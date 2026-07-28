import { Buffer } from "node:buffer";
import {
  resolveExecutionPolicyBinding,
  type ExecutionPolicyBinding,
} from "../authority/execution-policy.js";
import type {
  CompiledExecutionSemanticCatalog,
  CompiledOperationSemantics,
} from "../compiler/execution-semantics.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  type Sha256Digest,
} from "../shared/canonical.js";
import type {
  TerminalFailureSettlementProof,
  TerminalSuccessSettlementProof,
  TicketStatus,
} from "./run-record.js";

export const CHANGE_CONTROL_PUBLICATION_PROTOCOL = "koni.change-control-publication.v1" as const;
export const PROPOSAL_DECISION_PROTOCOL = "koni.proposal-decision.v1" as const;
export const PROPOSAL_DECISION_AUTHORITY_PROTOCOL = "koni.proposal-decision-authority.v2" as const;
export const APPROVED_CHANGE_MATERIALIZATION_PROTOCOL =
  "koni.approved-change-materialization.v1" as const;
export const SOURCE_RELEASE_DECISION_PROTOCOL = "koni.source-release-decision.v1" as const;
export const TERMINAL_RESOLVER_RECONCILIATION_PROTOCOL =
  "koni.terminal-resolver-reconciliation.v1" as const;
export const TERMINAL_RESOLVER_RETRY_PROTOCOL = "koni.terminal-resolver-retry.v1" as const;
export const MAX_TERMINAL_RESOLVER_RETRIES = 8;

export class ChangeControlAuthorityError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ChangeControlAuthorityError";
    this.code = code;
  }
}

export interface ExistingChangeControlProposal {
  readonly ticketId: string;
  readonly requestSha256: Sha256Digest;
  readonly proposalOperationId: string;
  readonly sourceTicketId: string;
  readonly sourceStepId: string;
  readonly sourceOutputSha256: Sha256Digest;
  readonly controlScopeNodeIds: readonly string[];
}

export interface ChangeControlPublication {
  readonly protocol: typeof CHANGE_CONTROL_PUBLICATION_PROTOCOL;
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly runId: string;
  readonly sourceTicketId: string;
  readonly sourceStepId: string;
  readonly sourceOutputSha256: Sha256Digest;
  readonly sourceBinding: ExecutionPolicyBinding;
  readonly sourceOperation: CompiledOperationSemantics;
  readonly targetNodeIds: readonly string[];
  readonly summary: string;
  readonly reason: string;
  readonly requestSha256: Sha256Digest;
  readonly proposalTicketId: string;
  readonly proposalOperationId: string;
  readonly proposalBinding: ExecutionPolicyBinding;
  readonly initialStatus: "proposed";
  readonly controlScopeNodeIds: readonly string[];
  readonly disposition: "create" | "reuse";
  /** Proposal must be committed first; replay then repairs or confirms this source hold. */
  readonly sourceHold: "apply_or_repair_after_proposal";
  readonly sha256: Sha256Digest;
}

/**
 * Compile one upstream request into a deterministic proposal identity. The caller publishes the
 * proposal and source hold atomically when possible; proposal-first replay remains self-healing.
 */
export function deriveChangeControlPublication(
  catalog: CompiledExecutionSemanticCatalog,
  input: Readonly<{
    runId: string;
    sourceTicketId: string;
    sourceStepId: string;
    sourceOutputSha256: Sha256Digest;
    sourceBinding: ExecutionPolicyBinding;
    targetNodeIds: readonly string[];
    summary: string;
    reason: string;
    existingProposal?: ExistingChangeControlProposal;
  }>,
): ChangeControlPublication {
  requireNonempty(input.runId, "run id");
  requireNonempty(input.sourceTicketId, "source ticket id");
  requireNonempty(input.sourceStepId, "source step id");
  requireDigest(input.sourceOutputSha256, "source output hash");
  requireNonempty(input.summary, "request summary");
  requireNonempty(input.reason, "request reason");
  const sourceOperation = exactBoundOperation(catalog, input.sourceBinding);
  if (
    sourceOperation.changeControl.role !== "ordinary" ||
    !sourceOperation.changeControl.allowUpstreamRequests ||
    sourceOperation.changeControl.proposalOperation === undefined
  ) {
    fail(
      "change_control.route_forbidden",
      `operation ${sourceOperation.id} cannot issue an upstream change request`,
    );
  }
  const proposalOperation = uniquePublicOperation(
    catalog,
    sourceOperation.changeControl.proposalOperation,
    "proposal",
  );
  const targetNodeIds = canonicalStrings(input.targetNodeIds, "request target nodes", false);
  const requestMaterial = {
    runId: input.runId,
    sourceTicketId: input.sourceTicketId,
    sourceStepId: input.sourceStepId,
    sourceOutputSha256: input.sourceOutputSha256,
    sourceBindingSha256: input.sourceBinding.sha256,
    targetNodeIds,
    summary: input.summary.trim(),
    reason: input.reason.trim(),
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
  };
  const requestSha256 = canonicalHash(requestMaterial);
  const proposalTicketId = deterministicTicketId("change", {
    runId: input.runId,
    proposalOperationId: proposalOperation.id,
    requestSha256,
  });
  const proposalBinding = resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId: proposalOperation.id,
    ...(proposalOperation.workflowId === undefined
      ? {}
      : {
          workflowId: proposalOperation.workflowId,
        }),
  });
  const expected: ExistingChangeControlProposal = {
    ticketId: proposalTicketId,
    requestSha256,
    proposalOperationId: proposalOperation.id,
    sourceTicketId: input.sourceTicketId,
    sourceStepId: input.sourceStepId,
    sourceOutputSha256: input.sourceOutputSha256,
    controlScopeNodeIds: targetNodeIds,
  };
  const disposition: "create" | "reuse" = input.existingProposal === undefined ? "create" : "reuse";
  if (
    input.existingProposal !== undefined &&
    canonicalHash(input.existingProposal) !== canonicalHash(expected)
  ) {
    fail(
      "change_control.proposal_collision",
      `deterministic proposal ${proposalTicketId} conflicts with its exact request authority`,
    );
  }
  const material = {
    protocol: CHANGE_CONTROL_PUBLICATION_PROTOCOL,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    runId: input.runId,
    sourceTicketId: input.sourceTicketId,
    sourceStepId: input.sourceStepId,
    sourceOutputSha256: input.sourceOutputSha256,
    sourceBinding: structuredClone(input.sourceBinding),
    sourceOperation: structuredClone(sourceOperation),
    targetNodeIds,
    summary: input.summary.trim(),
    reason: input.reason.trim(),
    requestSha256,
    proposalTicketId,
    proposalOperationId: proposalOperation.id,
    proposalBinding,
    initialStatus: "proposed" as const,
    controlScopeNodeIds: targetNodeIds,
    disposition,
    sourceHold: "apply_or_repair_after_proposal" as const,
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

export interface ProposalApprovalAuthority {
  readonly protocol: typeof PROPOSAL_DECISION_AUTHORITY_PROTOCOL;
  readonly runId: string;
  readonly proposalTicketId: string;
  readonly requestSha256: Sha256Digest;
  readonly eventId: string;
  /** The operator disposition is part of the authority bytes; it cannot be reinterpreted later. */
  readonly decision: "approval" | "rejection";
  readonly actor: "operator";
  readonly recordedAt: string;
  readonly message: string;
  readonly sha256: Sha256Digest;
}

export interface ProposalDecision {
  readonly protocol: typeof PROPOSAL_DECISION_PROTOCOL;
  readonly proposalTicketId: string;
  readonly disposition:
    "approve" | "reject" | "reuse_approval" | "preserve_active_approval" | "audit_only";
  readonly approvalSha256?: Sha256Digest;
  readonly transition?: Readonly<{ from: TicketStatus; to: TicketStatus }>;
  readonly invalidatePriorReview: boolean;
  readonly terminalDisposition?: "rejected";
  /** Exact incoming operator event, including audit-only and preserved-approval decisions. */
  readonly decisionAuthoritySha256: Sha256Digest;
  readonly sha256: Sha256Digest;
}

/** Determine one exact approval/rejection transition without mutating durable state. */
export function deriveProposalDecision(
  input: Readonly<{
    runId: string;
    proposalTicketId: string;
    requestSha256: Sha256Digest;
    status: TicketStatus;
    decision: "approval" | "rejection";
    authority: ProposalApprovalAuthority;
    currentApprovalSha256?: Sha256Digest;
    ownsExecutionAuthority: boolean;
  }>,
): ProposalDecision {
  requireNonempty(input.runId, "proposal run id");
  requireNonempty(input.proposalTicketId, "proposal ticket id");
  requireDigest(input.requestSha256, "proposal request hash");
  assertApprovalAuthority(input.authority);
  if (
    input.authority.runId !== input.runId ||
    input.authority.proposalTicketId !== input.proposalTicketId ||
    input.authority.requestSha256 !== input.requestSha256
  ) {
    fail(
      "change_control.approval_binding",
      "proposal decision authority differs from its exact run, ticket, or request",
    );
  }
  if (input.authority.decision !== input.decision) {
    fail(
      "change_control.approval_decision",
      "proposal decision differs from its authenticated authority event",
    );
  }
  if (input.currentApprovalSha256 !== undefined) {
    requireDigest(input.currentApprovalSha256, "current proposal approval hash");
  }
  let disposition: ProposalDecision["disposition"];
  let approvalSha256: Sha256Digest | undefined;
  let transition: ProposalDecision["transition"];
  let invalidatePriorReview = false;
  let terminalDisposition: ProposalDecision["terminalDisposition"];
  if (input.decision === "approval") {
    approvalSha256 = input.authority.sha256;
    if (input.currentApprovalSha256 === input.authority.sha256) {
      disposition = "reuse_approval";
    } else if (input.currentApprovalSha256 !== undefined && input.ownsExecutionAuthority) {
      disposition = "preserve_active_approval";
      approvalSha256 = input.currentApprovalSha256;
    } else {
      if (input.status !== "proposed" && input.currentApprovalSha256 === undefined) {
        fail(
          "change_control.approval_state",
          `proposal ${input.proposalTicketId} without approval is not in proposed state`,
        );
      }
      disposition = "approve";
      if (input.status === "proposed") transition = { from: "proposed", to: "ready" };
      invalidatePriorReview = input.currentApprovalSha256 !== undefined;
    }
  } else if (input.status === "proposed") {
    disposition = "reject";
    transition = { from: "proposed", to: "completed" };
    invalidatePriorReview = input.currentApprovalSha256 !== undefined;
    terminalDisposition = "rejected";
  } else {
    // Later rejection/stop events remain audit evidence but cannot revoke active execution authority.
    disposition = "audit_only";
  }
  const material = {
    protocol: PROPOSAL_DECISION_PROTOCOL,
    proposalTicketId: input.proposalTicketId,
    disposition,
    ...(approvalSha256 === undefined ? {} : { approvalSha256 }),
    ...(transition === undefined ? {} : { transition }),
    invalidatePriorReview,
    ...(terminalDisposition === undefined ? {} : { terminalDisposition }),
    decisionAuthoritySha256: input.authority.sha256,
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

export interface ApprovedApplicationScope {
  readonly readNodeIds: readonly string[];
  readonly writeNodeIds: readonly string[];
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
}

export interface ExistingApplicationChild {
  readonly ticketId: string;
  readonly sourceProposalTicketId: string;
  readonly applicationOperationId: string;
  readonly authoritySha256: Sha256Digest;
}

export type ApprovedChangeMaterialization =
  | Readonly<{
      protocol: typeof APPROVED_CHANGE_MATERIALIZATION_PROTOCOL;
      configurationSha256: Sha256Digest;
      catalogSha256: Sha256Digest;
      runId: string;
      proposalTicketId: string;
      proposalBinding: ExecutionPolicyBinding;
      proposalOperation: CompiledOperationSemantics;
      requestSha256: Sha256Digest;
      approvalSha256: Sha256Digest;
      proposalOutputSha256: Sha256Digest;
      proposalStepId: string;
      proposalSelectionSha256: Sha256Digest;
      selectionSummary: string;
      proposalTerminalProof: TerminalSuccessSettlementProof;
      reviewSha256: Sha256Digest;
      reviewTerminalProof: TerminalSuccessSettlementProof;
      applicationPublicOperation: string;
      applicationOperation: CompiledOperationSemantics;
      applicationBinding: ExecutionPolicyBinding;
      targetNodeIds: readonly string[];
      scope: ApprovedApplicationScope;
      authoritySha256: Sha256Digest;
      kind: "application";
      applicationTicketId: string;
      applicationOperationId: string;
      controlScopeNodeIds: readonly string[];
      disposition: "create" | "reuse";
      sha256: Sha256Digest;
    }>
  | Readonly<{
      protocol: typeof APPROVED_CHANGE_MATERIALIZATION_PROTOCOL;
      configurationSha256: Sha256Digest;
      catalogSha256: Sha256Digest;
      runId: string;
      proposalTicketId: string;
      proposalBinding: ExecutionPolicyBinding;
      proposalOperation: CompiledOperationSemantics;
      requestSha256: Sha256Digest;
      approvalSha256: Sha256Digest;
      proposalOutputSha256: Sha256Digest;
      proposalStepId: string;
      proposalSelectionSha256: Sha256Digest;
      selectionSummary: string;
      proposalTerminalProof: TerminalSuccessSettlementProof;
      reviewSha256: Sha256Digest;
      reviewTerminalProof: TerminalSuccessSettlementProof;
      applicationPublicOperation: string;
      applicationOperation: CompiledOperationSemantics;
      applicationBinding: ExecutionPolicyBinding;
      targetNodeIds: readonly string[];
      scope: ApprovedApplicationScope;
      authoritySha256: Sha256Digest;
      kind: "no_op";
      disposition: "materialize_without_agent";
      sha256: Sha256Digest;
    }>;

/**
 * Bind a reviewed proposal to either one deterministic application child or an agent-free no-op.
 */
export function deriveApprovedChangeMaterialization(
  catalog: CompiledExecutionSemanticCatalog,
  input: Readonly<{
    runId: string;
    proposalTicketId: string;
    proposalBinding: ExecutionPolicyBinding;
    requestSha256: Sha256Digest;
    approvalSha256: Sha256Digest;
    proposalOutputSha256: Sha256Digest;
    proposalStepId: string;
    proposalSelectionSha256: Sha256Digest;
    selectionSummary: string;
    proposalTerminalProof: TerminalSuccessSettlementProof;
    reviewSha256: Sha256Digest;
    reviewTerminalProof: TerminalSuccessSettlementProof;
    applicationPublicOperation: string;
    targetNodeIds: readonly string[];
    scope: ApprovedApplicationScope;
    existingApplication?: ExistingApplicationChild;
  }>,
): ApprovedChangeMaterialization {
  requireNonempty(input.runId, "run id");
  requireNonempty(input.proposalTicketId, "proposal ticket id");
  requireDigest(input.requestSha256, "request hash");
  requireDigest(input.approvalSha256, "approval hash");
  requireDigest(input.proposalOutputSha256, "proposal output hash");
  requireNonempty(input.proposalStepId, "proposal step id");
  requireDigest(input.proposalSelectionSha256, "proposal selection hash");
  requireNonempty(input.selectionSummary, "proposal selection summary");
  requireDigest(input.reviewSha256, "proposal review hash");
  if (
    input.proposalTerminalProof.runId !== input.runId ||
    input.proposalTerminalProof.ticketId !== input.proposalTicketId ||
    input.proposalTerminalProof.semanticResult.status !== "completed" ||
    input.proposalTerminalProof.semanticResult.changeControlSha256 !==
      input.proposalSelectionSha256 ||
    input.reviewTerminalProof.runId !== input.runId ||
    input.reviewTerminalProof.ticketId !== input.proposalTicketId ||
    input.reviewTerminalProof.semanticResult.status !== "completed"
  ) {
    fail(
      "change_control.materialization_terminal_proof",
      "approved materialization lacks exact proposal and review settlements",
    );
  }
  const proposalOperation = exactBoundOperation(catalog, input.proposalBinding);
  if (proposalOperation.changeControl.role !== "proposal") {
    fail(
      "change_control.not_proposal",
      `operation ${proposalOperation.id} cannot materialize an approved change`,
    );
  }
  const application = uniquePublicOperation(
    catalog,
    input.applicationPublicOperation,
    "application_or_disposition",
  );
  if (
    !proposalOperation.changeControl.applicationOperations.includes(application.publicOperation)
  ) {
    fail(
      "change_control.application_route",
      `proposal ${proposalOperation.id} does not permit ${application.publicOperation}`,
    );
  }
  const targetNodeIds = canonicalStrings(input.targetNodeIds, "application target nodes", false);
  const scope = canonicalScope(input.scope);
  if (
    application.changeControl.role !== "disposition" &&
    canonicalHash(scope.writeNodeIds) !== canonicalHash(targetNodeIds)
  ) {
    fail(
      "change_control.application_scope",
      "approved application write nodes must exactly equal its target nodes",
    );
  }
  const applicationBinding = resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId: application.id,
    ...(application.workflowId === undefined ? {} : { workflowId: application.workflowId }),
  });
  const authorityMaterial = {
    runId: input.runId,
    proposalTicketId: input.proposalTicketId,
    proposalBindingSha256: input.proposalBinding.sha256,
    requestSha256: input.requestSha256,
    approvalSha256: input.approvalSha256,
    proposalOutputSha256: input.proposalOutputSha256,
    proposalStepId: input.proposalStepId,
    proposalSelectionSha256: input.proposalSelectionSha256,
    selectionSummary: input.selectionSummary,
    reviewSha256: input.reviewSha256,
    proposalTerminalProofSha256: input.proposalTerminalProof.sha256,
    reviewTerminalProofSha256: input.reviewTerminalProof.sha256,
    applicationOperationId: application.id,
    targetNodeIds,
    scope,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
  };
  const authoritySha256 = canonicalHash(authorityMaterial);
  if (application.changeControl.role === "disposition") {
    if (input.existingApplication !== undefined) {
      fail(
        "change_control.no_op_child",
        "no-op disposition cannot own an application child ticket",
      );
    }
    const material = {
      protocol: APPROVED_CHANGE_MATERIALIZATION_PROTOCOL,
      configurationSha256: catalog.configurationSha256,
      catalogSha256: catalog.sha256,
      runId: input.runId,
      proposalTicketId: input.proposalTicketId,
      proposalBinding: structuredClone(input.proposalBinding),
      proposalOperation: structuredClone(proposalOperation),
      requestSha256: input.requestSha256,
      approvalSha256: input.approvalSha256,
      proposalOutputSha256: input.proposalOutputSha256,
      proposalStepId: input.proposalStepId,
      proposalSelectionSha256: input.proposalSelectionSha256,
      selectionSummary: input.selectionSummary,
      proposalTerminalProof: structuredClone(input.proposalTerminalProof),
      reviewSha256: input.reviewSha256,
      reviewTerminalProof: structuredClone(input.reviewTerminalProof),
      applicationPublicOperation: application.publicOperation,
      applicationOperation: structuredClone(application),
      applicationBinding,
      targetNodeIds,
      scope: structuredClone(scope),
      authoritySha256,
      kind: "no_op" as const,
      disposition: "materialize_without_agent" as const,
    };
    return deepFreeze({ ...material, sha256: canonicalHash(material) });
  }
  if (application.changeControl.role !== "application") {
    fail(
      "change_control.application_role",
      `operation ${application.id} is not a typed application or disposition`,
    );
  }
  const applicationTicketId = deterministicTicketId("application", {
    proposalTicketId: input.proposalTicketId,
    authoritySha256,
  });
  const expected: ExistingApplicationChild = {
    ticketId: applicationTicketId,
    sourceProposalTicketId: input.proposalTicketId,
    applicationOperationId: application.id,
    authoritySha256,
  };
  const disposition: "create" | "reuse" =
    input.existingApplication === undefined ? "create" : "reuse";
  if (
    input.existingApplication !== undefined &&
    canonicalHash(input.existingApplication) !== canonicalHash(expected)
  ) {
    fail(
      "change_control.application_collision",
      `deterministic application ${applicationTicketId} conflicts with approved proposal authority`,
    );
  }
  const material = {
    protocol: APPROVED_CHANGE_MATERIALIZATION_PROTOCOL,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    runId: input.runId,
    proposalTicketId: input.proposalTicketId,
    proposalBinding: structuredClone(input.proposalBinding),
    proposalOperation: structuredClone(proposalOperation),
    requestSha256: input.requestSha256,
    approvalSha256: input.approvalSha256,
    proposalOutputSha256: input.proposalOutputSha256,
    proposalStepId: input.proposalStepId,
    proposalSelectionSha256: input.proposalSelectionSha256,
    selectionSummary: input.selectionSummary,
    proposalTerminalProof: structuredClone(input.proposalTerminalProof),
    reviewSha256: input.reviewSha256,
    reviewTerminalProof: structuredClone(input.reviewTerminalProof),
    applicationPublicOperation: application.publicOperation,
    applicationOperation: structuredClone(application),
    targetNodeIds,
    scope: structuredClone(scope),
    authoritySha256,
    kind: "application" as const,
    applicationTicketId,
    applicationOperationId: application.id,
    applicationBinding,
    controlScopeNodeIds: scope.writeNodeIds,
    disposition,
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

export interface SourceReleaseDecision {
  readonly protocol: typeof SOURCE_RELEASE_DECISION_PROTOCOL;
  readonly sourceTicketId: string;
  readonly proposalTicketId: string;
  readonly disposition: "hold" | "release";
  readonly reason:
    "proposal_pending" | "application_pending" | "rejected" | "no_op" | "application_completed";
  readonly retirePriorExecutionAuthority: boolean;
  readonly sha256: Sha256Digest;
}

export function deriveSourceReleaseDecision(
  input: Readonly<{
    sourceTicketId: string;
    heldByProposalTicketId: string;
    proposalTerminal: boolean;
    proposalTerminalSha256?: Sha256Digest;
    proposalDisposition:
      | { kind: "pending" }
      | { kind: "rejected"; authoritySha256: Sha256Digest }
      | { kind: "no_op"; authoritySha256: Sha256Digest }
      | {
          kind: "application";
          authoritySha256: Sha256Digest;
          applicationTicketId: string;
          applicationApprovalSha256: Sha256Digest;
          applicationTerminal: boolean;
          applicationTerminalSha256?: Sha256Digest;
        };
  }>,
): SourceReleaseDecision {
  requireNonempty(input.sourceTicketId, "source ticket id");
  requireNonempty(input.heldByProposalTicketId, "held proposal ticket id");
  if (input.proposalTerminal) {
    requireDigest(input.proposalTerminalSha256, "terminal proposal authority hash");
  } else if (input.proposalTerminalSha256 !== undefined) {
    fail(
      "change_control.proposal_terminal_authority",
      "nonterminal proposal supplied terminal authority",
    );
  }
  let disposition: SourceReleaseDecision["disposition"] = "hold";
  let reason: SourceReleaseDecision["reason"] = "proposal_pending";
  if (input.proposalDisposition.kind === "rejected" || input.proposalDisposition.kind === "no_op") {
    requireDigest(input.proposalDisposition.authoritySha256, "proposal disposition authority hash");
    if (!input.proposalTerminal) {
      fail(
        "change_control.nonterminal_disposition",
        `${input.proposalDisposition.kind} proposal must be terminal before source release`,
      );
    }
    disposition = "release";
    reason = input.proposalDisposition.kind;
  } else if (input.proposalDisposition.kind === "application") {
    requireNonempty(input.proposalDisposition.applicationTicketId, "application ticket id");
    requireDigest(input.proposalDisposition.authoritySha256, "proposal application authority hash");
    requireDigest(
      input.proposalDisposition.applicationApprovalSha256,
      "application approval authority hash",
    );
    if (
      input.proposalDisposition.applicationApprovalSha256 !==
      input.proposalDisposition.authoritySha256
    ) {
      fail(
        "change_control.application_authority",
        "application child authority differs from the proposal disposition",
      );
    }
    if (input.proposalDisposition.applicationTerminal) {
      requireDigest(
        input.proposalDisposition.applicationTerminalSha256,
        "terminal application authority hash",
      );
    } else if (input.proposalDisposition.applicationTerminalSha256 !== undefined) {
      fail(
        "change_control.application_terminal_authority",
        "nonterminal application supplied terminal authority",
      );
    }
    if (!input.proposalTerminal || !input.proposalDisposition.applicationTerminal) {
      reason = "application_pending";
    } else {
      disposition = "release";
      reason = "application_completed";
    }
  }
  const material = {
    protocol: SOURCE_RELEASE_DECISION_PROTOCOL,
    sourceTicketId: input.sourceTicketId,
    proposalTicketId: input.heldByProposalTicketId,
    proposalTerminal: input.proposalTerminal,
    proposalTerminalSha256: input.proposalTerminalSha256 ?? null,
    proposalDisposition: input.proposalDisposition,
    disposition,
    reason,
    retirePriorExecutionAuthority: disposition === "release",
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

export interface ExistingTerminalResolver {
  readonly ticketId: string;
  readonly sourceTicketId: string;
  readonly resolverOperationId: string;
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly failureBindingSha256s: readonly Sha256Digest[];
  /** Completed/retired resolvers remain immutable audit evidence and do not block a new failure. */
  readonly terminal: boolean;
}

export type TerminalResolverReconciliation =
  | Readonly<{
      protocol: typeof TERMINAL_RESOLVER_RECONCILIATION_PROTOCOL;
      configurationSha256: Sha256Digest;
      catalogSha256: Sha256Digest;
      sourceTicketId: string;
      resolverOperationId: string;
      resolverTicketId: string;
      resolverBinding: ExecutionPolicyBinding;
      failureBindingSha256s: readonly Sha256Digest[];
      disposition: "create" | "reuse";
      sourceLink: "apply_or_repair_after_resolver";
      chainSuppressed: false;
      sha256: Sha256Digest;
    }>
  | Readonly<{
      protocol: typeof TERMINAL_RESOLVER_RECONCILIATION_PROTOCOL;
      configurationSha256: Sha256Digest;
      catalogSha256: Sha256Digest;
      sourceTicketId: string;
      resolverOperationId: string;
      failureBindingSha256s: readonly Sha256Digest[];
      disposition: "chain_suppressed";
      sourceLink: "operator_recovery_required";
      chainSuppressed: true;
      sha256: Sha256Digest;
    }>;

/** Derive one replay-safe terminal resolver or suppress recursive resolver fan-out. */
export function deriveTerminalResolverReconciliation(
  catalog: CompiledExecutionSemanticCatalog,
  input: Readonly<{
    runId: string;
    sourceTicketId: string;
    sourceBinding: ExecutionPolicyBinding;
    failureBindingSha256: Sha256Digest;
    existingResolvers: readonly ExistingTerminalResolver[];
  }>,
): TerminalResolverReconciliation {
  requireNonempty(input.runId, "run id");
  requireNonempty(input.sourceTicketId, "source ticket id");
  requireDigest(input.failureBindingSha256, "terminal failure binding hash");
  const sourceOperation = exactBoundOperation(catalog, input.sourceBinding);
  const resolverId = catalog.terminalResolverOperationId;
  if (resolverId === undefined) {
    fail("change_control.terminal_resolver_missing", "pinned catalog has no terminal resolver");
  }
  const resolverOperation = catalog.operations[resolverId];
  if (resolverOperation === undefined || !resolverOperation.terminalResolver) {
    fail(
      "change_control.terminal_resolver_stale",
      `pinned terminal resolver ${resolverId} is missing or invalid`,
    );
  }
  if (sourceOperation.terminalResolver) {
    const material = {
      protocol: TERMINAL_RESOLVER_RECONCILIATION_PROTOCOL,
      configurationSha256: catalog.configurationSha256,
      catalogSha256: catalog.sha256,
      sourceTicketId: input.sourceTicketId,
      resolverOperationId: resolverOperation.id,
      failureBindingSha256s: Object.freeze([input.failureBindingSha256]),
      disposition: "chain_suppressed" as const,
      sourceLink: "operator_recovery_required" as const,
      chainSuppressed: true as const,
    };
    return deepFreeze({ ...material, sha256: canonicalHash(material) });
  }
  const resolverTicketId = deterministicTicketId("recovery", {
    runId: input.runId,
    sourceTicketId: input.sourceTicketId,
    failureBindingSha256: input.failureBindingSha256,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    resolverOperationId: resolverOperation.id,
  });
  if (
    input.existingResolvers.some(
      (resolver) =>
        resolver.sourceTicketId === input.sourceTicketId &&
        resolver.ticketId !== resolverTicketId &&
        !resolver.terminal,
    )
  ) {
    fail(
      "change_control.terminal_resolver_ambiguous",
      `source ${input.sourceTicketId} already has a noncanonical terminal resolver`,
    );
  }
  const existing = input.existingResolvers.filter(
    (resolver) => resolver.ticketId === resolverTicketId,
  );
  if (existing.length > 1) {
    fail(
      "change_control.terminal_resolver_ambiguous",
      `source ${input.sourceTicketId} has duplicate terminal resolver records`,
    );
  }
  const prior = existing[0];
  if (
    prior !== undefined &&
    (prior.sourceTicketId !== input.sourceTicketId ||
      prior.resolverOperationId !== resolverOperation.id ||
      prior.configurationSha256 !== catalog.configurationSha256 ||
      prior.catalogSha256 !== catalog.sha256)
  ) {
    fail(
      "change_control.terminal_resolver_collision",
      `terminal resolver ${resolverTicketId} conflicts with its pinned source authority`,
    );
  }
  const failureBindingSha256s = [input.failureBindingSha256] as Sha256Digest[];
  if (
    prior !== undefined &&
    (prior.failureBindingSha256s.length !== 1 ||
      prior.failureBindingSha256s[0] !== input.failureBindingSha256)
  ) {
    fail(
      "change_control.terminal_resolver_collision",
      `terminal resolver ${resolverTicketId} is not bound to its one immutable failure`,
    );
  }
  for (const hash of failureBindingSha256s) requireDigest(hash, "terminal failure binding hash");
  const resolverBinding = resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId: resolverOperation.id,
    ...(resolverOperation.workflowId === undefined
      ? {}
      : {
          workflowId: resolverOperation.workflowId,
        }),
  });
  const material = {
    protocol: TERMINAL_RESOLVER_RECONCILIATION_PROTOCOL,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    sourceTicketId: input.sourceTicketId,
    resolverOperationId: resolverOperation.id,
    resolverTicketId,
    resolverBinding,
    failureBindingSha256s: Object.freeze(failureBindingSha256s),
    disposition: prior === undefined ? ("create" as const) : ("reuse" as const),
    sourceLink: "apply_or_repair_after_resolver" as const,
    chainSuppressed: false as const,
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

export interface ExistingTerminalResolverRetry {
  readonly ordinal: number;
  readonly resolverFailureBindingSha256: Sha256Digest;
  readonly sha256: Sha256Digest;
}

export interface TerminalResolverRetryRequest {
  readonly protocol: typeof TERMINAL_RESOLVER_RETRY_PROTOCOL;
  readonly ordinal: number;
  readonly eventId: string;
  readonly actor: "operator";
  readonly message: string;
  readonly recordedAt: string;
  readonly runId: string;
  readonly resolverTicketId: string;
  readonly sourceTicketId: string;
  readonly sourceFailureBindingSha256: Sha256Digest;
  readonly resolverFailureBindingSha256: Sha256Digest;
  readonly failureSettlementSha256: Sha256Digest;
  readonly failureProof: TerminalFailureSettlementProof;
  readonly failedAttemptId: string;
  readonly launchSpecHash: Sha256Digest;
  readonly terminalPolicySha256: Sha256Digest;
  readonly terminalOutputSha256: Sha256Digest;
  readonly configurationSha256: Sha256Digest;
  readonly catalogSha256: Sha256Digest;
  readonly resolverBindingSha256: Sha256Digest;
  readonly sha256: Sha256Digest;
}

/**
 * Compile one bounded operator retry for an exact chain-suppressed resolver failure. The request
 * is immutable audit and is also the Git-cycle supersession authority used by the runtime.
 */
export function deriveTerminalResolverRetryRequest(
  catalog: CompiledExecutionSemanticCatalog,
  input: Readonly<{
    runId: string;
    resolverTicketId: string;
    resolverBinding: ExecutionPolicyBinding;
    sourceTicketId: string;
    sourceFailureBindingSha256: Sha256Digest;
    resolverFailure: Readonly<{
      sha256: Sha256Digest;
      attemptId: string;
      launchSpecHash: Sha256Digest;
      terminalPolicySha256: Sha256Digest;
      terminalOutputSha256: Sha256Digest;
      failureSettlementSha256: Sha256Digest;
      failureProof: TerminalFailureSettlementProof;
    }>;
    priorRetries: readonly ExistingTerminalResolverRetry[];
    event: Readonly<{
      eventId: string;
      actor: "operator";
      message: string;
      recordedAt: string;
    }>;
  }>,
): TerminalResolverRetryRequest {
  requireNonempty(input.runId, "run id");
  requireNonempty(input.resolverTicketId, "resolver ticket id");
  requireNonempty(input.sourceTicketId, "resolver source ticket id");
  requireDigest(input.sourceFailureBindingSha256, "resolver source failure binding hash");
  requireDigest(input.resolverFailure.sha256, "resolver failure binding hash");
  requireNonempty(input.resolverFailure.attemptId, "resolver failed attempt id");
  requireDigest(input.resolverFailure.launchSpecHash, "resolver launch spec hash");
  requireDigest(input.resolverFailure.terminalPolicySha256, "resolver terminal policy hash");
  requireDigest(input.resolverFailure.terminalOutputSha256, "resolver terminal output hash");
  requireDigest(
    input.resolverFailure.failureSettlementSha256,
    "resolver semantic failure settlement hash",
  );
  if (
    input.resolverFailure.failureProof.sha256 !== input.resolverFailure.failureSettlementSha256 ||
    input.resolverFailure.failureProof.attemptId !== input.resolverFailure.attemptId ||
    input.resolverFailure.failureProof.terminalPolicySha256 !==
      input.resolverFailure.terminalPolicySha256 ||
    input.resolverFailure.failureProof.terminalOutputSha256 !==
      input.resolverFailure.terminalOutputSha256 ||
    input.resolverFailure.failureProof.semanticResult.status !== "failed"
  ) {
    fail(
      "change_control.terminal_resolver_retry_failure_proof",
      "resolver retry lacks its exact failed semantic settlement",
    );
  }
  requireNonempty(input.event.eventId, "resolver retry event id");
  requireNonempty(input.event.recordedAt, "resolver retry timestamp");
  if (input.event.actor !== "operator") {
    fail(
      "change_control.terminal_resolver_retry_actor",
      "terminal resolver retry must be operator-authored",
    );
  }
  if (
    input.event.message.trim().length === 0 ||
    Buffer.byteLength(input.event.message, "utf8") > 64 * 1024
  ) {
    fail(
      "change_control.terminal_resolver_retry_message",
      "terminal resolver retry requires a nonempty operator message of at most 64 KiB",
    );
  }
  if (input.priorRetries.length >= MAX_TERMINAL_RESOLVER_RETRIES) {
    fail(
      "change_control.terminal_resolver_retry_limit",
      `terminal resolver retry limit (${MAX_TERMINAL_RESOLVER_RETRIES}) has been reached`,
    );
  }
  if (
    input.priorRetries.some(
      (retry) => retry.resolverFailureBindingSha256 === input.resolverFailure.sha256,
    )
  ) {
    fail(
      "change_control.terminal_resolver_retry_replay",
      "this exact terminal resolver failure already has an operator retry request",
    );
  }
  const operation = exactBoundOperation(catalog, input.resolverBinding);
  if (!operation.terminalResolver || operation.id !== catalog.terminalResolverOperationId) {
    fail(
      "change_control.terminal_resolver_retry_route",
      `operation ${operation.id} is not the pinned terminal resolver`,
    );
  }
  const material = {
    protocol: TERMINAL_RESOLVER_RETRY_PROTOCOL,
    ordinal: input.priorRetries.length + 1,
    eventId: input.event.eventId,
    actor: input.event.actor,
    message: input.event.message,
    recordedAt: input.event.recordedAt,
    runId: input.runId,
    resolverTicketId: input.resolverTicketId,
    sourceTicketId: input.sourceTicketId,
    sourceFailureBindingSha256: input.sourceFailureBindingSha256,
    resolverFailureBindingSha256: input.resolverFailure.sha256,
    failureSettlementSha256: input.resolverFailure.failureSettlementSha256,
    failureProof: structuredClone(input.resolverFailure.failureProof),
    failedAttemptId: input.resolverFailure.attemptId,
    launchSpecHash: input.resolverFailure.launchSpecHash,
    terminalPolicySha256: input.resolverFailure.terminalPolicySha256,
    terminalOutputSha256: input.resolverFailure.terminalOutputSha256,
    configurationSha256: catalog.configurationSha256,
    catalogSha256: catalog.sha256,
    resolverBindingSha256: input.resolverBinding.sha256,
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function exactBoundOperation(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
): CompiledOperationSemantics {
  const expected = resolveExecutionPolicyBinding(catalog, {
    configurationSha256: catalog.configurationSha256,
    operationId: binding.operationId,
    ...(binding.workflowId === undefined ? {} : { workflowId: binding.workflowId }),
    ...(binding.stepId === undefined ? {} : { stepId: binding.stepId }),
  });
  if (expected.sha256 !== binding.sha256 || canonicalHash(expected) !== canonicalHash(binding)) {
    fail(
      "change_control.execution_binding_stale",
      `execution-policy binding ${binding.operationId} is stale or mutated`,
    );
  }
  return catalog.operations[binding.operationId]!;
}

function uniquePublicOperation(
  catalog: CompiledExecutionSemanticCatalog,
  publicOperation: string,
  expected: "proposal" | "application_or_disposition",
): CompiledOperationSemantics {
  const matches = Object.values(catalog.operations).filter(
    (operation) => operation.publicOperation === publicOperation,
  );
  const operation = matches.length === 1 ? matches[0] : undefined;
  const role = operation?.changeControl.role;
  if (
    operation === undefined ||
    (expected === "proposal"
      ? role !== "proposal"
      : role !== "application" && role !== "disposition")
  ) {
    fail(
      "change_control.operation_route",
      `public operation ${publicOperation} does not resolve to one typed ${expected} operation`,
    );
  }
  return operation;
}

function assertApprovalAuthority(authority: ProposalApprovalAuthority): void {
  if (authority.protocol !== PROPOSAL_DECISION_AUTHORITY_PROTOCOL) {
    fail("change_control.approval_protocol", "proposal decision authority protocol is invalid");
  }
  requireNonempty(authority.runId, "approval run id");
  requireNonempty(authority.proposalTicketId, "approval proposal ticket id");
  requireDigest(authority.requestSha256, "approval proposal request hash");
  requireNonempty(authority.eventId, "approval event id");
  if (authority.actor !== "operator") {
    fail("change_control.approval_actor", "proposal decision authority must be operator-authored");
  }
  requireNonempty(authority.recordedAt, "approval timestamp");
  requireNonempty(authority.message, "approval message");
  requireDigest(authority.sha256, "approval authority hash");
  const { sha256: _sha256, ...material } = authority;
  if (canonicalHash(material) !== authority.sha256) {
    fail("change_control.approval_integrity", "proposal approval authority hash is invalid");
  }
}

function canonicalScope(scope: ApprovedApplicationScope): ApprovedApplicationScope {
  return deepFreeze({
    readNodeIds: canonicalStrings(scope.readNodeIds, "application read nodes", true),
    writeNodeIds: canonicalStrings(scope.writeNodeIds, "application write nodes", true),
    readPaths: canonicalStrings(scope.readPaths, "application read paths", true),
    writePaths: canonicalStrings(scope.writePaths, "application write paths", true),
  });
}

function canonicalStrings(values: readonly string[], label: string, allowEmpty: boolean): string[] {
  const output = values
    .map((value) => {
      requireNonempty(value, label);
      return value;
    })
    .sort(compareUtf8);
  const unique = [...new Set(output)];
  if (unique.length !== output.length)
    fail("change_control.duplicate", `${label} contain duplicates`);
  if (!allowEmpty && unique.length === 0) fail("change_control.empty", `${label} must be nonempty`);
  return unique;
}

function deterministicTicketId(
  kind: "change" | "application" | "recovery",
  material: unknown,
): string {
  return `TK-${kind}-${canonicalHash(material).slice("sha256:".length, "sha256:".length + 24)}`;
}

function requireNonempty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("change_control.string", `${label} must be nonempty`);
  }
}

function requireDigest(value: unknown, label: string): asserts value is Sha256Digest {
  if (!isSha256Digest(value)) fail("change_control.digest", `${label} must be a SHA-256 digest`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fail(code: string, message: string): never {
  throw new ChangeControlAuthorityError(code, message);
}
