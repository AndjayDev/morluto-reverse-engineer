import { z } from "zod";
import { ABORTED, waitForAbortable } from "../process/AbortablePromise.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
  AnalysisOutputError,
  AnalysisInputError,
  AnalysisTimeoutError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { IdaConfiguration } from "./IdaConfiguration.js";
import { idaProtocol } from "./IdaConfiguration.js";
import type { IdaMcpConnection } from "./IdaMcpConnection.js";
import { nativeTools } from "./IdaNativeProtocol.js";
import {
  hexraysCloseDatabaseSchema,
  hexraysDatabaseListSchema,
  hexraysHealthQuery,
  hexraysMetadataQuery,
  hexraysOpenDatabaseSchema,
  hexraysTools,
  unwrapHexraysExecuteResult,
} from "./IdaHexraysProtocol.js";
import { readSettledHealth } from "./IdaBusyHealth.js";
import { isX86OnlyTarget } from "./IdaCallGraph.js";
import { IdaOperationRunner } from "./IdaOperationRunner.js";
import {
  IDA_LIMITATIONS,
  IDA_OPERATIONS,
  IDA_PROVIDER_IDENTITY,
  idaProfileAdmits,
  type IdaOperation,
} from "./IdaProviderCapabilities.js";
import {
  absentDatabaseCloseSchema,
  closeDatabaseSchema,
  databaseListSchema,
  legacyMetadataSchema,
  modernHealthSchema,
  openDatabaseSchema,
  rejectedOpenDatabaseSchema,
} from "./IdaProtocolValues.js";
import {
  idaFileDigest,
  IdaWorkspace,
  sameIdaHostPath,
} from "./IdaWorkspace.js";
import { parseIdaInput } from "./IdaInput.js";
import { createEvidence } from "../domain/evidence.js";

const legacyTools = [
  "get_metadata",
  "list_functions",
  "list_strings",
  "get_function_by_name",
  "get_function_by_address",
  "decompile_function",
  "disassemble_function",
  "get_callers",
  "get_callees",
  "get_xrefs_to",
];
const modernTools = [
  "idb_open",
  "idb_list",
  "idb_close",
  "server_health",
  "list_funcs",
  "lookup_funcs",
  "find_regex",
  "decompile",
  "disasm",
  "callees",
  "xrefs_to",
];
const operationSet: ReadonlySet<string> = new Set(IDA_OPERATIONS);

const isIdaOperation = (operation: string): operation is IdaOperation =>
  operationSet.has(operation);
const wasCancelled = (options: ExecutionOptions | undefined): boolean =>
  options?.signal?.aborted === true;

interface IdaOperationFailureContext {
  runner: IdaOperationRunner | undefined;
  metadataBefore: JsonValue | undefined;
  metadataAfter: JsonValue | undefined;
  postOperationIdentityCheck: "not_attempted" | "started" | "verified";
  parameters: Readonly<Record<string, JsonValue>>;
}

/** Upstream session ids of inventory entries, omitting unreported ones. */
interface UpstreamSession {
  readonly session_id: string;
  readonly backend: "worker" | "gui";
  /** Upstream ownership; null when no inventory has reported it. */
  readonly owned: boolean | null;
  /** Last inventoried input binding; null until upstream reports it. */
  readonly input_path: string | null;
  /** Last inventoried activity; null before upstream reports it. */
  readonly is_active: boolean | null;
}

/**
 * Protocol-normalized database inventory row used by lifecycle checks.
 * The official server's rows carry no activity field and its GUI rows carry
 * no instance id, so hexrays rows use `is_active: true` and the empty
 * session id as this adapter's own bookkeeping values, not observations.
 */
interface LifecycleInventoryEntry {
  readonly session_id: string;
  readonly input_path: string;
  readonly owned: boolean;
  readonly backend: "worker" | "gui";
  readonly is_active: boolean;
}

/** A failed cleanup retains its private workspace and reports the remaining resource. */
class IdaCleanupError extends ProviderAdapterError {
  override readonly cleanupIncomplete = true;
  constructor(
    path: string,
    cause: unknown,
    sessions?: readonly UpstreamSession[],
  ) {
    super("ida", "close", {
      cause,
      capturedOutput:
        cause instanceof AnalysisError ? cause.capturedOutput : undefined,
      diagnostics: {
        ...(cause instanceof AnalysisError ? cause.diagnostics : undefined),
        reason:
          "IDA cleanup could not be verified; the remaining connection or private workspace is retained for retry.",
        failure_reason:
          cause instanceof AnalysisError
            ? (cause.diagnostics?.reason ?? cause.message)
            : cause instanceof Error
              ? cause.message
              : String(cause),
        workspace: path,
        ...(sessions === undefined
          ? {}
          : {
              upstream_sessions: {
                state: "unverified",
                sessions: sessions.map(
                  ({ session_id, backend, owned, input_path, is_active }) => ({
                    session_id,
                    backend,
                    owned,
                    input_path,
                    is_active,
                  }),
                ),
                reason:
                  "Release of upstream sessions matching the requested session ID or private input was not confirmed; input_path preserves the last observed binding and is null when no inventory has reported it. is_active preserves registry activity and is null when unknown; it does not establish process liveness. A worker outlives its supervisor and may keep running until it finishes and reaches its idle timeout; exiting REA does not stop it. A gui session belongs to an IDA instance REA does not control. An empty session_id means upstream reported none; owned is null when no inventory has reported ownership; an empty list means the requested worker's close was confirmed but no inventory has identified any remaining session.",
              },
            }),
      },
    });
    this.setCleanupResources([path]);
  }
}

/** Serial read-only session whose lifecycle authority excludes an attached GUI. */
export class IdaSessionClient implements AnalysisClient {
  #tail: Promise<void> = Promise.resolve();
  #startup: Promise<void> | undefined;
  #closed = false;
  #closing = false;
  #closePromise: Promise<Result<null, AnalysisError>> | undefined;
  #workspace: IdaWorkspace | undefined;
  #database: string | undefined;
  #databaseCloseCompleted = false;
  #openAttempted = false;
  #openCompleted = false;
  #ready = false;
  #blockingSessions: readonly UpstreamSession[] | undefined;
  #openRejected = false;
  #callGraphAdvertised = false;
  #surveyAdvertised = false;
  #initialIdentity: string | undefined;
  #metadata: JsonValue = null;
  #lifecycle: JsonValue[] = [];

  constructor(
    private readonly config: IdaConfiguration,
    private readonly target: BinaryTarget,
    private readonly connection: IdaMcpConnection,
    private readonly profile?: AnalysisProfileCommitment,
  ) {}

  execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    const call = this.#tail.then(() =>
      this.#execute(operation, parameters, options),
    );
    this.#tail = call.then(
      () => undefined,
      () => undefined,
    );
    return call;
  }

  async executeIfReady(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ) {
    if (!this.#ready || this.#closed || this.#closing)
      return Promise.resolve(undefined);
    const call = this.#tail.then(() => {
      if (!this.#ready || this.#closed || this.#closing) return undefined;
      if (wasCancelled(options))
        return err(new AnalysisCancelledError(operation));
      return this.#execute(operation, parameters, options, true);
    });
    this.#tail = call.then(
      () => undefined,
      () => undefined,
    );
    const result = await waitForAbortable(call, options?.signal);
    return result === ABORTED
      ? err(new AnalysisCancelledError(operation))
      : result;
  }

  async #execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
    readyOnly = false,
  ) {
    if (this.#closed || this.#closing)
      return err(
        new AnalysisProtocolError(
          "IDA session is closing or closed; reopen the target.",
        ),
      );
    if (wasCancelled(options))
      return err(new AnalysisCancelledError(operation));
    if (operation !== "health" && !isIdaOperation(operation))
      return err(
        new AnalysisCapabilityUnavailableError(
          "ida",
          operation,
          "This integration admits read-only analysis operations only.",
        ),
      );
    if (
      operation !== "health" &&
      !idaProfileAdmits(operation, this.config.mode)
    )
      return err(
        new AnalysisCapabilityUnavailableError(
          "ida",
          operation,
          "This operation is available for the modern headless profile only.",
        ),
      );
    if (
      operation === "procedure_callers" &&
      idaProtocol(this.config) !== "legacy" &&
      idaProtocol(this.config) !== "hexrays"
    )
      return err(
        new AnalysisCapabilityUnavailableError(
          "ida",
          operation,
          "This upstream profile does not prove direct callers.",
        ),
      );
    if (operation !== "health") {
      const parsed = parseIdaInput(operation, parameters);
      if (!parsed.ok) return parsed;
      parameters = parsed.value;
    }
    const document = parameters.document;
    if (
      document !== undefined &&
      (typeof document !== "string" ||
        (!sameIdaHostPath(document, this.target.path) &&
          (this.target.sourcePath === undefined ||
            !sameIdaHostPath(document, this.target.sourcePath))))
    )
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["document"],
            reason: "invalid_value",
            expected: this.target.path,
            message:
              "IDA document must be the REA-bound target; omit document or use its admitted path.",
          },
        ]),
      );
    const failureContext: IdaOperationFailureContext = {
      runner: undefined,
      metadataBefore: undefined,
      metadataAfter: undefined,
      postOperationIdentityCheck: "not_attempted",
      parameters,
    };
    try {
      if (!readyOnly) await this.#start(operation);
      const before = await this.#observe(options);
      failureContext.metadataBefore = before;
      if (wasCancelled(options)) throw new AnalysisCancelledError(operation);
      if (operation === "health") return this.#health(before);
      if (!isIdaOperation(operation))
        throw new AnalysisProtocolError(
          "IDA operation changed after validation.",
        );
      const runner = this.#runner(options);
      failureContext.runner = runner;
      const result = await runner.run(operation, parameters);
      if (wasCancelled(options)) throw new AnalysisCancelledError(operation);
      failureContext.postOperationIdentityCheck = "started";
      const after = await this.#observe(
        options,
        (observed) => (failureContext.metadataAfter = observed),
      );
      failureContext.postOperationIdentityCheck = "verified";
      if (wasCancelled(options)) throw new AnalysisCancelledError(operation);
      return ok(
        createAnalysisExecution(result, IDA_PROVIDER_IDENTITY, {
          rawResult: {
            upstream: this.connection.serverInfo(),
            metadata_before: before,
            metadata_after: after,
            observations: jsonValueSchema.parse(runner.raw),
          },
          limitations: [...IDA_LIMITATIONS, ...runner.limitations],
          ...(runner.relationshipCoverage === undefined
            ? {}
            : { relationshipCoverage: runner.relationshipCoverage }),
          ...(runner.referencesTruncated !== undefined
            ? { referencesTruncated: runner.referencesTruncated }
            : {}),
          locations: [
            { kind: "artifact-path", path: this.target.path },
            ...runner.locations,
          ],
          ...(this.profile === undefined
            ? {}
            : { analysisProfile: this.profile }),
        }),
      );
    } catch (cause: unknown) {
      return this.#failure(operation, cause, options, failureContext);
    }
  }

  #runner(options: ExecutionOptions | undefined): IdaOperationRunner {
    return new IdaOperationRunner(
      this.connection,
      idaProtocol(this.config),
      this.#database,
      {
        signal: options?.signal,
        selectorOrigin: options?.selectorOrigin,
        x86Only: isX86OnlyTarget(this.target),
        callGraphAvailable: this.#callGraphAdvertised,
        surveyAvailable: this.#surveyAdvertised,
        admittedDocument: this.target.path,
      },
    );
  }

  #health(metadata: JsonValue) {
    return ok(
      createAnalysisExecution(
        {
          ready: true,
          mode: this.config.mode,
          database: this.#database ?? null,
          upstream: this.connection.serverInfo(),
          metadata,
          lifecycle: this.#lifecycle,
        },
        IDA_PROVIDER_IDENTITY,
        {
          limitations: IDA_LIMITATIONS,
          ...(this.profile === undefined
            ? {}
            : { analysisProfile: this.profile }),
        },
      ),
    );
  }

  #failure(
    operation: string,
    cause: unknown,
    options: ExecutionOptions | undefined,
    context: IdaOperationFailureContext,
  ) {
    let failure: AnalysisError;
    if (wasCancelled(options)) {
      failure = new AnalysisCancelledError(operation, {
        cause,
        ...(cause instanceof AnalysisError
          ? {
              capturedOutput: cause.capturedOutput,
              diagnostics: cause.diagnostics,
              partialObservation: cause.partialObservation,
              cleanup:
                cause.cleanup ??
                (cause.cleanupIncomplete
                  ? {
                      reason: cause.message,
                      resources: cause.cleanupResources,
                    }
                  : undefined),
            }
          : {}),
      });
      if (cause instanceof AnalysisError)
        failure
          .bindCleanupDependencies([cause])
          .bindCleanupResourceOwner(cause);
    } else if (
      cause instanceof ProviderAdapterError &&
      cause.operation === "transport"
    )
      failure = new ProviderAdapterError("ida", operation, {
        cause,
        capturedOutput: cause.capturedOutput,
        partialObservation: cause.partialObservation,
        cleanup: cause.cleanup,
        diagnostics: {
          ...cause.diagnostics,
          recovery:
            "Check the configured upstream MCP registration and selected target; see docs/ida-provider.md.",
        },
      });
    else if (cause instanceof AnalysisError) failure = cause;
    else if (cause instanceof z.ZodError)
      failure = new AnalysisOutputError(
        operation,
        `IDA MCP returned malformed or unsupported producer data: ${cause.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
        { cause },
      );
    else
      failure = new ProviderAdapterError("ida", operation, {
        cause,
        diagnostics: {
          reason:
            cause instanceof Error ? cause.message : "Unknown upstream failure",
          recovery:
            "Check the configured upstream MCP registration and selected target; see docs/ida-provider.md.",
        },
      });
    // Only operation calls made after target identity/readiness validation can
    // become partial Evidence. The failing call itself is absent from `raw`
    // when its transport or MCP envelope could not be decoded.
    const { runner, metadataBefore, metadataAfter } = context;
    if (
      runner !== undefined &&
      runner.raw.length > 0 &&
      metadataBefore !== undefined
    ) {
      const observations = jsonValueSchema.parse(runner.raw);
      const upstream = this.connection.serverInfo();
      const binding =
        context.postOperationIdentityCheck !== "verified"
          ? {
              status: "not_verified",
              reason:
                cause instanceof Error
                  ? cause.message
                  : "Post-operation target identity was not observed.",
            }
          : { status: "verified" };
      failure.retainPartialObservation(
        createEvidence(this.target, IDA_PROVIDER_IDENTITY, {
          predicateType: "analysis-observation",
          operation,
          parameters: context.parameters,
          result: {
            status: "partial",
            failed_operation: operation,
            observations,
            metadata_before: metadataBefore,
            target_binding: binding,
            ...(metadataAfter === undefined
              ? {}
              : { metadata_after: metadataAfter }),
          },
          rawResult: {
            upstream,
            observations,
            metadata_before: metadataBefore,
            ...(metadataAfter === undefined
              ? {}
              : { metadata_after: metadataAfter }),
            post_operation_identity_check: context.postOperationIdentityCheck,
          },
          confidence: "observed",
          authority: "external-service",
          limitations: [
            ...IDA_LIMITATIONS,
            ...runner.limitations,
            "The requested IDA operation failed after these completed upstream replies; the partial Evidence does not establish a complete result.",
            "Replies are bound to the selected target only by the pre-operation identity check unless post_operation_identity_check is verified.",
          ],
          locations: [
            { kind: "artifact-path", path: this.target.path },
            ...runner.locations,
          ],
        }),
      );
    }
    return err(failure);
  }

  async #start(operation: string): Promise<void> {
    this.#startup ??= this.#initialize();
    try {
      await this.#startup;
    } catch (cause: unknown) {
      if (
        !(cause instanceof AnalysisTimeoutError) &&
        !(cause instanceof AnalysisResourceConstraintError) &&
        !(cause instanceof ProviderAdapterError)
      )
        throw cause;
      // Transport adapters already receive caller attribution in #failure.
      if (
        cause instanceof ProviderAdapterError &&
        cause.operation === "transport"
      )
        throw cause;
      const options = {
        cause,
        capturedOutput: cause.capturedOutput,
        partialObservation: cause.partialObservation,
        cleanup: cause.cleanup,
        ...(cause.userMessage === undefined
          ? {}
          : { userMessage: cause.userMessage }),
        ...(cause.remediationAction === undefined
          ? {}
          : { remediationAction: cause.remediationAction }),
        diagnostics: {
          ...cause.diagnostics,
          startup_operation: cause.operation,
        },
      };
      // Startup is shared, but each accepted operation owns its attribution.
      // Keep the original cached failure unchanged for later callers.
      const failure =
        cause instanceof AnalysisTimeoutError
          ? new AnalysisTimeoutError(operation, cause.timeoutMs, options)
          : cause instanceof AnalysisResourceConstraintError
            ? new AnalysisResourceConstraintError(
                operation,
                cause.resource,
                cause.reason,
                cause.reportedLimits,
                {
                  ...options,
                  ...(cause.retryable === undefined
                    ? {}
                    : { retryable: cause.retryable }),
                },
              )
            : new ProviderAdapterError(cause.providerId, operation, options);
      throw failure
        .bindCleanupDependencies([cause])
        .bindCleanupResourceOwner(cause);
    }
  }

  async #initialize(): Promise<void> {
    const tools = new Set(await this.connection.connect());
    this.#callGraphAdvertised = tools.has("callgraph");
    // The official profile serves the survey facet through its translation
    // instead of advertising a tool of that name.
    this.#surveyAdvertised =
      tools.has("survey_binary") ||
      (this.config.protocol === "hexrays" && this.config.mode === "headless");
    const expected =
      this.config.protocol === "native"
        ? nativeTools
        : this.config.protocol === "hexrays"
          ? hexraysTools
          : this.config.mode === "attached"
            ? legacyTools
            : modernTools;
    const missing = expected.filter((name) => !tools.has(name));
    if (missing.length > 0) {
      const summary = `IDA MCP ${this.config.protocol === "native" ? "native attached" : this.config.protocol === "hexrays" ? "official" : this.config.mode} compatibility profile is missing tools: ${missing.join(", ")}. Native attached mode requires the native IDA MCP tool catalog; legacy attached mode requires the legacy 1.4 profile; headless mode requires the database supervisor profile; the official profile requires the Hex-Rays ida-mcp server. See docs/ida-provider.md.`;
      // The caller cannot act on a profile mismatch it never sees, so the
      // missing names travel as adapter diagnostics rather than a bare message.
      throw new ProviderAdapterError("ida", "initialize", {
        userMessage: summary,
        diagnostics: {
          reason: summary,
          mode: this.config.mode,
          expected_profile:
            this.config.protocol === "native"
              ? "native"
              : this.config.protocol === "hexrays"
                ? "official-hexrays"
                : this.config.mode === "attached"
                  ? "legacy-1.4"
                  : "database-supervisor",
          missing_tools: [...missing],
          recovery:
            "Install an IDA MCP build that serves the selected profile; see docs/ida-provider.md.",
        },
      });
    }
    if (this.config.mode === "headless") {
      this.#workspace = await IdaWorkspace.allocate(
        this.target,
        this.config.workspaceRoot,
      );
      await this.#workspace.copyInput();
      this.#openAttempted = true;
      if (this.config.protocol === "hexrays") {
        await this.#openHeadlessHexrays();
      } else {
        const raw = await this.connection.call("idb_open", {
          input_path: this.#workspace.inputPath,
          mode: "force_headless",
          run_auto_analysis: true,
          build_caches: true,
          init_hexrays: true,
          preferred_session_id: this.#workspace.sessionId,
        });
        this.#openCompleted = true;
        // A completed but malformed/positive open may still own a live Worker.
        // Only an explicit producer rejection keeps the old no-worker branch.
        this.#openRejected = rejectedOpenDatabaseSchema.safeParse(raw).success;
        this.#lifecycle.push(raw);
        const opened = openDatabaseSchema.parse(raw);
        if (
          !sameIdaHostPath(opened.session.input_path, this.#workspace.inputPath)
        )
          throw new AnalysisProtocolError(
            "IDA opened a different input than the private admitted target copy.",
          );
        if (opened.session.session_id !== this.#workspace.sessionId)
          throw new AnalysisProtocolError(
            "IDA returned an adopted or unexpected session instead of the requested private worker.",
          );
        const inventory = databaseListSchema.parse(
          await this.connection.call("idb_list", {}),
        );
        this.#lifecycle.push(jsonValueSchema.parse(inventory));
        const workspace = this.#workspace;
        this.#recordBlockingSessions(
          inventory.sessions.filter(
            (entry) =>
              entry.session_id === workspace.sessionId ||
              sameIdaHostPath(entry.input_path, workspace.inputPath),
          ),
        );
        const entry = inventory.sessions.find(
          ({ session_id }) => session_id === opened.session.session_id,
        );
        if (
          entry?.owned !== true ||
          entry.backend !== "worker" ||
          entry.is_active !== true ||
          !sameIdaHostPath(entry.input_path, this.#workspace.inputPath)
        )
          throw new AnalysisProtocolError(
            "IDA did not return an active owned headless worker for the private input copy.",
          );
        this.#database = opened.session.session_id;
      }
    } else if (this.config.protocol === "hexrays") {
      await this.#bindAttachedHexrays();
    }
    this.#ready = true;
  }

  /**
   * Open the private input copy in an official headless worker. The private
   * copy cannot be open in the IDA GUI, so the server cannot adopt a GUI
   * database for it, and the returned instance id pins every later call.
   */
  async #openHeadlessHexrays(): Promise<void> {
    const workspace = this.#workspace;
    if (workspace === undefined)
      throw new AnalysisProtocolError(
        "IDA headless session has no private workspace.",
      );
    const raw = await this.connection.call("open_database", {
      path: workspace.inputPath,
    });
    this.#openCompleted = true;
    this.#lifecycle.push(raw);
    const opened = hexraysOpenDatabaseSchema.parse(raw);
    if (
      opened.backend !== "idalib" ||
      typeof opened.instance_id !== "string" ||
      opened.instance_id.length === 0
    )
      throw new AnalysisProtocolError(
        "The official IDA MCP did not return a headless worker for the private admitted target copy.",
      );
    const inventory = hexraysDatabaseListSchema.parse(
      await this.connection.call("list_databases", {}),
    );
    this.#lifecycle.push(jsonValueSchema.parse(inventory));
    this.#recordBlockingSessions(
      inventory.instances
        .filter((entry) =>
          this.#hexraysEntryMatchesWorkspace(
            entry,
            opened.instance_id ?? undefined,
          ),
        )
        .map((entry) => this.#hexraysUpstreamSession(entry)),
    );
    const entry = inventory.instances.find(
      ({ instance_id }) => instance_id === opened.instance_id,
    );
    if (
      entry === undefined ||
      entry.backend !== "idalib" ||
      !this.#hexraysEntryMatchesWorkspace(entry, opened.instance_id)
    )
      throw new AnalysisProtocolError(
        "The official IDA MCP inventory did not confirm the private headless worker for the admitted input copy.",
      );
    this.#database = opened.instance_id;
  }

  /**
   * Bind the attached session to the GUI database whose recorded input
   * matches the admitted target. GUI databases report no instance id, so
   * queries stay bound through this connection's current database instead.
   */
  async #bindAttachedHexrays(): Promise<void> {
    const inventory = hexraysDatabaseListSchema.parse(
      await this.connection.call("list_databases", {}),
    );
    this.#lifecycle.push(jsonValueSchema.parse(inventory));
    const guiDatabases = inventory.instances.filter(
      ({ backend, status }) => backend === "gui" && status === "available",
    );
    if (guiDatabases.length === 0)
      throw new AnalysisProtocolError(
        "The official IDA MCP reports no database open in the IDA GUI; open the selected target in IDA or use headless mode.",
      );
    const tried: string[] = [];
    for (const candidate of guiDatabases) {
      const opened = hexraysOpenDatabaseSchema.parse(
        await this.connection.call("open_database", { path: candidate.path }),
      );
      this.#lifecycle.push(jsonValueSchema.parse(opened));
      let metadata: JsonValue | undefined;
      let readFailure: string | undefined;
      try {
        metadata = await this.#hexraysExecute(
          hexraysMetadataQuery(),
          opened.instance_id ?? undefined,
        );
      } catch (cause) {
        // A GUI database whose recorded input cannot be read cannot match,
        // but a transport failure must surface instead of looking like one.
        if (
          cause instanceof ProviderAdapterError ||
          cause instanceof AnalysisTimeoutError ||
          cause instanceof AnalysisResourceConstraintError
        )
          throw cause;
        readFailure = cause instanceof Error ? cause.message : String(cause);
      }
      const parsed = legacyMetadataSchema.safeParse(metadata);
      if (
        parsed.success &&
        parsed.data.sha256.toLowerCase() === this.target.sha256.toLowerCase()
      ) {
        this.#database = opened.instance_id ?? undefined;
        return;
      }
      const reason =
        readFailure !== undefined
          ? `identity read failed: ${readFailure}`
          : !parsed.success
            ? "identity observation malformed"
            : parsed.data.sha256 === ""
              ? "input digest unavailable"
              : "input digest mismatch";
      tried.push(`${candidate.path} (${reason})`);
    }
    throw new AnalysisProtocolError(
      `No database open in the IDA GUI matches the selected target ${this.target.path}; GUI databases tried: ${tried.join(", ")}. Open that target in IDA or use headless mode.`,
    );
  }

  /** One read-only official-server query against a bound database. */
  async #hexraysExecute(
    code: string,
    instanceId: string | undefined,
  ): Promise<JsonValue> {
    return unwrapHexraysExecuteResult(
      await this.connection.call("execute_python", {
        code,
        ...(instanceId === undefined ? {} : { instance_id: instanceId }),
      }),
    );
  }

  #hexraysEntryMatchesWorkspace(
    entry: z.infer<typeof hexraysDatabaseListSchema>["instances"][number],
    instanceId: string | undefined,
  ): boolean {
    const workspace = this.#workspace;
    if (workspace === undefined) return false;
    return (
      (instanceId !== undefined && entry.instance_id === instanceId) ||
      this.#inventoryMatchesWorkspacePath(entry.path, workspace.inputPath)
    );
  }

  /** Inventory rows keep the adapter's ownership vocabulary for diagnostics. */
  #hexraysUpstreamSession(
    entry: z.infer<typeof hexraysDatabaseListSchema>["instances"][number],
  ): UpstreamSession & { readonly owned: boolean } {
    return {
      session_id: entry.instance_id ?? "",
      backend: entry.backend === "gui" ? "gui" : "worker",
      owned: entry.backend === "idalib",
      input_path: entry.path,
      is_active: true,
    };
  }

  async #nativeMetadata(): Promise<JsonValue> {
    if (this.connection.readResource === undefined)
      throw new AnalysisProtocolError(
        "Native IDA MCP requires resources/read for recorded input metadata.",
      );
    return this.connection.readResource("ida://idb/metadata");
  }

  async #observe(
    options?: ExecutionOptions,
    onObserved?: (metadata: JsonValue) => void,
  ): Promise<JsonValue> {
    let identity: string;
    if (this.config.mode === "attached") {
      const raw =
        this.config.protocol === "native"
          ? await this.#nativeMetadata()
          : this.config.protocol === "hexrays"
            ? await this.#hexraysExecute(hexraysMetadataQuery(), this.#database)
            : await this.connection.call("get_metadata", {});
      const metadata = legacyMetadataSchema.parse(raw);
      this.#metadata = raw;
      onObserved?.(raw);
      if (metadata.sha256.toLowerCase() !== this.target.sha256.toLowerCase())
        throw new AnalysisProtocolError(
          `The attached IDA input SHA-256 does not match the selected target ${this.target.path}; open that target in IDA or use headless mode.`,
        );
      identity = JSON.stringify([
        metadata.path,
        metadata.sha256.toLowerCase(),
        metadata.base,
      ]);
    } else {
      if (this.#database === undefined || this.#workspace === undefined)
        throw new AnalysisProtocolError(
          "IDA headless session has no database binding.",
        );
      const raw =
        this.config.protocol === "hexrays"
          ? await this.#hexraysExecute(hexraysHealthQuery(), this.#database)
          : await readSettledHealth(this.connection, {
              database: this.#database,
              timeoutMs: this.config.timeoutMs,
              signal: options?.signal,
            });
      const metadata = modernHealthSchema.parse(raw);
      this.#metadata = raw;
      onObserved?.(raw);
      if (
        !sameIdaHostPath(metadata.input_path, this.#workspace.inputPath) ||
        (await idaFileDigest(this.#workspace.inputPath)) !==
          this.#workspace.inputSha256
      )
        throw new AnalysisProtocolError(
          "IDA headless input identity changed after target admission.",
        );
      if (metadata.auto_analysis_ready !== true)
        throw new AnalysisProtocolError(
          "IDA auto-analysis is incomplete or readiness is unknown; retry after analysis completes.",
        );
      identity = JSON.stringify([
        this.#database,
        metadata.input_path,
        metadata.idb_path,
        metadata.imagebase,
      ]);
    }
    if (
      this.#initialIdentity !== undefined &&
      identity !== this.#initialIdentity
    )
      throw new AnalysisProtocolError(
        "The attached IDA target or image base changed during the REA session; reopen the target.",
      );
    this.#initialIdentity = identity;
    return this.#metadata;
  }

  async close(): Promise<Result<null, AnalysisError>> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const closing = this.#closeOnce();
    const shared = closing.finally(() => {
      if (this.#closePromise === shared) this.#closePromise = undefined;
    });
    this.#closePromise = shared;
    return shared;
  }

  /**
   * Upstream sessions whose release cleanup has not confirmed: the entries
   * the latest successful inventory found blocking release; else the
   * requested private worker until its close is confirmed, and then none
   * known.
   */
  #unreleasedSessions(): readonly UpstreamSession[] | undefined {
    if (this.#blockingSessions !== undefined) return this.#blockingSessions;
    if (
      !this.#openAttempted ||
      this.#workspace === undefined ||
      this.#openRejected
    )
      return undefined;
    return this.#databaseCloseCompleted
      ? []
      : [
          {
            session_id:
              this.config.protocol === "hexrays"
                ? (this.#database ?? "")
                : this.#workspace.sessionId,
            backend: "worker",
            owned: null,
            input_path: null,
            is_active: null,
          },
        ];
  }

  /** Drop a session whose release upstream confirmed, keeping other blockers. */
  #forgetReleasedSession(sessionId: string): void {
    const remaining = this.#blockingSessions?.filter(
      ({ session_id }) => session_id !== sessionId,
    );
    this.#blockingSessions =
      remaining !== undefined && remaining.length > 0 ? remaining : undefined;
  }

  /** Replace blocker evidence from a successful inventory; true when blocked. */
  #recordBlockingSessions(
    entries: readonly (UpstreamSession & { readonly owned: boolean })[],
  ): boolean {
    this.#blockingSessions =
      entries.length > 0
        ? entries.map(
            ({ session_id, backend, owned, input_path, is_active }) => ({
              session_id,
              backend,
              owned,
              input_path,
              is_active,
            }),
          )
        : undefined;
    return entries.length > 0;
  }

  /** One protocol-normalized database inventory row for lifecycle checks. */
  async #lifecycleInventory(): Promise<readonly LifecycleInventoryEntry[]> {
    if (this.config.protocol === "hexrays") {
      const list = hexraysDatabaseListSchema.parse(
        await this.connection.call("list_databases", {}),
      );
      return list.instances.map((entry) => ({
        session_id: entry.instance_id ?? "",
        input_path: entry.path,
        owned: entry.backend === "idalib",
        backend:
          entry.backend === "gui" ? ("gui" as const) : ("worker" as const),
        is_active: true,
      }));
    }
    return databaseListSchema.parse(await this.connection.call("idb_list", {}))
      .sessions;
  }

  /** A headless worker the inventory proves this session owns privately. */
  #inventoryOwnsPrivateWorker(entry: LifecycleInventoryEntry): boolean {
    const workspace = this.#workspace;
    if (workspace === undefined) return false;
    if (entry.owned !== true || entry.backend !== "worker") return false;
    if (this.config.protocol === "hexrays")
      return (
        entry.session_id !== "" &&
        this.#inventoryMatchesWorkspacePath(
          entry.input_path,
          workspace.inputPath,
        )
      );
    return (
      entry.session_id === workspace.sessionId &&
      sameIdaHostPath(entry.input_path, workspace.inputPath)
    );
  }

  /** An entry still claiming the requested worker identity or private input. */
  #inventoryMatchesWorkspace(entry: LifecycleInventoryEntry): boolean {
    const workspace = this.#workspace;
    if (workspace === undefined) return false;
    if (this.config.protocol === "hexrays")
      return this.#inventoryMatchesWorkspacePath(
        entry.input_path,
        workspace.inputPath,
      );
    return (
      entry.session_id === workspace.sessionId ||
      sameIdaHostPath(entry.input_path, workspace.inputPath)
    );
  }

  #inventoryMatchesReleased(
    entry: LifecycleInventoryEntry,
    database: string,
  ): boolean {
    return (
      entry.session_id === database || this.#inventoryMatchesWorkspace(entry)
    );
  }

  /**
   * The official server names an idalib worker's database after its input
   * with the engine's database suffix, so both forms claim the input.
   */
  #inventoryMatchesWorkspacePath(
    entryPath: string,
    inputPath: string,
  ): boolean {
    return (
      sameIdaHostPath(entryPath, inputPath) ||
      sameIdaHostPath(entryPath, `${inputPath}.i64`) ||
      sameIdaHostPath(entryPath, `${inputPath}.idb`)
    );
  }

  async #closeDatabase(database: string): Promise<void> {
    if (this.config.protocol === "hexrays") {
      // The official release drops this connection's lease only; it never
      // saves and never closes a database that the IDA GUI keeps open.
      const closed = hexraysCloseDatabaseSchema.parse(
        await this.connection.call("close_database", {
          instance_id: database,
        }),
      );
      if (closed.closed !== true)
        throw new AnalysisProtocolError(
          "The official IDA MCP did not confirm the headless worker release.",
        );
      return;
    }
    const response = await this.connection.call("idb_close", {
      database,
      save: false,
    });
    const closed = closeDatabaseSchema.safeParse(response);
    if (!closed.success) {
      if (!absentDatabaseCloseSchema(database).safeParse(response).success)
        throw closed.error;
      return;
    }
    if (
      closed.data.session_id !== database ||
      closed.data.saved === true ||
      closed.data.owned !== true ||
      closed.data.backend !== "worker"
    )
      throw new AnalysisProtocolError(
        "IDA database close did not confirm the requested owned, unsaved session release.",
      );
  }

  async #closeOnce(): Promise<Result<null, AnalysisError>> {
    this.#closing = true;
    await this.#tail;
    if (this.#closed) return ok(null);
    try {
      if (this.#workspace !== undefined && this.#openAttempted) {
        if (this.#database === undefined) {
          const inventory = await this.#lifecycleInventory();
          this.#database = inventory.find((entry) =>
            this.#inventoryOwnsPrivateWorker(entry),
          )?.session_id;
          // Every same-input session and any entry under the requested ID,
          // whatever its input, stays reported until a later successful
          // inventory confirms release.
          const blocked = this.#recordBlockingSessions(
            inventory.filter((entry) => this.#inventoryMatchesWorkspace(entry)),
          );
          if (this.#database === undefined && blocked)
            throw new AnalysisProtocolError(
              "A registered session still matches the requested ID or private input without a verified private worker binding; the workspace was retained.",
            );
          if (
            this.#database === undefined &&
            this.#openCompleted &&
            !this.#openRejected
          )
            throw new AnalysisProtocolError(
              "IDA open returned without a verified private worker binding. An empty session inventory does not prove that its Worker exited; the private workspace was retained.",
            );
        }
        if (this.#database !== undefined) {
          if (!this.#databaseCloseCompleted) {
            await this.#closeDatabase(this.#database);
            this.#databaseCloseCompleted = true;
            this.#forgetReleasedSession(this.#database);
          }
          const inventory = await this.#lifecycleInventory();
          const released = this.#database;
          const remaining = inventory.filter((entry) =>
            this.#inventoryMatchesReleased(entry, released),
          );
          if (this.#recordBlockingSessions(remaining))
            throw new AnalysisProtocolError(
              "IDA worker remains registered after close.",
            );
          this.#database = undefined;
        }
        if (!this.#openCompleted)
          throw new AnalysisProtocolError(
            "IDA database open did not return a completed response. Worker inventory cannot prove that the request has stopped; the private workspace was retained.",
          );
        this.#openAttempted = false;
      }
      await this.connection.close();
      await this.#workspace?.remove();
      this.#closed = true;
      return ok(null);
    } catch (cause: unknown) {
      this.connection.detach();
      return err(
        new IdaCleanupError(
          this.#workspace?.directory ?? "IDA MCP connection",
          cause,
          this.#unreleasedSessions(),
        ),
      );
    }
  }
}
