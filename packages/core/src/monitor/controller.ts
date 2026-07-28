import type { RpcEvent } from "../authority/protocol.js";
import {
  MonitorDecisionClient,
  MonitorDecisionConflictError,
  type MonitorAuthorityConnection,
  type MonitorReadOnlyConnector,
} from "./client.js";
import {
  parseMonitorAttention,
  parseMonitorEvents,
  parseMonitorSnapshot,
  type MonitorAttention,
  type MonitorEvent,
  type MonitorSnapshot,
} from "./protocol.js";
import { terminalSafeText } from "./terminal.js";

export interface MonitorProjectEligibility {
  trusted: boolean;
  initialized: boolean;
}

export type MonitorConnectionState =
  "disabled" | "stopped" | "connecting" | "connected" | "error" | "suspended";

export interface MonitorNotice {
  kind: "info" | "warning" | "error";
  message: string;
  keys: readonly string[];
}

export interface MonitorControllerSnapshot {
  eligibility: MonitorProjectEligibility;
  connection: MonitorConnectionState;
  monitor: MonitorSnapshot | undefined;
  attentions: Readonly<Record<string, MonitorAttention>>;
  selectedRunId: string | undefined;
  eventCursor: number;
  recentEvents: readonly MonitorEvent[];
  lastError: string | undefined;
  busy: boolean;
}

export interface MonitorClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MonitorControllerOptions {
  eligibility: MonitorProjectEligibility;
  connect: MonitorReadOnlyConnector;
  clock?: MonitorClock;
  heartbeatMs?: number;
  eventDebounceMs?: number;
  reconnectDelaysMs?: readonly number[];
  snapshotLimit?: number;
  idempotencyKey?: (method: string) => string;
  onNotice?: (notice: MonitorNotice) => void;
}

const DEFAULT_RECONNECT_DELAYS = [2_000, 5_000, 15_000, 30_000] as const;
const RECENT_EVENT_LIMIT = 100;

/** Event-driven companion state. It can attach, but it has no authority-start callback. */
export class MonitorController {
  readonly #options: Required<
    Pick<MonitorControllerOptions, "heartbeatMs" | "eventDebounceMs" | "snapshotLimit">
  > &
    MonitorControllerOptions;
  readonly #clock: MonitorClock;
  readonly #listeners = new Set<(snapshot: MonitorControllerSnapshot) => void>();
  readonly #seenAttention = new Set<string>();
  readonly #seenEventNotices = new Set<number>();
  #connection: MonitorAuthorityConnection | undefined;
  #decisionClient: MonitorDecisionClient | undefined;
  #unsubscribeEvents: (() => void) | undefined;
  #heartbeatTimer: unknown;
  #reconnectTimer: unknown;
  #debounceTimer: unknown;
  #connectPromise: Promise<void> | undefined;
  #refreshPromise: Promise<void> | undefined;
  #refreshAgain = false;
  #started = false;
  #disposed = false;
  #suspended = false;
  #initialAttentionPublished = false;
  #reconnectAttempt = 0;
  #state: MonitorControllerSnapshot;

  public constructor(options: MonitorControllerOptions) {
    this.#options = {
      ...options,
      heartbeatMs: positiveInteger(options.heartbeatMs ?? 20_000, "heartbeat"),
      eventDebounceMs: positiveInteger(options.eventDebounceMs ?? 120, "event debounce"),
      snapshotLimit: boundedInteger(options.snapshotLimit ?? 50, 1, 200, "snapshot limit"),
    };
    this.#clock = options.clock ?? nodeClock();
    this.#state = {
      eligibility: { ...options.eligibility },
      connection:
        options.eligibility.trusted && options.eligibility.initialized ? "stopped" : "disabled",
      monitor: undefined,
      attentions: {},
      selectedRunId: undefined,
      eventCursor: 0,
      recentEvents: [],
      lastError: undefined,
      busy: false,
    };
  }

  public get snapshot(): MonitorControllerSnapshot {
    return cloneSnapshot(this.#state);
  }

  public subscribe(listener: (snapshot: MonitorControllerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async start(): Promise<void> {
    if (this.#disposed || this.#started) return;
    this.#started = true;
    if (!this.#state.eligibility.trusted || !this.#state.eligibility.initialized) {
      this.#setState({ connection: "disabled" });
      return;
    }
    await this.#connectReadOnly();
  }

  public suspend(): void {
    if (this.#disposed || this.#suspended) return;
    this.#suspended = true;
    this.#cancelTimers();
    this.#closeConnection();
    this.#setState({ connection: "suspended", busy: false });
  }

  public async resume(): Promise<void> {
    if (this.#disposed || !this.#suspended) return;
    this.#suspended = false;
    if (!this.#state.eligibility.trusted || !this.#state.eligibility.initialized) {
      this.#setState({ connection: "disabled" });
      return;
    }
    this.#setState({ connection: "stopped" });
    await this.#connectReadOnly();
  }

  public selectRun(runId: string): void {
    if (!this.#state.monitor?.runs.some((run) => run.id === runId)) return;
    this.#setState({ selectedRunId: runId });
  }

  public moveSelection(delta: -1 | 1): void {
    const runs = this.#state.monitor?.runs ?? [];
    if (runs.length === 0) return;
    const current = runs.findIndex((run) => run.id === this.#state.selectedRunId);
    const next = (Math.max(0, current) + delta + runs.length) % runs.length;
    this.selectRun(runs[next]!.id);
  }

  public attention(runId: string): MonitorAttention | undefined {
    return this.#state.attentions[runId];
  }

  public async refresh(): Promise<void> {
    if (this.#disposed || this.#suspended || this.#connection === undefined) return;
    if (this.#refreshPromise !== undefined) {
      this.#refreshAgain = true;
      return this.#refreshPromise;
    }
    this.#refreshPromise = this.#refreshLoop();
    try {
      await this.#refreshPromise;
    } finally {
      this.#refreshPromise = undefined;
    }
  }

  public async answerQuestion(input: {
    runId: string;
    questionId: string;
    selectedOptionId?: string;
    notes?: string;
  }): Promise<void> {
    const attention = this.#state.attentions[input.runId];
    const question = attention?.questions.find((candidate) => candidate.id === input.questionId);
    if (question === undefined) throw new Error("this question is no longer pending");
    const client = this.#requiredDecisionClient();
    try {
      await client.answerQuestion({
        runId: input.runId,
        question,
        ...(input.selectedOptionId === undefined
          ? {}
          : { selectedOptionId: input.selectedOptionId }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      });
    } catch (error) {
      if (error instanceof MonitorDecisionConflictError) await this.refresh();
      throw error;
    }
    await this.refresh();
  }

  public async approvePlan(runId: string): Promise<void> {
    if (this.#state.attentions[runId]?.plan === undefined)
      throw new Error("this plan is no longer awaiting approval");
    try {
      await this.#requiredDecisionClient().approvePlan({ runId });
    } catch (error) {
      if (error instanceof MonitorDecisionConflictError) await this.refresh();
      throw error;
    }
    await this.refresh();
  }

  public async revisePlan(runId: string, instructions: string): Promise<void> {
    if (this.#state.attentions[runId]?.plan === undefined)
      throw new Error("this plan is no longer awaiting approval");
    try {
      await this.#requiredDecisionClient().revisePlan({ runId, instructions });
    } catch (error) {
      if (error instanceof MonitorDecisionConflictError) await this.refresh();
      throw error;
    }
    await this.refresh();
  }

  public async decideProposal(input: {
    runId: string;
    ticketId: string;
    decision: "approval" | "rejection";
    message?: string;
  }): Promise<void> {
    const proposal = this.#state.attentions[input.runId]?.proposals.find(
      (candidate) => candidate.ticketId === input.ticketId,
    );
    if (proposal === undefined)
      throw new Error("this change proposal is no longer awaiting a decision");
    try {
      await this.#requiredDecisionClient().decideProposal({
        runId: input.runId,
        proposal,
        decision: input.decision,
        ...(input.message === undefined ? {} : { message: input.message }),
      });
    } catch (error) {
      if (error instanceof MonitorDecisionConflictError) await this.refresh();
      throw error;
    }
    await this.refresh();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelTimers();
    this.#closeConnection();
    this.#listeners.clear();
  }

  async #connectReadOnly(): Promise<void> {
    if (this.#disposed || this.#suspended || this.#connection !== undefined) return;
    if (this.#connectPromise !== undefined) return this.#connectPromise;
    this.#setState({ connection: "connecting", lastError: undefined });
    this.#connectPromise = (async () => {
      try {
        const connection = await this.#options.connect();
        if (this.#disposed || this.#suspended) {
          connection?.close();
          return;
        }
        if (connection === undefined) {
          this.#setState({ connection: "stopped", busy: false });
          this.#scheduleReconnect();
          return;
        }
        this.#connection = connection;
        this.#decisionClient = new MonitorDecisionClient(connection, this.#options.idempotencyKey);
        this.#unsubscribeEvents = connection.onEvent((event) => this.#onAuthorityEvent(event));
        this.#reconnectAttempt = 0;
        this.#setState({ connection: "connected", lastError: undefined });
        await this.refresh();
        this.#scheduleHeartbeat();
      } catch (error) {
        if (this.#disposed || this.#suspended) return;
        this.#closeConnection();
        this.#setState({
          connection: "error",
          lastError: terminalSafeText(error instanceof Error ? error.message : String(error), {
            maxCodePoints: 256,
          }),
          busy: false,
        });
        this.#scheduleReconnect();
      }
    })();
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = undefined;
    }
  }

  async #refreshLoop(): Promise<void> {
    this.#setState({ busy: true });
    try {
      do {
        this.#refreshAgain = false;
        await this.#performRefresh();
      } while (
        this.#refreshAgain &&
        !this.#disposed &&
        !this.#suspended &&
        this.#connection !== undefined
      );
    } catch (error) {
      if (!this.#disposed && !this.#suspended) {
        this.#closeConnection();
        this.#setState({
          connection: "error",
          lastError: terminalSafeText(error instanceof Error ? error.message : String(error), {
            maxCodePoints: 256,
          }),
        });
        this.#scheduleReconnect();
      }
    } finally {
      if (!this.#disposed) this.#setState({ busy: false });
    }
  }

  async #performRefresh(): Promise<void> {
    const connection = this.#connection;
    if (connection === undefined) return;
    if (this.#state.monitor !== undefined) {
      const eventResponse = await connection.request("monitor.events", {
        after: this.#state.eventCursor,
        limit: 200,
      });
      const events = parseMonitorEvents(eventResponse.result);
      if (events.fromCursor !== this.#state.eventCursor)
        throw new Error("authority returned an unexpected event cursor");
      this.#consumeEvents(events.events);
      this.#setState({ eventCursor: events.nextCursor });
      if (events.truncated) this.#refreshAgain = true;
    }
    const snapshotResponse = await connection.request("monitor.snapshot", {
      limit: this.#options.snapshotLimit,
    });
    const monitor = parseMonitorSnapshot(snapshotResponse.result);
    const initial = this.#state.monitor === undefined;
    if (initial) this.#setState({ eventCursor: monitor.eventCursor });
    const selectedRunId = monitor.runs.some((run) => run.id === this.#state.selectedRunId)
      ? this.#state.selectedRunId
      : monitor.runs[0]?.id;
    const attentions: Record<string, MonitorAttention> = {};
    for (const run of monitor.runs) {
      if (run.questionCount === 0 && run.proposalCount === 0 && !run.planApproval) continue;
      const response = await connection.request("monitor.attention", { runId: run.id });
      const attention = parseMonitorAttention(response.result);
      if (attention.runId !== run.id || attention.runRevision < run.runRevision) {
        throw new Error("authority returned stale attention or attention for the wrong run");
      }
      if (attention.runRevision > run.runRevision) this.#refreshAgain = true;
      attentions[run.id] = attention;
    }
    this.#setState({ monitor, attentions, selectedRunId });
    this.#publishAttentionNotices(attentions, monitor, initial);
  }

  #consumeEvents(events: readonly MonitorEvent[]): void {
    if (events.length === 0) return;
    const recentEvents = [...this.#state.recentEvents, ...events].slice(-RECENT_EVENT_LIMIT);
    this.#setState({ recentEvents });
    for (const event of events) {
      if (this.#seenEventNotices.has(event.sequence)) continue;
      rememberBounded(this.#seenEventNotices, event.sequence, 2_048);
      const stateKey = eventStateAttentionKey(event);
      if (stateKey !== undefined) {
        if (this.#seenAttention.has(stateKey)) continue;
        rememberBounded(this.#seenAttention, stateKey, 4_096);
      }
      const notice = eventNotice(event);
      if (notice !== undefined) this.#options.onNotice?.(notice);
    }
  }

  #publishAttentionNotices(
    attentions: Readonly<Record<string, MonitorAttention>>,
    monitor: MonitorSnapshot,
    initial: boolean,
  ): void {
    const fresh: string[] = [];
    let questions = 0;
    let plans = 0;
    let proposals = 0;
    let blockers = 0;
    let failures = 0;
    let mergeReady = 0;
    for (const attention of Object.values(attentions)) {
      for (const question of attention.questions) {
        const key = `question:${attention.runId}:${question.id}`;
        if (!this.#seenAttention.has(key)) {
          rememberBounded(this.#seenAttention, key, 4_096);
          fresh.push(key);
          questions += 1;
        }
      }
      if (attention.plan !== undefined) {
        const key = `plan:${attention.runId}:${attention.plan.revision}`;
        if (!this.#seenAttention.has(key)) {
          rememberBounded(this.#seenAttention, key, 4_096);
          fresh.push(key);
          plans += 1;
        }
      }
      for (const proposal of attention.proposals) {
        const key = `proposal:${attention.runId}:${proposal.ticketId}:${proposal.createdAt}`;
        if (!this.#seenAttention.has(key)) {
          rememberBounded(this.#seenAttention, key, 4_096);
          fresh.push(key);
          proposals += 1;
        }
      }
    }
    for (const run of monitor.runs) {
      const states: Array<{ key: string; kind: "blocker" | "failure" | "merge" }> = [
        ...(run.blocker === undefined
          ? []
          : [{ key: `blocked:${run.id}:${run.runRevision}`, kind: "blocker" as const }]),
        ...(run.failure === undefined
          ? []
          : [{ key: `failed:${run.id}:${run.runRevision}`, kind: "failure" as const }]),
        ...(run.mergeReady
          ? [{ key: `merge_ready:${run.id}:${run.runRevision}`, kind: "merge" as const }]
          : []),
      ];
      for (const state of states) {
        if (this.#seenAttention.has(state.key)) continue;
        rememberBounded(this.#seenAttention, state.key, 4_096);
        fresh.push(state.key);
        if (state.kind === "blocker") blockers += 1;
        else if (state.kind === "failure") failures += 1;
        else mergeReady += 1;
      }
    }
    if (fresh.length === 0) return;
    if (initial && !this.#initialAttentionPublished) {
      this.#initialAttentionPublished = true;
      const parts = [
        ...(questions === 0 ? [] : [`${questions} question${questions === 1 ? "" : "s"}`]),
        ...(plans === 0 ? [] : [`${plans} plan${plans === 1 ? "" : "s"}`]),
        ...(proposals === 0 ? [] : [`${proposals} change proposal${proposals === 1 ? "" : "s"}`]),
        ...(blockers === 0 ? [] : [`${blockers} blocker${blockers === 1 ? "" : "s"}`]),
        ...(failures === 0 ? [] : [`${failures} failure${failures === 1 ? "" : "s"}`]),
        ...(mergeReady === 0 ? [] : [`${mergeReady} merge ready`]),
      ];
      const inputOnly = blockers === 0 && failures === 0 && mergeReady === 0;
      this.#options.onNotice?.({
        kind:
          failures > 0
            ? "error"
            : blockers > 0 || questions > 0 || plans > 0 || proposals > 0
              ? "warning"
              : "info",
        message: `Koni needs ${inputOnly ? "input" : "attention"}: ${parts.join(" · ")}`,
        keys: fresh,
      });
      return;
    }
    this.#options.onNotice?.({
      kind:
        failures > 0
          ? "error"
          : blockers > 0 || questions > 0 || plans > 0 || proposals > 0
            ? "warning"
            : "info",
      message:
        failures > 0
          ? "A Koni run failed."
          : blockers > 0
            ? "A Koni run is blocked."
            : mergeReady > 0
              ? "A Koni run is ready to merge."
              : questions > 0
                ? "A Koni run has a question for you."
                : plans > 0
                  ? "A Koni plan is ready for review."
                  : "A Koni change proposal needs your decision.",
      keys: fresh,
    });
  }

  #onAuthorityEvent(event: RpcEvent): void {
    if (this.#disposed || this.#suspended || event.topic === "authority.ready") return;
    if (this.#debounceTimer !== undefined) return;
    this.#debounceTimer = this.#clock.setTimeout(() => {
      this.#debounceTimer = undefined;
      void this.refresh();
    }, this.#options.eventDebounceMs);
  }

  #scheduleHeartbeat(): void {
    if (this.#disposed || this.#suspended || this.#connection === undefined) return;
    if (this.#heartbeatTimer !== undefined) this.#clock.clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = this.#clock.setTimeout(() => {
      this.#heartbeatTimer = undefined;
      void this.refresh().finally(() => this.#scheduleHeartbeat());
    }, this.#options.heartbeatMs);
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#suspended || this.#reconnectTimer !== undefined) return;
    const configured = this.#options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS;
    if (configured.length === 0) return;
    for (const delay of configured) positiveInteger(delay, "reconnect delay");
    const delay = configured[Math.min(this.#reconnectAttempt, configured.length - 1)]!;
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = this.#clock.setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connectReadOnly();
    }, delay);
  }

  #requiredDecisionClient(): MonitorDecisionClient {
    if (this.#decisionClient === undefined) throw new Error("Koni authority is not connected");
    return this.#decisionClient;
  }

  #closeConnection(): void {
    this.#unsubscribeEvents?.();
    this.#unsubscribeEvents = undefined;
    this.#decisionClient = undefined;
    this.#connection?.close();
    this.#connection = undefined;
  }

  #cancelTimers(): void {
    for (const timer of [this.#heartbeatTimer, this.#reconnectTimer, this.#debounceTimer]) {
      if (timer !== undefined) this.#clock.clearTimeout(timer);
    }
    this.#heartbeatTimer = undefined;
    this.#reconnectTimer = undefined;
    this.#debounceTimer = undefined;
  }

  #setState(patch: Partial<MonitorControllerSnapshot>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

function eventNotice(event: MonitorEvent): MonitorNotice | undefined {
  const key = `event:${event.sequence}`;
  switch (event.kind) {
    case "stage_changed":
    case "ticket_completed":
      return { kind: "info", message: event.detail ?? event.title, keys: [key] };
    case "blocked":
      return { kind: "warning", message: event.detail ?? event.title, keys: [key] };
    case "failed":
      return { kind: "error", message: event.detail ?? event.title, keys: [key] };
    case "merge_ready":
      return {
        kind: "info",
        message: event.detail ?? `${event.title} is ready to merge.`,
        keys: [key],
      };
    case "run_created":
    case "question_opened":
    case "question_resolved":
    case "proposal_opened":
    case "proposal_resolved":
    case "plan_ready":
    case "plan_resolved":
    case "run_updated":
      return undefined;
  }
}

function eventStateAttentionKey(event: MonitorEvent): string | undefined {
  if (event.kind === "blocked" || event.kind === "failed" || event.kind === "merge_ready") {
    return `${event.kind}:${event.runId}:${event.runRevision}`;
  }
  return undefined;
}

function rememberBounded<T>(set: Set<T>, value: T, maximum: number): void {
  set.add(value);
  while (set.size > maximum) set.delete(set.values().next().value!);
}

function cloneSnapshot(snapshot: MonitorControllerSnapshot): MonitorControllerSnapshot {
  return {
    ...snapshot,
    eligibility: { ...snapshot.eligibility },
    monitor: snapshot.monitor === undefined ? undefined : structuredClone(snapshot.monitor),
    attentions: structuredClone(snapshot.attentions),
    recentEvents: structuredClone(snapshot.recentEvents),
  };
}

function nodeClock(): MonitorClock {
  return {
    now: Date.now,
    setTimeout(callback, delayMs) {
      const handle = setTimeout(callback, delayMs);
      handle.unref();
      return handle;
    },
    clearTimeout(handle) {
      clearTimeout(handle as NodeJS.Timeout);
    },
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
