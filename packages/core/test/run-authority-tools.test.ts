import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityClient } from "../src/authority/client.js";
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
    const client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    const created = await client.request("run.create", {
      objective: "Choose and build",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Choose and build" },
    }, { expectedRevision: 0, idempotencyKey: "create-question-run" });
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
    expect(question.prompt).toBe("Which behavior should be primary?");
    expect(Object.values(waiting.attempts)[0]!.status).toBe("waiting_question");
    expect(waiting.plan).toBeUndefined();

    await client.request("authority.ping");
    await client.request("question.answer", {
      runId,
      questionId: question.id,
      selectedOptionId: "recommended",
      notes: "Keep the fallback too.",
    }, { expectedRevision: client.revision, idempotencyKey: "answer-question" });
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return current.lifecycle.phase === "awaiting_approval" &&
        Object.values(current.attempts)[0]?.status === "completed";
    });
    const planned = await engine.store.getRun(runId);
    expect(Object.values(planned.attempts)[0]!.status).toBe("completed");
    expect(planned.plan?.concise.decisions?.[0]?.title).toBe("Use recommendation");
    expect(Object.values(planned.attempts)[0]!.authorityToolResults?.filter(
      (result) => result.toolName === "koni_read_file",
    )).toEqual([
      expect.objectContaining({ callId: "read-one", outcome: "accepted" }),
    ]);
    client.close();
  });
});

function questionProgram(): RunCompilerProgram {
  const terminalSchema = Type.Object({ result: Type.String() }, { additionalProperties: false });
  const names: KoniToolName[] = ["koni_read_file", "koni_ask_question", "koni_submit_output"];
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
        workingSpecOwnerId: "lead",
        planningMode: "agent",
        pipelineStageIds: ["plan", "approval", "orchestrate", "verification", "promotion"],
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
    async initializeDirectApproval() { throw new Error("not used"); },
    async prepareAttempt(input) {
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
        readPaths: ["README.md"],
        writePaths: [],
        expectedRevision: input.nextAuthorityRevision,
        expectedStateHash: input.expectedAuthorityStateHash,
      };
      expect(grant.expectedStateHash).toBe(authorityRevisionStateHash(input.run.projectRoot, input.nextAuthorityRevision));
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
        model: { provider: "openai-codex", id: "test-model", thinkingLevel: "high" },
        tools: names.map((name) => ({
          name,
          schemaHash: koniToolSchemaHash(name, terminalSchema),
          executionMode: name === "koni_read_file" ? "parallel" as const : "sequential" as const,
          maxResultBytes: koniToolMaxResultBytes(name),
        })),
        resources: { setHash: computeLaunchResourceSetHash([]), entries: [] },
        budgets: {
          tokens: {
            maxInput: 10_000,
            maxOutput: 10_000,
            maxCacheRead: 10_000,
            maxCacheWrite: 10_000,
            maxNew: 20_000,
            maxAll: 40_000,
          },
          transcript: { maxBytes: 64 * 1024 * 1024 },
          retries: { maxProviderRetries: 0, baseDelayMs: 0 },
          repositoryCalls: { max: 1 },
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
          plan: { architecture: "Pending", decisions: "Pending", risk: "Pending", verification: "Pending" },
          graphRefs: [],
          touchedFiles: [],
          receiptIds: [],
          checkIds: [],
          unresolvedQuestions: [],
          nextAction: "Plan the run",
        },
        factory: (async (_spec, options) => new QuestionAdapter(spec, options.tools)) satisfies ManagedPiSessionFactory,
      };
    },
    async compilePlanningOutput() {
      return {
        plan: {
          revision: 1,
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
    async initializeApprovedPlan() { throw new Error("not used"); },
    async compileAssignmentOutput() { throw new Error("not used"); },
    async verifyRun() { return { ok: true }; },
    async createIntegrationTicket() { throw new Error("not used"); },
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

  public getActiveToolNames(): readonly string[] { return this.tools.map((tool) => tool.name); }
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
    try {
      await readTool.execute("read-two", readArgs, this.#abort.signal);
      throw new Error("repository-call ceiling accepted a second unique read");
    } catch (error) {
      if (!(error instanceof Error) || (error as Error & { code?: string }).code !== "repository_call_budget") {
        throw error;
      }
    }
    const questionArgs = {
      prompt: "Which behavior should be primary?",
      options: [
        { id: "recommended", label: "Recommended", description: "Use the new behavior first." },
        { id: "legacy", label: "Legacy", description: "Keep the old behavior first." },
      ],
      allowsNotes: true,
    };
    this.emit({ type: "tool_execution_start", toolCallId: "ask", toolName: "koni_ask_question", args: questionArgs });
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
    this.emit({ type: "tool_execution_start", toolCallId: "submit", toolName: "koni_submit_output", args: terminalArgs });
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
  public async continue(): Promise<void> { await this.prompt(); }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> { this.#abort.abort(); }
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
  await git(root, "add", "README.md");
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
    child.on("close", (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8").trim())
      : reject(new Error(Buffer.concat(stderr).toString("utf8"))));
  });
}
