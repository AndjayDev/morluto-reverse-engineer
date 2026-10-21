import { expect, it } from "vitest";
import {
  dependencyReconstructionCoverageData,
  contradictionReconstructionCoverageData,
} from "../../../src/domain/reconstructionCoverage.fixture.js";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";

it("reports a transitive missing dependency through the compiled CLI and preserves complete controls", async () => {
  const observedAt = new Date().toISOString();
  for (const [edges, status] of [
    [{ "cli.help": [] }, "ready"],
    [{ "cli.help": ["absent"] }, "partial"],
    [{ "cli.help": ["dep"], dep: ["absent"] }, "partial"],
    [{ "cli.help": ["dep"], dep: ["absent"], absent: [] }, "ready"],
  ] as const) {
    const input = {
      coverage: dependencyReconstructionCoverageData(edges, observedAt),
      boundary_id: "replacement.cli",
    };
    const result = await runCliJson([
      "evaluate-reconstruction-coverage",
      JSON.stringify(input),
      "--json",
    ]);
    expect(result).toMatchObject({ status, boundary_id: "replacement.cli" });
  }
});

it("rejects a dependency contradiction through the compiled CLI and accepts its resolution", async () => {
  const coverage = dependencyReconstructionCoverageData(
    { "cli.help": ["mid"], mid: ["dep"], dep: [] },
    new Date().toISOString(),
  );
  for (const [contradictionStatus, status] of [
    ["active", "failed"],
    ["resolved", "ready"],
  ] as const) {
    const input = {
      coverage: contradictionReconstructionCoverageData(
        coverage,
        ["dep"],
        contradictionStatus,
      ),
      boundary_id: "replacement.cli",
    };
    const result = await runCliJson([
      "evaluate-reconstruction-coverage",
      JSON.stringify(input),
      "--json",
    ]);
    expect(result).toMatchObject({
      status,
      summary: { required_surfaces: 1 },
      reasons:
        contradictionStatus === "active"
          ? [
              {
                code: "active-contradiction",
                subject_id: "contradiction.fixture",
              },
            ]
          : [],
    });
  }
});
