import { createPackageWithOptions } from "@electron/asar";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { writeJavaScriptSourceTreeFixture } from "../../fixtures/javascriptSourceTree.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for([
  { format: "directory", command: "analyze" },
  { format: "asar", command: "analyze-javascript-application" },
])(
  "resolves $format sources by inventory folder and glob selectors",
  { timeout: 120_000 },
  async ({ format, command }, { cli }) => {
    const directory = await createTestTempDirectory("rea-js-source-tree-");
    const files = await writeJavaScriptSourceTreeFixture(directory);
    let input = directory;
    if (format === "asar") {
      input = join(
        await createTestTempDirectory("rea-js-source-tree-asar-"),
        "app.asar",
      );
      await createPackageWithOptions(directory, input, {});
    }
    const analysis = async (selectors: readonly string[]) => {
      const response = await cli.run({
        arguments: [
          command,
          input,
          ...selectors.flatMap((selector) => ["--source-path", selector]),
          "--format",
          "json",
        ],
      });
      expect(response.exitCode).toBe(0);
      const evidence = parseEvidence(response.json);
      return {
        evidence,
        result: javascriptApplicationAnalysisResultSchema.parse(
          evidence.normalized_result,
        ),
      };
    };

    const preload = ["out/preload/deep/nested.js", "out/preload/index.js"];
    const preloadForm = await analysis(["out/preload"]);
    expect(preloadForm.evidence.parameters.source_paths).toEqual([
      "out/preload",
    ]);
    expect(preloadForm.result.source_selection).toEqual({
      requested_paths: ["out/preload"],
      selected_paths: preload,
      unselected_files: files.size - preload.length,
    });
    expect(preloadForm.result.statistics.text_bytes_read).toBe(
      files.get("out/preload/deep/nested.js")!.length +
        files.get("out/preload/index.js")!.length,
    );
    for (const [path] of files) {
      const properties = preloadForm.result.graph.nodes
        .flatMap(({ observations }) =>
          observations.map(({ properties }) => properties),
        )
        .find(
          (properties) =>
            properties.path === path && properties.text_status !== undefined,
        );
      expect(properties?.text_status).toBe(
        preload.includes(path) ? "included" : "outside-analysis-scope",
      );
    }
    for (const selector of ["out/preload/", "out/preload/**"]) {
      const equivalent = await analysis([selector]);
      expect(equivalent.result.source_selection).toEqual({
        requested_paths: [selector],
        selected_paths: preload,
        unselected_files: files.size - preload.length,
      });
    }

    const direct = await analysis(["out/preload/*"]);
    expect(direct.result.source_selection).toEqual({
      requested_paths: ["out/preload/*"],
      selected_paths: ["out/preload/index.js"],
      unselected_files: files.size - 1,
    });
    expect(
      direct.result.semantic_graph.unknowns.some(
        ({ reason, detail }) =>
          reason === "incomplete-module" &&
          detail.includes("caller-selected source_paths"),
      ),
    ).toBe(true);

    const main = await analysis(["out/main"]);
    expect(main.result.source_selection).toEqual({
      requested_paths: ["out/main"],
      selected_paths: ["out/main/index.js", "out/main/nested/worker.js"],
      unselected_files: files.size - 2,
    });

    const mixed = await analysis(["out/main.js", "out/**"]);
    expect(mixed.result.source_selection).toEqual({
      requested_paths: ["out/main.js", "out/**"],
      selected_paths: [
        "out/main.js",
        "out/main/index.js",
        "out/main/nested/worker.js",
        "out/mainx/other.js",
        "out/preload/deep/nested.js",
        "out/preload/index.js",
        "out/web/assets/chunk-one.js",
      ],
      unselected_files: files.size - 7,
    });

    const full = await analysis([]);
    expect(full.result.source_selection).toBeUndefined();
    expect(full.result.statistics).toMatchObject({
      relevant_files: files.size,
      invalid_utf8_files: 0,
      parse_failures: 0,
    });
    expect([
      mixed.result.root_artifact_sha256,
      mixed.result.inventory_manifest_id,
      mixed.result.inventory_graph_sha256,
    ]).toEqual([
      full.result.root_artifact_sha256,
      full.result.inventory_manifest_id,
      full.result.inventory_graph_sha256,
    ]);
    if (format === "asar")
      expect(mixed.result.root_artifact_sha256).toBe(
        createHash("sha256")
          .update(await readFile(input))
          .digest("hex"),
      );
  },
);

cliTest(
  "rejects selectors that match no inventoried file and keeps the request recoverable",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-js-source-tree-");
    await writeJavaScriptSourceTreeFixture(directory);
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        directory,
        "--source-path",
        "out/nothing/**",
        "--source-path",
        "./package.json",
        "--format",
        "json",
      ],
    });
    expect(response.exitCode).toBe(1);
    expect(response.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          { path: ["source_paths", 0], reason: "invalid_value" },
          { path: ["source_paths", 1], reason: "invalid_value" },
        ],
      },
    });
  },
);
