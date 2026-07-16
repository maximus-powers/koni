import type { AgentLaunchSpec } from "./launch-spec.js";
import {
  ManagedPiSession,
  type ManagedPiSessionFactory,
  type ManagedPiSessionFactoryOptions,
  type ManagedSessionEvent,
  type ManagedSessionOutcome,
} from "./managed-session.js";

export interface ManagedSessionHandle {
  session: ManagedPiSession;
  outcome: Promise<ManagedSessionOutcome>;
}

export interface SupervisorEvent {
  runId: string;
  ticketId: string;
  stepId: string;
  attemptId: string;
  sessionId: string;
  event: ManagedSessionEvent;
}

export class SessionSupervisorError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "SessionSupervisorError";
    this.code = code;
  }
}

/**
 * Process-local owner for compiler-authorized Pi attempts. The authority service remains the
 * durable scheduler; this supervisor makes launch/abort/deletion races fail closed.
 */
export class ManagedSessionSupervisor {
  readonly #sessions = new Map<string, ManagedSessionHandle>();
  readonly #pending = new Map<string, {
    runId: string;
    specHash: string;
    epoch: number;
    promise: Promise<ManagedSessionHandle>;
  }>();
  readonly #runEpochs = new Map<string, number>();
  readonly #suspendedRuns = new Set<string>();
  readonly #deletedRuns = new Set<string>();
  readonly #deletions = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(event: SupervisorEvent) => void>();

  public subscribe(listener: (event: SupervisorEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public launch(
    spec: AgentLaunchSpec,
    options: ManagedPiSessionFactoryOptions & { factory?: ManagedPiSessionFactory },
  ): Promise<ManagedSessionHandle> {
    const { runId, attemptId } = spec.identity;
    this.#assertRunMayLaunch(runId);
    const existing = this.#sessions.get(attemptId);
    if (existing !== undefined) {
      if (existing.session.spec.specHash !== spec.specHash) {
        return Promise.reject(new SessionSupervisorError("attempt_reuse", `attempt ${attemptId} was rebound to different bytes`));
      }
      return Promise.resolve(existing);
    }
    const pending = this.#pending.get(attemptId);
    if (pending !== undefined) {
      if (pending.specHash !== spec.specHash || pending.runId !== runId) {
        return Promise.reject(new SessionSupervisorError("attempt_reuse", `pending attempt ${attemptId} was rebound`));
      }
      return pending.promise;
    }

    const epoch = this.#runEpoch(runId);
    const promise = this.#createAndStart(spec, options, epoch);
    this.#pending.set(attemptId, { runId, specHash: spec.specHash, epoch, promise });
    void promise.finally(() => {
      if (this.#pending.get(attemptId)?.promise === promise) {
        this.#pending.delete(attemptId);
      }
    }).catch(() => undefined);
    return promise;
  }

  public get(attemptId: string): ManagedSessionHandle | undefined {
    return this.#sessions.get(attemptId);
  }

  public list(runId?: string): readonly ManagedSessionHandle[] {
    const sessions = [...this.#sessions.values()];
    return runId === undefined
      ? sessions
      : sessions.filter((entry) => entry.session.spec.identity.runId === runId);
  }

  public async steer(attemptId: string, text: string): Promise<void> {
    const session = this.#requiredLiveAttempt(attemptId);
    await session.steer(text);
  }

  public async followUp(attemptId: string, text: string): Promise<void> {
    const session = this.#requiredLiveAttempt(attemptId);
    await session.followUp(text);
  }

  /** Pause admission and idempotently abort every in-flight or currently creating attempt. */
  public async abortByRun(runId: string, reason = "run paused"): Promise<void> {
    if (this.#deletedRuns.has(runId)) {
      return this.#deletions.get(runId) ?? Promise.resolve();
    }
    this.#suspendedRuns.add(runId);
    this.#bumpRunEpoch(runId);
    await this.#abortRunSessions(runId, reason, false);
  }

  /** Resume admission. Aborted attempts remain terminal and require new immutable attempt IDs. */
  public resumeRun(runId: string): void {
    if (this.#deletedRuns.has(runId)) {
      throw new SessionSupervisorError("run_deleted", `run ${runId} has been deleted`);
    }
    this.#suspendedRuns.delete(runId);
  }

  /**
   * Install the deletion tombstone synchronously, then abort and dispose every associated session.
   * Concurrent factory completions observe the changed epoch and are aborted before their prompt.
   */
  public deleteRun(runId: string): Promise<void> {
    const existing = this.#deletions.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    this.#deletedRuns.add(runId);
    this.#suspendedRuns.add(runId);
    this.#bumpRunEpoch(runId);
    const deletion = this.#abortRunSessions(runId, "run deleted", true);
    this.#deletions.set(runId, deletion);
    return deletion;
  }

  public isDeleted(runId: string): boolean {
    return this.#deletedRuns.has(runId);
  }

  public async dispose(): Promise<void> {
    const runIds = new Set<string>();
    for (const entry of this.#sessions.values()) {
      runIds.add(entry.session.spec.identity.runId);
    }
    for (const pending of this.#pending.values()) {
      runIds.add(pending.runId);
    }
    await Promise.all([...runIds].map((runId) => this.abortByRun(runId, "supervisor disposed")));
    await Promise.all([...this.#sessions.values()].map(async (entry) => entry.session.dispose()));
    this.#sessions.clear();
    this.#listeners.clear();
  }

  async #createAndStart(
    spec: AgentLaunchSpec,
    options: ManagedPiSessionFactoryOptions & { factory?: ManagedPiSessionFactory },
    launchEpoch: number,
  ): Promise<ManagedSessionHandle> {
    const session = await ManagedPiSession.create(spec, options);
    const { runId, attemptId } = spec.identity;
    if (
      this.#deletedRuns.has(runId) ||
      this.#suspendedRuns.has(runId) ||
      this.#runEpoch(runId) !== launchEpoch
    ) {
      await session.abort(this.#deletedRuns.has(runId) ? "run deleted" : "run launch revoked");
      await session.dispose();
      throw new SessionSupervisorError(
        this.#deletedRuns.has(runId) ? "run_deleted" : "launch_revoked",
        `run ${runId} stopped admitting attempts while ${attemptId} was being created`,
      );
    }
    if (this.#sessions.has(attemptId)) {
      await session.dispose();
      return this.#sessions.get(attemptId)!;
    }
    session.subscribe((event) => this.#emit(session, event));
    const handle: ManagedSessionHandle = { session, outcome: session.start() };
    this.#sessions.set(attemptId, handle);
    return handle;
  }

  async #abortRunSessions(runId: string, reason: string, dispose: boolean): Promise<void> {
    const pending = [...this.#pending.values()]
      .filter((entry) => entry.runId === runId)
      .map((entry) => entry.promise.catch(() => undefined));
    if (pending.length > 0) {
      await Promise.all(pending);
    }
    const entries = [...this.#sessions.entries()]
      .filter(([, entry]) => entry.session.spec.identity.runId === runId);
    await Promise.all(entries.map(async ([attemptId, entry]) => {
      await entry.session.abort(reason);
      if (dispose) {
        await entry.session.dispose();
        this.#sessions.delete(attemptId);
      }
    }));
  }

  #requiredLiveAttempt(attemptId: string): ManagedPiSession {
    const entry = this.#sessions.get(attemptId);
    if (entry === undefined) {
      throw new SessionSupervisorError("attempt_missing", `attempt ${attemptId} is not supervised`);
    }
    const runId = entry.session.spec.identity.runId;
    if (this.#deletedRuns.has(runId)) {
      throw new SessionSupervisorError("run_deleted", `run ${runId} has been deleted`);
    }
    if (this.#suspendedRuns.has(runId)) {
      throw new SessionSupervisorError("run_suspended", `run ${runId} is paused`);
    }
    return entry.session;
  }

  #assertRunMayLaunch(runId: string): void {
    if (this.#deletedRuns.has(runId)) {
      throw new SessionSupervisorError("run_deleted", `run ${runId} has been deleted`);
    }
    if (this.#suspendedRuns.has(runId)) {
      throw new SessionSupervisorError("run_suspended", `run ${runId} is paused`);
    }
  }

  #emit(session: ManagedPiSession, event: ManagedSessionEvent): void {
    const identity = session.spec.identity;
    const envelope: SupervisorEvent = { ...identity, event };
    for (const listener of this.#listeners) {
      listener(envelope);
    }
  }

  #runEpoch(runId: string): number {
    return this.#runEpochs.get(runId) ?? 0;
  }

  #bumpRunEpoch(runId: string): void {
    this.#runEpochs.set(runId, this.#runEpoch(runId) + 1);
  }
}
