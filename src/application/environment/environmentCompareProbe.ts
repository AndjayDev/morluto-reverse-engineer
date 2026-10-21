import { z } from "zod";
import { isJsonLike } from "../../domain/analysisView/EnvironmentManifestAccumulator.js";
import {
  mediaTypeEssence,
  readRecordedRequestLine,
  type RequestLineExclusion,
} from "../../domain/analysisView/webNetworkRouteTemplates.js";
import { parseExactJson } from "../../domain/exactJsonNumber.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { WebNetworkCaptureRecord } from "../../domain/webNetworkCapture.js";
import type { Answer } from "./environmentCompareDiff.js";
import type { ProbeRequest } from "./environmentCompareMatch.js";
import {
  recordedExchange,
  replayedBody,
  type ReplayedBody,
} from "./environmentSource.js";

/** A probe record left uncompared: without a usable request line it is not replayed either; without an answer there is nothing to compare. */
export interface UnobservedRecord {
  readonly ordinal: number;
  readonly reason: RequestLineExclusion | "no-response";
}

/** One probe request with the application's answer. */
export interface ProbeStep {
  readonly ordinal: number;
  readonly request: ProbeRequest;
  readonly live: Answer;
}

/** Statuses whose answers carry no body, so a missing body is known to be empty. */
const BODYLESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

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
export const requestBody = (
  record: WebNetworkCaptureRecord,
): JsonValue | undefined => {
  const parsed = postDataSchema.safeParse(record.reported);
  if (!parsed.success) return undefined;
  const { mimeType, text } = parsed.data.request.postData;
  return isJsonLike(mediaTypeEssence(mimeType))
    ? (parseExactJson(text) ?? text)
    : text;
};

/** A body over the replay limit, text or bytes: only a prefix is known, so only the status compares. */
export const isCut = (body: ReplayedBody): boolean =>
  body.kind === "cut" || (body.kind === "base64" && !body.whole);

/** The application's answer as an environment answer carries it: JSON, text, or null when it is empty; a body the probe did not record is marked. */
const liveAnswer = (
  method: string,
  status: number,
  body: ReplayedBody,
): Answer => {
  if (body.kind === "none")
    return method === "HEAD" || BODYLESS_STATUSES.has(status)
      ? { status, body: null }
      : { status, body: null, unobserved: true };
  if (body.kind === "json") return { status, body: body.value };
  if (body.kind === "base64")
    return { status, body: body.encoded, cut: isCut(body) };
  return {
    status,
    body: body.text === "" ? null : body.text,
    cut: isCut(body),
  };
};

/** The probe's requests in the order they were made, each with the application's answer, and the records left uncompared. */
export const probeRequests = (
  records: readonly WebNetworkCaptureRecord[],
): { steps: ProbeStep[]; unobserved: UnobservedRecord[] } => {
  const steps: ProbeStep[] = [];
  const unobserved: UnobservedRecord[] = [];
  const ordered = [...records].sort(
    (left, right) =>
      startedMs(left) - startedMs(right) || left.ordinal - right.ordinal,
  );
  for (const record of ordered) {
    const line = readRecordedRequestLine(record.reported, true, () => true);
    const exchange = recordedExchange(record);
    const { ordinal } = record;
    if (line?.kind !== "line" || exchange === undefined)
      unobserved.push({
        ordinal,
        reason: line?.kind === "excluded" ? line.reason : "request-unavailable",
      });
    else if (exchange.status === null)
      unobserved.push({ ordinal, reason: "no-response" });
    else
      steps.push({
        ordinal,
        request: {
          method: line.method,
          path: exchange.path,
          query: exchange.query,
          body: requestBody(record),
        },
        live: liveAnswer(line.method, exchange.status, replayedBody(exchange)),
      });
  }
  return { steps, unobserved };
};
