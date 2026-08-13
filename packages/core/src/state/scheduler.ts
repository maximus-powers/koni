import type {
  RunRecord,
  TicketRecord,
  TicketReviewReworkRecord,
  TicketStepRecord,
} from "./run-record.js";
import {
  deriveExecutionAdmissionConflicts,
  type ExecutionAdmissionConflict,
  type ExecutionAdmissionTicket,
  type ExecutionPolicyBinding,
} from "../authority/execution-policy.js";
import type {
  CompiledExecutionSemanticCatalog,
  CompiledOperationSemantics,
} from "../compiler/execution-semantics.js";
import { compareUtf8, isSha256Digest, type Sha256Digest } from "../shared/canonical.js";
import {
  createProjectPathAuthority,
  type ProjectPathAuthority,
} from "../shared/project-path-authority.js";
export {
  COMPILER_INAPPLICABLE_TICKET,
  COMPILER_ROUTED_TO_MANIFEST_GATE_RECHECK,
  COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR,
  COMPILER_SUPERSEDED_BEFORE_EXECUTION,
  ticketDependencySettled,
} from "./ticket-dependency.js";
import { ticketDependencySettled } from "./ticket-dependency.js";

export interface ReadyAssignment {
  runId: string;
  ticketId: string;
  stepId: string;
  personaId: string;
  priority: number;
}

export interface SchedulerProjection {
  ready: ReadyAssignment[];
  blocked: { ticketId: string; waitingOn: string[] }[];
  scopeConflicts: Array<{
    ticketId: string;
    stepId: string;
    conflictsWithTicketId: string;
    conflictsWithStepId: string;
    reason: "overlapping_scope" | "scope_authority_unavailable";
  }>;
  policyConflicts: Array<{
    ticketId: string;
    stepId: string;
    conflictsWithTicketId: string;
    reason: ExecutionAdmissionConflict["kind"];
    detail: string;
    overlapNodeIds?: readonly string[];
    overlapPaths?: readonly string[];
  }>;
  activeCount: number;
  availableSlots: number;
}

/**
 * Compiler-owned metadata that cannot be reconstructed from ticket presentation fields.
 * Callers must project it from the run's exact pinned configuration and durable control records.
 */
export interface SchedulerTicketExecutionAuthority {
  readonly binding: ExecutionPolicyBinding;
  /** Request target for proposals; exact approved write scope for applications. */
  readonly changeControlScopeNodeIds?: readonly string[];
  /** Exact steering/approval authority required before proposal work can start. */
  readonly proposalApprovalSha256?: Sha256Digest;
  /** Required for application/disposition children. */
  readonly sourceProposalTicketId?: string;
  /** Exact reviewed proposal/application authority required for an application child. */
  readonly approvedApplicationSha256?: Sha256Digest;
  /** Compiler-owned terminal resolver source and all exact failure bindings accumulated so far. */
  readonly terminalRecovery?: Readonly<{
    sourceTicketId: string;
    failureBindingSha256s: readonly Sha256Digest[];
  }>;
}

export interface SchedulerExecutionAuthority {
  readonly catalog: CompiledExecutionSemanticCatalog;
  readonly tickets: Readonly<Record<string, SchedulerTicketExecutionAuthority>>;
}

export class SchedulerAuthorityError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "SchedulerAuthorityError";
    this.code = code;
  }
}

export interface AssignmentFinishResult {
  disposition: "advanced" | "ticket_completed" | "review_rework" | "review_exhausted" | "blocked";
}

/**
 * Exact durable boundary exposed after a compiler-configured review has consumed its automatic
 * rework allowance. This is only a projection; reopening still requires
 * `authorizeBlockedReviewRetry` with the same attempt identity.
 */
export interface BlockedReviewRetryCandidate {
  ticketId: string;
  ticketTitle: string;
  reviewStepId: string;
  failedReviewAttemptId: string;
  reopenFromStepId: string;
  blocker: string;
}

export type BlockedReviewRetryScope = "producer_and_review" | "review_only";

export function deriveReadyAssignments(
  run: RunRecord,
  maxParallel: number,
  executionAuthority?: SchedulerExecutionAuthority,
): SchedulerProjection {
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
    throw new Error("max parallel assignments must be a positive safe integer");
  }
  const tickets = Object.values(run.tickets);
  const activeCount = tickets.reduce(
    (count, ticket) => count + ticket.steps.filter((step) => step.status === "running").length,
    0,
  );
  const availableSlots = Math.max(0, maxParallel - activeCount);
  const blocked: SchedulerProjection["blocked"] = [];
  const candidates: { ticket: TicketRecord; step: TicketStepRecord }[] = [];
  const scopeConflicts: SchedulerProjection["scopeConflicts"] = [];
  const policyConflicts: SchedulerProjection["policyConflicts"] = [];
  const pathAuthority = createProjectPathAuthority(run.projectRoot);

  const policy =
    executionAuthority === undefined ? undefined : prepareSchedulerPolicy(run, executionAuthority);

  if (
    !run.lifecycle.runningIntent ||
    !new Set(["planning", "executing", "verifying"]).has(run.lifecycle.phase)
  ) {
    return { ready: [], blocked, scopeConflicts, policyConflicts, activeCount, availableSlots };
  }

  for (const ticket of tickets) {
    if (!new Set(["queued", "running", "review"]).has(ticket.status)) {
      continue;
    }
    const waitingOn = ticket.dependencyIds.filter(
      (dependencyId) => !ticketDependencySettled(run.tickets[dependencyId]),
    );
    if (waitingOn.length > 0) {
      blocked.push({ ticketId: ticket.id, waitingOn: waitingOn.sort() });
      continue;
    }
    if (ticket.steps.some((step) => step.status === "running")) {
      continue;
    }
    const pending = ticket.steps.filter((candidate) => candidate.status === "pending");
    const step = pending.find((candidate) =>
      stepDependencies(ticket, candidate).every((dependencyId) =>
        dependencyComplete(ticket, dependencyId),
      ),
    );
    if (step !== undefined) {
      candidates.push({ ticket, step });
    } else if (pending.length > 0) {
      blocked.push({
        ticketId: ticket.id,
        waitingOn: [
          ...new Set(
            pending.flatMap((candidate) =>
              stepDependencies(ticket, candidate)
                .filter((dependencyId) => !dependencyComplete(ticket, dependencyId))
                .map((dependencyId) => `${ticket.id}/${dependencyId}`),
            ),
          ),
        ].sort(compareUtf8),
      });
    }
  }

  candidates.sort(
    (left, right) =>
      runtimeExecutionAdmissionRank(left.ticket) - runtimeExecutionAdmissionRank(right.ticket) ||
      left.ticket.priority - right.ticket.priority ||
      compareUtf8(left.ticket.id, right.ticket.id) ||
      compareUtf8(left.step.id, right.step.id),
  );
  const reserved: ReservedAssignmentScope[] = tickets.flatMap((ticket) =>
    ticket.steps
      .filter((step) => step.status === "running")
      .map((step) => ({
        ticketId: ticket.id,
        stepId: step.id,
        scope: assignmentScope(ticket, step),
      })),
  );
  const admitted: typeof candidates = [];
  for (const candidate of candidates) {
    if (admitted.length >= availableSlots) break;
    if (policy !== undefined) {
      const admission = policy.admissions.get(candidate.ticket.id)!;
      const conflicts = schedulerPolicyConflicts(
        executionAuthority!.catalog,
        run.projectRoot,
        admission,
        policy.controlTickets,
        policy.executionReservations,
      );
      if (conflicts.length > 0) {
        policyConflicts.push(
          ...conflicts.map((conflict) => ({
            ticketId: candidate.ticket.id,
            stepId: candidate.step.id,
            conflictsWithTicketId: conflict.activeTicketId,
            reason: conflict.kind,
            detail: conflict.detail,
            ...(conflict.overlapNodeIds === undefined
              ? {}
              : {
                  overlapNodeIds: conflict.overlapNodeIds,
                }),
            ...(conflict.overlapPaths === undefined
              ? {}
              : {
                  overlapPaths: conflict.overlapPaths,
                }),
          })),
        );
        continue;
      }
    }
    if (run.executionConfig?.disjointScopeParallelism === false) {
      admitted.push(candidate);
      if (policy !== undefined) {
        reservePolicyAdmission(
          policy.executionReservations,
          policy.admissions.get(candidate.ticket.id)!,
        );
      }
      continue;
    }
    const scope = assignmentScope(candidate.ticket, candidate.step);
    let conflicting: ReservedAssignmentScope | undefined;
    let reason: "overlapping_scope" | "scope_authority_unavailable" = "overlapping_scope";
    for (const reservation of reserved) {
      const comparison = assignmentScopesConflict(pathAuthority, scope, reservation.scope);
      if (!comparison.conflict) continue;
      conflicting = reservation;
      reason = comparison.unsafe ? "scope_authority_unavailable" : "overlapping_scope";
      break;
    }
    if (conflicting !== undefined) {
      scopeConflicts.push({
        ticketId: candidate.ticket.id,
        stepId: candidate.step.id,
        conflictsWithTicketId: conflicting.ticketId,
        conflictsWithStepId: conflicting.stepId,
        reason,
      });
      continue;
    }
    admitted.push(candidate);
    reserved.push({ ticketId: candidate.ticket.id, stepId: candidate.step.id, scope });
    if (policy !== undefined) {
      reservePolicyAdmission(
        policy.executionReservations,
        policy.admissions.get(candidate.ticket.id)!,
      );
    }
  }
  return {
    ready: admitted.map(({ ticket, step }) => ({
      runId: run.id,
      ticketId: ticket.id,
      stepId: step.id,
      personaId: step.personaId,
      priority: ticket.priority,
    })),
    blocked: blocked.sort((left, right) => compareUtf8(left.ticketId, right.ticketId)),
    scopeConflicts: scopeConflicts.sort(
      (left, right) =>
        compareUtf8(left.ticketId, right.ticketId) ||
        compareUtf8(left.stepId, right.stepId) ||
        compareUtf8(left.conflictsWithTicketId, right.conflictsWithTicketId) ||
        compareUtf8(left.conflictsWithStepId, right.conflictsWithStepId),
    ),
    policyConflicts: policyConflicts.sort(
      (left, right) =>
        compareUtf8(left.ticketId, right.ticketId) ||
        compareUtf8(left.stepId, right.stepId) ||
        compareUtf8(left.reason, right.reason) ||
        compareUtf8(left.conflictsWithTicketId, right.conflictsWithTicketId),
    ),
    activeCount,
    availableSlots,
  };
}

/**
 * A retained compiler ticket can be absent from the latest rule evaluation while its multi-step
 * workflow is still authoring the same run node. Durable priorities alone would admit the newer
 * run-experiment ticket first and compile its checks against a partial runtime contract. Keep
 * empirical execution behind all simultaneously admissible preparation/control work; downstream
 * synthesis does not become admissible until the runtime receipt exists, so it cannot be inverted
 * by this rank.
 */
function runtimeExecutionAdmissionRank(ticket: TicketRecord): number {
  return ticket.operationId === "execution.run.run-experiment" ? 1 : 0;
}

export function beginAssignment(
  run: RunRecord,
  assignment: ReadyAssignment,
  attemptId: string,
  at: string,
  executionAuthority?: SchedulerExecutionAuthority,
): void {
  const { ticket, step } = resolveAssignment(run, assignment);
  if (step.status !== "pending") {
    throw new Error(`step is not pending: ${ticket.id}/${step.id}`);
  }
  const maxParallel = run.executionConfig?.maxParallel ?? 1;
  const admitted = deriveReadyAssignments(run, maxParallel, executionAuthority).ready.some(
    (candidate) =>
      candidate.runId === assignment.runId &&
      candidate.ticketId === assignment.ticketId &&
      candidate.stepId === assignment.stepId &&
      candidate.personaId === assignment.personaId &&
      candidate.priority === assignment.priority,
  );
  if (!admitted)
    throw new Error(`assignment is not currently scheduler-admissible: ${ticket.id}/${step.id}`);
  step.status = "running";
  step.attemptIds.push(attemptId);
  step.startedAt = at;
  ticket.status = "running";
  ticket.updatedAt = at;
}

interface PreparedSchedulerPolicy {
  admissions: ReadonlyMap<string, ExecutionAdmissionTicket>;
  controlTickets: readonly ExecutionAdmissionTicket[];
  executionReservations: ExecutionAdmissionTicket[];
}

function prepareSchedulerPolicy(
  run: RunRecord,
  authority: SchedulerExecutionAuthority,
): PreparedSchedulerPolicy {
  const admissions = new Map<string, ExecutionAdmissionTicket>();
  const controls: ExecutionAdmissionTicket[] = [];
  const reservations: ExecutionAdmissionTicket[] = [];
  for (const ticket of Object.values(run.tickets).sort((left, right) =>
    compareUtf8(left.id, right.id),
  )) {
    if (ticketIsTerminal(ticket)) continue;
    const metadata = authority.tickets[ticket.id];
    if (metadata === undefined) {
      schedulerFail(
        "scheduler.execution_binding_missing",
        `nonterminal ticket ${ticket.id} lacks compiler-owned execution-policy authority`,
      );
    }
    const admission = ticketAdmission(ticket, metadata);
    // The authority helper validates catalog and binding integrity even when no conflict exists.
    deriveExecutionAdmissionConflicts(authority.catalog, run.projectRoot, admission, []);
    const operation = boundOperation(authority.catalog, metadata.binding, ticket.id);
    assertRoleMetadata(ticket, operation, metadata);
    admissions.set(ticket.id, admission);
    if (
      operation.changeControl.role === "proposal" ||
      operation.changeControl.role === "application"
    ) {
      controls.push(admission);
    }
    if (ticketOwnsExecutionReservation(ticket)) reservations.push(admission);
  }
  assertCrossTicketControlAuthority(run, authority);
  return {
    admissions,
    controlTickets: Object.freeze(controls),
    executionReservations: reservations,
  };
}

function assertCrossTicketControlAuthority(
  run: RunRecord,
  authority: SchedulerExecutionAuthority,
): void {
  const resolverSources = new Map<string, string>();
  for (const ticket of Object.values(run.tickets).sort((left, right) =>
    compareUtf8(left.id, right.id),
  )) {
    if (ticketIsTerminal(ticket)) continue;
    const metadata = authority.tickets[ticket.id]!;
    const operation = boundOperation(authority.catalog, metadata.binding, ticket.id);
    if (operation.changeControl.role === "application") {
      const sourceId = metadata.sourceProposalTicketId!;
      const source = run.tickets[sourceId];
      const sourceMetadata = authority.tickets[sourceId];
      if (source === undefined || sourceMetadata === undefined || sourceId === ticket.id) {
        schedulerFail(
          "scheduler.application_source_missing",
          `application ticket ${ticket.id} has no distinct durable source proposal ${sourceId}`,
        );
      }
      const sourceAdmission = ticketAdmission(source, sourceMetadata);
      deriveExecutionAdmissionConflicts(authority.catalog, run.projectRoot, sourceAdmission, []);
      const sourceOperation = boundOperation(authority.catalog, sourceMetadata.binding, source.id);
      if (
        sourceOperation.changeControl.role !== "proposal" ||
        source.status !== "completed" ||
        sourceMetadata.approvedApplicationSha256 !== metadata.approvedApplicationSha256
      ) {
        schedulerFail(
          "scheduler.application_source_stale",
          `application ticket ${ticket.id} is not bound to one completed proposal and matching approval`,
        );
      }
    }
    if (operation.terminalResolver) {
      const recovery = metadata.terminalRecovery!;
      const source = run.tickets[recovery.sourceTicketId];
      const sourceMetadata = authority.tickets[recovery.sourceTicketId];
      if (
        source === undefined ||
        sourceMetadata === undefined ||
        source.id === ticket.id ||
        source.status !== "blocked"
      ) {
        schedulerFail(
          "scheduler.terminal_resolver_source",
          `terminal resolver ${ticket.id} lacks one blocked durable source ticket`,
        );
      }
      const sourceAdmission = ticketAdmission(source, sourceMetadata);
      deriveExecutionAdmissionConflicts(authority.catalog, run.projectRoot, sourceAdmission, []);
      if (boundOperation(authority.catalog, sourceMetadata.binding, source.id).terminalResolver) {
        schedulerFail(
          "scheduler.terminal_resolver_recursion",
          `terminal resolver ${ticket.id} cannot be emitted for another terminal resolver`,
        );
      }
      const prior = resolverSources.get(source.id);
      if (prior !== undefined && prior !== ticket.id) {
        schedulerFail(
          "scheduler.terminal_resolver_ambiguous",
          `terminal recovery source ${source.id} is bound to both ${prior} and ${ticket.id}`,
        );
      }
      resolverSources.set(source.id, ticket.id);
    }
  }
}

function ticketAdmission(
  ticket: TicketRecord,
  metadata: SchedulerTicketExecutionAuthority,
): ExecutionAdmissionTicket {
  return {
    ticketId: ticket.id,
    binding: metadata.binding,
    targetNodeIds: ticket.targetNodeIds,
    readNodeIds: ticket.readNodeIds ?? ticket.targetNodeIds,
    writeNodeIds: ticket.writeNodeIds ?? ticket.targetNodeIds,
    writePaths: ticket.writePaths,
    ...(metadata.changeControlScopeNodeIds === undefined
      ? {}
      : {
          changeControlScopeNodeIds: metadata.changeControlScopeNodeIds,
        }),
  };
}

function boundOperation(
  catalog: CompiledExecutionSemanticCatalog,
  binding: ExecutionPolicyBinding,
  ticketId: string,
): CompiledOperationSemantics {
  const operation = catalog.operations[binding.operationId];
  if (operation === undefined) {
    schedulerFail(
      "scheduler.operation_binding_missing",
      `ticket ${ticketId} binds unknown operation ${binding.operationId}`,
    );
  }
  return operation;
}

function assertRoleMetadata(
  ticket: TicketRecord,
  operation: CompiledOperationSemantics,
  metadata: SchedulerTicketExecutionAuthority,
): void {
  const role = operation.changeControl.role;
  if (
    (role === "proposal" || role === "application") &&
    (metadata.changeControlScopeNodeIds === undefined ||
      metadata.changeControlScopeNodeIds.length === 0)
  ) {
    schedulerFail(
      "scheduler.change_control_scope_missing",
      `${role} ticket ${ticket.id} lacks its compiler-owned control scope`,
    );
  }
  if (
    role === "proposal" &&
    ticket.status !== "proposed" &&
    !isSha256Digest(metadata.proposalApprovalSha256)
  ) {
    schedulerFail(
      "scheduler.proposal_approval_missing",
      `proposal ticket ${ticket.id} cannot leave proposed without exact approval authority`,
    );
  }
  if (
    role === "application" &&
    (!nonempty(metadata.sourceProposalTicketId) ||
      !isSha256Digest(metadata.approvedApplicationSha256))
  ) {
    schedulerFail(
      "scheduler.application_authority_missing",
      `application ticket ${ticket.id} lacks its source proposal or exact approved application hash`,
    );
  }
  if (role === "disposition" && !ticketIsTerminal(ticket)) {
    schedulerFail(
      "scheduler.disposition_agent_forbidden",
      `disposition ticket ${ticket.id} must be compiler-materialized and cannot enter agent scheduling`,
    );
  }
  if (operation.terminalResolver) {
    const recovery = metadata.terminalRecovery;
    if (
      recovery === undefined ||
      !nonempty(recovery.sourceTicketId) ||
      recovery.failureBindingSha256s.length === 0 ||
      recovery.failureBindingSha256s.some((hash) => !isSha256Digest(hash)) ||
      new Set(recovery.failureBindingSha256s).size !== recovery.failureBindingSha256s.length ||
      recovery.failureBindingSha256s.some(
        (hash, index) =>
          index > 0 && compareUtf8(recovery.failureBindingSha256s[index - 1]!, hash) >= 0,
      )
    ) {
      schedulerFail(
        "scheduler.terminal_resolver_binding",
        `terminal resolver ticket ${ticket.id} lacks exact source/failure authority`,
      );
    }
  } else if (metadata.terminalRecovery !== undefined) {
    schedulerFail(
      "scheduler.terminal_resolver_binding",
      `non-resolver ticket ${ticket.id} carries terminal recovery authority`,
    );
  }
}

function schedulerPolicyConflicts(
  catalog: CompiledExecutionSemanticCatalog,
  projectRoot: string,
  candidate: ExecutionAdmissionTicket,
  controlTickets: readonly ExecutionAdmissionTicket[],
  executionReservations: readonly ExecutionAdmissionTicket[],
): readonly ExecutionAdmissionConflict[] {
  const byIdentity = new Map<string, ExecutionAdmissionConflict>();
  for (const conflict of deriveExecutionAdmissionConflicts(
    catalog,
    projectRoot,
    candidate,
    executionReservations,
  )) {
    byIdentity.set(policyConflictIdentity(conflict), conflict);
  }
  for (const control of controlTickets) {
    // A ready proposal/application is itself present in the durable control set. It must not
    // manufacture a change-control conflict against its own admission; the barrier is for
    // competing tickets touching the same controlled scope.
    if (control.ticketId === candidate.ticketId) continue;
    for (const conflict of deriveExecutionAdmissionConflicts(catalog, projectRoot, candidate, [
      control,
    ])) {
      if (conflict.kind === "change_control_barrier") {
        byIdentity.set(policyConflictIdentity(conflict), conflict);
      }
    }
  }
  return Object.freeze(
    [...byIdentity.values()].sort(
      (left, right) =>
        compareUtf8(left.kind, right.kind) ||
        compareUtf8(left.activeTicketId, right.activeTicketId),
    ),
  );
}

function policyConflictIdentity(conflict: ExecutionAdmissionConflict): string {
  return `${conflict.kind}\0${conflict.activeTicketId}\0${conflict.detail}`;
}

function reservePolicyAdmission(
  reservations: ExecutionAdmissionTicket[],
  admission: ExecutionAdmissionTicket,
): void {
  if (!reservations.some((candidate) => candidate.ticketId === admission.ticketId)) {
    reservations.push(admission);
  }
}

function ticketOwnsExecutionReservation(ticket: TicketRecord): boolean {
  return (
    ticket.steps.some((step) => step.status === "running") ||
    ticket.status === "running" ||
    ticket.status === "review" ||
    ticket.worktreePath !== undefined ||
    ticket.branch !== undefined ||
    ticket.gitCycleId !== undefined
  );
}

function ticketIsTerminal(ticket: TicketRecord): boolean {
  return ticket.status === "completed" || ticket.status === "cancelled";
}

function nonempty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function schedulerFail(code: string, message: string): never {
  throw new SchedulerAuthorityError(code, message);
}

export function finishAssignment(
  run: RunRecord,
  assignment: ReadyAssignment,
  outcome:
    | { status: "completed"; summary: string }
    | { status: "failed"; blocker: string; failureKind?: "semantic" | "infrastructure" },
  at: string,
): AssignmentFinishResult {
  const { ticket, step } = resolveAssignment(run, assignment);
  if (step.status !== "running") {
    throw new Error(`step is not running: ${ticket.id}/${step.id}`);
  }
  step.completedAt = at;
  ticket.updatedAt = at;
  if (outcome.status === "failed") {
    // Only one compiler-accepted semantic Review may send work back to its configured owner.
    // Provider, runtime, containment, accounting, and admission failures say nothing about the
    // author's product. Reopening on those failures both misattributes the fault and can spend an
    // entire rework cycle reproducing unchanged work.
    if (
      outcome.failureKind !== "infrastructure" &&
      reopenAfterReviewFailure(ticket, step, outcome.blocker, at)
    ) {
      return { disposition: "review_rework" };
    }
    const reviewExhausted =
      outcome.failureKind !== "infrastructure" && isConfiguredReviewFailure(ticket, step);
    step.status = "failed";
    ticket.status = "blocked";
    ticket.blocker = outcome.blocker;
    return { disposition: reviewExhausted ? "review_exhausted" : "blocked" };
  }
  step.status = "completed";
  step.summary = outcome.summary;
  ticket.blocker = undefined;
  ticket.status = ticket.steps.every(
    (candidate) => candidate.status === "completed" || candidate.status === "skipped",
  )
    ? "completed"
    : "queued";
  return {
    disposition: ticket.status === "completed" ? "ticket_completed" : "advanced",
  };
}

export interface LegacyCompletedReviewRejectionCandidate {
  reviewAttemptId: string;
  blocker: string;
}

export function reviewReworkAppliesToStep(ticket: TicketRecord, stepId: string): boolean {
  const rework = ticket.reviewReworks?.at(-1);
  if (rework === undefined) return false;
  if (rework.scope === "review_only") return stepId === rework.reopenFromStepId;
  return (
    stepId === rework.reopenFromStepId ||
    stepTransitivelyDependsOn(ticket, stepId, rework.reopenFromStepId)
  );
}

/**
 * Identify the first attempt for a compiler-configured review-rework slice. Its immutable parent
 * remains in lineage, but the new attempt should use the injected blocker/evidence as a fresh
 * conversation root instead of replaying the rejected producer transcript.
 */
export function beginsBoundedReviewRework(
  ticket: TicketRecord,
  stepId: string,
  latestSameScopeAttemptStartedAt: string | undefined,
): boolean {
  const rework = ticket.reviewReworks?.at(-1);
  if (
    rework === undefined ||
    (latestSameScopeAttemptStartedAt !== undefined &&
      latestSameScopeAttemptStartedAt >= rework.openedAt)
  ) {
    return false;
  }
  return reviewReworkAppliesToStep(ticket, stepId);
}

/**
 * Recognize only the legacy terminal shape that could misclassify an explicit rejection. Typed
 * review output is authoritative and is never interpreted from prose.
 */
export function legacyCompletedReviewRejectionCandidate(
  ticket: Readonly<TicketRecord>,
  terminalOutput: unknown,
): LegacyCompletedReviewRejectionCandidate | undefined {
  if (
    terminalOutput === null ||
    typeof terminalOutput !== "object" ||
    Array.isArray(terminalOutput) ||
    Object.hasOwn(terminalOutput, "reviewVerdict")
  ) {
    return undefined;
  }
  const output = terminalOutput as Record<string, unknown>;
  const summary = typeof output.summary === "string" ? output.summary.trim() : "";
  const prefix = "Review rejected:";
  const review = [...ticket.steps].reverse().find((step) => step.kind === "review");
  const reviewAttemptId = review?.attemptIds.at(-1);
  if (
    output.status !== "completed" ||
    !summary.startsWith(prefix) ||
    reviewAttemptId === undefined ||
    ticket.status !== "completed" ||
    review?.status !== "completed"
  ) {
    return undefined;
  }
  const blocker = summary.slice(prefix.length).trim();
  return blocker.length === 0 ? undefined : { reviewAttemptId, blocker };
}

/**
 * Recover the pre-typed-verdict compatibility case where a reviewer durably described a rejection
 * but the legacy terminal contract classified the review attempt as completed. Detection of that
 * legacy output shape belongs to the authority; this scheduler transition only reopens the exact
 * compiler-configured producer slice once, under the workflow's existing bounded rework allowance.
 */
export function recoverLegacyCompletedReviewRejection(
  ticket: TicketRecord,
  reviewAttemptId: string,
  blocker: string,
  at: string,
  operatorAuthorization?: TicketReviewReworkRecord["operatorAuthorization"],
): boolean {
  const reopenFrom = ticket.reviewFailureReopenFrom;
  const limit = ticket.reviewReworkLimit;
  const count = ticket.reviewReworkCount;
  const review = [...ticket.steps].reverse().find((step) => step.kind === "review");
  if (
    ticket.status !== "completed" ||
    reopenFrom === undefined ||
    limit === undefined ||
    count === undefined ||
    count >= limit ||
    review?.status !== "completed" ||
    review.attemptIds.at(-1) !== reviewAttemptId ||
    blocker.trim().length === 0
  ) {
    return false;
  }
  const anchor = ticket.steps.find((step) => step.id === reopenFrom);
  if (anchor === undefined || !stepTransitivelyDependsOn(ticket, review.id, reopenFrom)) {
    return false;
  }
  for (const step of ticket.steps.filter(
    (candidate) =>
      candidate.id === anchor.id || stepTransitivelyDependsOn(ticket, candidate.id, anchor.id),
  )) {
    step.status = "pending";
    step.summary = undefined;
    step.startedAt = undefined;
    step.completedAt = undefined;
  }
  ticket.reviewReworkCount = count + 1;
  ticket.reviewReworks ??= [];
  ticket.reviewReworks.push({
    ordinal: ticket.reviewReworks.length + 1,
    mode: "automatic",
    failedReviewAttemptId: reviewAttemptId,
    reopenFromStepId: reopenFrom,
    blocker,
    ...(operatorAuthorization === undefined ? {} : { operatorAuthorization }),
    openedAt: at,
  });
  ticket.status = "queued";
  ticket.blocker = blocker;
  ticket.updatedAt = at;
  return true;
}

/**
 * Project one exact semantic-review recovery. Generic Resume must never manufacture this state:
 * the operator action is bound to the latest failed reviewer attempt and the compiler-pinned
 * reopen anchor.
 */
export function blockedReviewRetryCandidate(
  ticket: Readonly<TicketRecord>,
): BlockedReviewRetryCandidate | undefined {
  if (
    ticket.status !== "blocked" ||
    ticket.blocker === undefined ||
    ticket.blocker.trim().length === 0
  ) {
    return undefined;
  }
  const review = [...ticket.steps].reverse().find((step) => step.kind === "review");
  const failedReview = review?.status === "failed" ? review : undefined;
  const exhaustedAutomaticRework = [...(ticket.reviewReworks ?? [])]
    .reverse()
    .find(
      (record) =>
        record.mode !== "supervised" &&
        review?.attemptIds.includes(record.failedReviewAttemptId) === true,
    );
  const failedReviewAttemptId =
    failedReview?.attemptIds.at(-1) ?? exhaustedAutomaticRework?.failedReviewAttemptId;
  const reopenFromStepId = ticket.reviewFailureReopenFrom;
  if (
    review === undefined ||
    failedReviewAttemptId === undefined ||
    reopenFromStepId === undefined ||
    ticket.reviewReworkLimit === undefined ||
    ticket.reviewReworkCount === undefined ||
    ticket.reviewReworkCount < ticket.reviewReworkLimit
  )
    return undefined;
  const anchor = ticket.steps.find((step) => step.id === reopenFromStepId);
  if (anchor === undefined || !stepTransitivelyDependsOn(ticket, review.id, anchor.id))
    return undefined;
  return {
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    reviewStepId: review.id,
    failedReviewAttemptId,
    reopenFromStepId,
    // A failed author in the automatic rework slice can replace the ticket's visible blocker
    // with an infrastructure/budget failure while the review step remains pending. The durable
    // review-rework record is the semantic correction contract that the supervised retry must
    // restore; the failed author attempt remains immutable evidence on the step.
    blocker:
      failedReview === undefined && exhaustedAutomaticRework !== undefined
        ? exhaustedAutomaticRework.blocker
        : ticket.blocker,
  };
}

/**
 * Project a review-only recovery even when the workflow intentionally has no producer-rework
 * route. The operator may re-run independent judgment over compiler-accepted predecessors; this
 * never grants authority to reopen or alter the producer slice.
 */
export function blockedIndependentReviewRetryCandidate(
  ticket: Readonly<TicketRecord>,
): BlockedReviewRetryCandidate | undefined {
  const configured = blockedReviewRetryCandidate(ticket);
  if (configured !== undefined) return configured;
  if (
    ticket.status !== "blocked" ||
    ticket.blocker === undefined ||
    ticket.blocker.trim().length === 0
  ) {
    return undefined;
  }
  const review = [...ticket.steps].reverse().find((step) => step.kind === "review");
  if (review?.status !== "failed") return undefined;
  const failedReviewAttemptId = review.attemptIds.at(-1);
  if (failedReviewAttemptId === undefined) return undefined;
  return {
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    reviewStepId: review.id,
    failedReviewAttemptId,
    // Review-only authorization ignores the producer anchor. Binding this fallback to the review
    // itself makes producer-and-review authorization fail closed while retaining one exact record.
    reopenFromStepId: review.id,
    blocker: ticket.blocker,
  };
}

/**
 * Reopen exactly one exhausted review slice after an explicit authority-validated operator action.
 * The automatic rework count and immutable limit remain untouched, so another failed review stops
 * at the human boundary again instead of becoming an unbounded agent loop.
 */
export function authorizeBlockedReviewRetry(
  run: RunRecord,
  expected: Readonly<
    Pick<BlockedReviewRetryCandidate, "ticketId" | "reviewStepId" | "failedReviewAttemptId">
  >,
  at: string,
  operatorSteering?: string,
  retryScope: BlockedReviewRetryScope = "producer_and_review",
  operatorAuthorization?: TicketReviewReworkRecord["operatorAuthorization"],
): BlockedReviewRetryCandidate {
  const ticket = run.tickets[expected.ticketId];
  const candidate =
    ticket === undefined
      ? undefined
      : retryScope === "review_only"
        ? blockedIndependentReviewRetryCandidate(ticket)
        : blockedReviewRetryCandidate(ticket);
  if (
    ticket === undefined ||
    candidate === undefined ||
    candidate.reviewStepId !== expected.reviewStepId ||
    candidate.failedReviewAttemptId !== expected.failedReviewAttemptId
  ) {
    schedulerFail(
      "review_retry_stale",
      `review recovery no longer matches ${expected.ticketId}/${expected.reviewStepId}/${expected.failedReviewAttemptId}`,
    );
  }
  const anchor = ticket.steps.find((step) => step.id === candidate.reopenFromStepId)!;
  const review = ticket.steps.find((step) => step.id === candidate.reviewStepId)!;
  if (retryScope === "review_only") {
    for (const step of ticket.steps.filter(
      (current) =>
        current.id !== review.id && stepTransitivelyDependsOn(ticket, review.id, current.id),
    )) {
      if (step.status === "completed" || step.status === "skipped") continue;
      const accepted = latestAcceptedSemanticAttempt(run, ticket.id, step);
      if (accepted === undefined) {
        schedulerFail(
          "review_retry_predecessor",
          `review-only recovery cannot restore ${ticket.id}/${step.id} without a prior compiler-accepted semantic attempt`,
        );
      }
      step.status = "completed";
      step.summary = accepted.terminalSummary!;
      step.startedAt = accepted.startedAt;
      step.completedAt = accepted.endedAt ?? accepted.terminalAcceptedAt;
    }
    for (const step of ticket.steps.filter(
      (current) =>
        current.id === review.id || stepTransitivelyDependsOn(ticket, current.id, review.id),
    )) {
      step.status = "pending";
      step.summary = undefined;
      step.startedAt = undefined;
      step.completedAt = undefined;
    }
  } else {
    for (const step of ticket.steps.filter(
      (current) =>
        current.id === anchor.id || stepTransitivelyDependsOn(ticket, current.id, anchor.id),
    )) {
      step.status = "pending";
      step.summary = undefined;
      step.startedAt = undefined;
      step.completedAt = undefined;
    }
  }
  ticket.reviewReworks ??= [];
  ticket.reviewReworks.push({
    ordinal: ticket.reviewReworks.length + 1,
    mode: "supervised",
    ...(retryScope === "producer_and_review" ? {} : { scope: retryScope }),
    failedReviewAttemptId: candidate.failedReviewAttemptId,
    reopenFromStepId: candidate.reopenFromStepId,
    blocker: candidate.blocker,
    ...(operatorSteering === undefined ? {} : { operatorSteering }),
    ...(operatorAuthorization === undefined ? {} : { operatorAuthorization }),
    openedAt: at,
  });
  ticket.status = "queued";
  // Restore the exact reviewed blocker. The next compiler-issued author context uses it as the
  // operator-authorized rework contract; leaving a later author infrastructure/budget blocker here
  // would discard the reviewer findings that define the rework.
  ticket.blocker = candidate.blocker;
  ticket.updatedAt = at;
  return candidate;
}

/** Bind the automatic review retry opened by `finishAssignment` to its exact failed settlement. */
export function bindAutomaticReviewReworkFailureProof(
  ticket: TicketRecord,
  failedReviewAttemptId: string,
  failureProofSha256: Sha256Digest,
): void {
  const record = ticket.reviewReworks?.at(-1);
  if (
    record === undefined ||
    record.mode === "supervised" ||
    record.failedReviewAttemptId !== failedReviewAttemptId ||
    record.failureProofSha256 !== undefined
  ) {
    schedulerFail(
      "review_rework_failure_proof",
      `automatic review rework no longer matches ${failedReviewAttemptId}`,
    );
  }
  record.failureProofSha256 = failureProofSha256;
}

/** Bind a direct-terminal review retry to the exact compiler-consumed terminal artifact. */
export function bindAutomaticReviewReworkTerminalOutput(
  ticket: TicketRecord,
  failedReviewAttemptId: string,
  terminalOutputSha256: Sha256Digest,
): void {
  const record = ticket.reviewReworks?.at(-1);
  if (
    record === undefined ||
    record.mode === "supervised" ||
    record.failedReviewAttemptId !== failedReviewAttemptId ||
    record.failureTerminalOutputSha256 !== undefined
  ) {
    schedulerFail(
      "review_rework_terminal_output",
      `automatic review rework no longer matches ${failedReviewAttemptId}`,
    );
  }
  record.failureTerminalOutputSha256 = terminalOutputSha256;
}

/**
 * Review-only recovery is available only when every nonterminal predecessor can be restored from
 * an immutable compiler-accepted semantic attempt. Failed submissions and plain completed labels
 * are not sufficient: this recovery preserves an effect, it never manufactures one.
 */
export function canRetryBlockedReviewOnly(
  run: Readonly<RunRecord>,
  candidate: Readonly<BlockedReviewRetryCandidate>,
): boolean {
  const ticket = run.tickets[candidate.ticketId];
  const review = ticket?.steps.find((step) => step.id === candidate.reviewStepId);
  if (ticket === undefined || review === undefined) return false;
  return ticket.steps
    .filter(
      (step) => step.id !== review.id && stepTransitivelyDependsOn(ticket, review.id, step.id),
    )
    .every(
      (step) =>
        step.status === "completed" ||
        step.status === "skipped" ||
        latestAcceptedSemanticAttempt(run, ticket.id, step) !== undefined,
    );
}

function latestAcceptedSemanticAttempt(
  run: Readonly<RunRecord>,
  ticketId: string,
  step: Readonly<TicketStepRecord>,
): RunRecord["attempts"][string] | undefined {
  return [...step.attemptIds]
    .reverse()
    .map((attemptId) => run.attempts[attemptId])
    .find(
      (attempt) =>
        attempt?.ticketId === ticketId &&
        attempt.stepId === step.id &&
        attempt.status === "completed" &&
        attempt.terminalOutputSha256 !== undefined &&
        attempt.terminalSummary !== undefined &&
        attempt.terminalSummary.trim().length > 0 &&
        (attempt.terminalPolicy?.mode === "semantic" ||
          attempt.terminalPolicy?.mode === "legacy_pre_execution_policy"),
    );
}

function isConfiguredReviewFailure(ticket: TicketRecord, step: TicketStepRecord): boolean {
  const reopenFrom = ticket.reviewFailureReopenFrom;
  if (step.kind !== "review" || reopenFrom === undefined) return false;
  const anchor = ticket.steps.find((candidate) => candidate.id === reopenFrom);
  return anchor !== undefined && stepTransitivelyDependsOn(ticket, step.id, anchor.id);
}

function reopenAfterReviewFailure(
  ticket: TicketRecord,
  failedStep: TicketStepRecord,
  blocker: string,
  at: string,
): boolean {
  const reopenFrom = ticket.reviewFailureReopenFrom;
  const limit = ticket.reviewReworkLimit;
  const count = ticket.reviewReworkCount;
  if (
    failedStep.kind !== "review" ||
    reopenFrom === undefined ||
    limit === undefined ||
    count === undefined ||
    count >= limit
  )
    return false;
  const anchor = ticket.steps.find((step) => step.id === reopenFrom);
  if (anchor === undefined || !stepTransitivelyDependsOn(ticket, failedStep.id, reopenFrom))
    return false;
  const failedReviewAttemptId = failedStep.attemptIds.at(-1);
  if (failedReviewAttemptId === undefined) return false;

  for (const step of ticket.steps.filter(
    (candidate) =>
      candidate.id === anchor.id || stepTransitivelyDependsOn(ticket, candidate.id, anchor.id),
  )) {
    step.status = "pending";
    step.summary = undefined;
    step.startedAt = undefined;
    step.completedAt = undefined;
  }
  ticket.reviewReworkCount = count + 1;
  ticket.reviewReworks ??= [];
  ticket.reviewReworks.push({
    ordinal: ticket.reviewReworks.length + 1,
    mode: "automatic",
    failedReviewAttemptId,
    reopenFromStepId: reopenFrom,
    blocker,
    openedAt: at,
  });
  ticket.status = "queued";
  ticket.blocker = blocker;
  return true;
}

function resolveAssignment(
  run: RunRecord,
  assignment: ReadyAssignment,
): { ticket: TicketRecord; step: TicketStepRecord } {
  if (assignment.runId !== run.id) {
    throw new Error("assignment belongs to another run");
  }
  const ticket = run.tickets[assignment.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === assignment.stepId);
  if (
    ticket === undefined ||
    step === undefined ||
    step.personaId !== assignment.personaId ||
    ticket.priority !== assignment.priority
  ) {
    throw new Error("assignment no longer matches compiled ticket state");
  }
  return { ticket, step };
}

interface AssignmentScope {
  readNodeIds: readonly string[];
  writeNodeIds: readonly string[];
  readPaths: readonly string[];
  writePaths: readonly string[];
}

interface ReservedAssignmentScope {
  ticketId: string;
  stepId: string;
  scope: AssignmentScope;
}

function assignmentScope(ticket: TicketRecord, step: TicketStepRecord): AssignmentScope {
  const legacyGraphScope = ticket.targetNodeIds;
  return {
    readNodeIds: step.readNodeIds ?? ticket.readNodeIds ?? legacyGraphScope,
    writeNodeIds: step.writeNodeIds ?? ticket.writeNodeIds ?? legacyGraphScope,
    readPaths: step.readPaths ?? ticket.readPaths,
    writePaths: step.writePaths ?? ticket.writePaths,
  };
}

function assignmentScopesConflict(
  pathAuthority: ProjectPathAuthority,
  left: AssignmentScope,
  right: AssignmentScope,
): { conflict: boolean; unsafe: boolean } {
  if (
    intersects(left.writeNodeIds, right.writeNodeIds) ||
    intersects(left.writeNodeIds, right.readNodeIds) ||
    intersects(left.readNodeIds, right.writeNodeIds)
  )
    return { conflict: true, unsafe: false };
  try {
    for (const leftPath of left.writePaths) {
      for (const rightPath of [...right.writePaths, ...right.readPaths]) {
        if (pathAuthority.pathsOverlap(leftPath, rightPath)) {
          return { conflict: true, unsafe: false };
        }
      }
    }
    for (const leftPath of left.readPaths) {
      for (const rightPath of right.writePaths) {
        if (pathAuthority.pathsOverlap(leftPath, rightPath)) {
          return { conflict: true, unsafe: false };
        }
      }
    }
  } catch {
    return { conflict: true, unsafe: true };
  }
  return { conflict: false, unsafe: false };
}

function stepDependencies(ticket: TicketRecord, step: TicketStepRecord): readonly string[] {
  if (step.dependsOn !== undefined) return step.dependsOn;
  const index = ticket.steps.indexOf(step);
  return index <= 0 ? [] : [ticket.steps[index - 1]!.id];
}

function dependencyComplete(ticket: TicketRecord, dependencyId: string): boolean {
  const status = ticket.steps.find((step) => step.id === dependencyId)?.status;
  return status === "completed" || status === "skipped";
}

function stepTransitivelyDependsOn(
  ticket: TicketRecord,
  stepId: string,
  ancestorId: string,
): boolean {
  const pending = [stepId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const candidateId = pending.pop()!;
    if (visited.has(candidateId)) continue;
    visited.add(candidateId);
    const candidate = ticket.steps.find((step) => step.id === candidateId);
    if (candidate === undefined) return false;
    for (const dependency of stepDependencies(ticket, candidate)) {
      if (dependency === ancestorId) return true;
      pending.push(dependency);
    }
  }
  return false;
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}
