import { describe, expect, it } from "vitest";
import {
  MAX_RUN_SUMMARY_PAGE_LIMIT,
  MAX_RUN_SUMMARY_PAGE_BYTES,
  RUN_SUMMARY_CURSOR_PROTOCOL,
  RUN_SUMMARY_ORDER,
  RunSummaryPageCollector,
  type RunSummaryPageError,
  parseRunSummaryPage,
  projectRunSummary,
} from "../src/authority/run-summary-page.js";
import { canonicalEncode, canonicalHash } from "../src/shared/canonical.js";
import { newRunLifecycle, type RunPhase } from "../src/state/run-lifecycle.js";
import type { RunRecord, TicketRecord } from "../src/state/run-record.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

describe("bounded run summary pages", () => {
  it("projects the complete terminal-safe row contract without retaining mutation authority", () => {
    const run = fixtureRun("run-summary", "2026-07-18T00:00:00.000Z", "executing");
    run.objective = "Ship the dashboard\n\u001b]8;;https://attacker.invalid\u0007hidden";
    run.runTypeId = "ui_feature";
    run.currentPipelineStageId = "execute-work";
    run.lifecycle.blocker = "wait \u001b[31mred\u001b[0m";
    run.tickets.ticket = fixtureTicket("ticket", "completed");
    run.attempts.worker = fixtureAttempt("worker", "running", 10, 5, 100, 2);
    run.attempts.old = fixtureAttempt("old", "completed", 7, 3, 20, 1);
    const summary = projectRunSummary(run);

    expect(summary).toMatchObject({
      id: "run-summary",
      runRevision: 0,
      objectiveTitle: "Ship the dashboard",
      runTypeId: "ui_feature",
      runType: "Ui feature",
      phase: "executing",
      stageId: "execute-work",
      stage: "Execute work",
      targetRef: "refs/heads/main",
      targetBranch: "main",
      tickets: { completed: 1, active: 0, blocked: 0, total: 1 },
      agents: { active: 1, spending: 1, total: 2 },
      tokens: { new: 25, cached: 123, providerTotal: 148 },
      paused: false,
      provisional: false,
      mergeReady: false,
    });
    expect(summary.objectivePreview).not.toContain("\u001b");
    expect(summary.blocker).toBe("wait red");
  });

  it("counts nominally in-flight tickets and attempts as blocked, never active, in a blocked run", () => {
    const run = fixtureRun("run-blocked", "2026-07-18T00:00:00.000Z", "blocked");
    run.lifecycle.blocker =
      "ticket validation action did not complete with its exact accepted assignment (compensated)";
    run.tickets.ticket = fixtureTicket("ticket", "running");
    run.attempts.worker = fixtureAttempt("worker", "running", 10, 5, 100, 2);
    const summary = projectRunSummary(run);
    expect(summary.tickets).toMatchObject({ active: 0, blocked: 1, total: 1 });
    expect(summary.agents).toMatchObject({ active: 0, spending: 0 });
    expect(summary.phase).toBe("blocked");
  });

  it("does not count a compiler-held source ticket as an actionable blocker", () => {
    const run = fixtureRun("run-source-hold", "2026-07-18T00:00:00.000Z", "executing");
    const held = fixtureTicket("ticket-held", "blocked");
    held.executionControl = {
      sourceHold: {
        proposalTicketId: "proposal-one",
        requestSha256: canonicalHash("proposal request"),
      },
    };
    run.tickets[held.id] = held;

    expect(projectRunSummary(run).tickets).toMatchObject({
      active: 0,
      blocked: 0,
      total: 1,
    });

    const ordinary = fixtureTicket("ticket-ordinary", "blocked");
    run.tickets[ordinary.id] = ordinary;
    expect(projectRunSummary(run).tickets).toMatchObject({
      active: 0,
      blocked: 1,
      total: 2,
    });
  });

  it("round-trips the planner-authored title and the scheduled-pause flag through page parsing", () => {
    const titled = fixtureRun("run-titled", "2026-07-18T00:00:00.000Z", "merging");
    titled.plan = {
      revision: 1,
      status: "approved",
      title: "Dashboard Header Removal",
      full: {},
      concise: {},
      graphSeed: undefined,
      steeringHistory: [],
    };
    titled.pendingPause = { requestedAt: "2026-07-18T00:00:01.000Z" };
    const plain = fixtureRun("run-plain", "2026-07-18T00:00:01.000Z", "executing");

    const collector = new RunSummaryPageCollector({
      revision: 3,
      includeDeleted: false,
      limit: 10,
    });
    collector.accept(plain);
    collector.accept(titled);
    const parsed = parseRunSummaryPage(structuredClone(collector.finish()));
    const titledRow = parsed.runs.find((row) => row.id === "run-titled");
    const plainRow = parsed.runs.find((row) => row.id === "run-plain");
    expect(titledRow).toMatchObject({
      title: "Dashboard Header Removal",
      pausePending: true,
      paused: false,
    });
    expect(plainRow?.title).toBeUndefined();
    expect(plainRow?.pausePending).toBeUndefined();
  });

  it("traverses more than two monitor pages without duplicates or omissions", () => {
    const runs = Array.from({ length: 451 }, (_, index) => {
      const run = fixtureRun(
        `run-${String(index).padStart(4, "0")}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        index % 7 === 0 ? "deleted" : "paused",
      );
      run.revision = index % 11;
      return run;
    });
    const expected = runs
      .filter((run) => run.lifecycle.phase !== "deleted")
      .sort(runOrder)
      .map((run) => run.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const collector = new RunSummaryPageCollector({
        revision: 41,
        limit: 73,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const run of [...runs].reverse()) collector.accept(run);
      expect(collector.retainedSummaryCount()).toBeLessThanOrEqual(74);
      const page = parseRunSummaryPage(collector.finish());
      expect(page.totalRuns).toBe(expected.length);
      expect(page.startIndex).toBe(seen.length);
      seen.push(...page.runs.map((run) => run.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("uses id ascending as the deterministic tie-breaker", () => {
    const ids = ["run-z", "run-Z", "run._", "run--", "run-a"];
    const runs = ids.map((id) => fixtureRun(id, "2026-07-18T00:00:00.000Z"));
    const collector = new RunSummaryPageCollector({ revision: 1, limit: ids.length });
    for (const run of runs) collector.accept(run);
    expect(collector.finish().runs.map((run) => run.id)).toEqual(
      [...ids].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    );
  });

  it("binds cursors to the exact authority revision", () => {
    const runs = [
      fixtureRun("run-a", "2026-07-18T00:00:02.000Z"),
      fixtureRun("run-b", "2026-07-18T00:00:01.000Z"),
    ];
    const first = new RunSummaryPageCollector({ revision: 8, limit: 1 });
    runs.forEach((run) => first.accept(run));
    const cursor = first.finish().nextCursor!;
    expect(() => new RunSummaryPageCollector({ revision: 9, limit: 1, cursor })).toThrowError(
      expect.objectContaining({ code: "run_page_stale" }),
    );
  });

  it("rejects cursor reuse under a different deleted-run filter", () => {
    const runs = [
      fixtureRun("run-a", "2026-07-18T00:00:02.000Z"),
      fixtureRun("run-b", "2026-07-18T00:00:01.000Z"),
    ];
    const first = new RunSummaryPageCollector({ revision: 8, limit: 1, includeDeleted: true });
    runs.forEach((run) => first.accept(run));
    expect(
      () =>
        new RunSummaryPageCollector({
          revision: 8,
          limit: 1,
          includeDeleted: false,
          cursor: first.finish().nextCursor!,
        }),
    ).toThrowError(expect.objectContaining({ code: "run_page_cursor" }));
  });

  it("rejects both byte tampering and a re-signed boundary absent from the snapshot", () => {
    const runs = [
      fixtureRun("run-a", "2026-07-18T00:00:02.000Z"),
      fixtureRun("run-b", "2026-07-18T00:00:01.000Z"),
    ];
    const first = new RunSummaryPageCollector({ revision: 8, limit: 1 });
    runs.forEach((run) => first.accept(run));
    const cursor = first.finish().nextCursor!;
    expect(
      () => new RunSummaryPageCollector({ revision: 8, limit: 1, cursor: `${cursor}x` }),
    ).toThrowError(expect.objectContaining({ code: "run_page_cursor" }));

    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const material = {
      protocol: RUN_SUMMARY_CURSOR_PROTOCOL,
      revision: decoded.revision,
      order: RUN_SUMMARY_ORDER,
      includeDeleted: decoded.includeDeleted,
      direction: decoded.direction,
      lastCreatedAt: decoded.lastCreatedAt,
      lastRunId: "run-absent",
      lastRunRevision: decoded.lastRunRevision,
    };
    const forged = Buffer.from(
      canonicalEncode({ ...material, sha256: canonicalHash(material) }),
      "utf8",
    ).toString("base64url");
    const collector = new RunSummaryPageCollector({ revision: 8, limit: 1, cursor: forged });
    runs.forEach((run) => collector.accept(run));
    expect(() => collector.finish()).toThrowError(
      expect.objectContaining({ code: "run_page_cursor" }),
    );
  });

  it("rejects non-canonical page and cursor timestamps", () => {
    const noncanonical = fixtureRun("run-time", "2026-07-18T00:00:00.000Z");
    noncanonical.createdAt = "2026-07-18T00:00:00Z";
    const invalidPage = new RunSummaryPageCollector({ revision: 1, limit: 1 });
    expect(() => invalidPage.accept(noncanonical)).toThrow(/created time is invalid/u);

    const runs = [
      fixtureRun("run-a", "2026-07-18T00:00:02.000Z"),
      fixtureRun("run-b", "2026-07-18T00:00:01.000Z"),
    ];
    const first = new RunSummaryPageCollector({ revision: 3, limit: 1 });
    runs.forEach((run) => first.accept(run));
    const decoded = JSON.parse(
      Buffer.from(first.finish().nextCursor!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const material = {
      protocol: RUN_SUMMARY_CURSOR_PROTOCOL,
      revision: decoded.revision,
      order: RUN_SUMMARY_ORDER,
      includeDeleted: decoded.includeDeleted,
      direction: decoded.direction,
      lastCreatedAt: "2026-07-18T00:00:02Z",
      lastRunId: decoded.lastRunId,
      lastRunRevision: decoded.lastRunRevision,
    };
    const cursor = Buffer.from(
      canonicalEncode({ ...material, sha256: canonicalHash(material) }),
      "utf8",
    ).toString("base64url");
    expect(() => new RunSummaryPageCollector({ revision: 3, limit: 1, cursor })).toThrowError(
      expect.objectContaining({ code: "run_page_cursor" }),
    );
  });

  it("fits 200 maximum-width compact projections below the proven page frame budget", () => {
    const collector = new RunSummaryPageCollector({ revision: 12, limit: 200 });
    for (let index = 0; index < 200; index += 1) {
      const run = fixtureRun(
        `run-${String(index).padStart(4, "0")}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        "failed",
      );
      run.objective = "🧪".repeat(1_024);
      run.lifecycle.blocker = "🛑".repeat(1_024);
      run.lifecycle.terminalReason = "💥".repeat(1_024);
      run.currentPipelineStageId = "s".repeat(256);
      run.git.target.ref = `refs/heads/${Array.from({ length: 8 }, () => "b".repeat(120)).join("/")}`;
      collector.accept(run);
    }
    const page = collector.finish();
    expect(page.runs).toHaveLength(200);
    expect(Buffer.byteLength(canonicalEncode(page), "utf8")).toBeLessThan(
      MAX_RUN_SUMMARY_PAGE_BYTES,
    );
  });

  it("keeps only fixed compact top-K state for arbitrarily many valid records", () => {
    const collector = new RunSummaryPageCollector({
      revision: 5,
      limit: MAX_RUN_SUMMARY_PAGE_LIMIT,
    });
    for (let index = 0; index < 10_000; index += 1) {
      collector.accept(
        fixtureRun(
          `run-${String(index).padStart(5, "0")}`,
          new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        ),
      );
      expect(collector.retainedSummaryCount()).toBeLessThanOrEqual(MAX_RUN_SUMMARY_PAGE_LIMIT + 1);
    }
    const page = collector.finish();
    expect(page.runs).toHaveLength(MAX_RUN_SUMMARY_PAGE_LIMIT);
    expect(page.totalRuns).toBe(10_000);
    expect(page.startIndex).toBe(0);
    expect(page.nextCursor).toBeDefined();
  });

  it("navigates adjacent pages in both directions while retaining only one bounded page", () => {
    const runs = Array.from({ length: 23 }, (_, index) =>
      fixtureRun(
        `run-${String(index).padStart(2, "0")}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      ),
    );
    const collect = (cursor?: string) => {
      const collector = new RunSummaryPageCollector({
        revision: 19,
        limit: 7,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const run of [...runs].reverse()) collector.accept(run);
      expect(collector.retainedSummaryCount()).toBeLessThanOrEqual(8);
      return parseRunSummaryPage(collector.finish());
    };

    const first = collect();
    const second = collect(first.nextCursor);
    const third = collect(second.nextCursor);
    expect([first.startIndex, second.startIndex, third.startIndex]).toEqual([0, 7, 14]);
    expect(second.previousCursor).toBeDefined();
    expect(collect(second.previousCursor)).toEqual(first);
    expect(collect(third.previousCursor)).toEqual(second);
  });

  it("locates a selected later-page run in one bounded anchored projection", () => {
    const runs = Array.from({ length: 451 }, (_, index) =>
      fixtureRun(
        `run-${String(index).padStart(4, "0")}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      ),
    );
    const target = runs[137]!;
    const collector = new RunSummaryPageCollector({
      revision: 22,
      limit: 50,
      around: { id: target.id, createdAt: target.createdAt, runRevision: target.revision },
    });
    for (const run of [...runs].reverse()) collector.accept(run);
    const page = parseRunSummaryPage(collector.finish());
    expect(page.startIndex).toBe(451 - 1 - 137);
    expect(page.runs[0]?.id).toBe(target.id);
    expect(page.previousCursor).toBeDefined();
    expect(page.nextCursor).toBeDefined();
    expect(collector.retainedSummaryCount()).toBeLessThanOrEqual(51);
  });

  it("rejects limits outside the finite page contract", () => {
    for (const limit of [0, -1, 1.5, MAX_RUN_SUMMARY_PAGE_LIMIT + 1, Number.MAX_SAFE_INTEGER]) {
      expect(() => new RunSummaryPageCollector({ revision: 0, limit })).toThrowError(
        expect.objectContaining({ code: "run_page_limit" } satisfies Partial<RunSummaryPageError>),
      );
    }
  });
});

function fixtureRun(id: string, createdAt: string, phase: RunPhase = "planning"): RunRecord {
  const lifecycle = newRunLifecycle(id);
  lifecycle.phase = phase;
  lifecycle.runningIntent = ["planning", "executing", "verifying"].includes(phase);
  lifecycle.activeSinceMs = lifecycle.runningIntent ? Date.parse(createdAt) : undefined;
  return {
    protocol: "koni.run-record.v1",
    id,
    revision: 0,
    generation: 0,
    projectRoot: "/project",
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "1.0.0",
      lineage: "koni.software",
      bundleHash: `sha256:${"a".repeat(64)}`,
    },
    compiledConfigHash: `sha256:${"b".repeat(64)}`,
    runTypeId: "medium",
    objective: `Objective for ${id}`,
    intake: { goal: `Objective for ${id}` },
    createdAt,
    updatedAt: createdAt,
    lifecycle,
    pipelineStageIds: ["planning", "execute-work"],
    currentPipelineStageId: "planning",
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit("/project", id),
  };
}

function fixtureTicket(id: string, status: TicketRecord["status"]): TicketRecord {
  return {
    id,
    operationId: "implement",
    title: "Implement",
    summary: "Implement",
    status,
    priority: 0,
    dependencyIds: [],
    targetNodeIds: [],
    readPaths: [],
    writePaths: [],
    steps: [],
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}

function fixtureAttempt(
  id: string,
  status: RunRecord["attempts"][string]["status"],
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): RunRecord["attempts"][string] {
  return {
    id,
    sessionId: `session-${id}`,
    ticketId: "ticket",
    stepId: "work",
    personaId: "worker",
    modelProvider: "openai-codex",
    modelId: "model",
    thinkingLevel: "medium",
    status,
    launchSpecHash: `sha256:${"c".repeat(64)}`,
    sessionFile: undefined,
    startedAt: "2026-07-18T00:00:00.000Z",
    endedAt: status === "completed" ? "2026-07-18T00:00:01.000Z" : undefined,
    terminalSummary: undefined,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function runOrder(left: RunRecord, right: RunRecord): number {
  return (
    Buffer.compare(Buffer.from(right.createdAt), Buffer.from(left.createdAt)) ||
    Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))
  );
}
