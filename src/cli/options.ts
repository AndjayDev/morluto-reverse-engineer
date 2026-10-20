import { z } from "incur";

import {
  executableFormatHintSchema,
  type ExecutableFormatHint,
} from "../domain/dosCom.js";
import type { BinaryArchitecture } from "../domain/binaryTargetTypes.js";
import {
  binaryArchitectureSchema,
  rawBinaryEntryPointSchema,
} from "../domain/rawBinary.js";
import { analysisProviderSelectorSchema } from "../contracts/providerSelection.js";
import type { AnalysisProviderSelector } from "../contracts/providerSelection.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { Logger } from "pino";

/** Parse decimal integer tokens before Number coercion can erase their syntax. */
export const cliIntegerArgument = (min: number) =>
  z
    .string()
    .regex(/^[0-9]+$/u, "Expected a decimal integer")
    .pipe(z.coerce.number<string>().safe().min(min));

export const providerSelectionOption = analysisProviderSelectorSchema
  .optional()
  .describe(
    "Bind deep analysis to a provider ID or use deterministic auto selection",
  );

/** Explicit interpretation for headerless native executable formats. */
export const formatSelectionOption = executableFormatHintSchema
  .optional()
  .describe(
    "Explicit headerless interpretation (dos-com or raw-binary); omission preserves header-based detection",
  );

export const architectureSelectionOption = binaryArchitectureSchema
  .optional()
  .describe(
    "Caller-supplied CPU family; required with --target-format raw-binary",
  );

export const entryPointSelectionOption = rawBinaryEntryPointSchema
  .optional()
  .describe(
    "Caller-supplied load and entry address (0xhex); required with --target-format raw-binary",
  );

/** Analysis modes a one-shot CLI command accepts. */
export type CliAnalysisMode = "foreground" | "background" | "auto";

/**
 * Analysis mode of a one-shot CLI command.
 *
 * The CLI process exits when the command does, so it has no owner for a
 * background analysis job. `background` is refused; `auto` runs in the
 * foreground with the same budget as any other foreground CLI analysis.
 */
export const analysisModeOption = z
  .enum(["foreground", "background", "auto"])
  .optional()
  .describe(
    "Analysis mode: foreground blocks until the analysis is ready (default). background is unavailable in the one-shot CLI; use the REA MCP server. auto behaves as foreground.",
  );

/** Reject a background request that the one-shot CLI cannot own. */
export const assertCliAnalysisMode = (
  mode: CliAnalysisMode | undefined,
): void => {
  if (mode !== "background") return;
  throw new AnalysisCapabilityUnavailableError(
    "cli",
    "open_binary",
    "The one-shot CLI cannot own a background analysis job because it exits when the command does.",
    {
      userMessage:
        "Background analysis is not available in the one-shot CLI. Use the REA MCP server: call open_binary with analysis_mode=background, then poll with binary_session and wait_ms.",
      remediationAction:
        "Open the target through the REA MCP server with analysis_mode=background, or run this command in the foreground.",
    },
  );
};

/** Shared CLI flags that bind a native target interpretation. */
export const nativeOpenOptionFields = {
  "target-format": formatSelectionOption,
  architecture: architectureSelectionOption,
  "entry-point": entryPointSelectionOption,
  provider: providerSelectionOption,
  "analysis-mode": analysisModeOption,
};

/** Native CLI flags consumed when opening a target for one-shot analysis. */
export interface NativeOpenCliFlags {
  readonly snapshot?: string | undefined;
  readonly provider?: AnalysisProviderSelector | undefined;
  readonly "target-format"?: ExecutableFormatHint | undefined;
  readonly architecture?: BinaryArchitecture | undefined;
  readonly "entry-point"?: string | undefined;
  readonly "analysis-mode"?: CliAnalysisMode | undefined;
}

export const directAnalysisOptions = (
  logger: Logger,
  snapshotPath: string | undefined,
  providerId: AnalysisProviderSelector | undefined,
  formatHint?: ExecutableFormatHint,
  architecture?: BinaryArchitecture,
  entryPoint?: string,
) => ({
  logger,
  snapshotPath,
  ...(formatHint === undefined ? {} : { formatHint }),
  ...(architecture === undefined ? {} : { architecture }),
  ...(entryPoint === undefined ? {} : { entryPoint }),
  ...(providerId === undefined ? {} : { providerId }),
});

/** Map native CLI flags onto the shared one-shot analysis options. */
export const directAnalysisOptionsFromCli = (
  logger: Logger,
  options: NativeOpenCliFlags,
) => {
  // The one-shot CLI has no owner for a background job, so it refuses the
  // request at the boundary that owns the open options.
  assertCliAnalysisMode(options["analysis-mode"]);
  return directAnalysisOptions(
    logger,
    options.snapshot,
    options.provider,
    options["target-format"],
    options.architecture,
    options["entry-point"],
  );
};
