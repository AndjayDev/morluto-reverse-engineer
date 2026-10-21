import { access, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdaTarget,
  RecordingIdaMcp,
} from "../../tests/fixtures/idaMcp.js";
import { IdaSessionClient } from "./IdaSessionClient.js";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { WindowsPrivateRuntime } from "../windows/WindowsPrivateRuntime.js";

const roots: string[] = [];
const windowsRuntimes = new Set<WindowsPrivateRuntime>();
beforeEach(() => {
  if (process.platform !== "win32") return;
  const create = WindowsPrivateRuntime.create;
  vi.spyOn(WindowsPrivateRuntime, "create").mockImplementation(
    (parent, prefix) => {
      const runtime = create(parent, prefix);
      windowsRuntimes.add(runtime);
      return runtime;
    },
  );
});
afterEach(async () => {
  try {
    for (const runtime of windowsRuntimes) {
      await runtime.close();
      windowsRuntimes.delete(runtime);
    }
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  } finally {
    vi.restoreAllMocks();
  }
});

const fixture = async (mode: "attached" | "headless", timeoutMs = 1000) => {
  const { root, target } = await createIdaTarget();
  roots.push(root);
  const producer = new RecordingIdaMcp(target, mode, "hexrays");
  producer.guiDatabases =
    mode === "attached" ? [{ path: target.path, sha256: target.sha256 }] : [];
  const client = new IdaSessionClient(
    {
      command: "fixture",
      args: [],
      env: {},
      mode,
      protocol: "hexrays",
      timeoutMs,
      workspaceRoot: root,
    },
    target,
    producer,
  );
  return { root, target, producer, client };
};

describe("official hexrays attached sessions", () => {
  it("binds the GUI database whose digest matches the target", async () => {
    const { target, producer, client } = await fixture("attached");
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(true);
    const opens = producer.calls.filter(({ name }) => name === "open_database");
    expect(opens).toHaveLength(1);
    expect(opens[0]?.args).toMatchObject({ path: target.path });
    const reads = producer.calls.filter(
      ({ name }) => name === "execute_python",
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads)
      expect(read.args).not.toHaveProperty("instance_id");
    expect((await client.close()).ok).toBe(true);
    // Attached leases of GUI databases are never released with close_database.
    expect(producer.calls.some(({ name }) => name === "close_database")).toBe(
      false,
    );
  });

  it("skips non-matching GUI databases before binding", async () => {
    const { target, producer, client } = await fixture("attached");
    producer.guiDatabases = [
      { path: "/gui/other", sha256: "0".repeat(64) },
      { path: target.path, sha256: target.sha256 },
    ];
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(true);
    expect(
      producer.calls.filter(({ name }) => name === "open_database"),
    ).toHaveLength(2);
    await client.close();
  });

  it("reports the GUI candidates when none matches", async () => {
    const { target, producer, client } = await fixture("attached");
    producer.guiDatabases = [
      { path: "/gui/a", sha256: "0".repeat(64) },
      { path: "/gui/b", sha256: "1".repeat(64) },
    ];
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain(
        "/gui/a (input digest mismatch), /gui/b (input digest mismatch)",
      );
    expect((await client.close()).ok).toBe(true);
  });

  it("rejects startup when the IDA GUI has no database", async () => {
    const { producer, client } = await fixture("attached");
    producer.guiDatabases = [];
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain("no database open in the IDA GUI");
    await client.close();
  });

  it("translates reads through execute_python with legacy shapes", async () => {
    const { client } = await fixture("attached");
    const pseudocode = await client.execute("procedure_pseudo_code", {
      procedure: "main",
    });
    expect(pseudocode.ok).toBe(true);
    if (pseudocode.ok)
      expect(pseudocode.value.result).toBe("int main(void) { return 42; }");
    const callers = await client.execute("procedure_callers", {
      procedure: "main",
    });
    expect(callers.ok).toBe(true);
    if (callers.ok) expect(callers.value.result).toEqual(["0x1000"]);
    await client.close();
  });

  it("flags a function that the database does not know", async () => {
    const { client } = await fixture("attached");
    const result = await client.execute("procedure_pseudo_code", {
      procedure: "missing_function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(
        result.error instanceof AnalysisProtocolError ||
          result.error.message.includes("Not found"),
      ).toBe(true);
    await client.close();
  });
});

describe("official hexrays headless sessions", () => {
  it("opens the private copy, pins the instance, and releases it", async () => {
    const { producer, client } = await fixture("headless", 5000);
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(true);
    const reads = producer.calls.filter(
      ({ name }) => name === "execute_python",
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads)
      expect(read.args).toMatchObject({
        instance_id: "fixture-official-instance",
      });
    const opens = producer.calls.filter(({ name }) => name === "open_database");
    expect(opens[0]?.args.path).toContain("target.elf");
    const closed = await client.close();
    expect(closed.ok).toBe(true);
    expect(producer.calls.some(({ name }) => name === "close_database")).toBe(
      true,
    );
    expect(
      producer.calls.filter(({ name }) => name === "list_databases").at(-1)
        ?.args,
    ).toEqual({});
    // The confirmed release must have removed the private workspace.
    const workspaceInput = opens[0]?.args.path;
    if (typeof workspaceInput !== "string")
      throw new Error("The fixture recorded no private input copy.");
    await expect(access(dirname(workspaceInput))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains the workspace when the worker release fails", async () => {
    const { producer, client } = await fixture("headless", 5000);
    producer.failClose = true;
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(true);
    const closed = await client.close();
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.error).toBeInstanceOf(ProviderAdapterError);
      expect(closed.error.diagnostics?.reason).toContain(
        "remaining connection or private workspace is retained",
      );
    }
    expect(producer.detaches).toBe(1);
    producer.failClose = false;
    await client.close();
  });

  it("serves caller-proven direct callers in headless mode", async () => {
    const { client } = await fixture("headless", 5000);
    const callers = await client.execute("procedure_callers", {
      procedure: "main",
    });
    expect(callers.ok).toBe(true);
    if (callers.ok) expect(callers.value.result).toEqual(["0x1000"]);
    await client.close();
  });

  it("resolves address containment through functions and exact segments", async () => {
    const { client } = await fixture("headless", 5000);
    const inside = await client.execute("resolve_containing_procedure", {
      address: "0x1000",
    });
    expect(inside.ok).toBe(true);
    if (inside.ok)
      expect(inside.value.result).toMatchObject({
        query_address: "0x1000",
        found: true,
        procedure: { address: "0x1000", name: "main" },
      });
    const between = await client.execute("resolve_containing_procedure", {
      address: "0x1500",
    });
    expect(between.ok).toBe(true);
    if (between.ok)
      expect(between.value.result).toMatchObject({
        found: false,
        reason: "not_in_procedure",
      });
    const outside = await client.execute("resolve_containing_procedure", {
      address: "0x5000",
    });
    expect(outside.ok).toBe(true);
    if (outside.ok)
      expect(outside.value.result).toMatchObject({
        found: false,
        reason: "outside_segments",
      });
    await client.close();
  });
});
