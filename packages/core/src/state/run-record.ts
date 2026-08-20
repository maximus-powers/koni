import {
  assertCheckExecutionPolicyBinding,
  assertExecutionPolicyBindingIntegrity,
  decideBoundCheckRetry,
  type ExecutionPolicyBinding,
} from "../authority/execution-policy.js";
import type {
  CompiledOperationSemantics,
  CompiledWorkflowSemantics,
} from "../compiler/execution-semantics.js";
import { assertCompiledStateMachineCatalog } from "../compiler/rules.js";
import type { CompiledTokenPolicy } from "../contracts/behavior.js";
import type { CompiledStateMachineCatalog, DerivedTicketDefinition } from "../contracts/rules.js";
import { assertGitLifecycleIntent, assertRunGitLifecycleRecord } from "../git/lifecycle.js";
import {
  canonicalHash,
  compareUtf8,
  isSha256Digest,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  deriveSourceReleaseDecision,
  type ApprovedChangeMaterialization,
  type SourceReleaseDecision,
} from "./change-control.js";
import { assertLegacyRunGitMigrationRecord } from "./legacy-run-git-migration.js";
import { assertQuestionBatchRecord } from "./question-batch.js";
import {
  COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR,
  ticketDependencySettled,
} from "./ticket-dependency.js";

import {
  assertRunActionArchive,
  assertRunActionExecutions,
  assertRunBehaviorSnapshot,
  assertTerminalFailureProofIndex,
  assertTerminalFailureSettlementProof,
  assertTerminalSuccessProofIndex,
  assertTerminalSuccessSettlementProof,
} from "./run-record-archive.js";
import {
  CONTROL_TICKET_AUTHORITY_PROTOCOL,
  createTerminalFailureSettlementProof,
  createTerminalSuccessSettlementProof,
  deriveRunActionExecutionArchive,
  deriveRunActionExecutionArchiveSegment,
  RUN_RECORD_PROTOCOL,
  TICKET_IMMUTABLE_PROJECTION_PROTOCOL,
  type AgentAttemptRecord,
  type AgentProviderTokenTotals,
  type AttemptStatus,
  type CompilerCheckPreflightRejectionRecord,
  type CompilerControlTicketAuthority,
  type ControlTicketCausalAuthority,
  type ControlTicketRole,
  type HeldSourceGrantRefreshAuthority,
  type PendingCheckIntentRecord,
  type PendingCompilerCheckPreflightIntentRecord,
  type PlanningRevisionRecord,
  type PlanningSessionRecord,
  type PlanningSteeringBinding,
  type ProposalReviewExhaustionAuthority,
  type RecurringAssetGrantRefreshAuthority,
  type ReviewReworkOperatorAuthorization,
  type RunActionArchiveArtifactWrite,
  type RunActionArchiveMutationProjection,
  type RunActionExecutionRecord,
  type RunActionSettlementRecord,
  type RunBehaviorSnapshot,
  type RunCheckAttemptRecord,
  type RunCheckRecord,
  type RunCheckSourceManifestRecord,
  type RunLeadJudgmentRecord,
  type RunPostOrchestrationBinding,
  type RunPostOrchestrationRecord,
  type RunRecord,
  type RunReportRecord,
  type SourceCorrectionSeedAuthority,
  type TerminalFailureSettlementProof,
  type TerminalSuccessSettlementProof,
  type TicketExecutionControlRecord,
  type TicketImmutableProjection,
  type TicketRecord,
  type TicketStepRecord,
  type WorkspaceEffectIntentRecord,
} from "./run-record-contracts.js";
import {
  assertAppendOnlyControlEvents,
  assertAttemptLineageForest,
  assertAttemptRecord,
  assertCanonicalDigestArray,
  assertCanonicalIdArray,
  assertImmutableControlField,
  assertInterruptedTerminalAcceptanceSettlement,
  assertProposalDecisionEvent,
  assertQuestionRecord,
  assertTicketStepGraph,
  assertUniqueIds,
  assertUniquePaths,
  isBoundedRecordText,
  isId,
  isNonnegativeSafeInteger,
  isPlanningSynthesisRecord,
  isProjectRelativePath,
  isRecord,
  isRevision,
  isStringArray,
} from "./run-record-validation.js";
export * from "./run-record-archive.js";
export * from "./run-record-contracts.js";

export function leadJudgmentTicketBoard(run: Readonly<Pick<RunRecord, "tickets">>) {
  return Object.values(run.tickets)
    .sort((left, right) => left.priority - right.priority || compareUtf8(left.id, right.id))
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
        ...(ticket.blocker === undefined ? {} : { blocker: ticket.blocker }),
        scope: {
          readNodeIds: ticket.readNodeIds ?? [],
          writeNodeIds: ticket.writeNodeIds ?? [],
          ...(ticket.readPaths === undefined ? {} : { readPaths: ticket.readPaths }),
          ...(ticket.writePaths === undefined ? {} : { writePaths: ticket.writePaths }),
        },
        steps: ticket.steps.map((step) => ({
          id: step.id,
          ...(step.kind === undefined ? {} : { kind: step.kind }),
          personaId: step.personaId,
          status: step.status,
          ...(step.summary === undefined ? {} : { summary: step.summary }),
        })),
      };
    });
}

/** Bind a deadlock judgment to the exact compiler-visible ticket frontier it evaluated. */
export function leadJudgmentFrontierSha256(
  run: Readonly<Pick<RunRecord, "tickets">>,
): Sha256Digest {
  return canonicalHash(leadJudgmentTicketBoard(run));
}

/** Exact semantic product admitted before a compiler-owned Lead launch. */
export function leadJudgmentProductSha256(
  run: Readonly<RunRecord>,
  trigger: RunLeadJudgmentRecord["trigger"],
): Sha256Digest {
  if (
    run.behavior === undefined ||
    run.graphHash === undefined ||
    run.git.run.headOid === undefined
  ) {
    throw new Error("Lead action product requires pinned behavior, graph, and run Git identity");
  }
  return canonicalHash({
    behaviorSha256: run.behavior.sha256,
    graphHash: run.graphHash,
    runOid: run.git.run.headOid,
    stageId: run.currentPipelineStageId ?? null,
    trigger,
    priorJudgments: (run.leadJudgments ?? []).map((judgment) => ({
      trigger: judgment.trigger,
      disposition: judgment.disposition,
      graphHash: judgment.graphHash,
      runOid: judgment.runOid,
      frontierSha256: judgment.frontierSha256 ?? null,
    })),
    frontierSha256: trigger === "compiler_deadlock" ? leadJudgmentFrontierSha256(run) : null,
  });
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

export function terminalTicketAuthoritySha256(ticket: Readonly<TicketRecord>): Sha256Digest {
  return canonicalHash({
    protocol: "koni.terminal-ticket-authority.v1",
    ticketId: ticket.id,
    operationId: ticket.operationId,
    status: ticket.status,
    executionPolicyBindingSha256: ticket.executionPolicyBinding?.sha256 ?? null,
    executionControl: ticket.executionControl ?? null,
    steps: ticket.steps.map((step) => ({
      id: step.id,
      status: step.status,
      attemptIds: step.attemptIds,
      summary: step.summary ?? null,
      completedAt: step.completedAt ?? null,
      executionPolicyBindingSha256: step.executionPolicyBinding?.sha256 ?? null,
    })),
  });
}

/** Derive the exact durable source-release decision from one accepted run state. */
export function sourceReleaseDecisionForRun(
  run: Readonly<RunRecord>,
  source: Readonly<TicketRecord>,
  proposal: Readonly<TicketRecord>,
): SourceReleaseDecision {
  const proposalTerminal = proposal.status === "completed" || proposal.status === "cancelled";
  const disposition = proposal.executionControl?.proposalDisposition;
  const exhaustedReview = proposal.executionControl?.proposalReviewExhaustion;
  if (
    proposal.status === "cancelled" &&
    (disposition === undefined ||
      (exhaustedReview !== undefined &&
        proposalReviewExhaustionMatchesRun(run, proposal, exhaustedReview)))
  ) {
    return deriveSourceReleaseDecision({
      sourceTicketId: source.id,
      heldByProposalTicketId: proposal.id,
      proposalTerminal: true,
      proposalTerminalSha256: terminalTicketAuthoritySha256(proposal),
      proposalDisposition: { kind: "cancelled" },
    });
  }
  if (disposition?.kind === "rejected" || disposition?.kind === "no_op") {
    return deriveSourceReleaseDecision({
      sourceTicketId: source.id,
      heldByProposalTicketId: proposal.id,
      proposalTerminal,
      ...(proposalTerminal
        ? { proposalTerminalSha256: terminalTicketAuthoritySha256(proposal) }
        : {}),
      proposalDisposition: {
        kind: disposition.kind,
        authoritySha256: disposition.authoritySha256,
      },
    });
  }
  if (disposition?.kind === "application" && disposition.applicationTicketId !== undefined) {
    const application = run.tickets[disposition.applicationTicketId];
    const applicationApprovalSha256 = application?.executionControl?.approvedApplicationSha256;
    if (application === undefined || applicationApprovalSha256 === undefined) {
      throw new Error(`proposal ${proposal.id} names a missing or unauthenticated application`);
    }
    const applicationTerminal = application.status === "completed";
    return deriveSourceReleaseDecision({
      sourceTicketId: source.id,
      heldByProposalTicketId: proposal.id,
      proposalTerminal,
      ...(proposalTerminal
        ? { proposalTerminalSha256: terminalTicketAuthoritySha256(proposal) }
        : {}),
      proposalDisposition: {
        kind: "application",
        authoritySha256: disposition.authoritySha256,
        applicationTicketId: application.id,
        applicationApprovalSha256,
        applicationTerminal,
        ...(applicationTerminal
          ? { applicationTerminalSha256: terminalTicketAuthoritySha256(application) }
          : {}),
      },
    });
  }
  return deriveSourceReleaseDecision({
    sourceTicketId: source.id,
    heldByProposalTicketId: proposal.id,
    proposalTerminal,
    ...(proposalTerminal
      ? { proposalTerminalSha256: terminalTicketAuthoritySha256(proposal) }
      : {}),
    proposalDisposition: { kind: "pending" },
  });
}

function proposalReviewExhaustionBinding(
  run: Readonly<RunRecord>,
  proposal: Readonly<TicketRecord>,
) {
  const control = proposal.executionControl;
  const request = control?.proposalRequest;
  const authority = control?.controlTicketAuthority;
  const review = [...proposal.steps].reverse().find((step) => step.kind === "review");
  const failedReviewAttemptId = review?.attemptIds.at(-1);
  const attempt =
    failedReviewAttemptId === undefined ? undefined : run.attempts[failedReviewAttemptId];
  const failureBindings =
    failedReviewAttemptId === undefined
      ? []
      : Object.values(run.terminalFailureProofs ?? {})
          .filter((proof) => proof.attemptId === failedReviewAttemptId)
          .map((proof) => terminalFailureBindingFromProof(run, proposal, proof))
          .filter((binding): binding is TerminalFailureBindingRecord => binding !== undefined);
  const failureBinding = failureBindings.length === 1 ? failureBindings[0] : undefined;
  const configuredValidation = run.behavior !== undefined && review?.validationAction !== undefined;
  const reviewReworkCount = proposal.reviewReworkCount;
  const reviewReworkLimit = proposal.reviewReworkLimit;
  if (
    request === undefined ||
    authority?.role !== "proposal" ||
    authority.causal.role !== "proposal" ||
    authority.runId !== run.id ||
    authority.ticketId !== proposal.id ||
    authority.causal.publication.requestSha256 !== request.requestSha256 ||
    authority.causal.publication.sourceTicketId !== request.sourceTicketId ||
    review?.status !== "failed" ||
    failedReviewAttemptId === undefined ||
    attempt?.status !== "completed" ||
    attempt.ticketId !== proposal.id ||
    attempt.stepId !== review.id ||
    (configuredValidation
      ? failureBinding?.failureProof.semanticResult.status !== "failed" ||
        failureBinding.failureProof.semanticResult.blocker !== proposal.blocker
      : attempt.terminalSummary !== proposal.blocker) ||
    attempt.terminalPolicy === undefined ||
    attempt.terminalOutputSha256 === undefined ||
    attempt.terminalAcceptedAt === undefined ||
    reviewReworkCount === undefined ||
    reviewReworkLimit === undefined ||
    reviewReworkLimit < 1 ||
    reviewReworkCount < reviewReworkLimit ||
    proposal.blocker === undefined ||
    proposal.blocker.trim().length === 0
  ) {
    return undefined;
  }
  return {
    protocol: "koni.proposal-review-exhaustion.v1",
    runId: run.id,
    proposalTicketId: proposal.id,
    requestSha256: request.requestSha256,
    sourceTicketId: request.sourceTicketId,
    reviewStepId: review.id,
    failedReviewAttemptId,
    reviewReworkCount,
    reviewReworkLimit,
    blocker: proposal.blocker,
    launchSpecHash: attempt.launchSpecHash,
    terminalPolicySha256: attempt.terminalPolicy.sha256,
    terminalOutputSha256: attempt.terminalOutputSha256,
    terminalAcceptedAt: attempt.terminalAcceptedAt,
    failureSettlementSha256: failureBinding?.failureSettlementSha256 ?? null,
  };
}

export function deriveProposalReviewExhaustionAuthority(
  run: Readonly<RunRecord>,
  proposal: Readonly<TicketRecord>,
): ProposalReviewExhaustionAuthority | undefined {
  const binding = proposalReviewExhaustionBinding(run, proposal);
  const request = proposal.executionControl?.proposalRequest;
  const source = request === undefined ? undefined : run.tickets[request.sourceTicketId];
  const hold = source?.executionControl?.sourceHold;
  if (
    proposal.status !== "blocked" ||
    binding === undefined ||
    hold?.proposalTicketId !== proposal.id ||
    hold.requestSha256 !== request?.requestSha256
  ) {
    return undefined;
  }
  return {
    protocol: "koni.proposal-review-exhaustion.v1",
    failedReviewAttemptId: binding.failedReviewAttemptId,
    sha256: canonicalHash(binding),
  };
}

function proposalReviewExhaustionMatchesRun(
  run: Readonly<RunRecord>,
  proposal: Readonly<TicketRecord>,
  proof: Readonly<ProposalReviewExhaustionAuthority>,
): boolean {
  const binding = proposalReviewExhaustionBinding(run, proposal);
  return (
    proposal.status === "cancelled" &&
    binding !== undefined &&
    binding.failedReviewAttemptId === proof.failedReviewAttemptId &&
    canonicalHash(binding) === proof.sha256
  );
}

export function sourceCorrectionSeedRoute(
  run: Readonly<RunRecord>,
  source: Readonly<TicketRecord>,
  proposal: Readonly<TicketRecord>,
): SourceCorrectionSeedAuthority["route"] | undefined {
  const request = proposal.executionControl?.proposalRequest;
  if (request?.sourceTicketId !== source.id) {
    return undefined;
  }
  const release = sourceReleaseDecisionForRun(run, source, proposal);
  if (release.disposition !== "release") return undefined;
  if (
    release.reason === "cancelled" &&
    request.fulfillment === "planned_asset_repair" &&
    proposal.blocker === COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR
  ) {
    return "planned_asset_repair";
  }
  if (
    release.reason === "cancelled" &&
    proposal.executionControl?.proposalReviewExhaustion !== undefined &&
    proposalReviewExhaustionMatchesRun(
      run,
      proposal,
      proposal.executionControl.proposalReviewExhaustion,
    )
  ) {
    return "proposal_review_exhausted";
  }
  if (release.reason === "no_op") return "no_op";
  if (release.reason === "application_completed") return "approved_application";
  return undefined;
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
  if (value.compilerCheckPreflightRejections !== undefined) {
    if (
      !Array.isArray(value.compilerCheckPreflightRejections) ||
      value.compilerCheckPreflightRejections.length > 100_000
    ) {
      throw new Error("run compiler check preflight rejections are invalid");
    }
    for (const rejection of value.compilerCheckPreflightRejections) {
      assertCompilerCheckPreflightRejection(rejection, value as unknown as RunRecord);
    }
  }
  if (value.pendingCompilerCheckPreflights !== undefined) {
    if (!isRecord(value.pendingCompilerCheckPreflights)) {
      throw new Error("run pending compiler check preflights are invalid");
    }
    for (const [id, intent] of Object.entries(value.pendingCompilerCheckPreflights)) {
      assertPendingCompilerCheckPreflight(id, intent, value as unknown as RunRecord);
    }
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

function assertPendingCompilerCheckPreflight(
  id: string,
  value: unknown,
  run: Readonly<RunRecord>,
): asserts value is PendingCompilerCheckPreflightIntentRecord {
  if (!isRecord(value)) throw new Error("invalid pending compiler check preflight");
  const allowed = new Set([
    "protocol",
    "id",
    "runId",
    "runRevision",
    "configurationSha256",
    "consumerTicketId",
    "consumerStepId",
    "producerTicketIds",
    "producerProjectionSha256s",
    "preparedAt",
    "sha256",
  ]);
  const material = {
    protocol: "koni.pending-compiler-check-preflight.v1" as const,
    id: value.id,
    runId: value.runId,
    runRevision: value.runRevision,
    configurationSha256: value.configurationSha256,
    consumerTicketId: value.consumerTicketId,
    consumerStepId: value.consumerStepId,
    producerTicketIds: value.producerTicketIds,
    producerProjectionSha256s: value.producerProjectionSha256s,
    preparedAt: value.preparedAt,
  };
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.protocol !== material.protocol ||
    value.id !== id ||
    !isId(value.id) ||
    value.runId !== run.id ||
    !isNonnegativeSafeInteger(value.runRevision) ||
    !isSha256Digest(value.configurationSha256) ||
    !isId(value.consumerTicketId) ||
    !isId(value.consumerStepId) ||
    !isStringArray(value.producerTicketIds) ||
    value.producerTicketIds.length === 0 ||
    new Set(value.producerTicketIds).size !== value.producerTicketIds.length ||
    !Array.isArray(value.producerProjectionSha256s) ||
    value.producerProjectionSha256s.length !== value.producerTicketIds.length ||
    value.producerProjectionSha256s.some((sha256) => !isSha256Digest(sha256)) ||
    typeof value.preparedAt !== "string" ||
    value.preparedAt.length === 0 ||
    !isSha256Digest(value.sha256) ||
    value.sha256 !== canonicalHash(material)
  ) {
    throw new Error("invalid pending compiler check preflight");
  }
}

function assertCompilerCheckPreflightRejection(
  value: unknown,
  run: Readonly<RunRecord>,
): asserts value is CompilerCheckPreflightRejectionRecord {
  if (!isRecord(value)) throw new Error("invalid compiler check preflight rejection");
  const allowed = new Set([
    "protocol",
    "runId",
    "runRevision",
    "configurationSha256",
    "consumerTicketId",
    "consumerStepId",
    "producerTicketIds",
    "producerProjectionSha256s",
    "intentSha256",
    "code",
    "message",
    "recordedAt",
    "sha256",
  ]);
  const material = {
    protocol: "koni.compiler-check-preflight-rejection.v1" as const,
    runId: value.runId,
    runRevision: value.runRevision,
    configurationSha256: value.configurationSha256,
    consumerTicketId: value.consumerTicketId,
    consumerStepId: value.consumerStepId,
    producerTicketIds: value.producerTicketIds,
    producerProjectionSha256s: value.producerProjectionSha256s,
    intentSha256: value.intentSha256,
    code: value.code,
    message: value.message,
    recordedAt: value.recordedAt,
  };
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.protocol !== material.protocol ||
    value.runId !== run.id ||
    !isNonnegativeSafeInteger(value.runRevision) ||
    !isSha256Digest(value.configurationSha256) ||
    !isId(value.consumerTicketId) ||
    !isId(value.consumerStepId) ||
    !isStringArray(value.producerTicketIds) ||
    value.producerTicketIds.length === 0 ||
    new Set(value.producerTicketIds).size !== value.producerTicketIds.length ||
    !Array.isArray(value.producerProjectionSha256s) ||
    value.producerProjectionSha256s.length !== value.producerTicketIds.length ||
    value.producerProjectionSha256s.some((sha256) => !isSha256Digest(sha256)) ||
    !isSha256Digest(value.intentSha256) ||
    !new Set([
      "check_argv",
      "check_input_binding",
      "check_path",
      "check_path_scope",
      "check_result_path",
    ]).has(String(value.code)) ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    Buffer.byteLength(value.message, "utf8") > 64 * 1024 ||
    typeof value.recordedAt !== "string" ||
    value.recordedAt.length === 0 ||
    !isSha256Digest(value.sha256) ||
    value.sha256 !== canonicalHash(material)
  ) {
    throw new Error("invalid compiler check preflight rejection");
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
    (expectedRevision < currentRevision &&
      revision.status !== "superseded" &&
      revision.status !== "failed")
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
      (raw.frontierSha256 !== undefined && !isSha256Digest(raw.frontierSha256)) ||
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
    const bindingTrigger = `${raw.graphHash}\u0000${raw.runOid}\u0000${raw.trigger}\u0000${raw.frontierSha256 ?? "legacy"}`;
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
  if (value.compilerReissueDiagnoses !== undefined) {
    if (
      !Array.isArray(value.compilerReissueDiagnoses) ||
      value.compilerReissueDiagnoses.length > 100 ||
      value.compilerReissueDiagnoses.some((diagnosis) => {
        if (!isRecord(diagnosis)) return true;
        const allowed = new Set([
          "protocol",
          "kind",
          "sourceTicketId",
          "executionEpoch",
          "blocker",
          "sourceSha256",
          "openedAt",
          "sha256",
        ]);
        const material = {
          protocol: "koni.ticket-compiler-reissue-diagnosis.v1" as const,
          kind: diagnosis.kind,
          sourceTicketId: diagnosis.sourceTicketId,
          executionEpoch: diagnosis.executionEpoch,
          blocker: diagnosis.blocker,
          sourceSha256: diagnosis.sourceSha256,
          openedAt: diagnosis.openedAt,
        };
        return (
          Object.keys(diagnosis).some((key) => !allowed.has(key)) ||
          diagnosis.protocol !== material.protocol ||
          !new Set(["configured_check_preflight", "configured_check_result"]).has(
            String(diagnosis.kind),
          ) ||
          !isId(diagnosis.sourceTicketId) ||
          !isNonnegativeSafeInteger(diagnosis.executionEpoch) ||
          typeof diagnosis.blocker !== "string" ||
          diagnosis.blocker.length === 0 ||
          Buffer.byteLength(diagnosis.blocker, "utf8") > 64 * 1024 ||
          !isSha256Digest(diagnosis.sourceSha256) ||
          typeof diagnosis.openedAt !== "string" ||
          diagnosis.openedAt.length === 0 ||
          !isSha256Digest(diagnosis.sha256) ||
          diagnosis.sha256 !== canonicalHash(material)
        );
      })
    ) {
      throw new Error(`invalid ticket compiler-reissue diagnosis: ${id}`);
    }
  }
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
          (rework.failureProofSha256 !== undefined && !isSha256Digest(rework.failureProofSha256)) ||
          (rework.failureTerminalOutputSha256 !== undefined &&
            !isSha256Digest(rework.failureTerminalOutputSha256)) ||
          (rework.operatorAuthorization !== undefined &&
            !isReviewReworkOperatorAuthorization(rework.operatorAuthorization)) ||
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
      Number(value.reviewReworkLimit) > 3 ||
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
          (rework.failureProofSha256 !== undefined && !isSha256Digest(rework.failureProofSha256)) ||
          (rework.failureTerminalOutputSha256 !== undefined &&
            !isSha256Digest(rework.failureTerminalOutputSha256)) ||
          (rework.operatorAuthorization !== undefined &&
            !isReviewReworkOperatorAuthorization(rework.operatorAuthorization)) ||
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

function isReviewReworkOperatorAuthorization(
  value: unknown,
): value is ReviewReworkOperatorAuthorization {
  if (!isRecord(value)) return false;
  const allowed = new Set(["protocol", "method", "idempotencyKey", "requestHash", "sha256"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  const material = {
    protocol: "koni.review-rework-operator-authorization.v1" as const,
    method: value.method,
    idempotencyKey: value.idempotencyKey,
    requestHash: value.requestHash,
  };
  return (
    value.protocol === material.protocol &&
    typeof value.method === "string" &&
    value.method.length > 0 &&
    typeof value.idempotencyKey === "string" &&
    value.idempotencyKey.length > 0 &&
    isSha256Digest(value.requestHash) &&
    isSha256Digest(value.sha256) &&
    value.sha256 === canonicalHash(material)
  );
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

function assertHeldSourceGrantRefreshAuthority(
  ticketId: string,
  value: unknown,
): asserts value is HeldSourceGrantRefreshAuthority {
  if (!isRecord(value)) throw new Error(`invalid held-source grant refresh: ${ticketId}`);
  const allowed = new Set([
    "protocol",
    "runId",
    "ticketId",
    "proposalTicketId",
    "applicationTicketId",
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
    "executionEpoch",
    "sourceCycleId",
    "recordedAt",
    "sha256",
  ]);
  if (
    Object.keys(value).some((field) => !allowed.has(field)) ||
    value.protocol !== "koni.held-source-grant-refresh.v1" ||
    !isId(value.runId) ||
    value.ticketId !== ticketId ||
    !isId(value.proposalTicketId) ||
    !isId(value.applicationTicketId) ||
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
    !isNonnegativeSafeInteger(value.executionEpoch) ||
    !isId(value.sourceCycleId) ||
    typeof value.recordedAt !== "string" ||
    value.recordedAt.length === 0 ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid held-source grant refresh: ${ticketId}`);
  }
  assertTicketImmutableProjection(
    value.priorProjection,
    `held-source prior projection: ${ticketId}`,
  );
  assertTicketImmutableProjection(
    value.refreshedProjection,
    `held-source refreshed projection: ${ticketId}`,
  );
  const { sha256, ...material } = value;
  if (
    value.priorProjection.id !== ticketId ||
    value.refreshedProjection.id !== ticketId ||
    value.priorProjectionSha256 !== value.priorProjection.sha256 ||
    value.nextProjectionSha256 !== value.refreshedProjection.sha256 ||
    value.nextGraphRevision !== value.priorGraphRevision + 1 ||
    canonicalHash(material) !== sha256
  ) {
    throw new Error(`invalid held-source grant refresh authority: ${ticketId}`);
  }
}

function assertSourceCorrectionSeedAuthority(
  ticketId: string,
  value: unknown,
): asserts value is SourceCorrectionSeedAuthority {
  if (!isRecord(value)) throw new Error(`invalid source-correction seed: ${ticketId}`);
  const allowed = new Set([
    "protocol",
    "runId",
    "ticketId",
    "proposalTicketId",
    "requestSha256",
    "route",
    "releaseDecisionSha256",
    "archivedCycleId",
    "archiveRef",
    "candidateBaseOid",
    "candidateOid",
    "candidateProjection",
    "releaseProjection",
    "priorExecutionEpoch",
    "nextExecutionEpoch",
    "recordedAt",
    "sha256",
  ]);
  if (
    Object.keys(value).some((field) => !allowed.has(field)) ||
    value.protocol !== "koni.source-correction-seed.v1" ||
    !isId(value.runId) ||
    value.ticketId !== ticketId ||
    !isId(value.proposalTicketId) ||
    !isSha256Digest(value.requestSha256) ||
    (value.route !== "planned_asset_repair" &&
      value.route !== "proposal_review_exhausted" &&
      value.route !== "no_op" &&
      value.route !== "approved_application") ||
    !isSha256Digest(value.releaseDecisionSha256) ||
    !isId(value.archivedCycleId) ||
    typeof value.archiveRef !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test(String(value.candidateBaseOid)) ||
    !/^[0-9a-f]{40,64}$/u.test(String(value.candidateOid)) ||
    !isRecord(value.candidateProjection) ||
    !isRecord(value.releaseProjection) ||
    !isNonnegativeSafeInteger(value.priorExecutionEpoch) ||
    !isNonnegativeSafeInteger(value.nextExecutionEpoch) ||
    value.nextExecutionEpoch !== value.priorExecutionEpoch + 1 ||
    typeof value.recordedAt !== "string" ||
    value.recordedAt.length === 0 ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid source-correction seed: ${ticketId}`);
  }
  assertTicketImmutableProjection(value.candidateProjection, `correction candidate: ${ticketId}`);
  assertTicketImmutableProjection(value.releaseProjection, `correction release: ${ticketId}`);
  const { sha256, ...material } = value;
  if (
    value.candidateProjection.id !== ticketId ||
    value.releaseProjection.id !== ticketId ||
    canonicalHash(material) !== sha256
  ) {
    throw new Error(`invalid source-correction seed authority: ${ticketId}`);
  }
}

function assertProposalReviewExhaustionAuthority(
  ticketId: string,
  value: unknown,
): asserts value is ProposalReviewExhaustionAuthority {
  if (!isRecord(value)) throw new Error(`invalid proposal review exhaustion: ${ticketId}`);
  const allowed = new Set(["protocol", "failedReviewAttemptId", "sha256"]);
  if (
    Object.keys(value).some((field) => !allowed.has(field)) ||
    value.protocol !== "koni.proposal-review-exhaustion.v1" ||
    !isId(value.failedReviewAttemptId) ||
    !isSha256Digest(value.sha256)
  ) {
    throw new Error(`invalid proposal review exhaustion: ${ticketId}`);
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
    "heldSourceGrantRefreshes",
    "sourceCorrectionSeeds",
    "proposalReviewExhaustion",
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
  if (value.heldSourceGrantRefreshes !== undefined) {
    if (
      !Array.isArray(value.heldSourceGrantRefreshes) ||
      value.heldSourceGrantRefreshes.length > 64
    ) {
      throw new Error(`invalid held-source grant refresh history: ${ticketId}`);
    }
    for (const refresh of value.heldSourceGrantRefreshes) {
      assertHeldSourceGrantRefreshAuthority(ticketId, refresh);
    }
  }
  if (value.sourceCorrectionSeeds !== undefined) {
    if (!Array.isArray(value.sourceCorrectionSeeds) || value.sourceCorrectionSeeds.length > 1_024) {
      throw new Error(`invalid source-correction seed history: ${ticketId}`);
    }
    for (const seed of value.sourceCorrectionSeeds) {
      assertSourceCorrectionSeedAuthority(ticketId, seed);
    }
  }
  if (value.proposalReviewExhaustion !== undefined) {
    assertProposalReviewExhaustionAuthority(ticketId, value.proposalReviewExhaustion);
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
    assertSourceCorrectionSeedHistory(run, ticket);
    const activeCycle =
      ticket.gitCycleId === undefined ? undefined : run.git.ticketCycles[ticket.gitCycleId];
    const correctionSeed = currentSourceCorrectionSeed(run, ticket);
    if (
      activeCycle !== undefined &&
      (activeCycle.continuationAuthoritySha256 !== undefined || correctionSeed !== undefined) &&
      activeCycle.continuationAuthoritySha256 !== correctionSeed?.sha256
    ) {
      throw new Error(`ticket Git cycle differs from source-correction authority: ${ticket.id}`);
    }
    assertCompilerControlTicketForRun(run, ticket);
    const control = ticket.executionControl;
    if (control === undefined) continue;
    const request = control.proposalRequest;
    const proposalReviewExhaustion = control.proposalReviewExhaustion;
    if (
      proposalReviewExhaustion !== undefined &&
      (request === undefined ||
        !proposalReviewExhaustionMatchesRun(run, ticket, proposalReviewExhaustion))
    ) {
      throw new Error(`proposal review exhaustion differs from exact failed review: ${ticket.id}`);
    }
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
        ? ticketProjectionsDifferOnlyByDependencies(
            sourceProjection,
            causal.sourceTicketProjection,
          ) ||
          heldSourceGrantRefreshChainAuthorizes(
            source,
            sourceProjection,
            causal.sourceTicketProjection,
            ticket.id,
          )
        : proposalHasReleasedSourceAuthority(run, ticket) &&
          (recurringAssetGrantRefreshChainAuthorizes(
            source,
            sourceProjection,
            causal.sourceTicketProjection,
          ) ||
            heldSourceGrantRefreshChainAuthorizes(
              source,
              sourceProjection,
              causal.sourceTicketProjection,
              ticket.id,
            )));
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

function durableTicketExecutionEpoch(
  run: Readonly<Pick<RunRecord, "git">>,
  ticket: Readonly<TicketRecord>,
): number {
  if (ticket.executionEpoch !== undefined) return ticket.executionEpoch;
  const cycle =
    ticket.gitCycleId === undefined ? undefined : run.git.ticketCycles[ticket.gitCycleId];
  return Math.max(0, (cycle?.ordinal ?? 1) - 1);
}

function sourceCorrectionSeedMatchesRun(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
  seed: Readonly<SourceCorrectionSeedAuthority>,
): boolean {
  const proposal = run.tickets[seed.proposalTicketId];
  const request = proposal?.executionControl?.proposalRequest;
  const authority = proposal?.executionControl?.controlTicketAuthority;
  const causal = authority?.causal;
  const cycle = run.git.ticketCycles[seed.archivedCycleId];
  if (
    proposal === undefined ||
    request?.sourceTicketId !== ticket.id ||
    request.requestSha256 !== seed.requestSha256 ||
    authority?.role !== "proposal" ||
    causal?.role !== "proposal" ||
    canonicalHash(causal.sourceTicketProjection) !== canonicalHash(seed.candidateProjection) ||
    cycle?.ticketId !== ticket.id ||
    cycle.status !== "retired" ||
    cycle.archiveRef !== seed.archiveRef ||
    cycle.supersessionSha256 !== seed.requestSha256 ||
    cycle.baseRunOid !== seed.candidateBaseOid ||
    cycle.ticketHeadOid !== seed.candidateOid
  ) {
    return false;
  }
  return true;
}

/** Select only the exact archived correction authority for this ticket's current epoch. */
export function currentSourceCorrectionSeed(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
): SourceCorrectionSeedAuthority | undefined {
  const seed = ticket.executionControl?.sourceCorrectionSeeds?.at(-1);
  if (
    seed === undefined ||
    seed.nextExecutionEpoch !== durableTicketExecutionEpoch(run, ticket) ||
    !sourceCorrectionSeedMatchesRun(run, ticket, seed) ||
    !ticketProjectionsDifferOnlyByDependencies(
      ticketImmutableProjection(ticket),
      seed.releaseProjection,
    )
  ) {
    return undefined;
  }
  return seed;
}

function assertSourceCorrectionSeedHistory(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
): void {
  const history = ticket.executionControl?.sourceCorrectionSeeds;
  if (history === undefined || history.length === 0) return;
  for (const [index, seed] of history.entries()) {
    if (
      seed.runId !== run.id ||
      seed.ticketId !== ticket.id ||
      !sourceCorrectionSeedMatchesRun(run, ticket, seed) ||
      (index > 0 && seed.priorExecutionEpoch < history[index - 1]!.nextExecutionEpoch)
    ) {
      throw new Error(`source-correction seed history is invalid: ${ticket.id}`);
    }
  }
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

function heldSourceGrantRefreshChainAuthorizes(
  source: Readonly<TicketRecord>,
  current: Readonly<TicketImmutableProjection>,
  historical: Readonly<TicketImmutableProjection>,
  proposalTicketId: string,
): boolean {
  const history = (source.executionControl?.heldSourceGrantRefreshes ?? []).filter(
    (refresh) => refresh.proposalTicketId === proposalTicketId,
  );
  let accepted = historical;
  for (const refresh of history) {
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
    (definition.review_failure_reopen_from === undefined
      ? null
      : (definition.review_rework_limit ?? 1)) !== projection.reviewReworkLimit ||
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

function heldSourceProjectionDefinitionMaterial(
  projection: Readonly<TicketImmutableProjection>,
): unknown {
  return {
    ...projection,
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

function assertHeldSourceGrantRefreshMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
): void {
  for (const [ticketId, currentTicket] of Object.entries(next.tickets)) {
    const priorTicket = previous.tickets[ticketId];
    const priorHistory = priorTicket?.executionControl?.heldSourceGrantRefreshes ?? [];
    const currentHistory = currentTicket.executionControl?.heldSourceGrantRefreshes ?? [];
    if (
      currentHistory.length < priorHistory.length ||
      canonicalHash(currentHistory.slice(0, priorHistory.length)) !== canonicalHash(priorHistory)
    ) {
      throw new Error(`ticket rewrote held-source grant refresh authority: ${ticketId}`);
    }
    const added = currentHistory.slice(priorHistory.length);
    if (added.length === 0) {
      if (
        priorTicket !== undefined &&
        priorHistory.length > 0 &&
        !ticketProjectionsDifferOnlyByDependencies(
          ticketImmutableProjection(priorTicket),
          ticketImmutableProjection(currentTicket),
        ) &&
        priorTicket.executionControl?.sourceHold !== undefined
      ) {
        throw new Error(`ticket changed a held-source grant without fresh authority: ${ticketId}`);
      }
      continue;
    }
    if (added.length !== 1 || priorTicket === undefined) {
      throw new Error(`ticket added ambiguous held-source grant refresh authority: ${ticketId}`);
    }
    const refresh = added[0]!;
    const priorProjection = ticketImmutableProjection(priorTicket);
    const currentProjection = ticketImmutableProjection(currentTicket);
    const priorHold = priorTicket.executionControl?.sourceHold;
    const currentHold = currentTicket.executionControl?.sourceHold;
    const priorAction = previous.actionExecutions?.[refresh.actionInvocationId];
    const currentAction = next.actionExecutions?.[refresh.actionInvocationId];
    const application = next.tickets[refresh.applicationTicketId];
    const applicationAuthority = application?.executionControl?.controlTicketAuthority;
    const applicationCausal =
      applicationAuthority?.causal.role === "approved_application"
        ? applicationAuthority.causal
        : undefined;
    const semanticCompilerStep =
      currentAction === undefined ? undefined : assignmentSemanticCompilerStep(currentAction);
    const refreshEffect =
      currentAction === undefined || semanticCompilerStep === undefined
        ? undefined
        : currentAction.effects[
            `${currentAction.invocationId}:recipe:${semanticCompilerStep.id}:${currentAction.plan.sha256}`
          ];
    const sourceCycle =
      priorTicket.gitCycleId === undefined
        ? undefined
        : previous.git.ticketCycles[priorTicket.gitCycleId];
    if (
      priorHold === undefined ||
      currentHold === undefined ||
      canonicalHash(currentHold) !== canonicalHash(priorHold) ||
      priorTicket.status !== "blocked" ||
      currentTicket.status !== "blocked" ||
      priorTicket.operationId !== currentTicket.operationId ||
      currentTicket.executionEpoch !== priorTicket.executionEpoch ||
      currentTicket.gitCycleId !== priorTicket.gitCycleId ||
      currentTicket.worktreePath !== priorTicket.worktreePath ||
      currentTicket.branch !== priorTicket.branch ||
      sourceCycle?.status !== "active" ||
      refresh.runId !== next.id ||
      refresh.ticketId !== ticketId ||
      refresh.proposalTicketId !== priorHold.proposalTicketId ||
      refresh.applicationTicketId !== application?.id ||
      refresh.configurationSha256 !== next.compiledConfigHash ||
      refresh.actionInvocationId !== currentAction?.invocationId ||
      refresh.actionBoundarySha256 !== currentAction?.boundary.sha256 ||
      refresh.priorGraphHash !== previous.graphHash ||
      refresh.priorGraphRevision !== previous.graphRevision ||
      refresh.nextGraphHash !== next.graphHash ||
      refresh.nextGraphRevision !== next.graphRevision ||
      refresh.priorProjectionSha256 !== priorProjection.sha256 ||
      canonicalHash(refresh.priorProjection) !== canonicalHash(priorProjection) ||
      refresh.nextProjectionSha256 !== currentProjection.sha256 ||
      canonicalHash(refresh.refreshedProjection) !== canonicalHash(currentProjection) ||
      refresh.executionEpoch !== (priorTicket.executionEpoch ?? 0) ||
      refresh.sourceCycleId !== priorTicket.gitCycleId ||
      refresh.recordedAt !== next.updatedAt ||
      canonicalHash(heldSourceProjectionDefinitionMaterial(priorProjection)) !==
        canonicalHash(heldSourceProjectionDefinitionMaterial(currentProjection)) ||
      previous.graphHash === next.graphHash ||
      priorAction === undefined ||
      currentAction === undefined ||
      priorAction.boundary.kind !== "assignment_validation" ||
      priorAction.boundary.sha256 !== refresh.actionBoundarySha256 ||
      priorAction.semanticResult !== undefined ||
      currentAction.boundary.ticketId !== application.id ||
      applicationAuthority?.role !== "approved_application" ||
      applicationCausal === undefined ||
      application.executionControl?.sourceProposalTicketId !== priorHold.proposalTicketId ||
      applicationCausal.materialization.proposalTicketId !== priorHold.proposalTicketId ||
      !applicationCausal.materialization.targetNodeIds.some((nodeId) =>
        priorProjection.targetNodeIds.includes(nodeId),
      ) ||
      currentAction.semanticResult?.kind !== "assignment" ||
      currentAction.semanticResult.status !== "completed" ||
      !currentAction.semanticResult.heldSourceGrantRefreshSha256s?.includes(refresh.sha256) ||
      semanticCompilerStep === undefined ||
      refreshEffect === undefined ||
      priorAction.effects[refreshEffect.effectKey] !== undefined ||
      !isRecord(refreshEffect.output) ||
      !Array.isArray(refreshEffect.output.heldSourceGrantRefreshSha256s) ||
      !refreshEffect.output.heldSourceGrantRefreshSha256s.includes(refresh.sha256)
    ) {
      throw new Error(`ticket added unauthenticated held-source grant refresh: ${ticketId}`);
    }
  }
}

function assertSourceCorrectionSeedMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
): void {
  for (const [ticketId, currentTicket] of Object.entries(next.tickets)) {
    const priorTicket = previous.tickets[ticketId];
    const priorHistory = priorTicket?.executionControl?.sourceCorrectionSeeds ?? [];
    const currentHistory = currentTicket.executionControl?.sourceCorrectionSeeds ?? [];
    if (
      currentHistory.length < priorHistory.length ||
      canonicalHash(currentHistory.slice(0, priorHistory.length)) !== canonicalHash(priorHistory)
    ) {
      throw new Error(`ticket rewrote source-correction seed authority: ${ticketId}`);
    }
    const added = currentHistory.slice(priorHistory.length);
    if (added.length === 0) continue;
    if (added.length !== 1 || priorTicket === undefined) {
      throw new Error(`ticket added ambiguous source-correction seed authority: ${ticketId}`);
    }
    const seed = added[0]!;
    const priorHold = priorTicket.executionControl?.sourceHold;
    const proposal =
      priorHold === undefined ? undefined : previous.tickets[priorHold.proposalTicketId];
    const request = proposal?.executionControl?.proposalRequest;
    const proposalAuthority = proposal?.executionControl?.controlTicketAuthority;
    const proposalCausal =
      proposalAuthority?.causal.role === "proposal" ? proposalAuthority.causal : undefined;
    const cycle =
      priorTicket.gitCycleId === undefined
        ? undefined
        : previous.git.ticketCycles[priorTicket.gitCycleId];
    const route =
      proposal === undefined
        ? undefined
        : sourceCorrectionSeedRoute(previous, priorTicket, proposal);
    const release =
      proposal === undefined
        ? undefined
        : sourceReleaseDecisionForRun(previous, priorTicket, proposal);
    const priorEpoch = durableTicketExecutionEpoch(previous, priorTicket);
    if (
      priorHold === undefined ||
      currentTicket.executionControl?.sourceHold !== undefined ||
      proposal === undefined ||
      request === undefined ||
      route === undefined ||
      release?.disposition !== "release" ||
      proposalAuthority?.role !== "proposal" ||
      proposalCausal === undefined ||
      cycle?.ticketId !== ticketId ||
      cycle.status !== "retired" ||
      cycle.archiveRef === undefined ||
      cycle.supersessionSha256 !== request.requestSha256 ||
      cycle.ticketHeadOid === cycle.baseRunOid ||
      currentTicket.status !== "queued" ||
      currentTicket.executionEpoch !== priorEpoch + 1 ||
      currentTicket.gitCycleId !== undefined ||
      currentTicket.worktreePath !== undefined ||
      currentTicket.branch !== undefined ||
      currentTicket.steps.some((step) => step.status !== "pending") ||
      seed.runId !== next.id ||
      seed.ticketId !== ticketId ||
      seed.proposalTicketId !== proposal.id ||
      seed.requestSha256 !== request.requestSha256 ||
      seed.route !== route ||
      seed.releaseDecisionSha256 !== release.sha256 ||
      seed.archivedCycleId !== cycle.cycleId ||
      seed.archiveRef !== cycle.archiveRef ||
      seed.candidateBaseOid !== cycle.baseRunOid ||
      seed.candidateOid !== cycle.ticketHeadOid ||
      canonicalHash(seed.candidateProjection) !==
        canonicalHash(proposalCausal.sourceTicketProjection) ||
      canonicalHash(seed.releaseProjection) !==
        canonicalHash(ticketImmutableProjection(priorTicket)) ||
      seed.priorExecutionEpoch !== priorEpoch ||
      seed.nextExecutionEpoch !== currentTicket.executionEpoch ||
      seed.recordedAt !== next.updatedAt ||
      !ticketProjectionsDifferOnlyByDependencies(
        ticketImmutableProjection(currentTicket),
        seed.releaseProjection,
      )
    ) {
      throw new Error(`ticket added unauthenticated source-correction seed: ${ticketId}`);
    }
  }
}

function assertReviewReworkMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
  receipt?: Readonly<{
    method: string;
    idempotencyKey: string;
    requestHash: Sha256Digest;
  }>,
): void {
  for (const [ticketId, prior] of Object.entries(previous.tickets)) {
    const current = next.tickets[ticketId];
    if (current === undefined) continue;
    const priorLimit = prior.reviewReworkLimit;
    const currentLimit = current.reviewReworkLimit;
    const priorCount = prior.reviewReworkCount;
    const currentCount = current.reviewReworkCount;
    const priorHistory = prior.reviewReworks ?? [];
    const currentHistory = current.reviewReworks ?? [];
    const priorConfigured =
      prior.reviewFailureReopenFrom !== undefined ||
      priorLimit !== undefined ||
      priorCount !== undefined ||
      prior.reviewReworks !== undefined;
    const currentConfigured =
      current.reviewFailureReopenFrom !== undefined ||
      currentLimit !== undefined ||
      currentCount !== undefined ||
      current.reviewReworks !== undefined;
    if (!priorConfigured && !currentConfigured) continue;
    const priorStandaloneReviewOnly =
      prior.reviewFailureReopenFrom === undefined &&
      priorLimit === undefined &&
      priorCount === undefined &&
      prior.reviewReworks !== undefined;
    if (priorStandaloneReviewOnly) {
      if (
        current.reviewFailureReopenFrom !== undefined ||
        currentLimit !== undefined ||
        currentCount !== undefined ||
        current.reviewReworks === undefined ||
        currentHistory.length < priorHistory.length ||
        currentHistory.length > priorHistory.length + 1 ||
        canonicalHash(currentHistory.slice(0, priorHistory.length)) !== canonicalHash(priorHistory)
      ) {
        throw new Error(`ticket rewrote standalone review-only authority: ${ticketId}`);
      }
      const added = currentHistory.at(priorHistory.length);
      if (added === undefined) continue;
      const review = current.steps.find(
        (step) => step.kind === "review" && step.attemptIds.includes(added.failedReviewAttemptId),
      );
      const authorization = added.operatorAuthorization;
      const exactRequestHash = canonicalHash({
        method: "run.action.execute",
        params: {
          protocol: "koni.stage-action-invocation.v1",
          runId: previous.id,
          runRevision: previous.revision,
          generation: previous.generation,
          capabilityId: `ticket:${ticketId}:retry-review-only:${added.failedReviewAttemptId}`,
          confirmed: true,
          values: {
            ticketId,
            reviewStepId: review?.id,
            retryScope: "review_only",
            failedReviewAttemptId: added.failedReviewAttemptId,
            ...(added.operatorSteering === undefined ? {} : { steering: added.operatorSteering }),
          },
        },
      });
      if (
        added.mode !== "supervised" ||
        added.scope !== "review_only" ||
        added.reopenFromStepId !== review?.id ||
        added.openedAt !== next.updatedAt ||
        prior.status !== "blocked" ||
        current.status !== "queued" ||
        authorization === undefined ||
        receipt === undefined ||
        authorization.method !== receipt.method ||
        authorization.idempotencyKey !== receipt.idempotencyKey ||
        authorization.requestHash !== receipt.requestHash ||
        authorization.requestHash !== exactRequestHash
      ) {
        throw new Error(`ticket added unauthenticated standalone review-only history: ${ticketId}`);
      }
      continue;
    }
    if (!priorConfigured) {
      const standalone = currentHistory[0];
      const standaloneReview = current.steps.find(
        (step) =>
          step.kind === "review" &&
          standalone !== undefined &&
          step.attemptIds.includes(standalone.failedReviewAttemptId),
      );
      const standaloneAuthorization = standalone?.operatorAuthorization;
      const standaloneRequestHash =
        standalone === undefined || standaloneReview === undefined
          ? undefined
          : canonicalHash({
              method: "run.action.execute",
              params: {
                protocol: "koni.stage-action-invocation.v1",
                runId: previous.id,
                runRevision: previous.revision,
                generation: previous.generation,
                capabilityId: `ticket:${ticketId}:retry-review-only:${standalone.failedReviewAttemptId}`,
                confirmed: true,
                values: {
                  ticketId,
                  reviewStepId: standaloneReview.id,
                  retryScope: "review_only",
                  failedReviewAttemptId: standalone.failedReviewAttemptId,
                  ...(standalone.operatorSteering === undefined
                    ? {}
                    : { steering: standalone.operatorSteering }),
                },
              },
            });
      const exactStandaloneReviewOnly =
        currentCount === undefined &&
        current.reviewFailureReopenFrom === undefined &&
        currentLimit === undefined &&
        currentHistory.length === 1 &&
        standalone?.mode === "supervised" &&
        standalone.scope === "review_only" &&
        standalone.reopenFromStepId === standaloneReview?.id &&
        standalone.openedAt === next.updatedAt &&
        prior.status === "blocked" &&
        current.status === "queued" &&
        standaloneAuthorization !== undefined &&
        receipt !== undefined &&
        standaloneAuthorization.method === receipt.method &&
        standaloneAuthorization.idempotencyKey === receipt.idempotencyKey &&
        standaloneAuthorization.requestHash === receipt.requestHash &&
        standaloneAuthorization.requestHash === standaloneRequestHash;
      if (exactStandaloneReviewOnly) continue;
      if (
        currentCount !== 0 ||
        currentHistory.length !== 0 ||
        prior.steps.some((step) => step.attemptIds.length > 0)
      ) {
        throw new Error(`ticket added review-rework authority after execution: ${ticketId}`);
      }
      continue;
    }
    if (
      !currentConfigured ||
      current.reviewFailureReopenFrom !== prior.reviewFailureReopenFrom ||
      currentLimit !== priorLimit
    ) {
      throw new Error(`ticket rewrote review-rework authority: ${ticketId}`);
    }
    if (
      currentHistory.length < priorHistory.length ||
      canonicalHash(currentHistory.slice(0, priorHistory.length)) !== canonicalHash(priorHistory) ||
      currentHistory.length > priorHistory.length + 1 ||
      currentCount === undefined ||
      priorCount === undefined
    ) {
      throw new Error(`ticket rewrote review-rework history: ${ticketId}`);
    }
    const added = currentHistory.at(priorHistory.length);
    if (added === undefined) {
      if (currentCount !== priorCount) {
        throw new Error(`ticket rewrote review-rework count: ${ticketId}`);
      }
      continue;
    }
    const review = current.steps.find(
      (step) => step.kind === "review" && step.attemptIds.includes(added.failedReviewAttemptId),
    );
    const attempt = next.attempts[added.failedReviewAttemptId];
    const automatic = added.mode !== "supervised";
    const failureAlreadyConsumed = priorHistory.some(
      (record) => record.failedReviewAttemptId === added.failedReviewAttemptId,
    );
    const failureProof =
      added.failureProofSha256 === undefined
        ? undefined
        : next.terminalFailureProofs?.[added.failureProofSha256];
    const authorization = added.operatorAuthorization;
    const sameReceipt =
      authorization !== undefined &&
      receipt !== undefined &&
      authorization.method === receipt.method &&
      authorization.idempotencyKey === receipt.idempotencyKey &&
      authorization.requestHash === receipt.requestHash;
    const exactFailure =
      failureProof !== undefined &&
      failureProof.ticketId === ticketId &&
      failureProof.stepId === review?.id &&
      failureProof.attemptId === added.failedReviewAttemptId &&
      failureProof.semanticResult.status === "failed" &&
      failureProof.semanticResult.blocker === added.blocker;
    const exactDirectFailure =
      added.failureTerminalOutputSha256 !== undefined &&
      attempt?.terminalOutputSha256 === added.failureTerminalOutputSha256 &&
      attempt.terminalPolicy?.mode === "failed_submission" &&
      attempt.terminalSummary === added.blocker &&
      new Set<AttemptStatus>(["terminal_accepted", "completed"]).has(attempt.status);
    const exactSupervisedRequestHash = canonicalHash({
      method: "run.action.execute",
      params: {
        protocol: "koni.stage-action-invocation.v1",
        runId: previous.id,
        runRevision: previous.revision,
        generation: previous.generation,
        capabilityId: `ticket:${ticketId}:retry-review${added.scope === "review_only" ? "-only" : ""}:${added.failedReviewAttemptId}`,
        confirmed: true,
        values: {
          ticketId,
          reviewStepId: review?.id,
          retryScope: added.scope ?? "producer_and_review",
          failedReviewAttemptId: added.failedReviewAttemptId,
          ...(added.operatorSteering === undefined ? {} : { steering: added.operatorSteering }),
        },
      },
    });
    const exactLegacyResumeHashes = new Set([
      canonicalHash({ method: "run.resume", params: { runId: previous.id } }),
      canonicalHash({
        method: "run.action.execute",
        params: {
          protocol: "koni.stage-action-invocation.v1",
          runId: previous.id,
          runRevision: previous.revision,
          generation: previous.generation,
          capabilityId: `stage:${previous.currentPipelineStageId}:retry`,
          confirmed: true,
          values: {},
        },
      }),
    ]);
    const legacyOperatorRecovery =
      automatic &&
      sameReceipt &&
      new Set(["run.action.execute", "run.resume"]).has(authorization.method) &&
      exactLegacyResumeHashes.has(authorization.requestHash) &&
      previous.attempts[added.failedReviewAttemptId]?.status === "completed";
    if (
      review === undefined ||
      attempt === undefined ||
      attempt.ticketId !== ticketId ||
      attempt.stepId !== review.id ||
      added.openedAt !== next.updatedAt ||
      (automatic
        ? currentCount !== priorCount + 1 ||
          priorLimit === undefined ||
          priorCount >= priorLimit ||
          failureAlreadyConsumed ||
          (!exactFailure && !exactDirectFailure && !legacyOperatorRecovery)
        : currentCount !== priorCount ||
          prior.status !== "blocked" ||
          current.status !== "queued" ||
          !sameReceipt ||
          authorization.method !== "run.action.execute" ||
          authorization.requestHash !== exactSupervisedRequestHash)
    ) {
      throw new Error(`ticket added unauthenticated review-rework history: ${ticketId}`);
    }
  }
}

function assertCompilerReissueDiagnosisMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
  receipt?: Readonly<{
    method: string;
    idempotencyKey: string;
    requestHash: Sha256Digest;
  }>,
): void {
  const priorPending = previous.pendingCompilerCheckPreflights ?? {};
  const currentPending = next.pendingCompilerCheckPreflights ?? {};
  const addedPendingIds = Object.keys(currentPending).filter(
    (id) => priorPending[id] === undefined,
  );
  const removedPendingIds = Object.keys(priorPending).filter(
    (id) => currentPending[id] === undefined,
  );
  if (
    addedPendingIds.length > 1 ||
    removedPendingIds.length > 1 ||
    Object.entries(priorPending).some(
      ([id, intent]) =>
        currentPending[id] !== undefined &&
        canonicalHash(currentPending[id]) !== canonicalHash(intent),
    )
  ) {
    throw new Error("run rewrote pending compiler check preflight authority");
  }
  const addedPending =
    addedPendingIds.length === 0 ? undefined : currentPending[addedPendingIds[0]!]!;
  if (addedPending !== undefined) {
    const consumer = previous.tickets[addedPending.consumerTicketId];
    const step = consumer?.steps.find((candidate) => candidate.id === addedPending.consumerStepId);
    const exactProducerIds = compilerCheckProducerIds(previous, addedPending.consumerTicketId);
    if (
      addedPending.runRevision !== previous.revision ||
      addedPending.configurationSha256 !== previous.compiledConfigHash ||
      addedPending.preparedAt !== next.updatedAt ||
      previous.behavior === undefined ||
      consumer?.status !== "queued" ||
      step?.status !== "pending" ||
      step.validationAction === undefined ||
      consumer.dependencyIds.some(
        (dependencyId) => !ticketDependencySettled(previous.tickets[dependencyId]),
      ) ||
      (step.dependsOn ?? []).some(
        (stepId) =>
          !new Set(["completed", "skipped"]).has(
            consumer.steps.find((candidate) => candidate.id === stepId)?.status ?? "missing",
          ),
      ) ||
      canonicalHash([...addedPending.producerTicketIds].sort()) !==
        canonicalHash(exactProducerIds) ||
      addedPending.producerTicketIds.some(
        (producerId, index) =>
          addedPending.producerProjectionSha256s[index] !==
          ticketImmutableProjection(previous.tickets[producerId]!).sha256,
      )
    ) {
      throw new Error("run added unauthenticated pending compiler check preflight");
    }
  }
  const priorPreflight = previous.compilerCheckPreflightRejections ?? [];
  const currentPreflight = next.compilerCheckPreflightRejections ?? [];
  if (
    currentPreflight.length < priorPreflight.length ||
    currentPreflight.length > priorPreflight.length + 1 ||
    canonicalHash(currentPreflight.slice(0, priorPreflight.length)) !==
      canonicalHash(priorPreflight)
  ) {
    throw new Error("run rewrote compiler check preflight rejection authority");
  }
  const addedPreflight = currentPreflight.at(priorPreflight.length);
  if (addedPreflight !== undefined) {
    const removedIntent =
      removedPendingIds.length === 0 ? undefined : priorPending[removedPendingIds[0]!]!;
    const consumer = previous.tickets[addedPreflight.consumerTicketId];
    const exactProducerIds = compilerCheckProducerIds(previous, addedPreflight.consumerTicketId);
    if (
      addedPreflight.runRevision !== previous.revision ||
      addedPreflight.configurationSha256 !== previous.compiledConfigHash ||
      addedPreflight.recordedAt !== next.updatedAt ||
      removedIntent?.sha256 !== addedPreflight.intentSha256 ||
      removedIntent?.consumerTicketId !== addedPreflight.consumerTicketId ||
      removedIntent?.consumerStepId !== addedPreflight.consumerStepId ||
      canonicalHash(removedIntent?.producerTicketIds) !==
        canonicalHash(addedPreflight.producerTicketIds) ||
      canonicalHash(removedIntent?.producerProjectionSha256s) !==
        canonicalHash(addedPreflight.producerProjectionSha256s) ||
      consumer === undefined ||
      !consumer.steps.some((step) => step.id === addedPreflight.consumerStepId) ||
      consumer.status !== "queued" ||
      canonicalHash([...addedPreflight.producerTicketIds].sort()) !==
        canonicalHash(exactProducerIds) ||
      addedPreflight.producerTicketIds.some((producerId, index) => {
        const producer = previous.tickets[producerId];
        return (
          producer === undefined ||
          producer.status !== "completed" ||
          addedPreflight.producerProjectionSha256s[index] !==
            ticketImmutableProjection(producer).sha256
        );
      })
    ) {
      throw new Error("run added unauthenticated compiler check preflight rejection");
    }
  }
  if (removedPendingIds.length > 0 && addedPreflight === undefined) {
    const removed = priorPending[removedPendingIds[0]!]!;
    const launched = Object.values(next.attempts).some(
      (attempt) =>
        previous.attempts[attempt.id] === undefined &&
        attempt.ticketId === removed.consumerTicketId &&
        attempt.stepId === removed.consumerStepId &&
        attempt.startedAt === next.updatedAt &&
        attempt.status === "running",
    );
    if (!launched) throw new Error("run discarded pending compiler check preflight authority");
  }
  for (const [ticketId, current] of Object.entries(next.tickets)) {
    const prior = previous.tickets[ticketId];
    if (prior === undefined) continue;
    const priorHistory = prior.compilerReissueDiagnoses ?? [];
    const currentHistory = current.compilerReissueDiagnoses ?? [];
    if (
      currentHistory.length < priorHistory.length ||
      currentHistory.length > priorHistory.length + 1 ||
      canonicalHash(currentHistory.slice(0, priorHistory.length)) !== canonicalHash(priorHistory)
    ) {
      throw new Error(`ticket rewrote compiler-reissue diagnosis: ${ticketId}`);
    }
    const added = currentHistory.at(priorHistory.length);
    if (added === undefined) continue;
    if (
      Object.values(previous.tickets).some((ticket) =>
        ticket.compilerReissueDiagnoses?.some(
          (diagnosis) => diagnosis.sourceSha256 === added.sourceSha256,
        ),
      )
    ) {
      throw new Error(`ticket reused compiler-reissue diagnosis authority: ${ticketId}`);
    }
    const resultCheck =
      added.kind === "configured_check_result"
        ? next.checks?.find((check) => canonicalHash(check) === added.sourceSha256)
        : undefined;
    const resultAttempt =
      resultCheck === undefined ? undefined : next.attempts[resultCheck.attemptId];
    const previousResultAttempt =
      resultCheck === undefined ? undefined : previous.attempts[resultCheck.attemptId];
    const resultIntent =
      resultCheck === undefined
        ? undefined
        : Object.values(previous.pendingChecks ?? {}).find(
            (intent) =>
              intent.attemptId === resultCheck.attemptId && intent.callId === resultCheck.callId,
          );
    const resolvedResultCheck =
      resultIntent !== undefined && isRecord(resultIntent.resolvedCheck)
        ? resultIntent.resolvedCheck
        : undefined;
    const priorToolResults = previousResultAttempt?.authorityToolResults ?? [];
    const currentToolResults = resultAttempt?.authorityToolResults ?? [];
    const addedToolResult = currentToolResults.at(priorToolResults.length);
    const exactResultProducerIds = compilerCheckProducerIds(previous, added.sourceTicketId);
    const resultDiagnosedTicketIds = Object.entries(next.tickets)
      .filter(([, ticket]) =>
        ticket.compilerReissueDiagnoses?.some(
          (diagnosis) => diagnosis.sourceSha256 === added.sourceSha256,
        ),
      )
      .map(([id]) => id)
      .sort();
    const exactResultSource =
      resultCheck !== undefined &&
      !(previous.checks ?? []).some((check) => canonicalHash(check) === added.sourceSha256) &&
      resultAttempt?.ticketId === added.sourceTicketId &&
      resultCheck.accepted === false &&
      resultCheck.infrastructureFailure === undefined &&
      resultIntent !== undefined &&
      resolvedResultCheck !== undefined &&
      canonicalHash(resolvedResultCheck) === resultIntent.resolvedCheckSha256 &&
      resultCheck.requestedCheckId === resultIntent.requestedCheckId &&
      resultCheck.definitionHash === resolvedResultCheck.definitionHash &&
      resultCheck.kind === resolvedResultCheck.kind &&
      next.pendingChecks?.[resultIntent.id] === undefined &&
      receipt?.method === resultIntent.method &&
      receipt.idempotencyKey === resultIntent.idempotencyKey &&
      receipt.requestHash === resultIntent.requestHash &&
      currentToolResults.length === priorToolResults.length + 1 &&
      canonicalHash(currentToolResults.slice(0, priorToolResults.length)) ===
        canonicalHash(priorToolResults) &&
      addedToolResult?.callId === resultCheck.callId &&
      addedToolResult.toolName === "koni_run_check" &&
      addedToolResult.outcome === "accepted" &&
      addedToolResult.argumentsSha256 === resultIntent.argumentsSha256 &&
      addedToolResult.recordedAt === resultCheck.recordedAt &&
      resultCheck.recordedAt === next.updatedAt &&
      canonicalHash(resultDiagnosedTicketIds) === canonicalHash(exactResultProducerIds);
    const exactPreflightSource =
      added.kind === "configured_check_preflight" &&
      addedPreflight?.sha256 === added.sourceSha256 &&
      addedPreflight.consumerTicketId === added.sourceTicketId &&
      addedPreflight.producerTicketIds.includes(ticketId);
    if (
      current.executionEpoch !== (prior.executionEpoch ?? 0) + 1 ||
      current.status !== "queued" ||
      current.blocker !== added.blocker ||
      added.executionEpoch !== current.executionEpoch ||
      added.openedAt !== next.updatedAt ||
      next.tickets[added.sourceTicketId] === undefined ||
      (!exactResultSource && !exactPreflightSource)
    ) {
      throw new Error(`ticket added unauthenticated compiler-reissue diagnosis: ${ticketId}`);
    }
  }
  if (addedPreflight !== undefined) {
    const diagnosedIds = Object.entries(next.tickets)
      .filter(([, ticket]) =>
        ticket.compilerReissueDiagnoses?.some(
          (diagnosis) => diagnosis.sourceSha256 === addedPreflight.sha256,
        ),
      )
      .map(([id]) => id)
      .sort();
    if (
      canonicalHash(diagnosedIds) !== canonicalHash([...addedPreflight.producerTicketIds].sort())
    ) {
      throw new Error("compiler check preflight diagnosis set is incomplete");
    }
  }
}

function compilerCheckProducerIds(run: Readonly<RunRecord>, consumerTicketId: string): string[] {
  const consumer = run.tickets[consumerTicketId];
  if (consumer === undefined) return [];
  const consumerNodeIds = new Set([
    ...consumer.targetNodeIds,
    ...(consumer.readNodeIds ?? []),
    ...(consumer.writeNodeIds ?? []),
  ]);
  const directOrPlanProducerIds =
    consumer.dependencyIds.length > 0
      ? consumer.dependencyIds
      : Object.values(run.tickets)
          .filter(
            (ticket) =>
              ticket.id !== consumer.id && ticket.operationId === "execution.node.compile-run-plan",
          )
          .map(({ id }) => id);
  const assetProducerIds = Object.values(run.tickets)
    .filter(
      (ticket) =>
        ticket.status === "completed" &&
        ticket.operationId === "asset-resolution.asset.implement-asset",
    )
    .filter((ticket) =>
      [
        ...(ticket.writeNodeIds ?? []),
        ...(ticket.writeNodeIds === undefined || ticket.writeNodeIds.length === 0
          ? ticket.targetNodeIds
          : []),
      ].some((nodeId) => consumerNodeIds.has(nodeId)),
    )
    .map(({ id }) => id);
  return [...new Set([...directOrPlanProducerIds, ...assetProducerIds])]
    .map((id) => run.tickets[id])
    .filter((ticket): ticket is TicketRecord => ticket?.status === "completed")
    .filter((ticket) =>
      [
        ...(ticket.writeNodeIds ?? []),
        ...(ticket.writeNodeIds === undefined || ticket.writeNodeIds.length === 0
          ? ticket.targetNodeIds
          : []),
      ].some((nodeId) => consumerNodeIds.has(nodeId)),
    )
    .map(({ id }) => id)
    .sort();
}

function assertProposalReviewExhaustionMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
): void {
  for (const [ticketId, currentTicket] of Object.entries(next.tickets)) {
    const priorTicket = previous.tickets[ticketId];
    const priorProof = priorTicket?.executionControl?.proposalReviewExhaustion;
    const currentProof = currentTicket.executionControl?.proposalReviewExhaustion;
    if (priorProof !== undefined) {
      if (currentProof === undefined || canonicalHash(currentProof) !== canonicalHash(priorProof)) {
        throw new Error(`ticket rewrote proposal review exhaustion authority: ${ticketId}`);
      }
      continue;
    }
    if (currentProof === undefined || priorTicket === undefined) continue;
    const expected = deriveProposalReviewExhaustionAuthority(next, priorTicket);
    const { proposalReviewExhaustion: _currentProof, ...currentControl } =
      currentTicket.executionControl ?? {};
    if (
      expected === undefined ||
      canonicalHash(expected) !== canonicalHash(currentProof) ||
      priorTicket.status !== "blocked" ||
      currentTicket.status !== "cancelled" ||
      currentTicket.blocker !== priorTicket.blocker ||
      currentTicket.updatedAt !== next.updatedAt ||
      ticketImmutableProjection(currentTicket).sha256 !==
        ticketImmutableProjection(priorTicket).sha256 ||
      canonicalHash(currentControl) !== canonicalHash(priorTicket.executionControl ?? {})
    ) {
      throw new Error(`ticket added unauthenticated proposal review exhaustion: ${ticketId}`);
    }
  }
}

/** Enforce append-only control evidence and immutable cross-ticket identities across one CAS. */
export function assertRunExecutionControlMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
  previousArchivedActions: ReadonlyMap<string, Readonly<RunActionExecutionRecord>> = new Map(),
  receipt?: Readonly<{
    method: string;
    idempotencyKey: string;
    requestHash: Sha256Digest;
  }>,
): void {
  assertPlanningSessionMutation(previous.planningSession, next.planningSession);
  assertLeadJudgmentMutation(previous, next);
  assertTokenBudgetRecoveryMutation(previous, next);
  assertHeldSourceGrantRefreshMutation(previous, next);
  assertRecurringAssetGrantRefreshMutation(previous, next);
  assertSourceCorrectionSeedMutation(previous, next);
  assertProposalReviewExhaustionMutation(previous, next);
  assertReviewReworkMutation(previous, next, receipt);
  assertCompilerReissueDiagnosisMutation(previous, next, receipt);
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

function assertLeadJudgmentMutation(
  previous: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
): void {
  const nextByAttempt = new Map(
    (next.leadJudgments ?? []).map((judgment) => [judgment.attemptId, judgment]),
  );
  for (const prior of previous.leadJudgments ?? []) {
    const retained = nextByAttempt.get(prior.attemptId);
    if (retained !== undefined) {
      if (canonicalHash(prior) !== canonicalHash(retained)) {
        throw new Error(`run changed immutable Lead judgment: ${prior.attemptId}`);
      }
      continue;
    }
    if (prior.trigger === "compiler_deadlock") {
      throw new Error(`run deleted immutable deadlock Lead judgment: ${prior.attemptId}`);
    }
  }
  const priorByAttempt = new Map(
    (previous.leadJudgments ?? []).map((judgment) => [judgment.attemptId, judgment]),
  );
  for (const judgment of next.leadJudgments ?? []) {
    const prior = priorByAttempt.get(judgment.attemptId);
    if (prior !== undefined) continue;
    const attempt = previous.attempts[judgment.attemptId];
    const invocationId = attempt?.launchActionInvocationId;
    const action =
      invocationId === undefined ? undefined : previous.actionExecutions?.[invocationId];
    const expectedStep =
      judgment.trigger === "orchestration_entry"
        ? "lead-orchestration-entry"
        : "lead-compiler-deadlock";
    const expectedFrontier =
      judgment.trigger === "compiler_deadlock" ? leadJudgmentFrontierSha256(previous) : undefined;
    if (
      attempt?.kind !== "lead" ||
      attempt.stepId !== expectedStep ||
      action?.boundary.kind !== "lead_launch" ||
      action.boundary.attemptId !== attempt.id ||
      action.boundary.stepId !== expectedStep ||
      action.boundary.productSha256 !== leadJudgmentProductSha256(previous, judgment.trigger) ||
      action.journal.status !== "completed" ||
      action.settlement?.disposition !== "completed" ||
      judgment.behaviorSha256 !== previous.behavior?.sha256 ||
      judgment.stageId !== previous.currentPipelineStageId ||
      judgment.graphHash !== previous.graphHash ||
      judgment.runOid !== previous.git.run.headOid ||
      judgment.frontierSha256 !== expectedFrontier
    ) {
      throw new Error(
        `run Lead judgment lacks exact launch-product authority: ${judgment.attemptId}`,
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
    (nextPriorCurrent.status !== "superseded" && nextPriorCurrent.status !== "failed") ||
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
  const policyAuthority = next.tickets[ticketId]?.executionControl?.controlTicketAuthority;
  for (const event of current.slice(prior.length)) {
    const exactOperator =
      event.protocol === "koni.proposal-decision-authority.v2" && event.actor === "operator";
    const exactProfilePolicy =
      event.protocol === "koni.proposal-decision-authority.v3" &&
      event.actor === "profile_policy" &&
      event.decision === "approval" &&
      event.policyAuthoritySha256 === policyAuthority?.sha256 &&
      policyAuthority?.role === "proposal" &&
      policyAuthority.operation.changeControl.role === "proposal" &&
      policyAuthority.operation.changeControl.decisionPolicy === "automatic";
    if (
      event.runId !== next.id ||
      event.proposalTicketId !== ticketId ||
      event.requestSha256 !== request?.requestSha256 ||
      (!exactOperator && !exactProfilePolicy)
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
  const exhaustedReview = proposal.executionControl?.proposalReviewExhaustion;
  if (
    proposal.status === "cancelled" &&
    request !== undefined &&
    (disposition === undefined ||
      (exhaustedReview !== undefined &&
        proposalReviewExhaustionMatchesRun(run, proposal, exhaustedReview)))
  ) {
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
