export type RunPhase =
  | "draft"
  | "planning"
  | "awaiting_questions"
  | "awaiting_approval"
  | "approving"
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

export type ResumableRunPhase = Exclude<RunPhase, "pausing" | "paused" | "deleting" | "deleted">;

/**
 * A blocker's prose says what went wrong; this says what clears it. Without the distinction every
 * blocked run renders identically, so an operator has to reverse-engineer the remedy from journals
 * and hashes — and surfaces end up offering retries that cannot possibly succeed.
 */
export type RunBlockerRemedy =
  /** Self-clearing: a tick or reconciliation pass resolves it with no operator action. */
  | "auto"
  /** `run.resume` retries productively, because the failure was transient. */
  | "resume"
  /** Only `koni stop` clears it; resume would replay an unreplayable terminal state forever. */
  | "stop"
  /** Needs a fresh conversational root, because inherited history is the thing that is wrong. */
  | "fresh_epoch"
  /** Unsalvageable under this run's pinned configuration; a new run is the only path. */
  | "new_run"
  /** Needs a human decision or a graph/spec change; no retry of any kind will help. */
  | "change_request";

/**
 * Whether a retry is an honest thing to offer. Records written before typed remedies carry no
 * remedy at all, and those keep today's behaviour rather than losing an affordance retroactively.
 */
export function retryClearsBlocker(remedy: RunBlockerRemedy | undefined): boolean {
  return remedy === undefined || remedy === "auto" || remedy === "resume";
}

/**
 * Derive a blocker's remedy from the failure it records, so a run never advertises `resume` for a
 * condition resume cannot clear. Call sites that know better still pass an explicit remedy; this is
 * the default for the ones that do not, and for paths where a throw escapes past every `catch` that
 * would have classified it. Deriving it centrally rather than at each handler is deliberate: an
 * exhausted reissue budget reached the operator as an untyped blocker precisely because one of the
 * three callers of the assignment-validation settle has no handler of its own, and the unattended
 * operator loop then spent its whole retry budget resuming a run that could not be resumed.
 */
export function classifyBlockerRemedy(reason: string): RunBlockerRemedy {
  // Three fresh attempts already lost to the same rejection, so nothing inside this run's pinned
  // configuration changes the outcome.
  if (/automatic reissue is exhausted/u.test(reason)) return "new_run";
  // Accepted terminal bytes are immutable, so replaying them fails identically every time.
  if (
    /terminal validation replay did not pass|terminal_replay_failed|terminal replay .* has no authenticated retained receipt/u.test(
      reason,
    )
  )
    return "stop";
  return "resume";
}

/** One line naming the action that actually clears a blocker, for operator-facing surfaces. */
export function blockerRemedyGuidance(remedy: RunBlockerRemedy): string {
  switch (remedy) {
    case "auto":
      return "clears itself; authority reconciliation re-drives this run without operator action";
    case "resume":
      return "resume the run to retry from its durable blocked phase";
    case "stop":
      return "stop the run; resume would replay an unreplayable terminal state indefinitely";
    case "fresh_epoch":
      return "needs a fresh conversational root, because inherited history is what is wrong";
    case "new_run":
      return "unsalvageable under this run's pinned configuration; start a new run";
    case "change_request":
      return "needs an operator decision on a change request (`koni decide --run <id> --approve|--reject`) or a graph/spec change; no retry of any kind will clear it";
  }
}

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
  /** Present exactly when `blocker` is; absent on records written before typed remedies. */
  blockerRemedy?: RunBlockerRemedy | undefined;
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
  | { type: "plan_checkpoint_validated"; atMs: number; revision: number }
  | { type: "plan_revision_requested"; atMs: number }
  | { type: "plan_approval_requested"; atMs: number }
  | { type: "plan_approved"; atMs: number }
  | { type: "execution_started"; atMs: number }
  | { type: "verification_started"; atMs: number }
  | { type: "execution_required"; atMs: number }
  | { type: "verification_passed"; atMs: number }
  | { type: "integration_required"; atMs: number; reason: string }
  | { type: "merge_started"; atMs: number }
  | { type: "merge_completed"; atMs: number }
  | { type: "pause_requested"; atMs: number }
  | { type: "pause_settled"; atMs: number }
  | { type: "resume_requested"; atMs: number }
  | { type: "questions_resume_requested"; atMs: number }
  | { type: "blocked"; atMs: number; reason: string; remedy: RunBlockerRemedy }
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
      state.blockerRemedy = undefined;
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
    case "plan_checkpoint_validated":
      requirePhase(current, event, ["planning"]);
      if (!Number.isSafeInteger(event.revision) || event.revision < 0) {
        throw new Error("planning checkpoint revision must be a non-negative safe integer");
      }
      state.phase = "awaiting_approval";
      state.planRevision = event.revision;
      closeActiveInterval(state, event.atMs);
      break;
    case "plan_revision_requested": {
      // A blocked approved plan can be structurally unsound even when compilation succeeded
      // (for example, a runtime-produced receipt modeled as its own prerequisite). Retrying
      // preserves that graph and replays the same blocker, so permit an explicit fresh plan
      // revision from any blocked phase while retaining the prior plan/attempts for audit.
      if (current.phase !== "blocked") requirePhase(current, event, ["awaiting_approval"]);
      state.phase = "planning";
      state.planRevision += 1;
      state.blocker = undefined;
      state.blockerRemedy = undefined;
      state.resumePhase = undefined;
      state.activeSinceMs = event.atMs;
      effects.push({ type: "request_plan_revision", planRevision: state.planRevision });
      break;
    }
    case "plan_approval_requested":
      requirePhase(current, event, ["awaiting_approval"]);
      state.phase = "approving";
      state.runningIntent = true;
      state.blocker = undefined;
      state.blockerRemedy = undefined;
      state.approvedAtMs ??= event.atMs;
      state.accumulatedActiveMs = 0;
      state.activeSinceMs = event.atMs;
      break;
    case "plan_approved":
      requirePhase(current, event, ["approving"]);
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
    case "execution_required":
      requirePhase(current, event, ["verifying", "merge_ready"]);
      state.phase = "executing";
      state.runningIntent = true;
      state.blocker = undefined;
      state.blockerRemedy = undefined;
      if (state.activeSinceMs === undefined) state.activeSinceMs = event.atMs;
      effects.push({ type: "admit_ready_work" });
      break;
    case "verification_passed":
      requirePhase(current, event, ["verifying"]);
      state.phase = "merge_ready";
      closeActiveInterval(state, event.atMs);
      break;
    case "integration_required":
      requirePhase(current, event, ["verifying", "merge_ready", "merging"]);
      state.phase = "executing";
      state.blocker = event.reason;
      state.blockerRemedy = "auto";
      state.runningIntent = true;
      if (state.activeSinceMs === undefined) state.activeSinceMs = event.atMs;
      effects.push({ type: "admit_ready_work" });
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
      requirePhase(current, event, [
        "planning",
        "awaiting_questions",
        "awaiting_approval",
        "approving",
        "executing",
        "verifying",
        "merge_ready",
      ]);
      // awaiting_questions is a presentation/wait boundary layered over the exact stage in
      // resumePhase. Preserve that underlying stage across pause/restart instead of replacing it
      // with awaiting_questions and losing whether planning, execution, or verification owned it.
      state.resumePhase =
        current.phase === "awaiting_questions"
          ? (current.resumePhase ?? "planning")
          : (current.phase as ResumableRunPhase);
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
      state.blocker = undefined;
      state.blockerRemedy = undefined;
      state.runningIntent = true;
      if (new Set<RunPhase>(["planning", "executing", "verifying"]).has(state.phase)) {
        state.activeSinceMs = event.atMs;
      }
      if (state.phase === "planning") {
        effects.push({ type: "launch_planner", planRevision: state.planRevision });
      } else if (state.phase === "executing" || state.phase === "verifying") {
        effects.push({ type: "admit_ready_work" });
      }
      break;
    case "questions_resume_requested":
      requirePhase(current, event, ["paused"]);
      if (!state.pendingQuestions.some((question) => question.answeredAtMs === undefined)) {
        throw new Error("cannot resume the question boundary without an unanswered question");
      }
      state.phase = "awaiting_questions";
      state.runningIntent = true;
      state.activeSinceMs = undefined;
      break;
    case "blocked":
      requirePhase(current, event, [
        "draft",
        "planning",
        "awaiting_approval",
        "approving",
        "executing",
        "verifying",
        "merge_ready",
        "merging",
      ]);
      state.resumePhase = current.phase as ResumableRunPhase;
      state.phase = "blocked";
      state.blocker = event.reason;
      state.blockerRemedy = event.remedy;
      state.runningIntent = false;
      closeActiveInterval(state, event.atMs);
      effects.push({ type: "stop_admission" });
      break;
    case "retry_requested":
      requirePhase(current, event, ["blocked"]);
      state.phase = event.phase;
      state.resumePhase = undefined;
      state.blocker = undefined;
      state.blockerRemedy = undefined;
      state.runningIntent = true;
      state.activeSinceMs = event.atMs;
      effects.push(
        event.phase === "planning"
          ? { type: "launch_planner", planRevision: state.planRevision }
          : event.phase === "executing" || event.phase === "verifying"
            ? { type: "admit_ready_work" }
            : { type: "stop_admission" },
      );
      break;
    case "failed":
      state.phase = "failed";
      state.runningIntent = false;
      state.terminalReason = event.reason;
      closeActiveInterval(state, event.atMs);
      effects.push(
        { type: "stop_admission" },
        { type: "abort_sessions", generation: state.generation },
      );
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
