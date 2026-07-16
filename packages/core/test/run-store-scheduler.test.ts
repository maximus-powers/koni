import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord, TicketRecord } from "../src/state/run-record.js";
import { DurableRunStore, RunRevisionConflictError } from "../src/state/run-store.js";
import { beginAssignment, deriveReadyAssignments, finishAssignment } from "../src/state/scheduler.js";

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
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approved", atMs: 3 }).state;
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
    git: {
      targetRef: "refs/heads/main",
      targetBaseOid: "a".repeat(40),
      runBranch: "koni/runs/run-one",
      runWorktree: "/worktree",
      candidateOid: undefined,
      promotionTargetOid: undefined,
      mergeReadyAt: undefined,
      mergedOid: undefined,
    },
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
