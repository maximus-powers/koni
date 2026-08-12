import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type Api, type Model } from "@earendil-works/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  ModelRuntime,
  SessionManager,
  VERSION as PI_CODING_AGENT_VERSION,
  createAgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import {
  canonicalEncode,
  canonicalHash,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  createKoniManagedExtension,
  renderCompactionSummary,
  type CompactionLifecycleNotice,
  type KoniAuthorizedMessage,
  type KoniAttemptRecoveryClaim,
  type KoniAttemptRecoveryState,
  type KoniAttemptUsage,
  type KoniContextProvider,
  type KoniProviderRequestRecoveryRecord,
  type KoniProviderRequestReservation,
  providerRequestRetirementValidationError,
} from "./compaction.js";
import { type AgentLaunchSpec, validateAgentLaunchSpec } from "./launch-spec.js";
import { createContainedResourceLoader } from "./resource-loader.js";
import {
  assertAutonomousPiSession,
  parsePiSession,
  readPiSessionDurably,
  summarizeUsage,
  type ParsedPiSession,
  type PiSessionEntry,
} from "./session-transcript.js";
import { createFileAtomicallyNoReplace } from "./atomic-file.js";
import {
  koniToolResultPayloadBytes,
  renderKoniToolReceipt,
  validateKoniToolReceipt,
  type KoniRuntimeToolRejection,
  type KoniToolReceipt,
} from "./tool-catalog.js";
import { sealPiModelDescriptor } from "./model-catalog.js";
import {
  deriveProviderSettlement,
  deriveProviderSettlements,
  isSupportedStoredProviderInputEstimate,
  isSupportedProviderOutputCap,
  providerApiHasSupportedOutputCap,
  providerPayloadIdentity,
  serializedProviderOutputCap,
} from "./provider-request.js";

const ABORT_ACK_TIMEOUT_MS = 5_000;
const MAX_RECOVERY_SINGLE_ENTRY_OVERSHOOT_BYTES = 24 * 1024 * 1024;
const PINNED_PI_CODING_AGENT_VERSION = "0.80.10";
const TRANSCRIPT_TOOL_RESULT_OVERHEAD_BYTES = 4 * 1024;
const RUNTIME_REJECTION_RESULT_BYTES = 64 * 1024;
const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";

export interface AuthorityBackedTool {
  name: string;
  schemaHash: Sha256Digest;
  maxResultBytes: number;
  /**
   * Context-free authority invocation used both by Pi and crash recovery. Keeping this
   * separate from Pi's presentation-oriented ToolDefinition prevents recovery from
   * fabricating an ExtensionContext merely to replay an idempotent broker call.
   */
  execute(
    toolCallId: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>>;
  /** Durably record a runtime-originated no-effect denial through the same authority ledger. */
  reject(
    toolCallId: string,
    parameters: Record<string, unknown>,
    rejection: KoniRuntimeToolRejection,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>>;
  definition: ToolDefinition;
  terminalOutputSchema?: TSchema;
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
  "created" | "running" | "aborting" | "aborted" | "completed" | "failed" | "disposed";

export type ManagedSessionEvent =
  | { type: "status"; status: ManagedSessionStatus; detail?: string }
  | { type: "pi_lifecycle"; eventType: string }
  | { type: "usage"; usage: ManagedTokenUsage }
  | { type: "terminal"; toolName: string; output: unknown }
  | { type: "compaction"; notice: CompactionLifecycleNotice };

export type ManagedSessionOutcome =
  | { status: "completed"; terminalOutput: unknown; usage: ManagedTokenUsage }
  | {
      status: "checkpointed";
      revision: number;
      terminalOutput: unknown;
      usage: ManagedTokenUsage;
    }
  | { status: "failed"; error: string; code?: string; usage: ManagedTokenUsage }
  | { status: "aborted"; reason: string; usage: ManagedTokenUsage };

export interface PiSessionAdapter {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly recovery?: RecoveredSessionState | undefined;
  readonly mappingPersisted?: boolean;
  getActiveToolNames(): readonly string[];
  appendMapping(data: unknown): void;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  subscribeNotices?(listener: (notice: CompactionLifecycleNotice) => void): () => void;
  /** Production emits only after the authority durably settles canonical Pi JSONL usage. */
  subscribeAuthorityUsage?(listener: (usage: ManagedTokenUsage) => void): () => void;
  prompt(text: string): Promise<void>;
  continue(): Promise<void>;
  steer(message: KoniAuthorizedMessage): Promise<void>;
  followUp(message: KoniAuthorizedMessage): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface RecoveredSessionState {
  usage: ManagedTokenUsage;
  /** Number of durable reservations already issued in this linear attempt. */
  providerRequestCount?: number;
  pendingMessages?: readonly PendingRecoveredMessage[];
  pendingToolActions?: readonly PendingRecoveredToolAction[];
  disposition:
    | { kind: "prompt" }
    | { kind: "continue" }
    | { kind: "complete"; terminalOutput: unknown }
    | { kind: "blocked"; reason: string }
    | { kind: "revoked"; reason: string };
}

interface PendingRecoveredMessage {
  message: KoniAuthorizedMessage;
  mappingPersisted: boolean;
}

interface PendingRecoveredToolActionBase {
  order: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

type PendingRecoveredToolAction = PendingRecoveredToolActionBase &
  (
    | {
        kind: "append_receipt";
        authorizedResult: KoniAttemptRecoveryState["authorizedToolResults"][number];
      }
    | { kind: "execute" }
    | { kind: "append_pi_error"; errorText: string }
  );

interface AuthenticatedRecovery {
  projection: RecoveredSessionState;
  release(): Promise<void>;
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

export interface ManagedPlanningRevisionOptions extends ManagedPiSessionFactoryOptions {
  priorTranscriptSha256: Sha256Digest;
  factory?: ManagedPiSessionFactory;
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
  #unsubscribeNotices: (() => void) | undefined;
  #unsubscribeAuthorityUsage: (() => void) | undefined;
  readonly #usesAuthorityUsage: boolean;
  #startPromise: Promise<ManagedSessionOutcome> | undefined;
  #abortPromise: Promise<void> | undefined;
  #releasePromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;
  #abortReason = "aborted by authority";
  #abortAsFailure = false;
  #failureCode: string | undefined;
  #terminalCount = 0;
  #terminalOutput: unknown;
  readonly #terminalOutputSchema: TSchema;
  readonly #terminalArguments = new Map<string, unknown>();
  readonly #terminalArgumentErrors = new Map<string, string>();
  #failure: string | undefined;
  #latestProviderError: string | undefined;
  readonly #recovery: RecoveredSessionState | undefined;

  private constructor(
    spec: Readonly<AgentLaunchSpec>,
    adapter: PiSessionAdapter,
    appendMapping: boolean,
    terminalTool: AuthorityBackedTool,
    initialUsage?: ManagedTokenUsage,
  ) {
    this.spec = spec;
    this.#adapter = adapter;
    this.#terminalOutputSchema = structuredClone(terminalTool.terminalOutputSchema!);
    this.#usesAuthorityUsage = adapter.subscribeAuthorityUsage !== undefined;
    const recovery = adapter.recovery;
    this.#recovery =
      recovery?.disposition.kind === "complete"
        ? {
            usage: { ...recovery.usage },
            disposition: {
              kind: "complete",
              terminalOutput: validateTerminalPayload(
                spec,
                this.#terminalOutputSchema,
                recovery.disposition.terminalOutput,
                "accepted terminal output",
              ),
            },
          }
        : recovery;
    if (this.#recovery !== undefined) {
      validateManagedUsage(this.#recovery.usage);
      Object.assign(this.#usage, this.#recovery.usage);
    } else if (initialUsage !== undefined) {
      validateManagedUsage(initialUsage);
      Object.assign(this.#usage, initialUsage);
    }
    assertExactToolInventory(spec, adapter.getActiveToolNames());
    if (adapter.sessionId !== spec.identity.sessionId) {
      throw new ManagedSessionError(
        "session_identity",
        "Pi created a different session identity than authorized",
      );
    }
    if (appendMapping && adapter.mappingPersisted !== true) {
      adapter.appendMapping(attemptSessionMapping(spec, adapter.sessionFile));
    }
    this.#unsubscribe = adapter.subscribe((event) => this.#onPiEvent(event));
    this.#unsubscribeNotices = adapter.subscribeNotices?.((notice) => {
      this.#emit({ type: "compaction", notice });
    });
    this.#unsubscribeAuthorityUsage = adapter.subscribeAuthorityUsage?.((usage) => {
      try {
        validateManagedUsage(usage);
        assertMonotonicUsage(this.#usage, usage);
        Object.assign(this.#usage, usage);
        this.#emit({ type: "usage", usage: this.usage });
        const violation = tokenBudgetViolation(this.spec, this.#usage);
        if (violation !== undefined && this.#failure === undefined) {
          this.#failure = violation;
          this.#requestAbort(violation);
        }
      } catch (error) {
        this.#failure = error instanceof Error ? error.message : String(error);
        this.#requestAbort(this.#failure, true);
      }
    });
  }

  public static async create(
    specValue: AgentLaunchSpec,
    options: ManagedPiSessionFactoryOptions & { factory?: ManagedPiSessionFactory },
  ): Promise<ManagedPiSession> {
    const spec = validateAgentLaunchSpec(specValue);
    validateToolBindings(spec, options.tools);
    const adapter = await (options.factory ?? createManagedPiSession)(spec, options);
    try {
      const terminalTool = validateToolBindings(spec, options.tools);
      return new ManagedPiSession(spec, adapter, true, terminalTool);
    } catch (error) {
      await disposeRejectedAdapter(adapter);
      throw error;
    }
  }

  public static async recover(
    specValue: AgentLaunchSpec,
    options: ManagedPiSessionFactoryOptions & { factory?: ManagedPiSessionFactory },
  ): Promise<ManagedPiSession> {
    const spec = validateAgentLaunchSpec(specValue);
    validateToolBindings(spec, options.tools);
    const adapter = await (options.factory ?? recoverManagedPiSession)(spec, options);
    if (adapter.recovery === undefined) {
      await disposeRejectedAdapter(adapter);
      throw new ManagedSessionError(
        "recovery_projection",
        "recovery factory did not authenticate a durable session",
      );
    }
    if (adapter.recovery.disposition.kind === "blocked") {
      const reason = adapter.recovery.disposition.reason;
      await disposeRejectedAdapter(adapter);
      throw new ManagedSessionError("recovery_blocked", reason);
    }
    try {
      const terminalTool = validateToolBindings(spec, options.tools);
      return new ManagedPiSession(spec, adapter, false, terminalTool);
    } catch (error) {
      await disposeRejectedAdapter(adapter);
      throw error;
    }
  }

  public static async continuePlanningRevision(
    specValue: AgentLaunchSpec,
    options: ManagedPlanningRevisionOptions,
  ): Promise<ManagedPiSession> {
    const spec = validateAgentLaunchSpec(specValue);
    if (spec.planningRevision === undefined || spec.planningRevision.revision < 1) {
      throw new ManagedSessionError(
        "planning_revision",
        "continued planning requires a later immutable planning revision binding",
      );
    }
    if (!isSha256Digest(options.priorTranscriptSha256)) {
      throw new ManagedSessionError(
        "planning_revision_transcript",
        "continued planning requires the prior checkpoint transcript hash",
      );
    }
    validateToolBindings(spec, options.tools);
    const adapter = await (options.factory ?? continueManagedPlanningSession)(spec, options);
    try {
      const terminalTool = validateToolBindings(spec, options.tools);
      const baseline = spec.planningRevision.budgetBaseline;
      return new ManagedPiSession(spec, adapter, false, terminalTool, {
        input: baseline.inputTokens,
        output: baseline.outputTokens,
        cacheRead: baseline.cacheReadTokens,
        cacheWrite: baseline.cacheWriteTokens,
        newTokens: safeUsageSum(baseline.inputTokens, baseline.outputTokens),
        allTokens: safeUsageSum(
          baseline.inputTokens,
          baseline.outputTokens,
          baseline.cacheReadTokens,
          baseline.cacheWriteTokens,
        ),
      });
    } catch (error) {
      await disposeRejectedAdapter(adapter);
      throw error;
    }
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
      return Promise.reject(
        new ManagedSessionError("start_state", `cannot start a ${this.#status} session`),
      );
    }
    this.#startPromise = this.#runAndRelease();
    return this.#startPromise;
  }

  public async steer(message: KoniAuthorizedMessage): Promise<void> {
    this.#assertCanMessage("steer", message);
    await this.#adapter.steer(message);
  }

  public async followUp(message: KoniAuthorizedMessage): Promise<void> {
    this.#assertCanMessage("follow_up", message);
    await this.#adapter.followUp(message);
  }

  public abort(reason = "aborted by authority"): Promise<void> {
    if (
      this.#status === "aborted" ||
      this.#status === "disposed" ||
      this.#status === "completed" ||
      this.#status === "failed"
    ) {
      return Promise.resolve();
    }
    if (this.#abortPromise !== undefined) {
      return this.#abortPromise;
    }
    this.#abortReason = sanitizeText(reason);
    this.#setStatus("aborting", this.#abortReason);
    this.#abortPromise = (async () => {
      await withTimeout(
        this.#adapter.abort(),
        ABORT_ACK_TIMEOUT_MS,
        `Pi session did not acknowledge abort within ${ABORT_ACK_TIMEOUT_MS}ms`,
      );
      if (this.#status === "aborting") {
        this.#setStatus("aborted", this.#abortReason);
      }
    })();
    return this.#abortPromise;
  }

  public dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeOnce();
    return this.#disposePromise;
  }

  /** Release provider/extension resources while preserving the durable transcript and outcome state. */
  public releaseRuntime(): Promise<void> {
    this.#releasePromise ??= this.#releaseRuntimeOnce();
    return this.#releasePromise;
  }

  async #disposeOnce(): Promise<void> {
    let firstError: unknown;
    try {
      await this.abort("session disposed");
    } catch (error) {
      firstError = error;
    }
    try {
      await this.releaseRuntime();
    } catch (error) {
      firstError ??= error;
    }
    this.#setStatus("disposed");
    this.#listeners.clear();
    if (firstError !== undefined) throw firstError;
  }

  async #releaseRuntimeOnce(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#unsubscribeNotices?.();
    this.#unsubscribeNotices = undefined;
    this.#unsubscribeAuthorityUsage?.();
    this.#unsubscribeAuthorityUsage = undefined;
    await this.#adapter.dispose();
  }

  async #runAndRelease(): Promise<ManagedSessionOutcome> {
    let outcome: ManagedSessionOutcome;
    try {
      outcome = await this.#run();
    } catch (error) {
      try {
        await this.releaseRuntime();
      } catch {
        // Preserve the primary execution exception.
      }
      throw error;
    }
    try {
      await this.releaseRuntime();
      return outcome;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (outcome.status === "completed" || outcome.status === "checkpointed") {
        // The terminal tool's resolved receipt means the authority effect is durably accepted.
        // Pi cleanup cannot roll that transaction back or turn it into replayable failed work.
        this.#setStatus("completed", `Pi cleanup warning after terminal acceptance: ${detail}`);
        return outcome;
      }
      const failure = `Pi session runtime cleanup failed: ${detail}`;
      this.#failure = failure;
      this.#failureCode = "runtime_cleanup";
      this.#setStatus("failed", failure);
      return { status: "failed", error: failure, code: this.#failureCode, usage: this.usage };
    }
  }

  async #run(): Promise<ManagedSessionOutcome> {
    this.#setStatus("running");
    if (this.#recovery?.disposition.kind === "complete") {
      this.#terminalCount = 1;
      this.#terminalOutput = this.#recovery.disposition.terminalOutput;
      this.#emit({
        type: "terminal",
        toolName: this.spec.terminal.toolName,
        output: this.#terminalOutput,
      });
      this.#setStatus("completed", "recovered accepted terminal receipt");
      return this.#acceptedOutcome(this.#terminalOutput);
    }
    if (this.#recovery?.disposition.kind === "blocked") {
      this.#setStatus("failed", this.#recovery.disposition.reason);
      return {
        status: "failed",
        error: this.#recovery.disposition.reason,
        code: "recovery_blocked",
        usage: this.usage,
      };
    }
    if (this.#recovery?.disposition.kind === "revoked") {
      this.#abortReason = this.#recovery.disposition.reason;
      this.#setStatus("aborted", this.#abortReason);
      return { status: "aborted", reason: this.#abortReason, usage: this.usage };
    }
    const recoveryBudgetViolation =
      tokenBudgetViolation(this.spec, this.#usage) ??
      (this.#recovery === undefined ? undefined : tokenBudgetExhaustion(this.spec, this.#usage));
    if (this.#recovery !== undefined && recoveryBudgetViolation !== undefined) {
      await this.abort(recoveryBudgetViolation);
      return { status: "aborted", reason: recoveryBudgetViolation, usage: this.usage };
    }
    try {
      if (this.#recovery?.disposition.kind === "continue") {
        await this.#adapter.continue();
      } else {
        await this.#adapter.prompt(this.spec.persona.initialPrompt);
      }
    } catch (error) {
      if (this.#status !== "aborting" && this.#status !== "aborted") {
        this.#failure = error instanceof Error ? error.message : String(error);
        if (error instanceof ManagedSessionError) this.#failureCode = error.code;
      }
    }

    const aborted = await this.#settleAbortOutcome();
    if (aborted !== undefined) return aborted;
    if (this.#failure !== undefined) {
      this.#setStatus("failed", this.#failure);
      return {
        status: "failed",
        error: this.#failure,
        ...(this.#failureCode === undefined ? {} : { code: this.#failureCode }),
        usage: this.usage,
      };
    }
    if (this.#terminalCount !== 1) {
      const error =
        this.#terminalCount === 0
          ? `agent settled without calling terminal tool ${this.spec.terminal.toolName}`
          : `agent called terminal tool ${this.spec.terminal.toolName} more than once`;
      this.#setStatus("failed", error);
      return { status: "failed", error, code: "terminal_protocol", usage: this.usage };
    }
    this.#setStatus("completed");
    return this.#acceptedOutcome(this.#terminalOutput);
  }

  #acceptedOutcome(terminalOutput: unknown): ManagedSessionOutcome {
    const revision = this.spec.planningRevision?.revision;
    return revision === undefined
      ? { status: "completed", terminalOutput, usage: this.usage }
      : { status: "checkpointed", revision, terminalOutput, usage: this.usage };
  }

  #onPiEvent(event: AgentSessionEvent): void {
    this.#emit({ type: "pi_lifecycle", eventType: event.type });
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.#latestProviderError =
        event.message.stopReason === "error"
          ? sanitizeProviderError(event.message.errorMessage)
          : undefined;
      if (!this.#usesAuthorityUsage) {
        const usage = event.message.usage;
        try {
          addUsage(this.#usage, usage.input, usage.output, usage.cacheRead, usage.cacheWrite);
        } catch (error) {
          this.#failure = error instanceof Error ? error.message : String(error);
          this.#requestAbort(this.#failure, true);
          return;
        }
        this.#emit({ type: "usage", usage: this.usage });
        const violation = tokenBudgetViolation(this.spec, this.#usage);
        if (violation !== undefined && this.#failure === undefined) {
          this.#failure = violation;
          this.#requestAbort(violation);
        }
      }
      const toolCalls = event.message.content.filter((block) => block.type === "toolCall");
      const terminalCalls = toolCalls.filter((block) => block.name === this.spec.terminal.toolName);
      if (terminalCalls.length > 0 && (terminalCalls.length !== 1 || toolCalls.length !== 1)) {
        this.#failure = `terminal tool ${this.spec.terminal.toolName} must be the only call in its assistant batch`;
        this.#requestAbort(this.#failure, true);
      }
    }
    if (event.type === "agent_settled" && this.#latestProviderError !== undefined) {
      // Pi represents provider/onPayload failures as a persisted AssistantMessage rather than a
      // rejected prompt promise. Wait until AgentSession has exhausted its configured retry and
      // compaction paths, then project the final canonical error into Koni's outcome.
      this.#failure ??= this.#latestProviderError;
    }
    if (event.type === "tool_execution_start" && event.toolName === this.spec.terminal.toolName) {
      if (this.#terminalCount > 0) {
        this.#failure = `terminal tool ${event.toolName} was called after an accepted terminal result`;
        this.#requestAbort(this.#failure, true);
        return;
      }
      try {
        this.#terminalArguments.set(
          event.toolCallId,
          validateTerminalPayload(
            this.spec,
            this.#terminalOutputSchema,
            event.args,
            "terminal tool arguments",
          ),
        );
      } catch (error) {
        // Pi's pinned argument validator will surface the malformed submission as a normal
        // non-effect error result. A later terminal retry remains valid.
        this.#terminalArgumentErrors.set(
          event.toolCallId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (event.type === "tool_execution_end" && event.toolName === this.spec.terminal.toolName) {
      if (this.#failure !== undefined) {
        this.#requestAbort(this.#failure, this.#abortAsFailure);
        return;
      }
      const payload = this.#terminalArguments.get(event.toolCallId);
      const argumentError = this.#terminalArgumentErrors.get(event.toolCallId);
      this.#terminalArguments.delete(event.toolCallId);
      this.#terminalArgumentErrors.delete(event.toolCallId);
      if (event.isError) {
        // Schema errors and durable authority rejections are model-visible, recoverable attempts;
        // neither is an accepted terminal boundary.
        return;
      }
      if (argumentError !== undefined) {
        this.#failure = argumentError;
        this.#requestAbort(this.#failure, true);
        return;
      }
      this.#terminalCount += 1;
      if (this.#terminalCount > 1) {
        this.#failure = `terminal tool ${event.toolName} was called more than once`;
        this.#requestAbort(this.#failure, true);
        return;
      }
      if (payload === undefined) {
        this.#failure = "terminal tool completed without an authenticated argument payload";
        this.#requestAbort(this.#failure, true);
        return;
      }
      if (!isRecord(event.result) || event.result.terminate !== true) {
        this.#failure = "terminal authority receipt did not terminate the Pi tool batch";
        this.#requestAbort(this.#failure, true);
        return;
      }
      this.#terminalOutput = payload;
      this.#emit({ type: "terminal", toolName: event.toolName, output: this.#terminalOutput });
    }
  }

  #requestAbort(reason: string, asFailure = false): void {
    this.#abortAsFailure ||= asFailure;
    void this.abort(reason).catch(() => {
      // #run awaits the same memoized promise and turns a failed abort into a failed outcome.
    });
  }

  async #settleAbortOutcome(): Promise<ManagedSessionOutcome | undefined> {
    if (this.#status !== "aborting" && this.#status !== "aborted") return undefined;
    try {
      await this.#abortPromise;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failure = `Pi session abort failed: ${detail}`;
      this.#failure = failure;
      this.#setStatus("failed", failure);
      return { status: "failed", error: failure, usage: this.usage };
    }
    if (this.#abortAsFailure && this.#failure !== undefined) {
      this.#setStatus("failed", this.#failure);
      return { status: "failed", error: this.#failure, usage: this.usage };
    }
    if (this.#status !== "aborted") this.#setStatus("aborted", this.#abortReason);
    return { status: "aborted", reason: this.#abortReason, usage: this.usage };
  }

  #assertCanMessage(
    operation: KoniAuthorizedMessage["mode"],
    message: KoniAuthorizedMessage,
  ): void {
    if (
      this.#status !== "running" ||
      this.#failure !== undefined ||
      this.#terminalCount > 0 ||
      this.#terminalArguments.size > 0 ||
      this.#terminalArgumentErrors.size > 0 ||
      this.#abortPromise !== undefined
    ) {
      throw new ManagedSessionError(
        "message_state",
        `cannot ${operation} a ${this.#status} session`,
      );
    }
    validateAuthorizedMessageRecord(message, "message_size");
    if (message.mode !== operation) {
      throw new ManagedSessionError(
        "message_mode",
        `${operation} received a ${message.mode} authority record`,
      );
    }
  }

  #setStatus(status: ManagedSessionStatus, detail?: string): void {
    if (this.#status === "disposed" && status !== "disposed") return;
    this.#status = status;
    this.#emit({ type: "status", status, ...(detail === undefined ? {} : { detail }) });
  }

  #emit(event: ManagedSessionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Observers are presentation/audit clients, never part of Pi persistence or control flow.
      }
    }
  }
}

/** Production factory. Tests inject a fake factory and make no provider or network calls. */
export async function createManagedPiSession(
  spec: Readonly<AgentLaunchSpec>,
  options: ManagedPiSessionFactoryOptions,
): Promise<PiSessionAdapter> {
  return createProductionPiSession(spec, options, "fresh");
}

/** Reopen one authenticated, compiler-authorized linear Pi session. */
export async function recoverManagedPiSession(
  spec: Readonly<AgentLaunchSpec>,
  options: ManagedPiSessionFactoryOptions,
): Promise<PiSessionAdapter> {
  return createProductionPiSession(spec, options, "recover");
}

/** Reopen the stable planning transcript and append one authenticated revision epoch. */
export async function continueManagedPlanningSession(
  spec: Readonly<AgentLaunchSpec>,
  options: ManagedPlanningRevisionOptions,
): Promise<PiSessionAdapter> {
  return createProductionPiSession(spec, options, "planning_revision");
}

async function createProductionPiSession(
  spec: Readonly<AgentLaunchSpec>,
  options: ManagedPiSessionFactoryOptions | ManagedPlanningRevisionOptions,
  mode: "fresh" | "recover" | "planning_revision",
): Promise<PiSessionAdapter> {
  assertSupportedPiRuntimeVersion();
  const boundTools = snapshotToolBindings(options.tools);
  const terminalTool = validateToolBindings(spec, boundTools);
  // Authenticate a recovery before resource/model/extension construction. No provider-capable
  // object exists until the persisted attempt and durable authority view agree byte-for-byte.
  const authenticatedRecovery =
    mode === "recover"
      ? await inspectRecoveredSession(
          spec,
          options.contextProvider,
          terminalTool.terminalOutputSchema!,
          boundTools,
        )
      : mode === "planning_revision"
        ? await inspectPlanningRevisionAuthority(spec, options.contextProvider)
        : undefined;
  const recovery = authenticatedRecovery?.projection;
  let adapterOwnsRecoveryClaim = false;
  try {
    if (
      recovery !== undefined &&
      recovery.disposition.kind !== "prompt" &&
      recovery.disposition.kind !== "continue"
    ) {
      await authenticatedRecovery!.release();
      const adapter = createPassiveRecoveryAdapter(spec, recovery);
      adapterOwnsRecoveryClaim = true;
      return adapter;
    }
    // Persist the immutable header+attempt mapping before materializing resources. If this process
    // dies at any later construction boundary, recovery has an authenticated session anchor and
    // can safely recreate only missing resources from the hash-bound launch spec.
    const sessionSetup: FreshSessionSetup =
      mode === "fresh"
        ? await createFreshSessionManager(spec)
        : mode === "planning_revision"
          ? await openPlanningRevisionSessionManager(
              spec,
              (options as ManagedPlanningRevisionOptions).priorTranscriptSha256,
            )
          : {
              sessionManager: SessionManager.open(
                expectedSessionFile(spec),
                spec.workspace.sessionDirectory,
                spec.workspace.cwd,
              ),
              initialPromptPreloaded: false,
            };
    const { sessionManager } = sessionSetup;
    let initialPromptPreloaded = sessionSetup.initialPromptPreloaded;
    let pendingForkCompaction = sessionSetup.pendingForkCompaction;
    const resultBudget = new TranscriptToolResultBudget(spec, sessionManager);
    let replayedTerminalOutput: unknown;
    for (const action of recovery?.pendingToolActions ?? []) {
      if (action.kind === "append_pi_error") {
        const errorResult = {
          content: [{ type: "text" as const, text: action.errorText }],
          details: {},
        };
        await resultBudget.reserveExact(koniToolResultPayloadBytes(errorResult));
        await appendRecoveredToolResult(
          sessionManager,
          action.callId,
          action.toolName,
          errorResult,
          true,
        );
        continue;
      }
      if (action.kind === "append_receipt") {
        const receipt = action.authorizedResult.receipt;
        if (!isRecord(receipt)) {
          throw new ManagedSessionError("recovery_tool", "authority repair receipt is malformed");
        }
        validateKoniToolReceipt(receipt);
        const repaired = {
          content: [{ type: "text" as const, text: renderKoniToolReceipt(receipt) }],
          details: structuredClone(receipt),
        };
        await resultBudget.reserveExact(koniToolResultPayloadBytes(repaired));
        await appendRecoveredToolResult(
          sessionManager,
          action.callId,
          action.toolName,
          repaired,
          receipt.outcome === "rejected",
        );
        continue;
      }
      const tool = boundTools.find((candidate) => candidate.name === action.toolName);
      if (tool === undefined) {
        throw new ManagedSessionError(
          "recovery_tool",
          `recovery tool ${action.toolName} is unavailable`,
        );
      }
      const signal = new AbortController().signal;
      const budgetDisposition = await resultBudget.reserve(tool.maxResultBytes);
      const result =
        budgetDisposition === "execute"
          ? await tool.execute(action.callId, structuredClone(action.arguments), signal)
          : await tool.reject(
              action.callId,
              structuredClone(action.arguments),
              transcriptBudgetRejection(spec),
              signal,
            );
      const receipt = validatedReceiptFromResult(result, tool.maxResultBytes);
      if (action.toolName !== spec.terminal.toolName && result.terminate === true) {
        throw new ManagedSessionError(
          "recovery_tool",
          "non-terminal authority tool attempted to terminate recovery",
        );
      }
      await appendRecoveredToolResult(
        sessionManager,
        action.callId,
        action.toolName,
        result,
        receipt.outcome === "rejected",
      );
      if (action.toolName === spec.terminal.toolName && receipt.outcome === "accepted") {
        if (result.terminate !== true) {
          throw new ManagedSessionError(
            "recovery_terminal",
            "replayed terminal authority receipt did not terminate",
          );
        }
        replayedTerminalOutput = validateTerminalPayload(
          spec,
          terminalTool.terminalOutputSchema!,
          action.arguments,
          "replayed terminal output",
        );
      }
    }
    if (replayedTerminalOutput !== undefined) {
      await authenticatedRecovery?.release();
      const adapter = createPassiveRecoveryAdapter(spec, {
        usage: recovery?.usage ?? emptyUsage(),
        disposition: { kind: "complete", terminalOutput: replayedTerminalOutput },
      });
      adapterOwnsRecoveryClaim = true;
      return adapter;
    }
    if (
      options.contextProvider.reserveProviderRequest === undefined ||
      options.contextProvider.reconcileProviderRequest === undefined
    ) {
      throw new ManagedSessionError(
        "provider_authority",
        "production contained sessions require durable provider reservation and settlement authority",
      );
    }
    const reserveProviderRequest = options.contextProvider.reserveProviderRequest.bind(
      options.contextProvider,
    );
    const reconcileProviderRequest = options.contextProvider.reconcileProviderRequest.bind(
      options.contextProvider,
    );
    let beforeProviderRequest = async (): Promise<void> => undefined;
    let currentProviderOutputLimit = 0;
    let contextFailure: ManagedSessionError | undefined;
    let providerFailure: ManagedSessionError | undefined;
    // A reservation rejection may be Pi's signal to compact and retry the same turn. Retain its
    // type until a successor reservation is admitted, but do not make it sticky across Pi's one
    // provider-free compaction path.
    let providerRequestFailure: ManagedSessionError | undefined;
    const noticeListeners = new Set<(notice: CompactionLifecycleNotice) => void>();
    const authorityUsageListeners = new Set<(usage: ManagedTokenUsage) => void>();
    const authorityUsage = { ...(recovery?.usage ?? emptyUsage()) };
    let nextProviderSequence = (recovery?.providerRequestCount ?? 0) + 1;
    let pendingReservation: KoniProviderRequestReservation | undefined;
    const extension = createKoniManagedExtension({
      spec,
      contextProvider: options.contextProvider,
      beforeProviderRequest: () => beforeProviderRequest(),
      onNotice: (notice) => {
        try {
          options.onCompactionNotice?.(notice);
        } catch {
          // Audit/TUI observers cannot interrupt the contained session.
        }
        for (const listener of noticeListeners) {
          try {
            listener(notice);
          } catch {
            // Compaction observers are not part of the persistence/control path.
          }
        }
      },
      onTurnStart: () => resultBudget.reset(),
    });
    const contained = await createContainedResourceLoader({
      spec,
      extension,
      mode: mode === "fresh" ? "fresh" : "recover",
    });
    const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
    const unboundedModel = modelRuntime.getModel(spec.model.provider, spec.model.id);
    if (unboundedModel === undefined) {
      throw new ManagedSessionError(
        "model_missing",
        `Pi's normal model runtime does not contain ${spec.model.provider}/${spec.model.id}`,
      );
    }
    const sealedModel = sealPiModelDescriptor(unboundedModel);
    if (
      sealedModel.provider !== spec.model.provider ||
      sealedModel.id !== spec.model.id ||
      sealedModel.api !== spec.model.api ||
      sealedModel.catalogMaxTokens !== spec.model.catalogMaxTokens ||
      sealedModel.catalogSha256 !== spec.model.catalogSha256
    ) {
      throw new ManagedSessionError(
        "model_catalog_drift",
        "Pi's executable model descriptor differs from the compiler-sealed launch binding",
      );
    }
    const hasWireOutputCap = providerApiHasSupportedOutputCap(spec.model.api);
    const model: Model<Api> = {
      ...unboundedModel,
      maxTokens: hasWireOutputCap
        ? Math.min(unboundedModel.maxTokens, providerOutputLimit(spec, authorityUsage))
        : unboundedModel.maxTokens,
    };
    currentProviderOutputLimit = model.maxTokens;
    contained.settingsManager.applyOverrides({
      defaultProvider: spec.model.provider,
      defaultModel: spec.model.id,
      defaultThinkingLevel: spec.model.thinkingLevel,
      ...(spec.model.api === OPENAI_CODEX_RESPONSES_API ? { transport: "sse" as const } : {}),
      compaction: {
        enabled: true,
        // Koni's structured checkpoint already preserves the authoritative run/ticket state.
        // Keep only a small recent evidence tail so an input-pressure retry is materially
        // smaller instead of repeatedly carrying another ~20K transcript tokens.
        keepRecentTokens: containedCompactionKeepRecentTokens(spec),
      },
      retry: {
        enabled: spec.budgets.retries.maxProviderRetries > 0,
        maxRetries: spec.budgets.retries.maxProviderRetries,
        baseDelayMs: spec.budgets.retries.baseDelayMs,
        provider: { maxRetries: 0 },
      },
      images: { blockImages: true, autoResize: false },
    });
    const notifyAuthorityUsage = (): void => {
      const snapshot = { ...authorityUsage };
      for (const listener of authorityUsageListeners) {
        try {
          listener(snapshot);
        } catch {
          // Durable authority accounting cannot be interrupted by observation.
        }
      }
    };
    const settlePendingProviderReservation = async (): Promise<void> => {
      const pending = pendingReservation;
      if (pending === undefined) return;
      let derived;
      try {
        derived = deriveProviderSettlement(
          sessionManager.getEntries() as unknown as readonly PiSessionEntry[],
          pending.baselineEntryId,
        );
      } catch (error) {
        throw new ManagedSessionError(
          "provider_settlement",
          `Pi provider response cannot be uniquely projected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (derived === undefined) {
        throw new ManagedSessionError(
          "provider_settlement",
          "provider reservation has no persisted canonical assistant response",
        );
      }
      const expected = {
        sequence: pending.sequence,
        reservationId: pending.reservationId,
        assistantEntryId: derived.assistantEntryId,
        assistantEntrySha256: derived.assistantEntrySha256,
        usage: derived.usage,
      };
      const settled = await reconcileProviderRequest(spec, expected);
      assertExactProviderSettlement(expected, settled);
      addUsage(
        authorityUsage,
        settled.usage.input,
        settled.usage.output,
        settled.usage.cacheRead,
        settled.usage.cacheWrite,
      );
      pendingReservation = undefined;
      notifyAuthorityUsage();
    };
    beforeProviderRequest = async () => {
      const currentSessionFile = sessionManager.getSessionFile();
      if (currentSessionFile === undefined) {
        throw new ManagedSessionError(
          "session_persistence",
          "provider turn has no durable Pi session file",
        );
      }
      const transcript = await lstat(currentSessionFile);
      if (!transcript.isFile() || transcript.size >= spec.budgets.transcript.maxBytes) {
        throw new ManagedSessionError(
          "transcript_budget",
          `Pi transcript reached its ${spec.budgets.transcript.maxBytes}-byte attempt budget`,
        );
      }
      // A provider must never observe conversation state that exists only in process memory.
      // This also makes the preceding authority receipt repair a committed recovery boundary.
      await syncSessionFile(currentSessionFile);
      await settlePendingProviderReservation();
      const violation = tokenBudgetViolation(spec, authorityUsage);
      if (violation !== undefined) throw new ManagedSessionError("token_budget", violation);
      const exhausted = tokenBudgetExhaustion(spec, authorityUsage);
      if (exhausted !== undefined) throw new ManagedSessionError("token_budget", exhausted);
      if (hasWireOutputCap) {
        model.maxTokens = Math.min(
          unboundedModel.maxTokens,
          providerOutputLimit(spec, authorityUsage),
        );
        currentProviderOutputLimit = model.maxTokens;
      }
    };
    const result = await createAgentSession({
      cwd: spec.workspace.cwd,
      agentDir: path.join(contained.resourceRoot, ".pi-agent"),
      modelRuntime,
      model,
      thinkingLevel: spec.model.thinkingLevel,
      noTools: "all",
      tools: spec.tools.map((tool) => tool.name),
      customTools: runtimeToolDefinitions(spec, boundTools, sessionManager, resultBudget),
      resourceLoader: contained.loader,
      sessionManager,
      settingsManager: contained.settingsManager,
      sessionStartEvent: { type: "session_start", reason: mode === "fresh" ? "startup" : "resume" },
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
    try {
      await result.session.bindExtensions({
        mode: "rpc",
        onError: (error) => {
          if (error.event === "context") {
            // Pi reports and otherwise swallows context-extension failures. Re-throwing from its
            // supported error binding makes transformContext reject before ModelRuntime is entered.
            contextFailure ??= new ManagedSessionError("provider_context", error.error);
            throw contextFailure;
          }
          if (error.event === "before_provider_request") {
            providerFailure ??= new ManagedSessionError("provider_admission", error.error);
            throw providerFailure;
          }
        },
      });
    } catch (error) {
      await shutdownAgentSession(result.session);
      throw error;
    }
    const piPayloadHook = result.session.agent.onPayload;
    if (piPayloadHook === undefined) {
      await shutdownAgentSession(result.session);
      throw new ManagedSessionError(
        "provider_admission",
        "Pi exposed no final provider-payload hook",
      );
    }
    result.session.agent.onPayload = async (payload, selectedModel) => {
      if (contextFailure !== undefined) throw contextFailure;
      if (providerFailure !== undefined) throw providerFailure;
      await settlePendingProviderReservation();
      const admittedOutputLimit = currentProviderOutputLimit;
      const admitted = await piPayloadHook(payload, selectedModel);
      if (contextFailure !== undefined) throw contextFailure;
      if (providerFailure !== undefined) throw providerFailure;
      assertSelectedProviderModel(spec, selectedModel, admittedOutputLimit);
      const exactPayload = exactProviderPayload(spec.model.api, admitted);
      if (spec.model.api === OPENAI_CODEX_RESPONSES_API) {
        assertCodexProviderPayload(spec, exactPayload.transportPayload);
      }
      const identity = providerPayloadIdentity(exactPayload.wirePayload);
      const serializedOutputCap = serializedProviderOutputCap(
        spec.model.api,
        exactPayload.wirePayload,
      );
      if (serializedOutputCap !== undefined && serializedOutputCap.value > admittedOutputLimit) {
        throw new ManagedSessionError(
          "provider_output_cap",
          "Pi serialized a provider output cap above the selected contained model bound",
        );
      }
      const request = {
        sequence: nextProviderSequence,
        api: spec.model.api,
        modelId: spec.model.id,
        ...identity,
        reservedOutputTokens: serializedOutputCap?.value ?? spec.model.catalogMaxTokens,
        ...(serializedOutputCap === undefined ? {} : { serializedOutputCap }),
      };
      // FINAL awaited/fallible operation before transport. Once this resolves, only local scalar
      // assignment occurs and the exact JSON-round-tripped payload is returned immediately.
      let reservation: KoniProviderRequestReservation;
      try {
        reservation = await reserveProviderRequest(spec, request);
      } catch (error) {
        providerRequestFailure = providerAdmissionFailure(error);
        throw providerRequestFailure;
      }
      providerRequestFailure = undefined;
      pendingReservation = reservation;
      nextProviderSequence += 1;
      return exactPayload.transportPayload;
    };
    const sessionFile = result.session.sessionFile;
    if (sessionFile === undefined) {
      result.session.dispose();
      throw new ManagedSessionError("session_persistence", "contained Pi session is not persisted");
    }
    if (recovery?.disposition.kind === "continue") {
      continuationLifecycle(result.session);
    }
    const runWithCurrentContext = async (operation: () => Promise<void>): Promise<void> => {
      const currentFailure = (): ManagedSessionError | undefined =>
        contextFailure ?? providerFailure ?? providerRequestFailure;
      if (currentFailure() !== undefined) throw currentFailure();
      try {
        await operation();
      } catch (error) {
        try {
          await settlePendingProviderReservation();
        } catch {
          // Preserve the primary provider error. The durable unresolved reservation remains held
          // and authenticated recovery will reconcile or block it before any new provider turn.
        }
        if (currentFailure() !== undefined) throw currentFailure();
        throw error;
      }
      await settlePendingProviderReservation();
      if (currentFailure() !== undefined) throw currentFailure();
    };
    const adapter: PiSessionAdapter = {
      sessionId: result.session.sessionId,
      sessionFile,
      mappingPersisted: true,
      ...(recovery === undefined ? {} : { recovery }),
      getActiveToolNames: () => result.session.getActiveToolNames(),
      appendMapping: () => {
        throw new ManagedSessionError(
          "session_mapping",
          "production Pi sessions persist their mapping atomically",
        );
      },
      subscribe: (listener) => result.session.subscribe(listener),
      subscribeNotices: (listener) => {
        noticeListeners.add(listener);
        return () => noticeListeners.delete(listener);
      },
      subscribeAuthorityUsage: (listener) => {
        authorityUsageListeners.add(listener);
        return () => authorityUsageListeners.delete(listener);
      },
      // Compiler output is already fully expanded and hash-bound. Slash-like bytes remain literal so
      // the persisted initial user message is exactly the launch-spec message authenticated later.
      prompt: (text) =>
        runWithCurrentContext(async () => {
          if (initialPromptPreloaded) {
            if (text !== spec.persona.initialPrompt) {
              throw new ManagedSessionError(
                "session_fork_prompt",
                "preloaded conversation fork received a different initial prompt",
              );
            }
            if (pendingForkCompaction !== undefined) {
              await finalizeForkCompaction(
                spec,
                sessionManager,
                pendingForkCompaction,
                options.contextProvider,
                options.onCompactionNotice,
              );
              // createAgentSession hydrated its in-memory agent before authority could authorize the
              // deferred fork compaction. Mirror Pi's own compaction lifecycle so provider input uses
              // the newly persisted compacted context rather than the inherited pre-compaction state.
              result.session.agent.state.messages = sessionManager.buildSessionContext().messages;
              pendingForkCompaction = undefined;
            }
            initialPromptPreloaded = false;
            await continueThroughAgentSession(result.session);
            return;
          }
          await result.session.prompt(text, { expandPromptTemplates: false, source: "rpc" });
        }),
      continue: () =>
        runWithCurrentContext(async () => {
          for (const pending of recovery?.pendingMessages ?? []) {
            const message = pending.message;
            if (!pending.mappingPersisted) {
              await appendAuthorizedMessageMapping(sessionManager, spec, message);
            }
            const queued = {
              role: "user" as const,
              content: [{ type: "text" as const, text: message.content }],
              timestamp: Date.now(),
            };
            if (message.mode === "steer") result.session.agent.steer(queued);
            else result.session.agent.followUp(queued);
          }
          await continueThroughAgentSession(result.session);
        }),
      steer: (message) =>
        runWithCurrentContext(async () => {
          await appendAuthorizedMessageMapping(sessionManager, spec, message);
          await result.session.prompt(message.content, {
            expandPromptTemplates: false,
            streamingBehavior: "steer",
            source: "rpc",
          });
        }),
      followUp: (message) =>
        runWithCurrentContext(async () => {
          await appendAuthorizedMessageMapping(sessionManager, spec, message);
          await result.session.prompt(message.content, {
            expandPromptTemplates: false,
            streamingBehavior: "followUp",
            source: "rpc",
          });
        }),
      abort: () => result.session.abort(),
      dispose: async () => {
        try {
          await shutdownAgentSession(result.session);
        } finally {
          await authenticatedRecovery?.release();
        }
      },
    };
    adapterOwnsRecoveryClaim = true;
    return adapter;
  } finally {
    if (!adapterOwnsRecoveryClaim) {
      await authenticatedRecovery?.release().catch(() => undefined);
    }
  }
}

export function assertSupportedPiRuntimeVersion(version = PI_CODING_AGENT_VERSION): void {
  if (version !== PINNED_PI_CODING_AGENT_VERSION) {
    throw new ManagedSessionError(
      "pi_runtime_version",
      `contained sessions require exact Pi ${PINNED_PI_CODING_AGENT_VERSION}; loaded ${version}`,
    );
  }
}

/**
 * Pi 0.80.10 does not expose a public no-new-message AgentSession continuation. Its private
 * `_runAgentPrompt([])` is the exact high-level lifecycle path used by `prompt()`: it owns
 * isStreaming/idle, retry, compaction, queue draining, agent-settled events, persistence, and
 * abort waiting. Calling the public low-level `session.agent.continue()` would bypass all of that.
 * Keep this compatibility check pinned and fail before spending tokens if Pi changes the surface.
 */
function continueThroughAgentSession(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
): Promise<void> {
  return continuationLifecycle(session).call(session, []);
}

function continuationLifecycle(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
): (messages: unknown[]) => Promise<void> {
  const lifecycle = session as unknown as {
    _runAgentPrompt?: (messages: unknown[]) => Promise<void>;
  };
  if (typeof lifecycle._runAgentPrompt !== "function") {
    throw new ManagedSessionError(
      "pi_continuation_api",
      "pinned Pi AgentSession continuation lifecycle is unavailable",
    );
  }
  return lifecycle._runAgentPrompt;
}

function createPassiveRecoveryAdapter(
  spec: Readonly<AgentLaunchSpec>,
  recovery: RecoveredSessionState,
): PiSessionAdapter {
  const inactive = async (): Promise<never> => {
    throw new ManagedSessionError(
      "recovery_inactive",
      "recovered attempt does not require an active Pi model session",
    );
  };
  return {
    sessionId: spec.identity.sessionId,
    sessionFile: expectedSessionFile(spec),
    recovery,
    mappingPersisted: true,
    getActiveToolNames: () => spec.tools.map((tool) => tool.name),
    appendMapping: () => {
      throw new ManagedSessionError(
        "recovery_mapping",
        "recovery cannot append another attempt mapping",
      );
    },
    subscribe: () => () => undefined,
    subscribeNotices: () => () => undefined,
    prompt: inactive,
    continue: inactive,
    steer: inactive,
    followUp: inactive,
    abort: async () => undefined,
    dispose: async () => undefined,
  };
}

async function appendRecoveredToolResult(
  sessionManager: SessionManager,
  callId: string,
  toolName: string,
  result: Pick<AgentToolResult<unknown>, "content" | "details">,
  isError: boolean,
): Promise<void> {
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: callId,
    toolName,
    content: structuredClone(result.content),
    details: structuredClone(result.details),
    isError,
    timestamp: Date.now(),
  });
  const sessionFile = sessionManager.getSessionFile();
  if (sessionFile === undefined) {
    throw new ManagedSessionError(
      "session_persistence",
      "recovered tool receipt has no durable session file",
    );
  }
  await syncSessionFile(sessionFile);
}

async function appendAuthorizedMessageMapping(
  sessionManager: SessionManager,
  spec: Readonly<AgentLaunchSpec>,
  message: KoniAuthorizedMessage,
): Promise<void> {
  validateAuthorizedMessageRecord(message, "message_size");
  sessionManager.appendCustomEntry(
    "koni.authorized-message-map",
    authorizedMessageMapping(spec, message),
  );
  const sessionFile = sessionManager.getSessionFile();
  if (sessionFile === undefined) {
    throw new ManagedSessionError(
      "session_persistence",
      "authorized message map has no durable session file",
    );
  }
  // Commit the mode/hash binding before Pi can enqueue or persist the associated user text.
  await syncSessionFile(sessionFile);
}

function authorizedMessageMapping(
  spec: Readonly<AgentLaunchSpec>,
  message: KoniAuthorizedMessage,
): Readonly<Record<string, unknown>> {
  return {
    protocol: "koni.authorized-message-map.v1",
    specHash: spec.specHash,
    runId: spec.identity.runId,
    attemptId: spec.identity.attemptId,
    sequence: message.sequence,
    mode: message.mode,
    sha256: message.sha256,
    sizeBytes: message.sizeBytes,
    content: message.content,
  };
}

async function syncSessionFile(sessionFile: string): Promise<void> {
  let handle;
  try {
    handle = await open(sessionFile, constants.O_RDWR | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ManagedSessionError("session_persistence", "Pi session path is not a regular file");
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof ManagedSessionError) throw error;
    throw new ManagedSessionError(
      "session_persistence",
      `Pi session could not be committed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function shutdownAgentSession(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
): Promise<void> {
  try {
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
  } finally {
    session.dispose();
  }
}

interface FreshSessionSetup {
  sessionManager: SessionManager;
  initialPromptPreloaded: boolean;
  pendingForkCompaction?: PendingForkCompaction;
}

interface PendingForkCompaction {
  firstKeptEntryId: string;
}

async function createFreshSessionManager(
  spec: Readonly<AgentLaunchSpec>,
): Promise<FreshSessionSetup> {
  if (spec.lineage.conversationFork !== undefined) {
    const sessionManager = await createForkedSessionManager(spec);
    if (shouldPrecompactConversationFork(spec, sessionManager)) {
      const pendingForkCompaction = preloadForkPromptForCompaction(spec, sessionManager);
      return { sessionManager, initialPromptPreloaded: true, pendingForkCompaction };
    }
    return { sessionManager, initialPromptPreloaded: false };
  }
  await mkdir(spec.workspace.sessionDirectory, { recursive: true, mode: 0o700 });
  const sessionFile = expectedSessionFile(spec);
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: spec.identity.sessionId,
    timestamp: new Date().toISOString(),
    cwd: spec.workspace.cwd,
  };
  const mapping = {
    type: "custom",
    id: randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "koni.attempt-session-map",
    data: attemptSessionMapping(spec, sessionFile),
  };
  if (
    !(await createFileAtomicallyNoReplace(
      sessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(mapping)}\n`,
      0o600,
    ))
  ) {
    throw new ManagedSessionError(
      "session_replay",
      `Pi session ${spec.identity.sessionId} already exists`,
    );
  }
  return {
    sessionManager: SessionManager.open(
      sessionFile,
      spec.workspace.sessionDirectory,
      spec.workspace.cwd,
    ),
    initialPromptPreloaded: false,
  };
}

async function openPlanningRevisionSessionManager(
  spec: Readonly<AgentLaunchSpec>,
  priorTranscriptSha256: Sha256Digest,
): Promise<FreshSessionSetup> {
  const revision = spec.planningRevision;
  if (revision === undefined || revision.revision < 1) {
    throw new ManagedSessionError(
      "planning_revision",
      "planning continuation has no later revision binding",
    );
  }
  const sessionFile = expectedSessionFile(spec);
  let parsed: ParsedPiSession;
  try {
    parsed = await readPiSessionDurably(sessionFile, {
      maxBytes: spec.budgets.transcript.maxBytes + MAX_RECOVERY_SINGLE_ENTRY_OVERSHOOT_BYTES,
    });
  } catch (error) {
    throw new ManagedSessionError(
      "planning_revision_transcript",
      `planning transcript cannot be authenticated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    assertAutonomousPiSession(parsed, {
      sessionId: spec.identity.sessionId,
      cwd: spec.workspace.cwd,
    });
  } catch {
    throw new ManagedSessionError(
      "planning_revision_identity",
      "planning continuation changed the stable session header, workspace, or linear history",
    );
  }
  if (
    parsed.entries.some(
      (entry) => entry.type === "custom" && entry.customType === "koni.conversation-fork-map",
    )
  ) {
    throw new ManagedSessionError(
      "planning_revision_fork",
      "planning continuation cannot contain a conversation fork",
    );
  }
  assertStablePlanningAttemptMapping(spec, sessionFile, parsed.entries);
  if (transcriptSnapshotHash(parsed) !== priorTranscriptSha256) {
    throw new ManagedSessionError(
      "planning_revision_transcript",
      "planning transcript does not match the prior validated checkpoint leaf",
    );
  }
  assertPlanningRevisionMapSequence(spec, parsed.entries);
  const sessionManager = SessionManager.open(
    sessionFile,
    spec.workspace.sessionDirectory,
    spec.workspace.cwd,
  );
  sessionManager.appendCustomEntry(
    "koni.planning-revision-map",
    planningRevisionMapping(spec, priorTranscriptSha256),
  );
  sessionManager.appendModelChange(spec.model.provider, spec.model.id);
  sessionManager.appendThinkingLevelChange(spec.model.thinkingLevel);
  sessionManager.appendMessage({
    role: "user",
    content: spec.persona.initialPrompt,
    timestamp: Date.now(),
  });
  await syncSessionFile(sessionFile);
  return { sessionManager, initialPromptPreloaded: true };
}

function planningRevisionMapping(
  spec: Readonly<AgentLaunchSpec>,
  priorTranscriptSha256: Sha256Digest,
): Readonly<Record<string, unknown>> {
  const revision = spec.planningRevision!;
  return {
    protocol: "koni.planning-revision-map.v1",
    specHash: spec.specHash,
    runId: spec.identity.runId,
    attemptId: spec.identity.attemptId,
    sessionId: spec.identity.sessionId,
    grantId: spec.authority.grantId,
    grantHash: spec.authority.grantHash,
    revision: revision.revision,
    baseRevision: revision.baseRevision,
    priorCheckpointSha256: revision.priorCheckpointSha256,
    priorTranscriptSha256,
    steeringSha256: revision.steeringSha256,
    budgetBaseline: revision.budgetBaseline,
  };
}

function assertStablePlanningAttemptMapping(
  spec: Readonly<AgentLaunchSpec>,
  sessionFile: string,
  entries: readonly PiSessionEntry[],
): void {
  const mappings = entries.filter(
    (entry) => entry.type === "custom" && entry.customType === "koni.attempt-session-map",
  );
  const data = mappings[0]?.data;
  if (
    mappings.length !== 1 ||
    !isRecord(data) ||
    data.runId !== spec.identity.runId ||
    data.ticketId !== spec.identity.ticketId ||
    data.stepId !== spec.identity.stepId ||
    data.attemptId !== spec.identity.attemptId ||
    data.sessionId !== spec.identity.sessionId ||
    data.sessionFile !== sessionFile
  ) {
    throw new ManagedSessionError(
      "planning_revision_identity",
      "planning transcript does not retain its original authenticated attempt mapping",
    );
  }
}

function planningRevisionRecoveryPartition(
  spec: Readonly<AgentLaunchSpec>,
  sessionFile: string,
  entries: readonly PiSessionEntry[],
): { entries: readonly PiSessionEntry[]; priorEntries: readonly PiSessionEntry[] } {
  assertStablePlanningAttemptMapping(spec, sessionFile, entries);
  const expectedRevision = spec.planningRevision!.revision;
  const maps: Array<{ data: Record<string, unknown>; index: number }> = [];
  entries.forEach((entry, index) => {
    if (
      entry.type === "custom" &&
      entry.customType === "koni.planning-revision-map" &&
      isRecord(entry.data)
    ) {
      maps.push({ data: entry.data, index });
    }
  });
  if (
    maps.length !== expectedRevision ||
    maps.some(({ data }, index) => data.revision !== index + 1)
  ) {
    throw new ManagedSessionError(
      "planning_revision_sequence",
      "recovered planning transcript has replayed, missing, or noncontiguous revision maps",
    );
  }
  const current = maps.at(-1)!;
  const priorTranscriptSha256 = current.data.priorTranscriptSha256;
  if (
    !isSha256Digest(priorTranscriptSha256) ||
    !jsonEqual(current.data, planningRevisionMapping(spec, priorTranscriptSha256))
  ) {
    throw new ManagedSessionError(
      "planning_revision_identity",
      "current planning revision map does not match its immutable launch binding",
    );
  }
  return {
    priorEntries: entries.slice(0, current.index + 1),
    entries: entries.slice(current.index + 1),
  };
}

function planningRevisionRecoveryAuthority(
  authority: KoniAttemptRecoveryState,
  priorEntries: readonly PiSessionEntry[],
): KoniAttemptRecoveryState {
  const priorToolCalls = new Set<string>();
  const priorMessageSequences = new Set<number>();
  for (const entry of priorEntries) {
    if (
      entry.type === "custom" &&
      entry.customType === "koni.authorized-message-map" &&
      isRecord(entry.data) &&
      typeof entry.data.sequence === "number"
    ) {
      priorMessageSequences.add(entry.data.sequence);
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    if (entry.message.role === "toolResult" && typeof entry.message.toolCallId === "string") {
      priorToolCalls.add(entry.message.toolCallId);
      continue;
    }
    if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") {
        priorToolCalls.add(block.id);
      }
    }
  }
  return {
    ...authority,
    authorizedMessages: authority.authorizedMessages.filter(
      (message) => !priorMessageSequences.has(message.sequence),
    ),
    authorizedToolResults: authority.authorizedToolResults.filter(
      (result) => !priorToolCalls.has(result.callId),
    ),
  };
}

function assertPlanningRevisionMapSequence(
  spec: Readonly<AgentLaunchSpec>,
  entries: readonly PiSessionEntry[],
): void {
  const expectedPrior = spec.planningRevision!.revision - 1;
  const revisions = entries.flatMap((entry) => {
    if (
      entry.type !== "custom" ||
      entry.customType !== "koni.planning-revision-map" ||
      !isRecord(entry.data) ||
      !Number.isSafeInteger(entry.data.revision)
    ) {
      return [];
    }
    return [Number(entry.data.revision)];
  });
  const expected = Array.from({ length: expectedPrior }, (_unused, index) => index + 1);
  if (
    revisions.length !== expected.length ||
    revisions.some((revision, index) => revision !== expected[index])
  ) {
    throw new ManagedSessionError(
      "planning_revision_sequence",
      "planning transcript revision maps are replayed, missing, or noncontiguous",
    );
  }
}

function shouldPrecompactConversationFork(
  spec: Readonly<AgentLaunchSpec>,
  sessionManager: SessionManager,
): boolean {
  if (spec.lineage.conversationFork === undefined) return false;
  const threshold = Math.max(8_000, Math.min(32_000, Math.floor(spec.budgets.tokens.maxInput / 4)));
  return estimatedSessionContextTokens(sessionManager) > threshold;
}

function preloadForkPromptForCompaction(
  spec: Readonly<AgentLaunchSpec>,
  sessionManager: SessionManager,
): PendingForkCompaction {
  // Persist the immutable child suffix while construction is still effect-free. The authority
  // cannot authorize its compaction until the parent has committed and activated this exact
  // session file; the ManagedPiSession start boundary finalizes it before provider entry.
  sessionManager.appendModelChange(spec.model.provider, spec.model.id);
  sessionManager.appendThinkingLevelChange(spec.model.thinkingLevel);
  return {
    firstKeptEntryId: sessionManager.appendMessage({
      role: "user",
      content: spec.persona.initialPrompt,
      timestamp: Date.now(),
    }),
  };
}

async function finalizeForkCompaction(
  spec: Readonly<AgentLaunchSpec>,
  sessionManager: SessionManager,
  pending: Readonly<PendingForkCompaction>,
  contextProvider: KoniContextProvider,
  onCompactionNotice?: (notice: CompactionLifecycleNotice) => void,
): Promise<void> {
  const tokensBefore = estimatedSessionContextTokens(sessionManager);
  const snapshot = await contextProvider.loadCompactionSnapshot(spec);
  const summary = renderCompactionSummary(spec, snapshot);
  const summaryHash = rawSha256(summary);
  const summaryBytes = Buffer.byteLength(summary, "utf8");
  const authorization = await contextProvider.authorizeCompaction(spec, {
    summaryHash,
    summaryBytes,
    firstKeptEntryId: pending.firstKeptEntryId,
    tokensBefore,
  });
  if (!safeTranscriptIdentity(authorization.authorizationId, 256)) {
    throw new ManagedSessionError(
      "compaction_authority",
      "authority returned an invalid pre-provider compaction identity",
    );
  }
  sessionManager.appendCompaction(
    summary,
    pending.firstKeptEntryId,
    tokensBefore,
    {
      protocol: "koni.compaction.v1",
      specHash: spec.specHash,
      runId: spec.identity.runId,
      ticketId: spec.identity.ticketId,
      stepId: spec.identity.stepId,
      attemptId: spec.identity.attemptId,
      grantHash: spec.authority.grantHash,
      stateHash: spec.authority.expectedStateHash,
      contextHash: spec.authority.authoritativeContextHash,
      summaryHash,
      summaryBytes,
      authorizationId: authorization.authorizationId,
      contextReissueRequired: true,
    },
    true,
  );
  const sessionFile = sessionManager.getSessionFile();
  if (sessionFile === undefined) {
    throw new ManagedSessionError(
      "session_persistence",
      "pre-compacted fork has no durable session file",
    );
  }
  await syncSessionFile(sessionFile);
  try {
    onCompactionNotice?.({
      type: "compaction_created",
      detail: "large inherited conversation compacted before first provider request",
    });
  } catch {
    // Observation cannot interrupt the durable pre-provider boundary.
  }
}

function estimatedSessionContextTokens(sessionManager: SessionManager): number {
  const messages = sessionManager.buildSessionContext().messages;
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(messages), "utf8") / 4));
}

async function createForkedSessionManager(
  spec: Readonly<AgentLaunchSpec>,
): Promise<SessionManager> {
  await mkdir(spec.workspace.sessionDirectory, { recursive: true, mode: 0o700 });
  const sessionFile = expectedSessionFile(spec);
  const parent = await authenticateConversationForkParent(spec);
  const inherited = inheritedConversationEntries(parent.session.entries);
  const timestamp = new Date().toISOString();
  let parentId: string | null = null;
  const linearInherited = inherited.map((entry) => {
    const copy = { ...structuredClone(entry), parentId };
    parentId = copy.id;
    return copy;
  });
  const forkMap = {
    type: "custom",
    id: randomUUID(),
    parentId,
    timestamp,
    customType: "koni.conversation-fork-map",
    data: conversationForkMapping(spec, parent.sessionFile, linearInherited),
  };
  const mapping = {
    type: "custom",
    id: randomUUID(),
    parentId: forkMap.id,
    timestamp,
    customType: "koni.attempt-session-map",
    data: attemptSessionMapping(spec, sessionFile),
  };
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: spec.identity.sessionId,
    timestamp,
    cwd: spec.workspace.cwd,
    parentSession: parent.sessionFile,
  };
  const content =
    [header, ...linearInherited, forkMap, mapping]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  if (!(await createFileAtomicallyNoReplace(sessionFile, content, 0o600))) {
    throw new ManagedSessionError(
      "session_replay",
      `Pi session ${spec.identity.sessionId} already exists`,
    );
  }
  return SessionManager.open(sessionFile, spec.workspace.sessionDirectory, spec.workspace.cwd);
}

async function authenticateConversationForkParent(spec: Readonly<AgentLaunchSpec>): Promise<{
  sessionFile: string;
  session: ParsedPiSession;
}> {
  const lineage = spec.lineage;
  const fork = lineage.conversationFork;
  if (
    fork === undefined ||
    lineage.parentAttemptId === undefined ||
    lineage.parentSessionId === undefined ||
    lineage.parentEntryId === undefined
  ) {
    throw new ManagedSessionError(
      "session_fork",
      "conversation fork is missing its parent identity",
    );
  }
  const runRoot = path.dirname(path.dirname(spec.workspace.sessionDirectory));
  const parentSpecPath = path.join(
    runRoot,
    "attempts",
    lineage.parentAttemptId,
    "launch-spec.json",
  );
  const parentSpec = await readParentLaunchSpec(parentSpecPath);
  if (
    parentSpec.specHash !== fork.parentLaunchSpecHash ||
    parentSpec.identity.runId !== spec.identity.runId ||
    parentSpec.identity.attemptId !== lineage.parentAttemptId ||
    parentSpec.identity.sessionId !== lineage.parentSessionId
  ) {
    throw new ManagedSessionError(
      "session_fork_spec",
      "conversation parent launch spec does not match lineage",
    );
  }
  const sessionFile = expectedSessionFile(parentSpec);
  const sessionsRoot = await realpath(path.dirname(spec.workspace.sessionDirectory));
  const resolvedParentDirectory = await realpath(parentSpec.workspace.sessionDirectory);
  const expectedParentDirectory = path.join(sessionsRoot, lineage.parentAttemptId);
  if (
    !isPathWithin(sessionsRoot, resolvedParentDirectory) ||
    path.resolve(resolvedParentDirectory) !== path.resolve(expectedParentDirectory)
  ) {
    throw new ManagedSessionError(
      "session_fork_path",
      "conversation parent session escapes the run session root",
    );
  }
  const session = await readPiSessionDurably(sessionFile, {
    maxBytes: parentSpec.budgets.transcript.maxBytes + MAX_RECOVERY_SINGLE_ENTRY_OVERSHOOT_BYTES,
  });
  assertAutonomousPiSession(session, {
    sessionId: parentSpec.identity.sessionId,
    cwd: parentSpec.workspace.cwd,
    ...(parentSpec.lineage.conversationFork === undefined
      ? {}
      : { parentSession: expectedConversationParentSessionFile(parentSpec) }),
  });
  assertExactAttemptMapping(parentSpec, sessionFile, session.entries);
  if (
    session.entries.at(-1)?.id !== lineage.parentEntryId ||
    transcriptSnapshotHash(session) !== fork.parentTranscriptSha256
  ) {
    throw new ManagedSessionError(
      "session_fork_snapshot",
      "conversation parent transcript differs from its launch binding",
    );
  }
  return { sessionFile, session };
}

async function readParentLaunchSpec(filePath: string): Promise<Readonly<AgentLaunchSpec>> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 16 * 1024 * 1024) {
      throw new ManagedSessionError(
        "session_fork_spec",
        "conversation parent launch spec is missing or oversized",
      );
    }
    const bytes = await handle.readFile();
    return validateAgentLaunchSpec(JSON.parse(bytes.toString("utf8")) as AgentLaunchSpec);
  } catch (error) {
    if (error instanceof ManagedSessionError) throw error;
    throw new ManagedSessionError(
      "session_fork_spec",
      `conversation parent launch spec cannot be authenticated: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function inheritedConversationEntries(entries: readonly PiSessionEntry[]): PiSessionEntry[] {
  return entries
    .filter(
      (entry) =>
        !(
          entry.type === "custom" &&
          typeof entry.customType === "string" &&
          entry.customType.startsWith("koni.")
        ),
    )
    .map((entry) => structuredClone(entry));
}

function transcriptSnapshotHash(session: ParsedPiSession): Sha256Digest {
  return canonicalHash({ header: session.header, entries: session.entries });
}

function inheritedConversationHash(entries: readonly PiSessionEntry[]): Sha256Digest {
  return canonicalHash(entries);
}

function expectedConversationParentSessionFile(spec: Readonly<AgentLaunchSpec>): string {
  if (spec.lineage.parentAttemptId === undefined || spec.lineage.parentSessionId === undefined) {
    throw new ManagedSessionError(
      "session_fork",
      "conversation fork has no parent session identity",
    );
  }
  return path.join(
    path.dirname(spec.workspace.sessionDirectory),
    spec.lineage.parentAttemptId,
    `${spec.lineage.parentSessionId}.jsonl`,
  );
}

function conversationForkMapping(
  spec: Readonly<AgentLaunchSpec>,
  parentSessionFile: string,
  inheritedEntries: readonly PiSessionEntry[],
): Readonly<Record<string, unknown>> {
  return {
    protocol: "koni.conversation-fork-map.v1",
    specHash: spec.specHash,
    runId: spec.identity.runId,
    attemptId: spec.identity.attemptId,
    sessionId: spec.identity.sessionId,
    parentAttemptId: spec.lineage.parentAttemptId,
    parentSessionId: spec.lineage.parentSessionId,
    parentEntryId: spec.lineage.parentEntryId,
    parentLaunchSpecHash: spec.lineage.conversationFork?.parentLaunchSpecHash,
    parentTranscriptSha256: spec.lineage.conversationFork?.parentTranscriptSha256,
    parentSessionFile,
    inheritedEntryCount: inheritedEntries.length,
    inheritedContextSha256: inheritedConversationHash(inheritedEntries),
  };
}

function expectedSessionFile(spec: Readonly<AgentLaunchSpec>): string {
  return path.join(spec.workspace.sessionDirectory, `${spec.identity.sessionId}.jsonl`);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function attemptSessionMapping(
  spec: Readonly<AgentLaunchSpec>,
  sessionFile: string,
): Readonly<Record<string, unknown>> {
  return {
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
    lineage: spec.lineage,
    sessionFile,
  };
}

async function inspectPlanningRevisionAuthority(
  spec: Readonly<AgentLaunchSpec>,
  contextProvider: KoniContextProvider,
): Promise<AuthenticatedRecovery> {
  const claim = await contextProvider.acquireRecoveryClaim(spec);
  const release =
    typeof claim.release === "function"
      ? onceAsync(claim.release.bind(claim))
      : async () => undefined;
  try {
    validateRecoveryClaim(spec, claim);
    validateRecoveryAuthority(spec, claim.state);
    if (claim.state.providerRequests?.some(isOpenRecoveryProviderRequest)) {
      throw new ManagedSessionError(
        "planning_revision_provider",
        "planning revision cannot continue while a provider request remains unsettled",
      );
    }
    if (claim.state.status !== "continue") {
      throw new ManagedSessionError(
        "planning_revision_state",
        "planning revision authority is not ready for same-session continuation",
      );
    }
    return {
      projection: {
        usage: authorityRecoveryUsage(claim.state),
        ...(claim.state.providerRequests === undefined
          ? {}
          : { providerRequestCount: claim.state.providerRequests.length }),
        disposition: { kind: "prompt" },
      },
      release,
    };
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

async function inspectRecoveredSession(
  spec: Readonly<AgentLaunchSpec>,
  contextProvider: KoniContextProvider,
  terminalOutputSchema: TSchema,
  tools: readonly AuthorityBackedTool[],
): Promise<AuthenticatedRecovery> {
  const sessionFile = expectedSessionFile(spec);
  const claim = await contextProvider.acquireRecoveryClaim(spec);
  const release =
    typeof claim.release === "function"
      ? onceAsync(claim.release.bind(claim))
      : async () => undefined;
  try {
    validateRecoveryClaim(spec, claim);
    const recoveryState = claim.state;
    validateRecoveryAuthority(spec, recoveryState);
    const providerRequestCount = recoveryState.providerRequests?.length;
    const providerProjection = providerRequestCount === undefined ? {} : { providerRequestCount };
    if (recoveryState.providerRequests?.some(isOpenRecoveryProviderRequest)) {
      return {
        projection: {
          usage: authorityRecoveryUsage(recoveryState),
          ...providerProjection,
          disposition: {
            kind: "blocked",
            reason:
              "provider request has no committed canonical assistant settlement; its worst-case reservation remains held",
          },
        },
        release,
      };
    }

    let parsed: ParsedPiSession;
    let handle;
    try {
      handle = await open(sessionFile, constants.O_RDWR | constants.O_NOFOLLOW);
      const metadata = await handle.stat();
      const sessionRoot = await realpath(spec.workspace.sessionDirectory);
      const resolvedFile = await realpath(sessionFile);
      if (
        !metadata.isFile() ||
        (metadata.mode & 0o077) !== 0 ||
        metadata.size >
          spec.budgets.transcript.maxBytes + MAX_RECOVERY_SINGLE_ENTRY_OVERSHOOT_BYTES ||
        !isPathWithin(sessionRoot, resolvedFile)
      ) {
        throw new ManagedSessionError(
          "recovery_session_file",
          "durable Pi session file is missing, oversized, or unsafe",
        );
      }
      const bytes = await handle.readFile();
      const after = await lstat(sessionFile);
      if (after.isSymbolicLink() || after.dev !== metadata.dev || after.ino !== metadata.ino) {
        throw new ManagedSessionError(
          "recovery_session_file",
          "durable Pi session changed during authentication",
        );
      }
      parsed = parsePiSession(bytes, {
        allowTruncatedTail: true,
        maxBytes: spec.budgets.transcript.maxBytes + MAX_RECOVERY_SINGLE_ENTRY_OVERSHOOT_BYTES,
      });
      if (parsed.diagnostics.some((entry) => entry.code === "truncated_tail")) {
        const lastCommittedLf = bytes.lastIndexOf(0x0a);
        if (lastCommittedLf < 0) {
          throw new ManagedSessionError(
            "recovery_transcript",
            "Pi session has no committed header record",
          );
        }
        await handle.truncate(lastCommittedLf + 1);
        await handle.sync();
      }
    } catch (error) {
      if (error instanceof ManagedSessionError) throw error;
      throw new ManagedSessionError(
        "recovery_transcript",
        `durable Pi session cannot be authenticated: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
    try {
      assertAutonomousPiSession(parsed, {
        sessionId: spec.identity.sessionId,
        cwd: spec.workspace.cwd,
        ...(spec.lineage.conversationFork === undefined
          ? {}
          : { parentSession: expectedConversationParentSessionFile(spec) }),
      });
    } catch {
      throw new ManagedSessionError(
        "recovery_branch",
        "contained Pi attempt has an unbound parent session or non-linear entry chain",
      );
    }
    const transcriptPartition = await currentAttemptEntries(spec, parsed);
    const currentEntries = transcriptPartition.entries;
    const planningPartition =
      spec.planningRevision !== undefined && spec.planningRevision.revision > 0
        ? planningRevisionRecoveryPartition(spec, sessionFile, currentEntries)
        : undefined;
    if (planningPartition === undefined)
      assertExactAttemptMapping(spec, sessionFile, currentEntries);
    const inspectionEntries = planningPartition?.entries ?? currentEntries;
    const inspectionAuthority =
      planningPartition === undefined
        ? recoveryState
        : planningRevisionRecoveryAuthority(recoveryState, planningPartition.priorEntries);
    const authorityUsage = authorityRecoveryUsage(recoveryState);
    const retiredAssistantIds = new Set(
      (recoveryState.providerRequests ?? []).flatMap((request) =>
        request.retirement !== undefined && "assistantEntryId" in request.retirement
          ? [request.retirement.assistantEntryId]
          : [],
      ),
    );
    const transcriptUsage = recoveryUsage(
      currentEntries.filter((entry) => !retiredAssistantIds.has(entry.id)),
    );
    const usage =
      recoveryState.providerRequests === undefined
        ? mergeRecoveryUsage(authorityUsage, transcriptUsage)
        : exactRecoveryUsage(authorityUsage, transcriptUsage);
    assertProviderSettlementsMatchTranscript(currentEntries, recoveryState);
    if (recoveryState.status === "terminal_accepted") {
      return {
        projection: {
          usage,
          ...providerProjection,
          disposition: {
            kind: "complete",
            terminalOutput: validateTerminalPayload(
              spec,
              terminalOutputSchema,
              recoveryState.terminalOutput,
              "accepted terminal output",
            ),
          },
        },
        release,
      };
    }
    if (recoveryState.status === "revoked") {
      return {
        projection: {
          usage,
          ...providerProjection,
          disposition: {
            kind: "revoked",
            reason: recoveryReason(recoveryState.reason, "attempt revoked by authority"),
          },
        },
        release,
      };
    }
    if (recoveryState.status === "terminal_inflight") {
      return {
        projection: {
          usage,
          ...providerProjection,
          disposition: {
            kind: "blocked",
            reason: recoveryReason(
              recoveryState.reason,
              "terminal submission is in flight; authority reconciliation is required before recovery",
            ),
          },
        },
        release,
      };
    }
    const transcript = inspectTranscript(
      spec,
      inspectionEntries,
      inspectionAuthority,
      tools,
      new Set([
        ...transcriptPartition.inheritedEntryIds,
        ...(planningPartition?.priorEntries.map((entry) => entry.id) ?? []),
      ]),
    );
    assertExactPersistedRuntime(spec, inspectionEntries, transcript.hasInitialPrompt);
    const replayableTerminal =
      transcript.terminalResults === 0 &&
      transcript.pendingToolActions.some(
        (action) => action.kind === "execute" && action.toolName === spec.terminal.toolName,
      );
    if (transcript.terminalResults > 0 && !replayableTerminal) {
      return {
        projection: {
          usage,
          ...providerProjection,
          disposition: {
            kind: "blocked",
            reason:
              "Pi transcript contains a terminal submission that durable authority has not accepted",
          },
        },
        release,
      };
    }
    if (!transcript.hasInitialPrompt) {
      if (transcript.pendingMessages.length > 0) {
        throw new ManagedSessionError(
          "recovery_message",
          "authority accepted steering before the compiler-issued initial prompt was persisted",
        );
      }
      return {
        projection: { usage, ...providerProjection, disposition: { kind: "prompt" } },
        release,
      };
    }
    if (transcript.mayContinue) {
      return {
        projection: {
          usage,
          ...providerProjection,
          disposition: { kind: "continue" },
          ...(transcript.pendingMessages.length === 0
            ? {}
            : { pendingMessages: transcript.pendingMessages }),
          ...(transcript.pendingToolActions.length === 0
            ? {}
            : { pendingToolActions: transcript.pendingToolActions }),
        },
        release,
      };
    }
    return {
      projection: {
        usage,
        ...providerProjection,
        disposition: {
          kind: "blocked",
          reason: "Pi transcript does not end at a provably safe continuation boundary",
        },
      },
      release,
    };
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

function validateRecoveryClaim(
  spec: Readonly<AgentLaunchSpec>,
  claim: KoniAttemptRecoveryClaim,
): void {
  if (
    claim.protocol !== "koni.attempt-recovery-claim.v1" ||
    typeof claim.claimId !== "string" ||
    claim.claimId.length === 0 ||
    claim.claimId.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(claim.claimId) ||
    typeof claim.release !== "function" ||
    claim.state.specHash !== spec.specHash ||
    claim.state.attemptId !== spec.identity.attemptId ||
    claim.state.sessionId !== spec.identity.sessionId
  ) {
    throw new ManagedSessionError(
      "recovery_claim",
      "authority returned an invalid or mismatched recovery claim",
    );
  }
}

function assertExactPersistedRuntime(
  spec: Readonly<AgentLaunchSpec>,
  entries: readonly PiSessionEntry[],
  hasStarted: boolean,
): void {
  const modelChanges = entries.filter((entry) => entry.type === "model_change");
  const thinkingChanges = entries.filter((entry) => entry.type === "thinking_level_change");
  if (
    modelChanges.some(
      (entry) => entry.provider !== spec.model.provider || entry.modelId !== spec.model.id,
    ) ||
    thinkingChanges.some((entry) => entry.thinkingLevel !== spec.model.thinkingLevel) ||
    (hasStarted && (modelChanges.length === 0 || thinkingChanges.length === 0))
  ) {
    throw new ManagedSessionError(
      "recovery_model",
      "persisted Pi model or thinking history does not match the immutable launch binding",
    );
  }
}

async function currentAttemptEntries(
  spec: Readonly<AgentLaunchSpec>,
  parsed: ParsedPiSession,
): Promise<{ entries: readonly PiSessionEntry[]; inheritedEntryIds: ReadonlySet<string> }> {
  const forkIndexes = parsed.entries.flatMap((entry, index) =>
    entry.type === "custom" && entry.customType === "koni.conversation-fork-map" ? [index] : [],
  );
  if (spec.lineage.conversationFork === undefined) {
    if (forkIndexes.length !== 0) {
      throw new ManagedSessionError(
        "recovery_fork",
        "fresh Pi session contains an unauthorized fork boundary",
      );
    }
    return { entries: parsed.entries, inheritedEntryIds: new Set() };
  }
  if (forkIndexes.length !== 1) {
    throw new ManagedSessionError(
      "recovery_fork",
      "forked Pi session must contain one immutable fork boundary",
    );
  }
  const forkIndex = forkIndexes[0]!;
  const parent = await authenticateConversationForkParent(spec);
  let parentId: string | null = null;
  const expectedInherited = inheritedConversationEntries(parent.session.entries).map((entry) => {
    const copy = { ...structuredClone(entry), parentId };
    parentId = copy.id;
    return copy;
  });
  const actualInherited = parsed.entries.slice(0, forkIndex);
  if (
    actualInherited.length !== expectedInherited.length ||
    canonicalHash(actualInherited) !== canonicalHash(expectedInherited)
  ) {
    throw new ManagedSessionError(
      "recovery_fork_prefix",
      "forked Pi conversation prefix differs from its parent",
    );
  }
  const forkEntry = parsed.entries[forkIndex]!;
  const expectedMapping = conversationForkMapping(spec, parent.sessionFile, expectedInherited);
  if (
    forkEntry.type !== "custom" ||
    forkEntry.customType !== "koni.conversation-fork-map" ||
    !isRecord(forkEntry.data) ||
    !jsonEqual(forkEntry.data, expectedMapping)
  ) {
    throw new ManagedSessionError(
      "recovery_fork_mapping",
      "Pi conversation fork mapping differs from its launch spec",
    );
  }
  return {
    entries: parsed.entries.slice(forkIndex + 1),
    inheritedEntryIds: new Set(actualInherited.map((entry) => entry.id)),
  };
}

function assertExactAttemptMapping(
  spec: Readonly<AgentLaunchSpec>,
  sessionFile: string,
  entries: readonly PiSessionEntry[],
): void {
  const mappings = entries.filter(
    (entry) => entry.type === "custom" && entry.customType === "koni.attempt-session-map",
  );
  if (mappings.length !== 1) {
    throw new ManagedSessionError(
      "recovery_mapping_count",
      "Pi session must contain exactly one immutable Koni attempt mapping",
    );
  }
  const data = mappings[0]?.data;
  if (!isRecord(data)) {
    throw new ManagedSessionError("recovery_mapping", "Pi session attempt mapping is malformed");
  }
  const expected = attemptSessionMapping(spec, sessionFile);
  const actualKeys = Object.keys(data).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => !jsonEqual(data[key], expected[key]))
  ) {
    throw new ManagedSessionError(
      "recovery_mapping",
      "Pi session attempt mapping does not match the launch spec",
    );
  }
}

function inspectTranscript(
  spec: Readonly<AgentLaunchSpec>,
  entries: readonly PiSessionEntry[],
  authority: KoniAttemptRecoveryState,
  tools: readonly AuthorityBackedTool[],
  inheritedEntryIds: ReadonlySet<string> = new Set(),
): {
  hasInitialPrompt: boolean;
  mayContinue: boolean;
  terminalCalls: number;
  terminalResults: number;
  pendingMessages: readonly PendingRecoveredMessage[];
  pendingToolActions: readonly PendingRecoveredToolAction[];
} {
  const toolCalls = new Map<
    string,
    {
      name: string;
      arguments: Record<string, unknown>;
      expectedPiError?: string;
      order: number;
      resolved: boolean;
    }
  >();
  const toolBindings = new Map(tools.map((tool) => [tool.name, tool] as const));
  const allowedTools = new Set(spec.tools.map((tool) => tool.name));
  const seenEntryIds = new Set<string>(inheritedEntryIds);
  let hasInitialPrompt = false;
  let lastBoundary: "user" | "assistant" | "toolResult" | "compaction" | "messageMap" | undefined;
  let terminalCalls = 0;
  let terminalResults = 0;
  let toolCallOrder = 0;
  let lastAssistantIsRetryableLocalInterruption = false;
  const authorizedMessages = new Map(
    authority.authorizedMessages.map((message) => [message.sequence, message] as const),
  );
  const mappedMessageSequences = new Set<number>();
  const consumedMessageSequences = new Set<number>();
  const outstandingMessageMappings: KoniAuthorizedMessage[] = [];
  const authorizedToolResults = new Map(
    authority.authorizedToolResults.map((record) => [record.callId, record] as const),
  );
  const seenAuthorizedToolResults = new Set<string>();
  if (authorizedToolResults.size !== authority.authorizedToolResults.length) {
    throw new ManagedSessionError(
      "recovery_authority",
      "authority returned duplicate tool receipt identities",
    );
  }
  const authorizedCompactions = new Map(
    authority.authorizedCompactions.map((record) => [record.authorizationId, record] as const),
  );
  const seenAuthorizedCompactions = new Set<string>();
  for (const entry of entries) {
    lastAssistantIsRetryableLocalInterruption = false;
    if (entry.type === "custom") {
      if (entry.customType === "koni.authorized-message-map") {
        if (!hasInitialPrompt || !isRecord(entry.data)) {
          throw new ManagedSessionError(
            "recovery_message",
            "authorized message map is misplaced or malformed",
          );
        }
        const sequence = entry.data.sequence;
        const authorized =
          typeof sequence === "number" ? authorizedMessages.get(sequence) : undefined;
        if (
          authorized === undefined ||
          mappedMessageSequences.has(authorized.sequence) ||
          !jsonEqual(entry.data, authorizedMessageMapping(spec, authorized))
        ) {
          throw new ManagedSessionError(
            "recovery_message",
            "Pi authorized message map does not match the durable authority ledger",
          );
        }
        mappedMessageSequences.add(authorized.sequence);
        outstandingMessageMappings.push(authorized);
        lastBoundary = "messageMap";
        seenEntryIds.add(entry.id);
        continue;
      }
      if (entry.customType !== "koni.attempt-session-map") {
        throw new ManagedSessionError(
          "recovery_entry",
          "Pi session contains an unauthorized custom entry",
        );
      }
      seenEntryIds.add(entry.id);
      continue;
    }
    if (entry.type === "model_change" || entry.type === "thinking_level_change") {
      seenEntryIds.add(entry.id);
      continue;
    }
    if (entry.type === "compaction") {
      if (!hasInitialPrompt) {
        throw new ManagedSessionError(
          "recovery_compaction",
          "Pi compacted before the initial prompt boundary",
        );
      }
      const authorizationId =
        isRecord(entry.details) && typeof entry.details.authorizationId === "string"
          ? entry.details.authorizationId
          : undefined;
      const authorized =
        authorizationId === undefined ? undefined : authorizedCompactions.get(authorizationId);
      if (authorized === undefined || seenAuthorizedCompactions.has(authorized.authorizationId)) {
        throw new ManagedSessionError(
          "recovery_compaction",
          "Pi compaction has no durable authority authorization",
        );
      }
      validatePersistedCompaction(spec, entry, seenEntryIds, authorized);
      seenAuthorizedCompactions.add(authorized.authorizationId);
      lastBoundary = "compaction";
      seenEntryIds.add(entry.id);
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) {
      throw new ManagedSessionError(
        "recovery_entry",
        `Pi session contains unauthorized context-bearing entry type ${entry.type}`,
      );
    }
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
      throw new ManagedSessionError(
        "recovery_message",
        "Pi session contains an unsupported persisted message role",
      );
    }
    if (message.role === "user") {
      const text = userText(message.content);
      if (
        text === undefined ||
        text.length === 0 ||
        Buffer.byteLength(text, "utf8") > 1024 * 1024 ||
        text.includes("\u0000")
      ) {
        throw new ManagedSessionError(
          "recovery_message",
          "Pi user message is malformed or exceeds its bound",
        );
      }
      if (!hasInitialPrompt) {
        if (text !== spec.persona.initialPrompt) {
          throw new ManagedSessionError(
            "recovery_initial_prompt",
            "Pi session does not start with the exact compiler-issued initial prompt",
          );
        }
        hasInitialPrompt = true;
      } else {
        const authorized = nextMappedMessageForPiDelivery(outstandingMessageMappings);
        if (authorized === undefined || !authorizedMessageMatches(authorized, text)) {
          throw new ManagedSessionError(
            "recovery_message",
            "Pi user message has no exact preceding authority message map",
          );
        }
        outstandingMessageMappings.splice(outstandingMessageMappings.indexOf(authorized), 1);
        consumedMessageSequences.add(authorized.sequence);
      }
      lastBoundary = "user";
      seenEntryIds.add(entry.id);
      continue;
    }
    if (message.role === "assistant") {
      if (!Array.isArray(message.content)) {
        throw new ManagedSessionError(
          "recovery_message",
          "Pi assistant message content is malformed",
        );
      }
      // A retirement authenticates this exact provider terminal while deliberately retaining its
      // reservation as uncertain exposure. It is history, not a tool batch to replay. Treat it as
      // the recoverable continuation boundary after its identity was checked against the ledger.
      if (isRetiredProviderAssistant(authority, entry.id)) {
        lastAssistantIsRetryableLocalInterruption = true;
        lastBoundary = "assistant";
        seenEntryIds.add(entry.id);
        continue;
      }
      const batchCalls: Array<{ id: string; name: string }> = [];
      for (const block of message.content) {
        if (!isRecord(block) || !["text", "thinking", "toolCall"].includes(String(block.type))) {
          throw new ManagedSessionError(
            "recovery_message",
            "Pi assistant content contains an unsupported block",
          );
        }
        if (block.type !== "toolCall") continue;
        if (
          typeof block.id !== "string" ||
          block.id.length === 0 ||
          block.id.length > 256 ||
          typeof block.name !== "string" ||
          !allowedTools.has(block.name) ||
          toolCalls.has(block.id)
        ) {
          throw new ManagedSessionError(
            "recovery_tool",
            "Pi tool call is unauthorized, malformed, or duplicated",
          );
        }
        const binding = toolBindings.get(block.name);
        if (binding === undefined || !isRecord(block.arguments)) {
          throw new ManagedSessionError(
            "recovery_tool",
            "Pi tool call has no exact compiler binding or arguments",
          );
        }
        let validatedArguments: Record<string, unknown>;
        let expectedPiError: string | undefined;
        if (message.stopReason === "length") {
          validatedArguments = structuredClone(block.arguments);
          expectedPiError = truncatedToolCallError(block.name);
        } else {
          try {
            const value = validateToolArguments(binding.definition, {
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: structuredClone(block.arguments),
            });
            if (!isRecord(value)) throw new Error("validated arguments are not an object");
            validatedArguments = structuredClone(value);
          } catch (error) {
            validatedArguments = structuredClone(block.arguments);
            expectedPiError = error instanceof Error ? error.message : String(error);
          }
        }
        let encodedArguments: string;
        try {
          encodedArguments = canonicalEncode(validatedArguments);
        } catch {
          throw new ManagedSessionError(
            "recovery_tool",
            "Pi tool call arguments are not canonical JSON data",
          );
        }
        if (Buffer.byteLength(encodedArguments, "utf8") > 16 * 1024 * 1024) {
          throw new ManagedSessionError(
            "recovery_tool",
            "Pi tool call arguments exceed the recovery bound",
          );
        }
        toolCalls.set(block.id, {
          name: block.name,
          arguments: validatedArguments,
          ...(expectedPiError === undefined ? {} : { expectedPiError }),
          order: toolCallOrder,
          resolved: false,
        });
        toolCallOrder += 1;
        batchCalls.push({ id: block.id, name: block.name });
      }
      if (
        batchCalls.some((call) => call.name === spec.terminal.toolName) &&
        batchCalls.some((call) => call.name !== spec.terminal.toolName)
      ) {
        throw new ManagedSessionError(
          "recovery_terminal",
          "terminal tool must be the only tool in its assistant batch",
        );
      }
      terminalCalls += batchCalls.filter((call) => call.name === spec.terminal.toolName).length;
      lastAssistantIsRetryableLocalInterruption = isRetryableUnreservedAssistantInterruption(
        spec,
        message,
        authority,
      );
      lastBoundary = "assistant";
      seenEntryIds.add(entry.id);
      continue;
    }
    if (
      typeof message.toolCallId !== "string" ||
      typeof message.toolName !== "string" ||
      typeof message.isError !== "boolean"
    ) {
      throw new ManagedSessionError("recovery_tool", "Pi tool result is malformed");
    }
    const call = toolCalls.get(message.toolCallId);
    if (call === undefined || call.name !== message.toolName || call.resolved) {
      throw new ManagedSessionError(
        "recovery_tool",
        "Pi tool result has no unique matching tool call",
      );
    }
    call.resolved = true;
    const authorizedResult = authorizedToolResults.get(message.toolCallId);
    if (call.expectedPiError !== undefined) {
      if (
        authorizedResult !== undefined ||
        message.isError !== true ||
        !isRecord(message.details) ||
        Object.keys(message.details).length !== 0 ||
        userText(message.content) !== call.expectedPiError
      ) {
        throw new ManagedSessionError(
          "recovery_tool",
          "Pi validation error differs from the pinned runtime outcome",
        );
      }
      lastBoundary = "toolResult";
      seenEntryIds.add(entry.id);
      continue;
    }
    if (authorizedResult === undefined || seenAuthorizedToolResults.has(message.toolCallId)) {
      throw new ManagedSessionError(
        "recovery_tool",
        "Pi tool result has no durable authority receipt",
      );
    }
    const receipt = validateAuthorizedToolResult(message, authorizedResult, call.arguments);
    seenAuthorizedToolResults.add(message.toolCallId);
    if (message.toolName === spec.terminal.toolName) {
      if (receipt.outcome === "accepted") terminalResults += 1;
    }
    lastBoundary = "toolResult";
    seenEntryIds.add(entry.id);
  }
  const pendingToolActions: PendingRecoveredToolAction[] = [];
  for (const [callId, call] of toolCalls) {
    if (call.resolved) continue;
    if (call.expectedPiError !== undefined) {
      pendingToolActions.push({
        order: call.order,
        kind: "append_pi_error",
        callId,
        toolName: call.name,
        arguments: structuredClone(call.arguments),
        errorText: call.expectedPiError,
      });
      continue;
    }
    const authorized = authorizedToolResults.get(callId);
    if (authorized !== undefined) {
      validateAuthorizedToolArguments(authorized, callId, call.name, call.arguments);
      pendingToolActions.push({
        order: call.order,
        kind: "append_receipt",
        callId,
        toolName: call.name,
        arguments: structuredClone(call.arguments),
        authorizedResult: authorized,
      });
    } else {
      pendingToolActions.push({
        order: call.order,
        kind: "execute",
        callId,
        toolName: call.name,
        arguments: structuredClone(call.arguments),
      });
    }
  }
  for (const authorized of authority.authorizedToolResults) {
    const call = toolCalls.get(authorized.callId);
    if (call === undefined || call.expectedPiError !== undefined) {
      throw new ManagedSessionError(
        "recovery_tool",
        "authority receipt has no committed matching Pi tool call",
      );
    }
  }
  pendingToolActions.sort((left, right) => left.order - right.order);
  const outstandingCalls = [...toolCalls.values()].filter((call) => !call.resolved).length;
  const pendingAuthorizedMessages =
    authority.authorizedMessages.length - consumedMessageSequences.size;
  if (terminalResults > 1 || terminalResults > terminalCalls) {
    throw new ManagedSessionError(
      "recovery_terminal",
      "Pi session contains repeated terminal submissions",
    );
  }
  return {
    hasInitialPrompt,
    mayContinue:
      hasInitialPrompt &&
      outstandingCalls === pendingToolActions.length &&
      (lastBoundary === "user" ||
        lastBoundary === "toolResult" ||
        lastBoundary === "compaction" ||
        (lastBoundary === "messageMap" && outstandingMessageMappings.length > 0) ||
        (lastBoundary === "assistant" &&
          (pendingToolActions.length > 0 ||
            pendingAuthorizedMessages > 0 ||
            lastAssistantIsRetryableLocalInterruption))),
    terminalCalls,
    terminalResults,
    pendingMessages: authority.authorizedMessages
      .filter((message) => !consumedMessageSequences.has(message.sequence))
      .map((message) => ({
        message,
        mappingPersisted: mappedMessageSequences.has(message.sequence),
      })),
    pendingToolActions,
  };
}

function isRetryableUnreservedAssistantInterruption(
  spec: Readonly<AgentLaunchSpec>,
  message: Record<string, unknown>,
  authority: KoniAttemptRecoveryState,
): boolean {
  const usage = message.usage;
  const content = message.content;
  const isLocalError =
    message.stopReason === "error" && Array.isArray(content) && content.length === 0;
  const isLocallyAborted =
    message.stopReason === "aborted" &&
    Array.isArray(content) &&
    content.every((block) => isRecord(block) && block.type === "text" && block.text === "");
  return (
    (isLocalError || isLocallyAborted) &&
    typeof message.errorMessage === "string" &&
    message.errorMessage.length > 0 &&
    Buffer.byteLength(message.errorMessage, "utf8") <= 1024 * 1024 &&
    message.api === spec.model.api &&
    message.provider === spec.model.provider &&
    message.model === spec.model.id &&
    isRecord(usage) &&
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    usage.totalTokens === 0 &&
    (authority.providerRequests ?? []).every(
      (request) => request.settlement !== undefined || request.retirement !== undefined,
    )
  );
}

function validatePersistedCompaction(
  spec: Readonly<AgentLaunchSpec>,
  entry: PiSessionEntry,
  seenEntryIds: ReadonlySet<string>,
  authorized: KoniAttemptRecoveryState["authorizedCompactions"][number],
): void {
  const details = entry.details;
  if (
    typeof entry.summary !== "string" ||
    Buffer.byteLength(entry.summary, "utf8") > 4 * 1024 * 1024 ||
    typeof entry.firstKeptEntryId !== "string" ||
    !seenEntryIds.has(entry.firstKeptEntryId) ||
    !Number.isSafeInteger(entry.tokensBefore) ||
    Number(entry.tokensBefore) < 0 ||
    entry.fromHook !== true ||
    !isRecord(details)
  ) {
    throw new ManagedSessionError(
      "recovery_compaction",
      "Pi compaction entry is malformed or unauthorized",
    );
  }
  const expected = {
    protocol: "koni.compaction.v1",
    specHash: spec.specHash,
    runId: spec.identity.runId,
    ticketId: spec.identity.ticketId,
    stepId: spec.identity.stepId,
    attemptId: spec.identity.attemptId,
    grantHash: spec.authority.grantHash,
    stateHash: spec.authority.expectedStateHash,
    contextHash: spec.authority.authoritativeContextHash,
    summaryHash: rawSha256(entry.summary),
    summaryBytes: Buffer.byteLength(entry.summary, "utf8"),
    authorizationId: authorized.authorizationId,
    contextReissueRequired: true,
  } as const;
  const actualKeys = Object.keys(details).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => details[key] !== expected[key as keyof typeof expected])
  ) {
    throw new ManagedSessionError(
      "recovery_compaction",
      "Pi compaction does not match its launch-bound digest",
    );
  }
  if (
    authorized.summaryHash !== expected.summaryHash ||
    authorized.summaryBytes !== expected.summaryBytes ||
    authorized.firstKeptEntryId !== entry.firstKeptEntryId ||
    authorized.tokensBefore !== entry.tokensBefore
  ) {
    throw new ManagedSessionError(
      "recovery_compaction",
      "Pi compaction does not match durable authority",
    );
  }
}

function authorizedMessageMatches(message: KoniAuthorizedMessage, text: string): boolean {
  return (
    message.content === text &&
    message.sizeBytes === Buffer.byteLength(text, "utf8") &&
    message.sha256 === rawSha256(text)
  );
}

function nextMappedMessageForPiDelivery(
  outstanding: readonly KoniAuthorizedMessage[],
): KoniAuthorizedMessage | undefined {
  // Pi drains steering FIFO before it considers queued follow-ups. Iterating the JSONL in order
  // means only maps durably present before this user entry participate, so a later steer cannot
  // retroactively preempt an already-persisted follow-up.
  return (
    outstanding.find((message) => message.mode === "steer") ??
    outstanding.find((message) => message.mode === "follow_up")
  );
}

function truncatedToolCallError(toolName: string): string {
  return `Tool call "${toolName}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;
}

function validateAuthorizedToolResult(
  message: Record<string, unknown>,
  authorized: KoniAttemptRecoveryState["authorizedToolResults"][number],
  callArguments: Record<string, unknown>,
): KoniToolReceipt {
  validateAuthorizedToolArguments(
    authorized,
    String(message.toolCallId),
    String(message.toolName),
    callArguments,
  );
  if (
    message.toolCallId !== authorized.callId ||
    message.toolName !== authorized.toolName ||
    !isRecord(message.details)
  ) {
    throw new ManagedSessionError(
      "recovery_tool",
      "Pi tool result does not match its authority receipt identity",
    );
  }
  const encoded = canonicalEncode(message.details);
  if (
    canonicalHash(message.details) !== authorized.receiptSha256 ||
    Buffer.byteLength(encoded, "utf8") !== authorized.receiptSizeBytes
  ) {
    throw new ManagedSessionError(
      "recovery_tool",
      "Pi tool receipt details do not match durable authority",
    );
  }
  if (!jsonEqual(message.details, authorized.receipt)) {
    throw new ManagedSessionError(
      "recovery_tool",
      "Pi tool receipt object differs from durable authority",
    );
  }
  validateKoniToolReceipt(message.details);
  if (
    authorized.outcome !== message.details.outcome ||
    message.isError !== (message.details.outcome === "rejected")
  ) {
    throw new ManagedSessionError(
      "recovery_tool",
      "Pi tool error status differs from durable authority outcome",
    );
  }
  const receiptText = userText(message.content);
  const expectedText = renderKoniToolReceipt(message.details);
  if (receiptText !== expectedText) {
    throw new ManagedSessionError(
      "recovery_tool",
      "Pi tool result text does not match its authority receipt details",
    );
  }
  return message.details;
}

function validateAuthorizedToolArguments(
  authorized: KoniAttemptRecoveryState["authorizedToolResults"][number],
  callId: string,
  toolName: string,
  callArguments: Record<string, unknown>,
): void {
  const encoded = canonicalEncode(callArguments);
  if (
    authorized.callId !== callId ||
    authorized.toolName !== toolName ||
    authorized.argumentsSha256 !== canonicalHash(callArguments) ||
    authorized.argumentsSizeBytes !== Buffer.byteLength(encoded, "utf8")
  ) {
    throw new ManagedSessionError(
      "recovery_tool",
      "Pi tool call arguments do not match durable authority",
    );
  }
}

function validateRecoveryAuthority(
  spec: Readonly<AgentLaunchSpec>,
  state: KoniAttemptRecoveryState,
): void {
  const expected = {
    protocol: "koni.attempt-recovery.v1",
    specHash: spec.specHash,
    runId: spec.identity.runId,
    ticketId: spec.identity.ticketId,
    stepId: spec.identity.stepId,
    attemptId: spec.identity.attemptId,
    sessionId: spec.identity.sessionId,
    grantHash: spec.authority.grantHash,
    generation: spec.authority.generation,
    epoch: spec.authority.epoch,
    stateHash: spec.authority.expectedStateHash,
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if (state[key as keyof typeof expected] !== value) {
      throw new ManagedSessionError(
        "recovery_authority",
        `durable authority ${key} does not match the immutable launch binding`,
      );
    }
  }
  if (!["continue", "terminal_accepted", "terminal_inflight", "revoked"].includes(state.status)) {
    throw new ManagedSessionError(
      "recovery_authority",
      "durable authority returned an unsupported recovery status",
    );
  }
  validateAuthorizedMessages(state.authorizedMessages);
  validateAuthorizedToolResults(spec, state.authorizedToolResults);
  validateAuthorizedCompactions(state.authorizedCompactions);
  validateProviderRecoveryRecords(spec, state);
}

function validateProviderRecoveryRecords(
  spec: Readonly<AgentLaunchSpec>,
  state: KoniAttemptRecoveryState,
): void {
  const requests = state.providerRequests;
  if (requests === undefined) {
    if (state.providerUsageBaseline !== undefined) {
      throw new ManagedSessionError(
        "recovery_authority",
        "provider usage baseline has no request ledger",
      );
    }
    return;
  }
  if (!Array.isArray(requests) || requests.length > 100_000) {
    throw new ManagedSessionError(
      "recovery_authority",
      "provider request ledger is malformed or oversized",
    );
  }
  const baseline = state.providerUsageBaseline ?? emptyUsage();
  validateManagedUsage({ ...baseline });
  let input = baseline.input;
  let output = baseline.output;
  let cacheRead = baseline.cacheRead;
  let cacheWrite = baseline.cacheWrite;
  let unresolved = false;
  for (const [index, request] of requests.entries()) {
    const cap = request.serializedOutputCap;
    if (
      request.sequence !== index + 1 ||
      !safeTranscriptIdentity(request.reservationId, 256) ||
      request.api !== spec.model.api ||
      request.modelId !== spec.model.id ||
      !isSha256Digest(request.payloadSha256) ||
      !Number.isSafeInteger(request.payloadSizeBytes) ||
      request.payloadSizeBytes < 1 ||
      request.payloadSizeBytes > 64 * 1024 * 1024 ||
      !isSupportedStoredProviderInputEstimate(
        request.payloadSizeBytes,
        request.prospectiveInputTokens,
      ) ||
      !Number.isSafeInteger(request.reservedOutputTokens) ||
      request.reservedOutputTokens < 1 ||
      request.reservedOutputTokens > spec.model.catalogMaxTokens ||
      !safeTranscriptIdentity(request.baselineEntryId, 128) ||
      (cap !== undefined &&
        (spec.model.api === OPENAI_CODEX_RESPONSES_API ||
          cap.value !== request.reservedOutputTokens ||
          !isSupportedProviderOutputCap(spec.model.api, cap))) ||
      (cap === undefined &&
        (providerApiHasSupportedOutputCap(spec.model.api) ||
          request.reservedOutputTokens !== spec.model.catalogMaxTokens))
    ) {
      throw new ManagedSessionError(
        "recovery_authority",
        "provider request ledger is not launch-bound",
      );
    }
    const settlement = request.settlement;
    const retirement = request.retirement;
    if (settlement !== undefined && retirement !== undefined) {
      throw new ManagedSessionError(
        "recovery_authority",
        "provider request cannot be both settled and retired",
      );
    }
    if (retirement !== undefined) {
      const retirementError = providerRequestRetirementValidationError(retirement);
      if (retirementError !== undefined) {
        throw new ManagedSessionError("recovery_authority", retirementError);
      }
      continue;
    }
    if (settlement === undefined) {
      if (unresolved || index !== requests.length - 1) {
        throw new ManagedSessionError(
          "recovery_authority",
          "provider request ledger contains an ambiguous gap",
        );
      }
      unresolved = true;
      continue;
    }
    if (
      !safeTranscriptIdentity(settlement.assistantEntryId, 128) ||
      !isSha256Digest(settlement.assistantEntrySha256)
    ) {
      throw new ManagedSessionError(
        "recovery_authority",
        "provider settlement identity is malformed",
      );
    }
    validateManagedUsage({ ...settlement.usage });
    if (
      safeUsageSum(
        settlement.usage.input,
        settlement.usage.cacheRead,
        settlement.usage.cacheWrite,
      ) > request.prospectiveInputTokens ||
      settlement.usage.output > request.reservedOutputTokens
    ) {
      throw new ManagedSessionError(
        "recovery_authority",
        "provider settlement exceeds its reservation",
      );
    }
    input = safeUsageSum(input, settlement.usage.input);
    output = safeUsageSum(output, settlement.usage.output);
    cacheRead = safeUsageSum(cacheRead, settlement.usage.cacheRead);
    cacheWrite = safeUsageSum(cacheWrite, settlement.usage.cacheWrite);
  }
  const expected = {
    input,
    output,
    cacheRead,
    cacheWrite,
    newTokens: safeUsageSum(input, output),
    allTokens: safeUsageSum(input, output, cacheRead, cacheWrite),
  };
  if (canonicalHash(expected) !== canonicalHash(state.usage)) {
    throw new ManagedSessionError(
      "recovery_authority",
      "provider ledger does not equal durable usage totals",
    );
  }
}

function isOpenRecoveryProviderRequest(request: KoniProviderRequestRecoveryRecord): boolean {
  return request.settlement === undefined && request.retirement === undefined;
}

function isRetiredProviderAssistant(authority: KoniAttemptRecoveryState, entryId: string): boolean {
  return (authority.providerRequests ?? []).some(
    (request) =>
      request.retirement !== undefined &&
      "assistantEntryId" in request.retirement &&
      request.retirement.assistantEntryId === entryId,
  );
}

function assertProviderSettlementsMatchTranscript(
  entries: readonly PiSessionEntry[],
  state: KoniAttemptRecoveryState,
): void {
  const requests = state.providerRequests;
  if (requests === undefined) return;
  for (const [index, request] of requests.entries()) {
    const settlement = request.settlement;
    const retirement = request.retirement;
    if (retirement !== undefined) {
      const baselineIndex = entries.findIndex((entry) => entry.id === request.baselineEntryId);
      const nextBaselineId = requests[index + 1]?.baselineEntryId;
      const nextBaselineIndex =
        nextBaselineId === undefined
          ? entries.length
          : entries.findIndex((entry) => entry.id === nextBaselineId);
      const assistants = entries
        .slice(baselineIndex + 1, nextBaselineIndex + 1)
        .filter(
          (entry) =>
            entry.type === "message" &&
            isRecord(entry.message) &&
            entry.message.role === "assistant",
        );
      const retiredAssistant = assistants.at(-1);
      if (
        baselineIndex < 0 ||
        nextBaselineIndex <= baselineIndex ||
        ("assistantEntryId" in retirement
          ? retiredAssistant?.id !== retirement.assistantEntryId ||
            canonicalHash(retiredAssistant) !== retirement.assistantEntrySha256
          : assistants.length !== 0)
      ) {
        throw new ManagedSessionError(
          "recovery_provider_settlement",
          "provider retirement no longer matches its exact canonical Pi response boundary",
        );
      }
      continue;
    }
    if (settlement === undefined) {
      throw new ManagedSessionError(
        "recovery_provider_settlement",
        "provider reservation remains unsettled during transcript authentication",
      );
    }
    let derived: ReturnType<typeof deriveProviderSettlements>[number];
    try {
      [derived] = deriveProviderSettlements(entries, [
        {
          baselineEntryId: request.baselineEntryId,
          nextBaselineEntryId: settlement.assistantEntryId,
        },
      ]);
    } catch (error) {
      throw new ManagedSessionError(
        "recovery_provider_settlement",
        `provider settlement cannot be re-derived from Pi JSONL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      derived === undefined ||
      derived.assistantEntryId !== settlement.assistantEntryId ||
      derived.assistantEntrySha256 !== settlement.assistantEntrySha256 ||
      canonicalHash(derived.usage) !== canonicalHash(settlement.usage)
    ) {
      throw new ManagedSessionError(
        "recovery_provider_settlement",
        "provider settlement no longer matches its exact canonical Pi assistant entry",
      );
    }
  }
}

function validateAuthorizedMessages(messages: readonly KoniAuthorizedMessage[]): void {
  if (!Array.isArray(messages)) {
    throw new ManagedSessionError("recovery_authority", "authority steering ledger is missing");
  }
  validateAuthoritySequences(messages);
  for (const message of messages) {
    validateAuthorizedMessageRecord(message, "recovery_authority");
  }
}

function validateAuthorizedMessageRecord(
  value: unknown,
  code: string,
): asserts value is KoniAuthorizedMessage {
  if (!isRecord(value)) {
    throw new ManagedSessionError(code, "authority message record is malformed");
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = ["content", "mode", "sequence", "sha256", "sizeBytes"].sort();
  const content = value.content;
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) <= 0 ||
    (value.mode !== "steer" && value.mode !== "follow_up") ||
    typeof content !== "string" ||
    content.length === 0 ||
    content.includes("\u0000") ||
    Buffer.byteLength(content, "utf8") > 1024 * 1024 ||
    value.sizeBytes !== Buffer.byteLength(content, "utf8") ||
    value.sha256 !== rawSha256(content)
  ) {
    throw new ManagedSessionError(code, "authority message record is malformed or hash-drifted");
  }
}

function validateAuthorizedToolResults(
  spec: Readonly<AgentLaunchSpec>,
  results: readonly KoniAttemptRecoveryState["authorizedToolResults"][number][],
): void {
  if (!Array.isArray(results)) {
    throw new ManagedSessionError("recovery_authority", "authority tool receipt ledger is missing");
  }
  validateAuthoritySequences(results);
  const allowedTools = new Set(spec.tools.map((tool) => tool.name));
  const calls = new Set<string>();
  for (const result of results) {
    const toolBinding = spec.tools.find((tool) => tool.name === result.toolName);
    let encodedReceipt: string;
    try {
      if (!isRecord(result.receipt)) throw new Error("receipt is not an object");
      encodedReceipt = canonicalEncode(result.receipt);
      validateKoniToolReceipt(result.receipt);
      renderKoniToolReceipt(result.receipt);
    } catch {
      throw new ManagedSessionError(
        "recovery_authority",
        "authority tool receipt object is malformed",
      );
    }
    if (
      !safeTranscriptIdentity(result.callId, 256) ||
      !allowedTools.has(result.toolName) ||
      toolBinding === undefined ||
      (result.outcome !== "accepted" && result.outcome !== "rejected") ||
      result.outcome !== result.receipt.outcome ||
      calls.has(result.callId) ||
      !isSha256Digest(result.receiptSha256) ||
      !isSha256Digest(result.argumentsSha256) ||
      !Number.isSafeInteger(result.argumentsSizeBytes) ||
      result.argumentsSizeBytes <= 0 ||
      result.argumentsSizeBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(result.receiptSizeBytes) ||
      result.receiptSizeBytes <= 0 ||
      result.receiptSizeBytes > 16 * 1024 * 1024 ||
      result.receiptSha256 !== canonicalHash(result.receipt) ||
      result.receiptSizeBytes !== Buffer.byteLength(encodedReceipt, "utf8") ||
      koniToolResultPayloadBytes({
        content: [{ type: "text", text: renderKoniToolReceipt(result.receipt) }],
        details: result.receipt,
        ...(result.toolName === spec.terminal.toolName && result.outcome === "accepted"
          ? { terminate: true }
          : {}),
      }) > toolBinding.maxResultBytes
    ) {
      throw new ManagedSessionError(
        "recovery_authority",
        "authority tool receipt ledger is malformed",
      );
    }
    calls.add(result.callId);
  }
}

function validateAuthorizedCompactions(
  compactions: readonly KoniAttemptRecoveryState["authorizedCompactions"][number][],
): void {
  if (!Array.isArray(compactions)) {
    throw new ManagedSessionError("recovery_authority", "authority compaction ledger is missing");
  }
  validateAuthoritySequences(compactions);
  const ids = new Set<string>();
  for (const compaction of compactions) {
    if (
      !safeTranscriptIdentity(compaction.authorizationId, 256) ||
      ids.has(compaction.authorizationId) ||
      !isSha256Digest(compaction.summaryHash) ||
      !Number.isSafeInteger(compaction.summaryBytes) ||
      compaction.summaryBytes <= 0 ||
      compaction.summaryBytes > 4 * 1024 * 1024 ||
      !safeTranscriptIdentity(compaction.firstKeptEntryId, 128) ||
      !Number.isSafeInteger(compaction.tokensBefore) ||
      compaction.tokensBefore < 0
    ) {
      throw new ManagedSessionError(
        "recovery_authority",
        "authority compaction ledger is malformed",
      );
    }
    ids.add(compaction.authorizationId);
  }
}

function validateAuthoritySequences(records: readonly unknown[]): void {
  let expected = 1;
  for (const record of records) {
    if (
      !isRecord(record) ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence !== expected
    ) {
      throw new ManagedSessionError("recovery_authority", "authority ledger sequence is invalid");
    }
    expected += 1;
  }
}

function safeTranscriptIdentity(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validateTerminalPayload(
  spec: Readonly<AgentLaunchSpec>,
  schema: TSchema,
  output: unknown,
  description: string,
): unknown {
  let serialized: string;
  try {
    const encoded = JSON.stringify(output);
    if (encoded === undefined) throw new Error("undefined output");
    serialized = encoded;
  } catch {
    throw new ManagedSessionError("terminal_output", `${description} is not JSON serializable`);
  }
  if (Buffer.byteLength(serialized, "utf8") > spec.terminal.maxOutputBytes) {
    throw new ManagedSessionError(
      "terminal_output",
      `${description} exceeds its launch byte budget`,
    );
  }
  const clone = JSON.parse(serialized) as unknown;
  let valid: boolean;
  try {
    valid = Compile(schema).Check(clone);
  } catch (error) {
    throw new ManagedSessionError(
      "terminal_schema",
      `terminal output schema cannot be compiled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!valid) {
    throw new ManagedSessionError(
      "terminal_output",
      `${description} does not match the compiler-issued schema`,
    );
  }
  return clone;
}

function recoveryUsage(entries: readonly PiSessionEntry[]): ManagedTokenUsage {
  const totals = summarizeUsage(entries);
  return {
    input: safeUsageNumber(totals.input, "input"),
    output: safeUsageNumber(totals.output, "output"),
    cacheRead: safeUsageNumber(totals.cacheRead, "cacheRead"),
    cacheWrite: safeUsageNumber(totals.cacheWrite, "cacheWrite"),
    newTokens: safeUsageNumber(totals.newTokens, "newTokens"),
    allTokens: safeUsageNumber(totals.allTokens, "allTokens"),
  };
}

function authorityRecoveryUsage(state: KoniAttemptRecoveryState): ManagedTokenUsage {
  const usage = { ...state.usage };
  validateManagedUsage(usage);
  return usage;
}

function mergeRecoveryUsage(
  authority: ManagedTokenUsage,
  transcript: ManagedTokenUsage,
): ManagedTokenUsage {
  const input = Math.max(authority.input, transcript.input);
  const output = Math.max(authority.output, transcript.output);
  const cacheRead = Math.max(authority.cacheRead, transcript.cacheRead);
  const cacheWrite = Math.max(authority.cacheWrite, transcript.cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    newTokens: safeUsageSum(input, output),
    allTokens: safeUsageSum(input, output, cacheRead, cacheWrite),
  };
}

function exactRecoveryUsage(
  authority: ManagedTokenUsage,
  transcript: ManagedTokenUsage,
): ManagedTokenUsage {
  if (canonicalHash(authority) !== canonicalHash(transcript)) {
    throw new ManagedSessionError(
      "recovery_usage",
      "canonical Pi transcript usage differs from the durable provider settlement ledger",
    );
  }
  return { ...authority };
}

function safeUsageNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ManagedSessionError(
      "recovery_usage",
      `persisted ${field} usage exceeds safe accounting range`,
    );
  }
  return Number(value);
}

function userText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return undefined;
    parts.push(item.text);
  }
  return parts.join("");
}

function recoveryReason(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const clean = value.replaceAll("\u0000", "").trim();
  return clean.length === 0 ? fallback : clean.slice(0, 4_096);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function onceAsync(operation: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | undefined;
  return () => {
    promise ??= Promise.resolve().then(operation);
    return promise;
  };
}

async function withTimeout<Value>(
  operation: Promise<Value>,
  timeoutMs: number,
  message: string,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function disposeRejectedAdapter(adapter: PiSessionAdapter): Promise<void> {
  try {
    await adapter.abort();
  } catch {
    // Constructor validation failure remains the primary error.
  }
  try {
    await adapter.dispose();
  } catch {
    // Best-effort cleanup cannot replace the validation failure.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateToolBindings(
  spec: Readonly<AgentLaunchSpec>,
  tools: readonly AuthorityBackedTool[],
): AuthorityBackedTool {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (byName.size !== tools.length || tools.length !== spec.tools.length) {
    throw new ManagedSessionError(
      "tool_inventory",
      "authority tool bindings do not exactly match the launch inventory",
    );
  }
  for (const expected of spec.tools) {
    const actual = byName.get(expected.name);
    if (
      actual === undefined ||
      actual.definition.name !== expected.name ||
      actual.schemaHash !== expected.schemaHash ||
      actual.maxResultBytes !== expected.maxResultBytes ||
      canonicalHash(actual.definition.parameters) !== expected.schemaHash ||
      (actual.definition.executionMode ?? "parallel") !== expected.executionMode ||
      actual.definition.prepareArguments !== undefined
    ) {
      throw new ManagedSessionError(
        "tool_binding",
        `authority tool ${expected.name} does not match its launch binding`,
      );
    }
  }
  const terminal = byName.get(spec.terminal.toolName);
  if (
    terminal === undefined ||
    terminal.definition.executionMode !== "sequential" ||
    terminal.terminalOutputSchema === undefined ||
    terminal.terminalOutputSchemaHash !== spec.terminal.outputSchemaHash ||
    canonicalHash(terminal.terminalOutputSchema) !== spec.terminal.outputSchemaHash
  ) {
    throw new ManagedSessionError(
      "terminal_schema",
      "terminal tool output schema does not match its launch binding",
    );
  }
  try {
    Compile(terminal.terminalOutputSchema);
  } catch (error) {
    throw new ManagedSessionError(
      "terminal_schema",
      `terminal output schema cannot be compiled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const tool of tools) {
    if (
      tool.name !== spec.terminal.toolName &&
      (tool.terminalOutputSchema !== undefined || tool.terminalOutputSchemaHash !== undefined)
    ) {
      throw new ManagedSessionError(
        "terminal_schema",
        `non-terminal tool ${tool.name} declares a terminal schema`,
      );
    }
  }
  return terminal;
}

function runtimeToolDefinitions(
  spec: Readonly<AgentLaunchSpec>,
  tools: readonly AuthorityBackedTool[],
  sessionManager: SessionManager,
  resultBudget: TranscriptToolResultBudget,
): ToolDefinition[] {
  return tools.map((tool) => {
    const definition = tool.definition;
    return {
      ...definition,
      ...(tool.name === spec.terminal.toolName ? { executionMode: "sequential" as const } : {}),
      async execute(toolCallId, params, signal, _onUpdate, _context) {
        const sessionFile = sessionManager.getSessionFile();
        if (sessionFile === undefined) {
          throw new ManagedSessionError(
            "session_persistence",
            "authority tool call has no durable Pi session file",
          );
        }
        // Pi persists the assistant tool-call entry before invoking a tool. Commit that entry
        // before any authority-backed effect so recovery can always authenticate the call.
        await syncSessionFile(sessionFile);
        const argumentsRecord = params as Record<string, unknown>;
        const budgetDisposition = await resultBudget.reserve(tool.maxResultBytes);
        const result =
          budgetDisposition === "execute"
            ? await tool.execute(toolCallId, argumentsRecord, signal)
            : await tool.reject(
                toolCallId,
                argumentsRecord,
                transcriptBudgetRejection(spec),
                signal,
              );
        const receipt = validatedReceiptFromResult(result, tool.maxResultBytes);
        if (tool.name !== spec.terminal.toolName && result.terminate === true) {
          throw new ManagedSessionError(
            "tool_result",
            "non-terminal authority tool attempted to terminate",
          );
        }
        return tool.name === spec.terminal.toolName && receipt.outcome === "accepted"
          ? { ...result, terminate: true }
          : result;
      },
    };
  });
}

/**
 * Reserve transcript space before an authority effect. Pi may execute a parallel tool batch, so
 * reservations are serialized and retained through the whole turn; no result can borrow bytes
 * another in-flight result has already been promised.
 */
class TranscriptToolResultBudget {
  readonly #spec: Readonly<AgentLaunchSpec>;
  readonly #sessionManager: SessionManager;
  #baseBytes: number | undefined;
  #reservedBytes = 0;
  #lock: Promise<void> = Promise.resolve();

  public constructor(spec: Readonly<AgentLaunchSpec>, sessionManager: SessionManager) {
    this.#spec = spec;
    this.#sessionManager = sessionManager;
  }

  public reset(): void {
    this.#baseBytes = undefined;
    this.#reservedBytes = 0;
  }

  public reserve(maxResultBytes: number): Promise<"execute" | "reject"> {
    return this.#serialized(async () => {
      validatePositiveResultBound(maxResultBytes);
      const executeBytes = maxResultBytes + TRANSCRIPT_TOOL_RESULT_OVERHEAD_BYTES;
      if (await this.#canReserve(executeBytes)) {
        this.#reservedBytes += executeBytes;
        return "execute" as const;
      }
      const rejectionBytes = RUNTIME_REJECTION_RESULT_BYTES + TRANSCRIPT_TOOL_RESULT_OVERHEAD_BYTES;
      if (await this.#canReserve(rejectionBytes)) {
        this.#reservedBytes += rejectionBytes;
        return "reject" as const;
      }
      throw new ManagedSessionError(
        "transcript_budget",
        `Pi transcript cannot safely persist even a bounded rejection within its ${this.#spec.budgets.transcript.maxBytes}-byte attempt budget`,
      );
    });
  }

  public reserveExact(resultBytes: number): Promise<void> {
    return this.#serialized(async () => {
      validatePositiveResultBound(resultBytes);
      const reservation = resultBytes + TRANSCRIPT_TOOL_RESULT_OVERHEAD_BYTES;
      if (!(await this.#canReserve(reservation))) {
        throw new ManagedSessionError(
          "transcript_budget",
          `Pi transcript cannot persist an authenticated recovery result within its ${this.#spec.budgets.transcript.maxBytes}-byte attempt budget`,
        );
      }
      this.#reservedBytes += reservation;
    });
  }

  async #canReserve(bytes: number): Promise<boolean> {
    if (this.#baseBytes === undefined) {
      const sessionFile = this.#sessionManager.getSessionFile();
      if (sessionFile === undefined) {
        throw new ManagedSessionError(
          "session_persistence",
          "tool-result reservation has no durable Pi session file",
        );
      }
      this.#baseBytes = await safeRegularFileSize(sessionFile);
    }
    return this.#baseBytes + this.#reservedBytes + bytes <= this.#spec.budgets.transcript.maxBytes;
  }

  #serialized<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = this.#lock.then(operation, operation);
    this.#lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function safeRegularFileSize(file: string): Promise<number> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ManagedSessionError("session_persistence", "Pi session path is not a regular file");
    }
    return metadata.size;
  } catch (error) {
    if (error instanceof ManagedSessionError) throw error;
    throw new ManagedSessionError(
      "session_persistence",
      `Pi session size cannot be authenticated: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validatePositiveResultBound(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 16 * 1024 * 1024) {
    throw new ManagedSessionError("tool_result", "tool result byte bound is invalid");
  }
}

function transcriptBudgetRejection(spec: Readonly<AgentLaunchSpec>): KoniRuntimeToolRejection {
  return {
    code: "transcript_result_budget",
    summary: `Tool was not executed because its worst-case result would exceed this attempt's ${spec.budgets.transcript.maxBytes}-byte transcript budget.`,
  };
}

function validatedReceiptFromResult(
  result: AgentToolResult<unknown>,
  maxResultBytes: number,
): KoniToolReceipt {
  validateKoniToolReceipt(result.details);
  if (
    koniToolResultPayloadBytes(result) > maxResultBytes ||
    result.content.length !== 1 ||
    result.content[0]?.type !== "text" ||
    result.content[0].text !== renderKoniToolReceipt(result.details)
  ) {
    throw new ManagedSessionError(
      "tool_result",
      "authority tool result exceeds its bound or is not canonical",
    );
  }
  if (result.details.outcome === "rejected" && result.terminate === true) {
    throw new ManagedSessionError(
      "tool_result",
      "a rejected authority tool result cannot terminate an attempt",
    );
  }
  return result.details;
}

function snapshotToolBindings(tools: readonly AuthorityBackedTool[]): AuthorityBackedTool[] {
  return tools.map((tool) => ({
    ...tool,
    definition: {
      ...tool.definition,
      parameters: structuredClone(tool.definition.parameters),
      ...(tool.definition.promptGuidelines === undefined
        ? {}
        : { promptGuidelines: [...tool.definition.promptGuidelines] }),
    },
    ...(tool.terminalOutputSchema === undefined
      ? {}
      : { terminalOutputSchema: structuredClone(tool.terminalOutputSchema) }),
  }));
}

function assertExactToolInventory(
  spec: Readonly<AgentLaunchSpec>,
  active: readonly string[],
): void {
  const expected = spec.tools.map((tool) => tool.name).sort();
  const actual = [...active].sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new ManagedSessionError(
      "ambient_tool",
      "Pi exposed a tool outside the compiler-issued inventory",
    );
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
  total.input = safeUsageSum(total.input, input);
  total.output = safeUsageSum(total.output, output);
  total.cacheRead = safeUsageSum(total.cacheRead, cacheRead);
  total.cacheWrite = safeUsageSum(total.cacheWrite, cacheWrite);
  total.newTokens = safeUsageSum(total.input, total.output);
  total.allTokens = safeUsageSum(total.newTokens, total.cacheRead, total.cacheWrite);
}

function validateManagedUsage(usage: ManagedTokenUsage): void {
  for (const [name, value] of Object.entries(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ManagedSessionError("recovery_usage", `recovered ${name} usage is invalid`);
    }
  }
  if (
    usage.newTokens !== usage.input + usage.output ||
    usage.allTokens !== usage.newTokens + usage.cacheRead + usage.cacheWrite
  ) {
    throw new ManagedSessionError("recovery_usage", "recovered token aggregates are inconsistent");
  }
}

function assertMonotonicUsage(
  prior: Readonly<ManagedTokenUsage>,
  next: Readonly<ManagedTokenUsage>,
): void {
  if (
    next.input < prior.input ||
    next.output < prior.output ||
    next.cacheRead < prior.cacheRead ||
    next.cacheWrite < prior.cacheWrite
  ) {
    throw new ManagedSessionError("usage", "authority provider usage moved backwards");
  }
}

function safeUsageSum(...values: number[]): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) {
    throw new ManagedSessionError("usage", "Pi token usage exceeds safe accounting range");
  }
  return result;
}

function tokenBudgetViolation(
  spec: Readonly<AgentLaunchSpec>,
  cumulativeUsage: ManagedTokenUsage,
): string | undefined {
  const usage = planningRevisionBudgetUsage(spec, cumulativeUsage);
  const maximum = spec.budgets.tokens;
  const checks: Array<[number, number, string]> = [
    [usage.input, maximum.maxInput, "input"],
    [usage.output, maximum.maxOutput, "output"],
    [usage.cacheRead, maximum.maxCacheRead, "cache-read"],
    [usage.cacheWrite, maximum.maxCacheWrite, "cache-write"],
    [usage.newTokens, maximum.maxNew, "new-token"],
    [usage.allTokens, maximum.maxAll, "cache-inclusive"],
  ];
  return checks.find(([actual, allowed]) => actual > allowed)?.[2].concat(" token budget exceeded");
}

function tokenBudgetExhaustion(
  spec: Readonly<AgentLaunchSpec>,
  cumulativeUsage: ManagedTokenUsage,
): string | undefined {
  const usage = planningRevisionBudgetUsage(spec, cumulativeUsage);
  const maximum = spec.budgets.tokens;
  const checks: Array<[number, number, string]> = [
    [usage.input, maximum.maxInput, "input"],
    [usage.output, maximum.maxOutput, "output"],
    [usage.cacheRead, maximum.maxCacheRead, "cache-read"],
    [usage.cacheWrite, maximum.maxCacheWrite, "cache-write"],
    [usage.newTokens, maximum.maxNew, "new-token"],
    [usage.allTokens, maximum.maxAll, "cache-inclusive"],
  ];
  return checks
    .find(([actual, allowed]) => actual >= allowed)?.[2]
    .concat(" token budget exhausted");
}

/**
 * Bound one request's output reservation independently of the run-wide token budget.
 *
 * A model can advertise an output maximum large enough to consume most of its context
 * window. Reserving that entire maximum alongside an already-large prompt leaves no
 * allowance for provider framing or context reissue messages, which can turn an otherwise
 * admissible synthesis turn into a canonical provider abort. Keep at least three quarters of
 * an authenticated context window available for prompt and transport overhead.
 */
export function providerOutputLimit(
  spec: Readonly<AgentLaunchSpec>,
  recoveredUsage: ManagedTokenUsage | undefined,
): number {
  const usage = planningRevisionBudgetUsage(spec, recoveredUsage ?? emptyUsage());
  const maximum = spec.budgets.tokens;
  const contextOutputCap =
    spec.model.catalogContextWindow === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.floor(spec.model.catalogContextWindow / 4);
  return Math.max(
    1,
    Math.min(
      maximum.maxOutput - usage.output,
      maximum.maxNew - usage.newTokens,
      maximum.maxAll - usage.allTokens,
      contextOutputCap,
    ),
  );
}

function planningRevisionBudgetUsage(
  spec: Readonly<AgentLaunchSpec>,
  cumulative: Readonly<ManagedTokenUsage>,
): ManagedTokenUsage {
  const baseline = spec.planningRevision?.budgetBaseline;
  if (baseline === undefined) return { ...cumulative };
  const input = cumulative.input - baseline.inputTokens;
  const output = cumulative.output - baseline.outputTokens;
  const cacheRead = cumulative.cacheRead - baseline.cacheReadTokens;
  const cacheWrite = cumulative.cacheWrite - baseline.cacheWriteTokens;
  if ([input, output, cacheRead, cacheWrite].some((value) => value < 0)) {
    throw new ManagedSessionError(
      "planning_revision_budget",
      "cumulative provider usage moved behind the authenticated planning revision baseline",
    );
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    newTokens: safeUsageSum(input, output),
    allTokens: safeUsageSum(input, output, cacheRead, cacheWrite),
  };
}

function containedCompactionKeepRecentTokens(spec: Readonly<AgentLaunchSpec>): number {
  return Math.max(2_000, Math.min(8_000, Math.floor(spec.budgets.tokens.maxInput / 32)));
}

function exactProviderPayload(
  api: string,
  payload: unknown,
): { wirePayload: unknown; transportPayload: unknown } {
  let jsonPayload = payload;
  let abortSignal: AbortSignal | undefined;
  if (api === "google-generative-ai" || api === "google-vertex") {
    if (
      !isRecord(payload) ||
      !isRecord(payload.config) ||
      !(payload.config.abortSignal instanceof AbortSignal)
    ) {
      throw new ManagedSessionError(
        "provider_payload",
        `Pi built a ${api} payload without its live abort control`,
      );
    }
    abortSignal = payload.config.abortSignal;
    const config = { ...payload.config };
    delete config.abortSignal;
    jsonPayload = { ...payload, config };
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(jsonPayload);
  } catch {
    throw new ManagedSessionError(
      "provider_payload",
      "Pi built a non-serializable provider payload",
    );
  }
  if (encoded === undefined) {
    throw new ManagedSessionError("provider_payload", "Pi built an empty provider payload");
  }
  // The authority hashes the exact JSON body projection. Google keeps AbortSignal as a live SDK
  // control outside those bytes, so preserve that exact object while freezing every wire field.
  const wirePayload = JSON.parse(encoded) as unknown;
  if (abortSignal === undefined) return { wirePayload, transportPayload: wirePayload };
  if (!isRecord(wirePayload) || !isRecord(wirePayload.config)) {
    throw new ManagedSessionError("provider_payload", `Pi built a malformed ${api} payload`);
  }
  return {
    wirePayload,
    transportPayload: {
      ...wirePayload,
      config: { ...wirePayload.config, abortSignal },
    },
  };
}

function assertSelectedProviderModel(
  spec: Readonly<AgentLaunchSpec>,
  selected: Readonly<Model<Api>>,
  expectedMaxTokens: number,
): void {
  if (
    selected.provider !== spec.model.provider ||
    selected.id !== spec.model.id ||
    selected.api !== spec.model.api ||
    selected.maxTokens !== expectedMaxTokens
  ) {
    throw new ManagedSessionError(
      "provider_model",
      "Pi selected a provider model different from the authenticated contained model",
    );
  }
}

function assertExactProviderSettlement(
  expected: {
    sequence: number;
    reservationId: string;
    assistantEntryId: string;
    assistantEntrySha256: Sha256Digest;
    usage: KoniAttemptUsage;
  },
  settled: Awaited<ReturnType<NonNullable<KoniContextProvider["reconcileProviderRequest"]>>>,
): void {
  if (
    settled.protocol !== "koni.provider-request-settlement.v1" ||
    settled.sequence !== expected.sequence ||
    settled.reservationId !== expected.reservationId ||
    settled.assistantEntryId !== expected.assistantEntryId ||
    settled.assistantEntrySha256 !== expected.assistantEntrySha256 ||
    canonicalHash(settled.usage) !== canonicalHash(expected.usage)
  ) {
    throw new ManagedSessionError(
      "provider_settlement",
      "authority settled a different provider request or canonical assistant usage",
    );
  }
}

function assertCodexProviderPayload(
  spec: Readonly<AgentLaunchSpec>,
  payload: unknown,
): asserts payload is Record<string, unknown> {
  if (
    !isRecord(payload) ||
    payload.model !== spec.model.id ||
    payload.store !== false ||
    payload.stream !== true ||
    typeof payload.instructions !== "string" ||
    !Array.isArray(payload.input) ||
    !isRecord(payload.text) ||
    !Array.isArray(payload.include) ||
    payload.parallel_tool_calls !== true ||
    !(typeof payload.tool_choice === "string" || isRecord(payload.tool_choice)) ||
    (payload.tools !== undefined && !Array.isArray(payload.tools)) ||
    (payload.reasoning !== undefined && !isRecord(payload.reasoning))
  ) {
    throw new ManagedSessionError(
      "provider_payload",
      "Pi built a malformed or differently bound OpenAI Codex request payload",
    );
  }
}

function emptyUsage(): ManagedTokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 };
}

function sanitizeText(value: string): string {
  const clean = value.replaceAll("\u0000", "").trim();
  return clean.length === 0 ? "aborted by authority" : clean.slice(0, 4_096);
}

function sanitizeProviderError(value: string | undefined): string {
  const clean = (value ?? "provider request failed").replaceAll("\u0000", "").trim();
  return (clean.length === 0 ? "provider request failed" : clean).slice(0, 4_096);
}

function providerAdmissionFailure(error: unknown): ManagedSessionError {
  const failure =
    error instanceof ManagedSessionError
      ? error
      : new ManagedSessionError(
          "provider_admission",
          error instanceof Error ? error.message : String(error),
        );
  if (failure.code !== "provider_input_exposure" && failure.code !== "provider_token_exposure") {
    return failure;
  }
  // Pi owns the provider-free compact-and-retry lifecycle, but identifies overflow from the
  // persisted assistant error text. Preserve Koni's typed code while projecting a stable marker
  // that Pi recognizes instead of coupling recovery to authority wording.
  const marker = "Koni provider admission rejected: request exceeds the context window. ";
  return new ManagedSessionError(
    failure.code,
    `${marker}${sanitizeProviderError(failure.message)}`.slice(0, 4_096),
  );
}
