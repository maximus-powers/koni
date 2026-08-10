import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord, TicketRecord } from "../src/state/run-record.js";
import { DurableRunStore, RunRevisionConflictError } from "../src/state/run-store.js";
import {
  authorizeBlockedReviewRetry,
  beginAssignment,
  beginsBoundedReviewRework,
  blockedIndependentReviewRetryCandidate,
  blockedReviewRetryCandidate,
  canRetryBlockedReviewOnly,
  deriveReadyAssignments,
  finishAssignment,
  legacyCompletedReviewRejectionCandidate,
  recoverLegacyCompletedReviewRejection,
  reviewReworkAppliesToStep,
} from "../src/state/scheduler.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable run store and deterministic scheduler", () => {
  it("accepts queued tickets and rejects legacy ticket states", async () => {
    for (const legacyStatus of ["todo", "ready", "failed"] as const) {
      const store = await DurableRunStore.open(await temporaryRoot());
      const legacy = runRecord();
      const legacyTicket = ticket(`ticket-legacy-${legacyStatus}`, 0, []);
      legacyTicket.status = legacyStatus as unknown as TicketRecord["status"];
      legacy.tickets[legacyTicket.id] = legacyTicket;

      await expect(store.create(legacy)).rejects.toThrow(/invalid ticket status/u);
    }

    const queuedStore = await DurableRunStore.open(await temporaryRoot());
    const queuedRun = runRecord();
    const queuedTicket = ticket("ticket-queued", 0, []);
    queuedTicket.status = "queued";
    queuedRun.tickets[queuedTicket.id] = queuedTicket;
    await expect(queuedStore.create(queuedRun)).resolves.toMatchObject({
      tickets: { "ticket-queued": { status: "queued" } },
    });

    const blockedStore = await DurableRunStore.open(await temporaryRoot());
    const blockedRun = runRecord();
    const blockedTicket = ticket("ticket-blocked", 0, []);
    blockedTicket.status = "blocked";
    blockedTicket.blocker = "The boundary case is missing.";
    blockedTicket.steps[0]!.status = "failed";
    blockedRun.tickets[blockedTicket.id] = blockedTicket;
    await expect(blockedStore.create(blockedRun)).resolves.toMatchObject({
      tickets: {
        "ticket-blocked": {
          status: "blocked",
          steps: [expect.objectContaining({ status: "failed" })],
        },
      },
    });
  });

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
    expect(run.tickets["ticket-a"].steps[0]!.summary).toBe("Implemented seam");
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

    expect(deriveReadyAssignments(run, 1).ready.map((assignment) => assignment.ticketId)).toEqual([
      "ticket-b",
    ]);
    // These synchronous scheduler primitives mutate only compiler-owned ticket state. There
    // is no model/session callback through which they could create relay work or usage.
    expect(
      Object.values(run.attempts).filter(
        (attempt) => attempt.personaId === "lead" || attempt.personaId === "supervisor",
      ),
    ).toEqual([]);
    expect(
      Object.values(run.attempts).reduce(
        (tokens, attempt) =>
          tokens +
          attempt.inputTokens +
          attempt.outputTokens +
          attempt.cacheReadTokens +
          attempt.cacheWriteTokens,
        0,
      ),
    ).toBe(0);
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
    expect(
      finishAssignment(
        run,
        firstReview,
        { status: "failed", blocker: "The boundary case is missing." },
        "2026-07-16T00:00:04.000Z",
      ),
    ).toEqual({ disposition: "review_rework" });

    const ticket = run.tickets["ticket-review"];
    expect(ticket.reviewReworks).toEqual([
      {
        ordinal: 1,
        mode: "automatic",
        failedReviewAttemptId: "attempt-review-one",
        reopenFromStepId: "implement",
        blocker: "The boundary case is missing.",
        openedAt: "2026-07-16T00:00:04.000Z",
      },
    ]);
    expect(ticket.steps.map((step) => [step.id, step.status, step.attemptIds])).toEqual([
      ["implement", "pending", ["attempt-implementation-one"]],
      ["review", "pending", ["attempt-review-one"]],
    ]);
    expect(() =>
      finishAssignment(
        run,
        firstReview,
        { status: "completed", summary: "Stale review replay" },
        "2026-07-16T00:00:05.000Z",
      ),
    ).toThrow(/step is not running/u);

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
    expect(
      finishAssignment(
        run,
        currentReview,
        { status: "completed", summary: "Current review passed" },
        "2026-07-16T00:00:09.000Z",
      ),
    ).toEqual({ disposition: "ticket_completed" });
    expect(ticket.status).toBe("completed");
    expect(ticket.steps[1]!.attemptIds).toEqual(["attempt-review-one", "attempt-review-two"]);
  });

  it("recovers one legacy review rejection that was misclassified as completed", () => {
    const run = runRecord();
    const ticket = reviewTicket("ticket-legacy-review-rejection");
    run.tickets[ticket.id] = ticket;

    const implementation = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, implementation, "attempt-implementation", "2026-07-16T00:00:01.000Z");
    finishAssignment(
      run,
      implementation,
      { status: "completed", summary: "Unsafe candidate" },
      "2026-07-16T00:00:02.000Z",
    );
    const review = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, review, "attempt-legacy-review", "2026-07-16T00:00:03.000Z");
    finishAssignment(
      run,
      review,
      { status: "completed", summary: "Review rejected: unsafe execution path." },
      "2026-07-16T00:00:04.000Z",
    );

    expect(
      legacyCompletedReviewRejectionCandidate(ticket, {
        status: "completed",
        reviewVerdict: "approved",
        summary: "Review rejected: misleading typed output.",
      }),
    ).toBeUndefined();
    const candidate = legacyCompletedReviewRejectionCandidate(ticket, {
      status: "completed",
      summary: "Review rejected: unsafe execution path.",
    });
    expect(candidate).toEqual({
      reviewAttemptId: "attempt-legacy-review",
      blocker: "unsafe execution path.",
    });
    expect(
      recoverLegacyCompletedReviewRejection(
        ticket,
        candidate!.reviewAttemptId,
        candidate!.blocker,
        "2026-07-16T00:00:05.000Z",
      ),
    ).toBe(true);
    expect(ticket.status).toBe("ready");
    expect(ticket.reviewReworkCount).toBe(1);
    expect(ticket.blocker).toBe("unsafe execution path.");
    expect(ticket.steps.map((step) => [step.id, step.status, step.attemptIds])).toEqual([
      ["implement", "pending", ["attempt-implementation"]],
      ["review", "pending", ["attempt-legacy-review"]],
    ]);
    expect(ticket.reviewReworks).toEqual([
      {
        ordinal: 1,
        mode: "automatic",
        failedReviewAttemptId: "attempt-legacy-review",
        reopenFromStepId: "implement",
        blocker: "unsafe execution path.",
        openedAt: "2026-07-16T00:00:05.000Z",
      },
    ]);
    expect(beginsBoundedReviewRework(ticket, "implement", "2026-07-16T00:00:01.000Z")).toBe(true);
    expect(beginsBoundedReviewRework(ticket, "implement", "2026-07-16T00:00:06.000Z")).toBe(false);
    expect(reviewReworkAppliesToStep(ticket, "implement")).toBe(true);
    expect(reviewReworkAppliesToStep(ticket, "review")).toBe(true);
  });

  it("never spends an author rework cycle on a Review infrastructure failure", () => {
    const run = runRecord();
    const ticket = reviewTicket("ticket-review-infrastructure");
    run.tickets[ticket.id] = ticket;

    const implementation = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, implementation, "attempt-implementation", "2026-07-16T00:00:01.000Z");
    finishAssignment(
      run,
      implementation,
      { status: "completed", summary: "Candidate is ready for review" },
      "2026-07-16T00:00:02.000Z",
    );
    const review = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, review, "attempt-review-infrastructure", "2026-07-16T00:00:03.000Z");

    expect(
      finishAssignment(
        run,
        review,
        {
          status: "failed",
          blocker: "provider input budget exceeded",
          failureKind: "infrastructure",
        },
        "2026-07-16T00:00:04.000Z",
      ),
    ).toEqual({ disposition: "blocked" });
    expect(ticket.status).toBe("blocked");
    expect(ticket.reviewReworkCount).toBe(0);
    expect(ticket.reviewReworks).toEqual([]);
    expect(ticket.steps.map((step) => [step.id, step.status])).toEqual([
      ["implement", "completed"],
      ["review", "failed"],
    ]);
  });

  it("blocks a second failed review instead of opening an unbounded rework loop", () => {
    const run = runRecord();
    const ticket = reviewTicket("ticket-review-limit");
    ticket.reviewReworkCount = 1;
    ticket.reviewReworks = [
      {
        ordinal: 1,
        failedReviewAttemptId: "attempt-review-one",
        reopenFromStepId: "implement",
        blocker: "First review failed.",
        openedAt: "2026-07-16T00:00:01.000Z",
      },
    ];
    ticket.steps[0]!.status = "completed";
    ticket.steps[1]!.status = "pending";
    run.tickets[ticket.id] = ticket;
    const review = deriveReadyAssignments(run, 1).ready[0]!;
    expect(review.stepId).toBe("review");
    beginAssignment(run, review, "attempt-review-two", "2026-07-16T00:00:02.000Z");
    expect(
      finishAssignment(
        run,
        review,
        { status: "failed", blocker: "Second review still fails." },
        "2026-07-16T00:00:03.000Z",
      ),
    ).toEqual({ disposition: "review_exhausted" });
    expect(ticket.status).toBe("blocked");
    expect(ticket.reviewReworkCount).toBe(1);
    expect(ticket.reviewReworks).toHaveLength(1);
  });

  it("reopens an exhausted review only through one exact operator-authorized boundary", () => {
    const run = runRecord();
    const ticket = reviewTicket("ticket-review-supervised");
    ticket.reviewReworkCount = 1;
    ticket.reviewReworks = [
      {
        ordinal: 1,
        mode: "automatic",
        failedReviewAttemptId: "attempt-review-one",
        reopenFromStepId: "implement",
        blocker: "First review failed.",
        openedAt: "2026-07-16T00:00:01.000Z",
      },
    ];
    ticket.steps[0]!.status = "completed";
    ticket.steps[1]!.status = "pending";
    run.tickets[ticket.id] = ticket;
    const review = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, review, "attempt-review-two", "2026-07-16T00:00:02.000Z");
    expect(
      finishAssignment(
        run,
        review,
        { status: "failed", blocker: "Second review found a material route gap." },
        "2026-07-16T00:00:03.000Z",
      ),
    ).toEqual({ disposition: "review_exhausted" });

    const candidate = blockedReviewRetryCandidate(ticket)!;
    expect(candidate).toMatchObject({
      ticketId: ticket.id,
      reviewStepId: "review",
      failedReviewAttemptId: "attempt-review-two",
      blocker: "Second review found a material route gap.",
    });
    expect(() =>
      authorizeBlockedReviewRetry(
        run,
        {
          ticketId: ticket.id,
          reviewStepId: "review",
          failedReviewAttemptId: "attempt-review-one",
        },
        "2026-07-16T00:00:04.000Z",
      ),
    ).toThrow(/no longer matches/u);

    authorizeBlockedReviewRetry(
      run,
      candidate,
      "2026-07-16T00:00:04.000Z",
      "Keep the real parent render, but stub unrelated icon and return-product leaves.",
    );
    expect(ticket.status).toBe("ready");
    expect(ticket.blocker).toBe("Second review found a material route gap.");
    expect(ticket.reviewReworkCount).toBe(1);
    expect(ticket.reviewReworks).toEqual([
      expect.objectContaining({
        ordinal: 1,
        mode: "automatic",
        failedReviewAttemptId: "attempt-review-one",
      }),
      expect.objectContaining({
        ordinal: 2,
        mode: "supervised",
        failedReviewAttemptId: "attempt-review-two",
        operatorSteering:
          "Keep the real parent render, but stub unrelated icon and return-product leaves.",
      }),
    ]);
    expect(ticket.steps.map((step) => [step.id, step.status])).toEqual([
      ["implement", "pending"],
      ["review", "pending"],
    ]);
    expect(deriveReadyAssignments(run, 1).ready[0]).toMatchObject({
      ticketId: ticket.id,
      stepId: "implement",
    });
  });

  it("restores the reviewed correction contract when its automatic rework author is blocked", () => {
    const run = runRecord();
    const ticket = reviewTicket("ticket-review-author-blocked");
    ticket.reviewReworkCount = 1;
    ticket.reviewReworks = [
      {
        ordinal: 1,
        mode: "automatic",
        failedReviewAttemptId: "attempt-review-one",
        reopenFromStepId: "implement",
        blocker: "Reviewer requires proof through the real parent consumer.",
        openedAt: "2026-07-16T00:00:01.000Z",
      },
    ];
    ticket.status = "blocked";
    ticket.blocker = "new-token token budget exceeded";
    ticket.steps[0]!.status = "failed";
    ticket.steps[1]!.status = "pending";
    ticket.steps[1]!.attemptIds = ["attempt-review-one"];
    run.tickets[ticket.id] = ticket;

    const candidate = blockedReviewRetryCandidate(ticket)!;
    expect(candidate).toMatchObject({
      ticketId: ticket.id,
      reviewStepId: "review",
      failedReviewAttemptId: "attempt-review-one",
      blocker: "Reviewer requires proof through the real parent consumer.",
    });

    authorizeBlockedReviewRetry(run, candidate, "2026-07-16T00:00:04.000Z");
    expect(ticket.status).toBe("ready");
    expect(ticket.blocker).toBe("Reviewer requires proof through the real parent consumer.");
    expect(ticket.reviewReworkCount).toBe(1);
    expect(ticket.reviewReworks).toEqual([
      expect.objectContaining({
        ordinal: 1,
        mode: "automatic",
        failedReviewAttemptId: "attempt-review-one",
      }),
      expect.objectContaining({
        ordinal: 2,
        mode: "supervised",
        failedReviewAttemptId: "attempt-review-one",
      }),
    ]);
    expect(ticket.steps.map((step) => [step.id, step.status])).toEqual([
      ["implement", "pending"],
      ["review", "pending"],
    ]);
  });

  it("can preserve a compiler-accepted producer result and retry only independent review", () => {
    const run = runRecord();
    const ticket = reviewTicket("ticket-review-only");
    ticket.reviewReworkCount = 1;
    ticket.reviewReworks = [
      {
        ordinal: 1,
        mode: "automatic",
        failedReviewAttemptId: "attempt-review-one",
        reopenFromStepId: "implement",
        blocker: "The prior reviewer demanded evidence outside its configured contract.",
        openedAt: "2026-07-16T00:00:01.000Z",
      },
    ];
    ticket.status = "blocked";
    ticket.blocker = "The rework producer could not manufacture reviewer-only evidence.";
    ticket.steps[0]!.status = "failed";
    ticket.steps[0]!.attemptIds = ["attempt-implement-good", "attempt-implement-failed"];
    ticket.steps[1]!.status = "pending";
    ticket.steps[1]!.attemptIds = ["attempt-review-one"];
    run.tickets[ticket.id] = ticket;
    const digest =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    run.attempts["attempt-implement-good"] = {
      id: "attempt-implement-good",
      sessionId: "session-implement-good",
      ticketId: ticket.id,
      stepId: "implement",
      personaId: "implementer",
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "high",
      status: "completed",
      launchSpecHash: digest,
      sessionFile: "/sessions/implement-good.jsonl",
      startedAt: "2026-07-16T00:00:00.100Z",
      endedAt: "2026-07-16T00:00:00.900Z",
      terminalSummary: "Accepted candidate preserved",
      terminalOutputSha256: digest,
      terminalOutputSizeBytes: 42,
      terminalAcceptedAt: "2026-07-16T00:00:00.800Z",
      terminalPolicy: {
        protocol: "koni.agent-terminal-policy.v1",
        mode: "semantic",
        projectionSha256: digest,
        replayCompilationSha256: digest,
        receiptEvaluationSha256: digest,
        sourcePreservationSha256s: [],
        acceptedAt: "2026-07-16T00:00:00.800Z",
        sha256: digest,
      },
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    const candidate = blockedReviewRetryCandidate(ticket)!;
    expect(canRetryBlockedReviewOnly(run, candidate)).toBe(true);
    authorizeBlockedReviewRetry(
      run,
      candidate,
      "2026-07-16T00:00:04.000Z",
      undefined,
      "review_only",
    );
    expect(ticket.reviewReworks.at(-1)).toMatchObject({
      mode: "supervised",
      scope: "review_only",
      failedReviewAttemptId: "attempt-review-one",
    });
    expect(ticket.steps.map((step) => [step.id, step.status, step.summary])).toEqual([
      ["implement", "completed", "Accepted candidate preserved"],
      ["review", "pending", undefined],
    ]);
    expect(deriveReadyAssignments(run, 1).ready[0]).toMatchObject({
      ticketId: ticket.id,
      stepId: "review",
    });
  });

  it("permits explicit independent rereview when the workflow has no producer-rework route", () => {
    const run = runRecord();
    const ticket = reviewTicket("ticket-review-only-no-producer-route");
    delete ticket.reviewFailureReopenFrom;
    delete ticket.reviewReworkLimit;
    delete ticket.reviewReworkCount;
    delete ticket.reviewReworks;
    ticket.status = "blocked";
    ticket.blocker = "The independent reviewer lacked compiler-authenticated historical evidence.";
    ticket.steps[0]!.status = "completed";
    ticket.steps[0]!.summary = "Current promotion receipt accepted";
    ticket.steps[0]!.attemptIds = ["attempt-producer-accepted"];
    ticket.steps[1]!.status = "failed";
    ticket.steps[1]!.attemptIds = ["attempt-review-failed"];
    run.tickets[ticket.id] = ticket;
    const digest =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
    run.attempts["attempt-producer-accepted"] = {
      id: "attempt-producer-accepted",
      sessionId: "session-producer-accepted",
      ticketId: ticket.id,
      stepId: "implement",
      personaId: "implementer",
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "high",
      status: "completed",
      launchSpecHash: digest,
      sessionFile: "/sessions/producer-accepted.jsonl",
      startedAt: "2026-07-16T00:00:00.100Z",
      endedAt: "2026-07-16T00:00:00.900Z",
      terminalSummary: "Current promotion receipt accepted",
      terminalOutputSha256: digest,
      terminalOutputSizeBytes: 42,
      terminalAcceptedAt: "2026-07-16T00:00:00.800Z",
      terminalPolicy: {
        protocol: "koni.agent-terminal-policy.v1",
        mode: "semantic",
        projectionSha256: digest,
        replayCompilationSha256: digest,
        receiptEvaluationSha256: digest,
        sourcePreservationSha256s: [],
        acceptedAt: "2026-07-16T00:00:00.800Z",
        sha256: digest,
      },
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    expect(blockedReviewRetryCandidate(ticket)).toBeUndefined();
    const candidate = blockedIndependentReviewRetryCandidate(ticket)!;
    expect(candidate).toMatchObject({
      ticketId: ticket.id,
      reviewStepId: "review",
      failedReviewAttemptId: "attempt-review-failed",
      reopenFromStepId: "review",
    });
    expect(canRetryBlockedReviewOnly(run, candidate)).toBe(true);
    authorizeBlockedReviewRetry(
      run,
      candidate,
      "2026-07-16T00:00:04.000Z",
      "Use the newly projected immutable evidence envelope.",
      "review_only",
    );
    expect(ticket.steps.map((step) => [step.id, step.status])).toEqual([
      ["implement", "completed"],
      ["review", "pending"],
    ]);
    expect(ticket.reviewReworks).toEqual([
      expect.objectContaining({
        mode: "supervised",
        scope: "review_only",
        reopenFromStepId: "review",
        failedReviewAttemptId: "attempt-review-failed",
      }),
    ]);
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
