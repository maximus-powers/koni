import { describe, expect, it } from "vitest";
import {
  activeRuntimeMs,
  InvalidRunTransitionError,
  newRunLifecycle,
  reduceRunLifecycle,
  type RunLifecycleEvent,
  type RunLifecycleState,
} from "../src/state/run-lifecycle.js";

function apply(state: RunLifecycleState, ...events: RunLifecycleEvent[]): RunLifecycleState {
  return events.reduce((current, event) => reduceRunLifecycle(current, event).state, state);
}

describe("run lifecycle", () => {
  it("persists pause intent and resumes only explicitly", () => {
    let state = apply(
      newRunLifecycle("run-one"),
      { type: "planning_started", atMs: 10 },
      { type: "plan_submitted", atMs: 20 },
      { type: "plan_approval_requested", atMs: 30 },
      { type: "plan_approved", atMs: 30 },
      { type: "pause_requested", atMs: 50 },
      { type: "pause_settled", atMs: 60 },
    );
    expect(state.phase).toBe("paused");
    expect(state.runningIntent).toBe(false);
    expect(activeRuntimeMs(state, 100)).toBe(20);

    const reduction = reduceRunLifecycle(state, { type: "resume_requested", atMs: 100 });
    state = reduction.state;
    expect(state.phase).toBe("executing");
    expect(state.runningIntent).toBe(true);
    expect(reduction.effects).toContainEqual({ type: "admit_ready_work" });
    expect(activeRuntimeMs(state, 120)).toBe(40);
  });

  it("answers all pending questions before resuming the attempt", () => {
    let state = apply(newRunLifecycle("run-one"), { type: "planning_started", atMs: 10 });
    state = apply(state, {
      type: "question_opened",
      atMs: 20,
      question: { id: "q1", attemptId: "planner-1" },
    });
    expect(state.phase).toBe("awaiting_questions");
    const reduction = reduceRunLifecycle(state, {
      type: "question_answered",
      atMs: 40,
      questionId: "q1",
      answer: "Use the existing boundary",
      notes: "Preserve compatibility",
    });
    expect(reduction.state.phase).toBe("planning");
    expect(reduction.effects).toEqual([
      { type: "deliver_answer", questionId: "q1", attemptId: "planner-1" },
    ]);
  });

  it("preserves an executing question wrapper across pause and explicit resume", () => {
    let state = apply(
      newRunLifecycle("run-question-pause"),
      { type: "planning_started", atMs: 10 },
      { type: "plan_submitted", atMs: 20 },
      { type: "plan_approval_requested", atMs: 30 },
      { type: "plan_approved", atMs: 31 },
      {
        type: "question_opened",
        atMs: 40,
        question: { id: "q-executing", attemptId: "worker-1" },
      },
    );
    expect(state).toMatchObject({ phase: "awaiting_questions", resumePhase: "executing" });

    state = apply(
      state,
      { type: "pause_requested", atMs: 50 },
      { type: "pause_settled", atMs: 60 },
    );
    expect(state).toMatchObject({
      phase: "paused",
      resumePhase: "executing",
      runningIntent: false,
    });

    const resumed = reduceRunLifecycle(state, { type: "questions_resume_requested", atMs: 70 });
    expect(resumed.state).toMatchObject({
      phase: "awaiting_questions",
      resumePhase: "executing",
      runningIntent: true,
      activeSinceMs: undefined,
    });
    expect(resumed.effects).toEqual([]);

    const answered = reduceRunLifecycle(resumed.state, {
      type: "question_answered",
      atMs: 80,
      questionId: "q-executing",
      answer: "Proceed",
    });
    expect(answered.state).toMatchObject({
      phase: "executing",
      resumePhase: undefined,
      runningIntent: true,
      activeSinceMs: 80,
    });
  });

  it("retries a blocked run from its exact prior phase", () => {
    let state = apply(
      newRunLifecycle("run-one"),
      { type: "planning_started", atMs: 10 },
      { type: "blocked", atMs: 20, reason: "bounded cold-start timeout" },
    );
    expect(state).toMatchObject({
      phase: "blocked",
      resumePhase: "planning",
      runningIntent: false,
    });

    const reduction = reduceRunLifecycle(state, {
      type: "retry_requested",
      atMs: 30,
      phase: state.resumePhase!,
    });
    state = reduction.state;
    expect(state).toMatchObject({
      phase: "planning",
      resumePhase: undefined,
      blocker: undefined,
      runningIntent: true,
    });
    expect(reduction.effects).toEqual([{ type: "launch_planner", planRevision: 1 }]);
  });

  it("increments generation before deleting and rejects resurrection", () => {
    let state = apply(newRunLifecycle("run-one"), { type: "planning_started", atMs: 10 });
    const deleting = reduceRunLifecycle(state, { type: "delete_requested", atMs: 12 });
    state = deleting.state;
    expect(state.phase).toBe("deleting");
    expect(state.generation).toBe(1);
    expect(deleting.effects).toContainEqual({ type: "abort_sessions", generation: 1 });
    state = reduceRunLifecycle(state, { type: "delete_settled", atMs: 13 }).state;
    expect(state.phase).toBe("deleted");
    expect(() => reduceRunLifecycle(state, { type: "resume_requested", atMs: 14 })).toThrow(
      InvalidRunTransitionError,
    );
  });

  it("requires explicit merge authorization after verification", () => {
    let state = apply(
      newRunLifecycle("run-one"),
      { type: "planning_started", atMs: 1 },
      { type: "plan_submitted", atMs: 2 },
      { type: "plan_approval_requested", atMs: 3 },
      { type: "plan_approved", atMs: 3 },
      { type: "verification_started", atMs: 4 },
      { type: "verification_passed", atMs: 5 },
    );
    expect(state.phase).toBe("merge_ready");
    const merge = reduceRunLifecycle(state, { type: "merge_started", atMs: 6 });
    expect(merge.effects).toEqual([{ type: "publish_merge" }]);
    state = reduceRunLifecycle(merge.state, { type: "merge_completed", atMs: 7 }).state;
    expect(state.phase).toBe("completed");
  });

  it("returns a verifying run to deterministic execution when the compiler finds work", () => {
    const verifying = apply(
      newRunLifecycle("run-verification-fixpoint"),
      { type: "planning_started", atMs: 1 },
      { type: "plan_submitted", atMs: 2 },
      { type: "plan_approval_requested", atMs: 3 },
      { type: "plan_approved", atMs: 3 },
      { type: "verification_started", atMs: 4 },
    );

    const reduction = reduceRunLifecycle(verifying, { type: "execution_required", atMs: 5 });

    expect(reduction.state).toMatchObject({
      phase: "executing",
      runningIntent: true,
      blocker: undefined,
    });
    expect(reduction.effects).toEqual([{ type: "admit_ready_work" }]);
  });
});
