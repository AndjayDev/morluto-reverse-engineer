import { isAbsolute } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { JvmDebugMetadataPort } from "./JvmDebugMetadataPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  createJavaDebugMetadataEvidence,
  inspectJvmDebugMetadataInputSchema,
  javaDebugMetadataAnswersSelection,
  javaDebugMetadataResultSchema,
} from "../../domain/jvm/javaDebugMetadataReport.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const OPERATION = "inspect_jvm_debug_metadata";

/** Shared artifact validation and typed inline Evidence for CLI/MCP. */
export class JvmDebugMetadataService {
  constructor(readonly provider: JvmDebugMetadataPort) {}

  /** Join provider cleanup during shutdown or an explicit retry. */
  close(): Promise<void> {
    return this.provider.close();
  }

  /** Preserve exact selected artifact identity and the decoded debug facts. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const input = inspectJvmDebugMetadataInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const inspected = await this.provider.inspect(input.data, options);
    if (!inspected.ok) return inspected;
    const execution = inspected.value;
    const report = javaDebugMetadataResultSchema.safeParse(execution.result);
    if (
      !report.success ||
      !javaDebugMetadataAnswersSelection(
        report.data,
        execution.subject,
        input.data,
      )
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "JVM class-file reader returned malformed data or answered a different artifact, container, entry or release than was selected.",
        ),
      );
    // Validate before classifying completion: a valid report keeps its
    // Evidence under late cancellation, with the caller's abort reason.
    return completeProviderEvidence(
      createJavaDebugMetadataEvidence(input.data, {
        ...execution,
        result: report.data,
      }),
      options?.signal,
    );
  }
}
