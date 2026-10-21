import { readProviderRegistration } from "../providers/ReadProviderRegistration.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

const common = {
  mode: z.enum(["attached", "headless"]).default("attached"),
  protocol: z.literal("native").optional(),
  timeoutMs: z.number().int().positive().max(2_147_483_647).default(300_000),
  workspaceRoot: z
    .string()
    .refine(isAbsolute, "workspaceRoot must be absolute on the REA host")
    .optional(),
};
const registrationSchema = z
  .union([
    z
      .object({
        ...common,
        type: z.literal("stdio").optional(),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}),
      })
      .strict(),
    z
      .object({
        ...common,
        type: z.literal("http").optional(),
        url: z.url().refine((value) => {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
            url.username === "" &&
            url.password === ""
          );
        }, "IDA MCP must use a local HTTP endpoint without URL credentials"),
        headers: z.record(z.string(), z.string()).default({}),
      })
      .strict(),
  ])
  .refine(
    (config) => config.protocol !== "native" || config.mode === "attached",
    "The native IDA MCP protocol requires attached mode",
  );

/** An upstream MCP registration plus REA's database lifecycle selection. */
export type IdaConfiguration = z.infer<typeof registrationSchema>;

/** Select a protocol without changing existing attached/headless registrations. */
export const idaProtocol = (config: IdaConfiguration) =>
  config.protocol ?? (config.mode === "attached" ? "legacy" : "modern");

/** Read one explicit registration without starting or installing a provider. */
export const readIdaConfiguration = (
  path: string,
  options: {
    readonly signal?: AbortSignal;
    readonly resourceScope: RetainedResourceScope;
  },
): Promise<Result<IdaConfiguration, ConfigurationError>> =>
  readProviderRegistration(path, options, {
    setting: "REA_IDA_MCP_CONFIG",
    label: "IDA MCP",
    operation: "ida:registration",
    parse: (input) => {
      const envelope = z
        .object({ mcpServers: z.object({ "ida-pro-mcp": z.unknown() }) })
        .safeParse(input);
      const parsed = registrationSchema.safeParse(
        envelope.success ? envelope.data.mcpServers["ida-pro-mcp"] : input,
      );
      return parsed.success
        ? ok(parsed.data)
        : err(
            idaConfigurationError(
              "REA_IDA_MCP_CONFIG must contain an IDA MCP command/args or local url registration; see docs/ida-provider.md.",
              parsed.error,
            ),
          );
    },
  });

/** A REA_IDA_MCP_CONFIG rejection that names the setting it concerns. */
export const idaConfigurationError = (
  constraint: string,
  cause?: unknown,
): ConfigurationError =>
  new ConfigurationError(constraint, {
    ...(cause === undefined ? {} : { cause }),
    settings: [{ setting: "REA_IDA_MCP_CONFIG", constraint }],
  });
