import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectPythonPycInputSchema,
  pythonPycSchema,
  type PythonPyc,
} from "../domain/python/pythonPyc.js";
import {
  marshalCode,
  pythonPycFixture,
  pythonPycHeader,
} from "./PythonPyc.fixture.js";
import { parsePythonPyc } from "./PythonPycParser.js";
import {
  PythonPycFormatFailure,
  PythonPycResourceFailure,
} from "./PythonPyc.errors.js";

const defaults = inspectPythonPycInputSchema.parse({
  path: "/artifacts/sample.pyc",
});

const root = (report: PythonPyc) => {
  const code = report.code_objects[0];
  if (code === undefined) throw new Error("Report lists no code object");
  return code;
};

const parse = (bytes: Buffer) =>
  parsePythonPyc(
    bytes,
    {
      path: defaults.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    defaults,
  );

it("reads 3.7, 3.10 and 3.12 layouts including nested code", () => {
  const py37 = parse(pythonPycFixture("py37"));
  expect(py37.header).toMatchObject({
    magic: 3394,
    python_version: "3.7",
    code_layout: "py37",
    hash_based: false,
  });
  expect(root(py37).posonlyargcount).toBeNull();
  expect(root(py37).nlocals).toBe(0);
  expect(root(py37).qualname).toBeNull();

  const py38 = parse(pythonPycFixture("py38", { nested: true }));
  expect(py38.header.python_version).toBe("3.10");
  expect(root(py38).posonlyargcount).toBe(0);
  expect(py38.code_objects[1]?.name).toBe("inner");
  expect(py38.coverage.code_objects).toBe(2);

  const py311 = parse(pythonPycFixture("py311", { nested: true }));
  expect(py311.header).toMatchObject({
    magic: 3531,
    python_version: "3.12",
    code_layout: "py311",
  });
  expect(root(py311).nlocals).toBeNull();
  expect(root(py311).qualname).toBe("<module>");
  expect(py311.code_objects[1]?.name).toBe("inner");
  expect(root(py311).consts).toEqual(
    expect.arrayContaining([
      { kind: "code", name: "inner", firstlineno: 2 },
      { kind: "none" },
    ]),
  );
});

it("decodes a hash-based header and a FLAG_REF top-level code object", () => {
  const bytes = pythonPycFixture("py311", {
    flaggedCode: true,
    header: {
      flags: 0x1,
      sourceHash: Buffer.from("0102030405060708", "hex"),
    },
  });
  const report = parse(bytes);
  expect(report.header).toMatchObject({
    hash_based: true,
    check_source: false,
    source_hash_hex: "0102030405060708",
    source_mtime: null,
    source_size: null,
  });
  expect(root(report).name).toBe("<module>");
});

it("fails unknown magics and truncated marshal without partial success", () => {
  const unknown = Buffer.concat([pythonPycHeader(1), marshalCode("py311")]);
  expect(() => parse(unknown)).toThrow(PythonPycFormatFailure);
  expect(() => parse(pythonPycFixture("py311").subarray(0, 20))).toThrow(
    PythonPycFormatFailure,
  );
});

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const i32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
};
const f64 = (value: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value);
  return bytes;
};
const marshalRef = (index: number): Buffer =>
  Buffer.concat([Buffer.from([0x72]), u32(index)]);
const marshalLong = (digits: readonly number[], negative = false): Buffer =>
  Buffer.concat([
    Buffer.from([0x6c]),
    i32(negative ? -digits.length : digits.length),
    ...digits.map((digit) => {
      const bytes = Buffer.alloc(2);
      bytes.writeUInt16LE(digit);
      return bytes;
    }),
  ]);
const marshalUnicode = (bytes: Buffer): Buffer =>
  Buffer.concat([Buffer.from([0x75]), u32(bytes.length), bytes]);
const withConsts = (consts: Buffer[]): Buffer =>
  Buffer.concat([pythonPycHeader(3531), marshalCode("py311", { consts })]);

/** Each level keeps one flagged child and two TYPE_REF copies of it. */
const sharedChain = (levels: number): Buffer => {
  const level = (index: number): Buffer =>
    index === levels
      ? marshalCode("py311", { name: `leaf`, flagged: true })
      : marshalCode("py311", {
          name: `level${index}`,
          flagged: index > 0,
          consts: [level(index + 1), marshalRef(index), marshalRef(index)],
        });
  return Buffer.concat([pythonPycHeader(3531), level(0)]);
};

it("lists a code object shared through TYPE_REF once and refers to it by index", () => {
  const small = parse(sharedChain(3));
  expect(small.code_objects.map((code) => code.name)).toEqual([
    "level0",
    "level1",
    "level2",
    "leaf",
  ]);
  expect(small.code_objects.map((code) => code.nested_code)).toEqual([
    [1, 1, 1],
    [2, 2, 2],
    [3, 3, 3],
    [],
  ]);
  expect(small.coverage.code_objects).toBe(4);
  expect(pythonPycSchema.safeParse(small).success).toBe(true);
  const started = Date.now();
  const deep = parse(sharedChain(25));
  expect(Date.now() - started).toBeLessThan(1000);
  expect(deep.coverage.code_objects).toBe(26);
  expect(JSON.stringify(deep).length).toBeLessThan(64 * 1024);
});

it("bounds names repeated through TYPE_REF by what the report carries", () => {
  const name = Buffer.alloc(1000, 0x61);
  const namesObject = Buffer.concat([
    Buffer.from([0x29, 101]),
    Buffer.from([0x61 | 0x80]),
    u32(name.length),
    name,
    ...Array.from({ length: 100 }, () => marshalRef(0)),
  ]);
  const bytes = Buffer.concat([
    pythonPycHeader(3531),
    marshalCode("py311", { namesObject }),
  ]);
  expect(() =>
    parsePythonPyc(
      bytes,
      {
        path: defaults.path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      { ...defaults, max_file_bytes: bytes.length },
    ),
  ).toThrow(PythonPycResourceFailure);
});

it("charges long digits to the string budget and keeps large previews bounded", () => {
  expect(() =>
    parse(withConsts([Buffer.concat([Buffer.from([0x6c]), i32(600_000)])])),
  ).toThrow(PythonPycResourceFailure);
  const report = parse(
    withConsts([
      marshalLong([1, 2]),
      marshalLong(Array.from({ length: 20 }, (_, index) => index + 1)),
    ]),
  );
  expect(root(report).consts[0]).toEqual({
    kind: "int",
    bits: 17,
    value: String(1n + (2n << 15n)),
  });
  expect(root(report).consts[1]).toMatchObject({ kind: "int", value: null });
  expect(pythonPycSchema.safeParse(report).success).toBe(true);
  expect(() => parse(withConsts([marshalLong([1, 0])]))).toThrow(
    PythonPycFormatFailure,
  );
  expect(() => parse(withConsts([marshalLong([0x8000])]))).toThrow(
    PythonPycFormatFailure,
  );
});

it("decodes marshal strings with CPython surrogatepass rules", () => {
  const report = parse(
    withConsts([marshalUnicode(Buffer.from([0x73, 0xed, 0xa0, 0x80]))]),
  );
  expect(root(report).consts[0]).toMatchObject({
    kind: "str",
    value: "s\ud800",
  });
  expect(() =>
    parse(withConsts([marshalUnicode(Buffer.from([0xf0, 0x90, 0x80]))])),
  ).toThrow(PythonPycFormatFailure);
  expect(() =>
    parse(withConsts([marshalUnicode(Buffer.from([0xc0, 0x80]))])),
  ).toThrow(PythonPycFormatFailure);
});

it("keeps non-finite float and complex constants JSON-safe", () => {
  const report = parse(
    withConsts([
      Buffer.concat([Buffer.from([0x67]), f64(Infinity)]),
      Buffer.concat([Buffer.from([0x79]), f64(0), f64(-Infinity)]),
      Buffer.concat([Buffer.from([0x67]), f64(Number.NaN)]),
    ]),
  );
  expect(root(report).consts).toEqual([
    { kind: "float", value: "inf" },
    { kind: "complex", real: 0, imag: "-inf" },
    { kind: "float", value: "nan" },
  ]);
  expect(pythonPycSchema.safeParse(report).success).toBe(true);
  expect(JSON.parse(JSON.stringify(report))).toEqual(report);
});

it("accepts an empty co_filename", () => {
  const report = parse(
    Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", { filename: "" }),
    ]),
  );
  expect(root(report).filename).toBe("");
  expect(pythonPycSchema.safeParse(report).success).toBe(true);
});

it("rejects a code object whose location tables are not bytes", () => {
  expect(() =>
    parse(
      Buffer.concat([
        pythonPycHeader(3531),
        marshalCode("py311", { exceptiontableObject: Buffer.from([0x53]) }),
      ]),
    ),
  ).toThrow(PythonPycFormatFailure);
});

it("hashes one shared byte string no matter how many times it is referenced", () => {
  const payload = Buffer.alloc(1024 * 1024, 0x61);
  const refs = 1200;
  const bytes = Buffer.concat([
    pythonPycHeader(3531),
    marshalCode("py311", {
      constsObject: Buffer.concat([
        Buffer.from([0x28]),
        u32(refs + 1),
        Buffer.from([0xf3]),
        u32(payload.length),
        payload,
        ...Array.from({ length: refs }, () => marshalRef(0)),
      ]),
    }),
  ]);
  const started = Date.now();
  const report = parse(bytes);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(root(report).consts).toHaveLength(refs + 1);
  expect(root(report).consts[refs]).toEqual(root(report).consts[0]);
  expect(root(report).consts[0]).toMatchObject({
    kind: "bytes",
    bytes: payload.length,
  });
});

it("rejects constant tables whose copies exceed max_objects", () => {
  const shared = Buffer.concat([
    Buffer.from([0xa9, 20]),
    Buffer.alloc(20, 0x4e),
  ]);
  const child = (constsObject: Buffer, name: string) =>
    marshalCode("py311", { constsObject, name });
  const bytes = Buffer.concat([
    pythonPycHeader(3531),
    marshalCode("py311", {
      consts: [
        child(shared, "a"),
        ...Array.from({ length: 5 }, (_, index) =>
          child(marshalRef(0), `b${index}`),
        ),
      ],
    }),
  ]);
  const artifact = {
    path: defaults.path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
  const allowed = parsePythonPyc(bytes, artifact, defaults);
  const entries = allowed.code_objects.reduce(
    (sum, code) => sum + code.consts.length,
    0,
  );
  expect(entries).toBeGreaterThan(allowed.coverage.objects);
  expect(() =>
    parsePythonPyc(bytes, artifact, {
      ...defaults,
      max_objects: entries - 1,
    }),
  ).toThrow(/Reported constants exceed max_objects/);
});

it("rejects NULL tuple items and mismatched local kinds", () => {
  expect(() => parse(withConsts([Buffer.from([0x30])]))).toThrow(
    PythonPycFormatFailure,
  );
  expect(
    root(parse(withConsts([Buffer.from([0x7b, 0x4e, 0x54, 0x30])]))).consts[0],
  ).toEqual({
    kind: "dict",
    length: 1,
  });
  expect(() =>
    parse(
      Buffer.concat([
        pythonPycHeader(3531),
        marshalCode("py311", {
          localsplusnames: ["v"],
          localspluskinds: Buffer.alloc(0),
        }),
      ]),
    ),
  ).toThrow(PythonPycFormatFailure);
  const matched = parse(
    Buffer.concat([
      pythonPycHeader(3531),
      marshalCode("py311", {
        localsplusnames: ["v"],
        localspluskinds: Buffer.from([0x20]),
      }),
    ]),
  );
  expect(root(matched).localsplusnames).toEqual(["v"]);
  expect(root(matched).localspluskinds_hex).toBe("20");
  const broken = {
    ...matched,
    code_objects: [
      { ...root(matched), localspluskinds_hex: "" },
      ...matched.code_objects.slice(1),
    ],
  };
  expect(pythonPycSchema.safeParse(broken).success).toBe(false);
  expect(pythonPycSchema.safeParse(matched).success).toBe(true);
});

it("leaves 3.11 alpha magics with other code layouts unsupported", () => {
  for (const magic of [3452, 3459, 3460, 3493]) {
    const bytes = Buffer.concat([pythonPycHeader(magic), marshalCode("py311")]);
    expect(() => parse(bytes)).toThrow(
      expect.objectContaining({ kind: "unsupported" }),
    );
  }
  expect(
    parse(pythonPycFixture("py311", { magic: 3495 })).header,
  ).toMatchObject({ python_version: "3.11", code_layout: "py311" });
});
