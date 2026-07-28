import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AuthorityClientError } from "../src/authority/client.js";
import type { RpcSuccess } from "../src/authority/protocol.js";
import { RunSummaryPageCollector } from "../src/authority/run-summary-page.js";
import { createKoniCoreExtension } from "../src/extension.js";
import { rawSha256 } from "../src/shared/canonical.js";
import { newRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord } from "../src/state/run-record.js";
import {
  createKoniInteractiveReadTools,
  createKoniInteractiveProposalTools,
  type KoniReadAuthorityClient,
} from "../src/pi/interactive-tools.js";
import { createKoniAuthorityTools, KONI_TOOL_RECEIPT_PROTOCOL } from "../src/pi/tool-catalog.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

describe("Pi interactive Koni read tools", () => {
  it("registers inertly and cannot start recovery/provider work when the authority is stopped", async () => {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, unknown>();
    const assertCoreRuntime = vi.fn(async () => undefined);
    const assertPiHost = vi.fn(async () => undefined);
    const connectReadOnly = vi.fn(async () => undefined);
    const ensure = vi.fn(async () => ({ close() {} }));
    const pi = {
      events: {
        on() {
          return () => undefined;
        },
        emit() {},
      },
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
      getCommands: () => [
        {
          name: "koni",
          source: "extension",
          sourceInfo: {
            path: "/koni/extension.js",
            source: "npm:@koni/core",
            scope: "user",
            origin: "package",
          },
        },
      ],
      on() {},
    } as unknown as ExtensionAPI;

    createKoniCoreExtension({ assertCoreRuntime, assertPiHost, connectReadOnly, ensure })(pi);

    expect([...tools.keys()]).toEqual([
      "koni_project_status",
      "koni_run_status",
      "koni_graph_context",
      "koni_ticket_context",
      "koni_agent_transcript",
      "koni_proposal_inspect",
      "koni_proposal_decide",
    ]);
    expect(commands.has("koni")).toBe(true);
    expect(assertCoreRuntime).not.toHaveBeenCalled();
    expect(assertPiHost).not.toHaveBeenCalled();
    expect(connectReadOnly).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();

    await expect(
      tools
        .get("koni_project_status")!
        .execute("status-one", {}, undefined, undefined, trustedContext()),
    ).rejects.toMatchObject({
      code: "authority_stopped",
      message: expect.stringContaining("/koni start"),
    });
    expect(assertCoreRuntime).toHaveBeenCalledOnce();
    expect(assertPiHost).toHaveBeenCalledOnce();
    expect(connectReadOnly).toHaveBeenCalledWith("/project");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("rejects an untrusted project before runtime authentication or authority discovery", async () => {
    const assertAvailable = vi.fn(async () => undefined);
    const connect = vi.fn(async () => clientFor(() => undefined));
    const [status] = createKoniInteractiveReadTools({ version: "1.0.0", assertAvailable, connect });

    await expect(
      status.execute("status-untrusted", {}, undefined, undefined, trustedContext(false)),
    ).rejects.toMatchObject({ code: "project_untrusted" });
    expect(assertAvailable).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("reads sealed status, run, graph, ticket, and explicitly requested transcript projections without exposing paths", async () => {
    const run = fixtureRun();
    const graph = {
      nodes: [
        graphNode("claim-b", "claim", "Cache is bounded"),
        graphNode("claim-a", "claim", "Writes are atomic"),
      ],
      edges: [{ source: "claim-a", relation: "supports", target: "claim-b" }],
    };
    const methods: string[] = [];
    const connect = vi.fn(async () =>
      clientFor((method, params) => {
        methods.push(`${method}:${JSON.stringify(params ?? null)}`);
        if (method === "project.status")
          return {
            projectRoot: "/project",
            version: "1.0.0",
            revision: 8,
            runCount: 1,
          };
        if (method === "run.page") {
          const request = params as { limit: number; includeDeleted?: boolean; cursor?: string };
          const collector = new RunSummaryPageCollector({
            revision: 8,
            limit: request.limit,
            ...(request.includeDeleted === undefined
              ? {}
              : { includeDeleted: request.includeDeleted }),
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          });
          collector.accept(run);
          return collector.finish();
        }
        if (method === "run.get") return run;
        if (method === "run.graph") return graph;
        if (method === "run.transcript") return fixtureTranscript();
        throw new Error(`unexpected method ${method}`);
      }),
    );
    const tools = createKoniInteractiveReadTools({
      version: "1.0.0",
      assertAvailable: vi.fn(async () => undefined),
      connect,
    });

    const project = await tools[0].execute(
      "project",
      { limit: 10 },
      undefined,
      undefined,
      trustedContext(),
    );
    expect(project.details.runs[0]).toMatchObject({
      objective: "Build safe notes",
      tickets: { active: 1, total: 1 },
      agents: { active: 1, total: 1 },
      tokens: { new: 30, cache: 100, total: 130 },
    });
    expect(methods).toContain(`run.page:${JSON.stringify({ limit: 10, includeDeleted: false })}`);
    expect(methods.some((entry) => entry.startsWith("run.list:"))).toBe(false);

    const runStatus = await tools[1].execute(
      "run",
      { runId: run.id },
      undefined,
      undefined,
      trustedContext(),
    );
    expect(runStatus.details).toMatchObject({
      protocol: "koni.interactive-run-status.v2",
      agents: [
        expect.objectContaining({
          persona: "worker",
          model: "openai-codex/gpt-5.6-terra",
          workTitle: "Implement storage",
        }),
      ],
      attention: { awaitingPlanApproval: false, mergeReady: false, pendingQuestions: [] },
      recentActivity: [
        expect.objectContaining({ kind: "graph_added", message: "Added claim: Atomic writes" }),
      ],
    });
    expect(JSON.stringify(runStatus.details)).not.toContain("sessionFile");
    expect(JSON.stringify(runStatus.details)).not.toContain("/sessions/");

    const graphContext = await tools[2].execute(
      "graph",
      {
        runId: run.id,
        nodeIds: ["claim-b", "claim-a"],
        maxNodes: 1,
        maxEdges: 10,
      },
      undefined,
      undefined,
      trustedContext(),
    );
    expect(graphContext.details.nodes.map((node) => node.id)).toEqual(["claim-a"]);
    expect(graphContext.details).toMatchObject({ totals: { nodes: 2, edges: 1 }, truncated: true });
    expect(graphContext.details.edges).toEqual([]);
    expect(graphContext.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("[claim] Writes are atomic"),
    });

    const ticket = await tools[3].execute(
      "ticket",
      {
        runId: run.id,
        ticketId: "ticket-one",
      },
      undefined,
      undefined,
      trustedContext(),
    );
    expect(ticket.details.ticket).toMatchObject({
      title: "Implement storage",
      writePaths: ["src/storage.ts"],
      steps: [expect.objectContaining({ persona: "worker", status: "running" })],
    });
    expect(JSON.stringify(ticket.details)).not.toContain("worktreePath");
    expect(JSON.stringify(ticket.details)).not.toContain("/worktree/");
    expect(methods).toContain(`run.graph:${JSON.stringify({ runId: run.id })}`);
    expect(connect).toHaveBeenCalledTimes(4);

    const transcript = await tools[4].execute(
      "transcript",
      {
        runId: run.id,
        attemptId: "attempt-one",
        limit: 2,
      },
      undefined,
      undefined,
      trustedContext(),
    );
    expect(transcript.details).toMatchObject({
      protocol: "koni.interactive-agent-transcript.v1",
      agent: { id: "attempt-one", persona: "worker" },
      totalBlocks: 3,
      nextCursor: "older-page",
      blocks: [
        expect.objectContaining({ kind: "thinking", markdown: "Preserve atomic writes." }),
        expect.objectContaining({ kind: "assistant", markdown: "I will update the storage seam." }),
      ],
    });
    expect(JSON.stringify(transcript.details)).not.toContain("sessionFile");
    expect(JSON.stringify(transcript.details)).not.toContain("/sessions/");
    expect(methods).toContain(
      `run.transcript:${JSON.stringify({
        runId: run.id,
        attemptId: "attempt-one",
        limit: 2,
      })}`,
    );
    expect(connect).toHaveBeenCalledTimes(5);
  });

  it("projects bounded project rows directly from run.page with exact filter and totals", async () => {
    const runs = [0, 1, 2].map((index) => {
      const run = fixtureRun();
      run.id = `run-${index}`;
      run.revision = index + 1;
      run.objective = `Objective ${index}`;
      run.createdAt = `2026-07-1${index + 1}T00:00:00.000Z`;
      run.updatedAt = run.createdAt;
      if (index === 0) {
        run.lifecycle.phase = "deleted";
        run.lifecycle.runningIntent = false;
      }
      return run;
    });
    const methods: string[] = [];
    const [status] = createKoniInteractiveReadTools({
      version: "1.0.0",
      assertAvailable: vi.fn(async () => undefined),
      connect: async () =>
        clientFor((method, params) => {
          methods.push(method);
          if (method === "project.status")
            return {
              projectRoot: "/project",
              version: "1.0.0",
              revision: 8,
              runCount: runs.length,
            };
          if (method !== "run.page") throw new Error(`unexpected method ${method}`);
          const request = params as { limit: number; includeDeleted?: boolean; cursor?: string };
          const collector = new RunSummaryPageCollector({
            revision: 8,
            limit: request.limit,
            ...(request.includeDeleted === undefined
              ? {}
              : { includeDeleted: request.includeDeleted }),
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          });
          for (const run of runs) collector.accept(run);
          return collector.finish();
        }),
    });

    const result = await status.execute(
      "bounded-status",
      { limit: 2, includeDeleted: true },
      undefined,
      undefined,
      trustedContext(),
    );

    expect(result.details).toMatchObject({ totalRuns: 3, truncated: true });
    expect(result.details.runs).toHaveLength(2);
    expect(result.details.runs.some((run) => run.phase === "deleted")).toBe(false);
    expect(methods).toEqual(["project.status", "run.page"]);
  });
});

describe("Pi interactive Koni change-proposal tools", () => {
  it("inspects the exact bounded proposal without mutation", async () => {
    const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
    const connect = vi.fn(async () => proposalClient(calls, false));
    const [inspect] = createKoniInteractiveProposalTools({
      version: "1.0.0",
      assertAvailable: vi.fn(async () => undefined),
      connect,
    });

    const result = await inspect.execute(
      "inspect-proposal",
      { runId: "run-one", ticketId: "proposal-one" },
      undefined,
      undefined,
      trustedContext(),
    );
    expect(result.details).toMatchObject({
      protocol: "koni.interactive-proposal.v1",
      outcome: "inspected",
      proposal: {
        title: "Revise the storage contract",
        status: "proposed",
        disposition: { kind: "pending" },
      },
    });
    expect(calls).toEqual([
      {
        method: "proposal.inspect",
        params: { runId: "run-one", ticketId: "proposal-one" },
        options: undefined,
      },
    ]);
  });

  it("cancels through Pi confirmation without sending a decision", async () => {
    const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
    const confirm = vi.fn(async () => false);
    const [, decide] = createKoniInteractiveProposalTools({
      version: "1.0.0",
      assertAvailable: vi.fn(async () => undefined),
      connect: async () => proposalClient(calls, false),
    });

    const result = await decide.execute(
      "cancel-proposal",
      {
        runId: "run-one",
        ticketId: "proposal-one",
        decision: "approval",
        message: "Keep the public API stable.",
      },
      undefined,
      undefined,
      trustedContext(true, confirm),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.join("\n")).toContain("Revise the storage contract");
    expect(confirm.mock.calls[0]?.join("\n")).not.toContain("proposal-one");
    expect(confirm.mock.calls[0]?.join("\n")).not.toContain("ticket-source");
    expect(result.details.outcome).toBe("cancelled");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("No decision was sent"),
    });
    expect(calls.map((call) => call.method)).toEqual(["proposal.inspect"]);
  });

  it("records one exact CAS decision after confirmation and never sends an actor", async () => {
    const calls: Array<{ method: string; params: unknown; options: any }> = [];
    const confirm = vi.fn(async () => true);
    const [, decide] = createKoniInteractiveProposalTools({
      version: "1.0.0",
      assertAvailable: vi.fn(async () => undefined),
      connect: async () => proposalClient(calls, true),
    });
    const context = trustedContext(true, confirm);

    const result = await decide.execute(
      "decide-proposal",
      {
        runId: "run-one",
        ticketId: "proposal-one",
        decision: "rejection",
        message: "  Preserve the current storage boundary.  ",
      },
      undefined,
      undefined,
      context,
    );
    expect(result.details).toMatchObject({
      outcome: "decided",
      proposal: {
        status: "completed",
        decision: { decision: "rejection", actor: "operator" },
        disposition: { kind: "rejected" },
      },
    });
    expect(calls.at(-1)).toMatchObject({
      method: "proposal.decide",
      params: {
        runId: "run-one",
        ticketId: "proposal-one",
        decision: "rejection",
        message: "Preserve the current storage boundary.",
      },
      options: {
        expectedRevision: 23,
        idempotencyKey: expect.stringMatching(/^interactive:proposal\.decide:/u),
      },
    });
    expect(calls.at(-1)?.params).not.toHaveProperty("actor");
    const rendered = decide.renderResult!(result, renderOptions(false), plainTheme(), {
      ...renderContext(),
      args: { runId: "run-one", ticketId: "proposal-one", decision: "rejection" },
    })
      .render(120)
      .join("\n");
    expect(rendered).toContain("Proposal rejected");
    expect(rendered).toContain("Revise the storage contract");
    expect(rendered).not.toContain("proposal-one");
  });

  it("refuses noninteractive decisions before connecting to authority", async () => {
    const connect = vi.fn(async () => proposalClient([], true));
    const [, decide] = createKoniInteractiveProposalTools({
      version: "1.0.0",
      assertAvailable: vi.fn(async () => undefined),
      connect,
    });
    const context = {
      ...trustedContext(),
      hasUI: false,
      mode: "print",
    } as unknown as ExtensionContext;
    await expect(
      decide.execute(
        "noninteractive-proposal",
        { runId: "run-one", ticketId: "proposal-one", decision: "approval" },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toMatchObject({ code: "proposal_confirmation_ui" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("refreshes after a revision conflict and never replays the confirmed decision", async () => {
    const calls: Array<{ method: string; params: unknown; options: any }> = [];
    let inspections = 0;
    const client: KoniReadAuthorityClient = {
      revision: 23,
      async request(method, params, options): Promise<RpcSuccess> {
        calls.push({ method, params, options });
        if (method === "proposal.inspect") {
          inspections += 1;
          return {
            type: "response",
            id: `proposal-inspection-${inspections}`,
            ok: true,
            revision: inspections === 1 ? 23 : 24,
            result: proposalProjection(),
          };
        }
        if (method === "proposal.decide") {
          throw new AuthorityClientError("revision_conflict", "proposal changed", { revision: 24 });
        }
        throw new Error(`unexpected method ${method}`);
      },
      close() {},
    };
    const [, decide] = createKoniInteractiveProposalTools({
      version: "1.0.0",
      assertAvailable: vi.fn(async () => undefined),
      connect: async () => client,
    });

    await expect(
      decide.execute(
        "conflicted-proposal",
        { runId: "run-one", ticketId: "proposal-one", decision: "approval" },
        undefined,
        undefined,
        trustedContext(
          true,
          vi.fn(async () => true),
        ),
      ),
    ).rejects.toMatchObject({
      code: "proposal_revision_conflict",
      message: expect.stringContaining("inspect it and confirm"),
    });
    expect(calls.map((call) => call.method)).toEqual([
      "proposal.inspect",
      "proposal.decide",
      "proposal.inspect",
    ]);
  });
});

describe("shared Koni semantic tool rendering", () => {
  it("renders typed graph receipts and concise authority rejections for contained tools", async () => {
    const accepted = createKoniAuthorityTools({
      names: ["koni_graph_context"],
      invoke: async () => ({
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: "receipt-graph",
        outcome: "accepted",
        summary: "Read graph context",
        value: {
          nodes: [graphNode("claim-a", "claim", "Writes are atomic")],
          edges: [{ source: "claim-a", relation: "supports", target: "claim-b" }],
        },
      }),
      reject: async () => {
        throw new Error("not used");
      },
    })[0]!;
    expect(accepted.definition.renderCall).toBeTypeOf("function");
    expect(accepted.definition.renderResult).toBeTypeOf("function");
    const result = await accepted.definition.execute(
      "graph",
      {},
      undefined,
      undefined,
      trustedContext(),
    );
    const rendered = accepted.definition.renderResult!(
      result,
      renderOptions(true),
      plainTheme(),
      renderContext(),
    )
      .render(120)
      .join("\n");
    expect(rendered).toContain("✓ Read graph context");
    expect(rendered).toContain("[claim] Writes are atomic");
    expect(rendered).toContain("claim-a —supports→ claim-b");

    const rejected = createKoniAuthorityTools({
      names: ["koni_read_file"],
      invoke: async () => ({
        protocol: KONI_TOOL_RECEIPT_PROTOCOL,
        receiptId: "receipt-denied",
        outcome: "rejected",
        code: "grant_scope",
        summary: "Read denied by ticket grant",
      }),
      reject: async () => {
        throw new Error("not used");
      },
    })[0]!;
    const rejection = await rejected.definition.execute(
      "read",
      { path: "secrets.txt" },
      undefined,
      undefined,
      trustedContext(),
    );
    const collapsed = rejected.definition.renderResult!(
      rejection,
      renderOptions(false),
      plainTheme(),
      renderContext(),
    )
      .render(120)
      .join("\n");
    expect(collapsed).toContain("✕ Read denied by ticket grant");
    expect(collapsed).toContain("Code: grant_scope");
    expect(collapsed).not.toContain("receipt-denied");
  });
});

function trustedContext(
  trusted = true,
  confirm: (title: string, message: string) => Promise<boolean> = async () => true,
): ExtensionContext {
  return {
    cwd: "/project",
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => trusted,
    ui: { confirm },
  } as unknown as ExtensionContext;
}

function proposalClient(
  calls: Array<{ method: string; params: unknown; options: any }>,
  allowDecision: boolean,
): KoniReadAuthorityClient {
  return {
    revision: 23,
    async request(method, params, options): Promise<RpcSuccess> {
      calls.push({ method, params, options });
      if (method === "proposal.inspect") {
        return {
          type: "response",
          id: "proposal-inspection",
          ok: true,
          revision: 23,
          result: proposalProjection(),
        };
      }
      if (method !== "proposal.decide" || !allowDecision)
        throw new Error(`unexpected method ${method}`);
      const row = params as { decision: "approval" | "rejection"; message?: string };
      const rejected = row.decision === "rejection";
      return {
        type: "response",
        id: "proposal-decision",
        ok: true,
        revision: 24,
        result: {
          ...proposalProjection(),
          status: rejected ? "completed" : "ready",
          decision: {
            decision: row.decision,
            authoritySha256: `sha256:${"9".repeat(64)}`,
            ...(row.message === undefined ? {} : { message: row.message }),
            actor: "operator",
            decidedAt: "2026-07-17T12:00:00.000Z",
          },
          disposition: rejected ? { kind: "rejected" } : { kind: "pending" },
        },
      };
    },
    close() {},
  };
}

function proposalProjection() {
  return {
    runId: "run-one",
    ticketId: "proposal-one",
    sourceTicketId: "ticket-source",
    status: "proposed",
    title: "Revise the storage contract",
    summary: "Permit encrypted drafts while keeping the public notes API stable.",
    targetNodeIds: ["claim-storage"],
    createdAt: "2026-07-17T11:58:00.000Z",
    disposition: { kind: "pending" },
  };
}

function clientFor(result: (method: string, params?: unknown) => unknown): KoniReadAuthorityClient {
  return {
    revision: 8,
    async request(method, params): Promise<RpcSuccess> {
      const value = result(method, params) as RpcSuccess["result"];
      return {
        type: "response",
        id: `response-${method}`,
        ok: true,
        revision: 8,
        ...(value === undefined ? {} : { result: value }),
      };
    },
    close() {},
  };
}

function fixtureRun(): RunRecord {
  const run: RunRecord = {
    protocol: "koni.run-record.v1",
    id: "run-one",
    revision: 2,
    generation: 0,
    projectRoot: "/project",
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "1.0.0",
      lineage: "koni.software",
      bundleHash: rawSha256("profile"),
    },
    compiledConfigHash: rawSha256("config"),
    runTypeId: "medium",
    objective: "Build safe notes",
    intake: { goal: "Build safe notes" },
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:02:00.000Z",
    lifecycle: { ...newRunLifecycle("run-one"), phase: "executing", runningIntent: true },
    pipelineStageIds: ["plan", "approval", "orchestrate", "verify"],
    currentPipelineStageId: "orchestrate",
    plan: {
      revision: 1,
      status: "approved",
      full: {
        architecture: "Use storage seam",
        decisions: "Keep API",
        risk: "Low",
        verification: "Test",
      },
      concise: {
        architecture: [{ title: "Storage seam", description: "Keep persistence isolated." }],
      },
      graphSeed: undefined,
      steeringHistory: [],
    },
    graphRevision: 2,
    graphHash: rawSha256("graph"),
    tickets: {
      "ticket-one": {
        id: "ticket-one",
        operationId: "implement-change",
        title: "Implement storage",
        summary: "Add durable note storage.",
        status: "running",
        priority: 1,
        dependencyIds: [],
        targetNodeIds: ["claim-a"],
        readPaths: ["src/app.ts"],
        writePaths: ["src/storage.ts"],
        steps: [
          {
            id: "implement",
            title: "Implement storage",
            personaId: "worker",
            status: "running",
            attemptIds: ["attempt-one"],
            summary: undefined,
            startedAt: "2026-07-17T00:01:00.000Z",
            completedAt: undefined,
          },
        ],
        worktreePath: "/worktree/ticket-one",
        branch: "refs/heads/koni/ticket-one",
        blocker: undefined,
        createdAt: "2026-07-17T00:00:30.000Z",
        updatedAt: "2026-07-17T00:01:00.000Z",
      },
    },
    attempts: {
      "attempt-one": {
        id: "attempt-one",
        sessionId: "session-one",
        ticketId: "ticket-one",
        stepId: "implement",
        personaId: "worker",
        modelProvider: "openai-codex",
        modelId: "gpt-5.6-terra",
        thinkingLevel: "high",
        status: "running",
        launchSpecHash: rawSha256("launch"),
        sessionFile: "/sessions/private/session-one.jsonl",
        startedAt: "2026-07-17T00:01:00.000Z",
        endedAt: undefined,
        terminalSummary: undefined,
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
      },
    },
    questions: {},
    activity: [
      {
        id: "activity-one",
        at: "2026-07-17T00:01:30.000Z",
        kind: "graph_added",
        message: "Added claim: Atomic writes",
        ticketId: "ticket-one",
        nodeId: "claim-a",
      },
    ],
    git: fixtureRunGit("/project", "run-one", "approved"),
  };
  return run;
}

function fixtureTranscript() {
  return {
    protocol: "koni.pi-transcript-page.v1",
    session: { id: "session-one", version: 3 },
    snapshot: { entryCount: 2, lastEntryId: "entry-assistant", sha256: rawSha256("snapshot") },
    totalBlocks: 3,
    startBlock: 1,
    blocks: [
      {
        id: "entry-assistant:thinking",
        kind: "thinking",
        title: "Reasoning",
        markdown: "Preserve atomic writes.",
        branch: false,
        error: false,
        truncated: false,
      },
      {
        id: "entry-assistant:assistant",
        kind: "assistant",
        title: "Assistant",
        markdown: "I will update the storage seam.",
        branch: false,
        error: false,
        truncated: false,
      },
    ],
    usage: {
      input: "20",
      output: "10",
      cacheRead: "100",
      cacheWrite: "0",
      newTokens: "30",
      allTokens: "130",
    },
    diagnostics: [],
    nextCursor: "older-page",
  };
}

function graphNode(id: string, type: string, title: string) {
  return {
    schema_version: "1.0" as const,
    id,
    type,
    title,
    status: "active",
    spec: { statement: title },
    edges: {},
    annotations: {},
  };
}

function plainTheme(): Theme {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  } as unknown as Theme;
}

function renderOptions(expanded: boolean): ToolRenderResultOptions {
  return { expanded, isPartial: false };
}

function renderContext() {
  return {
    args: {},
    toolCallId: "call",
    invalidate() {},
    lastComponent: undefined as Component | undefined,
    state: {},
    cwd: "/project",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
  };
}
