import { z } from "zod";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";

/**
 * The official Hex-Rays IDA MCP server (`HexRaysSA/ida-mcp`) exposes its
 * database lifecycle and one arbitrary-Python analysis tool instead of the
 * compatibility tool catalogs of the other profiles. REA's adapter uses only
 * the closed set of read-only queries generated here; it never exposes
 * `execute_python` to callers, never saves, and never closes a GUI database.
 */
export const hexraysTools = [
  "open_database",
  "execute_python",
  "list_databases",
  "close_database",
] as const;

/** One inventory row of the official server's `list_databases` reply. */
export const hexraysInstanceSchema = z
  .object({
    path: z.string().min(1),
    backend: z.enum(["gui", "idalib"]),
    status: z.string().min(1),
    instance_id: z.string().nullable(),
    error: z.unknown().nullish(),
  })
  .passthrough();
export const hexraysDatabaseListSchema = z
  .object({ instances: z.array(hexraysInstanceSchema) })
  .passthrough();

/** `open_database` binds this connection to one database instance. */
export const hexraysOpenDatabaseSchema = z
  .object({
    instance_id: z.string().nullable(),
    backend: z.enum(["gui", "idalib"]),
    status: z.string().min(1),
  })
  .passthrough();

/** `close_database` releases this connection's lease; GUI databases stay open. */
export const hexraysCloseDatabaseSchema = z
  .object({ closed: z.boolean() })
  .passthrough();

/**
 * `execute_python` reports the trailing expression in a `{result, stdout,
 * stderr}` envelope. The shared MCP decoder only unwraps the single-key
 * scalar form, so this owner unwraps the full envelope once. An error
 * envelope, or a null result with traceback output, is a failed query;
 * only a null result without output is a lookup miss.
 */
export const unwrapHexraysExecuteResult = (value: JsonValue): JsonValue => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value;
  const envelope = value as {
    readonly result?: JsonValue;
    readonly error?: JsonValue;
    readonly stderr?: JsonValue;
  };
  if (
    "error" in envelope &&
    envelope.error !== null &&
    envelope.error !== undefined
  )
    throw new AnalysisProtocolError(
      `The official IDA MCP execute_python query reported an error: ${describeExecuteFailure(envelope.error)}.`,
    );
  if (!("result" in envelope)) return value;
  const stderr =
    typeof envelope.stderr === "string" ? envelope.stderr.trim() : "";
  if (envelope.result === null && stderr !== "")
    throw new AnalysisProtocolError(
      `The official IDA MCP execute_python query produced no result: ${describeExecuteFailure(stderr)}.`,
    );
  return envelope.result;
};

const EXECUTE_FAILURE_TEXT_LIMIT = 1024;
const describeExecuteFailure = (value: JsonValue): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > EXECUTE_FAILURE_TEXT_LIMIT
    ? `${text.slice(0, EXECUTE_FAILURE_TEXT_LIMIT)}...[truncated]`
    : text;
};

/**
 * The only lookup answers the generated queries report for a name or address
 * that is not a function, mirroring the legacy profile's error strings.
 */
export const hexraysLookupMisses = {
  byName: "Not found",
  byAddress: "Not a function",
} as const;

/** The input digest is cached per (path, size, mtime) inside the database. */
const METADATA_AND_HEALTH_PREFIX = "import hashlib, os\n";

/**
 * Metadata of the bound database in the legacy attached shape. The digest is
 * recomputed whenever the recorded input file's stat changes, so repeated
 * identity observations stay meaningful without rehashing on every request.
 */
export const hexraysMetadataQuery = () =>
  METADATA_AND_HEALTH_PREFIX +
  "import ida_nalt, idaapi\n" +
  "def _rea_metadata():\n" +
  "    p = ida_nalt.get_input_file_path()\n" +
  "    sha = ''\n" +
  "    try:\n" +
  "        st = os.stat(p)\n" +
  "        key = (p, st.st_size, st.st_mtime)\n" +
  "        cache = globals().get('_rea_sha256_cache')\n" +
  "        if cache is None or cache[0] != key:\n" +
  "            h = hashlib.sha256()\n" +
  "            with open(p, 'rb') as f:\n" +
  "                for chunk in iter(lambda: f.read(1048576), b''):\n" +
  "                    h.update(chunk)\n" +
  "            sha = h.hexdigest()\n" +
  "            globals()['_rea_sha256_cache'] = (key, sha)\n" +
  "        else:\n" +
  "            sha = cache[1]\n" +
  "    except Exception:\n" +
  "        sha = ''\n" +
  "    return {'path': p, 'module': ida_nalt.get_root_filename() or ''," +
  " 'sha256': sha, 'base': hex(idaapi.get_imagebase())}\n" +
  "_rea_metadata()";

/** Health of the bound database in the modern supervisor shape. */
export const hexraysHealthQuery = () =>
  METADATA_AND_HEALTH_PREFIX +
  "import ida_nalt, idaapi, ida_auto\n" +
  "def _rea_health():\n" +
  "    p = ida_nalt.get_input_file_path()\n" +
  "    try:\n" +
  "        idb = ida_nalt.get_path(ida_nalt.PATH_TYPE_IDB)\n" +
  "    except Exception:\n" +
  "        idb = None\n" +
  "    return {'status': 'ok', 'input_path': p, 'idb_path': idb," +
  " 'imagebase': hex(idaapi.get_imagebase())," +
  " 'auto_analysis_ready': bool(ida_auto.auto_is_ok())," +
  " 'module': ida_nalt.get_root_filename() or ''}\n" +
  "_rea_health()";

/** One function page, walked incrementally so memory stays bounded per page. */
export const hexraysFunctionsPageQuery = (offset: number, count: number) =>
  "import idautils, ida_funcs, idc\n" +
  `_start = ${JSON.stringify(offset)}\n` +
  `_count = ${JSON.stringify(count)}\n` +
  "_data = []\n" +
  "_next = None\n" +
  "_i = 0\n" +
  "for _f in idautils.Functions():\n" +
  "    if _i >= _start + _count:\n" +
  "        _next = _start + _count\n" +
  "        break\n" +
  "    if _i >= _start and _count > 0:\n" +
  "        _data.append({'address': hex(_f), 'name': idc.get_func_name(_f)," +
  " 'size': str(ida_funcs.get_func(_f).size())})\n" +
  "    _i += 1\n" +
  "{'data': _data, 'next_offset': _next}";

/**
 * One string page, walked incrementally; a nonpositive count lists every
 * remaining string in the legacy shape.
 */
export const hexraysStringsPageQuery = (offset: number, count: number) =>
  "import idautils\n" +
  `_start = ${JSON.stringify(offset)}\n` +
  `_count = ${JSON.stringify(count)}\n` +
  "_limit = _start + _count\n" +
  "_data = []\n" +
  "_next = None\n" +
  "_i = 0\n" +
  "for _s in idautils.Strings():\n" +
  "    if _count > 0 and _i >= _limit:\n" +
  "        _next = _limit\n" +
  "        break\n" +
  "    if _i >= _start:\n" +
  "        try:\n" +
  "            _data.append({'address': hex(int(_s.ea)), 'string': str(_s)," +
  " 'length': int(_s.length)})\n" +
  "        except Exception:\n" +
  "            pass\n" +
  "    _i += 1\n" +
  "{'data': _data, 'next_offset': _next}";

/** Function object for a name, or null when no such function exists. */
export const hexraysFunctionByNameQuery = (name: string) =>
  "import ida_name, ida_funcs, idc\n" +
  `_ea = ida_name.get_name_ea(0, ${JSON.stringify(name)})\n` +
  "_f = None if _ea == idc.BADADDR else ida_funcs.get_func(_ea)\n" +
  "None if _f is None else {'address': hex(_f.start_ea)," +
  " 'name': idc.get_func_name(_f.start_ea), 'size': str(_f.size())}";

/** Function containing an address, or null when the address is outside one. */
export const hexraysFunctionByAddressQuery = (address: string) =>
  "import ida_funcs, idc\n" +
  `_ea = int(${JSON.stringify(address)}, 16)\n` +
  "_f = ida_funcs.get_func(_ea)\n" +
  "None if _f is None else {'address': hex(_f.start_ea)," +
  " 'name': idc.get_func_name(_f.start_ea), 'size': str(_f.size())}";

export const hexraysDecompileQuery = (address: string) =>
  "import ida_funcs, ida_hexrays\n" +
  `_ea = int(${JSON.stringify(address)}, 16)\n` +
  "_f = ida_funcs.get_func(_ea)\n" +
  "_start = _f.start_ea if _f else _ea\n" +
  "_out = None\n" +
  "try:\n" +
  "    if ida_hexrays.init_hexrays_plugin():\n" +
  "        _cf = ida_hexrays.decompile(_start)\n" +
  "        if _cf:\n" +
  "            _out = str(_cf)\n" +
  "except Exception:\n" +
  "    _out = None\n" +
  "_out";

/**
 * Disassembly echoing the resolved entry, as the legacy profile's identity
 * verification requires.
 */
export const hexraysDisassemblyQuery = (address: string) =>
  "import idautils, ida_funcs, idc, idaapi, ida_lines\n" +
  `_ea = int(${JSON.stringify(address)}, 16)\n` +
  "_f = ida_funcs.get_func(_ea)\n" +
  "_start = _f.start_ea if _f else _ea\n" +
  "_f2 = ida_funcs.get_func(_start)\n" +
  "_end = _f2.end_ea if _f2 else _start\n" +
  "_lines = []\n" +
  "for _h in idautils.Heads(_start, _end):\n" +
  "    _t = idaapi.generate_disasm_line(_h, 0)\n" +
  "    if _t is None:\n" +
  "        continue\n" +
  "    _lines.append({'address': hex(_h)," +
  " 'instruction': ida_lines.tag_remove(_t)})\n" +
  "{'name': idc.get_func_name(_start), 'start_ea': hex(_start)," +
  " 'lines': _lines, 'return_type': None, 'arguments': None}";

export const hexraysXrefsToQuery = (address: string) =>
  "import idautils, ida_funcs, idc\n" +
  `_ea = int(${JSON.stringify(address)}, 16)\n` +
  "_out = []\n" +
  "for _x in idautils.XrefsTo(_ea, 0):\n" +
  "    _f = ida_funcs.get_func(_x.frm)\n" +
  "    _fn = None\n" +
  "    if _f:\n" +
  "        _fn = {'address': hex(_f.start_ea)," +
  " 'name': idc.get_func_name(_f.start_ea), 'size': str(_f.size())}\n" +
  "    _out.append({'address': hex(_x.frm)," +
  " 'type': 'code' if _x.iscode else 'data', 'function': _fn})\n" +
  "_out";

/** Direct callers, deduplicated to their function entries. */
export const hexraysCallersQuery = (address: string) =>
  "import idautils, ida_funcs, idc\n" +
  `_ea = int(${JSON.stringify(address)}, 16)\n` +
  "_f = ida_funcs.get_func(_ea)\n" +
  "_start = _f.start_ea if _f else _ea\n" +
  "_seen = {}\n" +
  "for _x in idautils.XrefsTo(_start, 0):\n" +
  "    if not _x.iscode:\n" +
  "        continue\n" +
  "    _cf = ida_funcs.get_func(_x.frm)\n" +
  "    if _cf:\n" +
  "        _seen[_cf.start_ea] = {'address': hex(_cf.start_ea)," +
  " 'name': idc.get_func_name(_cf.start_ea), 'size': str(_cf.size())}\n" +
  "list(_seen.values())";

/**
 * Call targets only: sequential flow and intra-function jumps are filtered,
 * and self-references from recursion-shaped edges are excluded.
 */
export const hexraysCalleesQuery = (address: string) =>
  "import idautils, ida_funcs, idc, idaapi\n" +
  `_ea = int(${JSON.stringify(address)}, 16)\n` +
  "_f = ida_funcs.get_func(_ea)\n" +
  "_start = _f.start_ea if _f else _ea\n" +
  "_f2 = ida_funcs.get_func(_start)\n" +
  "_out = {}\n" +
  "if _f2:\n" +
  "    for _h in idautils.Heads(_f2.start_ea, _f2.end_ea):\n" +
  "        for _x in idautils.XrefsFrom(_h, 0):\n" +
  "            if _x.type not in (idaapi.fl_CN, idaapi.fl_CF):\n" +
  "                continue\n" +
  "            _tf = ida_funcs.get_func(_x.to)\n" +
  "            _a = _tf.start_ea if _tf else _x.to\n" +
  "            if _a == _start:\n" +
  "                continue\n" +
  "            _n = idc.get_func_name(_tf.start_ea) if _tf else" +
  " (idc.get_name(_x.to) or ('sub_' + hex(_x.to)))\n" +
  "            _out[_a] = {'address': hex(_a), 'name': _n," +
  " 'type': 'internal' if _tf else 'external'}\n" +
  "list(_out.values())";

/**
 * Segment inventory in the modern survey shape. IDA segment bounds are exact,
 * so membership answers carry the same guarantees the survey producer gives.
 */
export const hexraysSegmentsQuery = () =>
  "import idautils, ida_segment\n" +
  "_out = []\n" +
  "for _s in idautils.Segments():\n" +
  "    _seg = ida_segment.getseg(_s)\n" +
  "    if _seg is None:\n" +
  "        continue\n" +
  "    _out.append({'start': hex(_seg.start_ea), 'end': hex(_seg.end_ea)," +
  " 'size': hex(_seg.end_ea - _seg.start_ea)})\n" +
  "{'segments': _out, 'statistics': {'total_segments': len(_out)}}";

/**
 * Translate one legacy- or modern-profile tool request into the official
 * server's `execute_python` call, pinned to the bound instance when one
 * exists.
 */
export const hexraysRequest = (
  tool: string,
  args: Readonly<Record<string, JsonValue>>,
  instanceId: string | undefined,
):
  | {
      readonly name: "execute_python";
      readonly args: Record<string, JsonValue>;
    }
  | undefined => {
  const address = (value: JsonValue | undefined): string => {
    if (typeof value !== "string" && typeof value !== "number")
      throw new AnalysisProtocolError(
        `The official IDA MCP query for ${tool} requires an address.`,
      );
    return typeof value === "number" ? "0x" + value.toString(16) : value;
  };
  let code: string | undefined;
  switch (tool) {
    case "get_metadata":
      code = hexraysMetadataQuery();
      break;
    case "list_functions":
      code = hexraysFunctionsPageQuery(
        numberArg(args.offset, 0),
        numberArg(args.count, 100),
      );
      break;
    case "list_strings":
      code = hexraysStringsPageQuery(
        numberArg(args.offset, 0),
        numberArg(args.count, 0),
      );
      break;
    case "get_function_by_name":
      code = hexraysFunctionByNameQuery(stringArg(args.name, tool));
      break;
    case "get_function_by_address":
      code = hexraysFunctionByAddressQuery(address(args.address));
      break;
    case "decompile_function":
      code = hexraysDecompileQuery(address(args.address));
      break;
    case "disassemble_function":
      code = hexraysDisassemblyQuery(address(args.start_address));
      break;
    case "get_xrefs_to":
      code = hexraysXrefsToQuery(address(args.address));
      break;
    case "get_callers":
      code = hexraysCallersQuery(address(args.function_address));
      break;
    case "get_callees":
      code = hexraysCalleesQuery(address(args.function_address));
      break;
    case "survey_binary":
      code = hexraysSegmentsQuery();
      break;
    default:
      return undefined;
  }
  return {
    name: "execute_python",
    args: {
      code,
      ...(instanceId === undefined ? {} : { instance_id: instanceId }),
    },
  };
};

const numberArg = (value: JsonValue | undefined, fallback: number): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    return fallback;
  return value;
};

const stringArg = (value: JsonValue | undefined, tool: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new AnalysisProtocolError(
      `The official IDA MCP query for ${tool} requires a name.`,
    );
  return value;
};
