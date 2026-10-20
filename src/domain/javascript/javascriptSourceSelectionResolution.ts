import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";

interface JavaScriptSourceSelectorOutcome {
  /** Resolved inventoried paths in first-request order, without duplicates. */
  readonly selectedPaths: readonly string[];
  /** Selector indexes that matched no inventoried file. */
  readonly unmatchedIndexes: readonly number[];
  /** Resolved paths whose inventoried bytes are unavailable, in resolution order. */
  readonly unavailablePaths: readonly string[];
  /** True when a folder prefix or glob resolved at least one selector. */
  readonly expanded: boolean;
}

const hasGlobMeta = (selector: string): boolean =>
  selector.includes("*") || selector.includes("?");

/** Match one path segment where `*` spans any run and `?` one code point. */
const matchSegment = (pattern: string, value: string): boolean => {
  const patternPoints = Array.from(pattern);
  const valuePoints = Array.from(value);
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starValueIndex = -1;
  while (valueIndex < valuePoints.length) {
    const patternPoint =
      patternIndex < patternPoints.length
        ? patternPoints[patternIndex]
        : undefined;
    if (
      patternPoint !== undefined &&
      (patternPoint === "?" || patternPoint === valuePoints[valueIndex])
    ) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (patternPoint === "*") {
      starIndex = patternIndex;
      starValueIndex = valueIndex;
      patternIndex += 1;
    } else if (starIndex >= 0) {
      starValueIndex += 1;
      patternIndex = starIndex + 1;
      valueIndex = starValueIndex;
    } else {
      return false;
    }
  }
  while (
    patternIndex < patternPoints.length &&
    patternPoints[patternIndex] === "*"
  )
    patternIndex += 1;
  return patternIndex === patternPoints.length;
};

/** Match whole paths where a `**` segment spans zero or more segments. */
const matchSegments = (
  patternSegments: readonly string[],
  pathSegments: readonly string[],
): boolean => {
  const failed = new Set<string>();
  const matchFrom = (patternIndex: number, pathIndex: number): boolean => {
    const state = `${String(patternIndex)}:${String(pathIndex)}`;
    if (failed.has(state)) return false;
    const patternSegment = patternSegments[patternIndex];
    if (patternSegment === undefined) {
      if (pathIndex === pathSegments.length) return true;
      failed.add(state);
      return false;
    }
    if (patternSegment === "**") {
      for (let skip = pathIndex; skip <= pathSegments.length; skip += 1)
        if (matchFrom(patternIndex + 1, skip)) return true;
      failed.add(state);
      return false;
    }
    const pathSegment = pathSegments[pathIndex];
    if (
      pathSegment !== undefined &&
      matchSegment(patternSegment, pathSegment) &&
      matchFrom(patternIndex + 1, pathIndex + 1)
    )
      return true;
    failed.add(state);
    return false;
  };
  return matchFrom(0, 0);
};

const folderMatches = (
  prefix: string,
  paths: readonly string[],
): readonly string[] => {
  const boundary = `${prefix}/`;
  return paths
    .filter((path) => path.startsWith(boundary))
    .sort(compareUnicodeCodePoints);
};

/**
 * Resolve caller selectors against the complete artifact inventory. An entry
 * that exactly names an inventoried path selects that path; otherwise it is a
 * folder prefix (trailing slashes ignored) or a glob where `*` matches within
 * one path segment, `**` spans whole segments and `?` matches one character.
 * Matching is case-sensitive and never touches the filesystem.
 */
export const resolveJavaScriptSourceSelection = (
  entries: readonly string[],
  inventoryPaths: readonly string[],
  unavailablePaths: ReadonlySet<string>,
): JavaScriptSourceSelectorOutcome => {
  const allPaths = new Set(inventoryPaths);
  for (const path of unavailablePaths) allPaths.add(path);
  const paths = [...allPaths];
  const selectedPaths: string[] = [];
  const selected = new Set<string>();
  const unmatchedIndexes: number[] = [];
  let expanded = false;
  for (const [index, entry] of entries.entries()) {
    const base = entry.replace(/\/+$/u, "");
    let matches: readonly string[];
    if (allPaths.has(entry)) matches = [entry];
    else if (base === "") matches = [];
    else if (hasGlobMeta(base))
      matches = paths
        .filter((path) => matchSegments(base.split("/"), path.split("/")))
        .sort(compareUnicodeCodePoints);
    else matches = folderMatches(base, paths);
    if (matches.length === 0) {
      unmatchedIndexes.push(index);
      continue;
    }
    if (!allPaths.has(entry)) expanded = true;
    for (const path of matches)
      if (!selected.has(path)) {
        selected.add(path);
        selectedPaths.push(path);
      }
  }
  return {
    selectedPaths,
    unmatchedIndexes,
    unavailablePaths: selectedPaths.filter((path) =>
      unavailablePaths.has(path),
    ),
    expanded,
  };
};
