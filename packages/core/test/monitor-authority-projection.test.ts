import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendMonitorEvents,
  deriveMonitorEvents,
  projectMonitorAttention,
  projectControlProposalInspection,
  projectMonitorEvents,
  projectMonitorSnapshot,
} from "../src/authority/monitor-projection.js";
import {
  ProjectAuthorityStore,
  type ProjectAuthorityState,
} from "../src/authority/project-store.js";
import {
  parseMonitorAttention,
  parseMonitorEvents,
  parseMonitorSnapshot,
} from "../src/monitor/protocol.js";
import { rawSha256 } from "../src/shared/canonical.js";
import { newRunLifecycle } from "../src/state/run-lifecycle.js";
import type {
  AgentProviderTokenTotals,
  PlanningRevisionRecord,
  RunRecord,
} from "../src/state/run-record.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable Pi companion authority projections", () => {
  it("derives ordered semantic transitions and bounded human attention from committed records", () => {
    const root = "/tmp/koni-monitor-projection";
    const prior = runRecord(root);
    prior.lifecycle.phase = "planning";
    prior.lifecycle.runningIntent = true;
    prior.currentPipelineStageId = "architecture-plan";

    const next = structuredClone(prior);
    next.revision = 1;
    next.updatedAt = "2026-07-17T12:01:00.000Z";
    next.lifecycle.phase = "awaiting_approval";
    next.lifecycle.runningIntent = false;
    next.currentPipelineStageId = "plan-review";
    next.tickets["ticket-a"] = {
      id: "ticket-a",
      operationId: "implement",
      title: "Build notes editor",
      summary: "The note editor is implemented and verified.",
      status: "completed",
      priority: 1,
      dependencyIds: [],
      targetNodeIds: [],
      readPaths: [],
      writePaths: ["src"],
      steps: [],
      worktreePath: undefined,
      branch: undefined,
      blocker: undefined,
      createdAt: prior.createdAt,
      updatedAt: next.updatedAt,
    };
    next.questions["question-a"] = {
      id: "question-a",
      attemptId: "planner-a",
      prompt: "Where should notes be stored?",
      options: [{ id: "database", label: "Database", description: "Use the existing database." }],
      allowsNotes: true,
      askedAt: next.updatedAt,
      answeredAt: undefined,
      selectedOptionId: undefined,
      notes: undefined,
    };
    next.plan = {
      revision: 2,
      status: "awaiting_approval",
      full: { architecture: "# Complete architecture" },
      concise: {
        architecture: [
          { title: "Reuse persistence", description: "Keep writes behind the repository." },
        ],
        decisions: [],
        risk: [],
        verification: [
          { title: "Focused checks", description: "Exercise repository and route tests." },
        ],
      },
      graphSeed: {
        rootSpec: {},
        nodes: [
          { key: "change-a", type: "change" },
          { key: "check-a", type: "verification" },
        ],
        edges: [],
      },
      steeringHistory: [],
    };

    expect(deriveMonitorEvents(prior, next).map((event) => event.kind)).toEqual([
      "stage_changed",
      "ticket_completed",
      "question_opened",
      "plan_ready",
    ]);
    expect(parseMonitorAttention(projectMonitorAttention(next))).toMatchObject({
      runId: next.id,
      questions: [{ id: "question-a", allowsNotes: true }],
      plan: {
        revision: 2,
        graphSeedCounts: { change: 1, verification: 1 },
        sections: { architecture: [{ title: "Reuse persistence" }] },
      },
    });
  });

  it("projects cumulative and current usage for one continuous planning identity", () => {
    const run = runRecord("/tmp/koni-monitor-continuous-planning");
    run.lifecycle.phase = "awaiting_approval";
    run.plan = {
      revision: 1,
      status: "awaiting_approval",
      full: {},
      concise: { architecture: [], decisions: [], risk: [], verification: [] },
      graphSeed: undefined,
      steeringHistory: [],
    };
    run.attempts["planner-a"] = {
      id: "planner-a",
      sessionId: "session-a",
      kind: "planning",
      ticketId: "run-planning",
      stepId: "combined-plan",
      personaId: "run-planner",
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-sol",
      thinkingLevel: "high",
      status: "waiting_plan_review",
      launchSpecHash: rawSha256("launch"),
      sessionFile: "/sessions/session-a.jsonl",
      startedAt: run.createdAt,
      endedAt: undefined,
      terminalSummary: undefined,
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 0,
    };
    run.planningSession = {
      protocol: "koni.planning-session.v1",
      attemptId: "planner-a",
      sessionId: "session-a",
      status: "awaiting_review",
      currentRevision: 1,
      revisions: [
        planningRevision(0, "superseded", {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
        planningRevision(1, "awaiting_review", {
          inputTokens: 600,
          outputTokens: 300,
          cacheReadTokens: 6_000,
          cacheWriteTokens: 0,
        }),
      ],
    };

    expect(parseMonitorAttention(projectMonitorAttention(run)).plan).toMatchObject({
      revision: 1,
      planningSessionId: "session-a",
      planningAttemptId: "planner-a",
      revisionUsage: {
        cumulative: { new: 1_500, cache: 8_000, total: 9_500 },
        currentRevision: { new: 600, cache: 2_000, total: 2_600 },
      },
    });
  });

  it("persists a restart-safe global event cursor in the same transaction as a run", async () => {
    const root = await temporaryRoot();
    const store = await ProjectAuthorityStore.open({
      stateRoot: path.join(root, "state"),
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    const run = runRecord(root);
    const result = await store.commit({
      expectedRevision: 0,
      runWrites: [{ record: run, expectedRevision: null }],
    });
    expect(result.state.monitorEventCursor).toBe(2);
    expect(result.state.monitorEvents?.map((event) => event.kind)).toEqual([
      "run_created",
      "stage_changed",
    ]);

    const reopened = await ProjectAuthorityStore.open({
      stateRoot: path.join(root, "state"),
      projectRoot: root,
      commonDirectory: path.join(root, ".git"),
    });
    const state = await reopened.state();
    const events = parseMonitorEvents(projectMonitorEvents(state, 0, 100));
    expect(events.nextCursor).toBe(2);
    expect(events.events.map((event) => event.sequence)).toEqual([1, 2]);
    const snapshot = parseMonitorSnapshot(
      projectMonitorSnapshot(state, await reopened.listRuns(), 20),
    );
    expect(snapshot).toMatchObject({ revision: 1, eventCursor: 2, totalRuns: 1 });
    expect(snapshot.runs[0]).toMatchObject({
      id: "run-one",
      tokens: { new: 0, cache: 0, total: 0 },
      mergeReady: false,
    });
  });

  it("keeps legacy state readable and advances pages without replaying decisions", () => {
    const state = legacyState();
    appendMonitorEvents(state, [
      {
        at: "2026-07-17T12:00:00.000Z",
        kind: "plan_ready",
        runId: "run-one",
        runRevision: 3,
        title: "Plan ready",
        detail: undefined,
        ticketId: undefined,
      },
    ]);
    const first = parseMonitorEvents(projectMonitorEvents(state, 0, 1));
    expect(first).toMatchObject({ fromCursor: 0, nextCursor: 1, truncated: false });
    const empty = parseMonitorEvents(projectMonitorEvents(state, 1, 1));
    expect(empty.events).toEqual([]);
    expect(empty.nextCursor).toBe(1);
  });

  it("projects actionable change proposals without mutating durable authority state", () => {
    const run = runRecord("/tmp/koni-monitor-proposal");
    run.revision = 7;
    run.tickets["proposal-a"] = {
      id: "proposal-a",
      operationId: "review-upstream-change",
      title: "Revise the storage contract",
      summary: "Allow encrypted drafts before final publication.",
      status: "proposed",
      priority: 2,
      dependencyIds: [],
      targetNodeIds: ["claim-storage"],
      readPaths: [],
      writePaths: [],
      steps: [],
      worktreePath: undefined,
      branch: undefined,
      blocker: undefined,
      createdAt: "2026-07-17T11:58:00.000Z",
      updatedAt: "2026-07-17T11:58:00.000Z",
      executionControl: {
        changeControlScopeNodeIds: ["claim-storage", "constraint-encryption"],
        proposalRequest: {
          requestSha256: rawSha256("proposal-request"),
          sourceTicketId: "ticket-source",
          sourceStepId: "compile",
          sourceOutputSha256: rawSha256("source-output"),
        },
      },
    };
    const before = structuredClone(run);
    const proposal = projectControlProposalInspection(run, run.tickets["proposal-a"]);
    const attention = projectMonitorAttention(run);
    const snapshot = projectMonitorSnapshot(legacyState(), [run], 20);

    expect(proposal).toMatchObject({
      runId: "run-one",
      ticketId: "proposal-a",
      status: "proposed",
      disposition: { kind: "pending" },
      targetNodeIds: ["claim-storage", "constraint-encryption"],
    });
    expect(attention.proposals).toEqual([proposal]);
    expect(snapshot.runs[0]?.proposalCount).toBe(1);
    expect(deriveMonitorEvents(runRecord("/tmp/koni-monitor-proposal"), run)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "proposal_opened",
          ticketId: "proposal-a",
        }),
      ]),
    );
    expect(run).toEqual(before);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-monitor-authority-"));
  roots.push(root);
  return root;
}

function legacyState(): ProjectAuthorityState {
  return {
    protocol: "koni.project-authority-state.v1",
    projectRoot: "/tmp/koni-monitor-projection",
    commonDirectory: "/tmp/koni-monitor-projection/.git",
    revision: 0,
    createdAt: "2026-07-17T12:00:00.000Z",
    updatedAt: "2026-07-17T12:00:00.000Z",
    runIds: [],
    receipts: {},
  };
}

function runRecord(root: string): RunRecord {
  const now = "2026-07-17T12:00:00.000Z";
  return {
    protocol: "koni.run-record.v1",
    id: "run-one",
    revision: 0,
    generation: 0,
    projectRoot: root,
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "0.6.0",
      lineage: "koni.software",
      bundleHash: rawSha256("profile"),
    },
    compiledConfigHash: rawSha256("config"),
    runTypeId: "medium",
    objective: "Build a notes application",
    intake: { goal: "Build a notes application" },
    createdAt: now,
    updatedAt: now,
    lifecycle: newRunLifecycle("run-one"),
    pipelineStageIds: [],
    currentPipelineStageId: undefined,
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(root, "run-one"),
  };
}

function planningRevision(
  revision: number,
  status: PlanningRevisionRecord["status"],
  budgetBaseline: AgentProviderTokenTotals,
): PlanningRevisionRecord {
  return {
    protocol: "koni.planning-revision.v1",
    revision,
    status,
    launchSpecSha256: rawSha256(`launch ${revision}`),
    grantSha256: rawSha256(`grant ${revision}`),
    budgetBaseline,
    budgetPolicy: {
      metric: "new_tokens",
      limit: 20_000,
      synthesisReserve: 2_000,
      synthesisThreshold: 18_000,
      onExhausted: "force_synthesis",
    },
    startedAt: "2026-07-17T12:00:00.000Z",
    artifactSha256: rawSha256(`artifact ${revision}`),
    graphSha256: rawSha256(`graph ${revision}`),
    transcriptSha256: rawSha256(`transcript ${revision}`),
    checkpointPath: `planning/revisions/${revision}/checkpoint.json`,
    completedAt: "2026-07-17T12:01:00.000Z",
  };
}
