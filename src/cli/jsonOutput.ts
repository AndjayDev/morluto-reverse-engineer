import type { Writable } from "node:stream";

import { bufferedJsonParts, jsonParts } from "../domain/jsonSerialization.js";

type JsonOutputFormat = "json" | "jsonl";

export const JSONL_COVERAGE_SCHEMA =
  "https://rea.dev/schemas/jsonl-coverage-v1.json" as const;
export const JSONL_ERROR_SCHEMA =
  "https://rea.dev/schemas/jsonl-error-v1.json" as const;

export interface ExtractedRowCollection {
  readonly records: readonly unknown[];
  readonly coverage?: Readonly<Record<string, unknown>>;
  readonly pagination?: Readonly<Record<string, unknown>>;
  readonly limitations?: readonly string[];
  readonly unknowns?: readonly string[];
  readonly evidenceId?: string;
  readonly parentEvidenceId?: string;
  readonly evidenceLinks?: readonly string[];
}

/** Extract deterministic records and coverage from row-oriented results. */
export const extractRowCollection = (
  value: unknown,
): ExtractedRowCollection | undefined => {
  if (Array.isArray(value)) {
    return { records: value };
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const inner =
    typeof candidate.normalized_result === "object" &&
    candidate.normalized_result !== null
      ? (candidate.normalized_result as Record<string, unknown>)
      : candidate;

  const pageCandidate =
    typeof inner.page === "object" && inner.page !== null
      ? (inner.page as Record<string, unknown>)
      : typeof candidate.page === "object" && candidate.page !== null
        ? (candidate.page as Record<string, unknown>)
        : undefined;

  let records: readonly unknown[] | undefined;
  if (Array.isArray(inner.rows)) records = inner.rows;
  else if (Array.isArray(inner.items)) records = inner.items;
  else if (Array.isArray(inner.occurrences)) records = inner.occurrences;
  else if (Array.isArray(inner.records)) records = inner.records;
  else if (pageCandidate !== undefined) {
    if (Array.isArray(pageCandidate.rows)) records = pageCandidate.rows;
    else if (Array.isArray(pageCandidate.items)) records = pageCandidate.items;
    else if (Array.isArray(pageCandidate.occurrences))
      records = pageCandidate.occurrences;
    else if (Array.isArray(pageCandidate.records))
      records = pageCandidate.records;
  }

  if (records === undefined) return undefined;

  const coverage =
    typeof inner.coverage === "object" && inner.coverage !== null
      ? (inner.coverage as Record<string, unknown>)
      : typeof candidate.coverage === "object" && candidate.coverage !== null
        ? (candidate.coverage as Record<string, unknown>)
        : undefined;

  const pagination = extractPagination(inner, candidate, pageCandidate);

  const limitations = Array.isArray(inner.limitations)
    ? (inner.limitations as readonly string[])
    : Array.isArray(candidate.limitations)
      ? (candidate.limitations as readonly string[])
      : undefined;

  const unknowns = Array.isArray(inner.unknowns)
    ? (inner.unknowns as readonly string[])
    : Array.isArray(candidate.unknowns)
      ? (candidate.unknowns as readonly string[])
      : undefined;

  const evidenceId =
    typeof candidate.evidence_id === "string"
      ? candidate.evidence_id
      : typeof inner.evidence_id === "string"
        ? inner.evidence_id
        : undefined;

  const parentEvidenceId =
    typeof candidate.parent_evidence_id === "string"
      ? candidate.parent_evidence_id
      : typeof inner.parent_evidence_id === "string"
        ? inner.parent_evidence_id
        : undefined;

  const evidenceLinks = Array.isArray(candidate.evidence_links)
    ? (candidate.evidence_links as readonly string[])
    : Array.isArray(inner.evidence_links)
      ? (inner.evidence_links as readonly string[])
      : undefined;

  return {
    records,
    ...(coverage !== undefined ? { coverage } : {}),
    ...(pagination !== undefined ? { pagination } : {}),
    ...(limitations !== undefined && limitations.length > 0
      ? { limitations }
      : {}),
    ...(unknowns !== undefined && unknowns.length > 0 ? { unknowns } : {}),
    ...(evidenceId !== undefined ? { evidenceId } : {}),
    ...(parentEvidenceId !== undefined ? { parentEvidenceId } : {}),
    ...(evidenceLinks !== undefined && evidenceLinks.length > 0
      ? { evidenceLinks }
      : {}),
  };
};

const extractPagination = (
  inner: Record<string, unknown>,
  candidate: Record<string, unknown>,
  pageCandidate?: Record<string, unknown>,
): Readonly<Record<string, unknown>> | undefined => {
  const result: Record<string, unknown> = {};
  const sources = [inner, candidate, pageCandidate].filter(
    (s): s is Record<string, unknown> => s !== undefined,
  );

  for (const src of sources) {
    if (typeof src.offset === "number" && result.offset === undefined)
      result.offset = src.offset;
    if (typeof src.limit === "number" && result.limit === undefined)
      result.limit = src.limit;
    if (
      (typeof src.next_offset === "number" || src.next_offset === null) &&
      result.next_offset === undefined
    )
      result.next_offset = src.next_offset;
    if (
      typeof src.total_records === "number" &&
      result.total_records === undefined
    )
      result.total_records = src.total_records;
    if (typeof src.total === "number" && result.total === undefined)
      result.total = src.total;
    if (typeof src.truncated === "boolean" && result.truncated === undefined)
      result.truncated = src.truncated;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

/** Determine if a CLI result has a clear row/record boundary for JSON Lines. */
export const hasClearRecordBoundary = (
  value: unknown,
  hasFilter = false,
): boolean => {
  if (hasFilter) return true;
  return extractRowCollection(value) !== undefined;
};

export const isJsonLinesError = (value: unknown): boolean => {
  if (value instanceof Error) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === false && "error" in candidate) return true;
  if (
    typeof candidate.code === "string" &&
    typeof candidate.category === "string" &&
    typeof candidate.message === "string"
  )
    return true;
  return false;
};

export const formatJsonLinesError = (
  value: unknown,
): Record<string, unknown> => {
  if (value instanceof Error) {
    return {
      $schema: JSONL_ERROR_SCHEMA,
      type: "error",
      ok: false,
      error: {
        name: value.name,
        message: value.message,
      },
    };
  }
  if (typeof value === "object" && value !== null) {
    const candidate = value as Record<string, unknown>;
    if (candidate.ok === false && "error" in candidate) {
      return {
        $schema: JSONL_ERROR_SCHEMA,
        type: "error",
        ok: false,
        error: candidate.error,
        ...(candidate.meta !== undefined ? { meta: candidate.meta } : {}),
      };
    }
  }
  return {
    $schema: JSONL_ERROR_SCHEMA,
    type: "error",
    ok: false,
    error: value,
  };
};

/**
 * Write ordinary JSON without constructing a document-sized string.
 *
 * `json` is indented for a terminal reader. Piped or redirected output, which
 * agents and scripts consume, is compact: indentation adds no information and
 * measured 16-45% more model tokens on real results. The value is identical.
 */
export const writeJsonOutput = async (
  value: unknown,
  destination: Writable,
  format: JsonOutputFormat = "json",
): Promise<void> => {
  for (const part of bufferedJsonParts(
    jsonOutputParts(value, format, isTerminal(destination)),
  ))
    await writeOutputText(destination, part);
};

const isTerminal = (destination: Writable): boolean =>
  "isTTY" in destination && destination.isTTY === true;

export const writeOutputText = (
  destination: Writable,
  part: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (cause: unknown): void => reject(cause);
    destination.once("error", onError);
    try {
      destination.write(part, (cause) => {
        if (cause) {
          // A Writable can emit its error after invoking the write callback.
          setImmediate(() => destination.off("error", onError));
          reject(cause);
        } else {
          destination.off("error", onError);
          resolve();
        }
      });
    } catch (cause: unknown) {
      destination.off("error", onError);
      reject(cause);
    }
  });

/** The exact formatted document, including its final newline. */
export function* jsonOutputParts(
  value: unknown,
  format: JsonOutputFormat,
  pretty = true,
): Generator<string> {
  if (format === "jsonl") {
    if (isJsonLinesError(value)) {
      yield* jsonParts(formatJsonLinesError(value));
      yield "\n";
      return;
    }
    const collection = extractRowCollection(value);
    if (collection !== undefined) {
      for (const item of collection.records) {
        yield* jsonParts(item);
        yield "\n";
      }
      const hasMetadata =
        collection.coverage !== undefined ||
        collection.pagination !== undefined ||
        collection.evidenceId !== undefined ||
        collection.parentEvidenceId !== undefined ||
        (collection.evidenceLinks !== undefined &&
          collection.evidenceLinks.length > 0) ||
        (collection.limitations !== undefined &&
          collection.limitations.length > 0) ||
        (collection.unknowns !== undefined && collection.unknowns.length > 0);

      if (hasMetadata) {
        const metadataRecord: Record<string, unknown> = {
          $schema: JSONL_COVERAGE_SCHEMA,
          type: "coverage",
        };
        if (collection.evidenceId !== undefined)
          metadataRecord.evidence_id = collection.evidenceId;
        if (collection.parentEvidenceId !== undefined)
          metadataRecord.parent_evidence_id = collection.parentEvidenceId;
        if (collection.evidenceLinks && collection.evidenceLinks.length > 0)
          metadataRecord.evidence_links = collection.evidenceLinks;
        if (collection.coverage !== undefined)
          metadataRecord.coverage = collection.coverage;
        if (collection.pagination !== undefined)
          metadataRecord.pagination = collection.pagination;
        if (collection.limitations && collection.limitations.length > 0)
          metadataRecord.limitations = collection.limitations;
        if (collection.unknowns && collection.unknowns.length > 0)
          metadataRecord.unknowns = collection.unknowns;
        yield* jsonParts(metadataRecord);
        yield "\n";
      }
      return;
    }
  }
  yield* jsonParts(value, pretty && format === "json");
  yield "\n";
}
