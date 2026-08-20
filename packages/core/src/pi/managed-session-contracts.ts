import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  AgentSessionEvent,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { Sha256Digest } from "../shared/canonical.js";
import type {
  CompactionLifecycleNotice,
  KoniAttemptRecoveryState,
  KoniAuthorizedMessage,
  KoniContextProvider,
} from "./compaction.js";
import type { AgentLaunchSpec } from "./launch-spec.js";
import type { KoniRuntimeToolRejection } from "./tool-catalog.js";

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

export interface PendingRecoveredMessage {
  message: KoniAuthorizedMessage;
  mappingPersisted: boolean;
}

export interface PendingRecoveredToolActionBase {
  order: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export type PendingRecoveredToolAction = PendingRecoveredToolActionBase &
  (
    | {
        kind: "append_receipt";
        authorizedResult: KoniAttemptRecoveryState["authorizedToolResults"][number];
      }
    | { kind: "execute" }
    | { kind: "append_pi_error"; errorText: string }
  );

export interface AuthenticatedRecovery {
  projection: RecoveredSessionState;
  transcriptSha256?: Sha256Digest;
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
