import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  createAssistantMessageEventStream,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type AuthPrompt,
  type CredentialStore,
  type ImageContent,
  type Model,
  type MutableModels,
  type OAuthCredential,
  type Provider,
  type TextContent,
  type TSchema,
} from "@earendil-works/pi-ai";
import { IpcCredentialStore, OPENAI_CODEX_PROVIDER_ID } from "./credential-store.js";
import {
  HostError,
  projectProviderFailure,
  projectRuntimeFailure,
  type ProjectedFailure,
} from "./errors.js";
import { koniOpenAICodexProvider } from "./openai-codex-provider.js";
import type { PiProtocolPeer } from "./protocol.js";
import type { SecretRedactor } from "./redaction.js";
import type {
  AgentToolOutcome,
  CredentialBrokerRequest,
  CredentialBrokerResponse,
  OAuthInteractionWire,
  RuntimeModelDescriptor,
  RuntimeControl,
  RuntimeResponse,
  RuntimeSessionStart,
  RuntimeToolDefinition,
  RuntimeTurnRequest,
  RuntimeUsage,
} from "./wire-types.js";

export const PI_SDK_VERSION = "0.80.7" as const;
export const DEFAULT_OAUTH_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
export const OPENAI_CODEX_CALLBACK_HOST = "127.0.0.1";
export const OPENAI_CODEX_CALLBACK_PORT = 1455;
export const OAUTH_CALLBACK_UNAVAILABLE_MESSAGE =
  "OpenAI Codex browser sign-in cannot use localhost port 1455. Close the process using that port, then try signing in again.";
export const MIN_OPENAI_CODEX_OUTPUT_TOKENS = 16;
export const MAX_BROKER_TOOL_ARGUMENT_JSON_BYTES = 896 * 1024;

/**
 * Pi 0.80.7 turns a callback-listener error into a null callback result and
 * then waits on its concurrently offered manual-code prompt. Koni does not
 * expose that secret-bearing fallback, so prove that the exact listener can
 * bind before entering Pi's browser flow instead of waiting for the global
 * login timeout. The listener is closed before Pi creates its own server.
 */
export async function assertOAuthCallbackAvailable(
  signal?: AbortSignal,
  host = OPENAI_CODEX_CALLBACK_HOST,
  port = OPENAI_CODEX_CALLBACK_PORT,
): Promise<void> {
  if (signal?.aborted) {
    throw new HostError("CANCELLED", "OpenAI Codex OAuth login was cancelled");
  }
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (error?: HostError) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const closeThen = (error?: HostError) => {
      try {
        server.close(() => finish(error));
      } catch {
        finish(error);
      }
    };
    const onAbort = () =>
      closeThen(new HostError("CANCELLED", "OpenAI Codex OAuth login was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", () => {
      finish(new HostError("AUTHENTICATION_FAILED", OAUTH_CALLBACK_UNAVAILABLE_MESSAGE));
    });
    server.listen({ host, port, exclusive: true }, () => closeThen());
  });
}

export function toolArgumentsFitPublicFrame(arguments_: unknown): boolean {
  try {
    // JSON escaping is measured, not estimated. The 128 KiB margin below the
    // 1 MiB wire ceiling covers the bounded protocol/session/call headers and
    // keeps a sequence-width race from turning a local rejection into a
    // fatal outgoing-frame error.
    return Buffer.byteLength(JSON.stringify(arguments_), "utf8") <= MAX_BROKER_TOOL_ARGUMENT_JSON_BYTES;
  } catch {
    return false;
  }
}

export interface RuntimeManagerOptions {
  protocol: Pick<PiProtocolPeer, "executeTool" | "sendEvent">;
  credentialStore: CredentialStore;
  redactor: SecretRedactor;
  provider?: Provider;
  allowedProviderId?: string;
  oauthLoginTimeoutMs?: number;
  /** Test seam; production OpenAI browser login uses the exact local probe above. */
  oauthCallbackProbe?: (signal: AbortSignal) => Promise<void>;
  onFatal?: (error: unknown) => void;
}

interface SessionRecord {
  id: string;
  agent: Agent;
  activeTurnId: string | undefined;
  terminalEventPending: boolean;
  lastTerminalTurnId: string | undefined;
  activeOutputTokenBudget: number | undefined;
  outputBudgetExhausted: boolean;
  activeOutputSchema: Record<string, unknown> | undefined;
  activeRun: Promise<void> | undefined;
  cancelRequested: boolean;
  activeUsage: RuntimeUsage;
  messageCounter: number;
  activeMessageId: string | undefined;
  toolOutcomes: Map<string, AgentToolOutcome>;
  brokerDispatchedTools: Set<string>;
  truncatedToolCalls: Set<string>;
  oversizedToolCalls: Set<string>;
  staleAfterRetryableErrorTools: Set<string>;
  staleAfterContextDeliveryTools: Set<string>;
  repeatedContextTools: Set<string>;
  locallyRejectedTools: Set<string>;
  retryableToolErrorCallId: string | undefined;
  contextObservationBoundaryCallId: string | undefined;
  contextContinuation: ContextContinuationCursor | undefined;
  contextCompletionRequired: boolean;
  contextIssued: boolean;
  contextRepeatRejections: number;
  terminalToolCallId: string | undefined;
  terminalBoundaryTools: string[];
  minimumProviderOutputTokens: number;
  credentialLease: string;
  eventChain: Promise<void>;
  fatalError: unknown | undefined;
}

interface ContextContinuationCursor {
  path: string;
  nextOffset: number;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function exactContextContinuationCall(
  cursor: ContextContinuationCursor | undefined,
  tool: string,
  arguments_: unknown,
): boolean {
  if (!cursor || tool !== "read_file") return false;
  const record = objectValue(arguments_);
  if (!record || record.path !== cursor.path) return false;
  return (nonnegativeInteger(record.offset) ?? 0) === cursor.nextOffset;
}

function contextContinuationAfterDelivery(
  tool: string,
  arguments_: unknown,
  value: unknown,
  current: ContextContinuationCursor | undefined,
  issued: boolean,
): { delivered: boolean; next: ContextContinuationCursor | undefined } {
  const response = objectValue(value);
  if (tool === "context") {
    if (issued) return { delivered: false, next: current };
    if (!response) {
      return { delivered: true, next: undefined };
    }
    if (response.status === "paged" && response.eof !== true) {
      const path = typeof response.document_path === "string" ? response.document_path : undefined;
      const nextOffset = nonnegativeInteger(response.next_offset);
      return {
        delivered: true,
        next: path && nextOffset !== undefined ? { path, nextOffset } : undefined,
      };
    }
    if (response.status === "already_issued") {
      const path = typeof response.document_path === "string" ? response.document_path : undefined;
      return { delivered: true, next: path ? { path, nextOffset: 0 } : undefined };
    }
    return { delivered: true, next: undefined };
  }
  if (!exactContextContinuationCall(current, tool, arguments_)) {
    return { delivered: false, next: current };
  }
  if (!response || response.eof === true) {
    return { delivered: true, next: undefined };
  }
  const responsePath = typeof response.path === "string" ? response.path : current?.path;
  const nextOffset = nonnegativeInteger(response.next_offset);
  return {
    delivered: true,
    next:
      responsePath && nextOffset !== undefined
        ? { path: responsePath, nextOffset }
        : current,
  };
}

const EMPTY_USAGE: RuntimeUsage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
};

function cloneUsage(usage: RuntimeUsage): RuntimeUsage {
  return { ...usage };
}

function tokenCount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HostError("PROVIDER_ERROR", `Pi provider returned invalid ${name} token usage`);
  }
  return value;
}

function checkedTokenSum(values: number[], name: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new HostError("PROVIDER_ERROR", `Pi provider overflowed ${name} token usage`);
    }
  }
  return total;
}

function calculateUsage(
  total: RuntimeUsage,
  message: Extract<AgentMessage, { role: "assistant" }>,
): { usage: RuntimeUsage; nextTotal: RuntimeUsage } {
  const input = tokenCount(message.usage.input, "input");
  const output = tokenCount(message.usage.output, "output");
  const cacheRead = tokenCount(message.usage.cacheRead, "cache-read");
  const cacheWrite = tokenCount(message.usage.cacheWrite, "cache-write");
  const reasoning = tokenCount(message.usage.reasoning ?? 0, "reasoning");
  const reportedTotal = tokenCount(message.usage.totalTokens, "total");
  const calculatedTotal = checkedTokenSum([input, output, cacheRead, cacheWrite], "message total");
  if (reportedTotal !== calculatedTotal || reasoning > output) {
    throw new HostError("PROVIDER_ERROR", "Pi provider returned inconsistent token usage");
  }
  const usage = {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    output_tokens: output,
    reasoning_tokens: reasoning,
    total_tokens: reportedTotal,
  };
  const nextTotal: RuntimeUsage = {
    input_tokens: checkedTokenSum([total.input_tokens, usage.input_tokens], "cumulative input"),
    cached_input_tokens: checkedTokenSum(
      [total.cached_input_tokens, usage.cached_input_tokens],
      "cumulative cache-read",
    ),
    output_tokens: checkedTokenSum([total.output_tokens, usage.output_tokens], "cumulative output"),
    reasoning_tokens: checkedTokenSum(
      [total.reasoning_tokens, usage.reasoning_tokens],
      "cumulative reasoning",
    ),
    total_tokens: checkedTokenSum([total.total_tokens, usage.total_tokens], "cumulative total"),
  };
  return { usage, nextTotal };
}

function stoppedAgentStream(model: Model<Api>, message: string) {
  const stream = createAssistantMessageEventStream();
  const stopped: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage: message,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "aborted", error: stopped });
    stream.end(stopped);
  });
  return stream;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outcomeContent(outcome: AgentToolOutcome): Array<TextContent | ImageContent> {
  if (outcome.status === "error") {
    return [{ type: "text", text: `${outcome.code}: ${outcome.message}` }];
  }
  const value = outcome.value;
  if (isRecord(value) && Array.isArray(value["content"])) {
    const content: Array<TextContent | ImageContent> = [];
    for (const block of value["content"]) {
      if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") {
        content.push({ type: "text", text: block["text"] });
      } else if (
        isRecord(block) &&
        block["type"] === "image" &&
        typeof block["data"] === "string" &&
        typeof block["mimeType"] === "string"
      ) {
        content.push({ type: "image", data: block["data"], mimeType: block["mimeType"] });
      }
    }
    if (content.length > 0) return content;
  }
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
}

function accountLabel(credential: OAuthCredential): string | null {
  for (const key of ["accountId", "account_id", "email"]) {
    const value = credential[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export class PiRuntimeManager {
  private readonly protocol: Pick<PiProtocolPeer, "executeTool" | "sendEvent">;
  private readonly credentialStore: CredentialStore;
  private readonly redactor: SecretRedactor;
  private readonly provider: Provider;
  private readonly allowedProviderId: string;
  private readonly oauthLoginTimeoutMs: number;
  private readonly oauthCallbackProbe: ((signal: AbortSignal) => Promise<void>) | undefined;
  private readonly onFatal: ((error: unknown) => void) | undefined;
  private readonly models: MutableModels;
  private session: SessionRecord | undefined;
  private loginController: AbortController | undefined;

  constructor(options: RuntimeManagerOptions) {
    this.protocol = options.protocol;
    this.credentialStore = options.credentialStore;
    this.redactor = options.redactor;
    this.provider = options.provider ?? koniOpenAICodexProvider();
    this.allowedProviderId = options.allowedProviderId ?? OPENAI_CODEX_PROVIDER_ID;
    this.oauthLoginTimeoutMs = options.oauthLoginTimeoutMs ?? DEFAULT_OAUTH_LOGIN_TIMEOUT_MS;
    this.oauthCallbackProbe =
      options.oauthCallbackProbe ??
      (this.allowedProviderId === OPENAI_CODEX_PROVIDER_ID ? assertOAuthCallbackAvailable : undefined);
    this.onFatal = options.onFatal;
    if (!Number.isSafeInteger(this.oauthLoginTimeoutMs) || this.oauthLoginTimeoutMs <= 0) {
      throw new HostError("INVALID_REQUEST", "OAuth login timeout must be a positive safe integer");
    }
    if (this.provider.id !== this.allowedProviderId) {
      throw new HostError("UNSUPPORTED", `provider ${this.provider.id} is not allowed by this host`);
    }
    this.models = createModels({
      credentials: this.credentialStore,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    this.models.setProvider(this.provider);
  }

  listModels(): RuntimeModelDescriptor[] {
    return this.models.getModels(this.allowedProviderId).map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      api: model.api,
      reasoning: model.reasoning,
      input: [...model.input],
      context_window: model.contextWindow,
      max_tokens: model.maxTokens,
      thinking_levels: getSupportedThinkingLevels(model),
    }));
  }

  providerId(): string {
    return this.allowedProviderId;
  }

  startSession(request: RuntimeSessionStart, frameSessionId: string): RuntimeResponse {
    if (this.session) throw new HostError("CONFLICT", "this Pi host already owns a runtime session");
    if (request.session_id !== frameSessionId) {
      throw new HostError("PROTOCOL_ERROR", "start_session request does not match its frame session_id");
    }
    if (request.model.provider !== this.allowedProviderId) {
      throw new HostError("UNSUPPORTED", `provider must be ${this.allowedProviderId}`);
    }
    const model = this.requireModel(request.model.model);
    this.requireThinkingLevel(model, request.model.thinking_level);
    if (this.credentialStore instanceof IpcCredentialStore) {
      this.credentialStore.setLease(request.credential_lease);
    }
    const toolOutcomes = new Map<string, AgentToolOutcome>();
    const tools = (request.tools ?? []).map((tool) => this.createTool(request.session_id, tool, toolOutcomes));
    let sessionForStream: SessionRecord | undefined;
    const agent = new Agent({
      initialState: {
        systemPrompt: request.instructions,
        model,
        thinkingLevel: request.model.thinking_level,
        messages: [],
        tools,
      },
      sessionId: request.session_id,
      transport: "auto",
      toolExecution: "sequential",
      streamFn: (requestModel, context, options) => {
        const activeSession = sessionForStream;
        if (activeSession?.terminalToolCallId) {
          return stoppedAgentStream(requestModel, "compiler accepted a terminal tool outcome");
        }
        if (activeSession) {
          // A new provider request is the first point at which the model has
          // seen the prior tool result. Calls later in the original
          // model-authored batch were skipped as stale; this begins the next
          // informed round without changing compiler CAS or execution order.
          activeSession.retryableToolErrorCallId = undefined;
          activeSession.contextObservationBoundaryCallId = undefined;
        }
        if (!activeSession || activeSession.activeOutputTokenBudget === undefined) {
          return this.models.streamSimple(requestModel, context, options);
        }
        const remaining = Math.max(
          0,
          activeSession.activeOutputTokenBudget - activeSession.activeUsage.output_tokens,
        );
        const minimumRequestTokens =
          this.allowedProviderId === OPENAI_CODEX_PROVIDER_ID && requestModel.api === "openai-codex-responses"
            ? MIN_OPENAI_CODEX_OUTPUT_TOKENS
            : 1;
        if (remaining < minimumRequestTokens) {
          activeSession.outputBudgetExhausted = true;
          activeSession.agent.abort();
          return stoppedAgentStream(requestModel, "turn output-token budget is exhausted");
        }
        const modelLimit = requestModel.maxTokens > 0 ? requestModel.maxTokens : Number.MAX_SAFE_INTEGER;
        const optionLimit = options?.maxTokens ?? Number.MAX_SAFE_INTEGER;
        const maxTokens = Math.min(remaining, modelLimit, optionLimit);
        return this.models.streamSimple(requestModel, context, {
          ...options,
          maxTokens,
        });
      },
      afterToolCall: async ({ toolCall }) => {
        const outcome = toolOutcomes.get(toolCall.id);
        return outcome?.status === "error" ? { isError: true } : undefined;
      },
    });
    const session: SessionRecord = {
      id: request.session_id,
      agent,
      activeTurnId: undefined,
      terminalEventPending: false,
      lastTerminalTurnId: undefined,
      activeOutputTokenBudget: undefined,
      outputBudgetExhausted: false,
      activeOutputSchema: undefined,
      activeRun: undefined,
      cancelRequested: false,
      activeUsage: cloneUsage(EMPTY_USAGE),
      messageCounter: 0,
      activeMessageId: undefined,
      toolOutcomes,
      brokerDispatchedTools: new Set(),
      truncatedToolCalls: new Set(),
      oversizedToolCalls: new Set(),
      staleAfterRetryableErrorTools: new Set(),
      staleAfterContextDeliveryTools: new Set(),
      repeatedContextTools: new Set(),
      locallyRejectedTools: new Set(),
      retryableToolErrorCallId: undefined,
      contextObservationBoundaryCallId: undefined,
      contextContinuation: undefined,
      contextCompletionRequired: request.context_completion_required === true,
      contextIssued: false,
      contextRepeatRejections: 0,
      terminalToolCallId: undefined,
      terminalBoundaryTools: [...(request.terminal_boundary_tools ?? [])],
      minimumProviderOutputTokens:
        this.allowedProviderId === OPENAI_CODEX_PROVIDER_ID && model.api === "openai-codex-responses"
          ? MIN_OPENAI_CODEX_OUTPUT_TOKENS
          : 1,
      credentialLease: request.credential_lease,
      eventChain: Promise.resolve(),
      fatalError: undefined,
    };
    sessionForStream = session;
    this.session = session;
    agent.subscribe((event) => {
      const next = session.eventChain.then(() => this.forwardAgentEvent(session, event));
      session.eventChain = next;
      void next.catch(() => undefined);
      return next;
    });
    return {
      kind: "session_started",
      session: {
        runtime: "pi-sdk",
        protocol_version: 1,
        provider: model.provider,
        model: model.id,
        session_id: request.session_id,
      },
    };
  }

  startTurn(request: RuntimeTurnRequest): RuntimeResponse {
    const prepared = this.prepareTurn(request);
    prepared.afterResponse();
    return prepared.response;
  }

  prepareTurn(request: RuntimeTurnRequest): { response: RuntimeResponse; afterResponse: () => void } {
    const session = this.requireSession();
    if (session.fatalError !== undefined) {
      throw new HostError("PROTOCOL_ERROR", "the runtime session failed before terminal reconciliation");
    }
    if (session.activeTurnId || session.agent.state.isStreaming) {
      throw new HostError("CONFLICT", "the runtime session already has an active turn");
    }
    if (
      this.allowedProviderId === OPENAI_CODEX_PROVIDER_ID &&
      request.output_token_budget !== null &&
      request.output_token_budget < MIN_OPENAI_CODEX_OUTPUT_TOKENS
    ) {
      throw new HostError(
        "INVALID_REQUEST",
        `OpenAI Codex output_token_budget must be at least ${MIN_OPENAI_CODEX_OUTPUT_TOKENS}`,
      );
    }
    const message = this.turnMessage(request);
    session.activeTurnId = request.turn_id;
    session.activeOutputTokenBudget = request.output_token_budget ?? undefined;
    session.activeOutputSchema = request.output_schema ?? undefined;
    session.activeUsage = cloneUsage(EMPTY_USAGE);
    session.cancelRequested = false;
    session.outputBudgetExhausted = false;
    session.terminalToolCallId = undefined;
    let started = false;
    return {
      response: { kind: "accepted" },
      afterResponse: () => {
        if (started) throw new HostError("CONFLICT", `turn ${request.turn_id} was already started`);
        started = true;
        this.launchTurn(session, request, message);
      },
    };
  }

  private launchTurn(session: SessionRecord, request: RuntimeTurnRequest, message: AgentMessage): void {
    const activeRun = this.runTurn(session, request, message);
    session.activeRun = activeRun;
    void activeRun.then(
      () => {
        if (session.activeRun === activeRun) session.activeRun = undefined;
      },
      (error) => {
        session.fatalError = error;
        if (session.activeRun === activeRun) session.activeRun = undefined;
        this.onFatal?.(error);
      },
    );
  }

  control(control: RuntimeControl): RuntimeResponse {
    const prepared = this.prepareControl(control);
    prepared.afterResponse();
    return prepared.response;
  }

  prepareControl(control: RuntimeControl): { response: RuntimeResponse; afterResponse: () => void } {
    const session = this.requireSession();
    if (session.terminalEventPending || !session.activeTurnId) {
      if (session.terminalEventPending || session.lastTerminalTurnId !== undefined) {
        throw new HostError("TERMINAL_RACE", "turn completed before runtime control could be applied");
      }
      throw new HostError("CONFLICT", "runtime session has no active turn");
    }
    const turnId = session.activeTurnId;
    let applied = false;
    return {
      response: { kind: "accepted" },
      afterResponse: () => {
        if (applied) throw new HostError("CONFLICT", `runtime control ${control.control} was already applied`);
        applied = true;
        // A control response can be backpressured while the provider finishes. Bind
        // the deferred side effect to the turn observed when the command was parsed.
        if (session.activeTurnId !== turnId || session.terminalEventPending) return;
        if (control.control === "steer") session.agent.steer(this.textMessage(control.text));
        else if (control.control === "follow_up") session.agent.followUp(this.textMessage(control.text));
        else {
          session.cancelRequested = true;
          session.agent.abort();
        }
      },
    };
  }

  async authenticate(credentialLease: string, request: CredentialBrokerRequest): Promise<RuntimeResponse> {
    if (this.credentialStore instanceof IpcCredentialStore) {
      this.credentialStore.setLease(credentialLease);
    }
    if (request.provider !== "open-ai-codex") {
      throw new HostError("UNSUPPORTED", "only OpenAI Codex OAuth is supported");
    }
    let response: CredentialBrokerResponse;
    switch (request.request) {
      case "status": {
        const credential = await this.readCredential();
        response = {
          response: "status",
          provider: request.provider,
          status: credential
            ? {
                status: "signed_in",
                account_label: accountLabel(credential),
                expires_at: new Date(credential.expires).toISOString(),
              }
            : { status: "signed_out" },
        };
        break;
      }
      case "begin_login":
        response = await this.login(request.preferred_flow);
        break;
      case "acquire_lease": {
        const session = this.requireSession();
        if (request.session_id !== session.id) throw new HostError("NOT_FOUND", "credential lease session mismatch");
        const credential = await this.readCredential();
        response = {
          response: "lease_granted",
          provider: request.provider,
          lease_id: session.credentialLease,
          expires_at: credential ? new Date(credential.expires).toISOString() : null,
        };
        break;
      }
      case "logout":
        await this.credentialStore.delete(this.allowedProviderId);
        response = { response: "logged_out", provider: request.provider };
        break;
    }
    return { kind: "authentication", response };
  }

  async waitForIdle(): Promise<void> {
    if (this.session?.activeRun) await this.session.activeRun;
    else if (this.session) {
      if (this.session.fatalError !== undefined) throw this.session.fatalError;
      await this.session.agent.waitForIdle();
    }
  }

  snapshot(): Record<string, unknown> {
    const session = this.requireSession();
    return {
      session_id: session.id,
      active_turn_id: session.activeTurnId,
      is_streaming: session.agent.state.isStreaming,
      messages: structuredClone(session.agent.state.messages).map((message) => {
        if (message.role !== "assistant" || message.stopReason !== "error") return message;
        const failure = projectProviderFailure(message.errorMessage);
        return { ...message, content: [], errorMessage: failure.message };
      }),
      usage: cloneUsage(session.activeUsage),
    };
  }

  async shutdown(): Promise<void> {
    this.loginController?.abort();
    this.session?.agent.abort();
    await this.waitForIdle();
    this.session = undefined;
  }

  private async runTurn(
    session: SessionRecord,
    request: RuntimeTurnRequest,
    message: AgentMessage,
  ): Promise<void> {
    let stopReason = "stop";
    let failure: ProjectedFailure | undefined;
    try {
      await this.protocol.sendEvent({ event: "turn_started", turn_id: request.turn_id });
      if (session.cancelRequested) {
        stopReason = "aborted";
      } else {
        await session.agent.prompt(message);
        await session.eventChain;
        if (this.shouldCorrectMissingTerminalBoundary(session)) {
          await session.agent.prompt(this.terminalBoundaryCorrection(session.terminalBoundaryTools));
          await session.eventChain;
        }
        const last = session.agent.state.messages.at(-1);
        stopReason = session.terminalToolCallId
          ? "stop"
          : session.outputBudgetExhausted
            ? "output_token_budget"
            : last?.role === "assistant"
              ? last.stopReason
              : session.agent.signal?.aborted
                ? "aborted"
                : "stop";
        if (stopReason === "error") {
          failure = projectProviderFailure(
            last?.role === "assistant" ? last.errorMessage : undefined,
          );
        }
      }
    } catch (error) {
      const last = session.agent.state.messages.at(-1);
      failure =
        last?.role === "assistant" && last.stopReason === "error"
          ? projectProviderFailure(last.errorMessage)
          : projectRuntimeFailure(error);
      stopReason = session.cancelRequested ? "aborted" : "error";
    }

    // The model/tool loop is closed. Mark terminal reconciliation before any
    // diagnostic write so a concurrently backpressured control cannot enqueue
    // Pi work after the final steering/follow-up poll.
    session.terminalEventPending = true;
    if (failure !== undefined && stopReason !== "aborted") {
      try {
        await this.protocol.sendEvent({
          event: "runtime_error",
          turn_id: request.turn_id,
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        });
      } catch {
        // The terminal event below is the authoritative reconciliation attempt.
      }
    }

    let terminalFailure: unknown;
    try {
      await this.protocol.sendEvent({
        event: "turn_completed",
        turn_id: request.turn_id,
        stop_reason: stopReason,
        usage: cloneUsage(session.activeUsage),
      });
    } catch (error) {
      terminalFailure = error;
    } finally {
      session.terminalEventPending = false;
      session.lastTerminalTurnId = request.turn_id;
      if (session.activeTurnId === request.turn_id) {
        session.activeTurnId = undefined;
        session.activeOutputTokenBudget = undefined;
        session.activeOutputSchema = undefined;
        session.cancelRequested = false;
        session.outputBudgetExhausted = false;
        session.activeMessageId = undefined;
        session.toolOutcomes.clear();
        session.brokerDispatchedTools.clear();
        session.truncatedToolCalls.clear();
        session.oversizedToolCalls.clear();
        session.staleAfterRetryableErrorTools.clear();
        session.staleAfterContextDeliveryTools.clear();
        session.repeatedContextTools.clear();
        session.locallyRejectedTools.clear();
        session.retryableToolErrorCallId = undefined;
        session.contextObservationBoundaryCallId = undefined;
        session.terminalToolCallId = undefined;
        session.agent.clearAllQueues();
        session.eventChain = Promise.resolve();
      }
    }
    if (terminalFailure !== undefined) throw terminalFailure;
  }

  private turnMessage(request: RuntimeTurnRequest): AgentMessage {
    const content: Array<TextContent | ImageContent> = [];
    for (const input of request.input) {
      if (input.kind === "text") {
        content.push({ type: "text", text: input.text });
        continue;
      }
      if (!/^image\/[A-Za-z0-9.+-]+$/u.test(input.media_type)) {
        throw new HostError("INVALID_REQUEST", `unsupported image media type ${input.media_type}`);
      }
      if (!/^[A-Fa-f0-9]{64}$/u.test(input.sha256) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data_base64)) {
        throw new HostError("INVALID_REQUEST", "image hash or base64 encoding is invalid");
      }
      const data = Buffer.from(input.data_base64, "base64");
      const hash = createHash("sha256").update(data).digest("hex");
      if (hash !== input.sha256.toLowerCase()) throw new HostError("INVALID_REQUEST", "image sha256 does not match its bytes");
      content.push({ type: "image", data: input.data_base64, mimeType: input.media_type });
    }
    if (request.output_schema) {
      content.push({
        type: "text",
        text: `Koni output contract (the Rust compiler validates this schema): ${JSON.stringify(request.output_schema)}`,
      });
    }
    if (content.length === 0) throw new HostError("INVALID_REQUEST", "turn input cannot be empty");
    return { role: "user", content, timestamp: Date.now() };
  }

  private textMessage(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  }

  private shouldCorrectMissingTerminalBoundary(session: SessionRecord): boolean {
    if (
      session.terminalBoundaryTools.length === 0 ||
      session.terminalToolCallId !== undefined ||
      session.cancelRequested ||
      session.outputBudgetExhausted ||
      session.agent.signal?.aborted
    ) {
      return false;
    }
    const last = session.agent.state.messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop") return false;
    let nonemptyProse = false;
    for (const block of last.content) {
      if (block.type === "toolCall") return false;
      if (block.type === "text" && block.text.trim().length > 0) nonemptyProse = true;
    }
    if (!nonemptyProse) return false;
    if (session.activeOutputTokenBudget !== undefined) {
      const remaining = Math.max(
        0,
        session.activeOutputTokenBudget - session.activeUsage.output_tokens,
      );
      if (remaining < session.minimumProviderOutputTokens) {
        session.outputBudgetExhausted = true;
        return false;
      }
    }
    return true;
  }

  private terminalBoundaryCorrection(tools: readonly string[]): AgentMessage {
    return this.textMessage(
      `Koni compiler correction: continue the same compiler-issued assignment from its current repository and receipt state. Do not repeat effects already accepted by the compiler. Before stopping, invoke one appropriate terminal boundary tool from this allowed list: ${tools.join(
        ", ",
      )}. Do not answer with prose alone.`,
    );
  }

  private createTool(
    sessionId: string,
    definition: RuntimeToolDefinition,
    outcomes: Map<string, AgentToolOutcome>,
  ): AgentTool<TSchema> {
    return {
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.input_schema as TSchema,
      executionMode: "sequential",
      execute: async (toolCallId, arguments_, signal) => {
        const session = this.requireActiveSession();
        if (session.id !== sessionId) throw new HostError("PROTOCOL_ERROR", "tool call crossed runtime sessions");
        if (session.terminalToolCallId) {
          session.agent.abort();
          return {
            content: [{ type: "text", text: "compiler already accepted a terminal tool outcome" }],
            details: { status: "terminate", value: null },
            terminate: true,
          };
        }
        if (session.outputBudgetExhausted) {
          session.agent.abort();
          throw new HostError("CANCELLED", "turn output-token budget is exhausted");
        }
        if (session.contextObservationBoundaryCallId) {
          const outcome: AgentToolOutcome = {
            status: "error",
            code: "stale_after_context_delivery",
            message:
              "A prior compiler-context result in this model-authored batch must be observed first. Review it, then issue only the next exact context continuation or informed product call.",
            retryable: true,
          };
          session.staleAfterContextDeliveryTools.add(toolCallId);
          outcomes.set(toolCallId, outcome);
          return {
            content: outcomeContent(outcome),
            details: outcome,
          };
        }
        if (session.retryableToolErrorCallId) {
          const outcome: AgentToolOutcome = {
            status: "error",
            code: "stale_after_retryable_error",
            message:
              "A prior call in this model-authored tool batch needs correction. Review its result, then issue only informed replacement calls.",
            retryable: true,
          };
          session.staleAfterRetryableErrorTools.add(toolCallId);
          outcomes.set(toolCallId, outcome);
          return {
            content: outcomeContent(outcome),
            details: outcome,
          };
        }
        if (
          session.contextCompletionRequired &&
          definition.name === "context" &&
          session.contextIssued
        ) {
          const retryable = session.contextRepeatRejections === 0;
          session.contextRepeatRejections += 1;
          const outcome: AgentToolOutcome = {
            status: "error",
            code: retryable ? "context_already_issued" : "context_already_issued_retry_limit",
            message: retryable
              ? "Compiler context was already issued in this session. Continue its exact paging cursor or proceed with informed product work; do not restart context."
              : "Compiler context was repeated after one correction. Stop this session rather than spending more provider turns on an immutable context pack.",
            retryable,
          };
          session.repeatedContextTools.add(toolCallId);
          outcomes.set(toolCallId, outcome);
          if (!retryable) {
            session.terminalToolCallId = toolCallId;
            session.agent.abort();
          }
          return {
            content: outcomeContent(outcome),
            details: outcome,
            ...(!retryable ? { terminate: true } : {}),
          };
        }
        if (!toolArgumentsFitPublicFrame(arguments_)) {
          session.oversizedToolCalls.add(toolCallId);
          const outcome: AgentToolOutcome = {
            status: "error",
            code: "arguments_too_large",
            message: "Tool arguments exceed the compiler transport bound; narrow or paginate the request.",
            retryable: true,
          };
          return {
            content: outcomeContent(outcome),
            details: outcome,
          };
        }
        session.brokerDispatchedTools.add(toolCallId);
        const outcome = await this.protocol.executeTool(
          { call_id: toolCallId, name: definition.name, arguments: arguments_ },
          signal,
        );
        outcomes.set(toolCallId, outcome);
        if (outcome.status === "success" && session.contextCompletionRequired) {
          const contextDelivery = contextContinuationAfterDelivery(
            definition.name,
            arguments_,
            outcome.value,
            session.contextContinuation,
            session.contextIssued,
          );
          if (contextDelivery.delivered) {
            session.contextContinuation = contextDelivery.next;
            session.contextIssued = true;
            session.contextObservationBoundaryCallId = toolCallId;
          }
        }
        if (outcome.status === "error" && outcome.retryable) {
          session.retryableToolErrorCallId = toolCallId;
        }
        const terminal = outcome.status === "terminate" || (outcome.status === "error" && !outcome.retryable);
        if (terminal) {
          session.terminalToolCallId = toolCallId;
          session.agent.abort();
        }
        return {
          content: outcomeContent(outcome),
          details: outcome,
          ...(terminal ? { terminate: true } : {}),
        };
      },
    };
  }

  private async forwardAgentEvent(session: SessionRecord, event: AgentEvent): Promise<void> {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    switch (event.type) {
      case "message_start":
        if (event.message.role === "toolResult" && session.locallyRejectedTools.has(event.message.toolCallId)) {
          break;
        }
        if (session.terminalToolCallId || session.outputBudgetExhausted) break;
        session.messageCounter += 1;
        session.activeMessageId = `message-${session.messageCounter}`;
        break;
      case "message_update":
        // Provider streams may split one bounded response into thousands of
        // tiny text fragments. Koni's durable/TUI projection intentionally
        // publishes only message_completed, so forwarding these deltas adds
        // no observable product value and can exhaust the compiler's bounded
        // public-event transcript before the authoritative message arrives.
        // Keep them inside the verified host and publish the complete message
        // once at message_end.
        break;
      case "message_end": {
        if (event.message.role === "toolResult" && session.locallyRejectedTools.delete(event.message.toolCallId)) {
          break;
        }
        if (session.terminalToolCallId || session.outputBudgetExhausted) break;
        const messageId = session.activeMessageId ?? `message-${session.messageCounter}`;
        if (event.message.role === "assistant" && event.message.stopReason === "length") {
          for (const block of event.message.content) {
            if (block.type === "toolCall") session.truncatedToolCalls.add(block.id);
          }
        }
        const calculated =
          event.message.role === "assistant" ? calculateUsage(session.activeUsage, event.message) : undefined;
        const exceededOutputBudget =
          calculated !== undefined &&
          session.activeOutputTokenBudget !== undefined &&
          calculated.nextTotal.output_tokens > session.activeOutputTokenBudget;
        await this.protocol.sendEvent({
          event: "message_completed",
          turn_id: turnId,
          message_id: messageId,
          role: String(event.message.role),
          content: "content" in event.message ? event.message.content : event.message,
        });
        session.activeMessageId = undefined;
        if (calculated !== undefined) {
          await this.protocol.sendEvent({ event: "usage", turn_id: turnId, usage: calculated.usage });
          session.activeUsage = calculated.nextTotal;
          if (exceededOutputBudget) {
            // Preserve the completed message and exact billed usage before
            // failing closed. The compiler-owned local transcript can then
            // explain an oversized response instead of retaining only a
            // generic runtime error with zero usage.
            session.outputBudgetExhausted = true;
            session.agent.abort();
            throw new HostError("OUTPUT_LIMIT", "Pi provider exceeded the turn output-token budget");
          }
          if (
            session.activeOutputTokenBudget !== undefined &&
            session.activeUsage.output_tokens >= session.activeOutputTokenBudget
          ) {
            session.outputBudgetExhausted = true;
            session.agent.abort();
          }
        }
        break;
      }
      case "tool_execution_start":
        if (session.outputBudgetExhausted) break;
        if (session.terminalToolCallId && event.toolCallId !== session.terminalToolCallId) break;
        await this.protocol.sendEvent({
          event: "tool_started",
          turn_id: turnId,
          call_id: event.toolCallId,
          name: event.toolName,
        });
        break;
      case "tool_execution_update":
        if (session.outputBudgetExhausted) break;
        if (session.terminalToolCallId && event.toolCallId !== session.terminalToolCallId) break;
        await this.protocol.sendEvent({
          event: "tool_updated",
          turn_id: turnId,
          call_id: event.toolCallId,
          update: event.partialResult,
        });
        break;
      case "tool_execution_end": {
        if (session.outputBudgetExhausted) break;
        if (session.terminalToolCallId && event.toolCallId !== session.terminalToolCallId) break;
        if (session.staleAfterContextDeliveryTools.delete(event.toolCallId)) {
          session.toolOutcomes.delete(event.toolCallId);
          session.locallyRejectedTools.add(event.toolCallId);
          await this.protocol.sendEvent({
            event: "tool_rejected",
            turn_id: turnId,
            call_id: event.toolCallId,
            name: event.toolName,
            code: "pi_tool_stale_after_context_delivery",
            message: "Pi skipped a stale sibling call until the model observes compiler context",
          });
          break;
        }
        if (session.repeatedContextTools.delete(event.toolCallId)) {
          session.toolOutcomes.delete(event.toolCallId);
          session.locallyRejectedTools.add(event.toolCallId);
          await this.protocol.sendEvent({
            event: "tool_rejected",
            turn_id: turnId,
            call_id: event.toolCallId,
            name: event.toolName,
            code: "pi_tool_context_already_issued",
            message: "Pi rejected a repeated context call without compiler dispatch",
          });
          break;
        }
        if (session.staleAfterRetryableErrorTools.delete(event.toolCallId)) {
          session.toolOutcomes.delete(event.toolCallId);
          session.locallyRejectedTools.add(event.toolCallId);
          await this.protocol.sendEvent({
            event: "tool_rejected",
            turn_id: turnId,
            call_id: event.toolCallId,
            name: event.toolName,
            code: "pi_tool_stale_after_retryable_error",
            message: "Pi skipped a stale sibling call after an earlier retryable compiler error",
          });
          break;
        }
        const outcome = session.toolOutcomes.get(event.toolCallId);
        if (!outcome) {
          if (session.brokerDispatchedTools.delete(event.toolCallId)) {
            throw new HostError(
              "PROVIDER_ERROR",
              `compiler-brokered tool ${event.toolCallId} ended without a compiler outcome`,
            );
          }
          const truncated = session.truncatedToolCalls.delete(event.toolCallId);
          const oversized = session.oversizedToolCalls.delete(event.toolCallId);
          session.locallyRejectedTools.add(event.toolCallId);
          await this.protocol.sendEvent({
            event: "tool_rejected",
            turn_id: turnId,
            call_id: event.toolCallId,
            name: event.toolName,
            code: truncated
              ? "pi_tool_truncated"
              : oversized
                ? "pi_tool_arguments_too_large"
                : "pi_tool_validation",
            message: truncated
              ? "Pi rejected a tool call because its model response was truncated"
              : oversized
                ? "Pi rejected oversized tool arguments before compiler dispatch"
                : "Pi rejected a tool call before compiler dispatch",
          });
          break;
        }
        session.toolOutcomes.delete(event.toolCallId);
        session.brokerDispatchedTools.delete(event.toolCallId);
        await this.protocol.sendEvent({
          event: "tool_completed",
          turn_id: turnId,
          call_id: event.toolCallId,
          outcome,
        });
        break;
      }
      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
        break;
    }
  }

  private async login(flow: "browser_pkce" | "device_code"): Promise<CredentialBrokerResponse> {
    if (this.loginController) throw new HostError("CONFLICT", "an OAuth login is already active");
    const oauth = this.provider.auth.oauth;
    if (!oauth) throw new HostError("UNSUPPORTED", "the configured provider does not support OAuth");
    const controller = new AbortController();
    this.loginController = controller;
    const timeout = setTimeout(() => controller.abort(), this.oauthLoginTimeoutMs);
    let interactionChain: Promise<void> = Promise.resolve();
    try {
      if (flow === "browser_pkce") await this.oauthCallbackProbe?.(controller.signal);
      const login = oauth.login({
        signal: controller.signal,
        prompt: (prompt) => this.resolveLoginPrompt(flow, prompt, controller.signal),
        notify: (event) => {
          if (controller.signal.aborted) return;
          const next = interactionChain.then(() => this.emitAuthInteraction(event));
          interactionChain = next;
          void next.catch(() => undefined);
        },
      });
      void login.catch(() => undefined);
      const cancelled = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new HostError("CANCELLED", "OpenAI Codex OAuth login was cancelled or timed out")),
          { once: true },
        );
      });
      const credential = await Promise.race([login, cancelled]);
      await interactionChain;
      this.redactor.addCredential(credential);
      const stored = await this.credentialStore.modify(this.allowedProviderId, async () => credential);
      if (!stored || stored.type !== "oauth") throw new HostError("PROVIDER_ERROR", "credential broker did not persist OAuth login");
      return {
        response: "login_started",
        provider: "open-ai-codex",
        status: {
          status: "signed_in",
          account_label: accountLabel(stored),
          expires_at: new Date(stored.expires).toISOString(),
        },
      };
    } catch (error) {
      await interactionChain.catch(() => undefined);
      if (controller.signal.aborted || (error instanceof HostError && error.code === "CANCELLED")) {
        throw new HostError("CANCELLED", "OpenAI Codex OAuth login was cancelled or timed out");
      }
      if (
        error instanceof HostError &&
        error.code === "AUTHENTICATION_FAILED" &&
        error.message === OAUTH_CALLBACK_UNAVAILABLE_MESSAGE
      ) {
        throw error;
      }
      throw new HostError(
        "AUTHENTICATION_FAILED",
        "OpenAI Codex sign-in did not complete; try signing in again",
      );
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (this.loginController === controller) this.loginController = undefined;
    }
  }

  private async resolveLoginPrompt(
    flow: "browser_pkce" | "device_code",
    prompt: AuthPrompt,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw new HostError("CANCELLED", "OpenAI Codex OAuth login was cancelled");
    if (prompt.type === "select") {
      const desired = flow === "device_code" ? "device_code" : "browser";
      if (!prompt.options.some((option) => option.id === desired)) {
        throw new HostError("PROVIDER_ERROR", `OpenAI Codex OAuth did not offer the requested ${desired} flow`);
      }
      return desired;
    }
    if (prompt.type === "manual_code") {
      // Pi races this prompt with its localhost callback. Koni intentionally
      // has no secret/manual-code input on the public protocol, so keep the
      // prompt pending until Pi aborts it after the browser callback wins.
      // Rejecting immediately would cancel the otherwise healthy browser
      // flow before the user could finish signing in.
      return await new Promise<string>((_resolve, reject) => {
        const signals = [signal, prompt.signal].filter((candidate): candidate is AbortSignal => candidate !== undefined);
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          for (const candidate of signals) candidate.removeEventListener("abort", onAbort);
          reject(new HostError("CANCELLED", "OpenAI Codex browser login prompt closed"));
        };
        if (signals.some((candidate) => candidate.aborted)) {
          onAbort();
          return;
        }
        for (const candidate of signals) candidate.addEventListener("abort", onAbort, { once: true });
      });
    }
    throw new HostError(
      "PROVIDER_ERROR",
      "OpenAI Codex browser login requested an unsupported prompt",
    );
  }

  private async emitAuthInteraction(event: {
    type: "auth_url" | "device_code" | "progress";
    [key: string]: unknown;
  }): Promise<void> {
    let interaction: OAuthInteractionWire;
    if (event.type === "auth_url") {
      interaction = {
        interaction: "auth_url",
        url: this.redactor.redact(String(event["url"])),
        instructions:
          typeof event["instructions"] === "string" ? this.redactor.redact(event["instructions"]) : null,
      };
    } else if (event.type === "device_code") {
      interaction = {
        interaction: "device_code",
        user_code: String(event["userCode"]),
        verification_uri: this.redactor.redact(String(event["verificationUri"])),
        interval_seconds: typeof event["intervalSeconds"] === "number" ? event["intervalSeconds"] : null,
        expires_in_seconds: typeof event["expiresInSeconds"] === "number" ? event["expiresInSeconds"] : null,
      };
    } else {
      interaction = { interaction: "progress", message: this.redactor.redact(String(event["message"])) };
    }
    await this.protocol.sendEvent({ event: "authentication", interaction });
  }

  private async readCredential(): Promise<OAuthCredential | undefined> {
    const credential = await this.credentialStore.read(this.allowedProviderId);
    if (!credential) return undefined;
    if (credential.type !== "oauth") throw new HostError("UNSUPPORTED", "stored credential is not OAuth");
    this.redactor.addCredential(credential);
    return credential;
  }

  private requireModel(modelId: string): Model<Api> {
    const model = this.models.getModel(this.allowedProviderId, modelId);
    if (!model) throw new HostError("NOT_FOUND", `unknown ${this.allowedProviderId} model ${modelId}`);
    return model;
  }

  private requireThinkingLevel(model: Model<Api>, thinkingLevel: ThinkingLevel): void {
    if (!getSupportedThinkingLevels(model).includes(thinkingLevel)) {
      throw new HostError("INVALID_REQUEST", `model ${model.id} does not support thinking level ${thinkingLevel}`);
    }
  }

  private requireSession(): SessionRecord {
    if (!this.session) throw new HostError("NOT_INITIALIZED", "runtime session has not started");
    return this.session;
  }

  private requireActiveSession(): SessionRecord & { activeTurnId: string } {
    const session = this.requireSession();
    if (!session.activeTurnId) {
      throw new HostError("CONFLICT", "runtime session has no active turn");
    }
    return session as SessionRecord & { activeTurnId: string };
  }
}
