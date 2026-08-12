import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { readStableDurableFile } from "../authority/durable-file-read.js";
import { snapshotContainedPaths } from "../authority/process-runner.js";
import type { AuthorityGrant } from "../authority/grants.js";
import { discoverAuthorityEndpoint } from "../authority/endpoint.js";
import type { TransactionWrite } from "../authority/file-journal.js";
import type {
  ApprovedPlanCompilation,
  AgentCheckExecution,
  AgentToolCompilation,
  AssignmentCompilation,
  CompiledAgentCheckResult,
  PlanningCompilation,
  PreparedManagedAttempt,
  ResolvedAgentCheck,
  ResolvedAgentCheckCommand,
  ResolvedCheckExecutionPolicyBinding,
  ResolvedGateAutoEvaluationContextBinding,
  ResolvedRunDefinition,
  RuntimeAssignmentChangeControlCompilation,
  RunCompilerProgram,
  RunCreationRequest,
  RunPipelineStageDefinition,
  TicketBoardCompilation,
  VerificationCompilation,
} from "../authority/run-engine.js";
import type { JsonValue } from "../authority/protocol.js";
import type {
  ControlCatalog,
  ControlRoleDefault,
  ControlStageOption,
} from "../control-center/protocol.js";
import {
  projectCompiledCockpitViewCatalog,
  type CompiledCockpitViewCatalog,
} from "../control-center/cockpit-config.js";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import {
  LEAD_JUDGMENT_OUTPUT_PROTOCOL,
  type CompiledBehaviorIr,
  type CompiledLeadJudgmentBehavior,
  type CompiledRunStage,
  type CompiledRunTypeBehavior,
  type LeadJudgmentTrigger,
  type LeadJudgmentOutput,
} from "../contracts/behavior.js";
import type {
  CompilerGraphNode,
  CompiledGatePolicyContext,
  CompiledRuleEvaluation,
  CompiledStateMachineCatalog,
  DerivedTicketDefinition,
  DerivedWorkflowStep,
} from "../contracts/rules.js";
import {
  assertOperationGraphMutationPolicy,
  resolveExecutionPolicyBinding,
  selectComposedReplayChecks,
  type CheckExecutionPolicyBinding,
  type ComposedReplaySelection,
  type ExecutionPolicyBinding,
  type MaterializedNodeChange,
} from "../authority/execution-policy.js";
import { validateConfiguredGraphConstraints } from "./graph-constraints.js";
import {
  TicketDependencyProjectionError,
  deriveCompilerTicketDependencies,
  type RetainedTicketDependencyProjection,
} from "./ticket-dependencies.js";
import {
  GRAPH_CHANGE_NOTE_PROTOCOL,
  WORKING_SPEC_PROTOCOL,
  GraphSchema,
  GraphValidationError,
  TypedGraph,
  createGraphContextualState,
  sealGraphContextualState,
  validateGraphContextualState,
  workingSpecDigest,
  type ContextualRecordProvenance,
  type GraphChangeNoteRecord,
  type GraphCompilerFieldSource,
  type GraphContextualLink,
  type GraphContextualRecord,
  type GraphContextualState,
  type GraphDelta,
  type GraphEdge,
  type GraphFieldDefinition,
  type GraphNode,
  type GraphNodeTypeDefinition,
  type WorkingSpecBaseline,
  type WorkingSpecVersionRecord,
} from "../graph/model.js";
import {
  DynamicGraphContextSelector,
  type DynamicGraphSelectionRequest,
  type SelectedDynamicGraphContext,
} from "../graph/context-selector.js";
import type { KoniCompactionSnapshot } from "../pi/compaction.js";
import {
  AGENT_LAUNCH_SPEC_PROTOCOL,
  computeLaunchResourceSetHash,
  createAgentLaunchSpec,
  validateAgentLaunchSpec,
  type AgentLaunchSpec,
  type LaunchResource,
  type PlanningRevisionLaunchBinding,
} from "../pi/launch-spec.js";
import { loadSealedPiModelBinding, type SealedPiModelBinding } from "../pi/model-catalog.js";
import {
  loadPiResolvedInventory,
  piAgentCatalogFromCompiledConfiguration,
  resolvePiAgentConfiguration,
  type PiResolvedInventory,
  type ResolvedPiAgentConfiguration,
} from "../pi/agent-configuration.js";
import {
  KONI_TOOL_NAMES,
  isSupportedKoniToolSchemaHash,
  koniToolMaxResultBytes,
  koniToolSchemaHash,
  validateKoniToolReceipt,
  type KoniToolInvocation,
  type KoniToolName,
} from "../pi/tool-catalog.js";
import {
  canonicalEncode,
  canonicalHash,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  createProjectPathAuthority,
  normalizeProjectRelativePath,
} from "../shared/project-path-authority.js";
import type { CompilerDiagnostic, ValidationResult } from "../shared/diagnostics.js";
import {
  createRunBehaviorSnapshot,
  type RunBehaviorSnapshot,
  type AgentAttemptRecord,
  type AttemptStatus,
  type RunActivityRecord,
  type RunPlanRecord,
  type RunCheckRecord,
  type RunRecord,
  type TicketRecord,
  type TicketExecutionControlRecord,
  type TerminalFailureSettlementProof,
  type TerminalSuccessSettlementProof,
  type ControlTicketCausalAuthority,
  type ControlTicketRole,
  createCompilerControlTicketAuthority,
  configuredCheckInfrastructureFailureForAttempt,
  ticketImmutableProjection,
  terminalFailureBindingFromProof,
} from "../state/run-record.js";
import { semanticQuestionPolicy } from "../state/question-policy.js";
import {
  COMPILER_INAPPLICABLE_TICKET,
  COMPILER_ROUTED_TO_MANIFEST_GATE_RECHECK,
  COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR,
  COMPILER_SUPERSEDED_BEFORE_EXECUTION,
  reviewReworkAppliesToStep,
  ticketDependencySettled,
  type ReadyAssignment,
} from "../state/scheduler.js";
import {
  deriveChangeControlPublication,
  type ApprovedChangeMaterialization,
  type ExistingChangeControlProposal,
  type TerminalResolverReconciliation,
} from "../state/change-control.js";
import type { VerifiedProfileBaseline } from "./profile-package.js";
import { projectGatePolicyDefinitions, projectGraphSchemaDefinition } from "./graph-schema.js";
import { GraphExpressionEvaluator, type RuleDomainAdapter } from "./expressions.js";
import { compileProjectDirectory } from "./project-directory.js";
import {
  PLAN_DOMAINS,
  PlanningArtifactValidationError,
  applyPlanningArtifactPatch,
  parsePlanningArtifact,
  parsePlanningArtifactPatch,
  parsePlanningFullPlans,
  parsePlanningGraphSeed,
  type PlanDomain,
  type PlanningArtifact,
  type PlanningGraphSeed,
} from "./planning-artifact.js";
import {
  effectiveOrchestrationPolicy,
  normalizeRunIntake,
  parseLeadJudgmentOutput,
  resolveRunBehavior,
} from "./behavior.js";
import {
  assertHistoricalBehaviorMatchesRun,
  projectHistoricalCompiledBehavior,
} from "./historical-behavior.js";
import { resolveCompiledAgent, resolveCompiledRunType } from "./resolution.js";
import {
  compileStateMachineCatalog,
  evaluateConfiguredRules,
  expandPythonPackageReadPaths,
} from "./rules.js";
import {
  compileExecutionSemanticCatalog,
  type CompiledChangeControl,
  type CompiledExecutionSemanticCatalog,
  type CompiledWorkflowStepSemantics,
} from "./execution-semantics.js";
import { compileConfiguredReports, type PreparedReportArtifact } from "./reports.js";
import {
  RULE_AUTHORITY_EVIDENCE_PROTOCOL,
  createPolicySelectionRuleDomainAdapter,
  createProductionRuleDomainAdapter,
  createRuleAuthorityEvidence,
  prepareFilesystemManifestAcceptance,
  ruleInputGraphSha256,
  rulePredicateBindingNames,
  rulePredicateEvidenceKey,
  type RuleAuthorityEvidence,
  type RulePredicateEvidence,
} from "./domain-adapter.js";

const PINNED_CONFIGURATION_PROTOCOL = "koni.pinned-run-configuration.v1" as const;
const GRAPH_ARTIFACT_PROTOCOL = "koni.run-graph.v1" as const;
const TICKET_ARTIFACT_PROTOCOL = "koni.ticket-definitions.v1" as const;
const PLAN_ARTIFACT_PROTOCOL = "koni.planning-compilation.v1" as const;
const PLANNING_TERMINAL_INSTRUCTION =
  "Submission is a tool protocol, not prose. Submit the required planning payload through koni_submit_output in the same turn after assembling it. Plain assistant text is not a planning submission and will be discarded.";
const LEGACY_GRAPH_NOTE_PROTOCOL = "koni.graph-note.v1" as const;
const PI_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const MAX_PLAN_CHARS = 24_000;
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const MAX_LAUNCH_SPEC_BYTES = 16 * 1024 * 1024;
const MAX_REVIEW_EXECUTION_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_REVIEW_CHECK_STREAM_BYTES = 1024 * 1024;
const MAX_HISTORICAL_PREPARATION_EVIDENCE_BYTES = 512 * 1024;
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_PINNED_SKILL_BYTES = 3 * 1024 * 1024;
const MAX_SKILL_FILES = 128;
const ATTEMPT_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_GRAPH_CONTEXT_BYTES = 2 * 1024 * 1024;
const MAX_GRAPH_NOTES = 4_096;
const MAX_WORKING_SPEC_BYTES = 1024 * 1024;
const MAX_BASELINE_SPEC_BYTES = 8 * 1024 * 1024;
const MAX_RUN_GRAPH_BYTES = 64 * 1024 * 1024;

interface PinnedSkillFile {
  relativePath: string;
  content: string;
  sha256: Sha256Digest;
  sizeBytes: number;
}

interface PinnedSkill {
  id: string;
  files: Record<string, PinnedSkillFile>;
}

interface PinnedConfigurationMaterial {
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

interface PinnedConfigurationArtifact extends PinnedConfigurationMaterial {
  artifactSha256: Sha256Digest;
}

interface GraphArtifact {
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

interface TicketDefinitionsArtifact {
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

interface PreparedAttemptArtifact {
  protocol: "koni.prepared-attempt.v1";
  specHash: Sha256Digest;
  grant: AuthorityGrant;
  contextHash: Sha256Digest;
  contextContent: string;
  terminalSchemaHash: Sha256Digest;
}

interface ProofPreparationReviewCandidate {
  ticket: TicketRecord;
  step: TicketRecord["steps"][number];
  attempt: AgentAttemptRecord;
  attemptOrder: number;
}

interface AuthenticatedReviewSnapshot {
  definition: DerivedTicketDefinition;
  step: DerivedWorkflowStep;
  reviewedNodes: readonly GraphNode[];
  context: Record<string, unknown>;
}

interface AuthenticatedProofPreparationCurrent {
  snapshot: AuthenticatedReviewSnapshot;
  reviewedSubject: GraphNode;
  sourceManifest: ConfigurationObject;
  baselineStep: DerivedWorkflowStep;
  baselinePredecessor: ConfigurationObject;
  baselineCheck: ConfigurationObject;
  currentVia: "preparation_review" | "review_effect_successor";
}

interface RuleEvaluationOptions {
  /** The one terminal-accepted review whose compiler-owned effect is being evaluated pre-persist. */
  selfPreparationReviewAttemptId?: string;
  /** Override the approved run checkout when evaluating a pre-approval planning graph. */
  projectRoot?: string;
}

interface GraphNoteArtifact {
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

type PlanningOutput = PlanningArtifact;

interface AssignmentOutput {
  status: "completed" | "failed";
  reviewVerdict?: "approved" | "rejected" | "changes_requested";
  summary?: string;
  blocker?: string;
  graphDelta?: GraphDelta | null;
  upstreamChangeRequest?: AssignmentUpstreamChangeRequest;
  changeApplication?: AssignmentChangeApplication;
}

interface AssignmentUpstreamChangeRequest {
  targetNodeIds: string[];
  fulfillment: "planned_asset_repair" | "dynamic_scope_change";
  summary: string;
  reason: string;
}

interface AssignmentChangeApplication {
  operation: string;
  targetNodeIds: string[];
  summary: string;
}

interface AssignmentChangeControlContract {
  role: "ordinary" | "proposal" | "application" | "disposition";
  allowUpstreamRequest: boolean;
  requireChangeApplication: boolean;
}

interface AttemptDescriptor {
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

interface AttemptDescriptorInput {
  kind: "planning" | "lead" | "ticket" | "verification" | "integration";
  run: RunRecord;
  assignment?: ReadyAssignment;
  leadTrigger?: LeadJudgmentTrigger;
  planningRevision?: PlanningRevisionPreparationContext;
}

interface PlanningRevisionPreparationContext {
  binding: PlanningRevisionLaunchBinding;
  currentArtifact?: PlanningArtifact;
  steering?: string;
}

interface PrepareAttemptInput extends AttemptDescriptorInput {
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
export class NativeRunCompilerProgram implements RunCompilerProgram {
  readonly #projectRoot: string;
  #packageBaseline: VerifiedProfileBaseline;
  readonly #packageBaselineLoader: (() => Promise<VerifiedProfileBaseline>) | undefined;
  readonly #piInventoryLoader: () => Promise<PiResolvedInventory>;
  readonly #sealedModelBindingLoader: (
    provider: string,
    modelId: string,
  ) => Promise<SealedPiModelBinding>;
  readonly #stateRoot: string;
  readonly #now: () => Date;
  readonly #ruleAuthorityEvidence: NativeRunCompilerProgramOptions["ruleAuthorityEvidence"];
  readonly #pinned = new Map<string, PinnedConfigurationArtifact>();
  readonly #issuedSpecs = new Map<string, Readonly<AgentLaunchSpec>>();
  readonly #dynamicContextSelector = new DynamicGraphContextSelector();

  private constructor(options: NativeRunCompilerProgramOptions, stateRoot: string) {
    this.#projectRoot = path.resolve(options.projectRoot);
    this.#packageBaseline = options.packageBaseline;
    this.#packageBaselineLoader = options.packageBaselineLoader;
    this.#piInventoryLoader =
      options.piInventoryLoader ??
      (() =>
        loadPiResolvedInventory({
          projectRoot: this.#projectRoot,
          installMissingPackages: process.env.NODE_ENV !== "test",
          skipMissingPackages: process.env.NODE_ENV === "test",
        }));
    this.#sealedModelBindingLoader =
      options.sealedModelBindingLoader ??
      ((provider, modelId) => loadSealedPiModelBinding(provider, modelId));
    this.#stateRoot = stateRoot;
    this.#now = options.now ?? (() => new Date());
    this.#ruleAuthorityEvidence = options.ruleAuthorityEvidence;
  }

  public static async create(
    options: NativeRunCompilerProgramOptions,
  ): Promise<NativeRunCompilerProgram> {
    const endpoint = await discoverAuthorityEndpoint(options.projectRoot);
    return new NativeRunCompilerProgram(options, endpoint.stateRoot);
  }

  public async controlCatalog(): Promise<ControlCatalog> {
    if (this.#packageBaselineLoader !== undefined) {
      this.#packageBaseline = await this.#packageBaselineLoader();
    }
    const compiled = requireValidation(
      await compileProjectDirectory(this.#projectRoot, this.#packageBaseline),
      "configuration_invalid",
      "project configuration did not compile",
    );
    const resolved = compiled.run_type_order.map((runTypeId) => {
      const behavior = compiled.behavior.runTypes[runTypeId];
      if (behavior === undefined)
        fail("run_type_invalid", `run type ${runTypeId} has no compiled behavior`);
      return behavior;
    });
    const stageOrder: string[] = [];
    const sharedStages = new Map<string, { title: string; kind: string }>();
    for (const runType of resolved) {
      for (const stage of runType.pipeline) {
        if (!sharedStages.has(stage.id)) {
          stageOrder.push(stage.id);
          sharedStages.set(stage.id, {
            title: stage.title,
            kind: stage.kind,
          });
        }
      }
    }
    return {
      protocol: "koni.control-catalog.v1",
      defaultRunTypeId: compiled.behavior.defaultRunTypeId,
      runTypes: resolved.map((runType) => {
        const included = new Map(runType.pipeline.map((stage) => [stage.id, stage] as const));
        const stages: ControlStageOption[] = stageOrder.map((stageId) => {
          const configured = included.get(stageId);
          const shared = sharedStages.get(stageId)!;
          return {
            id: stageId,
            title: configured?.title ?? shared.title,
            kind: configured?.kind ?? shared.kind,
            included: configured !== undefined,
          };
        });
        const roles: ControlRoleDefault[] = runType.roles.map((role) => ({ ...role }));
        return {
          id: runType.id,
          title: runType.title,
          description: runType.description,
          questionPolicy: runType.questions.presentation,
          questionDefaultScope: runType.questions.defaultScope,
          maxParallel: runType.maxParallel,
          startMode: runType.pipeline.some((stage) => stage.kind === "planning")
            ? "planning"
            : "work",
          objectiveFieldId: runType.objectiveFieldId,
          intake: runType.intake.map((field) => structuredClone(field)),
          autoStart: runType.autoStart,
          runCardSections: [...runType.runCardSections],
          stages,
          roles,
        };
      }),
    };
  }

  /** Project presentation only from the immutable configuration selected by this durable run. */
  public async projectCockpitCatalog(run: RunRecord): Promise<CompiledCockpitViewCatalog> {
    const pinned = await this.#loadPinned(run);
    return projectCompiledCockpitViewCatalog(pinned.configuration);
  }

  /** Re-derive the exact operation/workflow/check authority catalog for this durable run. */
  public async projectExecutionSemanticCatalog(
    run: RunRecord,
  ): Promise<CompiledExecutionSemanticCatalog> {
    const pinned = await this.#loadPinned(run);
    return requireExecutionSemanticCatalog(pinned.configuration);
  }

  public async projectAssignmentTerminalPolicy(input: {
    run: RunRecord;
    assignment: ReadyAssignment;
    attemptId: string;
  }): Promise<AssignmentTerminalPolicyProjection> {
    if (input.assignment.runId !== input.run.id) {
      fail("terminal_policy_run", "terminal policy assignment belongs to another run");
    }
    const attempt = input.run.attempts[input.attemptId];
    if (
      attempt === undefined ||
      attempt.ticketId !== input.assignment.ticketId ||
      attempt.stepId !== input.assignment.stepId ||
      attempt.personaId !== input.assignment.personaId
    ) {
      fail(
        "terminal_policy_attempt",
        "terminal policy attempt does not match its exact assignment",
      );
    }
    const pinned = await this.#loadPinned(input.run);
    const catalog = requireExecutionSemanticCatalog(pinned.configuration);
    const descriptor = await this.#descriptorForRecordedAttempt(
      input.run,
      attempt,
      pinned.configuration,
    );
    if (
      descriptor.step === undefined ||
      descriptor.definition === undefined ||
      descriptor.graph === undefined ||
      descriptor.executionPolicyBinding === undefined
    ) {
      fail(
        "terminal_policy_descriptor",
        "terminal policy requires one compiler-bound ticket workflow step",
      );
    }
    const stepSemantics = terminalStepSemantics(catalog, descriptor.executionPolicyBinding);
    if (
      canonicalHash(stepSemantics.validationChecks) !==
      canonicalHash(descriptor.step.validation_checks)
    ) {
      fail(
        "terminal_policy_checks",
        "durable workflow validation checks differ from pinned execution semantics",
      );
    }
    const validationChecks = await resolveTerminalValidationCheckPolicies({
      configuration: pinned.configuration,
      catalog,
      descriptor,
      projectRoot: attemptWorkspace(
        input.run,
        recordedAttemptWorkspaceKind(attempt),
        attempt.ticketId,
      ),
      checkIds: stepSemantics.validationChecks,
    });
    const composedReplayCheckIds = [
      ...new Set(validationChecks.flatMap((policy) => policy.replaySelection.replayCheckIds)),
    ].sort(compareText);
    const retainedReceipts = retainedTerminalReceipts(
      input.run,
      input.assignment.ticketId,
      validationChecks,
      input.attemptId,
    );
    let sourceManifestPairs: AssignmentTerminalPolicySourceManifestPair[] = [];
    if (stepSemantics.preserveSourcePathsFrom !== undefined) {
      const definitions = await this.#readTicketDefinitions(input.run, pinned.configuration);
      const sourceStep = descriptor.definition.workflow.find(
        (candidate) => candidate.id === stepSemantics.preserveSourcePathsFrom,
      );
      if (sourceStep === undefined) {
        fail(
          "terminal_policy_source_step",
          `workflow source-preservation step ${stepSemantics.preserveSourcePathsFrom} is unavailable`,
        );
      }
      const sourceDescriptor = ticketAttempt(
        input.run,
        descriptor.definition,
        sourceStep,
        descriptor.graph,
        pinned.configuration,
        catalog,
        definitions.value.evaluation.gate_policy_contexts,
      );
      if (sourceDescriptor.executionPolicyBinding === undefined) {
        fail(
          "terminal_policy_source_binding",
          "source-preservation step has no exact execution policy binding",
        );
      }
      const sourceSemantics = terminalStepSemantics(
        catalog,
        sourceDescriptor.executionPolicyBinding,
      );
      const sourceChecks = await resolveTerminalValidationCheckPolicies({
        configuration: pinned.configuration,
        catalog,
        descriptor: sourceDescriptor,
        projectRoot: attemptWorkspace(input.run, "ticket", input.assignment.ticketId),
        checkIds: sourceSemantics.validationChecks,
      });
      sourceManifestPairs = pairSourceManifestCommands({
        run: input.run,
        ticketId: input.assignment.ticketId,
        currentStepId: descriptor.step.id,
        sourceStepId: sourceStep.id,
        currentChecks: validationChecks,
        sourceChecks,
      });
    }
    const material = {
      protocol: "koni.assignment-terminal-policy.v1" as const,
      configurationSha256: catalog.configurationSha256,
      catalogSha256: catalog.sha256,
      catalog,
      executionPolicyBinding: structuredClone(descriptor.executionPolicyBinding),
      validationCheckIds: Object.freeze([...stepSemantics.validationChecks]),
      requiredReceiptTypes: Object.freeze([...stepSemantics.requiredReceipts]),
      ...(stepSemantics.preserveSourcePathsFrom === undefined
        ? {}
        : { preserveSourcePathsFrom: stepSemantics.preserveSourcePathsFrom }),
      validationChecks: Object.freeze(validationChecks),
      composedReplayCheckIds: Object.freeze(composedReplayCheckIds),
      retainedReceipts: Object.freeze(retainedReceipts),
      sourceManifestPairs: Object.freeze(sourceManifestPairs),
    };
    return deepFreeze({ ...material, sha256: canonicalHash(material) });
  }

  /**
   * Compile the replay-only terminal verification plan. Unlike `compileAgentCheckResult`, this
   * accepts only helper-selected replay leaves and exact durable receipts for every excluded
   * causal leaf; the ordinary agent check tool remains a causal, execute-all boundary.
   */
  public async compileAssignmentTerminalReplay(input: {
    run: RunRecord;
    assignment: ReadyAssignment;
    attemptId: string;
    projectionSha256: Sha256Digest;
    executions: readonly Readonly<{
      checkId: string;
      executions: readonly AgentCheckExecution[];
    }>[];
    retainedReceipts: readonly AssignmentTerminalPolicyRetainedReceipt[];
  }): Promise<AssignmentTerminalReplayCompilation> {
    const projection = await this.projectAssignmentTerminalPolicy({
      run: input.run,
      assignment: input.assignment,
      attemptId: input.attemptId,
    });
    if (projection.sha256 !== input.projectionSha256) {
      fail("terminal_replay_projection", "terminal replay projection changed before compilation");
    }
    const pinned = await this.#loadPinned(input.run);
    const attempt = input.run.attempts[input.attemptId]!;
    const descriptor = await this.#descriptorForRecordedAttempt(
      input.run,
      attempt,
      pinned.configuration,
    );
    if (descriptor.graph === undefined)
      fail("terminal_replay_graph", "terminal replay has no compiler-bound graph");
    const byCheck = new Map<string, readonly AgentCheckExecution[]>();
    for (const entry of input.executions) {
      if (byCheck.has(entry.checkId))
        fail("terminal_replay_duplicate", `duplicate terminal replay ${entry.checkId}`);
      byCheck.set(entry.checkId, entry.executions);
    }
    if (
      byCheck.size !== projection.validationChecks.length ||
      projection.validationChecks.some((policy) => !byCheck.has(policy.checkId))
    ) {
      fail(
        "terminal_replay_checks",
        "terminal replay executions do not match the exact validation check set",
      );
    }
    const candidateReceipts = new Map(
      projection.retainedReceipts.map((receipt) => [terminalRetainedReceiptKey(receipt), receipt]),
    );
    const selectedReceipts = new Map<string, AssignmentTerminalPolicyRetainedReceipt>();
    for (const receipt of input.retainedReceipts) {
      const key = terminalRetainedReceiptKey(receipt);
      const candidate = candidateReceipts.get(key);
      if (
        candidate === undefined ||
        canonicalHash(candidate) !== canonicalHash(receipt) ||
        selectedReceipts.has(key)
      ) {
        fail(
          "terminal_replay_receipt",
          `terminal replay retained receipt ${key} is stale, unknown, or duplicated`,
        );
      }
      selectedReceipts.set(key, receipt);
    }
    const unusedReceiptKeys = new Set(selectedReceipts.keys());
    const checkResults: Array<{
      checkId: string;
      kind: string;
      accepted: boolean;
      passed: boolean;
      replayedLeafCheckIds: string[];
      retainedLeafCheckIds: string[];
      commandEvidence: unknown[];
    }> = [];
    for (const policy of projection.validationChecks) {
      const executions = byCheck.get(policy.checkId)!;
      if (executions.length !== policy.resolvedCheck.commands.length) {
        fail(
          "terminal_replay_count",
          `terminal replay ${policy.checkId} expected ${policy.resolvedCheck.commands.length} executions, received ${executions.length}`,
        );
      }
      const compiled = policy.resolvedCheck.commands.map((command, index) =>
        compileCheckCommandExecution(
          command,
          executions[index]!,
          index,
          pinned.configuration,
          descriptor,
        ),
      );
      const retainedLeafCheckIds: string[] = [];
      for (const expected of policy.retainedLeafPolicies) {
        const match = [...selectedReceipts.entries()].find(
          ([key, receipt]) =>
            unusedReceiptKeys.has(key) &&
            receipt.checkId === expected.checkId &&
            canonicalHash(receipt.executionPolicy) === canonicalHash(expected.executionPolicy),
        );
        if (match === undefined) {
          fail(
            "terminal_replay_receipt_missing",
            `terminal replay ${policy.checkId} has no authenticated retained receipt for ${expected.checkId}`,
          );
        }
        unusedReceiptKeys.delete(match[0]);
        retainedLeafCheckIds.push(expected.checkId);
      }
      let passed = compiled.every((result) => result.passed);
      if (policy.resolvedCheck.kind === "graph") {
        passed = await evaluateRequestedGraphCheck(
          pinned.configuration,
          descriptor.graph,
          attemptWorkspace(input.run, recordedAttemptWorkspaceKind(attempt), attempt.ticketId),
          policy.checkId,
          descriptor.definition?.target_node_ids ?? descriptor.readNodeIds,
        );
      }
      checkResults.push({
        checkId: policy.checkId,
        kind: policy.resolvedCheck.kind,
        accepted: compiled.every((result) => result.accepted),
        passed,
        replayedLeafCheckIds: policy.resolvedCheck.commands.map((command) => command.checkId),
        retainedLeafCheckIds,
        commandEvidence: compiled.map((result) => result.evidence),
      });
    }
    if (unusedReceiptKeys.size > 0) {
      fail(
        "terminal_replay_receipt_extra",
        "terminal replay supplied retained receipts outside exact closure needs",
      );
    }
    const accepted = checkResults.every((result) => result.accepted);
    const passed = accepted && checkResults.every((result) => result.passed);
    // Whether this replay may settle its assignment. For a command check, `accepted` is already the
    // acceptance notion that honours the check's own `allow_nonpassing_receipt`: it equals `passed`
    // unless the check declares that a nonpassing verdict is still a valid receipt — which is
    // exactly what an `expected_red` research gate declares. A graph check has no commands, so its
    // `accepted` is vacuously true and only `passed`, computed by `evaluateRequestedGraphCheck`,
    // carries meaning; it must stay strict. Demanding `passed` for both made a correctly-red gate
    // unable to settle its ticket at all, which is the same inert-flag defect already fixed in
    // `assertCurrentAssignmentChecks` and reachable independently through this replay path.
    const terminalSatisfied = checkResults.every((result) =>
      result.kind === "graph" ? result.passed : result.accepted,
    );
    const evidence = {
      protocol: "koni.assignment-terminal-replay-evidence.v1",
      runId: input.run.id,
      ticketId: input.assignment.ticketId,
      stepId: input.assignment.stepId,
      attemptId: input.attemptId,
      projectionSha256: projection.sha256,
      accepted,
      passed,
      terminalSatisfied,
      checks: checkResults,
      retainedReceipts: input.retainedReceipts,
      recordedAt: this.#now().toISOString(),
    };
    const material = {
      protocol: "koni.assignment-terminal-replay.v1" as const,
      projectionSha256: projection.sha256,
      accepted,
      passed,
      terminalSatisfied,
      checks: Object.freeze(
        checkResults.map((result) =>
          deepFreeze({
            checkId: result.checkId,
            kind: result.kind,
            accepted: result.accepted,
            passed: result.passed,
            replayedLeafCheckIds: Object.freeze([...result.replayedLeafCheckIds]),
            retainedLeafCheckIds: Object.freeze([...result.retainedLeafCheckIds]),
          }),
        ),
      ),
      evidence: structuredClone(evidence) as unknown as JsonValue,
    };
    return deepFreeze({ ...material, sha256: canonicalHash(material) });
  }

  /** Re-derive the exact finite lifecycle catalog for this durable run. */
  public async projectStateMachineCatalog(run: RunRecord): Promise<CompiledStateMachineCatalog> {
    const pinned = await this.#loadPinned(run);
    return requireValidation(
      compileStateMachineCatalog(pinned.configuration),
      "state_machine_invalid",
      "pinned state-machine configuration did not compile",
    );
  }

  public async resolveRun(request: RunCreationRequest): Promise<ResolvedRunDefinition> {
    if (this.#packageBaselineLoader !== undefined) {
      this.#packageBaseline = await this.#packageBaselineLoader();
    }
    const compiled = requireValidation(
      await compileProjectDirectory(this.#projectRoot, this.#packageBaseline),
      "configuration_invalid",
      "project configuration did not compile",
    );
    const runType = requireValidation(
      resolveCompiledRunType(compiled, request.runTypeId),
      "run_type_invalid",
      `run type ${request.runTypeId} is not executable`,
    );
    const runBehavior = resolveRunBehavior(compiled, runType.id);
    const normalizedIntake = normalizeRunIntake(runBehavior, request.intake);
    if (request.objective.trim() !== normalizedIntake.objective) {
      fail(
        "objective_intake_mismatch",
        `objective must exactly match intake field ${runBehavior.objectiveFieldId}`,
      );
    }
    const behavior: RunBehaviorSnapshot = createRunBehaviorSnapshot(compiled.behavior, runType.id);
    const orchestration = effectiveOrchestrationPolicy(compiled.behavior.profile, runBehavior);
    const overrides = parseRunOverrides(request.overrides, compiled);
    const workingSpecOwnerId = resolveWorkingSpecOwner(
      compiled,
      runType.document,
      overrides.workingSpecOwner,
    );
    const pipelineStages = projectCompiledPipelineDefinition(runBehavior.pipeline);
    const planningMode = runBehavior.pipeline.some((stage) => stage.kind === "planning")
      ? "agent"
      : "direct";
    const agents: ResolvedRunDefinition["executionConfig"]["agents"] = Object.create(
      null,
    ) as ResolvedRunDefinition["executionConfig"]["agents"];
    for (const agentId of Object.keys(compiled.agents).sort(compareText)) {
      const agentDocument = compiled.agents[agentId]!.document;
      const koniPolicy = requiredRecord(agentDocument.koni, `agent ${agentId} Koni policy`);
      const roleId = optionalString(koniPolicy.role);
      const roleSelection = roleId === undefined ? undefined : overrides.roles[roleId];
      const personaSelection = overrides.agents[agentId];
      const selected = mergeAgentSelection(roleSelection, personaSelection);
      const persona = requireValidation(
        resolveCompiledAgent(compiled, agentId, {
          runTypeId: runType.id,
          ...(selected?.model === undefined ? {} : { model: selected.model }),
          ...(selected?.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: selected.thinkingLevel }),
        }),
        "persona_invalid",
        `agent ${agentId} is not executable`,
      );
      const provider = requiredPersonaProvider(selected?.provider ?? persona.provider, agentId);
      const model = requiredNonempty(persona.model, `agent ${agentId} model`);
      const thinkingLevel = requireThinkingLevel(persona.thinking_level, `agent ${agentId}`);
      agents[agentId] = { provider, model, thinkingLevel };
    }
    let piInventory: PiResolvedInventory;
    try {
      piInventory = await this.#piInventoryLoader();
    } catch (error) {
      fail(
        "pi_inventory",
        `Pi's resolved repository inventory could not be read without mutation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const piAgents = resolveRunPiAgents(compiled, piInventory);
    const skills = await pinPiResolvedSkills(piAgents);
    const pinned = createPinnedArtifact(request.runId, compiled, skills, piAgents);
    const lifecycleCatalog = requireValidation(
      compileStateMachineCatalog(compiled),
      "state_machine_invalid",
      "project lifecycle configuration did not compile",
    );
    this.#pinned.set(request.runId, pinned);
    const bytes = encodeArtifact(pinned);
    const questionPolicy = overrides.questionPolicy ?? runBehavior.questions.presentation;
    const semanticPolicy =
      overrides.questionPolicy === undefined
        ? runBehavior.questions.policy
        : semanticQuestionPolicy(overrides.questionPolicy);
    const runInstructions = [runBehavior.planningInstructions, overrides.instructions]
      .filter((item): item is string => item !== undefined && item.trim().length > 0)
      .join("\n\n");
    return {
      profile: {
        packageName: compiled.package.name,
        packageVersion: compiled.package.version,
        lineage: compiled.package.profile_lineage,
        bundleHash: compiled.baseline_bundle_sha256,
      },
      compiledConfigHash: compiled.configuration_sha256,
      runTypeId: runType.id,
      objective: normalizedIntake.objective,
      intake: normalizedIntake.values,
      behavior,
      lifecycleCatalog,
      workingSpecOwnerId,
      planningMode,
      pipelineStageIds: pipelineStages.map((stage) => stage.id),
      pipelineStages,
      executionConfig: {
        maxParallel: Math.min(
          overrides.maxParallel ?? runBehavior.maxParallel,
          compiled.behavior.profile.orchestration.maxParallel,
        ),
        disjointScopeParallelism: orchestration.disjointScopeParallelism,
        questionPolicy,
        semanticQuestionPolicy: semanticPolicy,
        questionDefaultScope: runBehavior.questions.defaultScope,
        instructions: runInstructions,
        agents,
      },
      artifactWrites: [
        {
          path: pinnedConfigurationPath(request.runId),
          bytes,
          expectedSha256: null,
        },
        {
          path: graphArtifactPath(request.runId),
          bytes: encodeRunGraphArtifact(
            initialGraphArtifact(request.runId, compiled, workingSpecOwnerId, this.#projectRoot),
          ),
          expectedSha256: null,
        },
      ],
    };
  }

  public async initializeDirectApproval(run: RunRecord): Promise<PlanningCompilation> {
    const pinned = await this.#loadPinned(run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const pipeline = pipelineDefinition(runType.document);
    if (
      pipeline.order.some(
        (id) => requiredRecord(pipeline.stages[id], `pipeline stage ${id}`).kind === "planning",
      )
    ) {
      fail(
        "direct_approval_planning_stage",
        "a run type with a planning stage cannot use direct approval",
      );
    }
    const graph = compileDirectInitialGraph(pinned.configuration, run, this.#projectRoot);
    const plan: RunPlanRecord = {
      revision: (run.plan?.revision ?? 0) + 1,
      status: "planning",
      full: {},
      concise: {},
      graphSeed: undefined,
      steeringHistory: structuredClone(run.plan?.steeringHistory ?? []),
    };
    const compiledArtifact = {
      protocol: PLAN_ARTIFACT_PROTOCOL,
      runId: run.id,
      directApproval: true,
      plan,
      graphSha256: graph.hash,
    };
    return {
      plan,
      graphHash: graph.hash,
      graphRevision: 0,
      activity: [compilerActivity(run, "Direct-approval root graph validated", "plan", "success")],
      artifactWrites: [
        {
          path: `runs/${run.id}/direct-approval.json`,
          bytes: encodeArtifact(compiledArtifact),
          expectedSha256: null,
        },
        {
          path: `runs/${run.id}/direct-approval-graph.json`,
          bytes: encodeRunGraphArtifact(graphArtifact(run, pinned.configuration, graph, 0)),
          expectedSha256: null,
        },
      ],
    };
  }

  public async prepareAttempt(input: PrepareAttemptInput): Promise<PreparedManagedAttempt> {
    if (input.planningRevision !== undefined) {
      fail(
        "planning_revision_authority",
        "planning revision context may only be issued by preparePlanningRevision",
      );
    }
    if (input.kind !== "planning" || input.run.planningSession === undefined) {
      return this.#prepareAttempt(input);
    }
    const session = input.run.planningSession;
    const revision = session.revisions[0];
    if (
      session.currentRevision !== 0 ||
      session.attemptId !== input.attemptId ||
      session.sessionId !== input.sessionId ||
      revision === undefined ||
      revision.revision !== 0 ||
      revision.status !== "running" ||
      Object.values(revision.budgetBaseline).some((value) => value !== 0)
    ) {
      fail(
        "planning_revision_identity",
        "initial continuous planning launch must bind revision zero to its stable attempt and session",
      );
    }
    return this.#prepareAttempt({
      ...input,
      planningRevision: {
        binding: {
          revision: 0,
          baseRevision: null,
          priorCheckpointSha256: null,
          steeringSha256: null,
          budgetBaseline: structuredClone(revision.budgetBaseline),
        },
      },
    });
  }

  public async preparePlanningRevision(input: {
    run: RunRecord;
    attemptId: string;
    sessionId: string;
    nextAuthorityRevision: number;
    expectedAuthorityStateHash: Sha256Digest;
    steering?: string;
  }): Promise<PreparedManagedAttempt> {
    const session = input.run.planningSession;
    if (
      session === undefined ||
      session.attemptId !== input.attemptId ||
      session.sessionId !== input.sessionId ||
      session.currentRevision < 1
    ) {
      fail(
        "planning_revision_identity",
        "planning revision must retain the authenticated planning attempt and Pi session",
      );
    }
    const attempt = input.run.attempts[input.attemptId];
    if (
      attempt === undefined ||
      attempt.kind !== "planning" ||
      attempt.sessionId !== input.sessionId
    ) {
      fail(
        "planning_revision_identity",
        "planning revision attempt metadata does not match the stable planning session",
      );
    }
    const revision = session.revisions[session.currentRevision];
    const base = session.revisions[session.currentRevision - 1];
    if (
      revision === undefined ||
      revision.revision !== session.currentRevision ||
      revision.status !== "running" ||
      revision.steering === undefined ||
      base === undefined ||
      base.revision !== revision.revision - 1 ||
      base.artifactSha256 === undefined ||
      base.checkpointPath === undefined
    ) {
      fail(
        "planning_revision_state",
        "planning revision does not name one contiguous validated base checkpoint and steering event",
      );
    }
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
    ] as const) {
      if (revision.budgetBaseline[field] > attempt[field]) {
        fail(
          "planning_revision_budget",
          `planning revision token baseline ${field} exceeds cumulative settled provider usage`,
        );
      }
    }
    const runRoot = path.resolve(this.#stateRoot, "runs", input.run.id);
    const artifactPath = path.resolve(this.#stateRoot, base.checkpointPath);
    const steeringPath = path.resolve(this.#stateRoot, revision.steering.artifactPath);
    for (const [label, candidate] of [
      ["checkpoint", artifactPath],
      ["steering", steeringPath],
    ] as const) {
      if (candidate !== runRoot && !candidate.startsWith(`${runRoot}${path.sep}`)) {
        fail("planning_revision_path", `planning revision ${label} path escapes its run root`);
      }
    }
    const artifactBytes = await readFile(artifactPath).catch(() => undefined);
    if (artifactBytes === undefined || artifactBytes.byteLength > MAX_CONTEXT_BYTES) {
      fail(
        "planning_revision_checkpoint",
        "planning revision base artifact is missing or oversized",
      );
    }
    let artifactValue: unknown;
    try {
      artifactValue = JSON.parse(artifactBytes.toString("utf8"));
    } catch {
      fail("planning_revision_checkpoint", "planning revision base artifact is malformed");
    }
    const currentArtifact = planningArtifactBoundary(() => parsePlanningArtifact(artifactValue));
    if (canonicalHash(currentArtifact) !== base.artifactSha256) {
      fail(
        "planning_revision_checkpoint",
        "planning revision base artifact does not match its validated checkpoint hash",
      );
    }
    const steeringBytes =
      input.steering === undefined
        ? await readFile(steeringPath).catch(() => undefined)
        : Buffer.from(input.steering, "utf8");
    if (
      steeringBytes === undefined ||
      steeringBytes.byteLength !== revision.steering.instructionsSizeBytes ||
      steeringBytes.byteLength > MAX_CONTEXT_BYTES ||
      rawSha256(steeringBytes) !== revision.steering.instructionsSha256
    ) {
      fail(
        "planning_revision_steering",
        "planning revision steering does not match its durable authenticated binding",
      );
    }
    const steering = steeringBytes.toString("utf8");
    if (steering.trim().length === 0 || steering.includes("\0")) {
      fail("planning_revision_steering", "planning revision steering is empty or unsafe");
    }
    const binding: PlanningRevisionLaunchBinding = {
      revision: revision.revision,
      baseRevision: base.revision,
      priorCheckpointSha256: base.artifactSha256,
      steeringSha256: revision.steering.instructionsSha256,
      budgetBaseline: structuredClone(revision.budgetBaseline),
    };
    return this.#prepareAttempt({
      kind: "planning",
      run: input.run,
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      nextAuthorityRevision: input.nextAuthorityRevision,
      expectedAuthorityStateHash: input.expectedAuthorityStateHash,
      lineage: { branchEpoch: 0, reason: "initial" },
      planningRevision: { binding, currentArtifact, steering },
    });
  }

  async #prepareAttempt(input: PrepareAttemptInput): Promise<PreparedManagedAttempt> {
    const pinned = await this.#loadPinned(input.run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, input.run.runTypeId),
      "run_type_invalid",
      `pinned run type ${input.run.runTypeId} is unavailable`,
    );
    const runBehavior = pinnedRunTypeBehavior(input.run, pinned.configuration);
    const descriptor = await this.#attemptDescriptor(input, pinned.configuration, runType.document);
    const parentAttempt =
      input.lineage.parentAttemptId === undefined
        ? undefined
        : input.run.attempts[input.lineage.parentAttemptId];
    const parentFailure = parentAttempt?.error?.slice(0, 400) ?? parentAttempt?.failureCode;
    const compensatedValidationFailures = activeCompensatedValidationFailures(
      input.run,
      input.assignment,
    );
    const initialPrompt = sameScopeContinuationPrompt(
      descriptor.initialPrompt,
      input.lineage,
      parentFailure,
      compensatedValidationFailures,
    );
    const persona = requireValidation(
      resolveCompiledAgent(pinned.configuration, descriptor.personaId, {
        runTypeId: input.run.runTypeId,
      }),
      "persona_invalid",
      `persona ${descriptor.personaId} is not executable`,
    );
    const selection = input.run.executionConfig?.agents[descriptor.personaId];
    const provider = requiredPersonaProvider(
      selection?.provider ?? persona.provider,
      descriptor.personaId,
    );
    const model = requiredNonempty(
      selection?.model ?? persona.model,
      `persona ${descriptor.personaId} model`,
    );
    const thinkingLevel = requireThinkingLevel(
      selection?.thinkingLevel ?? persona.thinking_level,
      `persona ${descriptor.personaId}`,
    );
    let modelBinding: SealedPiModelBinding;
    try {
      modelBinding = await this.#sealedModelBindingLoader(provider, model);
    } catch (error) {
      fail(
        "model_unavailable",
        error instanceof Error ? error.message : `Pi model ${provider}/${model} is unavailable`,
      );
    }
    assertCompilerModelBinding(modelBinding, provider, model);
    const configuredChecks = await this.#configuredCheckGrant(
      input.run,
      pinned.configuration,
      descriptor,
      persona.capabilities,
    );
    const resources = launchResources(
      pinned,
      pinned.piAgents?.[descriptor.personaId]?.skillIds ?? [],
      input.run.executionConfig?.instructions ?? "",
    );
    const toolNames = toolInventory(input.run, descriptor, resources);
    const contextContent = boundedContext(descriptor.context);
    const contextHash = rawSha256(contextContent);
    const authorityGrant: AuthorityGrant = {
      protocol: "koni.authority-grant.v1",
      grantId:
        input.planningRevision === undefined
          ? `grant-${input.attemptId}`
          : `grant-${input.attemptId}-planning-revision-${input.planningRevision.binding.revision}`,
      runId: input.run.id,
      ticketId: descriptor.ticketId,
      stepId: descriptor.stepId,
      attemptId: input.attemptId,
      sessionId: input.sessionId,
      epoch: input.run.lifecycle.revision + 1,
      generation: input.run.generation,
      allowedTools: toolNames,
      readPaths: descriptor.readPaths,
      writePaths: descriptor.writePaths,
      ...(configuredChecks === undefined ? {} : { configuredChecks }),
      expectedRevision: input.nextAuthorityRevision,
      expectedStateHash: input.expectedAuthorityStateHash,
    };
    const grantHash = canonicalHash(authorityGrant);
    const repositoryCallBudget = attemptRepositoryCallBudget(runBehavior, input.kind);
    const systemPrompt = [
      ...(pinned.piAgents?.[descriptor.personaId]?.context ?? []),
      persona.instructions.trim(),
      "You are executing one immutable compiler-issued Koni attempt. Use only the Koni tools present in this session. Never use ambient filesystem, shell, Git, network, extension, subagent, or lifecycle authority. The authority reissues your exact bound context before every provider request; observe and reuse it instead of refetching it through a tool. Stay inside the exact semantic and path grant, and finish with exactly one koni_submit_output call matching its schema.",
      renderPathGrant(descriptor.readPaths, descriptor.writePaths),
      "Your attempt is incomplete until koni_submit_output returns an accepted receipt. After the final check or edit, call it immediately as the only tool in that assistant turn. A plain final assistant message is discarded and fails the attempt.",
      "Reason briefly, then act: once you have decided the next tool call, emit it in the same turn instead of continuing to deliberate. A turn that spends its whole output budget on reasoning is cut off before any tool call and the entire turn is lost. Never re-derive a conclusion you already reached in an earlier turn.",
      "Read the koni_submit_output schema from its tool definition before calling it, and submit your real result on the first call. Never send placeholder, probing, or schema-discovery payloads: an accepted failed submission is terminal, cannot be retried, and permanently fails this assignment even if your actual work succeeded.",
      'Do the concrete work this step requires before you submit — author the proof, make the edit and run the check, or assemble and verify the candidate as the step demands; do not submit failed with little or no tool use. A failed submission is a genuine-impossibility last resort, and its blocker must be a specific self-contained diagnosis: the exact obstacle, what you tried, and why nothing within your grant can resolve it. An accepted failed submission is terminal and strands the whole run for operator recovery, so a terse or placeholder blocker (for example "test", "probe", "blocked") is never acceptable — never submit one.',
      ...implementationWriteGrantInstructions(
        descriptor.writePaths.length > 0,
        descriptor.step?.validation_checks.length ?? 0,
      ),
      ...(repositoryCallBudget === undefined
        ? []
        : [
            `Repository discovery is bounded to ${repositoryCallBudget} total koni_read_file, koni_list_files, and koni_search_files calls for this planning attempt. Reuse compiler context, prioritize high-value reads, and synthesize before the authority ceiling is exhausted.`,
            "Begin with the narrowest objective-derived source root (for example, the named app's src directory). Do not search `.` or broad monorepo/package roots when the objective identifies a narrower area; bounded broad scans can fail and still consume a discovery call.",
          ]),
    ].join("\n\n");
    const tokenBudget = attemptTokenBudget(runBehavior, input.kind, modelBinding.catalogMaxTokens);
    // Ticket-local review steps use the verification containment/persona class, but their
    // compiler assignment still belongs to the ticket cycle. Only the assignment-free final
    // reviewer reads the composed run checkout.
    const workspace = attemptWorkspace(
      input.run,
      input.kind === "verification" && input.assignment !== undefined ? "ticket" : input.kind,
      descriptor.ticketId,
    );
    const spec = createAgentLaunchSpec({
      protocol: AGENT_LAUNCH_SPEC_PROTOCOL,
      issuedAt: this.#now().toISOString(),
      identity: {
        runId: input.run.id,
        ticketId: descriptor.ticketId,
        stepId: descriptor.stepId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
      },
      lineage: structuredClone(input.lineage),
      ...(input.planningRevision === undefined
        ? {}
        : { planningRevision: structuredClone(input.planningRevision.binding) }),
      authority: {
        grantId: authorityGrant.grantId,
        grantHash,
        generation: authorityGrant.generation,
        epoch: authorityGrant.epoch,
        expectedRevision: authorityGrant.expectedRevision,
        expectedStateHash: input.expectedAuthorityStateHash,
        authoritativeContextHash: contextHash,
      },
      workspace: {
        cwd: workspace,
        sessionDirectory: path.join(
          this.#stateRoot,
          "runs",
          input.run.id,
          "sessions",
          input.attemptId,
        ),
      },
      persona: {
        id: descriptor.personaId,
        systemPrompt,
        systemPromptHash: rawSha256(systemPrompt),
        initialPrompt,
        initialPromptHash: rawSha256(initialPrompt),
      },
      model: {
        provider,
        id: model,
        api: modelBinding.api,
        catalogContextWindow: modelBinding.catalogContextWindow,
        catalogMaxTokens: modelBinding.catalogMaxTokens,
        catalogSha256: modelBinding.catalogSha256,
        thinkingLevel,
      },
      tools: toolNames.map((name) => ({
        name,
        schemaHash: koniToolSchemaHash(name, descriptor.terminalSchema),
        executionMode: toolExecutionMode(name),
        maxResultBytes: koniToolMaxResultBytes(name),
      })),
      resources: {
        setHash: computeLaunchResourceSetHash(resources),
        entries: resources,
      },
      budgets: {
        tokens: tokenBudget,
        // A failed provider response cannot be proven unbilled from Pi's transcript. Keep
        // contained attempts single-transport so one durable reservation never authorizes an
        // ambiguous automatic retry; workflow-level recovery remains compiler-visible.
        retries: { maxProviderRetries: 0, baseDelayMs: 0 },
        transcript: { maxBytes: ATTEMPT_TRANSCRIPT_MAX_BYTES },
        ...(repositoryCallBudget === undefined
          ? {}
          : {
              repositoryCalls: { max: repositoryCallBudget },
            }),
      },
      terminal: {
        toolName: "koni_submit_output",
        // The outcome contract binds the exact compiled union; the tool's advertised parameters
        // (tools[].schemaHash) bind the transport-flattened view. These are distinct hashes.
        outputSchemaHash: canonicalHash(descriptor.terminalSchema),
        maxOutputBytes: 4 * 1024 * 1024,
      },
    });
    const snapshot = compactionSnapshot(input.run, descriptor);
    const attemptArtifact: PreparedAttemptArtifact = {
      protocol: "koni.prepared-attempt.v1",
      specHash: spec.specHash,
      grant: authorityGrant,
      contextHash,
      contextContent,
      terminalSchemaHash: spec.terminal.outputSchemaHash,
    };
    this.#issuedSpecs.set(input.attemptId, spec);
    return {
      spec: spec,
      authorityGrant,
      toolNames,
      terminalOutputSchema: descriptor.terminalSchema,
      contextContent,
      compactionSnapshot: snapshot,
      artifactWrites: [
        {
          path:
            input.planningRevision === undefined
              ? `runs/${input.run.id}/attempts/${input.attemptId}/compiler-input.json`
              : `runs/${input.run.id}/attempts/${input.attemptId}/planning/revisions/${input.planningRevision.binding.revision}/compiler-input.json`,
          bytes: encodeArtifact(attemptArtifact),
          expectedSha256: null,
        },
      ],
    };
  }

  public async recoverAttempt(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
  }): Promise<PreparedManagedAttempt> {
    const { run, attempt, spec } = input;
    assertRecoveryIdentity(run, attempt, spec);
    const kind = recoveredAttemptKind(run, attempt);
    if (
      spec.workspace.cwd !==
        attemptWorkspace(run, recordedAttemptWorkspaceKind(attempt), attempt.ticketId) ||
      spec.workspace.sessionDirectory !==
        path.join(this.#stateRoot, "runs", run.id, "sessions", attempt.id) ||
      spec.authority.generation !== run.generation
    )
      fail(
        "recovery_workspace_drift",
        "stored launch workspace or generation no longer matches the run",
      );
    const pinned = await this.#loadPinned(run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const assignment =
      kind === "planning" || kind === "lead" || isRunWideVerificationAttempt(attempt)
        ? undefined
        : assignmentFromAttempt(run, attempt);
    const compilerInput = await this.#readPreparedAttemptArtifact(run, attempt, spec);
    const planningRevision =
      kind === "planning" && spec.planningRevision !== undefined
        ? recoveredPlanningRevisionContext(spec, compilerInput)
        : undefined;
    const descriptor = await this.#attemptDescriptor(
      {
        kind,
        run,
        ...(assignment === undefined ? {} : { assignment }),
        ...(kind === "lead" ? { leadTrigger: leadTriggerForAttempt(attempt) } : {}),
        ...(planningRevision === undefined ? {} : { planningRevision }),
      },
      pinned.configuration,
      runType.document,
    );
    if (
      descriptor.ticketId !== spec.identity.ticketId ||
      descriptor.stepId !== spec.identity.stepId ||
      descriptor.personaId !== spec.persona.id
    ) {
      fail(
        "recovery_assignment_drift",
        "stored launch identity no longer matches its pinned compiler assignment",
      );
    }

    const persona = requireValidation(
      resolveCompiledAgent(pinned.configuration, descriptor.personaId, {
        runTypeId: run.runTypeId,
      }),
      "persona_invalid",
      `persona ${descriptor.personaId} is not executable`,
    );
    const configuredChecks = await this.#configuredCheckGrant(
      run,
      pinned.configuration,
      descriptor,
      persona.capabilities,
    );
    const expectedResources = launchResources(
      pinned,
      pinned.piAgents?.[descriptor.personaId]?.skillIds ?? [],
      run.executionConfig?.instructions ?? "",
    );
    if (
      computeLaunchResourceSetHash(expectedResources) !== spec.resources.setHash ||
      canonicalHash(expectedResources) !== canonicalHash(spec.resources.entries)
    ) {
      fail(
        "recovery_resource_drift",
        "stored launch resources no longer match pinned compiler state",
      );
    }
    const compiledTools = toolInventory(run, descriptor, expectedResources);
    const storedTools = spec.tools.map((tool) => tool.name);
    // Contextual tools added after a launch was issued never rewrite a legacy launch inventory.
    const expectedTools =
      run.workingSpecOwnerId === undefined
        ? compiledTools.filter(
            (name) =>
              (name !== "koni_record_note" && name !== "koni_update_working_spec") ||
              storedTools.includes(name),
          )
        : compiledTools;
    if (
      JSON.stringify(storedTools) !== JSON.stringify(expectedTools) ||
      spec.terminal.toolName !== "koni_submit_output" ||
      spec.terminal.outputSchemaHash !== canonicalHash(descriptor.terminalSchema)
    ) {
      fail(
        "recovery_tool_drift",
        "stored launch tools or terminal contract no longer match pinned compiler state",
      );
    }
    for (const tool of spec.tools) {
      const name = requireKoniToolName(tool.name);
      if (
        !isSupportedKoniToolSchemaHash(name, tool.schemaHash, descriptor.terminalSchema) ||
        tool.executionMode !== toolExecutionMode(name) ||
        tool.maxResultBytes !== koniToolMaxResultBytes(name)
      )
        fail(
          "recovery_tool_drift",
          `stored tool binding ${tool.name} no longer matches its compiler contract`,
        );
    }

    if (rawSha256(compilerInput.contextContent) !== spec.authority.authoritativeContextHash)
      fail("recovery_context", "stored launch spec has no valid authoritative assignment context");
    const authorityGrant: AuthorityGrant = {
      protocol: "koni.authority-grant.v1",
      grantId: spec.authority.grantId,
      runId: run.id,
      ticketId: descriptor.ticketId,
      stepId: descriptor.stepId,
      attemptId: attempt.id,
      sessionId: attempt.sessionId,
      epoch: spec.authority.epoch,
      generation: spec.authority.generation,
      allowedTools: expectedTools,
      readPaths: descriptor.readPaths,
      writePaths: descriptor.writePaths,
      ...(configuredChecks === undefined ? {} : { configuredChecks }),
      expectedRevision: spec.authority.expectedRevision,
      expectedStateHash: spec.authority.expectedStateHash,
    };
    if (canonicalHash(authorityGrant) !== spec.authority.grantHash) {
      fail(
        "recovery_grant_drift",
        "stored launch authority no longer matches pinned compiler scope",
      );
    }
    this.#issuedSpecs.set(attempt.id, spec);
    return {
      spec,
      authorityGrant,
      toolNames: expectedTools,
      terminalOutputSchema: descriptor.terminalSchema,
      contextContent: compilerInput.contextContent,
      compactionSnapshot: compactionSnapshot(run, descriptor),
      artifactWrites: [],
    };
  }

  public async selectDynamicGraphContext(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
    request?: DynamicGraphSelectionRequest;
  }): Promise<SelectedDynamicGraphContext> {
    const { run, attempt, spec } = input;
    assertRecoveryIdentity(run, attempt, spec);
    const pinned = await this.#loadPinned(run);
    const descriptor = await this.#descriptorForRecordedAttempt(run, attempt, pinned.configuration);
    let graphRead: { graph: TypedGraph; artifact: GraphArtifact; bytesSha256: Sha256Digest };
    try {
      graphRead = await this.#readContextGraph(run, pinned.configuration);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Pre-contextual pinned planning attempts legitimately predate the canonical graph shell.
      const graph = new TypedGraph(requireGraphSchema(pinned.configuration), [], {
        projectRoot: this.#projectRoot,
      });
      assertConfiguredGraphConstraints(pinned.configuration, graph, this.#projectRoot);
      const artifact: GraphArtifact = {
        protocol: GRAPH_ARTIFACT_PROTOCOL,
        runId: run.id,
        revision: 0,
        configurationSha256: run.compiledConfigHash,
        graphSha256: graph.hash,
        nodes: graph.toJSON(),
      };
      graphRead = { graph, artifact, bytesSha256: rawSha256(encodeArtifact(artifact)) };
    }
    const attemptKind = recoveredAttemptKind(run, attempt);
    if (
      attemptKind !== "planning" &&
      (graphRead.artifact.revision !== run.graphRevision ||
        run.graphHash === undefined ||
        graphRead.graph.hash !== run.graphHash)
    ) {
      fail(
        "graph_artifact_drift",
        "dynamic context observed a semantic graph transaction in an incoherent state",
      );
    }
    const contextual = this.#contextualState(run, graphRead.artifact);
    const request = input.request;
    if (request?.anchors !== undefined) {
      const visible = new Set([...descriptor.readNodeIds, ...descriptor.writeNodeIds]);
      for (const anchor of request.anchors) {
        if (!visible.has(anchor) || graphRead.graph.node(anchor) === undefined) {
          fail(
            "graph_context_anchor",
            `graph context anchor ${anchor} is outside this step's compiler-visible scope`,
          );
        }
      }
    }
    if (request?.relations !== undefined) {
      const relations = new Set<string>();
      for (const edge of pinned.configuration.edge_types) {
        if (typeof edge.relation === "string") relations.add(edge.relation);
        if (edge.bidirectional === true && typeof edge.inverse === "string")
          relations.add(edge.inverse);
      }
      for (const relation of request.relations) {
        if (!relations.has(relation)) {
          // Enumerate the configured set: a guessed relation name otherwise costs a whole
          // provider turn to discover something the compiler already knows exactly.
          fail(
            "graph_context_relation",
            `unknown configured graph relation ${relation}; configured relations are ${[...relations].sort(compareText).join(", ")}`,
          );
        }
      }
    }
    if (request?.nodeTypes !== undefined) {
      for (const type of request.nodeTypes) {
        if (pinned.configuration.registries.node_types[type] === undefined) {
          fail(
            "graph_context_node_type",
            `unknown configured graph node type ${type}; configured node types are ${Object.keys(
              pinned.configuration.registries.node_types,
            )
              .sort(compareText)
              .join(", ")}`,
          );
        }
      }
    }
    const lineage = compatibleAttemptLineage(run, attempt);
    const { touchedFiles } = await this.#readAttemptReceiptContext(run, attempt, spec);
    const nodePaths = Object.fromEntries(
      graphRead.graph.nodes().map((node) => [node.id, graphRead.graph.repositoryPaths(node.id)]),
    );
    const ticket = run.tickets[attempt.ticketId];
    const approvedChangeReferencePaths = approvedChangeContextReferencePaths(
      run,
      ticket,
      graphRead.graph,
    );
    const cacheKey = canonicalHash({
      runId: run.id,
      generation: run.generation,
      semanticRevision: graphRead.artifact.revision,
      semanticHash: graphRead.graph.hash,
      contextualRevision: contextual.revision,
      contextualHash: contextual.hash,
    });
    return this.#dynamicContextSelector.select({
      cacheKey,
      identity: {
        runId: run.id,
        ticketId: attempt.ticketId,
        stepId: attempt.stepId,
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        personaId: attempt.personaId,
        grantHash: spec.authority.grantHash,
        launchSpecHash: spec.specHash,
        generation: spec.authority.generation,
      },
      objective: run.objective,
      runUpdatedAt: run.updatedAt,
      semanticRevision: graphRead.artifact.revision,
      semanticHash: graphRead.graph.hash,
      contextual,
      graph: graphRead.graph,
      arcs: dynamicRelationArcs(pinned.configuration, graphRead.graph),
      nodePaths,
      legacyNotes: await this.#readGraphNotes(run),
      ticketTargetIds: ticket?.targetNodeIds ?? descriptor.definition?.target_node_ids ?? [],
      stepTargetIds: [...new Set([...descriptor.writeNodeIds, ...descriptor.readNodeIds])].sort(
        compareText,
      ),
      scopedPaths: [
        ...new Set([
          ...descriptor.readPaths,
          ...descriptor.writePaths,
          ...approvedChangeReferencePaths,
        ]),
      ].sort(compareText),
      touchedPaths: touchedFiles,
      graphActivity: run.activity.map((activity) => ({
        at: activity.at,
        ...(activity.nodeId === undefined ? {} : { nodeId: activity.nodeId }),
      })),
      compatibleAttemptIds: lineage.compatible,
      abandonedAttemptIds: lineage.abandoned,
      maxInputTokens: spec.budgets.tokens.maxInput,
      ...(request === undefined ? {} : { request }),
    });
  }

  public dynamicContextCacheStats(): {
    selections: number;
    indexBuilds: number;
    cachedIndexes: number;
  } {
    return this.#dynamicContextSelector.stats();
  }

  public async refreshCompactionSnapshot(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    spec: Readonly<AgentLaunchSpec>;
  }): Promise<KoniCompactionSnapshot> {
    const { run, attempt, spec } = input;
    assertRecoveryIdentity(run, attempt, spec);
    const pinned = await this.#loadPinned(run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const kind = recoveredAttemptKind(run, attempt);
    const assignment =
      kind === "planning" || kind === "lead" || isRunWideVerificationAttempt(attempt)
        ? undefined
        : assignmentFromAttempt(run, attempt);
    const descriptor = await this.#attemptDescriptor(
      {
        kind,
        run,
        ...(assignment === undefined ? {} : { assignment }),
        ...(kind === "lead" ? { leadTrigger: leadTriggerForAttempt(attempt) } : {}),
      },
      pinned.configuration,
      runType.document,
    );
    const snapshot = compactionSnapshot(run, descriptor);
    const durable = await this.#readAttemptReceiptContext(run, attempt, spec);
    const dynamic = await this.selectDynamicGraphContext({ run, attempt, spec });
    snapshot.receiptIds = durable.receiptIds;
    snapshot.touchedFiles = durable.touchedFiles;
    snapshot.loadedResources = durable.loadedResources;
    snapshot.graphRefs = dynamic.envelope.selection.selected.map(
      (entry) => `${entry.id} (${entry.reason})`,
    );
    snapshot.dynamicGraphContext = {
      envelopeHash: dynamic.envelopeHash,
      semanticRevision: dynamic.envelope.binding.semanticRevision,
      semanticHash: dynamic.envelope.binding.semanticHash,
      contextualRevision: dynamic.envelope.binding.contextualRevision,
      contextualHash: dynamic.envelope.binding.contextualHash,
      selectedIds: dynamic.envelope.selection.selected.map((entry) => entry.id),
    };
    const workingSpec = dynamic.envelope.records.find((record) => record.kind === "working_spec");
    if (workingSpec?.kind === "working_spec") {
      snapshot.workingSpec = {
        id: workingSpec.id,
        version: workingSpec.value.version,
        digest: workingSpec.value.digest,
        guidance: workingSpec.value.guidance,
      };
    }
    return snapshot;
  }

  public async compilePlanningOutput(input: {
    run: RunRecord;
    attemptId: string;
    output: unknown;
  }): Promise<PlanningCompilation> {
    const pinned = await this.#loadPinned(input.run);
    const parsed = parsePlanningOutput(input.output);
    const planningWorkspace = attemptWorkspace(input.run, "planning", "run-planning");
    const graph = compilePlanningSeed(
      pinned.configuration,
      input.run,
      parsed.graphSeed,
      parsed.full,
      planningWorkspace,
    );
    const evaluation = requireValidation(
      await this.#evaluateRules(input.run, pinned.configuration, graph, {
        projectRoot: planningWorkspace,
      }),
      "rule_compilation_failed",
      "planning graph did not compile into a valid ticket board",
    );
    await assertPlanningRepositoryPaths(planningWorkspace, evaluation.tickets);
    const revision =
      input.run.planningSession === undefined
        ? (input.run.plan?.revision ?? 0) + 1
        : input.run.planningSession.currentRevision;
    const plan: RunPlanRecord = {
      revision,
      status: "planning",
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      full: parsed.full,
      concise: parsed.concise,
      graphSeed: structuredClone(parsed.graphSeed) as unknown as JsonValue,
      steeringHistory: structuredClone(input.run.plan?.steeringHistory ?? []),
    };
    const pendingGraphArtifact: GraphArtifact = graphArtifact(
      input.run,
      pinned.configuration,
      graph,
      0,
    );
    const compiledArtifact = {
      protocol: PLAN_ARTIFACT_PROTOCOL,
      runId: input.run.id,
      attemptId: input.attemptId,
      plan,
      graphSha256: graph.hash,
    };
    return {
      plan,
      graphHash: graph.hash,
      graphRevision: 0,
      activity: [
        compilerActivity(
          input.run,
          `Planning graph validated (${graph.nodes().length} nodes)`,
          "plan",
          "success",
        ),
      ],
      artifactWrites: [
        {
          path: `runs/${input.run.id}/attempts/${input.attemptId}/planning-output.json`,
          bytes: encodeArtifact(compiledArtifact),
          expectedSha256: null,
        },
        {
          path: `runs/${input.run.id}/attempts/${input.attemptId}/planning-graph.json`,
          bytes: encodeRunGraphArtifact(pendingGraphArtifact),
          expectedSha256: null,
        },
      ],
    };
  }

  public async compilePlanningRevision(input: {
    run: RunRecord;
    attemptId: string;
    revision: number;
    patch: unknown;
  }): Promise<PlanningCompilation> {
    const session = input.run.planningSession;
    if (
      session === undefined ||
      session.attemptId !== input.attemptId ||
      session.currentRevision !== input.revision ||
      input.revision < 1 ||
      session.revisions[input.revision]?.status !== "running"
    ) {
      fail(
        "planning_revision_identity",
        "planning revision output is not bound to the current stable planning session",
      );
    }
    const baseRevision = input.revision - 1;
    const baseRecord = session.revisions[baseRevision];
    if (
      baseRecord === undefined ||
      baseRecord.artifactSha256 === undefined ||
      baseRecord.checkpointPath === undefined ||
      !["awaiting_review", "superseded", "approved"].includes(baseRecord.status)
    ) {
      fail("planning_revision_base", "planning revision has no exact validated base checkpoint");
    }

    const runRoot = path.resolve(this.#stateRoot, "runs", input.run.id);
    const basePath = path.resolve(this.#stateRoot, baseRecord.checkpointPath);
    if (!basePath.startsWith(`${runRoot}${path.sep}`)) {
      fail("planning_revision_base", "planning revision checkpoint escapes the run artifact root");
    }
    let baseBytes: Buffer;
    try {
      baseBytes = await readStableDurableFile(basePath, {
        minimum: 1,
        maximum: MAX_CONTEXT_BYTES,
        label: `planning revision ${baseRevision} artifact`,
      });
    } catch (error) {
      fail(
        "planning_revision_base",
        `planning revision base checkpoint is not durably readable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let baseValue: unknown;
    try {
      baseValue = JSON.parse(baseBytes.toString("utf8"));
    } catch {
      fail("planning_revision_base", "planning revision base checkpoint is not valid JSON");
    }
    if (canonicalHash(baseValue) !== baseRecord.artifactSha256) {
      fail(
        "planning_revision_base",
        "planning revision base checkpoint differs from its immutable artifact hash",
      );
    }

    const pinned = await this.#loadPinned(input.run);
    const parsedPatch = planningArtifactBoundary(() => parsePlanningArtifactPatch(input.patch));
    const artifact = planningArtifactBoundary(() =>
      applyPlanningArtifactPatch(baseValue, parsedPatch, {
        baseRevision,
        protectedRootSpecFields: planningProtectedRootSpecFields(pinned.configuration),
      }),
    );
    const planningWorkspace = attemptWorkspace(input.run, "planning", "run-planning");
    const graph = compilePlanningSeed(
      pinned.configuration,
      input.run,
      artifact.graphSeed,
      artifact.full,
      planningWorkspace,
    );
    const evaluation = requireValidation(
      await this.#evaluateRules(input.run, pinned.configuration, graph, {
        projectRoot: planningWorkspace,
      }),
      "rule_compilation_failed",
      "planning revision graph did not compile into a valid ticket board",
    );
    await assertPlanningRepositoryPaths(planningWorkspace, evaluation.tickets);
    const plan: RunPlanRecord = {
      revision: input.revision,
      status: "planning",
      ...(artifact.title === undefined ? {} : { title: artifact.title }),
      full: artifact.full,
      concise: artifact.concise,
      graphSeed: structuredClone(artifact.graphSeed) as unknown as JsonValue,
      steeringHistory: structuredClone(input.run.plan?.steeringHistory ?? []),
    };
    const graphValue = graphArtifact(input.run, pinned.configuration, graph, 0);
    const prefix = `runs/${input.run.id}/attempts/${input.attemptId}/planning/revisions/${input.revision}`;
    const patchSha256 = canonicalHash(parsedPatch);
    const artifactSha256 = canonicalHash(artifact);
    const checkpoint = {
      protocol: "koni.planning-checkpoint.v1" as const,
      runId: input.run.id,
      attemptId: input.attemptId,
      revision: input.revision,
      baseRevision,
      baseArtifactSha256: baseRecord.artifactSha256,
      patchSha256,
      artifactSha256,
      graphSha256: graph.hash,
      patchPath: `${prefix}/patch.json`,
      artifactPath: `${prefix}/artifact.json`,
      graphPath: `${prefix}/graph.json`,
    };
    return {
      plan,
      graphHash: graph.hash,
      graphRevision: 0,
      activity: [
        compilerActivity(
          input.run,
          `Planning revision ${input.revision} graph validated (${graph.nodes().length} nodes)`,
          "plan",
          "success",
        ),
      ],
      artifactWrites: [
        { path: checkpoint.patchPath, bytes: encodeArtifact(parsedPatch), expectedSha256: null },
        { path: checkpoint.artifactPath, bytes: encodeArtifact(artifact), expectedSha256: null },
        {
          path: checkpoint.graphPath,
          bytes: encodeRunGraphArtifact(graphValue),
          expectedSha256: null,
        },
        {
          path: `${prefix}/checkpoint.json`,
          bytes: encodeArtifact(checkpoint),
          expectedSha256: null,
        },
      ],
    };
  }

  /**
   * Compile one bounded qualitative Lead judgment. This decoder never schedules work: the
   * authority consumes the disposition and remains solely responsible for deterministic
   * ticket readiness, concurrency, and durable lifecycle transitions.
   */
  public async compileLeadJudgmentOutput(input: {
    run: RunRecord;
    attemptId: string;
    output: unknown;
  }): Promise<LeadJudgmentOutput> {
    const attempt = input.run.attempts[input.attemptId];
    if (
      attempt === undefined ||
      attempt.kind !== "lead" ||
      attempt.ticketId !== "run-orchestration"
    ) {
      fail("lead_attempt", "Lead judgment output is not bound to a run-level Lead attempt");
    }
    const pinned = await this.#loadPinned(input.run);
    const trigger = leadTriggerForAttempt(attempt);
    const behavior = pinnedLeadJudgmentBehavior(input.run, pinned.configuration);
    if (
      attempt.stepId !== leadJudgmentStepId(trigger) ||
      attempt.personaId !== behavior.personaId
    ) {
      fail("lead_attempt", "Lead judgment attempt identity drifted from its pinned behavior");
    }
    try {
      return parseLeadJudgmentOutput(input.output);
    } catch (error) {
      fail(
        "lead_output",
        error instanceof Error ? error.message : "Lead judgment output is invalid",
      );
    }
  }

  public async initializeApprovedPlan(run: RunRecord): Promise<ApprovedPlanCompilation> {
    const pinned = await this.#loadPinned(run);
    if (run.plan === undefined)
      fail("plan_missing", "run has no compiler-validated approval artifact");
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const pipeline = pipelineDefinition(runType.document);
    const hasPlanningStage = pipeline.order.some(
      (id) => requiredRecord(pipeline.stages[id], `pipeline stage ${id}`).kind === "planning",
    );
    const graph =
      run.plan.graphSeed === undefined
        ? (() => {
            if (hasPlanningStage)
              fail("plan_missing", "approved plan has no compiler-validated graph seed");
            return compileDirectInitialGraph(pinned.configuration, run, this.#projectRoot);
          })()
        : compilePlanningSeed(
            pinned.configuration,
            run,
            parsePlanningSeed(run.plan.graphSeed),
            planningArtifactBoundary(() =>
              parsePlanningFullPlans(run.plan!.full, "approved full plan"),
            ),
            this.#projectRoot,
          );
    if (run.graphHash !== undefined && run.graphHash !== graph.hash) {
      fail(
        "approved_graph_drift",
        "approved graph seed no longer matches the reviewed planning graph",
      );
    }
    const evaluation = requireValidation(
      await this.#evaluateRules(run, pinned.configuration, graph),
      "rule_compilation_failed",
      "approved graph did not compile into tickets",
    );
    const tickets = reconcileTickets(
      run,
      evaluation.tickets,
      requireExecutionSemanticCatalog(pinned.configuration),
      this.#now().toISOString(),
      this.#projectRoot,
      await recurringAssetReissueNodeIds(
        run,
        pinned.configuration,
        graph,
        evaluation,
        run.git.run.worktree,
      ),
      integrationOperation(pinned.configuration, run.runTypeId),
    );
    const graphRevision = 1;
    let priorGraph:
      { graph: TypedGraph; artifact: GraphArtifact; bytesSha256: Sha256Digest } | undefined;
    try {
      priorGraph = await this.#readContextGraph(run, pinned.configuration);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let priorDefinitionsSha256: Sha256Digest | undefined;
    try {
      // A revised approved plan deliberately supersedes definitions bound to the
      // prior graph revision. We need their byte hash for CAS replacement, not a
      // semantic read that would (correctly) reject the obsolete binding.
      priorDefinitionsSha256 = rawSha256(
        await readFile(path.join(this.#stateRoot, ticketDefinitionsPath(run.id))),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let priorEvaluationSha256: Sha256Digest | undefined;
    try {
      priorEvaluationSha256 = rawSha256(
        await readFile(path.join(this.#stateRoot, evaluationPath(run.id, graphRevision))),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const priorContext =
      priorGraph === undefined
        ? createGraphContextualState(runRootContextId(run.id), run.workingSpecOwnerId)
        : this.#contextualState(run, priorGraph.artifact);
    const contextual =
      run.workingSpecOwnerId === undefined
        ? priorContext
        : await this.#materializeWorkingSpecBaseline(run, graph, graphRevision, priorContext);
    const graphBytes = encodeRunGraphArtifact(
      graphArtifact(run, pinned.configuration, graph, graphRevision, contextual),
    );
    const definitions = ticketArtifact(run, graphRevision, evaluation);
    this.#dynamicContextSelector.clear();
    return {
      graphHash: graph.hash,
      graphRevision,
      tickets,
      activity: [
        ...graph.nodes().map((node) => graphActivity(run, "graph_added", node, "approved")),
        compilerActivity(
          run,
          `Compiled ${evaluation.tickets.length} deterministic tickets`,
          "initialize",
          "warning",
        ),
      ],
      artifactWrites: [
        {
          path: graphArtifactPath(run.id),
          bytes: graphBytes,
          expectedSha256: priorGraph?.bytesSha256 ?? null,
        },
        {
          path: ticketDefinitionsPath(run.id),
          bytes: encodeArtifact(definitions),
          expectedSha256: priorDefinitionsSha256 ?? null,
        },
        {
          path: evaluationPath(run.id, graphRevision),
          bytes: encodeArtifact(evaluation),
          expectedSha256: priorEvaluationSha256 ?? null,
        },
      ],
    };
  }

  public async reconcileTicketBoard(run: RunRecord): Promise<TicketBoardCompilation> {
    const pinned = await this.#loadPinned(run);
    const graphRead = await this.#readGraph(run, pinned.configuration);
    const definitionsRead = await this.#readTicketDefinitions(run, pinned.configuration);
    const evaluation = requireValidation(
      await this.#evaluateRules(run, pinned.configuration, graphRead.graph),
      "rule_compilation_failed",
      "current graph did not compile into a valid ticket board",
    );
    const recurringAssetReissues = await recurringAssetReissueNodeIds(
      run,
      pinned.configuration,
      graphRead.graph,
      evaluation,
      run.git.run.worktree,
    );
    const tickets = reconcileTickets(
      run,
      evaluation.tickets,
      requireExecutionSemanticCatalog(pinned.configuration),
      this.#now().toISOString(),
      this.#projectRoot,
      recurringAssetReissues,
      integrationOperation(pinned.configuration, run.runTypeId),
    );
    const definitions = ticketArtifact(run, run.graphRevision, evaluation, definitionsRead.value);
    return {
      tickets,
      applicableTicketIds: ticketBoardApplicableTicketDefinitions(
        evaluation.tickets,
        recurringAssetReissues,
      ).map((definition) => definition.id),
      artifactWrites: [
        {
          path: ticketDefinitionsPath(run.id),
          bytes: encodeArtifact(definitions),
          expectedSha256: definitionsRead.bytesSha256,
        },
      ],
    };
  }

  public async compileAssignmentOutput(input: {
    run: RunRecord;
    assignment: ReadyAssignment;
    attemptId: string;
    output: unknown;
  }): Promise<AssignmentCompilation> {
    const pinned = await this.#loadPinned(input.run);
    const graphRead = await this.#readGraph(input.run, pinned.configuration);
    const executionCatalog = requireExecutionSemanticCatalog(pinned.configuration);
    const definitionsRead = await this.#readTicketDefinitions(input.run, pinned.configuration);
    const attempt = input.run.attempts[input.attemptId];
    if (attempt === undefined)
      fail("assignment_attempt", `assignment attempt ${input.attemptId} is unavailable`);
    const pinnedDefinition =
      ticketDefinitionFromArtifact(definitionsRead.value, input.assignment.ticketId) ??
      configuredControlDefinitionFromTicket(
        input.run,
        input.assignment,
        pinned.configuration,
        executionCatalog,
        graphRead.graph,
      );
    const ticket = input.run.tickets[input.assignment.ticketId];
    const synthetic =
      pinnedDefinition ??
      (ticket?.operationId === integrationOperation(pinned.configuration, input.run.runTypeId)
        ? integrationDefinition(input.run, input.assignment, pinned.configuration, graphRead.graph)
        : await this.#recoverDefinitionFromRecordedAttempt(
            input.run,
            attempt,
            pinned.configuration,
          ));
    const step = synthetic.workflow.find((item) => item.id === input.assignment.stepId);
    if (step === undefined || step.persona_id !== input.assignment.personaId) {
      fail("assignment_drift", "assignment no longer matches its pinned compiler definition");
    }
    const executionBinding = resolveDefinitionExecutionBindings(
      executionCatalog,
      synthetic,
    ).steps.get(step.id);
    if (executionBinding === undefined) {
      fail("execution_policy_step", `assignment step ${step.id} has no pinned semantic binding`);
    }
    const result = parseAssignmentOutput(
      input.output,
      step.graph_mutation,
      assignmentChangeControlContract(executionCatalog, executionBinding, step.id),
      step.kind,
    );
    if (result.status === "failed") {
      assertFailedAssignmentDoesNotReuseInheritedChecks(
        input.run,
        input.assignment,
        input.attemptId,
        step,
      );
      if (step.kind === "review") {
        assertFailedReviewDoesNotContradictApprovedChangeRuntimeObligations(
          input.run,
          graphRead.graph,
          step.write_node_ids ?? synthetic.scope.write_node_ids,
          result.blocker!,
        );
      }
      return {
        outcome: {
          status: "failed",
          ...(result.summary === undefined ? {} : { summary: result.summary }),
          blocker: result.blocker!,
          ...(configuredCheckInfrastructureFailureForAttempt(input.run, input.attemptId) ===
          undefined
            ? {}
            : { failureKind: "infrastructure" as const }),
        },
      };
    }
    assertCurrentAssignmentChecks(input.run, input.assignment, input.attemptId, step);
    let graph = graphRead.graph;
    const evidenceInputGraph = graph;
    const priorRuleEvidence = runRuleEvidence(
      input.run,
      pinned.configuration.configuration_sha256,
      ruleInputGraphSha256(pinned.configuration, evidenceInputGraph),
    );
    const changeControl = compileAssignmentChangeControl({
      run: input.run,
      definition: synthetic,
      step,
      binding: executionBinding,
      catalog: executionCatalog,
      graph,
      result,
    });
    if (changeControl !== undefined) {
      return {
        outcome: { status: "completed", summary: result.summary! },
        changeControl,
      };
    }
    const changes: Array<{
      kind: "added" | "modified" | "deleted";
      nodeId: string;
      nodeType: string;
      title: string;
    }> = [];
    if (result.graphDelta !== undefined && result.graphDelta !== null) {
      const ticketOwnedWritableNodeIds =
        ticket === undefined || step.graph_mutation === "forbidden"
          ? []
          : ticketCreatedNodeIds(input.run, ticket, graph);
      const normalizedDelta = normalizeAgentGraphRelationships(
        graph,
        result.graphDelta,
        ticketOwnedWritableNodeIds,
      );
      validateAgentGraphDelta(
        pinned.configuration,
        graph,
        synthetic,
        step,
        normalizedDelta,
        ticketOwnedWritableNodeIds,
      );
      const effectiveDelta = materializeCompilerFieldSources(
        pinned.configuration,
        input.run,
        normalizedDelta,
      );
      const applied = graph.applyRebased(effectiveDelta);
      assertOperationGraphMutationPolicy(
        executionCatalog,
        executionBinding,
        typedGateIdentityCatalog(pinned.configuration, graph),
        materializedNodeChanges(graph, applied.graph, effectiveDelta),
        ticketOwnedWritableNodeIds,
      );
      graph = applied.graph;
      assertAssetGateContractsBoundToGraph(
        graph,
        typedGateIdentityCatalog(pinned.configuration, graph).gateNodeTypes,
        effectiveDelta.upsertNodes.map((mutation) => mutation.node.id),
      );
      changes.push(...applied.changes);
    }
    if (shouldAssertApprovedChangeRuntimeObligations(step)) {
      assertApprovedChangeRuntimeObligations(
        input.run,
        graph,
        step.write_node_ids ?? synthetic.scope.write_node_ids,
      );
    }
    const reviewCandidates =
      step.kind === "review"
        ? await this.#reviewCandidateNodeIds(input.run, synthetic, executionCatalog)
        : [];
    const postDeltaEvidence = rebindRuleEvidenceAcrossNonInterferingGraphChange({
      configuration: pinned.configuration,
      before: evidenceInputGraph,
      after: graph,
      evidence: priorRuleEvidence,
    });
    const reviewInputGraph = graph;
    const effected = await applyReviewEffects({
      configuration: pinned.configuration,
      graph,
      ticket: synthetic,
      step,
      reviewId: input.attemptId,
      actor: step.persona_id,
      candidateNodeIds: reviewCandidates,
      projectRoot: attemptWorkspace(input.run, "ticket", input.assignment.ticketId),
      ...(postDeltaEvidence === undefined ? {} : { evidence: postDeltaEvidence }),
    });
    graph = effected.graph;
    changes.push(...effected.changes);
    if (synthetic.operation === "compile-run-plan") {
      for (const nodeId of synthetic.target_node_ids) {
        const node = graph.node(nodeId);
        if (node?.type === "run") assertRunPlanUsesRepositoryOwnedArgv(node);
      }
    }
    const successorEvidence = rebindRuleEvidenceAcrossNonInterferingGraphChange({
      configuration: pinned.configuration,
      before: reviewInputGraph,
      after: graph,
      evidence: postDeltaEvidence,
    });
    assertConfiguredGraphConstraints(
      pinned.configuration,
      graph,
      attemptWorkspace(input.run, "ticket", input.assignment.ticketId),
    );
    if (step.graph_mutation === "required" && changes.length === 0) {
      fail(
        "graph_mutation_required",
        "this compiler step completed without its required graph change",
      );
    }
    if (changes.length === 0) {
      const evaluationRun =
        successorEvidence === undefined
          ? input.run
          : {
              ...structuredClone(input.run),
              ruleAuthorityEvidence: successorEvidence as unknown as JsonValue,
            };
      const evaluation = requireValidation(
        await this.#evaluateRules(evaluationRun, pinned.configuration, graph),
        "rule_compilation_failed",
        "unchanged agent output did not compile into a valid ticket board",
      );
      const tickets = reconcileTickets(
        input.run,
        evaluation.tickets,
        executionCatalog,
        this.#now().toISOString(),
        this.#projectRoot,
        await recurringAssetReissueNodeIds(
          input.run,
          pinned.configuration,
          graph,
          evaluation,
          input.run.git.run.worktree,
        ),
        integrationOperation(pinned.configuration, input.run.runTypeId),
      );
      const definitions = ticketArtifact(
        input.run,
        input.run.graphRevision,
        evaluation,
        definitionsRead.value,
      );
      return {
        outcome: { status: "completed", summary: result.summary! },
        tickets,
        ...(successorEvidence === undefined
          ? {}
          : { ruleAuthorityEvidence: successorEvidence as unknown as JsonValue }),
        artifactWrites: [
          {
            path: ticketDefinitionsPath(input.run.id),
            bytes: encodeArtifact(definitions),
            expectedSha256: definitionsRead.bytesSha256,
          },
        ],
      };
    }
    const selfPreparationReview =
      step.kind === "review" &&
      typeof pinned.configuration.registries.operations[synthetic.operation_registry_id]
        ?.proof_source_preparation_check === "string";
    const evaluationRun =
      successorEvidence === undefined
        ? input.run
        : {
            ...structuredClone(input.run),
            ruleAuthorityEvidence: successorEvidence as unknown as JsonValue,
          };
    const evaluation = requireValidation(
      await this.#evaluateRules(evaluationRun, pinned.configuration, graph, {
        ...(selfPreparationReview ? { selfPreparationReviewAttemptId: input.attemptId } : {}),
      }),
      "rule_compilation_failed",
      "agent graph output did not compile into a valid ticket board",
    );
    const graphRevision = input.run.graphRevision + 1;
    const tickets = reconcileTickets(
      input.run,
      evaluation.tickets,
      requireExecutionSemanticCatalog(pinned.configuration),
      this.#now().toISOString(),
      this.#projectRoot,
      await recurringAssetReissueNodeIds(
        input.run,
        pinned.configuration,
        graph,
        evaluation,
        input.run.git.run.worktree,
      ),
      integrationOperation(pinned.configuration, input.run.runTypeId),
    );
    const graphBytes = encodeRunGraphArtifact(
      graphArtifact(
        input.run,
        pinned.configuration,
        graph,
        graphRevision,
        this.#contextualState(input.run, graphRead.artifact),
      ),
    );
    const definitions = ticketArtifact(input.run, graphRevision, evaluation, definitionsRead.value);
    this.#dynamicContextSelector.clear();
    return {
      outcome: { status: "completed", summary: result.summary! },
      graphHash: graph.hash,
      graphRevision,
      tickets,
      ...(successorEvidence === undefined
        ? { ruleAuthorityEvidence: null }
        : { ruleAuthorityEvidence: successorEvidence as unknown as JsonValue }),
      activity: changes.map((change) =>
        graphActivity(
          input.run,
          change.kind === "added"
            ? "graph_added"
            : change.kind === "deleted"
              ? "graph_deleted"
              : "graph_modified",
          { id: change.nodeId, type: change.nodeType, title: change.title },
          input.assignment.ticketId,
        ),
      ),
      artifactWrites: [
        {
          path: graphArtifactPath(input.run.id),
          bytes: graphBytes,
          expectedSha256: graphRead.bytesSha256,
        },
        {
          path: ticketDefinitionsPath(input.run.id),
          bytes: encodeArtifact(definitions),
          expectedSha256: definitionsRead.bytesSha256,
        },
        {
          path: evaluationPath(input.run.id, graphRevision),
          bytes: encodeArtifact(evaluation),
          expectedSha256: null,
        },
      ],
    };
  }

  public async requiresVerificationAttempt(run: RunRecord): Promise<boolean> {
    const pinned = await this.#loadPinned(run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const pipeline = pipelineDefinition(runType.document);
    return pipeline.order.some(
      (id) => requiredRecord(pipeline.stages[id], `pipeline stage ${id}`).kind === "agent_review",
    );
  }

  public async projectPipeline(run: RunRecord): Promise<readonly RunPipelineStageDefinition[]> {
    const pinned = await this.#loadPinned(run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const pipeline = pipelineDefinition(runType.document);
    return projectPipelineDefinition(pipeline);
  }

  public async compileVerificationOutput(input: {
    run: RunRecord;
    attemptId: string;
    output: unknown;
  }): Promise<AssignmentCompilation> {
    const attempt = input.run.attempts[input.attemptId];
    if (attempt === undefined || attempt.kind !== "verification") {
      fail(
        "verification_attempt",
        "independent-review output is not bound to a verification attempt",
      );
    }
    const result = parseAssignmentOutput(input.output, "forbidden");
    return result.status === "failed"
      ? {
          outcome: {
            status: "failed",
            ...(result.summary === undefined ? {} : { summary: result.summary }),
            blocker: result.blocker!,
          },
        }
      : { outcome: { status: "completed", summary: result.summary! } };
  }

  public async verifyRun(run: RunRecord): Promise<VerificationCompilation> {
    const pinned = await this.#loadPinned(run);
    const graphRead = await this.#readGraph(run, pinned.configuration);
    if (run.graphHash !== graphRead.graph.hash) {
      return { ok: false, reason: "The durable graph hash does not match the run record." };
    }
    const evaluation = requireValidation(
      await this.#evaluateRules(run, pinned.configuration, graphRead.graph),
      "rule_compilation_failed",
      "verification could not compile the current graph",
    );
    const recurringAssetReissues = await recurringAssetReissueNodeIds(
      run,
      pinned.configuration,
      graphRead.graph,
      evaluation,
      run.git.run.worktree,
    );
    const actionableTickets = verificationActionableTicketDefinitions(
      evaluation.tickets,
      recurringAssetReissues,
      Object.values(run.tickets),
    );
    if (actionableTickets.length > 0) {
      const definitionsRead = await this.#readTicketDefinitions(run, pinned.configuration);
      const tickets = reconcileTickets(
        run,
        evaluation.tickets,
        requireExecutionSemanticCatalog(pinned.configuration),
        this.#now().toISOString(),
        this.#projectRoot,
        recurringAssetReissues,
        integrationOperation(pinned.configuration, run.runTypeId),
      );
      const reason = `Verification found ${actionableTickets.length} still-applicable compiler tickets: ${actionableTickets.map((item) => item.title).join("; ")}`;
      return {
        ok: false,
        reason,
        tickets,
        applicableTicketIds: actionableTickets.map((ticket) => ticket.id).sort(compareText),
        activity: [compilerActivity(run, reason, "verify", "error")],
        artifactWrites: [
          {
            path: ticketDefinitionsPath(run.id),
            bytes: encodeArtifact(
              ticketArtifact(run, run.graphRevision, evaluation, definitionsRead.value),
            ),
            expectedSha256: definitionsRead.bytesSha256,
          },
        ],
      };
    }
    if (Object.values(run.tickets).some((ticket) => !ticketDependencySettled(ticket))) {
      return { ok: false, reason: "Verification found a ticket that is not complete." };
    }
    const compiledAt = this.#now().toISOString();
    const reports = compileConfiguredReports({
      configuration: pinned.configuration,
      graph: graphRead.graph,
      run,
      compiledAt,
    });
    const reportWrites = await this.#prepareReportWrites(reports.artifacts);
    return {
      ok: true,
      report: reports.report,
      activity: [
        compilerActivity(
          run,
          "Typed graph and deterministic ticket fixpoint verified",
          "verify",
          "success",
        ),
      ],
      artifactWrites: [
        {
          path: `runs/${run.id}/program/verification-${run.revision}.json`,
          bytes: encodeArtifact({
            protocol: "koni.verification-compilation.v1",
            runId: run.id,
            graphSha256: graphRead.graph.hash,
            evaluationSha256: evaluation.evaluation_sha256,
            reportId: reports.report.reportId,
            reportBundleSha256: reports.report.bundleHash,
            verifiedAt: compiledAt,
          }),
          expectedSha256: null,
        },
        ...reportWrites,
      ],
    };
  }

  async #prepareReportWrites(
    artifacts: readonly PreparedReportArtifact[],
  ): Promise<TransactionWrite[]> {
    const writes: TransactionWrite[] = [];
    for (const artifact of artifacts) {
      const absolute = path.join(this.#stateRoot, artifact.path);
      let current: Buffer | undefined;
      try {
        current = await readFile(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current === undefined) {
        writes.push({ path: artifact.path, bytes: artifact.bytes, expectedSha256: null });
      } else if (rawSha256(current) !== rawSha256(artifact.bytes)) {
        fail("report_artifact_drift", `deterministic report artifact changed at ${artifact.path}`);
      }
    }
    return writes;
  }

  /**
   * Project the proposal side of an admitted upstream handoff. This method is deliberately pure:
   * the authority publishes the returned template and the source hold in its own run-record CAS.
   */
  public async projectChangeControlProposalTicket(input: {
    run: RunRecord;
    changeControl: Extract<RuntimeAssignmentChangeControlCompilation, { kind: "upstream_request" }>;
    sourceTerminalProof: TerminalSuccessSettlementProof;
  }): Promise<TicketRecord | undefined> {
    assertHashBoundRecord(input.changeControl, "compiled upstream change request");
    const pinned = await this.#loadPinned(input.run);
    const catalog = requireExecutionSemanticCatalog(pinned.configuration);
    const graph = (await this.#readGraph(input.run, pinned.configuration)).graph;
    const publication = input.changeControl.publication;
    assertHashBoundRecord(publication, "change-control publication");
    if (
      publication.configurationSha256 !== pinned.configuration.configuration_sha256 ||
      publication.catalogSha256 !== catalog.sha256 ||
      input.changeControl.sourceTicketId.length === 0 ||
      input.changeControl.sourceStepId.length === 0
    ) {
      fail(
        "change_control_publication_binding",
        "upstream change request differs from this run's pinned authority",
      );
    }
    const source = input.run.tickets[input.changeControl.sourceTicketId];
    const sourceStep = source?.steps.find((step) => step.id === input.changeControl.sourceStepId);
    if (source === undefined || sourceStep?.executionPolicyBinding === undefined) {
      fail(
        "change_control_source_binding",
        "upstream change request has no exact durable source step binding",
      );
    }
    assertExecutionBindingExact(catalog, sourceStep.executionPolicyBinding, "upstream source step");
    if (sourceStep.executionPolicyBinding.sha256 !== input.changeControl.sourceBindingSha256) {
      fail(
        "change_control_source_binding",
        "upstream change request source policy hash is stale or mutated",
      );
    }
    const existing = input.run.tickets[publication.proposalTicketId];
    const existingProposal =
      existing === undefined ? undefined : existingChangeControlProposal(existing);
    const priorSourceProof = existing?.executionControl?.controlTicketAuthority?.causal;
    const expectedSourceCompilationSha256 =
      existing === undefined
        ? input.changeControl.sha256
        : priorSourceProof?.role === "proposal"
          ? priorSourceProof.sourceTerminalProof.semanticResult.changeControlSha256
          : undefined;
    if (
      input.sourceTerminalProof.runId !== input.run.id ||
      input.sourceTerminalProof.ticketId !== source.id ||
      input.sourceTerminalProof.stepId !== sourceStep.id ||
      input.sourceTerminalProof.semanticResult.status !== "completed" ||
      input.sourceTerminalProof.semanticResult.changeControlSha256 !==
        expectedSourceCompilationSha256 ||
      (priorSourceProof?.role === "proposal" &&
        canonicalHash(input.sourceTerminalProof) !==
          canonicalHash(priorSourceProof.sourceTerminalProof))
    ) {
      fail(
        "change_control_source_terminal_proof",
        "proposal publication lacks its exact successful source action",
      );
    }
    if (
      input.changeControl.fulfillment === "dynamic_scope_change" &&
      existingStandaloneSupportRunForUpstreamRequest(graph, input.changeControl.targetNodeIds, [
        ...source.targetNodeIds,
        ...(source.readNodeIds ?? []),
      ]) !== undefined
    ) {
      return undefined;
    }
    const expectedPublication = deriveChangeControlPublication(catalog, {
      runId: input.run.id,
      sourceTicketId: input.changeControl.sourceTicketId,
      sourceStepId: input.changeControl.sourceStepId,
      sourceOutputSha256: input.changeControl.sourceOutputSha256,
      sourceBinding: sourceStep.executionPolicyBinding,
      targetNodeIds: input.changeControl.targetNodeIds,
      summary: input.changeControl.summary,
      reason: input.changeControl.reason,
      ...(existingProposal === undefined ? {} : { existingProposal }),
    });
    if (canonicalHash(expectedPublication) !== canonicalHash(publication)) {
      fail(
        "change_control_publication_drift",
        "compiled proposal publication is not the exact deterministic projection",
      );
    }
    assertExistingControlTargets(
      graph,
      input.changeControl.targetNodeIds,
      new Set(graph.nodes().map((node) => node.id)),
      "proposal request",
    );
    const definition = configuredControlTicketDefinition({
      configuration: pinned.configuration,
      catalog,
      graph,
      id: publication.proposalTicketId,
      operationId: publication.proposalOperationId,
      title: controlTicketTitle("Change request", input.changeControl.summary),
      targetNodeIds: publication.controlScopeNodeIds,
      readNodeIds: publication.controlScopeNodeIds,
      writeNodeIds: [],
      readPaths: [],
      writePaths: [],
      sourceStateKey: "upstream-change-requested",
      targetStateKey: "change-proposed",
      obligationKeys: [publication.requestSha256],
      forceGraphMutationForbidden: true,
      ruleId: "compiler.change-control.proposal",
    });
    const template = controlTicketRecordFromDefinition({
      runId: input.run.id,
      role: "proposal",
      definition,
      catalog,
      at: this.#now().toISOString(),
      status: "proposed",
      summary: `${input.changeControl.summary}\n\nReason: ${input.changeControl.reason}`,
      dependencyIds: [],
      executionControl: {
        changeControlScopeNodeIds: [...publication.controlScopeNodeIds],
        proposalRequest: {
          requestSha256: publication.requestSha256,
          sourceTicketId: input.changeControl.sourceTicketId,
          sourceStepId: input.changeControl.sourceStepId,
          sourceOutputSha256: input.changeControl.sourceOutputSha256,
          fulfillment: input.changeControl.fulfillment,
        },
      },
      causal: {
        role: "proposal",
        publication: structuredClone(expectedPublication),
        sourceTicketProjection: ticketImmutableProjection(source),
        sourceTerminalProof: structuredClone(input.sourceTerminalProof),
        sourceHold: {
          proposalTicketId: publication.proposalTicketId,
          requestSha256: publication.requestSha256,
        },
      },
    });
    if (existing === undefined) {
      if (publication.disposition !== "create") {
        fail(
          "change_control_proposal_reuse",
          "proposal publication requested reuse but no durable proposal exists",
        );
      }
      return template;
    }
    if (publication.disposition !== "reuse") {
      fail(
        "change_control_proposal_collision",
        "proposal publication requested creation over a durable proposal",
      );
    }
    preserveControlTicketCreationAuthority(existing, template, "proposal");
    assertControlTicketTemplate(existing, template, "proposal");
    return structuredClone(existing);
  }

  /** Project the exact reviewed application child, or return no ticket for a typed no-op. */
  public async projectApprovedApplicationTicket(input: {
    run: RunRecord;
    materialization: ApprovedChangeMaterialization;
    selection: Extract<RuntimeAssignmentChangeControlCompilation, { kind: "proposal_application" }>;
  }): Promise<TicketRecord | undefined> {
    assertHashBoundRecord(input.selection, "compiled proposal application");
    assertHashBoundRecord(input.materialization, "approved change materialization");
    const pinned = await this.#loadPinned(input.run);
    const catalog = requireExecutionSemanticCatalog(pinned.configuration);
    const graph = (await this.#readGraph(input.run, pinned.configuration)).graph;
    if (
      input.selection.configurationSha256 !== pinned.configuration.configuration_sha256 ||
      input.selection.catalogSha256 !== catalog.sha256 ||
      input.materialization.configurationSha256 !== pinned.configuration.configuration_sha256 ||
      input.materialization.catalogSha256 !== catalog.sha256 ||
      input.materialization.proposalTicketId !== input.selection.proposalTicketId
    ) {
      fail(
        "change_control_application_binding",
        "approved application differs from this run's pinned proposal authority",
      );
    }
    const proposal = input.run.tickets[input.selection.proposalTicketId];
    const proposalStep = proposal?.steps.find((step) => step.id === input.selection.proposalStepId);
    if (
      proposal === undefined ||
      proposal.executionPolicyBinding === undefined ||
      proposalStep?.executionPolicyBinding === undefined ||
      proposal.executionControl?.proposalRequest === undefined ||
      proposal.executionControl.controlTicketAuthority?.role !== "proposal" ||
      proposal.executionControl.changeControlScopeNodeIds === undefined ||
      proposal.executionPolicyBinding.sha256 !== input.selection.proposalBindingSha256
    ) {
      fail(
        "change_control_application_proposal",
        "approved application has no exact durable proposal authority",
      );
    }
    assertExecutionBindingExact(catalog, proposal.executionPolicyBinding, "proposal ticket");
    assertExecutionBindingExact(
      catalog,
      proposalStep.executionPolicyBinding,
      "proposal application step",
    );
    assertExecutionBindingExact(
      catalog,
      input.selection.applicationBinding,
      "selected application",
    );
    if (input.selection.applicationBinding.operationId !== input.selection.applicationOperationId) {
      fail(
        "change_control_application_binding",
        "selected application operation and policy binding disagree",
      );
    }
    const proposalOperation = catalog.operations[proposal.operationId];
    const applicationOperation = catalog.operations[input.selection.applicationOperationId];
    if (
      proposalOperation?.changeControl.role !== "proposal" ||
      applicationOperation === undefined ||
      !proposalOperation.changeControl.applicationOperations.includes(
        applicationOperation.publicOperation,
      ) ||
      applicationOperation.publicOperation !== input.selection.applicationPublicOperation
    ) {
      fail(
        "change_control_application_route",
        "approved application is outside the proposal's configured route",
      );
    }
    assertExistingControlTargets(
      graph,
      input.selection.targetNodeIds,
      new Set(proposal.executionControl.changeControlScopeNodeIds),
      "approved application",
    );
    const existingChildren = Object.values(input.run.tickets).filter(
      (ticket) =>
        ticket.executionControl?.sourceProposalTicketId === input.selection.proposalTicketId,
    );
    if (applicationOperation.changeControl.role === "disposition") {
      if (
        input.materialization.kind !== "no_op" ||
        existingChildren.length !== 0 ||
        input.selection.scope.readNodeIds.length !== 0 ||
        input.selection.scope.writeNodeIds.length !== 0 ||
        input.selection.scope.readPaths.length !== 0 ||
        input.selection.scope.writePaths.length !== 0
      ) {
        fail(
          "change_control_no_op_scope",
          "no-op disposition must materialize without a ticket, child, or authority scope",
        );
      }
      return undefined;
    }
    if (input.materialization.kind !== "application") {
      fail(
        "change_control_application_scope",
        "typed application route requires an application materialization",
      );
    }
    const materialization = input.materialization;
    if (
      applicationOperation.changeControl.role !== "application" ||
      materialization.applicationOperationId !== applicationOperation.id ||
      materialization.applicationTicketId !==
        deterministicControlTicketId("application", {
          proposalTicketId: input.selection.proposalTicketId,
          authoritySha256: materialization.authoritySha256,
        }) ||
      canonicalHash(materialization.applicationBinding) !==
        canonicalHash(input.selection.applicationBinding) ||
      canonicalHash(materialization.controlScopeNodeIds) !==
        canonicalHash(input.selection.targetNodeIds) ||
      canonicalHash(input.selection.scope.writeNodeIds) !==
        canonicalHash(input.selection.targetNodeIds) ||
      canonicalHash(input.selection.scope.readNodeIds) !==
        canonicalHash(input.selection.targetNodeIds) ||
      input.selection.scope.readPaths.length !== 0 ||
      input.selection.scope.writePaths.length !== 0
    ) {
      fail(
        "change_control_application_scope",
        "application materialization exceeds or differs from its approved exact scope",
      );
    }
    if (existingChildren.some((ticket) => ticket.id !== materialization.applicationTicketId)) {
      fail(
        "change_control_application_collision",
        "proposal already owns a different application child",
      );
    }
    const definition = configuredControlTicketDefinition({
      configuration: pinned.configuration,
      catalog,
      graph,
      id: materialization.applicationTicketId,
      operationId: materialization.applicationOperationId,
      title: controlTicketTitle("Apply change", input.selection.summary),
      targetNodeIds: input.selection.targetNodeIds,
      readNodeIds: input.selection.scope.readNodeIds,
      writeNodeIds: input.selection.scope.writeNodeIds,
      readPaths: input.selection.scope.readPaths,
      writePaths: input.selection.scope.writePaths,
      sourceStateKey: "change-approved",
      targetStateKey: "change-applied",
      obligationKeys: [materialization.authoritySha256],
      forceGraphMutationForbidden: false,
      ruleId: "compiler.change-control.application",
    });
    const template = controlTicketRecordFromDefinition({
      runId: input.run.id,
      role: "approved_application",
      definition,
      catalog,
      at: this.#now().toISOString(),
      status: "queued",
      summary: input.selection.summary,
      dependencyIds: [input.selection.proposalTicketId],
      executionControl: {
        changeControlScopeNodeIds: [...input.selection.targetNodeIds],
        sourceProposalTicketId: input.selection.proposalTicketId,
        approvedApplicationSha256: materialization.authoritySha256,
      },
      causal: {
        role: "approved_application",
        materialization: structuredClone(materialization),
        proposalTicketAuthoritySha256: proposal.executionControl.controlTicketAuthority.sha256,
        proposalTicketProjectionSha256:
          proposal.executionControl.controlTicketAuthority.projectionSha256,
      },
    });
    const existing = input.run.tickets[materialization.applicationTicketId];
    if (existing === undefined) {
      if (materialization.disposition !== "create") {
        fail(
          "change_control_application_reuse",
          "application requested reuse but no durable child exists",
        );
      }
      return template;
    }
    if (materialization.disposition !== "reuse") {
      fail(
        "change_control_application_collision",
        "application requested creation over a durable child",
      );
    }
    preserveControlTicketCreationAuthority(existing, template, "approved_application");
    assertControlTicketTemplate(existing, template, "application");
    return structuredClone(existing);
  }

  /** Project one bounded configured terminal resolver. Recursive resolver fan-out emits no ticket. */
  public async projectTerminalResolverTicket(input: {
    run: RunRecord;
    reconciliation: TerminalResolverReconciliation;
    sourceFailureProof: TerminalFailureSettlementProof;
  }): Promise<TicketRecord | undefined> {
    assertHashBoundRecord(input.reconciliation, "terminal resolver reconciliation");
    const pinned = await this.#loadPinned(input.run);
    const catalog = requireExecutionSemanticCatalog(pinned.configuration);
    if (
      input.reconciliation.configurationSha256 !== pinned.configuration.configuration_sha256 ||
      input.reconciliation.catalogSha256 !== catalog.sha256
    ) {
      fail(
        "terminal_resolver_binding",
        "terminal resolver differs from this run's pinned authority",
      );
    }
    const source = input.run.tickets[input.reconciliation.sourceTicketId];
    if (source?.executionPolicyBinding === undefined) {
      fail(
        "terminal_resolver_source",
        "terminal resolver has no exact durable source ticket binding",
      );
    }
    assertExecutionBindingExact(catalog, source.executionPolicyBinding, "terminal resolver source");
    const sourceOperation = catalog.operations[source.operationId];
    if (input.reconciliation.chainSuppressed) {
      if (
        !sourceOperation?.terminalResolver ||
        input.reconciliation.disposition !== "chain_suppressed"
      ) {
        fail(
          "terminal_resolver_chain",
          "resolver suppression is only valid for a configured resolver source",
        );
      }
      return undefined;
    }
    if (
      sourceOperation?.terminalResolver ||
      catalog.terminalResolverOperationId !== input.reconciliation.resolverOperationId
    ) {
      fail(
        "terminal_resolver_route",
        "terminal resolver is not the pinned nonrecursive recovery operation",
      );
    }
    assertExecutionBindingExact(catalog, input.reconciliation.resolverBinding, "terminal resolver");
    if (
      input.reconciliation.resolverBinding.operationId !== input.reconciliation.resolverOperationId
    ) {
      fail("terminal_resolver_binding", "terminal resolver operation and policy binding disagree");
    }
    const failureHashes = boundedDigests(
      input.reconciliation.failureBindingSha256s,
      "terminal failure bindings",
    );
    if (failureHashes.length !== 1) {
      fail(
        "terminal_resolver_binding",
        "terminal resolver must bind one immutable attempt failure",
      );
    }
    if (
      terminalFailureBindingFromProof(input.run, source, input.sourceFailureProof)?.sha256 !==
      failureHashes[0]
    ) {
      fail(
        "terminal_resolver_failure_proof",
        "terminal resolver source failure proof differs from reconciliation",
      );
    }
    const expectedId = deterministicControlTicketId("recovery", {
      runId: input.run.id,
      sourceTicketId: input.reconciliation.sourceTicketId,
      failureBindingSha256: failureHashes[0],
      configurationSha256: catalog.configurationSha256,
      catalogSha256: catalog.sha256,
      resolverOperationId: input.reconciliation.resolverOperationId,
    });
    if (expectedId !== input.reconciliation.resolverTicketId) {
      fail(
        "terminal_resolver_identity",
        "terminal resolver ticket id is not the deterministic compiler identity",
      );
    }
    const graph = (await this.#readGraph(input.run, pinned.configuration)).graph;
    const readNodeIds = canonicalControlStrings(
      [...new Set([...(source.readNodeIds ?? []), ...(source.writeNodeIds ?? [])])],
      "terminal resolver read nodes",
      true,
    );
    const writeNodeIds = canonicalControlStrings(
      source.writeNodeIds ?? [],
      "terminal resolver write nodes",
      true,
    );
    const definition = configuredControlTicketDefinition({
      configuration: pinned.configuration,
      catalog,
      graph,
      id: input.reconciliation.resolverTicketId,
      operationId: input.reconciliation.resolverOperationId,
      title: `Resolve terminal failure: ${source.title}`,
      targetNodeIds: source.targetNodeIds,
      readNodeIds,
      writeNodeIds,
      readPaths: source.readPaths,
      writePaths: source.writePaths,
      sourceStateKey: "terminal-failure",
      targetStateKey: "recovered",
      obligationKeys: failureHashes,
      forceGraphMutationForbidden: false,
      ruleId: "compiler.change-control.terminal-resolver",
    });
    const template = controlTicketRecordFromDefinition({
      runId: input.run.id,
      role: "terminal_resolver",
      definition,
      catalog,
      at: this.#now().toISOString(),
      status: "queued",
      summary: `Recover terminal ticket ${source.id} from ${failureHashes.length} authenticated failure binding(s).`,
      dependencyIds: [],
      executionControl: {
        changeControlScopeNodeIds: [...new Set([...readNodeIds, ...writeNodeIds])].sort(
          compareText,
        ),
        terminalRecovery: {
          protocol: "koni.terminal-recovery-authority.v2",
          configurationSha256: catalog.configurationSha256,
          catalogSha256: catalog.sha256,
          resolverOperationId: input.reconciliation.resolverOperationId,
          resolverTicketId: input.reconciliation.resolverTicketId,
          resolverBinding: structuredClone(input.reconciliation.resolverBinding),
          resolverOperation: structuredClone(
            catalog.operations[input.reconciliation.resolverOperationId]!,
          ),
          sourceTicketId: source.id,
          failureBindingSha256s: [...failureHashes],
          sourceFailureProof: structuredClone(input.sourceFailureProof),
          reconciliationDisposition: input.reconciliation.disposition,
          sourceLink: input.reconciliation.sourceLink,
          chainSuppressed: input.reconciliation.chainSuppressed,
          reconciliationSha256: input.reconciliation.sha256,
          sha256: canonicalHash({
            protocol: "koni.terminal-recovery-authority.v2",
            configurationSha256: catalog.configurationSha256,
            catalogSha256: catalog.sha256,
            resolverOperationId: input.reconciliation.resolverOperationId,
            resolverTicketId: input.reconciliation.resolverTicketId,
            resolverBinding: input.reconciliation.resolverBinding,
            resolverOperation: catalog.operations[input.reconciliation.resolverOperationId]!,
            sourceTicketId: source.id,
            failureBindingSha256s: [...failureHashes],
            sourceFailureProof: input.sourceFailureProof,
            reconciliationDisposition: input.reconciliation.disposition,
            sourceLink: input.reconciliation.sourceLink,
            chainSuppressed: input.reconciliation.chainSuppressed,
            reconciliationSha256: input.reconciliation.sha256,
          }),
        },
      },
      causal: {
        role: "terminal_resolver",
        reconciliation: structuredClone(input.reconciliation),
        sourceTicketProjection: ticketImmutableProjection(source),
        sourceFailureProof: structuredClone(input.sourceFailureProof),
      },
    });
    const existing = input.run.tickets[input.reconciliation.resolverTicketId];
    if (existing === undefined) {
      if (input.reconciliation.disposition !== "create") {
        fail(
          "terminal_resolver_reuse",
          "terminal resolver requested reuse but no durable resolver exists",
        );
      }
      return template;
    }
    if (input.reconciliation.disposition !== "reuse") {
      fail(
        "terminal_resolver_collision",
        "terminal resolver requested creation over a durable resolver",
      );
    }
    const durableRecovery = existing.executionControl?.terminalRecovery;
    const expectedRecovery = template.executionControl?.terminalRecovery;
    if (
      durableRecovery === undefined ||
      expectedRecovery === undefined ||
      durableRecovery.reconciliationDisposition !== "create"
    ) {
      fail(
        "terminal_resolver_reuse",
        "terminal resolver reuse lacks its original creation authority",
      );
    }
    // A reuse decision is an observation, not a new creation authority. Compare the entire
    // compiler template while retaining only the original reconciliation envelope; all bound
    // source, operation, policy, and failure-proof fields still come from the fresh projection.
    expectedRecovery.reconciliationDisposition = durableRecovery.reconciliationDisposition;
    expectedRecovery.sourceLink = durableRecovery.sourceLink;
    expectedRecovery.chainSuppressed = durableRecovery.chainSuppressed;
    expectedRecovery.reconciliationSha256 = durableRecovery.reconciliationSha256;
    expectedRecovery.sha256 = durableRecovery.sha256;
    preserveControlTicketCreationAuthority(existing, template, "terminal_resolver");
    assertControlTicketTemplate(existing, template, "terminal resolver", {
      allowFailureHashExtension: true,
      allowPristineCompilerCancellation: true,
    });
    return structuredClone(existing);
  }

  public async createIntegrationTicket(input: {
    run: RunRecord;
    conflictReport: string;
    targetOid: string;
  }): Promise<TicketRecord> {
    const pinned = await this.#loadPinned(input.run);
    const runType = requireValidation(
      resolveCompiledRunType(pinned.configuration, input.run.runTypeId),
      "run_type_invalid",
      "run type disappeared",
    );
    const promotion = optionalRecord(runType.document.promotion);
    const executionCatalog = requireExecutionSemanticCatalog(pinned.configuration);
    const operationId = resolveConfiguredOperationReference(
      executionCatalog,
      optionalString(promotion?.conflict_operation) ?? "resolve-target-integration",
    );
    const id = `TK-integration-${digestBody(canonicalHash([input.run.id, input.targetOid, input.conflictReport])).slice(0, 16)}`;
    const at = this.#now().toISOString();
    const graph = (await this.#readGraph(input.run, pinned.configuration)).graph;
    const definition = configuredIntegrationTicketDefinition({
      configuration: pinned.configuration,
      catalog: executionCatalog,
      graph,
      id,
      operationId,
      title: `Integrate target ${shortOid(input.targetOid)}`,
    });
    const semantic = resolveDefinitionExecutionBindings(executionCatalog, definition);
    const ticket: SemanticTicketRecord = {
      id,
      operationId,
      executionPolicyBinding: semantic.ticket,
      title: definition.title,
      summary: boundedText(input.conflictReport, "conflict report", 64 * 1024),
      status: "queued",
      priority: -1_000_000,
      dependencyIds: [],
      targetNodeIds: [...definition.target_node_ids],
      readNodeIds: [...definition.scope.read_node_ids],
      writeNodeIds: [...definition.scope.write_node_ids],
      readPaths: [...definition.scope.read_paths],
      writePaths: [...definition.scope.write_paths],
      steps: definition.workflow.map((step) => ({
        id: step.id,
        title: humanize(step.id),
        personaId: step.persona_id,
        executionPolicyBinding: semantic.steps.get(step.id)!,
        kind: step.kind,
        dependsOn: [...step.depends_on],
        ...(step.read_node_ids === undefined ? {} : { readNodeIds: [...step.read_node_ids] }),
        ...(step.write_node_ids === undefined ? {} : { writeNodeIds: [...step.write_node_ids] }),
        ...(step.read_paths === undefined ? {} : { readPaths: [...step.read_paths] }),
        ...(step.write_paths === undefined ? {} : { writePaths: [...step.write_paths] }),
        ...(step.validation_action === undefined
          ? {}
          : { validationAction: step.validation_action }),
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      })),
      ...(definition.review_failure_reopen_from === undefined
        ? {}
        : {
            reviewFailureReopenFrom: definition.review_failure_reopen_from,
            reviewReworkLimit: 1,
            reviewReworkCount: 0,
            reviewReworks: [],
          }),
      worktreePath: undefined,
      branch: undefined,
      blocker: undefined,
      integrationCandidateOid: input.targetOid,
      createdAt: at,
      updatedAt: at,
    };
    return ticket;
  }

  async #materializeWorkingSpecBaseline(
    run: RunRecord,
    graph: TypedGraph,
    semanticRevision: number,
    prior: GraphContextualState,
  ): Promise<GraphContextualState> {
    const ownerPersonaId = run.workingSpecOwnerId;
    if (ownerPersonaId === undefined) return prior;
    if (prior.canonicalWorkingSpecId !== undefined) {
      // A plan revision recompiles an already-approved run. Its existing canonical
      // baseline is immutable provenance for the prior approval and must be reused,
      // not treated as a duplicate initialization attempt.
      if (prior.ownerPersonaId !== undefined && prior.ownerPersonaId !== ownerPersonaId) {
        fail(
          "working_spec_owner_drift",
          "durable graph owner differs from the owner pinned at run creation",
        );
      }
      return prior;
    }
    if (prior.ownerPersonaId !== undefined && prior.ownerPersonaId !== ownerPersonaId) {
      fail(
        "working_spec_owner_drift",
        "durable graph owner differs from the owner pinned at run creation",
      );
    }
    const source = await this.#workingSpecBaselineSource(run);
    const full = run.plan?.full ?? {};
    const planned = source.kind === "approved_plan";
    const baseline: WorkingSpecBaseline = {
      objective: run.objective,
      intake: Object.fromEntries(
        Object.entries(run.intake).sort(([left], [right]) => compareText(left, right)),
      ),
      acceptedPlan: planned
        ? {
            architecture: full.architecture ?? "",
            decisions: full.decisions ?? "",
            risk: full.risk ?? "",
            verification: full.verification ?? "",
          }
        : null,
      resolvedDecisions: planned
        ? (full.decisions ?? "")
        : "Direct approval preserves the objective and intake as the decision baseline.",
      verificationIntent: planned
        ? (full.verification ?? "")
        : `Verify the approved objective against its intake: ${Object.values(run.intake).join("; ")}`,
      source,
    };
    const guidance = JSON.stringify(
      {
        objective: baseline.objective,
        intake: baseline.intake,
        acceptedPlan: baseline.acceptedPlan,
        resolvedDecisions: baseline.resolvedDecisions,
        verificationIntent: baseline.verificationIntent,
      },
      null,
      2,
    );
    if (
      Buffer.byteLength(guidance, "utf8") > MAX_BASELINE_SPEC_BYTES ||
      guidance.includes("\u0000")
    ) {
      fail("working_spec_baseline_size", "canonical working-spec baseline is oversized or unsafe");
    }
    const rootNodes = graph
      .nodes()
      .filter((node) => node.annotations.run_root === true || node.title === run.objective);
    const affectedNodeIds = rootNodes.map((node) => node.id).sort(compareText);
    const repositoryPaths = [
      ...new Set(graph.nodes().flatMap((node) => graph.repositoryPaths(node.id))),
    ].sort(compareText);
    const baselineDigest = canonicalHash(baseline);
    const digest = workingSpecDigest({
      baselineDigest,
      guidance,
      affectedNodeIds,
      repositoryPaths,
    });
    const id = `spec-${digestBody(canonicalHash([run.id, 1, digest, source.artifactSha256])).slice(0, 24)}`;
    const record: WorkingSpecVersionRecord = {
      protocol: WORKING_SPEC_PROTOCOL,
      recordType: "working_spec",
      id,
      runId: run.id,
      generation: run.generation,
      ownerPersonaId,
      version: 1,
      digest,
      baselineDigest,
      baseline,
      guidance,
      affectedNodeIds,
      repositoryPaths,
      provenance: {
        kind: "baseline",
        runId: run.id,
        generation: run.generation,
        personaId: ownerPersonaId,
        semanticRevision,
        semanticHash: graph.hash,
        contextualRevision: prior.revision,
        contextualHash: prior.hash,
        recordedAt: this.#now().toISOString(),
      },
    };
    return appendContextualRecord(
      prior,
      record,
      [
        {
          sourceId: id,
          relation: "context_for",
          targetKind: "run_root",
          targetId: prior.runRootId,
        },
        ...affectedNodeIds.map((targetId): GraphContextualLink => ({
          sourceId: id,
          relation: "affects",
          targetKind: "semantic_node",
          targetId,
        })),
        ...repositoryPaths.map((targetId): GraphContextualLink => ({
          sourceId: id,
          relation: "references_path",
          targetKind: "repository_path",
          targetId,
        })),
      ],
      { canonicalWorkingSpecId: id, ownerPersonaId },
    );
  }

  async #workingSpecBaselineSource(run: RunRecord): Promise<WorkingSpecBaseline["source"]> {
    if (run.plan === undefined)
      fail("working_spec_source", "working-spec baseline has no approved plan source");
    if (run.planningMode === "direct") {
      const artifactPath = `runs/${run.id}/direct-approval.json`;
      let bytes: Buffer;
      try {
        bytes = await readFile(path.join(this.#stateRoot, artifactPath));
      } catch {
        fail("working_spec_source", "direct-approval source artifact is missing or unreadable");
      }
      if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024 || bytes.includes(0)) {
        fail("working_spec_source", "direct-approval source artifact is missing or unsafe");
      }
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("working_spec_source", "direct-approval source artifact is not valid JSON");
      }
      const sourcePlan = isRecord(value) && isRecord(value.plan) ? value.plan : undefined;
      if (
        !isRecord(value) ||
        value.protocol !== PLAN_ARTIFACT_PROTOCOL ||
        value.runId !== run.id ||
        value.directApproval !== true ||
        value.graphSha256 !== run.graphHash ||
        sourcePlan === undefined ||
        !isRecord(sourcePlan.full) ||
        !isRecord(sourcePlan.concise) ||
        sourcePlan.revision !== run.plan.revision ||
        canonicalHash(sourcePlan.full) !== canonicalHash(run.plan.full) ||
        canonicalHash(sourcePlan.concise) !== canonicalHash(run.plan.concise)
      )
        fail(
          "working_spec_source",
          "direct-approval source artifact failed its immutable compiler binding",
        );
      return {
        kind: "direct_approval",
        artifactPath,
        artifactSha256: rawSha256(bytes),
        planRevision: run.plan.revision,
      };
    }
    if (run.planningSession !== undefined) {
      const session = run.planningSession;
      const revision = session.revisions[session.currentRevision];
      const attempt = run.attempts[session.attemptId];
      if (
        !["approving", "approved"].includes(session.status) ||
        revision === undefined ||
        revision.revision !== session.currentRevision ||
        !["awaiting_review", "approved"].includes(revision.status) ||
        revision.artifactSha256 === undefined ||
        revision.graphSha256 === undefined ||
        revision.transcriptSha256 === undefined ||
        revision.checkpointPath === undefined ||
        run.plan.revision !== session.currentRevision ||
        revision.graphSha256 !== run.graphHash ||
        attempt === undefined ||
        attempt.kind !== "planning" ||
        attempt.id !== session.attemptId ||
        attempt.sessionId !== session.sessionId
      ) {
        fail("working_spec_source", "current continuous planning checkpoint is not approval-bound");
      }
      const artifactPath = revision.checkpointPath;
      const runRoot = path.resolve(this.#stateRoot, "runs", run.id);
      const resolvedArtifactPath = path.resolve(this.#stateRoot, artifactPath);
      if (!resolvedArtifactPath.startsWith(`${runRoot}${path.sep}`)) {
        fail("working_spec_source", "continuous planning checkpoint escapes its run root");
      }
      let bytes: Buffer;
      try {
        bytes = await readStableDurableFile(resolvedArtifactPath, {
          minimum: 1,
          maximum: MAX_CONTEXT_BYTES,
          label: `planning revision ${revision.revision} checkpoint`,
        });
      } catch (error) {
        fail(
          "working_spec_source",
          `continuous planning checkpoint is not durably readable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("working_spec_source", "continuous planning checkpoint is not valid JSON");
      }
      const artifact = planningArtifactBoundary(() => parsePlanningArtifact(value));
      if (
        canonicalHash(artifact) !== revision.artifactSha256 ||
        canonicalHash(artifact.full) !== canonicalHash(run.plan.full) ||
        canonicalHash(artifact.concise) !== canonicalHash(run.plan.concise) ||
        canonicalHash(artifact.graphSeed) !== canonicalHash(run.plan.graphSeed ?? null) ||
        (artifact.title ?? null) !== (run.plan.title ?? null)
      ) {
        fail(
          "working_spec_source",
          "continuous planning checkpoint failed its immutable compiler binding",
        );
      }
      return {
        kind: "approved_plan",
        artifactPath,
        artifactSha256: revision.artifactSha256,
        planRevision: revision.revision,
        attemptId: attempt.id,
      };
    }
    const candidates = Object.values(run.attempts)
      .filter((attempt) => attempt.kind === "planning" && attempt.terminalAcceptedAt !== undefined)
      .sort(
        (left, right) =>
          (right.terminalAcceptedAt ?? "").localeCompare(left.terminalAcceptedAt ?? "") ||
          compareText(left.id, right.id),
      );
    for (const attempt of candidates) {
      const artifactPath = `runs/${run.id}/attempts/${attempt.id}/planning-output.json`;
      let bytes: Buffer;
      try {
        bytes = await readFile(path.join(this.#stateRoot, artifactPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024 || bytes.includes(0))
        continue;
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
      } catch {
        continue;
      }
      const plan = isRecord(value) && isRecord(value.plan) ? value.plan : undefined;
      if (
        !isRecord(value) ||
        value.protocol !== PLAN_ARTIFACT_PROTOCOL ||
        value.runId !== run.id ||
        value.attemptId !== attempt.id ||
        value.graphSha256 !== run.graphHash ||
        plan === undefined ||
        !isRecord(plan.full) ||
        !isRecord(plan.concise) ||
        plan.revision !== run.plan.revision ||
        canonicalHash(plan.full) !== canonicalHash(run.plan.full) ||
        canonicalHash(plan.concise) !== canonicalHash(run.plan.concise) ||
        canonicalHash(plan.graphSeed ?? null) !== canonicalHash(run.plan.graphSeed ?? null)
      )
        continue;
      return {
        kind: "approved_plan",
        artifactPath,
        artifactSha256: rawSha256(bytes),
        planRevision: run.plan.revision,
        attemptId: attempt.id,
      };
    }
    fail("working_spec_source", "final compiler-accepted planning source artifact is unavailable");
  }

  public async executeAgentTool(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    grant: AuthorityGrant;
    spec?: Readonly<AgentLaunchSpec>;
    call: KoniToolInvocation;
  }): Promise<AgentToolCompilation> {
    const { run, attempt, grant, call } = input;
    const spec = input.spec ?? this.#issuedSpecs.get(attempt.id);
    if (spec === undefined)
      fail("agent_tool_spec", "agent tool request has no authenticated launch specification");
    assertAgentToolIdentity(run, attempt, grant);
    assertRecoveryIdentity(run, attempt, spec);
    const pinned = await this.#loadPinned(run);
    const descriptor = await this.#descriptorForRecordedAttempt(run, attempt, pinned.configuration);
    const graphRead = await this.#readContextGraph(run, pinned.configuration);
    const contextual = this.#contextualState(run, graphRead.artifact);
    if (call.name === "koni_graph_context") {
      if (!grant.allowedTools.includes(call.name)) {
        fail("graph_context_scope", "this attempt has no compiler-issued graph context authority");
      }
      const request = parseDynamicGraphSelectionRequest(call.arguments);
      const dynamic = await this.selectDynamicGraphContext({ run, attempt, spec, request });
      const semantic = dynamic.envelope.records.filter((record) => record.kind === "semantic_node");
      const ids = new Set(semantic.map((record) => record.id));
      const value = {
        protocol: "koni.graph-context.v1" as const,
        graphSha256: dynamic.envelope.binding.semanticHash,
        graphRevision: dynamic.envelope.binding.semanticRevision,
        contextualSha256: dynamic.envelope.binding.contextualHash,
        contextualRevision: dynamic.envelope.binding.contextualRevision,
        anchors: [
          ...new Set(
            request.anchors ?? descriptor.definition?.target_node_ids ?? descriptor.readNodeIds,
          ),
        ].sort(compareText),
        nodes: semantic.map((record) => record.node),
        edges: graphRead.graph
          .edges()
          .filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
        contextualRecords: dynamic.envelope.records.filter(
          (record) => record.kind !== "semantic_node",
        ),
        dynamicEnvelopeHash: dynamic.envelopeHash,
        selection: dynamic.envelope.selection,
        budget: dynamic.envelope.budget,
      };
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_GRAPH_CONTEXT_BYTES) {
        fail("graph_context_size", "graph context response exceeds its compiler result bound");
      }
      return {
        summary: `Returned ${value.nodes.length} scoped graph nodes and current contextual guidance`,
        value: value as unknown as JsonValue,
      };
    }
    if (call.name === "koni_update_working_spec") {
      if (
        attempt.personaId !== run.workingSpecOwnerId ||
        contextual.ownerPersonaId !== run.workingSpecOwnerId
      ) {
        fail(
          "working_spec_owner",
          "only the working-spec owner pinned at run creation may update the canonical version",
        );
      }
      const canonicalId = contextual.canonicalWorkingSpecId;
      const current = canonicalId === undefined ? undefined : contextual.records[canonicalId];
      if (current?.recordType !== "working_spec") {
        fail("working_spec_missing", "run has no initialized canonical working-spec baseline");
      }
      const expectedRevision = requiredToolInteger(call.arguments, "expectedContextualRevision");
      const expectedDigest = requireDigest(
        call.arguments.expectedCanonicalDigest,
        "expected canonical working-spec digest",
      );
      if (expectedRevision !== contextual.revision || expectedDigest !== current.digest) {
        fail("working_spec_cas", "working-spec contextual revision or canonical digest is stale");
      }
      const guidanceArg = optionalToolString(call.arguments, "guidance");
      const contentArg = optionalToolString(call.arguments, "content");
      if ((guidanceArg === undefined) === (contentArg === undefined)) {
        fail(
          "working_spec_shape",
          "working-spec update requires exactly one guidance/content field",
        );
      }
      const guidance = boundedText(
        guidanceArg ?? contentArg,
        "working-spec guidance",
        MAX_WORKING_SPEC_BYTES,
      );
      const requestedNodeIds = optionalToolStringArray(call.arguments, "affectedNodeIds");
      const affectedNodeIds = [...new Set(requestedNodeIds ?? current.affectedNodeIds)].sort(
        compareText,
      );
      const visibleNodes = new Set([...descriptor.readNodeIds, ...descriptor.writeNodeIds]);
      for (const nodeId of affectedNodeIds) {
        if (graphRead.graph.node(nodeId) === undefined) {
          fail(
            "working_spec_scope",
            `working-spec update references missing semantic node ${nodeId}`,
          );
        }
        if (requestedNodeIds !== undefined && !visibleNodes.has(nodeId)) {
          fail(
            "working_spec_scope",
            `working-spec update expands beyond compiler-visible node ${nodeId}`,
          );
        }
      }
      const requestedPaths = optionalToolStringArray(call.arguments, "paths");
      const repositoryPaths =
        requestedPaths === undefined
          ? [...current.repositoryPaths]
          : normalizeReferencedPaths(requestedPaths, grant, "working-spec");
      const baselineDigest = current.baselineDigest;
      const digest = workingSpecDigest({
        baselineDigest,
        guidance,
        affectedNodeIds,
        repositoryPaths,
      });
      const version = current.version + 1;
      const recordedAt = this.#now().toISOString();
      const id = `spec-${digestBody(canonicalHash([run.id, version, digest, attempt.id, call.callId])).slice(0, 24)}`;
      const record: WorkingSpecVersionRecord = {
        protocol: WORKING_SPEC_PROTOCOL,
        recordType: "working_spec",
        id,
        runId: run.id,
        generation: run.generation,
        ownerPersonaId: attempt.personaId,
        version,
        digest,
        baselineDigest,
        baseline: structuredClone(current.baseline),
        guidance,
        affectedNodeIds: [...affectedNodeIds],
        repositoryPaths,
        supersedes: current.id,
        provenance: contextualProvenance(
          "owner_update",
          run,
          attempt,
          spec,
          graphRead.artifact.revision,
          graphRead.graph.hash,
          contextual,
          recordedAt,
        ),
      };
      const nextContext = appendContextualRecord(
        contextual,
        record,
        [
          {
            sourceId: id,
            relation: "context_for",
            targetKind: "run_root",
            targetId: contextual.runRootId,
          },
          {
            sourceId: id,
            relation: "supersedes",
            targetKind: "context_record",
            targetId: current.id,
          },
          ...affectedNodeIds.map((targetId): GraphContextualLink => ({
            sourceId: id,
            relation: "affects",
            targetKind: "semantic_node",
            targetId,
          })),
          ...repositoryPaths.map((targetId): GraphContextualLink => ({
            sourceId: id,
            relation: "references_path",
            targetKind: "repository_path",
            targetId,
          })),
        ],
        { canonicalWorkingSpecId: id, ownerPersonaId: attempt.personaId },
      );
      this.#dynamicContextSelector.clear();
      return {
        summary: `Working specification advanced to version ${version}`,
        value: {
          workingSpecId: id,
          version,
          digest,
          contextualRevision: nextContext.revision,
          contextualHash: nextContext.hash,
          supersedes: current.id,
        },
        artifactWrites: [
          {
            path: graphArtifactPath(run.id),
            bytes: encodeRunGraphArtifact(
              graphArtifact(
                run,
                pinned.configuration,
                graphRead.graph,
                graphRead.artifact.revision,
                nextContext,
              ),
            ),
            expectedSha256: graphRead.bytesSha256,
          },
        ],
      };
    }
    if (call.name === "koni_record_note") {
      if (!grant.allowedTools.includes(call.name)) {
        fail("graph_note_scope", "this attempt has no compiler-issued graph note authority");
      }
      const targetId = requiredToolString(call.arguments, "nodeId");
      const isRunRoot = targetId === contextual.runRootId;
      const visibleNodes = new Set([...descriptor.readNodeIds, ...descriptor.writeNodeIds]);
      const node = isRunRoot ? undefined : graphRead.graph.node(targetId);
      if (!isRunRoot && (node === undefined || !visibleNodes.has(targetId))) {
        fail("graph_note_scope", `node ${targetId} is not compiler-visible to this attempt`);
      }
      const kind = requiredToolString(call.arguments, "kind");
      if (!isGraphNoteKind(kind)) fail("graph_note_kind", `unsupported advisory note kind ${kind}`);
      const body = boundedText(
        requiredToolString(call.arguments, "body"),
        "graph note body",
        1024 * 1024,
      );
      const repositoryPaths = normalizeReferencedPaths(
        optionalToolStringArray(call.arguments, "paths") ?? [],
        grant,
        "graph note",
      );
      const supersedes = optionalToolString(call.arguments, "supersedes");
      const existingNativeNotes = Object.values(contextual.records).filter(
        (record): record is GraphChangeNoteRecord => record.recordType === "change_note",
      );
      const legacyNotes = await this.#readGraphNotes(run);
      if (supersedes !== undefined) {
        const prior =
          existingNativeNotes.find((note) => note.id === supersedes) ??
          legacyNotes.find((note) => note.id === supersedes);
        if (prior === undefined)
          fail("graph_note_lineage", `superseded graph note ${supersedes} is missing`);
        const priorSubject =
          prior.protocol === LEGACY_GRAPH_NOTE_PROTOCOL
            ? { kind: "semantic_node" as const, id: prior.nodeId }
            : prior.subject;
        const subjectKind = isRunRoot ? "run_root" : "semantic_node";
        if (priorSubject.kind !== subjectKind || priorSubject.id !== targetId) {
          fail(
            "graph_note_lineage",
            "a graph note may supersede only the same node/run-root subject",
          );
        }
        if ([...existingNativeNotes, ...legacyNotes].some((note) => note.supersedes === prior.id)) {
          fail("graph_note_lineage", `graph note ${prior.id} already has a superseding successor`);
        }
      }
      const recordedAt = this.#now().toISOString();
      const id = `note-${digestBody(
        canonicalHash([
          run.id,
          run.generation,
          attempt.id,
          call.callId,
          targetId,
          kind,
          body,
          repositoryPaths,
          supersedes ?? null,
          graphRead.graph.hash,
          contextual.hash,
        ]),
      ).slice(0, 24)}`;
      const note: GraphChangeNoteRecord = {
        protocol: GRAPH_CHANGE_NOTE_PROTOCOL,
        recordType: "change_note",
        id,
        runId: run.id,
        generation: run.generation,
        subject: { kind: isRunRoot ? "run_root" : "semantic_node", id: targetId },
        kind,
        body,
        repositoryPaths,
        targetNodeHashes: node === undefined ? {} : { [node.id]: canonicalHash(node) },
        ...(supersedes === undefined ? {} : { supersedes }),
        provenance: contextualProvenance(
          "change_note",
          run,
          attempt,
          spec,
          graphRead.artifact.revision,
          graphRead.graph.hash,
          contextual,
          recordedAt,
        ),
      };
      const nextContext = appendContextualRecord(contextual, note, [
        {
          sourceId: id,
          relation: "context_for",
          targetKind: isRunRoot ? "run_root" : "semantic_node",
          targetId,
        },
        ...repositoryPaths.map((path): GraphContextualLink => ({
          sourceId: id,
          relation: "references_path",
          targetKind: "repository_path",
          targetId: path,
        })),
        ...(supersedes === undefined
          ? []
          : [
              {
                sourceId: id,
                relation: "supersedes" as const,
                targetKind: "context_record" as const,
                targetId: supersedes,
              },
            ]),
      ]);
      this.#dynamicContextSelector.clear();
      return {
        summary: `Recorded ${kind} on ${node?.title ?? "run root"}`,
        value: {
          noteId: id,
          nodeId: targetId,
          kind,
          status: "working",
          contextualRevision: nextContext.revision,
          contextualHash: nextContext.hash,
        },
        activity: [
          {
            id: `activity-${digestBody(canonicalHash([run.id, run.revision, id])).slice(0, 20)}`,
            at: recordedAt,
            kind: "agent",
            message: `${attempt.personaId} noted ${node === undefined ? "run root" : `${node.type}: ${node.title}`}`,
            ticketId: attempt.ticketId,
            nodeId: node?.id,
          },
        ],
        artifactWrites: [
          {
            path: graphArtifactPath(run.id),
            bytes: encodeRunGraphArtifact(
              graphArtifact(
                run,
                pinned.configuration,
                graphRead.graph,
                graphRead.artifact.revision,
                nextContext,
              ),
            ),
            expectedSha256: graphRead.bytesSha256,
          },
        ],
      };
    }
    fail("tool_unsupported", `${call.name} is not a compiler-owned graph tool`);
  }

  public async resolveAgentCheck(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    checkId: string;
  }): Promise<ResolvedAgentCheck> {
    const pinned = await this.#loadPinned(input.run);
    const descriptor = await this.#descriptorForRecordedAttempt(
      input.run,
      input.attempt,
      pinned.configuration,
    );
    const configuredIds = new Set([
      ...(descriptor.step?.validation_checks ?? []),
      ...(descriptor.gatePolicyContexts ?? []).map((binding) => binding.checkId),
    ]);
    if (descriptor.step === undefined || !configuredIds.has(input.checkId)) {
      fail(
        "check_scope",
        `check ${input.checkId} is outside this step's exact configured validation checks`,
      );
    }
    if (descriptor.graph === undefined)
      fail("check_graph", "configured checks require a compiler-bound graph epoch");
    if (descriptor.executionPolicyBinding === undefined)
      fail("check_execution_policy", "configured check has no pinned step policy");
    return resolveConfiguredAgentCheck({
      configuration: pinned.configuration,
      executionCatalog: requireExecutionSemanticCatalog(pinned.configuration),
      executionPolicyBinding: descriptor.executionPolicyBinding,
      gatePolicyContexts: descriptor.gatePolicyContexts ?? [],
      graph: descriptor.graph,
      descriptor,
      projectRoot: attemptWorkspace(
        input.run,
        recordedAttemptWorkspaceKind(input.attempt),
        input.attempt.ticketId,
      ),
      requestedCheckId: input.checkId,
    });
  }

  public async compileAgentCheckResult(input: {
    run: RunRecord;
    attempt: AgentAttemptRecord;
    check: ResolvedAgentCheck;
    executions: AgentCheckExecution[];
  }): Promise<CompiledAgentCheckResult> {
    const pinned = await this.#loadPinned(input.run);
    const descriptor = await this.#descriptorForRecordedAttempt(
      input.run,
      input.attempt,
      pinned.configuration,
    );
    const configuredIds = new Set([
      ...(descriptor.step?.validation_checks ?? []),
      ...(descriptor.gatePolicyContexts ?? []).map((binding) => binding.checkId),
    ]);
    if (descriptor.step === undefined || !configuredIds.has(input.check.requestedCheckId)) {
      fail(
        "check_scope",
        `check ${input.check.requestedCheckId} is outside this step's exact configured validation checks`,
      );
    }
    if (descriptor.graph === undefined)
      fail("check_graph", "configured checks require a compiler-bound graph epoch");
    if (descriptor.executionPolicyBinding === undefined)
      fail("check_execution_policy", "configured check has no pinned step policy");
    const resolved = await resolveConfiguredAgentCheck({
      configuration: pinned.configuration,
      executionCatalog: requireExecutionSemanticCatalog(pinned.configuration),
      executionPolicyBinding: descriptor.executionPolicyBinding,
      gatePolicyContexts: descriptor.gatePolicyContexts ?? [],
      graph: descriptor.graph,
      descriptor,
      projectRoot: attemptWorkspace(
        input.run,
        recordedAttemptWorkspaceKind(input.attempt),
        input.attempt.ticketId,
      ),
      requestedCheckId: input.check.requestedCheckId,
    });
    if (canonicalHash(resolved) !== canonicalHash(input.check)) {
      fail(
        "check_resolution_drift",
        "configured check resolution changed before its result was compiled",
      );
    }
    if (input.executions.length !== resolved.commands.length) {
      fail(
        "check_execution_count",
        "configured check execution count does not match its compiler plan",
      );
    }
    const compiled = resolved.commands.map((command, index) =>
      compileCheckCommandExecution(
        command,
        input.executions[index]!,
        index,
        pinned.configuration,
        descriptor,
      ),
    );
    const accepted = compiled.every((result) => result.accepted);
    let passed = compiled.every((result) => result.passed);
    const infrastructureFailure = compiled.find(
      (result) => result.infrastructureFailure !== undefined,
    )?.infrastructureFailure;
    if (resolved.kind === "graph") {
      passed = await evaluateRequestedGraphCheck(
        pinned.configuration,
        descriptor.graph,
        attemptWorkspace(
          input.run,
          recordedAttemptWorkspaceKind(input.attempt),
          input.attempt.ticketId,
        ),
        resolved.requestedCheckId,
        descriptor.definition?.target_node_ids ?? descriptor.readNodeIds,
      );
    }
    const inputGraphSha256 = ruleInputGraphSha256(pinned.configuration, descriptor.graph);
    const evidenceId = `check-evidence-${digestBody(
      canonicalHash([input.run.id, input.attempt.id, resolved, input.executions, inputGraphSha256]),
    ).slice(0, 24)}`;
    const evidenceArtifact = {
      protocol: "koni.agent-check-execution-evidence.v1",
      id: evidenceId,
      configurationSha256: pinned.configuration.configuration_sha256,
      inputGraphSha256,
      graphRevision: input.run.graphRevision,
      graphSha256: descriptor.graph.hash,
      runId: input.run.id,
      ticketId: input.attempt.ticketId,
      stepId: input.attempt.stepId,
      attemptId: input.attempt.id,
      requestedCheckId: resolved.requestedCheckId,
      resolvedCheckSha256: canonicalHash(resolved),
      executionPolicy: structuredClone(resolved.executionPolicy),
      accepted,
      passed,
      commands: compiled.map((result) => result.evidence),
      recordedAt: this.#now().toISOString(),
    };
    const envelope = mergeCheckRuleEvidence({
      prior: runRuleEvidence(
        input.run,
        pinned.configuration.configuration_sha256,
        inputGraphSha256,
      ),
      configuration: pinned.configuration,
      graph: descriptor.graph,
      descriptor,
      resolved,
      accepted,
      passed,
      evidenceId,
      recordedAt: evidenceArtifact.recordedAt,
    });
    const evidenceRun = structuredClone(input.run);
    evidenceRun.ruleAuthorityEvidence = envelope as unknown as JsonValue;
    const evaluation = requireValidation(
      await this.#evaluateRules(evidenceRun, pinned.configuration, descriptor.graph),
      "rule_compilation_failed",
      "accepted check evidence did not compile into a valid ticket board",
    );
    const definitionsRead = await this.#readTicketDefinitions(input.run, pinned.configuration);
    const tickets = reconcileTickets(
      input.run,
      evaluation.tickets,
      requireExecutionSemanticCatalog(pinned.configuration),
      this.#now().toISOString(),
      this.#projectRoot,
      await recurringAssetReissueNodeIds(
        input.run,
        pinned.configuration,
        descriptor.graph,
        evaluation,
        input.run.git.run.worktree,
      ),
      integrationOperation(pinned.configuration, input.run.runTypeId),
    );
    const definitions = ticketArtifact(
      input.run,
      input.run.graphRevision,
      evaluation,
      definitionsRead.value,
    );
    // A nonpassing run whose streams are byte-identical to an earlier run of the same check in
    // this attempt is deterministic: re-running without changing any input is a no-op (observed
    // live: many consecutive identical re-runs burning turns). Say so in the receipt the agent
    // reads, so it iterates on the inputs or reports the blocker instead of retrying.
    const deterministicRepeat =
      !passed &&
      (input.run.checks ?? []).some(
        (record) =>
          record.attemptId === input.attempt.id &&
          record.requestedCheckId === resolved.requestedCheckId &&
          record.passed !== true &&
          record.commands.length === compiled.length &&
          record.commands.every((prior, index) => {
            const next = compiled[index]!.evidence as Record<string, unknown>;
            return (
              prior.exitCode === next.exitCode &&
              prior.stdoutSha256 === next.stdoutSha256 &&
              prior.stderrSha256 === next.stderrSha256
            );
          }),
      );
    const repeatNote = deterministicRepeat
      ? " — byte-identical to a previous run of this check in this attempt; the failure is deterministic, so re-running without changing its inputs cannot change the result"
      : "";
    const rejectionDiagnostics = compiled
      .flatMap((result, commandIndex) => {
        const value = isRecord(result.value) ? result.value : undefined;
        const errors = Array.isArray(value?.errors) ? value.errors : [];
        return errors
          .filter((error): error is string => typeof error === "string" && error.length > 0)
          .map((error) => `command ${commandIndex}: ${error.slice(0, 512)}`);
      })
      .slice(0, 8);
    const rejectionDetail =
      !accepted && rejectionDiagnostics.length > 0 ? `: ${rejectionDiagnostics.join("; ")}` : "";
    return {
      accepted,
      passed,
      ...(infrastructureFailure === undefined ? {} : { infrastructureFailure }),
      summary:
        (accepted
          ? `${resolved.requestedCheckId} ${passed ? "passed" : "recorded a nonpassing result"}`
          : `${resolved.requestedCheckId} failed its configured result contract${rejectionDetail}`) +
        repeatNote,
      value: {
        requestedCheckId: resolved.requestedCheckId,
        accepted,
        passed,
        evidenceId,
        executionPolicy: structuredClone(resolved.executionPolicy) as unknown as JsonValue,
        commands: compiled.map((result) => result.value),
      },
      evidence: evidenceArtifact as unknown as JsonValue,
      ruleAuthorityEvidence: envelope as unknown as JsonValue,
      tickets,
      activity: [
        {
          id: `activity-${digestBody(canonicalHash([input.run.id, input.run.revision, evidenceId])).slice(0, 20)}`,
          at: evidenceArtifact.recordedAt,
          kind: "compiler",
          message: `${resolved.requestedCheckId} ${passed ? "passed" : accepted ? "recorded a nonpassing result" : "failed validation"}`,
          ticketId: input.attempt.ticketId,
          nodeId: undefined,
        },
      ],
      artifactWrites: [
        {
          path: ticketDefinitionsPath(input.run.id),
          bytes: encodeArtifact(definitions),
          expectedSha256: definitionsRead.bytesSha256,
        },
      ],
    };
  }

  public async projectGraph(
    run: RunRecord,
    ticketId?: string,
  ): Promise<{
    nodes: GraphNode[];
    edges: GraphEdge[];
  }> {
    const pinned = await this.#loadPinned(run);
    const graph = (await this.#readGraph(run, pinned.configuration)).graph;
    if (ticketId === undefined) return { nodes: graph.nodes(), edges: graph.edges() };
    const ticket = run.tickets[ticketId];
    if (ticket === undefined)
      fail("ticket_missing", `ticket ${ticketId} does not exist in run ${run.id}`);
    const selected = new Set<string>();
    for (const nodeId of [...ticket.targetNodeIds].sort(compareText)) {
      if (graph.node(nodeId) === undefined) continue;
      selected.add(nodeId);
      for (const neighbor of graph.neighbors(nodeId)) selected.add(neighbor.id);
    }
    const ids = [...selected].sort(compareText).slice(0, 256);
    const bounded = new Set(ids);
    return {
      nodes: ids.flatMap((id) => {
        const node = graph.node(id);
        return node === undefined ? [] : [node];
      }),
      edges: graph.edges().filter((edge) => bounded.has(edge.source) && bounded.has(edge.target)),
    };
  }

  async #evaluateRules(
    run: RunRecord,
    configuration: CompiledConfiguration,
    graph: TypedGraph,
    options: RuleEvaluationOptions = {},
  ): Promise<ValidationResult<CompiledRuleEvaluation>> {
    const inputGraphSha256 = ruleInputGraphSha256(configuration, graph);
    const durableEvidence = runRuleEvidence(
      run,
      configuration.configuration_sha256,
      inputGraphSha256,
    );
    const injectedEvidence =
      this.#ruleAuthorityEvidence === undefined
        ? undefined
        : await this.#ruleAuthorityEvidence(
            deepFreeze({
              run: structuredClone(run),
              configuration,
              inputGraphSha256,
              graphNodes: graph.nodes(),
            }),
          );
    if (
      durableEvidence !== undefined &&
      injectedEvidence !== undefined &&
      canonicalHash(durableEvidence) !== canonicalHash(injectedEvidence)
    ) {
      fail("rule_evidence_conflict", "durable and injected rule-authority evidence disagree");
    }
    const evidence = await this.#proofPreparationRuleEvidence({
      run,
      configuration,
      graph,
      prior: durableEvidence ?? injectedEvidence,
      ...options,
    });
    const adapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: path.resolve(options.projectRoot ?? run.git.run.worktree),
      ...(evidence === undefined ? {} : { evidence }),
    });
    const evaluated = evaluateConfiguredRules({ configuration, graph }, { adapter });
    if (!evaluated.ok) return evaluated;
    const scientificDefinitions = scientificRunTicketDefinitions(graph, evaluated.value.tickets);
    const compatibleEvaluation =
      scientificDefinitions.length === evaluated.value.tickets.length
        ? evaluated.value
        : rehashRuleEvaluation(evaluated.value, scientificDefinitions);
    const withStandaloneSupportRuns = researchStandaloneSupportRunFallback(
      configuration,
      graph,
      compatibleEvaluation,
      adapter,
      Object.values(run.tickets),
    );
    const withRunContractScope = researchRunContractScopeFallback(graph, withStandaloneSupportRuns);
    const withBlockedGateRechecks = repairedProviderBlockedDirectGateFallback(
      configuration,
      graph,
      withRunContractScope,
    );
    const repaired = await generatedAssetImplementationFallback(
      run,
      configuration,
      graph,
      withBlockedGateRechecks,
      options.projectRoot ?? run.git.run.worktree,
    );
    const withAssetCompatibility = repaired ?? withBlockedGateRechecks;
    const withRunPlanCompatibility = researchConstitutionRunPlanFallback(
      configuration,
      graph,
      withAssetCompatibility,
    );
    return withRunPlanCompatibility === evaluated.value
      ? evaluated
      : { ...evaluated, value: withRunPlanCompatibility };
  }

  /**
   * Project the one dynamic rule fact whose authority spans model attempts and filesystem bytes.
   *
   * A prepared proof is not current merely because its graph status says `prepared`. The fact is
   * reconstructed from the newest exact preparation review, its immutable launch/context, the
   * reviewed historical check, and the current proof-source manifest. Any newer failed or
   * differently-targeted review supersedes the older fact. This is the TypeScript counterpart of
   * the legacy Rust `CurrentProofPreparationBinding` boundary.
   */
  async #proofPreparationRuleEvidence(input: {
    run: RunRecord;
    configuration: CompiledConfiguration;
    graph: TypedGraph;
    prior: RuleAuthorityEvidence | undefined;
    selfPreparationReviewAttemptId?: string;
  }): Promise<RuleAuthorityEvidence | undefined> {
    const leaves = collectProofPreparationLeaves(input.configuration);
    if (leaves.length === 0) return input.prior;
    const inputGraphSha256 = ruleInputGraphSha256(input.configuration, input.graph);
    const predicates = Object.fromEntries(
      Object.entries(input.prior?.predicates ?? {}).filter(
        ([, evidence]) => evidence.leaf?.op !== "proof_preparation_current",
      ),
    ) as Record<Sha256Digest, RulePredicateEvidence>;
    const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph);
    const attemptOrder = new Map(Object.keys(input.run.attempts).map((id, index) => [id, index]));
    const currentByBinding = new Map<Sha256Digest, Promise<boolean>>();

    for (const subject of input.graph.nodes()) {
      for (const leaf of leaves) {
        const bindingNames = [...rulePredicateBindingNames(leaf)].sort(compareText);
        if (bindingNames.length === 0) continue;
        const bindings = Object.fromEntries(bindingNames.map((name) => [name, [subject.id]]));
        let expectedTargets: readonly string[];
        try {
          expectedTargets = withRuleBindings(evaluator, bindings, () =>
            evaluator.select(leaf.preparation_targets as ConfigurationValue),
          );
        } catch {
          continue;
        }
        if (!expectedTargets.includes(subject.id)) continue;
        const operationId = optionalString(leaf.preparation_operation);
        const checkId = optionalString(leaf.check);
        if (operationId === undefined || checkId === undefined) continue;
        const operation = input.configuration.registries.operations[operationId];
        if (operation?.proof_source_preparation_check !== checkId) continue;
        const candidate = latestReviewCandidate(input.run, operationId, subject.id, attemptOrder);
        if (
          candidate === undefined ||
          canonicalHash(candidate.ticket.targetNodeIds) !== canonicalHash(expectedTargets)
        )
          continue;
        const bindingKey = canonicalHash({
          operationId,
          checkId,
          subjectId: subject.id,
          expectedTargets,
          candidateAttemptId: candidate.attempt.id,
          selfPreparationReviewAttemptId: input.selfPreparationReviewAttemptId ?? null,
        });
        let currentPromise = currentByBinding.get(bindingKey);
        if (currentPromise === undefined) {
          currentPromise = this.#proofPreparationCandidateCurrent({
            ...input,
            subject,
            leaf,
            expectedTargets,
            candidate,
          });
          currentByBinding.set(bindingKey, currentPromise);
        }
        const current = await currentPromise;
        if (!current) continue;
        const key = rulePredicateEvidenceKey({
          configurationSha256: input.configuration.configuration_sha256,
          inputGraphSha256,
          leaf,
          subjectNodeId: subject.id,
          bindings,
        });
        predicates[key] = {
          key,
          result: true,
          recordedAt:
            candidate.attempt.terminalAcceptedAt ??
            candidate.attempt.endedAt ??
            this.#now().toISOString(),
          sourceReceiptIds: [
            candidate.attempt.id,
            ...(candidate.attempt.terminalPolicy === undefined
              ? []
              : [candidate.attempt.terminalPolicy.sha256]),
          ],
          leaf: structuredClone(leaf),
          subjectNodeId: subject.id,
          bindings,
        };
      }
    }
    return createRuleAuthorityEvidence({
      protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
      configurationSha256: input.configuration.configuration_sha256,
      inputGraphSha256,
      predicates,
    });
  }

  async #proofPreparationCandidateCurrent(input: {
    run: RunRecord;
    configuration: CompiledConfiguration;
    graph: TypedGraph;
    subject: GraphNode;
    leaf: ConfigurationObject;
    expectedTargets: readonly string[];
    candidate: ProofPreparationReviewCandidate;
    selfPreparationReviewAttemptId?: string;
  }): Promise<boolean> {
    return (await this.#authenticatedProofPreparationCurrent(input)) !== undefined;
  }

  async #authenticatedProofPreparationCurrent(input: {
    run: RunRecord;
    configuration: CompiledConfiguration;
    graph: TypedGraph;
    subject: GraphNode;
    leaf: ConfigurationObject;
    expectedTargets: readonly string[];
    candidate: ProofPreparationReviewCandidate;
    selfPreparationReviewAttemptId?: string;
  }): Promise<AuthenticatedProofPreparationCurrent | undefined> {
    const self = input.selfPreparationReviewAttemptId === input.candidate.attempt.id;
    if (input.selfPreparationReviewAttemptId !== undefined && !self) return undefined;
    const snapshot = await this.#authenticatedReviewSnapshot({
      run: input.run,
      configuration: input.configuration,
      candidate: input.candidate,
      allowTerminalAccepted: self,
    });
    if (
      snapshot === undefined ||
      snapshot.definition.operation_registry_id !== input.leaf.preparation_operation ||
      canonicalHash(snapshot.definition.target_node_ids) !== canonicalHash(input.expectedTargets)
    )
      return undefined;
    const reviewedSubject = snapshot.reviewedNodes.find((node) => node.id === input.subject.id);
    if (reviewedSubject === undefined) return undefined;
    const baseline = this.#historicalPreparationBaseline({
      run: input.run,
      configuration: input.configuration,
      candidate: input.candidate,
      snapshot,
      reviewedSubject,
      checkId: requiredNonempty(input.leaf.check, "proof preparation check"),
    });
    if (baseline === undefined) return undefined;
    const roots = stringArray(
      baseline.sourceManifest.roots,
      "proof preparation source manifest roots",
    );
    const workspace = self
      ? (input.candidate.ticket.worktreePath ??
        attemptWorkspace(input.run, "ticket", input.candidate.ticket.id))
      : input.run.git.run.worktree;
    let currentManifest;
    try {
      currentManifest = await snapshotContainedPaths(workspace, roots);
    } catch {
      return undefined;
    }
    if (
      currentManifest.entries.some((entry) => entry.kind === "missing") ||
      canonicalHash(currentManifest.roots) !== canonicalHash(baseline.sourceManifest.roots) ||
      canonicalHash(sourceByteEntries(currentManifest.entries)) !==
        canonicalHash(sourceByteEntries(baseline.sourceManifest.entries))
    )
      return undefined;

    const prepared = projectPassedReviewEffects(
      input.configuration,
      snapshot.definition.operation_registry_id,
      reviewedSubject,
      input.candidate.attempt.id,
      input.candidate.attempt.personaId,
    );
    if (prepared === undefined) return undefined;
    if (canonicalHash(prepared) === canonicalHash(input.subject)) {
      return {
        snapshot,
        reviewedSubject,
        ...baseline,
        currentVia: "preparation_review",
      };
    }
    if (
      !(await this.#reviewEffectSuccessorCurrent({
        run: input.run,
        configuration: input.configuration,
        subjectId: input.subject.id,
        prepared,
        current: input.subject,
        excludedAttemptId: input.candidate.attempt.id,
      }))
    )
      return undefined;
    return {
      snapshot,
      reviewedSubject,
      ...baseline,
      currentVia: "review_effect_successor",
    };
  }

  #historicalPreparationBaseline(input: {
    run: RunRecord;
    configuration: CompiledConfiguration;
    candidate: ProofPreparationReviewCandidate;
    snapshot: AuthenticatedReviewSnapshot;
    reviewedSubject: GraphNode;
    checkId: string;
  }):
    | Omit<AuthenticatedProofPreparationCurrent, "snapshot" | "reviewedSubject" | "currentVia">
    | undefined {
    const baselineSteps = input.snapshot.definition.workflow.filter(
      (step) =>
        step.required && step.kind !== "review" && step.validation_checks.includes(input.checkId),
    );
    if (baselineSteps.length !== 1) return undefined;
    const baselineStep = baselineSteps[0]!;
    if (
      !input.snapshot.step.depends_on.includes(baselineStep.id) ||
      baselineStep.persona_id === input.snapshot.step.persona_id
    )
      return undefined;
    const predecessorEnvelope = optionalRecord(input.snapshot.context.predecessorExecution);
    if (
      predecessorEnvelope?.protocol !== "koni.review-predecessor-execution.v1" ||
      predecessorEnvelope.ticketId !== input.candidate.ticket.id ||
      predecessorEnvelope.reviewStepId !== input.candidate.step.id ||
      !Array.isArray(predecessorEnvelope.predecessors)
    )
      return undefined;
    const predecessors = predecessorEnvelope.predecessors
      .map((value) => optionalRecord(value))
      .filter((value): value is ConfigurationObject => value?.stepId === baselineStep.id);
    if (predecessors.length !== 1) return undefined;
    const predecessor = predecessors[0]!;
    const attemptId = optionalString(predecessor.attemptId);
    const attempt = attemptId === undefined ? undefined : input.run.attempts[attemptId];
    const durableStep = input.candidate.ticket.steps.find((step) => step.id === baselineStep.id);
    if (
      attempt === undefined ||
      durableStep === undefined ||
      !durableStep.attemptIds.includes(attempt.id) ||
      attempt.stepId !== baselineStep.id ||
      attempt.ticketId !== input.candidate.ticket.id ||
      attempt.personaId !== baselineStep.persona_id ||
      attempt.status !== "completed" ||
      attempt.terminalPolicy?.mode !== "semantic"
    )
      return undefined;
    const checks = Array.isArray(predecessor.checks)
      ? predecessor.checks
          .map((value) => optionalRecord(value))
          .filter((value): value is ConfigurationObject => value !== undefined)
      : [];
    const matchingChecks = checks.filter(
      (check) =>
        check.requestedCheckId === input.checkId &&
        check.accepted === true &&
        check.passed === true,
    );
    if (matchingChecks.length !== 1) return undefined;
    const projectedCheck = matchingChecks[0]!;
    const durableChecks = (input.run.checks ?? []).filter(
      (check) =>
        check.attemptId === attempt.id &&
        check.requestedCheckId === input.checkId &&
        check.accepted &&
        check.passed === true &&
        check.evidenceSha256 === projectedCheck.evidenceSha256 &&
        check.recordedAt === projectedCheck.recordedAt,
    );
    if (durableChecks.length !== 1 || !Array.isArray(projectedCheck.commands)) return undefined;
    const sourcePaths = [
      ...new Set([
        ...stringArray(input.reviewedSubject.spec.source_paths, "prepared proof source_paths"),
        ...(input.reviewedSubject.spec.support_paths === undefined
          ? []
          : stringArray(input.reviewedSubject.spec.support_paths, "prepared proof support_paths")),
      ]),
    ].sort(compareText);
    const manifests: ConfigurationObject[] = [];
    for (const projectedCommandValue of projectedCheck.commands) {
      const projectedCommand = optionalRecord(projectedCommandValue);
      const sourceManifest = optionalRecord(projectedCommand?.sourceManifest);
      if (projectedCommand === undefined || sourceManifest === undefined) continue;
      const durableCommand = durableChecks[0]!.commands.find(
        (command) =>
          command.checkId === projectedCommand.checkId &&
          command.definitionHash === projectedCommand.definitionHash &&
          command.sourceManifest?.sha256 === sourceManifest.sha256,
      );
      if (
        durableCommand?.sourceManifest === undefined ||
        sourceManifest.protocol !== "koni.run-check-source-manifest.v1" ||
        sourceManifest.configurationSha256 !== input.configuration.configuration_sha256 ||
        sourceManifest.catalogSha256 !==
          input.candidate.ticket.executionPolicyBinding?.catalogSha256 ||
        sourceManifest.bindingSha256 !== durableStep.executionPolicyBinding?.sha256 ||
        sourceManifest.checkSha256 !== projectedCommand.definitionHash ||
        sourceManifest.stepId !== baselineStep.id ||
        canonicalHash(sourceManifest.roots) !== canonicalHash(sourcePaths) ||
        !isSha256Digest(sourceManifest.manifestSha256) ||
        !isSha256Digest(sourceManifest.sha256)
      )
        continue;
      const material = withoutField(sourceManifest, "sha256");
      if (
        canonicalHash(material) !== sourceManifest.sha256 ||
        canonicalHash({
          protocol: "koni.contained-path-manifest.v1",
          roots: sourceManifest.roots,
          entries: sourceManifest.entries,
        }) !== sourceManifest.manifestSha256
      )
        continue;
      manifests.push(sourceManifest);
    }
    if (manifests.length !== 1) return undefined;
    return {
      sourceManifest: manifests[0]!,
      baselineStep,
      baselinePredecessor: predecessor,
      baselineCheck: projectedCheck,
    };
  }

  async #reviewEffectSuccessorCurrent(input: {
    run: RunRecord;
    configuration: CompiledConfiguration;
    subjectId: string;
    prepared: GraphNode;
    current: GraphNode;
    excludedAttemptId: string;
  }): Promise<boolean> {
    const candidates = allReviewCandidates(input.run).filter(
      (candidate) =>
        candidate.attempt.id !== input.excludedAttemptId &&
        candidate.ticket.status === "completed" &&
        candidate.step.status === "completed" &&
        candidate.attempt.status === "completed" &&
        candidate.attempt.terminalPolicy?.mode === "semantic" &&
        candidate.ticket.targetNodeIds.includes(input.subjectId),
    );
    const reachable = new Map<Sha256Digest, GraphNode>([
      [canonicalHash(input.prepared), input.prepared],
    ]);
    const remaining = new Set(candidates.map((candidate) => candidate.attempt.id));
    for (let pass = 0; pass <= candidates.length && remaining.size > 0; pass += 1) {
      let changed = false;
      for (const candidate of candidates) {
        if (!remaining.has(candidate.attempt.id)) continue;
        const snapshot = await this.#authenticatedReviewSnapshot({
          run: input.run,
          configuration: input.configuration,
          candidate,
          allowTerminalAccepted: false,
        });
        if (snapshot === undefined) {
          remaining.delete(candidate.attempt.id);
          continue;
        }
        const predecessor = snapshot.reviewedNodes.find((node) => node.id === input.subjectId);
        if (predecessor === undefined || !reachable.has(canonicalHash(predecessor))) continue;
        const successor = projectPassedReviewEffects(
          input.configuration,
          snapshot.definition.operation_registry_id,
          predecessor,
          candidate.attempt.id,
          candidate.attempt.personaId,
        );
        remaining.delete(candidate.attempt.id);
        if (successor === undefined) continue;
        const hash = canonicalHash(successor);
        reachable.set(hash, successor);
        changed = true;
        if (hash === canonicalHash(input.current)) return true;
      }
      if (!changed) break;
    }
    return false;
  }

  async #authenticatedReviewSnapshot(input: {
    run: RunRecord;
    configuration: CompiledConfiguration;
    candidate: ProofPreparationReviewCandidate;
    allowTerminalAccepted: boolean;
  }): Promise<AuthenticatedReviewSnapshot | undefined> {
    const { ticket, step, attempt } = input.candidate;
    if (
      step.kind !== "review" ||
      attempt.ticketId !== ticket.id ||
      attempt.stepId !== step.id ||
      attempt.personaId !== step.personaId ||
      ticket.executionPolicyBinding?.operationId !== ticket.operationId ||
      ticket.executionPolicyBinding.configurationSha256 !==
        input.configuration.configuration_sha256 ||
      step.executionPolicyBinding?.operationId !== ticket.operationId ||
      step.executionPolicyBinding.configurationSha256 !== input.configuration.configuration_sha256
    )
      return undefined;
    if (input.allowTerminalAccepted) {
      if (attempt.status !== "terminal_accepted" || attempt.terminalAcceptedAt === undefined)
        return undefined;
    } else if (
      ticket.status !== "completed" ||
      step.status !== "completed" ||
      attempt.status !== "completed" ||
      attempt.terminalPolicy?.mode !== "semantic"
    )
      return undefined;
    if (attempt.terminalOutputSha256 === undefined || attempt.terminalOutputSizeBytes === undefined)
      return undefined;
    const specBytes = await readFile(
      path.join(this.#stateRoot, `runs/${input.run.id}/attempts/${attempt.id}/launch-spec.json`),
    );
    if (specBytes.byteLength > MAX_LAUNCH_SPEC_BYTES || specBytes.includes(0)) {
      fail(
        "proof_preparation_spec",
        `launch specification for ${attempt.id} is oversized or unsafe`,
      );
    }
    let parsedSpec: unknown;
    try {
      parsedSpec = JSON.parse(specBytes.toString("utf8"));
    } catch {
      fail("proof_preparation_spec", `launch specification for ${attempt.id} is not JSON`);
    }
    const spec = validateAgentLaunchSpec(parsedSpec as AgentLaunchSpec);
    if (
      spec.specHash !== attempt.launchSpecHash ||
      spec.identity.runId !== input.run.id ||
      spec.identity.ticketId !== ticket.id ||
      spec.identity.stepId !== step.id ||
      spec.identity.attemptId !== attempt.id ||
      spec.identity.sessionId !== attempt.sessionId ||
      spec.persona.id !== attempt.personaId ||
      !isSha256Digest(attempt.reviewedGraphHash)
    ) {
      fail("proof_preparation_spec", `launch specification for ${attempt.id} has drifted identity`);
    }
    const prepared = await this.#readPreparedAttemptArtifact(input.run, attempt, spec);
    let contextValue: unknown;
    try {
      contextValue = JSON.parse(prepared.contextContent);
    } catch {
      fail("proof_preparation_context", `review context for ${attempt.id} is not JSON`);
    }
    const context = requiredRecord(contextValue, `review context for ${attempt.id}`);
    const definitionRecord = requiredRecord(context.ticket, `review ticket for ${attempt.id}`);
    if (
      !isSha256Digest(definitionRecord.definition_sha256) ||
      canonicalHash(withoutField(definitionRecord, "definition_sha256")) !==
        definitionRecord.definition_sha256
    ) {
      fail(
        "proof_preparation_context",
        `review ticket definition for ${attempt.id} failed its hash`,
      );
    }
    const definition = structuredClone(definitionRecord) as unknown as DerivedTicketDefinition;
    const contextStepRecord = requiredRecord(context.step, `review step for ${attempt.id}`);
    const contextStep = structuredClone(contextStepRecord) as unknown as DerivedWorkflowStep;
    const definitionStep = definition.workflow.find((candidate) => candidate.id === step.id);
    if (
      definition.configuration_sha256 !== input.configuration.configuration_sha256 ||
      definition.id !== ticket.id ||
      definition.operation_registry_id !== ticket.operationId ||
      canonicalHash(definition.target_node_ids) !== canonicalHash(ticket.targetNodeIds) ||
      definitionStep === undefined ||
      canonicalHash(definitionStep) !== canonicalHash(contextStep) ||
      definitionStep.kind !== "review" ||
      definitionStep.persona_id !== attempt.personaId ||
      canonicalHash(context.executionPolicy) !== canonicalHash(step.executionPolicyBinding)
    )
      return undefined;
    const terminalBytes = await readFile(
      path.join(
        this.#stateRoot,
        `runs/${input.run.id}/attempts/${attempt.id}/terminal-output.json`,
      ),
    );
    if (
      terminalBytes.byteLength !== attempt.terminalOutputSizeBytes ||
      rawSha256(terminalBytes) !== attempt.terminalOutputSha256 ||
      terminalBytes.includes(0)
    ) {
      fail(
        "proof_preparation_output",
        `review output for ${attempt.id} failed its authority binding`,
      );
    }
    let terminalValue: unknown;
    try {
      terminalValue = JSON.parse(terminalBytes.toString("utf8"));
    } catch {
      fail("proof_preparation_output", `review output for ${attempt.id} is not JSON`);
    }
    if (optionalRecord(terminalValue)?.status !== "completed") return undefined;
    if (!Array.isArray(context.graph)) return undefined;
    const reviewedNodes = context.graph.map((value) => parseContextGraphNode(value));
    if (new Set(reviewedNodes.map((node) => node.id)).size !== reviewedNodes.length)
      return undefined;
    return { definition, step: contextStep, reviewedNodes, context };
  }

  async #configuredCheckGrant(
    run: RunRecord,
    configuration: CompiledConfiguration,
    descriptor: AttemptDescriptor,
    capabilities: ConfigurationObject,
  ): Promise<AuthorityGrant["configuredChecks"] | undefined> {
    const ids = [
      ...new Set([
        ...(descriptor.step?.validation_checks ?? []),
        ...(descriptor.gatePolicyContexts ?? []).map((binding) => binding.checkId),
      ]),
    ].sort(compareText);
    if (ids.length === 0) return undefined;
    if (descriptor.graph === undefined)
      fail("check_graph", "configured checks require a compiler-bound graph epoch");
    if (descriptor.executionPolicyBinding === undefined) {
      fail(
        "check_execution_policy",
        "configured checks require an exact operation/workflow/step binding",
      );
    }
    const executionCatalog = requireExecutionSemanticCatalog(configuration);
    // A gate-policy binding can name a gate whose per-gate contract this very step is supposed to
    // author, so resolving it eagerly deadlocks the ticket that would satisfy it: the run blocks
    // before the authoring attempt can start. Checks the step declares itself still fail closed;
    // a purely auto-bound gate check degrades to an explicit instruction instead.
    const plans = await Promise.all(
      ids.map((requestedCheckId) =>
        resolveConfiguredAgentCheck({
          configuration,
          executionCatalog,
          executionPolicyBinding: descriptor.executionPolicyBinding!,
          gatePolicyContexts: descriptor.gatePolicyContexts ?? [],
          graph: descriptor.graph!,
          descriptor,
          projectRoot: attemptWorkspace(run, "ticket", descriptor.ticketId),
          requestedCheckId,
        }),
      ),
    );
    const commands = plans.flatMap((plan) => plan.commands);
    const commandCapability = optionalString(capabilities.commands) ?? "none";
    const personaNetwork = capabilities.network_access === true;
    for (const command of commands) {
      if (command.effect === "workspace_write" && commandCapability !== "workspace_write") {
        fail(
          "check_capability",
          `persona ${descriptor.personaId} cannot execute workspace-writing check ${command.checkId}`,
        );
      }
      if (command.networkAccess && !personaNetwork) {
        fail(
          "check_capability",
          `persona ${descriptor.personaId} cannot execute networked check ${command.checkId}`,
        );
      }
    }
    return {
      ids,
      networkAccess: commands.some((command) => command.networkAccess),
      maxTimeoutMs: Math.max(1, ...commands.map((command) => command.timeoutMs)),
    };
  }

  async #descriptorForRecordedAttempt(
    run: RunRecord,
    attempt: AgentAttemptRecord,
    configuration: CompiledConfiguration,
  ): Promise<AttemptDescriptor> {
    const runType = requireValidation(
      resolveCompiledRunType(configuration, run.runTypeId),
      "run_type_invalid",
      `pinned run type ${run.runTypeId} is unavailable`,
    );
    const kind = recoveredAttemptKind(run, attempt);
    const assignment =
      kind === "planning" || kind === "lead" || isRunWideVerificationAttempt(attempt)
        ? undefined
        : assignmentFromAttempt(run, attempt);
    let descriptor: AttemptDescriptor;
    try {
      descriptor = await this.#attemptDescriptor(
        {
          kind,
          run,
          ...(assignment === undefined ? {} : { assignment }),
          ...(kind === "lead" ? { leadTrigger: leadTriggerForAttempt(attempt) } : {}),
        },
        configuration,
        runType.document,
      );
    } catch (error) {
      if (
        !(error instanceof NativeRunProgramError) ||
        error.code !== "ticket_definition_missing" ||
        assignment === undefined
      )
        throw error;
      const graph = (await this.#readGraph(run, configuration)).graph;
      const definitions = await this.#readTicketDefinitions(run, configuration);
      const definition = await this.#recoverDefinitionFromRecordedAttempt(
        run,
        attempt,
        configuration,
      );
      const step = definition.workflow.find((candidate) => candidate.id === assignment.stepId);
      if (step === undefined || step.persona_id !== assignment.personaId) {
        fail(
          "attempt_assignment_drift",
          "recovered compiler definition differs from the durable attempt assignment",
        );
      }
      const predecessorExecution = shouldAttachPredecessorExecution(step)
        ? await this.#reviewPredecessorExecution(run, definition, step)
        : undefined;
      const reviewCandidateNodeIds =
        step.kind === "review"
          ? await this.#reviewCandidateNodeIds(
              run,
              definition,
              requireExecutionSemanticCatalog(configuration),
            )
          : [];
      const historicalPreparation =
        step.kind === "review"
          ? await this.#reviewHistoricalPreparation(run, definition, step, graph, configuration)
          : undefined;
      const gateRepairEvidence = shouldAttachCurrentGateRepairEvidence(run, definition, step)
        ? await this.#currentNonpassingGateRepairEvidence(
            run,
            configuration,
            graph,
            definitions.value.evaluation,
            gateRepairEvidenceTargetNodeIds(run, graph, definition.target_node_ids),
          )
        : [];
      descriptor = ticketAttempt(
        run,
        definition,
        step,
        graph,
        configuration,
        requireExecutionSemanticCatalog(configuration),
        definitions.value.evaluation.gate_policy_contexts,
        predecessorExecution,
        reviewCandidateNodeIds,
        historicalPreparation,
        gateRepairEvidence,
      );
    }
    if (
      descriptor.ticketId !== attempt.ticketId ||
      descriptor.stepId !== attempt.stepId ||
      descriptor.personaId !== attempt.personaId
    )
      fail(
        "attempt_assignment_drift",
        "durable attempt no longer matches its pinned compiler assignment",
      );
    return descriptor;
  }

  async #recoverDefinitionFromRecordedAttempt(
    run: RunRecord,
    attempt: AgentAttemptRecord,
    configuration: CompiledConfiguration,
  ): Promise<DerivedTicketDefinition> {
    const launchBytes = await readStableDurableFile(
      path.join(this.#stateRoot, `runs/${run.id}/attempts/${attempt.id}/launch-spec.json`),
      {
        minimum: 1,
        maximum: 8 * 1024 * 1024,
        label: `launch specification for ${attempt.id}`,
      },
    );
    let launchValue: unknown;
    try {
      launchValue = JSON.parse(launchBytes.toString("utf8"));
    } catch {
      fail(
        "recovery_launch_spec",
        `stored launch specification for ${attempt.id} is not valid JSON`,
      );
    }
    let spec: Readonly<AgentLaunchSpec>;
    try {
      spec = validateAgentLaunchSpec(launchValue as AgentLaunchSpec);
    } catch (error) {
      fail(
        "recovery_launch_spec",
        `stored launch specification for ${attempt.id} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      spec.specHash !== attempt.launchSpecHash ||
      spec.identity.runId !== run.id ||
      spec.identity.attemptId !== attempt.id ||
      spec.identity.ticketId !== attempt.ticketId ||
      spec.identity.stepId !== attempt.stepId ||
      spec.identity.sessionId !== attempt.sessionId
    )
      fail(
        "recovery_launch_spec",
        `stored launch specification for ${attempt.id} differs from durable attempt identity`,
      );
    const prepared = await this.#readPreparedAttemptArtifact(run, attempt, spec);
    let contextValue: unknown;
    try {
      contextValue = JSON.parse(prepared.contextContent);
    } catch {
      fail("recovery_ticket_definition", `compiler context for ${attempt.id} is not valid JSON`);
    }
    if (!isRecord(contextValue) || !isRecord(contextValue.ticket)) {
      fail(
        "recovery_ticket_definition",
        `compiler context for ${attempt.id} has no ticket definition`,
      );
    }
    const definition = contextValue.ticket as unknown as DerivedTicketDefinition;
    if (
      definition.protocol !== "koni.derived-ticket.v1" ||
      definition.id !== attempt.ticketId ||
      definition.configuration_sha256 !== configuration.configuration_sha256 ||
      !isSha256Digest(definition.definition_sha256) ||
      canonicalHash(withoutField(definition, "definition_sha256")) !==
        definition.definition_sha256 ||
      !Array.isArray(definition.workflow) ||
      !definition.workflow.some(
        (step) => step.id === attempt.stepId && step.persona_id === attempt.personaId,
      )
    )
      fail(
        "recovery_ticket_definition",
        `compiler context for ${attempt.id} has a drifted ticket definition`,
      );
    return structuredClone(definition);
  }

  async #readGraphNote(
    run: RunRecord,
    id: string,
  ): Promise<{
    value: GraphNoteArtifact;
    sizeBytes: number;
  }> {
    if (!/^note-[0-9a-f]{24}$/u.test(id))
      fail("graph_note_id", "superseded graph note id is malformed");
    const bytes = await readFile(path.join(this.#stateRoot, graphNotePath(run.id, id))).catch(
      () => undefined,
    );
    if (bytes === undefined || bytes.byteLength > 2 * 1024 * 1024 || bytes.includes(0)) {
      fail("graph_note_lineage", `superseded graph note ${id} is missing or unsafe`);
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("graph_note_lineage", `superseded graph note ${id} is malformed`);
    }
    if (
      !isRecord(value) ||
      value.protocol !== LEGACY_GRAPH_NOTE_PROTOCOL ||
      value.id !== id ||
      value.runId !== run.id ||
      typeof value.nodeId !== "string" ||
      typeof value.body !== "string" ||
      !isGraphNoteKind(value.kind)
    )
      fail("graph_note_lineage", `superseded graph note ${id} failed its identity binding`);
    return { value: value as unknown as GraphNoteArtifact, sizeBytes: bytes.byteLength };
  }

  async #readGraphNotes(run: RunRecord): Promise<GraphNoteArtifact[]> {
    const directory = path.join(this.#stateRoot, `runs/${run.id}/program/notes`);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    if (entries.length > MAX_GRAPH_NOTES)
      fail("graph_note_limit", "run graph note inventory exceeds its compiler bound");
    const output: GraphNoteArtifact[] = [];
    let totalBytes = 0;
    for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
      if (!entry.isFile() || !/^note-[0-9a-f]{24}\.json$/u.test(entry.name)) continue;
      const note = await this.#readGraphNote(run, entry.name.slice(0, -5));
      totalBytes += note.sizeBytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RUN_GRAPH_BYTES) {
        fail("graph_note_limit", "legacy run graph notes exceed the durable aggregate byte bound");
      }
      output.push(note.value);
    }
    return output;
  }

  async #attemptDescriptor(
    input: AttemptDescriptorInput,
    configuration: CompiledConfiguration,
    runType: ConfigurationObject,
  ): Promise<AttemptDescriptor> {
    if (input.kind === "planning")
      return planningAttempt(input.run, runType, configuration, input.planningRevision);
    if (input.kind === "lead") {
      if (input.assignment !== undefined)
        fail("lead_assignment", "run-level Lead judgment cannot carry a ticket assignment");
      const trigger = input.leadTrigger;
      if (trigger === undefined)
        fail("lead_trigger", "Lead judgment attempt requires an exact compiler trigger");
      return leadJudgmentAttempt(
        input.run,
        trigger,
        pinnedLeadJudgmentBehavior(input.run, configuration),
      );
    }
    if (input.kind === "verification" && input.assignment === undefined) {
      const graph = (await this.#readGraph(input.run, configuration)).graph;
      return verificationAttempt(input.run, runType, graph);
    }
    if (input.assignment === undefined)
      fail("assignment_missing", `${input.kind} attempt has no assignment`);
    const graph = (await this.#readGraph(input.run, configuration)).graph;
    const executionCatalog = requireExecutionSemanticCatalog(configuration);
    const definitions = await this.#readTicketDefinitions(input.run, configuration);
    const definition =
      ticketDefinitionFromArtifact(definitions.value, input.assignment.ticketId) ??
      configuredControlDefinitionFromTicket(
        input.run,
        input.assignment,
        configuration,
        executionCatalog,
        graph,
      ) ??
      (await this.#recoverDefinitionForActiveAssignment(
        input.run,
        input.assignment,
        configuration,
      )) ??
      integrationDefinition(input.run, input.assignment, configuration, graph);
    const step = definition.workflow.find((item) => item.id === input.assignment!.stepId);
    if (step === undefined || step.persona_id !== input.assignment.personaId) {
      fail("assignment_drift", "scheduler assignment does not match the compiler definition");
    }
    const predecessorExecution = shouldAttachPredecessorExecution(step)
      ? await this.#reviewPredecessorExecution(input.run, definition, step)
      : undefined;
    const reviewCandidateNodeIds =
      step.kind === "review"
        ? await this.#reviewCandidateNodeIds(input.run, definition, executionCatalog)
        : [];
    const historicalPreparation =
      step.kind === "review"
        ? await this.#reviewHistoricalPreparation(input.run, definition, step, graph, configuration)
        : undefined;
    const gateRepairEvidence = shouldAttachCurrentGateRepairEvidence(input.run, definition, step)
      ? await this.#currentNonpassingGateRepairEvidence(
          input.run,
          configuration,
          graph,
          definitions.value.evaluation,
          gateRepairEvidenceTargetNodeIds(input.run, graph, definition.target_node_ids),
        )
      : [];
    return ticketAttempt(
      input.run,
      definition,
      step,
      graph,
      configuration,
      executionCatalog,
      definitions.value.evaluation.gate_policy_contexts,
      predecessorExecution,
      reviewCandidateNodeIds,
      historicalPreparation,
      gateRepairEvidence,
    );
  }

  /**
   * Compatibility recovery for a ticket admitted before ticket-definition retention existed.
   *
   * A compiler-authenticated graph mutation can make the originating rule cease to apply while
   * the durable ticket is still awaiting a later workflow step. Current artifacts retain that
   * definition explicitly. Older artifacts did not, but every issued attempt already carries the
   * complete definition in its hash-bound compiler input. Recover only from the newest exact-step
   * attempt (or, before that step has ever run, the newest attempt for the same ticket), then
   * require the requested scheduler identity to be present in the recovered workflow.
   */
  async #recoverDefinitionForActiveAssignment(
    run: RunRecord,
    assignment: Readonly<ReadyAssignment>,
    configuration: CompiledConfiguration,
  ): Promise<DerivedTicketDefinition | undefined> {
    const candidates = Object.values(run.attempts)
      .filter((attempt) => attempt.ticketId === assignment.ticketId)
      .sort((left, right) => {
        const leftExact =
          left.stepId === assignment.stepId && left.personaId === assignment.personaId;
        const rightExact =
          right.stepId === assignment.stepId && right.personaId === assignment.personaId;
        if (leftExact !== rightExact) return leftExact ? -1 : 1;
        const leftAccepted = left.terminalOutputSha256 !== undefined;
        const rightAccepted = right.terminalOutputSha256 !== undefined;
        if (leftAccepted !== rightAccepted) return leftAccepted ? -1 : 1;
        return (
          (right.startedAt ?? "").localeCompare(left.startedAt ?? "") ||
          right.id.localeCompare(left.id)
        );
      });
    const source = candidates[0];
    if (source === undefined) return undefined;
    const definition = await this.#recoverDefinitionFromRecordedAttempt(run, source, configuration);
    const step = definition.workflow.find((candidate) => candidate.id === assignment.stepId);
    if (step === undefined || step.persona_id !== assignment.personaId) {
      fail(
        "assignment_drift",
        "recovered compiler definition does not contain the requested durable scheduler assignment",
      );
    }
    return definition;
  }

  async #reviewPredecessorExecution(
    run: RunRecord,
    definition: DerivedTicketDefinition,
    dependentStep: DerivedWorkflowStep,
  ): Promise<Record<string, unknown> | undefined> {
    const ticket = run.tickets[definition.id];
    if (ticket === undefined || dependentStep.depends_on.length === 0) return undefined;
    let remainingBytes = MAX_REVIEW_EXECUTION_EVIDENCE_BYTES;
    const predecessors: Record<string, unknown>[] = [];
    for (const predecessorStepId of orderedReviewPredecessorStepIds(
      definition.workflow,
      dependentStep,
    )) {
      const durableStep = ticket.steps.find((candidate) => candidate.id === predecessorStepId);
      if (durableStep === undefined) {
        fail(
          "review_evidence_step",
          `review predecessor ${predecessorStepId} is absent from durable ticket ${ticket.id}`,
        );
      }
      const attempt = [...durableStep.attemptIds]
        .reverse()
        .map((attemptId) => run.attempts[attemptId])
        .find(
          (candidate) =>
            candidate?.status === "completed" && candidate.stepId === predecessorStepId,
        );
      if (attempt === undefined) {
        // Non-review dependent steps can follow compiler/operator control stages whose durable
        // completion has no agent attempt. Preserve strict complete provenance for review, while
        // still carrying every available authenticated predecessor execution into ordinary causal
        // steps such as a gate's analyze stage.
        if (dependentStep.kind !== "review") continue;
        fail(
          "review_evidence_attempt",
          `review predecessor ${predecessorStepId} has no completed durable attempt`,
        );
      }
      const checks: Record<string, unknown>[] = [];
      for (const check of (run.checks ?? [])
        .filter((candidate) => candidate.attemptId === attempt.id)
        .sort((left, right) =>
          compareText(`${left.recordedAt}\0${left.id}`, `${right.recordedAt}\0${right.id}`),
        )) {
        const commands: Record<string, unknown>[] = [];
        for (const command of check.commands) {
          const stdout = await this.#reviewCheckStream(
            run,
            command.stdoutArtifactPath,
            command.stdoutSha256,
            command.stdoutSizeBytes,
            remainingBytes,
            `${check.requestedCheckId}/${command.checkId} stdout`,
          );
          remainingBytes -= stdout.includedBytes;
          const stderr = await this.#reviewCheckStream(
            run,
            command.stderrArtifactPath,
            command.stderrSha256,
            command.stderrSizeBytes,
            remainingBytes,
            `${check.requestedCheckId}/${command.checkId} stderr`,
          );
          remainingBytes -= stderr.includedBytes;
          commands.push({
            checkId: command.checkId,
            definitionHash: command.definitionHash,
            ...(command.executionPolicy === undefined
              ? {}
              : { executionPolicy: command.executionPolicy }),
            argv: command.argv,
            startedAt: command.startedAt,
            completedAt: command.completedAt,
            exitCode: command.exitCode,
            signal: command.signal,
            environmentSha256: command.environmentSha256,
            preManifestSha256: command.preManifestSha256,
            postManifestSha256: command.postManifestSha256,
            ...(command.sourceManifest === undefined
              ? {}
              : { sourceManifest: command.sourceManifest }),
            stdout: stdout.value,
            stderr: stderr.value,
          });
        }
        checks.push({
          requestedCheckId: check.requestedCheckId,
          definitionHash: check.definitionHash,
          kind: check.kind,
          ...(check.executionPolicy === undefined
            ? {}
            : { executionPolicy: check.executionPolicy }),
          accepted: check.accepted,
          ...(check.passed === undefined ? {} : { passed: check.passed }),
          summary: check.summary,
          recordedAt: check.recordedAt,
          evidenceSha256: check.evidenceSha256,
          commands,
        });
      }
      predecessors.push({
        stepId: predecessorStepId,
        attemptId: attempt.id,
        personaId: attempt.personaId,
        ...(attempt.terminalSummary === undefined
          ? {}
          : { terminalSummary: attempt.terminalSummary }),
        checks,
      });
    }
    if (predecessors.length === 0) return undefined;
    const material = {
      protocol: "koni.review-predecessor-execution.v1",
      ticketId: ticket.id,
      reviewStepId: dependentStep.id,
      predecessors,
    };
    return { ...material, sha256: canonicalHash(material) };
  }

  /**
   * Project immutable cross-ticket proof provenance without inheriting another agent session.
   *
   * The same authenticated preparation snapshot and current-source comparison that authorize the
   * `proof_preparation_current` rule authorize this envelope. The reviewer receives the bounded
   * historical red signal, independent preparation-review result, and exact source continuity;
   * Pi conversation history remains scoped to the current ticket execution epoch.
   */
  async #reviewHistoricalPreparation(
    run: RunRecord,
    definition: DerivedTicketDefinition,
    reviewStep: DerivedWorkflowStep,
    graph: TypedGraph,
    configuration: CompiledConfiguration,
  ): Promise<Record<string, unknown> | undefined> {
    const leaves = collectProofPreparationLeaves(configuration);
    if (leaves.length === 0) return undefined;
    const targetIds = new Set(definition.target_node_ids);
    const subjects = graph
      .nodes()
      .filter((node) => targetIds.has(node.id))
      .sort((left, right) => compareText(left.id, right.id));
    if (subjects.length === 0) return undefined;
    const evaluator = new GraphExpressionEvaluator(configuration, graph);
    const attemptOrder = new Map(Object.keys(run.attempts).map((id, index) => [id, index]));
    const entries = new Map<Sha256Digest, Record<string, unknown>>();

    for (const subject of subjects) {
      for (const leaf of leaves) {
        const bindingNames = [...rulePredicateBindingNames(leaf)].sort(compareText);
        if (bindingNames.length === 0) continue;
        const bindings = Object.fromEntries(bindingNames.map((name) => [name, [subject.id]]));
        let expectedTargets: readonly string[];
        try {
          expectedTargets = withRuleBindings(evaluator, bindings, () =>
            evaluator.select(leaf.preparation_targets as ConfigurationValue),
          );
        } catch {
          continue;
        }
        if (!expectedTargets.includes(subject.id)) continue;
        const operationId = optionalString(leaf.preparation_operation);
        const checkId = optionalString(leaf.check);
        if (operationId === undefined || checkId === undefined) continue;
        if (
          configuration.registries.operations[operationId]?.proof_source_preparation_check !==
          checkId
        )
          continue;
        const candidate = latestReviewCandidate(run, operationId, subject.id, attemptOrder);
        if (
          candidate === undefined ||
          canonicalHash(candidate.ticket.targetNodeIds) !== canonicalHash(expectedTargets)
        )
          continue;
        const authenticated = await this.#authenticatedProofPreparationCurrent({
          run,
          configuration,
          graph,
          subject,
          leaf,
          expectedTargets,
          candidate,
        });
        if (authenticated === undefined) continue;
        const baselineCheck = boundedHistoricalPreparationCheck(
          authenticated.baselineCheck,
          MAX_HISTORICAL_PREPARATION_EVIDENCE_BYTES,
        );
        const sourceManifest = authenticated.sourceManifest;
        const material = {
          subjectNodeId: subject.id,
          subjectNodeSha256: canonicalHash(subject),
          preparationOperationId: operationId,
          preparationTicketId: candidate.ticket.id,
          preparationReview: {
            stepId: candidate.step.id,
            attemptId: candidate.attempt.id,
            personaId: candidate.attempt.personaId,
            ...(candidate.attempt.terminalPolicy === undefined
              ? {}
              : { terminalPolicySha256: candidate.attempt.terminalPolicy.sha256 }),
            ...(candidate.attempt.terminalSummary === undefined
              ? {}
              : { terminalSummary: candidate.attempt.terminalSummary }),
          },
          baseline: {
            stepId: authenticated.baselineStep.id,
            attemptId: authenticated.baselinePredecessor.attemptId,
            personaId: authenticated.baselinePredecessor.personaId,
            check: baselineCheck,
          },
          sourceContinuity: {
            roots: sourceManifest.roots,
            manifestSha256: sourceManifest.manifestSha256,
            sourceManifestSha256: sourceManifest.sha256,
            current: true,
            currentVia: authenticated.currentVia,
          },
        };
        entries.set(canonicalHash(material), material);
      }
    }
    if (entries.size === 0) return undefined;
    const material = {
      protocol: "koni.review-historical-preparation.v1",
      configurationSha256: configuration.configuration_sha256,
      ticketId: definition.id,
      reviewStepId: reviewStep.id,
      entries: [...entries.values()].sort((left, right) =>
        compareText(
          requiredNonempty(left.subjectNodeId, "historical preparation subject"),
          requiredNonempty(right.subjectNodeId, "historical preparation subject"),
        ),
      ),
    };
    return { ...material, sha256: canonicalHash(material) };
  }

  async #reviewCheckStream(
    run: RunRecord,
    artifactPath: string,
    expectedSha256: Sha256Digest,
    expectedSizeBytes: number,
    remainingBytes: number,
    label: string,
  ): Promise<{ includedBytes: number; value: Record<string, unknown> }> {
    if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
      fail("review_evidence_stream", `${label} has an invalid durable byte size`);
    }
    const stateRoot = path.resolve(this.#stateRoot);
    const runRoot = path.resolve(stateRoot, "runs", run.id);
    const absolute = path.resolve(stateRoot, artifactPath);
    if (!absolute.startsWith(`${runRoot}${path.sep}`)) {
      fail("review_evidence_stream", `${label} escapes the authority-owned run root`);
    }
    const common = {
      sha256: expectedSha256,
      sizeBytes: expectedSizeBytes,
    };
    if (expectedSizeBytes > MAX_REVIEW_CHECK_STREAM_BYTES || expectedSizeBytes > remainingBytes) {
      return {
        includedBytes: 0,
        value: {
          ...common,
          encoding: "omitted",
          content: "",
          omission: "Authenticated stream exceeds the bounded inline review-evidence budget.",
        },
      };
    }
    let bytes: Buffer;
    try {
      bytes = await readStableDurableFile(absolute, {
        minimum: 0,
        maximum: expectedSizeBytes,
        label,
      });
    } catch (error) {
      fail(
        "review_evidence_stream",
        `${label} is not durably readable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (bytes.byteLength !== expectedSizeBytes || rawSha256(bytes) !== expectedSha256) {
      fail("review_evidence_stream", `${label} differs from its compiler-recorded hash or size`);
    }
    const utf8 = bytes.toString("utf8");
    const textSafe = !utf8.includes("\u0000") && Buffer.from(utf8, "utf8").equals(bytes);
    return {
      includedBytes: bytes.byteLength,
      value: {
        ...common,
        encoding: textSafe ? "utf8" : "base64",
        content: textSafe ? utf8 : bytes.toString("base64"),
      },
    };
  }

  async #currentNonpassingGateRepairEvidence(
    run: RunRecord,
    configuration: CompiledConfiguration,
    graph: TypedGraph,
    evaluation: Pick<CompiledRuleEvaluation, "facts" | "gate_policy_contexts">,
    targetNodeIds: readonly string[],
  ): Promise<CurrentNonpassingGateRepairEvidence[]> {
    const evidence = runRuleEvidence(
      run,
      configuration.configuration_sha256,
      ruleInputGraphSha256(configuration, graph),
    );
    const stateRoot = path.resolve(this.#stateRoot);
    const runRoot = path.resolve(stateRoot, "runs", run.id);
    let remainingBytes = MAX_HISTORICAL_PREPARATION_EVIDENCE_BYTES;
    const requests = await currentNonpassingGateRepairEvidenceRequests({
      graph,
      evaluation,
      evidence,
      checks: run.checks,
      targetNodeIds,
      readEvidence: async (check) => {
        if (check.evidenceSizeBytes > remainingBytes) {
          fail(
            "gate_repair_evidence_size",
            `current gate repair evidence candidate ${check.id} exceeds the bounded context budget`,
          );
        }
        const absolute = path.resolve(stateRoot, check.evidenceArtifactPath);
        if (!absolute.startsWith(`${runRoot}${path.sep}`)) {
          fail(
            "gate_repair_evidence_path",
            `current gate repair evidence candidate ${check.id} escapes the authority-owned run root`,
          );
        }
        const bytes = await readStableDurableFile(absolute, {
          minimum: 1,
          maximum: check.evidenceSizeBytes,
          label: `current gate repair evidence candidate ${check.id}`,
        });
        if (
          bytes.byteLength !== check.evidenceSizeBytes ||
          rawSha256(bytes) !== check.evidenceSha256
        ) {
          fail(
            "gate_repair_evidence_integrity",
            `current gate repair evidence candidate ${check.id} differs from its durable record`,
          );
        }
        remainingBytes -= bytes.byteLength;
        try {
          return JSON.parse(bytes.toString("utf8")) as unknown;
        } catch {
          fail(
            "gate_repair_evidence_shape",
            `current gate repair evidence candidate ${check.id} is not valid JSON`,
          );
        }
      },
    });
    const contexts: CurrentNonpassingGateRepairEvidence[] = [];
    for (const request of requests) {
      const check = request.check;
      const value = request.artifact;
      if (
        !isRecord(value) ||
        value.protocol !== "koni.agent-check-execution-evidence.v1" ||
        typeof value.id !== "string" ||
        !request.receiptIds.includes(value.id) ||
        value.accepted !== true ||
        value.passed !== false ||
        !Array.isArray(value.commands) ||
        value.commands.length !== check.commands.length
      ) {
        fail(
          "gate_repair_evidence_shape",
          `current gate repair evidence for ${request.gateNodeId} does not match its current accepted nonpassing receipt`,
        );
      }
      const commands = value.commands.map((rawCommand, index) => {
        const command = requiredRecord(rawCommand, `current gate repair evidence command ${index}`);
        const resultSource = requiredRecord(
          command.resultSource,
          `current gate repair evidence command ${index} result source`,
        );
        if (resultSource.value === undefined) {
          fail(
            "gate_repair_evidence_shape",
            `current gate repair evidence command ${index} has no decoded result`,
          );
        }
        const durableCommand = check.commands[index]!;
        return {
          argv: [...durableCommand.argv],
          exitCode: durableCommand.exitCode,
          result: structuredClone(resultSource.value) as JsonValue,
        };
      });
      contexts.push({
        protocol: "koni.current-gate-repair-evidence.v1",
        gateNodeId: request.gateNodeId,
        providerNodeId: request.providerNodeId,
        evidenceId: value.id,
        evidenceSha256: check.evidenceSha256,
        checkId: check.requestedCheckId,
        recordedAt: check.recordedAt,
        summary: check.summary,
        commands,
      });
    }
    return contexts;
  }

  async #loadPinned(run: RunRecord): Promise<PinnedConfigurationArtifact> {
    const cached = this.#pinned.get(run.id);
    if (cached !== undefined) {
      assertPinnedMatchesRun(cached, run);
      return cached;
    }
    const bytes = await readFile(path.join(this.#stateRoot, pinnedConfigurationPath(run.id)));
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("pinned_configuration_json", "pinned run configuration is not valid JSON");
    }
    let artifact = validatePinnedArtifact(value);
    const historicalBehavior = projectHistoricalCompiledBehavior(
      artifact.configuration,
      run.runTypeId,
    );
    if (historicalBehavior !== undefined) {
      assertHistoricalBehaviorMatchesRun(run, historicalBehavior, artifact.configuration);
      artifact = attachHistoricalBehavior(artifact, historicalBehavior);
    }
    assertPinnedMatchesRun(artifact, run);
    this.#pinned.set(run.id, artifact);
    return artifact;
  }

  async #readGraph(
    run: RunRecord,
    configuration: CompiledConfiguration,
  ): Promise<{ graph: TypedGraph; artifact: GraphArtifact; bytesSha256: Sha256Digest }> {
    // Planning deliberately keeps its proposed semantic graph outside the committed program
    // graph until the operator approves it. The run record nevertheless binds the exact reviewed
    // hash so approval cannot silently compile different bytes. Read surfaces shown during that
    // gate, including the planning interval of an operator-requested revision, must therefore
    // project the reviewed seed rather than compare its hash with the still-current committed
    // graph and report false corruption. Execution never enters this branch because it is
    // lifecycle-gated until approval publishes the graph artifact below.
    const graphPhase =
      run.lifecycle.phase === "pausing" || run.lifecycle.phase === "paused"
        ? run.lifecycle.resumePhase
        : run.lifecycle.phase;
    if (
      ((graphPhase === "planning" && run.plan?.status === "planning") ||
        (graphPhase === "awaiting_approval" && run.plan?.status === "awaiting_approval") ||
        (graphPhase === "approving" && run.plan?.status === "approving")) &&
      run.plan?.graphSeed !== undefined
    ) {
      const graph = compilePlanningSeed(
        configuration,
        run,
        parsePlanningSeed(run.plan.graphSeed),
        planningArtifactBoundary(() =>
          parsePlanningFullPlans(run.plan!.full, "reviewed full plan"),
        ),
        this.#projectRoot,
      );
      if (run.graphHash === undefined || run.graphHash !== graph.hash) {
        fail("graph_artifact_hash", "reviewed planning graph does not match its compiler hash");
      }
      const artifact = graphArtifact(run, configuration, graph, run.graphRevision);
      return {
        graph,
        artifact,
        bytesSha256: rawSha256(encodeRunGraphArtifact(artifact)),
      };
    }
    const read = await this.#readContextGraph(run, configuration);
    if (read.artifact.revision !== run.graphRevision) {
      fail("graph_artifact_drift", "durable graph semantic revision does not match the run record");
    }
    if (run.graphHash !== undefined && run.graphHash !== read.graph.hash) {
      fail("graph_artifact_hash", "durable graph bytes do not match their compiler hash");
    }
    return read;
  }

  async #readContextGraph(
    run: RunRecord,
    configuration: CompiledConfiguration,
  ): Promise<{ graph: TypedGraph; artifact: GraphArtifact; bytesSha256: Sha256Digest }> {
    const bytes = await readFile(path.join(this.#stateRoot, graphArtifactPath(run.id)));
    const artifact = parseGraphArtifact(bytes);
    if (artifact.runId !== run.id || artifact.configurationSha256 !== run.compiledConfigHash) {
      fail("graph_artifact_drift", "durable graph artifact does not match the run identity");
    }
    const graph = new TypedGraph(requireGraphSchema(configuration), Object.values(artifact.nodes), {
      projectRoot: this.#projectRoot,
    });
    assertConfiguredGraphConstraints(configuration, graph, this.#projectRoot);
    if (graph.hash !== artifact.graphSha256) {
      fail("graph_artifact_hash", "durable semantic graph bytes do not match their compiler hash");
    }
    return { graph, artifact, bytesSha256: rawSha256(bytes) };
  }

  #contextualState(run: RunRecord, artifact: GraphArtifact): GraphContextualState {
    const contextual =
      artifact.contextual === undefined
        ? createGraphContextualState(runRootContextId(run.id), run.workingSpecOwnerId)
        : structuredClone(artifact.contextual);
    assertContextualAuthorityBinding(run, artifact.revision, contextual);
    return contextual;
  }

  async #readTicketDefinitions(
    run: RunRecord,
    configuration: CompiledConfiguration,
  ): Promise<{
    value: TicketDefinitionsArtifact;
    bytesSha256: Sha256Digest;
  }> {
    const bytes = await readFile(path.join(this.#stateRoot, ticketDefinitionsPath(run.id)));
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("ticket_artifact_json", "ticket definition artifact is not valid JSON");
    }
    if (!isRecord(value) || value.protocol !== TICKET_ARTIFACT_PROTOCOL || value.runId !== run.id) {
      fail(
        "ticket_artifact_shape",
        "ticket definition artifact has the wrong identity or protocol",
      );
    }
    const artifact = value as unknown as TicketDefinitionsArtifact;
    if (
      artifact.graphRevision !== run.graphRevision ||
      artifact.evaluation.configuration_sha256 !== run.compiledConfigHash ||
      canonicalHash(withoutField(artifact.evaluation, "evaluation_sha256")) !==
        artifact.evaluation.evaluation_sha256
    )
      fail("ticket_artifact_hash", "ticket definition artifact failed its compiler binding");
    if (artifact.retainedDefinitions !== undefined) {
      if (!Array.isArray(artifact.retainedDefinitions)) {
        fail("ticket_artifact_retained", "retained ticket definitions are not an array");
      }
      const applicableIds = new Set(artifact.evaluation.tickets.map((definition) => definition.id));
      const retainedIds = new Set<string>();
      for (const definition of artifact.retainedDefinitions) {
        if (
          !isRecord(definition) ||
          definition.protocol !== "koni.derived-ticket.v1" ||
          definition.configuration_sha256 !== run.compiledConfigHash ||
          !isSha256Digest(definition.definition_sha256) ||
          canonicalHash(withoutField(definition, "definition_sha256")) !==
            definition.definition_sha256 ||
          applicableIds.has(definition.id) ||
          retainedIds.has(definition.id)
        )
          fail(
            "ticket_artifact_retained",
            "retained ticket definition failed its compiler binding",
          );
        retainedIds.add(definition.id);
      }
    }
    const stateMachines = requireValidation(
      compileStateMachineCatalog(configuration),
      "state_machine_invalid",
      "pinned state-machine configuration did not compile",
    );
    if (canonicalHash(artifact.evaluation.state_machine_catalog) !== canonicalHash(stateMachines)) {
      fail(
        "ticket_state_machine_drift",
        "ticket definition lifecycle catalog differs from its pinned configuration",
      );
    }
    return { value: artifact, bytesSha256: rawSha256(bytes) };
  }

  async #readPreparedAttemptArtifact(
    run: RunRecord,
    attempt: AgentAttemptRecord,
    spec: Readonly<AgentLaunchSpec>,
  ): Promise<PreparedAttemptArtifact> {
    const compilerInputPath =
      spec.planningRevision === undefined
        ? `runs/${run.id}/attempts/${attempt.id}/compiler-input.json`
        : `runs/${run.id}/attempts/${attempt.id}/planning/revisions/${spec.planningRevision.revision}/compiler-input.json`;
    const bytes = await readFile(path.join(this.#stateRoot, compilerInputPath));
    if (bytes.byteLength > MAX_CONTEXT_BYTES + 1024 * 1024 || bytes.includes(0)) {
      fail("recovery_compiler_input", "stored compiler input is oversized or unsafe");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("recovery_compiler_input", "stored compiler input is not valid JSON");
    }
    if (
      !isRecord(parsed) ||
      parsed.protocol !== "koni.prepared-attempt.v1" ||
      parsed.specHash !== spec.specHash ||
      parsed.contextHash !== spec.authority.authoritativeContextHash ||
      parsed.terminalSchemaHash !== spec.terminal.outputSchemaHash ||
      typeof parsed.contextContent !== "string" ||
      !isRecord(parsed.grant)
    )
      fail(
        "recovery_compiler_input",
        "stored compiler input does not match the immutable launch spec",
      );
    const artifact = parsed as unknown as PreparedAttemptArtifact;
    if (
      rawSha256(artifact.contextContent) !== artifact.contextHash ||
      canonicalHash(artifact.grant) !== spec.authority.grantHash
    )
      fail("recovery_compiler_input", "stored compiler input failed its content or grant binding");
    return artifact;
  }

  async #reviewCandidateNodeIds(
    run: RunRecord,
    ticket: DerivedTicketDefinition,
    executionCatalog: Readonly<CompiledExecutionSemanticCatalog>,
  ): Promise<string[]> {
    const candidates = new Set<string>();
    const stepBindings = resolveDefinitionExecutionBindings(executionCatalog, ticket).steps;
    const priorAttempts = Object.values(run.attempts)
      .filter(
        (attempt) =>
          attempt.ticketId === ticket.id &&
          attempt.status === "completed" &&
          attempt.terminalOutputSha256 !== undefined,
      )
      .sort((left, right) => compareText(left.id, right.id));
    for (const attempt of priorAttempts) {
      const step = ticket.workflow.find((candidate) => candidate.id === attempt.stepId);
      if (step === undefined || step.kind === "review") continue;
      const bytes = await readFile(
        path.join(this.#stateRoot, `runs/${run.id}/attempts/${attempt.id}/terminal-output.json`),
      );
      if (
        bytes.byteLength !== attempt.terminalOutputSizeBytes ||
        rawSha256(bytes) !== attempt.terminalOutputSha256 ||
        bytes.byteLength > MAX_CONTEXT_BYTES ||
        bytes.includes(0)
      )
        fail(
          "review_effect_provenance",
          `terminal output for ${attempt.id} failed its authority binding`,
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("review_effect_provenance", `terminal output for ${attempt.id} is not valid JSON`);
      }
      const binding = stepBindings.get(step.id);
      if (binding === undefined) {
        fail(
          "review_effect_provenance",
          `terminal output for ${attempt.id} lost its compiled execution-policy binding`,
        );
      }
      const output = parseAssignmentOutput(
        parsed,
        step.graph_mutation,
        assignmentChangeControlContract(executionCatalog, binding, step.id),
        step.kind,
      );
      if (
        output.status !== "completed" ||
        output.graphDelta === undefined ||
        output.graphDelta === null
      )
        continue;
      for (const nodeId of graphDeltaReviewCandidateNodeIds(output.graphDelta)) {
        candidates.add(nodeId);
      }
    }
    if (candidates.size === 0) {
      for (const id of ticket.target_node_ids) candidates.add(id);
    }
    return [...candidates].sort(compareText);
  }

  async #readAttemptReceiptContext(
    run: RunRecord,
    attempt: AgentAttemptRecord,
    spec: Readonly<AgentLaunchSpec>,
  ): Promise<{ receiptIds: string[]; touchedFiles: string[]; loadedResources: string[] }> {
    const receiptIds = new Set<string>();
    const touchedFiles = new Set<string>();
    const loadedResources = new Set<string>();
    for (const record of [...(attempt.authorityToolResults ?? [])].sort(
      (left, right) => left.sequence - right.sequence,
    )) {
      const parsed = await this.#readAuthorityToolReceipt(run, attempt, record);
      if (!isRecord(parsed) || typeof parsed.receiptId !== "string") {
        fail("compaction_receipt_shape", "authority tool receipt has an invalid shape");
      }
      receiptIds.add(parsed.receiptId);
      const value = optionalRecord(parsed.value);
      const loaded = loadedSkillResourceFromReceipt(record, parsed, spec);
      if (loaded !== undefined) loadedResources.add(loaded);
      if (
        record.toolName === "koni_read_file" ||
        record.toolName === "koni_write_file" ||
        record.toolName === "koni_edit_file"
      ) {
        if (typeof value?.path === "string" && value.path.trim().length > 0)
          touchedFiles.add(value.path);
      } else if (record.toolName === "koni_list_files" && Array.isArray(value?.entries)) {
        // A directory inventory is discovery metadata, not evidence that every returned entry was
        // read. Folding thousands of recursively listed paths into compaction previously made the
        // checkpoint larger while diluting graph-context relevance. Exact receipt identity remains
        // retained above; only read/edit/write targets and actual search matches become touched.
      } else if (record.toolName === "koni_search_files" && Array.isArray(value?.matches)) {
        for (const match of value.matches) {
          if (isRecord(match) && typeof match.path === "string" && match.path.trim().length > 0) {
            touchedFiles.add(match.path);
          }
        }
      }
    }
    let descendant = attempt;
    const visited = new Set([attempt.id]);
    while (
      (descendant.lineage?.reason === "retry" || descendant.lineage?.reason === "recovery") &&
      descendant.lineage.conversationFork !== undefined &&
      descendant.lineage.parentAttemptId !== undefined
    ) {
      const parent = run.attempts[descendant.lineage.parentAttemptId];
      if (
        parent === undefined ||
        visited.has(parent.id) ||
        parent.sessionId !== descendant.lineage.parentSessionId ||
        parent.launchSpecHash !== descendant.lineage.conversationFork.parentLaunchSpecHash
      ) {
        fail("compaction_resource_lineage", "same-scope resource ancestry is unauthenticated");
      }
      visited.add(parent.id);
      const parentSpec = await this.#readRecordedLaunchSpec(run, parent);
      for (const record of parent.authorityToolResults ?? []) {
        if (record.toolName !== "koni_read_resource" || record.outcome !== "accepted") continue;
        const parsed = await this.#readAuthorityToolReceipt(run, parent, record);
        const loaded = loadedSkillResourceFromReceipt(record, parsed, parentSpec);
        if (loaded !== undefined) loadedResources.add(loaded);
      }
      descendant = parent;
    }
    return {
      receiptIds: [...receiptIds].sort(compareText),
      touchedFiles: [...touchedFiles].sort(compareText),
      loadedResources: [...loadedResources].sort(compareText),
    };
  }

  async #readAuthorityToolReceipt(
    run: Readonly<RunRecord>,
    attempt: Readonly<AgentAttemptRecord>,
    record: NonNullable<AgentAttemptRecord["authorityToolResults"]>[number],
  ): Promise<unknown> {
    const expectedPrefix = `runs/${run.id}/attempts/${attempt.id}/tool-receipts/`;
    if (
      !record.artifactPath.startsWith(expectedPrefix) ||
      path.posix.normalize(record.artifactPath) !== record.artifactPath
    ) {
      fail(
        "compaction_receipt_path",
        "authority tool result points outside its attempt receipt directory",
      );
    }
    const bytes = await readFile(path.join(this.#stateRoot, record.artifactPath));
    if (bytes.byteLength > 16 * 1024 * 1024 || bytes.includes(0)) {
      fail(
        "compaction_receipt_hash",
        "authority tool receipt bytes do not match their durable record",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("compaction_receipt_json", "authority tool receipt is not valid JSON");
    }
    const canonical = canonicalEncode(parsed);
    if (
      Buffer.byteLength(canonical, "utf8") !== record.receiptSizeBytes ||
      rawSha256(canonical) !== record.receiptSha256
    ) {
      fail(
        "compaction_receipt_hash",
        "authority tool receipt bytes do not match their durable record",
      );
    }
    return parsed;
  }

  async #readRecordedLaunchSpec(
    run: Readonly<RunRecord>,
    attempt: Readonly<AgentAttemptRecord>,
  ): Promise<Readonly<AgentLaunchSpec>> {
    const cached = this.#issuedSpecs.get(attempt.id);
    let parsed: unknown = cached;
    if (parsed === undefined) {
      const bytes = await readStableDurableFile(
        path.join(this.#stateRoot, `runs/${run.id}/attempts/${attempt.id}/launch-spec.json`),
        {
          minimum: 1,
          maximum: MAX_LAUNCH_SPEC_BYTES,
          label: `launch specification for ${attempt.id}`,
        },
      );
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("compaction_resource_spec", "ancestor launch specification is not valid JSON");
      }
    }
    let spec: Readonly<AgentLaunchSpec>;
    try {
      spec = validateAgentLaunchSpec(parsed as AgentLaunchSpec);
    } catch {
      fail("compaction_resource_spec", "ancestor launch specification is invalid");
    }
    if (
      spec.specHash !== attempt.launchSpecHash ||
      spec.identity.runId !== run.id ||
      spec.identity.attemptId !== attempt.id ||
      spec.identity.ticketId !== attempt.ticketId ||
      spec.identity.stepId !== attempt.stepId ||
      spec.identity.sessionId !== attempt.sessionId
    ) {
      fail("compaction_resource_spec", "ancestor launch specification identity drifted");
    }
    return spec;
  }
}

export function loadedSkillResourceFromReceipt(
  record: Readonly<{ toolName: string; outcome: string }>,
  receipt: unknown,
  spec: Readonly<AgentLaunchSpec>,
): string | undefined {
  if (record.toolName !== "koni_read_resource" || record.outcome !== "accepted") return undefined;
  try {
    validateKoniToolReceipt(receipt);
  } catch {
    return undefined;
  }
  if (receipt.outcome !== "accepted") return undefined;
  const value = optionalRecord(receipt.value);
  const resource = spec.resources.entries.find(
    (entry) =>
      entry.kind === "skill" &&
      entry.id === value?.resourceId &&
      entry.relativePath === value.relativePath &&
      entry.sha256 === value.sha256,
  );
  if (
    resource === undefined ||
    value?.offsetChars !== 0 ||
    value.eof !== true ||
    value.nextOffsetChars !== value.totalChars ||
    typeof value.content !== "string" ||
    Array.from(value.content).length !== value.totalChars ||
    rawSha256(value.content) !== resource.sha256
  ) {
    return undefined;
  }
  return `${resource.relativePath} (${resource.sha256})`;
}

function sameScopeContinuationPrompt(
  initialPrompt: string,
  lineage: Readonly<AgentLaunchSpec["lineage"]>,
  parentFailure?: string,
  compensatedValidationFailures: readonly string[] = [],
): string {
  const continuesSameScope = lineage.reason === "retry" || lineage.reason === "recovery";
  const authenticatedFork = lineage.conversationFork !== undefined && continuesSameScope;
  const boundedCompilerRecovery = compensatedValidationFailures.length > 0;
  if (!authenticatedFork && !boundedCompilerRecovery) return initialPrompt;
  const rejectionLedger = [...new Set(compensatedValidationFailures)].map(
    (failure, index) => `${index + 1}. ${failure}`,
  );
  if (!authenticatedFork) {
    return [
      initialPrompt,
      "This is a fresh same-scope compiler-recovery root because no safe authenticated conversation fork was available. No parent transcript is inherited; use only the current compiler-authenticated repository and graph context.",
      `Compiler-rejected outputs in this active bounded recovery chain (oldest to newest):\n${rejectionLedger.join("\n")}`,
      "Correct every listed contract failure in one complete submission. Do not regress an earlier correction while fixing the latest rejection.",
    ].join("\n\n");
  }
  return [
    initialPrompt,
    // "checks" deliberately absent from this list: assignment completion requires every configured
    // check receipt to be bound to the *current* attempt, so an agent that reuses inherited check
    // results produces zero valid receipts and fails completion. Reusing reads and decisions is
    // sound economy; reusing checks is a contract violation the compiler will reject.
    "This is an authenticated same-scope continuation. The inherited Pi conversation is the repository and execution ledger: reuse its successful reads, searches, and decisions instead of repeating them.",
    "An accepted inherited koni_read_resource receipt already satisfies skill loading for those immutable bytes. Reuse it and do not reload the same immutable resource after recovery or compaction.",
    "Configured checks are the exception to that reuse: a check receipt in inherited history belongs to the parent attempt and cannot satisfy this one. Re-run every configured check your step requires in this attempt, even when the inherited run passed.",
    "Discard any speculative reasoning from that failed turn; retain only authenticated repository results, compiler constraints, and the unfinished objective.",
    "The parent terminal or provider-error turn was not accepted output. A terminal-tool receipt visible in inherited history belongs to the parent attempt and is invalid for this attempt: do not answer that it was already submitted. Resolve the remaining action directly from the already-retained evidence and current objective, then invoke the required terminal tool exactly once in this attempt. Perform another repository call only when one specific missing fact makes correct completion impossible.",
    // The authority-classified cause of the parent's death is metadata the inherited transcript
    // never contains — without it, forks re-derived the failure from scratch or repeated it
    // (observed live: identical 40-turn loops across fork generations). Name it explicitly.
    ...(parentFailure === undefined
      ? []
      : [
          `The parent attempt ended for this authority-recorded reason: ${parentFailure}. Account for it directly instead of re-deriving it: an exhausted budget means finish minimal remaining work and submit immediately; a transient provider failure means your prior work is intact, so proceed straight to submission; a tool-contract rejection means correct that exact call rather than retrying variations.`,
          ...(parentFailure.includes("input token budget exceeded")
            ? [
                "Do not reissue an exact repository discovery call that already succeeded or was rejected as a duplicate. Treat its retained result or rejection as final; make at most one narrower request only for one decisive missing fact.",
              ]
            : []),
        ]),
    ...(rejectionLedger.length === 0
      ? []
      : [
          `Compiler-rejected outputs in this active bounded recovery chain (oldest to newest):\n${rejectionLedger.join("\n")}`,
          "Correct every listed contract failure in one complete submission. Do not regress an earlier correction while fixing the latest rejection.",
        ]),
  ].join("\n\n");
}

const COMPENSATED_VALIDATION_FAILURE_PREFIX =
  "Retired accepted output after a compensated validation";

function activeCompensatedValidationFailures(
  run: Readonly<RunRecord>,
  assignment: Readonly<ReadyAssignment> | undefined,
): string[] {
  if (assignment === undefined) return [];
  const step = run.tickets[assignment.ticketId]?.steps.find(
    (candidate) => candidate.id === assignment.stepId,
  );
  if (step === undefined) return [];
  const failures: string[] = [];
  for (const attemptId of [...step.attemptIds].reverse()) {
    const attempt = run.attempts[attemptId];
    const failure = attempt?.error ?? attempt?.terminalSummary;
    if (
      attempt?.status !== "interrupted" ||
      failure === undefined ||
      !failure.startsWith(COMPENSATED_VALIDATION_FAILURE_PREFIX)
    ) {
      break;
    }
    failures.push(failure.slice(0, 400));
  }
  return failures.reverse();
}

function createPinnedArtifact(
  runId: string,
  configuration: CompiledConfiguration,
  skills: Record<string, PinnedSkill>,
  resolvedPiAgents: Readonly<Record<string, ResolvedPiAgentConfiguration>>,
): PinnedConfigurationArtifact {
  const piAgents = Object.fromEntries(
    Object.entries(resolvedPiAgents)
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, agent]) => [
        id,
        {
          skillIds: agent.resources.skills.map((skill) => skill.id).sort(compareText),
          context: agent.resources.context.map((resource) => resource.content),
          configurationSha256: agent.configurationSha256,
        },
      ]),
  );
  const material: PinnedConfigurationMaterial = {
    protocol: PINNED_CONFIGURATION_PROTOCOL,
    runId,
    configuration,
    skills,
    piAgents,
  };
  return deepFreeze({ ...structuredClone(material), artifactSha256: canonicalHash(material) });
}

function validatePinnedArtifact(value: unknown): PinnedConfigurationArtifact {
  if (
    !isRecord(value) ||
    value.protocol !== PINNED_CONFIGURATION_PROTOCOL ||
    !isRecord(value.configuration) ||
    !isRecord(value.skills)
  ) {
    fail("pinned_configuration_shape", "pinned run configuration has an invalid shape");
  }
  const artifact = value as unknown as PinnedConfigurationArtifact;
  if (canonicalHash(withoutField(artifact, "artifactSha256")) !== artifact.artifactSha256) {
    fail(
      "pinned_configuration_hash",
      "pinned run configuration artifact hash does not match its bytes",
    );
  }
  const configuration = artifact.configuration;
  if (
    canonicalHash(withoutField(configuration, "configuration_sha256")) !==
    configuration.configuration_sha256
  ) {
    fail("configuration_hash", "pinned compiled configuration hash does not match its content");
  }
  for (const [id, skill] of Object.entries(artifact.skills)) {
    if (
      !isRecord(skill) ||
      skill.id !== id ||
      !isRecord(skill.files) ||
      !Object.hasOwn(skill.files, "SKILL.md")
    ) {
      fail("skill_hash", `pinned skill ${id} has an invalid package inventory`);
    }
    for (const [relativePath, rawFile] of Object.entries(skill.files)) {
      if (!isRecord(rawFile))
        fail("skill_hash", `pinned skill ${id}/${relativePath} has invalid metadata`);
      const file = rawFile as unknown as PinnedSkillFile;
      if (
        file.relativePath !== relativePath ||
        normalizeResourcePath(relativePath) !== relativePath ||
        typeof file.content !== "string" ||
        file.sizeBytes !== Buffer.byteLength(file.content, "utf8") ||
        rawSha256(file.content) !== file.sha256
      ) {
        fail("skill_hash", `pinned skill ${id}/${relativePath} does not match its content hash`);
      }
    }
  }
  if (artifact.piAgents !== undefined) {
    for (const [id, agent] of Object.entries(artifact.piAgents)) {
      if (
        !isRecord(agent) ||
        !Array.isArray(agent.skillIds) ||
        agent.skillIds.some(
          (skillId) => typeof skillId !== "string" || artifact.skills[skillId] === undefined,
        ) ||
        !Array.isArray(agent.context) ||
        agent.context.some((entry) => typeof entry !== "string") ||
        typeof agent.configurationSha256 !== "string" ||
        !isSha256Digest(agent.configurationSha256)
      ) {
        fail("pi_agent_resources", `pinned Pi resources for agent ${id} are invalid`);
      }
    }
  }
  return deepFreeze(structuredClone(artifact));
}

function attachHistoricalBehavior(
  artifact: PinnedConfigurationArtifact,
  behavior: CompiledBehaviorIr,
): PinnedConfigurationArtifact {
  const configuration = structuredClone(artifact.configuration);
  // The projection is runtime-only. Keeping it non-enumerable preserves the authenticated legacy
  // configuration and wrapper digests while allowing every semantic consumer to use one typed IR.
  Object.defineProperty(configuration, "behavior", {
    value: behavior,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const projected = { ...artifact, configuration } as PinnedConfigurationArtifact;
  if (
    canonicalHash(withoutField(configuration, "configuration_sha256")) !==
      configuration.configuration_sha256 ||
    canonicalHash(withoutField(projected, "artifactSha256")) !== projected.artifactSha256
  ) {
    fail(
      "historical_behavior_hash",
      "runtime compatibility projection changed authenticated pinned bytes",
    );
  }
  return deepFreeze(projected);
}

function assertPinnedMatchesRun(artifact: PinnedConfigurationArtifact, run: RunRecord): void {
  if (
    artifact.runId !== run.id ||
    artifact.configuration.configuration_sha256 !== run.compiledConfigHash
  ) {
    fail(
      "pinned_configuration_identity",
      "pinned configuration belongs to another run or compiler snapshot",
    );
  }
}

function resolveRunPiAgents(
  configuration: CompiledConfiguration,
  inventory: PiResolvedInventory,
): Readonly<Record<string, ResolvedPiAgentConfiguration>> {
  const catalog = piAgentCatalogFromCompiledConfiguration(configuration);
  const output: Record<string, ResolvedPiAgentConfiguration> = Object.create(null) as Record<
    string,
    ResolvedPiAgentConfiguration
  >;
  for (const agentId of Object.keys(catalog).sort(compareText)) {
    output[agentId] = requireValidation(
      resolvePiAgentConfiguration({
        agentId,
        agents: catalog,
        inventory,
        extensionAdapters: {},
      }),
      "pi_agent_invalid",
      `Pi resources for agent ${agentId} are not executable`,
    );
  }
  return output;
}

async function pinPiResolvedSkills(
  agents: Readonly<Record<string, ResolvedPiAgentConfiguration>>,
): Promise<Record<string, PinnedSkill>> {
  const selected = new Map<string, ResolvedPiAgentConfiguration["resources"]["skills"][number]>();
  for (const agent of Object.values(agents)) {
    for (const skill of agent.resources.skills) {
      const existing = selected.get(skill.id);
      if (existing !== undefined && existing.sha256 !== skill.sha256) {
        fail("skill_identity_collision", `Pi resolved different skills with id ${skill.id}`);
      }
      selected.set(skill.id, skill);
    }
  }
  const output: Record<string, PinnedSkill> = Object.create(null) as Record<string, PinnedSkill>;
  let totalFiles = 0;
  let totalBytes = 0;
  for (const [id, resource] of [...selected.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const skillRoot = path.dirname(resource.absolutePath);
    const metadata = await lstat(skillRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail("skill_directory", `skill ${id} is not a regular directory`);
    const canonical = await realpath(skillRoot);
    const files = await readSkillPackage(canonical, id);
    if (!Object.hasOwn(files, "SKILL.md")) fail("skill_file", `skill ${id} has no root SKILL.md`);
    totalFiles += Object.keys(files).length;
    totalBytes += Object.values(files).reduce((sum, file) => sum + file.sizeBytes, 0);
    if (totalFiles > MAX_SKILL_FILES || totalBytes > MAX_PINNED_SKILL_BYTES) {
      fail("skill_package_limit", "selected skill packages exceed the launch resource budget");
    }
    output[id] = { id, files };
  }
  return output;
}

async function readSkillPackage(
  skillRoot: string,
  skillId: string,
): Promise<Record<string, PinnedSkillFile>> {
  const output: Record<string, PinnedSkillFile> = Object.create(null) as Record<
    string,
    PinnedSkillFile
  >;
  const walk = async (directory: string, segments: string[]): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (
        entry.name.length === 0 ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("\u0000") ||
        entry.name.includes("/") ||
        entry.name.includes("\\")
      )
        fail("skill_path", `skill ${skillId} contains an unsafe resource name`);
      const source = path.join(directory, entry.name);
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink())
        fail("skill_symlink", `skill ${skillId} contains a symbolic link`);
      if (metadata.isDirectory()) {
        await walk(source, [...segments, entry.name]);
        continue;
      }
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SKILL_FILE_BYTES) {
        fail(
          "skill_file",
          `skill ${skillId} contains an empty, oversized, or non-regular resource`,
        );
      }
      const canonical = await realpath(source);
      if (!isWithinDirectory(skillRoot, canonical))
        fail("skill_escape", `skill ${skillId} resource escapes its package`);
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
          fail("skill_race", `skill ${skillId} changed while it was pinned`);
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (bytes.byteLength !== metadata.size)
        fail("skill_race", `skill ${skillId} changed while it was pinned`);
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes) || content.includes("\u0000")) {
        fail("skill_encoding", `skill ${skillId} resources must be non-NUL UTF-8 text`);
      }
      const relativePath = normalizeResourcePath([...segments, entry.name].join("/"));
      output[relativePath] = {
        relativePath,
        content,
        sha256: rawSha256(content),
        sizeBytes: bytes.byteLength,
      };
    }
  };
  await walk(skillRoot, []);
  return output;
}

function parseRunOverrides(
  value: JsonValue | undefined,
  configuration: CompiledConfiguration,
): {
  maxParallel?: number;
  questionPolicy?: "none" | "some" | "many";
  instructions?: string;
  workingSpecOwner?: string;
  agents: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
  roles: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
} {
  const output: {
    maxParallel?: number;
    questionPolicy?: "none" | "some" | "many";
    instructions?: string;
    workingSpecOwner?: string;
    agents: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
    roles: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
  } = {
    agents: Object.create(null) as Record<
      string,
      { provider?: string; model?: string; thinkingLevel?: string }
    >,
    roles: Object.create(null) as Record<
      string,
      { provider?: string; model?: string; thinkingLevel?: string }
    >,
  };
  if (value === undefined || value === null) return output;
  const source = requiredRecord(value, "run overrides");
  assertAllowedFields(
    source,
    ["maxParallel", "questionPolicy", "instructions", "workingSpecOwner", "agents", "roles"],
    "run overrides",
  );
  if (source.maxParallel !== undefined) {
    if (!Number.isSafeInteger(source.maxParallel) || (source.maxParallel as number) < 1)
      fail("override_parallel", "maxParallel must be at least one");
    output.maxParallel = source.maxParallel as number;
  }
  if (source.questionPolicy !== undefined) {
    if (!["none", "some", "many"].includes(String(source.questionPolicy)))
      fail("override_questions", "questionPolicy must be none, some, or many");
    output.questionPolicy = source.questionPolicy as "none" | "some" | "many";
  }
  if (source.instructions !== undefined)
    output.instructions = boundedText(source.instructions, "run instructions", 1024 * 1024);
  if (source.workingSpecOwner !== undefined) {
    output.workingSpecOwner = requiredNonempty(
      source.workingSpecOwner,
      "working-spec owner override",
    );
  }
  if (source.roles !== undefined) {
    const roles = requiredRecord(source.roles, "role overrides");
    const configuredRoles = new Set(
      Object.values(configuration.registries.personas)
        .map((persona) => optionalString(persona.model_role))
        .filter((role): role is string => role !== undefined),
    );
    for (const [roleId, raw] of Object.entries(roles)) {
      if (!configuredRoles.has(roleId)) fail("override_role", `unknown override role ${roleId}`);
      output.roles[roleId] = parseAgentSelection(raw, `role override ${roleId}`, roleId);
    }
  }
  if (source.agents !== undefined) {
    const agents = requiredRecord(source.agents, "agent overrides");
    for (const [personaId, raw] of Object.entries(agents)) {
      if (configuration.registries.personas[personaId] === undefined)
        fail("override_persona", `unknown override persona ${personaId}`);
      output.agents[personaId] = parseAgentSelection(raw, `agent override ${personaId}`, personaId);
    }
  }
  return output;
}

function parseAgentSelection(
  value: unknown,
  label: string,
  identity: string,
): { provider?: string; model?: string; thinkingLevel?: string } {
  const item = requiredRecord(value, label);
  assertAllowedFields(item, ["provider", "model", "thinkingLevel"], label);
  const selected: { provider?: string; model?: string; thinkingLevel?: string } = {};
  if (item.provider !== undefined)
    selected.provider = boundedText(item.provider, `${identity} provider`, 256);
  if (item.model !== undefined) selected.model = boundedText(item.model, `${identity} model`, 512);
  if (item.thinkingLevel !== undefined) {
    selected.thinkingLevel = requireThinkingLevel(item.thinkingLevel, label);
  }
  return selected;
}

function mergeAgentSelection(
  role: { provider?: string; model?: string; thinkingLevel?: string } | undefined,
  persona: { provider?: string; model?: string; thinkingLevel?: string } | undefined,
): { provider?: string; model?: string; thinkingLevel?: string } | undefined {
  if (role === undefined) return persona;
  if (persona === undefined) return role;
  return { ...role, ...persona };
}

function resolveWorkingSpecOwner(
  configuration: CompiledConfiguration,
  runType: ConfigurationObject,
  explicitOverride: string | undefined,
): string {
  const runTypeOwner = optionalString(optionalRecord(runType.working_spec)?.owner);
  const changeControl = optionalRecord(configuration.profile.change_control);
  const profileOwner = optionalString(changeControl?.working_spec_owner);
  const explicit = [
    ...new Set(
      [explicitOverride, runTypeOwner, profileOwner].filter(
        (value): value is string => value !== undefined,
      ),
    ),
  ];
  if (explicit.length > 1) {
    fail(
      "working_spec_owner_ambiguous",
      "working-spec owner configuration resolves to conflicting personas",
    );
  }
  if (explicit.length === 1) {
    const owner = explicit[0]!;
    if (configuration.registries.personas[owner] === undefined) {
      fail(
        "working_spec_owner_invalid",
        `configured working-spec owner ${owner} is not exactly one managed persona`,
      );
    }
    return owner;
  }
  const leads = Object.entries(configuration.registries.personas)
    .filter(([, persona]) => optionalString(persona.model_role) === "lead")
    .map(([id]) => id)
    .sort(compareText);
  if (leads.length !== 1) {
    fail(
      "working_spec_owner_resolution",
      leads.length === 0
        ? "run creation requires exactly one managed persona with model_role lead"
        : `run creation found multiple managed lead personas: ${leads.join(", ")}`,
    );
  }
  return leads[0]!;
}

function pipelineDefinition(document: ConfigurationObject): {
  order: string[];
  stages: ConfigurationObject;
} {
  const pipeline = requiredRecord(document.pipeline, "run pipeline");
  const stages = requiredRecord(pipeline.stages, "run pipeline stages");
  if (!Array.isArray(pipeline.order) || pipeline.order.length === 0)
    fail("pipeline_order", "run pipeline order is empty or invalid");
  const order = pipeline.order.map((item) => requiredNonempty(item, "pipeline stage id"));
  if (new Set(order).size !== order.length)
    fail("pipeline_order", "run pipeline contains duplicate stages");
  for (const id of order)
    if (!isRecord(stages[id])) fail("pipeline_stage", `run pipeline stage ${id} is missing`);
  return { order, stages: stages as ConfigurationObject };
}

function projectPipelineDefinition(pipeline: {
  order: string[];
  stages: ConfigurationObject;
}): RunPipelineStageDefinition[] {
  return pipeline.order.map((id) => {
    const stage = requiredRecord(pipeline.stages[id], `pipeline stage ${id}`);
    const config = optionalRecord(stage.config);
    const kind = optionalString(stage.kind) ?? "unknown";
    return {
      id,
      title: optionalString(stage.title) ?? humanize(id),
      kind,
      automatic:
        config?.automatic === true ||
        config?.compiler_owned === true ||
        new Set([
          "initialize",
          "planning",
          "orchestration",
          "target_sync",
          "checkpoint",
          "agent_review",
        ]).has(kind),
    };
  });
}

function projectCompiledPipelineDefinition(
  pipeline: readonly CompiledRunStage[],
): RunPipelineStageDefinition[] {
  const automaticallyDriven = new Set([
    "initialize",
    "planning",
    "orchestration",
    "target_sync",
    "checkpoint",
    "agent_review",
  ]);
  return pipeline.map((stage) => ({
    id: stage.id,
    title: stage.title,
    kind: stage.kind,
    automatic:
      stage.config.kind === "action"
        ? stage.config.automatic || stage.config.compilerOwned
        : automaticallyDriven.has(stage.kind),
  }));
}

function pinnedLeadJudgmentBehavior(
  run: RunRecord,
  configuration: CompiledConfiguration,
): CompiledLeadJudgmentBehavior {
  return pinnedRunTypeBehavior(run, configuration).leadJudgment;
}

function pinnedRunTypeBehavior(
  run: RunRecord,
  configuration: CompiledConfiguration,
): CompiledRunTypeBehavior {
  const compiledRunType = configuration.behavior.runTypes[run.runTypeId];
  if (compiledRunType === undefined) {
    fail("run_behavior", `pinned configuration has no behavior for run type ${run.runTypeId}`);
  }
  if (run.behavior !== undefined) {
    if (
      run.behavior.compiledBehaviorSha256 !== configuration.behavior.sha256 ||
      run.behavior.runType.id !== run.runTypeId ||
      run.behavior.runType.sha256 !== compiledRunType.sha256
    ) {
      fail("run_behavior_drift", "durable run behavior differs from the pinned configuration");
    }
    return run.behavior.runType;
  }
  // Imported pre-snapshot runs remain resumable from their complete immutable configuration
  // artifact. New runs always carry the smaller RunBehaviorSnapshot as well.
  return compiledRunType;
}

function leadJudgmentStepId(trigger: LeadJudgmentTrigger): string {
  return trigger === "orchestration_entry" ? "lead-orchestration-entry" : "lead-compiler-deadlock";
}

function leadTriggerForAttempt(attempt: Pick<AgentAttemptRecord, "stepId">): LeadJudgmentTrigger {
  if (attempt.stepId === "lead-orchestration-entry") return "orchestration_entry";
  if (attempt.stepId === "lead-compiler-deadlock") return "compiler_deadlock";
  fail("lead_trigger", `Lead attempt step ${attempt.stepId} does not encode a supported trigger`);
}

function leadJudgmentAttempt(
  run: RunRecord,
  trigger: LeadJudgmentTrigger,
  behavior: CompiledLeadJudgmentBehavior,
): AttemptDescriptor {
  if (!behavior.triggers.includes(trigger)) {
    fail("lead_trigger", `Lead judgment behavior does not support trigger ${trigger}`);
  }
  const tickets = Object.values(run.tickets)
    .sort((left, right) => left.priority - right.priority || compareText(left.id, right.id))
    .map((ticket) => {
      const settledDependencyIds = ticket.dependencyIds.filter((dependencyId) =>
        ticketDependencySettled(run.tickets[dependencyId]),
      );
      const settled = new Set(settledDependencyIds);
      return {
        id: ticket.id,
        operationId: ticket.operationId,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        dependencyIds: ticket.dependencyIds,
        settledDependencyIds,
        waitingOnDependencyIds: ticket.dependencyIds.filter(
          (dependencyId) => !settled.has(dependencyId),
        ),
        blocker: ticket.blocker,
        scope: {
          readNodeIds: ticket.readNodeIds ?? [],
          writeNodeIds: ticket.writeNodeIds ?? [],
          readPaths: ticket.readPaths,
          writePaths: ticket.writePaths,
        },
        steps: ticket.steps.map((step) => ({
          id: step.id,
          kind: step.kind,
          personaId: step.personaId,
          status: step.status,
          summary: step.summary,
        })),
      };
    });
  const activeAttempts = Object.values(run.attempts)
    .filter((attempt) =>
      new Set<AttemptStatus>(["queued", "running", "waiting_question", "terminal_accepted"]).has(
        attempt.status,
      ),
    )
    .sort((left, right) => compareText(left.id, right.id))
    .map((attempt) => ({
      id: attempt.id,
      ticketId: attempt.ticketId,
      stepId: attempt.stepId,
      personaId: attempt.personaId,
      status: attempt.status,
    }));
  const context = {
    protocol: "koni.attempt-context.v1",
    kind: "lead_judgment",
    trigger,
    judgment: {
      protocol: behavior.protocol,
      actionId: behavior.actionId,
      maxBoundariesPerAttempt: behavior.maxBoundariesPerAttempt,
    },
    run: {
      id: run.id,
      objective: run.objective,
      intake: run.intake,
      runTypeId: run.runTypeId,
      lifecycle: run.lifecycle.phase,
      pipelineStageId: run.currentPipelineStageId,
      graphRevision: run.graphRevision,
      graphHash: run.graphHash,
    },
    plan:
      run.plan === undefined
        ? undefined
        : {
            revision: run.plan.revision,
            status: run.plan.status,
            full: run.plan.full,
            concise: run.plan.concise,
          },
    questionPolicy:
      run.executionConfig?.semanticQuestionPolicy ??
      semanticQuestionPolicy(run.executionConfig?.questionPolicy ?? "some"),
    questionDefaultScope: run.executionConfig?.questionDefaultScope ?? "run",
    resolvedQuestions: answeredQuestionContext(run),
    unresolvedQuestions: Object.values(run.questions)
      .filter((question) => question.answeredAt === undefined)
      .sort((left, right) => compareText(left.id, right.id))
      .map((question) => ({
        id: question.id,
        scope: question.scope,
        ticketId: question.ticketId,
        prompt: question.prompt,
      })),
    ticketBoard: tickets,
    activeAttempts,
    requiredOutput: {
      protocol: behavior.terminal.protocol,
      disposition: behavior.terminal.dispositions,
      summary: "One concise, evidence-based readiness or blocker summary.",
    },
  };
  return {
    ticketId: "run-orchestration",
    stepId: leadJudgmentStepId(trigger),
    personaId: behavior.personaId,
    readPaths: [],
    writePaths: [],
    readNodeIds: [],
    writeNodeIds: [],
    graphMutation: "forbidden",
    initialPrompt: [
      behavior.prompt.trim(),
      trigger === "orchestration_entry"
        ? "Judge whether the approved run is ready to enter deterministic ticket orchestration."
        : "Judge the supplied compiler deadlock once; do not schedule, retry, poll, or mutate work.",
      "For dependency readiness, use the compiler-projected ticketBoard fields: only waitingOnDependencyIds establishes a current dependency wait; settledDependencyIds remains causal history and does not require a completed ticket status.",
      "Treat each nonterminal ticket in the current ticketBoard as a compiler-derived current obligation. Do not infer that it is stale or redundant merely because a completed or cancelled ticket overlaps its target or scope.",
      `Finish with exactly one ${LEAD_JUDGMENT_OUTPUT_PROTOCOL} output: disposition proceed or blocked, plus a concise summary.`,
    ].join("\n\n"),
    context,
    terminalSchema: leadJudgmentTerminalSchema(),
    toolProfile: "lead_judgment",
  };
}

function planningAttempt(
  run: RunRecord,
  runType: ConfigurationObject,
  configuration: CompiledConfiguration,
  revisionContext?: PlanningRevisionPreparationContext,
): AttemptDescriptor {
  const pipeline = pipelineDefinition(runType);
  const planning = pipeline.order.flatMap((id) => {
    const stage = requiredRecord(pipeline.stages[id], `pipeline stage ${id}`);
    if (stage.kind !== "planning") return [];
    const config = optionalRecord(stage.config) ?? {};
    return [
      {
        id,
        title: optionalString(stage.title) ?? id,
        persona: optionalString(config.agent) ?? "run-planner",
        prompt:
          optionalString(config.prompt) ?? "Produce the implementation-ready plan for this stage.",
      },
    ];
  });
  if (planning.length === 0) {
    fail(
      "planning_stage_missing",
      "this run type has no planning stage; the authority must use its direct-approval fast path",
    );
  }
  const personas = new Set(planning.map((stage) => stage.persona));
  if (personas.size !== 1)
    fail("planning_persona", "one managed planning session cannot impersonate multiple personas");
  const stageId = planning.at(-1)!.id;
  const graphSeedContract = planningGraphSeedContract(configuration);
  const latestSteering = run.plan?.steeringHistory.at(-1)?.instructions;
  const laterRevision =
    revisionContext?.binding.revision === undefined
      ? undefined
      : revisionContext.binding.revision > 0
        ? revisionContext
        : undefined;
  if (
    laterRevision !== undefined &&
    (laterRevision.currentArtifact === undefined || laterRevision.steering === undefined)
  ) {
    fail(
      "planning_revision_context",
      "later planning revision is missing its validated artifact or exact steering",
    );
  }
  const resolvedQuestions = answeredQuestionContext(run);
  const context = {
    protocol: "koni.attempt-context.v1",
    kind: "planning",
    run: { id: run.id, objective: run.objective, intake: run.intake, runTypeId: run.runTypeId },
    questionPolicy: run.executionConfig?.questionPolicy ?? "some",
    resolvedQuestions,
    stages: planning,
    instructions: run.executionConfig?.instructions ?? "",
    requiredOutput:
      laterRevision === undefined
        ? {
            title: "One 3-4 word operator-facing run name (3-60 characters).",
            full: PLAN_DOMAINS,
            concise: "Each domain is an independently authored list of {title, description} items.",
            graphSeed: graphSeedContract.context,
          }
        : {
            kind: "bounded_patch",
            baseRevision: laterRevision.binding.baseRevision,
            baseArtifactSha256: laterRevision.binding.priorCheckpointSha256,
            editableDomains: PLAN_DOMAINS,
            graphSeedOperations: [
              "setRootSpec",
              "removeRootSpecFields",
              "upsertNodes",
              "removeNodeKeys",
              "addEdges",
              "removeEdges",
            ],
          },
    ...(laterRevision === undefined
      ? {}
      : {
          currentValidatedArtifact: laterRevision.currentArtifact,
          planningRevision: laterRevision.binding,
          steering: laterRevision.steering,
        }),
  };
  return {
    ticketId: "run-planning",
    stepId: stageId,
    personaId: planning[0]!.persona,
    readPaths: ["."],
    writePaths: [],
    readNodeIds: [],
    writeNodeIds: [],
    graphMutation: "forbidden",
    initialPrompt:
      laterRevision === undefined
        ? [
            latestSteering === undefined
              ? `Plan this ${run.runTypeId} run: ${run.objective}`
              : [
                  `Revise the prior ${run.runTypeId} plan for this unchanged objective: ${run.objective}`,
                  "The prior accepted planning transcript is your starting point. Apply the operator steering exactly, preserve every unaffected sound decision, and do not repeat repository discovery unless one specific steering consequence cannot be resolved from retained evidence.",
                  `Operator steering for this revision:\n${latestSteering}`,
                ].join("\n\n"),
            "Complete every configured planning concern in one bounded shared session.",
            PLANNING_TERMINAL_INSTRUCTION,
            "The koni_submit_output arguments must contain four complete Markdown plans (architecture, decisions, risk, verification), four separately written concise title/description item lists for human approval, and the exact typed graph seed. Do not derive mini-plan headings by truncating the full prose.",
            'Required top-level shape (illustrative only; replace every ... with schema-valid content): {"title":"...","full":{"architecture":"...","decisions":"...","risk":"...","verification":"..."},"concise":{"architecture":[{"title":"...","description":"..."}],"decisions":[...],"risk":[...],"verification":[...]},"graphSeed":{"rootSpec":{...},"nodes":[...],"edges":[...]}}. All four full domains, all four concise domains, and graphSeed are required in the same first submission.',
            "After any validation error, correct every named field before retrying; never resubmit the same incomplete shape.",
            'Also emit a top-level "title": a concise 3-4 word name for this run, suitable as an operator dashboard row label. Do not restate the full objective.',
            "For graphSeed, reference the already-existing run objective only with the literal $root. rootSpec enriches that objective and never declares a node key. Every other edge endpoint must exactly equal a key declared in nodes; connect every declared node to $root and never invent a root alias from the objective title.",
          ].join("\n\n")
        : [
            "Continue this planning session. Apply the operator steering to the current compiler-valid plan.",
            PLANNING_TERMINAL_INSTRUCTION,
            "Preserve unchanged domains and graph elements. Submit only the bounded patch against the named base revision and artifact hash.",
            `Base revision: ${laterRevision.binding.baseRevision}\nBase artifact hash: ${laterRevision.binding.priorCheckpointSha256}`,
            `Operator steering for revision ${laterRevision.binding.revision}:\n${laterRevision.steering}`,
            `Resolved planning questions:\n${JSON.stringify(resolvedQuestions)}`,
            `Current compiler-valid planning artifact:\n${JSON.stringify(laterRevision.currentArtifact)}`,
            "Use the planning patch schema. Include only changed title, plan domains, concise review domains, or semantic graph operations. The compiler will preserve every omitted field and revalidate the complete materialized artifact.",
            "Within a patch, graphSeed may contain only setRootSpec, removeRootSpecFields, upsertNodes, removeNodeKeys, addEdges, and removeEdges. Never send the initial nodes/edges seed shape. Never add an unchanged edge again; use addEdges and removeEdges only for relations that actually change. Every newly upserted node key must either already exist or connect through addEdges to the retained graph in the same patch.",
          ].join("\n\n"),
    context,
    terminalSchema:
      laterRevision === undefined
        ? planningTerminalSchema(graphSeedContract.schema)
        : planningPatchTerminalSchema(),
  };
}

export function resolvePinnedGateAutoEvaluationContexts(input: {
  configuration: CompiledConfiguration;
  descriptorBoundary: "full" | "scoped";
  /** Ticket operation of the compiling descriptor; gate checks that do not apply to it are skipped. */
  operation?: string;
  subjectNodeIds: readonly string[];
  /** Gate nodes this descriptor is accountable for (target/write scope), when it has any. */
  ownedNodeIds?: readonly string[];
  contexts: readonly CompiledGatePolicyContext[];
}): ResolvedGateAutoEvaluationContextBinding[] {
  const projected = requireValidation(
    projectGatePolicyDefinitions(input.configuration),
    "gate_policy_invalid",
    "pinned gate policies did not compile",
  );
  const definitions = new Map(projected.map((policy) => [policy.id, policy] as const));
  const subjectIds = new Set(input.subjectNodeIds);
  const output: ResolvedGateAutoEvaluationContextBinding[] = [];
  const ownedIds = new Set(input.ownedNodeIds ?? []);
  const ownedGateBindings = new Set<ResolvedGateAutoEvaluationContextBinding>();
  for (const context of input.contexts) {
    if (canonicalHash(withoutField(context, "context_sha256")) !== context.context_sha256) {
      fail(
        "gate_policy_context_hash",
        `gate context ${context.gate_node_id} failed its compiler hash binding`,
      );
    }
    if (
      !subjectIds.has(context.gate_node_id) &&
      !context.evaluation_target_node_ids.some((id) => subjectIds.has(id))
    )
      continue;
    const rawPolicy = input.configuration.registries.gate_policies[context.policy_id];
    const definition = definitions.get(context.policy_id);
    if (
      rawPolicy === undefined ||
      definition === undefined ||
      definition.contractSha256 !== context.policy_contract_sha256
    ) {
      fail(
        "gate_policy_context_drift",
        `gate context ${context.context_sha256} differs from its pinned policy`,
      );
    }
    if (rawPolicy.auto_evaluate === undefined) continue;
    const auto = requiredRecord(
      rawPolicy.auto_evaluate,
      `gate policy ${context.policy_id} auto_evaluate`,
    );
    assertExactFields(
      auto,
      ["check", "boundaries"],
      `gate policy ${context.policy_id} auto_evaluate`,
    );
    const checkId = requiredNonempty(
      auto.check,
      `gate policy ${context.policy_id} auto-evaluate check`,
    );
    const boundaries = stringArray(
      auto.boundaries,
      `gate policy ${context.policy_id} auto-evaluate boundaries`,
    );
    if (
      new Set(boundaries).size !== boundaries.length ||
      boundaries.some((boundary) => boundary !== "full" && boundary !== "scoped")
    ) {
      fail(
        "gate_policy_auto_boundary",
        `gate policy ${context.policy_id} declares an invalid auto-evaluate boundary`,
      );
    }
    if (!boundaries.includes(input.descriptorBoundary)) continue;
    const checkDefinition = input.configuration.registries.checks[checkId];
    if (checkDefinition === undefined) {
      fail(
        "gate_policy_auto_check",
        `gate policy ${context.policy_id} references missing check ${checkId}`,
      );
    }
    // A gate auto-evaluation is an obligation of the operations its check applies to. A ticket
    // that merely reads or links the gate node (e.g. experiment design touching a gate) must not
    // fail its launch compile over it — the gate evaluates under its own applicable operation.
    const applies = stringArray(checkDefinition.applies_to, `${checkId} applies_to`);
    if (input.operation !== undefined && applies.length > 0 && !applies.includes(input.operation))
      continue;
    const material = {
      policyId: context.policy_id,
      policyContractSha256: context.policy_contract_sha256,
      checkId,
      boundary: input.descriptorBoundary,
      gateNodeId: context.gate_node_id,
      contextSha256: context.context_sha256,
      readPaths: Object.freeze([...new Set(context.read_paths)].sort(compareText)),
    } as const;
    const binding = deepFreeze({ ...material, sha256: canonicalHash(material) });
    output.push(binding);
    if (ownedIds.has(context.gate_node_id)) ownedGateBindings.add(binding);
  }
  // Sibling gates share an evaluation target, so a gate node reachable only through that shared
  // target rides along with the gate the ticket actually owns. Two contexts then declare the same
  // auto-evaluate check id, and the step's bare `validation_checks` entry can no longer name one
  // of them, which fails the entire check plan. When the ticket names gates outright those are its
  // obligation; a context matched only via a shared evaluation target belongs to its own gate's
  // ticket and is dropped here.
  const selected =
    ownedGateBindings.size > 0 ? output.filter((b) => ownedGateBindings.has(b)) : output;
  return selected.sort((left, right) =>
    compareText(`${left.policyId}\0${left.gateNodeId}`, `${right.policyId}\0${right.gateNodeId}`),
  );
}

function portfolioGuidancePrompt(binding: ExecutionPolicyBinding): string {
  const guidance = binding.context.portfolioGuidance?.value;
  if (guidance === undefined) return "";
  return [
    `Portfolio guidance: prefer ${guidance.preferredCount} ${guidance.unit}.`,
    `Group when ${guidance.groupWhen}.`,
    `Split when ${guidance.splitWhen}.`,
    `Avoid ${guidance.avoid}.`,
  ].join(" ");
}

export function orderedReviewPredecessorStepIds(
  workflow: readonly Pick<DerivedWorkflowStep, "id" | "depends_on">[],
  reviewStep: Pick<DerivedWorkflowStep, "id" | "depends_on">,
): string[] {
  const byId = new Map(workflow.map((step) => [step.id, step]));
  const closure = new Set<string>();
  const visit = (stepId: string): void => {
    if (closure.has(stepId)) return;
    if (stepId === reviewStep.id) {
      fail("review_evidence_cycle", `review step ${reviewStep.id} depends on itself`);
    }
    const step = byId.get(stepId);
    if (step === undefined) {
      fail(
        "review_evidence_step",
        `review predecessor ${stepId} is absent from the compiled workflow`,
      );
    }
    for (const dependencyId of step.depends_on) visit(dependencyId);
    closure.add(stepId);
  };
  for (const predecessorStepId of reviewStep.depends_on) visit(predecessorStepId);
  return workflow.filter((step) => closure.has(step.id)).map((step) => step.id);
}

/** Every dependent step needs the exact accepted outputs that causally precede it. */
export function shouldAttachPredecessorExecution(
  step: Pick<DerivedWorkflowStep, "kind" | "depends_on">,
): boolean {
  return step.kind === "review" || step.depends_on.length > 0;
}

export interface ApprovedChangeObligationContext {
  readonly ticketId: string;
  readonly approvedApplicationSha256: Sha256Digest;
  readonly targetNodeIds: readonly string[];
  readonly summary: string;
  /** The application delta is accepted but its control workflow has not settled yet. */
  readonly inFlight?: true;
  readonly operatorSteering?: readonly string[];
}

/** Preserve an approved semantic obligation after its control ticket has settled. */
export function approvedChangeObligationsForTargets(
  run: Pick<RunRecord, "tickets">,
  targetNodeIds: readonly string[],
): ApprovedChangeObligationContext[] {
  const targets = new Set(targetNodeIds);
  return Object.values(run.tickets)
    .filter(
      (ticket) =>
        ticket.status === "completed" &&
        ticket.executionControl?.controlTicketAuthority?.role === "approved_application" &&
        ticket.executionControl.approvedApplicationSha256 !== undefined &&
        ticket.summary.trim().length > 0 &&
        ticket.targetNodeIds.some((nodeId) => targets.has(nodeId)),
    )
    .sort((left, right) => compareText(left.id, right.id))
    .map((ticket) => ({
      ticketId: ticket.id,
      approvedApplicationSha256: ticket.executionControl!.approvedApplicationSha256!,
      targetNodeIds: [...ticket.targetNodeIds],
      summary: ticket.summary,
    }));
}

/** Control proposals authorize later work; they do not themselves inherit settled application work. */
export function approvedChangeObligationsForAttempt(
  run: Pick<RunRecord, "tickets">,
  targetNodeIds: readonly string[],
  operationRole: CompiledChangeControl["role"],
): ApprovedChangeObligationContext[] {
  if (operationRole === "proposal") return [];
  const settled = approvedChangeObligationsForTargets(run, targetNodeIds);
  if (operationRole !== "ordinary") return settled;
  const targets = new Set(targetNodeIds);
  const inFlight = Object.values(run.tickets)
    .filter(
      (ticket) =>
        ticket.status !== "completed" &&
        ticket.executionControl?.controlTicketAuthority?.role === "approved_application" &&
        ticket.executionControl.approvedApplicationSha256 !== undefined &&
        ticket.targetNodeIds.some((nodeId) => targets.has(nodeId)),
    )
    .sort((left, right) => compareText(left.id, right.id))
    .flatMap((ticket) => {
      const sourceProposalId = ticket.executionControl?.sourceProposalTicketId;
      const sourceProposal =
        sourceProposalId === undefined ? undefined : run.tickets[sourceProposalId];
      const summary = sourceProposal?.summary.trim() || ticket.summary.trim();
      if (summary.length === 0) return [];
      const sourceControl = sourceProposal?.executionControl;
      const approvalSha256 = sourceControl?.proposalApprovalSha256;
      return [
        {
          ticketId: ticket.id,
          approvedApplicationSha256: ticket.executionControl!.approvedApplicationSha256!,
          targetNodeIds: [...ticket.targetNodeIds],
          summary,
          inFlight: true as const,
          ...(approvalSha256 === undefined
            ? {}
            : {
                operatorSteering: approvedProposalAuditSteering(
                  sourceControl?.proposalDecisionHistory ?? [],
                  approvalSha256,
                ),
              }),
        },
      ];
    });
  return [...settled, ...inFlight];
}

export function approvedChangeObligationInstructions(
  obligation: ApprovedChangeObligationContext,
  stepKind: DerivedWorkflowStep["kind"] = "production",
): string[] {
  const reviewBoundary =
    stepKind === "review"
      ? "Treat the complete approved request and operator steering as binding review criteria. If the current candidate does not satisfy them, reject it with a precise repair blocker so the compiler can reopen the source-owning implementation step. Do not edit files or graph nodes during independent review."
      : undefined;
  if (obligation.inFlight === true) {
    return [
      `In-flight approved-change obligation ${obligation.approvedApplicationSha256} from ${obligation.ticketId}: ${obligation.summary}`,
      ...(obligation.operatorSteering ?? []),
      ...(reviewBoundary === undefined
        ? [
            "The compiler is currently applying this exact approved request through the source-owning workflow. Treat its complete request and operator steering as binding input for the files and authored contract in this attempt; do not substitute repository neighbors, invent gate identities, or wait for the application control ticket to settle.",
          ]
        : [reviewBoundary]),
    ];
  }
  return [
    `Durable approved-change obligation ${obligation.approvedApplicationSha256} from ${obligation.ticketId}: ${obligation.summary}`,
    "This authenticated obligation survives the completed control ticket. Before claiming it is satisfied, read every named target file available in this ticket's scope and compare the current argv element-by-element with the approved argv; omitted, reordered, or substituted secondary script arguments are material defects. Verify named implementation mechanisms literally (for example runpy versus subprocess) from file content, never from a filename or prior summary. Preserve its exact algorithms, argv shape, and bounded target semantics.",
    ...(reviewBoundary === undefined
      ? [
          "If the current graph or files do not satisfy it, repair them within this ticket's grant or raise the smallest upstream change request; do not silently substitute a different implementation.",
        ]
      : [reviewBoundary]),
  ];
}

/** Independent review observes a sealed candidate and can only return a typed verdict. */
export function effectiveAssignmentWriteScope(input: {
  readonly stepKind: DerivedWorkflowStep["kind"];
  readonly graphMutation: DerivedWorkflowStep["graph_mutation"];
  readonly writePaths: readonly string[];
  readonly writeNodeIds: readonly string[];
}): {
  graphMutation: DerivedWorkflowStep["graph_mutation"];
  writePaths: string[];
  writeNodeIds: string[];
} {
  if (input.stepKind === "review") {
    return { graphMutation: "forbidden", writePaths: [], writeNodeIds: [] };
  }
  return {
    graphMutation: input.graphMutation,
    writePaths: [...input.writePaths],
    writeNodeIds: [...input.writeNodeIds],
  };
}

/** Keep approved proposal selection and its independent review on their distinct stages. */
export function approvedProposalAttemptInstructions(input: {
  readonly approved: boolean;
  readonly proposalStepId: string | undefined;
  readonly stepId: string;
  readonly stepKind: DerivedWorkflowStep["kind"];
  readonly applicationOperations: readonly string[];
}): string[] {
  if (!input.approved || input.proposalStepId === undefined) return [];
  if (input.stepId === input.proposalStepId) {
    return [
      "This proposal-selection step is intentionally read-only. Empty graph and repository write scopes, graph_mutation forbidden, and maxNewNodes 0 do not block selecting an authorized changeApplication: this step records the bounded selection, and the separately materialized application ticket performs any approved mutation with its own compiler-derived authority.",
      "For this approved proposal, submit the exact authorized changeApplication when the request remains unsatisfied. Do not select no-op while the approved request remains unsatisfied; no-op is allowed only when the requested state is already satisfied in the current scoped graph.",
      ...(input.applicationOperations.length === 0
        ? []
        : [
            `Use changeApplication.operation ${input.applicationOperations.map((operation) => `\"${operation}\"`).join(" or ")}; do not use the proposal operation name as an application operation.`,
          ]),
    ];
  }
  if (input.stepKind !== "review") return [];
  return [
    "This is a pre-application review of the predecessor changeApplication selection. Validate that the selection is exactly bound to the approved request, stays within its control scope, and chooses an authorized application operation. Do not reject the selection merely because the requested state is still unsatisfied: no application ticket can be materialized until this review approves. Do not demand that this read-only proposal ticket produce the requested files or post-application gate verdicts. Approve a correctly bounded selection so the compiler can materialize the separate application ticket; reject only a defect in the selection or its approval binding.",
  ];
}

/** Surface append-only post-approval messages without misrepresenting them as revocation. */
export function approvedProposalAuditSteering(
  history: NonNullable<TicketExecutionControlRecord["proposalDecisionHistory"]>,
  approvalSha256: Sha256Digest,
): string[] {
  const approvalIndex = history.findIndex((event) => event.sha256 === approvalSha256);
  if (approvalIndex < 0) return [];
  return history.slice(approvalIndex + 1).flatMap((event) => {
    const message = event.message?.trim();
    return message === undefined || message.length === 0
      ? []
      : [`Operator audit-only steering after approval (does not revoke approval): ${message}`];
  });
}

/** Preserve the operator's exact correction when a rejected proposal reissues its source. */
export function rejectedSourceProposalInstructions(
  run: Pick<RunRecord, "tickets">,
  sourceTicketId: string,
): string[] {
  const rejections = Object.values(run.tickets)
    .filter((ticket) => {
      const control = ticket.executionControl;
      return (
        control?.proposalRequest?.sourceTicketId === sourceTicketId &&
        control.proposalDecision?.decision === "rejection" &&
        control.proposalDisposition?.kind === "rejected"
      );
    })
    .sort((left, right) => {
      const leftDecision = left.executionControl!.proposalDecision!;
      const rightDecision = right.executionControl!.proposalDecision!;
      return (
        leftDecision.recordedAt.localeCompare(rightDecision.recordedAt) ||
        compareText(left.id, right.id)
      );
    });
  if (rejections.length === 0) return [];
  return [
    ...rejections.map((ticket) => {
      const control = ticket.executionControl!;
      const request = control.proposalRequest!;
      const decision = control.proposalDecision!;
      return `Operator rejection ${decision.sha256} for prior upstream request ${ticket.id} (${request.requestSha256}): ${decision.message}`;
    }),
    "Treat that rejection as binding corrective evidence. Do not repeat the rejected upstream request from older diagnostics unless new compiler-authenticated evidence recorded after the rejection contradicts it; continue the source workflow under the operator's correction.",
  ];
}

/** The materialized application inherits every append-only clarification on its source approval. */
export function approvedApplicationAuditSteering(
  run: Pick<RunRecord, "tickets">,
  application: Pick<TicketRecord, "executionControl">,
): string[] {
  const sourceProposalTicketId = application.executionControl?.sourceProposalTicketId;
  if (sourceProposalTicketId === undefined) return [];
  const sourceControl = run.tickets[sourceProposalTicketId]?.executionControl;
  const approvalSha256 = sourceControl?.proposalApprovalSha256;
  if (approvalSha256 === undefined) return [];
  return approvedProposalAuditSteering(
    sourceControl?.proposalDecisionHistory ?? [],
    approvalSha256,
  );
}

/** Keep a graph-only application review from duplicating the source workflow's file review. */
export function approvedApplicationGraphOnlyReviewInstruction(input: {
  readonly operationRole: CompiledChangeControl["role"];
  readonly stepKind: DerivedWorkflowStep["kind"];
  readonly readPaths: readonly string[];
}): string | undefined {
  if (
    input.operationRole !== "application" ||
    input.stepKind !== "review" ||
    input.readPaths.length !== 0
  ) {
    return undefined;
  }
  return [
    "This is a graph-only application review: judge the exact scoped semantic delta and the ordered cumulative operator steering.",
    "The source-owning filesystem workflow independently reviews candidate bytes and publishes the compiler-owned asset manifest.",
    "Past diagnostic prose reports the state observed when it was recorded; it is not proof that inaccessible file bytes remain unchanged after a later source workflow or follow-up audit.",
    "Do not reject this graph application solely for alleged file contents you have no read grant to inspect, and do not demand duplicate filesystem proof from this control ticket.",
    "Do reject a graph defect, a missing route to the source-owning workflow, or a current scoped graph state that contradicts the latest cumulative steering.",
  ].join(" ");
}

/** A later run-plan ticket may not silently contradict an exact approved argv. */
export function assertApprovedChangeRuntimeObligations(
  run: Pick<RunRecord, "tickets">,
  graph: Pick<TypedGraph, "node">,
  writableNodeIds: readonly string[],
): void {
  const writable = new Set(writableNodeIds);
  for (const obligation of approvedChangeObligationsForTargets(run, writableNodeIds)) {
    const gateVerifierPaths = new Set<string>();
    const entrypoints = obligation.targetNodeIds.flatMap((nodeId) => {
      const node = graph.node(nodeId);
      if (node?.type !== "asset") return [];
      const implementation = optionalRecord(node.spec.implementation);
      const assetEntrypoints = stringArray(
        implementation?.entrypoints,
        `asset ${nodeId} implementation entrypoints`,
      );
      const gateContracts = optionalRecord(node.spec.gate_contracts);
      for (const contractValue of Object.values(gateContracts ?? {})) {
        const contract = optionalRecord(contractValue);
        if (!Array.isArray(contract?.argv)) continue;
        for (const argument of contract.argv) {
          if (typeof argument === "string" && assetEntrypoints.includes(argument)) {
            gateVerifierPaths.add(argument);
          }
        }
      }
      return assetEntrypoints;
    });
    const commandPattern = /([A-Za-z0-9][A-Za-z0-9._:-]*)\s*\(command=\[([^\]]*)\]\)/gu;
    for (const match of obligation.summary.matchAll(commandPattern)) {
      const nodeId = match[1]!;
      if (!writable.has(nodeId)) continue;
      const node = graph.node(nodeId);
      if (node?.type !== "run") continue;
      const rawArgv = [...match[2]!.matchAll(/'([^']*)'|"([^"]*)"/gu)].map(
        (token) => token[1] ?? token[2]!,
      );
      if (rawArgv.length === 0) {
        fail(
          "approved_change_obligation",
          `approved change ${obligation.ticketId} carries an unreadable command for ${nodeId}`,
        );
      }
      const expectedArgv = rawArgv.map((argument) => {
        if (!argument.startsWith(".../")) return argument;
        const suffix = argument.slice(3);
        const candidates = [
          ...new Set(entrypoints.filter((entrypoint) => entrypoint.endsWith(suffix))),
        ];
        if (candidates.length !== 1) {
          fail(
            "approved_change_obligation",
            `approved change ${obligation.ticketId} cannot resolve ${argument} to one target asset entrypoint`,
          );
        }
        return candidates[0]!;
      });
      const contract = optionalRecord(node.spec.runtime_contract);
      const command = contract?.command;
      if (
        !Array.isArray(command) ||
        command.some((argument) => typeof argument !== "string" || argument.trim().length === 0)
      ) {
        fail(
          "approved_change_obligation",
          `run ${nodeId} must carry one nonempty argv for approved change ${obligation.ticketId}`,
        );
      }
      const actualArgv = command as string[];
      if (
        actualArgv.length !== expectedArgv.length ||
        actualArgv.some((argument, index) => argument !== expectedArgv[index])
      ) {
        fail(
          "approved_change_obligation",
          `run ${nodeId} must retain approved command ${JSON.stringify(expectedArgv)} from ${obligation.ticketId}; received ${JSON.stringify(actualArgv)}`,
        );
      }
      const scientificInputs = Array.isArray(contract?.scientific_inputs)
        ? contract.scientific_inputs.flatMap((value) => {
            const input = optionalRecord(value);
            return typeof input?.path === "string" ? [input] : [];
          })
        : [];
      const scientificInputPaths = new Set(scientificInputs.map((input) => input.path as string));
      for (const argument of expectedArgv.slice(1)) {
        if (!argument.includes("/") || argument.startsWith("-")) continue;
        if (scientificInputPaths.has(argument)) continue;
        fail(
          "approved_change_obligation",
          `run ${nodeId} approved command path ${argument} must remain a scientific input under ${obligation.ticketId}`,
        );
      }
      if (/no change to [^.]*scientific_inputs roles/iu.test(obligation.summary)) {
        const protocolAdapterRequired = /protocol adapter/iu.test(obligation.summary);
        for (const argument of expectedArgv.slice(1)) {
          if (!argument.includes("/") || argument.startsWith("-")) continue;
          const requiredRole = gateVerifierPaths.has(argument)
            ? "verifier_contract"
            : protocolAdapterRequired
              ? "protocol_adapter"
              : undefined;
          if (requiredRole === undefined) continue;
          const input = scientificInputs.find((candidate) => candidate.path === argument);
          if (input?.role === requiredRole) continue;
          fail(
            "approved_change_obligation",
            `run ${nodeId} scientific input role for ${argument} must remain ${requiredRole} under ${obligation.ticketId}`,
          );
        }
      }
    }
  }
}

export function shouldAssertApprovedChangeRuntimeObligations(
  step: Pick<DerivedWorkflowStep, "id" | "graph_mutation">,
): boolean {
  return step.id !== "diagnose" && step.graph_mutation !== "forbidden";
}

export function assertFailedReviewDoesNotContradictApprovedChangeRuntimeObligations(
  run: Pick<RunRecord, "tickets">,
  graph: Pick<TypedGraph, "node">,
  writableNodeIds: readonly string[],
  blocker: string,
): void {
  const obligations = approvedChangeObligationsForTargets(run, writableNodeIds);
  if (obligations.length === 0) return;
  try {
    assertApprovedChangeRuntimeObligations(run, graph, writableNodeIds);
  } catch {
    return;
  }
  const contradicted = obligations.find(
    (obligation) =>
      blocker.includes(obligation.ticketId) ||
      blocker.includes(obligation.approvedApplicationSha256),
  );
  if (contradicted === undefined) return;
  fail(
    "approved_change_review_contradiction",
    `failed review blocker contradicts satisfied approved change ${contradicted.ticketId}; review the current graph and durable obligation`,
  );
}

/**
 * Explain the compiler-owned filesystem acceptance boundary to asset reviewers.
 *
 * The manifest in the review graph describes the last accepted predecessor bytes. A later
 * workflow step may have changed the candidate files legitimately. The review verdict is the
 * authority that permits `applyReviewEffects` to derive and publish the new manifest, so requiring
 * that predecessor manifest to match before approval makes the atomic transition impossible.
 */
export function implementAssetReviewManifestInstruction(
  operation: string | undefined,
  stepKind: string,
): string | undefined {
  if (operation !== "implement-asset" || stepKind !== "review") return undefined;
  return [
    "Review the current scoped filesystem bytes as the candidate.",
    "A stale compiler-owned filesystem manifest is expected when an earlier workflow step changed those bytes; do not reject solely because its accepted hash describes predecessor bytes.",
    "If the current asset satisfies the review contract, approve it: after approval the compiler atomically derives and publishes the current manifest from the reviewed bytes.",
    "Reject only a defect in the current bytes or authored contract, and never author compiler-owned manifest fields yourself.",
  ].join(" ");
}

/** Keep implementation instructions honest about the exact compiled tool inventory. */
export function implementationWriteGrantInstructions(
  hasWriteGrant: boolean,
  validationCheckCount: number,
): readonly string[] {
  if (!hasWriteGrant) return [];
  const implementationBoundary =
    "This is an implementation attempt with a write grant. Reading alone does not satisfy it. Make the change with koni_write_file/koni_edit_file inside your write grant. Reserve a failed submission for a blocker that survives an actual implementation attempt (missing capability, contradictory contract, grant that cannot express the change), never for difficulty, uncertainty, or investigation you have not yet turned into an edit.";
  if (validationCheckCount === 0) {
    return [
      implementationBoundary,
      "No configured command proof is available in this attempt, so koni_run_check is intentionally absent. Inspect the exact authored bytes and authenticated causal evidence before submitting; do not treat the absence of an unconfigured check tool as a blocker when the requested file can be authored from that evidence.",
    ];
  }
  return [
    `${implementationBoundary} Run the configured proof with koni_run_check before you submit.`,
    "If the configured proof fails, that is normal iteration, not a blocker: read the failure, fix the edit, and run it again. Keep iterating until it passes or you have proven the objective is impossible within the grant. Do not stop after a single failing check.",
  ];
}

/** Keep recurring gate-provider repair attempts causal instead of merely descriptive. */
export function gateRepairInstruction(evidenceCount: number): string | undefined {
  if (evidenceCount === 0) return undefined;
  return [
    "Compiler-authenticated gateRepairEvidence is attached because current accepted gate receipts are nonpassing and this causal repair attempt was opened or reopened.",
    "expected_red describes an allowed initial check state; it does not make a current nonpassing receipt sufficient for downstream execution.",
    "Treat every attached diagnostic as an active repair obligation.",
    "Do not submit a no-op merely because files and manifests are current.",
    "Changing diagnostic wording, labels, or cause categories does not repair an unchanged nonpassing condition.",
    "Materially repair the cause within this grant; when the cause is outside this grant, raise the smallest upstream change request in this attempt instead of editing only its description.",
    "The application write scope is exactly its targetNodeIds. For a missing causal asset artifact, target the existing source-owning asset node or nodes visible in this attempt's causal scope, not merely the gate nodes that report the symptom.",
    "The attached commands[].result measurements are authenticated causal outputs. When they contain the exact regenerated hashes, paths, or other values required by the missing source artifact, use those exact values instead of demanding another execution of work the receipt already proves.",
    'An upstream change request is a successful handoff: submit it with status "completed", never status "failed".',
  ].join(" ");
}

/** Keep compatibility-scoped source repair causal when historical obligations describe pre-failure state. */
export function standaloneSupportRunAssetRepairInstruction(ruleId: string): string | undefined {
  if (ruleId !== "compiler.compatibility.standalone-support-run-asset-repair-scope") {
    return undefined;
  }
  return [
    "This compatibility ticket exists because a later compiler-authenticated standalone runtime failure supersedes older statements that the asset was already current, that only execution was missing, or that no source edit was requested.",
    "Do not use those pre-failure descriptions or an unchanged manifest as evidence that this repair can be a no-op.",
    "Preserve the authored thresholds, behavior scope, and output contract, but improve the source implementation that produces the failed measurements—for example its training procedure, optimizer, initialization, or other bounded implementation detail inside this write grant.",
    "The downstream standalone runtime rerun supplies validation after integration; the intentional absence of koni_run_check in this source-only attempt does not make a material source repair forbidden or unverifiable.",
  ].join(" ");
}

/** Keep a failed post-repair gate recheck moving toward the first writable cause. */
export function repairedProviderGateRecheckInstruction(
  operationRegistryId: string | undefined,
  sourceStateKey: string | undefined,
  stepId: string,
): string | undefined {
  if (
    operationRegistryId !== "gates.gate.run-gate" ||
    sourceStateKey !== "direct-scientific-gate-blocked-after-provider-repair" ||
    stepId !== "analyze"
  ) {
    return undefined;
  }
  return [
    "This is a compiler-created recheck after the selected gate provider completed repair.",
    "If the current accepted receipt passes, interpret it normally.",
    "If it remains nonpassing, diagnose the first unmet causal precondition; expected_red does not settle the current readiness obligation.",
    "Do not stop at receipt interpretation or another observation.",
    "Repair the cause within this grant, or when the cause is outside this grant, raise the smallest upstream change request in this attempt.",
  ].join(" ");
}

export function upstreamChangeRequestInstructions(
  changeControl: CompiledChangeControl | undefined,
): string[] {
  if (changeControl?.role !== "ordinary" || !changeControl.allowUpstreamRequests) return [];
  return [
    'This step has an explicit upstream-change route. If satisfying the contract requires changing a read-only asset or another node outside this step\'s write authority, do not fabricate an inline substitute, weaken the contract, or upsert that node. Submit status "completed" with summary and upstreamChangeRequest, and omit graphDelta. Exact shape: {"status":"completed","summary":"...","upstreamChangeRequest":{"targetNodeIds":["the-existing-causal-node-id"],"fulfillment":"planned_asset_repair","summary":"...","reason":"..."}}.',
    'Use fulfillment "planned_asset_repair" only when the existing asset implementation workflow can satisfy the whole request by editing that asset\'s authored source files or contracts. Use "dynamic_scope_change" when fulfillment needs a new run or node, runtime execution/output, or authority beyond the existing asset source grant.',
    'Graph write authority does not make fields that derive this ticket\'s repository grant mutable during the active attempt. If accepted repository evidence contradicts a scope-bearing field, stop probing the rejected path and submit the upstreamChangeRequest without graphDelta; use fulfillment "dynamic_scope_change" for the correction even when the replacement path is already inside the issued grant.',
  ];
}

function ticketAttempt(
  run: RunRecord,
  definition: DerivedTicketDefinition,
  step: DerivedWorkflowStep,
  graph: TypedGraph,
  configuration: CompiledConfiguration,
  executionCatalog: CompiledExecutionSemanticCatalog,
  gatePolicyContexts: readonly CompiledGatePolicyContext[],
  predecessorExecution?: Record<string, unknown>,
  reviewCandidateNodeIds: readonly string[] = [],
  historicalPreparation?: Record<string, unknown>,
  gateRepairEvidence: readonly CurrentNonpassingGateRepairEvidence[] = [],
): AttemptDescriptor {
  const semantic = resolveDefinitionExecutionBindings(executionCatalog, definition);
  const executionPolicyBinding = semantic.steps.get(step.id);
  if (executionPolicyBinding === undefined) {
    fail("execution_policy_step", `ticket ${definition.id} has no semantic binding for ${step.id}`);
  }
  const durableTicket = run.tickets[definition.id] as SemanticTicketRecord | undefined;
  const durableStep = durableTicket?.steps.find((candidate) => candidate.id === step.id);
  const activeReviewRework =
    durableTicket !== undefined && reviewReworkCoversStep(durableTicket, step.id)
      ? durableTicket.reviewReworks?.at(-1)
      : undefined;
  const ticketOwnedNodeIds =
    durableTicket === undefined ? [] : ticketCreatedNodeIds(run, durableTicket, graph);
  const terminalRecovery = durableTicket?.executionControl?.terminalRecovery;
  const terminalRecoveryContext =
    terminalRecovery === undefined
      ? undefined
      : {
          sourceTicketId: terminalRecovery.sourceTicketId,
          failureBindingSha256s: [...terminalRecovery.failureBindingSha256s],
          sourceFailureProof: structuredClone(terminalRecovery.sourceFailureProof),
        };
  const compatibility: string[] = [];
  if (durableTicket?.executionPolicyBinding === undefined)
    compatibility.push("ticket_binding_rederived_from_pinned_configuration");
  else
    assertOrBackfillExecutionPolicyBinding(
      { executionPolicyBinding: durableTicket.executionPolicyBinding },
      semantic.ticket,
      `ticket ${definition.id}`,
    );
  if (durableStep?.executionPolicyBinding === undefined)
    compatibility.push("step_binding_rederived_from_pinned_configuration");
  else
    assertOrBackfillExecutionPolicyBinding(
      { executionPolicyBinding: durableStep.executionPolicyBinding },
      executionPolicyBinding,
      `ticket ${definition.id} step ${step.id}`,
    );
  const boundGateContexts = resolvePinnedGateAutoEvaluationContexts({
    configuration,
    descriptorBoundary: "scoped",
    operation: definition.operation,
    subjectNodeIds: [
      ...new Set([
        ...definition.target_node_ids,
        ...(step.read_node_ids ?? definition.scope.read_node_ids),
        ...(step.write_node_ids ?? definition.scope.write_node_ids),
      ]),
    ],
    // The gates this ticket is actually accountable for. Read scope routinely also contains
    // sibling gates on the same asset, and binding those makes two contexts declare the same
    // auto-evaluate check id, which the step's unqualified `validation_checks` entry cannot name.
    ownedNodeIds: [
      ...new Set([
        ...definition.target_node_ids,
        ...(step.write_node_ids ?? definition.scope.write_node_ids),
      ]),
    ],
    contexts: gatePolicyContexts,
  });
  const legacyDeliveryReview =
    step.kind === "review" &&
    executionPolicyBinding.workflowSha256 === LEGACY_BROAD_DELIVERY_REVIEW_WORKFLOW_SHA256;
  const readPaths = [
    ...new Set([
      ...(legacyDeliveryReview ? [] : (step.read_paths ?? definition.scope.read_paths)),
      ...boundGateContexts.flatMap((binding) => binding.readPaths),
    ]),
  ].sort(compareText);
  const configuredWritePaths = [...(step.write_paths ?? definition.scope.write_paths)];
  const readNodeIds = [
    ...new Set([
      ...(step.read_node_ids ?? definition.scope.read_node_ids),
      ...ticketOwnedNodeIds,
      ...(step.kind === "review" ? reviewCandidateNodeIds : []),
    ]),
  ].sort(compareText);
  const configuredWriteNodeIds = [
    ...new Set([
      ...(step.write_node_ids ?? definition.scope.write_node_ids),
      ...(step.graph_mutation === "forbidden" ? [] : ticketOwnedNodeIds),
    ]),
  ].sort(compareText);
  const effectiveWriteScope = effectiveAssignmentWriteScope({
    stepKind: step.kind,
    graphMutation: step.graph_mutation,
    writePaths: configuredWritePaths,
    writeNodeIds: configuredWriteNodeIds,
  });
  const { graphMutation, writePaths, writeNodeIds } = effectiveWriteScope;
  const contextNodes = graph
    .nodes()
    .filter((node) => new Set([...readNodeIds, ...writeNodeIds]).has(node.id))
    .map((node) => ({ ...node, nodeHash: canonicalHash(node) }));
  const plannedAssetRepairHistory = plannedAssetRepairHistoryForAttempt(
    run,
    graph
      .nodes()
      .filter((node) =>
        new Set([...definition.target_node_ids, ...configuredWriteNodeIds]).has(node.id),
      ),
  );
  const mutationContract = assignmentMutationContract(configuration, definition);
  const compilerOwnedFields = assignmentCompilerOwnedFields(configuration, definition);
  const predecessorHasCommandEvidence = reviewPredecessorHasCommandEvidence(predecessorExecution);
  const proposalControl = durableTicket?.executionControl;
  const proposalApproval =
    proposalControl?.proposalDecision?.decision === "approval" &&
    proposalControl.proposalApprovalSha256 === proposalControl.proposalDecision.sha256
      ? {
          protocol: "koni.proposal-attempt-approval.v1" as const,
          requestSha256: proposalControl.proposalRequest!.requestSha256,
          approvalSha256: proposalControl.proposalApprovalSha256,
          event: structuredClone(proposalControl.proposalDecision),
        }
      : undefined;
  const proposalOperation = executionCatalog.operations[definition.operation_registry_id];
  const proposalApplicationOperations =
    proposalOperation?.changeControl.role === "proposal"
      ? proposalOperation.changeControl.applicationOperations
      : [];
  const proposalAttemptInstructions = approvedProposalAttemptInstructions({
    approved: proposalApproval !== undefined,
    proposalStepId:
      proposalOperation?.changeControl.role === "proposal"
        ? proposalOperation.changeControl.proposalStep
        : undefined,
    stepId: step.id,
    stepKind: step.kind,
    applicationOperations: proposalApplicationOperations,
  });
  const proposalAuditSteering =
    proposalApproval === undefined
      ? []
      : approvedProposalAuditSteering(
          proposalControl?.proposalDecisionHistory ?? [],
          proposalApproval.approvalSha256,
        );
  const approvedApplicationProposal =
    proposalOperation?.changeControl.role === "application" &&
    durableTicket?.executionControl?.sourceProposalTicketId !== undefined
      ? run.tickets[durableTicket.executionControl.sourceProposalTicketId]
      : undefined;
  const approvedApplicationCausal = durableTicket?.executionControl?.controlTicketAuthority?.causal;
  const approvedApplicationMaterialization =
    approvedApplicationCausal?.role === "approved_application"
      ? approvedApplicationCausal.materialization
      : undefined;
  const applicationAuditSteering =
    approvedApplicationProposal === undefined || durableTicket === undefined
      ? []
      : approvedApplicationAuditSteering(run, durableTicket);
  const applicationGraphOnlyReviewInstruction = approvedApplicationGraphOnlyReviewInstruction({
    operationRole: proposalOperation?.changeControl.role ?? "ordinary",
    stepKind: step.kind,
    readPaths,
  });
  const approvedChangeObligations = approvedChangeObligationsForAttempt(
    run,
    definition.target_node_ids,
    proposalOperation?.changeControl.role ?? "ordinary",
  );
  const assetManifestReviewInstruction = implementAssetReviewManifestInstruction(
    definition.operation,
    step.kind,
  );
  const gateRepairPrompt = gateRepairInstruction(gateRepairEvidence.length);
  const standaloneSupportRunAssetRepairPrompt = standaloneSupportRunAssetRepairInstruction(
    definition.rule_id,
  );
  const repairedProviderGateRecheckPrompt = repairedProviderGateRecheckInstruction(
    definition.operation_registry_id,
    definition.source_state_key,
    step.id,
  );
  const rejectedSourceProposalPrompts = rejectedSourceProposalInstructions(run, definition.id);
  if (
    executionCatalog.operations[definition.operation_registry_id]?.changeControl.role ===
      "proposal" &&
    durableTicket?.status !== "proposed" &&
    proposalApproval === undefined
  ) {
    fail(
      "proposal_attempt_approval",
      `proposal ticket ${definition.id} lacks exact active approval context`,
    );
  }
  return {
    ticketId: definition.id,
    stepId: step.id,
    personaId: step.persona_id,
    readPaths,
    writePaths,
    readNodeIds,
    writeNodeIds,
    graphMutation,
    initialPrompt: [
      `Execute ${definition.title}.`,
      `Current step: ${step.id}.`,
      `Graph write-authority nodes for this exact step: ${writeNodeIds.length === 0 ? "none" : writeNodeIds.join(", ")}. Every other graph node in context is read-only: never upsert or delete it. A referenced asset that needs a contract or source change requires the configured upstream-change route; visibility is not mutation authority.`,
      `Repository write-authority paths for this exact step: ${writePaths.length === 0 ? "none" : writePaths.join(", ")}. Never create, edit, or promise a file outside these paths.`,
      ...(step.validation_checks.length === 0
        ? []
        : [
            `Current-step validation checks (the only check IDs authorized in this attempt): ${step.validation_checks.join(", ")}. Do not call checks listed on earlier or later workflow steps.`,
            'A required configured check whose result is rejected cannot satisfy this assignment. Do not submit status "completed" after any required check returns accepted: false. Submit status "failed" with the exact check blocker unless you materially repair the cause and rerun that check successfully in this attempt.',
          ]),
      ...(executionPolicyBinding.context.outputContract.text.length === 0
        ? []
        : [`Operation output contract: ${executionPolicyBinding.context.outputContract.text}`]),
      ...(step.kind !== "review" || executionPolicyBinding.context.reviewContract.text.length === 0
        ? []
        : [`Independent review contract: ${executionPolicyBinding.context.reviewContract.text}`]),
      ...(assetManifestReviewInstruction === undefined ? [] : [assetManifestReviewInstruction]),
      ...(step.kind !== "review" || predecessorExecution === undefined
        ? []
        : predecessorHasCommandEvidence
          ? [
              "Inspect every command in the compiler-authenticated predecessorExecution evidence. A composite pass/fail or predecessor summary is never sufficient by itself: map every claimed oracle case to its actual stdout/stderr signal, and reject setup errors, harness crashes, unrelated failures, omitted material streams, or cases that never reached their intended assertion.",
            ]
          : [
              "The compiler-authenticated predecessorExecution for this review contains no direct command evidence because the preceding step is graph-only. Judge exactly the configured review contract and compiler-authenticated graph/evidence closure; do not demand raw stdout/stderr or unrelated checks that this operation does not require.",
            ]),
      ...(step.kind === "review" || predecessorExecution === undefined
        ? []
        : [
            "The compiler-authenticated predecessorExecution is the exact accepted evidence from this step's causal predecessors. Use its structured outputs and command results directly. Do not infer that a receipt is absent from graph reachability: predecessor graph effects may not be integrated until this workflow's later integration boundary. Never raise a repair request that contradicts a passing predecessor receipt.",
          ]),
      ...(step.kind !== "review" || historicalPreparation === undefined
        ? []
        : [
            "The compiler-authenticated historicalPreparation envelope is the immutable cross-ticket preparation authority for this review. Inspect its independently reviewed baseline command signals and source-continuity certification together with current predecessorExecution. Do not require or inherit the earlier Pi conversation: immutable causal evidence crosses ticket and execution-epoch boundaries; conversational lineage does not.",
          ]),
      ...(executionPolicyBinding.context.portfolioGuidance === undefined
        ? []
        : [portfolioGuidancePrompt(executionPolicyBinding)]),
      ...(executionPolicyBinding.context.escalationTriggers.values.length === 0
        ? []
        : [`Escalate on: ${executionPolicyBinding.context.escalationTriggers.values.join("; ")}`]),
      ...(executionPolicyBinding.context.stopConditions.values.length === 0
        ? []
        : [`Stop on: ${executionPolicyBinding.context.stopConditions.values.join("; ")}`]),
      ...(step.expected_outputs.length === 0
        ? []
        : [`Expected result: ${step.expected_outputs.join("; ")}`]),
      ...(terminalRecoveryContext === undefined
        ? []
        : [
            `The compiler-authenticated terminal recovery proof is the exact source failure this resolver must address. Source ticket ${terminalRecoveryContext.sourceTicketId} failed with: ${terminalRecoveryContext.sourceFailureProof.semanticResult.blocker}`,
            "Treat that immutable semantic result as current causal evidence. A clean worktree or absent output proves only that the failed attempt left no side effects; it does not make the recorded failure transient. Do not reissue the unchanged source contract unless the proof establishes retryability or the cause has since been materially repaired. Resolve the proved cause within this grant when possible; otherwise return a precise blocker instead of approving a deterministic no-op retry.",
          ]),
      ...(activeReviewRework === undefined
        ? []
        : [
            activeReviewRework.scope === "review_only"
              ? `The operator authorized an independent rereview of the unchanged compiler-accepted predecessor. Re-evaluate it from scratch under the current configured review contract. This earlier blocker is historical context, not a required conclusion; retain only findings supported by the current authenticated evidence: ${activeReviewRework.blocker}`
              : activeReviewRework.mode === "supervised"
                ? `The operator explicitly authorized reviewed-blocker recovery ${activeReviewRework.ordinal}. Materially address every finding before rerunning proof: ${activeReviewRework.blocker}`
                : `This is bounded automatic review rework ${activeReviewRework.ordinal}: ${activeReviewRework.blocker}`,
            ...(activeReviewRework.operatorSteering === undefined
              ? []
              : [
                  `Operator steering for this exact recovery: ${activeReviewRework.operatorSteering}`,
                ]),
            "This is a fresh attempt. Any koni_submit_output call or accepted terminal result in the inherited parent transcript belongs only to that parent and does not settle this attempt. Finish this attempt with a newly accepted koni_submit_output call, even when the correct graph delta is empty or repeats the parent's candidate.",
          ]),
      ...(plannedAssetRepairHistory.length === 0
        ? []
        : [
            [
              "The compiler-authenticated planned asset repair history is cumulative for this workflow boundary.",
              "Correct every named finding that remains unsatisfied, and preserve established fixes plus unrelated valid state.",
              "A later repair request does not erase an earlier finding; the current graph value is not a preservation instruction when an authenticated finding proves that value defective.",
              `Repair history: ${JSON.stringify(plannedAssetRepairHistory)}`,
            ].join(" "),
          ]),
      ...upstreamChangeRequestInstructions(proposalOperation?.changeControl),
      ...rejectedSourceProposalPrompts,
      ...(proposalApproval === undefined
        ? []
        : [
            `Operator approval (${proposalApproval.approvalSha256}): ${proposalApproval.event.message ?? "Approved."}`,
            ...proposalAuditSteering,
            ...proposalAttemptInstructions,
          ]),
      ...(approvedApplicationProposal === undefined
        ? []
        : [
            `The approved change request defines the required state for this application: ${approvedApplicationProposal.summary}\n\nApplication graph write-authority nodes: ${definition.target_node_ids.join(", ")}. Request context may name causal nodes outside this application authority; treat those nodes as context only and never as an instruction to mutate them.`,
            ...(approvedApplicationMaterialization === undefined
              ? []
              : [
                  `Exact approved application selection (${approvedApplicationMaterialization.authoritySha256}): ${approvedApplicationMaterialization.selectionSummary}`,
                  "The exact approved application selection is already the authoritative resolution among the source request's alternatives. Do not ask the operator to choose those alternatives again. Compatible later audit steering clarifies this selection but does not replace it. If later steering materially conflicts with or would replace the exact selection, do not silently choose either authority: route one focused question or a new change-control decision for that conflict. Otherwise ask only if current compiler-authenticated state creates a materially different high-impact choice that the selection and compatible steering do not resolve.",
                ]),
            ...applicationAuditSteering,
            ...(applicationAuditSteering.length === 0
              ? []
              : [
                  "The source approval remains hash-bound. Treat compatible later audit-only steering as cumulative binding interpretation in every application and review step; do not revive an explicitly excluded node, contract key, path, or mechanism. Steering that materially conflicts with or replaces the exact approved selection requires a focused question or new change-control decision instead of silent precedence.",
                ]),
            ...(applicationGraphOnlyReviewInstruction === undefined
              ? []
              : [applicationGraphOnlyReviewInstruction]),
            "The approved request together with its cumulative operator steering is the complete obligation for this application. Historical durable obligations are additive constraints: they may preserve earlier accepted state, but they never narrow, replace, or excuse any target or outcome that remains required after those operator clarifications. Review and apply that clarified request in full.",
            ...(step.kind === "review"
              ? [
                  "Review the predecessor candidate against the exact approved selection and compatible cumulative steering. This review is read-only: return only the configured verdict, and do not apply or demand a new graph mutation from this step.",
                ]
              : step.graph_mutation === "forbidden"
                ? [
                    "Inspect and authenticate the exact approved selection, its causal approval, and compatible cumulative steering without mutating the graph. Record the bounded inspection outcome so the separately authorized application step can apply it.",
                  ]
                : [
                    "Apply a non-empty scoped semantic graph delta that makes the exact approved application selection true unless the current scoped graph already satisfies it. The selection originated at a read-only proposal boundary; that does not make an unsatisfied application a no-op.",
                  ]),
            ...(step.id !== "apply-approved-delta"
              ? []
              : [
                  "This application step is graph-only and does not write repository files directly. When the approved request adds a required file under an existing asset implementation root, update the asset's authored implementation_plan.files within the exact graph write grant, while preserving its other authored fields and omitting compiler-owned asset_manifest, readiness, and status. That contract change lets the compiler reissue the source-owning implement-asset workflow with its bounded filesystem grant.",
                  "An approved request can explicitly authorize a bounded new node even though that node has no preexisting id to list in the application graph write-authority nodes. When the request requires one, create it only within this operation's allowed new-node types and count; unapproved-new-node-creation forbids only a new node that the approved request does not require.",
                ]),
          ]),
      ...approvedChangeObligations.flatMap((obligation) =>
        approvedChangeObligationInstructions(obligation, step.kind),
      ),
      ...(gateRepairPrompt === undefined ? [] : [gateRepairPrompt]),
      ...(standaloneSupportRunAssetRepairPrompt === undefined
        ? []
        : [standaloneSupportRunAssetRepairPrompt]),
      ...(repairedProviderGateRecheckPrompt === undefined
        ? []
        : [repairedProviderGateRecheckPrompt]),
      ...(compilerOwnedFields.length === 0
        ? []
        : [
            `Compiler-owned graph fields are materialized automatically. Omit these fields entirely from every node you author; never guess or copy them from context: ${compilerOwnedFields.join(", ")}.`,
          ]),
      ...(graphMutation === "allowed"
        ? [
            "For each existing node upsert, use that node's exact nodeHash from the injected context as expectedNodeHash. Never guess or derive a node hash; if it is absent, use koni_graph_context before submitting.",
          ]
        : []),
      ...(step.kind === "review"
        ? [
            'Return an explicit typed review verdict. Use status "completed" with reviewVerdict "approved" only when the work passes. If any material finding remains, use status "failed" with reviewVerdict "rejected" and put the precise repair contract in blocker. For a genuinely out-of-scope repair, use reviewVerdict "changes_requested" with the authorized upstreamChangeRequest.',
          ]
        : []),
      "Use the automatically injected authority context. Return a short outcome summary and only the graph delta permitted by this step. Do not author compiler-owned state.",
    ].join("\n\n"),
    context: {
      protocol: "koni.attempt-context.v1",
      kind: "ticket",
      run: {
        id: run.id,
        objective: run.objective,
        runTypeId: run.runTypeId,
        git: {
          target: {
            ref: run.git.target.ref,
            selectedOid: run.git.target.selectedOid,
          },
          runRef: run.git.namespace.runRef,
        },
      },
      plan: run.plan?.full ?? {},
      resolvedQuestions: answeredQuestionContext(run),
      ticket: definition,
      step,
      executionPolicy: executionPolicyBinding,
      gatePolicyContexts: boundGateContexts,
      ...(compatibility.length === 0 ? {} : { executionPolicyCompatibility: compatibility }),
      ...(activeReviewRework === undefined ? {} : { reviewRework: activeReviewRework }),
      ...(plannedAssetRepairHistory.length === 0 ? {} : { plannedAssetRepairHistory }),
      ...(proposalApproval === undefined ? {} : { proposalApproval }),
      ...(terminalRecoveryContext === undefined
        ? {}
        : { terminalRecovery: terminalRecoveryContext }),
      ...(approvedChangeObligations.length === 0 ? {} : { approvedChangeObligations }),
      ...(gateRepairEvidence.length === 0 ? {} : { gateRepairEvidence }),
      ...(predecessorExecution === undefined ? {} : { predecessorExecution }),
      ...(historicalPreparation === undefined ? {} : { historicalPreparation }),
      mutationContract,
      ...(reviewCandidateNodeIds.length === 0 ? {} : { reviewCandidateNodeIds }),
      graph: contextNodes,
      scope: { readPaths, writePaths, readNodeIds, writeNodeIds },
    },
    terminalSchema: assignmentTerminalSchema(
      graphMutation,
      assignmentChangeControlContract(executionCatalog, executionPolicyBinding, step.id),
      step.kind,
    ),
    executionPolicyBinding,
    gatePolicyContexts: boundGateContexts,
    definition,
    step,
    graph,
  };
}

function verificationAttempt(
  run: RunRecord,
  runType: ConfigurationObject,
  graph: TypedGraph,
): AttemptDescriptor {
  const pipeline = pipelineDefinition(runType);
  const review = pipeline.order
    .map((id) => ({ id, stage: requiredRecord(pipeline.stages[id], `stage ${id}`) }))
    .find(({ stage }) => stage.kind === "agent_review");
  const config = review === undefined ? undefined : optionalRecord(review.stage.config);
  const personaId =
    optionalString(config?.persona) ??
    (run.executionConfig?.agents.verifier === undefined ? "reviewer" : "verifier");
  return {
    ticketId: "run-verification",
    stepId: review?.id ?? "verification",
    personaId,
    readPaths: ["."],
    writePaths: [],
    readNodeIds: graph.nodes().map((node) => node.id),
    writeNodeIds: [],
    graphMutation: "forbidden",
    initialPrompt:
      optionalString(config?.prompt) ??
      "Independently verify the completed run against its approved plan and current evidence. Do not repair it.",
    context: {
      protocol: "koni.attempt-context.v1",
      kind: "verification",
      run: { id: run.id, objective: run.objective, runTypeId: run.runTypeId },
      plan: run.plan?.full ?? {},
      resolvedQuestions: answeredQuestionContext(run),
      graph: graph.nodes(),
      tickets: run.tickets,
    },
    terminalSchema: assignmentTerminalSchema("forbidden"),
    graph,
  };
}

interface ConfiguredControlTicketDefinitionInput {
  configuration: CompiledConfiguration;
  catalog: CompiledExecutionSemanticCatalog;
  graph: TypedGraph;
  id: string;
  operationId: string;
  title: string;
  targetNodeIds: readonly string[];
  readNodeIds: readonly string[];
  writeNodeIds: readonly string[];
  readPaths: readonly string[];
  writePaths: readonly string[];
  sourceStateKey: string;
  targetStateKey: string;
  obligationKeys: readonly string[];
  forceGraphMutationForbidden: boolean;
  ruleId: string;
}

interface ControlTicketRecordInput {
  runId: string;
  role: ControlTicketRole;
  definition: DerivedTicketDefinition;
  catalog: CompiledExecutionSemanticCatalog;
  at: string;
  status: "proposed" | "queued";
  summary: string;
  dependencyIds: readonly string[];
  executionControl: TicketExecutionControlRecord;
  causal: ControlTicketCausalAuthority;
}

/** Compile a configured control workflow without granting it any authority not present in spec. */
function configuredControlTicketDefinition(
  input: ConfiguredControlTicketDefinitionInput,
): DerivedTicketDefinition {
  const operation = input.catalog.operations[input.operationId];
  const rawOperation = input.configuration.registries.operations[input.operationId];
  if (operation === undefined || rawOperation === undefined) {
    fail(
      "control_ticket_operation",
      `control ticket references unknown operation ${input.operationId}`,
    );
  }
  if (
    requiredNonempty(rawOperation.id, `operation ${input.operationId} id`) !== input.operationId
  ) {
    fail(
      "control_ticket_operation",
      `operation registry identity differs from ${input.operationId}`,
    );
  }
  const workflowId = operation.workflowId;
  if (workflowId === undefined) {
    fail(
      "control_ticket_workflow",
      `control operation ${input.operationId} has no configured workflow`,
    );
  }
  const rawWorkflow = input.configuration.registries.workflows[workflowId];
  const workflowSemantics = input.catalog.workflows[workflowId];
  if (rawWorkflow === undefined || workflowSemantics === undefined) {
    fail(
      "control_ticket_workflow",
      `control operation ${input.operationId} references missing workflow ${workflowId}`,
    );
  }
  if (requiredNonempty(rawWorkflow.id, `workflow ${workflowId} id`) !== workflowId) {
    fail("control_ticket_workflow", `workflow registry identity differs from ${workflowId}`);
  }
  const appliesTo = stringArray(rawWorkflow.applies_to, `workflow ${workflowId} applies_to`);
  if (appliesTo.length > 0 && !appliesTo.includes(operation.publicOperation)) {
    fail(
      "control_ticket_workflow",
      `workflow ${workflowId} does not apply to ${operation.publicOperation}`,
    );
  }
  const targetNodeIds = canonicalControlStrings(input.targetNodeIds, "control target nodes", true);
  const readNodeIds = canonicalControlStrings(input.readNodeIds, "control read nodes", true);
  const writeNodeIds = canonicalControlStrings(input.writeNodeIds, "control write nodes", true);
  const readPaths = canonicalControlPaths(input.readPaths, "control read paths");
  const writePaths = canonicalControlPaths(input.writePaths, "control write paths");
  assertExistingControlTargets(
    input.graph,
    targetNodeIds,
    new Set(targetNodeIds),
    "control ticket",
  );
  for (const nodeId of [...readNodeIds, ...writeNodeIds]) {
    if (input.graph.node(nodeId) === undefined) {
      fail("control_ticket_scope", `control ticket scope references missing node ${nodeId}`);
    }
  }
  if (!isControlSubset(writeNodeIds, readNodeIds)) {
    fail("control_ticket_scope", "control ticket write nodes must be readable by the same ticket");
  }
  const rawSteps = rawWorkflow.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    fail("control_ticket_workflow", `workflow ${workflowId} has no executable steps`);
  }
  if (
    rawSteps.length !== workflowSemantics.steps.length ||
    rawSteps.some(
      (raw, index) =>
        requiredNonempty(
          requiredRecord(raw, `workflow ${workflowId} step ${index}`).id,
          `workflow ${workflowId} step id`,
        ) !== workflowSemantics.steps[index]?.id,
    )
  ) {
    fail(
      "control_ticket_workflow",
      `workflow ${workflowId} differs from its pinned semantic step catalog`,
    );
  }
  const parsed = rawSteps.map((raw, index) => {
    const step = requiredRecord(raw, `workflow ${workflowId} step ${index}`);
    const id = requiredNonempty(step.id, `workflow ${workflowId} step ${index} id`);
    return { step, id, index };
  });
  assertControlWorkflowDag(workflowId, parsed);
  const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph);
  const workflow = evaluator.withBinding("target", targetNodeIds, () =>
    evaluator.withBinding("ticket_read_scope", readNodeIds, () =>
      evaluator.withBinding("ticket_write_scope", writeNodeIds, () =>
        parsed.map(({ step, id, index }) => {
          const semantic = workflowSemantics.steps[index]!;
          const stepReadNodeIds = [
            ...evaluator.select(
              (step.read_scope ?? { variable: "ticket_read_scope" }) as ConfigurationValue,
              `/registries/workflows/${workflowId}/steps/${index}/read_scope`,
            ),
          ];
          const stepWriteNodeIds = [
            ...evaluator.select(
              (step.write_scope ?? { variable: "ticket_write_scope" }) as ConfigurationValue,
              `/registries/workflows/${workflowId}/steps/${index}/write_scope`,
            ),
          ];
          if (
            !isControlSubset(stepReadNodeIds, readNodeIds) ||
            !isControlSubset(stepWriteNodeIds, writeNodeIds)
          ) {
            fail(
              "control_ticket_step_scope",
              `workflow ${workflowId} step ${id} exceeds the ticket graph scope`,
            );
          }
          const stepReadPaths =
            step.read_paths === undefined
              ? undefined
              : resolveConfiguredControlPathScopes(
                  configuredArray(step.read_paths, `workflow ${workflowId} step ${id} read_paths`),
                  evaluator,
                  `workflow ${workflowId} step ${id} read_paths`,
                );
          const stepWritePaths =
            step.write_paths === undefined
              ? undefined
              : resolveConfiguredControlPathScopes(
                  configuredArray(
                    step.write_paths,
                    `workflow ${workflowId} step ${id} write_paths`,
                  ),
                  evaluator,
                  `workflow ${workflowId} step ${id} write_paths`,
                );
          for (const selected of stepReadPaths ?? []) {
            if (!controlPathCovered(selected, readPaths)) {
              fail(
                "control_ticket_step_scope",
                `workflow ${workflowId} step ${id} read path ${selected} exceeds ticket scope`,
              );
            }
          }
          for (const selected of stepWritePaths ?? []) {
            if (!controlPathCovered(selected, writePaths)) {
              fail(
                "control_ticket_step_scope",
                `workflow ${workflowId} step ${id} write path ${selected} exceeds ticket scope`,
              );
            }
          }
          const kind = optionalString(step.kind) ?? "production";
          if (!["production", "integration", "review", "agent", "manual"].includes(kind)) {
            fail(
              "control_ticket_step_kind",
              `workflow ${workflowId} step ${id} has unsupported kind ${kind}`,
            );
          }
          const configuredMutation = optionalString(step.graph_mutation) ?? "allowed";
          if (!["allowed", "forbidden", "required"].includes(configuredMutation)) {
            fail(
              "control_ticket_graph_mutation",
              `workflow ${workflowId} step ${id} has invalid graph mutation policy`,
            );
          }
          const graphMutation = input.forceGraphMutationForbidden
            ? "forbidden"
            : configuredMutation;
          const dependsOn = stringArray(
            step.depends_on,
            `workflow ${workflowId} step ${id} depends_on`,
          );
          const preserveSourcePathsFrom = semantic.preserveSourcePathsFrom;
          if (
            preserveSourcePathsFrom !== undefined &&
            !controlDependsTransitively(id, preserveSourcePathsFrom, parsed)
          ) {
            fail(
              "control_ticket_preserve_source",
              `workflow ${workflowId} step ${id} does not depend on ${preserveSourcePathsFrom}`,
            );
          }
          const differsReadNodes = canonicalHash(stepReadNodeIds) !== canonicalHash(readNodeIds);
          const differsWriteNodes = canonicalHash(stepWriteNodeIds) !== canonicalHash(writeNodeIds);
          const contextMaterial = [
            input.id,
            id,
            readNodeIds,
            writeNodeIds,
            readPaths,
            writePaths,
            stepReadPaths ?? null,
            stepWritePaths ?? null,
            input.configuration.configuration_sha256,
            preserveSourcePathsFrom ?? null,
            differsReadNodes ? stepReadNodeIds : null,
            differsWriteNodes ? stepWriteNodeIds : null,
            input.forceGraphMutationForbidden,
          ];
          return deepFreeze({
            id,
            kind: kind as DerivedWorkflowStep["kind"],
            persona_id: requiredNonempty(step.agent, `workflow ${workflowId} step ${id} agent`),
            depends_on: Object.freeze(dependsOn),
            required: true,
            ...(differsReadNodes ? { read_node_ids: Object.freeze(stepReadNodeIds) } : {}),
            ...(differsWriteNodes ? { write_node_ids: Object.freeze(stepWriteNodeIds) } : {}),
            ...(stepReadPaths === undefined ? {} : { read_paths: Object.freeze(stepReadPaths) }),
            ...(stepWritePaths === undefined ? {} : { write_paths: Object.freeze(stepWritePaths) }),
            ...(preserveSourcePathsFrom === undefined
              ? {}
              : { preserve_source_paths_from: preserveSourcePathsFrom }),
            expected_outputs: Object.freeze(
              step.expected_output === undefined
                ? []
                : [
                    requiredNonempty(
                      step.expected_output,
                      `workflow ${workflowId} step ${id} expected_output`,
                    ),
                  ],
            ),
            graph_mutation: graphMutation as DerivedWorkflowStep["graph_mutation"],
            ...(step.validation_action === undefined
              ? {}
              : {
                  validation_action: requiredNonempty(
                    step.validation_action,
                    `workflow ${workflowId} step ${id} validation_action`,
                  ),
                }),
            required_receipts: Object.freeze([...semantic.requiredReceipts]),
            escalation_triggers: Object.freeze([...semantic.escalationTriggers]),
            stop_conditions: Object.freeze([...semantic.stopConditions]),
            validation_checks: Object.freeze([...semantic.validationChecks]),
            context_sha256: canonicalHash(contextMaterial),
          } satisfies DerivedWorkflowStep);
        }),
      ),
    ),
  );
  const reviewFailureReopenFrom = configuredReviewFailureReopen(rawWorkflow, workflowId);
  if (
    reviewFailureReopenFrom !== undefined &&
    !workflow.some((step) => step.id === reviewFailureReopenFrom)
  ) {
    fail(
      "control_ticket_review_rework",
      `workflow ${workflowId} reopens unknown step ${reviewFailureReopenFrom}`,
    );
  }
  const rawDispatchPriority = rawOperation.dispatch_priority;
  const dispatchPriority =
    rawDispatchPriority === undefined
      ? 0
      : requireSignedInteger(
          rawDispatchPriority,
          `operation ${input.operationId} dispatch_priority`,
        );
  const material = {
    protocol: "koni.derived-ticket.v1" as const,
    id: requiredNonempty(input.id, "control ticket id"),
    rule_id: input.ruleId,
    rule_phase: operation.stage,
    rule_priority: 0,
    anchor_node_id: targetNodeIds[0] ?? input.id,
    operation: operation.publicOperation,
    operation_registry_id: operation.id,
    operation_dispatch_priority: dispatchPriority,
    ranking_hints: Object.freeze(
      stringArray(rawOperation.ranking_hints, `operation ${input.operationId} ranking_hints`),
    ),
    title: boundedText(input.title, "control ticket title", 16_384),
    target_node_ids: Object.freeze(targetNodeIds),
    scope: deepFreeze({
      read_node_ids: Object.freeze(readNodeIds),
      write_node_ids: Object.freeze(writeNodeIds),
      read_paths: Object.freeze(readPaths),
      write_paths: Object.freeze(writePaths),
    }),
    source_state_key: input.sourceStateKey,
    target_state_key: input.targetStateKey,
    obligation_keys: Object.freeze(
      canonicalControlStrings(input.obligationKeys, "control obligations", true),
    ),
    workflow_id: workflowId,
    ...(reviewFailureReopenFrom === undefined
      ? {}
      : { review_failure_reopen_from: reviewFailureReopenFrom }),
    workflow: Object.freeze(workflow),
    configuration_sha256: input.configuration.configuration_sha256,
  };
  return deepFreeze({ ...material, definition_sha256: canonicalHash(material) });
}

function controlTicketRecordFromDefinition(input: ControlTicketRecordInput): TicketRecord {
  const semantic = resolveDefinitionExecutionBindings(input.catalog, input.definition);
  const ticket: SemanticTicketRecord = {
    id: input.definition.id,
    operationId: input.definition.operation_registry_id,
    executionPolicyBinding: semantic.ticket,
    executionControl: structuredClone(input.executionControl),
    title: input.definition.title,
    summary: boundedText(input.summary, "control ticket summary", 64 * 1024),
    status: input.status,
    priority: -(
      input.definition.rule_priority * 1_000 +
      input.definition.operation_dispatch_priority
    ),
    dependencyIds: canonicalControlStrings(
      input.dependencyIds,
      "control ticket dependencies",
      true,
    ),
    targetNodeIds: [...input.definition.target_node_ids],
    readNodeIds: [...input.definition.scope.read_node_ids],
    writeNodeIds: [...input.definition.scope.write_node_ids],
    readPaths: [...input.definition.scope.read_paths],
    writePaths: [...input.definition.scope.write_paths],
    steps: input.definition.workflow.map((step) => ({
      id: step.id,
      title: humanize(step.id),
      personaId: step.persona_id,
      executionPolicyBinding: semantic.steps.get(step.id)!,
      kind: step.kind,
      dependsOn: [...step.depends_on],
      ...(step.read_node_ids === undefined ? {} : { readNodeIds: [...step.read_node_ids] }),
      ...(step.write_node_ids === undefined ? {} : { writeNodeIds: [...step.write_node_ids] }),
      ...(step.read_paths === undefined ? {} : { readPaths: [...step.read_paths] }),
      ...(step.write_paths === undefined ? {} : { writePaths: [...step.write_paths] }),
      ...(step.validation_action === undefined ? {} : { validationAction: step.validation_action }),
      status: "pending",
      attemptIds: [],
      summary: undefined,
      startedAt: undefined,
      completedAt: undefined,
    })),
    ...(input.definition.review_failure_reopen_from === undefined
      ? {}
      : {
          reviewFailureReopenFrom: input.definition.review_failure_reopen_from,
          reviewReworkLimit: 1,
          reviewReworkCount: 0,
          reviewReworks: [],
        }),
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: input.at,
    updatedAt: input.at,
  };
  const operation = input.catalog.operations[input.definition.operation_registry_id];
  const workflowId = input.definition.workflow_id;
  const workflow = workflowId === undefined ? undefined : input.catalog.workflows[workflowId];
  if (operation === undefined || workflow === undefined) {
    fail(
      "control_ticket_authority",
      `control ticket ${ticket.id} lost its pinned operation or workflow`,
    );
  }
  ticket.executionControl!.controlTicketAuthority = createCompilerControlTicketAuthority({
    runId: input.runId,
    role: input.role,
    ticket,
    operation,
    workflow,
    definition: input.definition,
    causal: input.causal,
  });
  return ticket;
}

function configuredControlDefinitionFromTicket(
  run: RunRecord,
  assignment: ReadyAssignment,
  configuration: CompiledConfiguration,
  catalog: CompiledExecutionSemanticCatalog,
  graph: TypedGraph,
): DerivedTicketDefinition | undefined {
  const ticket = run.tickets[assignment.ticketId];
  if (ticket === undefined) return undefined;
  const operation = catalog.operations[ticket.operationId];
  if (operation === undefined) return undefined;
  const control = ticket.executionControl;
  let ruleId: string;
  let sourceStateKey: string;
  let targetStateKey: string;
  let obligations: readonly string[];
  let forceGraphMutationForbidden = false;
  if (operation.changeControl.role === "proposal") {
    if (control?.proposalRequest === undefined || control.changeControlScopeNodeIds === undefined) {
      fail(
        "control_ticket_projection",
        `proposal ticket ${ticket.id} has no compiler request authority`,
      );
    }
    if (
      ticket.id !==
        deterministicControlTicketId("change", {
          runId: run.id,
          proposalOperationId: operation.id,
          requestSha256: control.proposalRequest.requestSha256,
        }) ||
      (ticket.writeNodeIds?.length ?? 0) !== 0 ||
      ticket.readPaths.length !== 0 ||
      ticket.writePaths.length !== 0 ||
      canonicalHash(ticket.targetNodeIds) !== canonicalHash(control.changeControlScopeNodeIds) ||
      canonicalHash(ticket.readNodeIds ?? []) !== canonicalHash(control.changeControlScopeNodeIds)
    ) {
      fail(
        "control_ticket_projection",
        `proposal ticket ${ticket.id} exceeds its bounded read-only control scope`,
      );
    }
    ruleId = "compiler.change-control.proposal";
    sourceStateKey = "upstream-change-requested";
    targetStateKey = "change-proposed";
    obligations = [control.proposalRequest.requestSha256];
    forceGraphMutationForbidden = true;
  } else if (operation.changeControl.role === "application") {
    if (
      control?.sourceProposalTicketId === undefined ||
      control.approvedApplicationSha256 === undefined ||
      ticket.id !==
        deterministicControlTicketId("application", {
          proposalTicketId: control.sourceProposalTicketId,
          authoritySha256: control.approvedApplicationSha256,
        }) ||
      canonicalHash(ticket.writeNodeIds ?? []) !== canonicalHash(ticket.targetNodeIds) ||
      canonicalHash(ticket.readNodeIds ?? []) !== canonicalHash(ticket.targetNodeIds) ||
      ticket.readPaths.length !== 0 ||
      ticket.writePaths.length !== 0
    ) {
      fail(
        "control_ticket_projection",
        `application ticket ${ticket.id} differs from its approved exact scope`,
      );
    }
    ruleId = "compiler.change-control.application";
    sourceStateKey = "change-approved";
    targetStateKey = "change-applied";
    obligations = [control.approvedApplicationSha256];
  } else if (operation.terminalResolver) {
    if (control?.terminalRecovery === undefined) {
      fail("control_ticket_projection", `terminal resolver ${ticket.id} has no failure authority`);
    }
    if (control.terminalRecovery.failureBindingSha256s.length !== 1) {
      fail(
        "control_ticket_projection",
        `terminal resolver ${ticket.id} must bind one immutable failure`,
      );
    }
    if (
      ticket.id !==
      deterministicControlTicketId("recovery", {
        runId: run.id,
        sourceTicketId: control.terminalRecovery.sourceTicketId,
        failureBindingSha256: control.terminalRecovery.failureBindingSha256s[0],
        configurationSha256: catalog.configurationSha256,
        catalogSha256: catalog.sha256,
        resolverOperationId: operation.id,
      })
    ) {
      fail(
        "control_ticket_projection",
        `terminal resolver ${ticket.id} has a noncanonical identity`,
      );
    }
    ruleId = "compiler.change-control.terminal-resolver";
    sourceStateKey = "terminal-failure";
    targetStateKey = "recovered";
    obligations = control.terminalRecovery.failureBindingSha256s;
  } else if (operation.changeControl.role === "disposition") {
    fail(
      "control_ticket_disposition",
      `disposition ${operation.id} must never own an executable ticket`,
    );
  } else {
    return undefined;
  }
  const definition = configuredControlTicketDefinition({
    configuration,
    catalog,
    graph,
    id: ticket.id,
    operationId: ticket.operationId,
    title: ticket.title,
    targetNodeIds: ticket.targetNodeIds,
    readNodeIds: ticket.readNodeIds ?? [],
    writeNodeIds: ticket.writeNodeIds ?? [],
    readPaths: ticket.readPaths,
    writePaths: ticket.writePaths,
    sourceStateKey,
    targetStateKey,
    obligationKeys: obligations,
    forceGraphMutationForbidden,
    ruleId,
  });
  assertTicketDefinitionStable(ticket, definition);
  if (ticket.executionPolicyBinding === undefined) {
    fail(
      "control_ticket_binding",
      `control ticket ${ticket.id} has no durable execution-policy binding`,
    );
  }
  assertExecutionBindingExact(
    catalog,
    ticket.executionPolicyBinding,
    `control ticket ${ticket.id}`,
  );
  for (const step of ticket.steps) {
    if (step.executionPolicyBinding === undefined) {
      fail(
        "control_ticket_binding",
        `control ticket ${ticket.id} step ${step.id} has no durable policy binding`,
      );
    }
    assertExecutionBindingExact(
      catalog,
      step.executionPolicyBinding,
      `control ticket ${ticket.id} step ${step.id}`,
    );
  }
  return definition;
}

function configuredReviewFailureReopen(
  workflow: ConfigurationObject,
  workflowId: string,
): string | undefined {
  const direct = optionalString(workflow.review_failure_reopen_from);
  const rawRoutes = workflow.review_failure_routes;
  if (rawRoutes === undefined) return direct;
  const routes = requiredRecord(rawRoutes, `workflow ${workflowId} review_failure_routes`);
  const routed = Object.entries(routes).flatMap(([id, value]) => {
    const route = requiredRecord(value, `workflow ${workflowId} review route ${id}`);
    if (optionalString(route.disposition) !== "reopen") return [];
    return [
      requiredNonempty(route.reopen_from, `workflow ${workflowId} review route ${id} reopen_from`),
    ];
  });
  if (
    new Set(routed).size > 1 ||
    (direct !== undefined && routed[0] !== undefined && routed[0] !== direct)
  ) {
    fail(
      "control_ticket_review_rework",
      `workflow ${workflowId} has ambiguous review rework ownership`,
    );
  }
  return direct ?? routed[0];
}

function assertControlWorkflowDag(
  workflowId: string,
  steps: readonly { step: Record<string, unknown>; id: string }[],
): void {
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  if (byId.size !== steps.length)
    fail("control_ticket_workflow", `workflow ${workflowId} has duplicate step ids`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id))
      fail("control_ticket_workflow", `workflow ${workflowId} has a dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of stringArray(
      byId.get(id)!.step.depends_on,
      `workflow ${workflowId} step ${id} depends_on`,
    )) {
      if (!byId.has(dependency))
        fail(
          "control_ticket_workflow",
          `workflow ${workflowId} step ${id} depends on unknown ${dependency}`,
        );
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

function controlDependsTransitively(
  stepId: string,
  expected: string,
  steps: readonly { step: Record<string, unknown>; id: string }[],
): boolean {
  const byId = new Map(steps.map((step) => [step.id, step.step] as const));
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (!seen.add(id)) return false;
    for (const dependency of stringArray(
      byId.get(id)?.depends_on,
      `workflow step ${id} depends_on`,
    )) {
      if (dependency === expected || visit(dependency)) return true;
    }
    return false;
  };
  return visit(stepId);
}

function resolveConfiguredControlPathScopes(
  definitions: readonly ConfigurationValue[],
  evaluator: GraphExpressionEvaluator,
  label: string,
): string[] {
  const output = new Set<string>();
  for (const [index, definition] of definitions.entries()) {
    if (typeof definition === "string") {
      output.add(controlScopePath(definition, `${label} ${index}`));
      continue;
    }
    const projection = requiredRecord(definition, `${label} ${index}`);
    assertExactFields(projection, ["select", "field"], `${label} ${index}`);
    const field = requiredNonempty(projection.field, `${label} ${index} field`);
    for (const nodeId of evaluator.select(
      projection.select as ConfigurationValue,
      `${label} ${index} select`,
    )) {
      const value = evaluator.field(nodeId, field);
      if (value === undefined) continue;
      const values =
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.map((item) => requiredNonempty(item, `${label} ${index} projected path`))
            : fail(
                "control_ticket_path_projection",
                `${nodeId}.${field} must project a path string or list`,
              );
      for (const selected of values) output.add(controlScopePath(selected, `${label} ${index}`));
    }
  }
  return [...output].sort(compareText);
}

function configuredArray(value: unknown, label: string): ConfigurationValue[] {
  if (!Array.isArray(value)) fail("control_ticket_array", `${label} must be an array`);
  return value as ConfigurationValue[];
}

function canonicalControlPaths(values: readonly string[], label: string): string[] {
  const output = values
    .map((value, index) => controlScopePath(value, `${label} ${index}`))
    .sort(compareText);
  if (new Set(output).size !== output.length)
    fail("control_ticket_duplicate", `${label} contain duplicates`);
  return output;
}

function controlScopePath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    /[*?]/u.test(value)
  ) {
    fail("control_ticket_path", `${label} must be a nonempty literal project path`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    fail("control_ticket_path", `${label} must be project-relative`);
  }
  const segments = normalized.split("/");
  if (segments.includes("..")) fail("control_ticket_path", `${label} may not escape the project`);
  const compact = segments.filter((segment) => segment !== "" && segment !== ".");
  return compact.length === 0 ? "." : compact.join("/");
}

function controlPathCovered(selected: string, scopes: readonly string[]): boolean {
  return scopes.some(
    (scope) => scope === "." || selected === scope || selected.startsWith(`${scope}/`),
  );
}

function isControlSubset(values: readonly string[], superset: readonly string[]): boolean {
  const allowed = new Set(superset);
  return values.every((value) => allowed.has(value));
}

function canonicalControlStrings(
  values: readonly string[],
  label: string,
  allowEmpty: boolean,
): string[] {
  const output = values.map((value) => requiredNonempty(value, label)).sort(compareText);
  if (new Set(output).size !== output.length)
    fail("control_ticket_duplicate", `${label} contain duplicates`);
  if (!allowEmpty && output.length === 0) fail("control_ticket_empty", `${label} must be nonempty`);
  return output;
}

function requireSignedInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    fail("control_ticket_integer", `${label} must be an integer`);
  return value;
}

function boundedDigests(values: readonly Sha256Digest[], label: string): Sha256Digest[] {
  if (values.length === 0 || values.length > 256)
    fail("control_ticket_digest", `${label} must contain 1..256 hashes`);
  const output = canonicalControlStrings(values, label, false) as Sha256Digest[];
  for (const value of output) requireDigest(value, label);
  return output;
}

function deterministicControlTicketId(
  kind: "change" | "application" | "recovery",
  material: unknown,
): string {
  return `TK-${kind}-${digestBody(canonicalHash(material)).slice(0, 24)}`;
}

function controlTicketTitle(prefix: string, summary: string): string {
  const firstLine = summary.trim().split(/\r?\n/u)[0] ?? summary.trim();
  return `${prefix}: ${firstLine}`.slice(0, 240);
}

function assertHashBoundRecord(value: { readonly sha256: Sha256Digest }, label: string): void {
  if (
    !isSha256Digest(value.sha256) ||
    canonicalHash(withoutField(value, "sha256")) !== value.sha256
  ) {
    fail("change_control_hash", `${label} failed its canonical SHA-256 binding`);
  }
}

function assertExecutionBindingExact(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
  label: string,
): void {
  assertHashBoundRecord(binding, label);
  const expected = resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId: binding.operationId,
    ...(binding.workflowId === undefined ? {} : { workflowId: binding.workflowId }),
    ...(binding.stepId === undefined ? {} : { stepId: binding.stepId }),
  });
  if (canonicalHash(expected) !== canonicalHash(binding)) {
    fail("change_control_binding", `${label} differs from its pinned execution-policy catalog`);
  }
}

function existingChangeControlProposal(ticket: TicketRecord): ExistingChangeControlProposal {
  const request = ticket.executionControl?.proposalRequest;
  const scope = ticket.executionControl?.changeControlScopeNodeIds;
  if (request === undefined || scope === undefined) {
    fail(
      "change_control_proposal_collision",
      `proposal ${ticket.id} has no exact compiler request metadata`,
    );
  }
  return {
    ticketId: ticket.id,
    requestSha256: request.requestSha256,
    proposalOperationId: ticket.operationId,
    sourceTicketId: request.sourceTicketId,
    sourceStepId: request.sourceStepId,
    sourceOutputSha256: request.sourceOutputSha256,
    controlScopeNodeIds: [...scope],
  };
}

function assertControlTicketTemplate(
  existing: TicketRecord,
  expected: TicketRecord,
  label: string,
  options: {
    allowFailureHashExtension?: boolean;
    allowPristineCompilerCancellation?: boolean;
  } = {},
): void {
  const existingTicket = structuredClone(existing);
  if (
    options.allowPristineCompilerCancellation === true &&
    existingTicket.status === "cancelled" &&
    existingTicket.blocker === COMPILER_SUPERSEDED_BEFORE_EXECUTION &&
    existingTicket.gitCycleId === undefined &&
    existingTicket.worktreePath === undefined &&
    existingTicket.branch === undefined &&
    existingTicket.steps.length > 0 &&
    existingTicket.steps.every((step) => step.status === "skipped" && step.attemptIds.length === 0)
  ) {
    existingTicket.status = expected.status;
  }
  const existingControl = structuredClone(existing.executionControl);
  const expectedControl = structuredClone(expected.executionControl);
  if (options.allowFailureHashExtension) {
    const prior = existingControl?.terminalRecovery?.failureBindingSha256s ?? [];
    const next = expectedControl?.terminalRecovery?.failureBindingSha256s ?? [];
    if (!prior.every((hash) => next.includes(hash))) {
      fail(
        "control_ticket_failure_binding",
        `${label} discarded an authenticated terminal failure binding`,
      );
    }
    if (
      existingControl?.terminalRecovery !== undefined &&
      expectedControl?.terminalRecovery !== undefined
    ) {
      existingControl.terminalRecovery.failureBindingSha256s = [...next];
    }
  }
  const immutable = (ticket: TicketRecord, control: TicketExecutionControlRecord | undefined) => ({
    id: ticket.id,
    operationId: ticket.operationId,
    title: ticket.title,
    summary: ticket.summary,
    status: ticket.status,
    executionPolicyBinding: ticket.executionPolicyBinding ?? null,
    executionControl: control ?? null,
    priority: ticket.priority,
    dependencyIds: ticket.dependencyIds,
    targetNodeIds: ticket.targetNodeIds,
    readNodeIds: ticket.readNodeIds ?? null,
    writeNodeIds: ticket.writeNodeIds ?? null,
    readPaths: ticket.readPaths,
    writePaths: ticket.writePaths,
    steps: ticket.steps.map((step) => ({
      id: step.id,
      title: step.title,
      personaId: step.personaId,
      kind: step.kind ?? null,
      dependsOn: step.dependsOn ?? null,
      readNodeIds: step.readNodeIds ?? null,
      writeNodeIds: step.writeNodeIds ?? null,
      readPaths: step.readPaths ?? null,
      writePaths: step.writePaths ?? null,
      validationAction: step.validationAction ?? null,
      executionPolicyBinding: step.executionPolicyBinding ?? null,
    })),
    reviewFailureReopenFrom: ticket.reviewFailureReopenFrom ?? null,
    reviewReworkLimit: ticket.reviewReworkLimit ?? null,
  });
  if (
    canonicalHash(immutable(existingTicket, existingControl)) !==
    canonicalHash(immutable(expected, expectedControl))
  ) {
    fail(
      "control_ticket_collision",
      `${label} ${expected.id} differs from its deterministic compiler template`,
    );
  }
}

function preserveControlTicketCreationAuthority(
  existing: TicketRecord,
  expected: TicketRecord,
  role: ControlTicketRole,
): void {
  const prior = existing.executionControl?.controlTicketAuthority;
  const projected = expected.executionControl?.controlTicketAuthority;
  if (
    prior?.role !== role ||
    projected?.role !== role ||
    prior.causal.role !== role ||
    projected.causal.role !== role
  ) {
    fail("control_ticket_authority", `${role} replay lacks its original compiler authority`);
  }
  const normalize = (authority: typeof prior): unknown => {
    const copy = structuredClone(authority);
    const causal = copy.causal;
    if (causal.role === "proposal") {
      const publication = { ...causal.publication } as Record<string, unknown>;
      delete publication.disposition;
      delete publication.sha256;
      (causal as unknown as { publication: Record<string, unknown> }).publication = publication;
    } else if (causal.role === "approved_application") {
      const materialization = { ...causal.materialization } as Record<string, unknown>;
      delete materialization.disposition;
      delete materialization.sha256;
      (causal as unknown as { materialization: Record<string, unknown> }).materialization =
        materialization;
    } else {
      const reconciliation = { ...causal.reconciliation } as Record<string, unknown>;
      delete reconciliation.disposition;
      delete reconciliation.sha256;
      (causal as unknown as { reconciliation: Record<string, unknown> }).reconciliation =
        reconciliation;
    }
    const authorityMaterial = copy as unknown as Record<string, unknown>;
    delete authorityMaterial.causal;
    delete authorityMaterial.projection;
    delete authorityMaterial.projectionSha256;
    delete authorityMaterial.sha256;
    return { authority: authorityMaterial, causal };
  };
  if (
    canonicalHash(normalize(prior)) !== canonicalHash(normalize(projected)) ||
    canonicalHash(prior.projection) !== canonicalHash(ticketImmutableProjection(expected))
  ) {
    fail(
      "control_ticket_authority",
      `${role} replay differs from its original causal compiler authority`,
    );
  }
  expected.executionControl!.controlTicketAuthority = structuredClone(prior);
}

function integrationDefinition(
  run: RunRecord,
  assignment: ReadyAssignment,
  configuration: CompiledConfiguration,
  graph: TypedGraph,
): DerivedTicketDefinition {
  const ticket = run.tickets[assignment.ticketId];
  const catalog = requireExecutionSemanticCatalog(configuration);
  const operationId = integrationOperation(configuration, run.runTypeId);
  if (ticket === undefined || ticket.operationId !== operationId) {
    fail(
      "ticket_definition_missing",
      `ticket ${assignment.ticketId} has no pinned compiler definition`,
    );
  }
  return configuredIntegrationTicketDefinition({
    configuration,
    catalog,
    graph,
    id: ticket.id,
    operationId,
    title: ticket.title,
  });
}

function integrationOperation(configuration: CompiledConfiguration, runTypeId: string): string {
  const runType = requireValidation(
    resolveCompiledRunType(configuration, runTypeId),
    "run_type_invalid",
    "run type disappeared",
  );
  return resolveConfiguredOperationReference(
    requireExecutionSemanticCatalog(configuration),
    optionalString(optionalRecord(runType.document.promotion)?.conflict_operation) ??
      "resolve-target-integration",
  );
}

export function resolveConfiguredOperationReference(
  catalog: CompiledExecutionSemanticCatalog,
  reference: string,
): string {
  if (catalog.operations[reference] !== undefined) return reference;
  const matches = Object.values(catalog.operations).filter(
    (candidate) => candidate.publicOperation === reference,
  );
  if (matches.length !== 1) {
    fail(
      "operation_reference",
      `configured operation reference ${reference} does not uniquely resolve to one pinned registry operation`,
    );
  }
  return matches[0]!.id;
}

function configuredIntegrationTicketDefinition(input: {
  configuration: CompiledConfiguration;
  catalog: CompiledExecutionSemanticCatalog;
  graph: TypedGraph;
  id: string;
  operationId: string;
  title: string;
}): DerivedTicketDefinition {
  return configuredControlTicketDefinition({
    configuration: input.configuration,
    catalog: input.catalog,
    graph: input.graph,
    id: input.id,
    operationId: input.operationId,
    title: input.title,
    targetNodeIds: [],
    readNodeIds: [],
    writeNodeIds: [],
    readPaths: ["."],
    writePaths: ["."],
    sourceStateKey: "target-conflicted",
    targetStateKey: "target-integrated",
    obligationKeys: ["target.integration"],
    forceGraphMutationForbidden: true,
    ruleId: "compiler.target-integration",
  });
}

function planningTerminalSchema(graphSeed: TSchema): TSchema {
  const miniItem = Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 160 }),
      description: Type.String({ minLength: 1, maxLength: 1_200 }),
    },
    { additionalProperties: false },
  );
  const domains = Object.fromEntries(
    PLAN_DOMAINS.map((domain) => [
      domain,
      Type.String({ minLength: 1, maxLength: MAX_PLAN_CHARS }),
    ]),
  );
  const concise = Object.fromEntries(
    PLAN_DOMAINS.map((domain) => [domain, Type.Array(miniItem, { minItems: 1, maxItems: 7 })]),
  );
  return Type.Object(
    {
      title: Type.Optional(Type.String({ minLength: 3, maxLength: 60 })),
      full: Type.Object(domains, { additionalProperties: false }),
      concise: Type.Object(concise, { additionalProperties: false }),
      graphSeed,
    },
    { additionalProperties: false },
  );
}

function planningPatchTerminalSchema(): TSchema {
  const miniItem = Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 160 }),
      description: Type.String({ minLength: 1, maxLength: 1_200 }),
    },
    { additionalProperties: false },
  );
  const full = Type.Object(
    Object.fromEntries(
      PLAN_DOMAINS.map((domain) => [
        domain,
        Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PLAN_CHARS })),
      ]),
    ),
    { additionalProperties: false, minProperties: 1 },
  );
  const concise = Type.Object(
    Object.fromEntries(
      PLAN_DOMAINS.map((domain) => [
        domain,
        Type.Optional(Type.Array(miniItem, { minItems: 1, maxItems: 7 })),
      ]),
    ),
    { additionalProperties: false, minProperties: 1 },
  );
  const edge = Type.Object(
    {
      source: Type.String({ minLength: 1, maxLength: 128 }),
      relation: Type.String({ minLength: 1, maxLength: 128 }),
      target: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  );
  const node = Type.Object(
    {
      key: Type.String({ minLength: 1, maxLength: 128 }),
      type: Type.String({ minLength: 1, maxLength: 128 }),
      title: Type.String({ minLength: 1, maxLength: 240 }),
      spec: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
    },
    { additionalProperties: false },
  );
  const graphSeed = Type.Object(
    {
      setRootSpec: Type.Optional(
        Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
      ),
      removeRootSpecFields: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
          maxItems: 1_024,
          uniqueItems: true,
        }),
      ),
      upsertNodes: Type.Optional(Type.Array(node, { maxItems: 1_024 })),
      removeNodeKeys: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          maxItems: 1_024,
          uniqueItems: true,
        }),
      ),
      addEdges: Type.Optional(Type.Array(edge, { maxItems: 4_096 })),
      removeEdges: Type.Optional(Type.Array(edge, { maxItems: 4_096 })),
    },
    { additionalProperties: false, minProperties: 1 },
  );
  return Type.Object(
    {
      baseRevision: Type.Integer({ minimum: 0 }),
      baseArtifactSha256: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
      title: Type.Optional(Type.String({ minLength: 3, maxLength: 60 })),
      full: Type.Optional(full),
      concise: Type.Optional(concise),
      graphSeed: Type.Optional(graphSeed),
    },
    { additionalProperties: false, minProperties: 3 },
  );
}

interface PlanningGraphSeedContract {
  schema: TSchema;
  context: JsonValue;
}

function planningProtectedRootSpecFields(configuration: CompiledConfiguration): string[] {
  const initialization = configuration.behavior.profile.initialization;
  const rootType = requiredNonempty(
    initialization.rootNodeType,
    "compiled initialization root node type",
  );
  const definition = requireValidation(
    projectGraphSchemaDefinition(configuration),
    "graph_schema_invalid",
    "compiled profile graph schema is invalid",
  );
  const rootDefinition = definition.nodeTypes.find((nodeType) => nodeType.id === rootType);
  if (rootDefinition === undefined) {
    fail("graph_seed_root_type", `unknown root node type ${rootType}`);
  }
  return [
    requiredNonempty(initialization.goalField, "compiled initialization goal field").replace(
      /^spec\./u,
      "",
    ),
    requiredNonempty(
      initialization.planningContextField,
      "compiled initialization planning context field",
    ).replace(/^spec\./u, ""),
    ...compilerOwnedSpecFields(rootDefinition),
  ];
}

function leadJudgmentTerminalSchema(): TSchema {
  return Type.Object(
    {
      protocol: Type.Literal(LEAD_JUDGMENT_OUTPUT_PROTOCOL),
      disposition: Type.Union([Type.Literal("proceed"), Type.Literal("blocked")]),
      summary: Type.String({ minLength: 1, maxLength: 4_096 }),
    },
    { additionalProperties: false },
  );
}

function planningGraphSeedContract(
  configuration: CompiledConfiguration,
): PlanningGraphSeedContract {
  const initialization = configuration.behavior.profile.initialization;
  const rootType = requiredNonempty(
    initialization.rootNodeType,
    "compiled initialization root node type",
  );
  const goalField = requiredNonempty(
    initialization.goalField,
    "compiled initialization goal field",
  ).replace(/^spec\./u, "");
  const contextField = requiredNonempty(
    initialization.planningContextField,
    "compiled initialization planning context field",
  ).replace(/^spec\./u, "");
  const operationId = requiredNonempty(
    initialization.planningSeedOperation,
    "compiled initialization planning seed operation",
  );
  const operation = configuration.registries.operations[operationId];
  if (operation === undefined)
    fail("graph_seed_operation", `planning seed operation ${operationId} is missing`);
  const allowedTypeIds = stringArray(
    operation.allowed_new_node_types,
    "planning seed allowed node types",
  );
  const maximum = optionalSafeInteger(operation.max_new_nodes) ?? 1_024;
  const definition = requireValidation(
    projectGraphSchemaDefinition(configuration),
    "graph_schema_invalid",
    "compiled profile graph schema is invalid",
  );
  const nodeTypes = new Map(definition.nodeTypes.map((nodeType) => [nodeType.id, nodeType]));
  const rootDefinition = nodeTypes.get(rootType);
  if (rootDefinition === undefined)
    fail("graph_seed_root_type", `unknown root node type ${rootType}`);
  const allowedNodeTypes = allowedTypeIds.map((id) => {
    const nodeType = nodeTypes.get(id);
    if (nodeType === undefined)
      fail("graph_seed_node_type", `planning seed operation allows unknown node type ${id}`);
    return nodeType;
  });
  if (allowedNodeTypes.length === 0)
    fail("graph_seed_node_type", "planning seed operation allows no node types");
  const participatingTypes = new Set([rootType, ...allowedTypeIds]);
  const edgeTypes = definition.edgeTypes.filter(
    (edge) =>
      participatingTypes.has(edge.source) &&
      edge.targets.some((target) => participatingTypes.has(target)),
  );
  const protectedRootFields = new Set([
    goalField,
    contextField,
    ...compilerOwnedSpecFields(rootDefinition),
  ]);
  const rootFields = planningFieldDefinitions(rootDefinition, protectedRootFields);
  const nodeSchemas = allowedNodeTypes.map((nodeType) => planningNodeSeedSchema(nodeType));
  const relationNames = [...new Set(edgeTypes.map((edge) => edge.relation))].sort(compareText);
  const schema = graphSeedSchema({
    rootDefinition,
    rootFields,
    nodeSchemas,
    relationNames,
    maximum,
  });
  return {
    schema,
    context: {
      rule: "Use the literal $root for the existing objective. rootSpec enriches that node but does not declare a key. Every other endpoint must equal a declared nodes[].key, and all declared nodes must connect to $root.",
      root: {
        key: "$root",
        type: rootDefinition.id,
        description: rootDefinition.description,
        specFields: planningFieldContract(rootFields),
      },
      allowedNodeTypes: allowedNodeTypes.map((nodeType) => ({
        id: nodeType.id,
        description: nodeType.description,
        requiredAny: (nodeType.required_any ?? []).map((group) => [...group]),
        specFields: planningFieldContract(planningFieldDefinitions(nodeType)),
      })),
      canonicalEdges: edgeTypes.map((edge) => ({
        sourceType: edge.source,
        relation: edge.relation,
        targetTypes: edge.targets.filter((target) => participatingTypes.has(target)),
        ...(edge.bidirectional === undefined ? {} : { bidirectional: edge.bidirectional }),
      })),
      maxNewNodes: maximum,
      forbidden: [
        "node types outside allowedNodeTypes",
        "spec fields not declared for that node type",
        "compiler-owned fields, status, tickets, receipts, and implementation progress",
        "invented, inverse, or redundant relationship names",
      ],
    },
  };
}

function graphSeedSchema(input: {
  rootDefinition: GraphNodeTypeDefinition;
  rootFields: Record<string, GraphFieldDefinition>;
  nodeSchemas: TSchema[];
  relationNames: string[];
  maximum: number;
}): TSchema {
  const relation =
    input.relationNames.length === 0
      ? Type.String({ minLength: 1, maxLength: 128 })
      : literalUnion(input.relationNames, {
          description:
            "A canonical relation from the compiled graph contract. It must be valid for the selected source and target node types.",
        });
  return Type.Object(
    {
      rootSpec: planningSpecSchema(input.rootDefinition, input.rootFields, {
        description:
          "Only declared, agent-authored spec fields merged into the existing run-objective root. This does not declare a local node key; edges reference that objective with the literal $root.",
      }),
      nodes: Type.Array(schemaUnion(input.nodeSchemas), {
        maxItems: input.maximum,
        description:
          "Typed semantic nodes introduced by this seed. Every key must be unique and every node must be connected by edges to $root.",
      }),
      edges: Type.Array(
        Type.Object(
          {
            source: Type.String({
              minLength: 1,
              maxLength: 128,
              description:
                "Either the literal $root for the existing run objective or a key declared in nodes.",
            }),
            relation,
            target: Type.String({
              minLength: 1,
              maxLength: 128,
              description:
                "Either the literal $root for the existing run objective or a key declared in nodes.",
            }),
          },
          { additionalProperties: false },
        ),
        {
          maxItems: 4_096,
          description:
            "Canonical relationships whose endpoints are only $root or keys declared in nodes. Never use a title, rootSpec field, or invented root alias as an endpoint.",
        },
      ),
    },
    { additionalProperties: false },
  );
}

function planningNodeSeedSchema(definition: GraphNodeTypeDefinition): TSchema {
  return Type.Object(
    {
      key: Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        description:
          "Unique local key declared by this node. Do not declare $root or invent another alias for the existing run objective.",
      }),
      type: Type.Literal(definition.id, { description: definition.description }),
      title: Type.String({ minLength: 1, maxLength: 16_384 }),
      spec: planningSpecSchema(definition, planningFieldDefinitions(definition)),
    },
    {
      additionalProperties: false,
      description: `${definition.id}: ${definition.description}`,
    },
  );
}

function planningSpecSchema(
  definition: GraphNodeTypeDefinition,
  fields: Record<string, GraphFieldDefinition>,
  options: Record<string, unknown> = {},
): TSchema {
  const properties: Record<string, TSchema> = Object.create(null) as Record<string, TSchema>;
  for (const [name, field] of Object.entries(fields).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const schema = graphFieldSchema(field);
    properties[name] = field.required === true ? schema : Type.Optional(schema);
  }
  const requiredAny = (definition.required_any ?? [])
    .map((group) => group.filter((name) => Object.hasOwn(fields, name)))
    .filter((group) => group.length > 0);
  const requirement =
    requiredAny.length === 0
      ? ""
      : ` At least one field from each configured group is required: ${requiredAny.map((group) => `[${group.join(", ")}]`).join("; ")}.`;
  const description = `${typeof options.description === "string" ? options.description : `Spec for ${definition.id}.`}${requirement}`;
  return Type.Object(properties, { ...options, description, additionalProperties: false });
}

function planningFieldDefinitions(
  definition: GraphNodeTypeDefinition,
  excluded: ReadonlySet<string> = new Set(compilerOwnedSpecFields(definition)),
): Record<string, GraphFieldDefinition> {
  return Object.fromEntries(
    Object.entries(definition.fields).filter(([name]) => !excluded.has(name)),
  );
}

function compilerOwnedSpecFields(definition: GraphNodeTypeDefinition): string[] {
  return (definition.compiler_owned_fields ?? []).flatMap((field) => {
    const match = /^spec\.([^.]+)(?:\.|$)/u.exec(field);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

function planningFieldContract(fields: Record<string, GraphFieldDefinition>): JsonValue {
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [name, field] of Object.entries(fields).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    output[name] = graphFieldContract(field);
  }
  return output;
}

function assignmentMutationContract(
  configuration: CompiledConfiguration,
  ticket: DerivedTicketDefinition,
): JsonValue {
  const operation = configuration.registries.operations[ticket.operation_registry_id];
  if (operation === undefined)
    fail("operation_missing", `ticket ${ticket.id} operation is unavailable`);
  const schema = requireGraphSchema(configuration);
  const allowedNew = stringArray(operation.allowed_new_node_types, "allowed new node types");
  const allowedExisting = stringArray(
    operation.allowed_existing_node_types,
    "allowed existing node types",
  );
  const participating = new Set([...allowedNew, ...allowedExisting]);
  const nodeTypes = [...participating].sort(compareText).map((id) => {
    const definition = schema.nodeTypes.get(id);
    if (definition === undefined)
      fail(
        "operation_node_type",
        `operation ${ticket.operation_registry_id} allows unknown node type ${id}`,
      );
    return {
      id,
      description: definition.description,
      initialStatus: definition.initial_status,
      allowedForNew: allowedNew.includes(id),
      allowedForExisting: allowedExisting.includes(id),
      requiredAny: (definition.required_any ?? []).map((group) => [...group]),
      specFields: planningFieldContract(planningFieldDefinitions(definition)),
      compilerFieldSources: structuredClone(compilerFieldSourcesForNodeType(definition)),
    };
  });
  return {
    maxNewNodes: optionalSafeInteger(operation.max_new_nodes) ?? 0,
    allowNodeDeletion: operation.allow_node_deletion === true,
    allowEdgeDeletion: operation.allow_edge_deletion === true,
    nodeTypes,
    canonicalEdges: schema.edgeTypes
      .filter(
        (edge) =>
          participating.has(edge.source) ||
          edge.targets.some((target) => participating.has(target)),
      )
      .map((edge) => ({
        sourceType: edge.source,
        relation: edge.relation,
        targetTypes: [...edge.targets],
        ...(edge.bidirectional === undefined ? {} : { bidirectional: edge.bidirectional }),
      })),
  };
}

function assignmentCompilerOwnedFields(
  configuration: CompiledConfiguration,
  ticket: DerivedTicketDefinition,
): string[] {
  const operation = configuration.registries.operations[ticket.operation_registry_id];
  if (operation === undefined)
    fail("operation_missing", `ticket ${ticket.id} operation is unavailable`);
  const schema = requireGraphSchema(configuration);
  const participating = new Set([
    ...stringArray(operation.allowed_new_node_types, "allowed new node types"),
    ...stringArray(operation.allowed_existing_node_types, "allowed existing node types"),
  ]);
  return [...participating].sort(compareText).flatMap((nodeType) => {
    const definition = schema.nodeTypes.get(nodeType);
    if (definition === undefined) {
      fail(
        "operation_node_type",
        `operation ${ticket.operation_registry_id} allows unknown node type ${nodeType}`,
      );
    }
    return Object.keys(compilerFieldSourcesForNodeType(definition))
      .sort(compareText)
      .map((field) => `${nodeType}.${field}`);
  });
}

function reviewPredecessorHasCommandEvidence(
  predecessorExecution: Record<string, unknown> | undefined,
): boolean {
  if (predecessorExecution === undefined || !Array.isArray(predecessorExecution.predecessors)) {
    return false;
  }
  return predecessorExecution.predecessors.some((predecessorValue) => {
    const predecessor = optionalRecord(predecessorValue);
    if (predecessor === undefined || !Array.isArray(predecessor.checks)) return false;
    return predecessor.checks.some((checkValue) => {
      const check = optionalRecord(checkValue);
      return check !== undefined && Array.isArray(check.commands) && check.commands.length > 0;
    });
  });
}

function boundedHistoricalPreparationCheck(
  check: ConfigurationObject,
  maximumInlineStreamBytes: number,
): ConfigurationObject {
  let remainingBytes = maximumInlineStreamBytes;
  const projectStream = (value: unknown): ConfigurationObject | undefined => {
    const stream = optionalRecord(value);
    if (stream === undefined) return undefined;
    const content = typeof stream.content === "string" ? stream.content : undefined;
    if (content === undefined || stream.encoding === "omitted") return structuredClone(stream);
    const bytes = Buffer.from(content, "utf8");
    const included = Math.min(bytes.byteLength, remainingBytes);
    remainingBytes -= included;
    if (included === bytes.byteLength) return structuredClone(stream);
    const prefix = bytes.subarray(0, included).toString("utf8");
    return {
      ...structuredClone(stream),
      content: prefix,
      includedBytes: Buffer.byteLength(prefix, "utf8"),
      truncated: true,
      omission:
        "Authenticated historical stream was truncated to the bounded cross-ticket evidence budget.",
    };
  };
  const commands = Array.isArray(check.commands)
    ? check.commands.map((value) => {
        const command = requiredRecord(value, "historical preparation command");
        const stdout = projectStream(command.stdout);
        const stderr = projectStream(command.stderr);
        return {
          ...structuredClone(command),
          ...(stdout === undefined ? {} : { stdout }),
          ...(stderr === undefined ? {} : { stderr }),
        };
      })
    : [];
  return {
    ...structuredClone(check),
    commands,
    sourceEvidenceSha256: canonicalHash(check),
  };
}

function graphFieldContract(field: GraphFieldDefinition): JsonValue {
  return {
    type: field.type,
    required: field.required === true,
    ...(field.enum === undefined ? {} : { enum: structuredClone(field.enum) }),
    ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.items === undefined ? {} : { items: graphFieldContract(field.items) }),
    ...(field.properties === undefined
      ? {}
      : { properties: planningFieldContract(field.properties) }),
    ...(field.additional_properties === undefined
      ? {}
      : { additionalProperties: field.additional_properties }),
    ...(field.unique_by === undefined ? {} : { uniqueBy: field.unique_by }),
    ...(field.subset_of === undefined ? {} : { subsetOf: field.subset_of }),
    ...(field.disjoint_from === undefined ? {} : { disjointFrom: field.disjoint_from }),
  };
}

function graphFieldSchema(field: GraphFieldDefinition): TSchema {
  const description = field.description === undefined ? {} : { description: field.description };
  if (field.enum !== undefined) {
    const variants = field.enum.flatMap((value): TSchema[] => {
      if (value === null) return [Type.Null()];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [Type.Literal(value)];
      }
      return [];
    });
    if (variants.length === field.enum.length && variants.length > 0)
      return schemaUnion(variants, description);
  }
  switch (field.type) {
    case "string":
      return Type.String({
        ...description,
        ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
      });
    case "path":
    case "node_ref":
      return Type.String(description);
    case "boolean":
      return Type.Boolean(description);
    case "number":
      return Type.Number(description);
    case "integer":
      return Type.Integer(description);
    case "list":
      return Type.Array(
        field.items === undefined ? Type.Unknown() : graphFieldSchema(field.items),
        description,
      );
    case "object": {
      if (field.properties === undefined)
        return Type.Record(Type.String(), Type.Unknown(), description);
      const properties: Record<string, TSchema> = Object.create(null) as Record<string, TSchema>;
      for (const [name, child] of Object.entries(field.properties).sort(([left], [right]) =>
        compareText(left, right),
      )) {
        const schema = graphFieldSchema(child);
        properties[name] = child.required === true ? schema : Type.Optional(schema);
      }
      return Type.Object(properties, {
        ...description,
        additionalProperties: field.additional_properties !== false,
      });
    }
    case "json":
      return Type.Unknown(description);
  }
}

function literalUnion(values: string[], options: Record<string, unknown> = {}): TSchema {
  return schemaUnion(
    values.map((value) => Type.Literal(value)),
    options,
  );
}

function schemaUnion(schemas: TSchema[], options: Record<string, unknown> = {}): TSchema {
  if (schemas.length === 1) return { ...schemas[0], ...options };
  return Type.Union(schemas, options);
}

function assignmentTerminalSchema(
  policy: DerivedWorkflowStep["graph_mutation"],
  changeControl: AssignmentChangeControlContract = {
    role: "ordinary",
    allowUpstreamRequest: false,
    requireChangeApplication: false,
  },
  stepKind: DerivedWorkflowStep["kind"] = "agent",
): TSchema {
  const graphDelta = Type.Object(
    {
      protocol: Type.Literal("koni.graph-delta.v1"),
      expectedGraphHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
      upsertNodes: Type.Array(
        Type.Object(
          {
            node: Type.Object(
              {
                schema_version: Type.Literal("1.0"),
                id: Type.String({ minLength: 1, maxLength: 128 }),
                type: Type.String({ minLength: 1, maxLength: 128 }),
                title: Type.String({ minLength: 1, maxLength: 16_384 }),
                status: Type.String({ minLength: 1, maxLength: 128 }),
                spec: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
                edges: Type.Record(
                  Type.String({ minLength: 1, maxLength: 128 }),
                  Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { uniqueItems: true }),
                ),
                annotations: Type.Record(
                  Type.String({ minLength: 1, maxLength: 256 }),
                  Type.Unknown(),
                ),
              },
              { additionalProperties: false },
            ),
            expectedNodeHash: Type.Union([
              Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
              Type.Null(),
            ]),
          },
          { additionalProperties: false },
        ),
        { maxItems: 1_024 },
      ),
      deleteNodes: Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 128 }),
            expectedNodeHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 1_024 },
      ),
      addEdges: Type.Array(edgeSchema(), { maxItems: 4_096 }),
      removeEdges: Type.Array(edgeSchema(), { maxItems: 4_096 }),
    },
    { additionalProperties: false },
  );
  const baseCompleteFields: Record<string, TSchema> = {
    status: Type.Literal("completed", {
      description:
        'Required. The exact literal string "completed" (not "success"/"done"/"ok"/a hash) — use it when the step succeeded.',
    }),
    summary: Type.String({
      minLength: 1,
      maxLength: 1_024,
      description:
        "One concise sentence describing what this step accomplished. Plain text, at most 1024 characters.",
    }),
  };
  const normalFields = { ...baseCompleteFields };
  if (stepKind === "review") {
    normalFields.reviewVerdict = Type.Literal("approved", {
      description:
        'Required for a passing review. Use "approved" only when no material finding remains.',
    });
  }
  if (policy === "required") normalFields.graphDelta = graphDelta;
  else if (policy === "allowed")
    normalFields.graphDelta = Type.Optional(Type.Union([graphDelta, Type.Null()]));
  const complete: TSchema[] = [];
  if (!changeControl.requireChangeApplication) {
    complete.push(Type.Object(normalFields, { additionalProperties: false }));
  }
  if (changeControl.allowUpstreamRequest) {
    complete.push(
      Type.Object(
        {
          ...baseCompleteFields,
          ...(stepKind === "review"
            ? {
                reviewVerdict: Type.Literal("changes_requested", {
                  description:
                    "Required when a review identifies a repair outside the current grant and requests upstream authority.",
                }),
              }
            : {}),
          upstreamChangeRequest: Type.Object(
            {
              targetNodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
                minItems: 1,
                maxItems: 1_024,
                uniqueItems: true,
              }),
              fulfillment: Type.Union(
                [Type.Literal("planned_asset_repair"), Type.Literal("dynamic_scope_change")],
                {
                  description:
                    'Use "planned_asset_repair" only when the existing asset implementation workflow can satisfy the entire request by editing its authored source files/contracts. Use "dynamic_scope_change" when fulfillment requires execution, a runtime artifact/output root, a new run or other node, or authority beyond that asset\'s source write grant.',
                },
              ),
              summary: Type.String({ minLength: 1, maxLength: 1_024 }),
              reason: Type.String({ minLength: 1, maxLength: 4_096 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    );
  }
  if (changeControl.requireChangeApplication) {
    complete.push(
      Type.Object(
        {
          ...baseCompleteFields,
          ...(stepKind === "review" ? { reviewVerdict: Type.Literal("approved") } : {}),
          changeApplication: Type.Object(
            {
              operation: Type.String({ minLength: 1, maxLength: 128 }),
              targetNodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
                minItems: 1,
                maxItems: 1_024,
                uniqueItems: true,
              }),
              summary: Type.String({ minLength: 1, maxLength: 1_024 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    );
  }
  const failed = Type.Object(
    {
      status: Type.Literal("failed", {
        description:
          'Required. The exact literal string "failed" — use it only when the objective is genuinely impossible within this grant, not to probe the schema.',
      }),
      ...(stepKind === "review"
        ? {
            reviewVerdict: Type.Literal("rejected", {
              description:
                "Required for a rejected review. The blocker is the deterministic repair contract.",
            }),
          }
        : {}),
      summary: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 1_024,
          description:
            "Optional concise outcome summary. The blocker remains the complete repair diagnosis.",
        }),
      ),
      blocker: Type.String({
        minLength: 1,
        maxLength: 64 * 1024,
        description:
          'A specific, self-contained diagnosis: the exact obstacle, what you tried (edits, checks and their output), and why nothing in your grant can resolve it. Never a placeholder such as "test" or "probe".',
      }),
    },
    { additionalProperties: false },
  );
  return Type.Union([...complete, failed]);
}

function edgeSchema(): TSchema {
  return Type.Object(
    {
      source: Type.String({ minLength: 1, maxLength: 128 }),
      relation: Type.String({ minLength: 1, maxLength: 128 }),
      target: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  );
}

function parsePlanningOutput(value: unknown): PlanningOutput {
  return planningArtifactBoundary(() => parsePlanningArtifact(value));
}

function parsePlanningSeed(value: unknown): PlanningGraphSeed {
  return planningArtifactBoundary(() => parsePlanningGraphSeed(value));
}

function planningArtifactBoundary<Value>(operation: () => Value): Value {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PlanningArtifactValidationError) fail(error.code, error.message);
    throw error;
  }
}

export function remapPlanningSeedGateContractKeys(
  nodes: readonly PlanningGraphSeed["nodes"][number][],
  gateIds: ReadonlyMap<string, string>,
): PlanningGraphSeed["nodes"] {
  return nodes.map((node) => {
    const contracts = node.spec.gate_contracts;
    if (!isRecord(contracts)) return structuredClone(node);
    const remapped: Record<string, ConfigurationValue> = {};
    for (const [key, contract] of Object.entries(contracts)) {
      const resolved = gateIds.get(key) ?? key;
      if (Object.hasOwn(remapped, resolved)) {
        fail(
          "graph_seed_gate_contract",
          `graph seed node ${node.key} defines duplicate gate contract ${resolved}`,
        );
      }
      const materializedContract = structuredClone(contract);
      if (
        resolved !== key &&
        isRecord(materializedContract) &&
        Array.isArray(materializedContract.argv)
      ) {
        materializedContract.argv = materializedContract.argv.map((argument) =>
          argument === key ? resolved : argument,
        );
      }
      remapped[resolved] = materializedContract;
    }
    return {
      ...structuredClone(node),
      spec: { ...structuredClone(node.spec), gate_contracts: remapped as JsonValue },
    };
  });
}

function assertDevelopmentOnlySeedScope(run: RunRecord, seed: PlanningGraphSeed): void {
  const developmentOnly = /\bdevelopment(?:-|\s)only\b/iu.test(run.objective);
  const sealedFinalHoldout = /\bsealed\s+final\s+holdouts?\b/iu.test(run.objective);
  if (!developmentOnly || !sealedFinalHoldout) return;

  const prohibited =
    /\bholdouts?\b|\bheld[-\s]?out\b|\bheldout\b|\bfinal[-_\s]?(?:split|subjects?)\b/iu;
  const graphText = JSON.stringify({
    rootSpec: seed.rootSpec,
    nodes: seed.nodes,
    edges: seed.edges,
  });
  if (!prohibited.test(graphText)) return;
  fail(
    "graph_seed_sealed_holdout",
    "development-only objectives that prohibit sealed final holdouts may not seed holdout or final-split graph content",
  );
}

function compilePlanningSeed(
  configuration: CompiledConfiguration,
  run: RunRecord,
  seed: PlanningGraphSeed,
  fullPlan: Record<PlanDomain, string>,
  projectRoot: string,
): TypedGraph {
  assertDevelopmentOnlySeedScope(run, seed);
  const schema = requireGraphSchema(configuration);
  const initialization = configuration.behavior.profile.initialization;
  const rootType = requiredNonempty(
    initialization.rootNodeType,
    "compiled initialization root node type",
  );
  const goalField = requiredNonempty(
    initialization.goalField,
    "compiled initialization goal field",
  ).replace(/^spec\./u, "");
  const contextField = requiredNonempty(
    initialization.planningContextField,
    "compiled initialization planning context field",
  ).replace(/^spec\./u, "");
  if (Object.hasOwn(seed.rootSpec, goalField) || Object.hasOwn(seed.rootSpec, contextField)) {
    fail(
      "graph_seed_protected_root",
      "graph seed rootSpec may not replace the run goal or compiler planning context",
    );
  }
  const operationId = requiredNonempty(
    initialization.planningSeedOperation,
    "compiled initialization planning seed operation",
  );
  const operation = configuration.registries.operations[operationId];
  if (operation === undefined)
    fail("graph_seed_operation", `planning seed operation ${operationId} is missing`);
  const allowedTypes = new Set(
    stringArray(operation.allowed_new_node_types, "planning seed allowed node types"),
  );
  const maximum = optionalSafeInteger(operation.max_new_nodes) ?? 1_024;
  if (seed.nodes.length > maximum)
    fail("graph_seed_node_limit", `graph seed exceeds operation limit ${maximum}`);
  const rootDefinition = schema.nodeTypes.get(rootType);
  if (rootDefinition === undefined)
    fail("graph_seed_root_type", `unknown root node type ${rootType}`);
  const rootId = `root-${digestBody(canonicalHash([run.id, rootType])).slice(0, 20)}`;
  const ids = new Map<string, string>([["$root", rootId]]);
  for (const node of seed.nodes) {
    if (!allowedTypes.has(node.type))
      fail("graph_seed_node_type", `planning seed operation does not allow ${node.type}`);
    ids.set(
      node.key,
      `${node.type}-${digestBody(canonicalHash([run.id, node.key, node.type])).slice(0, 20)}`,
    );
  }
  const materializedNodes = remapPlanningSeedGateContractKeys(
    seed.nodes,
    new Map(
      seed.nodes
        .filter((node) => node.type === "gate")
        .map((node) => [node.key, ids.get(node.key)!]),
    ),
  );
  const nodes: GraphNode[] = [
    {
      schema_version: "1.0",
      id: rootId,
      type: rootType,
      title: run.objective,
      status: requiredNonempty(initialization.rootStatus, "compiled initialization root status"),
      spec: {
        [goalField]: run.objective,
        ...structuredClone(seed.rootSpec),
        [contextField]: {
          protocol: "koni.approved-planning-context.v1",
          fullPlanSha256: canonicalHash(fullPlan),
          runTypeId: run.runTypeId,
        },
      },
      edges: {},
      annotations: {},
    },
  ];
  for (const source of materializedNodes) {
    const definition = schema.nodeTypes.get(source.type)!;
    rejectCompilerOwnedSpec(
      definition.compiler_owned_fields ?? [],
      source.spec,
      `graph seed node ${source.key}`,
    );
    nodes.push({
      schema_version: "1.0",
      id: ids.get(source.key)!,
      type: source.type,
      title: source.title,
      status: definition.initial_status,
      spec: structuredClone(source.spec),
      edges: {},
      annotations: {},
    });
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of seed.edges) {
    const source = byId.get(ids.get(edge.source)!)!;
    const target = byId.get(ids.get(edge.target)!)!;
    const resolved = schema.resolveEdge(source.type, edge.relation, target.type);
    const canonicalSource = resolved.reversed ? target : source;
    const canonicalTarget = resolved.reversed ? source : target;
    const targets = canonicalSource.edges[resolved.definition.relation] ?? [];
    if (!targets.includes(canonicalTarget.id)) targets.push(canonicalTarget.id);
    targets.sort(compareText);
    canonicalSource.edges[resolved.definition.relation] = targets;
  }
  try {
    const graph = new TypedGraph(schema, nodes, { projectRoot });
    assertConfiguredGraphConstraints(configuration, graph, projectRoot);
    return graph;
  } catch (error) {
    if (error instanceof GraphValidationError)
      fail(
        "graph_seed_invalid",
        "planning graph seed violates its typed schema",
        error.diagnostics,
      );
    throw error;
  }
}

/**
 * Direct-approval runs approve the objective itself: no model plan or approved planning context is
 * invented. The root-only graph is still fully schema validated so the normal rule compiler can
 * deterministically derive the first research/formulation tickets.
 */
function compileDirectInitialGraph(
  configuration: CompiledConfiguration,
  run: RunRecord,
  projectRoot: string,
): TypedGraph {
  const schema = requireGraphSchema(configuration);
  const initialization = configuration.behavior.profile.initialization;
  const rootType = requiredNonempty(
    initialization.rootNodeType,
    "compiled initialization root node type",
  );
  const goalField = requiredNonempty(
    initialization.goalField,
    "compiled initialization goal field",
  ).replace(/^spec\./u, "");
  const rootDefinition = schema.nodeTypes.get(rootType);
  if (rootDefinition === undefined)
    fail("direct_approval_root_type", `unknown root node type ${rootType}`);
  // Direct runs intentionally skip the planner, but Research roots still require a
  // declarative scientific field. Preserve the compiler-owned intake objective and
  // use the separately collected proposition when the run type provides one.
  const directScientificField =
    rootDefinition.fields.hypothesis !== undefined
      ? "hypothesis"
      : rootDefinition.fields.statement !== undefined
        ? "statement"
        : undefined;
  const directScientificProposition =
    typeof run.intake.hypothesis === "string" && run.intake.hypothesis.trim().length > 0
      ? run.intake.hypothesis.trim()
      : run.objective;
  const rootId = `root-${digestBody(canonicalHash([run.id, rootType])).slice(0, 20)}`;
  try {
    const graph = new TypedGraph(
      schema,
      [
        {
          schema_version: "1.0",
          id: rootId,
          type: rootType,
          title: run.objective,
          status: requiredNonempty(
            initialization.rootStatus,
            "compiled initialization root status",
          ),
          spec: {
            [goalField]: run.objective,
            ...(directScientificField === undefined
              ? {}
              : { [directScientificField]: directScientificProposition }),
          },
          edges: {},
          annotations: { run_root: true },
        },
      ],
      { projectRoot },
    );
    assertConfiguredGraphConstraints(configuration, graph, projectRoot);
    return graph;
  } catch (error) {
    if (error instanceof GraphValidationError) {
      fail(
        "direct_approval_graph_invalid",
        "direct-approval root violates its typed schema",
        error.diagnostics,
      );
    }
    throw error;
  }
}

/**
 * Collapse the graph delta's redundant relationship views into the canonical edge mutation lane.
 *
 * A node upsert must carry a complete node for strict per-node CAS, so models naturally express a
 * relationship change both by editing `node.edges` and by using `addEdges`/`removeEdges`. Treat the
 * former as an ergonomic view of the latter, then restore the authoritative stored edge snapshot
 * before applying the upsert. The node hash check remains exact, while edge scope, direction,
 * deletion policy, predicates, and graph validation still run through their existing compiler
 * path. Annotations are deliberately not normalized because they have separate authority.
 */
function normalizeAgentGraphRelationships(
  graph: TypedGraph,
  delta: GraphDelta,
  reviewReworkWritableNodeIds: readonly string[] = [],
): GraphDelta {
  const normalized = structuredClone(delta);
  const reviewReworkWritable = new Set(reviewReworkWritableNodeIds);
  const explicitAdds = new Set(normalized.addEdges.map(graphEdgeKey));
  const explicitRemovals = new Set(normalized.removeEdges.map(graphEdgeKey));
  const addKeys = new Set(explicitAdds);
  const removeKeys = new Set(explicitRemovals);

  const addEdge = (edge: GraphEdge): void => {
    const key = graphEdgeKey(edge);
    if (explicitRemovals.has(key)) {
      fail(
        "graph_delta_edge_conflict",
        `relationship ${edge.source}.${edge.relation} -> ${edge.target} is both added and removed`,
      );
    }
    if (!addKeys.has(key)) {
      normalized.addEdges.push(edge);
      addKeys.add(key);
    }
  };
  const removeEdge = (edge: GraphEdge): void => {
    const key = graphEdgeKey(edge);
    if (explicitAdds.has(key)) {
      fail(
        "graph_delta_edge_conflict",
        `relationship ${edge.source}.${edge.relation} -> ${edge.target} is both added and removed`,
      );
    }
    if (!removeKeys.has(key)) {
      normalized.removeEdges.push(edge);
      removeKeys.add(key);
    }
  };

  for (const mutation of normalized.upsertNodes) {
    const existing = graph.node(mutation.node.id);
    // Review recovery can replay the original create-shaped delta after the compiler has preserved
    // that ticket's accepted pre-review node. Durable graph_added activity is the ownership
    // receipt, so bind the replay to the exact current node instead of failing its original CAS.
    if (
      existing !== undefined &&
      mutation.expectedNodeHash === null &&
      reviewReworkWritable.has(existing.id)
    ) {
      mutation.expectedNodeHash = canonicalHash(existing);
    }
    const priorEdges = existing?.edges ?? {};
    const requestedEdges = mutation.node.edges;
    const relations = new Set([...Object.keys(priorEdges), ...Object.keys(requestedEdges)]);
    for (const relation of [...relations].sort(compareText)) {
      const priorTargets = new Set(priorEdges[relation] ?? []);
      const requestedTargets = new Set(requestedEdges[relation] ?? []);
      for (const target of [...requestedTargets].sort(compareText)) {
        if (!priorTargets.has(target)) addEdge({ source: mutation.node.id, relation, target });
      }
      for (const target of [...priorTargets].sort(compareText)) {
        if (!requestedTargets.has(target)) {
          const edge = { source: mutation.node.id, relation, target };
          // A create-shaped recovery output keeps relationships in the dedicated edge lane. If
          // that exact add was already preserved, the empty embedded snapshot does not delete it.
          if (!explicitAdds.has(graphEdgeKey(edge))) removeEdge(edge);
        }
      }
    }
    mutation.node.edges = structuredClone(priorEdges);
  }
  return normalized;
}

function graphEdgeKey(edge: GraphEdge): string {
  return `${edge.source}\0${edge.relation}\0${edge.target}`;
}

/** Every graph node whose current state can materially affect review of a candidate delta. */
export function graphDeltaReviewCandidateNodeIds(delta: GraphDelta): string[] {
  const candidates = new Set<string>();
  for (const mutation of delta.upsertNodes) {
    candidates.add(mutation.node.id);
    for (const targets of Object.values(mutation.node.edges)) {
      for (const target of targets) candidates.add(target);
    }
  }
  for (const deletion of delta.deleteNodes) candidates.add(deletion.id);
  for (const edge of [...delta.addEdges, ...delta.removeEdges]) {
    candidates.add(edge.source);
    candidates.add(edge.target);
  }
  return [...candidates].sort(compareText);
}

/**
 * Later workflow steps retain authority over nodes this ticket created in earlier steps. The
 * original compiled definition cannot name those nodes because their IDs did not exist when the
 * ticket was derived. Compiler-authored graph activity is the durable ownership receipt; callers
 * still suppress write authority for graph-mutation-forbidden steps.
 */
export function ticketCreatedNodeIds(
  run: RunRecord,
  ticket: TicketRecord,
  graph: TypedGraph,
): string[] {
  return [
    ...new Set(
      run.activity
        .filter(
          (activity) =>
            activity.kind === "graph_added" &&
            activity.ticketId === ticket.id &&
            activity.nodeId !== undefined &&
            graph.node(activity.nodeId) !== undefined,
        )
        .map((activity) => activity.nodeId!),
    ),
  ].sort(compareText);
}

function reviewReworkCoversStep(ticket: TicketRecord, stepId: string): boolean {
  const rework = ticket.reviewReworks?.at(-1);
  if (rework === undefined) return false;
  if (rework.scope === "review_only") {
    return ticket.steps.find((step) => step.id === stepId)?.kind === "review";
  }
  return reviewReworkAppliesToStep(ticket, stepId);
}

function validateAgentGraphDelta(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  ticket: DerivedTicketDefinition,
  step: DerivedWorkflowStep,
  delta: GraphDelta,
  additionalWritableNodeIds: readonly string[] = [],
): void {
  // The whole-graph hash may have moved while the worker was in flight (a disjoint sibling ticket
  // committed its own compile). That is not a conflict: every check below validates each mutation
  // against the CURRENT `graph`, and `applyRebased` re-runs the per-node expectedNodeHash CAS, so a
  // node this delta actually touches changing underneath it still fails. The scheduler forbids a
  // concurrent ticket from writing any node in this delta's read/write scope, so a moved
  // whole-graph hash reflects only untouched sibling work — rebase instead of wedging the run.
  if (delta.expectedGraphHash !== graph.hash && !isSha256Digest(delta.expectedGraphHash)) {
    fail("graph_delta_cas", "agent graph delta carries no valid expected graph hash");
  }
  const operation = configuration.registries.operations[ticket.operation_registry_id];
  if (operation === undefined && !ticket.rule_id.startsWith("compiler."))
    fail("operation_missing", "ticket operation disappeared from pinned config");
  const writable = new Set([
    ...(step.write_node_ids ?? ticket.scope.write_node_ids),
    ...additionalWritableNodeIds,
  ]);
  const reviewReworkOwned = new Set(additionalWritableNodeIds);
  const allowedNew = new Set(
    stringArray(operation?.allowed_new_node_types, "allowed new node types"),
  );
  const allowedExisting = new Set(
    stringArray(operation?.allowed_existing_node_types, "allowed existing node types"),
  );
  const schema = requireGraphSchema(configuration);
  const typedGateIds = new Set(
    typedGateIdentityCatalog(configuration, graph).gateNodes.map((node) => node.id),
  );
  let added = 0;
  for (const mutation of delta.upsertNodes) {
    const existing = graph.node(mutation.node.id);
    if (existing === undefined) {
      added += 1;
      if (!allowedNew.has(mutation.node.type))
        fail("graph_delta_new_type", `operation cannot add ${mutation.node.type}`);
      const definition = schema.nodeTypes.get(mutation.node.type);
      if (definition === undefined || mutation.node.status !== definition.initial_status) {
        fail(
          "graph_delta_new_status",
          "new graph nodes must carry the compiler-declared initial status",
        );
      }
      rejectCompilerOwnedSpec(
        definition.compiler_owned_fields ?? [],
        mutation.node.spec,
        `new node ${mutation.node.id}`,
      );
      if (
        Object.keys(mutation.node.edges).length > 0 ||
        Object.keys(mutation.node.annotations).length > 0
      ) {
        fail(
          "graph_delta_embedded_state",
          "new node relationships and annotations must use dedicated authority tools/edge mutations",
        );
      }
    } else {
      if (!writable.has(existing.id))
        fail("graph_delta_write_scope", `node ${existing.id} is outside the step write scope`);
      if (
        allowedExisting.size > 0 &&
        !allowedExisting.has(existing.type) &&
        !reviewReworkOwned.has(existing.id)
      )
        fail("graph_delta_existing_type", `operation cannot update ${existing.type}`);
      if (mutation.node.type !== existing.type || mutation.node.status !== existing.status) {
        fail("graph_delta_compiler_state", "agent graph deltas may not change node type or status");
      }
      if (
        canonicalHash(mutation.node.edges) !== canonicalHash(existing.edges) ||
        canonicalHash(mutation.node.annotations) !== canonicalHash(existing.annotations)
      ) {
        fail(
          "graph_delta_embedded_state",
          "relationships and annotations must not be smuggled through a node upsert",
        );
      }
      preserveCompilerOwnedSpec(
        schema.nodeTypes.get(existing.type)?.compiler_owned_fields ?? [],
        existing,
        mutation.node,
      );
      if (operation?.operation === "implement-asset" && existing.type === "asset") {
        const existingContracts = optionalRecord(existing.spec.gate_contracts);
        assertAssetImplementationObligationsPreserved(existing, mutation.node, {
          removableGateContractIds: Object.keys(existingContracts ?? {}).filter(
            (gateId) => !typedGateIds.has(gateId),
          ),
        });
      }
      if (existing.type === "run") {
        assertRunPlanObligationsPreserved(existing, mutation.node);
        assertRunPlanUsesRepositoryOwnedArgv(mutation.node);
      }
    }
  }
  const maximum = optionalSafeInteger(operation?.max_new_nodes) ?? 0;
  if (added > maximum)
    fail("graph_delta_new_limit", `operation permits at most ${maximum} new nodes`);
  if (delta.deleteNodes.length > 0 && operation?.allow_node_deletion !== true)
    fail("graph_delta_delete", "operation does not allow node deletion");
  for (const deletion of delta.deleteNodes)
    if (!writable.has(deletion.id))
      fail("graph_delta_write_scope", `node ${deletion.id} is outside the step write scope`);
  if (delta.removeEdges.length > 0 && operation?.allow_edge_deletion !== true)
    fail("graph_delta_edge_delete", "operation does not allow relationship deletion");
  const addedIds = new Set(
    delta.upsertNodes.filter((item) => item.expectedNodeHash === null).map((item) => item.node.id),
  );
  const projected = new Map(graph.nodes().map((node) => [node.id, node]));
  for (const item of delta.upsertNodes) projected.set(item.node.id, item.node);
  for (const edge of [...delta.addEdges, ...delta.removeEdges]) {
    const source = projected.get(edge.source);
    const target = projected.get(edge.target);
    if (source === undefined || target === undefined)
      fail("graph_delta_edge_node", "graph edge references a missing node");
    const resolved = schema.resolveEdge(source.type, edge.relation, target.type);
    const canonicalSourceId = resolved.reversed ? target.id : source.id;
    if (!writable.has(canonicalSourceId) && !addedIds.has(canonicalSourceId)) {
      fail(
        "graph_delta_edge_scope",
        `relationship source ${canonicalSourceId} is outside the write scope`,
      );
    }
  }
}

/** Asset implementation must satisfy an admitted plan, not make missing work disappear. */
export function assertAssetImplementationObligationsPreserved(
  existing: GraphNode,
  updated: GraphNode,
  options: { readonly removableGateContractIds?: readonly string[] } = {},
): void {
  if (
    canonicalHash(existing.spec.capabilities ?? null) !==
    canonicalHash(updated.spec.capabilities ?? null)
  ) {
    fail(
      "asset_implementation_obligation",
      `asset ${existing.id} implementation cannot change its planned capability declarations`,
    );
  }
  const existingPlan = optionalRecord(existing.spec.implementation_plan);
  const updatedPlan = optionalRecord(updated.spec.implementation_plan);
  const existingImplementation = optionalRecord(existing.spec.implementation);
  const updatedImplementation = optionalRecord(updated.spec.implementation);
  assertDeclaredStringsPreserved(
    existing.id,
    "implementation file",
    existingPlan?.files,
    updatedPlan?.files,
  );
  assertDeclaredStringsPreserved(
    existing.id,
    "implementation entrypoint",
    existingImplementation?.entrypoints,
    updatedImplementation?.entrypoints,
  );
  const existingContracts = optionalRecord(existing.spec.gate_contracts);
  const updatedContracts = optionalRecord(updated.spec.gate_contracts);
  const removableContracts = new Set(options.removableGateContractIds ?? []);
  for (const gateId of Object.keys(existingContracts ?? {}).sort(compareText)) {
    if (updatedContracts?.[gateId] !== undefined || removableContracts.has(gateId)) continue;
    fail(
      "asset_implementation_obligation",
      `asset ${existing.id} implementation cannot remove declared gate contract ${gateId}`,
    );
  }
}

/** Recovery may correct a runtime contract, but it may not erase accepted execution obligations. */
export function assertRunPlanObligationsPreserved(existing: GraphNode, updated: GraphNode): void {
  const existingContract = optionalRecord(existing.spec.runtime_contract);
  if (existingContract === undefined) return;
  const updatedContract = optionalRecord(updated.spec.runtime_contract);
  for (const field of [
    "command",
    "composed_verification_command",
    "result_protocol",
    "required_measurements",
    "asset_entrypoints",
    "scientific_inputs",
  ] as const) {
    if (existingContract[field] === undefined || updatedContract?.[field] !== undefined) continue;
    fail(
      "runtime_contract_obligation",
      `run ${existing.id} update cannot remove established runtime obligation ${field}`,
    );
  }
}

/** Runtime plans must execute repository-owned programs, never source text smuggled through argv. */
export function assertRunPlanUsesRepositoryOwnedArgv(node: Readonly<GraphNode>): void {
  const contract = optionalRecord(node.spec.runtime_contract);
  if (contract === undefined) return;
  const interpreters =
    /^(?:bash|bun|deno|fish|node|perl|php|python(?:\d+(?:\.\d+)*)?|ruby|sh|zsh)$/u;
  const inlineFlags = new Set(["-c", "-e", "--eval", "--execute"]);
  for (const field of ["command", "composed_verification_command"] as const) {
    const raw = contract[field];
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== "string"))
      continue;
    const argv = raw as string[];
    const executable = path.basename(argv[0]!).toLowerCase();
    const embedsInlineSource =
      (interpreters.test(executable) &&
        argv.slice(1).some((argument) => inlineFlags.has(argument))) ||
      argv.some(
        (argument) =>
          argument.includes("\n") || argument.includes("\r") || /(?:^|\s)<<-?\s*/u.test(argument),
      );
    if (embedsInlineSource) {
      fail(
        "runtime_contract_inline_argv",
        `run ${node.id} ${field} cannot embed an inline interpreter payload; put the logic in a repository file and pass that project-relative path as a plain argv element`,
      );
    }
  }
}

function assertDeclaredStringsPreserved(
  assetId: string,
  label: string,
  existing: unknown,
  updated: unknown,
): void {
  const required = Array.isArray(existing)
    ? existing.filter((value): value is string => typeof value === "string")
    : [];
  const retained = new Set(
    Array.isArray(updated)
      ? updated.filter((value): value is string => typeof value === "string")
      : [],
  );
  for (const value of required.sort(compareText)) {
    if (retained.has(value)) continue;
    fail(
      "asset_implementation_obligation",
      `asset ${assetId} implementation cannot remove declared ${label} ${value}`,
    );
  }
}

function materializeCompilerFieldSources(
  configuration: CompiledConfiguration,
  run: RunRecord,
  delta: GraphDelta,
): GraphDelta {
  const schema = requireGraphSchema(configuration);
  const materialized = structuredClone(delta);
  for (const mutation of materialized.upsertNodes) {
    const definition = schema.nodeTypes.get(mutation.node.type);
    if (definition === undefined) continue;
    const legacyDelivery = canonicalHash(definition) === LEGACY_DELIVERY_NODE_SHA256;
    if (mutation.expectedNodeHash !== null && !legacyDelivery) continue;
    for (const [field, source] of Object.entries(compilerFieldSourcesForNodeType(definition))) {
      if (!field.startsWith("spec.")) {
        fail("compiler_field_source", `compiler field source ${field} must target spec.*`);
      }
      setNestedSpec(
        mutation.node.spec,
        field.slice("spec.".length),
        compilerFieldSourceValue(run, source),
      );
    }
  }
  return materialized;
}

function compilerFieldSourcesForNodeType(
  definition: GraphNodeTypeDefinition,
): Readonly<Record<string, GraphCompilerFieldSource>> {
  if (definition.compiler_field_sources !== undefined) return definition.compiler_field_sources;
  // Exact compatibility for Coding 0.7/early-0.8 runs. Their delivery target was model-authored,
  // which allowed `main` to be guessed even when immutable run Git targeted another branch. New
  // profiles declare this binding directly; only the frozen legacy node contract is inferred.
  return canonicalHash(definition) === LEGACY_DELIVERY_NODE_SHA256
    ? { "spec.target_branch": "run.git.target.ref" }
    : {};
}

function compilerFieldSourceValue(run: RunRecord, source: GraphCompilerFieldSource): JsonValue {
  switch (source) {
    case "run.id":
      return run.id;
    case "run.objective":
      return run.objective;
    case "run.run_type_id":
      return run.runTypeId;
    case "run.git.target.ref":
      return run.git.target.ref;
  }
}

export async function applyReviewEffects(input: {
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  ticket: DerivedTicketDefinition;
  step: DerivedWorkflowStep;
  reviewId: string;
  actor: string;
  candidateNodeIds: readonly string[];
  projectRoot: string;
  evidence?: RuleAuthorityEvidence;
}): Promise<{
  graph: TypedGraph;
  changes: Array<{ kind: "modified"; nodeId: string; nodeType: string; title: string }>;
}> {
  const { configuration, graph, ticket, step } = input;
  if (step.kind !== "review") return { graph, changes: [] };
  const operation = configuration.registries.operations[ticket.operation_registry_id];
  if (operation === undefined) return { graph, changes: [] };
  let current = graph;
  const changes: Array<{ kind: "modified"; nodeId: string; nodeType: string; title: string }> = [];
  if (operation.operation === "implement-asset") {
    for (const nodeId of input.candidateNodeIds) {
      const node = current.node(nodeId);
      if (node === undefined) continue;
      const acceptance = await prepareFilesystemManifestAcceptance(
        configuration,
        node,
        input.projectRoot,
      );
      if (acceptance === undefined) continue;
      if (acceptance.blockingErrors.length > 0) {
        fail(
          "filesystem_manifest_acceptance",
          `review cannot accept ${node.id}: ${acceptance.blockingErrors.join("; ")}`,
        );
      }
      const owned = new Set(
        stringArray(
          configuration.registries.node_types[node.type]?.compiler_owned_fields,
          `node type ${node.type} compiler-owned fields`,
        ),
      );
      if (!owned.has(acceptance.outputField)) {
        fail(
          "filesystem_manifest_authority",
          `filesystem manifest output ${acceptance.outputField} is not compiler-owned for ${node.type}`,
        );
      }
      const updated = structuredClone(node);
      setNodeField(updated, acceptance.outputField, acceptance.manifest as unknown as JsonValue);
      if (canonicalHash(updated) === canonicalHash(node)) continue;
      const applied = current.apply({
        protocol: "koni.graph-delta.v1",
        expectedGraphHash: current.hash,
        upsertNodes: [{ node: updated, expectedNodeHash: canonicalHash(node) }],
        deleteNodes: [],
        addEdges: [],
        removeEdges: [],
      });
      current = applied.graph;
      changes.push({ kind: "modified", nodeId: node.id, nodeType: node.type, title: node.title });
    }
  }
  if (!Array.isArray(operation.review_effects)) return { graph: current, changes };
  for (const rawEffect of operation.review_effects) {
    const effect = requiredRecord(
      rawEffect,
      `review effect for ${ticket.id}`,
    ) as ConfigurationObject;
    if (effect.verdict !== "passed") continue;
    const select = requiredRecord(effect.select, "review effect selector");
    const nodeTypes = new Set(stringArray(select.node_types, "review effect node types"));
    const set = requiredRecord(effect.set, "review effect set") as ConfigurationObject;
    const classified = input.candidateNodeIds
      .map((id) => current.node(id))
      .flatMap((node) => {
        if (node === undefined || (nodeTypes.size > 0 && !nodeTypes.has(node.type))) return [];
        const pending = predicateMatches(node, optionalRecord(select.predicate));
        if (!pending && !reviewEffectSetAlreadyApplied(node, set, input.reviewId, input.actor))
          return [];
        return [{ node, pending }];
      });
    const candidates = classified.map(({ node }) => node);
    validateEffectCount(candidates.length, optionalRecord(effect.count));
    const preconditions = Array.isArray(effect.preconditions) ? effect.preconditions : [];
    for (const { node, pending } of classified) {
      // Preconditions describe the legal transition source. A hash-bound replay may already be
      // in the exact configured after-state (including fields whose source predicate was absent),
      // so only newly transitioning candidates must still satisfy them.
      if (!pending) continue;
      for (const precondition of preconditions) {
        if (!predicateMatches(node, requiredRecord(precondition, "review effect precondition"))) {
          fail("review_effect_precondition", `review effect precondition failed for ${node.id}`);
        }
      }
    }
    await validateOperationReceiptCoverage({
      configuration,
      graph: current,
      operationId: ticket.operation_registry_id,
      operation,
      candidates,
      projectRoot: input.projectRoot,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
    await validateReviewEffectCoverage({
      configuration,
      graph: current,
      ticket,
      effect,
      candidates,
      projectRoot: input.projectRoot,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
    for (const node of candidates) {
      const updated = structuredClone(node);
      for (const [field, value] of Object.entries(set)) {
        const resolved = resolveReviewEffectTokens(value, input.reviewId, input.actor);
        if (field === "status") updated.status = requiredNonempty(resolved, "review effect status");
        else if (field.startsWith("spec."))
          setNestedSpec(updated.spec, field.slice("spec.".length), resolved);
        else fail("review_effect_field", `unsupported compiler review effect field ${field}`);
      }
      // A terminal action may be replayed after its graph writes were durably published but its
      // ticket/action settlement was interrupted. Revalidating that exact after-state must not
      // manufacture a second graph revision or require another model attempt.
      if (canonicalHash(updated) === canonicalHash(node)) continue;
      const applied = current.apply({
        protocol: "koni.graph-delta.v1",
        expectedGraphHash: current.hash,
        upsertNodes: [{ node: updated, expectedNodeHash: canonicalHash(node) }],
        deleteNodes: [],
        addEdges: [],
        removeEdges: [],
      });
      current = applied.graph;
      changes.push({ kind: "modified", nodeId: node.id, nodeType: node.type, title: node.title });
    }
  }
  return { graph: current, changes };
}

/**
 * Recognize the exact compiler-owned after-state of a review effect.
 *
 * This is deliberately narrower than ignoring the selector predicate: every static field in the
 * configured `set` must already match, and token fields are accepted only when the prior value is
 * a non-empty authenticated compiler value. At least one static field is required so an effect
 * containing only a fresh review token can never select an otherwise-unqualified node.
 */
function reviewEffectSetAlreadyApplied(
  node: GraphNode,
  set: ConfigurationObject,
  reviewId: string,
  actor: string,
): boolean {
  let staticFieldCount = 0;
  for (const [field, configured] of Object.entries(set)) {
    const current = graphField(node, field);
    if (configured === "$review.id") {
      if (typeof current !== "string" || current.trim().length === 0) return false;
      continue;
    }
    const resolved = resolveReviewEffectTokens(configured, reviewId, actor);
    staticFieldCount += 1;
    if (canonicalHash(current ?? null) !== canonicalHash(resolved)) return false;
  }
  return staticFieldCount > 0;
}

async function validateOperationReceiptCoverage(input: {
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  operationId: string;
  operation: ConfigurationObject;
  candidates: readonly GraphNode[];
  projectRoot: string;
  evidence?: RuleAuthorityEvidence;
}): Promise<void> {
  if (input.operation.receipt_coverage === undefined) return;
  const leaves: ConfigurationObject[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.op === "receipt_coverage_current" && value.receipt_coverage === input.operationId) {
      leaves.push(structuredClone(value) as ConfigurationObject);
    }
    for (const item of Object.values(value)) visit(item);
  };
  for (const query of Object.values(input.configuration.registries.queries)) visit(query);
  if (leaves.length !== 1) {
    fail(
      "review_effect_receipt_coverage",
      `operation ${input.operationId} must have exactly one configured current receipt-coverage predicate`,
    );
  }
  const adapter = await createProductionRuleDomainAdapter({
    configuration: input.configuration,
    graph: input.graph,
    projectRoot: input.projectRoot,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
  const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph, adapter);
  for (const candidate of input.candidates) {
    const current = evaluator.withBinding("node", [candidate.id], () =>
      evaluator.evaluate(leaves[0]!),
    );
    if (!current) {
      fail(
        "review_effect_receipt_coverage",
        `review effect cannot promote ${candidate.id} without exact current authenticated receipt coverage`,
      );
    }
  }
}

function predicateMatches(
  node: GraphNode,
  predicate: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (predicate === undefined) return true;
  const field = requiredNonempty(predicate.field, "effect predicate field");
  const operation = requiredNonempty(predicate.op, "effect predicate op");
  const value = graphField(node, field);
  if (operation === "equals")
    return canonicalHash(value ?? null) === canonicalHash(predicate.value ?? null);
  if (operation === "present") return value !== undefined;
  if (operation === "absent") return value === undefined;
  if (operation === "non_empty") return isNonemptyConfigurationValue(value);
  fail("review_effect_predicate", `unsupported review effect predicate ${operation}`);
}

async function validateReviewEffectCoverage(input: {
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  ticket: DerivedTicketDefinition;
  effect: ConfigurationObject;
  candidates: readonly GraphNode[];
  projectRoot: string;
  evidence?: RuleAuthorityEvidence;
}): Promise<void> {
  if (!Array.isArray(input.effect.coverage) || input.effect.coverage.length === 0) return;
  const adapter = await createProductionRuleDomainAdapter({
    configuration: input.configuration,
    graph: input.graph,
    projectRoot: input.projectRoot,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  });
  const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph, adapter);
  evaluator.bind("target", input.ticket.target_node_ids);
  for (const candidate of input.candidates) {
    evaluator.withBinding("candidate", [candidate.id], () => {
      for (const rawCoverage of input.effect.coverage as ConfigurationValue[]) {
        const coverage = requiredRecord(
          rawCoverage,
          "review effect coverage",
        ) as ConfigurationObject;
        const coverageId = requiredNonempty(coverage.id, "review effect coverage id");
        const requiredSelector = coverage.required;
        if (requiredSelector === undefined) {
          fail(
            "review_effect_coverage",
            `review effect coverage ${coverageId} has no required selector`,
          );
        }
        const requiredIds = new Set(evaluator.select(requiredSelector));
        const actual = requiredRecord(
          coverage.actual,
          `review effect coverage ${coverageId} actual`,
        ) as ConfigurationObject;
        const actualIds = reviewEffectActualIds(candidate, actual, coverageId);
        const missing = [...requiredIds].filter((id) => !actualIds.has(id)).sort(compareText);
        const extra = [...actualIds].filter((id) => !requiredIds.has(id)).sort(compareText);
        if (missing.length > 0 || extra.length > 0) {
          fail(
            "review_effect_coverage",
            `review effect coverage ${coverageId} is not exact; missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
          );
        }
      }
    });
  }
}

function reviewEffectActualIds(
  candidate: GraphNode,
  actual: ConfigurationObject,
  coverageId: string,
): Set<string> {
  const kind = requiredNonempty(actual.kind, `review effect coverage ${coverageId} actual kind`);
  if (kind === "outgoing_relation") {
    const relation = requiredNonempty(
      actual.relation,
      `review effect coverage ${coverageId} relation`,
    );
    return strictReviewIdSet(candidate.edges[relation] ?? [], coverageId);
  }
  const field = requiredNonempty(actual.field, `review effect coverage ${coverageId} field`);
  const value = graphField(candidate, field);
  if (kind === "field_value") {
    return strictReviewIdSet(
      [requiredNonempty(value, `review effect coverage ${coverageId} field ${field}`)],
      coverageId,
    );
  }
  if (kind === "field_values") {
    if (!Array.isArray(value))
      fail(
        "review_effect_coverage",
        `review effect coverage ${coverageId} field ${field} is not a list`,
      );
    return strictReviewIdSet(
      value.map((item) =>
        requiredNonempty(item, `review effect coverage ${coverageId} field ${field}`),
      ),
      coverageId,
    );
  }
  if (kind === "object_keys") {
    if (!isRecord(value))
      fail(
        "review_effect_coverage",
        `review effect coverage ${coverageId} field ${field} is not an object`,
      );
    const allowed = Array.isArray(actual.allowed_values) ? actual.allowed_values : [];
    if (allowed.length > 0) {
      for (const [id, disposition] of Object.entries(value)) {
        if (!allowed.some((item) => canonicalHash(item) === canonicalHash(disposition))) {
          fail(
            "review_effect_coverage",
            `review effect coverage ${coverageId} has an invalid disposition for ${id}`,
          );
        }
      }
    }
    return strictReviewIdSet(Object.keys(value), coverageId);
  }
  fail(
    "review_effect_coverage",
    `review effect coverage ${coverageId} has unsupported actual kind ${kind}`,
  );
}

function strictReviewIdSet(values: readonly string[], coverageId: string): Set<string> {
  if (values.some((value) => value.trim().length === 0)) {
    fail(
      "review_effect_coverage",
      `review effect coverage ${coverageId} contains an empty node id`,
    );
  }
  const output = new Set(values);
  if (output.size !== values.length) {
    fail(
      "review_effect_coverage",
      `review effect coverage ${coverageId} contains duplicate node ids`,
    );
  }
  return output;
}

function resolveReviewEffectTokens(value: unknown, reviewId: string, actor: string): JsonValue {
  if (value === "$review.id") return reviewId;
  if (value === "$actor") return actor;
  if (typeof value === "string" && value.startsWith("$")) {
    fail("review_effect_token", `unknown review effect compiler token ${value}`);
  }
  if (Array.isArray(value))
    return value.map((item) => resolveReviewEffectTokens(item, reviewId, actor));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveReviewEffectTokens(item, reviewId, actor),
      ]),
    );
  }
  assertJsonValue(value, "review effect value");
  return value;
}

function isNonemptyConfigurationValue(value: JsonValue | undefined): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

function validateEffectCount(actual: number, count: ConfigurationObject | undefined): void {
  if (count === undefined) return;
  const exact = optionalSafeInteger(count.exact);
  const min = optionalSafeInteger(count.min);
  const max = optionalSafeInteger(count.max);
  if (
    (exact !== undefined && actual !== exact) ||
    (min !== undefined && actual < min) ||
    (max !== undefined && actual > max)
  ) {
    fail(
      "review_effect_count",
      `review effect selected ${actual} nodes outside its configured count`,
    );
  }
}

function graphField(node: GraphNode, field: string): JsonValue | undefined {
  if (field === "status") return node.status;
  const segments = field.replace(/^spec\./u, "").split(".");
  let value: unknown = node.spec;
  for (const segment of segments) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value as JsonValue | undefined;
}

function setNestedSpec(spec: Record<string, JsonValue>, field: string, value: JsonValue): void {
  const segments = field.split(".");
  let cursor: Record<string, JsonValue> = spec;
  for (const segment of segments.slice(0, -1)) {
    const child = cursor[segment];
    if (!isRecord(child)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, JsonValue>;
  }
  cursor[segments.at(-1)!] = structuredClone(value);
}

function setNodeField(node: GraphNode, field: string, value: JsonValue): void {
  const segments = field.split(".");
  if (segments.some((segment) => segment.length === 0)) {
    fail("compiler_field_path", `compiler-owned field path ${field} is invalid`);
  }
  let current = node as unknown as Record<string, JsonValue>;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (
      existing === undefined ||
      existing === null ||
      Array.isArray(existing) ||
      typeof existing !== "object"
    ) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, JsonValue>;
  }
  current[segments.at(-1)!] = structuredClone(value);
}

function parseAssignmentOutput(
  value: unknown,
  policy: DerivedWorkflowStep["graph_mutation"],
  changeControl: AssignmentChangeControlContract = {
    role: "ordinary",
    allowUpstreamRequest: false,
    requireChangeApplication: false,
  },
  stepKind: DerivedWorkflowStep["kind"] = "agent",
): AssignmentOutput {
  const root = requiredRecord(value, "assignment output");
  if (root.status === "failed") {
    assertAllowedFields(
      root,
      stepKind === "review"
        ? ["status", "reviewVerdict", "summary", "blocker"]
        : ["status", "summary", "blocker"],
      "failed assignment output",
    );
    if (stepKind === "review" && root.reviewVerdict !== "rejected") {
      fail("review_verdict", 'a failed review must declare reviewVerdict "rejected"');
    }
    return {
      status: "failed",
      ...(stepKind === "review" ? { reviewVerdict: "rejected" as const } : {}),
      ...(root.summary === undefined
        ? {}
        : { summary: boundedText(root.summary, "assignment summary", 1_024) }),
      blocker: boundedText(root.blocker, "assignment blocker", 64 * 1024),
    };
  }
  if (root.status !== "completed")
    fail("assignment_status", "assignment status must be completed or failed");
  const hasUpstreamRequest = root.upstreamChangeRequest !== undefined;
  const hasChangeApplication = root.changeApplication !== undefined;
  if (hasUpstreamRequest && hasChangeApplication) {
    fail(
      "change_control_output_collision",
      "one assignment cannot request upstream work and select an application",
    );
  }
  if (hasUpstreamRequest && !changeControl.allowUpstreamRequest) {
    fail(
      "change_control_route_forbidden",
      `change-control role ${changeControl.role} cannot issue upstream requests`,
    );
  }
  if (hasChangeApplication && !changeControl.requireChangeApplication) {
    fail(
      "change_control_application_step",
      "changeApplication is allowed only on the configured proposal step",
    );
  }
  if (changeControl.requireChangeApplication && !hasChangeApplication) {
    fail(
      "change_control_application_required",
      "configured proposal step requires changeApplication",
    );
  }
  const hasConcreteGraphDelta = root.graphDelta !== undefined && root.graphDelta !== null;
  if ((hasUpstreamRequest || hasChangeApplication) && hasConcreteGraphDelta) {
    fail(
      "change_control_graph_collision",
      "typed change-control output cannot also contain graphDelta",
    );
  }
  if (stepKind === "review") {
    const expectedVerdict = hasUpstreamRequest ? "changes_requested" : "approved";
    if (root.reviewVerdict !== expectedVerdict) {
      fail("review_verdict", `a completed review must declare reviewVerdict "${expectedVerdict}"`);
    }
  }
  const allowed = hasUpstreamRequest
    ? [
        "status",
        "summary",
        "upstreamChangeRequest",
        // Provider transports flatten the terminal union and can preserve the normal branch's
        // optional null sentinel. Null carries no graph mutation authority.
        "graphDelta",
        ...(stepKind === "review" ? ["reviewVerdict"] : []),
      ]
    : hasChangeApplication
      ? [
          "status",
          "summary",
          "changeApplication",
          "graphDelta",
          ...(stepKind === "review" ? ["reviewVerdict"] : []),
        ]
      : policy === "forbidden"
        ? ["status", "summary", ...(stepKind === "review" ? ["reviewVerdict"] : [])]
        : ["status", "summary", "graphDelta", ...(stepKind === "review" ? ["reviewVerdict"] : [])];
  assertAllowedFields(root, allowed, "completed assignment output");
  const summary = boundedText(root.summary, "assignment summary", 1_024).trim();
  const upstreamChangeRequest = hasUpstreamRequest
    ? parseUpstreamChangeRequest(root.upstreamChangeRequest)
    : undefined;
  const changeApplication = hasChangeApplication
    ? parseChangeApplication(root.changeApplication)
    : undefined;
  const graphDelta =
    hasUpstreamRequest || hasChangeApplication || root.graphDelta === undefined
      ? undefined
      : root.graphDelta === null
        ? null
        : parseGraphDelta(root.graphDelta);
  if (
    policy === "required" &&
    !hasUpstreamRequest &&
    !hasChangeApplication &&
    (graphDelta === undefined || graphDelta === null)
  ) {
    fail("graph_delta_required", "assignment requires a graph delta");
  }
  if (policy === "forbidden" && graphDelta !== undefined)
    fail("graph_delta_forbidden", "assignment forbids graph mutation");
  return {
    status: "completed",
    ...(stepKind === "review"
      ? hasUpstreamRequest
        ? { reviewVerdict: "changes_requested" as const }
        : { reviewVerdict: "approved" as const }
      : {}),
    summary,
    ...(graphDelta === undefined ? {} : { graphDelta }),
    ...(upstreamChangeRequest === undefined ? {} : { upstreamChangeRequest }),
    ...(changeApplication === undefined ? {} : { changeApplication }),
  };
}

function parseUpstreamChangeRequest(value: unknown): AssignmentUpstreamChangeRequest {
  const request = requiredRecord(value, "upstreamChangeRequest");
  assertAllowedFields(
    request,
    ["targetNodeIds", "fulfillment", "summary", "reason"],
    "upstreamChangeRequest",
  );
  const fulfillment =
    request.fulfillment === undefined
      ? // Compatibility for attempts launched before the structured routing discriminator existed:
        // preserve the explicit change-control path instead of silently narrowing their request.
        "dynamic_scope_change"
      : request.fulfillment;
  if (fulfillment !== "planned_asset_repair" && fulfillment !== "dynamic_scope_change") {
    fail(
      "change_control_fulfillment",
      "upstream change fulfillment must be planned_asset_repair or dynamic_scope_change",
    );
  }
  return {
    targetNodeIds: boundedUniqueIds(request.targetNodeIds, "upstream change target nodes"),
    fulfillment,
    summary: boundedText(request.summary, "upstream change summary", 1_024).trim(),
    reason: boundedText(request.reason, "upstream change reason", 4_096).trim(),
  };
}

function parseChangeApplication(value: unknown): AssignmentChangeApplication {
  const application = requiredRecord(value, "changeApplication");
  assertExactFields(application, ["operation", "targetNodeIds", "summary"], "changeApplication");
  return {
    operation: requiredNonempty(application.operation, "change application operation"),
    targetNodeIds: boundedUniqueIds(application.targetNodeIds, "change application target nodes"),
    summary: boundedText(application.summary, "change application summary", 1_024).trim(),
  };
}

function boundedUniqueIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_024) {
    fail("change_control_target_nodes", `${label} must contain between 1 and 1024 node ids`);
  }
  const ids = value.map((item) => requiredNonempty(item, label));
  if (ids.some((id) => id.length > 128) || new Set(ids).size !== ids.length) {
    fail("change_control_target_nodes", `${label} must be unique ids of at most 128 characters`);
  }
  return ids.sort(compareText);
}

function compileAssignmentChangeControl(input: {
  run: RunRecord;
  definition: DerivedTicketDefinition;
  step: DerivedWorkflowStep;
  binding: ExecutionPolicyBinding;
  catalog: CompiledExecutionSemanticCatalog;
  graph: TypedGraph;
  result: AssignmentOutput;
}): RuntimeAssignmentChangeControlCompilation | undefined {
  if (input.result.upstreamChangeRequest !== undefined) {
    const request = input.result.upstreamChangeRequest;
    const operation = input.catalog.operations[input.binding.operationId];
    if (
      operation?.changeControl.role !== "ordinary" ||
      !operation.changeControl.allowUpstreamRequests ||
      operation.changeControl.proposalOperation === undefined
    ) {
      fail(
        "change_control_route_forbidden",
        `operation ${input.binding.operationId} cannot issue upstream requests`,
      );
    }
    assertExistingControlTargets(
      input.graph,
      request.targetNodeIds,
      new Set(input.graph.nodes().map((node) => node.id)),
      "upstream request",
    );
    const sourceOutputMaterial = {
      status: "completed" as const,
      summary: input.result.summary!,
      upstreamChangeRequest: request,
    };
    const sourceOutputSha256 = canonicalHash(sourceOutputMaterial);
    const initial = deriveChangeControlPublication(input.catalog, {
      runId: input.run.id,
      sourceTicketId: input.definition.id,
      sourceStepId: input.step.id,
      sourceOutputSha256,
      sourceBinding: input.binding,
      targetNodeIds: request.targetNodeIds,
      summary: request.summary,
      reason: request.reason,
    });
    const existingTicket = input.run.tickets[initial.proposalTicketId];
    let existingProposal: ExistingChangeControlProposal | undefined;
    if (existingTicket !== undefined) {
      const control = existingTicket.executionControl;
      if (
        control?.proposalRequest === undefined ||
        control.changeControlScopeNodeIds === undefined
      ) {
        fail(
          "change_control_proposal_collision",
          `deterministic proposal ${initial.proposalTicketId} has no exact compiler request metadata`,
        );
      }
      existingProposal = {
        ticketId: existingTicket.id,
        requestSha256: control.proposalRequest.requestSha256,
        proposalOperationId: existingTicket.operationId,
        sourceTicketId: control.proposalRequest.sourceTicketId,
        sourceStepId: control.proposalRequest.sourceStepId,
        sourceOutputSha256: control.proposalRequest.sourceOutputSha256,
        controlScopeNodeIds: control.changeControlScopeNodeIds,
      };
    }
    const publication =
      existingProposal === undefined
        ? initial
        : deriveChangeControlPublication(input.catalog, {
            runId: input.run.id,
            sourceTicketId: input.definition.id,
            sourceStepId: input.step.id,
            sourceOutputSha256,
            sourceBinding: input.binding,
            targetNodeIds: request.targetNodeIds,
            summary: request.summary,
            reason: request.reason,
            existingProposal,
          });
    const material = {
      protocol: "koni.assignment-change-control.v1" as const,
      kind: "upstream_request" as const,
      sourceTicketId: input.definition.id,
      sourceStepId: input.step.id,
      sourceBindingSha256: input.binding.sha256,
      sourceOutputSha256,
      targetNodeIds: Object.freeze([...request.targetNodeIds]),
      fulfillment: request.fulfillment,
      summary: request.summary,
      reason: request.reason,
      publication,
    };
    return deepFreeze({ ...material, sha256: canonicalHash(material) });
  }
  if (input.result.changeApplication === undefined) return undefined;
  const selection = input.result.changeApplication;
  const proposalOperation = input.catalog.operations[input.binding.operationId];
  if (
    proposalOperation?.changeControl.role !== "proposal" ||
    proposalOperation.changeControl.proposalStep !== input.step.id
  ) {
    fail(
      "change_control_application_step",
      "changeApplication is not bound to the configured proposal step",
    );
  }
  const durableProposal = input.run.tickets[input.definition.id];
  const controlScope = durableProposal?.executionControl?.changeControlScopeNodeIds;
  if (
    durableProposal === undefined ||
    controlScope === undefined ||
    durableProposal.executionPolicyBinding === undefined ||
    canonicalHash(durableProposal.executionPolicyBinding) !==
      canonicalHash(
        resolveExecutionPolicyBinding(input.catalog, {
          configurationSha256: input.catalog.configurationSha256,
          operationId: proposalOperation.id,
          ...(proposalOperation.workflowId === undefined
            ? {}
            : { workflowId: proposalOperation.workflowId }),
        }),
      )
  ) {
    fail(
      "change_control_proposal_binding",
      "proposal ticket has no exact pinned control-scope authority",
    );
  }
  assertExistingControlTargets(
    input.graph,
    selection.targetNodeIds,
    new Set(controlScope),
    "change application",
  );
  const matches = Object.values(input.catalog.operations).filter(
    (candidate) => candidate.publicOperation === selection.operation,
  );
  const application = matches.length === 1 ? matches[0] : undefined;
  if (
    application === undefined ||
    (application.changeControl.role !== "application" &&
      application.changeControl.role !== "disposition") ||
    !proposalOperation.changeControl.applicationOperations.includes(application.publicOperation)
  ) {
    fail(
      "change_control_application_route",
      `proposal ${proposalOperation.id} does not permit application ${selection.operation}`,
    );
  }
  const applicationBinding = resolveExecutionPolicyBinding(input.catalog, {
    configurationSha256: input.catalog.configurationSha256,
    operationId: application.id,
    ...(application.workflowId === undefined ? {} : { workflowId: application.workflowId }),
  });
  const scope =
    application.changeControl.role === "disposition"
      ? { readNodeIds: [], writeNodeIds: [], readPaths: [], writePaths: [] }
      : {
          readNodeIds: [...selection.targetNodeIds],
          writeNodeIds: [...selection.targetNodeIds],
          readPaths: [],
          writePaths: [],
        };
  const proposalOutputMaterial = {
    status: "completed" as const,
    summary: input.result.summary!,
    changeApplication: selection,
  };
  const material = {
    protocol: "koni.assignment-change-control.v1" as const,
    kind: "proposal_application" as const,
    configurationSha256: input.catalog.configurationSha256,
    catalogSha256: input.catalog.sha256,
    proposalBindingSha256: durableProposal.executionPolicyBinding.sha256,
    applicationBinding,
    proposalOutputSha256: canonicalHash(proposalOutputMaterial),
    proposalTicketId: input.definition.id,
    proposalStepId: input.step.id,
    applicationPublicOperation: application.publicOperation,
    applicationOperationId: application.id,
    targetNodeIds: Object.freeze([...selection.targetNodeIds]),
    summary: selection.summary,
    scope: deepFreeze(scope),
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function assertExistingControlTargets(
  graph: TypedGraph,
  targetNodeIds: readonly string[],
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const nodeId of targetNodeIds) {
    if (graph.node(nodeId) === undefined)
      fail("change_control_target_missing", `${label} target ${nodeId} does not exist`);
    if (!allowed.has(nodeId))
      fail(
        "change_control_target_scope",
        `${label} target ${nodeId} is outside compiler control scope`,
      );
  }
}

function assertCurrentAssignmentChecks(
  run: RunRecord,
  assignment: ReadyAssignment,
  attemptId: string,
  step: DerivedWorkflowStep,
): void {
  if (step.validation_checks.length === 0) return;
  const attempt = run.attempts[attemptId];
  if (
    attempt === undefined ||
    attempt.ticketId !== assignment.ticketId ||
    attempt.stepId !== assignment.stepId ||
    attempt.personaId !== assignment.personaId
  ) {
    fail(
      "assignment_check_provenance",
      "configured checks are not bound to the current assignment attempt",
    );
  }
  // `accepted` is the acceptance notion that already honours the check's own contract:
  //   passed   = contractValid && exitAccepted && semanticPassing
  //   accepted = contractValid && exitAccepted && (semanticPassing || allowNonpassingReceipt)
  // For a check that does not set `allow_nonpassing_receipt` the two are identical, so requiring
  // acceptance here is exactly as strict as before. For one that does set it, the flag finally
  // means something. It previously did not: `gate-verifier` declares `allow_nonpassing_receipt:
  // true` precisely because a research gate may be `expected_red`, and every gate in an observed
  // run was, yet demanding `passed` here made a correctly-red gate unable to complete its
  // `run-gate` ticket at all — the ticket reissued indefinitely with no route to any other outcome.
  // Recording a red gate is the research result; treating it as satisfied is a separate question,
  // and the stricter `passed` requirements guarding receipt retention and replay are left intact.
  const missing = step.validation_checks.filter(
    (checkId) =>
      !(run.checks ?? []).some(
        (check) =>
          check.attemptId === attemptId &&
          check.requestedCheckId === checkId &&
          check.accepted === true,
      ),
  );
  if (missing.length > 0) {
    fail(
      "assignment_checks_incomplete",
      `assignment cannot complete without current accepted configured checks: ${missing.join(", ")}`,
    );
  }
}

function assertFailedAssignmentDoesNotReuseInheritedChecks(
  run: RunRecord,
  assignment: ReadyAssignment,
  attemptId: string,
  step: DerivedWorkflowStep,
): void {
  if (step.validation_checks.length === 0) return;
  const attempt = run.attempts[attemptId];
  if (
    attempt === undefined ||
    attempt.ticketId !== assignment.ticketId ||
    attempt.stepId !== assignment.stepId ||
    attempt.personaId !== assignment.personaId
  ) {
    fail(
      "assignment_check_provenance",
      "configured checks are not bound to the current assignment attempt",
    );
  }
  let parentAttemptId =
    attempt.lineage?.conversationFork === undefined ? undefined : attempt.lineage.parentAttemptId;
  const inheritedAttemptIds = new Set<string>();
  while (parentAttemptId !== undefined && !inheritedAttemptIds.has(parentAttemptId)) {
    inheritedAttemptIds.add(parentAttemptId);
    parentAttemptId = run.attempts[parentAttemptId]?.lineage?.parentAttemptId;
  }
  if (inheritedAttemptIds.size === 0) return;
  const required = new Set(step.validation_checks);
  const inherited = new Set(
    (run.checks ?? [])
      .filter(
        (check) => inheritedAttemptIds.has(check.attemptId) && required.has(check.requestedCheckId),
      )
      .map((check) => check.requestedCheckId),
  );
  if (inherited.size === 0) return;
  const current = new Set(
    (run.checks ?? [])
      .filter((check) => check.attemptId === attemptId && required.has(check.requestedCheckId))
      .map((check) => check.requestedCheckId),
  );
  const stale = [...inherited].filter((checkId) => !current.has(checkId)).sort(compareText);
  if (stale.length > 0) {
    fail(
      "assignment_check_provenance",
      `failed assignment cannot reuse configured checks from its parent attempt; rerun in the current attempt: ${stale.join(", ")}`,
    );
  }
}

function parseGraphDelta(value: unknown): GraphDelta {
  const root = requiredRecord(value, "graph delta");
  assertExactFields(
    root,
    ["protocol", "expectedGraphHash", "upsertNodes", "deleteNodes", "addEdges", "removeEdges"],
    "graph delta",
  );
  if (root.protocol !== "koni.graph-delta.v1")
    fail("graph_delta_protocol", "unsupported graph delta protocol");
  const expectedGraphHash = requireDigest(root.expectedGraphHash, "graph delta expectedGraphHash");
  if (
    !Array.isArray(root.upsertNodes) ||
    !Array.isArray(root.deleteNodes) ||
    !Array.isArray(root.addEdges) ||
    !Array.isArray(root.removeEdges)
  ) {
    fail("graph_delta_shape", "graph delta mutation collections must be arrays");
  }
  const upsertNodes = root.upsertNodes.map((item, index) => {
    const mutation = requiredRecord(item, `graph upsert ${index}`);
    assertExactFields(mutation, ["node", "expectedNodeHash"], `graph upsert ${index}`);
    return {
      node: parseGraphNode(mutation.node),
      expectedNodeHash:
        mutation.expectedNodeHash === null
          ? null
          : requireDigest(mutation.expectedNodeHash, "expected node hash"),
    };
  });
  const deleteNodes = root.deleteNodes.map((item, index) => {
    const deletion = requiredRecord(item, `graph deletion ${index}`);
    assertExactFields(deletion, ["id", "expectedNodeHash"], `graph deletion ${index}`);
    return {
      id: requiredNonempty(deletion.id, "graph deletion id"),
      expectedNodeHash: requireDigest(deletion.expectedNodeHash, "expected node hash"),
    };
  });
  return {
    protocol: "koni.graph-delta.v1",
    expectedGraphHash,
    upsertNodes,
    deleteNodes,
    addEdges: root.addEdges.map(parseGraphEdge),
    removeEdges: root.removeEdges.map(parseGraphEdge),
  };
}

function parseGraphNode(value: unknown): GraphNode {
  const node = requiredRecord(value, "graph node");
  assertExactFields(
    node,
    ["schema_version", "id", "type", "title", "status", "spec", "edges", "annotations"],
    "graph node",
  );
  if (node.schema_version !== "1.0")
    fail("graph_node_schema", "graph node schema_version must be 1.0");
  const edgesSource = requiredRecord(node.edges, "graph node edges");
  const edges: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [relation, targets] of Object.entries(edgesSource)) {
    if (!Array.isArray(targets) || targets.some((target) => typeof target !== "string"))
      fail("graph_node_edges", `graph relation ${relation} must contain string ids`);
    edges[relation] = [...new Set(targets as string[])].sort(compareText);
  }
  return {
    schema_version: "1.0",
    id: requiredNonempty(node.id, "graph node id"),
    type: requiredNonempty(node.type, "graph node type"),
    title: boundedText(node.title, "graph node title", 16_384),
    status: requiredNonempty(node.status, "graph node status"),
    spec: jsonRecord(node.spec, "graph node spec"),
    edges,
    annotations: jsonRecord(node.annotations, "graph node annotations"),
  };
}

/**
 * Attempt context includes the compiler-authored per-node CAS witness beside each graph node.
 * Authenticate and strip that witness before comparing reviewed semantic nodes. Submitted graph
 * deltas continue through parseGraphNode(), where nodeHash remains forbidden agent input.
 */
function parseContextGraphNode(value: unknown): GraphNode {
  const contextNode = requiredRecord(value, "context graph node");
  assertExactFields(
    contextNode,
    ["schema_version", "id", "type", "title", "status", "spec", "edges", "annotations", "nodeHash"],
    "context graph node",
  );
  const expectedNodeHash = requireDigest(contextNode.nodeHash, "context graph node hash");
  const semanticNode = structuredClone(contextNode);
  delete semanticNode.nodeHash;
  const node = parseGraphNode(semanticNode);
  if (canonicalHash(node) !== expectedNodeHash) {
    fail("graph_node_hash", `context graph node ${node.id} differs from its compiler CAS witness`);
  }
  return node;
}

function parseGraphEdge(value: unknown): { source: string; relation: string; target: string } {
  const edge = requiredRecord(value, "graph edge");
  assertExactFields(edge, ["source", "relation", "target"], "graph edge");
  return {
    source: requiredNonempty(edge.source, "graph edge source"),
    relation: requiredNonempty(edge.relation, "graph edge relation"),
    target: requiredNonempty(edge.target, "graph edge target"),
  };
}

type SemanticTicketStepRecord = TicketRecord["steps"][number] & {
  executionPolicyBinding?: ExecutionPolicyBinding;
};

type SemanticTicketRecord = Omit<TicketRecord, "steps"> & {
  executionPolicyBinding?: ExecutionPolicyBinding;
  steps: SemanticTicketStepRecord[];
};

const LEGACY_DELIVERY_NODE_SHA256 =
  "sha256:cbe87347eaa602ec31828745a8dd25417e1cad9cc3a86afc0ae9bf0d8003277d" as Sha256Digest;
const LEGACY_BROAD_DELIVERY_REVIEW_WORKFLOW_SHA256 =
  "sha256:a7cee4b6e610d2c736da09dad7dc2f3261fdd1804bc2a76c6d518df750a184f8" as Sha256Digest;

function resolveDefinitionExecutionBindings(
  catalog: CompiledExecutionSemanticCatalog,
  definition: DerivedTicketDefinition,
): { ticket: ExecutionPolicyBinding; steps: ReadonlyMap<string, ExecutionPolicyBinding> } {
  if (definition.configuration_sha256 !== catalog.configurationSha256) {
    fail(
      "execution_policy_configuration",
      `ticket ${definition.id} does not belong to the pinned execution-policy catalog`,
    );
  }
  const selector = {
    configurationSha256: catalog.configurationSha256,
    operationId: definition.operation_registry_id,
    ...(definition.workflow_id === undefined ? {} : { workflowId: definition.workflow_id }),
  };
  const ticket = resolveExecutionPolicyBinding(catalog, selector);
  const steps = new Map<string, ExecutionPolicyBinding>();
  for (const step of definition.workflow) {
    steps.set(step.id, resolveExecutionPolicyBinding(catalog, { ...selector, stepId: step.id }));
  }
  return { ticket, steps };
}

function assertOrBackfillExecutionPolicyBinding(
  target: { executionPolicyBinding?: ExecutionPolicyBinding },
  expected: ExecutionPolicyBinding,
  label: string,
): void {
  if (target.executionPolicyBinding === undefined) {
    // Explicit compatibility path for imported/pre-semantic records: the complete immutable
    // pinned configuration, never current project YAML, supplies the missing durable projection.
    target.executionPolicyBinding = structuredClone(expected);
    return;
  }
  if (canonicalHash(target.executionPolicyBinding) !== canonicalHash(expected)) {
    fail("execution_policy_drift", `${label} differs from its pinned execution-policy binding`);
  }
}

/**
 * Repair the one historical research-profile deadlock where a generated gate verifier
 * had a complete implementation plan but its own implementation ticket was withheld
 * until the verifier was already policy-selected. This is deliberately narrower than
 * normal ticket derivation: it preserves the pinned graph and uses only the pinned
 * implement-asset operation and workflow. Newer profiles derive this ticket normally.
 */
export function hasExistingAssetImplementationTicket(
  run: Pick<RunRecord, "tickets">,
  operationId: string,
  assetId: string,
): boolean {
  return Object.values(run.tickets).some(
    (ticket) =>
      ticket.status !== "cancelled" &&
      ticket.operationId === operationId &&
      ticket.targetNodeIds.includes(assetId),
  );
}

export async function assetImplementationFilesMaterialized(
  projectRoot: string,
  files: readonly string[],
): Promise<boolean> {
  const root = path.resolve(projectRoot);
  for (const file of files) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return false;
    }
    try {
      const metadata = await lstat(absolute);
      if (!metadata.isFile() || metadata.size === 0) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

async function recurringAssetReissueNodeIds(
  run: Pick<RunRecord, "tickets" | "checks" | "attempts" | "git">,
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  evaluation: CompiledRuleEvaluation,
  projectRoot: string,
): Promise<ReadonlySet<string>> {
  const plannedRepairTargets = new Set<string>();
  const routableProposalIds = routablePlannedAssetRepairProposalIds(run, evaluation.tickets);
  for (const proposalId of routableProposalIds) {
    for (const nodeId of run.tickets[proposalId]?.targetNodeIds ?? []) {
      plannedRepairTargets.add(nodeId);
    }
  }
  const blockedGateProviders = experimentBoundaryBlockedGateProviderNodeIds(graph, evaluation);
  const delegatedGateNodeIds = standaloneSupportRunGateNodeIds(graph, evaluation);
  const standaloneRunNodeIdsByAsset = standaloneSupportRunAssetNodeIds(graph, evaluation);
  const selectedGateIdsByProvider = new Map<string, Set<string>>();
  for (const context of evaluation.gate_policy_contexts) {
    if (context.winner_node_id === undefined) continue;
    const gateIds = selectedGateIdsByProvider.get(context.winner_node_id) ?? new Set<string>();
    gateIds.add(context.gate_node_id);
    selectedGateIdsByProvider.set(context.winner_node_id, gateIds);
  }
  const reissue = new Set<string>();
  for (const definition of evaluation.tickets) {
    if (definition.operation_registry_id !== "asset-resolution.asset.implement-asset") continue;
    for (const nodeId of definition.target_node_ids) {
      if (plannedRepairTargets.has(nodeId)) {
        reissue.add(nodeId);
        continue;
      }
      const node = graph.node(nodeId);
      const manifestDefinition =
        node === undefined
          ? undefined
          : optionalRecord(configuration.registries.node_types[node.type]?.filesystem_manifest);
      if (node === undefined || manifestDefinition === undefined) {
        reissue.add(nodeId);
        continue;
      }
      const outputField = optionalString(manifestDefinition.output_field);
      if (outputField === undefined) {
        reissue.add(nodeId);
        continue;
      }
      const extendedNode = node as unknown as ConfigurationObject & {
        fields?: ConfigurationObject;
      };
      const currentManifest = optionalRecord(
        extendedNode.fields?.[outputField] ?? extendedNode[outputField],
      );
      const acceptance = await prepareFilesystemManifestAcceptance(
        configuration,
        node,
        projectRoot,
      );
      const currentAcceptedContentHash = optionalString(currentManifest?.accepted_content_hash);
      const currentContentHash = optionalString(acceptance?.manifest.content_hash);
      const implementationCurrent =
        acceptance !== undefined &&
        acceptance.blockingErrors.length === 0 &&
        currentAcceptedContentHash !== undefined &&
        currentAcceptedContentHash === currentContentHash &&
        optionalString(currentManifest?.implementation_status) === "ready" &&
        optionalString(currentManifest?.vendor_status) === "vendored";
      const selectedGateIds = selectedGateIdsByProvider.get(nodeId) ?? new Set<string>();
      const standaloneRunNodeIds = standaloneRunNodeIdsByAsset.get(nodeId);
      const gateContracts = optionalRecord(node.spec.gate_contracts);
      const validates = new Set(node.edges.validates ?? []);
      const selectedGateContractsCurrent = [...selectedGateIds].every((gateId) => {
        const contract = optionalRecord(gateContracts?.[gateId]);
        return (
          optionalString(contract?.protocol) === "autoresearch.gate-result.v1" &&
          Array.isArray(contract?.argv) &&
          contract.argv.length > 0 &&
          contract.argv.every((value) => typeof value === "string" && value.length > 0) &&
          validates.has(gateId)
        );
      });
      if (
        recurringAssetRequiresReissue({
          implementationCurrent,
          selectedGateContractsCurrent,
          selectedGateBlocked:
            blockedGateProviders.has(nodeId) &&
            recurringAssetHasUnaddressedGateFailure({
              tickets: run.tickets,
              attempts: run.attempts,
              checks: run.checks,
              providerNodeId: nodeId,
              gateNodeIds: selectedGateIds,
              delegatedGateNodeIds,
            }),
          standaloneSupportRunFailed:
            standaloneRunNodeIds !== undefined &&
            recurringAssetHasUnaddressedStandaloneRunFailure({
              tickets: run.tickets,
              attempts: run.attempts,
              checks: run.checks,
              ticketCycles: run.git.ticketCycles,
              assetNodeId: nodeId,
              runNodeIds: standaloneRunNodeIds,
            }),
          reviewReworkPending: recurringAssetReviewReworkPending(run.tickets, nodeId),
        })
      ) {
        reissue.add(nodeId);
      }
    }
  }
  return reissue;
}

/**
 * Treat a completed provider repair as the causal response to every nonpassing gate receipt that
 * predates it. Reopening again for those same receipts creates an asset-review loop and starves
 * the gate ticket that must recheck or analyze the repaired provider. A newer nonpassing receipt
 * is fresh evidence and may reopen the provider once more.
 */
export function recurringAssetHasUnaddressedGateFailure(input: {
  readonly tickets: Readonly<Record<string, TicketRecord>>;
  readonly attempts?: Readonly<Record<string, AgentAttemptRecord>>;
  readonly checks: readonly RunCheckRecord[] | undefined;
  readonly providerNodeId: string;
  readonly gateNodeIds: ReadonlySet<string>;
  readonly delegatedGateNodeIds?: ReadonlySet<string>;
}): boolean {
  const providerRepairGateNodeIds = new Set(
    [...input.gateNodeIds].filter(
      (gateNodeId) => input.delegatedGateNodeIds?.has(gateNodeId) !== true,
    ),
  );
  if (providerRepairGateNodeIds.size === 0) return false;
  const latestFailureAt = input.checks
    ?.filter(
      (check) =>
        check.accepted &&
        check.passed === false &&
        check.executionPolicy?.gatePolicyContexts.some((context) =>
          providerRepairGateNodeIds.has(context.gateNodeId),
        ),
    )
    .map((check) => check.recordedAt)
    .sort(compareText)
    .at(-1);
  if (latestFailureAt === undefined) return true;
  const providerTickets = Object.values(input.tickets).filter(
    (ticket) =>
      ticket.operationId === "asset-resolution.asset.implement-asset" &&
      ticket.status !== "cancelled" &&
      ticket.targetNodeIds.includes(input.providerNodeId),
  );
  const latestCompletedRepairAt = providerTickets
    .filter(
      (ticket) =>
        ticket.steps.length > 0 && ticket.steps.every((step) => step.status === "completed"),
    )
    .flatMap((ticket) => [
      ticket.updatedAt,
      ...ticket.steps.flatMap((step) => (step.completedAt === undefined ? [] : [step.completedAt])),
    ])
    .concat(
      providerTickets.flatMap((ticket) =>
        completedRecurringAssetEpochTimes(ticket, input.attempts ?? {}),
      ),
    )
    .sort(compareText)
    .at(-1);
  return (
    latestCompletedRepairAt === undefined ||
    compareText(latestFailureAt, latestCompletedRepairAt) > 0
  );
}

/**
 * A rejected standalone support-run command is evidence that one of its exact executable assets
 * still needs repair. Compare only the newest runtime check with a fully completed asset workflow
 * epoch so an older rejection cannot reopen an asset after either a successful rerun or repair.
 */
export function recurringAssetHasUnaddressedStandaloneRunFailure(input: {
  readonly tickets: Readonly<Record<string, TicketRecord>>;
  readonly attempts: Readonly<Record<string, AgentAttemptRecord>>;
  readonly checks: readonly RunCheckRecord[] | undefined;
  readonly ticketCycles: RunRecord["git"]["ticketCycles"];
  readonly assetNodeId: string;
  readonly runNodeIds: ReadonlySet<string>;
}): boolean {
  const runTicketIds = new Set(
    Object.values(input.tickets)
      .filter(
        (ticket) =>
          ticket.operationId === "execution.run.run-experiment" &&
          ticket.targetNodeIds.some((nodeId) => input.runNodeIds.has(nodeId)),
      )
      .map((ticket) => ticket.id),
  );
  const latestRuntimeCheck = input.checks
    ?.filter((check) => {
      const attempt = input.attempts[check.attemptId];
      return (
        check.requestedCheckId === "scientific-runtime" &&
        attempt !== undefined &&
        runTicketIds.has(attempt.ticketId)
      );
    })
    .sort((left, right) => compareText(left.recordedAt, right.recordedAt))
    .at(-1);
  if (latestRuntimeCheck?.accepted !== false) return false;

  const latestRepairAt = Object.values(input.tickets)
    .filter(
      (ticket) =>
        ticket.operationId === "asset-resolution.asset.implement-asset" &&
        ticket.targetNodeIds.includes(input.assetNodeId),
    )
    .flatMap((ticket) =>
      completedMaterialRecurringAssetEpochTimes(ticket, input.attempts, input.ticketCycles),
    )
    .sort(compareText)
    .at(-1);
  return (
    latestRepairAt === undefined || compareText(latestRuntimeCheck.recordedAt, latestRepairAt) > 0
  );
}

interface CompletedRecurringAssetEpoch {
  readonly executionEpoch: number;
  readonly completedAt: string;
}

function completedRecurringAssetEpochTimes(
  ticket: TicketRecord,
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
): readonly string[] {
  return completedRecurringAssetEpochs(ticket, attempts).map((epoch) => epoch.completedAt);
}

function completedMaterialRecurringAssetEpochTimes(
  ticket: TicketRecord,
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
  ticketCycles: RunRecord["git"]["ticketCycles"],
): readonly string[] {
  const materialCycleOrdinals = new Set(
    Object.values(ticketCycles)
      .filter(
        (cycle) =>
          cycle.ticketId === ticket.id &&
          (cycle.status === "integrated" || cycle.status === "retired") &&
          cycle.ticketHeadOid !== cycle.baseRunOid,
      )
      .map((cycle) => cycle.ordinal),
  );
  return completedRecurringAssetEpochs(ticket, attempts)
    .filter((epoch) => materialCycleOrdinals.has(epoch.executionEpoch + 1))
    .map((epoch) => epoch.completedAt);
}

function completedRecurringAssetEpochs(
  ticket: TicketRecord,
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
): readonly CompletedRecurringAssetEpoch[] {
  if (ticket.steps.length === 0) return [];
  const completedByStep = ticket.steps.map((step) =>
    (step.attemptIds ?? [])
      .map((attemptId) => attempts[attemptId])
      .filter(
        (attempt): attempt is AgentAttemptRecord & { ticketExecutionEpoch: number } =>
          attempt !== undefined &&
          attempt.ticketId === ticket.id &&
          attempt.stepId === step.id &&
          attempt.status === "completed" &&
          typeof attempt.ticketExecutionEpoch === "number" &&
          attempt.terminalSummary !== undefined &&
          attempt.terminalSummary.trim().length > 0 &&
          (attempt.endedAt !== undefined || attempt.terminalAcceptedAt !== undefined),
      ),
  );
  if (completedByStep.some((candidates) => candidates.length === 0)) return [];
  const commonEpochs = completedByStep
    .slice(1)
    .reduce(
      (common, candidates) =>
        new Set(
          [...common].filter((epoch) =>
            candidates.some((candidate) => candidate.ticketExecutionEpoch === epoch),
          ),
        ),
      new Set(completedByStep[0]!.map((attempt) => attempt.ticketExecutionEpoch)),
    );
  return [...commonEpochs].flatMap((executionEpoch) => {
    const completedAt = completedByStep
      .flatMap((candidates) =>
        candidates
          .filter((attempt) => attempt.ticketExecutionEpoch === executionEpoch)
          .flatMap((attempt) => [attempt.endedAt ?? attempt.terminalAcceptedAt!]),
      )
      .sort(compareText)
      .at(-1);
    return completedAt === undefined ? [] : [{ executionEpoch, completedAt }];
  });
}

/**
 * A standalone support-run ticket is the compiler's explicit remediation path for the gates that
 * run evaluates. While that work is applicable, a nonpassing receipt for the same gate is not
 * evidence that the selected verifier provider needs another implementation cycle.
 */
export function standaloneSupportRunGateNodeIds(
  graph: Pick<ResearchRunContractScopeGraph, "node" | "edges">,
  evaluation: Pick<CompiledRuleEvaluation, "tickets">,
): ReadonlySet<string> {
  const gateNodeIds = new Set<string>();
  const edges = graph.edges();
  for (const definition of evaluation.tickets) {
    if (definition.rule_id !== "compiler.compatibility.research-standalone-support-run") continue;
    for (const nodeId of definition.target_node_ids) {
      const node = graph.node(nodeId);
      if (node?.type !== "run") continue;
      for (const edge of edges) {
        if (edge.source === nodeId && edge.relation === "evaluates") gateNodeIds.add(edge.target);
      }
    }
  }
  return gateNodeIds;
}

/**
 * Bind standalone support runs to only the generated assets whose entrypoints the runtime contract
 * executes. A generic `uses` edge is intentionally insufficient: it can also name read-only data,
 * verifier, and auxiliary assets that did not cause the command failure.
 */
export function standaloneSupportRunAssetNodeIds(
  graph: Pick<ResearchRunContractScopeGraph, "node">,
  evaluation: Pick<CompiledRuleEvaluation, "tickets">,
): ReadonlyMap<string, ReadonlySet<string>> {
  const runNodeIdsByAsset = new Map<string, Set<string>>();
  for (const definition of evaluation.tickets) {
    if (definition.rule_id !== "compiler.compatibility.research-standalone-support-run") continue;
    for (const runNodeId of definition.target_node_ids) {
      const runNode = graph.node(runNodeId);
      if (runNode?.type !== "run") continue;
      const runtimeContract = optionalRecord(runNode.spec.runtime_contract);
      const entrypoints = Array.isArray(runtimeContract?.asset_entrypoints)
        ? runtimeContract.asset_entrypoints
        : [];
      for (const rawEntrypoint of entrypoints) {
        const assetNodeId = optionalString(optionalRecord(rawEntrypoint)?.asset_id);
        const assetNode = assetNodeId === undefined ? undefined : graph.node(assetNodeId);
        if (
          assetNodeId === undefined ||
          assetNode?.type !== "asset" ||
          assetNode.spec.source_strategy !== "generated"
        ) {
          continue;
        }
        const runNodeIds = runNodeIdsByAsset.get(assetNodeId) ?? new Set<string>();
        runNodeIds.add(runNodeId);
        runNodeIdsByAsset.set(assetNodeId, runNodeIds);
      }
    }
  }
  return new Map(
    [...runNodeIdsByAsset.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([assetNodeId, runNodeIds]) => [
        assetNodeId,
        new Set([...runNodeIds].sort(compareText)),
      ]),
  );
}

/**
 * Give an existing generated-asset implementation workflow read-only context for the standalone
 * run that executed it. A new deterministic ticket identity prevents an already-issued narrower
 * grant from drifting while the asset's original write authority remains byte-for-byte unchanged.
 */
export function standaloneSupportRunAssetRepairScopeFallback(
  graph: ResearchRunContractScopeGraph,
  evaluation: CompiledRuleEvaluation,
): CompiledRuleEvaluation {
  const runNodeIdsByAsset = standaloneSupportRunAssetNodeIds(graph, evaluation);
  if (runNodeIdsByAsset.size === 0) return evaluation;

  const edges = graph.edges();
  const existingIds = new Set(evaluation.tickets.map((definition) => definition.id));
  const supersededIds = new Set<string>();
  const additions: DerivedTicketDefinition[] = [];
  for (const definition of evaluation.tickets) {
    if (definition.operation_registry_id !== "asset-resolution.asset.implement-asset") continue;
    const runNodeIds = [
      ...new Set(
        definition.target_node_ids.flatMap((assetNodeId) => [
          ...(runNodeIdsByAsset.get(assetNodeId) ?? []),
        ]),
      ),
    ].sort(compareText);
    if (runNodeIds.length === 0) continue;

    const readNodeIds = new Set(definition.scope.read_node_ids);
    const readPaths = new Set(definition.scope.read_paths);
    for (const runNodeId of runNodeIds) {
      readNodeIds.add(runNodeId);
      for (const edge of edges) {
        if (edge.source === runNodeId && edge.relation === "evaluates") {
          readNodeIds.add(edge.target);
        }
      }
      const runtimeContract = optionalRecord(graph.node(runNodeId)?.spec.runtime_contract);
      const outputRoot = optionalString(runtimeContract?.output_root);
      if (outputRoot !== undefined) readPaths.add(outputRoot);
    }
    const sortedReadNodeIds = [...readNodeIds].sort(compareText);
    const sortedReadPaths = [...readPaths].sort(compareText);
    if (
      canonicalHash(sortedReadNodeIds) === canonicalHash(definition.scope.read_node_ids) &&
      canonicalHash(sortedReadPaths) === canonicalHash(definition.scope.read_paths)
    ) {
      continue;
    }

    const { definition_sha256: _definitionSha256, ...existing } = definition;
    const id = `TK-compat-standalone-run-asset-repair-scope-${digestBody(
      canonicalHash({
        configuration_sha256: evaluation.configuration_sha256,
        source_definition_id: definition.id,
        target_node_ids: definition.target_node_ids,
        support_run_node_ids: runNodeIds,
        read_node_ids: sortedReadNodeIds,
        read_paths: sortedReadPaths,
      }),
    ).slice(0, 24)}`;
    supersededIds.add(definition.id);
    if (existingIds.has(id)) continue;
    const material = {
      ...existing,
      id,
      rule_id: "compiler.compatibility.standalone-support-run-asset-repair-scope",
      scope: {
        ...definition.scope,
        read_node_ids: sortedReadNodeIds,
        read_paths: sortedReadPaths,
      },
    };
    additions.push(deepFreeze({ ...material, definition_sha256: canonicalHash(material) }));
    existingIds.add(id);
  }
  return supersededIds.size === 0
    ? evaluation
    : rehashRuleEvaluation(evaluation, [
        ...evaluation.tickets.filter((definition) => !supersededIds.has(definition.id)),
        ...additions,
      ]);
}

/**
 * An upstream request that targets only assets already owned by configured implement-asset
 * tickets is repair work inside the approved plan, not a new dynamic scope decision. Route only
 * pristine, unapproved proposals whose exact source is still held; any operator decision or
 * started proposal remains on the explicit change-control path.
 */
export function routablePlannedAssetRepairProposalIds(
  run: Pick<RunRecord, "tickets">,
  definitions: readonly Pick<
    DerivedTicketDefinition,
    "operation_registry_id" | "target_node_ids"
  >[],
): ReadonlySet<string> {
  const implementedAssetIds = new Set(
    definitions
      .filter(
        (definition) =>
          definition.operation_registry_id === "asset-resolution.asset.implement-asset",
      )
      .flatMap((definition) => definition.target_node_ids),
  );
  const proposalIds = new Set<string>();
  for (const proposal of Object.values(run.tickets)) {
    if (!pristineHeldProposal(run, proposal)) continue;
    if (proposal.executionControl?.proposalRequest?.fulfillment !== "planned_asset_repair")
      continue;
    const sourceOwnedAssetIds = sourceOwnedPlannedAssetRepairNodeIds(run, proposal);
    const repairAssetIds = new Set([
      ...proposal.targetNodeIds.filter((nodeId) => implementedAssetIds.has(nodeId)),
      ...sourceOwnedAssetIds,
    ]);
    if (
      repairAssetIds.size === 0 ||
      [...repairAssetIds].some((nodeId) => !implementedAssetIds.has(nodeId))
    )
      continue;
    proposalIds.add(proposal.id);
  }
  return proposalIds;
}

export function plannedAssetRepairProposalTargetNodeIds(
  run: Pick<RunRecord, "tickets">,
): ReadonlySet<string> {
  const targetNodeIds = new Set<string>();
  for (const proposal of Object.values(run.tickets)) {
    if (!pristineHeldProposal(run, proposal)) continue;
    if (proposal.executionControl?.proposalRequest?.fulfillment !== "planned_asset_repair")
      continue;
    for (const nodeId of proposal.targetNodeIds) targetNodeIds.add(nodeId);
  }
  return targetNodeIds;
}

export function plannedAssetRepairRequestForNode(
  run: Pick<RunRecord, "tickets">,
  nodeId: string,
):
  | Readonly<{
      proposalTicketId: string;
      requestSha256: Sha256Digest;
      title: string;
    }>
  | undefined {
  const candidates = Object.values(run.tickets)
    .filter((proposal) => {
      const control = proposal.executionControl;
      const request = control?.proposalRequest;
      if (
        control === undefined ||
        request === undefined ||
        request.fulfillment !== "planned_asset_repair" ||
        (!proposal.targetNodeIds.includes(nodeId) &&
          !sourceOwnedPlannedAssetRepairNodeIds(run, proposal).includes(nodeId)) ||
        control.proposalApprovalSha256 !== undefined ||
        control.proposalDecision !== undefined ||
        (control.proposalDecisionHistory?.length ?? 0) > 0
      ) {
        return false;
      }
      if (pristineHeldProposal(run, proposal)) return true;
      return (
        proposal.status === "cancelled" &&
        proposal.blocker === COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR &&
        proposal.steps.every((step) => step.status === "skipped" && step.attemptIds.length === 0)
      );
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const proposal = candidates[0];
  const request = proposal?.executionControl?.proposalRequest;
  return proposal === undefined || request === undefined
    ? undefined
    : {
        proposalTicketId: proposal.id,
        requestSha256: request.requestSha256,
        title: proposal.title,
      };
}

export interface PlannedAssetRepairHistoryEntry {
  readonly proposalTicketId: string;
  readonly requestSha256: Sha256Digest;
  readonly sourceTicketId: string;
  readonly sourceStepId: string;
  readonly sourceOutputSha256: Sha256Digest;
  readonly targetNodeIds: readonly string[];
  readonly summary: string;
  readonly reason: string;
  readonly routedAt: string;
}

/**
 * Project immutable review findings that the compiler already routed back through an asset's
 * planned implementation workflow. The history is cumulative: a later request can add a repair
 * obligation, but cannot silently erase an earlier accepted finding. Only exact compiler-routed
 * proposal authority is admitted, and a gate-targeted request reaches only an asset that declares
 * that gate in its canonical validates relation.
 */
export function plannedAssetRepairHistoryForAttempt(
  run: Pick<RunRecord, "id" | "tickets">,
  subjectNodes: readonly Pick<GraphNode, "id" | "type" | "edges">[],
): PlannedAssetRepairHistoryEntry[] {
  const subjects = new Map(subjectNodes.map((node) => [node.id, node]));
  const history: PlannedAssetRepairHistoryEntry[] = [];
  for (const proposal of Object.values(run.tickets)) {
    const control = proposal.executionControl;
    const request = control?.proposalRequest;
    const authority = control?.controlTicketAuthority;
    if (
      proposal.status !== "cancelled" ||
      proposal.blocker !== COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR ||
      request?.fulfillment !== "planned_asset_repair" ||
      authority?.runId !== run.id ||
      authority.role !== "proposal" ||
      authority.ticketId !== proposal.id ||
      authority.causal.role !== "proposal"
    ) {
      continue;
    }
    const { publication, sourceTicketProjection, sourceTerminalProof } = authority.causal;
    if (
      publication.proposalTicketId !== proposal.id ||
      publication.requestSha256 !== request.requestSha256 ||
      publication.sourceTicketId !== request.sourceTicketId ||
      publication.sourceStepId !== request.sourceStepId ||
      publication.sourceOutputSha256 !== request.sourceOutputSha256 ||
      sourceTicketProjection.id !== request.sourceTicketId ||
      sourceTerminalProof.runId !== run.id ||
      sourceTerminalProof.ticketId !== request.sourceTicketId ||
      sourceTerminalProof.stepId !== request.sourceStepId
    ) {
      continue;
    }
    const targetNodeIds = new Set(publication.targetNodeIds);
    if (sourceTicketProjection.operationId === "asset-resolution.asset.implement-asset") {
      for (const nodeId of sourceTicketProjection.targetNodeIds) targetNodeIds.add(nodeId);
    }
    const affectsSubject = [...subjects.values()].some(
      (subject) =>
        targetNodeIds.has(subject.id) ||
        (subject.type === "asset" &&
          (subject.edges.validates ?? []).some((gateId) => targetNodeIds.has(gateId))),
    );
    if (!affectsSubject) continue;
    history.push({
      proposalTicketId: proposal.id,
      requestSha256: request.requestSha256,
      sourceTicketId: request.sourceTicketId,
      sourceStepId: request.sourceStepId,
      sourceOutputSha256: request.sourceOutputSha256,
      targetNodeIds: [...targetNodeIds].sort(compareText),
      summary: publication.summary,
      reason: publication.reason,
      routedAt: proposal.updatedAt,
    });
  }
  return history.sort(
    (left, right) =>
      left.routedAt.localeCompare(right.routedAt) ||
      left.proposalTicketId.localeCompare(right.proposalTicketId),
  );
}

/**
 * A repair request can name the gates that exposed the defect while its exact held source already
 * owns the selected verifier asset. Preserve that bounded source authority instead of requiring
 * the agent to redundantly repeat the asset id in its proposal. Every requested node must still be
 * inside the immutable source ticket's node grant; otherwise this remains a real scope proposal.
 */
function sourceOwnedPlannedAssetRepairNodeIds(
  run: Pick<RunRecord, "tickets">,
  proposal: Readonly<TicketRecord>,
): string[] {
  const request = proposal.executionControl?.proposalRequest;
  const source = request === undefined ? undefined : run.tickets[request.sourceTicketId];
  if (
    source?.operationId !== "asset-resolution.asset.implement-asset" ||
    source.executionControl?.sourceHold?.proposalTicketId !== proposal.id ||
    source.executionControl.sourceHold.requestSha256 !== request?.requestSha256
  )
    return [];
  const sourceAuthorityNodeIds = new Set([
    ...source.targetNodeIds,
    ...(source.readNodeIds ?? []),
    ...(source.writeNodeIds ?? []),
  ]);
  if (proposal.targetNodeIds.some((nodeId) => !sourceAuthorityNodeIds.has(nodeId))) return [];
  return [...new Set(source.targetNodeIds)].sort(compareText);
}

function pristineHeldProposal(
  run: Pick<RunRecord, "tickets">,
  proposal: Readonly<TicketRecord>,
): boolean {
  const control = proposal.executionControl;
  const request = control?.proposalRequest;
  const source = request === undefined ? undefined : run.tickets[request.sourceTicketId];
  const hold = source?.executionControl?.sourceHold;
  return (
    proposal.status === "proposed" &&
    control !== undefined &&
    request !== undefined &&
    control.proposalApprovalSha256 === undefined &&
    control.proposalDecision === undefined &&
    (control.proposalDecisionHistory?.length ?? 0) === 0 &&
    proposal.targetNodeIds.length > 0 &&
    proposal.steps.every((step) => step.status === "pending" && step.attemptIds.length === 0) &&
    hold?.proposalTicketId === proposal.id &&
    hold.requestSha256 === request.requestSha256
  );
}

export function routePlannedAssetRepairProposals(
  tickets: Record<string, TicketRecord>,
  proposalIds: ReadonlySet<string>,
  at: string,
): void {
  for (const proposalId of proposalIds) {
    const ticket = tickets[proposalId];
    if (ticket === undefined) continue;
    ticket.status = "cancelled";
    ticket.blocker = COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR;
    ticket.updatedAt = at;
    for (const step of ticket.steps) step.status = "skipped";
  }
}

/**
 * A pristine proposal that asks only to rerun a gate is obsolete once the compiler has projected
 * the exact current-manifest recheck. Cancel only that untouched proposal and leave its source
 * hold intact: the authority can then archive the exact held Git cycle, release the source, and
 * retire the now-inapplicable historical ticket without erasing any accepted attempts.
 */
export function routeSupersededGateRunProposals(
  tickets: Record<string, TicketRecord>,
  definitions: readonly DerivedTicketDefinition[],
  at: string,
): string[] {
  const applicableIds = new Set(definitions.map((definition) => definition.id));
  const recheckedGateIds = new Set(
    definitions
      .filter(
        (definition) =>
          definition.rule_id === "compiler.compatibility.repaired-provider-gate-recheck" &&
          definition.operation_registry_id === "gates.gate.run-gate",
      )
      .flatMap((definition) => definition.target_node_ids),
  );
  const routed: string[] = [];
  for (const source of Object.values(tickets).sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    const hold = source.executionControl?.sourceHold;
    if (
      hold === undefined ||
      source.operationId !== "gates.gate.run-gate" ||
      source.status !== "blocked" ||
      applicableIds.has(source.id) ||
      !source.targetNodeIds.some((nodeId) => recheckedGateIds.has(nodeId))
    )
      continue;
    const proposal = tickets[hold.proposalTicketId];
    const request = proposal?.executionControl?.proposalRequest;
    if (
      proposal === undefined ||
      request?.fulfillment !== "dynamic_scope_change" ||
      request.sourceTicketId !== source.id ||
      request.requestSha256 !== hold.requestSha256 ||
      !pristineHeldProposal({ tickets }, proposal)
    )
      continue;
    proposal.status = "cancelled";
    proposal.blocker = COMPILER_ROUTED_TO_MANIFEST_GATE_RECHECK;
    proposal.updatedAt = at;
    for (const step of proposal.steps) step.status = "skipped";
    routed.push(proposal.id);
  }
  return routed;
}

/**
 * A blocked gate without a current terminal receipt needs a fresh check, while a current accepted
 * nonpassing receipt is concrete repair evidence for the selected provider. Reopen the asset only
 * in the latter state so its higher priority cannot starve the first gate execution.
 */
export function recurringAssetRequiresReissue(input: {
  readonly implementationCurrent: boolean;
  readonly selectedGateContractsCurrent: boolean;
  readonly selectedGateBlocked: boolean;
  readonly standaloneSupportRunFailed?: boolean;
  readonly reviewReworkPending?: boolean;
}): boolean {
  return (
    !input.implementationCurrent ||
    !input.selectedGateContractsCurrent ||
    input.selectedGateBlocked ||
    input.standaloneSupportRunFailed === true ||
    input.reviewReworkPending === true
  );
}

export function recurringAssetReviewReworkPending(
  tickets: Readonly<Record<string, TicketRecord>>,
  nodeId: string,
): boolean {
  return Object.values(tickets).some(
    (ticket) =>
      ticket.operationId === "asset-resolution.asset.implement-asset" &&
      ticket.targetNodeIds.includes(nodeId) &&
      ticket.status !== "completed" &&
      ticket.status !== "cancelled" &&
      (ticket.reviewReworks?.length ?? 0) > 0 &&
      ticket.steps.some((step) => step.status === "pending" || step.status === "running"),
  );
}

/**
 * A current file manifest proves byte integrity, not that the implementation satisfies the gate it
 * was selected to verify. When a direct experiment/prerequisite gate has a current accepted
 * nonpassing receipt, its selected provider remains actionable even if every declared file is
 * present and hash-current. Broader hypothesis/root gates are deliberately excluded: treating a
 * terminal report-review gate as an implementation prerequisite creates a circular dependency.
 */
export function experimentBoundaryBlockedGateProviderNodeIds(
  graph: { node(id: string): { readonly type: string } | undefined },
  evaluation: Pick<CompiledRuleEvaluation, "facts" | "gate_policy_contexts">,
): ReadonlySet<string> {
  const selfBlockedGateIds = new Set<string>();
  const currentTerminalGateIds = new Set<string>();
  for (const fact of evaluation.facts) {
    if (fact.kind !== "readiness" || fact.value !== "blocked") continue;
    const blocking = fact.args.blocking_gate_ids;
    if (Array.isArray(blocking) && blocking.some((gateId) => gateId === fact.anchor_node_id)) {
      selfBlockedGateIds.add(fact.anchor_node_id);
    }
    const terminal = fact.args.current_terminal_gate_ids;
    if (Array.isArray(terminal) && terminal.some((gateId) => gateId === fact.anchor_node_id)) {
      currentTerminalGateIds.add(fact.anchor_node_id);
    }
  }
  const providers = new Set<string>();
  for (const context of evaluation.gate_policy_contexts) {
    if (
      context.winner_node_id !== undefined &&
      selfBlockedGateIds.has(context.gate_node_id) &&
      currentTerminalGateIds.has(context.gate_node_id) &&
      context.evaluation_target_node_ids.some((nodeId) => {
        const type = graph.node(nodeId)?.type;
        return type === "experiment" || type === "prerequisite";
      })
    ) {
      providers.add(context.winner_node_id);
    }
  }
  return providers;
}

export interface CurrentNonpassingGateRepairEvidenceRequest {
  readonly gateNodeId: string;
  readonly providerNodeId: string;
  readonly receiptIds: readonly string[];
  readonly check: RunCheckRecord;
  readonly artifact: ConfigurationObject;
}

interface CurrentNonpassingGateRepairEvidence {
  readonly protocol: "koni.current-gate-repair-evidence.v1";
  readonly gateNodeId: string;
  readonly providerNodeId: string;
  readonly evidenceId: string;
  readonly evidenceSha256: Sha256Digest;
  readonly checkId: string;
  readonly recordedAt: string;
  readonly summary: string;
  readonly commands: readonly {
    readonly argv: readonly string[];
    readonly exitCode: number | null;
    readonly result: JsonValue;
  }[];
}

/**
 * A nonpassing receipt is an active obligation until this execution epoch has produced its repair.
 * After a successful production step, later verification/integration/review stages evaluate the
 * candidate that step created. Relabeling the predecessor receipt as still active makes a bounded
 * verifier request an upstream scope change for a defect that its own candidate may already fix.
 * Read-only terminal resolvers have no production step, so their full diagnose/resolve chain keeps
 * the causal evidence it needs to route the repair.
 */
export function shouldAttachCurrentGateRepairEvidence(
  run: Pick<RunRecord, "tickets" | "attempts">,
  definition: Pick<DerivedTicketDefinition, "id" | "operation_registry_id" | "workflow">,
  step: DerivedTicketDefinition["workflow"][number],
): boolean {
  // A run-gate ticket is itself the current deterministic recheck. Giving its first step the
  // predecessor's nonpassing receipt lets the operator route another repair without executing the
  // now-current command, creating a repair/recheck loop even when the integrated verifier passes.
  if (definition.operation_registry_id === "gates.gate.run-gate") return false;
  const stepIndex = definition.workflow.findIndex((candidate) => candidate.id === step.id);
  if (stepIndex <= 0) return true;
  const ticket = run.tickets[definition.id];
  if (ticket === undefined) return true;
  const executionEpoch = ticket.executionEpoch ?? 0;
  const priorProductionStepIds = new Set(
    definition.workflow
      .slice(0, stepIndex)
      .filter((candidate) => candidate.kind === "production")
      .map((candidate) => candidate.id),
  );
  if (priorProductionStepIds.size === 0) return true;
  return !ticket.steps.some(
    (candidate) =>
      priorProductionStepIds.has(candidate.id) &&
      candidate.status === "completed" &&
      candidate.attemptIds.some((attemptId) => {
        const attempt = run.attempts[attemptId];
        return (
          attempt?.status === "completed" && (attempt.ticketExecutionEpoch ?? 0) === executionEpoch
        );
      }),
  );
}

/**
 * Carry a gate's authenticated failing receipt through an approved source-owned repair.
 *
 * The verifier is the gate policy winner, but an approved application can deliberately route the
 * repair to a different asset that owns the missing causal artifact. The application ticket is the
 * compiler-authenticated bridge: when it targets the current ticket's source asset, the source
 * proposal's gate targets remain causal read evidence even though they are not writable here.
 */
export function gateRepairEvidenceTargetNodeIds(
  run: Pick<RunRecord, "tickets">,
  graph: { node(id: string): { readonly type: string } | undefined },
  targetNodeIds: readonly string[],
): readonly string[] {
  const targets = new Set(targetNodeIds);
  for (const ticket of Object.values(run.tickets)) {
    const control = ticket.executionControl;
    if (
      control?.sourceProposalTicketId === undefined ||
      control.approvedApplicationSha256 === undefined ||
      !ticket.targetNodeIds.some((nodeId) => targets.has(nodeId))
    ) {
      continue;
    }
    const proposal = run.tickets[control.sourceProposalTicketId];
    if (proposal === undefined) continue;
    for (const nodeId of proposal.targetNodeIds) {
      if (graph.node(nodeId)?.type === "gate") targets.add(nodeId);
    }
  }
  return [...targets].sort(compareText);
}

/**
 * Bind a recurring verifier asset to the exact current nonpassing gate receipt that reopened it.
 * The durable rule-evidence envelope supplies freshness authority; a historical check with the
 * same gate id is never enough. The evidence artifact itself is authenticated and decoded later
 * at the compiler I/O boundary before any diagnostic is exposed to an attempt.
 */
export async function currentNonpassingGateRepairEvidenceRequests(input: {
  readonly graph: { node(id: string): { readonly type: string } | undefined };
  readonly evaluation: Pick<CompiledRuleEvaluation, "facts" | "gate_policy_contexts">;
  readonly evidence: RuleAuthorityEvidence | undefined;
  readonly checks: readonly RunCheckRecord[] | undefined;
  readonly targetNodeIds: readonly string[];
  readonly readEvidence: (check: RunCheckRecord) => Promise<unknown>;
}): Promise<CurrentNonpassingGateRepairEvidenceRequest[]> {
  if (input.evidence === undefined || input.checks === undefined) return [];
  const targets = new Set(input.targetNodeIds);
  const selfBlockedGateIds = new Set<string>();
  const currentTerminalGateIds = new Set<string>();
  for (const fact of input.evaluation.facts) {
    if (fact.kind !== "readiness" || fact.value !== "blocked") continue;
    const blocking = fact.args.blocking_gate_ids;
    if (Array.isArray(blocking) && blocking.some((gateId) => gateId === fact.anchor_node_id)) {
      selfBlockedGateIds.add(fact.anchor_node_id);
    }
    const terminal = fact.args.current_terminal_gate_ids;
    if (Array.isArray(terminal) && terminal.some((gateId) => gateId === fact.anchor_node_id)) {
      currentTerminalGateIds.add(fact.anchor_node_id);
    }
  }
  const requests: CurrentNonpassingGateRepairEvidenceRequest[] = [];
  for (const context of input.evaluation.gate_policy_contexts) {
    if (
      context.winner_node_id === undefined ||
      (!targets.has(context.winner_node_id) && !targets.has(context.gate_node_id)) ||
      !selfBlockedGateIds.has(context.gate_node_id) ||
      !currentTerminalGateIds.has(context.gate_node_id) ||
      !context.evaluation_target_node_ids.some((nodeId) => {
        const type = input.graph.node(nodeId)?.type;
        return type === "experiment" || type === "prerequisite";
      })
    ) {
      continue;
    }
    const currentPredicates = Object.values(input.evidence.predicates).filter(
      (predicate) =>
        predicate.result === true &&
        predicate.subjectNodeId === context.gate_node_id &&
        predicate.leaf?.op === "current_receipt" &&
        predicate.leaf.receipt_type === "gate.receipt",
    );
    const receiptIds = [
      ...new Set(currentPredicates.flatMap((predicate) => predicate.sourceReceiptIds)),
    ].sort(compareText);
    if (receiptIds.length === 0) continue;
    const candidates = [...input.checks]
      .reverse()
      .filter(
        (candidate) =>
          candidate.accepted &&
          candidate.passed === false &&
          candidate.executionPolicy?.gatePolicyContexts.some(
            (binding) => binding.gateNodeId === context.gate_node_id,
          ),
      );
    let selected: { check: RunCheckRecord; artifact: ConfigurationObject } | undefined;
    for (const check of candidates) {
      const artifact = await input.readEvidence(check);
      if (!isRecord(artifact) || typeof artifact.id !== "string") continue;
      if (!receiptIds.includes(artifact.id)) continue;
      selected = { check, artifact: artifact as ConfigurationObject };
      break;
    }
    if (selected === undefined) continue;
    requests.push({
      gateNodeId: context.gate_node_id,
      providerNodeId: context.winner_node_id,
      receiptIds,
      ...selected,
    });
  }
  return requests.sort((left, right) => compareText(left.gateNodeId, right.gateNodeId));
}

/** Direct scientific gates need a fresh check after their selected verifier manifest changes. */
export function repairedProviderBlockedDirectGateNodeIds(
  graph: {
    node(id: string):
      | {
          readonly type: string;
          readonly asset_manifest?: Readonly<Record<string, unknown>>;
        }
      | undefined;
  },
  evaluation: Pick<CompiledRuleEvaluation, "facts" | "gate_policy_contexts">,
): ReadonlySet<string> {
  const selfBlockedGateIds = new Set<string>();
  for (const fact of evaluation.facts) {
    if (fact.kind !== "readiness" || fact.value !== "blocked") continue;
    const blocking = fact.args.blocking_gate_ids;
    if (Array.isArray(blocking) && blocking.some((gateId) => gateId === fact.anchor_node_id)) {
      selfBlockedGateIds.add(fact.anchor_node_id);
    }
  }
  const gates = new Set<string>();
  for (const context of evaluation.gate_policy_contexts) {
    const winner =
      context.winner_node_id === undefined ? undefined : graph.node(context.winner_node_id);
    const manifestHash = optionalString(winner?.asset_manifest?.hash);
    if (
      manifestHash !== undefined &&
      selfBlockedGateIds.has(context.gate_node_id) &&
      context.evaluation_target_node_ids.some((nodeId) => {
        const type = graph.node(nodeId)?.type;
        return type === "experiment" || type === "prerequisite";
      })
    ) {
      gates.add(context.gate_node_id);
    }
  }
  return gates;
}

/**
 * A direct gate recheck reads the gate, its selected verifier, and the scientific subject being
 * evaluated. The broader policy context is useful evidence for rule selection, but granting every
 * context node here creates false read/write dependencies on unrelated run-contract repairs and
 * can deadlock the very gate that would unblock execution.
 */
export function repairedProviderDirectGateReadNodeIds(
  graph: { node(id: string): { readonly type: string } | undefined },
  context: {
    readonly gate_node_id: string;
    readonly winner_node_id?: string;
    readonly evaluation_target_node_ids: readonly string[];
    readonly context_node_ids?: readonly string[];
  },
): readonly string[] {
  return [
    context.gate_node_id,
    ...(context.winner_node_id === undefined ? [] : [context.winner_node_id]),
    ...context.evaluation_target_node_ids,
  ]
    .filter((nodeId) => graph.node(nodeId) !== undefined)
    .sort(compareText)
    .filter((nodeId, index, all) => index === 0 || nodeId !== all[index - 1]);
}

/** A gate recheck is current only when its manifest-derived definition identity is current. */
export function hasManifestScopedDirectGateRecheck(
  definitions: readonly Pick<DerivedTicketDefinition, "id" | "operation_registry_id">[],
  expectedDefinitionId: string,
): boolean {
  return definitions.some(
    (definition) =>
      definition.operation_registry_id === "gates.gate.run-gate" &&
      definition.id === expectedDefinitionId,
  );
}

/** Return current manifest-bound gate rechecks even when they already exist in the evaluation. */
export function manifestScopedDirectGateRechecks(
  definitions: readonly DerivedTicketDefinition[],
  expectedDefinitionIds: ReadonlySet<string>,
): DerivedTicketDefinition[] {
  return definitions.filter(
    (definition) =>
      definition.operation_registry_id === "gates.gate.run-gate" &&
      expectedDefinitionIds.has(definition.id),
  );
}

/**
 * A manifest-bound recheck is the current execution authority for its gate. Keeping an older
 * run-gate definition for the same node makes the new ticket depend on a stale failed workflow
 * (and possibly its operator proposal), even though the selected provider bytes have changed.
 */
export function replaceGateRunDefinitionsWithManifestRechecks(
  definitions: readonly DerivedTicketDefinition[],
  rechecks: readonly DerivedTicketDefinition[],
): DerivedTicketDefinition[] {
  const recheckedGateIds = new Set(rechecks.flatMap((definition) => definition.target_node_ids));
  return [
    ...definitions.filter(
      (definition) =>
        definition.operation_registry_id !== "gates.gate.run-gate" ||
        !definition.target_node_ids.some((nodeId) => recheckedGateIds.has(nodeId)),
    ),
    ...rechecks,
  ];
}

function repairedProviderBlockedDirectGateFallback(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  evaluation: CompiledRuleEvaluation,
): CompiledRuleEvaluation {
  const operationId = "gates.gate.run-gate";
  if (configuration.registries.operations[operationId]?.operation !== "run-gate") {
    return evaluation;
  }
  const targetGateIds = repairedProviderBlockedDirectGateNodeIds(graph, evaluation);
  const additions: DerivedTicketDefinition[] = [];
  const expectedDefinitionIds = new Set<string>();
  const catalog = requireExecutionSemanticCatalog(configuration);
  for (const gateId of [...targetGateIds].sort(compareText)) {
    const gate = graph.node(gateId);
    const context = evaluation.gate_policy_contexts.find(
      (candidate) => candidate.gate_node_id === gateId && candidate.winner_node_id !== undefined,
    );
    const winnerId = context?.winner_node_id;
    const winner = winnerId === undefined ? undefined : graph.node(winnerId);
    const extendedWinner = winner as unknown as ConfigurationObject | undefined;
    const manifestHash = optionalString(optionalRecord(extendedWinner?.asset_manifest)?.hash);
    if (gate?.type !== "gate" || winnerId === undefined || manifestHash === undefined) continue;
    const readNodeIds = repairedProviderDirectGateReadNodeIds(graph, {
      gate_node_id: gateId,
      winner_node_id: winnerId,
      evaluation_target_node_ids: context?.evaluation_target_node_ids ?? [],
    });
    const id = `TK-compat-run-gate-${digestBody(
      canonicalHash({
        configuration_sha256: configuration.configuration_sha256,
        gate_node_id: gateId,
        winner_node_id: winnerId,
        winner_manifest_hash: manifestHash,
      }),
    ).slice(0, 24)}`;
    expectedDefinitionIds.add(id);
    if (hasManifestScopedDirectGateRecheck(evaluation.tickets, id)) continue;
    additions.push(
      configuredControlTicketDefinition({
        configuration,
        catalog,
        graph,
        id,
        operationId,
        title: `run-gate: ${gate.title}`,
        targetNodeIds: [gateId],
        readNodeIds,
        writeNodeIds: [gateId],
        readPaths: [...(context?.read_paths ?? [])].sort(compareText),
        writePaths: [],
        sourceStateKey: "direct-scientific-gate-blocked-after-provider-repair",
        targetStateKey: "direct-scientific-gate-has-current-passing-receipt",
        obligationKeys: ["gate.verdict"],
        forceGraphMutationForbidden: false,
        ruleId: "compiler.compatibility.repaired-provider-gate-recheck",
      }),
    );
  }
  const currentRechecks = manifestScopedDirectGateRechecks(
    evaluation.tickets,
    expectedDefinitionIds,
  );
  const rechecks = [...currentRechecks, ...additions];
  if (rechecks.length === 0) return evaluation;
  const reconciled = replaceGateRunDefinitionsWithManifestRechecks(evaluation.tickets, rechecks);
  const unchanged =
    reconciled.length === evaluation.tickets.length &&
    reconciled.every((definition, index) => definition === evaluation.tickets[index]);
  return unchanged ? evaluation : rehashRuleEvaluation(evaluation, reconciled);
}

/**
 * Rule evaluation intentionally continues to project deterministic implement-asset definitions
 * after a recurring asset has settled. The filesystem acceptance pass is the authority for whether
 * that recurring obligation is current. Verification must therefore omit current recurring assets
 * from its actionable fixpoint while retaining stale assets and every non-asset predicate.
 */
export function verificationActionableTicketDefinitions(
  definitions: readonly DerivedTicketDefinition[],
  recurringAssetReissues: ReadonlySet<string>,
  durableTickets: readonly Pick<TicketRecord, "id" | "status">[] = [],
): readonly DerivedTicketDefinition[] {
  const completedTicketIds = new Set(
    durableTickets.filter((ticket) => ticket.status === "completed").map((ticket) => ticket.id),
  );
  return ticketBoardApplicableTicketDefinitions(definitions, recurringAssetReissues).filter(
    (definition) =>
      definition.rule_id !== "compiler.compatibility.repaired-provider-gate-recheck" ||
      !completedTicketIds.has(definition.id),
  );
}

/**
 * A current recurring asset definition remains in the compiler artifact for stable identity and
 * restoration, but it is not an applicable scheduling predicate until materialization becomes
 * stale again. Keeping these ids out of the board's applicable set also lets the authority retire
 * an already-created empty reissue cycle before it can launch another provider attempt.
 */
export function ticketBoardApplicableTicketDefinitions(
  definitions: readonly DerivedTicketDefinition[],
  recurringAssetReissues: ReadonlySet<string>,
): readonly DerivedTicketDefinition[] {
  return definitions.filter(
    (definition) =>
      definition.operation_registry_id !== "asset-resolution.asset.implement-asset" ||
      definition.target_node_ids.some((nodeId) => recurringAssetReissues.has(nodeId)),
  );
}

/**
 * Older pinned research profiles select scientific runs only through an incoming experiment or
 * ablation `runs` edge. An approved change can instead author a bounded standalone support run to
 * materialize a runtime artifact required by a gate. Preserve that approved execution path by
 * projecting the same configured contract-repair or runtime operation that the current profile
 * emits for a scientific-result run, while continuing to exclude gate-result provenance records.
 */
export function researchStandaloneSupportRunFallback(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  evaluation: CompiledRuleEvaluation,
  adapter: RuleDomainAdapter,
  durableTickets: readonly Pick<
    TicketRecord,
    "id" | "operationId" | "targetNodeIds" | "status"
  >[] = [],
): CompiledRuleEvaluation {
  const edges = graph.edges();
  const ownedRunIds = new Set(
    edges
      .filter((edge) => {
        const source = graph.node(edge.source);
        return (
          edge.relation === "runs" && (source?.type === "experiment" || source?.type === "ablation")
        );
      })
      .map((edge) => edge.target),
  );
  const evaluatedTargetKeys = new Set<string>();
  for (const definition of evaluation.tickets) {
    for (const nodeId of definition.target_node_ids) {
      evaluatedTargetKeys.add(operationTargetKey(definition.operation_registry_id, nodeId));
    }
  }
  const durableTicketIdsByTarget = new Map<string, Set<string>>();
  for (const ticket of durableTickets) {
    if (ticket.status === "completed" || ticket.status === "cancelled") continue;
    for (const nodeId of ticket.targetNodeIds) {
      const key = operationTargetKey(ticket.operationId, nodeId);
      const ticketIds = durableTicketIdsByTarget.get(key) ?? new Set<string>();
      ticketIds.add(ticket.id);
      durableTicketIdsByTarget.set(key, ticketIds);
    }
  }
  const requiredContractFields = [
    "spec.runtime_contract.command",
    "spec.runtime_contract.composed_verification_command",
    "spec.runtime_contract.result_protocol",
    "spec.runtime_contract.required_measurements",
    "spec.runtime_contract.asset_entrypoints",
  ] as const;
  const terminalStatuses = new Set(["satisfied", "archived", "superseded"]);
  const catalog = requireExecutionSemanticCatalog(configuration);
  const additions: DerivedTicketDefinition[] = [];

  for (const node of graph.nodes()) {
    const runtimeContract = optionalRecord(node.spec.runtime_contract);
    if (
      node.type !== "run" ||
      terminalStatuses.has(node.status) ||
      ownedRunIds.has(node.id) ||
      runtimeContract?.result_protocol !== "autoresearch.research-result.v1"
    ) {
      continue;
    }

    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
    evaluator.bind("target", [node.id]);
    const contractComplete =
      requiredContractFields.every((field) => evaluator.evaluate({ op: "field_present", field })) &&
      Array.isArray(runtimeContract.scientific_inputs);
    const operationId = contractComplete
      ? "execution.run.run-experiment"
      : "execution.node.compile-run-plan";
    if (
      contractComplete &&
      evaluator.evaluate({ op: "current_receipt", receipt_type: "runtime.receipt" })
    ) {
      continue;
    }

    const relatedNodeIds = new Set([node.id]);
    for (const edge of edges) {
      if (edge.source === node.id && (edge.relation === "uses" || edge.relation === "evaluates")) {
        relatedNodeIds.add(edge.target);
      }
    }
    const readNodeIds = [...relatedNodeIds].sort(compareText);
    const readPaths = new Set<string>();
    for (const nodeId of readNodeIds) {
      const related = graph.node(nodeId);
      if (related?.type !== "asset") continue;
      const root = optionalString(optionalRecord(related.spec.implementation_plan)?.root);
      if (root !== undefined) readPaths.add(root);
    }
    const outputRoot = optionalString(runtimeContract.output_root);
    if (contractComplete && outputRoot !== undefined) readPaths.add(outputRoot);
    const sourceStateKey = contractComplete
      ? "run-missing-current-valid-runtime-receipt"
      : "run-missing-executable-contract";
    const targetStateKey = contractComplete
      ? "run-has-current-valid-runtime-receipt"
      : "run-has-executable-scientific-contract";
    const id = `TK-compat-standalone-run-${digestBody(
      canonicalHash({
        configuration_sha256: configuration.configuration_sha256,
        operation_id: operationId,
        target_node_id: node.id,
        source_state: sourceStateKey,
      }),
    ).slice(0, 24)}`;
    const targetKey = operationTargetKey(operationId, node.id);
    if (evaluatedTargetKeys.has(targetKey)) continue;
    const durableTicketIds = durableTicketIdsByTarget.get(targetKey);
    if (
      durableTicketIds !== undefined &&
      [...durableTicketIds].some((ticketId) => ticketId !== id)
    ) {
      continue;
    }
    additions.push(
      configuredControlTicketDefinition({
        configuration,
        catalog,
        graph,
        id,
        operationId,
        title: `${contractComplete ? "run-experiment" : "compile-run-plan"}: ${node.title}`,
        targetNodeIds: [node.id],
        readNodeIds,
        writeNodeIds: [node.id],
        readPaths: [...readPaths].sort(compareText),
        writePaths: contractComplete && outputRoot !== undefined ? [outputRoot] : [],
        sourceStateKey,
        targetStateKey,
        obligationKeys: [contractComplete ? "run.receipt" : "run.runtime-contract"],
        forceGraphMutationForbidden: false,
        ruleId: "compiler.compatibility.research-standalone-support-run",
      }),
    );
  }

  return additions.length === 0
    ? evaluation
    : rehashRuleEvaluation(evaluation, [...evaluation.tickets, ...additions]);
}

function operationTargetKey(operationId: string, targetNodeId: string): string {
  return `${operationId}\u0000${targetNodeId}`;
}

/**
 * Resolve an already-authorized standalone scientific run that covers an upstream request's exact
 * asset/gate seam. A request may name only the executable asset while its source ticket carries the
 * causal gate in read scope; that still requires an explicit gate overlap rather than treating any
 * run that happens to use the asset as fulfillment. The run must declare a durable output root and
 * scientific result protocol; a gate-result provenance record or an experiment-owned run is not a
 * substitute.
 */
export function existingStandaloneSupportRunForUpstreamRequest(
  graph: {
    node(id: string):
      | {
          readonly type: string;
          readonly spec?: Readonly<Record<string, unknown>>;
        }
      | undefined;
    edges(): readonly {
      readonly source: string;
      readonly relation: string;
      readonly target: string;
    }[];
  },
  targetNodeIds: readonly string[],
  causalContextNodeIds: readonly string[] = [],
): string | undefined {
  const requestedAssets: string[] = [];
  const requestedGates: string[] = [];
  for (const nodeId of targetNodeIds) {
    const type = graph.node(nodeId)?.type;
    if (type === "asset") requestedAssets.push(nodeId);
    else if (type === "gate") requestedGates.push(nodeId);
    else return undefined;
  }
  if (requestedAssets.length === 0) return undefined;
  const contextualGates = new Set(
    causalContextNodeIds.filter((nodeId) => graph.node(nodeId)?.type === "gate"),
  );
  if (requestedGates.length === 0 && contextualGates.size === 0) return undefined;

  const edges = graph.edges();
  const ownedRunIds = new Set(
    edges
      .filter((edge) => {
        const source = graph.node(edge.source);
        return (
          edge.relation === "runs" && (source?.type === "experiment" || source?.type === "ablation")
        );
      })
      .map((edge) => edge.target),
  );
  const candidateRunIds = [...new Set(edges.map((edge) => edge.source))]
    .filter((nodeId) => graph.node(nodeId)?.type === "run" && !ownedRunIds.has(nodeId))
    .sort(compareText);
  for (const runId of candidateRunIds) {
    const runtimeContract = optionalRecord(graph.node(runId)?.spec?.runtime_contract);
    if (
      runtimeContract?.result_protocol !== "autoresearch.research-result.v1" ||
      optionalString(runtimeContract.output_root) === undefined
    ) {
      continue;
    }
    const uses = new Set(
      edges
        .filter((edge) => edge.source === runId && edge.relation === "uses")
        .map((edge) => edge.target),
    );
    const evaluates = new Set(
      edges
        .filter((edge) => edge.source === runId && edge.relation === "evaluates")
        .map((edge) => edge.target),
    );
    if (
      requestedAssets.every((nodeId) => uses.has(nodeId)) &&
      (requestedGates.length > 0
        ? requestedGates.every((nodeId) => evaluates.has(nodeId))
        : [...contextualGates].some((nodeId) => evaluates.has(nodeId)))
    ) {
      return runId;
    }
  }
  return undefined;
}

/**
 * Scientific execution workflows apply to runs owned by an experiment or ablation through its
 * `runs` edge and to bounded standalone support runs that explicitly declare the scientific result
 * protocol. Approved change applications can author the latter to materialize an upstream runtime
 * artifact before an experiment owns it. Gate workflows may also create run-shaped provenance
 * records, but those emit gate-result receipts and cannot truthfully satisfy a research-result
 * runtime contract. Keep this invariant in Core as compatibility for already-pinned profile
 * bundles.
 */
export function scientificRunTicketDefinitions(
  graph: {
    node(id: string):
      | {
          readonly type: string;
          readonly spec?: Readonly<Record<string, unknown>>;
        }
      | undefined;
    edges(): readonly {
      readonly source: string;
      readonly relation: string;
      readonly target: string;
    }[];
  },
  definitions: readonly DerivedTicketDefinition[],
): readonly DerivedTicketDefinition[] {
  const scientificRunIds = new Set(
    graph
      .edges()
      .filter((edge) => {
        const source = graph.node(edge.source);
        const target = graph.node(edge.target);
        return (
          edge.relation === "runs" &&
          (source?.type === "experiment" || source?.type === "ablation") &&
          target?.type === "run"
        );
      })
      .map((edge) => edge.target),
  );
  const scientificOperations = new Set([
    "execution.node.compile-run-plan",
    "execution.run.run-experiment",
  ]);
  return definitions.filter(
    (definition) =>
      !scientificOperations.has(definition.operation_registry_id) ||
      definition.target_node_ids.every((nodeId) => {
        const node = graph.node(nodeId);
        const runtimeContract = isRecord(node?.spec?.runtime_contract)
          ? node.spec.runtime_contract
          : undefined;
        const standaloneScientificRun =
          runtimeContract?.result_protocol === "autoresearch.research-result.v1";
        return node?.type !== "run" || scientificRunIds.has(nodeId) || standaloneScientificRun;
      }),
  );
}

function rehashRuleEvaluation(
  evaluation: CompiledRuleEvaluation,
  tickets: readonly DerivedTicketDefinition[],
): CompiledRuleEvaluation {
  const material = { ...evaluation, tickets: [...tickets] };
  return deepFreeze({
    ...material,
    evaluation_sha256: canonicalHash(withoutField(material, "evaluation_sha256")),
  });
}

/**
 * Research profiles historically selected run-plan targets through the final `readiness.state`.
 * Gate-policy authority is materialized after constitution readiness and deliberately overwrites
 * that field while an expected-red gate is unresolved, so the old selector made the operation
 * that designs an executable run unreachable. Planning a run is not scientific execution: gates
 * must constrain the later runtime receipt, not whether the runtime contract can be authored.
 *
 * Keep already-pinned runs live by projecting the same compile-run-plan operation from the
 * constitution encoded in their typed graph. Current profiles express this with the private
 * `compiler.constitution_state` projection; this fallback is inert once the configured rule emits
 * the ticket itself or the target already owns a run.
 */
export function researchConstitutionRunPlanFallback(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  evaluation: CompiledRuleEvaluation,
): CompiledRuleEvaluation {
  const operationId = "execution.node.compile-run-plan";
  const operation = configuration.registries.operations[operationId];
  if (operation?.operation !== "compile-run-plan") return evaluation;

  const existingTargets = new Set(
    evaluation.tickets
      .filter((definition) => definition.operation_registry_id === operationId)
      .flatMap((definition) => definition.target_node_ids),
  );
  const additions: DerivedTicketDefinition[] = [];
  const catalog = requireExecutionSemanticCatalog(configuration);
  for (const node of graph.nodes()) {
    if (
      (node.type !== "experiment" && node.type !== "ablation") ||
      new Set(["satisfied", "archived", "superseded"]).has(node.status) ||
      existingTargets.has(node.id) ||
      (node.edges.runs?.length ?? 0) > 0
    ) {
      continue;
    }
    const constitutionComplete =
      node.type === "experiment"
        ? (node.edges.methods?.length ?? 0) > 0 &&
          (node.edges.metrics?.length ?? 0) > 0 &&
          (node.edges.ablations?.length ?? 0) > 0 &&
          (node.edges.requires?.length ?? 0) > 0
        : (node.edges.metrics?.length ?? 0) > 0 &&
          ((node.edges.method?.length ?? 0) > 0 ||
            ((node.edges.baseline?.length ?? 0) > 0 && (node.edges.variant?.length ?? 0) > 0));
    if (!constitutionComplete) continue;

    const id = `TK-compat-run-plan-${digestBody(
      canonicalHash({
        configuration_sha256: configuration.configuration_sha256,
        target_node_id: node.id,
        source_state: "constitution-complete-without-run-plan",
      }),
    ).slice(0, 24)}`;
    additions.push(
      configuredControlTicketDefinition({
        configuration,
        catalog,
        graph,
        id,
        operationId,
        title: `compile-run-plan: ${node.title}`,
        targetNodeIds: [node.id],
        readNodeIds: [node.id],
        writeNodeIds: [node.id],
        readPaths: [],
        writePaths: [],
        sourceStateKey: "constitution-complete-without-run-plan",
        targetStateKey: "target-has-linked-run",
        obligationKeys: ["target.runs"],
        forceGraphMutationForbidden: false,
        ruleId: "compiler.compatibility.research-constitution-run-plan",
      }),
    );
  }
  return additions.length === 0
    ? evaluation
    : rehashRuleEvaluation(evaluation, [...evaluation.tickets, ...additions]);
}

interface ResearchRunContractScopeGraph {
  node(id: string):
    | {
        readonly id: string;
        readonly type: string;
        readonly spec: Readonly<Record<string, unknown>>;
      }
    | undefined;
  edges(): readonly {
    readonly source: string;
    readonly relation: string;
    readonly target: string;
  }[];
}

/**
 * A run-contract repair step must be able to inspect the concrete assets that its scientific
 * owner already selected. Older research rules only traversed `run -> evaluates` and `run ->
 * uses`; before the bind step creates `uses` edges, that scope excludes the very harness and
 * prerequisite assets needed to author truthful argv and integrity commands.
 *
 * Expand only scientific compile-run-plan repairs, and only through the owner's typed research
 * relations. This keeps unrelated assets out of scope while repairing already-pinned profiles.
 */
export function researchRunContractScopeFallback(
  graph: ResearchRunContractScopeGraph,
  evaluation: CompiledRuleEvaluation,
): CompiledRuleEvaluation {
  const edges = graph.edges();
  const expansionRelations = new Set([
    "assets",
    "methods",
    "requires",
    "baseline",
    "variant",
    "method",
    "implements",
    "satisfied_by",
    "metrics",
  ]);
  const existingIds = new Set(evaluation.tickets.map((definition) => definition.id));
  const supersededIds = new Set<string>();
  const additions: DerivedTicketDefinition[] = [];
  for (const definition of evaluation.tickets) {
    if (
      definition.operation_registry_id !== "execution.node.compile-run-plan" ||
      definition.source_state_key !== "run-missing-executable-contract"
    ) {
      continue;
    }
    const targetRunIds = definition.target_node_ids.filter(
      (nodeId) => graph.node(nodeId)?.type === "run",
    );
    if (targetRunIds.length === 0) continue;

    const visible = new Set(definition.scope.read_node_ids);
    const frontier: string[] = [...visible];
    const add = (nodeId: string): void => {
      if (graph.node(nodeId) === undefined || visible.has(nodeId)) return;
      visible.add(nodeId);
      frontier.push(nodeId);
    };
    for (const runId of targetRunIds) {
      add(runId);
      for (const edge of edges) {
        if (edge.source === runId && edge.relation === "evaluates") add(edge.target);
        if (edge.target === runId && edge.relation === "runs") {
          const owner = graph.node(edge.source);
          if (owner?.type === "experiment" || owner?.type === "ablation") add(edge.source);
        }
      }
    }
    for (const nodeId of [...visible]) {
      if (graph.node(nodeId)?.type !== "ablation") continue;
      for (const edge of edges) {
        if (edge.relation === "ablations" && edge.target === nodeId) add(edge.source);
      }
    }
    for (let index = 0; index < frontier.length; index += 1) {
      const source = frontier[index]!;
      for (const edge of edges) {
        if (edge.source === source && expansionRelations.has(edge.relation)) add(edge.target);
      }
    }

    const readPaths = new Set(definition.scope.read_paths);
    for (const nodeId of visible) {
      const node = graph.node(nodeId);
      if (node?.type !== "asset") continue;
      const plan = optionalRecord(node.spec.implementation_plan);
      const root = optionalString(plan?.root);
      if (root !== undefined) readPaths.add(root);
    }
    const readNodeIds = [...visible].sort(compareText);
    const sortedReadPaths = [...readPaths].sort(compareText);
    if (
      canonicalHash(readNodeIds) === canonicalHash(definition.scope.read_node_ids) &&
      canonicalHash(sortedReadPaths) === canonicalHash(definition.scope.read_paths)
    ) {
      continue;
    }
    const { definition_sha256: _definitionSha256, ...existing } = definition;
    const id = `TK-compat-run-contract-scope-${digestBody(
      canonicalHash({
        configuration_sha256: evaluation.configuration_sha256,
        target_node_ids: targetRunIds,
        read_node_ids: readNodeIds,
        read_paths: sortedReadPaths,
      }),
    ).slice(0, 24)}`;
    supersededIds.add(definition.id);
    if (existingIds.has(id)) continue;
    const material = {
      ...existing,
      id,
      rule_id: "compiler.compatibility.research-run-contract-scope",
      scope: {
        ...definition.scope,
        read_node_ids: readNodeIds,
        read_paths: sortedReadPaths,
      },
    };
    additions.push(deepFreeze({ ...material, definition_sha256: canonicalHash(material) }));
    existingIds.add(id);
  }
  const withRunContractScope =
    supersededIds.size === 0
      ? evaluation
      : rehashRuleEvaluation(evaluation, [
          ...evaluation.tickets.filter((definition) => !supersededIds.has(definition.id)),
          ...additions,
        ]);
  return standaloneSupportRunAssetRepairScopeFallback(
    graph,
    gateProviderRepairScopeFallback(graph, withRunContractScope),
  );
}

/**
 * A selected gate provider can diagnose that the nonpassing condition belongs to the scientific
 * prerequisite's generated asset rather than to the verifier itself. Give that recurring repair
 * ticket read-only visibility through the direct gate -> prerequisite -> asset chain so it can
 * name an exact, already-planned upstream target. Write authority remains confined to the
 * provider asset.
 */
export function gateProviderRepairScopeFallback(
  graph: ResearchRunContractScopeGraph,
  evaluation: CompiledRuleEvaluation,
): CompiledRuleEvaluation {
  const delegatedGateNodeIds = standaloneSupportRunGateNodeIds(graph, evaluation);
  const selfBlockedGateIds = new Set<string>();
  const currentTerminalGateIds = new Set<string>();
  for (const fact of evaluation.facts) {
    if (fact.kind !== "readiness" || fact.value !== "blocked") continue;
    const blocking = fact.args.blocking_gate_ids;
    if (Array.isArray(blocking) && blocking.some((gateId) => gateId === fact.anchor_node_id)) {
      selfBlockedGateIds.add(fact.anchor_node_id);
    }
    const terminal = fact.args.current_terminal_gate_ids;
    if (Array.isArray(terminal) && terminal.some((gateId) => gateId === fact.anchor_node_id)) {
      currentTerminalGateIds.add(fact.anchor_node_id);
    }
  }

  const edges = graph.edges();
  const causalRelations = new Set(["applies_to", "requires", "satisfied_by"]);
  const causalScopeByProvider = new Map<string, Set<string>>();
  for (const context of evaluation.gate_policy_contexts) {
    const providerId = context.winner_node_id;
    if (
      providerId === undefined ||
      delegatedGateNodeIds.has(context.gate_node_id) ||
      !selfBlockedGateIds.has(context.gate_node_id) ||
      !currentTerminalGateIds.has(context.gate_node_id) ||
      !context.evaluation_target_node_ids.some((nodeId) => {
        const type = graph.node(nodeId)?.type;
        return type === "experiment" || type === "prerequisite";
      })
    ) {
      continue;
    }
    const causal = causalScopeByProvider.get(providerId) ?? new Set<string>();
    const frontier = [context.gate_node_id, ...context.evaluation_target_node_ids];
    for (let index = 0; index < frontier.length; index += 1) {
      const source = frontier[index]!;
      if (graph.node(source) === undefined || causal.has(source)) continue;
      causal.add(source);
      for (const edge of edges) {
        if (
          edge.source === source &&
          causalRelations.has(edge.relation) &&
          !causal.has(edge.target)
        ) {
          frontier.push(edge.target);
        }
      }
    }
    causal.add(providerId);
    causalScopeByProvider.set(providerId, causal);
  }
  if (causalScopeByProvider.size === 0) return evaluation;

  const existingIds = new Set(evaluation.tickets.map((definition) => definition.id));
  const supersededIds = new Set<string>();
  const additions: DerivedTicketDefinition[] = [];
  for (const definition of evaluation.tickets) {
    if (definition.operation_registry_id !== "asset-resolution.asset.implement-asset") continue;
    const causalNodeIds = new Set(
      definition.target_node_ids.flatMap((nodeId) => [
        ...(causalScopeByProvider.get(nodeId) ?? []),
      ]),
    );
    if (causalNodeIds.size === 0) continue;

    const readNodeIds = [...new Set([...definition.scope.read_node_ids, ...causalNodeIds])].sort(
      compareText,
    );
    const readPaths = new Set(definition.scope.read_paths);
    for (const nodeId of readNodeIds) {
      const node = graph.node(nodeId);
      if (node?.type !== "asset") continue;
      const root = optionalString(optionalRecord(node.spec.implementation_plan)?.root);
      if (root !== undefined) readPaths.add(root);
    }
    const sortedReadPaths = [...readPaths].sort(compareText);
    if (
      canonicalHash(readNodeIds) === canonicalHash(definition.scope.read_node_ids) &&
      canonicalHash(sortedReadPaths) === canonicalHash(definition.scope.read_paths)
    ) {
      continue;
    }

    const { definition_sha256: _definitionSha256, ...existing } = definition;
    const id = `TK-compat-gate-provider-repair-scope-${digestBody(
      canonicalHash({
        configuration_sha256: evaluation.configuration_sha256,
        source_definition_id: definition.id,
        target_node_ids: definition.target_node_ids,
        read_node_ids: readNodeIds,
        read_paths: sortedReadPaths,
      }),
    ).slice(0, 24)}`;
    supersededIds.add(definition.id);
    if (existingIds.has(id)) continue;
    const material = {
      ...existing,
      id,
      rule_id: "compiler.compatibility.gate-provider-repair-scope",
      scope: {
        ...definition.scope,
        read_node_ids: readNodeIds,
        read_paths: sortedReadPaths,
      },
    };
    additions.push(deepFreeze({ ...material, definition_sha256: canonicalHash(material) }));
    existingIds.add(id);
  }
  return supersededIds.size === 0
    ? evaluation
    : rehashRuleEvaluation(evaluation, [
        ...evaluation.tickets.filter((definition) => !supersededIds.has(definition.id)),
        ...additions,
      ]);
}

/**
 * A generated asset always participates in the compatibility implementation projection. An
 * already-issued implementation workflow also remains the authenticated repair owner when a
 * pristine planned-asset request arrives after the ordinary readiness predicate has settled.
 * Requiring that durable historical ticket prevents a request from inventing implementation
 * authority for an asset that never had it.
 */
export function assetImplementationFallbackEligible(
  run: Pick<RunRecord, "tickets">,
  node: Pick<GraphNode, "id" | "type" | "spec">,
): boolean {
  if (node.type !== "asset") return false;
  if (node.spec.source_strategy === "generated") return true;
  return (
    plannedAssetRepairRequestForNode(run, node.id) !== undefined &&
    hasExistingAssetImplementationTicket(run, "asset-resolution.asset.implement-asset", node.id)
  );
}

async function generatedAssetImplementationFallback(
  run: RunRecord,
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  evaluation: CompiledRuleEvaluation,
  projectRoot: string,
): Promise<CompiledRuleEvaluation | undefined> {
  const operationId = "asset-resolution.asset.implement-asset";
  const operation = configuration.registries.operations[operationId];
  if (operation?.operation !== "implement-asset") return undefined;

  const additions: DerivedTicketDefinition[] = [];
  for (const node of graph.nodes()) {
    if (!assetImplementationFallbackEligible(run, node)) continue;
    const plan = optionalRecord(node.spec.implementation_plan);
    const root = typeof plan?.root === "string" ? plan.root : undefined;
    const files = Array.isArray(plan?.files)
      ? plan.files.filter((file): file is string => typeof file === "string" && file.length > 0)
      : [];
    const contracts = optionalRecord(node.spec.gate_contracts);
    if (root === undefined || files.length === 0) continue;
    const repairRequest = plannedAssetRepairRequestForNode(run, node.id);
    const readPaths = generatedAssetImplementationReadPaths(node, root);
    const id = `TK-compat-${digestBody(
      canonicalHash({
        configuration_sha256: configuration.configuration_sha256,
        asset_id: node.id,
        root,
        files: [...files].sort(compareText),
        read_paths: readPaths,
        ...(repairRequest === undefined
          ? {}
          : { repair_request_sha256: repairRequest.requestSha256 }),
      }),
    ).slice(0, 24)}`;
    const compatibilityTicket = run.tickets[id];
    const compatibilityRepairInFlight =
      compatibilityTicket !== undefined &&
      compatibilityTicket.status !== "completed" &&
      compatibilityTicket.status !== "cancelled";
    const requestedRepair = repairRequest !== undefined && run.tickets[id]?.status !== "completed";
    const hasGateImplementationPlan =
      contracts !== undefined &&
      Object.keys(contracts).length > 0 &&
      (node.edges.validates?.length ?? 0) > 0;
    if (!hasGateImplementationPlan && !requestedRepair && !compatibilityRepairInFlight) continue;
    const alreadyMaterialized = evaluation.tickets.some(
      (ticket) =>
        ticket.operation_registry_id === operationId &&
        ticket.target_node_ids.includes(node.id) &&
        ticket.scope.write_paths.includes(root),
    );
    if (alreadyMaterialized) continue;

    const existingTickets = Object.values(run.tickets).filter(
      (ticket) =>
        ticket.status !== "cancelled" &&
        ticket.operationId === operationId &&
        ticket.targetNodeIds.includes(node.id),
    );
    if (existingTickets.some((ticket) => ticket.id !== id && ticket.status !== "completed")) {
      continue;
    }
    if (
      !requestedRepair &&
      !compatibilityRepairInFlight &&
      existingTickets.some((ticket) => ticket.status === "completed") &&
      (await assetImplementationFilesMaterialized(projectRoot, files))
    ) {
      continue;
    }
    additions.push(
      configuredControlTicketDefinition({
        configuration,
        catalog: requireExecutionSemanticCatalog(configuration),
        graph,
        id,
        operationId,
        title:
          repairRequest === undefined
            ? `implement-asset: ${node.title}`
            : `implement-asset repair: ${repairRequest.title}`,
        targetNodeIds: [node.id],
        readNodeIds: [node.id],
        writeNodeIds: [node.id],
        readPaths,
        writePaths: [root],
        sourceStateKey: "generated-asset-unmaterialized",
        targetStateKey: "generated-asset-materialized",
        obligationKeys: [
          "asset.implementation",
          ...(hasGateImplementationPlan ? ["asset.gates"] : []),
          ...(repairRequest === undefined ? [] : [repairRequest.requestSha256]),
        ],
        forceGraphMutationForbidden: false,
        ruleId: "compiler.compatibility.generated-asset-implementation",
      }),
    );
  }
  if (additions.length === 0) return undefined;
  const material = {
    ...evaluation,
    tickets: [...evaluation.tickets, ...additions],
  };
  return deepFreeze({
    ...material,
    evaluation_sha256: canonicalHash(withoutField(material, "evaluation_sha256")),
  });
}

/**
 * Generated assets may explicitly depend on repository files outside their writable root.
 * Those declared support paths are immutable inputs to implementation and repair attempts, so
 * expose them read-only while retaining the asset root as the sole write scope.
 */
export function generatedAssetImplementationReadPaths(
  node: Pick<GraphNode, "id" | "spec">,
  root: string,
): string[] {
  const supportPaths = stringArray(node.spec.support_paths, `${node.id}.spec.support_paths`).map(
    (value, index) => controlScopePath(value, `${node.id} generated asset read path ${index + 1}`),
  );
  return expandPythonPackageReadPaths([
    controlScopePath(root, `${node.id} generated asset read path 0`),
    ...supportPaths,
  ]);
}

function isSettledRecurringAssetTicket(ticket: Readonly<TicketRecord>): boolean {
  return (
    ticket.status === "completed" ||
    (ticket.status === "cancelled" &&
      ticket.blocker === COMPILER_INAPPLICABLE_TICKET &&
      ticket.gitCycleId === undefined &&
      ticket.worktreePath === undefined &&
      ticket.branch === undefined &&
      ticket.steps.length > 0 &&
      ticket.steps.every((step) => step.status === "skipped"))
  );
}

/**
 * A completed recurring asset's old scope is immutable history for its accepted attempts, but it
 * is not authority for a later compiler-required execution epoch. Once the prior Git cycle has
 * settled, refresh only the grant-bearing scope on the durable ticket before reopening it. Live
 * attempts remain pinned and continue through the ordinary compensation path.
 */
export function refreshSettledRecurringAssetTicketGrant(
  ticket: TicketRecord,
  definition: DerivedTicketDefinition,
  reissueRequired: boolean,
): boolean {
  if (
    !reissueRequired ||
    !isSettledRecurringAssetTicket(ticket) ||
    ticket.operationId !== "asset-resolution.asset.implement-asset" ||
    definition.operation_registry_id !== ticket.operationId ||
    ticket.steps.length !== definition.workflow.length ||
    ticket.steps.some((step, index) => {
      const compiled = definition.workflow[index];
      return (
        compiled === undefined ||
        step.id !== compiled.id ||
        step.personaId !== compiled.persona_id ||
        (step.kind !== undefined && step.kind !== compiled.kind) ||
        (step.dependsOn !== undefined &&
          canonicalHash(step.dependsOn) !== canonicalHash(compiled.depends_on))
      );
    })
  ) {
    return false;
  }
  const before = canonicalHash({
    targetNodeIds: ticket.targetNodeIds,
    readNodeIds: ticket.readNodeIds ?? null,
    writeNodeIds: ticket.writeNodeIds ?? null,
    readPaths: ticket.readPaths,
    writePaths: ticket.writePaths,
    steps: ticket.steps.map((step) => ({
      readNodeIds: step.readNodeIds ?? null,
      writeNodeIds: step.writeNodeIds ?? null,
      readPaths: step.readPaths ?? null,
      writePaths: step.writePaths ?? null,
    })),
  });
  ticket.targetNodeIds = [...definition.target_node_ids];
  ticket.readNodeIds = [...definition.scope.read_node_ids];
  ticket.writeNodeIds = [...definition.scope.write_node_ids];
  ticket.readPaths = [...definition.scope.read_paths];
  ticket.writePaths = [...definition.scope.write_paths];
  for (const [index, step] of ticket.steps.entries()) {
    const compiled = definition.workflow[index]!;
    if (compiled.read_node_ids === undefined) delete step.readNodeIds;
    else step.readNodeIds = [...compiled.read_node_ids];
    if (compiled.write_node_ids === undefined) delete step.writeNodeIds;
    else step.writeNodeIds = [...compiled.write_node_ids];
    if (compiled.read_paths === undefined) delete step.readPaths;
    else step.readPaths = [...compiled.read_paths];
    if (compiled.write_paths === undefined) delete step.writePaths;
    else step.writePaths = [...compiled.write_paths];
  }
  const after = canonicalHash({
    targetNodeIds: ticket.targetNodeIds,
    readNodeIds: ticket.readNodeIds ?? null,
    writeNodeIds: ticket.writeNodeIds ?? null,
    readPaths: ticket.readPaths,
    writePaths: ticket.writePaths,
    steps: ticket.steps.map((step) => ({
      readNodeIds: step.readNodeIds ?? null,
      writeNodeIds: step.writeNodeIds ?? null,
      readPaths: step.readPaths ?? null,
      writePaths: step.writePaths ?? null,
    })),
  });
  return before !== after;
}

/**
 * A deterministic implement-asset id names the asset, not one immutable file manifest. If a later
 * approved graph change or repair request makes that asset actionable again, an old completed or
 * compiler-retired record is audit history rather than proof that the new obligation is met.
 * Reissue the same ticket in a fresh execution epoch while preserving its prior attempt ids.
 */
export function reopenCompletedRecurringAssetTicket(
  ticket: TicketRecord,
  definition: Pick<DerivedTicketDefinition, "operation_registry_id">,
  at: string,
  currentEpoch: number,
  reissueRequired = true,
): boolean {
  if (
    !reissueRequired ||
    !isSettledRecurringAssetTicket(ticket) ||
    ticket.operationId !== "asset-resolution.asset.implement-asset" ||
    definition.operation_registry_id !== ticket.operationId
  ) {
    return false;
  }
  ticket.executionEpoch = currentEpoch + 1;
  delete ticket.gitCycleId;
  ticket.worktreePath = undefined;
  ticket.branch = undefined;
  ticket.status = "queued";
  ticket.blocker = undefined;
  ticket.updatedAt = at;
  for (const step of ticket.steps) {
    step.status = "pending";
    step.summary = undefined;
    step.startedAt = undefined;
    step.completedAt = undefined;
  }
  if (ticket.reviewReworkCount !== undefined) ticket.reviewReworkCount = 0;
  if (ticket.reviewReworks !== undefined) ticket.reviewReworks = [];
  return true;
}

/**
 * A compiler bug can reissue a completed recurring asset even though its accepted manifest is
 * still current. Before any work starts in that empty epoch, restore the exact prior completed
 * epoch from its authenticated attempts instead of paying for the whole workflow again.
 */
export function restoreSettledRecurringAssetTicket(
  ticket: TicketRecord,
  definition: Pick<DerivedTicketDefinition, "operation_registry_id">,
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
  at: string,
  reissueRequired: boolean,
): boolean {
  if (
    reissueRequired ||
    ticket.status !== "queued" ||
    ticket.operationId !== "asset-resolution.asset.implement-asset" ||
    definition.operation_registry_id !== ticket.operationId ||
    ticket.gitCycleId !== undefined ||
    ticket.worktreePath !== undefined ||
    ticket.branch !== undefined ||
    ticket.steps.length === 0 ||
    ticket.steps.some((step) => step.status !== "pending")
  ) {
    return false;
  }
  const completedByStep = ticket.steps.map((step) =>
    step.attemptIds
      .map((attemptId) => attempts[attemptId])
      .filter(
        (attempt): attempt is AgentAttemptRecord & { ticketExecutionEpoch: number } =>
          attempt !== undefined &&
          attempt.ticketId === ticket.id &&
          attempt.stepId === step.id &&
          attempt.status === "completed" &&
          typeof attempt.ticketExecutionEpoch === "number" &&
          attempt.ticketExecutionEpoch < (ticket.executionEpoch ?? 0) &&
          attempt.terminalSummary !== undefined &&
          attempt.terminalSummary.trim().length > 0 &&
          (attempt.endedAt !== undefined || attempt.terminalAcceptedAt !== undefined),
      ),
  );
  if (completedByStep.some((candidates) => candidates.length === 0)) return false;
  const commonEpochs = completedByStep
    .slice(1)
    .reduce(
      (common, candidates) =>
        new Set(
          [...common].filter((epoch) =>
            candidates.some((candidate) => candidate.ticketExecutionEpoch === epoch),
          ),
        ),
      new Set(completedByStep[0]!.map((attempt) => attempt.ticketExecutionEpoch)),
    );
  const restoredEpoch = [...commonEpochs].sort((left, right) => right - left)[0];
  if (restoredEpoch === undefined) return false;
  ticket.executionEpoch = restoredEpoch;
  ticket.status = "completed";
  ticket.blocker = undefined;
  ticket.updatedAt = at;
  for (const [index, step] of ticket.steps.entries()) {
    const accepted = completedByStep[index]!.filter(
      (attempt) => attempt.ticketExecutionEpoch === restoredEpoch,
    ).at(-1)!;
    step.status = "completed";
    step.summary = accepted.terminalSummary;
    step.startedAt = accepted.startedAt;
    step.completedAt = accepted.endedAt ?? accepted.terminalAcceptedAt;
  }
  return true;
}

function compilerTicketExecutionEpoch(run: RunRecord, ticket: TicketRecord): number {
  if (ticket.executionEpoch !== undefined) return ticket.executionEpoch;
  const cycle =
    ticket.gitCycleId === undefined ? undefined : run.git.ticketCycles[ticket.gitCycleId];
  return Math.max(0, (cycle?.ordinal ?? 1) - 1);
}

function reconcileTickets(
  run: RunRecord,
  definitions: readonly DerivedTicketDefinition[],
  executionCatalog: CompiledExecutionSemanticCatalog,
  at: string,
  projectRoot: string,
  recurringAssetReissues?: ReadonlySet<string>,
  syntheticIntegrationOperationId?: string,
): Record<string, TicketRecord> {
  const tickets = structuredClone(run.tickets);
  const applicableIds = new Set(definitions.map((definition) => definition.id));
  routeSupersededGateRunProposals(tickets, definitions, at);
  const routedAssetRepairProposalIds = routablePlannedAssetRepairProposalIds(run, definitions);
  routePlannedAssetRepairProposals(tickets, routedAssetRepairProposalIds, at);
  for (const ticket of Object.values(tickets)) {
    // Target-conflict integration tickets are compiler-synthetic control work, not graph-rule
    // products. Preserve them across ordinary board reconciliation and repair the historical
    // cancellation produced by older compilers at an explicit resume boundary.
    if (ticket.operationId === syntheticIntegrationOperationId) {
      if (
        ticket.status === "cancelled" &&
        (ticket.blocker === COMPILER_SUPERSEDED_BEFORE_EXECUTION ||
          ticket.blocker === COMPILER_INAPPLICABLE_TICKET) &&
        ticket.steps.every((step) => step.status === "skipped")
      ) {
        ticket.status = "queued";
        ticket.blocker = undefined;
        ticket.updatedAt = at;
        for (const step of ticket.steps) {
          step.status = "pending";
          step.summary = undefined;
          step.startedAt = undefined;
          step.completedAt = undefined;
        }
      }
      continue;
    }
    // Change proposals are durable control-plane records projected from an accepted
    // source settlement, not ordinary rule-derived tickets. They can legitimately
    // be absent from the next compiler definition set while awaiting the operator's
    // decision or their approved application workflow. Cancelling one here loses
    // its only materialization path and strands the source hold.
    if (ticket.executionControl?.proposalRequest !== undefined) {
      if (routedAssetRepairProposalIds.has(ticket.id)) {
        continue;
      }
      // Repair records produced by an older compiler that cancelled a never-started
      // proposal during reconciliation. The source remains durably held by this
      // exact request, so re-arm only that same immutable proposal; do not invent
      // a replacement request or widen its authority.
      if (
        ticket.status === "cancelled" &&
        ticket.blocker === COMPILER_SUPERSEDED_BEFORE_EXECUTION &&
        Object.values(tickets).some(
          (source) => source.executionControl?.sourceHold?.proposalTicketId === ticket.id,
        ) &&
        ticket.steps.every((step) => step.status === "skipped" && step.attemptIds.length === 0)
      ) {
        ticket.status =
          ticket.executionControl.proposalApprovalSha256 === undefined ? "proposed" : "queued";
        ticket.blocker = undefined;
        ticket.updatedAt = at;
        for (const step of ticket.steps) step.status = "pending";
      }
      continue;
    }
    if (applicableIds.has(ticket.id) || !ticketIsNeverStarted(ticket)) continue;
    // Rules are predicates over the current compiler graph/evidence. If a later accepted effect
    // satisfies that predicate before a queued ticket starts, the queued work has ceased to
    // exist. Retaining it would run obsolete work from an older graph revision. Started tickets
    // remain pinned through retainedDefinitions so their already-issued workflow can settle.
    ticket.status = "cancelled";
    ticket.blocker = COMPILER_SUPERSEDED_BEFORE_EXECUTION;
    for (const step of ticket.steps) {
      if (step.status === "pending") step.status = "skipped";
    }
    ticket.updatedAt = at;
  }
  let dependencies: ReadonlyMap<string, readonly string[]>;
  try {
    // Compiler control tickets carry a hash-bound immutable projection. Their dependency list is
    // fixed when the compiler creates that control record; ordinary rule recompilation must not
    // rewrite it merely because the control ticket is already running. Doing so invalidates the
    // exact control-ticket authority before the resolver can settle its own graph repair.
    const retainedDependencies: RetainedTicketDependencyProjection[] = Object.values(tickets)
      .filter(
        (ticket) =>
          ticket.executionControl?.controlTicketAuthority === undefined &&
          !applicableIds.has(ticket.id) &&
          ticket.status !== "completed" &&
          ticket.status !== "cancelled" &&
          !ticketIsNeverStarted(ticket),
      )
      .map((ticket) => ({
        id: ticket.id,
        priority: ticket.priority,
        operationRegistryId: ticket.operationId,
        scope: {
          read_node_ids: [...(ticket.readNodeIds ?? [])],
          write_node_ids: [...(ticket.writeNodeIds ?? [])],
          read_paths: [...(ticket.readPaths ?? [])],
          write_paths: [...(ticket.writePaths ?? [])],
        },
      }));
    dependencies = deriveCompilerTicketDependencies(definitions, projectRoot, retainedDependencies);
    for (const retained of retainedDependencies) {
      tickets[retained.id]!.dependencyIds = [...(dependencies.get(retained.id) ?? [])];
    }
  } catch (error) {
    if (error instanceof TicketDependencyProjectionError) {
      fail("ticket_dependency_scope", error.message);
    }
    throw error;
  }
  for (const definition of definitions) {
    const semantic = resolveDefinitionExecutionBindings(executionCatalog, definition);
    const existing = tickets[definition.id];
    if (existing !== undefined) {
      reconcileNeverStartedTicketNodeScope(existing, definition);
      const recurringAssetReissueRequired = definition.target_node_ids.some(
        (nodeId) => recurringAssetReissues?.has(nodeId) ?? true,
      );
      if (existing.operationId === "asset-resolution.asset.implement-asset") {
        const cycle =
          existing.gitCycleId === undefined ? undefined : run.git.ticketCycles[existing.gitCycleId];
        if (existing.status === "completed" && cycle !== undefined && cycle.status !== "retired") {
          fail(
            "asset_reissue_git",
            `completed asset ticket ${existing.id} cannot reissue before its Git cycle retires`,
          );
        }
        refreshSettledRecurringAssetTicketGrant(
          existing,
          definition,
          recurringAssetReissueRequired,
        );
      }
      assertTicketDefinitionStable(existing, definition);
      restoreSettledRecurringAssetTicket(
        existing,
        definition,
        run.attempts,
        at,
        recurringAssetReissueRequired,
      );
      if (existing.operationId === "asset-resolution.asset.implement-asset") {
        reopenCompletedRecurringAssetTicket(
          existing,
          definition,
          at,
          compilerTicketExecutionEpoch(run, run.tickets[existing.id] ?? existing),
          recurringAssetReissueRequired,
        );
      }
      if (
        existing.status === "cancelled" &&
        existing.blocker === COMPILER_SUPERSEDED_BEFORE_EXECUTION &&
        existing.steps.every((step) => step.status === "skipped" && step.attemptIds.length === 0)
      ) {
        const operation = executionCatalog.operations[definition.operation_registry_id];
        if (operation === undefined) {
          fail(
            "execution_policy_operation",
            `derived ticket ${definition.id} references unknown operation ${definition.operation_registry_id}`,
          );
        }
        existing.status = operation.changeControl.role === "proposal" ? "proposed" : "queued";
        existing.blocker = undefined;
        existing.updatedAt = at;
        for (const step of existing.steps) step.status = "pending";
      }
      const semanticExisting = existing as SemanticTicketRecord;
      assertOrBackfillExecutionPolicyBinding(
        semanticExisting,
        semantic.ticket,
        `ticket ${definition.id}`,
      );
      for (const [index, step] of existing.steps.entries()) {
        const compiled = definition.workflow[index]!;
        const stepBinding = semantic.steps.get(compiled.id);
        if (stepBinding === undefined)
          fail(
            "execution_policy_step",
            `ticket ${definition.id} has no semantic binding for ${compiled.id}`,
          );
        assertOrBackfillExecutionPolicyBinding(
          step,
          stepBinding,
          `ticket ${definition.id} step ${compiled.id}`,
        );
        step.kind ??= compiled.kind;
        step.dependsOn ??= [...compiled.depends_on];
        if (compiled.read_node_ids !== undefined) step.readNodeIds ??= [...compiled.read_node_ids];
        if (compiled.write_node_ids !== undefined)
          step.writeNodeIds ??= [...compiled.write_node_ids];
        if (compiled.read_paths !== undefined) step.readPaths ??= [...compiled.read_paths];
        if (compiled.write_paths !== undefined) step.writePaths ??= [...compiled.write_paths];
        if (compiled.validation_action !== undefined)
          step.validationAction ??= compiled.validation_action;
      }
      existing.dependencyIds = [...(dependencies.get(definition.id) ?? [])];
      existing.readNodeIds ??= [...definition.scope.read_node_ids];
      existing.writeNodeIds ??= [...definition.scope.write_node_ids];
      if (definition.review_failure_reopen_from !== undefined) {
        existing.reviewFailureReopenFrom ??= definition.review_failure_reopen_from;
        existing.reviewReworkLimit ??= 1;
        existing.reviewReworkCount ??= 0;
        existing.reviewReworks ??= [];
      }
      continue;
    }
    if (definition.workflow.length === 0)
      fail("ticket_workflow", `derived ticket ${definition.id} has no executable workflow`);
    const operation = executionCatalog.operations[definition.operation_registry_id];
    if (operation === undefined) {
      fail(
        "execution_policy_operation",
        `derived ticket ${definition.id} references unknown operation ${definition.operation_registry_id}`,
      );
    }
    const ticket: SemanticTicketRecord = {
      id: definition.id,
      operationId: definition.operation_registry_id,
      executionPolicyBinding: semantic.ticket,
      title: definition.title,
      summary: `${definition.operation}: ${definition.title}`,
      status: operation.changeControl.role === "proposal" ? "proposed" : "queued",
      priority: -(definition.rule_priority * 1_000 + definition.operation_dispatch_priority),
      dependencyIds: [...(dependencies.get(definition.id) ?? [])],
      targetNodeIds: [...definition.target_node_ids],
      readNodeIds: [...definition.scope.read_node_ids],
      writeNodeIds: [...definition.scope.write_node_ids],
      readPaths: [...definition.scope.read_paths],
      writePaths: [...definition.scope.write_paths],
      steps: definition.workflow.map((step) => ({
        id: step.id,
        title: humanize(step.id),
        personaId: step.persona_id,
        executionPolicyBinding: semantic.steps.get(step.id)!,
        kind: step.kind,
        dependsOn: [...step.depends_on],
        ...(step.read_node_ids === undefined ? {} : { readNodeIds: [...step.read_node_ids] }),
        ...(step.write_node_ids === undefined ? {} : { writeNodeIds: [...step.write_node_ids] }),
        ...(step.read_paths === undefined ? {} : { readPaths: [...step.read_paths] }),
        ...(step.write_paths === undefined ? {} : { writePaths: [...step.write_paths] }),
        ...(step.validation_action === undefined
          ? {}
          : { validationAction: step.validation_action }),
        status: "pending",
        attemptIds: [],
        summary: undefined,
        startedAt: undefined,
        completedAt: undefined,
      })),
      ...(definition.review_failure_reopen_from === undefined
        ? {}
        : {
            reviewFailureReopenFrom: definition.review_failure_reopen_from,
            reviewReworkLimit: 1,
            reviewReworkCount: 0,
            reviewReworks: [],
          }),
      worktreePath: undefined,
      branch: undefined,
      blocker: undefined,
      createdAt: at,
      updatedAt: at,
    };
    tickets[definition.id] = ticket;
  }
  return Object.fromEntries(
    Object.entries(tickets).sort(([left], [right]) => compareText(left, right)),
  );
}

export function assertTicketDefinitionStable(
  ticket: TicketRecord,
  definition: DerivedTicketDefinition,
): void {
  // A started ticket's issued workflow settles under the node scope it was issued with. Its own
  // accepted graph effects legitimately change what the rules re-derive for the same deterministic
  // id (observed live: a delivery-node graphDelta added the new node to its submitting ticket's
  // derived node scope, and this guard rejected the whole delta as drift — making the assembly
  // step unsatisfiable). Tolerate node-scope drift for started tickets. A derived title is display
  // text copied from the target node and carries no grant authority, so title-only drift is also
  // harmless; operation, workflow, and path drift remain fatal for every ticket.
  //
  // Path drift is deliberately NOT tolerated here, and an attempt to relax it made things worse.
  // A derived read path can change while an attempt is in flight (`ticket.implement-asset` grants
  // `spec.support_paths`, and gate-context paths join the descriptor once the asset becomes a
  // gate's selected provider). Failing here compensates the assignment and reissues the step with
  // a freshly derived grant, which recovers. Letting it pass instead defers the mismatch to grant
  // recovery, where the pinned `grantHash` cannot be reproduced — turning a self-healing
  // compensation into a hard `stored launch authority no longer matches pinned compiler scope`
  // block. The one explicit exception is handled before this assertion: a settled recurring asset
  // whose prior Git cycle has retired may receive the compiler's current grant before a required
  // fresh epoch opens. Its accepted attempts retain their original immutable launch specs.
  const pinnedNodeScope = !ticketIsNeverStarted(ticket);
  const nodeScopeDrift =
    !pinnedNodeScope &&
    (canonicalHash(ticket.targetNodeIds) !== canonicalHash(definition.target_node_ids) ||
      (ticket.readNodeIds !== undefined &&
        canonicalHash(ticket.readNodeIds) !== canonicalHash(definition.scope.read_node_ids)) ||
      (ticket.writeNodeIds !== undefined &&
        canonicalHash(ticket.writeNodeIds) !== canonicalHash(definition.scope.write_node_ids)) ||
      ticket.steps.some(
        (step, index) =>
          (step.readNodeIds !== undefined &&
            canonicalHash(step.readNodeIds) !==
              canonicalHash(
                definition.workflow[index]!.read_node_ids ?? definition.scope.read_node_ids,
              )) ||
          (step.writeNodeIds !== undefined &&
            canonicalHash(step.writeNodeIds) !==
              canonicalHash(
                definition.workflow[index]!.write_node_ids ?? definition.scope.write_node_ids,
              )),
      ));
  if (
    nodeScopeDrift ||
    ticket.operationId !== definition.operation_registry_id ||
    canonicalHash(ticket.readPaths) !== canonicalHash(definition.scope.read_paths) ||
    canonicalHash(ticket.writePaths) !== canonicalHash(definition.scope.write_paths) ||
    canonicalHash(ticket.steps.map((step) => [step.id, step.personaId])) !==
      canonicalHash(definition.workflow.map((step) => [step.id, step.persona_id])) ||
    ticket.steps.some(
      (step, index) =>
        (step.kind !== undefined && step.kind !== definition.workflow[index]!.kind) ||
        (step.dependsOn !== undefined &&
          canonicalHash(step.dependsOn) !==
            canonicalHash(definition.workflow[index]!.depends_on)) ||
        (step.readPaths !== undefined &&
          canonicalHash(step.readPaths) !==
            canonicalHash(definition.workflow[index]!.read_paths ?? definition.scope.read_paths)) ||
        (step.writePaths !== undefined &&
          canonicalHash(step.writePaths) !==
            canonicalHash(
              definition.workflow[index]!.write_paths ?? definition.scope.write_paths,
            )) ||
        (step.validationAction !== undefined &&
          step.validationAction !== definition.workflow[index]!.validation_action),
    ) ||
    (ticket.reviewFailureReopenFrom !== undefined &&
      ticket.reviewFailureReopenFrom !== definition.review_failure_reopen_from)
  )
    fail(
      "ticket_definition_drift",
      `ticket ${ticket.id} changed under the same deterministic identity`,
    );
}

/**
 * A queued ticket is a projection of the current compiler graph until authority issues its first
 * attempt. Dynamic selectors may legitimately add or remove nodes from that projection while
 * sibling graph work settles. Refresh only that unissued node scope; once work starts, the durable
 * grant and per-node CAS remain pinned to the exact scope the agent received.
 */
export function reconcileNeverStartedTicketNodeScope(
  ticket: TicketRecord,
  definition: DerivedTicketDefinition,
): boolean {
  if (!ticketIsNeverStarted(ticket)) return false;
  const scopeHash = (): Sha256Digest =>
    canonicalHash({
      targetNodeIds: ticket.targetNodeIds,
      readNodeIds: ticket.readNodeIds ?? null,
      writeNodeIds: ticket.writeNodeIds ?? null,
      steps: ticket.steps.map((step) => ({
        id: step.id,
        readNodeIds: step.readNodeIds ?? null,
        writeNodeIds: step.writeNodeIds ?? null,
      })),
    });
  const before = scopeHash();
  ticket.targetNodeIds = [...definition.target_node_ids];
  ticket.readNodeIds = [...definition.scope.read_node_ids];
  ticket.writeNodeIds = [...definition.scope.write_node_ids];
  for (const [index, step] of ticket.steps.entries()) {
    const compiled = definition.workflow[index];
    if (compiled === undefined) continue;
    if (compiled.read_node_ids === undefined) delete step.readNodeIds;
    else step.readNodeIds = [...compiled.read_node_ids];
    if (compiled.write_node_ids === undefined) delete step.writeNodeIds;
    else step.writeNodeIds = [...compiled.write_node_ids];
  }
  return before !== scopeHash();
}

function runRootContextId(runId: string): string {
  return `run-root-${digestBody(canonicalHash(runId)).slice(0, 20)}`;
}

function assertContextualAuthorityBinding(
  run: RunRecord,
  semanticRevision: number,
  contextual: GraphContextualState,
): void {
  if (
    contextual.runRootId !== runRootContextId(run.id) ||
    (run.workingSpecOwnerId !== undefined && contextual.ownerPersonaId !== run.workingSpecOwnerId)
  ) {
    fail(
      "graph_contextual_binding",
      "durable contextual graph owner or stable run root differs from the run record",
    );
  }
  for (const record of Object.values(contextual.records)) {
    if (
      record.runId !== run.id ||
      record.generation > run.generation ||
      record.provenance.semanticRevision > semanticRevision ||
      record.provenance.contextualRevision >= contextual.revision
    ) {
      fail(
        "graph_contextual_binding",
        `contextual record ${record.id} is not bound to this durable run epoch`,
      );
    }
  }
  if (run.workingSpecOwnerId === undefined && contextual.canonicalWorkingSpecId !== undefined) {
    fail(
      "working_spec_owner_drift",
      "canonical working specification has no owner pinned in the run record",
    );
  }
  if (
    semanticRevision > 0 &&
    run.workingSpecOwnerId !== undefined &&
    contextual.canonicalWorkingSpecId === undefined
  ) {
    fail("working_spec_missing", "approved semantic graph has no canonical working-spec baseline");
  }
}

function initialGraphArtifact(
  runId: string,
  configuration: CompiledConfiguration,
  ownerPersonaId: string,
  projectRoot: string,
): GraphArtifact {
  const graph = new TypedGraph(requireGraphSchema(configuration), [], { projectRoot });
  assertConfiguredGraphConstraints(configuration, graph, projectRoot);
  return {
    protocol: GRAPH_ARTIFACT_PROTOCOL,
    runId,
    revision: 0,
    semanticRevision: 0,
    configurationSha256: configuration.configuration_sha256,
    graphSha256: graph.hash,
    semanticSha256: graph.hash,
    nodes: graph.toJSON(),
    ...contextualArtifactFields(
      createGraphContextualState(runRootContextId(runId), ownerPersonaId),
    ),
  };
}

function appendContextualRecord(
  prior: GraphContextualState,
  record: GraphContextualRecord,
  links: readonly GraphContextualLink[],
  update: { canonicalWorkingSpecId?: string; ownerPersonaId?: string } = {},
): GraphContextualState {
  if (prior.records[record.id] !== undefined) {
    fail("contextual_record_exists", `contextual graph record ${record.id} already exists`);
  }
  if (
    record.provenance.contextualRevision !== prior.revision ||
    record.provenance.contextualHash !== prior.hash
  ) {
    fail(
      "contextual_record_cas",
      `contextual graph record ${record.id} is not based on the current contextual epoch`,
    );
  }
  const records = structuredClone(prior.records);
  records[record.id] = structuredClone(record);
  if (Object.keys(records).length > MAX_GRAPH_NOTES) {
    fail("contextual_record_limit", `run contextual record inventory exceeds ${MAX_GRAPH_NOTES}`);
  }
  const allLinks = [...structuredClone(prior.links), ...structuredClone(links)].sort(
    (left, right) =>
      compareText(left.sourceId, right.sourceId) ||
      compareText(left.relation, right.relation) ||
      compareText(left.targetKind, right.targetKind) ||
      compareText(left.targetId, right.targetId),
  );
  const next = sealGraphContextualState({
    protocol: prior.protocol,
    revision: prior.revision + 1,
    runRootId: prior.runRootId,
    ...((update.ownerPersonaId ?? prior.ownerPersonaId) === undefined
      ? {}
      : { ownerPersonaId: update.ownerPersonaId ?? prior.ownerPersonaId }),
    ...((update.canonicalWorkingSpecId ?? prior.canonicalWorkingSpecId) === undefined
      ? {}
      : { canonicalWorkingSpecId: update.canonicalWorkingSpecId ?? prior.canonicalWorkingSpecId }),
    records,
    links: allLinks,
  });
  if (Buffer.byteLength(canonicalEncode(next), "utf8") > MAX_RUN_GRAPH_BYTES - 1024 * 1024) {
    fail("contextual_graph_size", "contextual graph state exceeds its durable artifact bound");
  }
  return next;
}

function graphArtifact(
  run: RunRecord,
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  revision: number,
  contextual?: GraphContextualState,
): GraphArtifact {
  return {
    protocol: GRAPH_ARTIFACT_PROTOCOL,
    runId: run.id,
    revision,
    semanticRevision: revision,
    configurationSha256: configuration.configuration_sha256,
    graphSha256: graph.hash,
    semanticSha256: graph.hash,
    nodes: graph.toJSON(),
    ...(contextual === undefined ? {} : contextualArtifactFields(contextual)),
  };
}

function contextualArtifactFields(contextual: GraphContextualState): {
  contextual: GraphContextualState;
  contextualRevision: number;
  contextualSha256: Sha256Digest;
} {
  return {
    contextual: structuredClone(contextual),
    contextualRevision: contextual.revision,
    contextualSha256: contextual.hash,
  };
}

function parseGraphArtifact(bytes: Buffer): GraphArtifact {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUN_GRAPH_BYTES || bytes.includes(0)) {
    fail("graph_artifact_size", "graph artifact is empty, oversized, or contains NUL");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("graph_artifact_json", "graph artifact is not valid JSON");
  }
  if (
    !isRecord(value) ||
    value.protocol !== GRAPH_ARTIFACT_PROTOCOL ||
    typeof value.runId !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    !isSha256Digest(value.configurationSha256) ||
    !isSha256Digest(value.graphSha256) ||
    !isRecord(value.nodes)
  ) {
    fail("graph_artifact_shape", "graph artifact has an unsupported shape");
  }
  const artifact = value as unknown as GraphArtifact;
  if (
    (artifact.semanticRevision !== undefined && artifact.semanticRevision !== artifact.revision) ||
    (artifact.semanticSha256 !== undefined && artifact.semanticSha256 !== artifact.graphSha256)
  )
    fail(
      "graph_artifact_semantic_alias",
      "graph artifact semantic aliases disagree with legacy fields",
    );
  if (
    artifact.contextual === undefined
      ? artifact.contextualRevision !== undefined || artifact.contextualSha256 !== undefined
      : (artifact.contextualRevision !== undefined || artifact.contextualSha256 !== undefined) &&
        (artifact.contextualRevision !== artifact.contextual.revision ||
          artifact.contextualSha256 !== artifact.contextual.hash)
  )
    fail(
      "graph_artifact_contextual_alias",
      "graph artifact contextual aliases disagree with contextual state",
    );
  if (artifact.contextual !== undefined) {
    try {
      validateGraphContextualState(artifact.contextual);
    } catch (error) {
      fail("graph_contextual_state", error instanceof Error ? error.message : String(error));
    }
  }
  return artifact;
}

function ticketArtifact(
  run: RunRecord,
  graphRevision: number,
  evaluation: CompiledRuleEvaluation,
  prior?: TicketDefinitionsArtifact,
): TicketDefinitionsArtifact {
  const applicableIds = new Set(evaluation.tickets.map((definition) => definition.id));
  const retainedById = new Map<string, DerivedTicketDefinition>();
  for (const definition of [
    ...(prior?.evaluation.tickets ?? []),
    ...(prior?.retainedDefinitions ?? []),
  ]) {
    const ticket = run.tickets[definition.id];
    if (
      applicableIds.has(definition.id) ||
      ticket === undefined ||
      ticket.status === "completed" ||
      ticket.status === "cancelled" ||
      ticketIsNeverStarted(ticket)
    )
      continue;
    retainedById.set(definition.id, structuredClone(definition));
  }
  const retainedDefinitions = [...retainedById.values()].sort((left, right) =>
    compareText(left.id, right.id),
  );
  return {
    protocol: TICKET_ARTIFACT_PROTOCOL,
    runId: run.id,
    graphRevision,
    evaluation,
    ...(retainedDefinitions.length === 0 ? {} : { retainedDefinitions }),
  };
}

function ticketIsNeverStarted(ticket: Readonly<TicketRecord>): boolean {
  return (
    new Set<TicketRecord["status"]>(["proposed", "queued"]).has(ticket.status) &&
    ticket.worktreePath === undefined &&
    ticket.branch === undefined &&
    ticket.gitCycleId === undefined &&
    ticket.steps.every(
      (step) =>
        step.status === "pending" &&
        step.attemptIds.length === 0 &&
        step.startedAt === undefined &&
        step.completedAt === undefined,
    )
  );
}

function ticketDefinitionFromArtifact(
  artifact: TicketDefinitionsArtifact,
  ticketId: string,
): DerivedTicketDefinition | undefined {
  return (
    artifact.evaluation.tickets.find((definition) => definition.id === ticketId) ??
    artifact.retainedDefinitions?.find((definition) => definition.id === ticketId)
  );
}

function requireGraphSchema(configuration: CompiledConfiguration): GraphSchema {
  const definition = requireValidation(
    projectGraphSchemaDefinition(configuration),
    "graph_schema_invalid",
    "compiled profile graph schema is invalid",
  );
  return new GraphSchema(definition);
}

function requireExecutionSemanticCatalog(
  configuration: CompiledConfiguration,
): CompiledExecutionSemanticCatalog {
  try {
    return compileExecutionSemanticCatalog(configuration);
  } catch (error) {
    fail(
      "execution_semantics_invalid",
      error instanceof Error ? error.message : "pinned execution semantics did not compile",
    );
  }
}

function assertConfiguredGraphConstraints(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  projectRoot: string,
): void {
  try {
    validateConfiguredGraphConstraints(configuration, graph, projectRoot);
  } catch (error) {
    if (error instanceof GraphValidationError) {
      fail(
        "graph_constraint_invalid",
        "semantic graph violates its compiled whole-graph constraints",
        error.diagnostics,
      );
    }
    throw error;
  }
}

/**
 * A planning checkpoint may name repository inputs only when the compiler can bind them to the
 * exact planning checkout or to authority that the same checkpoint grants to create them. This
 * catches copied or invented paths before approval while preserving ordinary planned outputs.
 */
export async function assertPlanningRepositoryPaths(
  projectRoot: string,
  definitions: readonly DerivedTicketDefinition[],
): Promise<void> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(projectRoot);
  } catch {
    fail("planning_workspace", "planning repository checkout is not durably readable");
  }
  const authority = createProjectPathAuthority(canonicalRoot!);
  let dependencies: ReadonlyMap<string, readonly string[]>;
  try {
    dependencies = deriveCompilerTicketDependencies(definitions, canonicalRoot!);
  } catch (error) {
    fail("planning_repository_path", "planning graph repository paths cannot be ordered safely", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const orderedDefinitions = [...definitions].sort((left, right) => compareText(left.id, right.id));
  const definitionsById = new Map(
    orderedDefinitions.map((definition) => [definition.id, definition]),
  );
  const workflowScopesByDefinitionId = new Map(
    orderedDefinitions.map((definition) => [definition.id, planningWorkflowPathScopes(definition)]),
  );
  const missing = new Set<string>();
  for (const definition of orderedDefinitions) {
    const steps = workflowScopesByDefinitionId.get(definition.id)!;
    const predecessorSteps = workflowPredecessors(definition.workflow);
    for (const reader of steps) {
      for (const readPath of reader.readPaths) {
        if (await planningRepositoryPathExists(canonicalRoot!, readPath)) continue;
        let planned = false;
        try {
          planned = reader.writePaths.some((writePath) =>
            authority.pathsOverlap(readPath, writePath),
          );
          if (!planned) {
            planned = steps.some(
              (writer) =>
                predecessorSteps.get(reader.id)?.has(writer.id) === true &&
                writer.writePaths.some((writePath) => authority.pathsOverlap(readPath, writePath)),
            );
          }
          if (!planned) {
            planned = (dependencies!.get(definition.id) ?? []).some((writerId) => {
              const writer = definitionsById.get(writerId);
              return (
                writer !== undefined &&
                workflowScopesByDefinitionId
                  .get(writer.id)!
                  .some((writerStep) =>
                    writerStep.writePaths.some((writePath) =>
                      authority.pathsOverlap(readPath, writePath),
                    ),
                  )
              );
            });
          }
        } catch (error) {
          fail(
            "planning_repository_path",
            "planning graph repository paths cannot be resolved safely",
            [error instanceof Error ? error.message : String(error)],
          );
        }
        if (!planned) missing.add(readPath);
      }
    }
  }
  if (missing.size === 0) return;
  const sortedMissing = [...missing].sort(compareText);
  const bounded = sortedMissing
    .slice(0, 64)
    .map(
      (value) =>
        `${value} does not exist in the planning checkout and no derived write scope can create it`,
    );
  if (sortedMissing.length > bounded.length) {
    bounded.push(
      `${sortedMissing.length - bounded.length} additional unresolved read path(s) omitted`,
    );
  }
  fail(
    "planning_repository_path",
    "planning graph derives repository reads that are neither authenticated inputs nor planned outputs",
    bounded,
  );
}

interface PlanningWorkflowPathScope {
  readonly id: string;
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
}

function planningWorkflowPathScopes(
  definition: DerivedTicketDefinition,
): readonly PlanningWorkflowPathScope[] {
  if (definition.workflow.length === 0) {
    return [
      {
        id: definition.id,
        readPaths: normalizePlanningPaths(definition.scope.read_paths, "read"),
        writePaths: normalizePlanningPaths(definition.scope.write_paths, "write"),
      },
    ];
  }
  return definition.workflow.map((step) => {
    const writePaths = normalizePlanningPaths(
      step.write_paths ?? definition.scope.write_paths,
      "write",
    );
    return {
      id: step.id,
      readPaths: normalizePlanningPaths(step.read_paths ?? definition.scope.read_paths, "read"),
      writePaths: step.kind === "review" ? [] : writePaths,
    };
  });
}

function workflowPredecessors(
  workflow: readonly DerivedWorkflowStep[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const direct = new Map(workflow.map((step) => [step.id, new Set(step.depends_on)]));
  const predecessors = new Map<string, ReadonlySet<string>>();
  const visit = (stepId: string, visiting = new Set<string>()): ReadonlySet<string> => {
    const cached = predecessors.get(stepId);
    if (cached !== undefined) return cached;
    if (visiting.has(stepId)) return new Set();
    const nextVisiting = new Set(visiting).add(stepId);
    const result = new Set<string>();
    for (const dependencyId of direct.get(stepId) ?? []) {
      result.add(dependencyId);
      for (const ancestorId of visit(dependencyId, nextVisiting)) result.add(ancestorId);
    }
    predecessors.set(stepId, result);
    return result;
  };
  for (const step of workflow) visit(step.id);
  return predecessors;
}

function normalizePlanningPaths(values: readonly string[], kind: "read" | "write"): string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    try {
      normalized.add(normalizeProjectRelativePath(value));
    } catch (error) {
      fail(
        "planning_repository_path",
        `planning graph derives an invalid repository ${kind} path`,
        [error instanceof Error ? error.message : String(error)],
      );
    }
  }
  return [...normalized].sort(compareText);
}

async function planningRepositoryPathExists(root: string, relativePath: string): Promise<boolean> {
  if (relativePath === ".") return true;
  let current = root;
  for (const component of relativePath.split("/")) {
    current = path.join(current, component);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
    if (metadata.isSymbolicLink()) return false;
  }
  const canonical = await realpath(current).catch(() => undefined);
  return canonical !== undefined && isWithinDirectory(root, canonical);
}

/**
 * An executable gate contract is semantic authority for one exact typed gate. A mnemonic or
 * script-local key is not a harmless metadata label: gate selection and verifier execution both
 * address this map by graph node id. Require the corresponding canonical relationship as the
 * independently inspectable graph binding.
 */
export function assertAssetGateContractsBoundToGraph(
  graph: Pick<TypedGraph, "nodes">,
  gateNodeTypes: readonly string[],
  candidateNodeIds?: readonly string[],
): void {
  const typedGateTypes = new Set(gateNodeTypes);
  const typedGateIds = new Set(
    graph
      .nodes()
      .filter((node) => typedGateTypes.has(node.type))
      .map((node) => node.id),
  );
  const candidates = candidateNodeIds === undefined ? undefined : new Set(candidateNodeIds);
  for (const node of graph.nodes()) {
    if (candidates !== undefined && !candidates.has(node.id)) continue;
    const contracts = optionalRecord(node.spec.gate_contracts);
    if (contracts === undefined) continue;
    const validates = new Set(node.edges.validates ?? []);
    for (const gateId of Object.keys(contracts).sort(compareText)) {
      if (!typedGateIds.has(gateId)) {
        fail(
          "asset_gate_contract_target",
          `asset ${node.id} gate contract ${gateId} must bind an exact typed gate node`,
        );
      }
      if (!validates.has(gateId)) {
        fail(
          "asset_gate_contract_relationship",
          `asset ${node.id} gate contract ${gateId} requires a canonical validates relationship`,
        );
      }
    }
  }
}

function typedGateIdentityCatalog(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
): { gateNodeTypes: readonly string[]; gateNodes: readonly { id: string; type: string }[] } {
  const policies = requireValidation(
    projectGatePolicyDefinitions(configuration),
    "gate_policy_invalid",
    "pinned gate policies did not compile",
  );
  const gateNodeTypes = [...new Set(policies.flatMap((policy) => policy.gateNodeTypes))].sort(
    compareText,
  );
  const typed = new Set(gateNodeTypes);
  return {
    gateNodeTypes,
    gateNodes: graph
      .nodes()
      .filter((node) => typed.has(node.type))
      .map((node) => ({ id: node.id, type: node.type }))
      .sort((left, right) => compareText(left.id, right.id)),
  };
}

function materializedNodeChanges(
  before: TypedGraph,
  after: TypedGraph,
  delta: GraphDelta,
): MaterializedNodeChange[] {
  // GraphSchema may materialize inverse/bidirectional edge changes on nodes not named as the
  // delta source. Compare the complete bounded graph states so operation policy sees those exact
  // semantic effects rather than trusting the model-authored mutation list.
  const candidateIds = new Set([
    ...before.nodes().map((node) => node.id),
    ...after.nodes().map((node) => node.id),
    ...delta.upsertNodes.map((mutation) => mutation.node.id),
    ...delta.deleteNodes.map((mutation) => mutation.id),
    ...delta.addEdges.flatMap((edge) => [edge.source, edge.target]),
    ...delta.removeEdges.flatMap((edge) => [edge.source, edge.target]),
  ]);
  return [...candidateIds].sort(compareText).flatMap((id) => {
    const oldNode = before.node(id) ?? null;
    const newNode = after.node(id) ?? null;
    if (canonicalHash(oldNode) === canonicalHash(newNode)) return [];
    return [{ before: oldNode, after: newNode }];
  });
}

function launchResources(
  pinned: PinnedConfigurationArtifact,
  skillIds: readonly string[],
  runInstructions: string,
): LaunchResource[] {
  const resources: LaunchResource[] = [];
  const selectedSkillIds = [...new Set(skillIds)].sort(compareText);
  for (const id of selectedSkillIds) {
    const skill = pinned.skills[id];
    if (skill === undefined) fail("skill_unpinned", `persona requested unpinned skill ${id}`);
    for (const [relativePath, file] of Object.entries(skill.files).sort(([left], [right]) =>
      compareText(left, right),
    )) {
      const resourceId =
        relativePath === "SKILL.md"
          ? `skill-${id}`
          : `skill-${id}-${digestBody(rawSha256(relativePath)).slice(0, 16)}`;
      resources.push(resource("skill", resourceId, `skills/${id}/${relativePath}`, file.content));
    }
  }
  if (runInstructions.trim().length > 0) {
    resources.push(
      resource(
        "append_system_prompt",
        "run-instructions",
        "prompts/run-instructions.md",
        runInstructions.trim(),
      ),
    );
  }
  return resources.sort((left, right) =>
    compareText(`${left.id}\0${left.relativePath}`, `${right.id}\0${right.relativePath}`),
  );
}

function resource(
  kind: LaunchResource["kind"],
  id: string,
  relativePath: string,
  content: string,
): LaunchResource {
  return {
    kind,
    id,
    relativePath,
    content,
    sha256: rawSha256(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function toolInventory(
  run: RunRecord,
  descriptor: AttemptDescriptor,
  resources: readonly LaunchResource[],
): KoniToolName[] {
  if (descriptor.toolProfile === "lead_judgment") {
    const exact = new Set<KoniToolName>(["koni_submit_output"]);
    if ((run.executionConfig?.questionPolicy ?? "some") !== "none") exact.add("koni_ask_question");
    return KONI_TOOL_NAMES.filter((name) => exact.has(name));
  }
  // The managed Pi context hook reissues the complete immutable assignment and current dynamic
  // graph projection before every provider request. Exposing a second full-context read tool to
  // contained agents only duplicates tens of thousands of input tokens and can exhaust a review
  // budget without adding authority or information. The catalog entry remains available to the
  // interactive package, but autonomous launch inventories intentionally omit it.
  const names = new Set<KoniToolName>();
  if (resources.some((entry) => entry.kind === "prompt" || entry.kind === "skill")) {
    names.add("koni_read_resource");
  }
  if (descriptor.graph !== undefined) names.add("koni_graph_context");
  if ((descriptor.step?.validation_checks.length ?? 0) > 0) names.add("koni_run_check");
  if (descriptor.readPaths.length > 0) {
    names.add("koni_read_file");
    names.add("koni_list_files");
    names.add("koni_search_files");
  }
  if (descriptor.writePaths.length > 0) {
    names.add("koni_write_file");
    names.add("koni_edit_file");
  }
  // Contextual notes do not grant semantic graph authority; every managed persona may append one
  // to a compiler-visible node or the stable run root.
  names.add("koni_record_note");
  if (run.workingSpecOwnerId === descriptor.personaId) names.add("koni_update_working_spec");
  if ((run.executionConfig?.questionPolicy ?? "some") !== "none") names.add("koni_ask_question");
  names.add("koni_submit_output");
  return KONI_TOOL_NAMES.filter((name) => names.has(name));
}

function requireKoniToolName(value: string): KoniToolName {
  if (!(KONI_TOOL_NAMES as readonly string[]).includes(value)) {
    fail("recovery_tool", `stored launch spec names unknown Koni tool ${value}`);
  }
  return value as KoniToolName;
}

function assertRecoveryIdentity(
  run: RunRecord,
  attempt: AgentAttemptRecord,
  spec: Readonly<AgentLaunchSpec>,
): void {
  const planningSession = run.planningSession;
  const launchSpecHash =
    planningSession?.attemptId === attempt.id
      ? planningSession.revisions[planningSession.currentRevision]?.launchSpecSha256
      : attempt.launchSpecHash;
  if (
    launchSpecHash !== spec.specHash ||
    spec.identity.runId !== run.id ||
    spec.identity.attemptId !== attempt.id ||
    spec.identity.sessionId !== attempt.sessionId ||
    spec.identity.ticketId !== attempt.ticketId ||
    spec.identity.stepId !== attempt.stepId ||
    spec.persona.id !== attempt.personaId ||
    spec.authority.generation !== run.generation
  )
    fail("recovery_identity", "stored launch spec does not match its durable attempt record");
}

function recoveredPlanningRevisionContext(
  spec: Readonly<AgentLaunchSpec>,
  compilerInput: Readonly<PreparedAttemptArtifact>,
): PlanningRevisionPreparationContext {
  const binding = spec.planningRevision;
  if (binding === undefined) {
    fail("recovery_planning_revision", "continuous planning recovery lost its revision binding");
  }
  if (binding.revision === 0) {
    return { binding: structuredClone(binding) };
  }
  let contextValue: unknown;
  try {
    contextValue = JSON.parse(compilerInput.contextContent);
  } catch {
    fail("recovery_planning_revision", "planning revision context is not valid JSON");
  }
  if (
    !isRecord(contextValue) ||
    canonicalHash(contextValue.planningRevision) !== canonicalHash(binding) ||
    typeof contextValue.steering !== "string" ||
    rawSha256(contextValue.steering) !== binding.steeringSha256
  ) {
    fail(
      "recovery_planning_revision",
      "planning revision context differs from its immutable launch binding",
    );
  }
  const currentArtifact = planningArtifactBoundary(() =>
    parsePlanningArtifact(contextValue.currentValidatedArtifact),
  );
  if (canonicalHash(currentArtifact) !== binding.priorCheckpointSha256) {
    fail(
      "recovery_planning_revision",
      "planning revision artifact differs from its immutable base checkpoint",
    );
  }
  return {
    binding: structuredClone(binding),
    currentArtifact,
    steering: contextValue.steering,
  };
}

function recoveredAttemptKind(
  run: RunRecord,
  attempt: AgentAttemptRecord,
): "planning" | "lead" | "ticket" | "verification" | "integration" {
  if (attempt.kind !== undefined) return attempt.kind;
  if (attempt.ticketId === "run-orchestration" && attempt.stepId.startsWith("lead-")) return "lead";
  if (attempt.ticketId === "run-planning") return "planning";
  if (attempt.ticketId === "run-verification") return "verification";
  if (run.tickets[attempt.ticketId]?.id.startsWith("TK-integration-") === true)
    return "integration";
  return "ticket";
}

function isRunWideVerificationAttempt(attempt: AgentAttemptRecord): boolean {
  return attempt.kind === "verification" && attempt.ticketId === "run-verification";
}

function recordedAttemptWorkspaceKind(
  attempt: AgentAttemptRecord,
): "planning" | "lead" | "ticket" | "verification" | "integration" {
  const kind =
    attempt.kind ??
    (attempt.ticketId === "run-planning"
      ? "planning"
      : attempt.ticketId === "run-orchestration" && attempt.stepId.startsWith("lead-")
        ? "lead"
        : attempt.ticketId === "run-verification"
          ? "verification"
          : "ticket");
  return kind === "verification" && !isRunWideVerificationAttempt(attempt) ? "ticket" : kind;
}

function assignmentFromAttempt(run: RunRecord, attempt: AgentAttemptRecord): ReadyAssignment {
  const ticket = run.tickets[attempt.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
  if (ticket === undefined || step === undefined || step.personaId !== attempt.personaId) {
    fail("recovery_assignment", "durable attempt no longer has its exact ticket assignment");
  }
  return {
    runId: run.id,
    ticketId: ticket.id,
    stepId: step.id,
    personaId: step.personaId,
    priority: ticket.priority,
  };
}

function toolExecutionMode(name: KoniToolName): "sequential" | "parallel" {
  return new Set<KoniToolName>([
    "koni_context",
    "koni_read_resource",
    "koni_graph_context",
    "koni_read_file",
    "koni_list_files",
    "koni_search_files",
  ]).has(name)
    ? "parallel"
    : "sequential";
}

function compactionSnapshot(run: RunRecord, descriptor: AttemptDescriptor): KoniCompactionSnapshot {
  const full = run.plan?.full ?? {};
  return {
    objective: run.objective,
    plan: {
      architecture: full.architecture ?? "Planning is still in progress.",
      decisions: full.decisions ?? "Planning is still in progress.",
      risk: full.risk ?? "Planning is still in progress.",
      verification: full.verification ?? "Planning is still in progress.",
    },
    graphRefs: descriptor.graph?.nodes().map((node) => `${node.type}: ${node.title}`) ?? [],
    touchedFiles: [],
    loadedResources: [],
    receiptIds: [],
    checkIds: descriptor.step?.validation_checks ?? [],
    unresolvedQuestions: Object.values(run.questions)
      .filter((question) => question.answeredAt === undefined)
      .map((question) => question.prompt),
    nextAction: descriptor.initialPrompt,
  };
}

function answeredQuestionContext(run: RunRecord): Array<{
  questionId: string;
  prompt: string;
  selectedOptionId?: string;
  selectedOption?: string;
  notes?: string;
  answeredAt: string;
}> {
  return Object.values(run.questions)
    .filter(
      (question): question is typeof question & { answeredAt: string } =>
        question.answeredAt !== undefined,
    )
    .sort(
      (left, right) =>
        left.answeredAt.localeCompare(right.answeredAt) || compareText(left.id, right.id),
    )
    .map((question) => {
      const selected =
        question.selectedOptionId === undefined
          ? undefined
          : question.options.find((option) => option.id === question.selectedOptionId);
      return {
        questionId: question.id,
        prompt: question.prompt,
        ...(selected === undefined
          ? {}
          : {
              selectedOptionId: selected.id,
              selectedOption: selected.label,
            }),
        ...(question.notes === undefined ? {} : { notes: question.notes }),
        answeredAt: question.answeredAt,
      };
    });
}

function attemptTokenBudget(
  runType: CompiledRunTypeBehavior,
  kind: "planning" | "lead" | "ticket" | "verification" | "integration",
  providerOutputHeadroom: number,
): AgentLaunchSpec["budgets"]["tokens"] {
  const configured = runType.planning?.tokenPolicy.limit;
  if (kind === "planning" && configured === undefined) {
    fail("planning_token_policy", "planning attempts require an explicit compiled token budget");
  }
  // Execution budgets derive from semantic planning policy, never from conventional preset IDs.
  // Direct-approval run types use the fixed compatibility envelope until they define a distinct
  // execution budget field in a future schema.
  const semanticEnvelope = configured ?? 240_000;
  // The ticket worker performs the heaviest turn sequence of the run — read, reason, edit, then
  // iterate against the configured proof — and at the model catalog's forced-minimum thinking
  // tier extended reasoning dominates the new-token count. Halving the planning envelope for it
  // (the previous `semanticEnvelope / 2`) exhausted the budget during discovery, aborting
  // productive implementers before they could write a single edit. Give the worker the full
  // planning envelope; the lighter non-planning roles (review, verification, integration) keep the
  // halved envelope, which is ample for their bounded turn counts in practice.
  const maxNew =
    kind === "planning"
      ? configured!
      : kind === "ticket"
        ? Math.max(32_000, semanticEnvelope)
        : Math.max(32_000, Math.floor(semanticEnvelope / 2));
  // The cache-inclusive ceiling is a worst-case exposure hold, not a spend target. Anthropic
  // usage reports re-read the entire cached prefix on every turn (observed live: a healthy
  // 14-turn implementer accumulated 905K cacheRead against 6.6K new tokens before crossing the
  // former x16 ceiling), and provider-side cache reads price at a small fraction of fresh input.
  // x64 keeps multi-dozen-turn full-context attempts admissible on cache-heavy providers while
  // still bounding runaway exposure; new-token budgets remain the real spend control.
  const maxAll = Math.min(Number.MAX_SAFE_INTEGER, maxNew * 64);
  return {
    maxInput: maxNew,
    maxOutput: maxNew,
    maxCacheRead: maxAll,
    maxCacheWrite: maxAll,
    maxNew,
    maxAll,
    providerOutputHeadroom,
  };
}

function assertCompilerModelBinding(
  binding: Readonly<SealedPiModelBinding>,
  provider: string,
  modelId: string,
): void {
  if (
    binding.provider !== provider ||
    binding.id !== modelId ||
    typeof binding.api !== "string" ||
    binding.api.trim().length === 0 ||
    !Number.isSafeInteger(binding.catalogContextWindow) ||
    binding.catalogContextWindow < binding.catalogMaxTokens ||
    !Number.isSafeInteger(binding.catalogMaxTokens) ||
    binding.catalogMaxTokens < 1 ||
    !isSha256Digest(binding.catalogSha256)
  ) {
    fail(
      "model_catalog_binding",
      `Pi model binding for ${provider}/${modelId} is missing, mismatched, or invalid`,
    );
  }
}

/**
 * State the exact compiled path grant in the launch prompt. Transcript audits showed every agent
 * discovering its boundary by trial and error ("outside the compiled path grant" probes, searches
 * rooted at a not-yet-existing file), wasting 2-4 calls per attempt; naming the grant up front
 * removes the probing entirely. Lists are bounded so a wide integration grant cannot bloat the
 * prompt.
 */
function renderPathGrant(readPaths: readonly string[], writePaths: readonly string[]): string {
  const render = (label: string, paths: readonly string[]) => {
    if (paths.length === 0) return `${label}: none`;
    const shown = paths.slice(0, 24);
    const more = paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : "";
    return `${label}: ${shown.join(", ")}${more}`;
  };
  return [
    "Your exact compiled path grant — tool calls outside it are rejected, so do not probe beyond it, and root searches at one of these paths or a directory containing them:",
    render("Readable", readPaths),
    render("Writable", writePaths),
  ].join("\n");
}

function attemptRepositoryCallBudget(
  runType: CompiledRunTypeBehavior,
  kind: "planning" | "lead" | "ticket" | "verification" | "integration",
): number | undefined {
  if (kind !== "planning") return undefined;
  const configured = runType.planning?.maxRepositoryToolCalls;
  if (configured === undefined) {
    fail(
      "planning_repository_budget",
      "planning attempts require a compiled repository-call budget",
    );
  }
  return configured;
}

function requireThinkingLevel(value: unknown, label: string): ThinkingLevel {
  if (value === "ultra") {
    fail(
      "legacy_thinking_level",
      `${label} still uses legacy ultra; migrate it explicitly to Pi max before execution`,
    );
  }
  if (!PI_THINKING_LEVELS.has(value as ThinkingLevel))
    fail("thinking_level", `${label} has unsupported Pi thinking level ${String(value)}`);
  return value as ThinkingLevel;
}

function rejectCompilerOwnedSpec(
  fields: readonly string[],
  spec: Record<string, JsonValue>,
  label: string,
): void {
  for (const field of fields) {
    const normalized = field.replace(/^spec\./u, "");
    if (!field.startsWith("spec.")) continue;
    if (
      graphField(
        {
          schema_version: "1.0",
          id: "x",
          type: "x",
          title: "x",
          status: "x",
          spec,
          edges: {},
          annotations: {},
        },
        normalized,
      ) !== undefined
    ) {
      fail("compiler_owned_field", `${label} may not author compiler-owned spec.${normalized}`);
    }
  }
}

function preserveCompilerOwnedSpec(
  fields: readonly string[],
  existing: GraphNode,
  updated: GraphNode,
): void {
  for (const field of fields) {
    if (!field.startsWith("spec.")) continue;
    if (
      canonicalHash(graphField(existing, field) ?? null) !==
      canonicalHash(graphField(updated, field) ?? null)
    ) {
      fail("compiler_owned_field", `agent may not change compiler-owned ${field}`);
    }
  }
}

function assertAgentToolIdentity(
  run: RunRecord,
  attempt: AgentAttemptRecord,
  grant: AuthorityGrant,
): void {
  if (
    grant.runId !== run.id ||
    grant.attemptId !== attempt.id ||
    grant.sessionId !== attempt.sessionId ||
    grant.ticketId !== attempt.ticketId ||
    grant.stepId !== attempt.stepId ||
    grant.generation !== run.generation ||
    grant.grantId !== `grant-${attempt.id}`
  )
    fail("agent_tool_identity", "agent tool request does not match its immutable run assignment");
}

interface ResolveConfiguredCheckInput {
  configuration: CompiledConfiguration;
  executionCatalog: CompiledExecutionSemanticCatalog;
  executionPolicyBinding: ExecutionPolicyBinding;
  gatePolicyContexts: readonly ResolvedGateAutoEvaluationContextBinding[];
  graph: TypedGraph;
  descriptor: AttemptDescriptor;
  projectRoot: string;
  requestedCheckId: string;
}

type SemanticResolvedAgentCheck = ResolvedAgentCheck & {
  executionPolicy: ResolvedCheckExecutionPolicyBinding;
};

type SemanticResolvedAgentCheckCommand = ResolvedAgentCheckCommand & {
  memberNodeId?: string;
  memberSourcePaths?: readonly string[];
};

interface CompositeMemberBinding {
  nodeId: string;
  cwd?: string;
  sourcePaths: string[];
  inputPaths: string[];
}

async function resolveConfiguredAgentCheck(
  input: ResolveConfiguredCheckInput,
): Promise<SemanticResolvedAgentCheck> {
  const adapter = await createProductionRuleDomainAdapter({
    configuration: input.configuration,
    graph: input.graph,
    projectRoot: input.projectRoot,
  });
  const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph, adapter);
  const targetIds = input.descriptor.definition?.target_node_ids ?? input.descriptor.readNodeIds;
  const resolved = await resolveCheckRecursive(
    { ...input, evaluator },
    input.requestedCheckId,
    targetIds,
    [],
    undefined,
  );
  const check = input.executionCatalog.checks[input.requestedCheckId];
  if (check === undefined)
    fail(
      "check_semantics",
      `configured check ${input.requestedCheckId} has no pinned execution semantics`,
    );
  const gatePolicyContexts = input.gatePolicyContexts
    .filter((binding) => binding.checkId === input.requestedCheckId)
    .map((binding) => structuredClone(binding));
  const gateReadPaths = gatePolicyContexts.flatMap((binding) => binding.readPaths);
  const commands = resolved.commands.map((command) => {
    const commandCheck = input.executionCatalog.checks[command.checkId];
    if (commandCheck === undefined) {
      fail(
        "check_semantics",
        `configured command ${command.checkId} has no pinned execution semantics`,
      );
    }
    return {
      ...command,
      // A policy-bound resolved check uses the semantic catalog identity. The complete
      // raw definition remains transitively pinned by configurationSha256; using its
      // older YAML-object hash here would make the runtime policy and receipt disagree.
      definitionHash: commandCheck.sha256,
      inputPaths: [...new Set([...command.inputPaths, ...gateReadPaths])].sort(compareText),
    };
  });
  return deepFreeze({
    protocol: "koni.resolved-agent-check.v1",
    requestedCheckId: input.requestedCheckId,
    definitionHash: check.sha256,
    kind: resolved.kind,
    commands,
    executionPolicy: resolvedCheckExecutionPolicy(input, input.requestedCheckId),
  });
}

function resolvedCheckExecutionPolicy(
  input: Pick<
    ResolveConfiguredCheckInput,
    "executionCatalog" | "executionPolicyBinding" | "gatePolicyContexts"
  >,
  checkId: string,
): ResolvedCheckExecutionPolicyBinding {
  const check = input.executionCatalog.checks[checkId];
  if (check === undefined)
    fail("check_semantics", `configured check ${checkId} has no pinned execution semantics`);
  return deepFreeze({
    configurationSha256: input.executionCatalog.configurationSha256,
    catalogSha256: input.executionCatalog.sha256,
    bindingSha256: input.executionPolicyBinding.sha256,
    checkId,
    checkSha256: check.sha256,
    effect: check.effect,
    receiptType: check.receiptType,
    receiptFreshness: check.receiptFreshness,
    composedReplay: check.composedReplay,
    retryPolicy: structuredClone(check.retryPolicy),
    gatePolicyContexts: input.gatePolicyContexts
      .filter((binding) => binding.checkId === checkId)
      .map((binding) => structuredClone(binding)),
  });
}

function terminalStepSemantics(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
): CompiledWorkflowStepSemantics {
  if (
    binding.configurationSha256 !== catalog.configurationSha256 ||
    binding.catalogSha256 !== catalog.sha256 ||
    binding.workflowId === undefined ||
    binding.workflowSha256 === undefined ||
    binding.stepId === undefined ||
    binding.stepSha256 === undefined
  ) {
    fail(
      "terminal_policy_binding",
      "terminal policy binding does not belong to one pinned workflow step",
    );
  }
  const operation = catalog.operations[binding.operationId];
  const workflow = catalog.workflows[binding.workflowId];
  const step = workflow?.steps.find((candidate) => candidate.id === binding.stepId);
  if (
    operation === undefined ||
    operation.sha256 !== binding.operationSha256 ||
    operation.workflowId !== binding.workflowId ||
    workflow === undefined ||
    workflow.sha256 !== binding.workflowSha256 ||
    workflow.version !== binding.workflowVersion ||
    step === undefined ||
    step.sha256 !== binding.stepSha256
  ) {
    fail(
      "terminal_policy_binding",
      "terminal policy binding differs from the pinned semantic catalog",
    );
  }
  return step;
}

function assignmentChangeControlContract(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
  stepId: string,
): AssignmentChangeControlContract {
  terminalStepSemantics(catalog, binding);
  const operation = catalog.operations[binding.operationId];
  if (operation === undefined)
    fail("change_control_operation", `operation ${binding.operationId} is unavailable`);
  const policy = operation.changeControl;
  return {
    role: policy.role,
    allowUpstreamRequest: policy.role === "ordinary" && policy.allowUpstreamRequests,
    requireChangeApplication: policy.role === "proposal" && policy.proposalStep === stepId,
  };
}

async function resolveTerminalValidationCheckPolicies(input: {
  configuration: CompiledConfiguration;
  catalog: CompiledExecutionSemanticCatalog;
  descriptor: AttemptDescriptor;
  projectRoot: string;
  checkIds: readonly string[];
}): Promise<AssignmentTerminalValidationCheckPolicy[]> {
  if (
    input.descriptor.executionPolicyBinding === undefined ||
    input.descriptor.graph === undefined
  ) {
    fail(
      "terminal_policy_descriptor",
      "terminal validation checks require a graph and step binding",
    );
  }
  const output: AssignmentTerminalValidationCheckPolicy[] = [];
  for (const checkId of input.checkIds) {
    const resolvedCheck = await resolveConfiguredAgentCheck({
      configuration: input.configuration,
      executionCatalog: input.catalog,
      executionPolicyBinding: input.descriptor.executionPolicyBinding,
      gatePolicyContexts: input.descriptor.gatePolicyContexts ?? [],
      graph: input.descriptor.graph,
      descriptor: input.descriptor,
      projectRoot: input.projectRoot,
      requestedCheckId: checkId,
    });
    const semantics = input.catalog.checks[checkId];
    if (semantics === undefined) {
      fail("terminal_policy_check", `terminal validation check ${checkId} has no pinned semantics`);
    }
    const causalResolvedCheckSha256 = canonicalHash(resolvedCheck);
    const leafIds = [...new Set(resolvedCheck.commands.map((command) => command.checkId))].sort(
      compareText,
    );
    const replaySelection = selectComposedReplayChecks(
      input.catalog,
      input.catalog.configurationSha256,
      leafIds,
    );
    const replayIds = new Set(replaySelection.replayCheckIds);
    const replayCommands = resolvedCheck.commands.filter((command) =>
      replayIds.has(command.checkId),
    );
    const retainedLeafPolicies = resolvedCheck.commands.flatMap((command, commandIndex) => {
      if (replayIds.has(command.checkId)) return [];
      if (command.executionPolicy === undefined) {
        fail(
          "terminal_policy_leaf_binding",
          `resolved leaf ${command.checkId} has no exact execution policy`,
        );
      }
      return [
        {
          commandIndex,
          checkId: command.checkId,
          executionPolicy: structuredClone(command.executionPolicy),
        },
      ];
    });
    output.push(
      deepFreeze({
        checkId,
        checkSha256: semantics.sha256,
        receiptType: semantics.receiptType,
        receiptFreshness: semantics.receiptFreshness,
        resolvedCheck: { ...resolvedCheck, commands: replayCommands },
        causalResolvedCheckSha256,
        causalCommands: Object.freeze([...resolvedCheck.commands]),
        retainedLeafPolicies,
        replaySelection,
      }),
    );
  }
  return output;
}

function retainedTerminalReceipts(
  run: RunRecord,
  ticketId: string,
  policies: readonly AssignmentTerminalValidationCheckPolicy[],
  currentAttemptId: string,
): AssignmentTerminalPolicyRetainedReceipt[] {
  const expected = new Map<string, CheckExecutionPolicyBinding>();
  for (const policy of policies) {
    for (const leaf of policy.retainedLeafPolicies) {
      expected.set(`${leaf.checkId}\0${canonicalHash(leaf.executionPolicy)}`, leaf.executionPolicy);
    }
  }
  const candidates = retainedReceiptsMatching(run, ticketId, expected, undefined);
  const checks = new Map((run.checks ?? []).map((check) => [check.id, check]));
  const selected: AssignmentTerminalPolicyRetainedReceipt[] = [];
  for (const key of [...expected.keys()].sort(compareText)) {
    const matches = candidates.filter(
      (candidate) => `${candidate.checkId}\0${canonicalHash(candidate.executionPolicy)}` === key,
    );
    matches.sort((left, right) => {
      const leftCurrent = left.attemptId === currentAttemptId ? 1 : 0;
      const rightCurrent = right.attemptId === currentAttemptId ? 1 : 0;
      if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
      const recorded = compareText(
        checks.get(right.runCheckId)?.recordedAt ?? "",
        checks.get(left.runCheckId)?.recordedAt ?? "",
      );
      if (recorded !== 0) return recorded;
      const checkId = compareText(right.runCheckId, left.runCheckId);
      return checkId !== 0 ? checkId : right.commandIndex - left.commandIndex;
    });
    if (matches[0] !== undefined) selected.push(matches[0]);
  }
  return selected;
}

function retainedReceiptsMatching(
  run: RunRecord,
  ticketId: string,
  expected: ReadonlyMap<string, CheckExecutionPolicyBinding>,
  stepId: string | undefined,
): AssignmentTerminalPolicyRetainedReceipt[] {
  const output: AssignmentTerminalPolicyRetainedReceipt[] = [];
  for (const check of run.checks ?? []) {
    const attempt = run.attempts[check.attemptId];
    if (
      attempt === undefined ||
      attempt.ticketId !== ticketId ||
      (stepId !== undefined && attempt.stepId !== stepId) ||
      !check.accepted ||
      check.passed !== true
    )
      continue;
    for (const [commandIndex, command] of check.commands.entries()) {
      if (command.executionPolicy === undefined) continue;
      const key = `${command.checkId}\0${canonicalHash(command.executionPolicy)}`;
      const policy = expected.get(key);
      if (policy === undefined) continue;
      output.push(
        deepFreeze({
          runCheckId: check.id,
          attemptId: check.attemptId,
          stepId: attempt.stepId,
          requestedCheckId: check.requestedCheckId,
          commandIndex,
          checkId: command.checkId,
          executionPolicy: structuredClone(policy),
        }),
      );
    }
  }
  return output.sort((left, right) =>
    compareText(
      `${left.stepId}\0${left.runCheckId}\0${left.commandIndex}`,
      `${right.stepId}\0${right.runCheckId}\0${right.commandIndex}`,
    ),
  );
}

function terminalRetainedReceiptKey(receipt: AssignmentTerminalPolicyRetainedReceipt): string {
  return `${receipt.runCheckId}#${receipt.commandIndex}`;
}

function pairSourceManifestCommands(input: {
  run: RunRecord;
  ticketId: string;
  currentStepId: string;
  sourceStepId: string;
  currentChecks: readonly AssignmentTerminalValidationCheckPolicy[];
  sourceChecks: readonly AssignmentTerminalValidationCheckPolicy[];
}): AssignmentTerminalPolicySourceManifestPair[] {
  const currentCommands = terminalCommandsWithMembers(input.currentChecks, input.currentStepId);
  const sourceCommands = terminalCommandsWithMembers(input.sourceChecks, input.sourceStepId);
  const sourceByMember = new Map<string, AssignmentTerminalPolicySourceCommand[]>();
  for (const command of sourceCommands) {
    const existing = sourceByMember.get(command.memberNodeId) ?? [];
    existing.push(command);
    sourceByMember.set(command.memberNodeId, existing);
  }
  const output: AssignmentTerminalPolicySourceManifestPair[] = [];
  for (const current of currentCommands) {
    const candidates = sourceByMember.get(current.memberNodeId) ?? [];
    if (candidates.length !== 1) {
      fail(
        "terminal_policy_source_pair",
        `source-preservation member ${current.memberNodeId} resolved ${candidates.length} baseline commands`,
      );
    }
    const source = candidates[0]!;
    if (canonicalHash(current.sourcePaths) !== canonicalHash(source.sourcePaths)) {
      fail(
        "terminal_policy_source_paths",
        `source-preservation member ${current.memberNodeId} changed its exact source-path set`,
      );
    }
    const expected = new Map<string, CheckExecutionPolicyBinding>();
    const sourcePolicy = input.sourceChecks
      .flatMap((policy) => policy.causalCommands)
      .find(
        (candidate) =>
          commandBindingSha256(
            candidate as SemanticResolvedAgentCheckCommand,
            input.sourceStepId,
          ) === source.commandBindingSha256,
      )?.executionPolicy;
    if (sourcePolicy === undefined) {
      fail(
        "terminal_policy_source_binding",
        `source command ${source.checkId} has no exact execution policy`,
      );
    }
    expected.set(`${source.checkId}\0${canonicalHash(sourcePolicy)}`, sourcePolicy);
    const retainedSourceReceipts = retainedReceiptsMatching(
      input.run,
      input.ticketId,
      expected,
      input.sourceStepId,
    );
    const material = {
      memberNodeId: current.memberNodeId,
      current,
      source,
      retainedSourceReceipts: Object.freeze(retainedSourceReceipts),
    };
    output.push(deepFreeze({ ...material, sha256: canonicalHash(material) }));
  }
  if (
    sourceCommands.some(
      (source) => !currentCommands.some((current) => current.memberNodeId === source.memberNodeId),
    )
  ) {
    fail(
      "terminal_policy_source_pair",
      "baseline source members differ from current validation members",
    );
  }
  return output.sort((left, right) => compareText(left.memberNodeId, right.memberNodeId));
}

function terminalCommandsWithMembers(
  policies: readonly AssignmentTerminalValidationCheckPolicy[],
  stepId: string,
): AssignmentTerminalPolicySourceCommand[] {
  const output: AssignmentTerminalPolicySourceCommand[] = [];
  for (const policy of policies) {
    for (const rawCommand of policy.causalCommands) {
      const command = rawCommand as SemanticResolvedAgentCheckCommand;
      if (
        command.memberNodeId === undefined ||
        command.memberSourcePaths === undefined ||
        command.memberSourcePaths.length === 0
      ) {
        fail(
          "terminal_policy_source_member",
          `source-preservation check ${policy.checkId} did not resolve an exact member and source-path set`,
        );
      }
      output.push(
        deepFreeze({
          stepId,
          checkId: command.checkId,
          memberNodeId: command.memberNodeId,
          commandBindingSha256: commandBindingSha256(command, stepId),
          sourcePaths: Object.freeze([...command.memberSourcePaths]),
        }),
      );
    }
  }
  const identities = new Set<string>();
  for (const command of output) {
    if (identities.has(command.memberNodeId)) {
      fail(
        "terminal_policy_source_member",
        `source-preservation member ${command.memberNodeId} has multiple commands`,
      );
    }
    identities.add(command.memberNodeId);
  }
  return output.sort((left, right) => compareText(left.memberNodeId, right.memberNodeId));
}

function commandBindingSha256(
  command: SemanticResolvedAgentCheckCommand,
  stepId: string,
): Sha256Digest {
  if (
    command.executionPolicy === undefined ||
    command.memberNodeId === undefined ||
    command.memberSourcePaths === undefined
  ) {
    fail(
      "terminal_policy_command_binding",
      `command ${command.checkId} has no exact semantic member binding`,
    );
  }
  return canonicalHash({
    stepId,
    checkId: command.checkId,
    definitionHash: command.definitionHash,
    executionPolicy: command.executionPolicy,
    memberNodeId: command.memberNodeId,
    memberSourcePaths: command.memberSourcePaths,
    argv: command.argv,
    cwd: command.cwd,
    inputPaths: command.inputPaths,
  });
}

async function resolveCheckRecursive(
  input: ResolveConfiguredCheckInput & { evaluator: GraphExpressionEvaluator },
  checkId: string,
  subjectIds: readonly string[],
  stack: readonly string[],
  member: CompositeMemberBinding | undefined,
): Promise<{
  kind: ResolvedAgentCheck["kind"];
  definitionHash: Sha256Digest;
  commands: ResolvedAgentCheckCommand[];
}> {
  if (stack.includes(checkId))
    fail(
      "check_recursive",
      `configured check recursion is cyclic: ${[...stack, checkId].join(" -> ")}`,
    );
  const definition = input.configuration.registries.checks[checkId];
  if (definition === undefined) fail("check_missing", `configured check ${checkId} does not exist`);
  assertCheckApplies(definition, input.descriptor, checkId);
  const kind = optionalString(definition.kind);
  const definitionHash = canonicalHash(definition);
  if (kind === "graph") return { kind, definitionHash, commands: [] };
  if (kind === "command") {
    return {
      kind,
      definitionHash,
      commands: await resolveCommandCheck(input, checkId, definition, subjectIds, member),
    };
  }
  if (kind !== "composite")
    fail("check_kind", `configured check ${checkId} has unsupported kind ${kind ?? ""}`);
  const set = optionalRecord(definition.graph_set);
  if (set === undefined)
    fail("check_composite", `composite check ${checkId} has no graph_set contract`);
  const selector = set.members;
  if (selector === undefined)
    fail("check_composite", `composite check ${checkId} has no member selector`);
  const selected = input.evaluator.withBinding("target", subjectIds, () =>
    input.evaluator.select(selector),
  );
  const memberTypes = new Set(stringArray(set.member_node_types, `${checkId} member node types`));
  const excluded = new Set(stringArray(set.status_excluding, `${checkId} excluded statuses`));
  const members = selected
    .flatMap((id) => {
      const node = input.graph.node(id);
      if (
        node === undefined ||
        (memberTypes.size > 0 && !memberTypes.has(node.type)) ||
        excluded.has(node.status)
      )
        return [];
      return [node];
    })
    .sort((left, right) => compareText(left.id, right.id));
  const minimum = optionalSafeInteger(set.min_members) ?? 0;
  if (members.length < minimum) {
    fail(
      "check_composite_coverage",
      `composite check ${checkId} selected ${members.length} members, below ${minimum}`,
    );
  }
  const commands: ResolvedAgentCheckCommand[] = [];
  for (const node of members) {
    const configuredChild = optionalString(set.member_check);
    const field = optionalString(set.member_check_field);
    const childId =
      configuredChild ??
      (field === undefined ? undefined : optionalString(graphNodeField(node, field)));
    if (childId === undefined)
      fail(
        "check_composite_member",
        `composite check ${checkId} member ${node.id} has no check id`,
      );
    const sourcePaths = configuredNodePaths(node, optionalString(set.source_paths_field));
    const coveredPaths = configuredNodePaths(node, optionalString(set.covered_paths_field));
    const supportPaths = configuredNodePaths(node, optionalString(set.support_paths_field));
    const workingDirectory = optionalString(set.working_directory_field);
    const cwd =
      workingDirectory === undefined
        ? undefined
        : optionalString(graphNodeField(node, workingDirectory));
    const resolved = await resolveCheckRecursive(input, childId, [node.id], [...stack, checkId], {
      nodeId: node.id,
      ...(cwd === undefined ? {} : { cwd }),
      // Test-support configuration is causal to an honest prepared baseline. Keep its exact
      // bytes in the same preservation manifest as the writable proof source, while retaining
      // a distinct graph field so it never becomes write authority or claimed product coverage.
      sourcePaths: [...new Set([...sourcePaths, ...supportPaths])].sort(compareText),
      inputPaths: [...new Set([...sourcePaths, ...coveredPaths, ...supportPaths])].sort(
        compareText,
      ),
    });
    commands.push(...resolved.commands);
  }
  return { kind, definitionHash, commands };
}

/**
 * Policy-backed commands execute once per compiler-pinned gate context. Ticket targets can be
 * verifier assets or evaluation subjects, so treating descriptor targets as gate ids asks the
 * policy selector to rank the wrong node type. Direct/manual checks without pinned contexts retain
 * the caller's explicit subjects.
 */
export function gatePolicyCommandSubjectIds(
  checkId: string,
  subjectIds: readonly string[],
  contexts: readonly Pick<ResolvedGateAutoEvaluationContextBinding, "checkId" | "gateNodeId">[],
): string[] {
  const pinnedGateIds = contexts
    .filter((binding) => binding.checkId === checkId)
    .map((binding) => binding.gateNodeId);
  return [...new Set(pinnedGateIds.length > 0 ? pinnedGateIds : subjectIds)].sort(compareText);
}

async function resolveCommandCheck(
  input: ResolveConfiguredCheckInput & { evaluator: GraphExpressionEvaluator },
  checkId: string,
  definition: ConfigurationObject,
  subjectIds: readonly string[],
  member: CompositeMemberBinding | undefined,
): Promise<ResolvedAgentCheckCommand[]> {
  const staticArgv = Array.isArray(definition.argv)
    ? exactArgv(definition.argv, checkId)
    : undefined;
  const source = optionalRecord(definition.command_source);
  if ((staticArgv === undefined) === (source === undefined)) {
    fail(
      "check_command_source",
      `command check ${checkId} must have exactly one static or dynamic command source`,
    );
  }
  const bindings: Array<{
    argv: string[];
    root?: ConfigurationValue;
    variables: Record<string, string>;
  }> = [];
  if (staticArgv !== undefined) {
    bindings.push({ argv: staticArgv, variables: {} });
  } else {
    const sourceKind = optionalString(source!.kind);
    const field = requiredNonempty(source!.field, `${checkId} command source field`);
    if (sourceKind === "node") {
      const allowedTypes = new Set(
        stringArray(source!.node_types, `${checkId} command source node types`),
      );
      const gatePolicy = optionalString(source!.gate_policy);
      if (gatePolicy !== undefined) {
        for (const gateId of gatePolicyCommandSubjectIds(
          checkId,
          subjectIds,
          input.gatePolicyContexts,
        )) {
          const winners = input.evaluator.select({
            policy_selection: { policy: gatePolicy, gate: { ids: [gateId] }, result: "winner" },
          });
          if (winners.length !== 1)
            fail(
              "check_command_source",
              `check ${checkId} gate ${gateId} has no unique policy winner`,
            );
          const winner = input.graph.node(winners[0]!)!;
          if (allowedTypes.size > 0 && !allowedTypes.has(winner.type)) {
            fail(
              "check_command_source",
              `check ${checkId} selected unauthorized ${winner.type} command node ${winner.id}`,
            );
          }
          const variables = {
            "gate.id": gateId,
            "target.id": gateId,
            [`${optionalString(source!.role) ?? winner.type}.id`]: winner.id,
            [`${winner.type}.id`]: winner.id,
          };
          bindings.push({
            argv: exactArgv(
              dynamicValuePath(graphNodeRoot(winner), field, variables),
              checkId,
              `${winner.id}.${field} (gate.id=${gateId})`,
            ),
            root: winner.spec,
            variables,
          });
        }
      } else {
        const candidates = [...new Set(subjectIds)]
          .flatMap((id) => {
            const node = input.graph.node(id);
            return node !== undefined && (allowedTypes.size === 0 || allowedTypes.has(node.type))
              ? [node]
              : [];
          })
          .sort((left, right) => compareText(left.id, right.id));
        if (candidates.length !== 1) {
          fail(
            "check_command_source",
            `check ${checkId} resolved ${candidates.length} target command nodes, expected exactly one`,
          );
        }
        const candidate = candidates[0]!;
        const variables = {
          "target.id": candidate.id,
          [`${optionalString(source!.role) ?? candidate.type}.id`]: candidate.id,
          [`${candidate.type}.id`]: candidate.id,
        };
        bindings.push({
          argv: exactArgv(
            dynamicValuePath(graphNodeRoot(candidate), field, variables),
            checkId,
            `${candidate.id}.${field}`,
          ),
          root: candidate.spec,
          variables,
        });
      }
    } else if (sourceKind === "ticket") {
      const candidates = [...new Set(subjectIds)]
        .flatMap((id) => {
          const node = input.graph.node(id);
          return node === undefined ? [] : [node];
        })
        .sort((left, right) => compareText(left.id, right.id));
      if (candidates.length !== 1) {
        fail(
          "check_command_source",
          `check ${checkId} resolved ${candidates.length} ticket command nodes, expected exactly one`,
        );
      }
      const target = candidates[0]!;
      const variables = { "target.id": target.id, "ticket.id": input.descriptor.ticketId };
      bindings.push({
        argv: exactArgv(dynamicValuePath(target.spec, field, variables), checkId),
        root: target.spec,
        variables,
      });
    } else {
      fail(
        "check_command_source",
        `check ${checkId} has unsupported dynamic source kind ${sourceKind ?? ""}`,
      );
    }
  }
  const effect = optionalString(definition.effect) ?? "read_only";
  if (effect !== "read_only" && effect !== "workspace_write")
    fail("check_effect", `check ${checkId} has unsupported effect ${effect}`);
  const timeoutSeconds = optionalSafeInteger(definition.timeout_seconds);
  if (timeoutSeconds === undefined || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
    fail("check_timeout", `check ${checkId} timeout must be between 1 and 86400 seconds`);
  }
  const environment = optionalRecord(definition.environment) ?? {};
  const inherit = stringArray(environment.inherit, `${checkId} inherited environment`);
  const set = optionalRecord(environment.set) ?? {};
  const environmentSet: Record<string, string> = {};
  for (const [name, value] of Object.entries(set).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== "string" ||
      value.includes("\u0000")
    ) {
      fail("check_environment", `check ${checkId} has an invalid fixed environment entry`);
    }
    environmentSet[name] = value;
  }
  const expectedExitCodes = stringOrNumberArray(definition.expected_exit_codes, [0], checkId);
  const cwd = normalizeCheckPath(
    member?.cwd ?? optionalString(definition.cwd) ?? ".",
    `${checkId} cwd`,
  );
  return Promise.all(
    bindings.map(async (binding) => {
      const boundInputPaths = await resolveCheckInputBindings(
        definition,
        binding.root,
        binding.argv,
        checkId,
        input.projectRoot,
        standaloneSupportRunAllowsEmptyScientificInputs(
          input.descriptor.definition,
          optionalString(optionalRecord(definition.argv_input_bindings)?.from) ?? "",
          binding.root === undefined
            ? undefined
            : dynamicValuePath(
                binding.root,
                optionalString(optionalRecord(definition.argv_input_bindings)?.from) ?? "",
                {},
              ),
        ),
      );
      const inputPaths = [...new Set([...(member?.inputPaths ?? []), ...boundInputPaths])]
        .map((value) => normalizeCheckPath(value, `${checkId} input path`))
        .sort(compareText);
      // A proof check reads not only the ticket-owned production seams (the attempt's covered read
      // grant) but also its declared support files — the test files it runs, the vitest/tsconfig
      // config, and the package manifest `pnpm exec vitest` needs to resolve. The compiler already
      // lists those support files in the check's source manifest and the ticket's runtime read grant,
      // so they are readable at run time; validating check inputs against the narrow per-step covered
      // scope alone rejected every support file as "outside path scope" and deadlocked every
      // implementation proof (observed live across both Sonnet and Opus planners). Validate against the
      // union of the granted read scope and the check's own declared source/support paths; other
      // inputs still stay bounded to the attempt's read grant.
      const checkReadScope = [...input.descriptor.readPaths, ...(member?.sourcePaths ?? [])];
      for (const value of inputPaths)
        assertPathInScopes(value, checkReadScope, `${checkId} input path`);
      const dynamicResult = optionalRecord(definition.dynamic_result);
      const resultPath = resolveDynamicResultPath(
        dynamicResult,
        binding.root,
        binding.variables,
        checkId,
      );
      if (resultPath !== undefined)
        assertPathInScopes(resultPath, input.descriptor.writePaths, `${checkId} result path`);
      const outputPaths =
        effect === "workspace_write"
          ? [...new Set(input.descriptor.writePaths)].sort(compareText)
          : [];
      const artifactDefinition = optionalRecord(dynamicResult?.artifacts);
      const outputArtifactSelector =
        artifactDefinition === undefined
          ? undefined
          : {
              field: requiredNonempty(artifactDefinition.field, `${checkId} artifact field`),
              allowPathStrings: artifactDefinition.allow_path_strings === true,
              pathField: optionalString(artifactDefinition.path_field) ?? "path",
            };
      return {
        checkId,
        definitionHash: canonicalHash(definition),
        executionPolicy: resolvedCheckExecutionPolicy(input, checkId),
        ...(member === undefined
          ? {}
          : {
              memberNodeId: member.nodeId,
              memberSourcePaths: Object.freeze([...member.sourcePaths]),
            }),
        argv: binding.argv,
        cwd,
        timeoutMs: timeoutSeconds * 1_000,
        effect,
        networkAccess: definition.network_access === true,
        environment: { inherit, set: environmentSet },
        expectedExitCodes,
        allowNonpassingReceipt: definition.allow_nonpassing_receipt === true,
        receiptType: requiredNonempty(definition.receipt_type, `${checkId} receipt type`),
        ...(optionalString(definition.result_protocol) === undefined
          ? {}
          : { resultProtocol: optionalString(definition.result_protocol)! }),
        requiredResultFields: stringArray(
          definition.required_result_fields,
          `${checkId} required result fields`,
        ),
        ...(definition.result_schema === undefined
          ? {}
          : { resultSchema: structuredClone(definition.result_schema) as JsonValue }),
        resultSource:
          resultPath === undefined
            ? { kind: "stdout" as const }
            : { kind: "file" as const, path: resultPath },
        ...(outputArtifactSelector === undefined ? {} : { outputArtifactSelector }),
        inputPaths,
        outputPaths,
      };
    }),
  );
}

function assertCheckApplies(
  definition: ConfigurationObject,
  descriptor: AttemptDescriptor,
  checkId: string,
): void {
  const applies = stringArray(definition.applies_to, `${checkId} applies_to`);
  const operation = descriptor.definition?.operation;
  if (operation !== undefined && applies.length > 0 && !applies.includes(operation)) {
    fail("check_operation", `check ${checkId} does not apply to operation ${operation}`);
  }
}

function configuredNodePaths(node: GraphNode, field: string | undefined): string[] {
  if (field === undefined) return [];
  const value = graphNodeField(node, field);
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (values.some((item) => typeof item !== "string"))
    fail("check_composite_path", `${node.id}.${field} contains a non-string path`);
  return (values as string[]).map((item) => normalizeCheckPath(item, `${node.id}.${field}`));
}

function graphNodeRoot(node: GraphNode): ConfigurationObject {
  return {
    schema_version: node.schema_version,
    id: node.id,
    type: node.type,
    title: node.title,
    status: node.status,
    spec: node.spec,
    edges: node.edges,
    annotations: node.annotations,
  };
}

function graphNodeField(node: GraphNode, field: string): ConfigurationValue | undefined {
  return dynamicValuePath(graphNodeRoot(node), field, {});
}

function dynamicValuePath(
  root: ConfigurationValue,
  field: string,
  variables: Readonly<Record<string, string>>,
): ConfigurationValue | undefined {
  const segments = field.replace(/^\$?\./u, "").match(/[^.[\]]+|\[[^\]]+\]/gu) ?? [];
  let current: ConfigurationValue | undefined = root;
  for (const raw of segments) {
    const bracket = raw.startsWith("[");
    let key = bracket ? raw.slice(1, -1).trim() : raw;
    if (key.startsWith("$")) key = variables[key.slice(1)] ?? "";
    else key = key.replace(/^(?:'|")|(?:'|")$/gu, "");
    if (key.length === 0) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[key];
    } else return undefined;
  }
  return current;
}

function exactArgv(value: unknown, checkId: string, source?: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.trim().length === 0 ||
        item.includes("\u0000") ||
        item.includes("\n") ||
        item.includes("\r"),
    )
  ) {
    // A node-sourced command resolves through a per-gate contract map, so the usual failure is an
    // absent entry for one gate rather than a malformed array. Naming the node, the resolved path,
    // and what was actually found is the difference between a fixable report and a hunt.
    const found = value === undefined ? "no value" : String(JSON.stringify(value)).slice(0, 120);
    // When the value *is* a nonempty array, "must be one exact nonempty argv array" describes it
    // accurately and explains nothing: the violation is inside one element. Observed live on a
    // `python3 -c` inline script whose source carried newlines, where the message sent the author
    // looking for a missing or malformed array that was neither.
    const offending = Array.isArray(value)
      ? value.findIndex(
          (item) =>
            typeof item !== "string" ||
            item.trim().length === 0 ||
            item.includes("\u0000") ||
            item.includes("\n") ||
            item.includes("\r"),
        )
      : -1;
    fail(
      "check_argv",
      offending >= 0
        ? `check ${checkId} argv element ${offending} is not a usable argument: it must be a nonempty single-line string with no NUL, newline, or carriage return. An inline script passed with -c cannot be an argv element; put it in a repository file and pass that path instead${
            source === undefined ? "" : ` (resolved ${source})`
          }`
        : `check ${checkId} command must be one exact nonempty argv array${
            source === undefined ? "" : `; resolved ${source} to ${found}`
          }`,
    );
  }
  const argv = value as string[];
  if (/\s/u.test(argv[0]!))
    fail("check_argv", `check ${checkId} executable argv element may not contain whitespace`);
  if (argv.length > 4_096 || argv.some((item) => Buffer.byteLength(item, "utf8") > 1024 * 1024)) {
    fail("check_argv", `check ${checkId} argv exceeds its compiler bound`);
  }
  return [...argv];
}

function stringOrNumberArray(value: unknown, fallback: number[], checkId: string): number[] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (item) => !Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 255,
    )
  ) {
    fail("check_exit_codes", `check ${checkId} expected exit codes are invalid`);
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

async function resolveCheckInputBindings(
  definition: ConfigurationObject,
  root: ConfigurationValue | undefined,
  argv: readonly string[],
  checkId: string,
  projectRoot: string,
  allowExplicitEmpty = false,
): Promise<string[]> {
  const configured = optionalRecord(definition.argv_input_bindings);
  if (configured === undefined) return [];
  if (root === undefined)
    fail("check_input_binding", `check ${checkId} has no dynamic root for argv input bindings`);
  const from = requiredNonempty(configured.from, `${checkId} argv input source`);
  const rows = dynamicValuePath(root, from, {});
  if (
    !Array.isArray(rows) ||
    (configured.require_nonempty === true && rows.length === 0 && !allowExplicitEmpty)
  ) {
    fail(
      "check_input_binding",
      `check ${checkId} argv input source is not a permitted nonempty list`,
    );
  }
  const pathField = optionalString(configured.path_field) ?? "path";
  const requiredFields = stringArray(
    configured.required_fields,
    `${checkId} required input fields`,
  );
  const paths: string[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row))
      fail("check_input_binding", `check ${checkId} input binding ${index} is not an object`);
    for (const field of requiredFields)
      if (row[field] === undefined) {
        fail("check_input_binding", `check ${checkId} input binding ${index} is missing ${field}`);
      }
    const value = requiredNonempty(row[pathField], `${checkId} input binding path`);
    const normalized = normalizeCheckPath(value, `${checkId} input binding path`);
    if (
      configured.require_exact_argument === true &&
      !argv.includes(normalized) &&
      !argv.includes(value)
    ) {
      // Distinguish "the argv does not contain this path" from "there is no argv". Both reach here,
      // but only the first is a quoting or `--flag=value` problem; the second is an incomplete
      // runtime contract, and reporting it as an argv-element mismatch sends the author looking for
      // a formatting error in an array that does not exist. Observed live on a `run` node whose
      // contract declared scientific_inputs with `argv: null`.
      fail(
        "check_input_binding",
        argv.length === 0
          ? `check ${checkId} declares input path ${normalized} but its runtime contract has no argv; author the exact argv that consumes this input`
          : `check ${checkId} input path ${normalized} is not an exact argv element (argv: ${argv
              .map((element) => JSON.stringify(element))
              .join(" ")}); pass the path as its own element rather than inside --flag=value`,
      );
    }
    if (configured.require_project_file === true) {
      await assertExistingProjectFile(projectRoot, normalized, checkId);
    }
    paths.push(normalized);
  }
  return paths;
}

/**
 * Historical research profiles require at least one scientific input for ordinary experiment
 * runs. A compiler-authored standalone support run may instead be a deterministic zero-input
 * generator whose sole purpose is to materialize a prerequisite artifact. Preserve the profile's
 * fail-closed rule everywhere else and relax it only for an explicit empty scientific-input list
 * on that exact compatibility ticket.
 */
export function standaloneSupportRunAllowsEmptyScientificInputs(
  definition: Pick<DerivedTicketDefinition, "rule_id"> | undefined,
  source: string,
  value: unknown,
): boolean {
  return (
    definition?.rule_id === "compiler.compatibility.research-standalone-support-run" &&
    source === "runtime_contract.scientific_inputs" &&
    Array.isArray(value) &&
    value.length === 0
  );
}

async function assertExistingProjectFile(
  projectRoot: string,
  relativePath: string,
  checkId: string,
): Promise<void> {
  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = await realpath(projectRoot);
    canonicalFile = await realpath(path.join(canonicalRoot, relativePath));
  } catch {
    fail(
      "check_input_binding",
      `check ${checkId} input path ${relativePath} does not exist as a project file`,
    );
  }
  if (!isWithinDirectory(canonicalRoot!, canonicalFile!)) {
    fail(
      "check_input_binding",
      `check ${checkId} input path ${relativePath} escapes the project root`,
    );
  }
  let metadata;
  try {
    metadata = await lstat(canonicalFile!);
  } catch {
    fail(
      "check_input_binding",
      `check ${checkId} input path ${relativePath} does not exist as a project file`,
    );
  }
  if (!metadata.isFile()) {
    fail(
      "check_input_binding",
      `check ${checkId} input path ${relativePath} is not a project file`,
    );
  }
}

function resolveDynamicResultPath(
  dynamicResult: ConfigurationObject | undefined,
  root: ConfigurationValue | undefined,
  variables: Readonly<Record<string, string>>,
  checkId: string,
): string | undefined {
  const source = optionalRecord(dynamicResult?.result_path);
  if (source === undefined) return undefined;
  if (root === undefined)
    fail("check_result_path", `check ${checkId} has no dynamic root for its result path`);
  const field = requiredNonempty(source.field, `${checkId} result path field`);
  const value = dynamicValuePath(root, field, variables);
  if (value === undefined || value === null) return undefined;
  return normalizeCheckPath(
    requiredNonempty(value, `${checkId} result path`),
    `${checkId} result path`,
  );
}

function normalizeCheckPath(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === ".") return ".";
  if (
    trimmed.length === 0 ||
    trimmed.includes("\u0000") ||
    trimmed.includes("\\") ||
    trimmed.startsWith("/") ||
    path.posix.normalize(trimmed) !== trimmed ||
    trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    fail("check_path", `${label} must be a normalized project-relative path`);
  return trimmed;
}

function assertPathInScopes(value: string, scopes: readonly string[], label: string): void {
  const normalizedScopes = scopes.map((scope) => normalizeCheckPath(scope, `${label} scope`));
  if (
    !normalizedScopes.some(
      (scope) => scope === "." || value === scope || value.startsWith(`${scope}/`),
    )
  ) {
    fail("check_path_scope", `${label} ${value} is outside the exact compiler-issued path scope`);
  }
}

interface CompiledCheckCommandExecution {
  accepted: boolean;
  passed: boolean;
  infrastructureFailure?: string;
  value: JsonValue;
  evidence: ConfigurationObject;
}

/**
 * A configured nonzero exit is useful evidence only after the repository-native runner reached
 * the subject it was meant to evaluate. These signatures describe command, sandbox, dependency,
 * or test-collection failures that occur before a focused assertion can establish an honest red.
 * Keep this deliberately narrower than general test failures: semantic wrong-reason review still
 * belongs to the configured reviewer.
 */
export function commandInfrastructureFailure(
  stdout: string,
  stderr: string,
  declaredInputPaths: readonly string[] = [],
): string | undefined {
  const rawOutput = `${stdout}\n${stderr}`;
  const output = rawOutput.toLocaleLowerCase("en-US");
  const contains = (needle: string): boolean => output.includes(needle);
  let cause: string | undefined;
  if (contains("process.cwd failed") || contains("uv_cwd")) {
    cause = "the runtime could not resolve its working directory";
  } else if (contains("error: eperm:") && contains("operation not permitted")) {
    cause = "the runtime was denied a required sandbox resource";
  } else if (
    // A failed subprocess spawn happens before the test runner loads, so it can never be a
    // legitimate test result. Package managers also append generic child-exit wrappers such as
    // ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL after a runner has produced an admissible expected red;
    // the concrete spawn, command, dependency, and collection diagnostics below—not that wrapper
    // alone—determine whether execution failed before reaching the subject.
    contains("spawn eperm") ||
    contains("spawn eacces") ||
    contains("node_modules missing") ||
    /(?:^|\n)(?:sh|bash|zsh): [^\n]+: command not found(?:\n|$)/u.test(output) ||
    (contains("corepack") && (contains("eperm") || contains("eacces") || contains("cannot create")))
  ) {
    cause = "the check runner failed to launch (package-manager or subprocess spawn error)";
  } else if (
    contains("startup error") ||
    contains("getaddrinfo enotfound") ||
    contains("getaddrinfo eai_")
  ) {
    cause = "the configured runtime failed during startup";
  } else if (contains("invalid environment variables")) {
    cause = "the configured test environment was invalid";
  } else if (
    contains("tests  no tests") ||
    contains("no test files found") ||
    contains("no tests found") ||
    contains("your test suite must contain at least one test")
  ) {
    cause = "the configured test runner did not execute a test";
  } else if (
    contains("bad interpreter: no such file or directory") ||
    ((contains("/usr/bin/env:") || contains("env:")) && contains("no such file or directory"))
  ) {
    cause = "the configured command interpreter was unavailable";
  } else if (
    contains("err_module_not_found") ||
    contains("cannot find module") ||
    contains("cannot find package") ||
    contains("modulenotfounderror: no module named") ||
    contains("failed to resolve import") ||
    contains("failed to load url")
  ) {
    if (onlyDeclaredLocalModulesAreMissing(rawOutput, declaredInputPaths)) {
      cause = undefined;
    } else {
      cause = "the configured test graph could not load one of its modules";
    }
  }
  if (
    cause === undefined &&
    (contains("referenceerror: react is not defined") ||
      contains("objects are not valid as a react child") ||
      contains("element type is invalid:") ||
      contains("invalid hook call"))
  ) {
    cause = "the configured test harness failed before its focused assertions ran";
  }
  return cause === undefined
    ? undefined
    : `command infrastructure failed before producing an admissible expected result: ${cause}`;
}

/**
 * A red-green proof may intentionally import a not-yet-created local production source. That is
 * admissible only when the missing relative import resolves exactly to a compiler-declared input
 * path. Ambient packages, undeclared local files, ambiguous diagnostics, and mixed harness errors
 * remain infrastructure failures.
 */
function onlyDeclaredLocalModulesAreMissing(
  output: string,
  declaredInputPaths: readonly string[],
): boolean {
  if (declaredInputPaths.length === 0) return false;
  const foldedOutput = output.toLocaleLowerCase("en-US");
  const missingModulePattern =
    /cannot find module\s+['"]([^'"]+)['"]\s+imported from\s+['"]([^'"]+)['"]/giu;
  const matches = [...output.matchAll(missingModulePattern)];
  if (matches.length === 0) return false;
  // Node/Vite attach ERR_MODULE_NOT_FOUND to both ambient dependency failures and an honest
  // not-yet-created relative production import. The exact specifier/importer proof below is the
  // authority boundary; the generic code marker alone must not override it.
  if (
    foldedOutput.includes("cannot find package") ||
    foldedOutput.includes("failed to resolve import")
  ) {
    return false;
  }

  const normalizedInputs = [
    ...new Set(declaredInputPaths.map((candidate) => candidate.replaceAll("\\", "/"))),
  ];
  const allowedSpecifiers = new Set<string>();
  for (const match of matches) {
    const specifier = match[1]!;
    const importer = match[2]!.replaceAll("\\", "/");
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
    const importerPath = normalizedInputs.find(
      (candidate) => importer === candidate || importer.endsWith(`/${candidate}`),
    );
    if (importerPath === undefined) return false;
    const unresolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(importerPath), specifier),
    );
    if (unresolved === ".." || unresolved.startsWith("../") || path.posix.isAbsolute(unresolved))
      return false;
    const declared = normalizedInputs.some(
      (candidate) =>
        candidate === unresolved ||
        stripModuleExtension(candidate) === stripModuleExtension(unresolved),
    );
    if (!declared) return false;
    allowedSpecifiers.add(specifier.toLocaleLowerCase("en-US"));
  }

  // Test reporters can echo a shortened form of the same causal error before the complete
  // specifier/importer diagnostic. Admit only an unmistakably truncated prefix of a module that
  // the complete diagnostics above already bound to an exact declared input. Any other unmatched
  // missing-module marker remains an infrastructure failure.
  const unmatchedOutput = output.replace(missingModulePattern, "");
  const unmatchedMarkerCount =
    unmatchedOutput.toLocaleLowerCase("en-US").match(/cannot find module/gu)?.length ?? 0;
  const truncatedEchoes = [
    ...unmatchedOutput.matchAll(/cannot find module\s+['"]([^'"\n]*?)(?:…|\.\.\.)/giu),
  ];
  if (
    truncatedEchoes.length !== unmatchedMarkerCount ||
    truncatedEchoes.some((match) => {
      const prefix = match[1]!.toLocaleLowerCase("en-US");
      return ![...allowedSpecifiers].some((specifier) => specifier.startsWith(prefix));
    })
  ) {
    return false;
  }

  const failedLoads = [...output.matchAll(/failed to load url\s+([^\s(]+)/giu)];
  return failedLoads.every((match) => allowedSpecifiers.has(match[1]!.toLocaleLowerCase("en-US")));
}

function stripModuleExtension(value: string): string {
  return value.replace(/\.(?:[cm]?[jt]sx?|json)$/u, "");
}

function formatResultSchemaLiteral(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return String(value);
  return encoded.length <= 120 ? encoded : `${encoded.slice(0, 117)}...`;
}

function resultSchemaMismatchDiagnostics(schema: TSchema, result: unknown): string[] {
  const mismatches = new Map<string, { allowed: string[]; messages: string[] }>();
  for (const error of Value.Errors(schema, result)) {
    const instancePath = error.instancePath.length === 0 ? "/" : error.instancePath;
    const mismatch = mismatches.get(instancePath) ?? { allowed: [], messages: [] };
    if (error.keyword === "const") {
      mismatch.allowed.push(formatResultSchemaLiteral(error.params.allowedValue));
    } else if (error.keyword === "enum") {
      mismatch.allowed.push(
        ...error.params.allowedValues.map((value) => formatResultSchemaLiteral(value)),
      );
    } else if (error.keyword !== "anyOf") {
      mismatch.messages.push(error.message);
    }
    mismatches.set(instancePath, mismatch);
  }

  return [...mismatches.entries()].slice(0, 5).map(([instancePath, mismatch]) => {
    const allowed = [...new Set(mismatch.allowed)].slice(0, 10);
    if (allowed.length === 1)
      return `result schema mismatch at ${instancePath}: expected ${allowed[0]}`;
    if (allowed.length > 1)
      return `result schema mismatch at ${instancePath}: expected one of ${allowed.join(", ")}`;
    const message = [...new Set(mismatch.messages)][0] ?? "value is invalid";
    return `result schema mismatch at ${instancePath}: ${message}`;
  });
}

function compileCheckCommandExecution(
  command: ResolvedAgentCheckCommand,
  execution: AgentCheckExecution,
  index: number,
  configuration: CompiledConfiguration,
  descriptor: AttemptDescriptor,
): CompiledCheckCommandExecution {
  if (
    execution.checkId !== command.checkId ||
    execution.definitionHash !== command.definitionHash ||
    execution.argv.length !== command.argv.length ||
    execution.argv[0] !== execution.resolvedExecutable ||
    canonicalHash(execution.argv.slice(1)) !== canonicalHash(command.argv.slice(1))
  )
    fail(
      "check_execution_identity",
      `check execution ${index} does not match its compiler-resolved command`,
    );
  const hasAttemptNumber = execution.attemptNumber !== undefined;
  const hasRetryAudit = execution.retryAuditSha256 !== undefined;
  if (hasAttemptNumber !== hasRetryAudit) {
    fail(
      "check_execution_retry",
      `check execution ${index} must bind attempt number and retry audit together`,
    );
  }
  if (
    hasAttemptNumber &&
    (!Number.isSafeInteger(execution.attemptNumber) ||
      execution.attemptNumber! < 1 ||
      execution.attemptNumber! > 3 ||
      !isSha256Digest(execution.retryAuditSha256))
  ) {
    fail("check_execution_retry", `check execution ${index} has invalid retry audit authority`);
  }
  if (
    !isIsoTimestamp(execution.startedAt) ||
    !isIsoTimestamp(execution.completedAt) ||
    Date.parse(execution.completedAt) < Date.parse(execution.startedAt)
  ) {
    fail("check_execution_time", `check execution ${index} has invalid authority timestamps`);
  }
  if (
    typeof execution.resolvedExecutable !== "string" ||
    !path.isAbsolute(execution.resolvedExecutable) ||
    execution.resolvedExecutable.includes("\u0000") ||
    !isSha256Digest(execution.environmentSha256) ||
    !isSha256Digest(execution.preManifestSha256) ||
    !isSha256Digest(execution.postManifestSha256) ||
    !isSha256Digest(execution.sandboxProfileSha256) ||
    typeof execution.sandboxKind !== "string" ||
    execution.sandboxKind.trim().length === 0
  )
    fail(
      "check_execution_authority",
      `check execution ${index} has invalid sandbox or environment provenance`,
    );
  if (
    Buffer.byteLength(execution.stdout, "utf8") > 16 * 1024 * 1024 ||
    Buffer.byteLength(execution.stderr, "utf8") > 16 * 1024 * 1024 ||
    execution.stdoutSizeBytes !== Buffer.byteLength(execution.stdout, "utf8") ||
    execution.stderrSizeBytes !== Buffer.byteLength(execution.stderr, "utf8") ||
    rawSha256(execution.stdout) !== execution.stdoutSha256 ||
    rawSha256(execution.stderr) !== execution.stderrSha256
  ) {
    fail(
      "check_execution_stream",
      `check execution ${index} stream bytes do not match their authority hashes`,
    );
  }
  const errors: string[] = [];
  const exitAccepted =
    execution.signal === null &&
    execution.exitCode !== null &&
    command.expectedExitCodes.includes(execution.exitCode);
  if (!exitAccepted)
    errors.push(
      `exit ${execution.exitCode ?? execution.signal ?? "unknown"} is outside the configured contract`,
    );
  const infrastructureFailure =
    execution.exitCode !== null && execution.exitCode !== 0
      ? commandInfrastructureFailure(execution.stdout, execution.stderr, command.inputPaths)
      : undefined;
  if (infrastructureFailure !== undefined) errors.push(infrastructureFailure);
  if (
    command.effect === "read_only" &&
    execution.preManifestSha256 !== execution.postManifestSha256
  ) {
    errors.push("read-only check changed the workspace manifest");
  }
  if (
    execution.resultSource.kind !== command.resultSource.kind ||
    (command.resultSource.kind === "file" &&
      execution.resultSource.path !== command.resultSource.path) ||
    !isSha256Digest(execution.resultSource.bytesSha256) ||
    !Number.isSafeInteger(execution.resultSource.sizeBytes) ||
    execution.resultSource.sizeBytes < 0
  )
    fail(
      "check_result_source",
      `check execution ${index} result source is not the compiler-resolved source`,
    );
  if (
    command.resultSource.kind === "stdout" &&
    (execution.resultSource.bytesSha256 !== execution.stdoutSha256 ||
      execution.resultSource.sizeBytes !== Buffer.byteLength(execution.stdout, "utf8"))
  )
    fail(
      "check_result_source",
      `check execution ${index} stdout result bytes are not authority-bound`,
    );
  const resultRequired =
    command.resultProtocol !== undefined ||
    command.resultSchema !== undefined ||
    command.requiredResultFields.length > 0 ||
    command.outputArtifactSelector !== undefined;
  let result = execution.resultSource.value;
  if (resultRequired && command.resultSource.kind === "stdout") {
    try {
      const parsed = JSON.parse(execution.stdout) as unknown;
      assertJsonValue(parsed, `${command.checkId} stdout result`);
      if (canonicalHash(parsed) !== canonicalHash(result))
        errors.push("authority-parsed stdout result differs from stdout bytes");
      result = parsed;
    } catch {
      errors.push("stdout is not one complete JSON result");
    }
  }
  const resultObject = isRecord(result) ? result : undefined;
  if (resultRequired && resultObject === undefined)
    errors.push("configured result must be an object");
  if (command.resultProtocol !== undefined && resultObject?.protocol !== command.resultProtocol) {
    errors.push(`result protocol is not ${command.resultProtocol}`);
  }
  for (const field of command.requiredResultFields) {
    if (resultObject?.[field] === undefined) errors.push(`result is missing ${field}`);
  }
  if (command.resultSchema !== undefined) {
    try {
      if (!Value.Check(command.resultSchema as TSchema, result)) {
        const diagnostics = resultSchemaMismatchDiagnostics(
          command.resultSchema as TSchema,
          result,
        );
        errors.push(
          ...(diagnostics.length > 0
            ? diagnostics
            : ["result does not match the configured schema"]),
        );
      }
    } catch {
      fail(
        "check_result_schema",
        `compiled result schema for ${command.checkId} is not executable`,
      );
    }
  }
  const definition = configuration.registries.checks[command.checkId];
  if (definition === undefined) {
    fail(
      "check_definition_drift",
      `check ${command.checkId} definition changed during result compilation`,
    );
  }
  const definitionCurrent =
    command.executionPolicy === undefined
      ? canonicalHash(definition) === command.definitionHash
      : (() => {
          const semantics = requireExecutionSemanticCatalog(configuration).checks[command.checkId];
          return (
            semantics !== undefined &&
            semantics.sha256 === command.definitionHash &&
            semantics.sha256 === command.executionPolicy.checkSha256
          );
        })();
  if (!definitionCurrent) {
    fail(
      "check_definition_drift",
      `check ${command.checkId} definition changed during result compilation`,
    );
  }
  validateDynamicCheckResult(definition, resultObject, descriptor, command, errors);
  const acceptance = optionalRecord(definition.result_acceptance);
  let semanticPassing = true;
  if (acceptance !== undefined) {
    const field = requiredNonempty(acceptance.field, `${command.checkId} result acceptance field`);
    const values = Array.isArray(acceptance.values) ? acceptance.values : [];
    semanticPassing =
      resultObject !== undefined &&
      values.some((value) => canonicalHash(value) === canonicalHash(resultObject[field] ?? null));
  }
  const outputFiles = validateCheckOutputFiles(
    execution.outputFiles,
    command,
    resultObject,
    errors,
  );
  const contractValid = errors.length === 0;
  const passed = contractValid && exitAccepted && semanticPassing;
  const accepted =
    contractValid && exitAccepted && (semanticPassing || command.allowNonpassingReceipt);
  const value: JsonValue = {
    checkId: command.checkId,
    accepted,
    passed,
    exitCode: execution.exitCode,
    signal: execution.signal,
    result,
    outputFiles,
    errors,
  };
  return {
    accepted,
    passed,
    ...(infrastructureFailure === undefined ? {} : { infrastructureFailure }),
    value,
    evidence: {
      checkId: command.checkId,
      definitionHash: command.definitionHash,
      commandSha256: canonicalHash(command),
      ...(execution.attemptNumber === undefined
        ? {}
        : {
            attemptNumber: execution.attemptNumber,
            retryAuditSha256: execution.retryAuditSha256!,
          }),
      argvSha256: canonicalHash(command.argv),
      resolvedExecutable: execution.resolvedExecutable,
      environmentSha256: execution.environmentSha256,
      sandboxKind: execution.sandboxKind,
      sandboxProfileSha256: execution.sandboxProfileSha256,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      exitCode: execution.exitCode,
      signal: execution.signal,
      stdoutSha256: execution.stdoutSha256,
      stderrSha256: execution.stderrSha256,
      preManifestSha256: execution.preManifestSha256,
      postManifestSha256: execution.postManifestSha256,
      resultSource: execution.resultSource,
      outputFiles: outputFiles,
      accepted,
      passed,
      errors,
    },
  };
}

function validateDynamicCheckResult(
  definition: ConfigurationObject,
  result: Record<string, unknown> | undefined,
  descriptor: AttemptDescriptor,
  command: ResolvedAgentCheckCommand,
  errors: string[],
): void {
  if (result === undefined) return;
  const identityField = optionalString(definition.result_identity_field);
  if (identityField !== undefined) {
    const targets = descriptor.definition?.target_node_ids ?? [];
    if (targets.length !== 1 || result[identityField] !== targets[0]) {
      errors.push(`result ${identityField} is not the exact compiler target identity`);
    }
  }
  const dynamic = optionalRecord(definition.dynamic_result);
  const requiredKeys = optionalRecord(dynamic?.required_keys);
  if (requiredKeys !== undefined) {
    const source = optionalRecord(requiredKeys.source);
    const actualField = requiredNonempty(
      requiredKeys.actual_field,
      `${command.checkId} dynamic actual field`,
    );
    const root = descriptor.graph === undefined ? undefined : ticketCommandRoot(descriptor);
    const expected =
      source === undefined || root === undefined
        ? undefined
        : dynamicValuePath(
            root,
            requiredNonempty(source.field, `${command.checkId} required key source`),
            {},
          );
    const actual = result[actualField];
    if (
      !Array.isArray(expected) ||
      expected.some((item) => typeof item !== "string") ||
      !isRecord(actual)
    ) {
      errors.push("dynamic required-key contract could not be resolved");
    } else if ((expected as string[]).some((key) => actual[key] === undefined)) {
      errors.push(`result ${actualField} does not contain every compiler-required key`);
    }
  }
}

function validateCheckOutputFiles(
  files: AgentCheckExecution["outputFiles"],
  command: ResolvedAgentCheckCommand,
  result: Record<string, unknown> | undefined,
  errors: string[],
): Array<{ path: string; sha256: Sha256Digest; sizeBytes: number }> {
  const output = files
    .map((file) => {
      const normalized = normalizeCheckPath(file.path, `${command.checkId} output artifact`);
      if (
        !isSha256Digest(file.sha256) ||
        !Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0
      ) {
        fail(
          "check_output_file",
          `check ${command.checkId} has invalid authority output-file metadata`,
        );
      }
      if (command.effect !== "workspace_write")
        errors.push("read-only check reported output files");
      else
        assertPathInScopes(normalized, command.outputPaths, `${command.checkId} output artifact`);
      return { path: normalized, sha256: file.sha256, sizeBytes: file.sizeBytes };
    })
    .sort((left, right) => compareText(left.path, right.path));
  if (new Set(output.map((file) => file.path)).size !== output.length) {
    fail("check_output_file", `check ${command.checkId} reported duplicate output files`);
  }
  const selector = command.outputArtifactSelector;
  if (selector !== undefined) {
    const raw = result?.[selector.field];
    if (!Array.isArray(raw)) {
      errors.push(`result ${selector.field} is not an artifact list`);
    } else {
      const expected: string[] = [];
      for (const item of raw) {
        const pathValue =
          typeof item === "string" && selector.allowPathStrings
            ? item
            : isRecord(item)
              ? item[selector.pathField]
              : undefined;
        if (typeof pathValue !== "string") {
          errors.push(`result ${selector.field} contains an invalid artifact path`);
          continue;
        }
        expected.push(normalizeCheckPath(pathValue, `${command.checkId} result artifact`));
      }
      if (
        canonicalHash([...new Set(expected)].sort(compareText)) !==
        canonicalHash(output.map((file) => file.path))
      ) {
        errors.push("authority output-file inventory differs from the typed result artifacts");
      }
    }
  }
  return output;
}

function ticketCommandRoot(descriptor: AttemptDescriptor): ConfigurationValue | undefined {
  if (descriptor.graph === undefined) return undefined;
  const ids = descriptor.definition?.target_node_ids ?? [];
  if (ids.length !== 1) return undefined;
  return descriptor.graph.node(ids[0]!)?.spec;
}

async function evaluateRequestedGraphCheck(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  projectRoot: string,
  checkId: string,
  targetIds: readonly string[],
): Promise<boolean> {
  const definition = configuration.registries.checks[checkId];
  if (
    definition === undefined ||
    definition.kind !== "graph" ||
    definition.predicate === undefined ||
    targetIds.length === 0
  ) {
    return false;
  }
  const adapter = await createProductionRuleDomainAdapter({ configuration, graph, projectRoot });
  const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
  return [...new Set(targetIds)].every((id) =>
    evaluator.withBinding("target", [id], () => evaluator.evaluate(definition.predicate!)),
  );
}

function mergeCheckRuleEvidence(input: {
  prior: RuleAuthorityEvidence | undefined;
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  descriptor: AttemptDescriptor;
  resolved: ResolvedAgentCheck;
  accepted: boolean;
  passed: boolean;
  evidenceId: string;
  recordedAt: string;
}): RuleAuthorityEvidence {
  const inputGraphSha256 = ruleInputGraphSha256(input.configuration, input.graph);
  const predicates = structuredClone(input.prior?.predicates ?? {}) as Record<
    Sha256Digest,
    import("./domain-adapter.js").RulePredicateEvidence
  >;
  const receiptTypes = new Set(input.resolved.commands.map((command) => command.receiptType));
  const gatePolicies = new Set(
    input.resolved.commands.flatMap((command) => {
      const source = optionalRecord(
        input.configuration.registries.checks[command.checkId]?.command_source,
      );
      const policy = optionalString(source?.gate_policy);
      return policy === undefined ? [] : [policy];
    }),
  );
  const leaves: Array<{ leaf: ConfigurationObject; result: boolean }> = [];
  collectEvidenceLeaves(
    input.configuration.registries,
    input.resolved,
    receiptTypes,
    gatePolicies,
    input.accepted,
    input.passed,
    leaves,
  );
  if (
    !leaves.some(
      (item) =>
        item.leaf.op === "check_passed" && item.leaf.check === input.resolved.requestedCheckId,
    )
  ) {
    leaves.push({
      leaf: { op: "check_passed", check: input.resolved.requestedCheckId },
      result: input.passed,
    });
  }
  const targets = evidenceSubjectNodeIds(
    input.configuration,
    input.graph,
    input.descriptor,
    input.resolved.requestedCheckId,
  );
  for (const subjectNodeId of [...new Set(targets)].sort(compareText)) {
    for (const { leaf, result } of leaves) {
      const bindings = Object.fromEntries(
        [...rulePredicateBindingNames(leaf)]
          .sort(compareText)
          .map((name) => [name, [subjectNodeId]]),
      );
      const key = rulePredicateEvidenceKey({
        configurationSha256: input.configuration.configuration_sha256,
        inputGraphSha256,
        leaf,
        subjectNodeId,
        bindings,
      });
      predicates[key] = {
        key,
        result,
        recordedAt: input.recordedAt,
        sourceReceiptIds: [input.evidenceId],
        leaf: structuredClone(leaf),
        subjectNodeId,
        bindings,
      };
    }
  }
  return createRuleAuthorityEvidence({
    protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
    configurationSha256: input.configuration.configuration_sha256,
    inputGraphSha256,
    predicates,
  });
}

function collectProofPreparationLeaves(
  configuration: CompiledConfiguration,
): ConfigurationObject[] {
  const unique = new Map<Sha256Digest, ConfigurationObject>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.op === "proof_preparation_current") {
      const leaf = structuredClone(value) as ConfigurationObject;
      unique.set(canonicalHash(leaf), leaf);
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const registry of Object.values(configuration.registries)) visit(registry);
  return [...unique.values()].sort((left, right) =>
    compareText(canonicalHash(left), canonicalHash(right)),
  );
}

function withRuleBindings<Value>(
  evaluator: GraphExpressionEvaluator,
  bindings: Readonly<Record<string, readonly string[]>>,
  evaluate: () => Value,
): Value {
  const entries = Object.entries(bindings).sort(([left], [right]) => compareText(left, right));
  const descend = (index: number): Value => {
    const entry = entries[index];
    if (entry === undefined) return evaluate();
    return evaluator.withBinding(entry[0], entry[1], () => descend(index + 1));
  };
  return descend(0);
}

function allReviewCandidates(run: RunRecord): ProofPreparationReviewCandidate[] {
  const attemptOrder = new Map(Object.keys(run.attempts).map((id, index) => [id, index]));
  const candidates: ProofPreparationReviewCandidate[] = [];
  for (const ticket of Object.values(run.tickets)) {
    for (const step of ticket.steps.filter((candidate) => candidate.kind === "review")) {
      for (const attemptId of step.attemptIds) {
        const attempt = run.attempts[attemptId];
        if (attempt === undefined || attempt.ticketId !== ticket.id || attempt.stepId !== step.id)
          continue;
        candidates.push({
          ticket,
          step,
          attempt,
          attemptOrder: attemptOrder.get(attempt.id) ?? -1,
        });
      }
    }
  }
  return candidates.sort(
    (left, right) =>
      left.attemptOrder - right.attemptOrder || compareText(left.attempt.id, right.attempt.id),
  );
}

function latestReviewCandidate(
  run: RunRecord,
  operationId: string,
  subjectId: string,
  attemptOrder: ReadonlyMap<string, number>,
): ProofPreparationReviewCandidate | undefined {
  const candidates: ProofPreparationReviewCandidate[] = [];
  for (const ticket of Object.values(run.tickets)) {
    if (ticket.operationId !== operationId || !ticket.targetNodeIds.includes(subjectId)) continue;
    for (const step of ticket.steps.filter((candidate) => candidate.kind === "review")) {
      for (const attemptId of step.attemptIds) {
        const attempt = run.attempts[attemptId];
        if (attempt === undefined || attempt.ticketId !== ticket.id || attempt.stepId !== step.id)
          continue;
        candidates.push({
          ticket,
          step,
          attempt,
          attemptOrder: attemptOrder.get(attempt.id) ?? -1,
        });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      left.attemptOrder - right.attemptOrder || compareText(left.attempt.id, right.attempt.id),
  );
  return candidates.at(-1);
}

/** Pure replay of configured compiler-owned review effects for one already-selected node. */
function projectPassedReviewEffects(
  configuration: CompiledConfiguration,
  operationId: string,
  reviewed: GraphNode,
  reviewId: string,
  actor: string,
): GraphNode | undefined {
  const operation = configuration.registries.operations[operationId];
  if (operation === undefined || !Array.isArray(operation.review_effects)) return undefined;
  let current = structuredClone(reviewed);
  let applied = false;
  for (const rawEffect of operation.review_effects) {
    const effect = optionalRecord(rawEffect);
    const select = optionalRecord(effect?.select);
    if (effect?.verdict !== "passed" || select === undefined) continue;
    const nodeTypes = Array.isArray(select.node_types)
      ? new Set(select.node_types.filter((value): value is string => typeof value === "string"))
      : new Set<string>();
    if (
      (nodeTypes.size > 0 && !nodeTypes.has(current.type)) ||
      !predicateMatches(current, optionalRecord(select.predicate))
    )
      continue;
    const preconditions = Array.isArray(effect.preconditions) ? effect.preconditions : [];
    if (
      preconditions.some((value) => {
        const predicate = optionalRecord(value);
        return predicate === undefined || !predicateMatches(current, predicate);
      })
    )
      return undefined;
    const set = optionalRecord(effect.set);
    if (set === undefined) return undefined;
    for (const [field, value] of Object.entries(set)) {
      const resolved = resolveReviewEffectTokens(value, reviewId, actor);
      if (field === "status") current.status = requiredNonempty(resolved, "review effect status");
      else if (field.startsWith("spec."))
        setNestedSpec(current.spec, field.slice("spec.".length), resolved);
      else return undefined;
    }
    applied = true;
  }
  return applied ? current : undefined;
}

function sourceByteEntries(value: unknown): Array<{
  path: string;
  kind: string;
  sizeBytes?: number;
  sha256?: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const entry = requiredRecord(item, "proof preparation source manifest entry");
    const projected: { path: string; kind: string; sizeBytes?: number; sha256?: string } = {
      path: requiredNonempty(entry.path, "proof preparation source path"),
      kind: requiredNonempty(entry.kind, "proof preparation source kind"),
    };
    if (typeof entry.sizeBytes === "number") projected.sizeBytes = entry.sizeBytes;
    if (typeof entry.sha256 === "string") projected.sha256 = entry.sha256;
    return projected;
  });
}

function evidenceSubjectNodeIds(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  descriptor: AttemptDescriptor,
  requestedCheckId: string,
): string[] {
  const targets = descriptor.definition?.target_node_ids ?? descriptor.readNodeIds;
  const definition = configuration.registries.checks[requestedCheckId];
  const graphSet = optionalRecord(definition?.graph_set);
  if (definition?.kind !== "composite" || graphSet?.members === undefined) {
    return [...new Set(targets)].filter((id) => graph.node(id) !== undefined).sort(compareText);
  }
  const evaluator = new GraphExpressionEvaluator(configuration, graph);
  const memberTypes = new Set(
    stringArray(graphSet.member_node_types, `${requestedCheckId} member node types`),
  );
  const excluded = new Set(
    stringArray(graphSet.status_excluding, `${requestedCheckId} excluded statuses`),
  );
  return evaluator
    .withBinding("target", targets, () => evaluator.select(graphSet.members!))
    .filter((id) => {
      const node = graph.node(id);
      return (
        node !== undefined &&
        (memberTypes.size === 0 || memberTypes.has(node.type)) &&
        !excluded.has(node.status)
      );
    })
    .filter((id, index, values) => values.indexOf(id) === index)
    .sort(compareText);
}

function collectEvidenceLeaves(
  value: unknown,
  resolved: ResolvedAgentCheck,
  receiptTypes: ReadonlySet<string>,
  gatePolicies: ReadonlySet<string>,
  accepted: boolean,
  passed: boolean,
  output: Array<{ leaf: ConfigurationObject; result: boolean }>,
): void {
  if (Array.isArray(value)) {
    for (const item of value)
      collectEvidenceLeaves(item, resolved, receiptTypes, gatePolicies, accepted, passed, output);
    return;
  }
  if (!isRecord(value)) return;
  const op = value.op;
  if (op === "check_passed" && value.check === resolved.requestedCheckId) {
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: passed });
  } else if (op === "check_has_current_terminal" && value.check === resolved.requestedCheckId) {
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: accepted });
  } else if (
    op === "current_receipt" &&
    typeof value.receipt_type === "string" &&
    receiptTypes.has(value.receipt_type)
  ) {
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: accepted });
  } else if (
    (op === "gate_policy_has_current_terminal" || op === "gate_policy_satisfied") &&
    typeof value.gate_policy === "string" &&
    gatePolicies.has(value.gate_policy)
  ) {
    output.push({
      leaf: structuredClone(value) as ConfigurationObject,
      result: op === "gate_policy_satisfied" ? passed : accepted,
    });
  } else if (
    op === "gate_policy_receipt_refused" &&
    typeof value.gate_policy === "string" &&
    gatePolicies.has(value.gate_policy)
  ) {
    // A refused receipt (contract failure) is durably distinct from "never ran": evidence exists
    // with a false acceptance. Without this leaf that distinction is invisible to rules, and a
    // gate whose verifier cannot produce a valid receipt re-emits its run-gate ticket forever
    // while no operation with write access is ever told to repair the verifier.
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: !accepted });
  }
  for (const child of Object.values(value))
    collectEvidenceLeaves(child, resolved, receiptTypes, gatePolicies, accepted, passed, output);
}

function runRuleEvidence(
  run: RunRecord,
  configurationSha256: Sha256Digest,
  inputGraphSha256: Sha256Digest,
): RuleAuthorityEvidence | undefined {
  const value = run.ruleAuthorityEvidence;
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.protocol !== RULE_AUTHORITY_EVIDENCE_PROTOCOL ||
    !isSha256Digest(value.configurationSha256) ||
    !isSha256Digest(value.inputGraphSha256) ||
    !isSha256Digest(value.evidenceSha256) ||
    !isRecord(value.predicates)
  ) {
    fail("rule_evidence_shape", "durable rule-authority evidence is malformed");
  }
  const { evidenceSha256, ...material } = structuredClone(value);
  if (canonicalHash(material) !== evidenceSha256)
    fail("rule_evidence_hash", "durable rule-authority evidence failed its integrity hash");
  if (
    value.configurationSha256 !== configurationSha256 ||
    value.inputGraphSha256 !== inputGraphSha256
  )
    return undefined;
  return value as unknown as RuleAuthorityEvidence;
}

/**
 * A configured receipt is recorded against the exact compiler graph observed by its command.
 * Later compiler work may add delivery metadata or advance lifecycle statuses without changing
 * the nodes, paths, or command bindings that the receipt actually authenticated. Re-running the
 * command in that case is wasteful and can create a circular proof ticket.
 *
 * Re-key each predicate independently only when its recursively resolved check scope is byte-for-
 * byte identical after ignoring status values that do not change composite membership. Anything
 * we cannot project exactly is dropped fail-closed. Semantic changes to a checked node, a selected
 * member, command source, or member set therefore still invalidate the receipt.
 */
export function rebindRuleEvidenceAcrossNonInterferingGraphChange(input: {
  configuration: CompiledConfiguration;
  before: TypedGraph;
  after: TypedGraph;
  evidence: RuleAuthorityEvidence | undefined;
}): RuleAuthorityEvidence | undefined {
  if (input.evidence === undefined) return undefined;
  const beforeSha256 = ruleInputGraphSha256(input.configuration, input.before);
  if (
    input.evidence.configurationSha256 !== input.configuration.configuration_sha256 ||
    input.evidence.inputGraphSha256 !== beforeSha256
  )
    return undefined;
  const afterSha256 = ruleInputGraphSha256(input.configuration, input.after);
  if (afterSha256 === beforeSha256) return input.evidence;
  const predicates: Record<Sha256Digest, RulePredicateEvidence> = Object.create(null) as Record<
    Sha256Digest,
    RulePredicateEvidence
  >;
  for (const evidence of Object.values(input.evidence.predicates)) {
    if (evidence.leaf === undefined) continue;
    const beforeScope = ruleEvidencePredicateGraphScopeSha256(
      input.configuration,
      input.before,
      evidence,
    );
    const afterScope = ruleEvidencePredicateGraphScopeSha256(
      input.configuration,
      input.after,
      evidence,
    );
    if (beforeScope === undefined || beforeScope !== afterScope) continue;
    const key = rulePredicateEvidenceKey({
      configurationSha256: input.configuration.configuration_sha256,
      inputGraphSha256: afterSha256,
      leaf: evidence.leaf,
      ...(evidence.subjectNodeId === undefined ? {} : { subjectNodeId: evidence.subjectNodeId }),
      bindings: evidence.bindings ?? {},
    });
    predicates[key] = { ...structuredClone(evidence), key };
  }
  if (Object.keys(predicates).length === 0) return undefined;
  return createRuleAuthorityEvidence({
    protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
    configurationSha256: input.configuration.configuration_sha256,
    inputGraphSha256: afterSha256,
    predicates,
  });
}

/** Compatibility name retained for callers compiled against the narrower first implementation. */
export function rebindRuleEvidenceAcrossStatusOnlyReviewEffects(input: {
  configuration: CompiledConfiguration;
  before: TypedGraph;
  after: TypedGraph;
  evidence: RuleAuthorityEvidence | undefined;
}): RuleAuthorityEvidence | undefined {
  return rebindRuleEvidenceAcrossNonInterferingGraphChange(input);
}

function ruleEvidencePredicateGraphScopeSha256(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  evidence: RulePredicateEvidence,
): Sha256Digest | undefined {
  const leaf = evidence.leaf;
  if (leaf === undefined) return undefined;
  const op = optionalString(leaf.op);
  if (
    op === "gate_policy_satisfied" ||
    op === "gate_policy_has_current_terminal" ||
    op === "gate_policy_receipt_refused"
  ) {
    const policyId = optionalString(leaf.gate_policy) ?? optionalString(leaf.policy);
    const gateId = evidence.subjectNodeId;
    const gateSubject = optionalString(leaf.gate_subject) ?? "$gate";
    const bindingName = /^\$([A-Za-z_][A-Za-z0-9_-]*)$/u.exec(gateSubject)?.[1];
    if (
      policyId === undefined ||
      gateId === undefined ||
      bindingName === undefined ||
      canonicalHash(evidence.bindings?.[bindingName] ?? []) !== canonicalHash([gateId])
    ) {
      return undefined;
    }
    try {
      const material = gatePolicyEvidenceGraphScopeMaterial(configuration, graph, policyId, gateId);
      return material === undefined ? undefined : canonicalHash({ op, material });
    } catch {
      return undefined;
    }
  }
  if (op === "check_passed" || op === "check_has_current_terminal") {
    const checkId = optionalString(leaf.check);
    if (checkId === undefined || evidence.subjectNodeId === undefined) return undefined;
    try {
      const evaluator = new GraphExpressionEvaluator(configuration, graph);
      const material = checkEvidenceGraphScopeMaterial(
        configuration,
        graph,
        evaluator,
        checkId,
        [evidence.subjectNodeId],
        [],
      );
      return material === undefined ? undefined : canonicalHash(material);
    } catch {
      return undefined;
    }
  }
  if (op !== "current_receipt") return undefined;
  const ids = new Set<string>();
  if (evidence.subjectNodeId !== undefined) ids.add(evidence.subjectNodeId);
  const bindings = evidence.bindings ?? {};
  for (const name of rulePredicateBindingNames(leaf)) {
    const bound = bindings[name];
    if (bound === undefined) return undefined;
    for (const id of bound) ids.add(id);
  }
  if (ids.size === 0) return undefined;
  const nodes = [...ids].sort(compareText).map((id) => {
    const node = graph.node(id);
    if (node === undefined) throw new Error(`evidence scope references missing node ${id}`);
    return graphNodeEvidenceMaterial(node);
  });
  return canonicalHash({ op, nodes });
}

function checkEvidenceGraphScopeMaterial(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  evaluator: GraphExpressionEvaluator,
  checkId: string,
  subjectIds: readonly string[],
  stack: readonly string[],
): ConfigurationValue | undefined {
  if (stack.includes(checkId) || subjectIds.length === 0) return undefined;
  const definition = configuration.registries.checks[checkId];
  const kind = optionalString(definition?.kind);
  if (definition === undefined || kind === undefined || kind === "graph") return undefined;
  const subjects = [...new Set(subjectIds)].sort(compareText);
  if (kind === "command") {
    const commandSource = optionalRecord(definition.command_source);
    const gatePolicyId = optionalString(commandSource?.gate_policy);
    if (gatePolicyId !== undefined) {
      const scopes: ConfigurationValue[] = [];
      for (const gateId of subjects) {
        const scope = gatePolicyEvidenceGraphScopeMaterial(
          configuration,
          graph,
          gatePolicyId,
          gateId,
        );
        if (scope === undefined) return undefined;
        scopes.push(scope);
      }
      return { check: checkId, kind, gate_policy: gatePolicyId, scopes };
    }
    return {
      check: checkId,
      kind,
      subjects: subjects.map((id) => {
        const node = graph.node(id);
        if (node === undefined) throw new Error(`check scope references missing node ${id}`);
        return graphNodeEvidenceMaterial(node);
      }),
    };
  }
  if (kind !== "composite") return undefined;
  const set = optionalRecord(definition.graph_set);
  const selector = set?.members;
  if (set === undefined || selector === undefined) return undefined;
  const selected = evaluator.withBinding("target", subjects, () => evaluator.select(selector));
  const memberTypes = new Set(stringArray(set.member_node_types, `${checkId} member node types`));
  const excluded = new Set(stringArray(set.status_excluding, `${checkId} excluded statuses`));
  const members = selected
    .flatMap((id) => {
      const node = graph.node(id);
      if (
        node === undefined ||
        (memberTypes.size > 0 && !memberTypes.has(node.type)) ||
        excluded.has(node.status)
      ) {
        return [];
      }
      return [node];
    })
    .sort((left, right) => compareText(left.id, right.id));
  const configuredChild = optionalString(set.member_check);
  const childField = optionalString(set.member_check_field);
  const projectedMembers: ConfigurationValue[] = [];
  for (const node of members) {
    const childId =
      configuredChild ??
      (childField === undefined ? undefined : optionalString(graphNodeField(node, childField)));
    if (childId === undefined) return undefined;
    const child = checkEvidenceGraphScopeMaterial(
      configuration,
      graph,
      evaluator,
      childId,
      [node.id],
      [...stack, checkId],
    );
    if (child === undefined) return undefined;
    projectedMembers.push({ node: graphNodeEvidenceMaterial(node), child });
  }
  return { check: checkId, kind, members: projectedMembers };
}

/**
 * Exact graph footprint that can change one gate-policy command or the meaning of its verdict.
 *
 * The full graph is intentionally not included: unrelated research nodes may advance after a gate
 * passes. Candidate-pool membership, policy selection, applicability context, and every node the
 * compiled context exposes are included, so any relevant semantic change still invalidates the
 * receipt fail-closed.
 */
function gatePolicyEvidenceGraphScopeMaterial(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  policyId: string,
  gateId: string,
): ConfigurationValue | undefined {
  const configured = configuration.registries.gate_policies[policyId];
  const gate = graph.node(gateId);
  if (configured === undefined || gate === undefined) return undefined;
  const evaluator = new GraphExpressionEvaluator(
    configuration,
    graph,
    createPolicySelectionRuleDomainAdapter(),
  );
  evaluator.bind("gate", [gateId]);
  const candidatePool = configured.candidate_pool;
  const evaluationTargets = optionalRecord(configured.evaluation_targets);
  if (candidatePool === undefined || evaluationTargets?.select === undefined) return undefined;
  const candidateIds = [...evaluator.select(candidatePool)];
  const winnerIds = [
    ...evaluator.select({
      policy_selection: { policy: policyId, gate: { ids: [gateId] }, result: "winner" },
    }),
  ];
  if (winnerIds.length > 1) return undefined;
  const targetIds = [...evaluator.select(evaluationTargets.select)];
  const selectApplicability = (
    result: "ancestors" | "direct_gates" | "inherited_gates" | "applicable_gates",
  ): string[] => [
    ...evaluator.select({
      policy_applicability: {
        policy: policyId,
        subject: { ids: targetIds },
        result,
      },
    }),
  ];
  const ancestors = selectApplicability("ancestors");
  const direct = selectApplicability("direct_gates");
  const inherited = selectApplicability("inherited_gates");
  const applicable = [...new Set([...direct, ...inherited])].sort(compareText);
  evaluator.bind("winner", winnerIds);
  evaluator.bind("candidate", winnerIds);
  evaluator.bind("target", targetIds);
  evaluator.bind("evaluation_targets", targetIds);
  evaluator.bind("ancestors", ancestors);
  evaluator.bind("direct_gates", direct);
  evaluator.bind("inherited_gates", inherited);
  evaluator.bind("applicable_gates", applicable);
  const context = optionalRecord(configured.context);
  const contextIds = context?.select === undefined ? [] : [...evaluator.select(context.select)];
  evaluator.bind("context", contextIds);
  const readPaths = new Set<string>();
  const configuredReadPaths = context?.read_paths;
  if (configuredReadPaths !== undefined && !Array.isArray(configuredReadPaths)) return undefined;
  for (const definition of (configuredReadPaths ?? []) as readonly ConfigurationValue[]) {
    if (typeof definition === "string") {
      readPaths.add(definition);
      continue;
    }
    const projected = optionalRecord(definition);
    const field = optionalString(projected?.field);
    if (projected?.select === undefined || field === undefined) return undefined;
    for (const nodeId of evaluator.select(projected.select)) {
      const value = evaluator.field(nodeId, field);
      if (typeof value === "string") readPaths.add(value);
      else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        for (const item of value) readPaths.add(item);
      } else if (value !== undefined) return undefined;
    }
  }
  const nodes = (ids: readonly string[]): ConfigurationValue[] =>
    [...new Set(ids)].sort(compareText).map((id) => {
      const node = graph.node(id);
      if (node === undefined) throw new Error(`gate policy scope references missing node ${id}`);
      return graphNodeEvidenceMaterial(node);
    });
  return {
    protocol: "koni.gate-policy-evidence-graph-scope.v1",
    policy_id: policyId,
    policy: structuredClone(configured),
    gate: graphNodeEvidenceMaterial(gate),
    candidates: nodes(candidateIds),
    winners: nodes(winnerIds),
    evaluation_targets: nodes(targetIds),
    ancestors: nodes(ancestors),
    direct_gates: nodes(direct),
    inherited_gates: nodes(inherited),
    applicable_gates: nodes(applicable),
    context_nodes: nodes(contextIds),
    read_paths: [...readPaths].sort(compareText),
  };
}

function graphNodeEvidenceMaterial(node: CompilerGraphNode): ConfigurationObject {
  const { status: _status, ...material } = structuredClone(node);
  return material;
}

function isIsoTimestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function requiredToolString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    fail("tool_arguments", `${field} must be a nonempty safe string`);
  }
  return value;
}

function optionalToolString(args: Record<string, unknown>, field: string): string | undefined {
  return args[field] === undefined ? undefined : requiredToolString(args, field);
}

function optionalToolStringArray(
  args: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    fail("tool_arguments", `${field} must be an array of nonempty strings`);
  }
  return value as string[];
}

function optionalToolInteger(args: Record<string, unknown>, field: string): number | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) fail("tool_arguments", `${field} must be an integer`);
  return value as number;
}

function requiredToolInteger(args: Record<string, unknown>, field: string): number {
  const value = optionalToolInteger(args, field);
  if (value === undefined) fail("tool_arguments", `${field} is required`);
  return value;
}

function dynamicRelationArcs(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
): Array<{ from: string; relation: string; to: string }> {
  const arcs: Array<{ from: string; relation: string; to: string }> = [];
  for (const edge of graph.edges()) {
    arcs.push({ from: edge.source, relation: edge.relation, to: edge.target });
    const source = graph.node(edge.source);
    const target = graph.node(edge.target);
    const definition =
      source === undefined || target === undefined
        ? undefined
        : configuration.edge_types.find(
            (candidate) =>
              candidate.source === source.type &&
              candidate.relation === edge.relation &&
              Array.isArray(candidate.targets) &&
              candidate.targets.includes(target.type),
          );
    if (definition?.bidirectional === true && typeof definition.inverse === "string") {
      arcs.push({ from: edge.target, relation: definition.inverse, to: edge.source });
    }
  }
  return arcs.sort(
    (left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.relation, right.relation) ||
      compareText(left.to, right.to),
  );
}

function parseDynamicGraphSelectionRequest(
  args: Record<string, unknown>,
): DynamicGraphSelectionRequest {
  const anchors = optionalToolStringArray(args, "anchors");
  const relations = optionalToolStringArray(args, "relations");
  const nodeTypes = optionalToolStringArray(args, "nodeTypes");
  const direction = optionalToolString(args, "direction");
  if (
    direction !== undefined &&
    direction !== "outgoing" &&
    direction !== "incoming" &&
    direction !== "both"
  ) {
    fail("graph_context_direction", `unsupported graph context direction ${direction}`);
  }
  const maxDepth = optionalToolInteger(args, "maxDepth") ?? 1;
  if (maxDepth < 0 || maxDepth > 16) {
    fail("graph_context_depth", "graph context depth must be between zero and sixteen");
  }
  return {
    ...(anchors === undefined ? {} : { anchors }),
    ...(relations === undefined ? {} : { relations }),
    ...(direction === undefined ? {} : { direction }),
    maxDepth,
    ...(nodeTypes === undefined ? {} : { nodeTypes }),
  };
}

function normalizeReferencedPaths(
  values: readonly string[],
  grant: AuthorityGrant,
  label: string,
): string[] {
  const scopes = [...new Set([...grant.readPaths, ...grant.writePaths])];
  const output = new Set<string>();
  for (const value of values) {
    if (
      value !== "." &&
      (value.length === 0 ||
        value.length > 16 * 1024 ||
        value.startsWith("/") ||
        /^[A-Za-z]:\//u.test(value) ||
        value.includes("\\") ||
        value.includes("\u0000") ||
        value.split("/").some((part) => part === "" || part === "." || part === ".."))
    )
      fail(
        `${label.replaceAll(" ", "_")}_path`,
        `${label} path ${value} is not normalized and repository-relative`,
      );
    if (
      !scopes.some((scope) => scope === "." || value === scope || value.startsWith(`${scope}/`))
    ) {
      fail(
        `${label.replaceAll(" ", "_")}_scope`,
        `${label} path ${value} is outside this attempt's read/write scope`,
      );
    }
    output.add(value);
  }
  return [...output].sort(compareText);
}

function contextualProvenance<Kind extends "owner_update" | "change_note">(
  kind: Kind,
  run: RunRecord,
  attempt: AgentAttemptRecord,
  spec: Readonly<AgentLaunchSpec>,
  semanticRevision: number,
  semanticHash: Sha256Digest,
  contextual: GraphContextualState,
  recordedAt: string,
): ContextualRecordProvenance & { kind: Kind } {
  return {
    kind,
    runId: run.id,
    generation: run.generation,
    ticketId: attempt.ticketId,
    stepId: attempt.stepId,
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    personaId: attempt.personaId,
    authorityGrantHash: spec.authority.grantHash,
    launchSpecHash: spec.specHash,
    authoritativeContextHash: spec.authority.authoritativeContextHash,
    semanticRevision,
    semanticHash,
    contextualRevision: contextual.revision,
    contextualHash: contextual.hash,
    lineage: structuredClone(spec.lineage),
    recordedAt,
  };
}

function compatibleAttemptLineage(
  run: RunRecord,
  active: AgentAttemptRecord,
): { compatible: Set<string>; abandoned: Set<string> } {
  const abandonedStatuses = new Set<AttemptStatus>(["failed", "aborted", "interrupted"]);
  const abandoned = new Set(
    Object.values(run.attempts)
      .filter((attempt) => abandonedStatuses.has(attempt.status))
      .map((attempt) => attempt.id),
  );
  const ancestors = new Set<string>([active.id]);
  let cursor: AgentAttemptRecord | undefined = active;
  while (
    cursor?.lineage?.parentAttemptId !== undefined &&
    !ancestors.has(cursor.lineage.parentAttemptId)
  ) {
    ancestors.add(cursor.lineage.parentAttemptId);
    cursor = run.attempts[cursor.lineage.parentAttemptId];
  }
  const lineageGroup = (attempt: AgentAttemptRecord): string =>
    `${recoveredAttemptKind(run, attempt)}\u0000${attempt.ticketId}\u0000${attempt.stepId}`;
  const activeGroup = lineageGroup(active);
  const compatible = new Set<string>();
  for (const attempt of Object.values(run.attempts)) {
    if (abandoned.has(attempt.id)) continue;
    // Attempts for other ticket steps are independent linear histories, not sibling branches of
    // this attempt. Within the same history, only the active ancestry (plus unversioned legacy
    // roots) is compatible; completed sibling rework/retry branches remain excluded.
    if (
      lineageGroup(attempt) !== activeGroup ||
      ancestors.has(attempt.id) ||
      attempt.lineage === undefined
    ) {
      compatible.add(attempt.id);
    }
  }
  compatible.add(active.id);
  return { compatible, abandoned };
}

function isGraphNoteKind(value: unknown): value is GraphNoteArtifact["kind"] {
  return (
    value === "observation" ||
    value === "implementation_detail" ||
    value === "rationale" ||
    value === "nit" ||
    value === "open_question"
  );
}

function compilerActivity(
  run: RunRecord,
  message: string,
  salt: string,
  tone?: RunActivityRecord["tone"],
): RunActivityRecord {
  const at = new Date().toISOString();
  return {
    id: `activity-${digestBody(canonicalHash([run.id, run.revision, salt, message])).slice(0, 20)}`,
    at,
    kind: "compiler",
    message,
    ticketId: undefined,
    nodeId: undefined,
    ...(tone === undefined ? {} : { tone }),
  };
}

function graphActivity(
  run: RunRecord,
  kind: Extract<RunActivityRecord["kind"], "graph_added" | "graph_modified" | "graph_deleted">,
  node: Pick<GraphNode, "id" | "type" | "title">,
  salt: string,
): RunActivityRecord {
  const verb = kind === "graph_added" ? "Added" : kind === "graph_deleted" ? "Deleted" : "Modified";
  return {
    id: `activity-${digestBody(canonicalHash([run.id, run.revision, salt, kind, node.id])).slice(0, 20)}`,
    at: new Date().toISOString(),
    kind,
    message: `${verb} ${node.type}: ${node.title}`,
    ticketId: salt.startsWith("TK-") ? salt : undefined,
    nodeId: node.id,
  };
}

function boundedContext(value: unknown): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_BYTES || content.includes("\u0000"))
    fail("context_size", "compiler-issued context is oversized or unsafe");
  return content;
}

function graphArtifactPath(runId: string): string {
  return `runs/${runId}/program/graph.json`;
}
function ticketDefinitionsPath(runId: string): string {
  return `runs/${runId}/program/ticket-definitions.json`;
}
function pinnedConfigurationPath(runId: string): string {
  return `runs/${runId}/configuration/compiled.json`;
}
function evaluationPath(runId: string, revision: number): string {
  return `runs/${runId}/program/evaluations/${revision}.json`;
}
function graphNotePath(runId: string, noteId: string): string {
  return `runs/${runId}/program/notes/${noteId}.json`;
}

function encodeRunGraphArtifact(value: GraphArtifact): Buffer {
  const bytes = encodeArtifact(value);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUN_GRAPH_BYTES || bytes.includes(0)) {
    fail("graph_artifact_size", "completed run-graph artifact exceeds its durable byte bound");
  }
  return bytes;
}

function encodeArtifact(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requireValidation<Value>(
  result: ValidationResult<Value>,
  code: string,
  message: string,
): Value {
  if (!result.ok)
    throw new NativeRunProgramError(code, message, diagnosticLines(result.diagnostics));
  return result.value;
}

function diagnosticLines(diagnostics: readonly CompilerDiagnostic[]): string[] {
  return diagnostics.map((item) => `${item.code} ${item.path}: ${item.message}`);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail("shape", `${label} must be an object`);
  return value;
}

function optionalRecord(value: unknown): ConfigurationObject | undefined {
  return value === undefined || value === null || !isRecord(value)
    ? undefined
    : (value as ConfigurationObject);
}

function jsonRecord(value: unknown, label: string): Record<string, JsonValue> {
  const record = requiredRecord(value, label);
  assertJsonValue(record, label);
  return structuredClone(record);
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key.length === 0 || key.includes("\u0000"))
        fail("json_key", `${label} contains an invalid key`);
      assertJsonValue(item, label);
    }
    return;
  }
  fail("json_value", `${label} contains a non-JSON value`);
}

function assertExactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  assertAllowedFields(record, allowed, label);
  for (const key of allowed)
    if (!Object.hasOwn(record, key)) fail("missing_field", `${label} is missing ${key}`);
}

function assertAllowedFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(record))
    if (!accepted.has(key)) fail("unknown_field", `${label} contains unknown field ${key}`);
}

function requiredNonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000"))
    fail("string", `${label} must be a nonempty safe string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredNonempty(value, "configured string");
}

function boundedText(value: unknown, label: string, maximum: number): string {
  const text = requiredNonempty(value, label);
  if (Buffer.byteLength(text, "utf8") > maximum)
    fail("text_size", `${label} exceeds ${maximum} UTF-8 bytes`);
  return text;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  )
    fail("string_array", `${label} must contain strings`);
  return [...new Set(value as string[])].sort(compareText);
}

function optionalSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function requireDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))
    fail("digest", `${label} must be a sha256 digest`);
  return value as Sha256Digest;
}

function withoutField(value: object, field: string): Record<string, unknown> {
  const cloned = structuredClone(value) as Record<string, unknown>;
  delete cloned[field];
  return cloned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function normalizeResourcePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  )
    fail("resource_path", `resource path ${value} is not a safe normalized relative path`);
  return value;
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function digestBody(value: Sha256Digest): string {
  return value.slice("sha256:".length);
}

function humanize(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function shortOid(value: string): string {
  return value.slice(0, 12);
}

function attemptWorkspace(
  run: RunRecord,
  kind: "planning" | "lead" | "ticket" | "verification" | "integration",
  ticketId: string,
): string {
  if (kind === "lead") return path.resolve(run.projectRoot);
  if (kind === "planning") {
    // The initial plan uses a detached checkout. Once approval has materialized the
    // permanent run workspace and retired that checkout, a plan revision must inspect
    // the current durable run state there rather than attempting to resurrect planning.
    if (run.git.run.status === "ready" && run.git.run.headOid !== undefined) {
      return path.resolve(run.git.run.worktree);
    }
    if (run.git.planning.status !== "ready") {
      fail("planning_workspace", "planning attempt has no ready detached checkout");
    }
    return path.resolve(run.git.planning.worktree);
  }
  if (kind === "verification") {
    if (run.git.run.status !== "ready" || run.git.run.headOid === undefined) {
      fail("run_workspace", "verification attempt has no approved run checkout");
    }
    return path.resolve(run.git.run.worktree);
  }
  const ticket = run.tickets[ticketId];
  if (ticket === undefined || ticket.gitCycleId === undefined) {
    fail("ticket_workspace", `ticket ${ticketId} has no authority-issued Git cycle`);
  }
  const cycle = run.git.ticketCycles[ticket.gitCycleId];
  if (
    cycle === undefined ||
    cycle.ticketId !== ticketId ||
    ticket.worktreePath !== cycle.worktree ||
    ticket.branch !== cycle.branchRef ||
    (cycle.status !== "active" && cycle.status !== "candidate")
  ) {
    fail("ticket_workspace", `ticket ${ticketId} Git cycle is missing, stale, or not executable`);
  }
  return path.resolve(cycle.worktree);
}

/**
 * Approved applications sometimes need to add a typed reference to an existing node that is not
 * yet connected to the write target. Preserve the exact write grant, but make nodes whose
 * repository paths are named verbatim in the reviewed, hash-bound application summary eligible
 * for dynamic read context. Terminal resolvers inherit the same provenance from their source
 * application so a failed application can be repaired without ambient graph visibility.
 */
function approvedChangeContextReferencePaths(
  run: RunRecord,
  ticket: TicketRecord | undefined,
  graph: TypedGraph,
): readonly string[] {
  const summaries: string[] = [];
  const visited = new Set<string>();
  let current = ticket;
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    const control = current.executionControl;
    const causal = control?.controlTicketAuthority?.causal;
    const materializations = [
      control?.approvedMaterialization,
      ...(causal?.role === "approved_application" ? [causal.materialization] : []),
    ];
    for (const materialization of materializations) {
      if (materialization?.kind === "application") summaries.push(materialization.selectionSummary);
    }
    const sourceTicketId =
      control?.terminalRecovery?.sourceTicketId ?? control?.sourceProposalTicketId;
    current = sourceTicketId === undefined ? undefined : run.tickets[sourceTicketId];
  }
  if (summaries.length === 0) return [];

  const referenced = new Set<string>();
  for (const node of graph.nodes()) {
    for (const repositoryPath of graph.repositoryPaths(node.id)) {
      if (summaries.some((summary) => textMentionsExactRepositoryPath(summary, repositoryPath))) {
        referenced.add(repositoryPath);
      }
    }
  }
  return [...referenced].sort(compareText);
}

function textMentionsExactRepositoryPath(text: string, repositoryPath: string): boolean {
  if (repositoryPath.length === 0) return false;
  const pathCharacter = /[A-Za-z0-9._/@+-]/u;
  for (let offset = 0; offset <= text.length - repositoryPath.length;) {
    const index = text.indexOf(repositoryPath, offset);
    if (index < 0) return false;
    const before = index === 0 ? undefined : text[index - 1];
    const afterIndex = index + repositoryPath.length;
    const after = afterIndex >= text.length ? undefined : text[afterIndex];
    if (
      (before === undefined || !pathCharacter.test(before)) &&
      (after === undefined || !pathCharacter.test(after))
    ) {
      return true;
    }
    offset = index + repositoryPath.length;
  }
  return false;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code: string, message: string, details: readonly string[] = []): never {
  throw new NativeRunProgramError(code, message, details);
}

/**
 * Koni binds whichever Pi provider the configuration names; it has no built-in vendor.
 *
 * Defaulting a missing provider to one vendor would silently execute a persona against a provider
 * the project never chose, and would hide the configuration gap behind an unrelated
 * `model_unavailable` failure on installations authenticated with a different provider.
 */
function requiredPersonaProvider(provider: string | undefined, personaId: string): string {
  if (provider !== undefined && provider.trim().length > 0) return provider;
  return fail(
    "persona_provider",
    `persona ${personaId} has no configured provider; declare one on its agent resource, its persona, or the run-type role`,
  );
}
