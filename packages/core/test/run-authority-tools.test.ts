import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityClient } from "../src/authority/client.js";
import { AuthorityRpcError } from "../src/authority/server.js";
import {
  authorityRevisionStateHash,
  RunAuthorityEngine,
  type RunCompilerProgram,
} from "../src/authority/run-engine.js";
import type { AuthorityGrant } from "../src/authority/grants.js";
import {
  AGENT_LAUNCH_SPEC_PROTOCOL,
  computeLaunchResourceSetHash,
  createAgentLaunchSpec,
  type AgentLaunchSpec,
} from "../src/pi/launch-spec.js";
import type {
  AuthorityBackedTool,
  ManagedPiSessionFactory,
  PiSessionAdapter,
} from "../src/pi/managed-session.js";
import { ManagedSessionSupervisor } from "../src/pi/supervisor.js";
import {
  koniToolMaxResultBytes,
  koniToolSchemaHash,
  type KoniToolName,
} from "../src/pi/tool-catalog.js";
import { canonicalHash, rawSha256 } from "../src/shared/canonical.js";
import { runBehaviorSnapshotFixture } from "./fixtures/compiled-behavior.js";

const roots: string[] = [];
const engines: RunAuthorityEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run authority model tools", () => {
  it("enforces the planning repository-call ceiling while a durable question waits without provider turns", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: questionProgram(),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Choose and build",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Choose and build" },
      },
      { expectedRevision: 0, idempotencyKey: "create-question-run" },
    );
    const runId = (created.result as { runId: string }).runId;

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked") {
        throw new Error(`question run blocked: ${current.lifecycle.blocker ?? "unknown blocker"}`);
      }
      return current.lifecycle.phase === "awaiting_questions";
    });
    const waiting = await engine.store.getRun(runId);
    const question = Object.values(waiting.questions)[0]!;
    const batch = Object.values(waiting.questionBatches ?? {})[0]!;
    expect(question.prompt).toBe("Which behavior should be primary?");
    expect(question.batchId).toBe(batch.id);
    expect(question.scope).toBe("run");
    expect(batch.scope).toBe("run");
    expect(batch.ticketId).toBeUndefined();
    expect(Object.values(waiting.attempts)[0]!.status).toBe("waiting_question");
    expect(waiting.plan).toBeUndefined();

    await client.request("authority.ping");
    const saved = await client.request(
      "question.answer",
      {
        runId,
        batchId: batch.id,
        questionId: question.id,
        expectedVersion: batch.version,
        selectedOptionId: "recommended",
        notes: "Keep the fallback too.",
      },
      { expectedRevision: client.revision, idempotencyKey: "answer-question" },
    );
    const savedVersion = (saved.result as { batchVersion: number }).batchVersion;
    const stillWaiting = await engine.store.getRun(runId);
    expect(stillWaiting.lifecycle.phase).toBe("awaiting_questions");
    expect(stillWaiting.attempts[batch.attemptId]!.status).toBe("waiting_question");
    await client.request(
      "question.resolve",
      {
        runId,
        batchId: batch.id,
        expectedVersion: savedVersion,
      },
      { expectedRevision: client.revision, idempotencyKey: "resolve-question-batch" },
    );
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return (
        current.lifecycle.phase === "awaiting_approval" &&
        Object.values(current.attempts)[0]?.status === "waiting_plan_review"
      );
    });
    const planned = await engine.store.getRun(runId);
    expect(Object.values(planned.attempts)[0]!.status).toBe("waiting_plan_review");
    expect(planned.plan?.concise.decisions?.[0]?.title).toBe("Use recommendation");
    expect(
      Object.values(planned.attempts)[0]!.authorityToolResults?.filter(
        (result) => result.toolName === "koni_read_file",
      ),
    ).toEqual([
      expect.objectContaining({ callId: "read-one", outcome: "accepted" }),
      expect.objectContaining({ callId: "read-two", outcome: "rejected" }),
    ]);
    client.close();
  });

  it("rejects blind large-file pagination and permits search-bound targeted reads", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: questionProgram("bounded-read"),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Read one large source seam efficiently",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Read one large source seam efficiently" },
      },
      { expectedRevision: 0, idempotencyKey: "create-bounded-read-run" },
    );
    const runId = (created.result as { runId: string }).runId;

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked") {
        throw new Error(
          `bounded read run blocked: ${current.lifecycle.blocker ?? "unknown blocker"}`,
        );
      }
      return current.lifecycle.phase === "awaiting_approval";
    });
    const planned = await engine.store.getRun(runId);
    const results = Object.values(planned.attempts)[0]!.authorityToolResults ?? [];
    expect(results.map((result) => [result.callId, result.toolName, result.outcome])).toEqual([
      ["large-first-page", "koni_read_file", "accepted"],
      ["large-duplicate-first-page", "koni_read_file", "rejected"],
      ["large-oversized-page", "koni_read_file", "rejected"],
      ["large-blind-page", "koni_read_file", "rejected"],
      ["large-search", "koni_search_files", "accepted"],
      ["large-targeted-page", "koni_read_file", "accepted"],
      ["large-outside-search-window", "koni_read_file", "rejected"],
      ["large-submit", "koni_submit_output", "accepted"],
    ]);
    client.close();
  });

  it("records a correctable discovery denial as a durable model-visible rejection", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: questionProgram("correctable-rejection"),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Recover from one correctable discovery denial",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Recover from one correctable discovery denial" },
      },
      { expectedRevision: 0, idempotencyKey: "create-correctable-rejection-run" },
    );
    const runId = (created.result as { runId: string }).runId;

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked") {
        throw new Error(
          `correctable rejection run blocked: ${current.lifecycle.blocker ?? "unknown blocker"}`,
        );
      }
      return current.lifecycle.phase === "awaiting_approval";
    });
    const planned = await engine.store.getRun(runId);
    expect(Object.values(planned.attempts)[0]!.authorityToolResults).toEqual([
      expect.objectContaining({
        callId: "out-of-scope-search",
        toolName: "koni_search_files",
        outcome: "rejected",
      }),
      expect.objectContaining({
        callId: "rejection-submit",
        toolName: "koni_submit_output",
        outcome: "accepted",
      }),
    ]);
    client.close();
  });

  it("records an absent in-scope file as a durable model-visible rejection", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: questionProgram("missing-read-rejection"),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Continue after one absent optional file",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Continue after one absent optional file" },
      },
      { expectedRevision: 0, idempotencyKey: "create-missing-read-rejection-run" },
    );
    const runId = (created.result as { runId: string }).runId;

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked") {
        throw new Error(`missing read run blocked: ${current.lifecycle.blocker ?? "unknown"}`);
      }
      return current.lifecycle.phase === "awaiting_approval";
    });
    const planned = await engine.store.getRun(runId);
    expect(Object.values(planned.attempts)[0]!.authorityToolResults).toEqual([
      expect.objectContaining({
        callId: "missing-optional-file",
        toolName: "koni_read_file",
        outcome: "rejected",
      }),
      expect.objectContaining({
        callId: "missing-read-submit",
        toolName: "koni_submit_output",
        outcome: "accepted",
      }),
    ]);
    client.close();
  });

  it("rolls back rejected compiler mutations and leaves integrity errors fatal", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: questionProgram("rejection-boundary"),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const objective = "Reject without leaking compiler state";
    const created = await client.request(
      "run.create",
      {
        objective,
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: objective },
      },
      { expectedRevision: 0, idempotencyKey: "create-rejection-boundary-run" },
    );
    const runId = (created.result as { runId: string }).runId;

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "blocked");
    const blocked = await engine.store.getRun(runId);
    expect(blocked.lifecycle.blocker).toContain("compiler-issued resource bytes changed");
    expect(blocked.objective).toBe(objective);
    expect(Object.values(blocked.attempts)[0]!.authorityToolResults).toEqual([
      expect.objectContaining({
        callId: "rollback-rejection",
        toolName: "koni_record_note",
        outcome: "rejected",
      }),
    ]);
    client.close();
  });

  it("records a correctable workspace denial without applying the write", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: questionProgram("workspace-rejection"),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Continue after a denied workspace write",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Continue after a denied workspace write" },
      },
      { expectedRevision: 0, idempotencyKey: "create-workspace-rejection-run" },
    );
    const runId = (created.result as { runId: string }).runId;

    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked") {
        throw new Error(
          `workspace rejection run blocked: ${current.lifecycle.blocker ?? "unknown"}`,
        );
      }
      return current.lifecycle.phase === "awaiting_approval";
    });
    const planned = await engine.store.getRun(runId);
    expect(Object.values(planned.attempts)[0]!.authorityToolResults).toEqual([
      expect.objectContaining({
        callId: "out-of-scope-write",
        toolName: "koni_write_file",
        outcome: "rejected",
      }),
      expect.objectContaining({
        callId: "workspace-rejection-submit",
        toolName: "koni_submit_output",
        outcome: "accepted",
      }),
    ]);
    client.close();
  });

  it("reads an immutable skill by its Pi-relative path", async () => {
    const root = await repository();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: questionProgram("resource-read"),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });
    const created = await client.request(
      "run.create",
      {
        objective: "Read one skill",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Read one skill" },
      },
      { expectedRevision: 0, idempotencyKey: "create-resource-read-run" },
    );
    const runId = (created.result as { runId: string }).runId;
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked") {
        throw new Error(`resource read run blocked: ${current.lifecycle.blocker ?? "unknown"}`);
      }
      return current.lifecycle.phase === "awaiting_approval";
    });
    const run = await engine.store.getRun(runId);
    expect(Object.values(run.attempts)[0]!.authorityToolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callId: "skill-by-path", outcome: "accepted" }),
      ]),
    );
    client.close();
  });
});

function questionProgram(
  mode:
    | "question"
    | "bounded-read"
    | "resource-read"
    | "correctable-rejection"
    | "missing-read-rejection"
    | "rejection-boundary"
    | "workspace-rejection" = "question",
): RunCompilerProgram {
  const terminalSchema = Type.Object({ result: Type.String() }, { additionalProperties: false });
  const names: KoniToolName[] =
    mode === "bounded-read"
      ? ["koni_read_file", "koni_search_files", "koni_submit_output"]
      : mode === "resource-read"
        ? ["koni_read_resource", "koni_submit_output"]
        : mode === "correctable-rejection"
          ? ["koni_search_files", "koni_submit_output"]
          : mode === "missing-read-rejection"
            ? ["koni_read_file", "koni_submit_output"]
            : mode === "rejection-boundary"
              ? ["koni_record_note", "koni_submit_output"]
              : mode === "workspace-rejection"
                ? ["koni_write_file", "koni_submit_output"]
                : ["koni_read_file", "koni_ask_question", "koni_submit_output"];
  return {
    async resolveRun(request) {
      return {
        profile: {
          packageName: "@koni/coding-profile",
          packageVersion: "0.6.0",
          lineage: "koni.software",
          bundleHash: `sha256:${"a".repeat(64)}`,
        },
        compiledConfigHash: `sha256:${"b".repeat(64)}`,
        runTypeId: request.runTypeId,
        objective: request.objective,
        intake: request.intake,
        behavior: runBehaviorSnapshotFixture(request.runTypeId, "software"),
        workingSpecOwnerId: "lead",
        planningMode: "agent",
        pipelineStageIds: ["plan", "approval", "orchestrate", "verification", "promotion"],
        pipelineStages: [
          { id: "plan", title: "Plan", kind: "planning", automatic: true },
          { id: "approval", title: "Approval", kind: "approval", automatic: false },
          { id: "orchestrate", title: "Orchestrate", kind: "orchestration", automatic: true },
          { id: "verification", title: "Verification", kind: "checkpoint", automatic: true },
          { id: "promotion", title: "Promotion", kind: "promotion", automatic: false },
        ],
        executionConfig: {
          maxParallel: 1,
          questionPolicy: "some",
          instructions: "Ask one material question.",
          agents: {
            lead: { provider: "test", model: "test-model", thinkingLevel: "off" },
          },
        },
      };
    },
    async initializeDirectApproval() {
      throw new Error("not used");
    },
    async prepareAttempt(input) {
      const resources =
        mode === "resource-read"
          ? [
              {
                kind: "skill" as const,
                id: "skill-using-superpowers",
                relativePath: "skills/using-superpowers/SKILL.md",
                content: "Use relevant skills before acting.",
                sha256: rawSha256("Use relevant skills before acting."),
                sizeBytes: Buffer.byteLength("Use relevant skills before acting.", "utf8"),
              },
            ]
          : [];
      const context = "Compiler-bound planning context";
      const grant: AuthorityGrant = {
        protocol: "koni.authority-grant.v1",
        grantId: `grant-${input.attemptId}`,
        runId: input.run.id,
        ticketId: "run-planning",
        stepId: "plan",
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        epoch: 1,
        generation: input.run.generation,
        allowedTools: names,
        readPaths:
          mode === "bounded-read"
            ? ["large.ts"]
            : mode === "missing-read-rejection"
              ? ["optional/AGENTS.md"]
              : ["README.md"],
        writePaths: mode === "workspace-rejection" ? ["notes.txt"] : [],
        expectedRevision: input.nextAuthorityRevision,
        expectedStateHash: input.expectedAuthorityStateHash,
      };
      expect(grant.expectedStateHash).toBe(
        authorityRevisionStateHash(input.run.projectRoot, input.nextAuthorityRevision),
      );
      const systemPrompt = "Ask once, wait for the answer, then submit.";
      const initialPrompt = "Plan the run.";
      const spec = createAgentLaunchSpec({
        protocol: AGENT_LAUNCH_SPEC_PROTOCOL,
        issuedAt: new Date().toISOString(),
        identity: {
          runId: input.run.id,
          ticketId: "run-planning",
          stepId: "plan",
          attemptId: input.attemptId,
          sessionId: input.sessionId,
        },
        lineage: input.lineage,
        ...(input.kind !== "planning" || input.run.planningSession === undefined
          ? {}
          : {
              planningRevision: {
                revision: 0,
                baseRevision: null,
                priorCheckpointSha256: null,
                steeringSha256: null,
                budgetBaseline: structuredClone(
                  input.run.planningSession.revisions[0]!.budgetBaseline,
                ),
              },
            }),
        authority: {
          grantId: grant.grantId,
          grantHash: canonicalHash(grant),
          generation: grant.generation,
          epoch: grant.epoch,
          expectedRevision: grant.expectedRevision,
          expectedStateHash: grant.expectedStateHash as `sha256:${string}`,
          authoritativeContextHash: rawSha256(context),
        },
        workspace: {
          cwd: input.run.git.planning.worktree,
          sessionDirectory: path.join(input.run.projectRoot, ".koni-sessions", input.attemptId),
        },
        persona: {
          id: "run-planner",
          systemPrompt,
          systemPromptHash: rawSha256(systemPrompt),
          initialPrompt,
          initialPromptHash: rawSha256(initialPrompt),
        },
        model: {
          provider: "openai-codex",
          id: "test-model",
          api: "openai-codex-responses",
          catalogMaxTokens: 128_000,
          catalogSha256: rawSha256("test-model-catalog"),
          thinkingLevel: "high",
        },
        tools: names.map((name) => ({
          name,
          schemaHash: koniToolSchemaHash(name, terminalSchema),
          executionMode:
            name === "koni_read_file" ||
            name === "koni_read_resource" ||
            name === "koni_search_files"
              ? ("parallel" as const)
              : ("sequential" as const),
          maxResultBytes: koniToolMaxResultBytes(name),
        })),
        resources: { setHash: computeLaunchResourceSetHash(resources), entries: resources },
        budgets: {
          tokens: {
            maxInput: 10_000,
            maxOutput: 10_000,
            maxCacheRead: 10_000,
            maxCacheWrite: 10_000,
            maxNew: 20_000,
            maxAll: 40_000,
            providerOutputHeadroom: 128_000,
          },
          transcript: { maxBytes: 64 * 1024 * 1024 },
          retries: { maxProviderRetries: 0, baseDelayMs: 0 },
          repositoryCalls: { max: mode === "bounded-read" ? 10 : 1 },
        },
        terminal: {
          toolName: "koni_submit_output",
          outputSchemaHash: canonicalHash(terminalSchema),
          maxOutputBytes: 64 * 1024,
        },
      });
      return {
        spec,
        authorityGrant: grant,
        toolNames: names,
        terminalOutputSchema: terminalSchema,
        contextContent: context,
        compactionSnapshot: {
          objective: input.run.objective,
          plan: {
            architecture: "Pending",
            decisions: "Pending",
            risk: "Pending",
            verification: "Pending",
          },
          graphRefs: [],
          touchedFiles: [],
          receiptIds: [],
          checkIds: [],
          unresolvedQuestions: [],
          nextAction: "Plan the run",
        },
        factory: (async (_spec, options) =>
          mode === "bounded-read"
            ? new BoundedReadAdapter(spec, options.tools)
            : mode === "resource-read"
              ? new ResourceReadAdapter(spec, options.tools)
              : mode === "question"
                ? new QuestionAdapter(spec, options.tools)
                : new RejectionAdapter(
                    spec,
                    options.tools,
                    mode,
                  )) satisfies ManagedPiSessionFactory,
      };
    },
    async compilePlanningOutput() {
      return {
        plan: {
          revision: 0,
          status: "planning",
          full: {
            architecture: "## Architecture\nUse the existing seam.",
            decisions: "## Decisions\nUse the recommended behavior.",
            risk: "## Risk\nBounded.",
            verification: "## Verification\nRun the focused proof.",
          },
          concise: {
            architecture: [{ title: "Existing seam", description: "Keep ownership stable." }],
            decisions: [{ title: "Use recommendation", description: "Retain the fallback too." }],
            risk: [{ title: "Bounded", description: "No migration." }],
            verification: [{ title: "Focused proof", description: "Exercise both paths." }],
          },
          graphSeed: { objective: "question-run" },
          steeringHistory: [],
        },
      };
    },
    async initializeApprovedPlan() {
      throw new Error("not used");
    },
    async executeAgentTool({ run, call }) {
      if (mode !== "rejection-boundary") throw new Error("not used");
      if (call.callId === "rollback-rejection") {
        run.objective = "LEAKED REJECTED MUTATION";
        throw new AuthorityRpcError("read_page_size", "Correctable compiler denial");
      }
      throw new AuthorityRpcError("resource_hash", "compiler-issued resource bytes changed");
    },
    async compileAssignmentOutput() {
      throw new Error("not used");
    },
    async verifyRun() {
      return { ok: true };
    },
    async createIntegrationTicket() {
      throw new Error("not used");
    },
  };
}

class QuestionAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #abort = new AbortController();

  public constructor(
    private readonly spec: Readonly<AgentLaunchSpec>,
    private readonly tools: readonly AuthorityBackedTool[],
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return this.tools.map((tool) => tool.name);
  }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    const readTool = this.tool("koni_read_file");
    const readArgs = { path: "README.md", offset: 0, maxBytes: 4_096 };
    const firstRead = await readTool.execute("read-one", readArgs, this.#abort.signal);
    const replayedRead = await readTool.execute("read-one", readArgs, this.#abort.signal);
    if (JSON.stringify(replayedRead) !== JSON.stringify(firstRead)) {
      throw new Error("idempotent repository replay changed its accepted result");
    }
    const deniedRead = await readTool.execute("read-two", readArgs, this.#abort.signal);
    expect(deniedRead.details).toMatchObject({
      outcome: "rejected",
      code: "duplicate_repository_discovery",
    });
    const questionArgs = {
      prompt: "Which behavior should be primary?",
      options: [
        { id: "recommended", label: "Recommended", description: "Use the new behavior first." },
        { id: "legacy", label: "Legacy", description: "Keep the old behavior first." },
      ],
      allowsNotes: true,
      recommendedOptionId: "recommended",
      impact: "high_impact",
    };
    this.emit({
      type: "tool_execution_start",
      toolCallId: "ask",
      toolName: "koni_ask_question",
      args: questionArgs,
    });
    const questionResult = await this.tool("koni_ask_question").execute(
      "ask",
      questionArgs,
      this.#abort.signal,
    );
    this.emit({
      type: "tool_execution_end",
      toolCallId: "ask",
      toolName: "koni_ask_question",
      result: questionResult,
      isError: false,
    });
    const terminalArgs = { result: "planned-after-answer" };
    this.emit({
      type: "tool_execution_start",
      toolCallId: "submit",
      toolName: "koni_submit_output",
      args: terminalArgs,
    });
    const terminalResult = await this.tool("koni_submit_output").execute(
      "submit",
      terminalArgs,
      this.#abort.signal,
    );
    this.emit({
      type: "tool_execution_end",
      toolCallId: "submit",
      toolName: "koni_submit_output",
      result: terminalResult,
      isError: false,
    });
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {
    this.#abort.abort();
  }
  public dispose(): void {}
  private tool(name: KoniToolName): AuthorityBackedTool {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`missing authority tool ${name}`);
    return tool;
  }
  private emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

class BoundedReadAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #abort = new AbortController();

  public constructor(
    private readonly spec: Readonly<AgentLaunchSpec>,
    private readonly tools: readonly AuthorityBackedTool[],
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return this.tools.map((tool) => tool.name);
  }
  public appendMapping(): void {}
  public subscribe(): () => void {
    return () => {};
  }
  public async prompt(): Promise<void> {
    const read = this.tool("koni_read_file");
    const first = (await read.execute(
      "large-first-page",
      { path: "large.ts", offset: 0, maxBytes: 32 * 1024 },
      this.#abort.signal,
    )) as { details?: { value?: { sizeBytes?: number; eof?: boolean } } };
    expect(first.details?.value).toMatchObject({ sizeBytes: expect.any(Number), eof: false });
    const duplicate = await read.execute(
      "large-duplicate-first-page",
      { path: "large.ts", offset: 0, maxBytes: 32 * 1024 },
      this.#abort.signal,
    );
    expect(duplicate.details).toMatchObject({
      outcome: "rejected",
      code: "duplicate_repository_discovery",
    });
    const oversized = await read.execute(
      "large-oversized-page",
      { path: "large.ts", offset: 0, maxBytes: 32 * 1024 + 1 },
      this.#abort.signal,
    );
    expect(oversized.details).toMatchObject({ outcome: "rejected", code: "read_page_size" });
    const blind = await read.execute(
      "large-blind-page",
      { path: "large.ts", offset: 32 * 1024, maxBytes: 32 * 1024 },
      this.#abort.signal,
    );
    expect(blind.details).toMatchObject({ outcome: "rejected", code: "read_search_required" });

    const search = (await this.tool("koni_search_files").execute(
      "large-search",
      { query: "TARGETED_SEAM", roots: ["large.ts"] },
      this.#abort.signal,
    )) as { details?: { value?: { matches?: Array<{ path: string; byteOffset: number }> } } };
    const match = search.details?.value?.matches?.find(
      (candidate) => candidate.path === "large.ts",
    );
    expect(match).toMatchObject({ byteOffset: expect.any(Number) });
    const targetedOffset = Math.max(1, match!.byteOffset - 1_024);
    const targeted = (await read.execute(
      "large-targeted-page",
      { path: "large.ts", offset: targetedOffset, maxBytes: 4_096 },
      this.#abort.signal,
    )) as { details?: { value?: { content?: string } } };
    expect(targeted.details?.value?.content).toContain("TARGETED_SEAM");
    const outsideWindow = await read.execute(
      "large-outside-search-window",
      { path: "large.ts", offset: match!.byteOffset - 32 * 1024 - 1, maxBytes: 1 },
      this.#abort.signal,
    );
    expect(outsideWindow.details).toMatchObject({
      outcome: "rejected",
      code: "read_search_required",
    });
    await this.tool("koni_submit_output").execute(
      "large-submit",
      { result: "targeted seam inspected" },
      this.#abort.signal,
    );
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {
    this.#abort.abort();
  }
  public dispose(): void {}

  private tool(name: KoniToolName): AuthorityBackedTool {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`missing authority tool ${name}`);
    return tool;
  }
}

class ResourceReadAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #abort = new AbortController();

  public constructor(
    spec: Readonly<AgentLaunchSpec>,
    private readonly tools: readonly AuthorityBackedTool[],
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return this.tools.map((tool) => tool.name);
  }
  public appendMapping(): void {}
  public subscribe(): () => void {
    return () => {};
  }
  public async prompt(): Promise<void> {
    const read = (await this.tool("koni_read_resource").execute(
      "skill-by-path",
      { resourceId: "skills/using-superpowers/SKILL.md" },
      this.#abort.signal,
    )) as { details?: { value?: { content?: string; resourceId?: string } } };
    expect(read.details?.value).toMatchObject({
      content: "Use relevant skills before acting.",
      resourceId: "skill-using-superpowers",
    });
    await this.tool("koni_submit_output").execute(
      "resource-submit",
      { result: "skill read" },
      this.#abort.signal,
    );
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {
    this.#abort.abort();
  }
  public dispose(): void {}

  private tool(name: KoniToolName): AuthorityBackedTool {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`missing authority tool ${name}`);
    return tool;
  }
}

class RejectionAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #abort = new AbortController();

  public constructor(
    spec: Readonly<AgentLaunchSpec>,
    private readonly tools: readonly AuthorityBackedTool[],
    private readonly mode:
      | "correctable-rejection"
      | "missing-read-rejection"
      | "rejection-boundary"
      | "workspace-rejection",
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] {
    return this.tools.map((tool) => tool.name);
  }
  public appendMapping(): void {}
  public subscribe(): () => void {
    return () => {};
  }
  public async prompt(): Promise<void> {
    if (this.mode === "missing-read-rejection") {
      const denied = await this.tool("koni_read_file").execute(
        "missing-optional-file",
        { path: "optional/AGENTS.md" },
        this.#abort.signal,
      );
      expect(denied.details).toMatchObject({ outcome: "rejected", code: "read_missing" });
      await this.tool("koni_submit_output").execute(
        "missing-read-submit",
        { result: "continued after absent optional file" },
        this.#abort.signal,
      );
      return;
    }
    if (this.mode === "rejection-boundary") {
      const rejected = await this.tool("koni_record_note").execute(
        "rollback-rejection",
        { nodeId: "claim-one", kind: "observation", body: "Correctable denial" },
        this.#abort.signal,
      );
      expect(rejected.details).toMatchObject({ outcome: "rejected", code: "read_page_size" });
      await this.tool("koni_record_note").execute(
        "fatal-integrity",
        { nodeId: "claim-two", kind: "observation", body: "Fatal integrity fault" },
        this.#abort.signal,
      );
      return;
    }
    if (this.mode === "workspace-rejection") {
      const denied = await this.tool("koni_write_file").execute(
        "out-of-scope-write",
        { path: "outside.txt", expectedSha256: null, content: "must not be written\n" },
        this.#abort.signal,
      );
      expect(denied.details).toMatchObject({ outcome: "rejected", code: "write_scope" });
      await this.tool("koni_submit_output").execute(
        "workspace-rejection-submit",
        { result: "continued after denied write" },
        this.#abort.signal,
      );
      return;
    }
    const search = this.tool("koni_search_files");
    const args = { query: "TARGETED_SEAM", roots: ["large.ts"] };
    const denied = await search.execute("out-of-scope-search", args, this.#abort.signal);
    expect(denied.details).toMatchObject({
      outcome: "rejected",
      code: "read_scope",
    });
    const replayed = await search.execute("out-of-scope-search", args, this.#abort.signal);
    expect(replayed).toEqual(denied);
    await this.tool("koni_submit_output").execute(
      "rejection-submit",
      { result: "continued after correctable denial" },
      this.#abort.signal,
    );
  }
  public async continue(): Promise<void> {
    await this.prompt();
  }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {
    this.#abort.abort();
  }
  public dispose(): void {}

  private tool(name: KoniToolName): AuthorityBackedTool {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`missing authority tool ${name}`);
    return tool;
  }
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for authority state");
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-tool-engine-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "koni@example.invalid");
  await git(root, "config", "user.name", "Koni Test");
  await writeFile(path.join(root, "README.md"), "initial\n");
  await writeFile(
    path.join(root, "large.ts"),
    `${"export const filler = 1;\n".repeat(3_000)}export const TARGETED_SEAM = true;\n${"export const tail = 1;\n".repeat(1_000)}`,
  );
  await git(root, "add", "README.md", "large.ts");
  await git(root, "commit", "-m", "initial");
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(stdout).toString("utf8").trim())
        : reject(new Error(Buffer.concat(stderr).toString("utf8"))),
    );
  });
}
