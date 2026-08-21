import {
  type CheckExecutionPolicyBinding,
  type CheckRetryDecision,
  type ExecutionPolicyBinding,
} from "../authority/execution-policy.js";
import type { JsonValue } from "../authority/protocol.js";
import type {
  CompiledOperationSemantics,
  CompiledWorkflowSemantics,
} from "../compiler/execution-semantics.js";
import type {
  ActionExecutionJournal,
  ActionExecutionPlan,
  CompiledActionCatalog,
  CompiledBehaviorIr,
  CompiledRunTypeBehavior,
  CompiledTokenPolicy,
} from "../contracts/behavior.js";
import type { ConfigurationObject, ConfigurationValue } from "../contracts/configuration.js";
import type { CompiledStateMachineCatalog, DerivedTicketDefinition } from "../contracts/rules.js";
import type {
  GitCompensationEvidence,
  GitLifecycleIntent,
  RunGitLifecycleRecord,
} from "../git/lifecycle.js";
import type { AgentAttemptLineage } from "../pi/launch-spec.js";
import { canonicalHash, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import {
  type ApprovedChangeMaterialization,
  type ChangeControlPublication,
  type TerminalResolverReconciliation,
} from "./change-control.js";
import { type LegacyRunGitMigrationRecord } from "./legacy-run-git-migration.js";
import { type QuestionBatchRecord } from "./question-batch.js";
import type { QuestionPolicy } from "./question-policy.js";
import type { RunLifecycleState } from "./run-lifecycle.js";

export const RUN_RECORD_PROTOCOL = "koni.run-record.v1" as const;

/** Compiler-authored semantic pipeline pinned with a run; IDs are presentation identities only. */
export interface RunPipelineStageRecord {
  id: string;
  title: string;
  kind: string;
  automatic: boolean;
}

export type TicketStatus =
  "proposed" | "queued" | "running" | "review" | "blocked" | "completed" | "cancelled";

export type TicketStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type TicketStepKind = "production" | "integration" | "review" | "agent" | "manual";

export interface TicketStepRecord {
  id: string;
  title: string;
  personaId: string;
  /** Optional only for durable records created before compiler review-rework projection. */
  kind?: TicketStepKind;
  /** Compiler-authored step DAG; absent only on legacy sequential ticket records. */
  dependsOn?: string[];
  /** Step-local graph/path authority; omitted when the complete ticket scope is inherited. */
  readNodeIds?: string[];
  writeNodeIds?: string[];
  readPaths?: string[];
  writePaths?: string[];
  /** Exact compiler-selected terminal action; absent only on pre-action-authority records. */
  validationAction?: string;
  /** Exact operation/workflow/step policy pinned when the compiler derived this step. */
  executionPolicyBinding?: ExecutionPolicyBinding;
  status: TicketStepStatus;
  attemptIds: string[];
  summary: string | undefined;
  startedAt: string | undefined;
  completedAt: string | undefined;
}

export interface TicketReviewReworkRecord {
  ordinal: number;
  /** Missing on legacy records and equivalent to `automatic`. */
  mode?: "automatic" | "supervised";
  /** Supervised recovery may preserve the last accepted producer result and rerun review only. */
  scope?: "producer_and_review" | "review_only";
  failedReviewAttemptId: string;
  reopenFromStepId: string;
  blocker: string;
  /** Optional operator-authored correction for this exact supervised rework cycle. */
  operatorSteering?: string;
  /** Exact failed semantic settlement that authorized an automatic retry. */
  failureProofSha256?: Sha256Digest;
  /** Exact direct-terminal output that the compiler rejected when no action recipe was used. */
  failureTerminalOutputSha256?: Sha256Digest;
  /** Same-transaction RPC authority that authorized a supervised or legacy retry. */
  operatorAuthorization?: ReviewReworkOperatorAuthorization;
  openedAt: string;
}

/** Raw durable proposal-decision data. Runtime validation enforces each protocol's exact union shape. */
export interface ProposalDecisionAuthorityRecord {
  protocol: "koni.proposal-decision-authority.v2" | "koni.proposal-decision-authority.v3";
  runId: string;
  proposalTicketId: string;
  requestSha256: Sha256Digest;
  eventId: string;
  decision: "approval" | "rejection";
  actor: string;
  policyAuthoritySha256?: Sha256Digest;
  message?: string;
  recordedAt: string;
  sha256: Sha256Digest;
}

export interface ReviewReworkOperatorAuthorization {
  protocol: "koni.review-rework-operator-authorization.v1";
  method: string;
  idempotencyKey: string;
  requestHash: Sha256Digest;
  sha256: Sha256Digest;
}

export interface TicketCompilerReissueDiagnosis {
  protocol: "koni.ticket-compiler-reissue-diagnosis.v1";
  kind: "configured_check_preflight" | "configured_check_result";
  sourceTicketId: string;
  executionEpoch: number;
  blocker: string;
  sourceSha256: Sha256Digest;
  openedAt: string;
  sha256: Sha256Digest;
}

export interface CompilerCheckPreflightRejectionRecord {
  protocol: "koni.compiler-check-preflight-rejection.v1";
  runId: string;
  runRevision: number;
  configurationSha256: Sha256Digest;
  consumerTicketId: string;
  consumerStepId: string;
  producerTicketIds: string[];
  producerProjectionSha256s: Sha256Digest[];
  intentSha256: Sha256Digest;
  code:
    "check_argv" | "check_input_binding" | "check_path" | "check_path_scope" | "check_result_path";
  message: string;
  recordedAt: string;
  sha256: Sha256Digest;
}

export interface PendingCompilerCheckPreflightIntentRecord {
  protocol: "koni.pending-compiler-check-preflight.v1";
  id: string;
  runId: string;
  runRevision: number;
  configurationSha256: Sha256Digest;
  consumerTicketId: string;
  consumerStepId: string;
  producerTicketIds: string[];
  producerProjectionSha256s: Sha256Digest[];
  preparedAt: string;
  sha256: Sha256Digest;
}

export const CONTROL_TICKET_AUTHORITY_PROTOCOL =
  "koni.compiler-control-ticket-authority.v1" as const;
export const TICKET_IMMUTABLE_PROJECTION_PROTOCOL = "koni.ticket-immutable-projection.v1" as const;

export type ControlTicketRole = "proposal" | "approved_application" | "terminal_resolver";

export interface TicketImmutableProjection {
  readonly protocol: typeof TICKET_IMMUTABLE_PROJECTION_PROTOCOL;
  readonly id: string;
  readonly operationId: string;
  readonly title: string;
  readonly summary: string;
  readonly executionPolicyBinding: ExecutionPolicyBinding | null;
  readonly control:
    | Readonly<{ role: "ordinary" }>
    | Readonly<{
        role: "proposal";
        changeControlScopeNodeIds: readonly string[];
        proposalRequest: NonNullable<TicketExecutionControlRecord["proposalRequest"]>;
      }>
    | Readonly<{
        role: "approved_application";
        changeControlScopeNodeIds: readonly string[];
        sourceProposalTicketId: string;
        approvedApplicationSha256: Sha256Digest;
      }>
    | Readonly<{
        role: "terminal_resolver";
        changeControlScopeNodeIds: readonly string[];
        terminalRecovery: NonNullable<TicketExecutionControlRecord["terminalRecovery"]>;
      }>;
  readonly priority: number;
  readonly dependencyIds: readonly string[];
  readonly targetNodeIds: readonly string[];
  readonly readNodeIds: readonly string[];
  readonly writeNodeIds: readonly string[];
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly reviewFailureReopenFrom: string | null;
  readonly reviewReworkLimit: number | null;
  readonly steps: readonly Readonly<{
    id: string;
    title: string;
    personaId: string;
    kind: TicketStepKind | null;
    dependsOn: readonly string[];
    readNodeIds: readonly string[];
    writeNodeIds: readonly string[];
    readPaths: readonly string[];
    writePaths: readonly string[];
    validationAction: string | null;
    executionPolicyBinding: ExecutionPolicyBinding | null;
  }>[];
  readonly integrationForTicketId: string | null;
  readonly sha256: Sha256Digest;
}

export type ControlTicketCausalAuthority =
  | Readonly<{
      role: "proposal";
      publication: ChangeControlPublication;
      sourceTicketProjection: TicketImmutableProjection;
      sourceTerminalProof: TerminalSuccessSettlementProof;
      sourceHold: Readonly<{ proposalTicketId: string; requestSha256: Sha256Digest }>;
    }>
  | Readonly<{
      role: "approved_application";
      materialization: ApprovedChangeMaterialization;
      proposalTicketAuthoritySha256: Sha256Digest;
      proposalTicketProjectionSha256: Sha256Digest;
    }>
  | Readonly<{
      role: "terminal_resolver";
      reconciliation: Exclude<TerminalResolverReconciliation, { chainSuppressed: true }>;
      sourceTicketProjection: TicketImmutableProjection;
      sourceFailureProof: TerminalFailureSettlementProof;
    }>;

export interface CompilerControlTicketAuthority {
  readonly protocol: typeof CONTROL_TICKET_AUTHORITY_PROTOCOL;
  readonly runId: string;
  readonly role: ControlTicketRole;
  readonly ticketId: string;
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly operation: CompiledOperationSemantics;
  readonly workflow: CompiledWorkflowSemantics;
  readonly definition: DerivedTicketDefinition;
  readonly causal: ControlTicketCausalAuthority;
  readonly projection: TicketImmutableProjection;
  readonly projectionSha256: Sha256Digest;
  readonly sha256: Sha256Digest;
}

export interface RecurringAssetGrantRefreshAuthority {
  readonly protocol: "koni.recurring-asset-grant-refresh.v1";
  readonly runId: string;
  readonly ticketId: string;
  readonly configurationSha256: Sha256Digest;
  readonly actionInvocationId: string;
  readonly actionBoundarySha256: Sha256Digest;
  readonly priorGraphHash: Sha256Digest;
  readonly priorGraphRevision: number;
  readonly nextGraphHash: Sha256Digest;
  readonly nextGraphRevision: number;
  readonly priorProjection: TicketImmutableProjection;
  readonly priorProjectionSha256: Sha256Digest;
  readonly refreshedProjection: TicketImmutableProjection;
  readonly nextProjectionSha256: Sha256Digest;
  readonly priorExecutionEpoch: number;
  readonly nextExecutionEpoch: number;
  readonly recordedAt: string;
  readonly sha256: Sha256Digest;
}

export interface HeldSourceGrantRefreshAuthority {
  readonly protocol: "koni.held-source-grant-refresh.v1";
  readonly runId: string;
  readonly ticketId: string;
  readonly proposalTicketId: string;
  readonly applicationTicketId: string;
  readonly configurationSha256: Sha256Digest;
  readonly actionInvocationId: string;
  readonly actionBoundarySha256: Sha256Digest;
  readonly priorGraphHash: Sha256Digest;
  readonly priorGraphRevision: number;
  readonly nextGraphHash: Sha256Digest;
  readonly nextGraphRevision: number;
  readonly priorProjection: TicketImmutableProjection;
  readonly priorProjectionSha256: Sha256Digest;
  readonly refreshedProjection: TicketImmutableProjection;
  readonly nextProjectionSha256: Sha256Digest;
  readonly executionEpoch: number;
  readonly sourceCycleId: string;
  readonly recordedAt: string;
  readonly sha256: Sha256Digest;
}

export interface SourceCorrectionSeedAuthority {
  readonly protocol: "koni.source-correction-seed.v1";
  readonly runId: string;
  readonly ticketId: string;
  readonly proposalTicketId: string;
  readonly requestSha256: Sha256Digest;
  /** The authority which actually retired the immutable source archive. Missing on legacy exact-request seeds. */
  readonly archiveSupersessionSha256?: Sha256Digest;
  readonly route:
    "planned_asset_repair" | "proposal_review_exhausted" | "no_op" | "approved_application";
  readonly releaseDecisionSha256: Sha256Digest;
  readonly archivedCycleId: string;
  readonly archiveRef: string;
  readonly candidateBaseOid: string;
  readonly candidateOid: string;
  readonly candidateProjection: TicketImmutableProjection;
  readonly releaseProjection: TicketImmutableProjection;
  readonly priorExecutionEpoch: number;
  readonly nextExecutionEpoch: number;
  readonly recordedAt: string;
  readonly sha256: Sha256Digest;
}

export interface ProposalReviewExhaustionAuthority {
  readonly protocol: "koni.proposal-review-exhaustion.v1";
  readonly failedReviewAttemptId: string;
  readonly sha256: Sha256Digest;
}

/**
 * Compiler-authored control/recovery transaction state carried with one ticket. It deliberately
 * contains identities and hashes only; scheduling policy is projected elsewhere from this record.
 */
export interface TicketExecutionControlRecord {
  /** Complete compiler definition, immutable ticket projection, and role-specific causal proof. */
  controlTicketAuthority?: CompilerControlTicketAuthority;
  /** Append-only compiler proof for a recurring asset's fresh-epoch grant replacement. */
  recurringAssetGrantRefreshes?: RecurringAssetGrantRefreshAuthority[];
  /** Append-only compiler proof for a graph-changing application that refreshes its held source. */
  heldSourceGrantRefreshes?: HeldSourceGrantRefreshAuthority[];
  /** Append-only authority for reusing exact archived bytes in a later correction epoch. */
  sourceCorrectionSeeds?: SourceCorrectionSeedAuthority[];
  /** Compiler-authenticated exhausted review that returned a malformed proposal to its source. */
  proposalReviewExhaustion?: ProposalReviewExhaustionAuthority;
  changeControlScopeNodeIds?: string[];
  /** Immutable compiler request that caused this proposal ticket to exist. */
  proposalRequest?: {
    requestSha256: Sha256Digest;
    sourceTicketId: string;
    sourceStepId: string;
    sourceOutputSha256: Sha256Digest;
    /** Explicit compiler routing intent; absent only on legacy durable proposals. */
    fulfillment?: "planned_asset_repair" | "dynamic_scope_change";
  };
  /** Source-ticket hold that prevents publication while its exact proposal is unresolved. */
  sourceHold?: {
    proposalTicketId: string;
    requestSha256: Sha256Digest;
  };
  /** Durable authority disposition of the exact proposal request. */
  proposalDisposition?: {
    kind: "approved" | "rejected" | "no_op" | "application";
    authoritySha256: Sha256Digest;
    applicationTicketId?: string;
  };
  /** Exact operator/authority event that approved or rejected this proposal. */
  proposalDecision?: ProposalDecisionAuthorityRecord;
  /** Bounded append-only audit of every accepted decision, including later audit-only steering. */
  proposalDecisionHistory?: ProposalDecisionAuthorityRecord[];
  proposalApprovalSha256?: Sha256Digest;
  sourceProposalTicketId?: string;
  approvedApplicationSha256?: Sha256Digest;
  /** Full reviewed materialization preimage; opaque authority hashes are never sufficient. */
  approvedMaterialization?: ApprovedChangeMaterialization;
  approvedApplicationTicketAuthority?: {
    protocol: "koni.application-ticket-authority.v1";
    applicationTicketId: string;
    projectionSha256: Sha256Digest;
    sha256: Sha256Digest;
  };
  terminalRecovery?: {
    protocol: "koni.terminal-recovery-authority.v2";
    configurationSha256: Sha256Digest;
    catalogSha256: Sha256Digest;
    resolverOperationId: string;
    resolverTicketId: string;
    resolverBinding: ExecutionPolicyBinding;
    resolverOperation: CompiledOperationSemantics;
    sourceTicketId: string;
    failureBindingSha256s: Sha256Digest[];
    sourceFailureProof: TerminalFailureSettlementProof;
    reconciliationDisposition: "create" | "reuse";
    sourceLink: "apply_or_repair_after_resolver";
    chainSuppressed: false;
    reconciliationSha256: Sha256Digest;
    sha256: Sha256Digest;
  };
  /** Exact successful terminal settlement for a completed configured resolver. */
  terminalResolverTerminalProof?: TerminalSuccessSettlementProof;
  /**
   * Immutable operator requests to retry this configured terminal resolver. Settlement is
   * inferred from the resolver's later fresh cycle; the request bytes remain append-only audit.
   */
  terminalResolverRetryRequests?: Array<{
    protocol: "koni.terminal-resolver-retry.v1";
    ordinal: number;
    eventId: string;
    actor: "operator";
    message: string;
    recordedAt: string;
    runId: string;
    resolverTicketId: string;
    sourceTicketId: string;
    sourceFailureBindingSha256: Sha256Digest;
    resolverFailureBindingSha256: Sha256Digest;
    failureSettlementSha256: Sha256Digest;
    failureProof: TerminalFailureSettlementProof;
    failedAttemptId: string;
    launchSpecHash: Sha256Digest;
    terminalPolicySha256: Sha256Digest;
    terminalOutputSha256: Sha256Digest;
    configurationSha256: Sha256Digest;
    catalogSha256: Sha256Digest;
    resolverBindingSha256: Sha256Digest;
    sha256: Sha256Digest;
  }>;
}

export interface TicketRecord {
  id: string;
  operationId: string;
  title: string;
  summary: string;
  status: TicketStatus;
  /** Exact operation-level policy pinned when the compiler derived this ticket. */
  executionPolicyBinding?: ExecutionPolicyBinding;
  /** Typed change-control/recovery transaction identities; absent on ordinary and legacy tickets. */
  executionControl?: TicketExecutionControlRecord;
  priority: number;
  dependencyIds: string[];
  targetNodeIds: string[];
  /** Compiler-authored graph authority; absent only on legacy records. */
  readNodeIds?: string[];
  writeNodeIds?: string[];
  readPaths: string[];
  writePaths: string[];
  steps: TicketStepRecord[];
  /** Compiler-pinned owner step for one bounded failed-review rework cycle. */
  reviewFailureReopenFrom?: string;
  reviewReworkLimit?: number;
  reviewReworkCount?: number;
  reviewReworks?: TicketReviewReworkRecord[];
  /** Immutable compiler diagnosis for a non-review fresh-cycle reissue. */
  compilerReissueDiagnoses?: TicketCompilerReissueDiagnosis[];
  worktreePath: string | undefined;
  branch: string | undefined;
  /** Authority-generated Git cycle backing this ticket's current execution/reissue. */
  gitCycleId?: string;
  /**
   * Monotonic compiler-owned execution generation. A reissued ticket advances this value so a
   * fresh obligation cannot inherit conversational state from an already-settled generation.
   * Absent only on records written before execution-generation authority was introduced.
   */
  executionEpoch?: number;
  /** When present, successful publication also resolves this conflicted predecessor ticket. */
  integrationForTicketId?: string;
  /** Exact Git candidate whose tree must be materialized for configured conflict resolution. */
  integrationCandidateOid?: string;
  blocker: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type AttemptStatus =
  | "queued"
  | "running"
  | "waiting_question"
  | "waiting_plan_review"
  | "terminal_accepted"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

/**
 * One operator-authored message admitted by the authority before Pi receives it.
 * The artifact contains the exact UTF-8 bytes; this record authenticates their order and digest.
 */
export interface AgentAuthorityMessageRecord {
  sequence: number;
  mode: "steer" | "follow_up";
  sha256: Sha256Digest;
  sizeBytes: number;
  artifactPath: string;
  recordedAt: string;
}

/** One authority-accepted tool result that Pi may persist in the attempt transcript. */
export interface AgentAuthorityToolResultRecord {
  sequence: number;
  callId: string;
  toolName: string;
  outcome: "accepted" | "rejected";
  argumentsSha256: Sha256Digest;
  argumentsSizeBytes: number;
  receiptSha256: Sha256Digest;
  receiptSizeBytes: number;
  artifactPath: string;
  recordedAt: string;
}

/** One exact compiler-authored compaction Pi may append to the attempt transcript. */
export interface AgentAuthorityCompactionRecord {
  sequence: number;
  authorizationId: string;
  summaryHash: Sha256Digest;
  summaryBytes: number;
  firstKeptEntryId: string;
  tokensBefore: number;
  /** Last authority-tool result visible when this compaction was authorized. */
  toolResultSequence?: number;
  recordedAt: string;
}

/**
 * One provider request admitted by the authority before transport.
 *
 * An entry without settlement fields is a charged in-flight worst case. It must remain the final
 * entry and blocks every later provider request until canonical Pi transcript evidence settles it.
 */
export interface AgentProviderRequestRecord {
  sequence: number;
  reservationId: string;
  api: string;
  modelId: string;
  payloadSha256: Sha256Digest;
  payloadSizeBytes: number;
  baselineEntryId: string;
  prospectiveInputTokens: number;
  reservedOutputTokens: number;
  serializedOutputCap?: {
    path: string;
    value: number;
  };
  reservedAt: string;
  assistantEntryId?: string;
  assistantEntrySha256?: Sha256Digest;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  settledAt?: string;
  /**
   * Explicit operator authorization to continue after Pi durably committed an aborted or errored
   * response whose provider billing cannot be reconstructed. This is not a usage settlement:
   * exact token totals remain unchanged and the original reservation remains the conservative
   * exposure bound.
   */
  retirement?:
    | {
        protocol: "koni.provider-exposure-retirement.v1";
        disposition:
          "operator_acknowledged_canonical_abort" | "operator_acknowledged_provider_error";
        assistantEntryId: string;
        assistantEntrySha256: Sha256Digest;
        responseId: string;
        errorMessageSha256?: Sha256Digest;
        authorizationSha256: Sha256Digest;
        retiredAt: string;
        sha256: Sha256Digest;
      }
    | {
        protocol: "koni.provider-exposure-retirement.v1";
        disposition: "operator_acknowledged_authority_pause";
        pauseReasonSha256: Sha256Digest;
        authorizationSha256: Sha256Digest;
        retiredAt: string;
        sha256: Sha256Digest;
      }
    | {
        protocol: "koni.provider-exposure-retirement.v1";
        disposition: "operator_acknowledged_unreconciled_request";
        failureReasonSha256: Sha256Digest;
        authorizationSha256: Sha256Digest;
        retiredAt: string;
        sha256: Sha256Digest;
      };
}

/** Settled totals imported from an attempt that predates request-level reservations. */
export interface AgentProviderUsageBaseline {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  recordedAt: string;
}

export interface AgentProviderTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface PlanningSteeringBinding {
  sequence: number;
  instructionsSha256: Sha256Digest;
  instructionsSizeBytes: number;
  artifactPath: string;
  recordedAt: string;
}

export interface PlanningSynthesisRecord {
  protocol: "koni.planning-synthesis.v1";
  thresholdNewTokens: number;
  limitNewTokens: number;
  reserveNewTokens: number;
  /** Additive metadata; absent only on transitions written before input-pressure recovery. */
  triggerReason?: "token_threshold" | "provider_input_pressure";
  triggeredNewTokens?: number;
  instructionSha256: Sha256Digest;
  instructionSizeBytes: number;
  instructionArtifactPath: string;
  triggeredAt: string;
}

export interface PlanningRevisionRecord {
  protocol: "koni.planning-revision.v1";
  revision: number;
  status: "running" | "awaiting_review" | "superseded" | "approved" | "failed";
  launchSpecSha256: Sha256Digest;
  grantSha256: Sha256Digest;
  budgetBaseline: AgentProviderTokenTotals;
  budgetPolicy: CompiledTokenPolicy;
  startedAt: string;
  steering?: PlanningSteeringBinding;
  /** Revision-local transition; explicit steering resets only this synthesis authority. */
  planningSynthesis?: PlanningSynthesisRecord;
  patchSha256?: Sha256Digest;
  artifactSha256?: Sha256Digest;
  graphSha256?: Sha256Digest;
  transcriptSha256?: Sha256Digest;
  checkpointPath?: string;
  completedAt?: string;
}

export interface PlanningSessionRecord {
  protocol: "koni.planning-session.v1";
  attemptId: string;
  sessionId: string;
  status: "running" | "waiting_question" | "awaiting_review" | "approving" | "approved" | "blocked";
  currentRevision: number;
  approvedRevision?: number;
  revisions: PlanningRevisionRecord[];
}

/** Crash-forward intent for one authority-owned workspace write/edit effect. */
export interface WorkspaceEffectIntentRecord {
  id: string;
  attemptId: string;
  specHash: Sha256Digest;
  grantHash: Sha256Digest;
  callId: string;
  toolName: "koni_write_file" | "koni_edit_file";
  method: string;
  idempotencyKey: string;
  requestHash: Sha256Digest;
  argumentsSha256: Sha256Digest;
  argumentsSizeBytes: number;
  path: string;
  expectedSha256: Sha256Digest | null;
  desiredSha256: Sha256Digest;
  contentSizeBytes: number;
  contentArtifactPath: string;
  preparedAt: string;
}

/** Crash-forward boundary for a compiler-configured external validation request. */
export interface PendingCheckIntentRecord {
  id: string;
  attemptId: string;
  specHash: Sha256Digest;
  grantHash: Sha256Digest;
  callId: string;
  method: string;
  idempotencyKey: string;
  requestHash: Sha256Digest;
  argumentsSha256: Sha256Digest;
  argumentsSizeBytes: number;
  requestedCheckId: string;
  resolvedCheckSha256: Sha256Digest;
  resolvedCheck: JsonValue;
  /** Crash-safe ordered command-attempt audit, including attempts that are later retried. */
  attempts?: RunCheckAttemptRecord[];
  preparedAt: string;
}

/** One process-boundary attempt for a configured command leaf. */
export interface RunCheckAttemptRecord {
  protocol: "koni.run-check-attempt.v1";
  commandIndex: number;
  attemptNumber: number;
  checkId: string;
  definitionHash: Sha256Digest;
  executionPolicy: CheckExecutionPolicyBinding;
  status: "prepared" | "completed";
  startedAt: string;
  preManifestSha256: Sha256Digest;
  completedAt?: string;
  aggregateElapsedSeconds?: number;
  postManifestSha256?: Sha256Digest;
  exitCode?: number | null;
  signal?: string | null;
  stdoutSha256?: Sha256Digest;
  stdoutSizeBytes?: number;
  stdoutArtifactPath?: string;
  stderrSha256?: Sha256Digest;
  stderrSizeBytes?: number;
  stderrArtifactPath?: string;
  retryDecision?: CheckRetryDecision;
  sha256: Sha256Digest;
}

/** Exact pre-execution source tree associated with a semantic command/member binding. */
export interface RunCheckSourceManifestRecord {
  protocol: "koni.run-check-source-manifest.v1";
  configurationSha256: Sha256Digest;
  catalogSha256: Sha256Digest;
  bindingSha256: Sha256Digest;
  checkSha256: Sha256Digest;
  commandBindingSha256: Sha256Digest;
  stepId: string;
  roots: string[];
  entries: Array<{
    path: string;
    kind: "file" | "directory" | "missing";
    mode?: number;
    sizeBytes?: number;
    sha256?: Sha256Digest;
  }>;
  manifestSha256: Sha256Digest;
  capturedAt: string;
  sha256: Sha256Digest;
}

/** Immutable audit projection for one command leaf inside a compiler-configured check. */
export interface RunCheckCommandRecord {
  checkId: string;
  definitionHash: Sha256Digest;
  /** Exact child-check policy; absent only on legacy receipts. */
  executionPolicy?: CheckExecutionPolicyBinding;
  /** Complete retry audit for this command leaf; absent on legacy records. */
  attempts?: RunCheckAttemptRecord[];
  /** Exact source bytes observed before the terminal command attempt. */
  sourceManifest?: RunCheckSourceManifestRecord;
  startedAt: string;
  completedAt: string;
  resolvedExecutable: string;
  argv: string[];
  environmentSha256: Sha256Digest;
  exitCode: number | null;
  signal: string | null;
  stdoutSha256: Sha256Digest;
  stdoutSizeBytes: number;
  stdoutArtifactPath: string;
  stderrSha256: Sha256Digest;
  stderrSizeBytes: number;
  stderrArtifactPath: string;
  preManifestSha256: Sha256Digest;
  postManifestSha256: Sha256Digest;
  sandboxKind: string;
  sandboxProfileSha256: Sha256Digest;
  /** Exact authority-startup authenticated sandbox launcher (new records only). */
  sandboxExecutableSha256?: Sha256Digest;
  resultSource: {
    kind: "stdout" | "file";
    path?: string;
    bytesSha256: Sha256Digest;
    sizeBytes: number;
  };
  outputFiles: Array<{ path: string; sha256: Sha256Digest; sizeBytes: number }>;
}

/** One complete compiler-accepted graph, command, or composite validation result. */
export interface RunCheckRecord {
  id: string;
  attemptId: string;
  callId: string;
  requestedCheckId: string;
  definitionHash: Sha256Digest;
  kind: "command" | "graph" | "composite";
  /** Exact operation/check/gate policy that authorized this receipt. */
  executionPolicy?: CheckExecutionPolicyBinding;
  accepted: boolean;
  /** Typed compiler diagnosis proving the command failed before reaching its semantic subject. */
  infrastructureFailure?: string;
  /** Required on new records; absent legacy records cannot satisfy current-step closure. */
  passed?: boolean;
  summary: string;
  commands: RunCheckCommandRecord[];
  evidenceSha256: Sha256Digest;
  evidenceSizeBytes: number;
  evidenceArtifactPath: string;
  recordedAt: string;
}

export interface AgentAttemptRecord {
  id: string;
  sessionId: string;
  ticketId: string;
  stepId: string;
  personaId: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel: string;
  status: AttemptStatus;
  launchSpecHash: Sha256Digest;
  /** Compiler action that authorized this Lead session admission. */
  launchActionInvocationId?: string;
  sessionFile: string | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;
  terminalSummary: string | undefined;
  /** Exact terminal argument bytes durably admitted by the authority before semantic settlement. */
  terminalOutputSha256?: Sha256Digest;
  terminalOutputSizeBytes?: number;
  terminalAcceptedAt?: string;
  /** Terminal semantic closure; configured validation attaches this only with action settlement. */
  terminalPolicy?: AgentTerminalPolicyRecord;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Ticket execution generation this assignment belongs to; absent on legacy/assignment-free attempts. */
  ticketExecutionEpoch?: number;
  /** Exact durable authorization for one bounded automatic token-budget recovery. */
  tokenBudgetRecovery?: AgentTokenBudgetRecoveryRecord;
  /** Required on newly issued attempts; optional only for imported pre-lineage state. */
  lineage?: AgentAttemptLineage;
  /** Exact composed run/graph reviewed by a verification attempt; absent on other/legacy attempts. */
  reviewedRunOid?: string;
  reviewedTargetOid?: string;
  reviewedGraphHash?: Sha256Digest;
  /** Compiler outcome for an assignment-free independent review; session completion alone is insufficient. */
  verificationAccepted?: boolean;
  /** Ordered, authority-authenticated operator messages delivered after the initial prompt. */
  authorityMessages?: AgentAuthorityMessageRecord[];
  /** One compiler-authored transition from exploration to bounded planning synthesis. */
  planningSynthesis?: PlanningSynthesisRecord;
  /** Ordered authority receipts for every Pi-persisted tool result. */
  authorityToolResults?: AgentAuthorityToolResultRecord[];
  /** Ordered authority-issued compaction digests. */
  authorityCompactions?: AgentAuthorityCompactionRecord[];
  /** Ordered, fsynced provider reservations and canonical assistant-usage settlements. */
  authorityProviderRequests?: AgentProviderRequestRecord[];
  /** One guarded compatibility anchor created before the first reservation on a legacy attempt. */
  authorityProviderUsageBaseline?: AgentProviderUsageBaseline;
  kind?: "planning" | "lead" | "ticket" | "verification" | "integration";
  error?: string;
  /** Stable managed-runtime failure class used only for explicit operator-authorized retry. */
  failureCode?: string;
}

export interface AgentTokenBudgetRecoveryRecord {
  protocol: "koni.agent-token-budget-recovery.v1";
  failedAttemptId: string;
  ticketId: string;
  stepId: string;
  ticketExecutionEpoch?: number;
  reviewReworkOrdinal?: number;
  recoveredAt: string;
  sha256: Sha256Digest;
}

export type AgentTerminalPolicyRecord =
  | {
      protocol: "koni.agent-terminal-policy.v1";
      mode: "legacy_pre_execution_policy";
      acceptedAt: string;
      sha256: Sha256Digest;
    }
  | {
      protocol: "koni.agent-terminal-policy.v1";
      /** Compiler-authenticated failure output; success validation was intentionally not claimed. */
      mode: "failed_submission";
      acceptedAt: string;
      sha256: Sha256Digest;
    }
  | {
      protocol: "koni.agent-terminal-policy.v1";
      mode: "semantic";
      projectionSha256: Sha256Digest;
      replayCompilationSha256: Sha256Digest;
      receiptEvaluationSha256: Sha256Digest;
      sourcePreservationSha256s: Sha256Digest[];
      acceptedAt: string;
      sha256: Sha256Digest;
    }
  | {
      protocol: "koni.agent-terminal-policy.v1";
      /** Exact compiler-authenticated upstream route for current nonpassing configured checks. */
      mode: "semantic_upstream_change_control";
      changeControlSha256: Sha256Digest;
      projectionSha256: Sha256Digest;
      replayCompilationSha256: Sha256Digest;
      receiptEvaluationSha256: Sha256Digest;
      sourcePreservationSha256s: Sha256Digest[];
      acceptedAt: string;
      sha256: Sha256Digest;
    };

export interface RunLeadJudgmentRecord {
  protocol: "koni.lead-judgment-record.v1";
  trigger: "orchestration_entry" | "compiler_deadlock";
  attemptId: string;
  behaviorSha256: Sha256Digest;
  stageId: string;
  graphHash: Sha256Digest;
  runOid: string;
  /** Exact compiler-visible ticket frontier for deadlock judgments; absent on legacy records. */
  frontierSha256?: Sha256Digest;
  disposition: "proceed" | "blocked";
  summary: string;
  recordedAt: string;
}

export type RunActionBoundaryKind =
  | "approved_plan_compile"
  | "assignment_validation"
  | "configured_stage"
  | "lead_launch"
  | "post_orchestration_report"
  | "recovery";

/** Immutable authority identity for one compiler-selected action invocation. */
export interface RunActionBoundaryRecord {
  protocol: "koni.run-action-boundary.v1";
  kind: RunActionBoundaryKind;
  boundaryId: string;
  runId: string;
  compiledConfigHash: Sha256Digest;
  behaviorSha256: Sha256Digest;
  generation: number;
  admittedRunRevision: number;
  stageId: string;
  ticketId?: string;
  stepId?: string;
  attemptId?: string;
  cycleId?: string;
  productSha256?: Sha256Digest;
  parentInvocationId?: string;
  sha256: Sha256Digest;
}

/** Durable deduplication proof written atomically with a primitive's authority effect. */
export interface RunActionEffectReceipt {
  protocol: "koni.run-action-effect-receipt.v1";
  effectKey: string;
  planSha256: Sha256Digest;
  actionId: string;
  phase: "recipe" | "compensation";
  stepId: string;
  primitive: string;
  argumentsSha256: Sha256Digest;
  contextSha256: Sha256Digest;
  output: ConfigurationValue;
  outputSha256: Sha256Digest;
  recordedAt: string;
  sha256: Sha256Digest;
}

export type RunActionSemanticResult =
  | { kind: "approved_plan"; ticketCount: number; graphHash: Sha256Digest; graphRevision: number }
  | {
      kind: "assignment";
      status: "completed" | "failed";
      summary?: string;
      blocker?: string;
      /** Exact compiler-emitted change-control object retained in the accepted terminal artifact. */
      changeControlSha256?: Sha256Digest;
      /** Compiler-emitted recurring-asset grant replacements applied by this exact action. */
      recurringAssetGrantRefreshSha256s?: Sha256Digest[];
      /** Compiler-emitted held-source grant replacements applied by this exact action. */
      heldSourceGrantRefreshSha256s?: Sha256Digest[];
    }
  | { kind: "report"; reportId: string; bundleHash: Sha256Digest };

/**
 * Scheduler disposition applied after an action recipe reaches a durable journal state. This is
 * distinct from the recipe journal: pause/delete may abandon an otherwise completed semantic
 * result, while a recovery recipe may complete yet settle its failed parent as failed.
 */
export interface RunActionSettlementRecord {
  protocol: "koni.run-action-settlement.v1";
  invocationId: string;
  planSha256: Sha256Digest;
  journalSha256: Sha256Digest;
  semanticResultSha256: Sha256Digest | null;
  disposition: "completed" | "failed" | "abandoned";
  reason: string;
  settledAt: string;
  sha256: Sha256Digest;
}

/** Audited compiler-only reset of a failed first-step validation journal. */
export interface RunActionCompilerRetryRecord {
  protocol: "koni.run-action-compiler-retry.v1";
  journal: ActionExecutionJournal;
  reason: string;
  retriedAt: string;
  sha256: Sha256Digest;
}

/** Complete crash-forward action state. Only this record may authorize primitive replay. */
export interface RunActionExecutionRecord {
  protocol: "koni.run-action-execution.v1";
  invocationId: string;
  boundary: RunActionBoundaryRecord;
  plan: ActionExecutionPlan;
  journal: ActionExecutionJournal;
  effects: Record<string, RunActionEffectReceipt>;
  /** Revision expected before the next journal or primitive transition. */
  expectedRunRevision: number;
  semanticResult?: RunActionSemanticResult;
  /** Boundary-specific scheduler/lifecycle settlement applied exactly once after the recipe. */
  settledAt?: string;
  /** Exact current settlement. Absent only on records created before settlement v1. */
  settlement?: RunActionSettlementRecord;
  recoveryInvocationId?: string;
  recoverySettledAt?: string;
  /** Prior failed journals retained when exact accepted output is compiler-replayed on Resume. */
  compilerRetryHistory?: RunActionCompilerRetryRecord[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Non-evictable projection linking one admitted terminal attempt to its exact settled action.
 * Complete action bytes remain authoritative and are authenticated by ProjectAuthorityStore;
 * this bounded projection lets the pure run validator retain exact linkage after row compaction.
 */
export interface RunActionTerminalArchiveAuthority {
  protocol: "koni.run-action-terminal-archive-authority.v1";
  runId: string;
  invocationId: string;
  boundarySha256: Sha256Digest;
  ticketId: string;
  stepId: string;
  attemptId: string;
  actionPlanSha256: Sha256Digest;
  actionSettlementSha256: Sha256Digest;
  settlementDisposition: RunActionSettlementRecord["disposition"];
  terminalOutputSha256: Sha256Digest;
  terminalPolicySha256?: Sha256Digest;
  terminalProofSha256?: Sha256Digest;
  sha256: Sha256Digest;
}

export interface RunActionExecutionArchiveRecord {
  /** v1 remains a read-only artifact-bound compatibility record; all new rows are strict v2. */
  protocol: "koni.run-action-archive.v1" | "koni.run-action-archive.v2";
  invocationId: string;
  kind: RunActionBoundaryKind;
  actionId: string;
  planSha256: Sha256Digest;
  journalStatus: ActionExecutionJournal["status"];
  settlementSha256?: Sha256Digest;
  settlementDisposition?: RunActionSettlementRecord["disposition"];
  terminalFailureProof?: TerminalFailureSettlementProof;
  terminalAuthority?: RunActionTerminalArchiveAuthority;
  artifactPath: string;
  artifactSha256: Sha256Digest;
  artifactSizeBytes: number;
  archivedAt: string;
}

/** Minimal durable semantic-failure proof retained even after the complete action is archived. */
export interface TerminalFailureSettlementProof {
  protocol: "koni.terminal-failure-settlement.v1";
  runId: string;
  ticketId: string;
  stepId: string;
  attemptId: string;
  actionInvocationId: string;
  actionPlanSha256: Sha256Digest;
  actionSettlementSha256: Sha256Digest;
  semanticResult: Extract<RunActionSemanticResult, { kind: "assignment" }>;
  semanticResultSha256: Sha256Digest;
  terminalPolicySha256: Sha256Digest;
  terminalOutputSha256: Sha256Digest;
  sha256: Sha256Digest;
}

export interface TerminalSuccessSettlementProof {
  protocol: "koni.terminal-success-settlement.v1";
  runId: string;
  ticketId: string;
  stepId: string;
  attemptId: string;
  actionInvocationId: string;
  actionPlanSha256: Sha256Digest;
  actionSettlementSha256: Sha256Digest;
  semanticResult: Extract<RunActionSemanticResult, { kind: "assignment" }>;
  semanticResultSha256: Sha256Digest;
  terminalPolicySha256: Sha256Digest;
  terminalOutputSha256: Sha256Digest;
  sha256: Sha256Digest;
}

export interface RunActionExecutionArchiveSegment {
  /** v1 remains a read-only artifact-bound compatibility record; all new segments are strict v2. */
  protocol: "koni.run-action-archive-segment.v1" | "koni.run-action-archive-segment.v2";
  firstInvocationId: string;
  lastInvocationId: string;
  count: number;
  artifactPath: string;
  artifactSha256: Sha256Digest;
  artifactSizeBytes: number;
  archivedAt: string;
  /** Exact terminal-attempt links retained when their individual archive rows are compacted. */
  terminalAuthorities?: RunActionTerminalArchiveAuthority[];
}

export interface RunActionArchiveArtifactWrite {
  path: string;
  bytes: Buffer;
}

export interface RunActionArchiveMutationProjection {
  /** Exact new action and segment artifacts which must be introduced by the same store CAS. */
  writes: RunActionArchiveArtifactWrite[];
}

/** The one byte representation admitted for action-archive and archive-segment artifacts. */
export function encodeRunActionArchiveArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > 16 * 1024 * 1024 || bytes.includes(0)) {
    throw new Error("run action archive artifact exceeds its exact byte contract");
  }
  return bytes;
}

/** Derive the compact terminal-attempt authority retained across archive-row compaction. */
export function deriveRunActionTerminalArchiveAuthority(
  run: Readonly<RunRecord>,
  action: Readonly<RunActionExecutionRecord>,
): RunActionTerminalArchiveAuthority | undefined {
  if (
    action.boundary.kind !== "assignment_validation" ||
    action.boundary.ticketId === undefined ||
    action.boundary.stepId === undefined ||
    action.boundary.attemptId === undefined ||
    action.settlement === undefined
  ) {
    return undefined;
  }
  const attempt = run.attempts[action.boundary.attemptId];
  if (
    attempt === undefined ||
    attempt.ticketId !== action.boundary.ticketId ||
    attempt.stepId !== action.boundary.stepId ||
    attempt.terminalOutputSha256 === undefined
  ) {
    return undefined;
  }
  const proof =
    action.settlement.disposition === "completed"
      ? createTerminalSuccessSettlementProof(run, action)
      : action.settlement.disposition === "failed"
        ? createTerminalFailureSettlementProof(run, action)
        : undefined;
  if (action.settlement.disposition !== "abandoned" && proof === undefined) {
    throw new Error(`settled terminal action lacks exact semantic proof: ${action.invocationId}`);
  }
  if (action.settlement.disposition === "abandoned" && attempt.terminalPolicy !== undefined) {
    throw new Error(`abandoned terminal action retains semantic policy: ${action.invocationId}`);
  }
  const material = {
    protocol: "koni.run-action-terminal-archive-authority.v1" as const,
    runId: run.id,
    invocationId: action.invocationId,
    boundarySha256: action.boundary.sha256,
    ticketId: action.boundary.ticketId,
    stepId: action.boundary.stepId,
    attemptId: action.boundary.attemptId,
    actionPlanSha256: action.plan.sha256,
    actionSettlementSha256: action.settlement.sha256,
    settlementDisposition: action.settlement.disposition,
    terminalOutputSha256: attempt.terminalOutputSha256,
    ...(attempt.terminalPolicy === undefined
      ? {}
      : {
          terminalPolicySha256: attempt.terminalPolicy.sha256,
        }),
    ...(proof === undefined ? {} : { terminalProofSha256: proof.sha256 }),
  };
  return { ...material, sha256: canonicalHash(material) };
}

/** Derive every archive-row field from one prior settled live action. */
export function deriveRunActionExecutionArchive(
  run: Readonly<RunRecord>,
  action: Readonly<RunActionExecutionRecord>,
): { row: RunActionExecutionArchiveRecord; bytes: Buffer } {
  if (
    action.settlement === undefined ||
    action.settledAt !== action.settlement.settledAt ||
    (!isTerminalActionJournalState(action.journal.status) &&
      action.settlement.disposition !== "abandoned")
  ) {
    throw new Error(`cannot archive unsettled action authority: ${action.invocationId}`);
  }
  const bytes = encodeRunActionArchiveArtifact(action);
  const artifactPath = `runs/${run.id}/actions/archive/${action.invocationId}.json`;
  const terminalFailureProof = createTerminalFailureSettlementProof(run, action);
  const terminalAuthority = deriveRunActionTerminalArchiveAuthority(run, action);
  return {
    row: {
      protocol: "koni.run-action-archive.v2",
      invocationId: action.invocationId,
      kind: action.boundary.kind,
      actionId: action.plan.actionId,
      planSha256: action.plan.sha256,
      journalStatus: action.journal.status,
      settlementSha256: action.settlement.sha256,
      settlementDisposition: action.settlement.disposition,
      ...(terminalFailureProof === undefined ? {} : { terminalFailureProof }),
      ...(terminalAuthority === undefined ? {} : { terminalAuthority }),
      artifactPath,
      artifactSha256: rawSha256(bytes),
      artifactSizeBytes: bytes.byteLength,
      // This is deliberately the action's immutable terminal timestamp, not caller-supplied wall
      // time. Consequently every field in the archive row is a projection of the prior action.
      archivedAt: action.updatedAt,
    },
    bytes,
  };
}

/** Derive one content-addressed segment from the exact canonical archive prefix. */
export function deriveRunActionExecutionArchiveSegment(
  runId: string,
  rows: readonly RunActionExecutionArchiveRecord[],
): { segment: RunActionExecutionArchiveSegment; bytes: Buffer } {
  if (rows.length < 1) throw new Error("run action archive segment prefix is empty");
  const bytes = encodeRunActionArchiveArtifact(rows);
  const digest = rawSha256(bytes);
  const terminalAuthorities = rows.flatMap((row) =>
    row.terminalAuthority === undefined ? [] : [structuredClone(row.terminalAuthority)],
  );
  return {
    segment: {
      protocol: "koni.run-action-archive-segment.v2",
      firstInvocationId: rows[0]!.invocationId,
      lastInvocationId: rows.at(-1)!.invocationId,
      count: rows.length,
      artifactPath: `runs/${runId}/actions/archive-index/${digest.slice("sha256:".length)}.json`,
      artifactSha256: digest,
      artifactSizeBytes: bytes.byteLength,
      archivedAt: rows.at(-1)!.archivedAt,
      ...(terminalAuthorities.length === 0 ? {} : { terminalAuthorities }),
    },
    bytes,
  };
}

function isTerminalActionJournalState(status: ActionExecutionJournal["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "compensated" ||
    status === "compensation_failed" ||
    status === "recovery_required"
  );
}

export interface RunAgentSelection {
  provider: string;
  model: string;
  thinkingLevel: string;
}

export interface RunExecutionConfig {
  maxParallel: number;
  /** When true, parallel admissions require disjoint compiler-issued graph and file scopes. */
  disjointScopeParallelism?: boolean;
  questionPolicy: "none" | "some" | "many";
  /** Canonical policy pinned for new runs; presentation-only records may omit it. */
  semanticQuestionPolicy?: QuestionPolicy;
  questionDefaultScope?: "run" | "ticket";
  instructions: string;
  agents: Record<string, RunAgentSelection>;
}

/**
 * Selected compiler behavior pinned before the first Git or provider effect.
 * The complete project configuration remains an artifact; this is the bounded executable slice.
 */
export interface RunBehaviorSnapshot {
  protocol: "koni.run-behavior.v1";
  compiledBehaviorSha256: Sha256Digest;
  profile: CompiledBehaviorIr["profile"];
  runType: CompiledRunTypeBehavior;
  actions: CompiledActionCatalog;
  gitPolicySha256: Sha256Digest;
  sha256: Sha256Digest;
}

export function createRunBehaviorSnapshot(
  behavior: CompiledBehaviorIr,
  runTypeId: string,
): RunBehaviorSnapshot {
  const runType = behavior.runTypes[runTypeId];
  if (runType === undefined) throw new Error(`compiled behavior has no run type ${runTypeId}`);
  const material = {
    protocol: "koni.run-behavior.v1" as const,
    compiledBehaviorSha256: behavior.sha256,
    profile: structuredClone(behavior.profile),
    runType: structuredClone(runType),
    actions: structuredClone(behavior.actions),
    gitPolicySha256: runType.git.policySha256,
  };
  return recursivelyFreeze({ ...material, sha256: canonicalHash(material) });
}

export interface RunQuestionOption {
  id: string;
  label: string;
  description: string;
}

export interface RunQuestionRecord {
  id: string;
  attemptId: string;
  /** Absent only on historical standalone questions. */
  scope?: "run" | "ticket";
  /** Present exactly when `scope` is `ticket`. */
  ticketId?: string;
  prompt: string;
  options: RunQuestionOption[];
  allowsNotes: boolean;
  askedAt: string;
  answeredAt: string | undefined;
  selectedOptionId: string | undefined;
  notes: string | undefined;
  /** Durable batch projection fields; absent on historical standalone questions. */
  batchId?: string;
  batchPosition?: number;
  batchSize?: number;
  recommendationOptionId?: string;
  impact?: "routine" | "high_impact";
  answerSource?: "operator" | "configured_recommendation";
  answerRevision?: number;
}

export interface RunActivityRecord {
  id: string;
  at: string;
  kind: "compiler" | "graph_added" | "graph_modified" | "graph_deleted" | "agent" | "git";
  message: string;
  ticketId: string | undefined;
  nodeId: string | undefined;
  /** Operator display tone; absent on historical events (kind-based fallback applies). */
  tone?: "info" | "success" | "warning" | "error";
}

/** The complete compiler-owned Git namespace; there is no parallel legacy source of truth. */
export type RunGitRecord = RunGitLifecycleRecord;

/** Immutable audit projection for one settled crash-forward Git intent. */
export interface RunGitReceiptRecord {
  intentId: string;
  kind: GitLifecycleIntent["kind"];
  status: "completed" | "blocked";
  lifecycleSha256: Sha256Digest;
  /** Runtime closure and exact Git bytes that executed the settled intent (new records only). */
  runtimeClosureSha256?: Sha256Digest;
  gitExecutableSha256?: Sha256Digest;
  settledAt: string;
  reason?: string;
  compensation?: GitCompensationEvidence;
}

/** Immutable compiler publication for one deterministic report bundle. */
export interface RunReportRecord {
  protocol: "koni.report-bundle.v1";
  reportId: string;
  bundleKind: string;
  bundleHash: Sha256Digest;
  graphHash: Sha256Digest;
  ticketBoardHash: Sha256Digest;
  runStateHash: Sha256Digest;
  manifestArtifactPath: string;
  outputs: Array<{
    ledgerId: string;
    format: "json" | "markdown" | "yaml" | "csv";
    artifactPath: string;
    sha256: Sha256Digest;
    sizeBytes: number;
  }>;
  compiledAt: string;
}

/** Exact product identity shared by every compiler-authored post-orchestration boundary. */
export interface RunPostOrchestrationBinding {
  stageId: string;
  runOid: string;
  targetOid: string;
  graphHash: Sha256Digest;
  recordedAt: string;
}

/**
 * Durable proof that the configured post-orchestration stages ran in semantic order.
 *
 * Git remains authoritative for synchronization and promotion. This record binds the compiler
 * checkpoint, optional independent review, and report to the exact synchronized product so a
 * restart or target advance cannot reuse a stale downstream result.
 */
export interface RunPostOrchestrationRecord {
  protocol: "koni.post-orchestration.v1";
  synchronization?: RunPostOrchestrationBinding;
  checkpoint?: RunPostOrchestrationBinding & {
    verificationSha256: Sha256Digest;
  };
  review?: RunPostOrchestrationBinding & {
    attemptId: string;
  };
  report?: RunPostOrchestrationBinding & {
    actionId: string;
    actionSha256: Sha256Digest;
    reportId: string;
    bundleHash: Sha256Digest;
  };
}

export interface RunPlanRecord {
  revision: number;
  status: "planning" | "awaiting_approval" | "approving" | "approved" | "revising";
  /** Planner-authored 3-4 word operator label; absent on historical plans and direct-approval runs. */
  title?: string;
  full: Record<string, string>;
  concise: Record<string, { title: string; description: string }[]>;
  graphSeed: JsonValue | undefined;
  steeringHistory: { at: string; instructions: string }[];
}

/**
 * Durable operator choice for terminal run deletion.
 *
 * Session/provider revocation is unconditional. This record controls only whether Koni may also
 * retire its owned Git namespace after every attempt is proven drained. Persisting the choice
 * before cleanup makes crash recovery preserve the exact reviewed behavior.
 */
export interface RunDeletionRecord {
  protocol: "koni.run-deletion.v1";
  mode: "preserve_branches" | "delete_owned_branches";
  previewToken: Sha256Digest;
  requestedAt: string;
}

export interface RunRecord {
  protocol: typeof RUN_RECORD_PROTOCOL;
  id: string;
  revision: number;
  generation: number;
  projectRoot: string;
  profile: {
    packageName: string;
    packageVersion: string;
    lineage: string;
    bundleHash: Sha256Digest;
  };
  compiledConfigHash: Sha256Digest;
  /** Exact lifecycle authority projected from this run's pinned configuration. */
  lifecycleCatalog?: CompiledStateMachineCatalog;
  runTypeId: string;
  /** Pinned once at creation; absent only on legacy runs created before working specifications. */
  workingSpecOwnerId?: string;
  /** Absent only on imported pre-Pi-native records, which retain the historical agent default. */
  planningMode?: "agent" | "direct";
  objective: string;
  intake: ConfigurationObject;
  /** Absent only on compatibility records admitted before executable behavior snapshots. */
  behavior?: RunBehaviorSnapshot;
  executionConfig?: RunExecutionConfig;
  createdAt: string;
  updatedAt: string;
  lifecycle: RunLifecycleState;
  pipelineStageIds: string[];
  /** Absent only on pre-semantic-projection runs, which rehydrate from their pinned compiler artifact. */
  pipelineStages?: RunPipelineStageRecord[];
  currentPipelineStageId: string | undefined;
  plan: RunPlanRecord | undefined;
  /** Stable pre-approval planner identity and immutable revision checkpoints for new runs. */
  planningSession?: PlanningSessionRecord;
  /** Operator pause requested in a non-pausable phase; executed at the next pausable boundary. */
  pendingPause?: { requestedAt: string };
  /** Present after a guarded delete request; absent on legacy deleting records. */
  deletion?: RunDeletionRecord;
  graphRevision: number;
  graphHash: Sha256Digest | undefined;
  tickets: Record<string, TicketRecord>;
  attempts: Record<string, AgentAttemptRecord>;
  /** At most one immutable bounded Lead judgment for each compiler-authored trigger. */
  leadJudgments?: RunLeadJudgmentRecord[];
  /** Authenticated plans, journals, and primitive receipts for configured action boundaries. */
  actionExecutions?: Record<string, RunActionExecutionRecord>;
  actionExecutionArchive?: RunActionExecutionArchiveRecord[];
  actionExecutionArchiveSegments?: RunActionExecutionArchiveSegment[];
  /** Non-evictable semantic-failure authority; archive compaction never removes retry evidence. */
  terminalFailureProofs?: Record<string, TerminalFailureSettlementProof>;
  /** Non-evictable successful action authority used by proposal/review/resolver control tickets. */
  terminalSuccessProofs?: Record<string, TerminalSuccessSettlementProof>;
  /** Complete audit log for compiler-configured validation execution. */
  checks?: RunCheckRecord[];
  /** Compiler-classified failures emitted before a configured check attempt can launch. */
  compilerCheckPreflightRejections?: CompilerCheckPreflightRejectionRecord[];
  /** Durable admission preceding configured-check launch preparation; removed on launch/rejection. */
  pendingCompilerCheckPreflights?: Record<string, PendingCompilerCheckPreflightIntentRecord>;
  /** Exact compiler-owned dynamic predicate evidence envelope for the next graph pass. */
  ruleAuthorityEvidence?: JsonValue;
  /** Incomplete external effects only; completed effects are represented by receipts. */
  pendingEffects?: Record<string, WorkspaceEffectIntentRecord>;
  /** Incomplete external check executions; never treated as evidence until compiler finalization. */
  pendingChecks?: Record<string, PendingCheckIntentRecord>;
  questions: Record<string, RunQuestionRecord>;
  /** Canonical authority for native multi-question forms; legacy `questions` remains a projection. */
  questionBatches?: Record<string, QuestionBatchRecord>;
  activity: RunActivityRecord[];
  git: RunGitRecord;
  /** Proof-bound compatibility record retained after a flat legacy Git-state migration. */
  legacyGitMigration?: LegacyRunGitMigrationRecord;
  /** External Git effects in flight. Startup recovers these before any agent admission. */
  pendingGitIntents?: Record<string, GitLifecycleIntent>;
  /** Append-only authenticated settlement history for Git effects. */
  gitReceipts?: RunGitReceiptRecord[];
  /** Deterministic compiler report publications, newest last. */
  reports?: RunReportRecord[];
  /** Exact synchronized/checkpointed/reviewed/reported product proof for behavior-backed runs. */
  postOrchestration?: RunPostOrchestrationRecord;
}

/** Exact ticket-board projection supplied to a bounded Lead judgment. */

export function createTerminalFailureSettlementProof(
  run: Readonly<RunRecord>,
  action: Readonly<RunActionExecutionRecord>,
): TerminalFailureSettlementProof | undefined {
  if (
    action.boundary.kind !== "assignment_validation" ||
    action.boundary.ticketId === undefined ||
    action.boundary.stepId === undefined ||
    action.boundary.attemptId === undefined ||
    action.semanticResult?.kind !== "assignment" ||
    action.semanticResult.status !== "failed" ||
    action.settlement?.disposition !== "failed"
  ) {
    return undefined;
  }
  const attempt = run.attempts[action.boundary.attemptId];
  if (
    attempt === undefined ||
    attempt.ticketId !== action.boundary.ticketId ||
    attempt.stepId !== action.boundary.stepId ||
    attempt.terminalPolicy === undefined ||
    attempt.terminalOutputSha256 === undefined
  )
    return undefined;
  const material = {
    protocol: "koni.terminal-failure-settlement.v1" as const,
    runId: run.id,
    ticketId: action.boundary.ticketId,
    stepId: action.boundary.stepId,
    attemptId: action.boundary.attemptId,
    actionInvocationId: action.invocationId,
    actionPlanSha256: action.plan.sha256,
    actionSettlementSha256: action.settlement.sha256,
    semanticResult: structuredClone(action.semanticResult),
    semanticResultSha256: canonicalHash(action.semanticResult),
    terminalPolicySha256: attempt.terminalPolicy.sha256,
    terminalOutputSha256: attempt.terminalOutputSha256,
  };
  return { ...material, sha256: canonicalHash(material) };
}

export function createTerminalSuccessSettlementProof(
  run: Readonly<RunRecord>,
  action: Readonly<RunActionExecutionRecord>,
): TerminalSuccessSettlementProof | undefined {
  if (
    action.boundary.kind !== "assignment_validation" ||
    action.boundary.ticketId === undefined ||
    action.boundary.stepId === undefined ||
    action.boundary.attemptId === undefined ||
    action.semanticResult?.kind !== "assignment" ||
    action.semanticResult.status !== "completed" ||
    action.settlement?.disposition !== "completed"
  ) {
    return undefined;
  }
  const attempt = run.attempts[action.boundary.attemptId];
  if (
    attempt === undefined ||
    attempt.ticketId !== action.boundary.ticketId ||
    attempt.stepId !== action.boundary.stepId ||
    attempt.terminalPolicy === undefined ||
    attempt.terminalOutputSha256 === undefined
  )
    return undefined;
  const material = {
    protocol: "koni.terminal-success-settlement.v1" as const,
    runId: run.id,
    ticketId: action.boundary.ticketId,
    stepId: action.boundary.stepId,
    attemptId: action.boundary.attemptId,
    actionInvocationId: action.invocationId,
    actionPlanSha256: action.plan.sha256,
    actionSettlementSha256: action.settlement.sha256,
    semanticResult: structuredClone(action.semanticResult),
    semanticResultSha256: canonicalHash(action.semanticResult),
    terminalPolicySha256: attempt.terminalPolicy.sha256,
    terminalOutputSha256: attempt.terminalOutputSha256,
  };
  return { ...material, sha256: canonicalHash(material) };
}

export function recursivelyFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) recursivelyFreeze(child);
  return Object.freeze(value);
}
