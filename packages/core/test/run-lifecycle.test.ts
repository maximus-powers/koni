import { describe, expect, it } from "vitest";
import {
  activeRuntimeMs,
  blockerRemedyGuidance,
  classifyBlockerRemedy,
  InvalidRunTransitionError,
  newRunLifecycle,
  reduceRunLifecycle,
  retryClearsBlocker,
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

  it("clears a stale execution blocker when an explicitly paused run resumes", () => {
    let state = apply(
      newRunLifecycle("run-resume-clears-blocker"),
      { type: "planning_started", atMs: 10 },
      { type: "plan_submitted", atMs: 20 },
      { type: "plan_approval_requested", atMs: 30 },
      { type: "plan_approved", atMs: 31 },
      { type: "verification_started", atMs: 35 },
      {
        type: "integration_required",
        atMs: 40,
        reason: "previous deterministic orchestration boundary",
      },
      { type: "pause_requested", atMs: 50 },
      { type: "pause_settled", atMs: 60 },
    );
    expect(state.blocker).toBe("previous deterministic orchestration boundary");

    state = reduceRunLifecycle(state, { type: "resume_requested", atMs: 70 }).state;
    expect(state).toMatchObject({ phase: "executing", blocker: undefined, runningIntent: true });
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
      { type: "blocked", atMs: 20, reason: "bounded cold-start timeout", remedy: "resume" },
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

  it("carries a typed remedy with a blocker and clears both together", () => {
    const blocked = apply(
      newRunLifecycle("run-remedy"),
      { type: "planning_started", atMs: 10 },
      {
        type: "blocked",
        atMs: 20,
        reason: "Provider request remains reserved without a canonical assistant settlement",
        remedy: "stop",
      },
    );
    expect(blocked).toMatchObject({
      phase: "blocked",
      blocker: "Provider request remains reserved without a canonical assistant settlement",
      blockerRemedy: "stop",
    });
    // A remedy that outlived its blocker would keep advertising an action that no longer applies.
    const retried = reduceRunLifecycle(blocked, {
      type: "retry_requested",
      atMs: 30,
      phase: blocked.resumePhase!,
    }).state;
    expect(retried.blocker).toBeUndefined();
    expect(retried.blockerRemedy).toBeUndefined();
  });

  it("derives a remedy from the failure so no path advertises an impossible retry", () => {
    // Untyped blockers were the session's largest time sink, and the default of "resume" was worse
    // than untyped: it actively invited a retry. These two signatures are the ones a retry cannot
    // clear, and they must classify wherever they are recorded — including paths whose throw
    // escapes every catch that would otherwise have typed it.
    expect(
      classifyBlockerRemedy(
        "ticket validation action did not complete with its exact accepted assignment " +
          "(compensated): ticket TK-1 changed under the same deterministic identity; " +
          "automatic reissue is exhausted after 3 fresh attempts",
      ),
    ).toBe("new_run");
    expect(
      classifyBlockerRemedy(
        "Configured action recovery failed: compiler terminal validation replay did not pass",
      ),
    ).toBe("stop");
    expect(classifyBlockerRemedy("terminal_replay_failed")).toBe("stop");
    expect(
      classifyBlockerRemedy(
        "terminal replay scientific-runtime has no authenticated retained receipt for scientific-runtime",
      ),
    ).toBe("stop");

    // Anything unrecognised keeps the behaviour every surface already implies rather than a guess
    // wearing a confident label.
    expect(classifyBlockerRemedy("ticket validation action did not complete (compensated)")).toBe(
      "resume",
    );
    expect(classifyBlockerRemedy("Run workspace approval failed: disk full")).toBe("resume");

    // A remedy a retry cannot perform must never be offered as one.
    expect(retryClearsBlocker(classifyBlockerRemedy("automatic reissue is exhausted"))).toBe(false);
  });

  it("offers a retry only for remedies a retry performs", () => {
    expect(retryClearsBlocker(undefined)).toBe(true);
    expect(retryClearsBlocker("auto")).toBe(true);
    expect(retryClearsBlocker("resume")).toBe(true);
    for (const remedy of ["stop", "fresh_epoch", "new_run", "change_request"] as const) {
      expect(retryClearsBlocker(remedy)).toBe(false);
      expect(blockerRemedyGuidance(remedy).length).toBeGreaterThan(0);
    }
  });

  it("allows a fresh plan revision after an execution-time graph contradiction", () => {
    const blocked = apply(
      newRunLifecycle("run-plan-revision"),
      { type: "planning_started", atMs: 10 },
      { type: "plan_submitted", atMs: 20 },
      { type: "plan_approval_requested", atMs: 30 },
      { type: "plan_approved", atMs: 31 },
      { type: "blocked", atMs: 40, reason: "causal ordering contradiction", remedy: "resume" },
    );
    expect(blocked).toMatchObject({ phase: "blocked", resumePhase: "executing" });

    const revision = reduceRunLifecycle(blocked, {
      type: "plan_revision_requested",
      atMs: 50,
    });
    expect(revision.state).toMatchObject({
      phase: "planning",
      planRevision: 2,
      blocker: undefined,
      resumePhase: undefined,
      runningIntent: false,
    });
    expect(revision.effects).toEqual([{ type: "request_plan_revision", planRevision: 2 }]);
  });

  it("revises one planning session without replacing its attempt identity", () => {
    const initial = apply(newRunLifecycle("run-continuous-plan"), {
      type: "planning_started",
      atMs: 10,
    });
    const reviewed = reduceRunLifecycle(initial, {
      type: "plan_checkpoint_validated",
      atMs: 20,
      revision: 0,
    }).state;
    const revising = reduceRunLifecycle(reviewed, {
      type: "plan_revision_requested",
      atMs: 30,
    }).state;

    expect(reviewed.phase).toBe("awaiting_approval");
    expect(revising.phase).toBe("planning");
    expect(revising.planRevision).toBe(1);
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

  it("returns a merge-ready run to execution when revalidation finds new compiler work", () => {
    const mergeReady = apply(
      newRunLifecycle("run-promotion-revalidation"),
      { type: "planning_started", atMs: 1 },
      { type: "plan_submitted", atMs: 2 },
      { type: "plan_approval_requested", atMs: 3 },
      { type: "plan_approved", atMs: 4 },
      { type: "verification_started", atMs: 5 },
      { type: "verification_passed", atMs: 6 },
    );

    const reduction = reduceRunLifecycle(mergeReady, { type: "execution_required", atMs: 7 });

    expect(reduction.state.phase).toBe("executing");
    expect(reduction.effects).toEqual([{ type: "admit_ready_work" }]);
  });
});
