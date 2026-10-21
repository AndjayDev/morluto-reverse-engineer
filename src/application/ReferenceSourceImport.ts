import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import {
  createHistoricalSourceGraph,
  historicalSourceLanguages,
  historicalSourceManifests,
  historicalSourceParseFailureKey,
  type HistoricalSourceGraph,
  type HistoricalSourceGraphInput,
} from "../domain/referenceSourceGraph.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { AnalysisCleanupObservation } from "../domain/analysisErrorBase.js";
import { readReferenceSource } from "../reference/ReferenceSourceReader.js";
import type {
  ReferenceSourceRead,
  ReferenceSourceReaderError,
} from "../reference/ReferenceSourceReaderTypes.js";
import { parseReferenceSourceEntries } from "./ReferenceSourceImportEntries.js";
import { readReferenceSourceVcs } from "./ReferenceSourceVcsAdapter.js";
import type {
  ReferenceSourceImportError,
  ReferenceSourceImportOptions,
} from "./ReferenceSourceImportTypes.js";
import { prepareReferenceSourceImport } from "./ReferenceSourceImportPolicy.js";

const failure = (
  code: ReferenceSourceImportError["code"],
  message: string,
): ReferenceSourceImportError => ({
  tag: "reference-source-import",
  code,
  message,
});

const cancelled = (
  partial?: ReferenceSourceRead,
): ReferenceSourceImportError => ({
  ...failure("cancelled", "Reference source import cancelled"),
  ...(partial === undefined ? {} : { partial }),
});

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const relationshipKey = (
  relationship: HistoricalSourceGraphInput["relationships"][number],
): string =>
  `${relationship.from_path}\u0000${relationship.to}\u0000${relationship.kind}\u0000${relationship.resolution}\u0000${relationship.parse_state}`;

const deduplicateRelationships = (
  relationships: HistoricalSourceGraphInput["relationships"],
): HistoricalSourceGraphInput["relationships"] => {
  const seen = new Set<string>();
  const result: HistoricalSourceGraphInput["relationships"] = [];
  for (const relationship of relationships) {
    const key = relationshipKey(relationship);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(relationship);
  }
  return result;
};

/** Sort parse failures deterministically while retaining distinct reasons. */
export const normalizeHistoricalSourceParseFailures = (
  failures: HistoricalSourceGraphInput["parse_failures"],
): HistoricalSourceGraphInput["parse_failures"] =>
  [...failures]
    .sort((left, right) =>
      compareUnicodeCodePoints(
        historicalSourceParseFailureKey(left),
        historicalSourceParseFailureKey(right),
      ),
    )
    .filter((value, index, array) => {
      if (index === 0) return true;
      const previous = array[index - 1];
      return (
        previous === undefined ||
        historicalSourceParseFailureKey(value) !==
          historicalSourceParseFailureKey(previous)
      );
    });

const buildProvenance = (
  options: ReferenceSourceImportOptions,
): HistoricalSourceGraphInput["provenance"] => ({
  importer: options.importer ?? "rea-reference-source-import",
  importer_version: options.importerVersion ?? null,
  caller: options.caller,
});

const deriveInventoryState = (
  input: Pick<
    HistoricalSourceGraphInput,
    | "entries"
    | "relationships"
    | "parse_failures"
    | "exclusions"
    | "limitations"
  >,
): "complete" | "partial" | "unknown" => {
  if (input.limitations.length > 0) return "partial";
  if (input.exclusions.length > 0) return "partial";
  if (input.parse_failures.length > 0) return "partial";
  const partialEntry = input.entries.some(
    (entry) =>
      entry.limitations.length > 0 ||
      (entry.kind === "file" && entry.content_state !== "hashed") ||
      (entry.kind === "directory" && entry.tree_state !== "enumerated") ||
      (entry.kind === "symlink" && entry.target_state !== "internal") ||
      entry.kind === "unknown",
  );
  if (partialEntry) return "partial";
  const partialRelationship = input.relationships.some(
    ({ parse_state, resolution }) =>
      parse_state !== "parsed" ||
      ["unresolved", "unknown"].includes(resolution),
  );
  if (partialRelationship) return "partial";
  return "complete";
};

const sortExclusions = (
  exclusions: HistoricalSourceGraphInput["exclusions"],
): HistoricalSourceGraphInput["exclusions"] =>
  [...exclusions].sort((left, right) => {
    const byPath = compareUnicodeCodePoints(left.path, right.path);
    if (byPath !== 0) return byPath;
    const byReason = compareUnicodeCodePoints(left.reason, right.reason);
    if (byReason !== 0) return byReason;
    return compareUnicodeCodePoints(
      "pattern" in left ? left.pattern : "",
      "pattern" in right ? right.pattern : "",
    );
  });

/**
 * Import a reference source directory into a committed historical source graph.
 *
 * The import is deterministic, parallel-safe, and never executes source, hooks,
 * git subprocesses, or network requests. Paths explicitly excluded by the
 * caller's reference-source policy are omitted from the graph.
 */
export const importReferenceSource = async (
  options: ReferenceSourceImportOptions,
  resources: ArtifactResourceScope,
): Promise<Result<HistoricalSourceGraph, ReferenceSourceImportError>> => {
  if (isAborted(options.signal)) return err(cancelled());
  const exclusions: HistoricalSourceGraphInput["exclusions"] = [];
  const prepared = await prepareReferenceSourceImport(
    options,
    resources,
    exclusions,
  );
  if (!prepared.ok) return prepared;
  const { root, policy } = prepared.value;
  if (isAborted(options.signal)) return err(cancelled());

  const [readResult, vcsResult] = await Promise.all([
    readReferenceSource(root, resources, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...policy,
    }),
    readReferenceSourceVcs(root, resources, options.signal),
  ]);

  if (!readResult.ok)
    return err(
      combineReadFailures(
        readResult.error,
        vcsResult.ok ? undefined : vcsResult.error,
        readResult.error.partial,
      ),
    );
  if (!vcsResult.ok)
    return err(
      combineReadFailures(vcsResult.error, undefined, readResult.value),
    );

  const vcs = vcsResult.value;

  if (isAborted(options.signal)) return err(cancelled(readResult.value));

  const read = readResult.value;
  const filePaths = new Set(
    read.entries
      .filter((entry) => entry.status === "read" && entry.kind === "file")
      .map((entry) => entry.path),
  );

  const { entries, relationships, parseFailures, limitations } =
    parseReferenceSourceEntries(read, filePaths, options.signal);

  if (isAborted(options.signal)) return err(cancelled(read));

  const uniqueRelationships = deduplicateRelationships(relationships);
  const uniqueFailures = normalizeHistoricalSourceParseFailures(parseFailures);

  const sortedEntries = [...entries].sort((left, right) =>
    compareUnicodeCodePoints(left.path, right.path),
  );
  const sortedExclusions = sortExclusions(exclusions);
  const sortedLimitations = [...limitations].sort(compareUnicodeCodePoints);

  const input: HistoricalSourceGraphInput = {
    schema: "HistoricalSourceGraph",
    authority: "historical-reference",
    root_alias: "$REFERENCE_ROOT",
    inventory_state: deriveInventoryState({
      entries: sortedEntries,
      relationships: uniqueRelationships,
      parse_failures: uniqueFailures,
      exclusions: sortedExclusions,
      limitations: sortedLimitations,
    }),
    entries: sortedEntries,
    relationships: uniqueRelationships.sort((left, right) =>
      compareUnicodeCodePoints(relationshipKey(left), relationshipKey(right)),
    ),
    parse_failures: uniqueFailures,
    exclusions: sortedExclusions,
    languages: historicalSourceLanguages(sortedEntries),
    manifests: historicalSourceManifests(sortedEntries),
    vcs,
    provenance: buildProvenance(options),
    limitations: sortedLimitations,
  };

  try {
    return ok(createHistoricalSourceGraph(input));
  } catch (cause: unknown) {
    return err(
      failure(
        "parse",
        cause instanceof Error ? cause.message : "Graph failed validation",
      ),
    );
  }
};

const combineReadFailures = (
  primary: ReferenceSourceReaderError,
  other: ReferenceSourceReaderError | undefined,
  partial: ReferenceSourceRead | undefined,
): ReferenceSourceImportError => {
  const cleanup = mergeCleanup(primary.cleanup, other?.cleanup);
  const message =
    other === undefined
      ? primary.message
      : `${primary.message}; additional reference metadata failure: ${other.message}`;
  const cause =
    other === undefined
      ? primary.cause
      : new AggregateError(
          [primary, other],
          "Reference source inventory and metadata both failed",
          { cause: primary },
        );
  return {
    ...failure(primary.code, message),
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(partial === undefined ? {} : { partial }),
    ...(cause === undefined ? {} : { cause }),
  };
};

const mergeCleanup = (
  first: AnalysisCleanupObservation | undefined,
  second: AnalysisCleanupObservation | undefined,
): AnalysisCleanupObservation | undefined => {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return {
    reason: `${first.reason}; ${second.reason}`,
    resources: [...new Set([...first.resources, ...second.resources])],
  };
};
