import { segmentRule } from "../../domain/analysisView/webNetworkRouteTemplates.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { decodedPathSegment } from "./environmentReplay.js";
import type {
  EnvironmentManifest,
  EnvironmentManifestTool,
} from "./environmentSource.js";
import { environmentToolArguments } from "./environmentTools.js";

const FORMAT_RULES: ReadonlySet<string> = new Set([
  "numeric",
  "uuid",
  "hex",
  "iso-date",
]);

/** One request of a probe capture, as the comparison replays it. */
export interface ProbeRequest {
  readonly method: string;
  readonly path: string;
  /** WHATWG query spelling including `?`, or null. */
  readonly query: string | null;
  readonly body: JsonValue | undefined;
}

/** A probe request as a call of one manifest tool. */
export interface ProbeToolCall {
  readonly tool: EnvironmentManifestTool;
  readonly args: Record<string, JsonValue>;
  /** Argument names of the path values, in path order. */
  readonly pathArguments: readonly string[];
  /** Query names the tool does not take; the call drops them. */
  readonly ignoredQuery: readonly string[];
}

interface Fit {
  readonly tool: EnvironmentManifestTool;
  readonly literals: number;
}

/** How a path fits a tool's template: the literal segments it matches, or undefined when it does not fit. */
const fitOf = (
  tool: EnvironmentManifestTool,
  segments: readonly string[],
): Fit | undefined => {
  const template = tool.path_template.slice(1).split("/");
  if (template.length !== segments.length) return undefined;
  const params = new Map(tool.params.map((param) => [param.index, param]));
  let literals = 0;
  for (const [index, part] of template.entries()) {
    const segment = segments[index]!;
    const param = params.get(index);
    if (param === undefined) {
      if (part !== segment && part !== decodedPathSegment(segment))
        return undefined;
      literals += 1;
    } else if (
      FORMAT_RULES.has(param.rule) &&
      segmentRule(segment) !== param.rule
    )
      return undefined;
    else if (segment === "") return undefined;
  }
  return { tool, literals };
};

/** The tool of the request's method whose template fits the path with the most literal segments; the manifest's order breaks ties. */
export const matchProbeRequest = (
  manifest: EnvironmentManifest,
  request: ProbeRequest,
): ProbeToolCall | undefined => {
  const segments = request.path.slice(1).split("/");
  let best: Fit | undefined;
  for (const tool of manifest.tools) {
    if (tool.method !== request.method) continue;
    const fit = fitOf(tool, segments);
    if (
      fit !== undefined &&
      (best === undefined || fit.literals > best.literals)
    )
      best = fit;
  }
  if (best === undefined) return undefined;
  const { tool } = best;
  const names = environmentToolArguments(tool);
  const args: Record<string, JsonValue> = {};
  const pathArguments: string[] = [];
  for (const param of tool.params) {
    const name = names.path.get(param.name) ?? param.name;
    args[name] = decodedPathSegment(segments[param.index]!);
    pathArguments.push(name);
  }
  const ignoredQuery: string[] = [];
  if (request.query !== null)
    for (const [key, value] of new URLSearchParams(request.query.slice(1))) {
      const name = names.query.get(key);
      if (name === undefined) ignoredQuery.push(key);
      else if (!Object.hasOwn(args, name)) args[name] = value;
    }
  if (names.body !== undefined && request.body !== undefined)
    args[names.body] = request.body;
  return { tool, args, pathArguments, ignoredQuery };
};
