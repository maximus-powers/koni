import type { TSchema } from "typebox";
import type { KoniAuthorizedMessage } from "./compaction.js";
import type { AgentLaunchSpec } from "./launch-spec.js";
import type {
  ManagedSessionEvent,
  ManagedSessionOutcome,
  ManagedSessionStatus,
} from "./managed-session.js";
import {
  PiAttemptProcessError,
  SupervisedPiAttemptProcess,
  type PiAttemptProcessAuthority,
  type PiAttemptProcessRuntime,
  type PiAttemptProcessTimings,
} from "./attempt-process-supervisor.js";

export interface PiAttemptProcessLaunchOptions {
  terminalOutputSchema: TSchema;
  authority: PiAttemptProcessAuthority;
  timings?: PiAttemptProcessTimings;
  runtime?: PiAttemptProcessRuntime;
}

export interface PiAttemptProcessSupervisorOptions {
  /** Fail-closed runtime check performed before every new provider-capable process. */
  beforeLaunch?: () => Promise<void>;
  /** Authority-owned defaults that callers cannot replace with ambient process state. */
  runtime?: PiAttemptProcessRuntime;
  /** Require a separate authority activation after the child has authenticated readiness. */
  deferActivationUntilAuthorityCommit?: boolean;
}

export interface PiAttemptProcessSessionView {
  readonly spec: Readonly<AgentLaunchSpec>;
  readonly sessionFile: string;
  readonly status: ManagedSessionStatus;
  activate(): Promise<void>;
  abort(reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiAttemptProcessHandle {
  session: PiAttemptProcessSessionView;
  outcome: Promise<ManagedSessionOutcome>;
}

export type PiAttemptPoolEvent =
  ManagedSessionEvent | { type: "outcome"; outcome: ManagedSessionOutcome };

export interface PiAttemptProcessSupervisorEvent {
  runId: string;
  ticketId: string;
  stepId: string;
  attemptId: string;
  sessionId: string;
  event: PiAttemptPoolEvent;
}

interface PoolEntry {
  process: SupervisedPiAttemptProcess;
  handle: PiAttemptProcessHandle;
  view: MutableSessionView;
  unsubscribe: () => void;
}

interface PendingEntry {
  runId: string;
  specHash: string;
  mode: "fresh" | "recover";
  epoch: number;
  process: SupervisedPiAttemptProcess;
  promise: Promise<PiAttemptProcessHandle>;
}

interface AttemptTombstone {
  runId: string;
  specHash: string;
  mode: "fresh" | "recover";
}

/** Run-level owner for all one-attempt process groups admitted by one authority instance. */
export class PiAttemptProcessSupervisor {
  readonly #options: PiAttemptProcessSupervisorOptions;
  readonly #sessions = new Map<string, PoolEntry>();
  readonly #pending = new Map<string, PendingEntry>();
  readonly #attemptTombstones = new Map<string, AttemptTombstone>();
  readonly #epochs = new Map<string, number>();
  readonly #suspended = new Set<string>();
  readonly #deleted = new Set<string>();
  readonly #deletions = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(event: PiAttemptProcessSupervisorEvent) => void>();
  #allSuspended = false;

  public constructor(options: PiAttemptProcessSupervisorOptions = {}) {
    this.#options = options;
  }

  public subscribe(listener: (event: PiAttemptProcessSupervisorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public launch(
    spec: Readonly<AgentLaunchSpec>,
    options: PiAttemptProcessLaunchOptions,
  ): Promise<PiAttemptProcessHandle> {
    this.#assertMayLaunch(spec.identity.runId);
    return this.#admit(spec, options, "fresh");
  }

  public recover(
    spec: Readonly<AgentLaunchSpec>,
    options: PiAttemptProcessLaunchOptions,
  ): Promise<PiAttemptProcessHandle> {
    this.#assertMayLaunch(spec.identity.runId);
    return this.#admit(spec, options, "recover");
  }

  public get(attemptId: string): PiAttemptProcessHandle | undefined {
    return this.#sessions.get(attemptId)?.handle;
  }

  public list(runId?: string): readonly PiAttemptProcessHandle[] {
    const entries = [...this.#sessions.values()];
    return entries
      .filter((entry) => runId === undefined || entry.process.spec.identity.runId === runId)
      .map((entry) => entry.handle);
  }

  public async steer(attemptId: string, message: KoniAuthorizedMessage): Promise<void> {
    await this.#required(attemptId).process.steer(message);
  }

  public async followUp(attemptId: string, message: KoniAuthorizedMessage): Promise<void> {
    await this.#required(attemptId).process.followUp(message);
  }

  public async abortByRun(runId: string, reason = "run paused"): Promise<void> {
    if (this.#deleted.has(runId)) return this.#deletions.get(runId) ?? Promise.resolve();
    this.#suspended.add(runId);
    this.#bumpEpoch(runId);
    const processes = this.#processesForRun(runId);
    let failure: unknown;
    for (const process of processes) {
      try {
        await process.abort(reason);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  /** Install one synchronous global admission tombstone, then drain only actually live runs. */
  public async suspendAll(reason = "authority quiescing"): Promise<void> {
    this.#allSuspended = true;
    const runIds = new Set<string>();
    for (const entry of this.#sessions.values()) runIds.add(entry.process.spec.identity.runId);
    for (const pending of this.#pending.values()) runIds.add(pending.runId);
    let failure: unknown;
    for (const runId of [...runIds].sort()) {
      try {
        await this.abortByRun(runId, reason);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  public resumeRun(runId: string): void {
    if (this.#deleted.has(runId))
      throw new PiAttemptProcessError("run_deleted", `run ${runId} is deleted`);
    this.#suspended.delete(runId);
  }

  public deleteRun(runId: string): Promise<void> {
    const existing = this.#deletions.get(runId);
    if (existing !== undefined) return existing;
    this.#deleted.add(runId);
    this.#suspended.add(runId);
    this.#bumpEpoch(runId);
    const deletion = this.#deleteRunOnce(runId);
    this.#deletions.set(runId, deletion);
    void deletion.catch(() => {
      if (this.#deletions.get(runId) === deletion) this.#deletions.delete(runId);
    });
    return deletion;
  }

  public isDeleted(runId: string): boolean {
    return this.#deleted.has(runId);
  }

  public async dispose(): Promise<void> {
    const runIds = new Set<string>();
    for (const entry of this.#sessions.values()) runIds.add(entry.process.spec.identity.runId);
    for (const pending of this.#pending.values()) runIds.add(pending.runId);
    let failure: unknown;
    for (const runId of [...runIds].sort()) {
      try {
        await this.deleteRun(runId);
      } catch (error) {
        failure ??= error;
      }
    }
    this.#listeners.clear();
    if (failure !== undefined) throw failure;
  }

  async #admit(
    spec: Readonly<AgentLaunchSpec>,
    options: PiAttemptProcessLaunchOptions,
    mode: "fresh" | "recover",
  ): Promise<PiAttemptProcessHandle> {
    const { runId, attemptId } = spec.identity;
    this.#assertMayLaunch(runId);
    const admitted = this.#existingAdmission(spec, mode);
    if (admitted !== undefined) return admitted;
    await this.#options.beforeLaunch?.();
    this.#assertMayLaunch(runId);
    const admittedAfterGuard = this.#existingAdmission(spec, mode);
    if (admittedAfterGuard !== undefined) return admittedAfterGuard;

    const epoch = this.#epoch(runId);
    const runtime = mergeRuntime(this.#options.runtime, options.runtime);
    const process = new SupervisedPiAttemptProcess(spec, {
      ...options,
      mode,
      // Fail safe: every pool admission is two-phase unless an explicit compatibility/test
      // caller opts out. A forgotten bootstrap option must never start provider work early.
      deferActivation: this.#options.deferActivationUntilAuthorityCommit !== false,
      ...(runtime === undefined ? {} : { runtime }),
    });
    const promise = this.#finishAdmission(process, epoch, mode);
    const pending = { runId, specHash: spec.specHash, mode, epoch, process, promise };
    this.#pending.set(attemptId, pending);
    void promise
      .then(() => {
        // Successful admission transfers cleanup ownership to #sessions. A rejected admission must
        // remain here: it may still be the only handle capable of retrying an unproven retirement.
        if (this.#pending.get(attemptId) === pending) this.#pending.delete(attemptId);
      })
      .catch(() => undefined);
    void promise.catch(() => {
      void process.outcome
        .finally(() => {
          // Terminal publication already proves transport close and process-group absence. Only at
          // that boundary may a never-admitted process release its cleanup handle and become a
          // durable anti-reuse tombstone. Successful admission has its own session finalizer below.
          if (this.#pending.get(attemptId) === pending) this.#pending.delete(attemptId);
          this.#attemptTombstones.set(attemptId, { runId, specHash: spec.specHash, mode });
        })
        .catch(() => undefined);
    });
    return promise;
  }

  #existingAdmission(
    spec: Readonly<AgentLaunchSpec>,
    mode: "fresh" | "recover",
  ): Promise<PiAttemptProcessHandle> | undefined {
    const { runId, attemptId } = spec.identity;
    const existing = this.#sessions.get(attemptId);
    if (existing !== undefined) {
      if (existing.process.spec.specHash !== spec.specHash) {
        throw new PiAttemptProcessError("attempt_reuse", `attempt ${attemptId} was rebound`);
      }
      return Promise.resolve(existing.handle);
    }
    const pending = this.#pending.get(attemptId);
    if (pending !== undefined) {
      if (pending.runId !== runId || pending.specHash !== spec.specHash || pending.mode !== mode) {
        throw new PiAttemptProcessError(
          "attempt_reuse",
          `pending attempt ${attemptId} was rebound`,
        );
      }
      return pending.promise;
    }
    const tombstone = this.#attemptTombstones.get(attemptId);
    if (tombstone !== undefined) {
      if (
        tombstone.runId !== runId ||
        tombstone.specHash !== spec.specHash ||
        tombstone.mode !== mode
      ) {
        throw new PiAttemptProcessError(
          "attempt_reuse",
          `terminal attempt ${attemptId} was rebound`,
        );
      }
      throw new PiAttemptProcessError(
        "attempt_terminal",
        `attempt ${attemptId} already reached a terminal outcome`,
      );
    }
    return undefined;
  }

  async #finishAdmission(
    process: SupervisedPiAttemptProcess,
    epoch: number,
    mode: "fresh" | "recover",
  ): Promise<PiAttemptProcessHandle> {
    const { runId, attemptId } = process.spec.identity;
    const earlyEvents: ManagedSessionEvent[] = [];
    let entry: PoolEntry | undefined;
    const unsubscribe = process.subscribe(({ event }) => {
      if (entry === undefined) {
        earlyEvents.push(structuredClone(event));
        return;
      }
      if (event.type === "status") entry.view.statusValue = event.status;
      this.#emit(process.spec, event);
    });
    try {
      await process.ready;
      if (
        this.#allSuspended ||
        this.#deleted.has(runId) ||
        this.#suspended.has(runId) ||
        this.#epoch(runId) !== epoch
      ) {
        await process.delete(this.#deleted.has(runId) ? "run deleted" : "run launch revoked");
        throw new PiAttemptProcessError(
          this.#deleted.has(runId) ? "run_deleted" : "launch_revoked",
          `run ${runId} stopped admitting ${attemptId}`,
        );
      }
    } catch (error) {
      unsubscribe();
      await process.delete("attempt admission failed").catch(() => undefined);
      throw error;
    }
    const sessionFile = process.sessionFile;
    if (sessionFile === undefined) {
      unsubscribe();
      await process.delete("ready child omitted its session file").catch(() => undefined);
      throw new PiAttemptProcessError("session_file", "ready child omitted its session file");
    }
    const view = new MutableSessionView(process, sessionFile);
    const handle: PiAttemptProcessHandle = { session: view, outcome: process.outcome };
    entry = { process, handle, view, unsubscribe };
    const admittedEntry = entry;
    this.#sessions.set(attemptId, admittedEntry);
    for (const event of earlyEvents) {
      if (event.type === "status") view.statusValue = event.status;
      this.#emit(process.spec, event);
    }
    void process.outcome
      .then((outcome) => {
        view.statusValue =
          outcome.status === "completed"
            ? "completed"
            : outcome.status === "aborted"
              ? "aborted"
              : "failed";
        this.#emit(process.spec, { type: "outcome", outcome: structuredClone(outcome) });
      })
      .finally(() => {
        // Durable run state and Pi JSONL preserve history. The live pool must not retain a process
        // object—and therefore an obsolete numeric PID/PGID capability—after terminal publication.
        if (this.#sessions.get(attemptId) === admittedEntry) {
          admittedEntry.unsubscribe();
          this.#sessions.delete(attemptId);
        }
        this.#attemptTombstones.set(attemptId, { runId, specHash: process.spec.specHash, mode });
      })
      .catch(() => undefined);
    return handle;
  }

  async #deleteRunOnce(runId: string): Promise<void> {
    const processes = this.#processesForRun(runId);
    let failure: unknown;
    const deleted: SupervisedPiAttemptProcess[] = [];
    for (const process of processes) {
      try {
        await process.delete("run deleted");
        deleted.push(process);
      } catch (error) {
        failure ??= error;
      }
    }
    // Successful process deletion resolves `outcome` only after group absence. Its registered
    // finalizer, rather than this control path, owns process-entry eviction and tombstoning. A
    // failed retirement deliberately stays live in the pool for the next exact retry.
    for (const process of deleted) {
      try {
        await process.outcome;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  #processesForRun(runId: string): SupervisedPiAttemptProcess[] {
    const output = new Map<number | string, SupervisedPiAttemptProcess>();
    for (const entry of this.#sessions.values()) {
      if (entry.process.spec.identity.runId === runId)
        output.set(entry.process.pid ?? entry.process.spec.identity.attemptId, entry.process);
    }
    for (const entry of this.#pending.values()) {
      if (entry.runId === runId)
        output.set(entry.process.pid ?? entry.process.spec.identity.attemptId, entry.process);
    }
    return [...output.values()];
  }

  #required(attemptId: string): PoolEntry {
    const entry = this.#sessions.get(attemptId);
    if (entry === undefined)
      throw new PiAttemptProcessError("attempt_missing", `attempt ${attemptId} is not supervised`);
    const runId = entry.process.spec.identity.runId;
    if (this.#allSuspended)
      throw new PiAttemptProcessError("authority_suspended", "authority is quiescing");
    if (this.#deleted.has(runId))
      throw new PiAttemptProcessError("run_deleted", `run ${runId} is deleted`);
    if (this.#suspended.has(runId))
      throw new PiAttemptProcessError("run_suspended", `run ${runId} is paused`);
    return entry;
  }

  #assertMayLaunch(runId: string): void {
    if (this.#allSuspended)
      throw new PiAttemptProcessError("authority_suspended", "authority is quiescing");
    if (this.#deleted.has(runId))
      throw new PiAttemptProcessError("run_deleted", `run ${runId} is deleted`);
    if (this.#suspended.has(runId))
      throw new PiAttemptProcessError("run_suspended", `run ${runId} is paused`);
  }

  #epoch(runId: string): number {
    return this.#epochs.get(runId) ?? 0;
  }

  #bumpEpoch(runId: string): void {
    this.#epochs.set(runId, this.#epoch(runId) + 1);
  }

  #emit(spec: Readonly<AgentLaunchSpec>, event: PiAttemptPoolEvent): void {
    const envelope: PiAttemptProcessSupervisorEvent = { ...spec.identity, event };
    for (const listener of this.#listeners) {
      try {
        listener(envelope);
      } catch {
        // Observers are presentation/audit clients, never lifecycle participants.
      }
    }
  }
}

class MutableSessionView implements PiAttemptProcessSessionView {
  public statusValue: ManagedSessionStatus = "created";

  public constructor(
    readonly process: SupervisedPiAttemptProcess,
    public readonly sessionFile: string,
  ) {}

  public get spec(): Readonly<AgentLaunchSpec> {
    return this.process.spec;
  }

  public get status(): ManagedSessionStatus {
    return this.statusValue;
  }

  public activate(): Promise<void> {
    return this.process.activate();
  }

  public abort(reason?: string): Promise<void> {
    return this.process.abort(reason);
  }

  public dispose(): Promise<void> {
    return this.process.dispose();
  }
}

function mergeRuntime(
  authority: PiAttemptProcessRuntime | undefined,
  attempt: PiAttemptProcessRuntime | undefined,
): PiAttemptProcessRuntime | undefined {
  if (authority === undefined) return attempt;
  if (attempt === undefined) return authority;
  return {
    ...attempt,
    ...authority,
    additionalEnvironment: {
      ...(attempt.additionalEnvironment ?? {}),
      ...(authority.additionalEnvironment ?? {}),
    },
  };
}
