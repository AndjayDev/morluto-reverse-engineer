import type { WebPageInspection } from "./browserObservationSchemas.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import type {
  WebCaptureChange,
  WebCaptureDimension,
} from "./webCaptureDiffSchemas.js";

type Script = WebPageInspection["scripts"]["items"][number];
type ScriptPair = {
  readonly before: Script | undefined;
  readonly after: Script | undefined;
};

/** Capture-local source ordinals do not establish cross-capture identity. */
export const compareWebCaptureScripts = (
  before: readonly Script[],
  after: readonly Script[],
  inventoryComplete: boolean,
): WebCaptureDimension => {
  const beforeGroups = scriptGroups(before);
  const afterGroups = scriptGroups(after);
  const changes: WebCaptureChange[] = [];
  let contentComplete = true;
  for (const base of new Set([...beforeGroups.keys(), ...afterGroups.keys()])) {
    const left = beforeGroups.get(base) ?? [];
    const right = afterGroups.get(base) ?? [];
    const pairs = matchScripts(left, right, inventoryComplete);
    for (const pair of pairs) {
      if (pair.before === undefined) {
        if (inventoryComplete && pair.after !== undefined)
          changes.push({ identity: pair.after.script_key, change: "added" });
      } else if (pair.after === undefined) {
        if (inventoryComplete)
          changes.push({ identity: pair.before.script_key, change: "removed" });
      } else {
        const sourceComparable =
          inventoryComplete &&
          pair.before.source.included &&
          pair.after.source.included;
        if (
          !sourceComparable &&
          (pair.before.cdp_hash === null || pair.after.cdp_hash === null)
        )
          contentComplete = false;
        if (
          scriptFingerprint(pair.before, sourceComparable) !==
          scriptFingerprint(pair.after, sourceComparable)
        )
          changes.push({
            identity: pair.before.script_key,
            change: "modified",
          });
      }
    }
  }
  changes.sort(
    (left, right) =>
      compareUnicodeCodePoints(left.identity, right.identity) ||
      compareUnicodeCodePoints(left.change, right.change),
  );
  if (changes.length > 0)
    return {
      status: "changed",
      total_changes: changes.length,
      changes,
      reason: null,
    };
  return inventoryComplete && contentComplete
    ? { status: "unchanged", total_changes: 0, changes: [], reason: null }
    : {
        status: "unknown",
        total_changes: 0,
        changes: [],
        reason:
          "Script inventory or content identity was incomplete in at least one observation.",
      };
};

const scriptGroups = (scripts: readonly Script[]): Map<string, Script[]> => {
  const groups = new Map<string, Script[]>();
  for (const script of scripts) {
    const base = script.script_key.replace(/_[0-9]+$/u, "");
    const group = groups.get(base) ?? [];
    group.push(script);
    groups.set(base, group);
  }
  for (const group of groups.values())
    group.sort((left, right) =>
      compareUnicodeCodePoints(left.script_key, right.script_key),
    );
  return groups;
};

const matchScripts = (
  before: readonly Script[],
  after: readonly Script[],
  includeSources: boolean,
): ScriptPair[] => {
  const pairs: ScriptPair[] = [];
  let unmatchedBefore = [...before];
  let unmatchedAfter = [...after];
  const match = (
    leftIdentity: (script: Script) => string | undefined,
    rightIdentity = leftIdentity,
  ) => {
    const remainingAfter = new Map<string, Script[]>();
    for (const script of [...unmatchedAfter].reverse()) {
      const key = rightIdentity(script);
      if (key === undefined) continue;
      const bucket = remainingAfter.get(key) ?? [];
      bucket.push(script);
      remainingAfter.set(key, bucket);
    }
    const matchedAfter = new Set<Script>();
    unmatchedBefore = unmatchedBefore.filter((script) => {
      const key = leftIdentity(script);
      const matched =
        key === undefined ? undefined : remainingAfter.get(key)?.pop();
      if (matched === undefined) return true;
      pairs.push({ before: script, after: matched });
      matchedAfter.add(matched);
      return false;
    });
    unmatchedAfter = unmatchedAfter.filter(
      (script) => !matchedAfter.has(script),
    );
  };
  if (includeSources) {
    match((script) =>
      script.source.included ? scriptFingerprint(script, true) : undefined,
    );
    const known = (script: Script) =>
      script.source.included ? scriptFingerprint(script, false) : undefined;
    const unknown = (script: Script) =>
      script.source.included ? undefined : scriptFingerprint(script, false);
    // Unknown sources can explain residual known content, but not metadata changes.
    match(known, unknown);
    match(unknown, known);
    match(unknown);
  } else match((script) => script.script_key);
  unmatchedAfter.sort((left, right) =>
    compareUnicodeCodePoints(left.script_key, right.script_key),
  );
  // Pair only residual occurrences after cancelling identical content counts.
  for (
    let index = 0;
    index < Math.max(unmatchedBefore.length, unmatchedAfter.length);
    index++
  )
    pairs.push({
      before: unmatchedBefore[index],
      after: unmatchedAfter[index],
    });
  return pairs;
};

const scriptFingerprint = (script: Script, includeSource: boolean): string =>
  digestCanonicalValue({
    url: script.url,
    cdp_hash: script.cdp_hash,
    length: script.length,
    is_module: script.is_module,
    language: script.language,
    source_map_url: script.source_map_url,
    source_sha256:
      includeSource && script.source.included
        ? script.source.artifact.sha256
        : null,
  });
