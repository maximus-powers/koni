import type { JsonValue } from "../authority/protocol.js";
import {
  assertCheckExecutionPolicyBinding,
  assertExecutionPolicyBindingIntegrity,
  decideBoundCheckRetry,
  type CheckExecutionPolicyBinding,
  type CheckRetryDecision,
  type ExecutionPolicyBinding,
} from "../authority/execution-policy.js";
import { validateActionExecutionJournal } from "../compiler/action-recipes.js";
import { assertCompiledStateMachineCatalog } from "../compiler/rules.js";
import type {
  ActionExecutionJournal,
  ActionExecutionPlan,
  CompiledActionCatalog,
  CompiledBehaviorIr,
  CompiledRunTypeBehavior,
  CompiledTokenPolicy,
} from "../contracts/behavior.js";
import type {
  CompiledOperationSemantics,
  CompiledWorkflowSemantics,
} from "../compiler/execution-semantics.js";
import type { ConfigurationObject, ConfigurationValue } from "../contracts/configuration.js";
import type { CompiledStateMachineCatalog, DerivedTicketDefinition } from "../contracts/rules.js";
import type {
  GitCompensationEvidence,
  GitLifecycleIntent,
  RunGitLifecycleRecord,
} from "../git/lifecycle.js";
import { assertGitLifecycleIntent, assertRunGitLifecycleRecord } from "../git/lifecycle.js";
import type { AgentAttemptLineage } from "../pi/launch-spec.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import type { QuestionPolicy } from "./question-policy.js";
import { assertQuestionBatchRecord, type QuestionBatchRecord } from "./question-batch.js";
import type { RunLifecycleState } from "./run-lifecycle.js";
import type {
  ApprovedChangeMaterialization,
  ChangeControlPublication,
  TerminalResolverReconciliation,
} from "./change-control.js";
import {
  assertLegacyRunGitMigrationRecord,
  type LegacyRunGitMigrationRecord,
} from "./legacy-run-git-migration.js";

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
  openedAt: string;
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

/**
 * Compiler-authored control/recovery transaction state carried with one ticket. It deliberately
 * contains identities and hashes only; scheduling policy is projected elsewhere from this record.
 */
export interface TicketExecutionControlRecord {
  /** Complete compiler definition, immutable ticket projection, and role-specific causal proof. */
  controlTicketAuthority?: CompilerControlTicketAuthority;
  /** Append-only compiler proof for a recurring asset's fresh-epoch grant replacement. */
  recurringAssetGrantRefreshes?: RecurringAssetGrantRefreshAuthority[];
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
  proposalDecision?: {
    protocol: "koni.proposal-decision-authority.v2";
    runId: string;
    proposalTicketId: string;
    requestSha256: Sha256Digest;
    eventId: string;
    decision: "approval" | "rejection";
    actor: string;
    message?: string;
    recordedAt: string;
    sha256: Sha256Digest;
  };
  /** Bounded append-only audit of every accepted decision, including later audit-only steering. */
  proposalDecisionHistory?: Array<{
    protocol: "koni.proposal-decision-authority.v2";
    runId: string;
    proposalTicketId: string;
    requestSha256: Sha256Digest;
    eventId: string;
    decision: "approval" | "rejection";
    actor: string;
    message?: string;
    recordedAt: string;
    sha256: Sha256Digest;
  }>;
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
    };

export interface RunLeadJudgmentRecord {
  protocol: "koni.lead-judgment-record.v1";
  trigger: "orchestration_entry" | "compiler_deadlock";
  attemptId: string;
  behaviorSha256: Sha256Digest;
  stageId: string;
  graphHash: Sha256Digest;
  runOid: string;
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

export function createRunActionSettlement(
  action: Readonly<RunActionExecutionRecord>,
  disposition: RunActionSettlementRecord["disposition"],
  reason: string,
  settledAt: string,
): RunActionSettlementRecord {
  if (reason.trim().length === 0 || Buffer.byteLength(reason, "utf8") > 64 * 1024) {
    throw new Error("run action settlement reason is invalid");
  }
  const material = {
    protocol: "koni.run-action-settlement.v1" as const,
    invocationId: action.invocationId,
    planSha256: action.plan.sha256,
    journalSha256: action.journal.sha256,
    semanticResultSha256:
      action.semanticResult === undefined ? null : canonicalHash(action.semanticResult),
    disposition,
    reason,
    settledAt,
  };
  return { ...material, sha256: canonicalHash(material) };
}

/**
 * Complete immutable ticket projection. Only runtime lifecycle state is excluded: status,
 * blocker/timestamps, attempts and step results, review counters, worktree/branch, and Git cycle
 * state. Every compiler-owned identity, policy, scope, dependency, persona, validation action,
 * review rule, and control link is retained.
 */
export function ticketImmutableProjection(
  ticket: Readonly<TicketRecord>,
): TicketImmutableProjection {
  const executionControl = ticket.executionControl;
  let control: TicketImmutableProjection["control"] = { role: "ordinary" };
  if (executionControl?.proposalRequest !== undefined) {
    control = {
      role: "proposal",
      changeControlScopeNodeIds: [...(executionControl.changeControlScopeNodeIds ?? [])],
      proposalRequest: structuredClone(executionControl.proposalRequest),
    };
  } else if (
    executionControl?.sourceProposalTicketId !== undefined ||
    executionControl?.approvedApplicationSha256 !== undefined
  ) {
    control = {
      role: "approved_application",
      changeControlScopeNodeIds: [...(executionControl.changeControlScopeNodeIds ?? [])],
      sourceProposalTicketId: executionControl.sourceProposalTicketId ?? "",
      approvedApplicationSha256: executionControl.approvedApplicationSha256 ?? ("" as Sha256Digest),
    };
  } else if (executionControl?.terminalRecovery !== undefined) {
    control = {
      role: "terminal_resolver",
      changeControlScopeNodeIds: [...(executionControl.changeControlScopeNodeIds ?? [])],
      terminalRecovery: structuredClone(executionControl.terminalRecovery),
    };
  }
  const material = {
    protocol: TICKET_IMMUTABLE_PROJECTION_PROTOCOL,
    id: ticket.id,
    operationId: ticket.operationId,
    title: ticket.title,
    summary: ticket.summary,
    executionPolicyBinding: ticket.executionPolicyBinding ?? null,
    control,
    priority: ticket.priority,
    dependencyIds: ticket.dependencyIds,
    targetNodeIds: ticket.targetNodeIds,
    readNodeIds: ticket.readNodeIds ?? [],
    writeNodeIds: ticket.writeNodeIds ?? [],
    readPaths: ticket.readPaths,
    writePaths: ticket.writePaths,
    reviewFailureReopenFrom: ticket.reviewFailureReopenFrom ?? null,
    reviewReworkLimit: ticket.reviewReworkLimit ?? null,
    steps: ticket.steps.map((step) => ({
      id: step.id,
      title: step.title,
      personaId: step.personaId,
      kind: step.kind ?? null,
      dependsOn: step.dependsOn ?? [],
      readNodeIds: step.readNodeIds ?? [],
      writeNodeIds: step.writeNodeIds ?? [],
      readPaths: step.readPaths ?? [],
      writePaths: step.writePaths ?? [],
      validationAction: step.validationAction ?? null,
      executionPolicyBinding: step.executionPolicyBinding ?? null,
    })),
    integrationForTicketId: ticket.integrationForTicketId ?? null,
  };
  return { ...material, sha256: canonicalHash(material) };
}

/** Create the compiler-authored authority before a control ticket is admitted to durable state. */
export function createCompilerControlTicketAuthority(
  input: Readonly<{
    runId: string;
    role: ControlTicketRole;
    ticket: TicketRecord;
    operation: CompiledOperationSemantics;
    workflow: CompiledWorkflowSemantics;
    definition: DerivedTicketDefinition;
    causal: ControlTicketCausalAuthority;
  }>,
): CompilerControlTicketAuthority {
  const projection = ticketImmutableProjection(input.ticket);
  if (projection.control.role !== input.role) {
    throw new Error(
      `control ticket projection role differs from compiler authority: ${input.ticket.id}`,
    );
  }
  const material = {
    protocol: CONTROL_TICKET_AUTHORITY_PROTOCOL,
    runId: input.runId,
    role: input.role,
    ticketId: input.ticket.id,
    configurationSha256: input.definition.configuration_sha256,
    catalogSha256: input.ticket.executionPolicyBinding?.catalogSha256 ?? ("" as Sha256Digest),
    operation: structuredClone(input.operation),
    workflow: structuredClone(input.workflow),
    definition: structuredClone(input.definition),
    causal: structuredClone(input.causal),
    projection,
    projectionSha256: projection.sha256,
  };
  return { ...material, sha256: canonicalHash(material) };
}

/** @deprecated Use the shared projection for every compiler-created control-ticket role. */
export function applicationTicketAuthorityProjection(
  ticket: Readonly<TicketRecord>,
): TicketImmutableProjection {
  return ticketImmutableProjection(ticket);
}

/** Create the exact semantic-failure proof retained by live and archived action projections. */
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

export function assertRunRecord(value: unknown): asserts value is RunRecord {
  if (!isRecord(value) || value.protocol !== RUN_RECORD_PROTOCOL) {
    throw new Error("run record protocol is missing or unsupported");
  }
  if (!isId(value.id) || !isRevision(value.revision) || !isRevision(value.generation)) {
    throw new Error("run record identity or revision is invalid");
  }
  if (
    typeof value.projectRoot !== "string" ||
    typeof value.objective !== "string" ||
    typeof value.runTypeId !== "string" ||
    !isRecord(value.lifecycle) ||
    !isRecord(value.tickets) ||
    !isRecord(value.attempts) ||
    !isRecord(value.questions) ||
    !Array.isArray(value.activity) ||
    !isRecord(value.git)
  ) {
    throw new Error("run record has an invalid required field");
  }
  if (
    value.planningMode !== undefined &&
    value.planningMode !== "agent" &&
    value.planningMode !== "direct"
  ) {
    throw new Error("run record planning mode is invalid");
  }
  if (
    isRecord(value.plan) &&
    value.plan.title !== undefined &&
    (typeof value.plan.title !== "string" ||
      value.plan.title.trim().length === 0 ||
      Buffer.byteLength(value.plan.title, "utf8") > 256)
  ) {
    throw new Error("run plan title is invalid");
  }
  if (
    value.pendingPause !== undefined &&
    (!isRecord(value.pendingPause) ||
      typeof value.pendingPause.requestedAt !== "string" ||
      value.pendingPause.requestedAt.length === 0)
  ) {
    throw new Error("run pending-pause intent is invalid");
  }
  if (
    value.activity.some(
      (event) =>
        isRecord(event) &&
        event.tone !== undefined &&
        (typeof event.tone !== "string" ||
          !["info", "success", "warning", "error"].includes(event.tone)),
    )
  ) {
    throw new Error("run activity tone is invalid");
  }
  if (!isRecord(value.intake)) throw new Error("run intake is invalid");
  if (value.lifecycleCatalog !== undefined) {
    if (!isRecord(value.lifecycleCatalog)) throw new Error("run lifecycle catalog is invalid");
    assertCompiledStateMachineCatalog(
      value.lifecycleCatalog as unknown as CompiledStateMachineCatalog,
    );
    if (value.lifecycleCatalog.configuration_sha256 !== value.compiledConfigHash) {
      throw new Error("run lifecycle catalog is not bound to the compiled configuration");
    }
  }
  if (value.behavior !== undefined)
    assertRunBehaviorSnapshot(value.behavior, value.runTypeId, value.git);
  const pipelineStageIds = value.pipelineStageIds;
  if (
    !Array.isArray(pipelineStageIds) ||
    pipelineStageIds.some((id) => !isId(id)) ||
    new Set(pipelineStageIds).size !== pipelineStageIds.length ||
    (value.currentPipelineStageId !== undefined &&
      (typeof value.currentPipelineStageId !== "string" ||
        !pipelineStageIds.includes(value.currentPipelineStageId)))
  )
    throw new Error("run pipeline stage identities are invalid");
  if (value.pipelineStages !== undefined) {
    if (
      !Array.isArray(value.pipelineStages) ||
      value.pipelineStages.length !== pipelineStageIds.length ||
      value.pipelineStages.some(
        (stage, index) =>
          !isRecord(stage) ||
          stage.id !== pipelineStageIds[index] ||
          typeof stage.title !== "string" ||
          stage.title.length === 0 ||
          typeof stage.kind !== "string" ||
          stage.kind.length === 0 ||
          typeof stage.automatic !== "boolean",
      )
    )
      throw new Error("run semantic pipeline projection is invalid");
  }
  if (
    value.deletion !== undefined &&
    (!isRecord(value.deletion) ||
      value.deletion.protocol !== "koni.run-deletion.v1" ||
      (value.deletion.mode !== "preserve_branches" &&
        value.deletion.mode !== "delete_owned_branches") ||
      !isSha256Digest(value.deletion.previewToken) ||
      typeof value.deletion.requestedAt !== "string" ||
      value.deletion.requestedAt.length === 0)
  )
    throw new Error("run deletion choice is invalid");
  if (
    value.executionConfig !== undefined &&
    (!isRecord(value.executionConfig) ||
      (value.executionConfig.disjointScopeParallelism !== undefined &&
        typeof value.executionConfig.disjointScopeParallelism !== "boolean"))
  )
    throw new Error("run execution scope policy is invalid");
  if (value.workingSpecOwnerId !== undefined) {
    const execution = value.executionConfig;
    if (
      !isId(value.workingSpecOwnerId) ||
      (execution !== undefined &&
        (!isRecord(execution) ||
          !isRecord(execution.agents) ||
          execution.agents[value.workingSpecOwnerId] === undefined))
    )
      throw new Error("run working-spec owner is invalid or is not a managed persona");
  }
  assertRunGitLifecycleRecord(value.git);
  if (value.legacyGitMigration !== undefined) {
    assertLegacyRunGitMigrationRecord(
      value.legacyGitMigration,
      value.id,
      value.projectRoot,
      value.git,
    );
  }
  if (value.pendingGitIntents !== undefined) {
    if (!isRecord(value.pendingGitIntents)) throw new Error("run pending Git intents are invalid");
    for (const [id, intent] of Object.entries(value.pendingGitIntents)) {
      assertGitLifecycleIntent(intent);
      if (intent.id !== id || intent.runId !== value.id) {
        throw new Error(`invalid pending Git intent identity: ${id}`);
      }
    }
  }
  if (
    value.gitReceipts !== undefined &&
    (!Array.isArray(value.gitReceipts) ||
      value.gitReceipts.some(
        (receipt) =>
          !isRecord(receipt) ||
          typeof receipt.intentId !== "string" ||
          typeof receipt.kind !== "string" ||
          (receipt.status !== "completed" && receipt.status !== "blocked") ||
          !isSha256Digest(receipt.lifecycleSha256) ||
          (receipt.runtimeClosureSha256 !== undefined &&
            !isSha256Digest(receipt.runtimeClosureSha256)) ||
          (receipt.gitExecutableSha256 !== undefined &&
            !isSha256Digest(receipt.gitExecutableSha256)) ||
          typeof receipt.settledAt !== "string" ||
          !isOptionalCompensationEvidence(receipt.compensation),
      ))
  )
    throw new Error("run Git receipts are invalid");
  if (value.reports !== undefined) {
    if (!Array.isArray(value.reports) || value.reports.length > 10_000) {
      throw new Error("run report records are invalid");
    }
    for (const report of value.reports) assertRunReport(report);
  }
  for (const [id, ticket] of Object.entries(value.tickets)) {
    assertTicketRecord(id, ticket);
  }
  assertRunExecutionControlGraph(value as unknown as RunRecord);
  for (const [id, attempt] of Object.entries(value.attempts)) {
    assertAttemptRecord(id, attempt);
  }
  for (const attempt of Object.values(value.attempts) as AgentAttemptRecord[]) {
    if (
      attempt.tokenBudgetRecovery !== undefined &&
      attempt.tokenBudgetRecovery.ticketExecutionEpoch !==
        normalizedAttemptTicketExecutionEpoch(value as unknown as RunRecord, attempt)
    ) {
      throw new Error(`invalid attempt token-budget recovery slice: ${attempt.id}`);
    }
  }
  assertPlanningSessionRecord(value as unknown as RunRecord);
  assertAttemptLineageForest(value.attempts as Record<string, AgentAttemptRecord>);
  assertLeadJudgments(
    value.leadJudgments,
    value.behavior,
    value.attempts as Record<string, AgentAttemptRecord>,
  );
  assertRunActionExecutions(value.actionExecutions, value as unknown as RunRecord);
  assertRunActionArchive(value.actionExecutionArchive, value.actionExecutionArchiveSegments);
  assertInterruptedTerminalAcceptanceSettlement(value as unknown as RunRecord);
  assertTerminalFailureProofIndex(value.terminalFailureProofs, value as unknown as RunRecord);
  assertTerminalSuccessProofIndex(value.terminalSuccessProofs, value as unknown as RunRecord);
  for (const [id, question] of Object.entries(value.questions)) {
    assertQuestionRecord(id, question, value.attempts as Record<string, AgentAttemptRecord>);
  }
  if (value.questionBatches !== undefined) {
    if (!isRecord(value.questionBatches)) throw new Error("run question batches are invalid");
    const planningSession = value.planningSession as PlanningSessionRecord | undefined;
    for (const [id, batch] of Object.entries(value.questionBatches)) {
      assertQuestionBatchRecord(batch);
      const typedBatch = batch;
      const batchAttempt = (value.attempts as Record<string, AgentAttemptRecord>)[
        typedBatch.attemptId
      ];
      if (
        typedBatch.id !== id ||
        batchAttempt === undefined ||
        (typedBatch.scope === "ticket" && typedBatch.ticketId !== batchAttempt.ticketId) ||
        (typedBatch.planningRevision !== undefined &&
          (batchAttempt.kind !== "planning" ||
            planningSession === undefined ||
            planningSession.attemptId !== batchAttempt.id ||
            typedBatch.planningRevision > planningSession.currentRevision))
      ) {
        throw new Error(`invalid run question batch identity: ${id}`);
      }
    }
  }
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks) || value.checks.length > 100_000) {
      throw new Error("run check records are invalid");
    }
    for (const check of value.checks) assertRunCheck(check);
  }
  if (value.pendingEffects !== undefined) {
    if (!isRecord(value.pendingEffects)) throw new Error("run pending effects are invalid");
    for (const [id, effect] of Object.entries(value.pendingEffects))
      assertWorkspaceEffect(id, effect);
  }
  if (value.pendingChecks !== undefined) {
    if (!isRecord(value.pendingChecks)) throw new Error("run pending checks are invalid");
    for (const [id, check] of Object.entries(value.pendingChecks)) assertPendingCheck(id, check);
  }
  if (value.postOrchestration !== undefined) {
    // All required run fields and every referenced attempt/report are structurally proven above.
    assertRunPostOrchestration(value.postOrchestration, value as unknown as RunRecord);
  }
}

function assertPlanningSessionRecord(run: Readonly<RunRecord>): void {
  const session = run.planningSession;
  if (session === undefined) return;
  if (
    !isRecord(session) ||
    session.protocol !== "koni.planning-session.v1" ||
    !isId(session.attemptId) ||
    !isId(session.sessionId) ||
    ![
      "running",
      "waiting_question",
      "awaiting_review",
      "approving",
      "approved",
      "blocked",
    ].includes(String(session.status)) ||
    !isNonnegativeSafeInteger(session.currentRevision) ||
    !Array.isArray(session.revisions) ||
    session.revisions.length === 0 ||
    session.revisions.length > 10_000 ||
    session.currentRevision !== session.revisions.length - 1
  ) {
    throw new Error("run planning session is invalid");
  }

  const planningAttempt = run.attempts[session.attemptId];
  if (
    planningAttempt?.kind !== "planning" ||
    planningAttempt.sessionId !== session.sessionId ||
    !planningAttemptStatusMatchesSession(planningAttempt.status, session.status)
  ) {
    throw new Error("run planning session has an invalid stable attempt identity or status");
  }

  for (const [index, revision] of session.revisions.entries()) {
    assertPlanningRevisionRecord(revision, index, session.currentRevision);
  }
  const current = session.revisions[session.currentRevision]!;
  const expectedCurrentStatus =
    session.status === "running" || session.status === "waiting_question"
      ? "running"
      : session.status === "awaiting_review" || session.status === "approving"
        ? "awaiting_review"
        : session.status === "approved"
          ? "approved"
          : "failed";
  if (current.status !== expectedCurrentStatus) {
    throw new Error("run planning session current revision status is invalid");
  }

  if (
    (session.status === "approved") !== (session.approvedRevision !== undefined) ||
    (session.approvedRevision !== undefined && session.approvedRevision !== session.currentRevision)
  ) {
    throw new Error("run planning session approval revision is invalid");
  }

  const projectedRevision = [...session.revisions]
    .reverse()
    .find(
      (revision) =>
        revision.status === "awaiting_review" ||
        revision.status === "superseded" ||
        revision.status === "approved",
    );
  if (
    (projectedRevision === undefined && run.plan !== undefined) ||
    (projectedRevision !== undefined && run.plan?.revision !== projectedRevision.revision)
  ) {
    throw new Error("run plan is not bound to the latest validated planning revision");
  }
  if (run.plan === undefined) return;
  const expectedPlanStatuses: Readonly<Record<PlanningSessionRecord["status"], readonly string[]>> =
    {
      running: ["planning", "revising", "awaiting_approval"],
      waiting_question: ["planning", "revising", "awaiting_approval"],
      awaiting_review: ["awaiting_approval"],
      approving: ["approving"],
      approved: ["approved"],
      blocked: ["planning", "revising", "awaiting_approval"],
    };
  if (!expectedPlanStatuses[session.status].includes(run.plan.status)) {
    throw new Error("run plan status does not agree with its planning session");
  }
}

function assertPlanningRevisionRecord(
  revision: unknown,
  expectedRevision: number,
  currentRevision: number,
): asserts revision is PlanningRevisionRecord {
  if (
    !isRecord(revision) ||
    revision.protocol !== "koni.planning-revision.v1" ||
    revision.revision !== expectedRevision ||
    !["running", "awaiting_review", "superseded", "approved", "failed"].includes(
      String(revision.status),
    ) ||
    !isSha256Digest(revision.launchSpecSha256) ||
    !isSha256Digest(revision.grantSha256) ||
    !isAgentProviderTokenTotals(revision.budgetBaseline) ||
    !isCompiledTokenPolicy(revision.budgetPolicy) ||
    !isBoundedRecordText(revision.startedAt, 128) ||
    (revision.completedAt !== undefined && !isBoundedRecordText(revision.completedAt, 128))
  ) {
    throw new Error(`run planning revision ${expectedRevision} is invalid`);
  }
  if (
    revision.planningSynthesis !== undefined &&
    !isPlanningSynthesisRecord(revision.planningSynthesis)
  ) {
    throw new Error(`run planning revision ${expectedRevision} has invalid synthesis authority`);
  }

  if (
    (expectedRevision === 0 && revision.steering !== undefined) ||
    (expectedRevision > 0 && !isPlanningSteeringBinding(revision.steering, expectedRevision))
  ) {
    throw new Error(`run planning revision ${expectedRevision} has invalid steering authority`);
  }

  for (const field of [
    "patchSha256",
    "artifactSha256",
    "graphSha256",
    "transcriptSha256",
  ] as const) {
    if (revision[field] !== undefined && !isSha256Digest(revision[field])) {
      throw new Error(`run planning revision ${expectedRevision} has an invalid ${field}`);
    }
  }
  if (
    revision.checkpointPath !== undefined &&
    (typeof revision.checkpointPath !== "string" || !isProjectRelativePath(revision.checkpointPath))
  ) {
    throw new Error(`run planning revision ${expectedRevision} has an invalid checkpoint path`);
  }

  const checkpointed =
    revision.status === "awaiting_review" ||
    revision.status === "superseded" ||
    revision.status === "approved";
  const checkpointFieldsPresent =
    revision.artifactSha256 !== undefined &&
    revision.graphSha256 !== undefined &&
    revision.transcriptSha256 !== undefined &&
    revision.checkpointPath !== undefined &&
    revision.completedAt !== undefined;
  if (
    checkpointed !== checkpointFieldsPresent ||
    (checkpointed && expectedRevision > 0 && revision.patchSha256 === undefined) ||
    (expectedRevision === 0 && revision.patchSha256 !== undefined) ||
    (expectedRevision < currentRevision && revision.status !== "superseded")
  ) {
    throw new Error(`run planning revision ${expectedRevision} checkpoint state is invalid`);
  }
}

function planningAttemptStatusMatchesSession(
  attemptStatus: AttemptStatus,
  sessionStatus: PlanningSessionRecord["status"],
): boolean {
  switch (sessionStatus) {
    case "running":
      return ["queued", "running", "terminal_accepted"].includes(attemptStatus);
    case "waiting_question":
      return attemptStatus === "waiting_question";
    case "awaiting_review":
    case "approving":
      return attemptStatus === "waiting_plan_review";
    case "approved":
      return attemptStatus === "completed";
    case "blocked":
      return ["failed", "aborted", "interrupted"].includes(attemptStatus);
  }
}

function isAgentProviderTokenTotals(value: unknown): value is AgentProviderTokenTotals {
  return (
    isRecord(value) &&
    isNonnegativeSafeInteger(value.inputTokens) &&
    isNonnegativeSafeInteger(value.outputTokens) &&
    isNonnegativeSafeInteger(value.cacheReadTokens) &&
    isNonnegativeSafeInteger(value.cacheWriteTokens)
  );
}

function isCompiledTokenPolicy(value: unknown): value is CompiledTokenPolicy {
  return (
    isRecord(value) &&
    value.metric === "new_tokens" &&
    isNonnegativeSafeInteger(value.limit) &&
    value.limit > 0 &&
    isNonnegativeSafeInteger(value.synthesisReserve) &&
    value.synthesisReserve > 0 &&
    isNonnegativeSafeInteger(value.synthesisThreshold) &&
    value.synthesisThreshold === value.limit - value.synthesisReserve &&
    value.onExhausted === "force_synthesis"
  );
}

function isPlanningSynthesisRecord(value: unknown): value is PlanningSynthesisRecord {
  return (
    isRecord(value) &&
    value.protocol === "koni.planning-synthesis.v1" &&
    isNonnegativeSafeInteger(value.thresholdNewTokens) &&
    value.thresholdNewTokens > 0 &&
    isNonnegativeSafeInteger(value.limitNewTokens) &&
    value.limitNewTokens > value.thresholdNewTokens &&
    isNonnegativeSafeInteger(value.reserveNewTokens) &&
    value.reserveNewTokens === value.limitNewTokens - value.thresholdNewTokens &&
    (value.triggerReason === undefined) === (value.triggeredNewTokens === undefined) &&
    (value.triggerReason === undefined ||
      value.triggerReason === "token_threshold" ||
      value.triggerReason === "provider_input_pressure") &&
    (value.triggeredNewTokens === undefined ||
      isNonnegativeSafeInteger(value.triggeredNewTokens)) &&
    isSha256Digest(value.instructionSha256) &&
    isNonnegativeSafeInteger(value.instructionSizeBytes) &&
    value.instructionSizeBytes > 0 &&
    typeof value.instructionArtifactPath === "string" &&
    value.instructionArtifactPath.length > 0 &&
    typeof value.triggeredAt === "string" &&
    value.triggeredAt.length > 0
  );
}

function isPlanningSteeringBinding(
  value: unknown,
  expectedSequence: number,
): value is PlanningSteeringBinding {
  return (
    isRecord(value) &&
    value.sequence === expectedSequence &&
    isSha256Digest(value.instructionsSha256) &&
    isNonnegativeSafeInteger(value.instructionsSizeBytes) &&
    value.instructionsSizeBytes > 0 &&
    typeof value.artifactPath === "string" &&
    isProjectRelativePath(value.artifactPath) &&
    isBoundedRecordText(value.recordedAt, 128)
  );
}

function assertLeadJudgments(
  value: unknown,
  behavior: RunBehaviorSnapshot | undefined,
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
): void {
  if (value === undefined) return;
  // Two triggers may be issued for each immutable graph/run binding. Keep prior bindings as audit
  // history across a plan revision, rather than making a valid replacement Lead judgment corrupt
  // the whole run record. Medium research runs can legitimately cross dozens of graph bindings;
  // retain a generous finite cap so the audit remains bounded without rejecting ordinary recovery.
  if (!Array.isArray(value) || value.length > 1_024 || behavior === undefined) {
    throw new Error("run Lead judgment history is invalid");
  }
  const bindingTriggers = new Set<string>();
  const orchestrationStageId = behavior.runType.pipeline.find(
    (stage) => stage.kind === "orchestration",
  )?.id;
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      raw.protocol !== "koni.lead-judgment-record.v1" ||
      (raw.trigger !== "orchestration_entry" && raw.trigger !== "compiler_deadlock") ||
      !isId(raw.attemptId) ||
      raw.behaviorSha256 !== behavior.sha256 ||
      raw.stageId !== orchestrationStageId ||
      !isSha256Digest(raw.graphHash) ||
      typeof raw.runOid !== "string" ||
      !/^[0-9a-f]{40,64}$/u.test(raw.runOid) ||
      (raw.disposition !== "proceed" && raw.disposition !== "blocked") ||
      typeof raw.summary !== "string" ||
      raw.summary.trim().length === 0 ||
      raw.summary.includes("\0") ||
      Buffer.byteLength(raw.summary, "utf8") > 4_096 ||
      typeof raw.recordedAt !== "string" ||
      raw.recordedAt.length === 0
    ) {
      throw new Error("run Lead judgment record is invalid");
    }
    const bindingTrigger = `${raw.graphHash}\u0000${raw.runOid}\u0000${raw.trigger}`;
    if (bindingTriggers.has(bindingTrigger)) {
      throw new Error("run Lead judgment record is invalid");
    }
    const attempt = attempts[raw.attemptId];
    const expectedStep =
      raw.trigger === "orchestration_entry" ? "lead-orchestration-entry" : "lead-compiler-deadlock";
    if (
      attempt?.kind !== "lead" ||
      attempt.ticketId !== "run-orchestration" ||
      attempt.stepId !== expectedStep ||
      attempt.personaId !== behavior.runType.leadJudgment.personaId
    ) {
      throw new Error("run Lead judgment attempt binding is invalid");
    }
    bindingTriggers.add(bindingTrigger);
  }
}

function assertRunActionExecutions(value: unknown, run: Readonly<RunRecord>): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length > 2_048 || run.behavior === undefined) {
    throw new Error("run action executions are invalid");
  }
  for (const [invocationId, raw] of Object.entries(value)) {
    if (
      !isRecord(raw) ||
      raw.protocol !== "koni.run-action-execution.v1" ||
      raw.invocationId !== invocationId ||
      !isId(invocationId) ||
      !isRecord(raw.boundary) ||
      !isRecord(raw.plan) ||
      !isRecord(raw.journal) ||
      !isRecord(raw.effects) ||
      !isNonnegativeSafeInteger(raw.expectedRunRevision) ||
      typeof raw.createdAt !== "string" ||
      raw.createdAt.length === 0 ||
      typeof raw.updatedAt !== "string" ||
      raw.updatedAt.length === 0 ||
      (raw.settledAt !== undefined &&
        (typeof raw.settledAt !== "string" || raw.settledAt.length === 0)) ||
      (raw.settlement !== undefined && !isRecord(raw.settlement)) ||
      (raw.recoveryInvocationId !== undefined && !isId(raw.recoveryInvocationId)) ||
      (raw.recoverySettledAt !== undefined &&
        (typeof raw.recoverySettledAt !== "string" || raw.recoverySettledAt.length === 0)) ||
      (raw.compilerRetryHistory !== undefined &&
        (!Array.isArray(raw.compilerRetryHistory) || raw.compilerRetryHistory.length > 16))
    ) {
      throw new Error(`invalid run action execution: ${invocationId}`);
    }
    assertRunActionBoundary(raw.boundary, run, invocationId);
    const plan = raw.plan as unknown as ActionExecutionPlan;
    const journal = raw.journal as unknown as ActionExecutionJournal;
    const { sha256: planSha256, ...planMaterial } = plan;
    const { sha256: journalSha256, ...journalMaterial } = journal;
    if (
      plan.protocol !== "koni.action-execution-plan.v1" ||
      plan.invocationId !== invocationId ||
      !isSha256Digest(planSha256) ||
      canonicalHash(planMaterial) !== planSha256 ||
      plan.catalogSha256 !== run.behavior.actions.sha256 ||
      run.behavior.actions.actions[plan.actionId]?.sha256 !== plan.actionSha256 ||
      journal.protocol !== "koni.action-execution-journal.v1" ||
      journal.invocationId !== invocationId ||
      journal.planSha256 !== planSha256 ||
      !isSha256Digest(journalSha256) ||
      canonicalHash(journalMaterial) !== journalSha256
    ) {
      throw new Error(`invalid run action plan or journal: ${invocationId}`);
    }
    try {
      validateActionExecutionJournal(plan, journal);
    } catch {
      throw new Error(`impossible run action journal state: ${invocationId}`);
    }
    const compilerRetryHashes = new Set<string>();
    for (const [index, retry] of (raw.compilerRetryHistory ?? []).entries()) {
      if (
        !isRecord(retry) ||
        retry.protocol !== "koni.run-action-compiler-retry.v1" ||
        !isRecord(retry.journal) ||
        typeof retry.reason !== "string" ||
        retry.reason.length === 0 ||
        typeof retry.retriedAt !== "string" ||
        retry.retriedAt.length === 0 ||
        !isSha256Digest(retry.sha256)
      ) {
        throw new Error(`invalid compiler retry ${index} for run action: ${invocationId}`);
      }
      const { sha256, ...material } = retry;
      if (canonicalHash(material) !== sha256 || compilerRetryHashes.has(sha256)) {
        throw new Error(`invalid compiler retry identity ${index} for run action: ${invocationId}`);
      }
      compilerRetryHashes.add(sha256);
      const priorJournal = retry.journal as unknown as ActionExecutionJournal;
      if (priorJournal.status !== "failed") {
        throw new Error(`compiler retry did not retain a failed journal: ${invocationId}`);
      }
      try {
        validateActionExecutionJournal(plan, priorJournal);
      } catch {
        throw new Error(`compiler retry retained an impossible journal: ${invocationId}`);
      }
    }
    const effectEntries = Object.entries(raw.effects);
    if (effectEntries.length > plan.recipe.length + plan.compensation.length) {
      throw new Error(`run action has more effects than configured steps: ${invocationId}`);
    }
    for (const [effectKey, effect] of effectEntries) {
      assertRunActionEffectReceipt(effectKey, effect, plan);
    }
    if (raw.semanticResult !== undefined) assertRunActionSemanticResult(raw.semanticResult);
    if (raw.settlement !== undefined) {
      assertRunActionSettlement(raw.settlement, raw as unknown as RunActionExecutionRecord);
    }
    if (raw.settlement !== undefined && raw.settledAt !== raw.settlement.settledAt) {
      throw new Error(
        `run action settlement timestamp differs from legacy projection: ${invocationId}`,
      );
    }
    if (raw.boundary.kind === "lead_launch" && raw.settledAt !== undefined) {
      const attemptId = raw.boundary.attemptId;
      const attempt = typeof attemptId === "string" ? run.attempts[attemptId] : undefined;
      const abandonedBeforeLaunch =
        raw.settlement?.disposition === "abandoned" && attempt === undefined;
      if (
        !abandonedBeforeLaunch &&
        (attempt?.kind !== "lead" || attempt.launchActionInvocationId !== invocationId)
      ) {
        throw new Error(`settled Lead action has no exact admitted attempt: ${invocationId}`);
      }
    }
  }
}

function assertRunActionTerminalArchiveAuthority(
  value: unknown,
): asserts value is RunActionTerminalArchiveAuthority {
  if (!isRecord(value)) throw new Error("run action terminal archive authority is invalid");
  const { sha256, ...material } = value;
  if (
    value.protocol !== "koni.run-action-terminal-archive-authority.v1" ||
    !isId(value.runId) ||
    !isId(value.invocationId) ||
    !isSha256Digest(value.boundarySha256) ||
    !isId(value.ticketId) ||
    !isId(value.stepId) ||
    !isId(value.attemptId) ||
    !isSha256Digest(value.actionPlanSha256) ||
    !isSha256Digest(value.actionSettlementSha256) ||
    !["completed", "failed", "abandoned"].includes(String(value.settlementDisposition)) ||
    !isSha256Digest(value.terminalOutputSha256) ||
    (value.terminalPolicySha256 !== undefined && !isSha256Digest(value.terminalPolicySha256)) ||
    (value.terminalProofSha256 !== undefined && !isSha256Digest(value.terminalProofSha256)) ||
    !isSha256Digest(sha256) ||
    canonicalHash(material) !== sha256
  ) {
    throw new Error("run action terminal archive authority is invalid");
  }
  const abandoned = value.settlementDisposition === "abandoned";
  if (
    abandoned !== (value.terminalPolicySha256 === undefined) ||
    abandoned !== (value.terminalProofSha256 === undefined)
  ) {
    throw new Error("run action terminal archive authority has invalid semantic closure");
  }
}

function assertRunActionArchive(value: unknown, segments: unknown): void {
  if (value !== undefined) {
    if (!Array.isArray(value) || value.length > 8_192)
      throw new Error("run action archive is invalid");
    const ids = new Set<string>();
    for (const raw of value) {
      if (
        !isRecord(raw) ||
        (raw.protocol !== "koni.run-action-archive.v1" &&
          raw.protocol !== "koni.run-action-archive.v2") ||
        !isId(raw.invocationId) ||
        ids.has(raw.invocationId) ||
        ![
          "approved_plan_compile",
          "assignment_validation",
          "configured_stage",
          "lead_launch",
          "post_orchestration_report",
          "recovery",
        ].includes(String(raw.kind)) ||
        !isId(raw.actionId) ||
        !isSha256Digest(raw.planSha256) ||
        ![
          "running",
          "compensating",
          "completed",
          "failed",
          "compensated",
          "compensation_failed",
          "recovery_required",
        ].includes(String(raw.journalStatus)) ||
        (raw.settlementSha256 !== undefined && !isSha256Digest(raw.settlementSha256)) ||
        (raw.settlementDisposition !== undefined &&
          !["completed", "failed", "abandoned"].includes(String(raw.settlementDisposition))) ||
        typeof raw.artifactPath !== "string" ||
        !isProjectRelativePath(raw.artifactPath) ||
        !isSha256Digest(raw.artifactSha256) ||
        !isNonnegativeSafeInteger(raw.artifactSizeBytes) ||
        raw.artifactSizeBytes < 1 ||
        typeof raw.archivedAt !== "string" ||
        raw.archivedAt.length === 0
      ) {
        throw new Error("run action archive record is invalid");
      }
      if (
        (raw.journalStatus === "running" || raw.journalStatus === "compensating") &&
        raw.settlementDisposition !== "abandoned"
      ) {
        throw new Error("run action archive contains an unsettled nonterminal journal");
      }
      if (raw.terminalFailureProof !== undefined) {
        assertTerminalFailureSettlementProof(raw.terminalFailureProof);
        if (
          raw.terminalFailureProof.actionInvocationId !== raw.invocationId ||
          raw.terminalFailureProof.actionPlanSha256 !== raw.planSha256 ||
          raw.terminalFailureProof.actionSettlementSha256 !== raw.settlementSha256
        ) {
          throw new Error("run action archive terminal failure proof differs from its action");
        }
      }
      if (raw.terminalAuthority !== undefined) {
        assertRunActionTerminalArchiveAuthority(raw.terminalAuthority);
        if (
          raw.terminalAuthority.invocationId !== raw.invocationId ||
          raw.terminalAuthority.actionPlanSha256 !== raw.planSha256 ||
          raw.terminalAuthority.actionSettlementSha256 !== raw.settlementSha256 ||
          raw.terminalAuthority.settlementDisposition !== raw.settlementDisposition
        ) {
          throw new Error("run action archive terminal authority differs from its action row");
        }
        if (
          raw.terminalFailureProof !== undefined &&
          (raw.terminalAuthority.settlementDisposition !== "failed" ||
            raw.terminalAuthority.terminalProofSha256 !== raw.terminalFailureProof.sha256)
        ) {
          throw new Error("run action archive terminal failure differs from terminal authority");
        }
      } else if (
        raw.protocol === "koni.run-action-archive.v2" &&
        raw.terminalFailureProof !== undefined
      ) {
        throw new Error("run action archive terminal failure lacks non-evictable authority");
      }
      ids.add(raw.invocationId);
    }
  }
  if (segments !== undefined) {
    if (!Array.isArray(segments) || segments.length > 10_000)
      throw new Error("run action archive segments are invalid");
    for (const raw of segments) {
      if (
        !isRecord(raw) ||
        (raw.protocol !== "koni.run-action-archive-segment.v1" &&
          raw.protocol !== "koni.run-action-archive-segment.v2") ||
        !isId(raw.firstInvocationId) ||
        !isId(raw.lastInvocationId) ||
        !isNonnegativeSafeInteger(raw.count) ||
        raw.count < 1 ||
        typeof raw.artifactPath !== "string" ||
        !isProjectRelativePath(raw.artifactPath) ||
        !isSha256Digest(raw.artifactSha256) ||
        !isNonnegativeSafeInteger(raw.artifactSizeBytes) ||
        raw.artifactSizeBytes < 1 ||
        typeof raw.archivedAt !== "string" ||
        raw.archivedAt.length === 0
      ) {
        throw new Error("run action archive segment is invalid");
      }
      if (raw.terminalAuthorities !== undefined) {
        if (!Array.isArray(raw.terminalAuthorities) || raw.terminalAuthorities.length > raw.count) {
          throw new Error("run action archive segment terminal authorities are invalid");
        }
        const attempts = new Set<string>();
        const invocations = new Set<string>();
        for (const authority of raw.terminalAuthorities) {
          assertRunActionTerminalArchiveAuthority(authority);
          if (attempts.has(authority.attemptId) || invocations.has(authority.invocationId)) {
            throw new Error("run action archive segment repeats terminal authority");
          }
          attempts.add(authority.attemptId);
          invocations.add(authority.invocationId);
        }
      }
    }
  }
}

/** Validate one row against the exact serialized action artifact and return that action. */
export function validateRunActionArchiveArtifact(
  run: Readonly<RunRecord>,
  row: Readonly<RunActionExecutionArchiveRecord>,
  bytes: Buffer,
): RunActionExecutionRecord {
  if (bytes.byteLength !== row.artifactSizeBytes || rawSha256(bytes) !== row.artifactSha256) {
    throw new Error(`run action archive artifact digest differs from row: ${row.invocationId}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`run action archive artifact is not JSON: ${row.invocationId}`);
  }
  if (
    !isRecord(value) ||
    value.invocationId !== row.invocationId ||
    !bytes.equals(encodeRunActionArchiveArtifact(value))
  ) {
    throw new Error(`run action archive artifact is not the canonical action: ${row.invocationId}`);
  }
  assertRunActionExecutions({ [row.invocationId]: value }, run);
  const action = value as unknown as RunActionExecutionRecord;
  const expectedForProtocol =
    row.protocol === "koni.run-action-archive.v1"
      ? deriveLegacyRunActionExecutionArchive(
          run,
          action,
          row.archivedAt,
          bytes,
          row.terminalAuthority !== undefined,
        )
      : deriveRunActionExecutionArchive(run, action).row;
  if (canonicalHash(expectedForProtocol) !== canonicalHash(row)) {
    throw new Error(`run action archive row differs from action projection: ${row.invocationId}`);
  }
  return structuredClone(action);
}

/**
 * Explicit read-only compatibility for pre-v2 rows. The historical timestamp was caller wall
 * time, so it remains audit-only; every authority-bearing field is still derived from the exact
 * hash-bound action artifact. No new mutation may emit this protocol.
 */
function deriveLegacyRunActionExecutionArchive(
  run: Readonly<RunRecord>,
  action: Readonly<RunActionExecutionRecord>,
  archivedAt: string,
  bytes: Buffer,
  retainTerminalAuthority = false,
): RunActionExecutionArchiveRecord {
  const terminalFailureProof = createTerminalFailureSettlementProof(run, action);
  const terminalAuthority = retainTerminalAuthority
    ? deriveRunActionTerminalArchiveAuthority(run, action)
    : undefined;
  return {
    protocol: "koni.run-action-archive.v1",
    invocationId: action.invocationId,
    kind: action.boundary.kind,
    actionId: action.plan.actionId,
    planSha256: action.plan.sha256,
    journalStatus: action.journal.status,
    ...(action.settlement === undefined ? {} : { settlementSha256: action.settlement.sha256 }),
    ...(action.settlement === undefined
      ? {}
      : {
          settlementDisposition: action.settlement.disposition,
        }),
    ...(terminalFailureProof === undefined ? {} : { terminalFailureProof }),
    ...(terminalAuthority === undefined ? {} : { terminalAuthority }),
    artifactPath: `runs/${run.id}/actions/archive/${action.invocationId}.json`,
    artifactSha256: rawSha256(bytes),
    artifactSizeBytes: bytes.byteLength,
    archivedAt,
  };
}

/** Validate one segment against its exact serialized canonical prefix. */
export function validateRunActionArchiveSegmentArtifact(
  runId: string,
  segment: Readonly<RunActionExecutionArchiveSegment>,
  bytes: Buffer,
): RunActionExecutionArchiveRecord[] {
  if (
    bytes.byteLength !== segment.artifactSizeBytes ||
    rawSha256(bytes) !== segment.artifactSha256
  ) {
    throw new Error("run action archive segment artifact digest differs from index");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("run action archive segment artifact is not JSON");
  }
  if (!Array.isArray(value) || !bytes.equals(encodeRunActionArchiveArtifact(value))) {
    throw new Error("run action archive segment is not a canonical row prefix");
  }
  assertRunActionArchive(value, undefined);
  const rows = value as unknown as RunActionExecutionArchiveRecord[];
  const expected = deriveRunActionExecutionArchiveSegment(runId, rows).segment;
  const expectedForProtocol =
    segment.protocol === "koni.run-action-archive-segment.v1"
      ? { ...expected, protocol: segment.protocol, archivedAt: segment.archivedAt }
      : expected;
  const comparableSegment =
    segment.protocol === "koni.run-action-archive-segment.v1"
      ? (() => {
          const { terminalAuthorities: _projectedAfterAuthentication, ...legacy } = segment;
          return legacy;
        })()
      : segment;
  const comparableExpected =
    segment.protocol === "koni.run-action-archive-segment.v1"
      ? (() => {
          const { terminalAuthorities: _notPresentInHistoricalRows, ...legacy } =
            expectedForProtocol;
          return legacy;
        })()
      : expectedForProtocol;
  if (canonicalHash(comparableExpected) !== canonicalHash(comparableSegment)) {
    throw new Error("run action archive segment differs from its exact prefix projection");
  }
  return structuredClone(rows);
}

/**
 * Compatibility projection for genuine v1 archives written before terminal-attempt links were
 * retained in run.json. Callers must first authenticate every supplied row and complete action
 * artifact. The resulting record is strict and can be persisted by a guarded journal migration;
 * v1 artifacts themselves remain immutable and read-only.
 */
export function hydrateLegacyRunActionTerminalArchiveAuthorities(
  run: Readonly<RunRecord>,
  archivedActions: ReadonlyMap<string, Readonly<RunActionExecutionRecord>>,
  segmentRows: ReadonlyMap<string, readonly RunActionExecutionArchiveRecord[]>,
): RunRecord {
  const projected = structuredClone(run);
  for (const row of projected.actionExecutionArchive ?? []) {
    if (row.protocol !== "koni.run-action-archive.v1" || row.terminalAuthority !== undefined)
      continue;
    const action = archivedActions.get(row.invocationId);
    const authority =
      action === undefined ? undefined : deriveRunActionTerminalArchiveAuthority(projected, action);
    if (authority !== undefined) row.terminalAuthority = authority;
  }
  for (const segment of projected.actionExecutionArchiveSegments ?? []) {
    if (
      segment.protocol !== "koni.run-action-archive-segment.v1" ||
      segment.terminalAuthorities !== undefined
    )
      continue;
    const rows = segmentRows.get(segment.artifactPath);
    if (rows === undefined)
      throw new Error("legacy action archive segment lacks authenticated rows");
    const authorities = rows.flatMap((row) => {
      const action = archivedActions.get(row.invocationId);
      const authority =
        action === undefined
          ? undefined
          : deriveRunActionTerminalArchiveAuthority(projected, action);
      return authority === undefined ? [] : [authority];
    });
    if (authorities.length !== 0) segment.terminalAuthorities = authorities;
  }
  return projected;
}

/**
 * Once archive artifacts have been loaded, require every non-evictable proof to resolve to the
 * exact live or archived settlement and prevent an invocation identity from appearing twice.
 */
export function validateRunActionArchiveSemanticAuthority(
  run: Readonly<RunRecord>,
  archivedActions: ReadonlyMap<string, Readonly<RunActionExecutionRecord>>,
): void {
  const liveIds = new Set(Object.keys(run.actionExecutions ?? {}));
  for (const invocationId of archivedActions.keys()) {
    if (liveIds.has(invocationId)) {
      throw new Error(`run action identity is both live and archived: ${invocationId}`);
    }
  }
  for (const proof of Object.values(run.terminalFailureProofs ?? {})) {
    const action =
      run.actionExecutions?.[proof.actionInvocationId] ??
      archivedActions.get(proof.actionInvocationId);
    const exact =
      action === undefined ? undefined : createTerminalFailureSettlementProof(run, action);
    if (exact === undefined || canonicalHash(exact) !== canonicalHash(proof)) {
      throw new Error(
        `terminal failure proof differs from live/archive action authority: ${proof.sha256}`,
      );
    }
  }
  for (const proof of Object.values(run.terminalSuccessProofs ?? {})) {
    const action =
      run.actionExecutions?.[proof.actionInvocationId] ??
      archivedActions.get(proof.actionInvocationId);
    const exact =
      action === undefined ? undefined : createTerminalSuccessSettlementProof(run, action);
    if (exact === undefined || canonicalHash(exact) !== canonicalHash(proof)) {
      throw new Error(
        `terminal success proof differs from live/archive action authority: ${proof.sha256}`,
      );
    }
  }
  const projections = terminalArchiveAuthorities(run);
  const projectionsByInvocation = new Map(
    projections.map((projection) => [projection.invocationId, projection] as const),
  );
  for (const projection of projections) {
    const action = archivedActions.get(projection.invocationId);
    const exact =
      action === undefined ? undefined : deriveRunActionTerminalArchiveAuthority(run, action);
    if (exact === undefined || canonicalHash(exact) !== canonicalHash(projection)) {
      throw new Error(
        `terminal archive projection differs from action authority: ${projection.invocationId}`,
      );
    }
  }
  for (const [invocationId, action] of archivedActions) {
    const exact = deriveRunActionTerminalArchiveAuthority(run, action);
    if (exact === undefined) continue;
    const projected = projectionsByInvocation.get(invocationId);
    if (projected === undefined || canonicalHash(projected) !== canonicalHash(exact)) {
      throw new Error(
        `archived terminal action lacks one exact non-evictable projection: ${invocationId}`,
      );
    }
  }
}

function assertRunActionSettlement(
  value: unknown,
  action: Readonly<RunActionExecutionRecord>,
): asserts value is RunActionSettlementRecord {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.run-action-settlement.v1" ||
    value.invocationId !== action.invocationId ||
    value.planSha256 !== action.plan.sha256 ||
    value.journalSha256 !== action.journal.sha256 ||
    value.semanticResultSha256 !==
      (action.semanticResult === undefined ? null : canonicalHash(action.semanticResult)) ||
    !["completed", "failed", "abandoned"].includes(String(value.disposition)) ||
    typeof value.reason !== "string" ||
    value.reason.trim().length === 0 ||
    Buffer.byteLength(value.reason, "utf8") > 64 * 1024 ||
    typeof value.settledAt !== "string" ||
    value.settledAt.length === 0 ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid run action settlement: ${action.invocationId}`);
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256) {
    throw new Error(`invalid run action settlement hash: ${action.invocationId}`);
  }
  if (value.disposition === "completed" && action.journal.status !== "completed") {
    throw new Error(`completed action settlement has noncompleted journal: ${action.invocationId}`);
  }
  if (action.boundary.kind === "assignment_validation") {
    if (
      value.disposition === "completed" &&
      (action.semanticResult?.kind !== "assignment" || action.semanticResult.status !== "completed")
    ) {
      throw new Error(
        `completed assignment settlement has no completed semantic result: ${action.invocationId}`,
      );
    }
    if (
      value.disposition === "failed" &&
      (action.semanticResult?.kind !== "assignment" || action.semanticResult.status !== "failed")
    ) {
      throw new Error(
        `failed assignment settlement has no failed semantic result: ${action.invocationId}`,
      );
    }
  }
}

function assertTerminalFailureSettlementProof(
  value: unknown,
): asserts value is TerminalFailureSettlementProof {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.terminal-failure-settlement.v1" ||
    !isId(value.runId) ||
    !isId(value.ticketId) ||
    !isId(value.stepId) ||
    !isId(value.attemptId) ||
    !isId(value.actionInvocationId) ||
    !isSha256Digest(value.actionPlanSha256) ||
    !isSha256Digest(value.actionSettlementSha256) ||
    !isRecord(value.semanticResult) ||
    value.semanticResult.kind !== "assignment" ||
    value.semanticResult.status !== "failed" ||
    typeof value.semanticResult.blocker !== "string" ||
    value.semanticResult.blocker.length === 0 ||
    canonicalHash(value.semanticResult) !== value.semanticResultSha256 ||
    !isSha256Digest(value.semanticResultSha256) ||
    !isSha256Digest(value.terminalPolicySha256) ||
    !isSha256Digest(value.terminalOutputSha256) ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error("invalid terminal failure settlement proof");
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256)
    throw new Error("invalid terminal failure settlement proof hash");
}

function assertTerminalFailureProofIndex(value: unknown, run: Readonly<RunRecord>): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length > 100_000) {
    throw new Error("run terminal failure proof index is invalid");
  }
  for (const [sha256, proof] of Object.entries(value)) {
    assertTerminalFailureSettlementProof(proof);
    if (sha256 !== proof.sha256) throw new Error("run terminal failure proof key is invalid");
    const ticket = run.tickets[proof.ticketId];
    const attempt = run.attempts[proof.attemptId];
    if (
      proof.runId !== run.id ||
      ticket === undefined ||
      !ticket.steps.some(
        (step) => step.id === proof.stepId && step.attemptIds.includes(proof.attemptId),
      ) ||
      attempt?.ticketId !== proof.ticketId ||
      attempt.stepId !== proof.stepId ||
      attempt.terminalPolicy?.sha256 !== proof.terminalPolicySha256 ||
      attempt.terminalOutputSha256 !== proof.terminalOutputSha256
    ) {
      throw new Error("run terminal failure proof differs from durable attempt");
    }
    const live = run.actionExecutions?.[proof.actionInvocationId];
    if (live !== undefined) {
      const exact = createTerminalFailureSettlementProof(run, live);
      if (exact === undefined || canonicalHash(exact) !== canonicalHash(proof)) {
        throw new Error("run terminal failure proof differs from live action settlement");
      }
    }
  }
}

function assertTerminalSuccessProofIndex(value: unknown, run: Readonly<RunRecord>): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length > 100_000) {
    throw new Error("run terminal success proof index is invalid");
  }
  for (const [sha256, proof] of Object.entries(value)) {
    assertTerminalSuccessSettlementProof(proof);
    if (sha256 !== proof.sha256) throw new Error("run terminal success proof key is invalid");
    const ticket = run.tickets[proof.ticketId];
    const attempt = run.attempts[proof.attemptId];
    if (
      proof.runId !== run.id ||
      ticket === undefined ||
      !ticket.steps.some(
        (step) => step.id === proof.stepId && step.attemptIds.includes(proof.attemptId),
      ) ||
      attempt?.ticketId !== proof.ticketId ||
      attempt.stepId !== proof.stepId ||
      attempt.terminalPolicy?.sha256 !== proof.terminalPolicySha256 ||
      attempt.terminalOutputSha256 !== proof.terminalOutputSha256
    ) {
      throw new Error("run terminal success proof differs from durable attempt");
    }
    const live = run.actionExecutions?.[proof.actionInvocationId];
    if (live !== undefined) {
      const exact = createTerminalSuccessSettlementProof(run, live);
      if (exact === undefined || canonicalHash(exact) !== canonicalHash(proof)) {
        throw new Error("run terminal success proof differs from live action settlement");
      }
    }
  }
}

function assertTerminalSuccessSettlementProof(
  value: unknown,
): asserts value is TerminalSuccessSettlementProof {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.terminal-success-settlement.v1" ||
    !isId(value.runId) ||
    !isId(value.ticketId) ||
    !isId(value.stepId) ||
    !isId(value.attemptId) ||
    !isId(value.actionInvocationId) ||
    !isSha256Digest(value.actionPlanSha256) ||
    !isSha256Digest(value.actionSettlementSha256) ||
    !isRecord(value.semanticResult) ||
    value.semanticResult.kind !== "assignment" ||
    value.semanticResult.status !== "completed" ||
    typeof value.semanticResult.summary !== "string" ||
    value.semanticResult.summary.length === 0 ||
    canonicalHash(value.semanticResult) !== value.semanticResultSha256 ||
    !isSha256Digest(value.semanticResultSha256) ||
    !isSha256Digest(value.terminalPolicySha256) ||
    !isSha256Digest(value.terminalOutputSha256) ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error("invalid terminal success settlement proof");
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256)
    throw new Error("invalid terminal success settlement proof hash");
}

function assertRunActionBoundary(
  value: Record<string, unknown>,
  run: Readonly<RunRecord>,
  invocationId: string,
): void {
  const { sha256, ...material } = value;
  if (
    value.protocol !== "koni.run-action-boundary.v1" ||
    ![
      "approved_plan_compile",
      "assignment_validation",
      "configured_stage",
      "lead_launch",
      "post_orchestration_report",
      "recovery",
    ].includes(String(value.kind)) ||
    !isId(value.boundaryId) ||
    value.runId !== run.id ||
    value.compiledConfigHash !== run.compiledConfigHash ||
    value.behaviorSha256 !== run.behavior?.sha256 ||
    !isNonnegativeSafeInteger(value.generation) ||
    !isNonnegativeSafeInteger(value.admittedRunRevision) ||
    !isId(value.stageId) ||
    (value.ticketId !== undefined && !isId(value.ticketId)) ||
    (value.stepId !== undefined && !isId(value.stepId)) ||
    (value.attemptId !== undefined && !isId(value.attemptId)) ||
    (value.cycleId !== undefined && !isId(value.cycleId)) ||
    (value.productSha256 !== undefined && !isSha256Digest(value.productSha256)) ||
    (value.parentInvocationId !== undefined && !isId(value.parentInvocationId)) ||
    !isSha256Digest(sha256) ||
    canonicalHash(material) !== sha256 ||
    invocationId.length === 0
  ) {
    throw new Error(`invalid run action boundary: ${invocationId}`);
  }
}

function assertRunActionEffectReceipt(
  effectKey: string,
  value: unknown,
  plan: Readonly<ActionExecutionPlan>,
): void {
  if (!isRecord(value)) throw new Error(`invalid run action effect receipt: ${effectKey}`);
  const { sha256, ...material } = value;
  const phase =
    value.phase === "recipe" || value.phase === "compensation" ? value.phase : undefined;
  const configured =
    phase === undefined
      ? undefined
      : (phase === "recipe" ? plan.recipe : plan.compensation).find(
          (step) => step.id === value.stepId,
        );
  const expectedEffectKey =
    configured === undefined || phase === undefined
      ? undefined
      : `${plan.invocationId}:${phase}:${configured.id}:${plan.sha256}`;
  if (
    value.protocol !== "koni.run-action-effect-receipt.v1" ||
    value.effectKey !== effectKey ||
    value.planSha256 !== plan.sha256 ||
    value.actionId !== plan.actionId ||
    phase === undefined ||
    configured === undefined ||
    expectedEffectKey !== effectKey ||
    configured.primitive !== value.primitive ||
    canonicalHash(configured.arguments) !== value.argumentsSha256 ||
    canonicalHash(plan.context) !== value.contextSha256 ||
    !isId(value.stepId) ||
    typeof value.primitive !== "string" ||
    value.primitive.length === 0 ||
    !isSha256Digest(value.argumentsSha256) ||
    !isSha256Digest(value.contextSha256) ||
    !isSha256Digest(value.outputSha256) ||
    canonicalHash(value.output) !== value.outputSha256 ||
    typeof value.recordedAt !== "string" ||
    value.recordedAt.length === 0 ||
    !isSha256Digest(sha256) ||
    canonicalHash(material) !== sha256
  ) {
    throw new Error(`invalid run action effect receipt: ${effectKey}`);
  }
}

function assertRunActionSemanticResult(value: unknown): void {
  if (!isRecord(value)) throw new Error("invalid run action semantic result");
  if (value.kind === "approved_plan") {
    if (
      !isNonnegativeSafeInteger(value.ticketCount) ||
      !isSha256Digest(value.graphHash) ||
      !isNonnegativeSafeInteger(value.graphRevision)
    )
      throw new Error("invalid approved-plan action result");
  } else if (value.kind === "assignment") {
    if (
      (value.status !== "completed" && value.status !== "failed") ||
      (value.summary !== undefined && typeof value.summary !== "string") ||
      (value.blocker !== undefined && typeof value.blocker !== "string") ||
      (value.changeControlSha256 !== undefined && !isSha256Digest(value.changeControlSha256)) ||
      (value.recurringAssetGrantRefreshSha256s !== undefined &&
        (!Array.isArray(value.recurringAssetGrantRefreshSha256s) ||
          value.recurringAssetGrantRefreshSha256s.length === 0 ||
          value.recurringAssetGrantRefreshSha256s.length > 64 ||
          value.recurringAssetGrantRefreshSha256s.some((digest) => !isSha256Digest(digest)))) ||
      (value.status === "completed" &&
        (typeof value.summary !== "string" || value.summary.length === 0)) ||
      (value.status === "failed" &&
        (typeof value.blocker !== "string" || value.blocker.length === 0))
    ) {
      throw new Error("invalid assignment action result");
    }
  } else if (value.kind === "report") {
    if (!isId(value.reportId) || !isSha256Digest(value.bundleHash)) {
      throw new Error("invalid report action result");
    }
  } else {
    throw new Error("invalid run action semantic result kind");
  }
}

function assertRunBehaviorSnapshot(
  value: unknown,
  runTypeId: string,
  git: unknown,
): asserts value is RunBehaviorSnapshot {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.run-behavior.v1" ||
    !isSha256Digest(value.compiledBehaviorSha256) ||
    !isRecord(value.profile) ||
    !isRecord(value.runType) ||
    value.runType.id !== runTypeId ||
    !isSha256Digest(value.runType.sha256) ||
    !isRecord(value.runType.git) ||
    value.runType.git.policySha256 !== value.gitPolicySha256 ||
    !isRecord(value.actions) ||
    value.actions.protocol !== "koni.action-catalog.v1" ||
    !isSha256Digest(value.actions.sha256) ||
    !isSha256Digest(value.gitPolicySha256) ||
    !isSha256Digest(value.sha256)
  )
    throw new Error("run behavior snapshot is invalid");
  const { sha256: runTypeSha256, ...runTypeMaterial } = value.runType;
  if (canonicalHash(runTypeMaterial) !== runTypeSha256) {
    throw new Error("run behavior snapshot run-type hash is invalid");
  }
  const { sha256: actionCatalogSha256, ...actionCatalogMaterial } = value.actions;
  if (canonicalHash(actionCatalogMaterial) !== actionCatalogSha256) {
    throw new Error("run behavior snapshot action-catalog hash is invalid");
  }
  const { sha256: _sha256, ...material } = value;
  if (canonicalHash(material) !== value.sha256)
    throw new Error("run behavior snapshot hash is invalid");
  if (isRecord(git) && isRecord(git.policy) && git.policy.policySha256 !== value.gitPolicySha256) {
    throw new Error("run behavior snapshot Git policy differs from the pinned lifecycle policy");
  }
}

function recursivelyFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) recursivelyFreeze(child);
  return Object.freeze(value);
}

function isOptionalCompensationEvidence(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    typeof value.originalIntentId === "string" &&
    value.originalIntentId.length > 0 &&
    typeof value.priorOid === "string" &&
    /^[0-9a-f]{40,64}$/u.test(value.priorOid) &&
    typeof value.candidateOid === "string" &&
    /^[0-9a-f]{40,64}$/u.test(value.candidateOid) &&
    (value.compensationOid === undefined ||
      (typeof value.compensationOid === "string" &&
        /^[0-9a-f]{40,64}$/u.test(value.compensationOid)))
  );
}

function assertRunReport(value: unknown): asserts value is RunReportRecord {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.report-bundle.v1" ||
    !isId(value.reportId) ||
    typeof value.bundleKind !== "string" ||
    value.bundleKind.length === 0 ||
    !isSha256Digest(value.bundleHash) ||
    !isSha256Digest(value.graphHash) ||
    !isSha256Digest(value.ticketBoardHash) ||
    !isSha256Digest(value.runStateHash) ||
    typeof value.manifestArtifactPath !== "string" ||
    value.manifestArtifactPath.length === 0 ||
    typeof value.compiledAt !== "string" ||
    value.compiledAt.length === 0 ||
    !Array.isArray(value.outputs) ||
    value.outputs.some(
      (output) =>
        !isRecord(output) ||
        typeof output.ledgerId !== "string" ||
        output.ledgerId.length === 0 ||
        !["json", "markdown", "yaml", "csv"].includes(String(output.format)) ||
        typeof output.artifactPath !== "string" ||
        output.artifactPath.length === 0 ||
        !isSha256Digest(output.sha256) ||
        !isNonnegativeSafeInteger(output.sizeBytes),
    )
  )
    throw new Error("invalid run report record");
}

function assertRunPostOrchestration(
  value: unknown,
  run: Readonly<RunRecord>,
): asserts value is RunPostOrchestrationRecord {
  if (!isRecord(value) || value.protocol !== "koni.post-orchestration.v1") {
    throw new Error("invalid run post-orchestration protocol");
  }
  if (run.behavior === undefined) {
    throw new Error("run post-orchestration evidence requires pinned behavior");
  }
  const synchronization = optionalPostBinding(value.synchronization, "synchronization");
  const checkpoint = optionalPostBinding(value.checkpoint, "checkpoint");
  const review = optionalPostBinding(value.review, "review");
  const report = optionalPostBinding(value.report, "report");
  if (
    checkpoint !== undefined &&
    (synchronization === undefined ||
      !samePostProduct(synchronization, checkpoint) ||
      !isSha256Digest(checkpoint.verificationSha256))
  )
    throw new Error("invalid run post-orchestration checkpoint binding");
  if (
    review !== undefined &&
    (checkpoint === undefined || !samePostProduct(checkpoint, review) || !isId(review.attemptId))
  )
    throw new Error("invalid run post-orchestration review binding");
  if (
    report !== undefined &&
    (checkpoint === undefined ||
      !samePostProduct(checkpoint, report) ||
      !isId(report.actionId) ||
      !isSha256Digest(report.actionSha256) ||
      !isId(report.reportId) ||
      !isSha256Digest(report.bundleHash))
  )
    throw new Error("invalid run post-orchestration report binding");

  const pipeline = run.behavior.runType.pipeline;
  const stages = new Map(pipeline.map((stage) => [stage.id, stage]));
  for (const [binding, kind] of [
    [synchronization, "target_sync"],
    [checkpoint, "checkpoint"],
    [review, "agent_review"],
  ] as const) {
    if (
      binding !== undefined &&
      (!run.pipelineStageIds.includes(binding.stageId) ||
        stages.get(binding.stageId)?.kind !== kind)
    )
      throw new Error(`invalid run post-orchestration ${kind} stage`);
  }
  if (
    report !== undefined &&
    (!run.pipelineStageIds.includes(report.stageId) ||
      stages.get(report.stageId)?.kind !== "action")
  )
    throw new Error("invalid run post-orchestration report stage");
  const configuredReview = pipeline.find((stage) => stage.kind === "agent_review");
  if (
    (review !== undefined && configuredReview?.id !== review.stageId) ||
    (report !== undefined && configuredReview !== undefined && review === undefined)
  )
    throw new Error("run post-orchestration review evidence differs from pinned behavior");
  if (review !== undefined) {
    const attemptId = typeof review.attemptId === "string" ? review.attemptId : undefined;
    const attempt = attemptId === undefined ? undefined : run.attempts[attemptId];
    if (
      attempt === undefined ||
      attempt.kind !== "verification" ||
      attempt.status !== "completed" ||
      attempt.verificationAccepted !== true ||
      attempt.reviewedRunOid !== review.runOid ||
      attempt.reviewedTargetOid !== review.targetOid ||
      attempt.reviewedGraphHash !== review.graphHash
    )
      throw new Error("run post-orchestration review attempt is not bound to its product");
  }
  if (report !== undefined) {
    const reportStage = stages.get(report.stageId);
    const configuredAction =
      reportStage?.config.kind === "action"
        ? (run.behavior.actions.aliases[reportStage.config.action] ?? reportStage.config.action)
        : undefined;
    const selectedAction =
      run.behavior.actions.aliases[run.behavior.runType.actionSelectors.report] ??
      run.behavior.runType.actionSelectors.report;
    const action =
      configuredAction === undefined ? undefined : run.behavior.actions.actions[configuredAction];
    if (
      reportStage?.config.kind !== "action" ||
      !reportStage.config.automatic ||
      configuredAction !== selectedAction ||
      action === undefined ||
      action.actor !== "compiler" ||
      action.id !== report.actionId ||
      action.sha256 !== report.actionSha256
    )
      throw new Error("run post-orchestration report action differs from pinned behavior");
    if (
      !run.reports?.some(
        (candidate) =>
          candidate.reportId === report.reportId && candidate.bundleHash === report.bundleHash,
      )
    )
      throw new Error("run post-orchestration report publication is missing");
  }
}

function optionalPostBinding(
  value: unknown,
  label: string,
): (RunPostOrchestrationBinding & Record<string, unknown>) | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !isId(value.stageId) ||
    typeof value.runOid !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(value.runOid) ||
    typeof value.targetOid !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(value.targetOid) ||
    !isSha256Digest(value.graphHash) ||
    typeof value.recordedAt !== "string" ||
    value.recordedAt.length === 0
  )
    throw new Error(`invalid run post-orchestration ${label} product binding`);
  return value as RunPostOrchestrationBinding & Record<string, unknown>;
}

function samePostProduct(
  left: Readonly<RunPostOrchestrationBinding>,
  right: Readonly<RunPostOrchestrationBinding>,
): boolean {
  return (
    left.runOid === right.runOid &&
    left.targetOid === right.targetOid &&
    left.graphHash === right.graphHash
  );
}

function assertPendingCheck(id: string, value: unknown): asserts value is PendingCheckIntentRecord {
  if (
    !isId(id) ||
    !isRecord(value) ||
    value.id !== id ||
    !isId(value.attemptId) ||
    !isSha256Digest(value.specHash) ||
    !isSha256Digest(value.grantHash) ||
    typeof value.callId !== "string" ||
    value.callId.length === 0 ||
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    typeof value.idempotencyKey !== "string" ||
    value.idempotencyKey.length === 0 ||
    !isSha256Digest(value.requestHash) ||
    !isSha256Digest(value.argumentsSha256) ||
    !isNonnegativeSafeInteger(value.argumentsSizeBytes) ||
    value.argumentsSizeBytes === 0 ||
    typeof value.requestedCheckId !== "string" ||
    value.requestedCheckId.length === 0 ||
    !isSha256Digest(value.resolvedCheckSha256) ||
    value.resolvedCheck === undefined ||
    (value.attempts !== undefined && !Array.isArray(value.attempts)) ||
    typeof value.preparedAt !== "string"
  )
    throw new Error(`invalid pending check: ${id}`);
  if (value.attempts !== undefined) {
    if (value.attempts.length > 768)
      throw new Error(`pending check attempt audit is oversized: ${id}`);
    for (const attempt of value.attempts) assertRunCheckAttempt(attempt);
    assertCheckAttemptSequence(value.attempts, `pending check ${id}`);
  }
}

function assertRunCheck(value: unknown): asserts value is RunCheckRecord {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isId(value.attemptId) ||
    typeof value.callId !== "string" ||
    value.callId.length === 0 ||
    typeof value.requestedCheckId !== "string" ||
    value.requestedCheckId.length === 0 ||
    !isSha256Digest(value.definitionHash) ||
    !["command", "graph", "composite"].includes(String(value.kind)) ||
    typeof value.accepted !== "boolean" ||
    (value.infrastructureFailure !== undefined &&
      (!isBoundedRecordText(value.infrastructureFailure, 64 * 1024) || value.accepted)) ||
    (value.passed !== undefined && typeof value.passed !== "boolean") ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.commands) ||
    !isSha256Digest(value.evidenceSha256) ||
    !isNonnegativeSafeInteger(value.evidenceSizeBytes) ||
    typeof value.evidenceArtifactPath !== "string" ||
    value.evidenceArtifactPath.length === 0 ||
    typeof value.recordedAt !== "string"
  )
    throw new Error("invalid run check record");
  if (value.executionPolicy !== undefined) {
    assertCheckExecutionPolicyBinding(value.executionPolicy);
    if (
      value.executionPolicy.checkId !== value.requestedCheckId ||
      value.executionPolicy.checkSha256 !== value.definitionHash ||
      value.passed === undefined
    ) {
      throw new Error("run check top-level policy differs from its receipt");
    }
  }
  for (const command of value.commands) {
    if (
      !isRecord(command) ||
      typeof command.checkId !== "string" ||
      command.checkId.length === 0 ||
      !isSha256Digest(command.definitionHash) ||
      typeof command.startedAt !== "string" ||
      typeof command.completedAt !== "string" ||
      typeof command.resolvedExecutable !== "string" ||
      command.resolvedExecutable.length === 0 ||
      !isStringArray(command.argv) ||
      command.argv.length === 0 ||
      !isSha256Digest(command.environmentSha256) ||
      !(command.exitCode === null || Number.isSafeInteger(command.exitCode)) ||
      !(command.signal === null || typeof command.signal === "string") ||
      !isSha256Digest(command.stdoutSha256) ||
      !isNonnegativeSafeInteger(command.stdoutSizeBytes) ||
      typeof command.stdoutArtifactPath !== "string" ||
      command.stdoutArtifactPath.length === 0 ||
      !isSha256Digest(command.stderrSha256) ||
      !isNonnegativeSafeInteger(command.stderrSizeBytes) ||
      typeof command.stderrArtifactPath !== "string" ||
      command.stderrArtifactPath.length === 0 ||
      !isSha256Digest(command.preManifestSha256) ||
      !isSha256Digest(command.postManifestSha256) ||
      typeof command.sandboxKind !== "string" ||
      command.sandboxKind.length === 0 ||
      !isSha256Digest(command.sandboxProfileSha256) ||
      (command.sandboxExecutableSha256 !== undefined &&
        !isSha256Digest(command.sandboxExecutableSha256)) ||
      !isRecord(command.resultSource) ||
      (command.resultSource.kind !== "stdout" && command.resultSource.kind !== "file") ||
      (command.resultSource.kind === "file" &&
        (typeof command.resultSource.path !== "string" ||
          command.resultSource.path.length === 0)) ||
      !isSha256Digest(command.resultSource.bytesSha256) ||
      !isNonnegativeSafeInteger(command.resultSource.sizeBytes) ||
      !Array.isArray(command.outputFiles) ||
      command.outputFiles.some(
        (file) =>
          !isRecord(file) ||
          typeof file.path !== "string" ||
          file.path.length === 0 ||
          !isSha256Digest(file.sha256) ||
          !isNonnegativeSafeInteger(file.sizeBytes),
      )
    )
      throw new Error("invalid run check command record");
    if (command.executionPolicy !== undefined) {
      assertCheckExecutionPolicyBinding(command.executionPolicy);
    }
    if (command.attempts !== undefined) {
      if (
        !Array.isArray(command.attempts) ||
        command.attempts.length === 0 ||
        command.attempts.length > 3
      ) {
        throw new Error("invalid run check command attempt audit");
      }
      for (const attempt of command.attempts) assertRunCheckAttempt(attempt);
      assertCheckAttemptSequence(command.attempts, "run check command");
      const final = command.attempts.at(-1) as unknown as RunCheckAttemptRecord;
      if (
        final.status !== "completed" ||
        final.checkId !== command.checkId ||
        final.definitionHash !== command.definitionHash ||
        final.stdoutSha256 !== command.stdoutSha256 ||
        final.stderrSha256 !== command.stderrSha256 ||
        final.retryDecision?.disposition === "retry"
      ) {
        throw new Error("run check command differs from its final audited attempt");
      }
      if (
        command.executionPolicy === undefined ||
        command.attempts.some(
          (attempt) =>
            canonicalHash((attempt as unknown as RunCheckAttemptRecord).executionPolicy) !==
            canonicalHash(command.executionPolicy),
        )
      ) {
        throw new Error("run check attempt policy differs from its command receipt");
      }
    }
    if (command.sourceManifest !== undefined) assertRunCheckSourceManifest(command.sourceManifest);
    if (
      value.executionPolicy !== undefined &&
      (command.executionPolicy === undefined ||
        command.attempts === undefined ||
        command.executionPolicy.configurationSha256 !== value.executionPolicy.configurationSha256 ||
        command.executionPolicy.catalogSha256 !== value.executionPolicy.catalogSha256 ||
        command.executionPolicy.bindingSha256 !== value.executionPolicy.bindingSha256)
    ) {
      throw new Error("behavior-backed run check command lacks its exact durable execution audit");
    }
  }
}

const LEGACY_CONFIGURED_CHECK_INFRASTRUCTURE_MARKER =
  "command infrastructure failed before producing an admissible expected result:";

/**
 * Return only compiler-authored configured-check infrastructure evidence for one immutable
 * attempt. New records carry the typed field. The exact legacy marker was emitted by the compiler
 * from the same typed command classification before that field became durable.
 */
export function configuredCheckInfrastructureFailureForAttempt(
  run: Readonly<Pick<RunRecord, "checks">>,
  attemptId: string,
): string | undefined {
  return [...(run.checks ?? [])]
    .reverse()
    .filter((check) => check.attemptId === attemptId && !check.accepted)
    .map((check) => {
      if (check.infrastructureFailure !== undefined) return check.infrastructureFailure;
      return check.summary.includes(LEGACY_CONFIGURED_CHECK_INFRASTRUCTURE_MARKER)
        ? check.summary
        : undefined;
    })
    .find((failure): failure is string => failure !== undefined);
}

function assertRunCheckAttempt(value: unknown): asserts value is RunCheckAttemptRecord {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.run-check-attempt.v1" ||
    !Number.isSafeInteger(value.commandIndex) ||
    Number(value.commandIndex) < 0 ||
    !Number.isSafeInteger(value.attemptNumber) ||
    Number(value.attemptNumber) < 1 ||
    Number(value.attemptNumber) > 3 ||
    typeof value.checkId !== "string" ||
    value.checkId.length === 0 ||
    !isSha256Digest(value.definitionHash) ||
    !isRecord(value.executionPolicy) ||
    (value.status !== "prepared" && value.status !== "completed") ||
    typeof value.startedAt !== "string" ||
    !isSha256Digest(value.preManifestSha256) ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error("invalid run check attempt record");
  }
  assertCheckExecutionPolicyBinding(value.executionPolicy);
  const attemptNumber = Number(value.attemptNumber);
  if (
    attemptNumber > value.executionPolicy.retryPolicy.maxAttempts ||
    value.executionPolicy.retryPolicy.maxAttempts > 3
  ) {
    throw new Error("run check attempt exceeds its bound retry policy");
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256) throw new Error("run check attempt hash is invalid");
  if (value.status === "prepared") {
    if (
      value.completedAt !== undefined ||
      value.postManifestSha256 !== undefined ||
      value.aggregateElapsedSeconds !== undefined ||
      value.exitCode !== undefined ||
      value.signal !== undefined ||
      value.stdoutSha256 !== undefined ||
      value.stdoutSizeBytes !== undefined ||
      value.stdoutArtifactPath !== undefined ||
      value.stderrSha256 !== undefined ||
      value.stderrSizeBytes !== undefined ||
      value.stderrArtifactPath !== undefined ||
      value.retryDecision !== undefined
    ) {
      throw new Error("prepared run check attempt contains terminal evidence");
    }
    return;
  }
  if (
    typeof value.completedAt !== "string" ||
    !isNonnegativeSafeInteger(value.aggregateElapsedSeconds) ||
    !isSha256Digest(value.postManifestSha256) ||
    !(value.exitCode === null || Number.isSafeInteger(value.exitCode)) ||
    !(value.signal === null || typeof value.signal === "string") ||
    !isSha256Digest(value.stdoutSha256) ||
    !isNonnegativeSafeInteger(value.stdoutSizeBytes) ||
    typeof value.stdoutArtifactPath !== "string" ||
    value.stdoutArtifactPath.length === 0 ||
    !isSha256Digest(value.stderrSha256) ||
    !isNonnegativeSafeInteger(value.stderrSizeBytes) ||
    typeof value.stderrArtifactPath !== "string" ||
    value.stderrArtifactPath.length === 0
  ) {
    throw new Error("completed run check attempt is missing terminal evidence");
  }
  if (value.retryDecision !== undefined) {
    if (
      !isRecord(value.retryDecision) ||
      value.retryDecision.protocol !== "koni.check-retry-decision.v1" ||
      !isSha256Digest(value.retryDecision.sha256)
    ) {
      throw new Error("run check retry decision is invalid");
    }
    const { sha256: decisionSha256, ...decisionMaterial } = value.retryDecision;
    if (canonicalHash(decisionMaterial) !== decisionSha256) {
      throw new Error("run check retry decision hash is invalid");
    }
    const exitCode = value.exitCode as number | null;
    if (
      exitCode === null ||
      canonicalHash(
        decideBoundCheckRetry(value.executionPolicy, {
          attemptNumber,
          exitCode,
          aggregateElapsedSeconds: Number(value.aggregateElapsedSeconds),
        }),
      ) !== canonicalHash(value.retryDecision)
    ) {
      throw new Error("run check retry decision differs from its bound policy");
    }
  }
}

function assertCheckAttemptSequence(
  attempts: readonly RunCheckAttemptRecord[],
  label: string,
): void {
  for (const [index, attempt] of attempts.entries()) {
    const prior = attempts[index - 1];
    if (
      prior !== undefined &&
      (attempt.commandIndex < prior.commandIndex ||
        (attempt.commandIndex === prior.commandIndex &&
          attempt.attemptNumber !== prior.attemptNumber + 1) ||
        (attempt.commandIndex > prior.commandIndex && attempt.attemptNumber !== 1))
    )
      throw new Error(`${label} has a noncanonical attempt sequence`);
    if (
      prior !== undefined &&
      attempt.commandIndex === prior.commandIndex &&
      prior.retryDecision?.disposition !== "retry"
    ) {
      throw new Error(`${label} continued after a terminal retry decision`);
    }
    if (index < attempts.length - 1 && attempt.status !== "completed") {
      throw new Error(`${label} contains a nonterminal attempt before its end`);
    }
  }
}

function assertRunCheckSourceManifest(
  value: unknown,
): asserts value is RunCheckSourceManifestRecord {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.run-check-source-manifest.v1" ||
    !isSha256Digest(value.configurationSha256) ||
    !isSha256Digest(value.catalogSha256) ||
    !isSha256Digest(value.bindingSha256) ||
    !isSha256Digest(value.checkSha256) ||
    !isSha256Digest(value.commandBindingSha256) ||
    !isId(value.stepId) ||
    !isStringArray(value.roots) ||
    !Array.isArray(value.entries) ||
    !isSha256Digest(value.manifestSha256) ||
    typeof value.capturedAt !== "string" ||
    !isSha256Digest(value.sha256)
  )
    throw new Error("invalid run check source manifest");
  const roots = value.roots;
  assertUniquePaths(roots, "run check source manifest roots");
  if (roots.some((root, index) => index > 0 && compareUtf8(roots[index - 1]!, root) >= 0)) {
    throw new Error("run check source manifest roots are not canonical");
  }
  let prior: string | undefined;
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      !isProjectRelativePath(entry.path) ||
      !["file", "directory", "missing"].includes(String(entry.kind)) ||
      (entry.mode !== undefined && (!Number.isSafeInteger(entry.mode) || Number(entry.mode) < 0)) ||
      (entry.sizeBytes !== undefined && !isNonnegativeSafeInteger(entry.sizeBytes)) ||
      (entry.sha256 !== undefined && !isSha256Digest(entry.sha256)) ||
      (prior !== undefined && compareUtf8(prior, entry.path) >= 0)
    ) {
      throw new Error("invalid run check source manifest entry");
    }
    prior = entry.path;
  }
  const { sha256, ...material } = value;
  if (
    canonicalHash({
      protocol: "koni.contained-path-manifest.v1",
      roots: value.roots,
      entries: value.entries,
    }) !== value.manifestSha256
  ) {
    throw new Error("run check source byte manifest hash is invalid");
  }
  if (canonicalHash(material) !== sha256)
    throw new Error("run check source manifest hash is invalid");
}

function assertWorkspaceEffect(
  id: string,
  value: unknown,
): asserts value is WorkspaceEffectIntentRecord {
  if (
    !isId(id) ||
    !isRecord(value) ||
    value.id !== id ||
    !isId(value.attemptId) ||
    !isSha256Digest(value.specHash) ||
    !isSha256Digest(value.grantHash) ||
    typeof value.callId !== "string" ||
    value.callId.length === 0 ||
    (value.toolName !== "koni_write_file" && value.toolName !== "koni_edit_file") ||
    typeof value.method !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    !isSha256Digest(value.requestHash) ||
    !isSha256Digest(value.argumentsSha256) ||
    !isNonnegativeSafeInteger(value.argumentsSizeBytes) ||
    value.argumentsSizeBytes === 0 ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    (value.expectedSha256 !== null && !isSha256Digest(value.expectedSha256)) ||
    !isSha256Digest(value.desiredSha256) ||
    !isNonnegativeSafeInteger(value.contentSizeBytes) ||
    typeof value.contentArtifactPath !== "string" ||
    value.contentArtifactPath.length === 0 ||
    typeof value.preparedAt !== "string"
  )
    throw new Error(`invalid pending workspace effect: ${id}`);
}

export function assertTicketGraph(tickets: Readonly<Record<string, TicketRecord>>): void {
  const ids = new Set(Object.keys(tickets));
  for (const ticket of Object.values(tickets)) {
    if (new Set(ticket.dependencyIds).size !== ticket.dependencyIds.length) {
      throw new Error(`ticket has duplicate dependencies: ${ticket.id}`);
    }
    for (const dependency of ticket.dependencyIds) {
      if (!ids.has(dependency)) {
        throw new Error(`ticket ${ticket.id} has unknown dependency ${dependency}`);
      }
      if (dependency === ticket.id) {
        throw new Error(`ticket ${ticket.id} depends on itself`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`ticket dependency cycle includes ${id}`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of tickets[id]!.dependencyIds) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...ids].sort()) {
    visit(id);
  }
}

function assertTicketRecord(id: string, value: unknown): asserts value is TicketRecord {
  if (
    !isId(id) ||
    !isRecord(value) ||
    value.id !== id ||
    typeof value.operationId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.status !== "string" ||
    !Number.isSafeInteger(value.priority) ||
    (value.executionEpoch !== undefined && !isNonnegativeSafeInteger(value.executionEpoch)) ||
    !isStringArray(value.dependencyIds) ||
    !isStringArray(value.targetNodeIds) ||
    (value.readNodeIds !== undefined && !isStringArray(value.readNodeIds)) ||
    (value.writeNodeIds !== undefined && !isStringArray(value.writeNodeIds)) ||
    !isStringArray(value.readPaths) ||
    !isStringArray(value.writePaths) ||
    !Array.isArray(value.steps)
  ) {
    throw new Error(`invalid ticket record: ${id}`);
  }
  if (
    value.integrationCandidateOid !== undefined &&
    (typeof value.integrationCandidateOid !== "string" ||
      !/^[0-9a-f]{40,64}$/u.test(value.integrationCandidateOid))
  ) {
    throw new Error(`invalid ticket integration candidate OID: ${id}`);
  }
  if (
    !["proposed", "queued", "running", "review", "blocked", "completed", "cancelled"].includes(
      value.status,
    )
  )
    throw new Error(`invalid ticket status: ${id}`);
  if (value.executionPolicyBinding !== undefined) {
    if (!isRecord(value.executionPolicyBinding))
      throw new Error(`invalid ticket execution policy: ${id}`);
    assertExecutionPolicyBindingIntegrity(
      value.executionPolicyBinding as unknown as ExecutionPolicyBinding,
    );
  }
  if (value.executionControl !== undefined) {
    assertTicketExecutionControl(id, value.executionControl);
  }
  for (const step of value.steps) {
    if (
      !isRecord(step) ||
      !isId(step.id) ||
      typeof step.title !== "string" ||
      !isId(step.personaId) ||
      (step.kind !== undefined &&
        !["production", "integration", "review", "agent", "manual"].includes(String(step.kind))) ||
      (step.dependsOn !== undefined && !isStringArray(step.dependsOn)) ||
      (step.readNodeIds !== undefined && !isStringArray(step.readNodeIds)) ||
      (step.writeNodeIds !== undefined && !isStringArray(step.writeNodeIds)) ||
      (step.readPaths !== undefined && !isStringArray(step.readPaths)) ||
      (step.writePaths !== undefined && !isStringArray(step.writePaths)) ||
      (step.validationAction !== undefined && !isId(step.validationAction)) ||
      !["pending", "running", "completed", "failed", "skipped"].includes(String(step.status)) ||
      !isStringArray(step.attemptIds)
    )
      throw new Error(`invalid ticket step: ${id}`);
    if (step.executionPolicyBinding !== undefined) {
      if (!isRecord(step.executionPolicyBinding))
        throw new Error(`invalid ticket step execution policy: ${id}/${step.id}`);
      assertExecutionPolicyBindingIntegrity(
        step.executionPolicyBinding as unknown as ExecutionPolicyBinding,
      );
    }
  }
  assertUniqueIds(value.targetNodeIds, `ticket target nodes: ${id}`);
  assertUniqueIds(value.readNodeIds ?? [], `ticket read nodes: ${id}`);
  assertUniqueIds(value.writeNodeIds ?? [], `ticket write nodes: ${id}`);
  assertUniquePaths(value.readPaths, `ticket read paths: ${id}`);
  assertUniquePaths(value.writePaths, `ticket write paths: ${id}`);
  assertTicketStepGraph(id, value.steps);
  if (
    value.status === "completed" &&
    (value.steps as unknown as TicketStepRecord[]).some(
      (step) => step.status !== "completed" && step.status !== "skipped",
    )
  ) {
    throw new Error(`completed ticket has nonterminal steps: ${id}`);
  }
  const standaloneReviewReworks = Array.isArray(value.reviewReworks)
    ? value.reviewReworks
    : undefined;
  const standaloneReviewOnlyHistory =
    value.reviewFailureReopenFrom === undefined &&
    value.reviewReworkLimit === undefined &&
    value.reviewReworkCount === undefined &&
    standaloneReviewReworks !== undefined;
  if (standaloneReviewOnlyHistory) {
    const reviewIds = new Set(
      (value.steps as unknown as TicketStepRecord[])
        .filter((step) => step.kind === "review")
        .map((step) => step.id),
    );
    if (
      reviewIds.size === 0 ||
      standaloneReviewReworks.some(
        (rework, index) =>
          !isRecord(rework) ||
          rework.ordinal !== index + 1 ||
          rework.mode !== "supervised" ||
          rework.scope !== "review_only" ||
          !isId(rework.failedReviewAttemptId) ||
          !isId(rework.reopenFromStepId) ||
          !reviewIds.has(rework.reopenFromStepId) ||
          typeof rework.blocker !== "string" ||
          rework.blocker.length === 0 ||
          (rework.operatorSteering !== undefined &&
            (typeof rework.operatorSteering !== "string" ||
              rework.operatorSteering.trim().length === 0 ||
              Buffer.byteLength(rework.operatorSteering, "utf8") > 64 * 1024)) ||
          typeof rework.openedAt !== "string" ||
          rework.openedAt.length === 0,
      )
    )
      throw new Error(`invalid standalone review-only recovery history: ${id}`);
  } else if (
    value.reviewFailureReopenFrom !== undefined ||
    value.reviewReworkLimit !== undefined ||
    value.reviewReworkCount !== undefined ||
    value.reviewReworks !== undefined
  ) {
    if (
      !isId(value.reviewFailureReopenFrom) ||
      !Number.isSafeInteger(value.reviewReworkLimit) ||
      Number(value.reviewReworkLimit) < 1 ||
      !isNonnegativeSafeInteger(value.reviewReworkCount) ||
      Number(value.reviewReworkCount) > Number(value.reviewReworkLimit) ||
      !Array.isArray(value.reviewReworks) ||
      value.reviewReworks.some(
        (rework, index) =>
          !isRecord(rework) ||
          rework.ordinal !== index + 1 ||
          (rework.mode !== undefined &&
            rework.mode !== "automatic" &&
            rework.mode !== "supervised") ||
          (rework.scope !== undefined &&
            rework.scope !== "producer_and_review" &&
            rework.scope !== "review_only") ||
          (rework.scope === "review_only" && rework.mode !== "supervised") ||
          !isId(rework.failedReviewAttemptId) ||
          rework.reopenFromStepId !== value.reviewFailureReopenFrom ||
          typeof rework.blocker !== "string" ||
          rework.blocker.length === 0 ||
          (rework.operatorSteering !== undefined &&
            (typeof rework.operatorSteering !== "string" ||
              rework.operatorSteering.trim().length === 0 ||
              Buffer.byteLength(rework.operatorSteering, "utf8") > 64 * 1024)) ||
          typeof rework.openedAt !== "string" ||
          rework.openedAt.length === 0,
      ) ||
      !value.steps.some((step) => step.id === value.reviewFailureReopenFrom) ||
      !value.steps.some((step) => step.kind === "review") ||
      value.reviewReworks.filter((rework) => rework.mode !== "supervised").length !==
        Number(value.reviewReworkCount)
    )
      throw new Error(`invalid ticket review-rework state: ${id}`);
  }
}

function assertRecurringAssetGrantRefreshAuthority(
  ticketId: string,
  value: unknown,
): asserts value is RecurringAssetGrantRefreshAuthority {
  if (!isRecord(value)) {
    throw new Error(`invalid recurring-asset grant refresh: ${ticketId}`);
  }
  const allowed = new Set([
    "protocol",
    "runId",
    "ticketId",
    "configurationSha256",
    "actionInvocationId",
    "actionBoundarySha256",
    "priorGraphHash",
    "priorGraphRevision",
    "nextGraphHash",
    "nextGraphRevision",
    "priorProjection",
    "priorProjectionSha256",
    "refreshedProjection",
    "nextProjectionSha256",
    "priorExecutionEpoch",
    "nextExecutionEpoch",
    "recordedAt",
    "sha256",
  ]);
  if (
    Object.keys(value).some((field) => !allowed.has(field)) ||
    value.protocol !== "koni.recurring-asset-grant-refresh.v1" ||
    !isId(value.runId) ||
    value.ticketId !== ticketId ||
    !isSha256Digest(value.configurationSha256) ||
    !isId(value.actionInvocationId) ||
    !isSha256Digest(value.actionBoundarySha256) ||
    !isSha256Digest(value.priorGraphHash) ||
    !isNonnegativeSafeInteger(value.priorGraphRevision) ||
    !isSha256Digest(value.nextGraphHash) ||
    !isNonnegativeSafeInteger(value.nextGraphRevision) ||
    !isRecord(value.priorProjection) ||
    !isSha256Digest(value.priorProjectionSha256) ||
    !isRecord(value.refreshedProjection) ||
    !isSha256Digest(value.nextProjectionSha256) ||
    !isNonnegativeSafeInteger(value.priorExecutionEpoch) ||
    !isNonnegativeSafeInteger(value.nextExecutionEpoch) ||
    typeof value.recordedAt !== "string" ||
    value.recordedAt.length === 0 ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid recurring-asset grant refresh: ${ticketId}`);
  }
  assertTicketImmutableProjection(
    value.priorProjection,
    `recurring-asset prior projection: ${ticketId}`,
  );
  assertTicketImmutableProjection(
    value.refreshedProjection,
    `recurring-asset refreshed projection: ${ticketId}`,
  );
  const { sha256, ...material } = value;
  if (
    value.priorProjection.id !== ticketId ||
    value.refreshedProjection.id !== ticketId ||
    value.priorProjectionSha256 !== value.priorProjection.sha256 ||
    value.nextProjectionSha256 !== value.refreshedProjection.sha256 ||
    value.nextGraphRevision !== value.priorGraphRevision + 1 ||
    value.nextExecutionEpoch !== value.priorExecutionEpoch + 1 ||
    canonicalHash(material) !== sha256
  ) {
    throw new Error(`invalid recurring-asset grant refresh authority: ${ticketId}`);
  }
}

function assertTicketExecutionControl(
  ticketId: string,
  value: unknown,
): asserts value is TicketExecutionControlRecord {
  if (!isRecord(value)) throw new Error(`invalid ticket execution control: ${ticketId}`);
  let validatedSourceHold: TicketExecutionControlRecord["sourceHold"];
  let validatedProposalDisposition: TicketExecutionControlRecord["proposalDisposition"];
  const allowed = new Set([
    "controlTicketAuthority",
    "recurringAssetGrantRefreshes",
    "changeControlScopeNodeIds",
    "proposalRequest",
    "sourceHold",
    "proposalDisposition",
    "proposalDecision",
    "proposalDecisionHistory",
    "proposalApprovalSha256",
    "sourceProposalTicketId",
    "approvedApplicationSha256",
    "approvedMaterialization",
    "approvedApplicationTicketAuthority",
    "terminalRecovery",
    "terminalResolverTerminalProof",
    "terminalResolverRetryRequests",
  ]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new Error(`invalid ticket execution control field: ${ticketId}`);
  }
  if (value.controlTicketAuthority !== undefined) {
    assertCompilerControlTicketAuthority(ticketId, value.controlTicketAuthority);
  }
  if (value.recurringAssetGrantRefreshes !== undefined) {
    if (
      !Array.isArray(value.recurringAssetGrantRefreshes) ||
      value.recurringAssetGrantRefreshes.length > 64
    ) {
      throw new Error(`invalid recurring-asset grant refresh history: ${ticketId}`);
    }
    for (const refresh of value.recurringAssetGrantRefreshes) {
      assertRecurringAssetGrantRefreshAuthority(ticketId, refresh);
    }
  }
  if (value.changeControlScopeNodeIds !== undefined) {
    if (!isStringArray(value.changeControlScopeNodeIds)) {
      throw new Error(`invalid ticket change-control scope: ${ticketId}`);
    }
    assertCanonicalIdArray(
      value.changeControlScopeNodeIds,
      `ticket change-control scope: ${ticketId}`,
    );
  }
  if (value.proposalRequest !== undefined) {
    const request = value.proposalRequest;
    if (
      !isRecord(request) ||
      Object.keys(request).some(
        (field) =>
          ![
            "requestSha256",
            "sourceTicketId",
            "sourceStepId",
            "sourceOutputSha256",
            "fulfillment",
          ].includes(field),
      ) ||
      !isSha256Digest(request.requestSha256) ||
      !isId(request.sourceTicketId) ||
      !isId(request.sourceStepId) ||
      !isSha256Digest(request.sourceOutputSha256) ||
      (request.fulfillment !== undefined &&
        request.fulfillment !== "planned_asset_repair" &&
        request.fulfillment !== "dynamic_scope_change")
    ) {
      throw new Error(`invalid ticket proposal request: ${ticketId}`);
    }
  }
  if (value.sourceHold !== undefined) {
    const hold = value.sourceHold;
    if (
      !isRecord(hold) ||
      Object.keys(hold).some((field) => !["proposalTicketId", "requestSha256"].includes(field)) ||
      !isId(hold.proposalTicketId) ||
      !isSha256Digest(hold.requestSha256)
    ) {
      throw new Error(`invalid ticket proposal source hold: ${ticketId}`);
    }
    validatedSourceHold = hold as unknown as NonNullable<
      TicketExecutionControlRecord["sourceHold"]
    >;
  }
  if (value.proposalRequest !== undefined && value.sourceHold !== undefined) {
    throw new Error(
      `ticket cannot be both a proposal request and held proposal source: ${ticketId}`,
    );
  }
  if (value.proposalDisposition !== undefined) {
    const disposition = value.proposalDisposition;
    if (
      !isRecord(disposition) ||
      Object.keys(disposition).some(
        (field) => !["kind", "authoritySha256", "applicationTicketId"].includes(field),
      ) ||
      !["approved", "rejected", "no_op", "application"].includes(String(disposition.kind)) ||
      !isSha256Digest(disposition.authoritySha256) ||
      (disposition.applicationTicketId !== undefined && !isId(disposition.applicationTicketId)) ||
      (disposition.kind === "application") !== (disposition.applicationTicketId !== undefined)
    ) {
      throw new Error(`invalid ticket proposal disposition: ${ticketId}`);
    }
    if (value.proposalRequest === undefined) {
      throw new Error(`ticket proposal disposition has no durable request: ${ticketId}`);
    }
    validatedProposalDisposition = disposition as unknown as NonNullable<
      TicketExecutionControlRecord["proposalDisposition"]
    >;
  }
  let validatedProposalDecision: TicketExecutionControlRecord["proposalDecision"];
  if (value.proposalDecision !== undefined) {
    const decision = assertProposalDecisionEvent(ticketId, value.proposalDecision);
    if (value.proposalRequest === undefined) {
      throw new Error(`ticket proposal decision has no durable request: ${ticketId}`);
    }
    validatedProposalDecision = decision;
  }
  if (value.proposalDecisionHistory !== undefined) {
    if (
      !Array.isArray(value.proposalDecisionHistory) ||
      value.proposalDecisionHistory.length > 1_024
    ) {
      throw new Error(`invalid ticket proposal decision history: ${ticketId}`);
    }
    const events = value.proposalDecisionHistory.map((event) =>
      assertProposalDecisionEvent(ticketId, event),
    );
    if (
      new Set(events.map((event) => event.eventId)).size !== events.length ||
      new Set(events.map((event) => event.sha256)).size !== events.length ||
      events.some(
        (event, index) =>
          index > 0 && events[index - 1]!.recordedAt.localeCompare(event.recordedAt) > 0,
      )
    ) {
      throw new Error(`noncanonical ticket proposal decision history: ${ticketId}`);
    }
    if (value.proposalRequest === undefined) {
      throw new Error(`ticket proposal decision history has no durable request: ${ticketId}`);
    }
    if (
      validatedProposalDecision !== undefined &&
      !events.some((event) => event.sha256 === validatedProposalDecision.sha256)
    ) {
      throw new Error(`active ticket proposal decision is absent from its history: ${ticketId}`);
    }
  }
  if (validatedProposalDecision !== undefined && value.proposalDecisionHistory === undefined) {
    throw new Error(`active ticket proposal decision has no durable history: ${ticketId}`);
  }
  if (
    validatedProposalDisposition !== undefined &&
    (validatedProposalDisposition.kind === "approved" ||
      validatedProposalDisposition.kind === "rejected")
  ) {
    const requiredDecision =
      validatedProposalDisposition.kind === "approved" ? "approval" : "rejection";
    if (validatedProposalDecision?.decision !== requiredDecision) {
      throw new Error(
        `ticket proposal disposition lacks matching decision provenance: ${ticketId}`,
      );
    }
  }
  if (value.proposalApprovalSha256 !== undefined && !isSha256Digest(value.proposalApprovalSha256)) {
    throw new Error(`invalid ticket proposal approval: ${ticketId}`);
  }
  if (
    validatedProposalDecision?.decision === "approval" &&
    value.proposalApprovalSha256 !== validatedProposalDecision.sha256
  ) {
    throw new Error(`ticket proposal approval differs from its decision provenance: ${ticketId}`);
  }
  if (
    validatedProposalDecision?.decision === "rejection" &&
    value.proposalApprovalSha256 !== undefined
  ) {
    throw new Error(`rejected ticket proposal retains approval authority: ${ticketId}`);
  }
  if (value.sourceProposalTicketId !== undefined && !isId(value.sourceProposalTicketId)) {
    throw new Error(`invalid ticket source proposal: ${ticketId}`);
  }
  if (
    validatedSourceHold !== undefined &&
    value.sourceProposalTicketId !== undefined &&
    validatedSourceHold.proposalTicketId !== value.sourceProposalTicketId
  ) {
    throw new Error(
      `ticket proposal hold identity differs from its legacy source link: ${ticketId}`,
    );
  }
  if (
    value.approvedApplicationSha256 !== undefined &&
    !isSha256Digest(value.approvedApplicationSha256)
  ) {
    throw new Error(`invalid ticket approved application: ${ticketId}`);
  }
  if (value.approvedMaterialization !== undefined) {
    assertApprovedMaterialization(ticketId, value.approvedMaterialization);
  }
  if (value.approvedApplicationTicketAuthority !== undefined) {
    const authority = value.approvedApplicationTicketAuthority;
    if (
      !isRecord(authority) ||
      authority.protocol !== "koni.application-ticket-authority.v1" ||
      !isId(authority.applicationTicketId) ||
      !isSha256Digest(authority.projectionSha256) ||
      !isSha256Digest(authority.sha256)
    ) {
      throw new Error(`invalid approved application ticket authority: ${ticketId}`);
    }
    const { sha256, ...material } = authority;
    if (canonicalHash(material) !== sha256) {
      throw new Error(`invalid approved application ticket authority hash: ${ticketId}`);
    }
  }
  if (value.terminalRecovery !== undefined) {
    const recovery = value.terminalRecovery;
    if (
      !isRecord(recovery) ||
      recovery.protocol !== "koni.terminal-recovery-authority.v2" ||
      !isSha256Digest(recovery.configurationSha256) ||
      !isSha256Digest(recovery.catalogSha256) ||
      !isId(recovery.resolverOperationId) ||
      recovery.resolverTicketId !== ticketId ||
      !isRecord(recovery.resolverBinding) ||
      !isRecord(recovery.resolverOperation) ||
      !isId(recovery.sourceTicketId) ||
      !Array.isArray(recovery.failureBindingSha256s) ||
      recovery.failureBindingSha256s.length === 0 ||
      recovery.failureBindingSha256s.some((digest) => !isSha256Digest(digest)) ||
      !isRecord(recovery.sourceFailureProof) ||
      !isSha256Digest(recovery.reconciliationSha256) ||
      (recovery.reconciliationDisposition !== "create" &&
        recovery.reconciliationDisposition !== "reuse") ||
      recovery.sourceLink !== "apply_or_repair_after_resolver" ||
      recovery.chainSuppressed !== false ||
      !isSha256Digest(recovery.sha256)
    ) {
      throw new Error(`invalid ticket terminal recovery: ${ticketId}`);
    }
    assertExecutionPolicyBindingIntegrity(
      recovery.resolverBinding as unknown as ExecutionPolicyBinding,
    );
    assertTerminalFailureSettlementProof(recovery.sourceFailureProof);
    const operation = recovery.resolverOperation as unknown as CompiledOperationSemantics;
    const { sha256: operationSha256, ...operationMaterial } = operation;
    if (
      !isSha256Digest(operationSha256) ||
      canonicalHash(operationMaterial) !== operationSha256 ||
      operation.id !== recovery.resolverOperationId ||
      operation.terminalResolver !== true ||
      operation.changeControl?.role !== "ordinary" ||
      recovery.resolverBinding.operationId !== operation.id ||
      recovery.resolverBinding.operationSha256 !== operationSha256 ||
      recovery.resolverBinding.configurationSha256 !== recovery.configurationSha256 ||
      recovery.resolverBinding.catalogSha256 !== recovery.catalogSha256
    ) {
      throw new Error(`terminal recovery differs from configured resolver operation: ${ticketId}`);
    }
    const { sha256, ...material } = recovery;
    if (canonicalHash(material) !== sha256) {
      throw new Error(`invalid ticket terminal recovery authority hash: ${ticketId}`);
    }
    assertCanonicalDigestArray(
      recovery.failureBindingSha256s as Sha256Digest[],
      `ticket terminal recovery failure bindings: ${ticketId}`,
    );
  }
  if (value.terminalResolverTerminalProof !== undefined) {
    assertTerminalSuccessSettlementProof(value.terminalResolverTerminalProof);
    if (value.terminalRecovery === undefined) {
      throw new Error(`terminal resolver success proof has no recovery authority: ${ticketId}`);
    }
  }
  if (value.terminalResolverRetryRequests !== undefined) {
    if (
      !Array.isArray(value.terminalResolverRetryRequests) ||
      value.terminalResolverRetryRequests.length > 8
    ) {
      throw new Error(`invalid ticket terminal resolver retry requests: ${ticketId}`);
    }
    const requestHashes = new Set<string>();
    const failureHashes = new Set<string>();
    for (const [index, request] of value.terminalResolverRetryRequests.entries()) {
      if (
        !isRecord(request) ||
        Object.keys(request).some(
          (field) =>
            ![
              "protocol",
              "ordinal",
              "eventId",
              "actor",
              "message",
              "recordedAt",
              "runId",
              "resolverTicketId",
              "sourceTicketId",
              "sourceFailureBindingSha256",
              "resolverFailureBindingSha256",
              "failureSettlementSha256",
              "failureProof",
              "failedAttemptId",
              "launchSpecHash",
              "terminalPolicySha256",
              "terminalOutputSha256",
              "configurationSha256",
              "catalogSha256",
              "resolverBindingSha256",
              "sha256",
            ].includes(field),
        ) ||
        request.protocol !== "koni.terminal-resolver-retry.v1" ||
        request.ordinal !== index + 1 ||
        !isId(request.eventId) ||
        request.actor !== "operator" ||
        typeof request.message !== "string" ||
        request.message.trim().length === 0 ||
        typeof request.recordedAt !== "string" ||
        request.recordedAt.length === 0 ||
        !isId(request.runId) ||
        request.resolverTicketId !== ticketId ||
        !isId(request.sourceTicketId) ||
        !isId(request.failedAttemptId) ||
        !isSha256Digest(request.sourceFailureBindingSha256) ||
        !isSha256Digest(request.resolverFailureBindingSha256) ||
        !isSha256Digest(request.failureSettlementSha256) ||
        !isRecord(request.failureProof) ||
        !isSha256Digest(request.launchSpecHash) ||
        !isSha256Digest(request.terminalPolicySha256) ||
        !isSha256Digest(request.terminalOutputSha256) ||
        !isSha256Digest(request.configurationSha256) ||
        !isSha256Digest(request.catalogSha256) ||
        !isSha256Digest(request.resolverBindingSha256) ||
        !isSha256Digest(request.sha256)
      ) {
        throw new Error(`invalid ticket terminal resolver retry request: ${ticketId}`);
      }
      const { sha256, ...material } = request;
      assertTerminalFailureSettlementProof(request.failureProof);
      if (
        request.failureProof.sha256 !== request.failureSettlementSha256 ||
        request.failureProof.attemptId !== request.failedAttemptId ||
        request.failureProof.terminalPolicySha256 !== request.terminalPolicySha256 ||
        request.failureProof.terminalOutputSha256 !== request.terminalOutputSha256
      ) {
        throw new Error(`terminal resolver retry failure proof differs from request: ${ticketId}`);
      }
      if (
        canonicalHash(material) !== sha256 ||
        requestHashes.has(sha256) ||
        failureHashes.has(request.resolverFailureBindingSha256)
      ) {
        throw new Error(`invalid ticket terminal resolver retry request hash: ${ticketId}`);
      }
      requestHashes.add(sha256);
      failureHashes.add(request.resolverFailureBindingSha256);
    }
    if (value.terminalRecovery === undefined) {
      throw new Error(`terminal resolver retry requests have no recovery authority: ${ticketId}`);
    }
  }
}

function assertApprovedMaterialization(
  ticketId: string,
  value: unknown,
): asserts value is ApprovedChangeMaterialization {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.approved-change-materialization.v1" ||
    !isSha256Digest(value.configurationSha256) ||
    !isSha256Digest(value.catalogSha256) ||
    !isId(value.runId) ||
    value.proposalTicketId !== ticketId ||
    !isRecord(value.proposalBinding) ||
    !isRecord(value.proposalOperation) ||
    !isSha256Digest(value.requestSha256) ||
    !isSha256Digest(value.approvalSha256) ||
    !isSha256Digest(value.proposalOutputSha256) ||
    !isId(value.proposalStepId) ||
    !isSha256Digest(value.proposalSelectionSha256) ||
    typeof value.selectionSummary !== "string" ||
    value.selectionSummary.length === 0 ||
    !isRecord(value.proposalTerminalProof) ||
    !isSha256Digest(value.reviewSha256) ||
    !isRecord(value.reviewTerminalProof) ||
    !isId(value.applicationPublicOperation) ||
    !isRecord(value.applicationOperation) ||
    !isRecord(value.applicationBinding) ||
    !Array.isArray(value.targetNodeIds) ||
    !isRecord(value.scope) ||
    !isSha256Digest(value.authoritySha256) ||
    (value.kind !== "application" && value.kind !== "no_op") ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid approved materialization: ${ticketId}`);
  }
  assertExecutionPolicyBindingIntegrity(value.proposalBinding as unknown as ExecutionPolicyBinding);
  assertExecutionPolicyBindingIntegrity(
    value.applicationBinding as unknown as ExecutionPolicyBinding,
  );
  assertTerminalSuccessSettlementProof(value.proposalTerminalProof);
  assertTerminalSuccessSettlementProof(value.reviewTerminalProof);
  const operation = value.applicationOperation as unknown as CompiledOperationSemantics;
  const proposalOperation = value.proposalOperation as unknown as CompiledOperationSemantics;
  const { sha256: operationSha256, ...operationMaterial } = operation;
  const { sha256: proposalOperationSha256, ...proposalOperationMaterial } = proposalOperation;
  if (
    !isSha256Digest(proposalOperationSha256) ||
    canonicalHash(proposalOperationMaterial) !== proposalOperationSha256 ||
    proposalOperation.changeControl?.role !== "proposal" ||
    value.proposalBinding.operationId !== proposalOperation.id ||
    value.proposalBinding.operationSha256 !== proposalOperationSha256 ||
    !proposalOperation.changeControl.applicationOperations.includes(
      value.applicationPublicOperation,
    ) ||
    !isSha256Digest(operationSha256) ||
    canonicalHash(operationMaterial) !== operationSha256 ||
    operation.publicOperation !== value.applicationPublicOperation ||
    value.applicationBinding.operationId !== operation.id ||
    value.applicationBinding.operationSha256 !== operationSha256 ||
    value.applicationBinding.publicOperation !== operation.publicOperation ||
    value.applicationBinding.configurationSha256 !== value.configurationSha256 ||
    value.applicationBinding.catalogSha256 !== value.catalogSha256 ||
    (operation.changeControl?.role !== "application" &&
      operation.changeControl?.role !== "disposition")
  ) {
    throw new Error(`approved materialization operation is invalid: ${ticketId}`);
  }
  const targetNodeIds = value.targetNodeIds as string[];
  if (!isStringArray(targetNodeIds))
    throw new Error(`approved materialization targets are invalid: ${ticketId}`);
  assertCanonicalIdArray(targetNodeIds, `approved materialization targets: ${ticketId}`);
  for (const field of ["readNodeIds", "writeNodeIds", "readPaths", "writePaths"] as const) {
    if (!isStringArray(value.scope[field]))
      throw new Error(`approved materialization scope is invalid: ${ticketId}`);
  }
  const authorityMaterial = {
    runId: value.runId,
    proposalTicketId: value.proposalTicketId,
    proposalBindingSha256: value.proposalBinding.sha256,
    requestSha256: value.requestSha256,
    approvalSha256: value.approvalSha256,
    proposalOutputSha256: value.proposalOutputSha256,
    proposalStepId: value.proposalStepId,
    proposalSelectionSha256: value.proposalSelectionSha256,
    selectionSummary: value.selectionSummary,
    reviewSha256: value.reviewSha256,
    proposalTerminalProofSha256: value.proposalTerminalProof.sha256,
    reviewTerminalProofSha256: value.reviewTerminalProof.sha256,
    applicationOperationId: operation.id,
    targetNodeIds,
    scope: value.scope,
    configurationSha256: value.configurationSha256,
    catalogSha256: value.catalogSha256,
  };
  if (canonicalHash(authorityMaterial) !== value.authoritySha256) {
    throw new Error(`approved materialization authority hash is invalid: ${ticketId}`);
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256)
    throw new Error(`approved materialization hash is invalid: ${ticketId}`);
  if (value.kind === "application") {
    if (
      !isId(value.applicationTicketId) ||
      value.applicationOperationId !== operation.id ||
      !Array.isArray(value.controlScopeNodeIds) ||
      (value.disposition !== "create" && value.disposition !== "reuse")
    ) {
      throw new Error(`approved application materialization is invalid: ${ticketId}`);
    }
  } else if (
    value.disposition !== "materialize_without_agent" ||
    operation.changeControl?.role !== "disposition"
  ) {
    throw new Error(`approved no-op materialization is invalid: ${ticketId}`);
  }
}

function assertCompilerControlTicketAuthority(
  ticketId: string,
  value: unknown,
): asserts value is CompilerControlTicketAuthority {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (field) =>
        ![
          "protocol",
          "runId",
          "role",
          "ticketId",
          "configurationSha256",
          "catalogSha256",
          "operation",
          "workflow",
          "definition",
          "causal",
          "projection",
          "projectionSha256",
          "sha256",
        ].includes(field),
    ) ||
    value.protocol !== CONTROL_TICKET_AUTHORITY_PROTOCOL ||
    !isId(value.runId) ||
    value.ticketId !== ticketId ||
    !["proposal", "approved_application", "terminal_resolver"].includes(String(value.role)) ||
    !isSha256Digest(value.configurationSha256) ||
    !isSha256Digest(value.catalogSha256) ||
    !isRecord(value.operation) ||
    !isRecord(value.workflow) ||
    !isRecord(value.definition) ||
    !isRecord(value.causal) ||
    !isRecord(value.projection) ||
    !isSha256Digest(value.projectionSha256) ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid compiler control-ticket authority: ${ticketId}`);
  }
  assertHashBoundObject(value.operation, "sha256", `control-ticket operation: ${ticketId}`);
  assertHashBoundObject(value.workflow, "sha256", `control-ticket workflow: ${ticketId}`);
  assertHashBoundObject(
    value.definition,
    "definition_sha256",
    `control-ticket definition: ${ticketId}`,
  );
  assertTicketImmutableProjection(value.projection, `control-ticket projection: ${ticketId}`);
  if (
    value.projectionSha256 !== value.projection.sha256 ||
    value.projection.id !== ticketId ||
    value.projection.control.role !== value.role ||
    value.definition.id !== ticketId ||
    value.definition.operation_registry_id !== value.operation.id ||
    value.definition.workflow_id !== value.workflow.id ||
    value.definition.configuration_sha256 !== value.configurationSha256
  ) {
    throw new Error(`compiler control-ticket authority fields disagree: ${ticketId}`);
  }
  const operation = value.operation as unknown as CompiledOperationSemantics;
  const workflow = value.workflow as unknown as CompiledWorkflowSemantics;
  const projection = value.projection as unknown as TicketImmutableProjection;
  if (
    operation.workflowId !== workflow.id ||
    !workflow.appliesTo.includes(operation.publicOperation) ||
    projection.operationId !== operation.id ||
    projection.executionPolicyBinding?.operationId !== operation.id ||
    projection.executionPolicyBinding?.operationSha256 !== operation.sha256 ||
    projection.executionPolicyBinding?.workflowId !== workflow.id ||
    projection.executionPolicyBinding?.workflowSha256 !== workflow.sha256 ||
    projection.executionPolicyBinding?.configurationSha256 !== value.configurationSha256 ||
    projection.executionPolicyBinding?.catalogSha256 !== value.catalogSha256
  ) {
    throw new Error(`compiler control-ticket operation/workflow binding is invalid: ${ticketId}`);
  }
  assertControlTicketCausalAuthority(ticketId, value.role as ControlTicketRole, value.causal);
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256) {
    throw new Error(`invalid compiler control-ticket authority hash: ${ticketId}`);
  }
}

function assertControlTicketCausalAuthority(
  ticketId: string,
  role: ControlTicketRole,
  value: Record<string, unknown>,
): void {
  if (value.role !== role) throw new Error(`control-ticket causal role is invalid: ${ticketId}`);
  if (role === "proposal") {
    if (
      Object.keys(value).some(
        (field) =>
          ![
            "role",
            "publication",
            "sourceTicketProjection",
            "sourceTerminalProof",
            "sourceHold",
          ].includes(field),
      ) ||
      !isRecord(value.publication) ||
      !isRecord(value.sourceTicketProjection) ||
      !isRecord(value.sourceTerminalProof) ||
      !isRecord(value.sourceHold)
    ) {
      throw new Error(`proposal control-ticket causal authority is invalid: ${ticketId}`);
    }
    assertHashBoundObject(value.publication, "sha256", `proposal publication: ${ticketId}`);
    assertTicketImmutableProjection(
      value.sourceTicketProjection,
      `proposal source projection: ${ticketId}`,
    );
    assertTerminalSuccessSettlementProof(value.sourceTerminalProof);
    if (
      value.publication.proposalTicketId !== ticketId ||
      value.sourceHold.proposalTicketId !== ticketId ||
      value.sourceHold.requestSha256 !== value.publication.requestSha256
    ) {
      throw new Error(`proposal control-ticket causal identity is invalid: ${ticketId}`);
    }
    return;
  }
  if (role === "approved_application") {
    if (
      Object.keys(value).some(
        (field) =>
          ![
            "role",
            "materialization",
            "proposalTicketAuthoritySha256",
            "proposalTicketProjectionSha256",
          ].includes(field),
      ) ||
      !isRecord(value.materialization) ||
      !isSha256Digest(value.proposalTicketAuthoritySha256) ||
      !isSha256Digest(value.proposalTicketProjectionSha256)
    ) {
      throw new Error(`application control-ticket causal authority is invalid: ${ticketId}`);
    }
    assertApprovedMaterialization(
      String(value.materialization.proposalTicketId),
      value.materialization,
    );
    if (
      value.materialization.kind !== "application" ||
      value.materialization.applicationTicketId !== ticketId
    ) {
      throw new Error(`application control-ticket causal materialization is invalid: ${ticketId}`);
    }
    return;
  }
  if (
    Object.keys(value).some(
      (field) =>
        !["role", "reconciliation", "sourceTicketProjection", "sourceFailureProof"].includes(field),
    ) ||
    !isRecord(value.reconciliation) ||
    !isRecord(value.sourceTicketProjection) ||
    !isRecord(value.sourceFailureProof)
  ) {
    throw new Error(`resolver control-ticket causal authority is invalid: ${ticketId}`);
  }
  assertHashBoundObject(value.reconciliation, "sha256", `terminal reconciliation: ${ticketId}`);
  assertTicketImmutableProjection(
    value.sourceTicketProjection,
    `resolver source projection: ${ticketId}`,
  );
  assertTerminalFailureSettlementProof(value.sourceFailureProof);
  if (
    value.reconciliation.chainSuppressed !== false ||
    value.reconciliation.resolverTicketId !== ticketId
  ) {
    throw new Error(`resolver control-ticket causal identity is invalid: ${ticketId}`);
  }
}

function assertTicketImmutableProjection(
  value: unknown,
  label: string,
): asserts value is TicketImmutableProjection {
  if (
    !isRecord(value) ||
    value.protocol !== TICKET_IMMUTABLE_PROJECTION_PROTOCOL ||
    !isId(value.id) ||
    !isId(value.operationId) ||
    typeof value.title !== "string" ||
    typeof value.summary !== "string" ||
    !isRecord(value.control) ||
    !Number.isSafeInteger(value.priority) ||
    !Array.isArray(value.dependencyIds) ||
    !Array.isArray(value.targetNodeIds) ||
    !Array.isArray(value.readNodeIds) ||
    !Array.isArray(value.writeNodeIds) ||
    !Array.isArray(value.readPaths) ||
    !Array.isArray(value.writePaths) ||
    !Array.isArray(value.steps) ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid ${label}`);
  }
  if (value.executionPolicyBinding !== null) {
    if (!isRecord(value.executionPolicyBinding)) throw new Error(`invalid ${label} policy binding`);
    assertExecutionPolicyBindingIntegrity(
      value.executionPolicyBinding as unknown as ExecutionPolicyBinding,
    );
  }
  if (
    !["ordinary", "proposal", "approved_application", "terminal_resolver"].includes(
      String(value.control.role),
    )
  ) {
    throw new Error(`invalid ${label} control role`);
  }
  for (const step of value.steps) {
    if (
      !isRecord(step) ||
      !isId(step.id) ||
      typeof step.title !== "string" ||
      !isId(step.personaId) ||
      !Array.isArray(step.dependsOn) ||
      !Array.isArray(step.readNodeIds) ||
      !Array.isArray(step.writeNodeIds) ||
      !Array.isArray(step.readPaths) ||
      !Array.isArray(step.writePaths) ||
      (step.validationAction !== null && !isId(step.validationAction))
    ) {
      throw new Error(`invalid ${label} step`);
    }
    if (step.executionPolicyBinding !== null) {
      if (!isRecord(step.executionPolicyBinding)) throw new Error(`invalid ${label} step policy`);
      assertExecutionPolicyBindingIntegrity(
        step.executionPolicyBinding as unknown as ExecutionPolicyBinding,
      );
    }
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256) throw new Error(`invalid ${label} hash`);
}

function assertHashBoundObject(
  value: Record<string, unknown>,
  hashField: "sha256" | "definition_sha256",
  label: string,
): void {
  const digest = value[hashField];
  if (!isSha256Digest(digest)) throw new Error(`invalid ${label} hash`);
  const material = { ...value };
  delete material[hashField];
  if (canonicalHash(material) !== digest) throw new Error(`invalid ${label} hash`);
}

/**
 * Validate relationships that no individual ticket can prove in isolation. This executes at the
 * run-record/store boundary, before scheduler or UI projections can observe impossible control
 * state.
 */
function assertRunExecutionControlGraph(run: Readonly<RunRecord>): void {
  const proposalForSource = new Map<string, string>();
  const resolverFailures = new Set<string>();
  for (const ticket of Object.values(run.tickets)) {
    assertRecurringAssetGrantRefreshHistory(run, ticket);
    assertCompilerControlTicketForRun(run, ticket);
    const control = ticket.executionControl;
    if (control === undefined) continue;
    const request = control.proposalRequest;
    if (request !== undefined) {
      for (const decision of control.proposalDecisionHistory ?? []) {
        if (
          decision.protocol === "koni.proposal-decision-authority.v2" &&
          (decision.runId !== run.id ||
            decision.proposalTicketId !== ticket.id ||
            decision.requestSha256 !== request.requestSha256 ||
            decision.actor !== "operator")
        ) {
          throw new Error(`proposal decision differs from exact durable authority: ${ticket.id}`);
        }
      }
      const source = run.tickets[request.sourceTicketId];
      const sourceHold = source?.executionControl?.sourceHold;
      if (
        source === undefined ||
        source.id === ticket.id ||
        !source.steps.some((step) => step.id === request.sourceStepId)
      ) {
        throw new Error(`proposal ticket has no exact source: ${ticket.id}`);
      }
      const activelyHeld =
        sourceHold?.proposalTicketId === ticket.id &&
        sourceHold.requestSha256 === request.requestSha256;
      if (activelyHeld) {
        const prior = proposalForSource.get(source.id);
        if (prior !== undefined && prior !== ticket.id) {
          throw new Error(`proposal source has ambiguous control authority: ${source.id}`);
        }
        proposalForSource.set(source.id, ticket.id);
      } else if (!proposalHasReleasedSourceAuthority(run, ticket)) {
        if (ticket.executionControl?.proposalDisposition?.kind === "application") {
          throw new Error(
            `approved application source release lacks exact Git publication authority: ${ticket.id}`,
          );
        }
        throw new Error(`proposal ticket has no exact held or released source: ${ticket.id}`);
      }
    }
    const hold = control.sourceHold;
    if (hold !== undefined) {
      const proposal = run.tickets[hold.proposalTicketId];
      const proposalRequest = proposal?.executionControl?.proposalRequest;
      if (
        proposal === undefined ||
        proposal.id === ticket.id ||
        proposalRequest?.sourceTicketId !== ticket.id ||
        proposalRequest.requestSha256 !== hold.requestSha256
      ) {
        throw new Error(`held source has no exact proposal ticket: ${ticket.id}`);
      }
    }
    const disposition = control.proposalDisposition;
    if (disposition !== undefined) {
      if (disposition.kind === "rejected" && ticket.status !== "completed") {
        throw new Error(`rejected proposal is not terminal: ${ticket.id}`);
      }
      if (disposition.kind === "no_op") {
        const materialization = control.approvedMaterialization;
        if (
          ticket.status !== "completed" ||
          control.approvedApplicationSha256 !== disposition.authoritySha256 ||
          disposition.applicationTicketId !== undefined ||
          materialization?.kind !== "no_op" ||
          materialization.authoritySha256 !== disposition.authoritySha256
        ) {
          throw new Error(`no-op proposal has impossible application authority: ${ticket.id}`);
        }
      }
      if (disposition.kind === "application") {
        const materialization = control.approvedMaterialization;
        const applicationId = disposition.applicationTicketId!;
        const application = run.tickets[applicationId];
        if (application === undefined) {
          throw new Error(`proposal application relationship is invalid: ${ticket.id}`);
        }
        const applicationControl = application?.executionControl;
        if (
          ticket.status !== "completed" ||
          control.approvedApplicationSha256 !== disposition.authoritySha256 ||
          materialization?.kind !== "application" ||
          materialization.authoritySha256 !== disposition.authoritySha256 ||
          materialization.applicationTicketId !== applicationId ||
          applicationControl?.controlTicketAuthority?.role !== "approved_application" ||
          applicationControl.controlTicketAuthority.causal.role !== "approved_application" ||
          applicationControl.controlTicketAuthority.causal.materialization.authoritySha256 !==
            materialization.authoritySha256 ||
          applicationControl?.sourceProposalTicketId !== ticket.id ||
          applicationControl.approvedApplicationSha256 !== disposition.authoritySha256 ||
          application.operationId !== materialization.applicationOperationId ||
          application.executionPolicyBinding?.sha256 !==
            materialization.applicationBinding.sha256 ||
          canonicalHash(application.targetNodeIds) !==
            canonicalHash(materialization.targetNodeIds) ||
          canonicalHash(application.writeNodeIds ?? []) !==
            canonicalHash(materialization.scope.writeNodeIds)
        ) {
          throw new Error(`proposal application relationship is invalid: ${ticket.id}`);
        }
      }
      if (disposition.kind === "no_op" || disposition.kind === "application") {
        const materialization = control.approvedMaterialization;
        if (
          materialization === undefined ||
          materialization.runId !== run.id ||
          materialization.proposalTicketId !== ticket.id ||
          materialization.requestSha256 !== request?.requestSha256 ||
          materialization.approvalSha256 !== control.proposalApprovalSha256 ||
          materialization.proposalBinding.sha256 !== ticket.executionPolicyBinding?.sha256 ||
          materialization.configurationSha256 !==
            ticket.executionPolicyBinding?.configurationSha256 ||
          materialization.catalogSha256 !== ticket.executionPolicyBinding?.catalogSha256 ||
          materialization.applicationBinding.configurationSha256 !==
            materialization.configurationSha256 ||
          materialization.applicationBinding.catalogSha256 !== materialization.catalogSha256 ||
          materialization.proposalTerminalProof.stepId !== materialization.proposalStepId ||
          materialization.proposalOperation.changeControl.role !== "proposal" ||
          materialization.proposalOperation.changeControl.proposalStep !==
            materialization.proposalStepId ||
          ticket.steps.filter((step) => step.kind === "review").at(-1)?.id !==
            materialization.reviewTerminalProof.stepId ||
          materialization.reviewTerminalProof.attemptId ===
            materialization.proposalTerminalProof.attemptId ||
          materialization.reviewTerminalProof.actionInvocationId ===
            materialization.proposalTerminalProof.actionInvocationId ||
          !terminalSuccessProofMatchesRun(run, materialization.proposalTerminalProof, ticket.id) ||
          !terminalSuccessProofMatchesRun(run, materialization.reviewTerminalProof, ticket.id)
        ) {
          throw new Error(`proposal materialization lacks exact terminal authority: ${ticket.id}`);
        }
        const reviewAttempt = run.attempts[materialization.reviewTerminalProof.attemptId];
        const expectedReviewSha =
          reviewAttempt?.terminalAcceptedAt === undefined
            ? undefined
            : canonicalHash({
                protocol: "koni.proposal-review-authority.v1",
                attemptId: reviewAttempt.id,
                launchSpecHash: reviewAttempt.launchSpecHash,
                approvalSha256: materialization.approvalSha256,
                terminalPolicySha256: reviewAttempt.terminalPolicy!.sha256,
                terminalOutputSha256: reviewAttempt.terminalOutputSha256!,
                terminalAcceptedAt: reviewAttempt.terminalAcceptedAt,
              });
        const selectionMaterial = {
          protocol: "koni.assignment-change-control.v1" as const,
          kind: "proposal_application" as const,
          configurationSha256: materialization.configurationSha256,
          catalogSha256: materialization.catalogSha256,
          proposalBindingSha256: materialization.proposalBinding.sha256,
          applicationBinding: materialization.applicationBinding,
          proposalOutputSha256: materialization.proposalOutputSha256,
          proposalTicketId: ticket.id,
          proposalStepId: materialization.proposalStepId,
          applicationPublicOperation: materialization.applicationPublicOperation,
          applicationOperationId: materialization.applicationOperation.id,
          targetNodeIds: materialization.targetNodeIds,
          summary: materialization.selectionSummary,
          scope: materialization.scope,
        };
        if (
          canonicalHash(selectionMaterial) !== materialization.proposalSelectionSha256 ||
          materialization.proposalTerminalProof.semanticResult.changeControlSha256 !==
            materialization.proposalSelectionSha256 ||
          expectedReviewSha !== materialization.reviewSha256
        ) {
          throw new Error(
            `proposal materialization differs from selection or review authority: ${ticket.id}`,
          );
        }
        if (materialization.kind === "application") {
          const expectedId = `TK-application-${canonicalHash({
            proposalTicketId: ticket.id,
            authoritySha256: materialization.authoritySha256,
          }).slice("sha256:".length, "sha256:".length + 24)}`;
          if (expectedId !== materialization.applicationTicketId) {
            throw new Error(
              `proposal materialization has noncanonical application identity: ${ticket.id}`,
            );
          }
        }
      }
    }
    if (control.sourceProposalTicketId !== undefined) {
      const proposal = run.tickets[control.sourceProposalTicketId];
      const proposalDisposition = proposal?.executionControl?.proposalDisposition;
      if (
        proposal === undefined ||
        proposal.id === ticket.id ||
        proposalDisposition?.kind !== "application" ||
        proposalDisposition.applicationTicketId !== ticket.id ||
        control.approvedApplicationSha256 === undefined ||
        proposalDisposition.authoritySha256 !== control.approvedApplicationSha256
      ) {
        throw new Error(`application ticket has no exact proposal authority: ${ticket.id}`);
      }
    }
    const recovery = control.terminalRecovery;
    if (recovery !== undefined) {
      const source = run.tickets[recovery.sourceTicketId];
      if (
        source === undefined ||
        source.id === ticket.id ||
        recovery.failureBindingSha256s.length !== 1
      ) {
        throw new Error(`terminal resolver has invalid source authority: ${ticket.id}`);
      }
      const sourceFailure = terminalFailureBindingFromProof(
        run,
        source,
        recovery.sourceFailureProof,
      );
      const expectedResolverId = `TK-recovery-${canonicalHash({
        runId: run.id,
        sourceTicketId: source.id,
        failureBindingSha256: recovery.failureBindingSha256s[0],
        configurationSha256: recovery.configurationSha256,
        catalogSha256: recovery.catalogSha256,
        resolverOperationId: recovery.resolverOperationId,
      }).slice("sha256:".length, "sha256:".length + 24)}`;
      const reconciliationMaterial = {
        protocol: "koni.terminal-resolver-reconciliation.v1" as const,
        configurationSha256: recovery.configurationSha256,
        catalogSha256: recovery.catalogSha256,
        sourceTicketId: recovery.sourceTicketId,
        resolverOperationId: recovery.resolverOperationId,
        resolverTicketId: recovery.resolverTicketId,
        resolverBinding: recovery.resolverBinding,
        failureBindingSha256s: recovery.failureBindingSha256s,
        disposition: recovery.reconciliationDisposition,
        sourceLink: recovery.sourceLink,
        chainSuppressed: recovery.chainSuppressed,
      };
      if (
        sourceFailure?.sha256 !== recovery.failureBindingSha256s[0] ||
        canonicalHash(reconciliationMaterial) !== recovery.reconciliationSha256 ||
        expectedResolverId !== ticket.id ||
        recovery.resolverTicketId !== ticket.id ||
        ticket.operationId !== recovery.resolverOperationId ||
        source.executionControl?.terminalRecovery !== undefined ||
        ticket.executionPolicyBinding?.sha256 !== recovery.resolverBinding.sha256 ||
        ticket.executionPolicyBinding.configurationSha256 !== recovery.configurationSha256 ||
        ticket.executionPolicyBinding.catalogSha256 !== recovery.catalogSha256
      ) {
        throw new Error(
          `terminal resolver differs from canonical compiler authority: ${ticket.id}`,
        );
      }
      if (ticket.status === "completed") {
        const terminalProof = control.terminalResolverTerminalProof;
        const attempt =
          terminalProof === undefined ? undefined : run.attempts[terminalProof.attemptId];
        if (
          terminalProof === undefined ||
          terminalProof.runId !== run.id ||
          terminalProof.ticketId !== ticket.id ||
          attempt === undefined ||
          attempt.ticketId !== ticket.id ||
          attempt.stepId !== terminalProof.stepId ||
          ticket.steps.at(-1)?.id !== terminalProof.stepId ||
          attempt.terminalPolicy?.sha256 !== terminalProof.terminalPolicySha256 ||
          attempt.terminalOutputSha256 !== terminalProof.terminalOutputSha256
        ) {
          throw new Error(
            `completed terminal resolver lacks exact terminal authority: ${ticket.id}`,
          );
        }
      } else if (control.terminalResolverTerminalProof !== undefined) {
        throw new Error(`nonterminal resolver retains terminal success authority: ${ticket.id}`);
      }
      const identity = `${source.id}\0${recovery.failureBindingSha256s[0]}`;
      if (resolverFailures.has(identity)) {
        throw new Error(`terminal failure has duplicate resolver authority: ${source.id}`);
      }
      resolverFailures.add(identity);
      const sourceFailureBinding = terminalFailureBindingFromProof(
        run,
        source,
        recovery.sourceFailureProof,
      );
      for (const retry of control.terminalResolverRetryRequests ?? []) {
        if (
          retry.runId !== run.id ||
          retry.sourceTicketId !== source.id ||
          retry.sourceFailureBindingSha256 !== recovery.failureBindingSha256s[0] ||
          retry.configurationSha256 !== ticket.executionPolicyBinding?.configurationSha256 ||
          retry.catalogSha256 !== ticket.executionPolicyBinding?.catalogSha256 ||
          retry.resolverBindingSha256 !== ticket.executionPolicyBinding?.sha256
        ) {
          throw new Error(
            `terminal resolver retry differs from pinned recovery authority: ${ticket.id}`,
          );
        }
        const attempt = run.attempts[retry.failedAttemptId];
        const resolverFailureBinding = terminalFailureBindingFromProof(
          run,
          ticket,
          retry.failureProof,
        );
        if (
          attempt === undefined ||
          attempt.ticketId !== ticket.id ||
          attempt.launchSpecHash !== retry.launchSpecHash ||
          attempt.terminalPolicy?.sha256 !== retry.terminalPolicySha256 ||
          attempt.terminalOutputSha256 !== retry.terminalOutputSha256 ||
          resolverFailureBinding?.sha256 !== retry.resolverFailureBindingSha256 ||
          resolverFailureBinding.failureSettlementSha256 !== retry.failureSettlementSha256 ||
          sourceFailureBinding?.sha256 !== retry.sourceFailureBindingSha256
        ) {
          throw new Error(`terminal resolver retry has no exact failed attempt: ${ticket.id}`);
        }
      }
    }
  }
}

function assertCompilerControlTicketForRun(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
): void {
  const projection = ticketImmutableProjection(ticket);
  const role = projection.control.role;
  const authority = ticket.executionControl?.controlTicketAuthority;
  if (role === "ordinary") {
    if (authority !== undefined) {
      throw new Error(`ordinary ticket retains compiler control-ticket authority: ${ticket.id}`);
    }
    return;
  }
  if (
    authority === undefined ||
    authority.runId !== run.id ||
    authority.ticketId !== ticket.id ||
    authority.role !== role ||
    authority.configurationSha256 !== run.compiledConfigHash ||
    authority.projectionSha256 !== projection.sha256 ||
    canonicalHash(authority.projection) !== canonicalHash(projection)
  ) {
    throw new Error(`ticket lacks exact compiler control-ticket authority: ${ticket.id}`);
  }
  assertCompilerControlTicketAuthority(ticket.id, authority);
  assertControlDefinitionProjection(ticket, authority);
  if (role === "proposal") {
    const causal = authority.causal;
    if (causal.role !== "proposal" || authority.operation.changeControl.role !== "proposal") {
      throw new Error(`proposal ticket has invalid compiler authority role: ${ticket.id}`);
    }
    const source = run.tickets[causal.publication.sourceTicketId];
    const sourceProjection = source === undefined ? undefined : ticketImmutableProjection(source);
    const sourceHold = source?.executionControl?.sourceHold;
    const activelyHeldSource =
      sourceHold?.proposalTicketId === ticket.id &&
      sourceHold.requestSha256 === causal.publication.requestSha256 &&
      canonicalHash(sourceHold) === canonicalHash(causal.sourceHold);
    const authorizedSourceEvolution =
      source !== undefined &&
      sourceProjection !== undefined &&
      (activelyHeldSource
        ? ticketProjectionsDifferOnlyByDependencies(sourceProjection, causal.sourceTicketProjection)
        : proposalHasReleasedSourceAuthority(run, ticket) &&
          recurringAssetGrantRefreshChainAuthorizes(
            source,
            sourceProjection,
            causal.sourceTicketProjection,
          ));
    const sourceStep = sourceProjection?.steps.find(
      (step) => step.id === causal.publication.sourceStepId,
    );
    assertExecutionPolicyBindingIntegrity(causal.publication.sourceBinding);
    assertExecutionPolicyBindingIntegrity(causal.publication.proposalBinding);
    const publicationRequestSha256 = canonicalHash({
      runId: causal.publication.runId,
      sourceTicketId: causal.publication.sourceTicketId,
      sourceStepId: causal.publication.sourceStepId,
      sourceOutputSha256: causal.publication.sourceOutputSha256,
      sourceBindingSha256: causal.publication.sourceBinding.sha256,
      targetNodeIds: causal.publication.targetNodeIds,
      summary: causal.publication.summary,
      reason: causal.publication.reason,
      configurationSha256: causal.publication.configurationSha256,
      catalogSha256: causal.publication.catalogSha256,
    });
    const compilationMaterial = {
      protocol: "koni.assignment-change-control.v1" as const,
      kind: "upstream_request" as const,
      sourceTicketId: causal.publication.sourceTicketId,
      sourceStepId: causal.publication.sourceStepId,
      sourceBindingSha256: causal.publication.sourceBinding.sha256,
      sourceOutputSha256: causal.publication.sourceOutputSha256,
      targetNodeIds: causal.publication.targetNodeIds,
      ...(projection.control.proposalRequest.fulfillment === undefined
        ? {}
        : { fulfillment: projection.control.proposalRequest.fulfillment }),
      summary: causal.publication.summary,
      reason: causal.publication.reason,
      publication: causal.publication,
    };
    const sourceCompilationSha256 = canonicalHash(compilationMaterial);
    if (
      source === undefined ||
      source.id === ticket.id ||
      (canonicalHash(sourceProjection) !== canonicalHash(causal.sourceTicketProjection) &&
        !authorizedSourceEvolution) ||
      sourceStep?.executionPolicyBinding?.sha256 !== causal.publication.sourceBinding.sha256 ||
      causal.publication.runId !== run.id ||
      causal.publication.proposalTicketId !== ticket.id ||
      causal.publication.configurationSha256 !== authority.configurationSha256 ||
      causal.publication.catalogSha256 !== authority.catalogSha256 ||
      causal.publication.requestSha256 !== publicationRequestSha256 ||
      causal.publication.proposalOperationId !== authority.operation.id ||
      causal.publication.proposalBinding.sha256 !== ticket.executionPolicyBinding?.sha256 ||
      causal.publication.sourceOperation.sha256 !==
        causal.publication.sourceBinding.operationSha256 ||
      causal.sourceTerminalProof.semanticResult.changeControlSha256 !== sourceCompilationSha256 ||
      !terminalSuccessProofMatchesRun(run, causal.sourceTerminalProof, source.id) ||
      causal.sourceHold.proposalTicketId !== ticket.id ||
      causal.sourceHold.requestSha256 !== causal.publication.requestSha256 ||
      projection.summary !==
        `${causal.publication.summary}\n\nReason: ${causal.publication.reason}` ||
      projection.title !== controlAuthorityTitle("Change request", causal.publication.summary) ||
      canonicalHash(projection.targetNodeIds) !== canonicalHash(causal.publication.targetNodeIds) ||
      canonicalHash(projection.readNodeIds) !== canonicalHash(causal.publication.targetNodeIds) ||
      projection.writeNodeIds.length !== 0 ||
      projection.readPaths.length !== 0 ||
      projection.writePaths.length !== 0 ||
      canonicalHash(projection.control.changeControlScopeNodeIds) !==
        canonicalHash(causal.publication.controlScopeNodeIds) ||
      projection.dependencyIds.length !== 0
    ) {
      throw new Error(`proposal ticket differs from its causal compiler authority: ${ticket.id}`);
    }
    return;
  }
  if (role === "approved_application") {
    const causal = authority.causal;
    if (
      causal.role !== "approved_application" ||
      authority.operation.changeControl.role !== "application" ||
      causal.materialization.kind !== "application"
    ) {
      throw new Error(`application ticket has invalid compiler authority role: ${ticket.id}`);
    }
    const proposal = run.tickets[causal.materialization.proposalTicketId];
    const proposalAuthority = proposal?.executionControl?.controlTicketAuthority;
    const proposalProjection =
      proposal === undefined ? undefined : ticketImmutableProjection(proposal);
    if (
      proposal === undefined ||
      proposal.id === ticket.id ||
      proposalAuthority?.role !== "proposal" ||
      proposalAuthority.sha256 !== causal.proposalTicketAuthoritySha256 ||
      proposalProjection?.sha256 !== causal.proposalTicketProjectionSha256 ||
      causal.materialization.applicationTicketId !== ticket.id ||
      causal.materialization.applicationOperationId !== authority.operation.id ||
      causal.materialization.applicationBinding.sha256 !== ticket.executionPolicyBinding?.sha256 ||
      projection.control.sourceProposalTicketId !== proposal.id ||
      projection.control.approvedApplicationSha256 !== causal.materialization.authoritySha256 ||
      canonicalHash(projection.control.changeControlScopeNodeIds) !==
        canonicalHash(causal.materialization.controlScopeNodeIds) ||
      canonicalHash(projection.targetNodeIds) !==
        canonicalHash(causal.materialization.targetNodeIds) ||
      canonicalHash(projection.readNodeIds) !==
        canonicalHash(causal.materialization.scope.readNodeIds) ||
      canonicalHash(projection.writeNodeIds) !==
        canonicalHash(causal.materialization.scope.writeNodeIds) ||
      canonicalHash(projection.readPaths) !==
        canonicalHash(causal.materialization.scope.readPaths) ||
      canonicalHash(projection.writePaths) !==
        canonicalHash(causal.materialization.scope.writePaths) ||
      canonicalHash(projection.dependencyIds) !== canonicalHash([proposal.id]) ||
      projection.title !==
        controlAuthorityTitle("Apply change", causal.materialization.selectionSummary) ||
      projection.summary !== causal.materialization.selectionSummary ||
      canonicalHash(proposal.executionControl?.approvedMaterialization) !==
        canonicalHash(causal.materialization)
    ) {
      throw new Error(
        `application ticket differs from its causal compiler authority: ${ticket.id}`,
      );
    }
    return;
  }
  const causal = authority.causal;
  if (causal.role !== "terminal_resolver" || !authority.operation.terminalResolver) {
    throw new Error(`terminal resolver has invalid compiler authority role: ${ticket.id}`);
  }
  const source = run.tickets[causal.reconciliation.sourceTicketId];
  const sourceProjection = source === undefined ? undefined : ticketImmutableProjection(source);
  const authorizedSourceDependencyDrift =
    sourceProjection !== undefined &&
    ticketProjectionsDifferOnlyByDependencies(sourceProjection, causal.sourceTicketProjection);
  if (
    source === undefined ||
    sourceProjection === undefined ||
    source.id === ticket.id ||
    source.executionControl?.terminalRecovery !== undefined ||
    (canonicalHash(sourceProjection) !== canonicalHash(causal.sourceTicketProjection) &&
      !authorizedSourceDependencyDrift) ||
    causal.reconciliation.resolverTicketId !== ticket.id ||
    causal.reconciliation.resolverOperationId !== authority.operation.id ||
    causal.reconciliation.resolverBinding.sha256 !== ticket.executionPolicyBinding?.sha256 ||
    causal.reconciliation.configurationSha256 !== authority.configurationSha256 ||
    causal.reconciliation.catalogSha256 !== authority.catalogSha256 ||
    terminalFailureBindingFromProof(run, source, causal.sourceFailureProof)?.sha256 !==
      causal.reconciliation.failureBindingSha256s[0] ||
    canonicalHash(projection.targetNodeIds) !== canonicalHash(sourceProjection.targetNodeIds) ||
    canonicalHash(projection.readNodeIds) !==
      canonicalHash(
        [...new Set([...sourceProjection.readNodeIds, ...sourceProjection.writeNodeIds])].sort(
          compareUtf8,
        ),
      ) ||
    canonicalHash(projection.writeNodeIds) !== canonicalHash(sourceProjection.writeNodeIds) ||
    canonicalHash(projection.readPaths) !== canonicalHash(sourceProjection.readPaths) ||
    canonicalHash(projection.writePaths) !== canonicalHash(sourceProjection.writePaths) ||
    canonicalHash(projection.control.changeControlScopeNodeIds) !==
      canonicalHash(
        [...new Set([...projection.readNodeIds, ...projection.writeNodeIds])].sort(compareUtf8),
      ) ||
    projection.title !== `Resolve terminal failure: ${sourceProjection.title}` ||
    projection.summary !==
      `Recover terminal ticket ${source.id} from ${causal.reconciliation.failureBindingSha256s.length} authenticated failure binding(s).` ||
    projection.dependencyIds.length !== 0
  ) {
    throw new Error(`terminal resolver differs from its causal compiler authority: ${ticket.id}`);
  }
}

/**
 * A control ticket authenticates the historical source projection forever, but that history must
 * not freeze later compiler scheduling. Dependency edges are scheduling authority, not mutation
 * scope; permit only that exact field to change while the control ticket remains causally valid.
 */
function ticketProjectionsDifferOnlyByDependencies(
  current: Readonly<TicketImmutableProjection>,
  historical: Readonly<TicketImmutableProjection>,
): boolean {
  return (
    canonicalHash({
      ...current,
      dependencyIds: historical.dependencyIds,
      sha256: historical.sha256,
    }) === canonicalHash(historical)
  );
}

function recurringAssetGrantRefreshChainAuthorizes(
  source: Readonly<TicketRecord>,
  current: Readonly<TicketImmutableProjection>,
  historical: Readonly<TicketImmutableProjection>,
): boolean {
  const history = source.executionControl?.recurringAssetGrantRefreshes ?? [];
  let accepted = historical;
  let cursor = history.findIndex((refresh) =>
    ticketProjectionsDifferOnlyByDependencies(refresh.priorProjection, historical),
  );
  if (cursor < 0) {
    const checkpoint = history.findLastIndex((refresh) =>
      ticketProjectionsDifferOnlyByDependencies(refresh.refreshedProjection, historical),
    );
    cursor = checkpoint + 1;
  }
  for (const refresh of history.slice(cursor)) {
    if (!ticketProjectionsDifferOnlyByDependencies(refresh.priorProjection, accepted)) return false;
    accepted = refresh.refreshedProjection;
  }
  return ticketProjectionsDifferOnlyByDependencies(current, accepted);
}

function assertRecurringAssetGrantRefreshHistory(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
): void {
  const history = ticket.executionControl?.recurringAssetGrantRefreshes;
  if (history === undefined || history.length === 0) return;
  if (ticket.operationId !== "asset-resolution.asset.implement-asset") {
    throw new Error(`non-recurring ticket retains grant refresh authority: ${ticket.id}`);
  }
  for (const [index, refresh] of history.entries()) {
    if (
      refresh.runId !== run.id ||
      refresh.ticketId !== ticket.id ||
      refresh.configurationSha256 !== run.compiledConfigHash ||
      (index > 0 &&
        !ticketProjectionsDifferOnlyByDependencies(
          refresh.priorProjection,
          history[index - 1]!.refreshedProjection,
        ))
    ) {
      throw new Error(`recurring-asset grant refresh chain is invalid: ${ticket.id}`);
    }
  }
  if (
    !ticketProjectionsDifferOnlyByDependencies(
      ticketImmutableProjection(ticket),
      history.at(-1)!.refreshedProjection,
    )
  ) {
    throw new Error(`recurring-asset ticket differs from its latest grant refresh: ${ticket.id}`);
  }
}

function assertControlDefinitionProjection(
  ticket: Readonly<TicketRecord>,
  authority: Readonly<CompilerControlTicketAuthority>,
): void {
  const definition = authority.definition;
  const projection = authority.projection;
  const expectedPriority = -(
    definition.rule_priority * 1_000 +
    definition.operation_dispatch_priority
  );
  if (
    definition.id !== projection.id ||
    definition.operation_registry_id !== projection.operationId ||
    definition.title !== projection.title ||
    expectedPriority !== projection.priority ||
    canonicalHash(definition.target_node_ids) !== canonicalHash(projection.targetNodeIds) ||
    canonicalHash(definition.scope.read_node_ids) !== canonicalHash(projection.readNodeIds) ||
    canonicalHash(definition.scope.write_node_ids) !== canonicalHash(projection.writeNodeIds) ||
    canonicalHash(definition.scope.read_paths) !== canonicalHash(projection.readPaths) ||
    canonicalHash(definition.scope.write_paths) !== canonicalHash(projection.writePaths) ||
    (definition.review_failure_reopen_from ?? null) !== projection.reviewFailureReopenFrom ||
    (definition.review_failure_reopen_from === undefined ? null : 1) !==
      projection.reviewReworkLimit ||
    definition.workflow.length !== projection.steps.length
  ) {
    throw new Error(`control-ticket definition differs from immutable projection: ${ticket.id}`);
  }
  for (const [index, step] of definition.workflow.entries()) {
    const projected = projection.steps[index]!;
    const semantic = authority.workflow.steps[index];
    if (
      projected.id !== step.id ||
      projected.title !== controlAuthorityStepTitle(step.id) ||
      projected.personaId !== step.persona_id ||
      projected.kind !== step.kind ||
      canonicalHash(projected.dependsOn) !== canonicalHash(step.depends_on) ||
      canonicalHash(projected.readNodeIds) !== canonicalHash(step.read_node_ids ?? []) ||
      canonicalHash(projected.writeNodeIds) !== canonicalHash(step.write_node_ids ?? []) ||
      canonicalHash(projected.readPaths) !== canonicalHash(step.read_paths ?? []) ||
      canonicalHash(projected.writePaths) !== canonicalHash(step.write_paths ?? []) ||
      projected.validationAction !== (step.validation_action ?? null) ||
      projected.executionPolicyBinding?.stepId !== step.id ||
      projected.executionPolicyBinding?.stepSha256 !== semantic?.sha256
    ) {
      throw new Error(
        `control-ticket step differs from compiler definition: ${ticket.id}/${step.id}`,
      );
    }
  }
}

function controlAuthorityTitle(prefix: string, summary: string): string {
  const firstLine = summary.trim().split(/\r?\n/u)[0] ?? summary.trim();
  return `${prefix}: ${firstLine}`.slice(0, 240);
}

function controlAuthorityStepTitle(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function terminalSuccessProofMatchesRun(
  run: Readonly<RunRecord>,
  proof: Readonly<TerminalSuccessSettlementProof>,
  ticketId: string,
): boolean {
  if (canonicalHash(run.terminalSuccessProofs?.[proof.sha256]) !== canonicalHash(proof))
    return false;
  const attempt = run.attempts[proof.attemptId];
  const ticket = run.tickets[ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === proof.stepId);
  return (
    proof.runId === run.id &&
    proof.ticketId === ticketId &&
    step !== undefined &&
    step.attemptIds.includes(proof.attemptId) &&
    attempt !== undefined &&
    attempt.ticketId === ticketId &&
    attempt.stepId === proof.stepId &&
    (attempt.status === "terminal_accepted" || attempt.status === "completed") &&
    attempt.terminalPolicy?.sha256 === proof.terminalPolicySha256 &&
    attempt.terminalOutputSha256 === proof.terminalOutputSha256
  );
}

export interface TerminalFailureBindingRecord {
  stepId: string;
  attemptId: string;
  launchSpecHash: Sha256Digest;
  terminalPolicySha256: Sha256Digest;
  terminalOutputSha256: Sha256Digest;
  failureSettlementSha256: Sha256Digest;
  failureProof: TerminalFailureSettlementProof;
  sha256: Sha256Digest;
}

export function terminalFailureBindingsForTicket(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
): ReadonlyMap<string, TerminalFailureBindingRecord> {
  const bindings = new Map<string, TerminalFailureBindingRecord>();
  if (ticket.executionPolicyBinding === undefined) return bindings;
  // Only live action authority may create a new resolver/retry. Historical retry and resolver
  // records carry their complete immutable proof and never depend on evictable archive rows.
  const proofs = Object.values(run.actionExecutions ?? {})
    .map((action) => createTerminalFailureSettlementProof(run, action))
    .filter((proof): proof is TerminalFailureSettlementProof => proof !== undefined);
  for (const step of ticket.steps) {
    if (step.executionPolicyBinding === undefined) continue;
    for (const attemptId of step.attemptIds) {
      const attempt = run.attempts[attemptId];
      if (
        attempt === undefined ||
        attempt.ticketId !== ticket.id ||
        attempt.stepId !== step.id ||
        attempt.terminalPolicy === undefined ||
        attempt.terminalOutputSha256 === undefined
      )
        continue;
      const matching = proofs.filter(
        (proof) =>
          proof.runId === run.id &&
          proof.ticketId === ticket.id &&
          proof.stepId === step.id &&
          proof.attemptId === attempt.id &&
          proof.terminalPolicySha256 === attempt.terminalPolicy!.sha256 &&
          proof.terminalOutputSha256 === attempt.terminalOutputSha256,
      );
      if (matching.length !== 1) continue;
      const binding = terminalFailureBindingFromProof(run, ticket, matching[0]!);
      if (binding !== undefined) bindings.set(attemptId, binding);
    }
  }
  return bindings;
}

export function terminalFailureBindingFromProof(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
  proof: Readonly<TerminalFailureSettlementProof>,
): TerminalFailureBindingRecord | undefined {
  assertTerminalFailureSettlementProof(proof);
  if (canonicalHash(run.terminalFailureProofs?.[proof.sha256]) !== canonicalHash(proof))
    return undefined;
  const step = ticket.steps.find((candidate) => candidate.id === proof.stepId);
  const attempt = run.attempts[proof.attemptId];
  if (
    proof.runId !== run.id ||
    proof.ticketId !== ticket.id ||
    ticket.executionPolicyBinding === undefined ||
    step?.executionPolicyBinding === undefined ||
    !step.attemptIds.includes(proof.attemptId) ||
    attempt === undefined ||
    attempt.ticketId !== ticket.id ||
    attempt.stepId !== step.id ||
    attempt.launchSpecHash === undefined ||
    attempt.terminalPolicy?.sha256 !== proof.terminalPolicySha256 ||
    attempt.terminalOutputSha256 !== proof.terminalOutputSha256
  )
    return undefined;
  const material = {
    protocol: "koni.terminal-failure-binding.v1",
    runId: run.id,
    ticketId: ticket.id,
    ticketBindingSha256: ticket.executionPolicyBinding.sha256,
    stepId: step.id,
    stepBindingSha256: step.executionPolicyBinding.sha256,
    attemptId: attempt.id,
    launchSpecHash: attempt.launchSpecHash,
    terminalPolicySha256: attempt.terminalPolicy.sha256,
    terminalOutputSha256: attempt.terminalOutputSha256,
  };
  return {
    stepId: step.id,
    attemptId: attempt.id,
    launchSpecHash: attempt.launchSpecHash,
    terminalPolicySha256: attempt.terminalPolicy.sha256,
    terminalOutputSha256: attempt.terminalOutputSha256,
    failureSettlementSha256: proof.sha256,
    failureProof: structuredClone(proof),
    sha256: canonicalHash(material),
  };
}

/**
 * Validate the complete live/archive state transition and return the exact artifact writes which
 * must accompany it in the same file transaction. This is intentionally independent of caller
 * intent: archive state can only be derived from the prior authoritative run record.
 */
export function validateRunActionArchiveMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
): RunActionArchiveMutationProjection {
  const priorRows = previous.actionExecutionArchive ?? [];
  const currentRows = next.actionExecutionArchive ?? [];
  const priorSegments = previous.actionExecutionArchiveSegments ?? [];
  const currentSegments = next.actionExecutionArchiveSegments ?? [];

  if (
    currentSegments.length < priorSegments.length ||
    currentSegments.length > priorSegments.length + 1
  ) {
    throw new Error("run action archive segments are not append-only");
  }
  for (let index = 0; index < priorSegments.length; index += 1) {
    if (canonicalHash(priorSegments[index]) !== canonicalHash(currentSegments[index])) {
      throw new Error("run action archive segment authority was replaced");
    }
  }

  const removedActions = Object.values(previous.actionExecutions ?? {})
    .filter((action) => next.actionExecutions?.[action.invocationId] === undefined)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.invocationId.localeCompare(right.invocationId),
    );
  const derived = removedActions.map((action) => deriveRunActionExecutionArchive(previous, action));
  for (const { row } of derived) {
    const proof = row.terminalFailureProof;
    if (
      proof !== undefined &&
      canonicalHash(next.terminalFailureProofs?.[proof.sha256]) !== canonicalHash(proof)
    ) {
      throw new Error(
        `run archived failure without non-evictable proof authority: ${row.invocationId}`,
      );
    }
  }

  const combinedRows = [...priorRows, ...derived.map(({ row }) => row)];
  const addedSegment = currentSegments[priorSegments.length];
  const writes: RunActionArchiveArtifactWrite[] = derived.map(({ row, bytes }) => ({
    path: row.artifactPath,
    bytes,
  }));

  if (addedSegment === undefined) {
    if (canonicalHash(currentRows) !== canonicalHash(combinedRows)) {
      throw new Error("run action archive is not the exact append-only live-action projection");
    }
  } else {
    if (combinedRows.length <= 1_024 || currentRows.length !== 256) {
      throw new Error("run action archive segment did not compact the canonical retention prefix");
    }
    const removedCount = combinedRows.length - currentRows.length;
    const compacted = combinedRows.slice(0, removedCount);
    const retained = combinedRows.slice(removedCount);
    if (canonicalHash(retained) !== canonicalHash(currentRows)) {
      throw new Error("run action archive segment did not remove one exact prefix");
    }
    const expected = deriveRunActionExecutionArchiveSegment(next.id, compacted);
    if (canonicalHash(expected.segment) !== canonicalHash(addedSegment)) {
      throw new Error("run action archive segment differs from the canonical removed prefix");
    }
    writes.push({ path: expected.segment.artifactPath, bytes: expected.bytes });
  }

  const archivedIds = new Set(currentRows.map((row) => row.invocationId));
  for (const invocationId of Object.keys(next.actionExecutions ?? {})) {
    if (archivedIds.has(invocationId)) {
      throw new Error(`run action identity overlaps live and archive state: ${invocationId}`);
    }
  }
  return { writes };
}

function normalizedAttemptTicketExecutionEpoch(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
): number | undefined {
  if (attempt.ticketExecutionEpoch !== undefined) return attempt.ticketExecutionEpoch;
  const ticket = run.tickets[attempt.ticketId];
  if (ticket === undefined) return undefined;
  if (ticket.executionEpoch !== undefined) return 0;
  const cycle =
    ticket.gitCycleId === undefined ? undefined : run.git.ticketCycles[ticket.gitCycleId];
  return (cycle?.ordinal ?? 1) > 1 ? undefined : 0;
}

function normalizedAttemptReviewReworkOrdinal(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
): number | undefined {
  const ticket = run.tickets[attempt.ticketId];
  const rework = ticket?.reviewReworks?.at(-1);
  if (ticket === undefined || rework === undefined || attempt.startedAt === undefined) {
    return undefined;
  }
  const byId = new Map(ticket.steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const dependsOnReopenedStep = (stepId: string): boolean => {
    if (stepId === rework.reopenFromStepId) return true;
    if (visited.has(stepId)) return false;
    visited.add(stepId);
    return (byId.get(stepId)?.dependsOn ?? []).some(dependsOnReopenedStep);
  };
  const applies =
    rework.scope === "review_only"
      ? attempt.stepId === rework.reopenFromStepId
      : dependsOnReopenedStep(attempt.stepId);
  return applies && attempt.startedAt >= rework.openedAt ? rework.ordinal : undefined;
}

export const MAX_TOKEN_BUDGET_AUTO_RECOVERIES_PER_SLICE = 1;
export const MAX_TOKEN_BUDGET_AUTO_RECOVERIES_PER_TICKET_STEP = 3;

export function tokenBudgetRecoverySliceForAttempt(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
): { ticketExecutionEpoch: number | undefined; reviewReworkOrdinal: number | undefined } {
  return {
    ticketExecutionEpoch: normalizedAttemptTicketExecutionEpoch(run, attempt),
    reviewReworkOrdinal: normalizedAttemptReviewReworkOrdinal(run, attempt),
  };
}

function isTokenBudgetFailureRecord(attempt: Readonly<AgentAttemptRecord> | undefined): boolean {
  return (
    attempt !== undefined &&
    new Set(["failed", "aborted"]).has(attempt.status) &&
    /^(?:input|output|cache-read|cache-write|new-token|cache-inclusive) token budget (?:exceeded|exhausted)$/u.test(
      attempt.error ?? "",
    )
  );
}

export function tokenBudgetRecoveryAuthorityCounts(
  run: Readonly<RunRecord>,
  failed: Readonly<AgentAttemptRecord>,
): { slice: number; total: number } {
  const recovered = new Map<
    string,
    { ticketExecutionEpoch: number | undefined; reviewReworkOrdinal: number | undefined }
  >();
  for (const attempt of Object.values(run.attempts)) {
    if (attempt.ticketId !== failed.ticketId || attempt.stepId !== failed.stepId) continue;
    if (attempt.tokenBudgetRecovery !== undefined && isTokenBudgetFailureRecord(attempt)) {
      recovered.set(attempt.id, {
        ticketExecutionEpoch: attempt.tokenBudgetRecovery.ticketExecutionEpoch,
        reviewReworkOrdinal: attempt.tokenBudgetRecovery.reviewReworkOrdinal,
      });
    }
    // Explicit compatibility fallback for pre-marker records: immutable recovery lineage binds
    // the exact failed parent without trusting display activity or wall-clock ordering.
    const parentId = attempt.lineage?.parentAttemptId;
    const parent = parentId === undefined ? undefined : run.attempts[parentId];
    if (
      attempt.lineage?.reason === "recovery" &&
      parent !== undefined &&
      parent.ticketId === failed.ticketId &&
      parent.stepId === failed.stepId &&
      isTokenBudgetFailureRecord(parent)
    ) {
      const parentSlice = tokenBudgetRecoverySliceForAttempt(run, parent);
      const childSlice = tokenBudgetRecoverySliceForAttempt(run, attempt);
      if (
        childSlice.ticketExecutionEpoch === parentSlice.ticketExecutionEpoch &&
        childSlice.reviewReworkOrdinal === parentSlice.reviewReworkOrdinal
      ) {
        recovered.set(parent.id, parentSlice);
      }
    }
  }
  const expected = tokenBudgetRecoverySliceForAttempt(run, failed);
  return {
    slice: [...recovered.values()].filter(
      (slice) =>
        slice.ticketExecutionEpoch === expected.ticketExecutionEpoch &&
        slice.reviewReworkOrdinal === expected.reviewReworkOrdinal,
    ).length,
    total: recovered.size,
  };
}

function assertTokenBudgetRecoveryMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
): void {
  for (const [attemptId, priorAttempt] of Object.entries(previous.attempts)) {
    const currentAttempt = next.attempts[attemptId];
    const priorRecovery = priorAttempt.tokenBudgetRecovery;
    const currentRecovery = currentAttempt?.tokenBudgetRecovery;
    if (priorRecovery !== undefined) {
      if (
        currentRecovery === undefined ||
        canonicalHash(currentRecovery) !== canonicalHash(priorRecovery)
      ) {
        throw new Error(`run rewrote token-budget recovery authority: ${attemptId}`);
      }
      continue;
    }
    if (currentAttempt === undefined || currentRecovery === undefined) continue;
    assertAttemptRecord(attemptId, currentAttempt);
    const priorTicket = previous.tickets[priorAttempt.ticketId];
    const currentTicket = next.tickets[priorAttempt.ticketId];
    const priorStep = priorTicket?.steps.find((step) => step.id === priorAttempt.stepId);
    const currentStep = currentTicket?.steps.find((step) => step.id === priorAttempt.stepId);
    const { tokenBudgetRecovery: _currentRecovery, ...currentAttemptWithoutRecovery } =
      currentAttempt;
    const recoveryCounts = tokenBudgetRecoveryAuthorityCounts(previous, priorAttempt);
    if (
      !new Set(["failed", "aborted"]).has(priorAttempt.status) ||
      !/^(?:input|output|cache-read|cache-write|new-token|cache-inclusive) token budget (?:exceeded|exhausted)$/u.test(
        priorAttempt.error ?? "",
      ) ||
      priorAttempt.terminalAcceptedAt !== undefined ||
      priorAttempt.terminalOutputSha256 !== undefined ||
      (priorAttempt.authorityProviderRequests ?? []).some(
        (request) => request.settledAt === undefined && request.retirement === undefined,
      ) ||
      recoveryCounts.slice >= MAX_TOKEN_BUDGET_AUTO_RECOVERIES_PER_SLICE ||
      recoveryCounts.total >= MAX_TOKEN_BUDGET_AUTO_RECOVERIES_PER_TICKET_STEP ||
      currentRecovery.recoveredAt !== next.updatedAt ||
      currentRecovery.ticketExecutionEpoch !==
        normalizedAttemptTicketExecutionEpoch(previous, priorAttempt) ||
      currentRecovery.reviewReworkOrdinal !==
        normalizedAttemptReviewReworkOrdinal(previous, priorAttempt) ||
      canonicalHash(currentAttemptWithoutRecovery) !== canonicalHash(priorAttempt) ||
      priorTicket?.status !== "blocked" ||
      priorStep?.status !== "failed" ||
      priorStep.attemptIds.at(-1) !== attemptId ||
      currentTicket?.status !== "queued" ||
      currentStep?.status !== "pending" ||
      currentStep.attemptIds.at(-1) !== attemptId ||
      currentTicket.executionEpoch !== priorTicket.executionEpoch
    ) {
      throw new Error(
        `run added token-budget recovery without exact failed assignment: ${attemptId}`,
      );
    }
  }
  for (const [attemptId, currentAttempt] of Object.entries(next.attempts)) {
    if (
      currentAttempt.tokenBudgetRecovery !== undefined &&
      previous.attempts[attemptId] === undefined
    ) {
      throw new Error(`run added token-budget recovery to a new attempt: ${attemptId}`);
    }
  }
}

function recurringAssetProjectionDefinitionMaterial(
  projection: Readonly<TicketImmutableProjection>,
): unknown {
  return {
    ...projection,
    dependencyIds: [],
    readNodeIds: [],
    writeNodeIds: [],
    readPaths: [],
    writePaths: [],
    steps: projection.steps.map((step) => ({
      ...step,
      readNodeIds: [],
      writeNodeIds: [],
      readPaths: [],
      writePaths: [],
    })),
    sha256: "",
  };
}

function assignmentSemanticCompilerStep(
  action: Readonly<RunActionExecutionRecord>,
): Readonly<RunActionExecutionRecord["plan"]["recipe"][number]> | undefined {
  for (const primitive of ["check.run", "review.validate", "rules.evaluate", "project.validate"]) {
    const step = action.plan.recipe.find((candidate) => candidate.primitive === primitive);
    if (step !== undefined) return step;
  }
  return undefined;
}

function assertRecurringAssetGrantRefreshMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
): void {
  for (const [ticketId, currentTicket] of Object.entries(next.tickets)) {
    const priorTicket = previous.tickets[ticketId];
    const priorHistory = priorTicket?.executionControl?.recurringAssetGrantRefreshes ?? [];
    const currentHistory = currentTicket.executionControl?.recurringAssetGrantRefreshes ?? [];
    if (
      currentHistory.length < priorHistory.length ||
      canonicalHash(currentHistory.slice(0, priorHistory.length)) !== canonicalHash(priorHistory)
    ) {
      throw new Error(`ticket rewrote recurring-asset grant refresh authority: ${ticketId}`);
    }
    const added = currentHistory.slice(priorHistory.length);
    if (added.length === 0) continue;
    if (added.length !== 1 || priorTicket === undefined) {
      throw new Error(
        `ticket added ambiguous recurring-asset grant refresh authority: ${ticketId}`,
      );
    }
    const refresh = added[0]!;
    const priorProjection = ticketImmutableProjection(priorTicket);
    const currentProjection = ticketImmutableProjection(currentTicket);
    const priorCycle =
      priorTicket.gitCycleId === undefined
        ? undefined
        : previous.git.ticketCycles[priorTicket.gitCycleId];
    const priorSettled =
      (priorTicket.status === "completed" && priorCycle?.status === "retired") ||
      (priorTicket.status === "cancelled" &&
        priorTicket.blocker ===
          "Current compiler predicate no longer applies after prior execution" &&
        priorTicket.gitCycleId === undefined &&
        priorTicket.worktreePath === undefined &&
        priorTicket.branch === undefined &&
        priorTicket.steps.length > 0 &&
        priorTicket.steps.every((step) => step.status === "skipped"));
    const priorAction = previous.actionExecutions?.[refresh.actionInvocationId];
    const currentAction = next.actionExecutions?.[refresh.actionInvocationId];
    const applicationTicket =
      currentAction?.boundary.ticketId === undefined
        ? undefined
        : next.tickets[currentAction.boundary.ticketId];
    const applicationAuthority = applicationTicket?.executionControl?.controlTicketAuthority;
    const applicationCausal =
      applicationAuthority?.causal.role === "approved_application"
        ? applicationAuthority.causal
        : undefined;
    const applicationStep = applicationAuthority?.definition.workflow.find(
      (step) => step.id === currentAction?.boundary.stepId,
    );
    const semanticCompilerStep =
      currentAction === undefined ? undefined : assignmentSemanticCompilerStep(currentAction);
    const refreshEffect =
      currentAction === undefined || semanticCompilerStep === undefined
        ? undefined
        : currentAction.effects[
            `${currentAction.invocationId}:recipe:${semanticCompilerStep.id}:${currentAction.plan.sha256}`
          ];
    if (
      priorTicket.operationId !== "asset-resolution.asset.implement-asset" ||
      currentTicket.operationId !== priorTicket.operationId ||
      !priorSettled ||
      currentTicket.status !== "queued" ||
      currentTicket.executionEpoch !== (priorTicket.executionEpoch ?? 0) + 1 ||
      currentTicket.gitCycleId !== undefined ||
      currentTicket.worktreePath !== undefined ||
      currentTicket.branch !== undefined ||
      currentTicket.steps.length === 0 ||
      currentTicket.steps.some((step) => step.status !== "pending") ||
      refresh.runId !== next.id ||
      refresh.ticketId !== ticketId ||
      refresh.configurationSha256 !== next.compiledConfigHash ||
      refresh.priorGraphHash !== previous.graphHash ||
      refresh.priorGraphRevision !== previous.graphRevision ||
      refresh.nextGraphHash !== next.graphHash ||
      refresh.nextGraphRevision !== next.graphRevision ||
      refresh.priorProjectionSha256 !== priorProjection.sha256 ||
      canonicalHash(refresh.priorProjection) !== canonicalHash(priorProjection) ||
      refresh.nextProjectionSha256 !== currentProjection.sha256 ||
      canonicalHash(refresh.refreshedProjection) !== canonicalHash(currentProjection) ||
      refresh.priorExecutionEpoch !== (priorTicket.executionEpoch ?? 0) ||
      refresh.nextExecutionEpoch !== currentTicket.executionEpoch ||
      refresh.recordedAt !== next.updatedAt ||
      canonicalHash(recurringAssetProjectionDefinitionMaterial(priorProjection)) !==
        canonicalHash(recurringAssetProjectionDefinitionMaterial(currentProjection)) ||
      priorAction === undefined ||
      currentAction === undefined ||
      priorAction.boundary.kind !== "assignment_validation" ||
      priorAction.boundary.sha256 !== refresh.actionBoundarySha256 ||
      currentAction.boundary.sha256 !== refresh.actionBoundarySha256 ||
      currentAction.boundary.ticketId !== applicationTicket?.id ||
      applicationAuthority?.role !== "approved_application" ||
      applicationCausal === undefined ||
      applicationStep?.graph_mutation === "forbidden" ||
      semanticCompilerStep === undefined ||
      !applicationCausal.materialization.targetNodeIds.some((nodeId) =>
        priorProjection.targetNodeIds.includes(nodeId),
      ) ||
      previous.graphHash === next.graphHash ||
      priorAction.semanticResult !== undefined ||
      currentAction.semanticResult?.kind !== "assignment" ||
      currentAction.semanticResult.status !== "completed" ||
      !currentAction.semanticResult.recurringAssetGrantRefreshSha256s?.includes(refresh.sha256) ||
      refreshEffect === undefined ||
      priorAction.effects[refreshEffect.effectKey] !== undefined ||
      !isRecord(refreshEffect.output) ||
      !Array.isArray(refreshEffect.output.recurringAssetGrantRefreshSha256s) ||
      !refreshEffect.output.recurringAssetGrantRefreshSha256s.includes(refresh.sha256)
    ) {
      throw new Error(`ticket added unauthenticated recurring-asset grant refresh: ${ticketId}`);
    }
  }
}

/** Enforce append-only control evidence and immutable cross-ticket identities across one CAS. */
export function assertRunExecutionControlMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
  previousArchivedActions: ReadonlyMap<string, Readonly<RunActionExecutionRecord>> = new Map(),
): void {
  assertPlanningSessionMutation(previous.planningSession, next.planningSession);
  assertTokenBudgetRecoveryMutation(previous, next);
  assertRecurringAssetGrantRefreshMutation(previous, next);
  // This transition guard is an authority boundary in its own right. Validate the successor's
  // complete cross-ticket graph here so direct CAS callers cannot bypass raw-load validation by
  // introducing a structurally self-hashed but causally substituted control ticket.
  assertRunExecutionControlGraph(next);
  validateRunActionArchiveMutation(previous, next);
  for (const [ticketId, priorTicket] of Object.entries(previous.tickets)) {
    const prior = priorTicket.executionControl;
    if (prior === undefined) continue;
    const current = next.tickets[ticketId]?.executionControl;
    if (current === undefined) {
      if (Object.keys(prior).length === 1 && prior.sourceHold !== undefined) continue;
      throw new Error(`ticket discarded execution-control authority: ${ticketId}`);
    }
    assertImmutableControlField(
      ticketId,
      "proposalRequest",
      prior.proposalRequest,
      current.proposalRequest,
    );
    assertImmutableControlField(
      ticketId,
      "controlTicketAuthority",
      prior.controlTicketAuthority,
      current.controlTicketAuthority,
    );
    if (
      prior.controlTicketAuthority !== undefined &&
      canonicalHash(ticketImmutableProjection(priorTicket)) !==
        canonicalHash(ticketImmutableProjection(next.tickets[ticketId]!))
    ) {
      throw new Error(`ticket changed immutable compiler control-ticket projection: ${ticketId}`);
    }
    assertImmutableControlField(
      ticketId,
      "terminalRecovery",
      prior.terminalRecovery,
      current.terminalRecovery,
    );
    assertImmutableControlField(
      ticketId,
      "terminalResolverTerminalProof",
      prior.terminalResolverTerminalProof,
      current.terminalResolverTerminalProof,
    );
    assertImmutableControlField(
      ticketId,
      "sourceProposalTicketId",
      prior.sourceProposalTicketId,
      current.sourceProposalTicketId,
    );
    assertImmutableControlField(
      ticketId,
      "approvedApplicationSha256",
      prior.approvedApplicationSha256,
      current.approvedApplicationSha256,
    );
    assertImmutableControlField(
      ticketId,
      "approvedMaterialization",
      prior.approvedMaterialization,
      current.approvedMaterialization,
    );
    assertImmutableControlField(
      ticketId,
      "approvedApplicationTicketAuthority",
      prior.approvedApplicationTicketAuthority,
      current.approvedApplicationTicketAuthority,
    );
    if (
      prior.sourceHold !== undefined &&
      current.sourceHold !== undefined &&
      canonicalHash(prior.sourceHold) !== canonicalHash(current.sourceHold)
    ) {
      throw new Error(`ticket changed an active proposal source hold: ${ticketId}`);
    }
    if (
      prior.proposalApprovalSha256 !== undefined &&
      current.proposalApprovalSha256 !== prior.proposalApprovalSha256
    ) {
      throw new Error(`ticket changed active proposal approval authority: ${ticketId}`);
    }
    if (
      prior.proposalDecision !== undefined &&
      (current.proposalDecision === undefined ||
        canonicalHash(prior.proposalDecision) !== canonicalHash(current.proposalDecision))
    ) {
      throw new Error(`ticket changed active proposal decision authority: ${ticketId}`);
    }
    if (prior.proposalDisposition !== undefined) {
      const permittedMaterialization =
        prior.proposalDisposition.kind === "approved" &&
        (current.proposalDisposition?.kind === "application" ||
          current.proposalDisposition?.kind === "no_op");
      if (
        !permittedMaterialization &&
        (current.proposalDisposition === undefined ||
          canonicalHash(prior.proposalDisposition) !== canonicalHash(current.proposalDisposition))
      ) {
        throw new Error(`ticket changed terminal proposal disposition: ${ticketId}`);
      }
    }
    assertAppendOnlyControlEvents(
      ticketId,
      "proposal decision history",
      prior.proposalDecisionHistory ?? [],
      current.proposalDecisionHistory ?? [],
    );
    assertAppendOnlyControlEvents(
      ticketId,
      "terminal resolver retry requests",
      prior.terminalResolverRetryRequests ?? [],
      current.terminalResolverRetryRequests ?? [],
    );
    for (const request of (current.terminalResolverRetryRequests ?? []).slice(
      (prior.terminalResolverRetryRequests ?? []).length,
    )) {
      const indexed = previous.terminalFailureProofs?.[request.failureProof.sha256];
      // A failed resolver remains valid retry authority after bounded archive compaction, but
      // only when the store has authenticated the complete immutable v2 action artifact. The
      // non-evictable proof index alone is deliberately insufficient: it identifies the proof,
      // while the live or archive-backed action proves the settlement that created it.
      const action =
        previous.actionExecutions?.[request.failureProof.actionInvocationId] ??
        previousArchivedActions.get(request.failureProof.actionInvocationId);
      const exact =
        action === undefined ? undefined : createTerminalFailureSettlementProof(previous, action);
      if (
        indexed === undefined ||
        exact === undefined ||
        canonicalHash(indexed) !== canonicalHash(request.failureProof) ||
        canonicalHash(exact) !== canonicalHash(request.failureProof)
      ) {
        throw new Error(`ticket added resolver retry without prior failed settlement: ${ticketId}`);
      }
    }
    assertNewProposalDecisionAuthorities(
      previous,
      next,
      ticketId,
      prior.proposalDecisionHistory ?? [],
      current.proposalDecisionHistory ?? [],
    );
  }
  for (const [ticketId, nextTicket] of Object.entries(next.tickets)) {
    const priorTicket = previous.tickets[ticketId];
    if (priorTicket === undefined) {
      // A store normally validates the complete successor record before this transition check,
      // but the CAS authority boundary must be independently closed: a newly introduced control
      // ticket may never rely on caller ordering to validate its compiler projection and causal
      // preimage.
      assertCompilerControlTicketForRun(next, nextTicket);
      const history = nextTicket.executionControl?.proposalDecisionHistory ?? [];
      assertNewProposalDecisionAuthorities(previous, next, ticketId, [], history);
      const authority = nextTicket.executionControl?.controlTicketAuthority;
      if (authority?.role === "proposal") {
        const causal = authority.causal;
        if (causal.role !== "proposal") {
          throw new Error(`proposal has mismatched causal authority: ${ticketId}`);
        }
        const proof = causal.sourceTerminalProof;
        const action = next.actionExecutions?.[proof.actionInvocationId];
        const exact =
          action === undefined ? undefined : createTerminalSuccessSettlementProof(next, action);
        const source = next.tickets[causal.publication.sourceTicketId];
        if (
          exact === undefined ||
          canonicalHash(exact) !== canonicalHash(proof) ||
          source?.executionControl?.sourceHold?.proposalTicketId !== ticketId ||
          source.executionControl.sourceHold.requestSha256 !== causal.publication.requestSha256
        ) {
          throw new Error(
            `run admitted proposal without exact same-CAS source settlement and hold: ${ticketId}`,
          );
        }
      }
    }
    const recovery = nextTicket.executionControl?.terminalRecovery;
    const priorRecovery = priorTicket?.executionControl?.terminalRecovery;
    if (recovery !== undefined && priorRecovery === undefined) {
      const sourceAction =
        previous.actionExecutions?.[recovery.sourceFailureProof.actionInvocationId];
      const expectedProof =
        sourceAction === undefined
          ? undefined
          : createTerminalFailureSettlementProof(previous, sourceAction);
      if (
        expectedProof === undefined ||
        canonicalHash(expectedProof) !== canonicalHash(recovery.sourceFailureProof)
      ) {
        throw new Error(`run admitted resolver without exact live source failure: ${ticketId}`);
      }
    }
    const terminalProof = nextTicket.executionControl?.terminalResolverTerminalProof;
    const priorTerminalProof = priorTicket?.executionControl?.terminalResolverTerminalProof;
    if (terminalProof !== undefined && priorTerminalProof === undefined) {
      const terminalAction = next.actionExecutions?.[terminalProof.actionInvocationId];
      const expectedProof =
        terminalAction === undefined
          ? undefined
          : createTerminalSuccessSettlementProof(next, terminalAction);
      if (
        expectedProof === undefined ||
        canonicalHash(expectedProof) !== canonicalHash(terminalProof)
      ) {
        throw new Error(
          `run added resolver terminal proof without exact live settlement: ${ticketId}`,
        );
      }
    }
    const materialization = nextTicket.executionControl?.approvedMaterialization;
    const priorMaterialization = priorTicket?.executionControl?.approvedMaterialization;
    if (materialization !== undefined && priorMaterialization === undefined) {
      for (const proof of [
        materialization.proposalTerminalProof,
        materialization.reviewTerminalProof,
      ]) {
        const action = previous.actionExecutions?.[proof.actionInvocationId];
        const expected =
          action === undefined ? undefined : createTerminalSuccessSettlementProof(previous, action);
        if (expected === undefined || canonicalHash(expected) !== canonicalHash(proof)) {
          throw new Error(
            `run materialized proposal without exact live terminal proof: ${ticketId}`,
          );
        }
      }
    }
  }
  for (const [invocationId, prior] of Object.entries(previous.actionExecutions ?? {})) {
    const current = next.actionExecutions?.[invocationId];
    if (current === undefined) {
      const archived =
        next.actionExecutionArchive?.some((entry) => entry.invocationId === invocationId) ?? false;
      if (!archived || prior.settledAt === undefined) {
        throw new Error(`run discarded unsettled action authority: ${invocationId}`);
      }
      continue;
    }
    if (
      prior.settlement !== undefined &&
      canonicalHash(prior.settlement) !== canonicalHash(current.settlement)
    ) {
      throw new Error(`run rewrote action settlement authority: ${invocationId}`);
    }
    if (
      prior.settledAt === undefined &&
      current.settledAt !== undefined &&
      current.settlement === undefined
    ) {
      throw new Error(`run settled action without typed disposition: ${invocationId}`);
    }
    if (
      prior.recoveryInvocationId === undefined &&
      current.recoveryInvocationId !== undefined &&
      (prior.settledAt !== undefined ||
        new Set(["pausing", "paused", "deleting", "deleted"]).has(previous.lifecycle.phase))
    ) {
      throw new Error(`run admitted recovery after parent settlement: ${invocationId}`);
    }
  }
  for (const [sha256, prior] of Object.entries(previous.terminalFailureProofs ?? {})) {
    const current = next.terminalFailureProofs?.[sha256];
    if (current === undefined || canonicalHash(current) !== canonicalHash(prior)) {
      throw new Error(`run rewrote terminal failure proof authority: ${sha256}`);
    }
  }
  for (const [sha256, proof] of Object.entries(next.terminalFailureProofs ?? {})) {
    if (previous.terminalFailureProofs?.[sha256] !== undefined) continue;
    const action = next.actionExecutions?.[proof.actionInvocationId];
    const exact =
      action === undefined ? undefined : createTerminalFailureSettlementProof(next, action);
    if (exact === undefined || canonicalHash(exact) !== canonicalHash(proof)) {
      throw new Error(`run added terminal failure proof without live failed settlement: ${sha256}`);
    }
  }
  for (const [sha256, prior] of Object.entries(previous.terminalSuccessProofs ?? {})) {
    const current = next.terminalSuccessProofs?.[sha256];
    if (current === undefined || canonicalHash(current) !== canonicalHash(prior)) {
      throw new Error(`run rewrote terminal success proof authority: ${sha256}`);
    }
  }
  for (const [sha256, proof] of Object.entries(next.terminalSuccessProofs ?? {})) {
    if (previous.terminalSuccessProofs?.[sha256] !== undefined) continue;
    const action = next.actionExecutions?.[proof.actionInvocationId];
    const exact =
      action === undefined ? undefined : createTerminalSuccessSettlementProof(next, action);
    if (exact === undefined || canonicalHash(exact) !== canonicalHash(proof)) {
      throw new Error(
        `run added terminal success proof without live completed settlement: ${sha256}`,
      );
    }
  }
}

function assertPlanningSessionMutation(
  previous: Readonly<PlanningSessionRecord> | undefined,
  next: Readonly<PlanningSessionRecord> | undefined,
): void {
  if (previous === undefined) return;
  if (next === undefined) throw new Error("run discarded its planning session authority");
  if (
    previous.protocol !== next.protocol ||
    previous.attemptId !== next.attemptId ||
    previous.sessionId !== next.sessionId ||
    next.currentRevision < previous.currentRevision ||
    next.currentRevision > previous.currentRevision + 1
  ) {
    throw new Error("run changed its stable planning session identity or revision sequence");
  }

  for (let index = 0; index < previous.currentRevision; index += 1) {
    if (canonicalHash(previous.revisions[index]) !== canonicalHash(next.revisions[index])) {
      throw new Error(`run changed immutable planning revision ${index}`);
    }
  }

  const priorCurrent = previous.revisions[previous.currentRevision]!;
  const nextPriorCurrent = next.revisions[previous.currentRevision];
  if (nextPriorCurrent === undefined) {
    throw new Error("run discarded its current planning revision");
  }
  assertPlanningRevisionMonotonicMutation(priorCurrent, nextPriorCurrent);

  if (next.currentRevision === previous.currentRevision) {
    if (next.revisions.length !== previous.revisions.length) {
      throw new Error("run changed planning revision history without advancing its revision");
    }
    return;
  }

  if (
    next.revisions.length !== previous.revisions.length + 1 ||
    nextPriorCurrent.status !== "superseded" ||
    next.revisions[next.currentRevision]?.status !== "running"
  ) {
    throw new Error("run appended an invalid planning revision transition");
  }
}

function assertPlanningRevisionMonotonicMutation(
  previous: Readonly<PlanningRevisionRecord>,
  next: Readonly<PlanningRevisionRecord>,
): void {
  const {
    status: _previousStatus,
    planningSynthesis: _previousSynthesis,
    patchSha256: _previousPatch,
    artifactSha256: _previousArtifact,
    graphSha256: _previousGraph,
    transcriptSha256: _previousTranscript,
    checkpointPath: _previousCheckpoint,
    completedAt: _previousCompleted,
    ...immutablePrevious
  } = previous;
  const {
    status: _nextStatus,
    planningSynthesis: _nextSynthesis,
    patchSha256: _nextPatch,
    artifactSha256: _nextArtifact,
    graphSha256: _nextGraph,
    transcriptSha256: _nextTranscript,
    checkpointPath: _nextCheckpoint,
    completedAt: _nextCompleted,
    ...immutableNext
  } = next;
  if (canonicalHash(immutablePrevious) !== canonicalHash(immutableNext)) {
    throw new Error(`run changed immutable planning revision ${previous.revision}`);
  }
  if (
    previous.planningSynthesis !== undefined &&
    canonicalHash(previous.planningSynthesis) !== canonicalHash(next.planningSynthesis)
  ) {
    throw new Error(`run changed immutable planning revision ${previous.revision} synthesis`);
  }
  for (const field of [
    "patchSha256",
    "artifactSha256",
    "graphSha256",
    "transcriptSha256",
    "checkpointPath",
    "completedAt",
  ] as const) {
    const clearsFailedRevisionCompletion =
      field === "completedAt" &&
      previous.status === "failed" &&
      next.status === "running" &&
      next.completedAt === undefined;
    if (
      previous[field] !== undefined &&
      next[field] !== previous[field] &&
      !clearsFailedRevisionCompletion
    ) {
      throw new Error(`run changed immutable planning revision ${previous.revision} ${field}`);
    }
  }
  const legalTransitions: Readonly<Record<PlanningRevisionRecord["status"], readonly string[]>> = {
    running: ["running", "awaiting_review", "failed"],
    awaiting_review: ["awaiting_review", "superseded", "approved"],
    superseded: ["superseded"],
    approved: ["approved"],
    failed: ["failed", "running"],
  };
  if (!legalTransitions[previous.status].includes(next.status)) {
    throw new Error(`run changed planning revision ${previous.revision} through an invalid status`);
  }
}

function assertNewProposalDecisionAuthorities(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
  ticketId: string,
  prior: readonly NonNullable<TicketExecutionControlRecord["proposalDecision"]>[],
  current: readonly NonNullable<TicketExecutionControlRecord["proposalDecision"]>[],
): void {
  const request = next.tickets[ticketId]?.executionControl?.proposalRequest;
  for (const event of current.slice(prior.length)) {
    if (
      event.protocol !== "koni.proposal-decision-authority.v2" ||
      event.runId !== next.id ||
      event.proposalTicketId !== ticketId ||
      event.requestSha256 !== request?.requestSha256 ||
      event.actor !== "operator"
    ) {
      throw new Error(`ticket added unbound proposal decision authority: ${ticketId}`);
    }
  }
  void previous;
}

function proposalHasReleasedSourceAuthority(
  run: Readonly<RunRecord>,
  proposal: Readonly<TicketRecord>,
): boolean {
  const disposition = proposal.executionControl?.proposalDisposition;
  const request = proposal.executionControl?.proposalRequest;
  if (proposal.status === "cancelled" && disposition === undefined && request !== undefined) {
    return Object.values(run.git.ticketCycles).some(
      (cycle) =>
        cycle.ticketId === request.sourceTicketId &&
        cycle.status === "retired" &&
        cycle.supersessionSha256 === request.requestSha256 &&
        cycle.archiveRef !== undefined,
    );
  }
  if (proposal.status !== "completed" || disposition === undefined) return false;
  if (disposition.kind === "rejected" || disposition.kind === "no_op") return true;
  if (disposition.kind !== "application" || disposition.applicationTicketId === undefined)
    return false;
  const application = run.tickets[disposition.applicationTicketId];
  return (
    application?.status === "completed" &&
    application.executionControl?.sourceProposalTicketId === proposal.id &&
    application.executionControl.approvedApplicationSha256 === disposition.authoritySha256 &&
    approvedApplicationHasPublishedGitAuthority(run, application)
  );
}

/**
 * Source release is the irreversible edge of an approved application. A terminal ticket status is
 * not publication authority: its current compiler-owned cycle must be the one which actually
 * entered the run ref and was then retired. Earlier cycles may remain only as canonical
 * superseded/unintegrated audit history; supersession itself can never stand in for publication.
 */
function approvedApplicationHasPublishedGitAuthority(
  run: Readonly<RunRecord>,
  application: Readonly<TicketRecord>,
): boolean {
  const cycle =
    application.gitCycleId === undefined ? undefined : run.git.ticketCycles[application.gitCycleId];
  if (cycle === undefined || cycle.ticketId !== application.id) return false;
  const priorOwnedCycles = Object.values(run.git.ticketCycles).filter(
    (candidate) => candidate.ticketId === application.id && candidate.cycleId !== cycle.cycleId,
  );
  const priorCyclesAreSupersededAudit = priorOwnedCycles.every(
    (candidate) =>
      candidate.status === "retired" &&
      candidate.integratedRunOid === undefined &&
      candidate.squashCommitOid === undefined &&
      candidate.integratedAt === undefined &&
      candidate.retiredAt !== undefined &&
      candidate.archiveRef !== undefined &&
      candidate.supersessionSha256 !== undefined &&
      candidate.supersededAt === candidate.retiredAt,
  );
  return (
    priorCyclesAreSupersededAudit &&
    application.worktreePath === cycle.worktree &&
    application.branch === cycle.branchRef &&
    cycle.status === "retired" &&
    cycle.integratedRunOid !== undefined &&
    cycle.integratedAt !== undefined &&
    cycle.retiredAt !== undefined &&
    cycle.archiveRef === undefined &&
    cycle.supersessionSha256 === undefined &&
    cycle.supersededAt === undefined &&
    (cycle.squashCommitOid === undefined || cycle.squashCommitOid === cycle.integratedRunOid)
  );
}

function assertImmutableControlField(
  ticketId: string,
  label: string,
  previous: unknown,
  next: unknown,
): void {
  if (previous !== undefined && canonicalHash(previous) !== canonicalHash(next)) {
    throw new Error(`ticket changed immutable ${label}: ${ticketId}`);
  }
}

function assertAppendOnlyControlEvents(
  ticketId: string,
  label: string,
  previous: readonly unknown[],
  next: readonly unknown[],
): void {
  if (
    next.length < previous.length ||
    previous.some((event, index) => canonicalHash(event) !== canonicalHash(next[index]))
  ) {
    throw new Error(`ticket rewrote append-only ${label}: ${ticketId}`);
  }
}

function assertCanonicalIdArray(values: readonly string[], label: string): void {
  assertUniqueIds(values, label);
  if (values.some((value, index) => index > 0 && compareUtf8(values[index - 1]!, value) >= 0)) {
    throw new Error(`noncanonical ${label}`);
  }
}

function assertProposalDecisionEvent(
  ticketId: string,
  value: unknown,
): NonNullable<TicketExecutionControlRecord["proposalDecision"]> {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (field) =>
        ![
          "protocol",
          "runId",
          "proposalTicketId",
          "requestSha256",
          "eventId",
          "decision",
          "actor",
          "message",
          "recordedAt",
          "sha256",
        ].includes(field),
    ) ||
    !isId(value.eventId) ||
    (value.decision !== "approval" && value.decision !== "rejection") ||
    typeof value.actor !== "string" ||
    value.actor.trim().length === 0 ||
    (value.message !== undefined && typeof value.message !== "string") ||
    typeof value.recordedAt !== "string" ||
    value.recordedAt.length === 0 ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid ticket proposal decision: ${ticketId}`);
  }
  if (
    value.protocol !== "koni.proposal-decision-authority.v2" ||
    !isId(value.runId) ||
    !isId(value.proposalTicketId) ||
    !isSha256Digest(value.requestSha256) ||
    value.actor !== "operator"
  ) {
    throw new Error(`invalid current ticket proposal decision authority: ${ticketId}`);
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256) {
    throw new Error(`invalid ticket proposal decision hash: ${ticketId}`);
  }
  return value as unknown as NonNullable<TicketExecutionControlRecord["proposalDecision"]>;
}

function assertCanonicalDigestArray(values: readonly Sha256Digest[], label: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => index > 0 && compareUtf8(values[index - 1]!, value) >= 0)
  ) {
    throw new Error(`noncanonical ${label}`);
  }
}

function assertTicketStepGraph(ticketId: string, steps: readonly TicketStepRecord[]): void {
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new Error(`duplicate ticket step: ${ticketId}/${step.id}`);
    ids.add(step.id);
    assertUniqueIds(step.dependsOn ?? [], `ticket step dependencies: ${ticketId}/${step.id}`);
    assertUniqueIds(step.readNodeIds ?? [], `ticket step read nodes: ${ticketId}/${step.id}`);
    assertUniqueIds(step.writeNodeIds ?? [], `ticket step write nodes: ${ticketId}/${step.id}`);
    assertUniquePaths(step.readPaths ?? [], `ticket step read paths: ${ticketId}/${step.id}`);
    assertUniquePaths(step.writePaths ?? [], `ticket step write paths: ${ticketId}/${step.id}`);
  }
  for (const step of steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!ids.has(dependency) || dependency === step.id) {
        throw new Error(`invalid ticket step dependency: ${ticketId}/${step.id} -> ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new Error(`ticket step dependency cycle includes ${ticketId}/${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...ids].sort()) visit(id);
}

function assertUniqueIds(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length || values.some((value) => !isId(value))) {
    throw new Error(`invalid or duplicate ${label}`);
  }
}

function assertUniquePaths(values: readonly string[], label: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value) => !isProjectRelativePath(value))
  ) {
    throw new Error(`invalid or duplicate ${label}`);
  }
}

function isProjectRelativePath(value: string): boolean {
  return (
    value === "." ||
    (value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."))
  );
}

function assertAttemptRecord(id: string, value: unknown): asserts value is AgentAttemptRecord {
  if (
    !isId(id) ||
    !isRecord(value) ||
    value.id !== id ||
    !isId(value.sessionId) ||
    !isId(value.ticketId) ||
    !isId(value.stepId) ||
    !isId(value.personaId) ||
    typeof value.status !== "string" ||
    ![
      "queued",
      "running",
      "waiting_question",
      "waiting_plan_review",
      "terminal_accepted",
      "completed",
      "failed",
      "aborted",
      "interrupted",
    ].includes(value.status) ||
    !isSha256Digest(value.launchSpecHash) ||
    (value.launchActionInvocationId !== undefined && !isId(value.launchActionInvocationId)) ||
    !isNonnegativeSafeInteger(value.inputTokens) ||
    !isNonnegativeSafeInteger(value.outputTokens) ||
    !isNonnegativeSafeInteger(value.cacheReadTokens) ||
    !isNonnegativeSafeInteger(value.cacheWriteTokens) ||
    (value.ticketExecutionEpoch !== undefined &&
      !isNonnegativeSafeInteger(value.ticketExecutionEpoch)) ||
    (value.kind !== undefined &&
      !["planning", "lead", "ticket", "verification", "integration"].includes(
        String(value.kind),
      )) ||
    (value.failureCode !== undefined && !isBoundedRecordText(value.failureCode, 128))
  )
    throw new Error(`invalid attempt record: ${id}`);

  if (value.tokenBudgetRecovery !== undefined) {
    if (!isRecord(value.tokenBudgetRecovery)) {
      throw new Error(`invalid attempt token-budget recovery: ${id}`);
    }
    const recovery = value.tokenBudgetRecovery;
    const expectedKeys = [
      "failedAttemptId",
      "protocol",
      "recoveredAt",
      "sha256",
      "stepId",
      "ticketId",
      ...(recovery.ticketExecutionEpoch === undefined ? [] : ["ticketExecutionEpoch"]),
      ...(recovery.reviewReworkOrdinal === undefined ? [] : ["reviewReworkOrdinal"]),
    ].sort();
    const material = {
      protocol: recovery.protocol,
      failedAttemptId: recovery.failedAttemptId,
      ticketId: recovery.ticketId,
      stepId: recovery.stepId,
      ...(recovery.ticketExecutionEpoch === undefined
        ? {}
        : { ticketExecutionEpoch: recovery.ticketExecutionEpoch }),
      ...(recovery.reviewReworkOrdinal === undefined
        ? {}
        : { reviewReworkOrdinal: recovery.reviewReworkOrdinal }),
      recoveredAt: recovery.recoveredAt,
    };
    if (
      recovery.protocol !== "koni.agent-token-budget-recovery.v1" ||
      recovery.failedAttemptId !== id ||
      recovery.ticketId !== value.ticketId ||
      recovery.stepId !== value.stepId ||
      Object.keys(recovery).sort().join("\0") !== expectedKeys.join("\0") ||
      (recovery.ticketExecutionEpoch !== undefined &&
        !isNonnegativeSafeInteger(recovery.ticketExecutionEpoch)) ||
      (recovery.reviewReworkOrdinal !== undefined &&
        (!isNonnegativeSafeInteger(recovery.reviewReworkOrdinal) ||
          recovery.reviewReworkOrdinal < 1)) ||
      typeof recovery.recoveredAt !== "string" ||
      recovery.recoveredAt.length === 0 ||
      !isSha256Digest(recovery.sha256) ||
      recovery.sha256 !== canonicalHash(material)
    ) {
      throw new Error(`invalid attempt token-budget recovery: ${id}`);
    }
  }

  if (
    (value.reviewedRunOid !== undefined &&
      (typeof value.reviewedRunOid !== "string" ||
        !/^[0-9a-f]{40,64}$/u.test(value.reviewedRunOid))) ||
    (value.reviewedTargetOid !== undefined &&
      (typeof value.reviewedTargetOid !== "string" ||
        !/^[0-9a-f]{40,64}$/u.test(value.reviewedTargetOid))) ||
    (value.reviewedGraphHash !== undefined && !isSha256Digest(value.reviewedGraphHash)) ||
    (value.verificationAccepted !== undefined &&
      (typeof value.verificationAccepted !== "boolean" || value.kind !== "verification"))
  )
    throw new Error(`invalid attempt review binding: ${id}`);

  if (value.terminalPolicy !== undefined) {
    assertAgentTerminalPolicyRecord(id, value.terminalPolicy);
    if (
      value.terminalAcceptedAt !== value.terminalPolicy.acceptedAt ||
      !["terminal_accepted", "completed", "interrupted"].includes(String(value.status))
    ) {
      throw new Error(`invalid attempt terminal policy settlement: ${id}`);
    }
  }

  if (value.lineage !== undefined) {
    if (
      !isRecord(value.lineage) ||
      !isNonnegativeSafeInteger(value.lineage.branchEpoch) ||
      !["initial", "retry", "rework", "review", "recovery", "integration"].includes(
        String(value.lineage.reason),
      ) ||
      (value.lineage.parentAttemptId !== undefined && !isId(value.lineage.parentAttemptId)) ||
      (value.lineage.parentSessionId !== undefined && !isId(value.lineage.parentSessionId)) ||
      (value.lineage.parentEntryId !== undefined &&
        !isBoundedRecordText(value.lineage.parentEntryId, 128)) ||
      (value.lineage.conversationFork !== undefined &&
        (!isRecord(value.lineage.conversationFork) ||
          !isSha256Digest(value.lineage.conversationFork.parentLaunchSpecHash) ||
          !isSha256Digest(value.lineage.conversationFork.parentTranscriptSha256) ||
          value.lineage.parentEntryId === undefined ||
          !["retry", "rework", "recovery"].includes(String(value.lineage.reason)))) ||
      (value.lineage.parentAttemptId === undefined) !==
        (value.lineage.parentSessionId === undefined)
    )
      throw new Error(`invalid attempt lineage: ${id}`);
  }
  assertOrderedAuthorityRecords(
    value.authorityMessages,
    (entry) =>
      isRecord(entry) &&
      (entry.mode === "steer" || entry.mode === "follow_up") &&
      isSha256Digest(entry.sha256) &&
      isNonnegativeSafeInteger(entry.sizeBytes) &&
      entry.sizeBytes > 0 &&
      typeof entry.artifactPath === "string" &&
      typeof entry.recordedAt === "string",
    `attempt authority messages: ${id}`,
  );
  if (value.planningSynthesis !== undefined) {
    const synthesis = value.planningSynthesis;
    if (value.kind !== "planning" || !isPlanningSynthesisRecord(synthesis))
      throw new Error(`invalid planning synthesis transition: ${id}`);
  }
  assertOrderedAuthorityRecords(
    value.authorityToolResults,
    (entry) =>
      isRecord(entry) &&
      typeof entry.callId === "string" &&
      entry.callId.length > 0 &&
      typeof entry.toolName === "string" &&
      entry.toolName.length > 0 &&
      (entry.outcome === "accepted" || entry.outcome === "rejected") &&
      isSha256Digest(entry.argumentsSha256) &&
      isNonnegativeSafeInteger(entry.argumentsSizeBytes) &&
      entry.argumentsSizeBytes > 0 &&
      isSha256Digest(entry.receiptSha256) &&
      isNonnegativeSafeInteger(entry.receiptSizeBytes) &&
      entry.receiptSizeBytes > 0 &&
      typeof entry.artifactPath === "string" &&
      typeof entry.recordedAt === "string",
    `attempt authority tool results: ${id}`,
  );
  assertOrderedAuthorityRecords(
    value.authorityCompactions,
    (entry) =>
      isRecord(entry) &&
      typeof entry.authorizationId === "string" &&
      entry.authorizationId.length > 0 &&
      isSha256Digest(entry.summaryHash) &&
      isNonnegativeSafeInteger(entry.summaryBytes) &&
      entry.summaryBytes > 0 &&
      typeof entry.firstKeptEntryId === "string" &&
      entry.firstKeptEntryId.length > 0 &&
      isNonnegativeSafeInteger(entry.tokensBefore) &&
      typeof entry.recordedAt === "string",
    `attempt authority compactions: ${id}`,
  );
  assertProviderRequestRecords(id, value as unknown as AgentAttemptRecord);
  const hasTerminalDigest = value.terminalOutputSha256 !== undefined;
  const hasTerminalSize = value.terminalOutputSizeBytes !== undefined;
  const hasTerminalTime = value.terminalAcceptedAt !== undefined;
  if (
    hasTerminalDigest !== hasTerminalSize ||
    hasTerminalDigest !== hasTerminalTime ||
    (hasTerminalDigest &&
      (!isSha256Digest(value.terminalOutputSha256) ||
        !isNonnegativeSafeInteger(value.terminalOutputSizeBytes) ||
        value.terminalOutputSizeBytes === 0 ||
        typeof value.terminalAcceptedAt !== "string")) ||
    (value.status === "terminal_accepted" && !hasTerminalDigest)
  )
    throw new Error(`invalid attempt terminal acceptance: ${id}`);
}

/**
 * The terminal-output digest proves durable provider-output admission. `terminalPolicy` separately
 * proves compiler-authenticated semantic closure; configured validation deliberately has a durable
 * interval where the former exists and the latter does not. Every such assignment remains bound to
 * exactly one validation action. An admitted-then-interrupted attempt is legal only when a stop
 * CAS abandoned that exact action. The interrupted attempt and abandoned action are immutable
 * history, so they remain legal after a later resume; they can never be reopened as current work.
 */
function assertInterruptedTerminalAcceptanceSettlement(run: Readonly<RunRecord>): void {
  const archivedAuthorities = terminalArchiveAuthorities(run);
  const archivedByAttempt = new Map(
    archivedAuthorities.map((authority) => [authority.attemptId, authority] as const),
  );
  for (const attempt of Object.values(run.attempts)) {
    if (attempt.terminalOutputSha256 === undefined) continue;
    const step = run.tickets[attempt.ticketId]?.steps.find(
      (candidate) => candidate.id === attempt.stepId,
    );
    if (step?.validationAction === undefined) continue;
    const actions = Object.values(run.actionExecutions ?? {}).filter(
      (action) =>
        action.boundary.kind === "assignment_validation" &&
        action.boundary.attemptId === attempt.id &&
        action.boundary.ticketId === attempt.ticketId &&
        action.boundary.stepId === attempt.stepId,
    );
    const archivedCandidate = archivedByAttempt.get(attempt.id);
    const archived =
      archivedCandidate?.ticketId === attempt.ticketId &&
      archivedCandidate.stepId === attempt.stepId
        ? [archivedCandidate]
        : [];
    if (actions.length + archived.length !== 1) {
      const unprojectedLegacyArchive =
        (run.actionExecutionArchive ?? []).some(
          (row) =>
            row.protocol === "koni.run-action-archive.v1" && row.terminalAuthority === undefined,
        ) ||
        (run.actionExecutionArchiveSegments ?? []).some(
          (segment) =>
            segment.protocol === "koni.run-action-archive-segment.v1" &&
            segment.terminalAuthorities === undefined,
        );
      if (actions.length === 0 && archived.length === 0 && unprojectedLegacyArchive) {
        throw new Error(
          `legacy terminal action archive requires authenticated projection migration: ${attempt.id}`,
        );
      }
      throw new Error(`terminal acceptance lacks exact validation action: ${attempt.id}`);
    }
    const action = actions[0];
    const archive = archived[0];
    if (
      archive !== undefined &&
      (archive.terminalOutputSha256 !== attempt.terminalOutputSha256 ||
        archive.terminalPolicySha256 !== attempt.terminalPolicy?.sha256)
    ) {
      throw new Error(`archived validation action differs from terminal attempt: ${attempt.id}`);
    }
    if (
      attempt.status === "terminal_accepted" &&
      attempt.terminalPolicy === undefined &&
      (action?.settledAt !== undefined || archive !== undefined)
    ) {
      throw new Error(
        `pending terminal policy has an already-settled validation action: ${attempt.id}`,
      );
    }
    const successProofs = Object.values(run.terminalSuccessProofs ?? {}).filter(
      (proof) => proof.attemptId === attempt.id,
    );
    const failureProofs = Object.values(run.terminalFailureProofs ?? {}).filter(
      (proof) => proof.attemptId === attempt.id,
    );
    if (attempt.status === "interrupted") {
      if (
        action !== undefined &&
        (action.settledAt === undefined || action.settlement?.disposition !== "abandoned")
      ) {
        throw new Error(
          `interrupted terminal acceptance lacks exact abandoned action: ${attempt.id}`,
        );
      }
      if (archive !== undefined && archive.settlementDisposition !== "abandoned") {
        throw new Error(
          `interrupted terminal acceptance lacks exact archived abandonment: ${attempt.id}`,
        );
      }
      if (
        step !== undefined &&
        step.attemptIds.at(-1) === attempt.id &&
        step.status !== "pending" &&
        step.status !== "skipped"
      ) {
        throw new Error(`interrupted terminal acceptance remains current work: ${attempt.id}`);
      }
      if (successProofs.length !== 0 || failureProofs.length !== 0) {
        throw new Error(`abandoned terminal acceptance retains a terminal proof: ${attempt.id}`);
      }
      continue;
    }
    if (attempt.status === "terminal_accepted") continue;
    if (successProofs.length + failureProofs.length !== 1) {
      throw new Error(`settled terminal acceptance lacks one exact semantic proof: ${attempt.id}`);
    }
    const proof = successProofs[0] ?? failureProofs[0]!;
    const disposition = proof.semanticResult.status === "completed" ? "completed" : "failed";
    if (
      action !== undefined &&
      (action.settledAt === undefined ||
        action.settlement?.disposition !== disposition ||
        action.invocationId !== proof.actionInvocationId ||
        action.plan.sha256 !== proof.actionPlanSha256 ||
        action.settlement.sha256 !== proof.actionSettlementSha256)
    ) {
      throw new Error(`settled terminal acceptance differs from validation action: ${attempt.id}`);
    }
    if (
      archive !== undefined &&
      (archive.settlementDisposition !== disposition ||
        archive.invocationId !== proof.actionInvocationId ||
        archive.actionPlanSha256 !== proof.actionPlanSha256 ||
        archive.actionSettlementSha256 !== proof.actionSettlementSha256 ||
        archive.terminalProofSha256 !== proof.sha256)
    ) {
      throw new Error(
        `settled terminal acceptance differs from archived validation action: ${attempt.id}`,
      );
    }
  }
}

function terminalArchiveAuthorities(run: Readonly<RunRecord>): RunActionTerminalArchiveAuthority[] {
  const authorities = [
    ...(run.actionExecutionArchive ?? []).flatMap((row) =>
      row.terminalAuthority === undefined ? [] : [row.terminalAuthority],
    ),
    ...(run.actionExecutionArchiveSegments ?? []).flatMap(
      (segment) => segment.terminalAuthorities ?? [],
    ),
  ];
  const attempts = new Set<string>();
  const invocations = new Set<string>();
  for (const authority of authorities) {
    if (
      authority.runId !== run.id ||
      attempts.has(authority.attemptId) ||
      invocations.has(authority.invocationId)
    ) {
      throw new Error("run action archive repeats or misbinds terminal authority");
    }
    attempts.add(authority.attemptId);
    invocations.add(authority.invocationId);
  }
  return authorities;
}

function assertAgentTerminalPolicyRecord(
  attemptId: string,
  value: unknown,
): asserts value is AgentTerminalPolicyRecord {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.agent-terminal-policy.v1" ||
    (value.mode !== "legacy_pre_execution_policy" &&
      value.mode !== "failed_submission" &&
      value.mode !== "semantic") ||
    typeof value.acceptedAt !== "string" ||
    value.acceptedAt.length === 0 ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid attempt terminal policy: ${attemptId}`);
  }
  const allowed =
    value.mode === "semantic"
      ? new Set([
          "protocol",
          "mode",
          "projectionSha256",
          "replayCompilationSha256",
          "receiptEvaluationSha256",
          "sourcePreservationSha256s",
          "acceptedAt",
          "sha256",
        ])
      : new Set(["protocol", "mode", "acceptedAt", "sha256"]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new Error(`invalid attempt terminal policy field: ${attemptId}`);
  }
  if (value.mode === "semantic") {
    if (
      !isSha256Digest(value.projectionSha256) ||
      !isSha256Digest(value.replayCompilationSha256) ||
      !isSha256Digest(value.receiptEvaluationSha256) ||
      !Array.isArray(value.sourcePreservationSha256s) ||
      value.sourcePreservationSha256s.some((digest) => !isSha256Digest(digest))
    ) {
      throw new Error(`invalid semantic terminal policy: ${attemptId}`);
    }
    assertCanonicalDigestArray(
      value.sourcePreservationSha256s as Sha256Digest[],
      `attempt source-preservation receipts: ${attemptId}`,
    );
  }
  const { sha256, ...material } = value;
  if (canonicalHash(material) !== sha256) {
    throw new Error(`invalid attempt terminal policy hash: ${attemptId}`);
  }
}

function assertQuestionRecord(
  id: string,
  value: unknown,
  attempts: Readonly<Record<string, AgentAttemptRecord>>,
): asserts value is RunQuestionRecord {
  if (
    !isId(id) ||
    !isRecord(value) ||
    value.id !== id ||
    !isId(value.attemptId) ||
    attempts[value.attemptId] === undefined ||
    typeof value.prompt !== "string" ||
    value.prompt.length === 0 ||
    value.prompt.includes("\0") ||
    Buffer.byteLength(value.prompt, "utf8") > 1024 * 1024 ||
    // Pre-Pi-native imported records may contain one-option acknowledgements. New questions are
    // still compiler-validated to require two to eight meaningful choices.
    !Array.isArray(value.options) ||
    value.options.length < 1 ||
    value.options.length > 8 ||
    typeof value.allowsNotes !== "boolean" ||
    typeof value.askedAt !== "string" ||
    value.askedAt.length === 0 ||
    (value.answeredAt !== undefined && typeof value.answeredAt !== "string") ||
    (value.selectedOptionId !== undefined && typeof value.selectedOptionId !== "string") ||
    (value.batchId !== undefined && !isId(value.batchId)) ||
    (value.scope !== undefined && value.scope !== "run" && value.scope !== "ticket") ||
    (value.scope === undefined && value.ticketId !== undefined) ||
    (value.scope === "run" && value.ticketId !== undefined) ||
    (value.scope === "ticket" &&
      (!isId(value.ticketId) || value.ticketId !== attempts[value.attemptId]!.ticketId)) ||
    (value.batchPosition !== undefined &&
      (!isNonnegativeSafeInteger(value.batchPosition) || value.batchPosition < 1)) ||
    (value.batchSize !== undefined &&
      (!isNonnegativeSafeInteger(value.batchSize) || value.batchSize < 1 || value.batchSize > 8)) ||
    (value.batchPosition === undefined) !== (value.batchSize === undefined) ||
    (value.batchPosition !== undefined &&
      value.batchSize !== undefined &&
      value.batchPosition > value.batchSize) ||
    (value.recommendationOptionId !== undefined &&
      typeof value.recommendationOptionId !== "string") ||
    (value.impact !== undefined && value.impact !== "routine" && value.impact !== "high_impact") ||
    (value.answerSource !== undefined &&
      value.answerSource !== "operator" &&
      value.answerSource !== "configured_recommendation") ||
    (value.answerRevision !== undefined &&
      (!isNonnegativeSafeInteger(value.answerRevision) || value.answerRevision < 1)) ||
    (value.notes !== undefined &&
      (typeof value.notes !== "string" ||
        value.notes.includes("\0") ||
        Buffer.byteLength(value.notes, "utf8") > 64 * 1024))
  )
    throw new Error(`invalid run question: ${id}`);
  const optionIds = new Set<string>();
  for (const option of value.options) {
    if (
      !isRecord(option) ||
      !isId(option.id) ||
      optionIds.has(option.id) ||
      typeof option.label !== "string" ||
      option.label.length === 0 ||
      option.label.includes("\0") ||
      Buffer.byteLength(option.label, "utf8") > 16 * 1024 ||
      typeof option.description !== "string" ||
      option.description.length === 0 ||
      option.description.includes("\0") ||
      Buffer.byteLength(option.description, "utf8") > 64 * 1024
    )
      throw new Error(`invalid run question option: ${id}`);
    optionIds.add(option.id);
  }
  if (value.selectedOptionId !== undefined && !optionIds.has(value.selectedOptionId)) {
    throw new Error(`run question selected option does not exist: ${id}`);
  }
  if (value.recommendationOptionId !== undefined && !optionIds.has(value.recommendationOptionId)) {
    throw new Error(`run question recommendation does not exist: ${id}`);
  }
  if (
    value.answerSource === "configured_recommendation" &&
    (value.recommendationOptionId === undefined ||
      value.selectedOptionId !== value.recommendationOptionId ||
      value.notes !== undefined)
  )
    throw new Error(`run question automatic answer differs from its recommendation: ${id}`);
  if (
    value.answeredAt !== undefined &&
    value.selectedOptionId === undefined &&
    (value.notes === undefined || value.notes.trim().length === 0)
  ) {
    throw new Error(`answered run question has no answer: ${id}`);
  }
}

function assertAttemptLineageForest(attempts: Readonly<Record<string, AgentAttemptRecord>>): void {
  const sessionIds = new Set<string>();
  for (const attempt of Object.values(attempts)) {
    if (sessionIds.has(attempt.sessionId)) {
      throw new Error(`attempt Pi session identity is reused: ${attempt.sessionId}`);
    }
    sessionIds.add(attempt.sessionId);
  }
  for (const attempt of Object.values(attempts)) {
    const lineage = attempt.lineage;
    if (lineage === undefined) continue;
    const parentId = lineage.parentAttemptId;
    if (parentId === undefined) {
      if (
        lineage.branchEpoch !== 0 ||
        (lineage.reason !== "initial" && lineage.reason !== "recovery")
      ) {
        throw new Error(`root attempt lineage is invalid: ${attempt.id}`);
      }
      continue;
    }
    const parent = attempts[parentId];
    if (parent === undefined || parent.sessionId !== lineage.parentSessionId) {
      throw new Error(`attempt lineage parent is missing or mismatched: ${attempt.id}`);
    }
    const parentEpoch = parent.lineage?.branchEpoch ?? 0;
    if (lineage.branchEpoch !== parentEpoch + 1) {
      throw new Error(`attempt lineage epoch is not sequential: ${attempt.id}`);
    }
    if (lineage.reason === "review" && attempt.ticketId !== parent.ticketId) {
      throw new Error(`review attempt lineage crosses ticket scope: ${attempt.id}`);
    }
    if (
      new Set(["retry", "rework", "recovery"]).has(lineage.reason) &&
      (attempt.ticketId !== parent.ticketId || attempt.stepId !== parent.stepId)
    )
      throw new Error(`replacement attempt lineage crosses step scope: ${attempt.id}`);
  }
}

function assertProviderRequestRecords(id: string, attempt: AgentAttemptRecord): void {
  const records = attempt.authorityProviderRequests;
  const baseline = attempt.authorityProviderUsageBaseline;
  if (records === undefined) {
    if (baseline !== undefined) throw new Error(`orphaned attempt provider baseline: ${id}`);
    return;
  }
  if (!Array.isArray(records) || records.length > 100_000) {
    throw new Error(`invalid attempt provider requests: ${id}`);
  }
  if (
    baseline !== undefined &&
    (!isRecord(baseline) ||
      !isNonnegativeSafeInteger(baseline.inputTokens) ||
      !isNonnegativeSafeInteger(baseline.outputTokens) ||
      !isNonnegativeSafeInteger(baseline.cacheReadTokens) ||
      !isNonnegativeSafeInteger(baseline.cacheWriteTokens) ||
      typeof baseline.recordedAt !== "string")
  )
    throw new Error(`invalid attempt provider baseline: ${id}`);
  let input = baseline?.inputTokens ?? 0;
  let output = baseline?.outputTokens ?? 0;
  let cacheRead = baseline?.cacheReadTokens ?? 0;
  let cacheWrite = baseline?.cacheWriteTokens ?? 0;
  let unresolved = false;
  for (const [index, entry] of records.entries()) {
    if (
      !isRecord(entry) ||
      entry.sequence !== index + 1 ||
      !isId(entry.reservationId) ||
      !isBoundedRecordText(entry.api, 256) ||
      !isBoundedRecordText(entry.modelId, 512) ||
      !isSha256Digest(entry.payloadSha256) ||
      !isNonnegativeSafeInteger(entry.payloadSizeBytes) ||
      entry.payloadSizeBytes === 0 ||
      !isBoundedRecordText(entry.baselineEntryId, 128) ||
      !isNonnegativeSafeInteger(entry.prospectiveInputTokens) ||
      entry.prospectiveInputTokens === 0 ||
      !isNonnegativeSafeInteger(entry.reservedOutputTokens) ||
      entry.reservedOutputTokens === 0 ||
      typeof entry.reservedAt !== "string" ||
      (entry.serializedOutputCap !== undefined &&
        (!isRecord(entry.serializedOutputCap) ||
          !isBoundedRecordText(entry.serializedOutputCap.path, 256) ||
          !entry.serializedOutputCap.path.startsWith("/") ||
          !isNonnegativeSafeInteger(entry.serializedOutputCap.value) ||
          entry.serializedOutputCap.value === 0 ||
          entry.serializedOutputCap.value !== entry.reservedOutputTokens))
    )
      throw new Error(`invalid attempt provider request: ${id}`);
    const settlement = [
      entry.assistantEntryId,
      entry.assistantEntrySha256,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadTokens,
      entry.cacheWriteTokens,
      entry.settledAt,
    ];
    const settled = settlement.every((field) => field !== undefined);
    if (!settled && settlement.some((field) => field !== undefined)) {
      throw new Error(`partial attempt provider settlement: ${id}`);
    }
    if (entry.retirement !== undefined) {
      const retirement = entry.retirement;
      if (
        settled ||
        !isRecord(retirement) ||
        retirement.protocol !== "koni.provider-exposure-retirement.v1" ||
        !new Set([
          "operator_acknowledged_canonical_abort",
          "operator_acknowledged_provider_error",
          "operator_acknowledged_authority_pause",
          "operator_acknowledged_unreconciled_request",
        ]).has(String(retirement.disposition)) ||
        !isSha256Digest(retirement.authorizationSha256) ||
        typeof retirement.retiredAt !== "string" ||
        !isSha256Digest(retirement.sha256)
      )
        throw new Error(`invalid attempt provider exposure retirement: ${id}`);
      if (
        retirement.disposition === "operator_acknowledged_authority_pause"
          ? !isSha256Digest(retirement.pauseReasonSha256)
          : retirement.disposition === "operator_acknowledged_unreconciled_request"
            ? !isSha256Digest(retirement.failureReasonSha256)
            : !isBoundedRecordText(retirement.assistantEntryId, 128) ||
              !isSha256Digest(retirement.assistantEntrySha256) ||
              !isBoundedRecordText(retirement.responseId, 512) ||
              (retirement.disposition === "operator_acknowledged_provider_error"
                ? !isSha256Digest(retirement.errorMessageSha256)
                : retirement.errorMessageSha256 !== undefined)
      )
        throw new Error(`invalid attempt provider exposure retirement fields: ${id}`);
      const { sha256, ...material } = retirement;
      if (canonicalHash(material) !== sha256) {
        throw new Error(`invalid attempt provider exposure retirement identity: ${id}`);
      }
      continue;
    }
    if (!settled) {
      if (unresolved || index !== records.length - 1) {
        throw new Error(`invalid unresolved attempt provider request: ${id}`);
      }
      unresolved = true;
      continue;
    }
    if (
      !isBoundedRecordText(entry.assistantEntryId, 128) ||
      !isSha256Digest(entry.assistantEntrySha256) ||
      !isNonnegativeSafeInteger(entry.inputTokens) ||
      !isNonnegativeSafeInteger(entry.outputTokens) ||
      !isNonnegativeSafeInteger(entry.cacheReadTokens) ||
      !isNonnegativeSafeInteger(entry.cacheWriteTokens) ||
      typeof entry.settledAt !== "string" ||
      entry.outputTokens > entry.reservedOutputTokens
    )
      throw new Error(`invalid settled attempt provider request: ${id}`);
    if (
      checkedRecordSum(entry.inputTokens, entry.cacheReadTokens, entry.cacheWriteTokens) >
      entry.prospectiveInputTokens
    )
      throw new Error(`settled attempt provider prompt usage exceeds reservation: ${id}`);
    input = checkedRecordSum(input, entry.inputTokens);
    output = checkedRecordSum(output, entry.outputTokens);
    cacheRead = checkedRecordSum(cacheRead, entry.cacheReadTokens);
    cacheWrite = checkedRecordSum(cacheWrite, entry.cacheWriteTokens);
  }
  if (
    input !== attempt.inputTokens ||
    output !== attempt.outputTokens ||
    cacheRead !== attempt.cacheReadTokens ||
    cacheWrite !== attempt.cacheWriteTokens
  )
    throw new Error(`attempt provider usage does not match durable totals: ${id}`);
}

function checkedRecordSum(...values: number[]): number {
  const value = values.reduce((sum, next) => sum + next, 0);
  if (!Number.isSafeInteger(value)) throw new Error("attempt provider usage exceeds safe range");
  return value;
}

function isBoundedRecordText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function assertOrderedAuthorityRecords(
  value: unknown,
  validate: (entry: unknown) => boolean,
  label: string,
): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length > 100_000 ||
    value.some(
      (entry, index) => !validate(entry) || !isRecord(entry) || entry.sequence !== index + 1,
    )
  )
    throw new Error(`invalid ${label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}
