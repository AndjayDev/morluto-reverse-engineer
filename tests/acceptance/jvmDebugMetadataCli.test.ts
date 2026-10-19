import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import { jvmDebugClass } from "../fixtures/jvmDebugClass.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { storedZip } from "../fixtures/storedZip.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../support/cli/cliFixture.js";

const TOOL = "inspect_jvm_debug_metadata";

/** Run one selection over CLI and MCP and require the same outcome from both. */
const inspectBoth = async (
  cli: TestCli,
  call: Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"],
  input: { readonly path: string; readonly entry?: string },
): Promise<
  | { readonly ok: true; readonly evidence: unknown }
  | { readonly ok: false; readonly error: unknown }
> => {
  const viaCli = await cli.run({
    arguments: [
      "inspect-jvm-debug-metadata",
      input.path,
      ...(input.entry === undefined ? [] : ["--entry", input.entry]),
      "--json",
    ],
  });
  const viaMcp = await call(TOOL, input);
  if (viaCli.exitCode !== 0) {
    expect(parseMcpToolError(viaMcp).error).toMatchObject(
      viaCli.json as object,
    );
    return { ok: false, error: viaCli.json };
  }
  const evidence = toolContract(TOOL).outputSchema.parse(viaCli.json);
  expect(viaMcp.isError, JSON.stringify(viaMcp)).not.toBe(true);
  expect(viaMcp.structuredContent).toEqual(evidence);
  return { ok: true, evidence };
};

cliTest(
  "refuses a class file with bytes after its structure over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-jvm-trailing-");
    const path = join(root, "Example.class");
    await writeFile(path, jvmDebugClass({ trailingBytes: 3 }));
    const { client, call } = await connectLocalToolsMcp();
    const outcome = await inspectBoth(cli, call, { path });
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["path"],
              reason: "invalid_format",
              message: expect.stringContaining("3 extra bytes") as string,
            },
          ],
        },
      },
    });
    await client.ping();
  },
  30000,
);

cliTest(
  "reports a local outside max_locals as malformed over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-jvm-slots-");
    const { client, call } = await connectLocalToolsMcp();
    // run(J)V with max_locals 2: the long parameter fills slots 0 and 1.
    const cases = [
      { name: "valid", options: {}, lvt: "present", lvtt: "absent" },
      // HotSpot: "Invalid index 1 in LocalVariableTable" (a J's second slot).
      {
        name: "wide-second-slot",
        options: { locals: [{ slot: 1, descriptor: "J" }] },
        lvt: "malformed",
        lvtt: "absent",
      },
      // HotSpot: "Invalid index 2 in LocalVariableTypeTable".
      {
        name: "typed-slot",
        options: { typedLocals: [{ slot: 2, descriptor: "I" }] },
        lvt: "present",
        lvtt: "malformed",
      },
      // HotSpot reads LocalVariableTypeTable only from version 49: it loads
      // the same table in a version 48 class.
      {
        name: "typed-slot-v48",
        options: {
          majorVersion: 48,
          typedLocals: [{ slot: 2, descriptor: "I" }],
        },
        lvt: "present",
        lvtt: "present",
      },
    ] as const;
    for (const { name, options, lvt, lvtt } of cases) {
      const path = join(root, `${name}.class`);
      await writeFile(path, jvmDebugClass(options));
      const outcome = await inspectBoth(cli, call, { path });
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
      expect(outcome.evidence).toMatchObject({
        normalized_result: {
          methods: [
            {
              state:
                lvt === "present" && lvtt !== "malformed"
                  ? "present"
                  : "malformed",
              max_locals: 2,
              local_variable_table: { presence: lvt },
              local_variable_type_table: { presence: lvtt },
            },
          ],
        },
      });
    }
    await client.ping();
  },
  30000,
);

cliTest(
  "reports debug positions outside the code as malformed over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-jvm-pcs-");
    const { client, call } = await connectLocalToolsMcp();
    // code_length is 1. HotSpot: "Invalid pc in LineNumberTable" and
    // "Invalid length 2 in LocalVariableTable".
    const cases = [
      {
        name: "line-pc",
        options: { linePc: 1 },
        line: "malformed",
        lvt: "present",
      },
      {
        name: "scope-length",
        options: { locals: [{ slot: 0, descriptor: "J", length: 2 }] },
        line: "present",
        lvt: "malformed",
      },
    ] as const;
    for (const { name, options, line, lvt } of cases) {
      const path = join(root, `${name}.class`);
      await writeFile(path, jvmDebugClass(options));
      const outcome = await inspectBoth(cli, call, { path });
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
      expect(outcome.evidence).toMatchObject({
        normalized_result: {
          methods: [
            {
              state: "malformed",
              line_number_table: { presence: line },
              local_variable_table: { presence: lvt },
            },
          ],
        },
      });
    }
    await client.ping();
  },
  30000,
);

cliTest(
  "names unflagged JAR members as the JDK does (UTF-8) over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-jvm-names-");
    const { client, call } = await connectLocalToolsMcp();
    const ascii = (text: string): Uint8Array => Buffer.from(text, "latin1");
    // Unflagged UTF-8 bytes C3 A9: JarFile.getEntry("é.class") finds it.
    const utf8 = join(root, "utf8.jar");
    await writeFile(
      utf8,
      storedZip([
        { name: Buffer.from("é.class", "utf8"), bytes: jvmDebugClass() },
      ]),
    );
    const found = await inspectBoth(cli, call, {
      path: utf8,
      entry: "é.class",
    });
    if (!found.ok) throw new Error(JSON.stringify(found.error));
    expect(found.evidence).toMatchObject({
      normalized_result: { selected_entry: { entry: "é.class" } },
    });
    // An unflagged CP437 0x82 ("é") is invalid UTF-8: JarFile refuses the
    // whole archive ("invalid CEN header (bad entry name or comment)"), so
    // the valid sibling is not selectable either.
    const cp437 = join(root, "cp437.jar");
    await writeFile(
      cp437,
      storedZip([
        { name: ascii("Example.class"), bytes: jvmDebugClass() },
        { name: Uint8Array.of(0x82, ...ascii(".txt")), bytes: ascii("x") },
      ]),
    );
    const refused = await inspectBoth(cli, call, {
      path: cp437,
      entry: "Example.class",
    });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        details: {
          issues: [
            {
              reason: "invalid_format",
              message: expect.stringContaining("not valid UTF-8") as string,
            },
          ],
        },
      },
    });
    await client.ping();
  },
  30000,
);

cliTest(
  "reports the ZIP decompression budget a JAR exceeds over CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-jvm-zip-limit-");
    const { client, call } = await connectLocalToolsMcp();
    const path = join(root, "declares-more.jar");
    // One member declares 300 MiB uncompressed: past the 256 MiB minimum
    // decompression budget of a small archive, not the class-file size limit.
    await writeFile(
      path,
      storedZip([
        { name: Buffer.from("Example.class"), bytes: jvmDebugClass() },
        {
          name: Buffer.from("big.bin"),
          bytes: Buffer.from("x"),
          declaredSize: 300 * 1024 * 1024,
        },
      ]),
    );
    const outcome = await inspectBoth(cli, call, {
      path,
      entry: "Example.class",
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "resource_constraint",
        details: {
          resource: "capacity",
          reported_limits: { max_decompressed_bytes: 256 * 1024 * 1024 },
        },
      },
    });
    expect(
      (outcome as { error: { details: { reported_limits: object } } }).error
        .details.reported_limits,
    ).not.toHaveProperty("max_input_bytes");
    await client.ping();
  },
  30000,
);
