import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  AnalysisResourceConstraintError,
  AnalysisTargetNotOpenError,
} from "../../domain/analysisErrorCore.js";
import { err, ok as resultOk } from "../../domain/result.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  ControllableAnalysisClient,
  createBinarySessionTargets,
  createCacheProvider,
  createDeferred,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";

describe("BinaryTargetRegistry", () => {
  it("reopening the same target keeps its handle", async () => {
    const [first] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));
    expect((await registry.open(first)).ok).toBe(true);
    const openedId = registry.currentTargetId();

    expect((await registry.open(first)).ok).toBe(true);
    expect(openedId).toBeDefined();
    expect(registry.currentTargetId()).toBe(openedId);
    expect(registry.targets()).toHaveLength(1);
  });

  it("keeps two targets open and routes by target_id", async () => {
    const [first, second] = await createBinarySessionTargets();
    const seen: string[] = [];
    const registry = createTestBinaryTargetRegistry((target) => ({
      execute: (operation) => {
        if (operation !== "health") seen.push(target.sha256);
        return Promise.resolve(observed(operation));
      },
      close: () => Promise.resolve(resultOk(null)),
    }));

    const openedFirst = await registry.open(first, { keepOthersOpen: true });
    expect(openedFirst.ok).toBe(true);
    const firstId = registry.currentTargetId();
    const openedSecond = await registry.open(second, { keepOthersOpen: true });
    expect(openedSecond.ok).toBe(true);
    const secondId = registry.currentTargetId();
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    expect(registry.targets()).toHaveLength(2);

    const firstTarget = registry.activeTarget(firstId);
    const secondTarget = registry.activeTarget(secondId);
    expect(
      (await registry.execute("address_name", {}, { targetId: firstId! })).ok,
    ).toBe(true);
    expect(
      (await registry.execute("address_name", {}, { targetId: secondId! })).ok,
    ).toBe(true);
    expect(seen).toEqual([firstTarget?.sha256, secondTarget?.sha256]);
  });

  it("replaces other targets when keep_others_open is absent", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    expect((await registry.open(second)).ok).toBe(true);

    expect(registry.targets()).toHaveLength(1);
    expect(registry.activeTarget()?.path).toBe(second);
  });

  it("refuses a new target beyond the open-target cap", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(
      createCacheProvider([]),
      {},
      { maxOpenTargets: 1 },
    );

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const refused = await registry.open(second, { keepOthersOpen: true });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect((refused.error as AnalysisResourceConstraintError).resource).toBe(
      "capacity",
    );
    expect(registry.targets()).toHaveLength(1);
  });

  it("reports an unknown target handle without exposing paths", async () => {
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    const failed = await registry.execute(
      "address_name",
      {},
      { targetId: "not-a-target" },
    );

    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toBeInstanceOf(AnalysisTargetNotOpenError);
    expect(JSON.stringify(failed.error)).not.toContain("/");
  });

  it("queues concurrent starts beyond the analysis cap", async () => {
    const [first, second] = await createBinarySessionTargets();
    const firstHealth = createDeferred<ReturnType<typeof observed>>();
    const secondHealth = createDeferred<ReturnType<typeof observed>>();
    let clientsCreated = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clientsCreated += 1;
        return new ControllableAnalysisClient(
          clientsCreated === 1 ? firstHealth.promise : secondHealth.promise,
        );
      },
      {},
      { maxConcurrentAnalyses: 1 },
    );

    const openingFirst = registry.open(first, { keepOthersOpen: true });
    await vi.waitFor(() => expect(clientsCreated).toBe(1));
    const openingSecond = registry.open(second, { keepOthersOpen: true });
    await Promise.resolve();

    expect(clientsCreated).toBe(1);
    firstHealth.resolve(observed(null));
    expect((await openingFirst).ok).toBe(true);

    await vi.waitFor(() => expect(clientsCreated).toBe(2));
    secondHealth.resolve(observed(null));
    expect((await openingSecond).ok).toBe(true);
    expect(registry.targets()).toHaveLength(2);
  });

  it("closes one target without discarding the other", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const firstId = registry.currentTargetId();
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    expect((await registry.close({ targetId: firstId! })).ok).toBe(true);

    expect(registry.targets()).toHaveLength(1);
    expect(registry.activeTarget()?.path).toBe(second);
  });

  it("closes every target on server shutdown", async () => {
    const [first, second] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const closed = await registry.closeAll();
    expect(closed.ok).toBe(true);
    expect(registry.targets()).toHaveLength(0);
    expect(registry.activeTarget()).toBeUndefined();
  });
});

describe("BinaryTargetRegistry background starts", () => {
  it("queues a background start beyond the analysis cap", async () => {
    const [first, second] = await createBinarySessionTargets();
    const firstHealth = createDeferred<ReturnType<typeof observed>>();
    const secondHealth = createDeferred<ReturnType<typeof observed>>();
    let clientsCreated = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clientsCreated += 1;
        return new ControllableAnalysisClient(
          clientsCreated === 1 ? firstHealth.promise : secondHealth.promise,
        );
      },
      {},
      { maxConcurrentAnalyses: 1 },
    );

    expect(
      (
        await registry.open(first, {
          analysisMode: "background",
          keepOthersOpen: true,
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(clientsCreated).toBe(1));

    expect(
      (
        await registry.open(second, {
          analysisMode: "background",
          keepOthersOpen: true,
        })
      ).ok,
    ).toBe(true);
    // The cap holds the second start in the queue; only one provider starts.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clientsCreated).toBe(1);

    firstHealth.resolve(observed(null));
    await vi.waitFor(() => expect(clientsCreated).toBe(2));
    secondHealth.resolve(observed(null));
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
  });

  it("releases a queued background start that the target close cancels", async () => {
    const [first, second] = await createBinarySessionTargets();
    const thirdRoot = await createTestTempDirectory("rea-binary-third-");
    const third = join(thirdRoot, "third.hop");
    await writeFile(third, "three");
    const firstHealth = createDeferred<ReturnType<typeof observed>>();
    const thirdHealth = createDeferred<ReturnType<typeof observed>>();
    let clientsCreated = 0;
    const registry = createTestBinaryTargetRegistry(
      () => {
        clientsCreated += 1;
        return new ControllableAnalysisClient(
          clientsCreated === 1 ? firstHealth.promise : thirdHealth.promise,
        );
      },
      {},
      { maxConcurrentAnalyses: 1 },
    );

    await registry.open(first, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    await vi.waitFor(() => expect(clientsCreated).toBe(1));
    await registry.open(second, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    // The second start waits in the queue for the analysis cap.
    const queuedId = registry.currentTargetId();
    expect(queuedId).toBeDefined();

    // Closing the queued target cancels its start before it takes a permit.
    expect((await registry.close({ targetId: queuedId! })).ok).toBe(true);
    expect(clientsCreated).toBe(1);

    firstHealth.resolve(observed(null));
    await registry.open(third, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    // The cancelled start never consumed the permit the third start needs.
    await vi.waitFor(() => expect(clientsCreated).toBe(2));
    thirdHealth.resolve(observed(null));
  });
});

describe("BinaryTargetRegistry target selection", () => {
  it("refuses an unknown target handle instead of the current target", async () => {
    const [first] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));
    expect((await registry.open(first)).ok).toBe(true);

    expect(registry.analysisProfile()).toBeDefined();
    expect(registry.exportAnalysisSnapshot().ok).toBe(true);

    expect(() =>
      registry.providerIdentity(undefined, "missing-target"),
    ).toThrow(AnalysisTargetNotOpenError);
    expect(
      registry.analysisProfile(undefined, "missing-target"),
    ).toBeUndefined();
    expect(
      registry.allowsSnapshotReplay("address_name", "missing-target"),
    ).toBe(false);

    const exported = registry.exportAnalysisSnapshot("missing-target");
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.error).toBeInstanceOf(AnalysisTargetNotOpenError);

    const snapshot = registry.exportAnalysisSnapshot();
    if (!snapshot.ok) throw new Error("missing snapshot");
    const imported = registry.importAnalysisSnapshot(
      snapshot.value,
      "missing-target",
    );
    expect(imported.ok).toBe(false);
    if (imported.ok) return;
    expect(imported.error).toBeInstanceOf(AnalysisTargetNotOpenError);
  });
});

describe("BinaryTargetRegistry slot lifecycle", () => {
  it("stops a starting background job before the close returns", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    const events: string[] = [];
    const registry = createTestBinaryTargetRegistry(() => {
      events.push("client-created");
      return {
        execute: (operation: string) =>
          operation === "health"
            ? health.promise
            : Promise.resolve(observed(null)),
        close: () => {
          events.push("client-closed");
          return Promise.resolve(resultOk(null));
        },
      };
    });

    expect(
      (await registry.open(first, { analysisMode: "background" })).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(events).toContain("client-created"));

    const closing = registry.close();
    // The close waits for the interrupted start to unwind before it reports.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["client-created"]);

    health.resolve(observed(null));
    const closed = await closing;
    expect(closed.ok).toBe(true);
    // The interrupted start released its provider before the close reported.
    expect(events).toEqual(["client-created", "client-closed"]);
    expect(registry.analysisState()).toBeUndefined();
  });

  it("keeps a slot whose close failed", async () => {
    const [first, second] = await createBinarySessionTargets();
    let clientsCreated = 0;
    const registry = createTestBinaryTargetRegistry(() => {
      clientsCreated += 1;
      const failing = clientsCreated === 2;
      return {
        execute: (operation: string) => Promise.resolve(observed(operation)),
        close: () =>
          Promise.resolve(
            failing
              ? err(
                  new ProviderCleanupError("fixture", ["provider-client"], {
                    reason: "fixture close refused",
                  }),
                )
              : resultOk(null),
          ),
      };
    });

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const retainedId = registry.currentTargetId();

    const closed = await registry.closeAll?.();
    expect(closed?.ok).toBe(false);
    if (closed?.ok !== false) return;
    expect(closed.error.cleanupIncomplete).toBe(true);
    // The slot that failed to close keeps its registration and its resource,
    // so a later close can retry the cleanup it still owns.
    const retried = await registry.close({ targetId: retainedId! });
    expect(retried.ok).toBe(false);
    if (retried.ok) return;
    expect(retried.error).not.toBeInstanceOf(AnalysisTargetNotOpenError);
    expect(retried.error.cleanupIncomplete).toBe(true);
  });

  it("removes a failed open and a closed slot with one rule", async () => {
    const [first, second] = await createBinarySessionTargets();
    const failing = createTestBinaryTargetRegistry(
      () => new ControllableAnalysisClient(undefined, true),
    );
    const refused = await failing.open(first, { keepOthersOpen: true });
    expect(refused.ok).toBe(false);
    // A failed open removes its slot and leaves the primary slot current.
    expect(failing.targets()).toHaveLength(0);
    expect(failing.currentTargetId()).toBeUndefined();

    const registry = createTestBinaryTargetRegistry(createCacheProvider([]));
    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const firstId = registry.currentTargetId();
    expect((await registry.open(second, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const secondId = registry.currentTargetId();
    expect((await registry.close({ targetId: secondId! })).ok).toBe(true);
    // A closed slot leaves the first remaining open target current.
    expect(registry.currentTargetId()).toBe(firstId);
    expect(registry.activeTarget()?.path).toBe(first);
  });
});
