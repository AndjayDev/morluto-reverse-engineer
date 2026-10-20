import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AnalysisInProgressError } from "../../domain/analysisErrorCore.js";
import {
  declaresWaitBudget,
  REA_WAIT_BUDGET_META,
} from "../../contracts/officialToolContracts.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createDeferred,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";

describe("the shared wait budget", () => {
  it("is recognised only when the schema marks it", () => {
    const marked = z.object({
      wait_ms: z
        .number()
        .optional()
        .meta({ [REA_WAIT_BUDGET_META]: true }),
    });
    const own = z.object({ wait_ms: z.number().optional() });
    const absent = z.object({ address: z.string() });

    expect(declaresWaitBudget(marked)).toBe(true);
    // A tool that grows a parameter of its own with the same name keeps it.
    expect(declaresWaitBudget(own)).toBe(false);
    expect(declaresWaitBudget(absent)).toBe(false);
  });
});

describe("a call that declares no wait budget", () => {
  it("reports the starting state at once instead of blocking", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    const registry = createTestBinaryTargetRegistry(
      () => ({
        execute: (operation: string) =>
          operation === "health"
            ? health.promise
            : Promise.resolve(observed(operation)),
        close: () => Promise.resolve({ ok: true, value: null } as never),
      }),
      {},
      { autoBackgroundAfterMs: 5_000 },
    );

    expect(
      (
        await registry.open(first, {
          analysisMode: "background",
          keepOthersOpen: true,
        })
      ).ok,
    ).toBe(true);

    const started = Date.now();
    const answered = await registry.execute(
      "list_documents",
      {},
      { waitMs: 0 },
    );
    const elapsed = Date.now() - started;

    expect(answered.ok).toBe(false);
    if (answered.ok) return;
    expect(answered.error).toBeInstanceOf(AnalysisInProgressError);
    // The call answered at once; it did not wait for the default budget.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("still honours a declared budget", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    const registry = createTestBinaryTargetRegistry(
      () => ({
        execute: (operation: string) =>
          operation === "health"
            ? health.promise
            : Promise.resolve(observed(operation)),
        close: () => Promise.resolve({ ok: true, value: null } as never),
      }),
      {},
      { autoBackgroundAfterMs: 5_000 },
    );

    expect(
      (
        await registry.open(first, {
          analysisMode: "background",
          keepOthersOpen: true,
        })
      ).ok,
    ).toBe(true);

    const answered = await registry.execute("address_name", {}, { waitMs: 20 });
    expect(answered.ok).toBe(false);
    if (answered.ok) return;
    expect(answered.error).toBeInstanceOf(AnalysisInProgressError);
  });
});

describe("a failed background job", () => {
  it("does not stop the next open from trying again", async () => {
    const [first] = await createBinarySessionTargets();
    let attempts = 0;
    const registry = createTestBinaryTargetRegistry(
      () => ({
        execute: (operation: string) => {
          if (operation !== "health") return Promise.resolve(observed(null));
          attempts += 1;
          return Promise.resolve(
            attempts === 1
              ? ({
                  ok: false,
                  error: { _tag: "AnalysisCancelledError" },
                } as never)
              : observed(null),
          );
        },
        close: () => Promise.resolve({ ok: true, value: null } as never),
      }),
      {},
      { autoBackgroundAfterMs: 20 },
    );

    const failed = await registry.open(first, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    expect(failed.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(1);
    expect(registry.analysisState()).toMatchObject({ state: "failed" });

    // The failed job must not poison the slot: the next open retries.
    const retried = await registry.open(first, {
      analysisMode: "background",
      keepOthersOpen: true,
    });
    expect(retried.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(2);
    expect(registry.analysisState()).toMatchObject({ state: "ready" });
  });
});

describe("a slot whose cleanup failed", () => {
  it("stays reported so a later close can retry it", async () => {
    const [first] = await createBinarySessionTargets();
    const registry = createTestBinaryTargetRegistry(
      () => ({
        execute: () => Promise.resolve(observed(null)),
        close: () =>
          Promise.resolve({
            ok: false,
            error: { _tag: "ProviderCleanupError" },
          } as never),
      }),
      {},
      { autoBackgroundAfterMs: 20 },
    );

    expect((await registry.open(first, { keepOthersOpen: true })).ok).toBe(
      true,
    );
    const targetId = registry.currentTargetId();
    expect(targetId).toBeDefined();

    const closed = await registry.close({ targetId: targetId! });
    expect(closed.ok).toBe(false);

    const status = (await registry.status()) as Record<string, unknown>;
    expect(status.retained_target_ids).toEqual([targetId]);
  });
});
