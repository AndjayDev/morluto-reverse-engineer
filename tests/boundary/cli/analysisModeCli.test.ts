import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const prepareTarget = async (): Promise<{
  readonly root: string;
  readonly path: string;
}> => {
  const root = await createTestTempDirectory("rea-analysis-mode-cli-");
  const path = join(root, "sample.hop");
  await writeFile(path, "abc");
  return { root, path };
};

cliTest(
  "refuses a background analysis request in the one-shot CLI",
  async ({ cli }) => {
    const { root, path } = await prepareTarget();
    const result = await cli.run({
      arguments: ["inspect", path, "--analysis-mode", "background", "--json"],
      environment: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ code: "capability_unavailable" });
    // The refusal names the MCP alternative.
    expect(JSON.stringify(result.json)).toContain("MCP");
  },
);

cliTest("runs auto mode in the foreground", async ({ cli }) => {
  const { root, path } = await prepareTarget();
  const result = await cli.run({
    arguments: ["inspect", path, "--analysis-mode", "auto", "--json"],
    environment: {
      HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
    },
  });

  // Auto mode keeps the foreground budget, so the CLI never refuses it.
  expect(result.json).not.toMatchObject({ code: "capability_unavailable" });
});
