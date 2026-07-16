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
      { type: "plan_approved", atMs: 30 },
      { type: "pause_requested", atMs: 50 },
      { type: "pause_settled", atMs: 60 },
    );
    expect(state.phase).toBe("paused");
    expect(state.runningIntent).toBe(false);
    expect(activeRuntimeMs(state, 100)).toBe(30);

    const reduction = reduceRunLifecycle(state, { type: "resume_requested", atMs: 100 });
    state = reduction.state;
    expect(state.phase).toBe("executing");
    expect(state.runningIntent).toBe(true);
    expect(reduction.effects).toContainEqual({ type: "admit_ready_work" });
    expect(activeRuntimeMs(state, 120)).toBe(50);
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
});
