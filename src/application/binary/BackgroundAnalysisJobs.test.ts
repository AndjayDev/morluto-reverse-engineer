import { describe, expect, it, vi } from "vitest";

import { AnalysisInProgressError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { observed } from "../../../tests/fixtures/analysisExecution.js";
import {
  ControllableAnalysisClient,
  createBinarySessionTargets,
  createDeferred,
  createTestBinaryTargetRegistry,
} from "../../../tests/fixtures/binarySession.js";

const stateOf = (value: JsonValue | undefined): Record<string, JsonValue> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("missing analysis state");
  return value as Record<string, JsonValue>;
};

describe("background analysis jobs", () => {
  it("returns immediately and bounds a poll while the target starts", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    const registry = createTestBinaryTargetRegistry(
      () => new ControllableAnalysisClient(health.promise),
    );

    const opened = await registry.open(first, { analysisMode: "background" });
    expect(opened.ok).toBe(true);
    expect(stateOf(registry.analysisState())).toMatchObject({
      state: "starting",
      mode: "background",
    });

    const polled = await registry.execute("address_name", {}, { waitMs: 10 });
    expect(polled.ok).toBe(false);
    if (polled.ok) return;
    expect(polled.error).toBeInstanceOf(AnalysisInProgressError);
    expect(projectAnalysisError(polled.error).code).toBe(
      "analysis_in_progress",
    );

    health.resolve(observed(null));
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
    expect((await registry.execute("address_name", {})).ok).toBe(true);
  });

  it("reports a starting target through binary_session without failing", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    const registry = createTestBinaryTargetRegistry(
      () => new ControllableAnalysisClient(health.promise),
    );

    expect(
      (await registry.open(first, { analysisMode: "background" })).ok,
    ).toBe(true);
    const status = stateOf(await registry.status({ waitMs: 10 }));
    expect(status).toMatchObject({
      open: true,
      analysis: { state: "starting", mode: "background" },
    });

    health.resolve(observed(null));
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
  });

  it("keeps a promoted auto job alive after the request aborts", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    const registry = createTestBinaryTargetRegistry(
      () => new ControllableAnalysisClient(health.promise),
      {},
      { autoBackgroundAfterMs: 5_000 },
    );
    const controller = new AbortController();

    const opening = registry.open(first, {
      analysisMode: "auto",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(registry.analysisState()).toBeDefined());
    controller.abort();
    const opened = await opening;
    expect(opened.ok).toBe(false);
    expect(stateOf(registry.analysisState())).toMatchObject({
      state: "starting",
      mode: "auto",
    });

    health.resolve(observed(null));
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
  });

  it("promotes auto mode after the threshold", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    const registry = createTestBinaryTargetRegistry(
      () => new ControllableAnalysisClient(health.promise),
      {},
      { autoBackgroundAfterMs: 10 },
    );

    const opened = await registry.open(first, { analysisMode: "auto" });
    expect(opened.ok).toBe(true);
    expect(stateOf(registry.analysisState())).toMatchObject({
      state: "starting",
      mode: "auto",
    });

    health.resolve(observed(null));
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
  });
});

describe("background analysis job reporting", () => {
  it("reports elapsed time without an invented progress value", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    const registry = createTestBinaryTargetRegistry(
      () => new ControllableAnalysisClient(health.promise),
    );

    expect(
      (await registry.open(first, { analysisMode: "background" })).ok,
    ).toBe(true);
    const polled = await registry.execute("address_name", {}, { waitMs: 10 });
    expect(polled.ok).toBe(false);
    if (polled.ok) return;

    const projection = projectAnalysisError(polled.error);
    expect(projection.code).toBe("analysis_in_progress");
    // A still-running analysis is a bounded wait that expired, not a
    // resource constraint.
    expect(projection.category).toBe("timeout");
    expect(projection.retryable).toBe(true);
    expect(projection.details?.elapsed_ms).toBeGreaterThanOrEqual(0);
    // No provider streams a phase line into the application layer, so the
    // contract promises elapsed time only.
    expect(projection.details).not.toHaveProperty("progress");
    expect("progress" in polled.error).toBe(false);

    const state = stateOf(registry.analysisState());
    expect(state).not.toHaveProperty("progress");
    expect(state.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(state.elapsed_ms).toBeGreaterThanOrEqual(
      Number(projection.details?.elapsed_ms),
    );

    health.resolve(observed(null));
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
  });

  it("stops counting a finished job's elapsed time", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    const registry = createTestBinaryTargetRegistry(
      () => new ControllableAnalysisClient(health.promise),
    );

    expect(
      (await registry.open(first, { analysisMode: "background" })).ok,
    ).toBe(true);
    health.resolve(observed(null));
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
    const finished = Number(stateOf(registry.analysisState()).elapsed_ms);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Number(stateOf(registry.analysisState()).elapsed_ms)).toBe(finished);
  });
});

describe("background analysis job answers", () => {
  it("answers an aborted auto wait the same way on the first open and a re-open", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    const registry = createTestBinaryTargetRegistry(
      () => new ControllableAnalysisClient(health.promise),
      {},
      { autoBackgroundAfterMs: 5_000 },
    );

    const controller = new AbortController();
    const opening = registry.open(first, {
      analysisMode: "auto",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(registry.analysisState()).toBeDefined());
    controller.abort();
    const opened = await opening;
    expect(opened.ok).toBe(false);
    if (opened.ok) return;

    const second = new AbortController();
    const reopening = registry.open(first, {
      analysisMode: "auto",
      signal: second.signal,
    });
    await vi.waitFor(() => expect(registry.analysisState()).toBeDefined());
    second.abort();
    const reopened = await reopening;
    expect(reopened.ok).toBe(false);
    if (reopened.ok) return;

    expect(projectAnalysisError(reopened.error).code).toBe(
      projectAnalysisError(opened.error).code,
    );
    expect(projectAnalysisError(reopened.error).code).toBe("cancelled");
    // The aborted wait stops only the wait; the job keeps running.
    expect(stateOf(registry.analysisState())).toMatchObject({
      state: "starting",
      mode: "auto",
    });

    health.resolve(observed(null));
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
  });

  it("analyses the parsed target instead of parsing it twice", async () => {
    const [first] = await createBinarySessionTargets();
    const health = createDeferred<ReturnType<typeof observed>>();
    let providerTarget: BinaryTarget | undefined;
    const registry = createTestBinaryTargetRegistry((target) => {
      providerTarget = target;
      return new ControllableAnalysisClient(health.promise);
    });

    expect(
      (await registry.open(first, { analysisMode: "background" })).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(providerTarget).toBeDefined());
    // The provider analyses the target the registry recorded, not a second
    // parse of the same path.
    expect(providerTarget).toBe(registry.targets()[0]?.target);

    health.resolve(observed(null));
    await vi.waitFor(() =>
      expect(registry.analysisState()).toMatchObject({ state: "ready" }),
    );
  });
});
