import { describe, expect, it } from "vitest";

import { resolveJavaScriptSourceSelection } from "./javascriptSourceSelectionResolution.js";

const resolve = (
  entries: readonly string[],
  inventory: readonly string[],
  unavailable: readonly string[] = [],
) => resolveJavaScriptSourceSelection(entries, inventory, new Set(unavailable));

describe("resolveJavaScriptSourceSelection", () => {
  it("selects exact inventoried paths in first-request order without duplicates", () => {
    expect(
      resolve(
        ["main.js", "package.json", "main.js"],
        ["package.json", "main.js", "other.js"],
      ),
    ).toEqual({
      selectedPaths: ["main.js", "package.json"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: false,
    });
  });

  it("resolves a folder selector to every inventoried file under its slash boundary", () => {
    expect(
      resolve(
        ["out/main"],
        [
          "out/main.js",
          "out/mainx/other.js",
          "out/main/index.js",
          "out/main/deep/worker.js",
          "other.js",
        ],
      ),
    ).toEqual({
      selectedPaths: ["out/main/deep/worker.js", "out/main/index.js"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
  });

  it("treats a trailing slash as the same folder selector", () => {
    expect(
      resolve(["out/main/"], ["out/main/index.js", "out/main.js"]),
    ).toEqual({
      selectedPaths: ["out/main/index.js"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
  });

  it("prefers an exact inventoried path over a folder of the same name", () => {
    expect(resolve(["out/main"], ["out/main", "out/main/index.js"])).toEqual({
      selectedPaths: ["out/main"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: false,
    });
  });

  it("selects an exact inventoried path even when it contains glob characters", () => {
    expect(resolve(["weird*.js"], ["weird*.js", "weird1.js"])).toEqual({
      selectedPaths: ["weird*.js"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: false,
    });
  });

  it("keeps first-request priority across overlapping selectors", () => {
    expect(resolve(["out/**", "out/b.js"], ["out/a.js", "out/b.js"])).toEqual({
      selectedPaths: ["out/a.js", "out/b.js"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
    expect(resolve(["out/b.js", "out/**"], ["out/a.js", "out/b.js"])).toEqual({
      selectedPaths: ["out/b.js", "out/a.js"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
  });

  it("keeps resolved paths whose inventoried bytes are unavailable", () => {
    expect(resolve(["gone.js"], ["a.js"], ["gone.js"])).toEqual({
      selectedPaths: ["gone.js"],
      unmatchedIndexes: [],
      unavailablePaths: ["gone.js"],
      expanded: false,
    });
    expect(resolve(["**"], ["a.js"], ["gone.js"])).toEqual({
      selectedPaths: ["a.js", "gone.js"],
      unmatchedIndexes: [],
      unavailablePaths: ["gone.js"],
      expanded: true,
    });
  });
});

describe("resolveJavaScriptSourceSelection unmatched selectors", () => {
  it("reports every selector that matches no inventoried file", () => {
    expect(
      resolve(
        ["a.js", "nope", "out/nothing/**", "./a.js"],
        ["a.js", "out/x.js"],
      ),
    ).toEqual({
      selectedPaths: ["a.js"],
      unmatchedIndexes: [1, 2, 3],
      unavailablePaths: [],
      expanded: false,
    });
    expect(resolve(["nothing/**"], ["a.js"])).toEqual({
      selectedPaths: [],
      unmatchedIndexes: [0],
      unavailablePaths: [],
      expanded: false,
    });
  });

  it("stays case-sensitive and ignores selectors left empty by slashes", () => {
    expect(resolve(["Main.js"], ["main.js"])).toEqual({
      selectedPaths: [],
      unmatchedIndexes: [0],
      unavailablePaths: [],
      expanded: false,
    });
    expect(resolve(["/"], ["a.js"])).toEqual({
      selectedPaths: [],
      unmatchedIndexes: [0],
      unavailablePaths: [],
      expanded: false,
    });
    expect(resolve(["out/"], ["out"])).toEqual({
      selectedPaths: [],
      unmatchedIndexes: [0],
      unavailablePaths: [],
      expanded: false,
    });
  });
});

describe("resolveJavaScriptSourceSelection glob matching", () => {
  it("keeps a single star within one path segment", () => {
    expect(resolve(["out/*"], ["out/a.js", "out/deep/b.js"])).toEqual({
      selectedPaths: ["out/a.js"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
    expect(resolve(["out*"], ["out.js", "out/deep/b.js"])).toEqual({
      selectedPaths: ["out.js"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
  });

  it("spans zero or more whole segments with a double star", () => {
    expect(resolve(["out/**"], ["out", "out/a.js", "out/deep/b.js"])).toEqual({
      selectedPaths: ["out", "out/a.js", "out/deep/b.js"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
    expect(
      resolve(["a/**/z.js"], ["a/z.js", "a/x/y/z.js", "a/x/q.js"]),
    ).toEqual({
      selectedPaths: ["a/x/y/z.js", "a/z.js"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
    expect(resolve(["**/*.map"], ["a.map", "x/y/b.map", "c.js"])).toEqual({
      selectedPaths: ["a.map", "x/y/b.map"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
  });

  it("matches one code point with a question mark", () => {
    expect(resolve(["v?.js"], ["v1.js", "v12.js", "v\u{1f600}.js"])).toEqual({
      selectedPaths: ["v1.js", "v\u{1f600}.js"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
  });

  it("matches container-prefixed inventory paths", () => {
    expect(
      resolve(
        ["nested.asar/**"],
        ["nested.asar/main.mjs", "nested.asar/lib/x.js", "main.mjs"],
      ),
    ).toEqual({
      selectedPaths: ["nested.asar/lib/x.js", "nested.asar/main.mjs"],
      unmatchedIndexes: [],
      unavailablePaths: [],
      expanded: true,
    });
  });
});
