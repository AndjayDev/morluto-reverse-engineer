import { describe, expect, it } from "vitest";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import {
  hexraysCloseDatabaseSchema,
  hexraysDatabaseListSchema,
  hexraysFunctionByNameQuery,
  hexraysOpenDatabaseSchema,
  hexraysRequest,
  hexraysTools,
  unwrapHexraysExecuteResult,
} from "./IdaHexraysProtocol.js";

describe("official IDA MCP protocol values", () => {
  it("parses the observed upstream lifecycle replies", () => {
    expect(
      hexraysDatabaseListSchema.parse({
        instances: [
          {
            path: "/tmp/target",
            backend: "gui",
            status: "available",
            instance_id: null,
            error: null,
          },
          {
            path: "/tmp/workspace/target.i64",
            backend: "idalib",
            status: "current",
            instance_id: "59af0b5c7226",
            error: null,
          },
        ],
      }).instances,
    ).toHaveLength(2);
    expect(
      hexraysOpenDatabaseSchema.parse({
        instance_id: "59af0b5c7226",
        backend: "idalib",
        status: "current",
        recovery: "none",
        log_path: "/sessions/1.jsonl",
        mcp_id: null,
        hint: "Call reference(query)…",
      }),
    ).toMatchObject({ backend: "idalib", instance_id: "59af0b5c7226" });
    expect(
      hexraysOpenDatabaseSchema.parse({
        instance_id: null,
        backend: "gui",
        status: "current",
      }).instance_id,
    ).toBeNull();
    expect(hexraysCloseDatabaseSchema.parse({ closed: true }).closed).toBe(
      true,
    );
  });

  it("requires exactly the official tool catalog", () => {
    expect([...hexraysTools]).toEqual([
      "open_database",
      "execute_python",
      "list_databases",
      "close_database",
    ]);
  });

  it("unwraps the execute envelope without touching bare payloads", () => {
    expect(
      unwrapHexraysExecuteResult({ result: 2, stdout: "", stderr: "" }),
    ).toBe(2);
    expect(unwrapHexraysExecuteResult({ result: null })).toBeNull();
    expect(unwrapHexraysExecuteResult({ data: [], next_offset: null })).toEqual(
      { data: [], next_offset: null },
    );
  });

  it("surfaces failed execute queries instead of a lookup miss", () => {
    expect(() =>
      unwrapHexraysExecuteResult({ error: "boom", stdout: "", stderr: "" }),
    ).toThrowError(AnalysisProtocolError);
    expect(() =>
      unwrapHexraysExecuteResult({ error: "boom", stdout: "", stderr: "" }),
    ).toThrowError(/boom/);
    expect(() =>
      unwrapHexraysExecuteResult({
        result: null,
        stdout: "",
        stderr: "Traceback (most recent call last)",
      }),
    ).toThrowError(/Traceback/);
    expect(
      unwrapHexraysExecuteResult({ result: null, stdout: "", stderr: "" }),
    ).toBeNull();
    expect(
      unwrapHexraysExecuteResult({
        result: "int main(void)",
        stdout: "",
        stderr: "decompiler warning",
      }),
    ).toBe("int main(void)");
  });
});

describe("official IDA MCP request translation", () => {
  it("translates every legacy-shaped read into execute_python", () => {
    const translated = hexraysRequest(
      "list_functions",
      { offset: 0, count: 100 },
      "59af0b5c7226",
    );
    expect(translated?.name).toBe("execute_python");
    expect(translated?.args).toMatchObject({ instance_id: "59af0b5c7226" });
    expect(String(translated?.args.code)).toContain("idautils.Functions()");
    expect(hexraysRequest("get_metadata", {}, undefined)?.args.code).toContain(
      "_rea_metadata()",
    );
  });

  it("omits the instance pin only when no headless instance is bound", () => {
    expect(
      hexraysRequest("get_metadata", {}, undefined)?.args,
    ).not.toHaveProperty("instance_id");
    expect(hexraysRequest("get_metadata", {}, "id-1")?.args).toHaveProperty(
      "instance_id",
      "id-1",
    );
  });

  it("normalizes numeric addresses for the generated queries", () => {
    expect(
      String(
        hexraysRequest("get_xrefs_to", { address: 0x400a16 }, undefined)?.args
          .code,
      ),
    ).toContain('int("0x400a16", 16)');
  });

  it("leaves untranslated tools to the caller's error", () => {
    expect(hexraysRequest("set_address_name", {}, undefined)).toBeUndefined();
  });

  it("translates the modern segment survey request", () => {
    expect(
      hexraysRequest("survey_binary", { detail_level: "minimal" }, "i")?.args
        .code,
    ).toContain("idautils.Segments()");
  });

  it("pages inventories without materializing them", () => {
    const functions = String(
      hexraysRequest("list_functions", { offset: 0, count: 100 }, "i")?.args
        .code,
    );
    expect(functions).toContain("for _f in idautils.Functions():");
    expect(functions).not.toContain("list(idautils.Functions())");
    const strings = String(
      hexraysRequest("list_strings", { offset: 0, count: 0 }, "i")?.args.code,
    );
    expect(strings).toContain("for _s in idautils.Strings():");
    expect(strings).not.toContain("list(idautils.Strings())");
  });

  it("embeds hostile names as JSON literals only", () => {
    const hostile = 'weird % name "quotes"';
    const code = hexraysFunctionByNameQuery(hostile);
    expect(code).toContain(JSON.stringify(hostile));
    expect(code).not.toContain(`'${hostile}'`);
  });
});
