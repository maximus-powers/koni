import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type TSchema } from "typebox";
import {
  type CheckExecutionPolicyBinding,
  type ComposedReplaySelection,
  type ExecutionPolicyBinding,
} from "../authority/execution-policy.js";
import type { AuthorityGrant } from "../authority/grants.js";
import type { JsonValue } from "../authority/protocol.js";
import type {
  ResolvedAgentCheck,
  ResolvedAgentCheckCommand,
  ResolvedGateAutoEvaluationContextBinding,
} from "../authority/run-engine.js";
import { type LeadJudgmentTrigger } from "../contracts/behavior.js";
import type { CompiledConfiguration, ConfigurationObject } from "../contracts/configuration.js";
import type {
  CompiledRuleEvaluation,
  DerivedTicketDefinition,
  DerivedWorkflowStep,
} from "../contracts/rules.js";
import {
  type TypedGraph,
  type GraphContextualState,
  type GraphDelta,
  type GraphNode,
} from "../graph/model.js";
import { type PiResolvedInventory } from "../pi/agent-configuration.js";
import { type AgentLaunchSpec, type PlanningRevisionLaunchBinding } from "../pi/launch-spec.js";
import { type SealedPiModelBinding } from "../pi/model-catalog.js";
import { type Sha256Digest } from "../shared/canonical.js";
import { type AgentAttemptRecord, type RunRecord, type TicketRecord } from "../state/run-record.js";
import { type ReadyAssignment } from "../state/scheduler.js";
import { type RuleAuthorityEvidence } from "./domain-adapter.js";
import { type CompiledExecutionSemanticCatalog } from "./execution-semantics.js";
import { type PlanningArtifact } from "./planning-artifact.js";
import type { VerifiedProfileBaseline } from "./profile-package.js";

export const PINNED_CONFIGURATION_PROTOCOL = "koni.pinned-run-configuration.v1" as const;
export const GRAPH_ARTIFACT_PROTOCOL = "koni.run-graph.v1" as const;
export const TICKET_ARTIFACT_PROTOCOL = "koni.ticket-definitions.v1" as const;
export const PLAN_ARTIFACT_PROTOCOL = "koni.planning-compilation.v1" as const;
export const PLANNING_TERMINAL_INSTRUCTION =
  "Submission is a tool protocol, not prose. Submit the required planning payload through koni_submit_output in the same turn after assembling it. Plain assistant text is not a planning submission and will be discarded.";
export const LEGACY_GRAPH_NOTE_PROTOCOL = "koni.graph-note.v1" as const;
export const PI_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const MAX_PLAN_CHARS = 24_000;
export const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
export const MAX_LAUNCH_SPEC_BYTES = 16 * 1024 * 1024;
export const MAX_REVIEW_EXECUTION_EVIDENCE_BYTES = 2 * 1024 * 1024;
export const MAX_REVIEW_CHECK_STREAM_BYTES = 1024 * 1024;
export const MAX_HISTORICAL_PREPARATION_EVIDENCE_BYTES = 512 * 1024;
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_PINNED_SKILL_BYTES = 3 * 1024 * 1024;
export const MAX_SKILL_FILES = 128;
export const ATTEMPT_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
export const MAX_GRAPH_CONTEXT_BYTES = 2 * 1024 * 1024;
export const MAX_GRAPH_NOTES = 4_096;
export const MAX_WORKING_SPEC_BYTES = 1024 * 1024;
export const MAX_BASELINE_SPEC_BYTES = 8 * 1024 * 1024;
export const MAX_RUN_GRAPH_BYTES = 64 * 1024 * 1024;

export interface PinnedSkillFile {
  relativePath: string;
  content: string;
  sha256: Sha256Digest;
  sizeBytes: number;
}

export interface PinnedSkill {
  id: string;
  files: Record<string, PinnedSkillFile>;
}

export interface PinnedConfigurationMaterial {
  protocol: typeof PINNED_CONFIGURATION_PROTOCOL;
  runId: string;
  configuration: CompiledConfiguration;
  skills: Record<string, PinnedSkill>;
  /** Pi-native resources selected for each schema-3 Koni agent at run creation. */
  piAgents?: Record<
    string,
    Readonly<{
      skillIds: readonly string[];
      context: readonly string[];
      configurationSha256: Sha256Digest;
    }>
  >;
}

export interface PinnedConfigurationArtifact extends PinnedConfigurationMaterial {
  artifactSha256: Sha256Digest;
}

export interface GraphArtifact {
  protocol: typeof GRAPH_ARTIFACT_PROTOCOL;
  runId: string;
  /** Semantic revision; retained under its legacy field name for read compatibility. */
  revision: number;
  /** Explicit aliases are emitted by contextual-era artifacts; absent on legacy artifacts. */
  semanticRevision?: number;
  configurationSha256: Sha256Digest;
  /** Semantic graph hash only. Context records have an independent hash below. */
  graphSha256: Sha256Digest;
  semanticSha256?: Sha256Digest;
  nodes: Record<string, GraphNode>;
  /** Absent on legacy graph artifacts and synthesized read-only until the next contextual write. */
  contextual?: GraphContextualState;
  contextualRevision?: number;
  contextualSha256?: Sha256Digest;
}

export interface TicketDefinitionsArtifact {
  protocol: typeof TICKET_ARTIFACT_PROTOCOL;
  runId: string;
  graphRevision: number;
  evaluation: CompiledRuleEvaluation;
  /**
   * Definitions whose rules ceased to apply after an accepted graph mutation, but whose durable
   * tickets have not yet finished validation and Git integration. They remain compiler authority
   * for those already-issued workflows; they are never treated as newly applicable tickets.
   */
  retainedDefinitions?: DerivedTicketDefinition[];
}

export interface PreparedAttemptArtifact {
  protocol: "koni.prepared-attempt.v1";
  specHash: Sha256Digest;
  grant: AuthorityGrant;
  contextHash: Sha256Digest;
  contextContent: string;
  terminalSchemaHash: Sha256Digest;
}

export interface ProofPreparationReviewCandidate {
  ticket: TicketRecord;
  step: TicketRecord["steps"][number];
  attempt: AgentAttemptRecord;
  attemptOrder: number;
}

export interface AuthenticatedReviewSnapshot {
  definition: DerivedTicketDefinition;
  step: DerivedWorkflowStep;
  reviewedNodes: readonly GraphNode[];
  context: Record<string, unknown>;
}

export interface AuthenticatedProofPreparationCurrent {
  snapshot: AuthenticatedReviewSnapshot;
  reviewedSubject: GraphNode;
  sourceManifest: ConfigurationObject;
  baselineStep: DerivedWorkflowStep;
  baselinePredecessor: ConfigurationObject;
  baselineCheck: ConfigurationObject;
  currentVia: "preparation_review" | "review_effect_successor";
}

export interface RuleEvaluationOptions {
  /** The one terminal-accepted review whose compiler-owned effect is being evaluated pre-persist. */
  selfPreparationReviewAttemptId?: string;
  /** Override the approved run checkout when evaluating a pre-approval planning graph. */
  projectRoot?: string;
}

export interface GraphNoteArtifact {
  protocol: typeof LEGACY_GRAPH_NOTE_PROTOCOL;
  id: string;
  runId: string;
  ticketId: string;
  stepId: string;
  attemptId: string;
  personaId: string;
  nodeId: string;
  kind: "observation" | "implementation_detail" | "rationale" | "nit" | "open_question";
  body: string;
  status: "working";
  supersedes?: string;
  graphSha256: Sha256Digest;
  nodeSha256: Sha256Digest;
  contextSha256: Sha256Digest;
  launchSpecSha256: Sha256Digest;
  recordedAt: string;
}

export type PlanningOutput = PlanningArtifact;

export interface AssignmentOutput {
  status: "completed" | "failed";
  reviewVerdict?: "approved" | "rejected" | "changes_requested";
  summary?: string;
  blocker?: string;
  graphDelta?: GraphDelta | null;
  upstreamChangeRequest?: AssignmentUpstreamChangeRequest;
  changeApplication?: AssignmentChangeApplication;
}

export interface AssignmentUpstreamChangeRequest {
  targetNodeIds: string[];
  fulfillment: "planned_asset_repair" | "dynamic_scope_change";
  summary: string;
  reason: string;
}

export interface AssignmentChangeApplication {
  operation: string;
  targetNodeIds: string[];
  summary: string;
}

export interface AssignmentChangeControlContract {
  role: "ordinary" | "proposal" | "application" | "disposition";
  allowUpstreamRequest: boolean;
  requireChangeApplication: boolean;
}

export interface AttemptDescriptor {
  ticketId: string;
  stepId: string;
  personaId: string;
  readPaths: string[];
  writePaths: string[];
  readNodeIds: string[];
  writeNodeIds: string[];
  graphMutation: "allowed" | "forbidden" | "required";
  initialPrompt: string;
  context: Record<string, unknown>;
  terminalSchema: TSchema;
  /** Exact operation/workflow/step semantics re-derived from this run's pinned configuration. */
  executionPolicyBinding?: ExecutionPolicyBinding;
  /** Exact auto-evaluation gate contexts whose read paths extend this attempt's grant. */
  gatePolicyContexts?: readonly ResolvedGateAutoEvaluationContextBinding[];
  definition?: DerivedTicketDefinition;
  step?: DerivedWorkflowStep;
  graph?: TypedGraph;
  /** Lead judgments receive only their compiler-bound context, question, and terminal tools. */
  toolProfile?: "lead_judgment";
}

export interface AttemptDescriptorInput {
  kind: "planning" | "lead" | "ticket" | "verification" | "integration";
  run: RunRecord;
  assignment?: ReadyAssignment;
  leadTrigger?: LeadJudgmentTrigger;
  planningRevision?: PlanningRevisionPreparationContext;
}

export interface PlanningRevisionPreparationContext {
  binding: PlanningRevisionLaunchBinding;
  currentArtifact?: PlanningArtifact;
  steering?: string;
}

export interface PrepareAttemptInput extends AttemptDescriptorInput {
  attemptId: string;
  sessionId: string;
  nextAuthorityRevision: number;
  expectedAuthorityStateHash: Sha256Digest;
  lineage: AgentLaunchSpec["lineage"];
}

export interface AssignmentTerminalPolicyRetainedReceipt {
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

export interface AssignmentTerminalPolicySourceCommand {
  readonly stepId: string;
  readonly checkId: string;
  readonly memberNodeId: string;
  readonly commandBindingSha256: Sha256Digest;
  readonly sourcePaths: readonly string[];
}

export interface AssignmentTerminalPolicySourceManifestPair {
  readonly memberNodeId: string;
  readonly current: AssignmentTerminalPolicySourceCommand;
  readonly source: AssignmentTerminalPolicySourceCommand;
  readonly retainedSourceReceipts: readonly AssignmentTerminalPolicyRetainedReceipt[];
  readonly sha256: Sha256Digest;
}

export interface AssignmentTerminalValidationCheckPolicy {
  readonly checkId: string;
  readonly checkSha256: Sha256Digest;
  readonly receiptType: string;
  readonly receiptFreshness: "current" | "historical";
  /** Replay-only plan. Historical, opted-out, and side-effecting causal leaves are excluded. */
  readonly resolvedCheck: ResolvedAgentCheck;
  readonly causalResolvedCheckSha256: Sha256Digest;
  /** Audit/source-pairing material only; the runtime must never execute this causal command list as replay. */
  readonly causalCommands: readonly ResolvedAgentCheckCommand[];
  readonly retainedLeafPolicies: readonly Readonly<{
    commandIndex: number;
    checkId: string;
    executionPolicy: CheckExecutionPolicyBinding;
  }>[];
  readonly replaySelection: ComposedReplaySelection;
}

/**
 * Exact terminal-closure projection for one admitted assignment. The runtime consumes this object
 * instead of reopening workflow/check YAML or inferring semantic policy from ticket presentation.
 */
export interface AssignmentTerminalPolicyProjection {
  readonly protocol: "koni.assignment-terminal-policy.v1";
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly catalog: CompiledExecutionSemanticCatalog;
  readonly executionPolicyBinding: ExecutionPolicyBinding;
  readonly validationCheckIds: readonly string[];
  readonly requiredReceiptTypes: readonly string[];
  readonly preserveSourcePathsFrom?: string;
  readonly validationChecks: readonly AssignmentTerminalValidationCheckPolicy[];
  readonly composedReplayCheckIds: readonly string[];
  readonly retainedReceipts: readonly AssignmentTerminalPolicyRetainedReceipt[];
  readonly sourceManifestPairs: readonly AssignmentTerminalPolicySourceManifestPair[];
  readonly sha256: Sha256Digest;
}

export interface AssignmentTerminalReplayCompilation {
  readonly protocol: "koni.assignment-terminal-replay.v1";
  readonly projectionSha256: Sha256Digest;
  readonly accepted: boolean;
  readonly passed: boolean;
  readonly checks: readonly Readonly<{
    checkId: string;
    accepted: boolean;
    passed: boolean;
    replayedLeafCheckIds: readonly string[];
    retainedLeafCheckIds: readonly string[];
  }>[];
  readonly evidence: JsonValue;
  readonly sha256: Sha256Digest;
}

export interface NativeRunCompilerProgramOptions {
  projectRoot: string;
  packageBaseline: VerifiedProfileBaseline;
  /** Re-resolve the verified installed-package cache for future runs without touching pinned runs. */
  packageBaselineLoader?: () => Promise<VerifiedProfileBaseline>;
  /** Resolve Pi's ordinary repository inventory without installing or importing resources. */
  piInventoryLoader?: () => Promise<PiResolvedInventory>;
  /** Provider-free tests may inject a deterministic seal; production reads Pi's offline catalog. */
  sealedModelBindingLoader?: (provider: string, modelId: string) => Promise<SealedPiModelBinding>;
  now?: () => Date;
  /**
   * Supplies authenticated, snapshot-bound assertions for receipt/review/command predicates.
   * Local graph, gate-selection, and contained-filesystem predicates never consume assertions.
   */
  ruleAuthorityEvidence?: (
    request: NativeRuleAuthorityEvidenceRequest,
  ) => Promise<RuleAuthorityEvidence | undefined>;
}

export interface NativeRuleAuthorityEvidenceRequest {
  run: Readonly<RunRecord>;
  configuration: Readonly<CompiledConfiguration>;
  inputGraphSha256: Sha256Digest;
  graphNodes: readonly Readonly<GraphNode>[];
}

export class NativeRunProgramError extends Error {
  public readonly code: string;
  public readonly details: readonly string[];

  public constructor(code: string, message: string, details: readonly string[] = []) {
    super(details.length === 0 ? message : `${message}\n${details.join("\n")}`);
    this.name = "NativeRunProgramError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Pure TypeScript implementation of the compiler-facing run program.
 *
 * It consumes only an authenticated package baseline plus the project overlay, freezes that
 * result into the run transaction, and thereafter derives every model attempt from that immutable
 * snapshot. Effects and durable recovery ownership stay in RunAuthorityEngine.
 */
