import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import type { JvmDebugMetadataExecution } from "../application/jvm/JvmDebugMetadataPort.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../artifacts/AnalysisCleanupLease.js";
import {
  ArtifactFileCancelled,
  ArtifactFileCleanupFailure,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import {
  createJavaDebugMetadataEvidence,
  type InspectJvmDebugMetadataInput,
} from "../domain/jvm/javaDebugMetadataReport.js";
import { err, type Result } from "../domain/result.js";
import { jvmCleanupError } from "./jvmFailures.js";

const OPERATION = "inspect_jvm_debug_metadata";

/** One caller-selected JAR member inspection. */
export interface JarRequest {
  readonly jar: string;
  /** The normalized member path. */
  readonly entry: string;
  readonly input: InspectJvmDebugMetadataInput;
  readonly signal: AbortSignal | undefined;
}

/** A finished JAR read and, when it failed to close, the retained ZIP reader. */
export class JarInspection {
  constructor(
    readonly result: Result<JvmDebugMetadataExecution, AnalysisError>,
    readonly readerCleanup?: {
      readonly cause: unknown;
      readonly lease: AnalysisCleanupLease;
    },
  ) {}
}

/** The completed inspection carried by a failed or cancelled final close. */
export const completedJarInspection = (
  cause: unknown,
): JarInspection | undefined => {
  const value =
    cause instanceof ArtifactFileCleanupFailure &&
    cause.fileCleanupFailure.outcome.kind === "completed"
      ? cause.fileCleanupFailure.outcome.value
      : cause instanceof ArtifactFileCancelled
        ? cause.fileCancellation.outcome.value
        : undefined;
  return value instanceof JarInspection ? value : undefined;
};

/**
 * Classify a completed JAR inspection after its final close. A primary failure
 * keeps precedence over late cancellation; a completed result is retained as
 * the error's observation under cancellation or unconfirmed cleanup. Cleanup
 * failures of the archive descriptor and the ZIP reader are reported once and
 * bound to their exact leases, so the error resolves after close() releases
 * them. An unknown descriptor owner leaves the error unresolved.
 */
export const finishJarInspection = (
  { input, signal }: JarRequest,
  inspection: JarInspection,
  closeOutcome: unknown,
): Result<JvmDebugMetadataExecution, AnalysisError> => {
  const fileCleanup =
    closeOutcome instanceof ArtifactFileCleanupFailure
      ? closeOutcome
      : undefined;
  const readerCleanup = inspection.readerCleanup;
  const cancelled = signal?.aborted === true;
  const { result } = inspection;
  if (fileCleanup === undefined && readerCleanup === undefined) {
    if (!result.ok || !cancelled) return result;
    return err(
      new AnalysisCancelledError(OPERATION, {
        cause: signal.reason,
        partialObservation: createJavaDebugMetadataEvidence(
          input,
          result.value,
        ),
      }),
    );
  }
  const observations = [
    ...(fileCleanup?.cleanup === undefined ? [] : [fileCleanup.cleanup]),
    ...(readerCleanup === undefined
      ? []
      : [
          ArtifactReaderFailure.cleanupObservation(
            readerCleanup.cause,
            input.path,
          ),
        ]),
  ];
  const cleanupFacts = {
    reason: observations.map(({ reason }) => reason).join("; "),
    resources: [...new Set(observations.flatMap(({ resources }) => resources))],
  };
  const causes = [
    ...(fileCleanup === undefined ? [] : [fileCleanup]),
    ...(readerCleanup === undefined ? [] : [readerCleanup.cause]),
  ];
  const cleanupCause =
    causes.length === 1
      ? causes[0]
      : new AggregateError(causes, "JAR descriptor and reader cleanup failed");
  const evidence = result.ok
    ? createJavaDebugMetadataEvidence(input, result.value)
    : undefined;
  const error = result.ok
    ? cancelled
      ? analysisErrorWithCleanupFailure(
          new AnalysisCancelledError(OPERATION, {
            cause: signal.reason,
            partialObservation: evidence,
          }),
          jvmCleanupError(cleanupFacts, cleanupCause),
          OPERATION,
        )
      : jvmCleanupError(cleanupFacts, cleanupCause, evidence)
    : analysisErrorWithCleanupFailure(
        result.error,
        jvmCleanupError(cleanupFacts, cleanupCause),
        OPERATION,
      );
  const fileLeases = fileCleanup === undefined ? [] : fileCleanup.cleanupLeases;
  if (fileLeases !== undefined)
    new AnalysisCleanupLeaseGroup(error, [
      ...fileLeases,
      ...(readerCleanup === undefined ? [] : [readerCleanup.lease]),
    ]);
  return err(error);
};
