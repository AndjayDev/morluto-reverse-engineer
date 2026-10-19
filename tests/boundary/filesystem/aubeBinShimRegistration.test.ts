import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { classifyClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { setupRegistrationCommand } from "../../../src/application/SetupHost.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// The bin shim aube (mise's npm backend) wrote for rea-agents 6.7.0.
const aubeShim = (target: string): string => `#!/bin/sh
# aube-bin-shim v2 target=${target}
link="$0"
hops=0
while [ -L "$link" ] && [ "$hops" -lt 40 ]; do
hops=$((hops+1))
target=$(readlink "$link")
case "$target" in
/*) link="$target" ;;
*)  link="$(dirname "$link")/$target" ;;
esac
done
basedir=$(dirname "$link")
export NODE_PATH="$basedir/..:$basedir/../.mise/node_modules"
if [ -x "$basedir/node" ]; then
  exec "$basedir/node" "$basedir/${target}" "$@"
else
  exec node "$basedir/${target}" "$@"
fi
`;

const storeTarget = (version: string): string =>
  `../.mise/rea-agents@${version}/node_modules/rea-agents/scripts/rea.mjs`;

/** Lay out one aube install of `version` and return its entrypoint and shim. */
const installAube = async (
  root: string,
  version: string,
  shimTarget = storeTarget(version),
): Promise<{ entrypoint: string; shim: string }> => {
  const shim = join(root, "node_modules", ".bin", "rea");
  const entrypoint = join(root, "node_modules", ".bin", storeTarget(version));
  await mkdir(dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, "#!/usr/bin/env node\n");
  await mkdir(dirname(shim), { recursive: true });
  await writeFile(shim, aubeShim(shimTarget), { mode: 0o755 });
  return { entrypoint, shim };
};

const registerWithClaudeCode = async (
  home: string,
  command: readonly string[],
): Promise<void> => {
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        rea: { command: command[0], args: command.slice(1) },
      },
    }),
  );
};

const claudeCodeState = async (
  home: string,
  entrypoint: string,
): Promise<string | undefined> =>
  (
    await readClientRegistrationStatuses(home, entrypoint, {
      platform: "linux",
      environment: {},
    })
  ).find(({ client }) => client === "claude_code")?.state;

it.skipIf(process.platform === "win32")(
  "registers the aube bin shim, which stays aligned across an upgrade",
  async () => {
    const home = await createTestTempDirectory("rea-aube-registration-");
    const root = join(home, "installs", "rea", "latest");
    const before = await installAube(root, "6.7.0");

    const command = setupRegistrationCommand(
      "linux",
      undefined,
      before.entrypoint,
    );
    expect(command).toEqual([before.shim, "mcp"]);
    expect(classifyClientRegistrationCommand(command, before.entrypoint)).toBe(
      "owned",
    );
    await registerWithClaudeCode(home, command);
    expect(await claudeCodeState(home, before.entrypoint)).toBe("aligned");

    // An upgrade rewrites the shim in place and prunes the old store entry.
    const after = await installAube(root, "6.8.0");
    await rm(dirname(dirname(dirname(dirname(before.entrypoint)))), {
      recursive: true,
    });
    expect(after.shim).toBe(before.shim);
    expect(
      setupRegistrationCommand("linux", undefined, after.entrypoint),
    ).toEqual(command);
    expect(await claudeCodeState(home, after.entrypoint)).toBe("aligned");
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the script path when the shim does not run this entrypoint",
  async () => {
    const home = await createTestTempDirectory("rea-aube-foreign-shim-");
    const root = join(home, "installs", "rea", "latest");
    const { entrypoint, shim } = await installAube(
      root,
      "6.7.0",
      "../.mise/other@1.0.0/node_modules/other/bin.js",
    );

    expect(setupRegistrationCommand("linux", undefined, entrypoint)).toEqual([
      entrypoint,
      "mcp",
    ]);
    expect(classifyClientRegistrationCommand([shim, "mcp"], entrypoint)).toBe(
      "foreign",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "ignores shims in a format it does not know",
  async () => {
    const home = await createTestTempDirectory("rea-aube-unknown-shim-");
    const root = join(home, "installs", "rea", "latest");
    const { entrypoint, shim } = await installAube(root, "6.7.0");
    await writeFile(
      shim,
      aubeShim(storeTarget("6.7.0")).replace(
        "aube-bin-shim v2",
        "aube-bin-shim v3",
      ),
    );

    expect(setupRegistrationCommand("linux", undefined, entrypoint)).toEqual([
      entrypoint,
      "mcp",
    ]);
  },
);

it.skipIf(process.platform === "win32")(
  "classifies a registered FIFO without blocking on it",
  async () => {
    const home = await createTestTempDirectory("rea-aube-fifo-");
    const root = join(home, "installs", "rea", "latest");
    const { entrypoint } = await installAube(root, "6.7.0");
    const fifo = join(home, "rea-fifo");
    execFileSync("mkfifo", [fifo]);

    expect(classifyClientRegistrationCommand([fifo, "mcp"], entrypoint)).toBe(
      "foreign",
    );
  },
);
