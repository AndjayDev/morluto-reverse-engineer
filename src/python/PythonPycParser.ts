import { createHash } from "node:crypto";
import {
  PYTHON_PYC_CHECK_SOURCE,
  PYTHON_PYC_CONST_PREVIEW_LIMIT,
  PYTHON_PYC_HASH_BASED,
  PYTHON_PYC_HEADER_BYTES,
  PYTHON_PYC_INT_PREVIEW_BITS,
  pythonPycMagicEntry,
  type InspectPythonPycInput,
  type PythonPyc,
  type PythonPycCodeLayout,
  type PythonPycCodeObject,
  type PythonPycConst,
} from "../domain/python/pythonPyc.js";
import {
  PythonPycFormatFailure,
  PythonPycResourceFailure,
} from "./PythonPyc.errors.js";

const FLAG_REF = 0x80;
const TYPE_NULL = 0x30;
const TYPE_NONE = 0x4e;
const TYPE_FALSE = 0x46;
const TYPE_TRUE = 0x54;
const TYPE_STOPITER = 0x53;
const TYPE_ELLIPSIS = 0x2e;
const TYPE_INT = 0x69;
const TYPE_FLOAT = 0x67;
const TYPE_COMPLEX = 0x79;
const TYPE_LONG = 0x6c;
const TYPE_BYTES = 0x73;
const TYPE_INTERNED = 0x74;
const TYPE_REF = 0x72;
const TYPE_TUPLE = 0x28;
const TYPE_LIST = 0x5b;
const TYPE_DICT = 0x7b;
const TYPE_CODE = 0x63;
const TYPE_UNICODE = 0x75;
const TYPE_SET = 0x3c;
const TYPE_FROZENSET = 0x3e;
const TYPE_ASCII = 0x61;
const TYPE_ASCII_INTERNED = 0x41;
const TYPE_SMALL_TUPLE = 0x29;
const TYPE_SHORT_ASCII = 0x7a;
const TYPE_SHORT_ASCII_INTERNED = 0x5a;

type MarshalValue =
  | { readonly kind: "null" }
  | { readonly kind: "none" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "ellipsis" }
  | { readonly kind: "stopiter" }
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "complex"; readonly real: number; readonly imag: number }
  | { readonly kind: "bytes"; readonly value: Buffer }
  | { readonly kind: "str"; readonly value: string }
  | { readonly kind: "tuple"; readonly items: readonly MarshalValue[] }
  | { readonly kind: "list"; readonly items: readonly MarshalValue[] }
  | { readonly kind: "set"; readonly items: readonly MarshalValue[] }
  | { readonly kind: "frozenset"; readonly items: readonly MarshalValue[] }
  | {
      readonly kind: "dict";
      readonly items: readonly (readonly [MarshalValue, MarshalValue])[];
    }
  | { readonly kind: "code"; readonly value: CodeNode };

/** A decoded code object; TYPE_REF children are the same node, not copies. */
type CodeNode = Omit<PythonPycCodeObject, "nested_code"> & {
  readonly nested: readonly CodeNode[];
};

const malformed = (message: string): never => {
  throw new PythonPycFormatFailure("malformed", message);
};

const unsupported = (message: string): never => {
  throw new PythonPycFormatFailure("unsupported", message);
};

const digests = new WeakMap<Buffer, string>();
const sha256 = (bytes: Buffer): string => {
  const cached = digests.get(bytes);
  if (cached !== undefined) return cached;
  const digest = createHash("sha256").update(bytes).digest("hex");
  digests.set(bytes, digest);
  return digest;
};

/** Decode one bounded CPython 3.7–3.13 pyc without executing bytecode. */
export const parsePythonPyc = (
  bytes: Buffer,
  artifact: { path: string; sha256: string; bytes: number },
  input: InspectPythonPycInput,
): PythonPyc => {
  if (bytes.length !== artifact.bytes)
    malformed("Selected artifact length disagrees with the retained bytes.");
  if (bytes.length < PYTHON_PYC_HEADER_BYTES)
    malformed(
      "Selected file is shorter than a 16-byte CPython 3.7+ pyc header.",
    );
  if (bytes[2] !== 0x0d || bytes[3] !== 0x0a)
    malformed("Pyc magic is not a little-endian integer followed by CR LF.");
  const magic = bytes.readUInt16LE(0);
  const mapped = pythonPycMagicEntry(magic);
  if (mapped === null)
    return unsupported(
      `Pyc magic ${magic} is outside the pinned CPython 3.7–3.13 table.`,
    );
  const flags = bytes.readUInt32LE(4);
  const hashBased = (flags & PYTHON_PYC_HASH_BASED) !== 0;
  const header = {
    magic,
    python_version: mapped.python_version,
    code_layout: mapped.code_layout,
    flags,
    hash_based: hashBased,
    check_source: (flags & PYTHON_PYC_CHECK_SOURCE) !== 0,
    source_hash_hex: hashBased ? bytes.subarray(8, 16).toString("hex") : null,
    source_mtime: hashBased ? null : bytes.readUInt32LE(8),
    source_size: hashBased ? null : bytes.readUInt32LE(12),
  };
  const marshal = bytes.subarray(PYTHON_PYC_HEADER_BYTES);
  const reader = new MarshalReader(marshal, mapped.code_layout, input);
  const root = reader.readObject(0);
  if (reader.offset !== marshal.length)
    malformed("Marshal stream has trailing bytes after the top-level object.");
  if (root.kind !== "code")
    return malformed("Top-level marshal object is not a code object.");
  const codeObjects = flattenCode(root.value);
  const unknownFlags =
    flags & ~(PYTHON_PYC_HASH_BASED | PYTHON_PYC_CHECK_SOURCE);
  return {
    artifact: {
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    },
    header,
    code_objects: codeObjects,
    coverage: {
      status: "complete",
      objects: reader.objects,
      code_objects: codeObjects.length,
      marshal_bytes: marshal.length,
      marshal_depth: reader.depthReached,
    },
    limitations: [
      "Bytecode is retained as length and SHA-256 only; this workflow does not decompile, disassemble, or recover source.",
      "The selected file is not executed and CPython is not invoked.",
      hashBased
        ? "source_hash_hex is the PEP 552 header field; the original .py is not read."
        : "source_mtime and source_size are header fields; they do not prove a matching .py is present.",
      "python_version is the pinned CPython magic table for this header, not a runtime interpreter.",
      ...(unknownFlags === 0
        ? []
        : [
            `Header flags ${flags} include unrecognized bits; only hash-based and check-source bits are decoded.`,
          ]),
    ],
  };
};

class MarshalReader {
  offset = 0;
  objects = 0;
  depthReached = 0;
  readonly #intern: (MarshalValue | undefined)[] = [];
  /** Name and identifier bytes the report carries across all code objects. */
  #reportedStringBytes = 0;
  /** Const summaries the report copies, including tables shared by TYPE_REF. */
  #reportedConsts = 0;

  constructor(
    readonly bytes: Buffer,
    readonly layout: PythonPycCodeLayout,
    readonly input: InspectPythonPycInput,
  ) {}

  readObject(depth: number): MarshalValue {
    this.objects += 1;
    if (this.objects > this.input.max_objects)
      throw new PythonPycResourceFailure(
        "objects",
        { max_objects: this.input.max_objects },
        `Marshal object count exceeds max_objects ${this.input.max_objects}.`,
      );
    if (depth > this.input.max_depth)
      throw new PythonPycResourceFailure(
        "depth",
        { max_depth: this.input.max_depth },
        `Marshal nesting exceeds max_depth ${this.input.max_depth}.`,
      );
    this.depthReached = Math.max(this.depthReached, depth);
    const raw = this.u8();
    const flagged = (raw & FLAG_REF) !== 0;
    const type = raw & ~FLAG_REF;
    if (type === TYPE_REF) {
      if (flagged) malformed("TYPE_REF must not also set FLAG_REF.");
      return this.readRef();
    }
    let slot: number | undefined;
    if (flagged) {
      slot = this.#intern.length;
      this.#intern.push(undefined);
    }
    const value = this.readTyped(type, depth);
    if (slot !== undefined) this.#intern[slot] = value;
    return value;
  }

  readTyped(type: number, depth: number): MarshalValue {
    switch (type) {
      case TYPE_NULL:
        return { kind: "null" };
      case TYPE_NONE:
        return { kind: "none" };
      case TYPE_FALSE:
        return { kind: "bool", value: false };
      case TYPE_TRUE:
        return { kind: "bool", value: true };
      case TYPE_STOPITER:
        return { kind: "stopiter" };
      case TYPE_ELLIPSIS:
        return { kind: "ellipsis" };
      case TYPE_INT:
        return { kind: "int", value: BigInt(this.i32()) };
      case TYPE_FLOAT:
        return { kind: "float", value: this.f64() };
      case TYPE_COMPLEX:
        return { kind: "complex", real: this.f64(), imag: this.f64() };
      case TYPE_LONG:
        return { kind: "int", value: this.long() };
      case TYPE_BYTES:
        return { kind: "bytes", value: this.blob(this.u32()) };
      case TYPE_INTERNED:
      case TYPE_UNICODE:
        return { kind: "str", value: this.utf8(this.u32(), false) };
      case TYPE_ASCII:
      case TYPE_ASCII_INTERNED:
        return { kind: "str", value: this.utf8(this.u32(), true) };
      case TYPE_SHORT_ASCII:
      case TYPE_SHORT_ASCII_INTERNED:
        return { kind: "str", value: this.utf8(this.u8(), true) };
      case TYPE_TUPLE:
        return { kind: "tuple", items: this.sequence(this.u32(), depth) };
      case TYPE_SMALL_TUPLE:
        return { kind: "tuple", items: this.sequence(this.u8(), depth) };
      case TYPE_LIST:
        return { kind: "list", items: this.sequence(this.u32(), depth) };
      case TYPE_SET:
        return { kind: "set", items: this.sequence(this.u32(), depth) };
      case TYPE_FROZENSET:
        return { kind: "frozenset", items: this.sequence(this.u32(), depth) };
      case TYPE_DICT:
        return { kind: "dict", items: this.dict(depth) };
      case TYPE_CODE:
        return { kind: "code", value: this.code(depth) };
      default:
        return malformed(`Unsupported marshal type 0x${type.toString(16)}.`);
    }
  }

  code(depth: number): CodeNode {
    const argcount = this.u32();
    const posonlyargcount = this.layout === "py37" ? null : this.u32();
    const kwonlyargcount = this.u32();
    const nlocals = this.layout === "py311" ? null : this.u32();
    const stacksize = this.u32();
    const flags = this.u32();
    const bytecode = asBytes(this.readObject(depth + 1), "co_code");
    const consts = asTuple(this.readObject(depth + 1), "co_consts");
    this.#chargeConsts(consts.length);
    const names = strings(asTuple(this.readObject(depth + 1), "co_names"));
    let varnames: string[] | null = null;
    let freevars: string[] | null = null;
    let cellvars: string[] | null = null;
    let localsplusnames: string[] | null = null;
    let localspluskinds_hex: string | null = null;
    if (this.layout === "py311") {
      localsplusnames = strings(
        asTuple(this.readObject(depth + 1), "co_localsplusnames"),
      );
      const localspluskinds = asBytes(
        this.readObject(depth + 1),
        "co_localspluskinds",
      );
      if (localspluskinds.length !== localsplusnames.length)
        malformed(
          "co_localspluskinds length does not match co_localsplusnames.",
        );
      localspluskinds_hex = localspluskinds.toString("hex");
    } else {
      varnames = strings(asTuple(this.readObject(depth + 1), "co_varnames"));
      freevars = strings(asTuple(this.readObject(depth + 1), "co_freevars"));
      cellvars = strings(asTuple(this.readObject(depth + 1), "co_cellvars"));
    }
    const filename = asString(this.readObject(depth + 1), "co_filename");
    const name = asString(this.readObject(depth + 1), "co_name");
    const qualname =
      this.layout === "py311"
        ? asString(this.readObject(depth + 1), "co_qualname")
        : null;
    const firstlineno = this.u32();
    asBytes(this.readObject(depth + 1), "co_linetable");
    if (this.layout === "py311")
      asBytes(this.readObject(depth + 1), "co_exceptiontable");
    this.#reportStrings([
      name,
      qualname ?? "",
      filename,
      ...names,
      ...(varnames ?? []),
      ...(freevars ?? []),
      ...(cellvars ?? []),
      ...(localsplusnames ?? []),
      localspluskinds_hex ?? "",
    ]);
    return {
      name,
      qualname,
      filename,
      firstlineno,
      argcount,
      posonlyargcount,
      kwonlyargcount,
      nlocals,
      stacksize,
      flags,
      names,
      varnames,
      freevars,
      cellvars,
      localsplusnames,
      localspluskinds_hex,
      bytecode: { bytes: bytecode.length, sha256: sha256(bytecode) },
      consts: consts.map(summarizeConst),
      nested: consts.flatMap((item) =>
        item.kind === "code" ? [item.value] : [],
      ),
    };
  }

  /**
   * Strings reached through TYPE_REF are one marshal object but a full copy
   * in the report, so bound what the report carries, not the stream.
   */
  #reportStrings(values: readonly string[]): void {
    for (const value of values)
      this.#reportedStringBytes += Buffer.byteLength(value, "utf8");
    if (this.#reportedStringBytes > this.input.max_file_bytes)
      throw new PythonPycResourceFailure(
        "string",
        { max_file_bytes: this.input.max_file_bytes },
        `Reported code-object strings exceed max_file_bytes ${this.input.max_file_bytes}.`,
      );
  }

  /**
   * A consts tuple shared through TYPE_REF is one decode but a full copy in
   * every code object. Stop before those copies are built.
   */
  #chargeConsts(count: number): void {
    this.#reportedConsts += count;
    if (this.#reportedConsts > this.input.max_objects)
      throw new PythonPycResourceFailure(
        "objects",
        { max_objects: this.input.max_objects },
        `Reported constants exceed max_objects ${this.input.max_objects}.`,
      );
  }

  readRef(): MarshalValue {
    const index = this.u32();
    const value = this.#intern[index];
    if (value === undefined)
      return malformed(
        `TYPE_REF index ${index} is missing or still being constructed.`,
      );
    return value;
  }

  sequence(count: number, depth: number): MarshalValue[] {
    const items: MarshalValue[] = [];
    for (let index = 0; index < count; index += 1) {
      const item = this.readObject(depth + 1);
      if (item.kind === "null")
        malformed("NULL object in marshal data for sequence.");
      items.push(item);
    }
    return items;
  }

  dict(depth: number): (readonly [MarshalValue, MarshalValue])[] {
    const items: (readonly [MarshalValue, MarshalValue])[] = [];
    for (;;) {
      const key = this.readObject(depth + 1);
      if (key.kind === "null") return items;
      items.push([key, this.readObject(depth + 1)]);
    }
  }

  /**
   * CPython stores a long as 15-bit digits, least significant first. Charge
   * the digits against the string budget (they never use another one), reject
   * the digits CPython rejects, and build the value in one linear pass.
   */
  long(): bigint {
    const count = this.i32();
    const size = Math.abs(count);
    if (size * 2 > this.input.max_string_bytes)
      throw new PythonPycResourceFailure(
        "string",
        { max_string_bytes: this.input.max_string_bytes },
        `Marshal long of ${size * 2} digit bytes exceeds max_string_bytes ${this.input.max_string_bytes}.`,
      );
    if (this.offset > this.bytes.length - size * 2)
      malformed("Marshal long overruns the selected file.");
    const nibbles: number[] = [];
    let carry = 0;
    let carryBits = 0;
    let digit = 0;
    for (let index = 0; index < size; index += 1) {
      digit = this.u16();
      if (digit >= 0x8000) malformed("Marshal long digit is out of range.");
      carry |= digit << carryBits;
      carryBits += 15;
      while (carryBits >= 4) {
        nibbles.push(carry & 0xf);
        carry >>>= 4;
        carryBits -= 4;
      }
    }
    if (size > 0 && digit === 0) malformed("Marshal long is not normalized.");
    if (carryBits > 0) nibbles.push(carry);
    if (nibbles.length === 0) return 0n;
    const value = BigInt(
      `0x${nibbles
        .reverse()
        .map((nibble) => nibble.toString(16))
        .join("")}`,
    );
    return count < 0 ? -value : value;
  }

  utf8(length: number, ascii: boolean): string {
    const bytes = this.blob(length);
    if (ascii) {
      if (bytes.some((byte) => byte > 0x7f))
        malformed("Marshal ASCII string contains a non-ASCII byte.");
      return bytes.toString("latin1");
    }
    return decodeSurrogatePass(bytes);
  }

  blob(length: number): Buffer {
    if (length > this.input.max_string_bytes)
      throw new PythonPycResourceFailure(
        "string",
        { max_string_bytes: this.input.max_string_bytes },
        `Marshal string of ${length} bytes exceeds max_string_bytes ${this.input.max_string_bytes}.`,
      );
    if (this.offset > this.bytes.length - length)
      malformed("Marshal string overruns the selected file.");
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return Buffer.from(value);
  }

  u8(): number {
    if (this.offset >= this.bytes.length)
      malformed("Marshal stream ended inside an object.");
    const value = this.bytes[this.offset];
    this.offset += 1;
    if (value === undefined)
      return malformed("Marshal stream ended inside an object.");
    return value;
  }

  u16(): number {
    if (this.offset > this.bytes.length - 2)
      malformed("Marshal stream ended inside a 16-bit field.");
    const value = this.bytes.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  u32(): number {
    if (this.offset > this.bytes.length - 4)
      malformed("Marshal stream ended inside a 32-bit field.");
    const value = this.bytes.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  i32(): number {
    if (this.offset > this.bytes.length - 4)
      malformed("Marshal stream ended inside a 32-bit field.");
    const value = this.bytes.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  f64(): number {
    if (this.offset > this.bytes.length - 8)
      malformed("Marshal stream ended inside a float.");
    const value = this.bytes.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }
}

/**
 * Decode marshal UTF-8 the way CPython does (`surrogatepass`): encoded lone
 * surrogates are kept, every other ill-formed sequence is rejected.
 */
const decodeSurrogatePass = (bytes: Buffer): string => {
  const units: number[] = [];
  let text = "";
  for (let index = 0; index < bytes.length;) {
    const lead = bytes[index] ?? 0;
    let codePoint: number;
    let width: number;
    if (lead < 0x80) {
      codePoint = lead;
      width = 1;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      codePoint = lead & 0x1f;
      width = 2;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      codePoint = lead & 0x0f;
      width = 3;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      codePoint = lead & 0x07;
      width = 4;
    } else {
      return malformed("Marshal string is not valid UTF-8.");
    }
    if (index + width > bytes.length)
      return malformed("Marshal string is not valid UTF-8.");
    for (let offset = 1; offset < width; offset += 1) {
      const next = bytes[index + offset] ?? 0;
      if ((next & 0xc0) !== 0x80)
        return malformed("Marshal string is not valid UTF-8.");
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (
      (width === 3 && codePoint < 0x800) ||
      (width === 4 && (codePoint < 0x10000 || codePoint > 0x10ffff))
    )
      return malformed("Marshal string is not valid UTF-8.");
    units.push(codePoint);
    index += width;
    if (units.length === 4096) {
      text += codePointsToString(units);
      units.length = 0;
    }
  }
  return text + codePointsToString(units);
};

const codePointsToString = (codePoints: readonly number[]): string =>
  codePoints
    .map((codePoint) =>
      codePoint >= 0xd800 && codePoint <= 0xdfff
        ? String.fromCharCode(codePoint)
        : String.fromCodePoint(codePoint),
    )
    .join("");

/** JSON has no non-finite numbers; keep CPython's repr for them. */
const jsonFloat = (value: number): number | "inf" | "-inf" | "nan" =>
  Number.isNaN(value)
    ? "nan"
    : value === Infinity
      ? "inf"
      : value === -Infinity
        ? "-inf"
        : value;

/**
 * Emit each distinct code object once, the top-level object first. A child
 * shared through TYPE_REF is listed once and referenced by index, so the
 * report never repeats a subtree.
 */
const flattenCode = (root: CodeNode): PythonPycCodeObject[] => {
  const indexes = new Map<CodeNode, number>();
  const order: CodeNode[] = [];
  const visit = (node: CodeNode): void => {
    if (indexes.has(node)) return;
    indexes.set(node, order.length);
    order.push(node);
    for (const child of node.nested) visit(child);
  };
  visit(root);
  return order.map(({ nested, ...code }) => ({
    ...code,
    nested_code: nested.map(
      (child) =>
        indexes.get(child) ?? malformed("Nested code object was not listed."),
    ),
  }));
};

const asBytes = (value: MarshalValue, field: string): Buffer => {
  if (value.kind !== "bytes")
    return malformed(`${field} is not marshal bytes.`);
  return value.value;
};

const asString = (value: MarshalValue, field: string): string => {
  if (value.kind !== "str")
    return malformed(`${field} is not a marshal string.`);
  return value.value;
};

const asTuple = (
  value: MarshalValue,
  field: string,
): readonly MarshalValue[] => {
  if (value.kind !== "tuple")
    return malformed(`${field} is not a marshal tuple.`);
  return value.items;
};

const strings = (items: readonly MarshalValue[]): string[] =>
  items.map((item, index) => {
    if (item.kind !== "str")
      return malformed(`Tuple item ${index} is not a marshal string.`);
    return item.value;
  });

const summarizeConst = (value: MarshalValue): PythonPycConst => {
  switch (value.kind) {
    case "none":
      return { kind: "none" };
    case "bool":
      return { kind: "bool", value: value.value };
    case "int": {
      const bits = bitLength(value.value);
      return {
        kind: "int",
        bits,
        value:
          bits <= PYTHON_PYC_INT_PREVIEW_BITS ? value.value.toString() : null,
      };
    }
    case "float":
      return { kind: "float", value: jsonFloat(value.value) };
    case "str": {
      const truncated = value.value.length > PYTHON_PYC_CONST_PREVIEW_LIMIT;
      return {
        kind: "str",
        bytes: Buffer.byteLength(value.value, "utf8"),
        truncated,
        value: truncated
          ? value.value.slice(0, PYTHON_PYC_CONST_PREVIEW_LIMIT)
          : value.value,
      };
    }
    case "bytes":
      return {
        kind: "bytes",
        bytes: value.value.length,
        sha256: sha256(value.value),
      };
    case "code":
      return {
        kind: "code",
        name: value.value.name,
        firstlineno: value.value.firstlineno,
      };
    case "tuple":
      return { kind: "tuple", length: value.items.length };
    case "list":
      return { kind: "list", length: value.items.length };
    case "set":
      return { kind: "set", length: value.items.length };
    case "frozenset":
      return { kind: "frozenset", length: value.items.length };
    case "dict":
      return { kind: "dict", length: value.items.length };
    case "ellipsis":
      return { kind: "ellipsis" };
    case "complex":
      return {
        kind: "complex",
        real: jsonFloat(value.real),
        imag: jsonFloat(value.imag),
      };
    default:
      return { kind: "other", type: value.kind };
  }
};

const bitLength = (value: bigint): number => {
  if (value === 0n) return 0;
  const hex = (value < 0n ? -value : value).toString(16);
  return (
    (hex.length - 1) * 4 + Number.parseInt(hex[0] ?? "0", 16).toString(2).length
  );
};
