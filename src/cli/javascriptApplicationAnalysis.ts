import { JAVASCRIPT_APPLICATION_PROVIDER } from "../application/InvestigationProviders.js";
import { createProgressReporter } from "../application/ProgressReporter.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { javaScriptSourcePathsSchema } from "../domain/javascript/javascriptSourceSelection.js";
import { parseCliJsonInput } from "../cliJsonInput.js";

const OPERATION = "analyze_javascript_application";

/**
 * Combine repeated `--source-path` values with `--source-paths-json`, an inline
 * JSON array or a JSON file. A file keeps large selections below the host
 * command-line limit; entries remain exact application-relative paths and are
 * not resolved against the working directory.
 */
export const cliJavaScriptSourcePaths = async (
  sourcePath: readonly string[] | undefined,
  sourcePathsJson: string | undefined,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: readonly string[] | undefined }
  | { readonly ok: false; readonly error: JsonValue }
> => {
  if (sourcePathsJson === undefined) return { ok: true, value: sourcePath };
  const input = await parseCliJsonInput(sourcePathsJson, OPERATION, signal);
  if (!input.ok) return input;
  const parsed = javaScriptSourcePathsSchema.safeParse(input.value);
  if (!parsed.success)
    return {
      ok: false,
      error: cliError(
        analysisInputErrorFromIssues(
          OPERATION,
          parsed.error.issues.map((issue) => ({
            ...issue,
            path: ["source_paths_json", ...issue.path],
          })),
          { source_paths_json: input.value },
        ),
      ),
    };
  return { ok: true, value: [...(sourcePath ?? []), ...parsed.data] };
};

/** Execute the shared one-shot CLI boundary for static JavaScript analysis. */
export const runCliJavaScriptApplicationAnalysis = async (
  input: unknown,
  signal?: AbortSignal,
): Promise<JsonValue> => {
  const { analyzeJavaScriptApplication } =
    await import("../application/javascript/JavaScriptApplicationService.js");
  const progress = createProgressReporter(
    async (update) => {
      process.stderr.write(`${JSON.stringify({ rea_progress: update })}\n`);
    },
    { minimumIntervalMs: 0 },
  );
  const resources = new ArtifactResourceScope();
  const result = await analyzeJavaScriptApplication(input, resources, {
    progress,
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    await resources.close();
  } catch (cause: unknown) {
    const cleanup = ArtifactReaderFailure.cleanupObservation(
      cause,
      "JavaScript application resources",
    );
    const failure = new ProviderCleanupError(
      JAVASCRIPT_APPLICATION_PROVIDER.id,
      cleanup.resources,
      { reason: cleanup.reason },
      { cause, operation: "analyze_javascript_application" },
    );
    return cliError(
      result.ok
        ? failure
        : analysisErrorWithCleanupFailure(
            result.error,
            failure,
            "analyze_javascript_application",
          ),
    );
  }
  return result.ok ? result.value : cliError(result.error);
};

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "JavaScript application analysis failed",
  ...projectAnalysisError(error),
});
