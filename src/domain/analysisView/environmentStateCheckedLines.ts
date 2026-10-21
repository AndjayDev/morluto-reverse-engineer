import {
  compareUnicodeCodePoints as compare,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import { iterateUrlQueryParameters } from "../recordedTransportUrl.js";
import {
  decodedSegment,
  isParam,
  segmentsOf,
  type StateRecordFacts,
  type StateToolFacts,
  type StateView,
} from "./environmentStateRules.js";

/** A query as replay compares a call's: decoded values by name, in any order. A query repeating a name, which no call's arguments can carry, keeps its spelling. */
const queryKey = (query: string | undefined): string => {
  const pairs = [...iterateUrlQueryParameters(query ?? "")];
  return new Set(pairs.map(([name]) => name)).size === pairs.length
    ? compositeKey(pairs.sort(([left], [right]) => compare(left, right)))
    : compositeKey([query ?? ""]);
};

/** A list or document view's checked lines, by query, in the tool's recorded order, and which path segments are the tool's parameters. */
export interface CheckedLines {
  readonly params: ReadonlySet<number>;
  readonly byQuery: ReadonlyMap<
    string,
    readonly {
      readonly ordinal: number;
      readonly segments: readonly string[];
    }[]
  >;
}

/** The line a read's call is answered from, and the collection serving lists for it. */
export interface ServedLine {
  readonly ordinal: number;
  readonly collection: string;
}

/** Each list or document view's checked lines. */
export const checkedLines = (input: {
  readonly tools: readonly StateToolFacts[];
  readonly records: readonly StateRecordFacts[];
  readonly views: ReadonlyMap<string, StateView>;
}): Map<string, CheckedLines> => {
  const byOrdinal = new Map(
    input.records.map((record) => [record.ordinal, record]),
  );
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const byView = new Map<string, CheckedLines>();
  for (const view of input.views.values()) {
    const tool = tools.get(view.tool);
    if (view.shape === "recorded" || view.shape === "item" || !tool) continue;
    const checked = new Set(view.checked_record_ordinals);
    const byQuery = new Map<
      string,
      { readonly ordinal: number; readonly segments: readonly string[] }[]
    >();
    for (const ordinal of tool.record_ordinals) {
      const record = byOrdinal.get(ordinal);
      if (!checked.has(ordinal) || record === undefined) continue;
      const key = queryKey(record.query);
      const lines = byQuery.get(key) ?? [];
      lines.push({ ordinal, segments: segmentsOf(record.path) });
      byQuery.set(key, lines);
    }
    const params = new Set(
      segmentsOf(tool.path_template).flatMap((segment, index) =>
        isParam(segment) ? [index] : [],
      ),
    );
    byView.set(view.tool, { params, byQuery });
  }
  return byView;
};

/**
 * The checked line serving answers a read's call from, ranked as replay ranks lines: every
 * parameter the read's value verbatim or once percent-decoded and the query the read's, then the
 * most verbatim parameters, then recorded order.
 */
export const servedLine = (
  lines: CheckedLines | undefined,
  record: StateRecordFacts,
): ServedLine | undefined => {
  const read = segmentsOf(record.path);
  let best: { line: ServedLine; verbatim: number } | undefined;
  for (const { ordinal, segments } of lines?.byQuery.get(
    queryKey(record.query),
  ) ?? []) {
    if (segments.length !== read.length) continue;
    let verbatim = 0;
    const matches = segments.every((segment, index) => {
      if (segment === read[index]) {
        if (lines!.params.has(index)) verbatim += 1;
        return true;
      }
      return (
        lines!.params.has(index) && decodedSegment(segment) === read[index]
      );
    });
    if (matches && (best === undefined || verbatim > best.verbatim))
      best = {
        line: { ordinal, collection: `/${segments.join("/")}` },
        verbatim,
      };
  }
  return best?.line;
};
