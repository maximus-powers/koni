export type RunPhase =
  | "draft"
  | "planning"
  | "awaiting_questions"
  | "awaiting_approval"
  | "executing"
  | "pausing"
  | "paused"
  | "verifying"
  | "merge_ready"
  | "merging"
  | "blocked"
  | "completed"
  | "failed"
  | "deleting"
  | "deleted";

export type ResumableRunPhase = Exclude<
  RunPhase,
  "pausing" | "paused" | "deleting" | "deleted"
>;

export interface PendingQuestion {
  id: string;
  attemptId: string;
  askedAtMs: number;
  answeredAtMs: number | undefined;
  answer: string | undefined;
  notes: string | undefined;
}

export interface RunLifecycleState {
  protocol: "koni.run-lifecycle.v1";
  runId: string;
  revision: number;
  generation: number;
  phase: RunPhase;
  resumePhase: ResumableRunPhase | undefined;
  runningIntent: boolean;
  planRevision: number;
  approvedAtMs: number | undefined;
  activeSinceMs: number | undefined;
  accumulatedActiveMs: number;
  pendingQuestions: PendingQuestion[];
  blocker: string | undefined;
  terminalReason: string | undefined;
}

export type RunLifecycleEvent =
  | { type: "planning_started"; atMs: number }
  | {
      type: "question_opened";
      atMs: number;
      question: Pick<PendingQuestion, "id" | "attemptId">;
    }
  | { type: "question_answered"; atMs: number; questionId: string; answer: string; notes?: string }
  | { type: "plan_submitted"; atMs: number }
  | { type: "plan_revision_requested"; atMs: number }
  | { type: "plan_approved"; atMs: number }
  | { type: "execution_started"; atMs: number }
  | { type: "verification_started"; atMs: number }
  | { type: "verification_passed"; atMs: number }
  | { type: "merge_started"; atMs: number }
  | { type: "merge_completed"; atMs: number }
  | { type: "pause_requested"; atMs: number }
  | { type: "pause_settled"; atMs: number }
  | { type: "resume_requested"; atMs: number }
  | { type: "blocked"; atMs: number; reason: string }
  | { type: "retry_requested"; atMs: number; phase: ResumableRunPhase }
  | { type: "failed"; atMs: number; reason: string }
  | { type: "delete_requested"; atMs: number }
  | { type: "delete_settled"; atMs: number };

export type LifecycleEffect =
  | { type: "launch_planner"; planRevision: number }
  | { type: "deliver_answer"; questionId: string; attemptId: string }
  | { type: "request_plan_revision"; planRevision: number }
  | { type: "admit_ready_work" }
  | { type: "start_verification" }
  | { type: "stop_admission" }
  | { type: "drain_sessions" }
  | { type: "abort_sessions"; generation: number }
  | { type: "publish_merge" }
  | { type: "cleanup_run"; generation: number };

export interface LifecycleReduction {
  state: RunLifecycleState;
  effects: LifecycleEffect[];
}

export class InvalidRunTransitionError extends Error {
  public constructor(phase: RunPhase, event: RunLifecycleEvent["type"]) {
    super(`cannot apply ${event} while run is ${phase}`);
    this.name = "InvalidRunTransitionError";
  }
}

export function newRunLifecycle(runId: string): RunLifecycleState {
  if (runId.trim().length === 0) {
    throw new Error("run id must not be empty");
  }
  return {
    protocol: "koni.run-lifecycle.v1",
    runId,
    revision: 0,
    generation: 0,
    phase: "draft",
    resumePhase: undefined,
    runningIntent: false,
    planRevision: 0,
    approvedAtMs: undefined,
    activeSinceMs: undefined,
    accumulatedActiveMs: 0,
    pendingQuestions: [],
    blocker: undefined,
    terminalReason: undefined,
  };
}

export function reduceRunLifecycle(
  current: RunLifecycleState,
  event: RunLifecycleEvent,
): LifecycleReduction {
  ensureTimestamp(event.atMs);
  if (current.phase === "deleted") {
    throw new InvalidRunTransitionError(current.phase, event.type);
  }

  const state = structuredClone(current);
  const effects: LifecycleEffect[] = [];
  state.revision += 1;

  switch (event.type) {
    case "planning_started":
      requirePhase(current, event, ["draft", "blocked"]);
      state.phase = "planning";
      state.runningIntent = true;
      state.blocker = undefined;
      state.activeSinceMs = event.atMs;
      state.planRevision += 1;
      effects.push({ type: "launch_planner", planRevision: state.planRevision });
      break;
    case "question_opened":
      requirePhase(current, event, ["planning", "executing", "verifying"]);
      if (state.pendingQuestions.some((question) => question.id === event.question.id)) {
        throw new Error(`question already exists: ${event.question.id}`);
      }
      state.resumePhase = current.phase as ResumableRunPhase;
      state.phase = "awaiting_questions";
      closeActiveInterval(state, event.atMs);
      state.pendingQuestions.push({
        ...event.question,
        askedAtMs: event.atMs,
        answeredAtMs: undefined,
        answer: undefined,
        notes: undefined,
      });
      break;
    case "question_answered": {
      requirePhase(current, event, ["awaiting_questions"]);
      const question = state.pendingQuestions.find((item) => item.id === event.questionId);
      if (question === undefined) {
        throw new Error(`unknown pending question: ${event.questionId}`);
      }
      if (question.answeredAtMs !== undefined) {
        throw new Error(`question already answered: ${event.questionId}`);
      }
      question.answer = event.answer;
      question.notes = event.notes;
      question.answeredAtMs = event.atMs;
      effects.push({
        type: "deliver_answer",
        questionId: question.id,
        attemptId: question.attemptId,
      });
      if (state.pendingQuestions.every((item) => item.answeredAtMs !== undefined)) {
        state.phase = state.resumePhase ?? "planning";
        state.resumePhase = undefined;
        if (state.runningIntent) {
          state.activeSinceMs = event.atMs;
        }
      }
      break;
    }
    case "plan_submitted":
      requirePhase(current, event, ["planning"]);
      state.phase = "awaiting_approval";
      closeActiveInterval(state, event.atMs);
      break;
    case "plan_revision_requested":
      requirePhase(current, event, ["awaiting_approval"]);
      state.phase = "planning";
      state.planRevision += 1;
      state.activeSinceMs = event.atMs;
      effects.push({ type: "request_plan_revision", planRevision: state.planRevision });
      break;
    case "plan_approved":
      requirePhase(current, event, ["awaiting_approval"]);
      state.phase = "executing";
      state.approvedAtMs ??= event.atMs;
      state.activeSinceMs = event.atMs;
      effects.push({ type: "admit_ready_work" });
      break;
    case "execution_started":
      requirePhase(current, event, ["executing"]);
      effects.push({ type: "admit_ready_work" });
      break;
    case "verification_started":
      requirePhase(current, event, ["executing"]);
      state.phase = "verifying";
      effects.push({ type: "start_verification" });
      break;
    case "verification_passed":
      requirePhase(current, event, ["verifying"]);
      state.phase = "merge_ready";
      closeActiveInterval(state, event.atMs);
      break;
    case "merge_started":
      requirePhase(current, event, ["merge_ready"]);
      state.phase = "merging";
      state.activeSinceMs = event.atMs;
      effects.push({ type: "publish_merge" });
      break;
    case "merge_completed":
      requirePhase(current, event, ["merging"]);
      state.phase = "completed";
      state.runningIntent = false;
      closeActiveInterval(state, event.atMs);
      break;
    case "pause_requested":
      requirePhase(current, event, ["planning", "executing", "verifying"]);
      state.resumePhase = current.phase as ResumableRunPhase;
      state.phase = "pausing";
      state.runningIntent = false;
      closeActiveInterval(state, event.atMs);
      effects.push({ type: "stop_admission" }, { type: "drain_sessions" });
      break;
    case "pause_settled":
      requirePhase(current, event, ["pausing"]);
      state.phase = "paused";
      break;
    case "resume_requested":
      requirePhase(current, event, ["paused"]);
      state.phase = state.resumePhase ?? "executing";
      state.resumePhase = undefined;
      state.runningIntent = true;
      state.activeSinceMs = event.atMs;
      effects.push(
        state.phase === "planning"
          ? { type: "launch_planner", planRevision: state.planRevision }
          : { type: "admit_ready_work" },
      );
      break;
    case "blocked":
      requirePhase(current, event, [
        "planning",
        "awaiting_approval",
        "executing",
        "verifying",
        "merging",
      ]);
      state.resumePhase = current.phase as ResumableRunPhase;
      state.phase = "blocked";
      state.blocker = event.reason;
      state.runningIntent = false;
      closeActiveInterval(state, event.atMs);
      effects.push({ type: "stop_admission" });
      break;
    case "retry_requested":
      requirePhase(current, event, ["blocked"]);
      state.phase = event.phase;
      state.resumePhase = undefined;
      state.blocker = undefined;
      state.runningIntent = true;
      state.activeSinceMs = event.atMs;
      effects.push(
        event.phase === "planning"
          ? { type: "launch_planner", planRevision: state.planRevision }
          : { type: "admit_ready_work" },
      );
      break;
    case "failed":
      state.phase = "failed";
      state.runningIntent = false;
      state.terminalReason = event.reason;
      closeActiveInterval(state, event.atMs);
      effects.push({ type: "stop_admission" }, { type: "abort_sessions", generation: state.generation });
      break;
    case "delete_requested":
      state.generation += 1;
      state.phase = "deleting";
      state.runningIntent = false;
      closeActiveInterval(state, event.atMs);
      effects.push(
        { type: "stop_admission" },
        { type: "abort_sessions", generation: state.generation },
      );
      break;
    case "delete_settled":
      requirePhase(current, event, ["deleting"]);
      state.phase = "deleted";
      effects.push({ type: "cleanup_run", generation: state.generation });
      break;
    default:
      return assertNever(event);
  }
  return { state, effects };
}

export function activeRuntimeMs(state: RunLifecycleState, nowMs: number): number {
  ensureTimestamp(nowMs);
  return (
    state.accumulatedActiveMs +
    (state.activeSinceMs === undefined ? 0 : Math.max(0, nowMs - state.activeSinceMs))
  );
}

function closeActiveInterval(state: RunLifecycleState, atMs: number): void {
  if (state.activeSinceMs !== undefined) {
    state.accumulatedActiveMs += Math.max(0, atMs - state.activeSinceMs);
    state.activeSinceMs = undefined;
  }
}

function requirePhase(
  state: RunLifecycleState,
  event: RunLifecycleEvent,
  allowed: readonly RunPhase[],
): void {
  if (!allowed.includes(state.phase)) {
    throw new InvalidRunTransitionError(state.phase, event.type);
  }
}

function ensureTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("lifecycle timestamp must be a non-negative safe integer");
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled lifecycle event: ${JSON.stringify(value)}`);
}
