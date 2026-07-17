import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord, TicketRecord } from "../src/state/run-record.js";
import { DurableRunStore, RunRevisionConflictError } from "../src/state/run-store.js";
import { beginAssignment, deriveReadyAssignments, finishAssignment } from "../src/state/scheduler.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable run store and deterministic scheduler", () => {
  it("persists CAS mutations and rejects stale writers", async () => {
    const root = await temporaryRoot();
    const store = await DurableRunStore.open(root);
    await store.create(runRecord());
    const updated = await store.transact("run-one", 0, (draft) => {
      draft.objective = "changed";
    });
    expect(updated.revision).toBe(1);
    expect((await store.get("run-one")).objective).toBe("changed");
    await expect(store.transact("run-one", 0, () => undefined)).rejects.toBeInstanceOf(
      RunRevisionConflictError,
    );
  });

  it("admits only dependency-ready work under exact parallelism", () => {
    const run = runRecord();
    run.tickets["ticket-a"] = ticket("ticket-a", 20, []);
    run.tickets["ticket-b"] = ticket("ticket-b", 10, []);
    run.tickets["ticket-c"] = ticket("ticket-c", 0, ["ticket-a"]);
    const projection = deriveReadyAssignments(run, 2);
    expect(projection.ready.map((item) => item.ticketId)).toEqual(["ticket-b", "ticket-a"]);
    expect(projection.blocked).toEqual([{ ticketId: "ticket-c", waitingOn: ["ticket-a"] }]);
  });

  it("advances steps and makes dependents ready without a Lead scheduling loop", () => {
    const run = runRecord();
    run.tickets["ticket-a"] = ticket("ticket-a", 0, []);
    run.tickets["ticket-b"] = ticket("ticket-b", 1, ["ticket-a"]);
    const first = deriveReadyAssignments(run, 3).ready[0]!;
    beginAssignment(run, first, "attempt-one", "2026-07-16T00:00:01.000Z");
    expect(deriveReadyAssignments(run, 3).ready).toEqual([]);
    finishAssignment(
      run,
      first,
      { status: "completed", summary: "Implemented seam" },
      "2026-07-16T00:00:02.000Z",
    );
    expect(run.tickets["ticket-a"]!.steps[0]!.summary).toBe("Implemented seam");
    expect(deriveReadyAssignments(run, 3).ready.map((item) => item.ticketId)).toEqual(["ticket-b"]);
  });

  it("dispatches and reconciles with zero Lead or supervisor model calls and tokens", () => {
    const run = runRecord();
    run.tickets["ticket-a"] = ticket("ticket-a", 0, []);
    run.tickets["ticket-b"] = ticket("ticket-b", 1, ["ticket-a"]);

    const first = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, first, "attempt-ticket-a", "2026-07-16T00:00:01.000Z");
    finishAssignment(
      run,
      first,
      { status: "completed", summary: "Completed without a relay" },
      "2026-07-16T00:00:02.000Z",
    );

    expect(deriveReadyAssignments(run, 1).ready.map((assignment) => assignment.ticketId)).toEqual(["ticket-b"]);
    // These synchronous scheduler primitives mutate only compiler-owned ticket state. There
    // is no model/session callback through which they could create relay work or usage.
    expect(Object.values(run.attempts).filter((attempt) =>
      attempt.personaId === "lead" || attempt.personaId === "supervisor"
    )).toEqual([]);
    expect(Object.values(run.attempts).reduce((tokens, attempt) =>
      tokens + attempt.inputTokens + attempt.outputTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens,
    0)).toBe(0);
  });

  it("reopens one failed review and accepts only a fresh passing successor", () => {
    const run = runRecord();
    run.tickets["ticket-review"] = reviewTicket("ticket-review");

    const implementation = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, implementation, "attempt-implementation-one", "2026-07-16T00:00:01.000Z");
    finishAssignment(
      run,
      implementation,
      { status: "completed", summary: "First candidate" },
      "2026-07-16T00:00:02.000Z",
    );
    const firstReview = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, firstReview, "attempt-review-one", "2026-07-16T00:00:03.000Z");
    expect(finishAssignment(
      run,
      firstReview,
      { status: "failed", blocker: "The boundary case is missing." },
      "2026-07-16T00:00:04.000Z",
    )).toEqual({ disposition: "review_rework" });

    const ticket = run.tickets["ticket-review"]!;
    expect(ticket.reviewReworks).toEqual([{
      ordinal: 1,
      failedReviewAttemptId: "attempt-review-one",
      reopenFromStepId: "implement",
      blocker: "The boundary case is missing.",
      openedAt: "2026-07-16T00:00:04.000Z",
    }]);
    expect(ticket.steps.map((step) => [step.id, step.status, step.attemptIds])).toEqual([
      ["implement", "pending", ["attempt-implementation-one"]],
      ["review", "pending", ["attempt-review-one"]],
    ]);
    expect(() => finishAssignment(
      run,
      firstReview,
      { status: "completed", summary: "Stale review replay" },
      "2026-07-16T00:00:05.000Z",
    )).toThrow(/step is not running/u);

    const replacement = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, replacement, "attempt-implementation-two", "2026-07-16T00:00:06.000Z");
    finishAssignment(
      run,
      replacement,
      { status: "completed", summary: "Corrected candidate" },
      "2026-07-16T00:00:07.000Z",
    );
    const currentReview = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, currentReview, "attempt-review-two", "2026-07-16T00:00:08.000Z");
    expect(finishAssignment(
      run,
      currentReview,
      { status: "completed", summary: "Current review passed" },
      "2026-07-16T00:00:09.000Z",
    )).toEqual({ disposition: "ticket_completed" });
    expect(ticket.status).toBe("completed");
    expect(ticket.steps[1]!.attemptIds).toEqual(["attempt-review-one", "attempt-review-two"]);
  });

  it("blocks a second failed review instead of opening an unbounded rework loop", () => {
    const run = runRecord();
    const ticket = reviewTicket("ticket-review-limit");
    ticket.reviewReworkCount = 1;
    ticket.reviewReworks = [{
      ordinal: 1,
      failedReviewAttemptId: "attempt-review-one",
      reopenFromStepId: "implement",
      blocker: "First review failed.",
      openedAt: "2026-07-16T00:00:01.000Z",
    }];
    ticket.steps[0]!.status = "completed";
    ticket.steps[1]!.status = "pending";
    run.tickets[ticket.id] = ticket;
    const review = deriveReadyAssignments(run, 1).ready[0]!;
    expect(review.stepId).toBe("review");
    beginAssignment(run, review, "attempt-review-two", "2026-07-16T00:00:02.000Z");
    expect(finishAssignment(
      run,
      review,
      { status: "failed", blocker: "Second review still fails." },
      "2026-07-16T00:00:03.000Z",
    )).toEqual({ disposition: "blocked" });
    expect(ticket.status).toBe("blocked");
    expect(ticket.reviewReworkCount).toBe(1);
    expect(ticket.reviewReworks).toHaveLength(1);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-runs-"));
  roots.push(root);
  return root;
}

function runRecord(): RunRecord {
  let lifecycle = newRunLifecycle("run-one");
  lifecycle = reduceRunLifecycle(lifecycle, { type: "planning_started", atMs: 1 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_submitted", atMs: 2 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approval_requested", atMs: 3 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approved", atMs: 4 }).state;
  return {
    protocol: "koni.run-record.v1",
    id: "run-one",
    revision: 0,
    generation: 0,
    projectRoot: "/project",
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "0.6.0",
      lineage: "koni.software",
      bundleHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    compiledConfigHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    runTypeId: "medium",
    objective: "Build the feature",
    intake: { goal: "Build the feature" },
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    lifecycle,
    pipelineStageIds: ["planning", "approval", "orchestrate", "promotion"],
    currentPipelineStageId: "orchestrate",
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit("/project", "run-one", "approved"),
  };
}

function ticket(id: string, priority: number, dependencyIds: string[]): TicketRecord {
  return {
    id,
    operationId: "implement-change",
    title: id,
    summary: id,
    status: "todo",
    priority,
    dependencyIds,
    targetNodeIds: [],
    readPaths: [],
    writePaths: [],
    steps: [
      {
        id: "implement",
        title: "Implement",
        personaId: "implementer",
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      },
    ],
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  };
}

function reviewTicket(id: string): TicketRecord {
  const value = ticket(id, 0, []);
  value.steps = [
    {
      id: "implement",
      title: "Implement",
      personaId: "implementer",
      kind: "production",
      status: "pending",
      attemptIds: [],
      summary: undefined,
      startedAt: undefined,
      completedAt: undefined,
    },
    {
      id: "review",
      title: "Review",
      personaId: "reviewer",
      kind: "review",
      status: "pending",
      attemptIds: [],
      summary: undefined,
      startedAt: undefined,
      completedAt: undefined,
    },
  ];
  value.reviewFailureReopenFrom = "implement";
  value.reviewReworkLimit = 1;
  value.reviewReworkCount = 0;
  value.reviewReworks = [];
  return value;
}
