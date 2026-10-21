import { lstat, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import ignore from "ignore";
import {
  readRegularFileText,
  RegularFileCleanupFailure,
  RegularFileReadFailure,
  retryRegularFileCleanup,
} from "./RegularFileRead.js";

import { err, ok, type Result } from "../domain/result.js";
import type { HistoricalSourceGraphInput } from "../domain/referenceSourceGraph.js";
import type {
  ReferenceSourceExclusionKind,
  ReferenceSourceExclusionPolicy,
} from "../reference/ReferenceSourceReaderTypes.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS,
  type ReferenceSourceImportError,
  type ReferenceSourceImportOptions,
} from "./ReferenceSourceImportTypes.js";
import { rootFilesystemFailure } from "../reference/ReferenceSourceReaderErrors.js";
import { regularFileCancellation } from "../filesystem/OwnedRegularFile.js";

/** Validated inputs ready for filesystem traversal. */
export interface PreparedReferenceSourceImport {
  readonly root: string;
  readonly policy: ReferenceSourceExclusionPolicy;
}

const failure = (
  code: ReferenceSourceImportError["code"],
  message: string,
): ReferenceSourceImportError => ({
  tag: "reference-source-import",
  code,
  message,
});

class IgnorePolicyReadCancelled extends Error {
  constructor(readonly reason: unknown) {
    super("Reference source ignore policy read was cancelled", {
      cause: reason,
    });
    this.name = "IgnorePolicyReadCancelled";
  }
}

const isIgnorePolicyCancellation = (cause: unknown): boolean =>
  cause instanceof IgnorePolicyReadCancelled;

const ignorePolicyCause = (cause: unknown): unknown =>
  cause instanceof IgnorePolicyReadCancelled
    ? cause.reason
    : cause instanceof RegularFileReadFailure
      ? cause.operationCause
      : cause;

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

type IgnoreReason = "project-ignored" | "default-ignored" | "caller-excluded";

/** Scope Git patterns once while retaining their original text for evidence. */
const scopedPattern = (
  pattern: string,
  directory: string,
): string | undefined => {
  if (directory === ".") return pattern;
  if (pattern.trim() === "" || pattern.startsWith("#")) return undefined;
  const negative = pattern.startsWith("!");
  // Match ignore's treatment of an initial BOM and escaped trailing whitespace
  // before deciding whether a slash anchors the rule to its own directory.
  const body = (negative ? pattern.slice(1) : pattern).replace(/^\uFEFF/u, "");
  const normalized = body.replace(
    /((?:\\\\)*?)(\\?\s+)$/u,
    (_match, pairs: string, trailing: string) =>
      pairs + (trailing.startsWith("\\") ? " " : ""),
  );
  if (normalized === "" || normalized === "/") return undefined;
  const anchored =
    normalized.startsWith("/") || normalized.slice(0, -1).includes("/");
  // The reader lends this matcher only to this directory's descendants.
  // Consume that known prefix by depth: literal filenames can contain glob
  // metacharacters that ignore cannot safely escape (notably ? and \\).
  const prefix = directory
    .split("/")
    .map(() => "*")
    .join("/");
  return `${negative ? "!" : ""}/${prefix}/${anchored ? "" : "**/"}${body.replace(/^\//u, "")}`;
};

const addMarkedPatterns = (
  matcher: ReturnType<typeof ignore>,
  patterns: readonly string[],
  reason: IgnoreReason,
  directory = ".",
): void => {
  for (const pattern of patterns)
    for (const line of pattern.split(/\r?\n/u)) {
      const scoped = scopedPattern(line, directory);
      if (scoped !== undefined)
        matcher.add({ pattern: scoped, mark: `${reason}\u0000${line}` });
    }
};

const resolveRoot = async (
  requestedRoot: string,
  signal?: AbortSignal,
): Promise<Result<string, ReferenceSourceImportError>> => {
  if (isAborted(signal))
    return err(failure("cancelled", "Reference source import cancelled"));
  try {
    const metadata = await stat(requestedRoot);
    if (isAborted(signal))
      return err(failure("cancelled", "Reference source import cancelled"));
    if (!metadata.isDirectory())
      return err(
        failure(
          "invalid-root",
          `Reference source root is not a directory: ${requestedRoot}`,
        ),
      );
    const canonicalRoot = await realpath(resolve(requestedRoot));
    if (isAborted(signal))
      return err(failure("cancelled", "Reference source import cancelled"));
    return ok(canonicalRoot);
  } catch (cause: unknown) {
    if (isAborted(signal))
      return err(failure("cancelled", "Reference source import cancelled"));
    const rootFailure = rootFilesystemFailure(
      cause,
      "Reference source root could not be resolved",
    );
    if (rootFailure === undefined) throw cause;
    return err({ ...failure(rootFailure.code, rootFailure.message), cause });
  }
};

const ignorePolicyExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    )
      return false;
    throw cause;
  }
};

const readIgnorePolicy = async (
  root: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
  symlinks: "follow" | "reject" = "follow",
): Promise<Result<string, ReferenceSourceImportError>> => {
  const policyPath = join(root, ".gitignore");
  try {
    const present = await ignorePolicyExists(policyPath);
    if (signal?.aborted === true)
      throw new IgnorePolicyReadCancelled(signal.reason);
    if (!present) return ok("");
    try {
      return ok(
        await readRegularFileText(policyPath, {
          signal,
          symlinks,
          cancellationFailure: (reason) =>
            new IgnorePolicyReadCancelled(reason),
        }),
      );
    } catch (cause: unknown) {
      if (cause instanceof IgnorePolicyReadCancelled) throw cause;
      if (!(cause instanceof RegularFileCleanupFailure)) throw cause;
      const retry = await retryRegularFileCleanup(cause, resources, signal);
      const operationCancellation =
        cause.outcome.kind === "failed"
          ? regularFileCancellation(cause)
          : undefined;
      if (retry.cleanup !== undefined) {
        const primary =
          retry.outcome.kind === "failed"
            ? retry.outcome.cause
            : cause.cleanupCause;
        const primaryCause = ignorePolicyCause(primary);
        return err({
          ...failure(
            isIgnorePolicyCancellation(primary) ||
              operationCancellation !== undefined
              ? "cancelled"
              : "io",
            `Reference source ignore policy could not be read at ${policyPath}: ${errorMessage(primaryCause)}`,
          ),
          cleanup: retry.cleanup,
          cause: primaryCause,
        });
      }
      if (retry.outcome.kind === "failed") {
        if (operationCancellation !== undefined)
          throw new IgnorePolicyReadCancelled(operationCancellation.reason);
        throw retry.outcome.cause;
      }
      if (isAborted(signal))
        throw new IgnorePolicyReadCancelled(signal?.reason);
      return ok(retry.outcome.value);
    }
  } catch (cause: unknown) {
    const causeValue = ignorePolicyCause(cause);
    return err({
      ...failure(
        isIgnorePolicyCancellation(cause) ? "cancelled" : "io",
        `Reference source ignore policy could not be read at ${policyPath}: ${errorMessage(causeValue)}`,
      ),
      cause: causeValue,
    });
  }
};

/** Resolve the caller-selected directory and build path filters. */
export const prepareReferenceSourceImport = async (
  options: ReferenceSourceImportOptions,
  resources: ArtifactResourceScope,
  exclusions: HistoricalSourceGraphInput["exclusions"] = [],
): Promise<
  Result<PreparedReferenceSourceImport, ReferenceSourceImportError>
> => {
  try {
    return await resources.run(async () => {
      const root = await resolveRoot(options.root, options.signal);
      if (!root.ok) return root;
      const policy = await readIgnorePolicy(
        root.value,
        resources,
        options.signal,
      );
      if (!policy.ok) return policy;
      const project = ignore();
      addMarkedPatterns(project, [policy.value], "project-ignored");
      const overrides = ignore();
      addMarkedPatterns(
        overrides,
        DEFAULT_REFERENCE_SOURCE_IGNORE_PATTERNS,
        "default-ignored",
      );
      for (const path of options.excludePaths ?? [])
        addMarkedPatterns(overrides, [path, `${path}/`], "caller-excluded");
      const secrets = ignore().add([...options.policy.secretPatterns]);
      return ok({
        root: root.value,
        policy: createExclusionPolicy(project, {
          root: root.value,
          overrides,
          secrets,
          exclusions,
          resources,
          signal: options.signal,
        }),
      });
    });
  } catch (cause: unknown) {
    if (!(cause instanceof ArtifactReaderFailure)) throw cause;
    return err({
      ...failure(
        cause.reason === "cancelled" ? "cancelled" : "io",
        cause.message,
      ),
      ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
      cause,
    });
  }
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

interface ExclusionPolicyContext {
  readonly root: string;
  readonly overrides: ReturnType<typeof ignore>;
  readonly secrets: ReturnType<typeof ignore>;
  readonly exclusions: HistoricalSourceGraphInput["exclusions"];
  readonly resources: ArtifactResourceScope;
  readonly signal: AbortSignal | undefined;
}

/** Each pending directory keeps its own inherited rules; siblings never share writes. */
const createExclusionPolicy = (
  project: ReturnType<typeof ignore>,
  context: ExclusionPolicyContext,
): ReferenceSourceExclusionPolicy => {
  const { root, overrides, secrets, exclusions, resources, signal } = context;
  const policy: ReferenceSourceExclusionPolicy = {
    shouldExclude: createShouldExclude(
      exclusions,
      secrets,
      ignore().add(project).add(overrides),
    ),
    prepareDirectory: async (directory) => {
      // Root admission already read its policy before any inventory or VCS work.
      if (directory === ".") return ok(policy);
      const text = await readIgnorePolicy(
        join(root, directory),
        resources,
        signal,
        "reject",
      );
      if (!text.ok)
        return err({
          ...text.error,
          tag: "reference-source-reader",
          code: text.error.code === "cancelled" ? "cancelled" : "io",
        });
      if (text.value === "") return ok(policy);
      const inherited = ignore().add(project);
      addMarkedPatterns(inherited, [text.value], "project-ignored", directory);
      return ok(createExclusionPolicy(inherited, context));
    },
  };
  return policy;
};

const createShouldExclude =
  (
    exclusions: HistoricalSourceGraphInput["exclusions"],
    secrets: ReturnType<typeof ignore>,
    ignored: ReturnType<typeof ignore>,
  ): ((path: string, kind: ReferenceSourceExclusionKind) => boolean) =>
  (path, kind) => {
    // An entry of unknown kind may be a directory, so directory-only rules
    // must still exclude it; this fails closed for caller-marked secrets.
    const patternPaths =
      kind === "directory"
        ? [`${path}/`]
        : kind === "unknown"
          ? [path, `${path}/`]
          : [path];
    const firstMatch = (matcher: typeof secrets) => {
      const results = patternPaths.map((patternPath) =>
        matcher.test(patternPath),
      );
      return results.find(({ ignored }) => ignored) ?? results[0];
    };
    const secretMatch = firstMatch(secrets);
    if (secretMatch?.ignored === true) {
      if (!secretMatch.rule)
        throw new Error(`Ignored secret path has no matching rule: ${path}`);
      exclusions.push({
        path,
        entry_kind: kind,
        reason: "configured-secret",
        pattern: secretMatch.rule.pattern,
      });
      return true;
    }
    const match = firstMatch(ignored);
    if (match?.ignored !== true) return false;
    if (!match.rule)
      throw new Error(`Ignored path has no matching rule: ${path}`);
    const mark = match.rule.mark ?? "";
    const separator = mark.indexOf("\u0000");
    const reason = mark.slice(0, separator);
    if (
      reason !== "project-ignored" &&
      reason !== "default-ignored" &&
      reason !== "caller-excluded"
    )
      throw new Error(`Ignored path has unknown rule origin: ${path}`);
    exclusions.push({
      path,
      entry_kind: kind,
      reason,
      pattern: mark.slice(separator + 1),
    });
    return true;
  };
