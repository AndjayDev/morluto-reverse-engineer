import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { err, ok as resultOk, type Result } from "../../domain/result.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  createBinarySessionTargets,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";
import type { AnalysisClient } from "../AnalysisProvider.js";

/**
 * Counts providers that were created but have not finished starting.
 *
 * The analysis cap promises that no more than `maxConcurrentAnalyses` starts
 * overlap. Counting clients alone cannot show that, because a client may
 * exist while it waits for the cap. This probe counts the providers whose
 * start is still in flight and keeps the highest value it ever saw.
 */
class StartConcurrencyProbe {
  started = 0;
  finished = 0;
  peak = 0;

  /** Record a provider that began starting. */
  begin(): void {
    this.started += 1;
    this.peak = Math.max(this.peak, this.started - this.finished);
  }

  /** Record a provider whose start finished, successfully or not. */
  end(): void {
    this.finished += 1;
  }
}

/** A provider whose start never finishes and whose abort is ignored. */
class WedgedAnalysisClient implements AnalysisClient {
  closed = 0;

  constructor(
    readonly onClose: () => void,
    readonly probe?: StartConcurrencyProbe,
  ) {}

  execute(): Promise<ReturnType<typeof observed>> {
    this.probe?.begin();
    // The start never settles. The abort signal is deliberately ignored, the
    // way a provider that wedges during import behaves.
    return new Promise<ReturnType<typeof observed>>(() => undefined);
  }

  close(): Promise<Result<null, AnalysisError>> {
    this.closed += 1;
    this.probe?.end();
    this.onClose();
    return Promise.resolve(resultOk(null));
  }
}

/** A provider whose start observes the abort signal and then rejects. */
class AbortAwareAnalysisClient implements AnalysisClient {
  closed = 0;
  abortObserved = false;
  /** Whether the abort reached the provider before the close released it. */
  abortedBeforeClose = false;

  constructor(readonly onClose: () => void) {}

  execute(
    _name: string,
    _arguments_: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ReturnType<typeof observed>> {
    return new Promise<ReturnType<typeof observed>>((_resolve, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          this.abortObserved = true;
          reject(err(new Error("start aborted")));
        },
        { once: true },
      );
    });
  }

  close(): Promise<Result<null, AnalysisError>> {
    this.closed += 1;
    this.abortedBeforeClose = this.abortObserved;
    this.onClose();
    return Promise.resolve(resultOk(null));
  }
}

describe("background start concurrency", () => {
  it("never starts more providers at once than the analysis cap allows", async () => {
    const [first, second] = await createBinarySessionTargets();
    const thirdRoot = await createTestTempDirectory("rea-concurrency-third-");
    const third = join(thirdRoot, "third.hop");
    await writeFile(third, "three");
    const probe = new StartConcurrencyProbe();
    const registry = createTestBinaryTargetRegistry(
      () => ({
        execute: () => {
          probe.begin();
          return new Promise<ReturnType<typeof observed>>(() => undefined);
        },
        close: () => {
          probe.end();
          return Promise.resolve(resultOk(null));
        },
      }),
      {},
      { maxConcurrentAnalyses: 1 },
    );

    for (const path of [first, second, third]) {
      expect(
        (
          await registry.open(path, {
            analysisMode: "background",
            keepOthersOpen: true,
          })
        ).ok,
      ).toBe(true);
    }
    await vi.waitFor(() => expect(probe.started).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The cap holds every other start in the queue.
    expect(probe.started).toBe(1);
    expect(probe.peak).toBe(1);
  });

  it("does not let a cancelled queued start release a permit another start holds", async () => {
    const [first, second] = await createBinarySessionTargets();
    const thirdRoot = await createTestTempDirectory("rea-concurrency-queued-");
    const third = join(thirdRoot, "third.hop");
    await writeFile(third, "three");
    const probe = new StartConcurrencyProbe();
    const registry = createTestBinaryTargetRegistry(
      () => ({
        execute: () => {
          probe.begin();
          return new Promise<ReturnType<typeof observed>>(() => undefined);
        },
        close: () => {
          probe.end();
          return Promise.resolve(resultOk(null));
        },
      }),
      {},
      { maxConcurrentAnalyses: 1 },
    );

    await registry.open(first, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    await vi.waitFor(() => expect(probe.started).toBe(1));

    // The second start waits in the queue for the analysis cap.
    await registry.open(second, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    const queuedId = registry.currentTargetId();
    expect(queuedId).toBeDefined();
    expect((await registry.close({ targetId: queuedId! })).ok).toBe(true);

    // The cancelled start never took a permit, so the third start still waits.
    await registry.open(third, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probe.started).toBe(1);
    expect(probe.peak).toBe(1);
  });
});

describe("closing a starting background job", () => {
  it("stops the job and completes the close when the provider ignores the abort", async () => {
    const [first] = await createBinarySessionTargets();
    let client: WedgedAnalysisClient | undefined;
    const registry = createTestBinaryTargetRegistry(
      () => {
        client = new WedgedAnalysisClient(() => undefined);
        return client;
      },
      {},
      { jobSettleTimeoutMs: 50 },
    );

    expect(
      (
        await registry.open(first, {
          analysisMode: "background",
          keepOthersOpen: true,
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(client).toBeDefined());

    // The close must not wait for a start that never unwinds.
    const targetId = registry.currentTargetId();
    expect(targetId).toBeDefined();
    const closed = await registry.close({ targetId: targetId! });
    expect(closed.ok).toBe(true);
    expect(client?.closed).toBe(1);
  });

  it("aborts the provider start and closes without waiting for it to settle", async () => {
    const [first] = await createBinarySessionTargets();
    let client: AbortAwareAnalysisClient | undefined;
    const registry = createTestBinaryTargetRegistry(
      () => {
        client = new AbortAwareAnalysisClient(() => undefined);
        return client;
      },
      {},
      { jobSettleTimeoutMs: 5_000 },
    );

    expect(
      (
        await registry.open(first, {
          analysisMode: "background",
          keepOthersOpen: true,
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(client).toBeDefined());

    const targetId = registry.currentTargetId();
    expect(targetId).toBeDefined();
    const closed = await registry.close({ targetId: targetId! });
    expect(closed.ok).toBe(true);
    // The abort reached the provider before the close released the client, so
    // the close did not simply wait for the start to fail on its own.
    expect(client?.abortedBeforeClose).toBe(true);
  });

  it("reports a close that could not release the provider", async () => {
    const [first] = await createBinarySessionTargets();
    let client: AnalysisClient | undefined;
    const registry = createTestBinaryTargetRegistry(
      () => {
        client = {
          execute: () =>
            new Promise<ReturnType<typeof observed>>(() => undefined),
          close: () =>
            Promise.resolve(
              err(
                new ProviderCleanupError("fixture", ["provider-client"], {
                  reason: "fixture close refused",
                }),
              ),
            ),
        };
        return client;
      },
      {},
      { jobSettleTimeoutMs: 50 },
    );

    await registry.open(first, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    // The close must find a provider to release, so wait for the start.
    await vi.waitFor(() => expect(client).toBeDefined());
    const targetId = registry.currentTargetId();
    expect(targetId).toBeDefined();
    const closed = await registry.close({ targetId: targetId! });
    expect(closed.ok).toBe(false);
    if (closed.ok) return;
    expect(closed.error).toBeInstanceOf(ProviderCleanupError);
  });
});
