import type { TSchema } from "typebox";
import type { CompiledExecutionSemanticCatalog } from "../compiler/execution-semantics.js";
import type {
  ActionExecutionJournal,
  CompiledActionDefinition,
  CompiledRunStage,
  LeadJudgmentOutput,
  LeadJudgmentTrigger,
} from "../contracts/behavior.js";
import type { ConfigurationObject } from "../contracts/configuration.js";
import type { CompiledStateMachineCatalog } from "../contracts/rules.js";
import { type CompiledCockpitViewCatalog } from "../control-center/cockpit-config.js";
import type { ControlCatalog } from "../control-center/protocol.js";
import { type IsolatedGitLifecycle } from "../git/index.js";
import type { GraphEdge, GraphNode } from "../graph/model.js";
import type { KoniCompactionSnapshot, KoniContextProvider } from "../pi/compaction.js";
import { type AgentAttemptLineage, type AgentLaunchSpec } from "../pi/launch-spec.js";
import type { AuthorityBackedTool, ManagedPiSessionFactory } from "../pi/managed-session.js";
import { type KoniToolInvocation, type KoniToolName } from "../pi/tool-catalog.js";
import type { RuntimeExecutableIdentity } from "../runtime/executable.js";
import { type Sha256Digest } from "../shared/canonical.js";
import {
  type CheckExecutionPolicyBinding,
  type ComposedReplaySelection,
  type ExecutionPolicyBinding,
  type ExecutionPolicyReceiptEvidence,
  type GateAutoEvaluationContextBinding,
} from "./execution-policy.js";
import type { TransactionWrite } from "./file-journal.js";
import type { AuthorityGrant } from "./grants.js";
import type { JsonValue } from "./protocol.js";

import { type PiAttemptProcessSupervisor } from "../pi/attempt-process-pool.js";
import { type ManagedSessionSupervisor } from "../pi/supervisor.js";
import {
  type ApprovedChangeMaterialization,
  type ChangeControlPublication,
  type TerminalResolverReconciliation,
  type TerminalResolverRetryRequest,
} from "../state/change-control.js";
import { type LegacyRunGitExecutor } from "../state/legacy-run-git-executor.js";
import { type RunPhase } from "../state/run-lifecycle.js";
import type {
  AgentAttemptRecord,
  AgentTerminalPolicyRecord,
  AttemptStatus,
  RunActionExecutionRecord,
  RunActivityRecord,
  RunBehaviorSnapshot,
  RunCheckAttemptRecord,
  RunExecutionConfig,
  RunLeadJudgmentRecord,
  RunPipelineStageRecord,
  RunPlanRecord,
  RunRecord,
  RunReportRecord,
  TicketRecord,
  WorkspaceEffectIntentRecord,
} from "../state/run-record.js";
import { leadJudgmentFrontierSha256 } from "../state/run-record.js";
import { type ReadyAssignment } from "../state/scheduler.js";

export const MAX_PROVIDER_RESPONSE_TRANSCRIPT_OVERSHOOT_BYTES = 24 * 1024 * 1024;
/**
 * Fresh attempts a single ticket step may consume after configured validation proves it
 * preserved pre-semantic state. Bounds pathological churn while letting a fresh model turn
 * correct deterministic compiler feedback instead of surfacing a recoverable operator block.
 */
export const MAX_PRE_SEMANTIC_VALIDATION_REISSUES = 3;
export const SETTLED_PRE_SEMANTIC_VALIDATION_REISSUE_ACTIVITY =
  "Recovered a settled pre-semantic validation failure for fresh reissue";
// A rejection normally reissues the held source so it can produce a corrected request. Bound
// that semantic retry separately from infrastructure recovery: repeated denied scope requests
// must eventually preserve the completed source evidence and let the ticket continue.
export const MAX_REJECTED_SOURCE_REISSUES = 3;
// A terminal resolver may diagnose a source authority mismatch, but completing that diagnosis
// does not itself widen the source's immutable grant. Reissuing the same source more than once
// just replays an identical no-op application; retain the evidence and let normal change control
// project a distinct scoped successor instead.
// A blocked run whose only obstacle is a retireable provider-exposure hold (an aborted/errored
// provider request that can never settle) is auto-recovered without an operator resume. This caps
// how many times one run may auto-retire-and-continue before it stays blocked for the operator, so
// a pathological abort-every-time loop cannot churn provider spend indefinitely.
export const MAX_PROVIDER_EXPOSURE_AUTO_RECOVERIES = 3;
// Rate-limit errors are recoverable but token-bucket capacity replenishes over minutes, not the
// sub-second transcript-propagation window. Preserve a larger bounded retry allowance for this
// explicit upstream class and space its requests exponentially instead of burning the generic
// three-error allowance in one burst.
export const MAX_PROVIDER_RATE_LIMIT_AUTO_RECOVERIES = 12;
export const MIN_PROVIDER_RATE_LIMIT_RECOVERY_DELAY_MS = 60_000;
export const MAX_PROVIDER_RATE_LIMIT_RECOVERY_DELAY_MS = 15 * 60_000;
// A canonical provider error with an empty assistant payload and exact zero reported usage proves
// that no model work survived in the authenticated transcript. Give this narrower, effect-free
// failure a second bounded tier after the ordinary three immediate recoveries, spaced so a short
// upstream network outage cannot burn the whole allowance in one burst. Retirement still retains
// the request's conservative exposure bound; this changes retry timing, never accounting.
export const MAX_PROVIDER_ZERO_USAGE_TRANSPORT_AUTO_RECOVERIES = 6;
export const MIN_PROVIDER_ZERO_USAGE_TRANSPORT_RECOVERY_DELAY_MS = 30_000;
export const MAX_PROVIDER_ZERO_USAGE_TRANSPORT_RECOVERY_DELAY_MS = 5 * 60_000;
// A provider admission rejection occurs before a canonical assistant turn exists. Re-drive it
// from a fresh contained root, bounded just like provider-exposure recovery, so an oversized
// inherited transcript never turns into an operator-only retry loop.
export const MAX_PROVIDER_ADMISSION_AUTO_RECOVERIES = 3;
export const RECOVERABLE_CONFIGURED_CHECK_PREFLIGHT_CODES = new Set([
  "check_argv",
  "check_input_binding",
  "check_path",
  "check_path_scope",
  "check_result_path",
]);
// Advancement is event-driven, so a lost or raced continuation leaves a run in an executing phase
// with an attempt record that no live process backs. Nothing then re-drives it: the run reports
// itself healthy and never progresses again. Re-derive liveness on an interval and repair the
// difference, which is the only path back that does not require an operator to stop the authority.
export const RECONCILE_INTERVAL_MS = 60_000;
// An attempt record with no live process is only evidence of a wedge once the run has also stopped
// writing. It must clear the longest legitimate quiet period, and that is not a settlement race: an
// attempt that submits normally goes `terminal_accepted`, its process exits as designed, and the
// authority then runs assignment validation — including configured checks whose own timeout reaches
// 900s — without writing to the run record. A bound below that retires healthy work mid-validation,
// which is exactly what a first 300s setting did here, repeatedly killing the one ticket whose
// validation runs a gate verifier. Sit above the longest configured check instead; a real wedge
// idles indefinitely, so detection loses nothing by waiting.
export const ATTEMPT_STALL_MS = 1_200_000;
// A configured action can settle its semantic product before the provider outcome callback closes
// the durable attempt. Retry that final, effect-free status transition in-process so a transient
// mutation/CAS exception cannot orphan a terminal artifact until the next authority restart.
export const MAX_TERMINAL_FINALIZATION_RECOVERIES = 3;
// A contained provider can persist its terminal JSONL entry a moment after the process outcome
// reaches the authority. Re-probe that narrow propagation window rather than requiring the user
// to restart or resume a run whose canonical error is already becoming durable.
export const MAX_PROVIDER_TERMINAL_PROPAGATION_PROBES = 3;
export const PROVIDER_TERMINAL_PROPAGATION_PROBE_DELAY_MS = 250;
// A contained session that reaches a terminal turn without submitting is a Koni/Pi protocol
// failure, not research work product. Re-drive it automatically, but retain a hard cap so an
// agent that repeatedly ignores its terminal contract cannot churn indefinitely.
export const MAX_TERMINAL_PROTOCOL_AUTO_RECOVERIES = 3;
export const PLANNING_TERMINAL_PROTOCOL_FOLLOW_UP =
  "The previous provider turn ended without an authority-accepted terminal submission. Continue the same planning revision from the authenticated findings already in context and submit the required terminal artifact. Do not restart the plan or create a new revision.";
// Bounds one durably reserved provider request so a genuinely hung transport cannot hold worst-case
// exposure forever. It was 180s, which is shorter than the work: a research planner reasoning at
// high thinking over a large repository context needs longer than that to reach its first tool call,
// and twelve consecutive planning attempts were killed at exactly this boundary, each losing a whole
// attempt and re-paying for the same discovery. Aborting a live turn costs far more than waiting for
// it, so the bound belongs where it still catches a hang without truncating real reasoning.
export const DEFAULT_PROVIDER_REQUEST_LIVENESS_TIMEOUT_MS = 600_000;
// Codex Responses has no supported wire-level output cap in the pinned Pi runtime. Its advertised
// maximum must therefore remain reserved, while provider framing still consumes context capacity
// beyond Koni's serialized-payload estimate. Reserve a fixed transport margin so admission asks Pi
// for its existing provider-free compaction path before the remote endpoint aborts the turn.
export const UNCAPPED_PROVIDER_CONTEXT_FRAMING_RESERVE = 16 * 1024;
export const AGENT_FILE_READ_PAGE_BYTES = 32 * 1024;
// A single built-in tool result must never flood a contained attempt's context window. koni
// deliberately seals attempts from ambient Pi context-management extensions (see
// attempt-process-supervisor), so bounding tool results is koni's own responsibility. A listing or
// search over a large repository is capped to this many structured items with an explicit
// truncation marker instead of returning thousands of entries the model must then carry forever.
export const AGENT_LIST_RESULT_MAX_ENTRIES = 200;
export const AGENT_SEARCH_RESULT_MAX_MATCHES = 100;

/** Cap a structured discovery result to a window-appropriate item count, marking any truncation. */
export function boundDiscoveryItems<T>(
  items: readonly T[],
  max: number,
): { items: T[]; truncated: boolean; returned: number; omitted: number } {
  const returned = Math.min(items.length, max);
  return {
    items: items.slice(0, returned),
    truncated: items.length > returned,
    returned,
    omitted: Math.max(0, items.length - returned),
  };
}

export const REPOSITORY_DISCOVERY_TOOLS = new Set<KoniToolName>([
  "koni_read_file",
  "koni_list_files",
  "koni_search_files",
]);
export const REPOSITORY_KNOWLEDGE_INVALIDATION_TOOLS = new Set<KoniToolName>([
  "koni_write_file",
  "koni_edit_file",
  "koni_run_check",
]);

export const RUN_DELETION_PREVIEW_PROTOCOL = "koni.run-deletion-preview.v1" as const;
export const RUN_MERGE_PREVIEW_PROTOCOL = "koni.run-merge-preview.v1" as const;
export const RUN_ATTEMPT_LINEAGE_PROTOCOL = "koni.run-attempt-lineage.v1" as const;
export const RECEIPT_PARAMS = Symbol("koni.authority.receipt-params");

/** Phases where an operator pause can execute immediately as a durable lifecycle transition. */
export const PAUSABLE_RUN_PHASES = new Set<RunPhase>([
  "planning",
  "awaiting_questions",
  "awaiting_approval",
  "approving",
  "executing",
  "verifying",
  "merge_ready",
]);
/** Non-pausable phases where a pause request is durably recorded and executed at the next pausable boundary. */
export const DEFERRABLE_PAUSE_PHASES = new Set<RunPhase>(["draft", "merging", "blocked"]);

export interface RunDeletionPreview {
  protocol: typeof RUN_DELETION_PREVIEW_PROTOCOL;
  runId: string;
  objective: string;
  phase: RunPhase;
  targetRef: string;
  ownedWorktrees: number;
  ownedBranches: number;
  liveAgents: number;
  dirtyWorktreeWarnings: string[];
  blockers: string[];
  canPreserveBranches: boolean;
  canDeleteOwnedBranches: boolean;
  previewToken: Sha256Digest;
}

export interface RunMergePreview {
  protocol: typeof RUN_MERGE_PREVIEW_PROTOCOL;
  runId: string;
  objective: string;
  phase: RunPhase;
  targetRef: string;
  expectedTargetOid: string | null;
  observedTargetOid: string | null;
  targetAdvanced: boolean;
  resyncState: "current" | "required" | "unavailable";
  completedTickets: number;
  totalTickets: number;
  blockers: string[];
  canAuthorize: boolean;
  previewToken: Sha256Digest;
}

export interface RunAttemptLineageProjection {
  protocol: typeof RUN_ATTEMPT_LINEAGE_PROTOCOL;
  runId: string;
  runRevision: number;
  attempts: Array<{
    attemptId: string;
    persona: string;
    ticket: string;
    step: string;
    status: AttemptStatus;
    reason: AgentAttemptLineage["reason"];
    branchEpoch: number;
    parentAttemptId?: string;
    childAttemptIds: string[];
    activeLeaf: boolean;
  }>;
}

export interface RunCreationRequest {
  runId: string;
  objective: string;
  runTypeId: string;
  targetRef: string;
  intake: ConfigurationObject;
  overrides?: JsonValue;
}

export interface ResolvedRunDefinition {
  profile: RunRecord["profile"];
  compiledConfigHash: Sha256Digest;
  /** Exact lifecycle catalog compiled from the same configuration and persisted with the run. */
  /** Optional only for compatibility compiler seams admitted before lifecycle authority. */
  lifecycleCatalog?: CompiledStateMachineCatalog;
  runTypeId: string;
  /** Canonical values after the compiler applies typed defaults and exact intake validation. */
  objective: string;
  intake: ConfigurationObject;
  /** Bounded executable behavior persisted before the first Git effect. */
  behavior: RunBehaviorSnapshot;
  /** Exactly one managed persona, resolved and pinned before any run artifact is committed. */
  workingSpecOwnerId: string;
  /** Whether this run type requires a model planning pass before approval. */
  planningMode: "agent" | "direct";
  pipelineStageIds: string[];
  pipelineStages: RunPipelineStageDefinition[];
  executionConfig: RunExecutionConfig;
  artifactWrites?: readonly TransactionWrite[];
}

export type RunPipelineStageDefinition = RunPipelineStageRecord;

export interface PreparedManagedAttempt {
  spec: AgentLaunchSpec;
  /** Test/compatibility seam. Production attempts use the authority plan below. */
  tools?: readonly AuthorityBackedTool[];
  authorityGrant?: AuthorityGrant;
  toolNames?: readonly KoniToolName[];
  terminalOutputSchema?: TSchema;
  /** Test/compatibility seam. Production providers are authority-owned below. */
  contextProvider?: KoniContextProvider;
  contextContent?: string;
  compactionSnapshot?: KoniCompactionSnapshot;
  factory?: ManagedPiSessionFactory;
  artifactWrites?: readonly TransactionWrite[];
}

export interface PlanningCompilation {
  plan: RunPlanRecord;
  graphHash?: Sha256Digest;
  graphRevision?: number;
  tickets?: Record<string, TicketRecord>;
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
}

export interface PendingPlanningCheckpoint {
  revision: number;
  terminalOutputSha256: Sha256Digest;
  compilation: PlanningCompilation;
}

export interface ApprovedPlanCompilation {
  graphHash: Sha256Digest;
  graphRevision: number;
  tickets: Record<string, TicketRecord>;
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
}

export interface TicketBoardCompilation {
  tickets: Record<string, TicketRecord>;
  /** Rule-derived identities that are applicable now, excluding retained started definitions. */
  applicableTicketIds?: readonly string[];
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
}

export interface AssignmentCompilation {
  outcome: { status: "completed"; summary: string } | { status: "failed"; blocker: string };
  graphHash?: Sha256Digest;
  graphRevision?: number;
  tickets?: Record<string, TicketRecord>;
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
  /** Authenticated predicate evidence rebound across a proven non-interfering graph transition. */
  ruleAuthorityEvidence?: JsonValue | null;
  /** Compiler-authored typed change-control transaction, never inferred from summary prose. */
  changeControl?: RuntimeAssignmentChangeControlCompilation;
}

export type RuntimeAssignmentChangeControlCompilation =
  | Readonly<{
      protocol: "koni.assignment-change-control.v1";
      kind: "upstream_request";
      sourceTicketId: string;
      sourceStepId: string;
      sourceBindingSha256: Sha256Digest;
      sourceOutputSha256: Sha256Digest;
      targetNodeIds: readonly string[];
      fulfillment: "planned_asset_repair" | "dynamic_scope_change";
      summary: string;
      reason: string;
      publication: ChangeControlPublication;
      sha256: Sha256Digest;
    }>
  | Readonly<{
      protocol: "koni.assignment-change-control.v1";
      kind: "proposal_application";
      configurationSha256: Sha256Digest;
      catalogSha256: Sha256Digest;
      proposalBindingSha256: Sha256Digest;
      applicationBinding: ExecutionPolicyBinding;
      proposalOutputSha256: Sha256Digest;
      proposalTicketId: string;
      proposalStepId: string;
      applicationPublicOperation: string;
      applicationOperationId: string;
      targetNodeIds: readonly string[];
      summary: string;
      scope: Readonly<{
        readNodeIds: readonly string[];
        writeNodeIds: readonly string[];
        readPaths: readonly string[];
        writePaths: readonly string[];
      }>;
      sha256: Sha256Digest;
    }>;

export interface VerificationCompilation {
  ok: boolean;
  reason?: string;
  /** Exact compiler projection when verification discovers newly applicable work. */
  tickets?: Record<string, TicketRecord>;
  /** Exact derived ticket identities whose predicates still hold at this verification epoch. */
  applicableTicketIds?: readonly string[];
  report?: RunReportRecord;
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
}

export interface AgentToolCompilation {
  summary: string;
  value?: JsonValue;
  graphHash?: Sha256Digest;
  graphRevision?: number;
  tickets?: Record<string, TicketRecord>;
  activity?: RunActivityRecord[];
  artifactWrites?: readonly TransactionWrite[];
}

export interface ResolvedAgentCheckCommand {
  checkId: string;
  /** Exact composite-member identity; absent for standalone and legacy command checks. */
  memberNodeId?: string;
  /** Exact source paths derived for that member; absent outside semantic composite checks. */
  memberSourcePaths?: readonly string[];
  definitionHash: Sha256Digest;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  effect: "read_only" | "workspace_write";
  networkAccess: boolean;
  environment: { inherit: string[]; set: Record<string, string> };
  expectedExitCodes: number[];
  allowNonpassingReceipt: boolean;
  receiptType: string;
  resultProtocol?: string;
  requiredResultFields: string[];
  resultSchema?: JsonValue;
  resultSource: { kind: "stdout" } | { kind: "file"; path: string };
  outputArtifactSelector?: {
    field: string;
    allowPathStrings: boolean;
    pathField: string;
  };
  inputPaths: string[];
  outputPaths: string[];
  /** Exact child-check policy; absent only on legacy compiler plans. */
  executionPolicy?: CheckExecutionPolicyBinding;
}

/**
 * One compiler-resolved validation request. Composite checks retain one public check identity while
 * expanding to an ordered set of command leaves; graph-only checks intentionally have no commands.
 */
export interface ResolvedAgentCheck {
  protocol: "koni.resolved-agent-check.v1";
  requestedCheckId: string;
  definitionHash: Sha256Digest;
  kind: "command" | "graph" | "composite";
  commands: ResolvedAgentCheckCommand[];
  /** Absent only for explicit pre-execution-semantics compatibility programs. */
  executionPolicy?: ResolvedCheckExecutionPolicyBinding;
}

export type ResolvedGateAutoEvaluationContextBinding = GateAutoEvaluationContextBinding;
export type ResolvedCheckExecutionPolicyBinding = CheckExecutionPolicyBinding;

export interface AgentCheckExecution {
  checkId: string;
  definitionHash: Sha256Digest;
  /** Final process attempt selected after compiler-bound retry handling. */
  attemptNumber?: number;
  /** Hash of the complete durable retry audit supplied to the final compiler pass. */
  retryAuditSha256?: Sha256Digest;
  startedAt: string;
  completedAt: string;
  resolvedExecutable: string;
  argv: string[];
  environmentSha256: Sha256Digest;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutSha256: Sha256Digest;
  stdoutSizeBytes: number;
  stderrSha256: Sha256Digest;
  stderrSizeBytes: number;
  preManifestSha256: Sha256Digest;
  postManifestSha256: Sha256Digest;
  sandboxKind: string;
  sandboxProfileSha256: Sha256Digest;
  /** Exact authority-startup authenticated sandbox bytes used for this execution. */
  sandboxExecutableSha256?: Sha256Digest;
  resultSource: {
    kind: "stdout" | "file";
    path?: string;
    bytesSha256: Sha256Digest;
    sizeBytes: number;
    value: JsonValue;
  };
  outputFiles: Array<{ path: string; sha256: Sha256Digest; sizeBytes: number }>;
}

export interface RuntimeAssignmentTerminalPolicyRetainedReceipt {
  readonly runCheckId: string;
  readonly attemptId: string;
  readonly stepId: string;
  readonly requestedCheckId: string;
  readonly commandIndex: number;
  readonly checkId: string;
  readonly executionPolicy: CheckExecutionPolicyBinding;
  readonly accepted: boolean;
  readonly passed: boolean;
}

export interface RuntimeAssignmentTerminalPolicySourceCommand {
  readonly stepId: string;
  readonly checkId: string;
  readonly memberNodeId: string;
  readonly commandBindingSha256: Sha256Digest;
  readonly sourcePaths: readonly string[];
}

export interface RuntimeAssignmentTerminalPolicySourceManifestPair {
  readonly memberNodeId: string;
  readonly current: RuntimeAssignmentTerminalPolicySourceCommand;
  readonly source: RuntimeAssignmentTerminalPolicySourceCommand;
  readonly retainedSourceReceipts: readonly RuntimeAssignmentTerminalPolicyRetainedReceipt[];
  readonly sha256: Sha256Digest;
}

export interface RuntimeAssignmentTerminalValidationCheckPolicy {
  readonly checkId: string;
  readonly checkSha256: Sha256Digest;
  readonly receiptType: string;
  readonly receiptFreshness: "current" | "historical";
  readonly resolvedCheck: ResolvedAgentCheck;
  readonly causalResolvedCheckSha256: Sha256Digest;
  readonly causalCommands: readonly ResolvedAgentCheckCommand[];
  readonly retainedLeafPolicies: readonly Readonly<{
    commandIndex: number;
    checkId: string;
    executionPolicy: CheckExecutionPolicyBinding;
  }>[];
  readonly replaySelection: ComposedReplaySelection;
}

export interface RuntimeAssignmentTerminalPolicyProjection {
  readonly protocol: "koni.assignment-terminal-policy.v1";
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly catalog: CompiledExecutionSemanticCatalog;
  readonly executionPolicyBinding: ExecutionPolicyBinding;
  readonly validationCheckIds: readonly string[];
  readonly requiredReceiptTypes: readonly string[];
  readonly preserveSourcePathsFrom?: string;
  readonly validationChecks: readonly RuntimeAssignmentTerminalValidationCheckPolicy[];
  readonly composedReplayCheckIds: readonly string[];
  readonly retainedReceipts: readonly RuntimeAssignmentTerminalPolicyRetainedReceipt[];
  readonly sourceManifestPairs: readonly RuntimeAssignmentTerminalPolicySourceManifestPair[];
  readonly sha256: Sha256Digest;
}

export interface RuntimeAssignmentTerminalReplayCompilation {
  readonly protocol: "koni.assignment-terminal-replay.v1";
  readonly projectionSha256: Sha256Digest;
  readonly accepted: boolean;
  readonly passed: boolean;
  /** Whether this replay may settle its assignment; honours per-check `allow_nonpassing_receipt`. */
  readonly terminalSatisfied?: boolean;
  readonly checks: readonly Readonly<{
    checkId: string;
    kind?: string;
    accepted: boolean;
    passed: boolean;
    replayedLeafCheckIds: readonly string[];
    retainedLeafCheckIds: readonly string[];
  }>[];
  readonly evidence: JsonValue;
  readonly sha256: Sha256Digest;
}

export interface PreparedAssignmentTerminalPolicy {
  readonly projection: RuntimeAssignmentTerminalPolicyProjection;
  readonly executions: readonly Readonly<{
    checkId: string;
    executions: readonly AgentCheckExecution[];
  }>[];
  readonly retryAudits: readonly RunCheckAttemptRecord[];
  /** Compiler-authenticated receipts that exist before terminal output is interpreted. */
  readonly compilerReceipts: readonly CompilerTerminalReceiptAuthority[];
  readonly artifactWrites: readonly TransactionWrite[];
}

export interface CompilerTerminalReceiptAuthority {
  readonly protocol: "koni.compiler-terminal-receipt.v1";
  readonly source: "launch_context" | "configured_action" | "direct_compilation";
  readonly receipt: ExecutionPolicyReceiptEvidence;
  readonly provenance: JsonValue;
  readonly sha256: Sha256Digest;
}

export interface AssignmentTerminalPolicySettlement {
  readonly record: AgentTerminalPolicyRecord;
  readonly artifactWrites: readonly TransactionWrite[];
}

export interface PreparedOutcomeTerminalPolicy {
  readonly prepared: PreparedAssignmentTerminalPolicy | undefined;
  readonly workspace: string;
}

export interface CompiledAgentCheckResult extends AgentToolCompilation {
  accepted: boolean;
  passed: boolean;
  /** Setup/toolchain failure that prevented the configured subject from producing evidence. */
  infrastructureFailure?: string;
  evidence: JsonValue;
  /** Complete authenticated evidence envelope to use for the next compiler pass. */
  ruleAuthorityEvidence?: JsonValue;
}

export interface RunCompilerProgram {
  /** Future-run launch options projected from the current effective configuration. */
  controlCatalog?(): Promise<ControlCatalog>;
  /** Bounded cockpit projection from the exact configuration artifact pinned by this run. */
  projectCockpitCatalog?(run: RunRecord): Promise<CompiledCockpitViewCatalog>;
  /** Exact lifecycle projection for guarded compatibility hydration of an admitted run. */
  projectStateMachineCatalog?(run: RunRecord): Promise<CompiledStateMachineCatalog>;
  /** Exact operation/workflow/check catalog from the run's pinned configuration artifact. */
  projectExecutionSemanticCatalog?(run: RunRecord): Promise<CompiledExecutionSemanticCatalog>;
  resolveRun(request: RunCreationRequest): Promise<ResolvedRunDefinition>;
  /** Build the reviewable root-only plan for a run type with no planning stage. */
  initializeDirectApproval(run: RunRecord): Promise<PlanningCompilation>;
  prepareAttempt(input: {
    kind: "planning" | "lead" | "ticket" | "verification" | "integration";
    run: RunRecord;
    assignment?: ReadyAssignment;
    leadTrigger?: LeadJudgmentTrigger;
    attemptId: string;
    sessionId: string;
    nextAuthorityRevision: number;
    expectedAuthorityStateHash: Sha256Digest;
    lineage: AgentAttemptLineage;
  }): Promise<PreparedManagedAttempt>;
  preparePlanningRevision?(input: {
    run: RunRecord;
    attemptId: string;
    sessionId: string;
    nextAuthorityRevision: number;
    expectedAuthorityStateHash: Sha256Digest;
    steering?: string;
  }): Promise<PreparedManagedAttempt>;
  recoverAttempt?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
  }): Promise<PreparedManagedAttempt>;
  selectDynamicGraphContext?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
  }): Promise<import("../graph/context-selector.js").SelectedDynamicGraphContext>;
  refreshCompactionSnapshot?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
  }): Promise<KoniCompactionSnapshot>;
  compilePlanningOutput(input: {
    run: RunRecord;
    attemptId: string;
    output: unknown;
  }): Promise<PlanningCompilation>;
  compilePlanningRevision?(input: {
    run: RunRecord;
    attemptId: string;
    revision: number;
    patch: unknown;
  }): Promise<PlanningCompilation>;
  compileLeadJudgmentOutput?(input: {
    run: RunRecord;
    attemptId: string;
    output: unknown;
  }): Promise<LeadJudgmentOutput>;
  initializeApprovedPlan(run: RunRecord): Promise<ApprovedPlanCompilation>;
  /** Reproject the current graph's deterministic board at an explicit paused/blocked boundary. */
  reconcileTicketBoard?(run: RunRecord): Promise<TicketBoardCompilation>;
  compileAssignmentOutput(input: {
    run: RunRecord;
    assignment: ReadyAssignment;
    attemptId: string;
    output: unknown;
  }): Promise<AssignmentCompilation>;
  projectChangeControlProposalTicket?(input: {
    run: RunRecord;
    changeControl: Extract<RuntimeAssignmentChangeControlCompilation, { kind: "upstream_request" }>;
    sourceTerminalProof: import("../state/run-record.js").TerminalSuccessSettlementProof;
  }): Promise<TicketRecord | undefined>;
  projectApprovedApplicationTicket?(input: {
    run: RunRecord;
    materialization: ApprovedChangeMaterialization;
    selection: Extract<RuntimeAssignmentChangeControlCompilation, { kind: "proposal_application" }>;
  }): Promise<TicketRecord | undefined>;
  projectTerminalResolverTicket?(input: {
    run: RunRecord;
    reconciliation: TerminalResolverReconciliation;
    sourceFailureProof: import("../state/run-record.js").TerminalFailureSettlementProof;
  }): Promise<TicketRecord | undefined>;
  /** Project the exact pipeline pinned into this durable run; never consult future overlay bytes. */
  projectPipeline?(run: RunRecord): Promise<readonly RunPipelineStageDefinition[]>;
  /** Whether this pinned run type contains a compiler-configured independent model review. */
  requiresVerificationAttempt?(run: RunRecord): Promise<boolean>;
  /** Compile the immutable independent-review terminal output without granting graph mutation. */
  compileVerificationOutput?(input: {
    run: RunRecord;
    attemptId: string;
    output: unknown;
  }): Promise<AssignmentCompilation>;
  verifyRun(run: RunRecord): Promise<VerificationCompilation>;
  createIntegrationTicket(input: {
    run: RunRecord;
    conflictReport: string;
    targetOid: string;
  }): Promise<TicketRecord>;
  /** Pure/compiler-owned actions for graph context, notes, and profile-specific tools. */
  executeAgentTool?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    grant: AuthorityGrant;
    spec?: Readonly<AgentLaunchSpec>;
    call: KoniToolInvocation;
  }): Promise<AgentToolCompilation>;
  projectGraph?(
    run: RunRecord,
    ticketId?: string,
  ): Promise<{
    nodes: GraphNode[];
    edges: GraphEdge[];
  }>;
  resolveAgentCheck?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    checkId: string;
  }): Promise<ResolvedAgentCheck>;
  compileAgentCheckResult?(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    check: ResolvedAgentCheck;
    executions: AgentCheckExecution[];
  }): Promise<CompiledAgentCheckResult>;
  /** Exact compiler projection for behavior-backed terminal receipt/replay closure. */
  projectAssignmentTerminalPolicy?(input: {
    run: RunRecord;
    assignment: ReadyAssignment;
    attemptId: string;
  }): Promise<RuntimeAssignmentTerminalPolicyProjection>;
  /** Compile replay-only leaves plus exact authenticated retained receipt occurrences. */
  compileAssignmentTerminalReplay?(input: {
    run: RunRecord;
    assignment: ReadyAssignment;
    attemptId: string;
    projectionSha256: Sha256Digest;
    executions: readonly Readonly<{
      checkId: string;
      executions: readonly AgentCheckExecution[];
    }>[];
    retainedReceipts: readonly RuntimeAssignmentTerminalPolicyRetainedReceipt[];
  }): Promise<RuntimeAssignmentTerminalReplayCompilation>;
}

export interface RunAuthorityEngineOptions {
  projectRoot: string;
  version: string;
  program: RunCompilerProgram;
  /** Explicit test seam; production defaults to one killable child process per attempt. */
  supervisor?: ManagedSessionSupervisor | PiAttemptProcessSupervisor;
  /**
   * Provider-free release evidence may hold an admitted production child before activation.
   * Production authorities always leave this enabled.
   */
  activateProviderAttempts?: boolean;
  /** Exact executable-closure guard checked before any attempt is made durable or spawned. */
  runtimeGuard?: () => Promise<void>;
  /** Complete closure identity persisted into effect receipts for later audit. */
  runtimeClosureSha256?: Sha256Digest;
  /** Exact authority-startup authenticated Git bytes persisted into Git receipts. */
  gitExecutableSha256?: Sha256Digest;
  /** Exact authority-startup authenticated sandbox launcher. */
  sandboxExecutable?: RuntimeExecutableIdentity;
  /** Production daemon hook; invoked only after a successful quiesce response is flushed. */
  requestAuthorityShutdown?: () => void;
  git?: IsolatedGitLifecycle;
  /** Compatibility-only executor for proof-gated pre-isolation worktrees. */
  legacyGit?: LegacyRunGitExecutor;
  /** Current verified profile package root; reloaded per request so upgrades affect only future runs. */
  profilePackageRootLoader?: () => Promise<string>;
  now?: () => Date;
  /** Reconciliation cadence; shortened only by authority reconciliation tests. */
  reconcileIntervalMs?: number;
  /** Idle bound before a process-less attempt is a wedge; shortened only by those same tests. */
  attemptStallMs?: number;
  createId?: (kind: "run" | "attempt" | "session" | "question" | "activity") => string;
  /** Provider-free crash-boundary injection used only by authority durability tests. */
  effectFault?: (
    point: "after_prepare" | "after_apply",
    intent: Readonly<WorkspaceEffectIntentRecord>,
  ) => Promise<void> | void;
  /** Provider-free lifecycle race gates used only by authority durability tests. */
  lifecycleFault?: (
    point:
      | "before_ticket_cycle_open"
      | "before_run_materialization_settle"
      | "after_ticket_checkpoint"
      | "before_publication_settle"
      | "after_planned_asset_repair_route"
      | "before_proposal_policy_approval"
      | "after_verification",
    input: Readonly<{ runId: string; ticketId?: string }>,
  ) => Promise<void> | void;
  /** Provider-free fault injection at bounded action and attempt transition seams. */
  actionFault?: (
    point:
      | "before_journal"
      | "before_assignment_settle"
      | "before_attempt_finalize"
      | "before_lead_attempt_admission",
    input: Readonly<{
      runId: string;
      invocationId: string;
      journal?: ActionExecutionJournal;
      ticketId?: string;
      attemptId?: string;
    }>,
  ) => Promise<void> | void;
  /**
   * Maximum wall time for one durably reserved provider request before Koni asks the contained
   * session to abort it.  The default is deliberately generous; this seam exists so the
   * liveness boundary can be tested without shortening real research turns.
   */
  providerRequestLivenessTimeoutMs?: number;
  /** Test-only provider-liveness race gate. */
  providerLivenessFault?: (
    point: "after_live_question_resolution" | "before_liveness_abort_mutation",
    input: Readonly<{ runId: string; attemptId: string; reservationId: string }>,
  ) => Promise<void> | void;
}

/** Select the newest Lead judgment bound to the run's current semantic product. */
export function acceptedLeadJudgmentForRun(
  run: Readonly<RunRecord>,
  trigger: LeadJudgmentTrigger,
): Readonly<RunLeadJudgmentRecord> | undefined {
  const judgments = run.leadJudgments ?? [];
  for (let index = judgments.length - 1; index >= 0; index -= 1) {
    const judgment = judgments[index]!;
    if (
      judgment.trigger === trigger &&
      judgment.graphHash === run.graphHash &&
      judgment.runOid === run.git.run.headOid &&
      (trigger !== "compiler_deadlock" ||
        judgment.frontierSha256 === leadJudgmentFrontierSha256(run))
    ) {
      return judgment;
    }
  }
  // Integrating a ticket advances the run OID without changing the semantic graph. A proceeding
  // judgment on that graph remains authoritative, but an older graph's diagnosis never does.
  for (let index = judgments.length - 1; index >= 0; index -= 1) {
    const judgment = judgments[index]!;
    if (
      judgment.trigger === trigger &&
      judgment.graphHash === run.graphHash &&
      judgment.disposition === "proceed" &&
      (trigger !== "compiler_deadlock" ||
        judgment.frontierSha256 === leadJudgmentFrontierSha256(run))
    ) {
      return judgment;
    }
  }
  return undefined;
}

/** Retire only a blocked entry judgment whose missing executable authority was just restored. */
export function retireBlockedEntryJudgmentsAfterExecutableAuthorityChange(
  draft: RunRecord,
  previous: Readonly<RunRecord>,
): void {
  const remaining = (draft.leadJudgments ?? []).filter(
    (judgment) =>
      !(
        judgment.trigger === "orchestration_entry" &&
        judgment.disposition === "blocked" &&
        judgment.graphHash === previous.graphHash &&
        judgment.runOid === previous.git.run.headOid
      ),
  );
  if (remaining.length === 0) delete draft.leadJudgments;
  else draft.leadJudgments = remaining;
}

export function hasExactProposalApprovalInStatuses(
  run: Readonly<RunRecord>,
  statuses: ReadonlySet<TicketRecord["status"]>,
): boolean {
  return Object.values(run.tickets).some((ticket) => {
    const control = ticket.executionControl;
    return (
      statuses.has(ticket.status) &&
      control?.proposalDecision?.decision === "approval" &&
      control.proposalApprovalSha256 === control.proposalDecision.sha256
    );
  });
}

/** A queued proposal has exact operator authority before its agent-authored disposition exists. */
export function hasExactQueuedProposalApproval(run: Readonly<RunRecord>): boolean {
  return hasExactProposalApprovalInStatuses(run, new Set(["queued"]));
}

/** Exact operator authority remains live throughout the approved proposal workflow. */
export function hasExactActiveProposalApproval(run: Readonly<RunRecord>): boolean {
  return hasExactProposalApprovalInStatuses(run, new Set(["queued", "running", "review"]));
}

/** A materialized application retains the exact approved proposal authority until settlement. */
export function hasExactActiveApprovedApplication(run: Readonly<RunRecord>): boolean {
  const activeStatuses = new Set<TicketRecord["status"]>(["queued", "running", "review"]);
  return Object.values(run.tickets).some((application) => {
    const applicationControl = application.executionControl;
    if (
      !activeStatuses.has(application.status) ||
      applicationControl?.controlTicketAuthority?.role !== "approved_application" ||
      applicationControl.sourceProposalTicketId === undefined ||
      applicationControl.approvedApplicationSha256 === undefined
    ) {
      return false;
    }
    const proposal = run.tickets[applicationControl.sourceProposalTicketId];
    const proposalControl = proposal?.executionControl;
    const disposition = proposalControl?.proposalDisposition;
    return (
      proposal?.status === "completed" &&
      proposalControl?.approvedApplicationSha256 === applicationControl.approvedApplicationSha256 &&
      disposition?.kind === "application" &&
      disposition.applicationTicketId === application.id &&
      disposition.authoritySha256 === applicationControl.approvedApplicationSha256
    );
  });
}

/** Exact active change-control authority takes precedence over a new entry diagnosis. */
export function shouldBypassEntryLeadForExactActiveProposal(
  run: Readonly<RunRecord>,
  trigger: LeadJudgmentTrigger,
  accepted: Readonly<RunLeadJudgmentRecord> | undefined,
): boolean {
  return (
    trigger === "orchestration_entry" &&
    accepted === undefined &&
    (hasExactActiveProposalApproval(run) || hasExactActiveApprovedApplication(run))
  );
}

/** An assignment-validation action may replay only while its exact accepted assignment is live. */
export function isRecoverableAssignmentValidationAction(
  run: Readonly<RunRecord>,
  action: Readonly<RunActionExecutionRecord>,
): boolean {
  if (action.boundary.kind !== "assignment_validation") return false;
  const attemptId = action.boundary.attemptId;
  const ticketId = action.boundary.ticketId;
  const stepId = action.boundary.stepId;
  if (attemptId === undefined || ticketId === undefined || stepId === undefined) return false;
  const attempt = run.attempts[attemptId];
  const ticket = run.tickets[ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === stepId);
  return (
    attempt?.status === "terminal_accepted" &&
    ticket !== undefined &&
    attempt.ticketId === ticketId &&
    attempt.stepId === stepId &&
    attempt.ticketExecutionEpoch === ticket.executionEpoch &&
    action.boundary.cycleId === ticket.gitCycleId &&
    ticket.status === "running" &&
    step?.status === "running" &&
    step.attemptIds.includes(attemptId)
  );
}

/** Cancelled compiler work is terminally resolved and must not hold the run out of verification. */
export function ticketResolvedForVerification(ticket: Readonly<TicketRecord>): boolean {
  return ticket.status === "completed" || ticket.status === "cancelled";
}

export interface RunAdvancementToken {
  phase: RunPhase;
  lifecycleRevision: number;
  generation: number;
}

export interface LeadActionAdmission {
  invocationId: string;
  attemptId: string;
}

export interface TerminalFailureAuthority {
  stepId: string;
  attemptId: string;
  launchSpecHash: Sha256Digest;
  terminalPolicySha256: Sha256Digest;
  terminalOutputSha256: Sha256Digest;
  failureSettlementSha256: Sha256Digest;
  failureProof: import("../state/run-record.js").TerminalFailureSettlementProof;
  sha256: Sha256Digest;
}

export interface TerminalResolverRetryCandidate {
  catalog: CompiledExecutionSemanticCatalog;
  resolver: TicketRecord;
  source: TicketRecord;
  resolverFailure: TerminalFailureAuthority;
  sourceFailure: TerminalFailureAuthority;
  pendingRequest?: TerminalResolverRetryRequest;
}

export interface BehaviorPostOrchestrationPlan {
  targetSync: CompiledRunStage;
  checkpoint: CompiledRunStage;
  review?: CompiledRunStage;
  report: CompiledRunStage;
  reportAction: CompiledActionDefinition;
  promotion: CompiledRunStage;
}

export class RunAdvancementStoppedError extends Error {
  public constructor(public readonly startupCancellation = false) {
    super("run lifecycle changed while deterministic work was in flight");
    this.name = "RunAdvancementStoppedError";
  }
}

/**
 * Compiler-authoritative run coordinator. Models never select ready work or mutate lifecycle/Git;
 * they execute only immutable attempts issued here after deterministic compilation.
 */
