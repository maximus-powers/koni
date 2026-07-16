import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  CURRENT_SESSION_VERSION,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { Sha256Digest } from "../shared/canonical.js";
import {
  createKoniManagedExtension,
  type CompactionLifecycleNotice,
  type KoniContextProvider,
} from "./compaction.js";
import { type AgentLaunchSpec, validateAgentLaunchSpec } from "./launch-spec.js";
import { createContainedResourceLoader } from "./resource-loader.js";

export interface AuthorityBackedTool {
  name: string;
  schemaHash: Sha256Digest;
  definition: ToolDefinition;
  terminalOutputSchemaHash?: Sha256Digest;
}

export interface ManagedTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  newTokens: number;
  allTokens: number;
}

export type ManagedSessionStatus =
  | "created"
  | "running"
  | "aborting"
  | "aborted"
  | "completed"
  | "failed"
  | "disposed";

export type ManagedSessionEvent =
  | { type: "status"; status: ManagedSessionStatus; detail?: string }
  | { type: "pi_lifecycle"; eventType: string }
  | { type: "usage"; usage: ManagedTokenUsage }
  | { type: "terminal"; toolName: string; output: unknown }
  | { type: "compaction"; notice: CompactionLifecycleNotice };

export type ManagedSessionOutcome =
  | { status: "completed"; terminalOutput: unknown; usage: ManagedTokenUsage }
  | { status: "failed"; error: string; usage: ManagedTokenUsage }
  | { status: "aborted"; reason: string; usage: ManagedTokenUsage };

export interface PiSessionAdapter {
  readonly sessionId: string;
  readonly sessionFile: string;
  getActiveToolNames(): readonly string[];
  appendMapping(data: unknown): void;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

export type ManagedPiSessionFactory = (
  spec: Readonly<AgentLaunchSpec>,
  options: ManagedPiSessionFactoryOptions,
) => Promise<PiSessionAdapter>;

export interface ManagedPiSessionFactoryOptions {
  tools: readonly AuthorityBackedTool[];
  contextProvider: KoniContextProvider;
  onCompactionNotice?: (notice: CompactionLifecycleNotice) => void;
  modelRuntime?: ModelRuntime;
}

export class ManagedSessionError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ManagedSessionError";
    this.code = code;
  }
}

export class ManagedPiSession {
  readonly spec: Readonly<AgentLaunchSpec>;
  readonly #adapter: PiSessionAdapter;
  readonly #listeners = new Set<(event: ManagedSessionEvent) => void>();
  readonly #usage: ManagedTokenUsage = emptyUsage();
  #status: ManagedSessionStatus = "created";
  #unsubscribe: (() => void) | undefined;
  #startPromise: Promise<ManagedSessionOutcome> | undefined;
  #abortPromise: Promise<void> | undefined;
  #abortReason = "aborted by authority";
  #terminalCount = 0;
  #terminalOutput: unknown;
  #failure: string | undefined;

  private constructor(spec: Readonly<AgentLaunchSpec>, adapter: PiSessionAdapter) {
    this.spec = spec;
    this.#adapter = adapter;
    assertExactToolInventory(spec, adapter.getActiveToolNames());
    if (adapter.sessionId !== spec.identity.sessionId) {
      throw new ManagedSessionError("session_identity", "Pi created a different session identity than authorized");
    }
    adapter.appendMapping({
      protocol: "koni.attempt-session-map.v1",
      specHash: spec.specHash,
      runId: spec.identity.runId,
      ticketId: spec.identity.ticketId,
      stepId: spec.identity.stepId,
      attemptId: spec.identity.attemptId,
      sessionId: spec.identity.sessionId,
      grantId: spec.authority.grantId,
      grantHash: spec.authority.grantHash,
      generation: spec.authority.generation,
      epoch: spec.authority.epoch,
      stateHash: spec.authority.expectedStateHash,
      resourceSetHash: spec.resources.setHash,
      model: spec.model,
      sessionFile: adapter.sessionFile,
    });
    this.#unsubscribe = adapter.subscribe((event) => this.#onPiEvent(event));
  }

  public static async create(
    specValue: AgentLaunchSpec,
    options: ManagedPiSessionFactoryOptions & { factory?: ManagedPiSessionFactory },
  ): Promise<ManagedPiSession> {
    const spec = validateAgentLaunchSpec(specValue);
    validateToolBindings(spec, options.tools);
    const adapter = await (options.factory ?? createManagedPiSession)(spec, options);
    return new ManagedPiSession(spec, adapter);
  }

  public get status(): ManagedSessionStatus {
    return this.#status;
  }

  public get sessionFile(): string {
    return this.#adapter.sessionFile;
  }

  public get usage(): Readonly<ManagedTokenUsage> {
    return { ...this.#usage };
  }

  public subscribe(listener: (event: ManagedSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public start(): Promise<ManagedSessionOutcome> {
    if (this.#startPromise !== undefined) {
      return this.#startPromise;
    }
    if (this.#status !== "created") {
      return Promise.reject(new ManagedSessionError("start_state", `cannot start a ${this.#status} session`));
    }
    this.#startPromise = this.#run();
    return this.#startPromise;
  }

  public async steer(text: string): Promise<void> {
    this.#assertCanMessage("steer", text);
    await this.#adapter.steer(text);
  }

  public async followUp(text: string): Promise<void> {
    this.#assertCanMessage("follow up", text);
    await this.#adapter.followUp(text);
  }

  public abort(reason = "aborted by authority"): Promise<void> {
    if (this.#status === "aborted" || this.#status === "disposed" || this.#status === "completed" || this.#status === "failed") {
      return Promise.resolve();
    }
    if (this.#abortPromise !== undefined) {
      return this.#abortPromise;
    }
    this.#abortReason = sanitizeText(reason);
    this.#setStatus("aborting", this.#abortReason);
    this.#abortPromise = (async () => {
      await this.#adapter.abort();
      if (this.#status === "aborting") {
        this.#setStatus("aborted", this.#abortReason);
      }
    })();
    return this.#abortPromise;
  }

  public async dispose(): Promise<void> {
    if (this.#status === "disposed") {
      return;
    }
    await this.abort("session disposed");
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#adapter.dispose();
    this.#setStatus("disposed");
    this.#listeners.clear();
  }

  async #run(): Promise<ManagedSessionOutcome> {
    this.#setStatus("running");
    try {
      await this.#adapter.prompt(this.spec.persona.initialPrompt);
    } catch (error) {
      if (this.#status === "aborting" || this.#status === "aborted") {
        this.#setStatus("aborted", this.#abortReason);
        return { status: "aborted", reason: this.#abortReason, usage: this.usage };
      }
      this.#failure = error instanceof Error ? error.message : String(error);
    }

    if (this.#status === "aborting" || this.#status === "aborted") {
      this.#setStatus("aborted", this.#abortReason);
      return { status: "aborted", reason: this.#abortReason, usage: this.usage };
    }
    if (this.#failure !== undefined) {
      this.#setStatus("failed", this.#failure);
      return { status: "failed", error: this.#failure, usage: this.usage };
    }
    if (this.#terminalCount !== 1) {
      const error = this.#terminalCount === 0
        ? `agent settled without calling terminal tool ${this.spec.terminal.toolName}`
        : `agent called terminal tool ${this.spec.terminal.toolName} more than once`;
      this.#setStatus("failed", error);
      return { status: "failed", error, usage: this.usage };
    }
    this.#setStatus("completed");
    return { status: "completed", terminalOutput: this.#terminalOutput, usage: this.usage };
  }

  #onPiEvent(event: AgentSessionEvent): void {
    this.#emit({ type: "pi_lifecycle", eventType: event.type });
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      addUsage(this.#usage, usage.input, usage.output, usage.cacheRead, usage.cacheWrite);
      this.#emit({ type: "usage", usage: this.usage });
      const violation = tokenBudgetViolation(this.spec, this.#usage);
      if (violation !== undefined && this.#failure === undefined) {
        this.#failure = violation;
        void this.abort(violation);
      }
    }
    if (event.type === "tool_execution_end" && event.toolName === this.spec.terminal.toolName) {
      if (event.isError) {
        this.#failure = `terminal tool ${event.toolName} failed`;
        return;
      }
      this.#terminalCount += 1;
      if (this.#terminalCount > 1) {
        this.#failure = `terminal tool ${event.toolName} was called more than once`;
        void this.abort(this.#failure);
        return;
      }
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(event.result), "utf8");
      } catch {
        this.#failure = "terminal output is not JSON serializable";
        void this.abort(this.#failure);
        return;
      }
      if (bytes > this.spec.terminal.maxOutputBytes) {
        this.#failure = "terminal output exceeds the compiler-issued byte budget";
        void this.abort(this.#failure);
        return;
      }
      this.#terminalOutput = structuredClone(event.result);
      this.#emit({ type: "terminal", toolName: event.toolName, output: this.#terminalOutput });
    }
  }

  #assertCanMessage(operation: string, text: string): void {
    if (this.#status !== "running") {
      throw new ManagedSessionError("message_state", `cannot ${operation} a ${this.#status} session`);
    }
    if (Buffer.byteLength(text, "utf8") === 0 || Buffer.byteLength(text, "utf8") > 1024 * 1024 || text.includes("\u0000")) {
      throw new ManagedSessionError("message_size", `${operation} text is empty, oversized, or contains NUL`);
    }
  }

  #setStatus(status: ManagedSessionStatus, detail?: string): void {
    this.#status = status;
    this.#emit({ type: "status", status, ...(detail === undefined ? {} : { detail }) });
  }

  #emit(event: ManagedSessionEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

/** Production factory. Tests inject a fake factory and make no provider or network calls. */
export async function createManagedPiSession(
  spec: Readonly<AgentLaunchSpec>,
  options: ManagedPiSessionFactoryOptions,
): Promise<PiSessionAdapter> {
  const extension = createKoniManagedExtension({
    spec,
    contextProvider: options.contextProvider,
    ...(options.onCompactionNotice === undefined ? {} : { onNotice: options.onCompactionNotice }),
  });
  const contained = await createContainedResourceLoader({ spec, extension });
  contained.settingsManager.applyOverrides({
    defaultProvider: spec.model.provider,
    defaultModel: spec.model.id,
    defaultThinkingLevel: spec.model.thinkingLevel,
    compaction: { enabled: true },
    retry: {
      enabled: spec.budgets.retries.maxProviderRetries > 0,
      maxRetries: spec.budgets.retries.maxProviderRetries,
      baseDelayMs: spec.budgets.retries.baseDelayMs,
      provider: { maxRetries: 0 },
    },
    images: { blockImages: true, autoResize: false },
  });
  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create();
  const model = modelRuntime.getModel(spec.model.provider, spec.model.id);
  if (model === undefined) {
    throw new ManagedSessionError(
      "model_missing",
      `Pi's normal model runtime does not contain ${spec.model.provider}/${spec.model.id}`,
    );
  }
  const sessionManager = await createFreshSessionManager(spec);
  const result = await createAgentSession({
    cwd: spec.workspace.cwd,
    agentDir: path.join(contained.resourceRoot, ".pi-agent"),
    modelRuntime,
    model,
    thinkingLevel: spec.model.thinkingLevel,
    noTools: "all",
    tools: spec.tools.map((tool) => tool.name),
    customTools: options.tools.map((tool) => tool.definition),
    resourceLoader: contained.loader,
    sessionManager,
    settingsManager: contained.settingsManager,
    sessionStartEvent: { type: "session_start", reason: "startup" },
  });
  if (
    result.session.model?.provider !== spec.model.provider ||
    result.session.model?.id !== spec.model.id ||
    result.session.thinkingLevel !== spec.model.thinkingLevel
  ) {
    result.session.dispose();
    throw new ManagedSessionError(
      "model_clamped",
      "Pi could not honor the exact compiler-issued model and thinking level",
    );
  }
  await result.session.bindExtensions({ mode: "rpc" });
  const sessionFile = result.session.sessionFile;
  if (sessionFile === undefined) {
    result.session.dispose();
    throw new ManagedSessionError("session_persistence", "contained Pi session is not persisted");
  }
  return {
    sessionId: result.session.sessionId,
    sessionFile,
    getActiveToolNames: () => result.session.getActiveToolNames(),
    appendMapping: (data) => { result.session.sessionManager.appendCustomEntry("koni.attempt-session-map", data); },
    subscribe: (listener) => result.session.subscribe(listener),
    prompt: (text) => result.session.prompt(text, { expandPromptTemplates: false, source: "rpc" }),
    steer: (text) => result.session.prompt(text, {
      expandPromptTemplates: false,
      streamingBehavior: "steer",
      source: "rpc",
    }),
    followUp: (text) => result.session.prompt(text, {
      expandPromptTemplates: false,
      streamingBehavior: "followUp",
      source: "rpc",
    }),
    abort: () => result.session.abort(),
    dispose: () => result.session.dispose(),
  };
}

async function createFreshSessionManager(spec: Readonly<AgentLaunchSpec>): Promise<SessionManager> {
  await mkdir(spec.workspace.sessionDirectory, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(spec.workspace.sessionDirectory, `${spec.identity.sessionId}.jsonl`);
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: spec.identity.sessionId,
    timestamp: new Date().toISOString(),
    cwd: spec.workspace.cwd,
  };
  let handle;
  try {
    handle = await open(sessionFile, "wx", 0o600);
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      throw new ManagedSessionError("session_replay", `Pi session ${spec.identity.sessionId} already exists`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(header)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return SessionManager.open(sessionFile, spec.workspace.sessionDirectory, spec.workspace.cwd);
}

function validateToolBindings(spec: Readonly<AgentLaunchSpec>, tools: readonly AuthorityBackedTool[]): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (byName.size !== tools.length || tools.length !== spec.tools.length) {
    throw new ManagedSessionError("tool_inventory", "authority tool bindings do not exactly match the launch inventory");
  }
  for (const expected of spec.tools) {
    const actual = byName.get(expected.name);
    if (
      actual === undefined ||
      actual.definition.name !== expected.name ||
      actual.schemaHash !== expected.schemaHash ||
      (actual.definition.executionMode ?? "parallel") !== expected.executionMode
    ) {
      throw new ManagedSessionError("tool_binding", `authority tool ${expected.name} does not match its launch binding`);
    }
  }
  const terminal = byName.get(spec.terminal.toolName);
  if (terminal?.terminalOutputSchemaHash !== spec.terminal.outputSchemaHash) {
    throw new ManagedSessionError("terminal_schema", "terminal tool output schema does not match its launch binding");
  }
}

function assertExactToolInventory(spec: Readonly<AgentLaunchSpec>, active: readonly string[]): void {
  const expected = spec.tools.map((tool) => tool.name).sort();
  const actual = [...active].sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new ManagedSessionError("ambient_tool", "Pi exposed a tool outside the compiler-issued inventory");
  }
}

function addUsage(
  total: ManagedTokenUsage,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): void {
  for (const [name, value] of Object.entries({ input, output, cacheRead, cacheWrite })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ManagedSessionError("usage", `Pi reported invalid ${name} token usage`);
    }
  }
  total.input += input;
  total.output += output;
  total.cacheRead += cacheRead;
  total.cacheWrite += cacheWrite;
  total.newTokens = total.input + total.output;
  total.allTokens = total.newTokens + total.cacheRead + total.cacheWrite;
}

function tokenBudgetViolation(
  spec: Readonly<AgentLaunchSpec>,
  usage: ManagedTokenUsage,
): string | undefined {
  const maximum = spec.budgets.tokens;
  const checks: Array<[number, number, string]> = [
    [usage.input, maximum.maxInput, "input"],
    [usage.output, maximum.maxOutput, "output"],
    [usage.cacheRead, maximum.maxCacheRead, "cache-read"],
    [usage.cacheWrite, maximum.maxCacheWrite, "cache-write"],
    [usage.newTokens, maximum.maxNew, "new-token"],
    [usage.allTokens, maximum.maxAll, "cache-inclusive"],
  ];
  return checks.find(([actual, allowed]) => actual > allowed)?.[2]
    .concat(" token budget exceeded");
}

function emptyUsage(): ManagedTokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 };
}

function sanitizeText(value: string): string {
  const clean = value.replaceAll("\u0000", "").trim();
  return clean.length === 0 ? "aborted by authority" : clean.slice(0, 4_096);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
