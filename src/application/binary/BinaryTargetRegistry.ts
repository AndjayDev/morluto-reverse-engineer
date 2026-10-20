import { randomUUID } from "node:crypto";

import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type { AnalysisSnapshot } from "../../domain/analysisSnapshot.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInProgressError,
  AnalysisResourceConstraintError,
  AnalysisTargetNotOpenError,
} from "../../domain/analysisErrorCore.js";
import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import type { Evidence } from "../../domain/evidence.js";
import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import type { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { ResolvedSessionOpen } from "./BinarySessionOpen.js";
import { BinarySession } from "./BinarySession.js";
import { parseBinaryTarget } from "../BinaryTargetResolver.js";
import type {
  BinarySessionPort,
  SavedAnalysisSnapshot,
} from "./BinarySessionPort.js";
import { binaryTargetSummary } from "./BinaryTargetSummary.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import type { SessionProviderRouter } from "./SessionProviderRouter.js";
import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type {
  UnknownPage,
  UnknownQuery,
} from "../investigation/InvestigationRecordPort.js";
import type {
  RecordUnknownInput,
  ResidualUnknown,
  UnknownStatus,
  UpdateUnknownInput,
} from "../../domain/residualUnknown.js";
import type { UnknownRegistryError } from "../../domain/unknownRegistryError.js";
import type { WorkflowSnapshotRecordInput } from "./BinarySessionRecords.js";

/** Bounded target and analysis concurrency supplied by the composition root. */
export interface BinaryTargetLimits {
  readonly maxOpenTargets: number;
  readonly maxConcurrentAnalyses: number;
  readonly autoBackgroundAfterMs: number;
  /**
   * Bound on how long a close waits for an interrupted start to unwind.
   *
   * A provider start that ignores its abort holds the session's transition
   * promise, and the ordinary close serializes behind it. The close stops
   * waiting after this bound and releases the pending client through the
   * owner that stops the provider.
   */
  readonly jobSettleTimeoutMs: number;
}

const DEFAULT_LIMITS: BinaryTargetLimits = {
  maxOpenTargets: 4,
  maxConcurrentAnalyses: 2,
  autoBackgroundAfterMs: 120_000,
  jobSettleTimeoutMs: 30_000,
};

const DEFAULT_WAIT_MS = 180_000;
const MAX_WAIT_MS = 290_000;

interface TargetSlot {
  readonly id: string;
  readonly session: BinarySession;
}

type AnalysisJobState = "starting" | "ready" | "failed" | "cancelled";

type OpenOptions = NonNullable<Parameters<BinarySessionPort["open"]>[1]>;
type OpenResolvedOptions = NonNullable<
  Parameters<BinarySessionPort["openResolvedTarget"]>[1]
>;

interface AnalysisJob {
  readonly slot: TargetSlot;
  readonly target: BinaryTarget;
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly mode: "background" | "auto";
  state: AnalysisJobState;
  error: AnalysisError | undefined;
  /** Completion time of a terminal job; undefined while the job is starting. */
  finishedAt: number | undefined;
  promise: Promise<void>;
}

/**
 * Own several independent target sessions behind one `BinarySessionPort`.
 *
 * Each slot keeps the single-target lifecycle lock, provider client, snapshot
 * cache, and cancellation scope it had when `BinarySession` owned the whole
 * server. The registry routes each call to one slot and bounds how many slots
 * and simultaneous starts may exist. A call without `target_id` addresses the
 * current slot, so single-target clients keep the replacement behaviour.
 */
export class BinaryTargetRegistry implements BinarySessionPort {
  readonly #router: SessionProviderRouter;
  readonly #records: InvestigationRecords;
  readonly #limits: BinaryTargetLimits;
  readonly #slots = new Map<string, TargetSlot>();
  readonly #jobs = new Map<string, AnalysisJob>();
  /** Slot handles whose provider cleanup failed and still owns its resource. */
  readonly #retainedSlots = new Set<string>();
  readonly #availabilityListeners = new Set<() => void | Promise<void>>();
  readonly #snapshotListeners = new Set<() => void | Promise<void>>();
  #primary: TargetSlot;
  #currentId: string;
  #activeStarts = 0;
  readonly #startQueue: Array<() => void> = [];

  constructor(
    router: SessionProviderRouter,
    records: InvestigationRecords = new InvestigationRecords(),
    limits: Partial<BinaryTargetLimits> = {},
  ) {
    this.#router = router;
    this.#records = records;
    this.#limits = {
      maxOpenTargets: Math.max(
        1,
        limits.maxOpenTargets ?? DEFAULT_LIMITS.maxOpenTargets,
      ),
      maxConcurrentAnalyses: Math.max(
        1,
        limits.maxConcurrentAnalyses ?? DEFAULT_LIMITS.maxConcurrentAnalyses,
      ),
      autoBackgroundAfterMs: Math.max(
        1,
        limits.autoBackgroundAfterMs ?? DEFAULT_LIMITS.autoBackgroundAfterMs,
      ),
      jobSettleTimeoutMs: Math.max(
        1,
        limits.jobSettleTimeoutMs ?? DEFAULT_LIMITS.jobSettleTimeoutMs,
      ),
    };
    this.#primary = this.#createSlot();
    this.#currentId = this.#primary.id;
  }

  /** Currently open target handles in deterministic creation order. */
  targets(): readonly {
    readonly target_id: string;
    readonly target: BinaryTarget;
  }[] {
    return [...this.#slots.values()].flatMap((slot) => {
      const target =
        slot.session.activeTarget() ?? this.#jobs.get(slot.id)?.target;
      return target === undefined ? [] : [{ target_id: slot.id, target }];
    });
  }

  /** Identifier of the target addressed when a call omits target_id. */
  currentTargetId(): string | undefined {
    return this.#targetForSlot(this.#slotById(this.#currentId)) === undefined
      ? undefined
      : this.#currentId;
  }

  /** Current background-analysis state for one target, when tracked. */
  analysisState(targetId?: string): JsonValue | undefined {
    const slot = this.#resolveSlotResult(targetId);
    if (!slot.ok) return undefined;
    const job = this.#jobForSlot(slot.value);
    if (job === undefined) return undefined;
    return {
      state: job.state,
      mode: job.mode,
      started_at: new Date(job.startedAt).toISOString(),
      elapsed_ms: this.#jobElapsedMs(job),
      ...(job.error === undefined
        ? {}
        : {
            error: {
              code: projectAnalysisError(job.error).code,
              message: job.error.message,
            },
          }),
    };
  }

  /** Elapsed time of a job; a finished job stops counting at its completion. */
  #jobElapsedMs(job: AnalysisJob): number {
    return (job.finishedAt ?? Date.now()) - job.startedAt;
  }

  async open(
    path: string,
    options: Parameters<BinarySessionPort["open"]>[1] = {},
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    if ((options.analysisMode ?? "foreground") !== "foreground")
      return this.#openAsJob(path, options);
    if (options.keepOthersOpen !== true)
      return this.#openReplacing(path, options);
    const existing = this.#slotForPath(path);
    if (existing !== undefined)
      return this.#openInSlot(existing, path, options);
    return this.#openInNewSlot(path, options);
  }

  async openResolvedTarget(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: Parameters<BinarySessionPort["openResolvedTarget"]>[1] = {},
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    if ((options.analysisMode ?? "foreground") !== "foreground")
      return this.#openResolvedAsJob(resolved, options);
    if (options.keepOthersOpen !== true)
      return this.#openResolvedReplacing(resolved, options);
    const existing = this.#slotForPath(resolved.target.path);
    if (existing !== undefined)
      return this.#openResolvedInSlot(existing, resolved, options);
    return this.#openResolvedInNewSlot(resolved, options);
  }

  async #openReplacing(
    path: string,
    options: OpenOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    this.#cancelJob(this.#primary);
    const closed = await this.#closeSlotsExcept(this.#primary);
    if (!closed.ok) return closed;
    return this.#openInSlot(this.#primary, path, options);
  }

  async #openResolvedReplacing(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: OpenResolvedOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    this.#cancelJob(this.#primary);
    const closed = await this.#closeSlotsExcept(this.#primary);
    if (!closed.ok) return closed;
    return this.#openResolvedInSlot(this.#primary, resolved, options);
  }

  async #openAsJob(
    path: string,
    options: OpenOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const existing = this.#slotForPath(path);
    if (existing !== undefined) {
      const job = this.#blockingJob(existing);
      if (job !== undefined) return this.#jobOpenResult(job, options);
      const active = existing.session.activeTarget();
      if (active !== undefined) {
        this.#currentId = existing.id;
        return ok(active);
      }
    }
    if (isAborted(options.signal))
      return err(new AnalysisCancelledError("open_binary"));
    const parsed = await parseBinaryTarget(path, {
      ...(options.targetKind === undefined
        ? {}
        : { targetKind: options.targetKind }),
      ...(options.formatHint === undefined
        ? {}
        : { formatHint: options.formatHint }),
      ...(options.architecture === undefined
        ? {}
        : { architecture: options.architecture }),
      ...(options.entryPoint === undefined
        ? {}
        : { entryPoint: options.entryPoint }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!parsed.ok) return parsed;
    const slot = await this.#slotForJob(options);
    if (!slot.ok) return slot;
    // The target is parsed once here; the slot opens the resolved target so
    // the provider start never repeats the parse.
    const preview = await slot.value.session.previewTarget(parsed.value, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.providerId === undefined
        ? {}
        : { providerId: options.providerId }),
    });
    if (!preview.ok) {
      // The new target never became usable, so the slot it would have used is
      // dropped. The primary is never dropped here: it may already own a live
      // open target, and unregistering it would make that target invisible
      // and unclosable.
      if (slot.value !== this.#primary) this.#removeSlot(slot.value, "primary");
      return preview;
    }
    return this.#startJob(
      slot.value,
      parsed.value,
      "background",
      (signal) =>
        slot.value.session.openResolvedTarget(preview.value, {
          ...options,
          signal,
        }),
      options,
    );
  }

  async #openResolvedAsJob(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: OpenResolvedOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const existing = this.#slotForPath(resolved.target.path);
    if (existing !== undefined) {
      const job = this.#blockingJob(existing);
      if (job !== undefined) return this.#jobOpenResult(job, options);
      const active = existing.session.activeTarget();
      if (active !== undefined) {
        this.#currentId = existing.id;
        return ok(active);
      }
    }
    if (isAborted(options.signal))
      return err(new AnalysisCancelledError("open_binary"));
    const slot = await this.#slotForJob(options);
    if (!slot.ok) return slot;
    return this.#startJob(
      slot.value,
      resolved.target,
      "background",
      (signal) =>
        slot.value.session.openResolvedTarget(resolved, { ...options, signal }),
      options,
    );
  }

  async #slotForJob(
    options: OpenOptions,
  ): Promise<Result<TargetSlot, AnalysisError>> {
    if (options.keepOthersOpen === true) {
      const capacity = this.#checkOpenCapacity("open_binary");
      if (capacity !== undefined) return capacity;
      return ok(this.#createSlot());
    }
    const closed = await this.#closeSlotsExcept(this.#primary);
    if (!closed.ok) return closed;
    const previousJob = this.#jobs.get(this.#primary.id);
    previousJob?.controller.abort();
    this.#jobs.delete(this.#primary.id);
    return ok(this.#primary);
  }

  #startJob(
    slot: TargetSlot,
    target: BinaryTarget,
    requestedMode: "background" | "auto",
    start: (
      signal: AbortSignal,
    ) => Promise<Result<BinaryTarget, AnalysisError>>,
    options: OpenOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const mode =
      options.analysisMode === "auto" ? ("auto" as const) : requestedMode;
    const controller = new AbortController();
    const startedAt = Date.now();
    const job: AnalysisJob = {
      slot,
      target,
      controller,
      startedAt,
      mode,
      state: "starting",
      error: undefined,
      finishedAt: undefined,
      promise: Promise.resolve(),
    };
    this.#slots.set(slot.id, slot);
    this.#jobs.set(slot.id, job);
    this.#currentId = slot.id;
    job.promise = this.#runJob(job, start);
    if (mode === "background") return Promise.resolve(ok(target));
    const threshold = Math.max(
      1,
      options.autoBackgroundAfterMs ?? this.#limits.autoBackgroundAfterMs,
    );
    return this.#waitForAutoJob(job, threshold, options.signal).then(
      (outcome) => this.#jobOutcome(job, outcome),
    );
  }

  /**
   * Run one job under the shared start permit.
   *
   * The permit bounds simultaneous provider starts for background jobs exactly
   * as it does for foreground opens, and the queue is FIFO. The job owns the
   * start signal, so cancelling a queued start through `close_binary` releases
   * the queue entry without ever consuming a permit.
   */
  async #runJob(
    job: AnalysisJob,
    start: (
      signal: AbortSignal,
    ) => Promise<Result<BinaryTarget, AnalysisError>>,
  ): Promise<void> {
    const permit = await this.#acquireStartPermit(
      "open_binary",
      job.controller.signal,
    );
    if (!permit.ok) {
      this.#finishJob(job, "cancelled", permit.error);
      return;
    }
    try {
      const result = await start(job.controller.signal);
      if (job.controller.signal.aborted) {
        this.#finishJob(
          job,
          "cancelled",
          result.ok ? new AnalysisCancelledError("open_binary") : result.error,
        );
        return;
      }
      if (result.ok) {
        this.#finishJob(job, "ready");
        return;
      }
      this.#finishJob(job, "failed", result.error);
    } catch (cause: unknown) {
      this.#finishJob(
        job,
        job.controller.signal.aborted ? "cancelled" : "failed",
        cause instanceof AnalysisError
          ? cause
          : new AnalysisCancelledError("open_binary"),
      );
    } finally {
      this.#releaseStartPermit();
    }
  }

  /** Record a terminal job state and stop its elapsed clock. */
  #finishJob(
    job: AnalysisJob,
    state: AnalysisJobState,
    error?: AnalysisError,
  ): void {
    job.state = state;
    job.error = error;
    job.finishedAt = Date.now();
  }

  async #waitForAutoJob(
    job: AnalysisJob,
    thresholdMs: number,
    signal: AbortSignal | undefined,
  ): Promise<"ready" | "failed" | "aborted" | "timeout"> {
    if (isAborted(signal)) return "aborted";
    const outcome = await new Promise<
      "ready" | "failed" | "aborted" | "timeout"
    >((resolve) => {
      let settled = false;
      const finish = (
        value: "ready" | "failed" | "aborted" | "timeout",
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => finish("timeout"), thresholdMs);
      timer.unref?.();
      const onAbort = (): void => finish("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      void job.promise.then(() =>
        finish(job.state === "ready" ? "ready" : "failed"),
      );
    });
    return outcome;
  }

  /**
   * One rule for the answer a job gives.
   *
   * An aborted wait means the request was cancelled while the job kept
   * running, so the request reports cancellation. A timed-out wait means the
   * job is still starting, so the request reports the started target. The
   * first open and a re-open of the same running job share this rule.
   */
  #jobOutcome(
    job: AnalysisJob,
    outcome: "ready" | "failed" | "aborted" | "timeout",
  ): Result<BinaryTarget, AnalysisError> {
    if (outcome === "ready") return ok(job.target);
    if (outcome === "failed") return this.#terminalJobOutcome(job);
    if (outcome === "aborted")
      return err(new AnalysisCancelledError("open_binary"));
    return ok(job.target);
  }

  /** Report a job that reached a terminal state without becoming ready. */
  #terminalJobOutcome(job: AnalysisJob): Result<BinaryTarget, AnalysisError> {
    if (job.state === "failed")
      return err(job.error ?? new AnalysisCancelledError("open_binary"));
    return err(new AnalysisCancelledError("open_binary"));
  }

  #jobOpenResult(
    job: AnalysisJob,
    options: OpenOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    if (job.state === "ready") return Promise.resolve(ok(job.target));
    if (job.state === "starting" && job.mode === "background")
      return Promise.resolve(ok(job.target));
    if (job.state === "failed" || job.state === "cancelled")
      return Promise.resolve(this.#terminalJobOutcome(job));
    return this.#waitForAutoJob(
      job,
      Math.max(
        1,
        options.autoBackgroundAfterMs ?? this.#limits.autoBackgroundAfterMs,
      ),
      options.signal,
    ).then((outcome) => this.#jobOutcome(job, outcome));
  }

  async #openInNewSlot(
    path: string,
    options: OpenOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const capacity = this.#checkOpenCapacity("open_binary");
    if (capacity !== undefined) return capacity;
    return this.#openInSlot(this.#createSlot(), path, options);
  }

  async #openResolvedInNewSlot(
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: OpenResolvedOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const capacity = this.#checkOpenCapacity("open_binary");
    if (capacity !== undefined) return capacity;
    return this.#openResolvedInSlot(this.#createSlot(), resolved, options);
  }

  async #openInSlot(
    slot: TargetSlot,
    path: string,
    options: OpenOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const job = this.#blockingJob(slot);
    if (job !== undefined) {
      await job.promise;
      return job.state === "ready"
        ? ok(job.target)
        : err(job.error ?? new AnalysisCancelledError("open_binary"));
    }
    const permit = await this.#acquireStartPermit(
      "open_binary",
      options?.signal,
    );
    if (!permit.ok) return err(permit.error);
    try {
      const opened = await slot.session.open(path, options);
      return this.#finishOpen(slot, opened);
    } finally {
      this.#releaseStartPermit();
    }
  }

  async #openResolvedInSlot(
    slot: TargetSlot,
    resolved: Pick<ResolvedSessionOpen, "target" | "route">,
    options: OpenResolvedOptions,
  ): Promise<Result<BinaryTarget, AnalysisError>> {
    const job = this.#blockingJob(slot);
    if (job !== undefined) {
      await job.promise;
      return job.state === "ready"
        ? ok(job.target)
        : err(job.error ?? new AnalysisCancelledError("open_binary"));
    }
    const permit = await this.#acquireStartPermit(
      "open_binary",
      options?.signal,
    );
    if (!permit.ok) return err(permit.error);
    try {
      const opened = await slot.session.openResolvedTarget(resolved, options);
      return this.#finishOpen(slot, opened);
    } finally {
      this.#releaseStartPermit();
    }
  }

  #finishOpen(
    slot: TargetSlot,
    opened: Result<BinaryTarget, AnalysisError>,
  ): Result<BinaryTarget, AnalysisError> {
    if (!opened.ok) {
      if (slot !== this.#primary && slot.session.activeTarget() === undefined)
        this.#removeSlot(slot, "primary");
      return opened;
    }
    this.#slots.set(slot.id, slot);
    this.#currentId = slot.id;
    return opened;
  }

  previewTarget(
    target: BinaryTarget,
    options: Parameters<BinarySessionPort["previewTarget"]>[1] = {},
  ): Promise<Result<ResolvedSessionOpen, AnalysisError>> {
    return this.#currentSlot().session.previewTarget(target, options);
  }

  close(
    options: Parameters<BinarySessionPort["close"]>[0] = {},
  ): Promise<Result<null, AnalysisError>> {
    return this.#closeSlotFor(
      options,
      (slot, behavior) => slot.session.closeAsSlot(options, behavior),
      (slot, behavior) =>
        this.#closeSlotWithoutTransition(slot, options, behavior),
    );
  }

  /**
   * Close every slot; incomplete cleanup stays visible on the first failure.
   *
   * A slot whose close failed keeps its registration, its job entry, and the
   * retained resource it still owns, so a later close can retry the cleanup.
   * Only a successful close retires a slot.
   */
  async closeAll(
    options: Parameters<NonNullable<BinarySessionPort["closeAll"]>>[0] = {},
  ): Promise<Result<null, AnalysisError>> {
    let failure: AnalysisError | undefined;
    for (const slot of [...this.#slots.values()]) {
      if (slot === this.#primary) continue;
      const closed = await this.#closeSlot(slot, options, {
        clearRecords: false,
        closeOwnedProviderResources: false,
      });
      if (!closed.ok) {
        failure ??= closed.error;
        this.#retainedSlots.add(slot.id);
        this.#jobs.delete(slot.id);
        continue;
      }
      this.#retainedSlots.delete(slot.id);
      this.#removeSlot(slot, "first-open");
    }
    const final = await this.#closeSlot(this.#primary, options, {
      clearRecords: true,
      closeOwnedProviderResources: true,
    });
    if (!final.ok) {
      failure ??= final.error;
      this.#retainedSlots.add(this.#primary.id);
      this.#jobs.delete(this.#primary.id);
    } else {
      this.#retainedSlots.delete(this.#primary.id);
      this.#removeSlot(this.#primary, "first-open");
    }
    return failure === undefined ? ok(null) : err(failure);
  }

  /**
   * Abort a slot's job, wait for it to unwind, and close the slot session.
   *
   * The wait is bounded. A provider start that ignores its abort keeps the
   * session's transition promise unsettled, and the ordinary close serializes
   * behind that promise, so waiting for it forever would hang the close and
   * the server shutdown with it. When the bound expires the close escalates
   * to the path that releases the pending client without the transition
   * chain; the cleanup still runs through the owner that stops the provider.
   */
  async #closeSlot(
    slot: TargetSlot,
    options: Pick<ExecutionOptions, "progress"> & {
      readonly retainProviderDocuments?: boolean;
      readonly targetId?: string;
    },
    behavior: {
      readonly clearRecords: boolean;
      readonly closeOwnedProviderResources: boolean;
    },
  ): Promise<Result<null, AnalysisError>> {
    const settled = await this.#abortJobAndWait(slot);
    if (settled) return slot.session.closeAsSlot(options, behavior);
    return this.#closeSlotWithoutTransition(slot, options, behavior);
  }

  /** Retire a slot whose provider start did not unwind in time. */
  async #closeSlotWithoutTransition(
    slot: TargetSlot,
    options: Pick<ExecutionOptions, "progress"> & {
      readonly retainProviderDocuments?: boolean;
      readonly targetId?: string;
    },
    behavior: {
      readonly clearRecords: boolean;
      readonly closeOwnedProviderResources: boolean;
    },
  ): Promise<Result<null, AnalysisError>> {
    const escalate = slot.session.closeWithoutTransition;
    if (escalate === undefined)
      return slot.session.closeAsSlot(options, behavior);
    return escalate.call(slot.session, options, behavior);
  }

  closeWithSnapshot(
    path: string,
    overwrite: boolean,
    options: Parameters<BinarySessionPort["closeWithSnapshot"]>[2] = {},
  ): Promise<Result<SavedAnalysisSnapshot, AnalysisError>> {
    return this.#closeSlotFor(
      options,
      (slot, behavior) =>
        slot.session.closeWithSnapshotAsSlot(
          path,
          overwrite,
          options,
          behavior,
        ),
      // A wedged start cannot be snapshotted, but the provider still has to be
      // released. The escalation closes the slot the same way the plain close
      // does, and the snapshot is reported as not taken.
      async (slot, behavior) => {
        const closed = await this.#closeSlotWithoutTransition(
          slot,
          options,
          behavior,
        );
        return closed.ok
          ? err(
              new AnalysisCancelledError("close_binary", {
                diagnostics: {
                  reason:
                    "the provider start did not unwind within the settle bound, so no analysis snapshot was taken",
                  settle_bound_ms: this.#limits.jobSettleTimeoutMs,
                },
              }),
            )
          : closed;
      },
    );
  }

  async #closeSlotFor<Value>(
    options: { readonly targetId?: string; readonly signal?: AbortSignal },
    close: (
      slot: TargetSlot,
      behavior: {
        readonly clearRecords: boolean;
        readonly closeOwnedProviderResources: boolean;
      },
    ) => Promise<Result<Value, AnalysisError>>,
    escalate: (
      slot: TargetSlot,
      behavior: {
        readonly clearRecords: boolean;
        readonly closeOwnedProviderResources: boolean;
      },
    ) => Promise<Result<Value, AnalysisError>>,
  ): Promise<Result<Value, AnalysisError>> {
    const slot = this.#resolveCloseSlot(options.targetId);
    if (!slot.ok) return slot;
    const last = this.#openSlotCount() <= 1;
    const settled = await this.#abortJobAndWait(slot.value);
    const closed = await (settled
      ? close(slot.value, {
          clearRecords: last,
          closeOwnedProviderResources: last,
        })
      : escalate(slot.value, {
          clearRecords: last,
          closeOwnedProviderResources: last,
        }));
    if (closed.ok) {
      this.#retainedSlots.delete(slot.value.id);
      this.#removeSlot(slot.value, "first-open");
    } else {
      // The slot keeps its registration and its retained resource, so a later
      // close can retry the cleanup. It is no longer an open target: the
      // closed target must not stay listed or routable.
      this.#retainedSlots.add(slot.value.id);
      this.#jobs.delete(slot.value.id);
    }
    return closed;
  }

  /**
   * Abort a slot's job and wait, bounded, for the interrupted start to unwind.
   *
   * The wait keeps the interrupted provider start and the close from
   * interleaving over the same client: the start owns its own cleanup, and the
   * close reports that outcome instead of racing past it. The wait is bounded,
   * and it reports whether the start unwound. A start that ignores its abort
   * holds the session transition, so the caller escalates rather than waiting
   * for a close that would never begin.
   */
  async #abortJobAndWait(slot: TargetSlot): Promise<boolean> {
    const job = this.#jobs.get(slot.id);
    if (job === undefined) return true;
    job.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    await Promise.race([
      job.promise.then(() => {
        settled = true;
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.#limits.jobSettleTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return settled;
  }

  async status(
    options: Parameters<BinarySessionPort["status"]>[0] = {},
  ): Promise<JsonValue> {
    const slot = this.#resolveSlot(options?.targetId, "binary_session");
    if (!slot.ok) throw slot.error;
    const job = this.#jobForSlot(slot.value);
    if (job?.state === "starting")
      // Without a declared budget the status reports the current state at
      // once. A caller that wants to wait names its own budget.
      await this.#waitForAnalysis(slot.value, "binary_session", {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        waitMs: options.waitMs ?? 0,
      });
    const base = await slot.value.session.status(options);
    if (typeof base !== "object" || base === null || Array.isArray(base))
      return base;
    const analysis =
      job === undefined
        ? undefined
        : {
            state: job.state,
            mode: job.mode,
            started_at: new Date(job.startedAt).toISOString(),
            elapsed_ms: this.#jobElapsedMs(job),
            ...(job.error === undefined
              ? {}
              : {
                  error: {
                    code: projectAnalysisError(job.error).code,
                    message: job.error.message,
                  },
                }),
          };
    const targetFields =
      job === undefined ||
      base.open === true ||
      job.state === "failed" ||
      job.state === "cancelled"
        ? {}
        : {
            open: true as const,
            ...binaryTargetSummary(job.target),
          };
    return {
      ...base,
      ...targetFields,
      target_id: slot.value.id,
      open_target_ids: this.targets().map(({ target_id }) => target_id),
      ...(this.#retainedSlots.size === 0
        ? {}
        : { retained_target_ids: [...this.#retainedSlots] }),
      ...(analysis === undefined ? {} : { analysis }),
    };
  }

  execute(
    name: Parameters<AnalysisOperationPort["execute"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const slot = this.#resolveSlot(options?.targetId, name);
    if (!slot.ok) return Promise.resolve(slot);
    return this.#waitForAnalysis(slot.value, name, options).then((ready) =>
      ready.ok ? slot.value.session.execute(name, arguments_, options) : ready,
    );
  }

  executeIfProviderReady(
    name: Parameters<BinarySessionPort["executeIfProviderReady"]>[0],
    arguments_: Readonly<Record<string, JsonValue>>,
    options?: Pick<ExecutionOptions, "signal" | "selectorOrigin" | "targetId">,
  ): Promise<Result<AnalysisExecution, AnalysisError> | undefined> {
    const slot = this.#resolveSlot(options?.targetId, name);
    if (!slot.ok) return Promise.resolve(slot);
    const job = this.#jobForSlot(slot.value);
    if (job !== undefined && job.state !== "ready")
      return Promise.resolve(undefined);
    return slot.value.session.executeIfProviderReady(name, arguments_, options);
  }

  withAdmittedAnalysis<Value>(
    operationName: string,
    signal: AbortSignal | undefined,
    operation: (analysis: AnalysisOperationPort) => Promise<Value>,
    targetId?: string,
    waitMs?: number,
  ): Promise<Result<Value, AnalysisError>> {
    const slot = this.#resolveSlot(targetId, operationName);
    if (!slot.ok) return Promise.resolve(slot);
    return this.#waitForAnalysis(slot.value, operationName, {
      ...(signal === undefined ? {} : { signal }),
      ...(waitMs === undefined ? {} : { waitMs }),
    }).then((ready) =>
      ready.ok
        ? slot.value.session.withAdmittedAnalysis(
            operationName,
            signal,
            operation,
          )
        : ready,
    );
  }

  withAdmittedExternalMutation<Value>(
    path: string | undefined,
    signal: AbortSignal | undefined,
    operation: () => Promise<Result<Value, AnalysisError>>,
    retirementFailure: (
      value: Result<Value, AnalysisError>,
      error: AnalysisError,
    ) => AnalysisError,
    operationName = "execute_rizin_command",
    cleanupRecovery?: (
      failure: AnalysisError | undefined,
    ) => Promise<Result<null, AnalysisError>>,
  ): Promise<Result<Result<Value, AnalysisError>, AnalysisError>> {
    const slot = this.#currentSlot();
    return slot.session.withAdmittedExternalMutation(
      path,
      signal,
      operation,
      retirementFailure,
      operationName,
      cleanupRecovery,
    );
  }

  activeTarget(targetId?: string): BinaryTarget | undefined {
    const slot = this.#resolveSlotResult(targetId);
    return slot.ok ? this.#targetForSlot(slot.value) : undefined;
  }

  /**
   * Identify the provider that owns one target.
   *
   * An explicit handle that is not open is an error, never the primary slot's
   * provider. The port cannot express a failure here, so the registry reports
   * it the way `status` does.
   */
  providerIdentity(
    operation?: AnalysisOperation,
    targetId?: string,
  ): ProviderIdentity {
    const slot = this.#resolveSlot(targetId, "provider identity");
    if (!slot.ok) throw slot.error;
    return slot.value.session.providerIdentity(operation);
  }

  /** Report the profile of one target; an unknown handle has no profile. */
  analysisProfile(
    operation?: AnalysisOperation,
    targetId?: string,
  ): AnalysisProfileCommitment | undefined {
    const slot = this.#resolveSlot(targetId, "analysis profile");
    return slot.ok ? slot.value.session.analysisProfile(operation) : undefined;
  }

  /** Report whether one target may replay a snapshot; an unknown handle may not. */
  allowsSnapshotReplay(
    operation: AnalysisOperation,
    targetId?: string,
  ): boolean {
    const slot = this.#resolveSlot(targetId, "snapshot replay");
    return slot.ok ? slot.value.session.allowsSnapshotReplay(operation) : false;
  }

  /** Invalidate one target's cached Evidence; an unknown handle owns none. */
  invalidateSnapshotForExternalMutation(targetId?: string): void {
    const slot = this.#resolveSlot(targetId, "external mutation");
    if (!slot.ok) return;
    slot.value.session.invalidateSnapshotForExternalMutation();
  }

  exportAnalysisSnapshot(
    targetId?: string,
  ): Result<AnalysisSnapshot, AnalysisError> {
    const slot = this.#resolveSlot(targetId, "snapshot export");
    return slot.ok
      ? slot.value.session.exportAnalysisSnapshot()
      : err(slot.error);
  }

  importAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
    targetId?: string,
  ): Result<number, AnalysisError> {
    const slot = this.#resolveSlot(targetId, "snapshot import");
    return slot.ok
      ? slot.value.session.importAnalysisSnapshot(snapshot)
      : err(slot.error);
  }

  recordWorkflowSnapshot(
    input: WorkflowSnapshotRecordInput,
  ): Result<null, EvidenceIntegrityError> {
    return this.#currentSlot().session.recordWorkflowSnapshot(input);
  }

  onAvailabilityChanged(listener: () => void | Promise<void>): () => void {
    this.#availabilityListeners.add(listener);
    return () => this.#availabilityListeners.delete(listener);
  }

  onAnalysisSnapshotChanged(listener: () => void | Promise<void>): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  // Investigation records stay session-wide. The current slot owns the target
  // binding used to attach new unknowns and the only active snapshot cache.
  recordEvidence(
    evidence: Evidence,
  ): ReturnType<BinarySessionPort["recordEvidence"]> {
    return this.#currentSlot().session.recordEvidence(evidence);
  }

  hasEvidence(evidenceId: string): boolean {
    return this.#currentSlot().session.hasEvidence(evidenceId);
  }

  evidenceById(evidenceId: string): Evidence | undefined {
    return this.#currentSlot().session.evidenceById(evidenceId);
  }

  evidenceForAnalysis(evidenceId: string): Evidence | undefined {
    return this.#currentSlot().session.evidenceForAnalysis(evidenceId);
  }

  exportEvidenceBundle(): EvidenceBundle {
    return this.#currentSlot().session.exportEvidenceBundle();
  }

  evidenceBundleForSerialization(): EvidenceBundle {
    return this.#currentSlot().session.evidenceBundleForSerialization();
  }

  writeAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
    path: string,
    overwrite: boolean,
  ): ReturnType<BinarySession["writeAnalysisSnapshot"]> {
    return this.#currentSlot().session.writeAnalysisSnapshot(
      snapshot,
      path,
      overwrite,
    );
  }

  closeWriteResources(): Promise<Result<null, AnalysisError>> {
    return this.#currentSlot().session.closeWriteResources();
  }

  importEvidenceBundle(
    bundle: unknown,
  ): ReturnType<BinarySession["importEvidenceBundle"]> {
    return this.#currentSlot().session.importEvidenceBundle(bundle);
  }

  recordUnknown(
    input: RecordUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    return this.#currentSlot().session.recordUnknown(input);
  }

  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError> {
    return this.#currentSlot().session.recordEvidenceWithUnknown(
      evidence,
      input,
    );
  }

  updateUnknown(
    input: UpdateUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    return this.#currentSlot().session.updateUnknown(input);
  }

  listUnknowns(
    filters: {
      readonly status?: UnknownStatus;
      readonly severity?: ResidualUnknown["severity"];
      readonly domain?: string;
    } = {},
  ): ResidualUnknown[] {
    return this.#currentSlot().session.listUnknowns(filters);
  }

  listUnknownsPage(query: UnknownQuery = {}): UnknownPage {
    return this.#currentSlot().session.listUnknownsPage(query);
  }

  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  > {
    return this.#currentSlot().session.verifyUnknownResolution(unknownId);
  }

  #createSlot(): TargetSlot {
    const session = new BinarySession(this.#router, this.#records);
    const slot: TargetSlot = { id: randomUUID(), session };
    session.onAvailabilityChanged(() => this.#emitAvailabilityChanged());
    session.onAnalysisSnapshotChanged(() => this.#emitSnapshotChanged());
    return slot;
  }

  /**
   * Drop one slot from the registry.
   *
   * `fallback` names the target a call without an explicit handle addresses
   * once the removed slot was current. `primary` is the fallback for a slot
   * that never became usable, so the server keeps addressing the slot every
   * request addresses by default. `first-open` is the fallback for a slot that
   * was closed, so the server keeps addressing a slot that still holds an open
   * target. Only a successful close or a failed open removes a slot; a failed
   * close keeps the slot, its registration, and the resource it still owns.
   */
  #removeSlot(slot: TargetSlot, fallback: "primary" | "first-open"): void {
    this.#jobs.get(slot.id)?.controller.abort();
    this.#jobs.delete(slot.id);
    this.#slots.delete(slot.id);
    if (this.#currentId !== slot.id) return;
    this.#currentId =
      fallback === "primary"
        ? this.#primary.id
        : (this.#firstOpenSlot()?.id ?? this.#primary.id);
  }

  #firstOpenSlot(): TargetSlot | undefined {
    return [...this.#slots.values()].find(
      (slot) => this.#targetForSlot(slot) !== undefined,
    );
  }

  #openSlotCount(): number {
    let count = 0;
    for (const slot of this.#slots.values())
      if (this.#targetForSlot(slot) !== undefined) count += 1;
    return count;
  }

  #slotById(targetId: string): TargetSlot | undefined {
    if (this.#primary.id === targetId) return this.#primary;
    return this.#slots.get(targetId);
  }

  #targetForSlot(slot: TargetSlot | undefined): BinaryTarget | undefined {
    if (slot === undefined) return undefined;
    return slot.session.activeTarget() ?? this.#jobs.get(slot.id)?.target;
  }

  #jobForSlot(slot: TargetSlot): AnalysisJob | undefined {
    return this.#jobs.get(slot.id);
  }

  /**
   * The job that binds a slot, or undefined when the slot may open again.
   *
   * A job that failed or was cancelled left the slot with no target, so the
   * next open must be able to try again instead of replaying the stale
   * failure. A job that is still starting, or that reached `ready`, keeps the
   * slot bound to it: the target really is open, and reopening it returns the
   * same handle.
   */
  #blockingJob(slot: TargetSlot): AnalysisJob | undefined {
    const job = this.#jobs.get(slot.id);
    if (job === undefined) return undefined;
    if (job.state === "failed" || job.state === "cancelled") {
      this.#jobs.delete(slot.id);
      return undefined;
    }
    return job;
  }

  #cancelJob(slot: TargetSlot): void {
    const job = this.#jobs.get(slot.id);
    if (job === undefined) return;
    job.controller.abort();
    this.#jobs.delete(slot.id);
  }

  async #waitForAnalysis(
    slot: TargetSlot,
    operation: string,
    options: Pick<ExecutionOptions, "signal" | "waitMs"> | undefined,
  ): Promise<Result<undefined, AnalysisError>> {
    const job = this.#jobForSlot(slot);
    if (job === undefined || job.state === "ready") return ok(undefined);
    if (job.state === "failed")
      return err(job.error ?? new AnalysisCancelledError(operation));
    if (job.state === "cancelled")
      return err(new AnalysisCancelledError(operation));
    if (isAborted(options?.signal))
      return err(new AnalysisCancelledError(operation));
    // The wait budget belongs to the tool that declares it. A call that
    // declares no budget waits for nothing; a call that declares one passes
    // its own budget. A budget that is not a finite number is not a budget; it
    // falls back to no wait.
    const requested = options?.waitMs ?? 0;
    const waitMs = Number.isFinite(requested)
      ? Math.min(MAX_WAIT_MS, Math.max(0, requested))
      : 0;
    if (waitMs === 0)
      return err(
        new AnalysisInProgressError(
          operation,
          slot.id,
          this.#jobElapsedMs(job),
        ),
      );
    const outcome = await new Promise<
      "ready" | "failed" | "aborted" | "timeout"
    >((resolve) => {
      let settled = false;
      const finish = (
        value: "ready" | "failed" | "aborted" | "timeout",
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => finish("timeout"), waitMs);
      timer.unref?.();
      const onAbort = (): void => finish("aborted");
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      void job.promise.then(() =>
        finish(job.state === "ready" ? "ready" : "failed"),
      );
    });
    if (outcome === "ready") return ok(undefined);
    if (outcome === "aborted")
      return err(new AnalysisCancelledError(operation));
    if (outcome === "failed")
      return err(job.error ?? new AnalysisCancelledError(operation));
    return err(
      new AnalysisInProgressError(operation, slot.id, this.#jobElapsedMs(job)),
    );
  }

  #slotForPath(path: string): TargetSlot | undefined {
    return [...this.#slots.values()].find((slot) => {
      const target = this.#targetForSlot(slot);
      return target?.path === path || target?.sourcePath === path;
    });
  }

  /** The slot a call without an explicit target handle addresses. */
  #currentSlot(): TargetSlot {
    return this.#slotById(this.#currentId) ?? this.#primary;
  }

  #resolveSlot(
    targetId: string | undefined,
    operation: string,
  ): Result<TargetSlot, AnalysisError> {
    if (targetId === undefined)
      return ok(this.#slotById(this.#currentId) ?? this.#primary);
    const slot = this.#slotById(targetId);
    if (slot !== undefined && this.#targetForSlot(slot) !== undefined)
      return ok(slot);
    return err(
      new AnalysisTargetNotOpenError(
        operation,
        targetId,
        [...this.#slots.values()]
          .filter((candidate) => this.#targetForSlot(candidate) !== undefined)
          .map(({ id }) => id),
      ),
    );
  }

  #resolveSlotResult(
    targetId: string | undefined,
  ): Result<TargetSlot, AnalysisError> {
    return this.#resolveSlot(targetId, "target lookup");
  }

  /**
   * Resolve the slot a close addresses.
   *
   * A slot whose close failed keeps its registration and the resource it
   * still owns, so a later close can retry that cleanup even though the
   * target itself is already closed.
   */
  #resolveCloseSlot(
    targetId: string | undefined,
  ): Result<TargetSlot, AnalysisError> {
    if (targetId === undefined)
      return ok(this.#slotById(this.#currentId) ?? this.#primary);
    const slot = this.#slotById(targetId);
    if (slot !== undefined && this.#slots.has(slot.id)) return ok(slot);
    return err(
      new AnalysisTargetNotOpenError(
        "close_binary",
        targetId,
        [...this.#slots.values()]
          .filter((candidate) => this.#targetForSlot(candidate) !== undefined)
          .map(({ id }) => id),
      ),
    );
  }

  #checkOpenCapacity(
    operation: string,
  ): Result<never, AnalysisError> | undefined {
    if (this.#openSlotCount() < this.#limits.maxOpenTargets) return undefined;
    return err(
      new AnalysisResourceConstraintError(
        operation,
        "capacity",
        `Opening another target would exceed REA_MAX_OPEN_TARGETS=${this.#limits.maxOpenTargets}. Close an open target or raise the limit.`,
        { max_open_targets: this.#limits.maxOpenTargets },
        {
          remediationAction:
            "Close an open target with close_binary or raise REA_MAX_OPEN_TARGETS.",
        },
      ),
    );
  }

  async #closeSlotsExcept(
    keep: TargetSlot,
  ): Promise<Result<null, AnalysisError>> {
    for (const slot of [...this.#slots.values()]) {
      if (slot === keep) continue;
      const closed = await this.#closeSlot(
        slot,
        {},
        {
          clearRecords: false,
          closeOwnedProviderResources: false,
        },
      );
      if (!closed.ok) {
        // The slot keeps its registration and its retained resource, and its
        // handle stays reported so a later close can retry the cleanup. It is
        // no longer an open target.
        this.#retainedSlots.add(slot.id);
        this.#jobs.delete(slot.id);
        return closed;
      }
      this.#retainedSlots.delete(slot.id);
      this.#removeSlot(slot, "first-open");
    }
    return ok(null);
  }

  async #acquireStartPermit(
    operation: string,
    signal: AbortSignal | undefined,
  ): Promise<Result<undefined, AnalysisError>> {
    if (signal?.aborted === true)
      return err(new AnalysisCancelledError(operation));
    if (this.#activeStarts < this.#limits.maxConcurrentAnalyses) {
      this.#activeStarts += 1;
      return ok(undefined);
    }
    return new Promise((resolve) => {
      const grant = (): void => {
        this.#activeStarts += 1;
        resolve(ok(undefined));
      };
      if (signal === undefined) {
        this.#startQueue.push(grant);
        return;
      }
      const queued = (): void => {
        const index = this.#startQueue.indexOf(onGrant);
        if (index >= 0) this.#startQueue.splice(index, 1);
        resolve(err(new AnalysisCancelledError(operation)));
      };
      const onGrant = (): void => {
        signal.removeEventListener("abort", queued);
        grant();
      };
      signal.addEventListener("abort", queued, { once: true });
      this.#startQueue.push(onGrant);
    });
  }

  #releaseStartPermit(): void {
    this.#activeStarts = Math.max(0, this.#activeStarts - 1);
    const next = this.#startQueue.shift();
    next?.();
  }

  #emitAvailabilityChanged(): void {
    for (const listener of this.#availabilityListeners) {
      try {
        const notification = listener();
        if (notification !== undefined)
          void notification.catch(() => undefined);
      } catch (cause: unknown) {
        void cause;
      }
    }
  }

  #emitSnapshotChanged(): void {
    for (const listener of this.#snapshotListeners) {
      try {
        const notification = listener();
        if (notification !== undefined)
          void notification.catch(() => undefined);
      } catch (cause: unknown) {
        void cause;
      }
    }
  }
}

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;
