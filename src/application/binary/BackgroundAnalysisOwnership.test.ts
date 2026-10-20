import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { AnalysisTargetNotOpenError } from "../../domain/analysisErrorCore.js";
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
 * A provider whose start never settles and whose abort is ignored.
 *
 * The session's transition promise stays parked on this start, so the registry
 * has to escalate the close instead of waiting behind it.
 */
class WedgedAnalysisClient implements AnalysisClient {
  closed = 0;

  execute(): Promise<ReturnType<typeof observed>> {
    return new Promise<ReturnType<typeof observed>>(() => undefined);
  }

  close(): Promise<Result<null, AnalysisError>> {
    this.closed += 1;
    return Promise.resolve(resultOk(null));
  }
}

/** A provider that answers immediately. */
const healthyClient = (): AnalysisClient => ({
  execute: () => Promise.resolve(observed(null)),
  close: () => Promise.resolve(resultOk(null)),
});

const settlesWithin = async <Value>(
  work: Promise<Value>,
  ms = 2_000,
): Promise<Value | "timeout"> =>
  Promise.race([
    work,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), ms),
    ),
  ]);

describe("a close of a wedged background job", () => {
  it("leaves the server usable for the shutdown and for a later open", async () => {
    const [first, second] = await createBinarySessionTargets();
    let clients = 0;
    let wedged: WedgedAnalysisClient | undefined;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clients += 1;
        // Only the first start wedges. A later open must be able to run.
        if (clients !== 1) return healthyClient();
        wedged = new WedgedAnalysisClient();
        return wedged;
      },
      {},
      { jobSettleTimeoutMs: 50 },
    );

    // The default open replaces the current target, so the job runs on the
    // primary slot - the slot the server shutdown closes.
    expect(
      (
        await registry.open(first, {
          analysisMode: "background",
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(clients).toBe(1));
    const targetId = registry.currentTargetId();
    expect(targetId).toBeDefined();

    // The first close is bounded: the start never unwinds.
    const closed = await registry.close({ targetId: targetId! });
    expect(closed.ok).toBe(true);
    expect(wedged?.closed).toBe(1);

    // The server shutdown must not hang on the wedged transition.
    const shutdown = await settlesWithin(registry.closeAll());
    expect(shutdown).not.toBe("timeout");

    // And a later open on the same server must not hang either.
    const reopened = await settlesWithin(registry.open(second));
    expect(reopened).not.toBe("timeout");
  });

  it("releases the provider when a snapshot close cannot take one", async () => {
    const [first] = await createBinarySessionTargets();
    let clients = 0;
    let wedged: WedgedAnalysisClient | undefined;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clients += 1;
        if (clients !== 1) return healthyClient();
        wedged = new WedgedAnalysisClient();
        return wedged;
      },
      {},
      { jobSettleTimeoutMs: 50 },
    );

    expect(
      (
        await registry.open(first, {
          analysisMode: "background",
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(clients).toBe(1));
    const targetId = registry.currentTargetId();
    expect(targetId).toBeDefined();

    const snapshotRoot = await createTestTempDirectory("rea-snapshot-");
    const snapshot = join(snapshotRoot, "snapshot.json");
    const closed = await settlesWithin(
      registry.closeWithSnapshot(snapshot, false, { targetId: targetId! }),
    );
    expect(closed).not.toBe("timeout");
    // The provider is released even though no snapshot could be taken.
    expect(wedged?.closed).toBe(1);
  });
});

describe("a slot whose cleanup failed", () => {
  it("stays closable but is no longer an open target", async () => {
    const [first] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(
      () => ({
        execute: () => Promise.resolve(observed(null)),
        close: () =>
          Promise.resolve(
            err(
              new ProviderCleanupError("fixture", ["provider-client"], {
                reason: "fixture close refused",
              }),
            ),
          ),
      }),
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
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
    const targetId = registry.currentTargetId();
    expect(targetId).toBeDefined();

    const closed = await registry.close({ targetId: targetId! });
    expect(closed.ok).toBe(false);

    const status = (await registry.status()) as Record<string, unknown>;
    // The retained resource stays reported...
    expect(status.retained_target_ids).toEqual([targetId]);
    // ...but the closed target is no longer open or routable.
    expect(status.open_target_ids ?? []).not.toContain(targetId);
    expect(() => registry.providerIdentity(undefined, targetId!)).toThrow(
      AnalysisTargetNotOpenError,
    );
  });

  it("is reported when the replace path could not release it", async () => {
    const [first, second] = await createBinarySessionTargets();
    let failClose = true;
    const registry = createTestBinaryTargetRegistry(
      () => ({
        execute: () => Promise.resolve(observed(null)),
        close: () =>
          Promise.resolve(
            failClose
              ? err(
                  new ProviderCleanupError("fixture", ["provider-client"], {
                    reason: "fixture close refused",
                  }),
                )
              : resultOk(null),
          ),
      }),
      {},
      { jobSettleTimeoutMs: 50 },
    );

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const firstId = registry.currentTargetId();
    expect(firstId).toBeDefined();

    // The default replace path closes the first target, and its cleanup fails.
    const replaced = await registry.open(second);
    expect(replaced.ok).toBe(false);

    const status = (await registry.status()) as Record<string, unknown>;
    expect(status.retained_target_ids).toEqual([firstId]);

    // The retained slot is still closable, and a successful retry clears it.
    failClose = false;
    const retried = await registry.close({ targetId: firstId! });
    expect(retried.ok).toBe(true);
    const after = (await registry.status()) as Record<string, unknown>;
    expect(after.retained_target_ids ?? []).toEqual([]);
  });
});

describe("a background open that fails", () => {
  it("leaves an already open target visible and closable", async () => {
    const [first] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));

    // The default open binds the primary slot.
    expect((await registry.open(first)).ok).toBe(true);
    const openedId = registry.currentTargetId();
    expect(openedId).toBeDefined();

    // A background open that cannot even resolve its target must not
    // unregister the target that is already open.
    const missing = join(first, "does-not-exist.hop");
    const failed = await registry.open(missing, { analysisMode: "background" });
    expect(failed.ok).toBe(false);

    const status = (await registry.status()) as Record<string, unknown>;
    expect(status.open_target_ids).toContain(openedId);

    const closed = await registry.close({ targetId: openedId! });
    expect(closed.ok).toBe(true);
  });
});
