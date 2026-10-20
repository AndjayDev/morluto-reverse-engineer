import { z } from "zod";
import { isJsonLike } from "../../domain/analysisView/EnvironmentManifestAccumulator.js";
import {
  mediaTypeEssence,
  readRecordedRequestLine,
} from "../../domain/analysisView/webNetworkRouteTemplates.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { parseExactJson } from "../../domain/exactJsonNumber.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { WebNetworkCaptureRecord } from "../../domain/webNetworkCapture.js";
import {
  compareAnswers,
  DIFFERENCE_CATEGORIES,
  STEP_DIFFERENCE_LIMIT,
  type Answer,
  type Difference,
  type DifferenceCategory,
  type Normalised,
} from "./environmentCompareDiff.js";
import { IdMap, learnIds, translateValue } from "./environmentCompareIds.js";
import {
  matchProbeRequest,
  type ProbeRequest,
  type ProbeToolCall,
} from "./environmentCompareMatch.js";
import {
  inputError,
  parseCaptureEvidence,
  recordedExchange,
  replayedBody,
  type EnvironmentSource,
  type ReplayedBody,
} from "./environmentSource.js";
import { prepareServedState, servedCatalog } from "./environmentState.js";
import { EnvironmentStateStore } from "./environmentStateStore.js";
import {
  environmentToolAnswer,
  type EnvironmentToolAnswer,
} from "./environmentToolAnswer.js";

/** One probe capture file: its label for the report and its parsed JSON. */
export interface CompareProbeInput {
  readonly label: string;
  readonly value: unknown;
}

/** One probe request, how the environment answered it, and how that differs from the application. */
export interface CompareStep {
  readonly ordinal: number;
  readonly method: string;
  readonly path: string;
  readonly tool: string | null;
  readonly live_status: number | null;
  readonly env_status: number | null;
  readonly equal: boolean;
  readonly categories: DifferenceCategory[];
  readonly differences: Difference[];
  readonly ignored_query: string[];
}

export interface CompareProbeReport {
  readonly label: string;
  readonly evidence_id: string;
  readonly steps: number;
  readonly equal: number;
  readonly ids_mapped: number;
  readonly id_conflicts: number;
  readonly normalised: Normalised;
  readonly results: CompareStep[];
}

export interface CompareReport {
  readonly status: "complete";
  readonly environment: {
    readonly name: string;
    readonly manifest_evidence_id: string;
    readonly evidence_id: string;
    readonly state: "served" | "replay-only";
  };
  readonly summary: {
    readonly probes: number;
    readonly steps: number;
    readonly equal: number;
    readonly agreement: number | null;
    readonly categories: Record<DifferenceCategory, number>;
    readonly normalised: Normalised;
  };
  readonly tools: { tool: string; steps: number; equal: number }[];
  readonly probes: CompareProbeReport[];
}

const startedSchema = z.object({ startedDateTime: z.string() });
const postDataSchema = z.object({
  request: z.object({
    postData: z.object({ mimeType: z.string(), text: z.string() }),
  }),
});

const startedMs = (record: WebNetworkCaptureRecord): number => {
  const started = startedSchema.safeParse(record.reported);
  const ms = started.success ? Date.parse(started.data.startedDateTime) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/** The JSON a request body holds, its text when it is not JSON, or undefined without one. */
const requestBody = (
  record: WebNetworkCaptureRecord,
): JsonValue | undefined => {
  const parsed = postDataSchema.safeParse(record.reported);
  if (!parsed.success) return undefined;
  const { mimeType, text } = parsed.data.request.postData;
  return isJsonLike(mediaTypeEssence(mimeType))
    ? (parseExactJson(text) ?? text)
    : text;
};

/** The application's body as an environment answer carries it: JSON, text, or null when there is none or it is empty. */
const liveBody = (body: ReplayedBody): JsonValue => {
  if (body.kind === "json") return body.value;
  if (body.kind === "none") return null;
  if (body.kind === "base64") return body.encoded;
  return body.text === "" ? null : body.text;
};

/** The probe's requests in the order they were made, each with the application's answer. */
const probeRequests = (
  records: readonly WebNetworkCaptureRecord[],
): { ordinal: number; request: ProbeRequest; live: Answer }[] =>
  [...records]
    .sort(
      (left, right) =>
        startedMs(left) - startedMs(right) || left.ordinal - right.ordinal,
    )
    .flatMap((record) => {
      const line = readRecordedRequestLine(record.reported, true, () => true);
      const exchange = recordedExchange(record);
      if (line === null || line.kind !== "line" || exchange === undefined)
        return [];
      return [
        {
          ordinal: record.ordinal,
          request: {
            method: line.method,
            path: exchange.path,
            query: exchange.query,
            body: requestBody(record),
          },
          live: {
            status: exchange.status,
            body: liveBody(replayedBody(exchange)),
          },
        },
      ];
    });

const isSuccess = (status: number | null): boolean =>
  status !== null && status >= 200 && status < 300;

interface ProbeRun {
  readonly answer: EnvironmentToolAnswer;
  readonly store: EnvironmentStateStore | undefined;
  readonly served: ReadonlySet<string>;
  readonly map: IdMap;
  readonly normalised: Normalised;
}

const heldIds = (
  store: EnvironmentStateStore | undefined,
): ReadonlySet<string> =>
  new Set(
    store?.snapshot().rea_state.entities.map((entity) => entity.id) ?? [],
  );

const stepOf = (
  base: Pick<CompareStep, "ordinal" | "method" | "path" | "live_status">,
  call: ProbeToolCall | undefined,
  outcome: { env_status: number | null; differences: Difference[] },
): CompareStep => {
  const categories = [...new Set(outcome.differences.map((d) => d.category))];
  return {
    ...base,
    tool: call?.tool.name ?? null,
    env_status: outcome.env_status,
    equal: outcome.differences.length === 0,
    categories,
    differences: outcome.differences.slice(0, STEP_DIFFERENCE_LIMIT),
    ignored_query: [...(call?.ignoredQuery ?? [])],
  };
};

/** Answer one probe request as the environment would and compare it with the application's answer. */
const compareStep = (
  run: ProbeRun,
  manifest: EnvironmentSource["manifest"],
  probe: { ordinal: number; request: ProbeRequest; live: Answer },
): CompareStep => {
  const { request, live } = probe;
  const base = {
    ordinal: probe.ordinal,
    method: request.method,
    path: request.path,
    live_status: live.status,
  };
  const call = matchProbeRequest(manifest, request);
  if (call === undefined)
    return stepOf(base, call, {
      env_status: null,
      differences: [{ category: "no-tool", pointer: "" }],
    });
  if (!run.served.has(call.tool.name))
    return stepOf(base, call, {
      env_status: null,
      differences: [{ category: "not-served", pointer: "" }],
    });
  const held = heldIds(run.store);
  const unknownPath = call.pathArguments.some((name) => {
    const value = call.args[name];
    return (
      typeof value === "string" && !run.map.hasLive(value) && !held.has(value)
    );
  });
  const args = Object.fromEntries(
    Object.entries(call.args).map(([name, value]) => [
      name,
      translateValue(value, run.map),
    ]),
  );
  const answered = run.answer(call.tool, args);
  if (!answered.ok)
    return stepOf(base, call, {
      env_status: null,
      differences: [
        {
          category: "refused",
          pointer: "",
          env: answered.error.message.slice(0, 200),
        },
      ],
    });
  const env: Answer = {
    status: answered.value.status,
    body: answered.value.body,
  };
  learnIds(live.body, env.body, run.map, heldIds(run.store));
  const compared = compareAnswers(live, env, run.map);
  for (const key of ["ids", "clocks", "generated"] as const)
    run.normalised[key] += compared.normalised[key];
  const differences = [...compared.differences];
  if (unknownPath && isSuccess(live.status) && !isSuccess(env.status))
    differences.unshift({ category: "unmapped-id", pointer: "" });
  return stepOf(base, call, { env_status: env.status, differences });
};

const probeReport = (
  label: string,
  evidenceId: string,
  run: ProbeRun,
  results: CompareStep[],
): CompareProbeReport => ({
  label,
  evidence_id: evidenceId,
  steps: results.length,
  equal: results.filter((step) => step.equal).length,
  ids_mapped: run.map.size,
  id_conflicts: run.map.conflicts,
  normalised: run.normalised,
  results,
});

const summaryOf = (
  probes: readonly CompareProbeReport[],
): CompareReport["summary"] => {
  const steps = probes.flatMap((probe) => probe.results);
  const categories = Object.fromEntries(
    DIFFERENCE_CATEGORIES.map((category) => [category, 0]),
  ) as Record<DifferenceCategory, number>;
  for (const step of steps)
    for (const category of step.categories) categories[category] += 1;
  const equal = steps.filter((step) => step.equal).length;
  const normalised = { ids: 0, clocks: 0, generated: 0 };
  for (const probe of probes)
    for (const key of ["ids", "clocks", "generated"] as const)
      normalised[key] += probe.normalised[key];
  return {
    probes: probes.length,
    steps: steps.length,
    equal,
    agreement:
      steps.length === 0
        ? null
        : Math.round((equal / steps.length) * 1000) / 1000,
    categories,
    normalised,
  };
};

const toolsOf = (
  probes: readonly CompareProbeReport[],
): CompareReport["tools"] => {
  const tools = new Map<
    string,
    { tool: string; steps: number; equal: number }
  >();
  for (const step of probes.flatMap((probe) => probe.results)) {
    if (step.tool === null) continue;
    const entry = tools.get(step.tool) ?? {
      tool: step.tool,
      steps: 0,
      equal: 0,
    };
    entry.steps += 1;
    if (step.equal) entry.equal += 1;
    tools.set(step.tool, entry);
  }
  return [...tools.values()].sort(
    (left, right) =>
      left.equal / left.steps - right.equal / right.steps ||
      (left.tool < right.tool ? -1 : 1),
  );
};

/** Compare an environment with probe captures of the application: each probe from a reset state, every request answered and compared. */
export const compareEnvironment = (input: {
  readonly source: EnvironmentSource;
  readonly captureValue: unknown;
  readonly probes: readonly CompareProbeInput[];
  readonly operation: string;
}): Result<CompareReport, AnalysisError> => {
  const { source, operation } = input;
  const state = prepareServedState(source, input.captureValue, {
    operation,
  }).state;
  const catalog = servedCatalog(source, state, source.manifest.name, operation);
  if (!catalog.ok) return catalog;
  const served = new Set(catalog.value.tools.map((tool) => tool.name));
  const probes: CompareProbeReport[] = [];
  for (const [index, probe] of input.probes.entries()) {
    const capture = parseCaptureEvidence(operation, probe.value);
    if (!capture.ok)
      return err(
        inputError(
          operation,
          [
            {
              path: ["probe", index],
              reason: "invalid_value",
              message: `${probe.label}: ${capture.error.message}`,
            },
          ],
          "A probe file is not capture Evidence.",
        ),
      );
    const store =
      state === undefined ? undefined : new EnvironmentStateStore(state);
    const run: ProbeRun = {
      answer: environmentToolAnswer(source, store),
      store,
      served,
      map: new IdMap(),
      normalised: { ids: 0, clocks: 0, generated: 0 },
    };
    const results = probeRequests(capture.value.records).map((request) =>
      compareStep(run, source.manifest, request),
    );
    probes.push(
      probeReport(probe.label, capture.value.evidenceId, run, results),
    );
  }
  return ok({
    status: "complete",
    environment: {
      name: source.manifest.name,
      manifest_evidence_id: source.manifestEvidenceId,
      evidence_id: source.evidenceId,
      state: state === undefined ? "replay-only" : "served",
    },
    summary: summaryOf(probes),
    tools: toolsOf(probes),
    probes,
  });
};
