import path from "node:path";
import type {
  KoniAttemptUsage,
  KoniProviderRequestReservationInput,
  KoniProviderRequestSettlement,
  KoniProviderRequestSettlementInput,
} from "../pi/compaction.js";
import { type AgentLaunchSpec } from "../pi/launch-spec.js";
import type { ManagedSessionOutcome } from "../pi/managed-session.js";
import {
  deriveProviderSettlement,
  estimateProviderInputTokens,
  isSupportedProviderOutputCap,
  providerApiHasSupportedOutputCap,
} from "../pi/provider-request.js";
import { readPiSessionDurably, type ParsedPiSession } from "../pi/session-transcript.js";
import {
  canonicalHash,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  type DurableAuthorityQuiesceOperation,
  type DurableAuthorityReceipt,
} from "./project-store.js";
import {
  assignmentForAttempt,
  assignmentUsesConfiguredValidation,
  attemptTicketExecutionEpoch,
  checkedProviderSum,
  currentTicketExecutionEpoch,
  errorMessage,
  isProviderExposureHoldBlocker,
  isRecord,
  planningTokenUsageFromBaseline,
  preSemanticValidationReissueCount,
  recoveryPreservedPreSemanticState,
} from "./run-engine-shared.js";
import { AuthorityRpcError } from "./server.js";

import type {
  AgentAttemptRecord,
  AgentProviderRequestRecord,
  AttemptStatus,
  RunActionExecutionRecord,
  RunRecord,
} from "../state/run-record.js";
import {
  configuredCheckInfrastructureFailureForAttempt,
  createRunActionSettlement,
  tokenBudgetRecoveryAuthorityCounts,
  tokenBudgetRecoverySliceForAttempt,
} from "../state/run-record.js";
import { type ReadyAssignment } from "../state/scheduler.js";

import {
  MAX_PRE_SEMANTIC_VALIDATION_REISSUES,
  MAX_PROVIDER_EXPOSURE_AUTO_RECOVERIES,
  MAX_PROVIDER_RATE_LIMIT_AUTO_RECOVERIES,
  MAX_PROVIDER_RATE_LIMIT_RECOVERY_DELAY_MS,
  MAX_PROVIDER_RESPONSE_TRANSCRIPT_OVERSHOOT_BYTES,
  MAX_PROVIDER_ZERO_USAGE_TRANSPORT_AUTO_RECOVERIES,
  MAX_PROVIDER_ZERO_USAGE_TRANSPORT_RECOVERY_DELAY_MS,
  MIN_PROVIDER_RATE_LIMIT_RECOVERY_DELAY_MS,
  MIN_PROVIDER_ZERO_USAGE_TRANSPORT_RECOVERY_DELAY_MS,
  UNCAPPED_PROVIDER_CONTEXT_FRAMING_RESERVE,
} from "./run-engine-contracts.js";

export function hasLiveAttempt(run: RunRecord, kind: AgentAttemptRecord["kind"]): boolean {
  return Object.values(run.attempts).some(
    (attempt) =>
      attempt.kind === kind &&
      new Set(["queued", "running", "waiting_question", "terminal_accepted"]).has(attempt.status),
  );
}

export function isStartupSafetyQuiesce(
  operation: DurableAuthorityQuiesceOperation,
  receipts: Readonly<Record<string, DurableAuthorityReceipt>>,
): boolean {
  if (operation.purpose === "startup_failure" || operation.purpose === "dirty_startup_recovery") {
    return true;
  }
  if (operation.purpose !== undefined) return false;
  // Compatibility for pre-purpose startup-failure markers. The old internal failure path used this
  // reserved key prefix but did not commit an authority.quiesce receipt. The operator path committed
  // marker + matching receipt atomically, so caller-controlled prefix spoofing remains nonprivileged.
  const operatorReceipt = Object.values(receipts).some(
    (receipt) =>
      receipt.method === "authority.quiesce" &&
      receipt.idempotencyKey === operation.idempotencyKey &&
      receipt.requestHash === operation.requestHash,
  );
  return operation.idempotencyKey.startsWith("startup-failure:") && !operatorReceipt;
}

/**
 * A terminal tool receipt admits exact output bytes; it does not close the provider attempt.
 * Compiler action effects may already be staged in the durable run while that ACK is pending,
 * so no downstream scheduler or Git consumer may observe them as final authority yet.
 */
export function hasUnfinalizedAcceptedAssignment(run: Readonly<RunRecord>): boolean {
  return Object.values(run.attempts).some(
    (attempt) =>
      attempt.status === "terminal_accepted" && assignmentForAttempt(run, attempt) !== undefined,
  );
}

export function interruptRunningAttempts(run: RunRecord, reason: string, at: string): void {
  for (const attempt of Object.values(run.attempts)) {
    if (!new Set(["queued", "running", "waiting_question"]).has(attempt.status)) continue;
    attempt.status = "interrupted";
    attempt.error = reason;
    attempt.endedAt = at;
    attempt.terminalSummary = reason;
    const ticket = run.tickets[attempt.ticketId];
    const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
    if (step?.status === "running") {
      step.status = "pending";
      step.startedAt = undefined;
      step.completedAt = undefined;
      ticket!.status = "queued";
      ticket!.blocker = undefined;
      ticket!.updatedAt = at;
    }
  }
  blockInterruptedContinuousPlanningSession(run, at);
}

/**
 * A stopped boundary may also retire a terminal-accepted attempt, but only after its exact
 * validation action has been abandoned. This ordering prevents a compiled terminal product from
 * being both accepted and silently reset to pending.
 */
export function interruptStoppedAttempts(run: RunRecord, reason: string, at: string): void {
  for (const attempt of Object.values(run.attempts)) {
    if (
      !new Set<AttemptStatus>(["queued", "running", "waiting_question", "terminal_accepted"]).has(
        attempt.status,
      )
    )
      continue;
    if (attempt.status === "terminal_accepted") {
      if (attempt.kind === "planning" && run.planningSession?.attemptId === attempt.id) {
        // The exact compiler-validated terminal bytes are already durable, but continuous
        // planning does not expose a checkpoint until transcript/provider settlement. Preserve
        // that crash-forward cursor across pause/delete instead of falsely completing the stable
        // attempt or discarding the accepted artifact.
        continue;
      }
      const validation = Object.values(run.actionExecutions ?? {}).find(
        (action) =>
          action.boundary.kind === "assignment_validation" &&
          action.boundary.attemptId === attempt.id &&
          action.boundary.generation === run.generation,
      );
      const assignment = assignmentForAttempt(run, attempt);
      if (validation !== undefined && validation.settlement?.disposition !== "abandoned") {
        if (
          !new Set(["completed", "failed"]).has(validation.settlement?.disposition ?? "") ||
          attempt.terminalPolicy === undefined
        ) {
          throw new AuthorityRpcError(
            "attempt_stop_binding",
            `terminal-accepted attempt ${attempt.id} has not reached a safe semantic settlement`,
          );
        }
        const accountingIssue = providerOutcomeAccountingIssue(attempt, undefined, false);
        // The configured compiler result is already authoritative and may have advanced the
        // ticket. Finalize only the provider attempt; resetting its assignment would erase or
        // duplicate those accepted semantic effects after restart.
        attempt.status = "completed";
        attempt.endedAt = at;
        attempt.terminalSummary ??= `${reason} after semantic validation`;
        if (accountingIssue !== undefined) attempt.error = accountingIssue;
        continue;
      }
      if (
        assignment !== undefined &&
        assignmentUsesConfiguredValidation(run, assignment) &&
        validation === undefined
      ) {
        throw new AuthorityRpcError(
          "attempt_stop_binding",
          `terminal-accepted attempt ${attempt.id} lost its configured validation action`,
        );
      }
      if (attempt.terminalPolicy !== undefined) {
        const accountingIssue = providerOutcomeAccountingIssue(attempt, undefined, false);
        // Direct semantic compilation has already applied its exact graph/ticket/change-control
        // effects in the same CAS that attached this policy. Close the provider attempt without
        // rolling the accepted assignment back.
        attempt.status = "completed";
        attempt.endedAt = at;
        attempt.terminalSummary ??= `${reason} after semantic compilation`;
        if (accountingIssue !== undefined) attempt.error = accountingIssue;
        continue;
      }
      if (
        assignment === undefined &&
        new Set<AgentAttemptRecord["kind"]>(["planning", "lead", "verification"]).has(
          attempt.kind,
        ) &&
        attempt.terminalAcceptedAt !== undefined &&
        attempt.terminalOutputSha256 !== undefined
      ) {
        const accountingIssue = providerOutcomeAccountingIssue(attempt, undefined, false);
        // These run-scoped roles compile their plan/judgment/review into the same terminal-tool
        // CAS. Their semantic state is already authoritative even if the child outcome ACK died.
        attempt.status = "completed";
        attempt.endedAt = at;
        attempt.terminalSummary ??= `${reason} after run-scoped semantic compilation`;
        if (accountingIssue !== undefined) attempt.error = accountingIssue;
        continue;
      }
    }
    attempt.status = "interrupted";
    attempt.error = reason;
    attempt.endedAt = at;
    attempt.terminalSummary = reason;
    const assignment = assignmentForAttempt(run, attempt);
    if (assignment !== undefined) resetAssignmentAfterInterruption(run, assignment, at);
  }
  blockInterruptedContinuousPlanningSession(run, at);
}

export function blockInterruptedContinuousPlanningSession(run: RunRecord, at: string): void {
  const session = run.planningSession;
  const attempt = session === undefined ? undefined : run.attempts[session.attemptId];
  if (session === undefined || attempt?.status !== "interrupted") return;
  session.status = "blocked";
  const revision = session.revisions[session.currentRevision]!;
  revision.status = "failed";
  revision.completedAt ??= at;
}

export function settleRunAction(
  action: RunActionExecutionRecord,
  disposition: "completed" | "failed" | "abandoned",
  reason: string,
  at: string,
  expectedRunRevision: number,
): void {
  if (action.settledAt !== undefined || action.settlement !== undefined) {
    throw new AuthorityRpcError(
      "action_settlement_replay",
      `configured action ${action.invocationId} is already settled`,
    );
  }
  action.settlement = createRunActionSettlement(action, disposition, reason, at);
  action.settledAt = at;
  action.expectedRunRevision = expectedRunRevision;
  action.updatedAt = at;
}

/**
 * Pause/delete wins by closing every admitted configured action in the same CAS as the terminal
 * lifecycle label. In-process action promises are deliberately not awaited: the committed
 * lifecycle tombstone makes every later primitive/finalization CAS fail closed, while the typed
 * abandoned settlement prevents restart from resurrecting the admission.
 */
export function closeStoppedRunActions(run: RunRecord, reason: string, at: string): void {
  const actions = Object.values(run.actionExecutions ?? {}).sort(
    (left, right) =>
      left.boundary.admittedRunRevision - right.boundary.admittedRunRevision ||
      left.invocationId.localeCompare(right.invocationId),
  );

  for (const action of actions) {
    if (action.settledAt !== undefined) continue;
    if (action.boundary.kind === "assignment_validation") {
      const attemptId = action.boundary.attemptId;
      const attempt = attemptId === undefined ? undefined : run.attempts[attemptId];
      if (attempt?.status === "terminal_accepted") {
        const assignment = assignmentForAttempt(run, attempt);
        if (
          assignment === undefined ||
          assignment.ticketId !== action.boundary.ticketId ||
          assignment.stepId !== action.boundary.stepId
        ) {
          throw new AuthorityRpcError(
            "action_stop_binding",
            `stopped assignment validation ${action.invocationId} lost its accepted attempt`,
          );
        }
        attempt.status = "interrupted";
        attempt.error = reason;
        attempt.endedAt = at;
        attempt.terminalSummary = reason;
        resetAssignmentAfterInterruption(run, assignment, at);
      }
    } else if (
      action.boundary.kind === "post_orchestration_report" &&
      action.semanticResult?.kind === "report"
    ) {
      const reportId = action.semanticResult.reportId;
      if (run.postOrchestration?.report?.reportId === reportId) {
        delete run.postOrchestration.report;
      }
    }
    settleRunAction(action, "abandoned", reason, at, run.revision);
  }

  // Recovery is a two-record protocol. Closing the child also records that its parent has no
  // pending recovery settlement; both records retain their own immutable abandoned disposition.
  for (const action of actions) {
    if (action.boundary.kind !== "recovery" || action.boundary.parentInvocationId === undefined) {
      continue;
    }
    const parent = run.actionExecutions?.[action.boundary.parentInvocationId];
    if (parent !== undefined && parent.recoveryInvocationId === action.invocationId) {
      parent.recoverySettledAt ??= at;
      parent.expectedRunRevision = run.revision;
      parent.updatedAt = at;
    }
  }
}

export function interruptAttemptForContinuation(
  run: RunRecord,
  attempt: AgentAttemptRecord,
  at: string,
): void {
  attempt.status = "interrupted";
  attempt.error = "Question was answered after the original Pi session disconnected";
  attempt.endedAt = at;
  attempt.terminalSummary = "Continued in a fresh answer-linked attempt";
  const ticket = run.tickets[attempt.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
  if (ticket !== undefined && step?.status === "running") {
    step.status = "pending";
    step.startedAt = undefined;
    step.completedAt = undefined;
    ticket.status = "queued";
    ticket.blocker = undefined;
    ticket.updatedAt = at;
  }
}

export function resetAssignmentAfterInterruption(
  run: RunRecord,
  assignment: ReadyAssignment,
  at: string,
): void {
  const ticket = run.tickets[assignment.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === assignment.stepId);
  if (step === undefined || ticket === undefined) return;
  if (step.status === "running") {
    step.status = "pending";
    step.startedAt = undefined;
    step.completedAt = undefined;
    ticket.status = "queued";
    ticket.blocker = undefined;
    ticket.updatedAt = at;
  }
}

/**
 * Recover the exact terminal state emitted by older authorities after a configured recovery
 * durably proved that validation left pre-semantic state unchanged. The settled attempt and
 * action ledger remain immutable; explicit Resume only reissues the failed step when the complete
 * parent/child recovery chain is present and the shared bounded retry allowance remains.
 */
export function resetSettledPreSemanticValidationAssignments(
  run: RunRecord,
  at: string,
): Array<{ ticketId: string; ticketTitle: string; stepId: string }> {
  const retried: Array<{ ticketId: string; ticketTitle: string; stepId: string }> = [];
  for (const ticket of Object.values(run.tickets)) {
    if (
      ticket.status !== "blocked" ||
      ticket.blocker !==
        "Configured terminal validation required recovery; reissue from authenticated failure"
    ) {
      continue;
    }
    const step = ticket.steps.find((candidate) => candidate.status === "failed");
    const attemptId = step?.attemptIds.at(-1);
    const attempt = attemptId === undefined ? undefined : run.attempts[attemptId];
    if (
      step === undefined ||
      attempt === undefined ||
      attempt.status !== "completed" ||
      attempt.terminalPolicy?.mode !== "failed_submission" ||
      attempt.terminalOutputSha256 === undefined ||
      attempt.terminalAcceptedAt === undefined ||
      providerOutcomeAccountingIssue(attempt, undefined, false) !== undefined ||
      preSemanticValidationReissueCount(run, ticket.id, step.id) >=
        MAX_PRE_SEMANTIC_VALIDATION_REISSUES
    ) {
      continue;
    }
    const parent = Object.values(run.actionExecutions ?? {}).find(
      (candidate) =>
        candidate.boundary.kind === "assignment_validation" &&
        candidate.boundary.ticketId === ticket.id &&
        candidate.boundary.stepId === step.id &&
        candidate.boundary.attemptId === attempt.id,
    );
    const recoveryInvocationId = parent?.recoveryInvocationId;
    const recovery =
      recoveryInvocationId === undefined ? undefined : run.actionExecutions?.[recoveryInvocationId];
    if (
      parent === undefined ||
      parent.journal.status !== "recovery_required" ||
      parent.settledAt === undefined ||
      parent.recoverySettledAt === undefined ||
      parent.settlement?.disposition !== "failed" ||
      parent.semanticResult?.kind !== "assignment" ||
      parent.semanticResult.status !== "failed" ||
      parent.semanticResult.blocker !== ticket.blocker ||
      recovery === undefined ||
      recovery.boundary.kind !== "recovery" ||
      recovery.boundary.parentInvocationId !== parent.invocationId ||
      recovery.boundary.ticketId !== ticket.id ||
      recovery.boundary.stepId !== step.id ||
      recovery.boundary.attemptId !== attempt.id ||
      recovery.journal.status !== "completed" ||
      recovery.settledAt === undefined ||
      recovery.settlement?.disposition !== "completed" ||
      !recoveryPreservedPreSemanticState(recovery.journal)
    ) {
      continue;
    }
    step.status = "pending";
    step.startedAt = undefined;
    step.completedAt = undefined;
    step.summary = undefined;
    ticket.status = "queued";
    ticket.blocker = undefined;
    ticket.updatedAt = at;
    retried.push({ ticketId: ticket.id, ticketTitle: ticket.title, stepId: step.id });
  }
  return retried;
}

/**
 * Reissue only effect-free failed submissions whose own authenticated configured check proved an
 * infrastructure failure. The immutable terminal report and check receipt remain in history; the
 * operator resume merely restores the exact step to pending after the environment is repaired.
 */
export function resetRetryableConfiguredCheckInfrastructureAssignments(
  run: RunRecord,
  at: string,
): Array<{ ticketId: string; ticketTitle: string }> {
  const retried: Array<{ ticketId: string; ticketTitle: string }> = [];
  for (const ticket of Object.values(run.tickets)) {
    if (ticket.status !== "blocked") continue;
    const step = ticket.steps.find((candidate) => candidate.status === "failed");
    const attemptId = step?.attemptIds.at(-1);
    const attempt = attemptId === undefined ? undefined : run.attempts[attemptId];
    if (
      step === undefined ||
      attempt === undefined ||
      attempt.status !== "completed" ||
      attempt.terminalPolicy?.mode !== "failed_submission" ||
      attempt.terminalOutputSha256 === undefined ||
      attempt.terminalAcceptedAt === undefined ||
      providerOutcomeAccountingIssue(attempt, undefined, false) !== undefined ||
      configuredCheckInfrastructureFailureForAttempt(run, attempt.id) === undefined
    ) {
      continue;
    }
    step.status = "pending";
    step.startedAt = undefined;
    step.completedAt = undefined;
    step.summary = undefined;
    ticket.status = "queued";
    ticket.blocker = undefined;
    ticket.updatedAt = at;
    retried.push({ ticketId: ticket.id, ticketTitle: ticket.title });
  }
  return retried;
}

export function resetRetryableInfrastructureAssignments(
  run: RunRecord,
  at: string,
): Array<{ ticketId: string; ticketTitle: string }> {
  const retried: Array<{ ticketId: string; ticketTitle: string }> = [];
  for (const ticket of Object.values(run.tickets)) {
    const retriedTicket = resetRetryableInfrastructureAssignment(run, ticket.id, at);
    if (retriedTicket !== undefined) retried.push(retriedTicket);
  }
  return retried;
}

export function resetRetryableInfrastructureAssignment(
  run: RunRecord,
  ticketId: string,
  at: string,
  expected?: {
    failedAttemptId: string;
    ticketExecutionEpoch: number | undefined;
  },
): { ticketId: string; ticketTitle: string } | undefined {
  const ticket = run.tickets[ticketId];
  if (ticket?.status !== "blocked") return undefined;
  const step = ticket.steps.find((candidate) => candidate.status === "failed");
  const attemptId = step?.attemptIds.at(-1);
  const attempt = attemptId === undefined ? undefined : run.attempts[attemptId];
  if (
    step === undefined ||
    attempt === undefined ||
    (expected !== undefined &&
      (attemptId !== expected.failedAttemptId ||
        attemptTicketExecutionEpoch(run, ticket, attempt) !== expected.ticketExecutionEpoch ||
        (expected.ticketExecutionEpoch !== undefined &&
          currentTicketExecutionEpoch(run, ticket) !== expected.ticketExecutionEpoch))) ||
    !new Set<AttemptStatus>(["failed", "aborted"]).has(attempt.status) ||
    attempt.terminalAcceptedAt !== undefined ||
    attempt.terminalOutputSha256 !== undefined ||
    providerOutcomeAccountingIssue(attempt, undefined, false) !== undefined ||
    !isRetryableInfrastructureAttempt(attempt)
  )
    return undefined;
  step.status = "pending";
  step.startedAt = undefined;
  step.completedAt = undefined;
  step.summary = undefined;
  ticket.status = "queued";
  ticket.blocker = undefined;
  ticket.updatedAt = at;
  return { ticketId: ticket.id, ticketTitle: ticket.title };
}

export function isRetryableInfrastructureAttempt(attempt: AgentAttemptRecord): boolean {
  if (
    attempt.failureCode !== undefined &&
    new Set([
      "provider_admission",
      "provider_input_exposure",
      "provider_token_exposure",
      "provider_reservation",
      "provider_context",
      "session_persistence",
      "model_missing",
      "model_catalog_drift",
      "model_clamped",
      "provider_output_cap",
      "runtime_cleanup",
      // The Pi session reached a terminal turn without one authority-accepted submission. This is
      // retryable only at the explicit operator Resume boundary and only after the guards above
      // prove that no terminal effect or unsettled provider request exists. A rejected terminal call
      // (for example, after a contained check/runtime defect) must not strand the ticket forever.
      "terminal_protocol",
    ]).has(attempt.failureCode)
  )
    return true;
  const error = attempt.error ?? "";
  // Compatibility for attempts issued before failureCode became durable. These strings identify
  // Koni/Pi containment and admission failures, not a compiler-reviewed semantic outcome.
  return [
    /^(?:input|output|cache-read|cache-write|new-token|cache-inclusive) token budget (?:exceeded|exhausted)$/u,
    /input budget cannot reserve the prospective provider input/u,
    /prospective provider input plus reserved output exceeds the authenticated model context window/u,
    /authority tool result .* exceeds its .* launch bound/u,
    /simulated contained session cold-start timeout/u,
    // The supervisor's bounded provider-outcome watchdog is infrastructure containment, not an
    // agent-authored semantic failure. Once all provider turns are settled, a fresh attempt is
    // safe to issue through the ordinary retryable-assignment recovery path.
    /activated attempt exceeded the bounded provider outcome deadline/u,
    // Compatibility for a request watchdog that fired while an authority-backed question was
    // waiting. Current authorities defer that timer during `waiting_question`; already-settled
    // historical aborts remain safe to reissue at the explicit Resume boundary.
    /^Provider request exceeded the [0-9]+ms liveness boundary; aborting its contained Pi session$/u,
    // A provider-outcome watchdog can fail the attempt after the authority has already retired
    // its uncertain reservation. The caller above separately proves no provider exposure remains
    // before resetting the ticket, so this durable infrastructure outcome is safe to re-drive.
    /^Provider request remains reserved without a canonical assistant settlement; worst-case exposure is held$/u,
    /worker exited with code [0-9]+/u,
    // Provider-reservation containment: a request was reserved but its terminal never reconciled
    // (a transient upstream error or abort left the reservation held). This is Koni/Pi accounting
    // containment, not a compiler-reviewed semantic outcome. Once the exposure is retired (the
    // reset's providerOutcomeAccountingIssue guard proves no request stays open) the step is safe
    // to re-issue at the explicit operator Resume boundary.
    /provider request (?:remains reserved|cannot be reconciled|remains unsettled)/iu,
    // Sealed launch-binding mismatches (tool inventory/schema vs the issued spec) are pure harness
    // versioning skew — an attempt issued around an engine deploy — never agent work product. A
    // fresh attempt gets a consistent spec from the current authority.
    /does not (?:exactly )?match (?:its|the) launch (?:binding|inventory)/iu,
    // Compatibility for releases that settled a supervisor abort as an assignment failure during
    // ordinary authority shutdown. New authorities close outcome settlement before aborting, but
    // an explicit operator Resume may safely re-drive this exact historical infrastructure marker.
    /^authority stopping$/iu,
    // A Lead deadlock can suspend admission immediately before an approved change request is
    // scheduled. Older authorities persisted that admission rejection without its typed
    // `run_suspended` code; the caller's terminal/effect/accounting guards make it safe to reissue
    // only at the explicit operator Resume boundary.
    /^run [^\s]+ is paused$/u,
    // Older authorities persisted an unsafe recovery boundary as an untyped assignment failure.
    // The guards above prove that the failed attempt accepted no terminal effect and retains no
    // provider exposure; Resume therefore issues a fresh immutable attempt instead of continuing
    // or rewriting the suspect transcript.
    /^(?:Authenticated session recovery failed: )?Pi transcript does not end at a provably safe continuation boundary$/u,
  ].some((pattern) => pattern.test(error));
}

export function isTokenBudgetFailure(
  attempt: AgentAttemptRecord | undefined,
): attempt is AgentAttemptRecord {
  return (
    attempt !== undefined &&
    new Set<AttemptStatus>(["failed", "aborted"]).has(attempt.status) &&
    /^(?:input|output|cache-read|cache-write|new-token|cache-inclusive) token budget (?:exceeded|exhausted)$/u.test(
      attempt.error ?? "",
    )
  );
}

export function tokenBudgetRecoveryMessage(
  run: Readonly<RunRecord>,
  failed: Readonly<AgentAttemptRecord>,
): string {
  const ticketTitle = run.tickets[failed.ticketId]?.title ?? "ticket";
  return `Automatically retrying ${ticketTitle} step ${failed.stepId} after bounded token-budget recovery`;
}

export function tokenBudgetRecoveryCount(
  run: Readonly<RunRecord>,
  failed: Readonly<AgentAttemptRecord>,
  _recoveryMessage: string,
): number {
  return tokenBudgetRecoveryAuthorityCounts(run, failed).slice;
}

export function tokenBudgetRecoveryRecord(
  run: Readonly<RunRecord>,
  failed: Readonly<AgentAttemptRecord>,
  recoveredAt: string,
): NonNullable<AgentAttemptRecord["tokenBudgetRecovery"]> {
  const slice = tokenBudgetRecoverySliceForAttempt(run, failed);
  const material = {
    protocol: "koni.agent-token-budget-recovery.v1" as const,
    failedAttemptId: failed.id,
    ticketId: failed.ticketId,
    stepId: failed.stepId,
    ...(slice.ticketExecutionEpoch === undefined
      ? {}
      : { ticketExecutionEpoch: slice.ticketExecutionEpoch }),
    ...(slice.reviewReworkOrdinal === undefined
      ? {}
      : { reviewReworkOrdinal: slice.reviewReworkOrdinal }),
    recoveredAt,
  };
  return { ...material, sha256: canonicalHash(material) };
}

/**
 * Keep one failed provider lane from spending every later lane's bounded terminal recovery.
 *
 * A run can legitimately preserve terminal-protocol failures from earlier tickets and Lead
 * judgments. Counting those globally made the fourth unrelated failure permanently block a long
 * run. Count only the consecutive failures in the same immutable attempt lane, resetting after a
 * successful/non-terminal-protocol settlement. Ticket execution epochs keep an explicitly
 * reissued semantic slice independent from its predecessor when that identity is available.
 */
export function terminalProtocolRecoveryCount(
  run: Readonly<RunRecord>,
  failed: Readonly<AgentAttemptRecord>,
): number {
  if (run.planningSession?.attemptId === failed.id && failed.kind === "planning") {
    const recoveryMessage = terminalProtocolRecoveryMessage(run, failed);
    return (
      run.activity.filter((entry) => entry.message === recoveryMessage).length +
      (failed.status === "failed" && failed.failureCode === "terminal_protocol" ? 1 : 0)
    );
  }
  const lane = Object.values(run.attempts)
    .filter((attempt) => {
      if (
        attempt.kind !== failed.kind ||
        attempt.ticketId !== failed.ticketId ||
        attempt.stepId !== failed.stepId
      ) {
        return false;
      }
      if (
        failed.ticketExecutionEpoch !== undefined &&
        attempt.ticketExecutionEpoch !== undefined &&
        attempt.ticketExecutionEpoch !== failed.ticketExecutionEpoch
      ) {
        return false;
      }
      return true;
    })
    .sort(
      (left, right) =>
        (left.startedAt ?? left.endedAt ?? "").localeCompare(
          right.startedAt ?? right.endedAt ?? "",
        ) || left.id.localeCompare(right.id),
    );
  const failedIndex = lane.findIndex((attempt) => attempt.id === failed.id);
  if (failedIndex < 0) return 0;
  let count = 0;
  for (let index = failedIndex; index >= 0; index -= 1) {
    const attempt = lane[index]!;
    if (attempt.status !== "failed" || attempt.failureCode !== "terminal_protocol") break;
    count += 1;
  }
  return count;
}

export function terminalProtocolRecoveryMessage(
  run: Readonly<RunRecord>,
  failed: Readonly<AgentAttemptRecord>,
): string {
  if (run.planningSession?.attemptId === failed.id && failed.kind === "planning") {
    return `Auto-retrying an effect-free terminal-contract failure in planning revision ${run.planningSession.currentRevision} with the same authenticated session`;
  }
  return "Auto-retrying an effect-free terminal-contract failure with a fresh contained attempt";
}

/** A failed unassigned judgment must not revoke tools from an independent active worker. */
export function hasProviderCapableSiblingAttempt(
  run: Readonly<RunRecord>,
  failedAttemptId: string,
): boolean {
  return Object.values(run.attempts).some(
    (attempt) => attempt.id !== failedAttemptId && attempt.status === "running",
  );
}

/** A blocked Lead snapshot cannot revoke tools from work admitted concurrently against that board. */
export function shouldDeferBlockedLeadDisposition(
  run: Readonly<RunRecord>,
  leadAttemptId: string,
  disposition: "proceed" | "blocked",
): boolean {
  return disposition === "blocked" && hasProviderCapableSiblingAttempt(run, leadAttemptId);
}

export function isProviderAdmissionFailure(
  attempt: AgentAttemptRecord | undefined,
): attempt is AgentAttemptRecord {
  if (attempt === undefined || !new Set<AttemptStatus>(["failed", "aborted"]).has(attempt.status))
    return false;
  if (
    attempt.failureCode === "provider_input_exposure" ||
    attempt.failureCode === "provider_token_exposure"
  )
    return true;
  return /Koni provider admission rejected: request exceeds the context window/u.test(
    attempt.error ?? "",
  );
}

export function isProviderRateLimitErrorMessage(value: string): boolean {
  const message = value.trim();
  return /^429\b/u.test(message) && /["']?rate_limit_error["']?/u.test(message);
}

export function providerRateLimitRecoveryDelayMs(consecutiveRecoveries: number): number {
  const exponent = Number.isSafeInteger(consecutiveRecoveries)
    ? Math.max(0, Math.min(30, consecutiveRecoveries))
    : 0;
  return Math.min(
    MAX_PROVIDER_RATE_LIMIT_RECOVERY_DELAY_MS,
    MIN_PROVIDER_RATE_LIMIT_RECOVERY_DELAY_MS * 2 ** exponent,
  );
}

export type ProviderErrorRecoveryClass = "generic" | "rate_limit" | "zero_usage_transport";

export function providerErrorRecoveryClass(value: unknown): ProviderErrorRecoveryClass {
  if (!isRecord(value) || value.role !== "assistant" || value.stopReason !== "error") {
    return "generic";
  }
  if (
    typeof value.errorMessage === "string" &&
    isProviderRateLimitErrorMessage(value.errorMessage)
  ) {
    return "rate_limit";
  }
  const usage = value.usage;
  if (
    typeof value.errorMessage === "string" &&
    value.errorMessage.trim().length > 0 &&
    Array.isArray(value.content) &&
    value.content.length === 0 &&
    isRecord(usage) &&
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0
  ) {
    return "zero_usage_transport";
  }
  return "generic";
}

export function providerZeroUsageTransportRecoveryDelayMs(
  consecutiveExtendedRecoveries: number,
): number {
  const exponent = Number.isSafeInteger(consecutiveExtendedRecoveries)
    ? Math.max(0, Math.min(30, consecutiveExtendedRecoveries))
    : 0;
  return Math.min(
    MAX_PROVIDER_ZERO_USAGE_TRANSPORT_RECOVERY_DELAY_MS,
    MIN_PROVIDER_ZERO_USAGE_TRANSPORT_RECOVERY_DELAY_MS * 2 ** exponent,
  );
}

export function providerExposureRecoveryPolicy(
  recoveryClasses: readonly ProviderErrorRecoveryClass[],
  alreadyRetired: number,
): { recoveryLimit: number; delayMs?: number } {
  const rateLimited = recoveryClasses.some((value) => value === "rate_limit");
  if (rateLimited) {
    return {
      recoveryLimit: MAX_PROVIDER_RATE_LIMIT_AUTO_RECOVERIES,
      delayMs: providerRateLimitRecoveryDelayMs(alreadyRetired),
    };
  }
  const zeroUsageTransport =
    recoveryClasses.length > 0 &&
    recoveryClasses.every((value) => value === "zero_usage_transport");
  if (!zeroUsageTransport) return { recoveryLimit: MAX_PROVIDER_EXPOSURE_AUTO_RECOVERIES };
  return {
    recoveryLimit: MAX_PROVIDER_ZERO_USAGE_TRANSPORT_AUTO_RECOVERIES,
    ...(alreadyRetired < MAX_PROVIDER_EXPOSURE_AUTO_RECOVERIES
      ? {}
      : {
          delayMs: providerZeroUsageTransportRecoveryDelayMs(
            alreadyRetired - MAX_PROVIDER_EXPOSURE_AUTO_RECOVERIES,
          ),
        }),
  };
}

export async function attemptCanonicalProviderErrorRecoveryClass(
  spec: Readonly<AgentLaunchSpec>,
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
): Promise<ProviderErrorRecoveryClass> {
  const baselineEntryId = attempt.authorityProviderRequests?.at(-1)?.baselineEntryId;
  if (baselineEntryId === undefined) return "generic";
  try {
    const transcript = await readDurableAttemptTranscript(spec, run, attempt, {
      allowCommittedResponseTail: true,
    });
    const baselineIndex = transcript.entries.findIndex((entry) => entry.id === baselineEntryId);
    if (baselineIndex < 0) return "generic";
    const assistant = transcript.entries
      .slice(baselineIndex + 1)
      .filter(
        (entry) =>
          entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant",
      )
      .at(-1);
    return providerErrorRecoveryClass(assistant?.message);
  } catch {
    return "generic";
  }
}

export function isRetiredProviderError(attempt: AgentAttemptRecord): boolean {
  return (
    attempt.status === "failed" &&
    attempt.authorityProviderRequests?.at(-1)?.retirement?.disposition ===
      "operator_acknowledged_provider_error"
  );
}

export interface SettledProviderRequest {
  record: AgentProviderRequestRecord;
  assistantEntryId: string;
  assistantEntrySha256: Sha256Digest;
  usage: KoniAttemptUsage;
  alreadySettled: boolean;
}

export function validateProviderReservationForSpec(
  spec: Readonly<AgentLaunchSpec>,
  request: KoniProviderRequestReservationInput,
): void {
  let expectedProspective: number;
  try {
    expectedProspective = estimateProviderInputTokens(request.payloadSizeBytes);
  } catch {
    throw new AuthorityRpcError(
      "provider_reservation",
      "provider reservation does not match its immutable launch and payload bounds",
    );
  }
  if (
    !Number.isSafeInteger(request.sequence) ||
    request.sequence < 1 ||
    request.api !== spec.model.api ||
    request.modelId !== spec.model.id ||
    !isSha256Digest(request.payloadSha256) ||
    !Number.isSafeInteger(request.payloadSizeBytes) ||
    request.payloadSizeBytes < 1 ||
    request.payloadSizeBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(expectedProspective) ||
    request.prospectiveInputTokens !== expectedProspective ||
    !Number.isSafeInteger(request.reservedOutputTokens) ||
    request.reservedOutputTokens < 1 ||
    request.reservedOutputTokens > spec.model.catalogMaxTokens
  ) {
    throw new AuthorityRpcError(
      "provider_reservation",
      "provider reservation does not match its immutable launch and payload bounds",
    );
  }
  const cap = request.serializedOutputCap;
  if (cap !== undefined) {
    if (
      spec.model.api === "openai-codex-responses" ||
      !isSupportedProviderOutputCap(spec.model.api, cap) ||
      cap.value !== request.reservedOutputTokens
    ) {
      throw new AuthorityRpcError(
        "provider_output_cap",
        "serialized provider output cap is not supported by the bound Pi API",
      );
    }
  } else if (
    providerApiHasSupportedOutputCap(spec.model.api) ||
    request.reservedOutputTokens !== spec.model.catalogMaxTokens
  ) {
    throw new AuthorityRpcError(
      "provider_output_cap",
      "an uncapped provider request must reserve the authenticated catalog maximum",
    );
  }
}

export function assertProviderExposureBudget(
  spec: Readonly<AgentLaunchSpec>,
  attempt: AgentAttemptRecord,
  request: KoniProviderRequestReservationInput,
): void {
  const maximum = spec.budgets.tokens;
  const budgetUsage = planningTokenUsageFromBaseline(
    attempt,
    spec.planningRevision?.budgetBaseline,
  );
  if (request.reservedOutputTokens > maximum.providerOutputHeadroom) {
    throw new AuthorityRpcError(
      "provider_output_exposure",
      "provider request exceeds its compiler-issued in-flight output headroom",
    );
  }
  // v1 launch specs issued before Koni sealed Pi's contextWindow authenticated only the
  // compiler's explicit input target and model output maximum. Preserve that exact historical
  // admission boundary for resumability. Every new launch carries catalogContextWindow and uses
  // the stronger provider-total capacity check.
  const providerContextWindow = spec.model.catalogContextWindow;
  const hasSupportedOutputCap = providerApiHasSupportedOutputCap(spec.model.api);
  const providerInputHeadroom =
    providerContextWindow === undefined
      ? maximum.maxInput
      : providerContextWindow -
        request.reservedOutputTokens -
        (hasSupportedOutputCap ? 0 : UNCAPPED_PROVIDER_CONTEXT_FRAMING_RESERVE);
  // An uncapped transport must reserve the model's full advertised output maximum even though
  // input and output consume one shared context window. Do not reject a plausible input merely by
  // adding two maxima that the provider cannot realize simultaneously. The provider still binds
  // the exact shared context ceiling, while the authority reserves the smaller input allocation
  // beside the full output hold. Gross payloads that cannot fit even with zero output remain
  // provider-free failures.
  const uncappedSharedContextInputLimit =
    providerContextWindow === undefined || hasSupportedOutputCap
      ? undefined
      : providerContextWindow - UNCAPPED_PROVIDER_CONTEXT_FRAMING_RESERVE;
  const providerInputAdmissionLimit = uncappedSharedContextInputLimit ?? providerInputHeadroom;
  if (providerInputHeadroom < 1 || request.prospectiveInputTokens > providerInputAdmissionLimit) {
    throw new AuthorityRpcError(
      "provider_input_exposure",
      "prospective provider input plus reserved output exceeds the authenticated model context window",
    );
  }
  const reservedInputExposure =
    uncappedSharedContextInputLimit === undefined
      ? request.prospectiveInputTokens
      : Math.min(request.prospectiveInputTokens, providerInputHeadroom);
  const componentChecks: Array<[number, number, string]> = [
    [budgetUsage.inputTokens, maximum.maxInput, "input"],
    [budgetUsage.cacheReadTokens, maximum.maxCacheRead, "cache-read"],
    [budgetUsage.cacheWriteTokens, maximum.maxCacheWrite, "cache-write"],
  ];
  for (const [used, limit, label] of componentChecks) {
    // Settled provider usage is exact; the next request's serialized byte upper bound is not a
    // prediction of how the provider will divide input, cache-read, and cache-write tokens. Stop
    // at the desired component target, while the authenticated context window above provides the
    // hard in-flight input exposure ceiling.
    if (used >= limit) {
      throw new AuthorityRpcError(
        "provider_token_exhausted",
        `settled ${label} usage reached its compiler-issued stop target`,
      );
    }
  }
  const newTokens = checkedProviderSum(budgetUsage.inputTokens, budgetUsage.outputTokens);
  const allTokens = checkedProviderSum(
    newTokens,
    budgetUsage.cacheReadTokens,
    budgetUsage.cacheWriteTokens,
  );
  if (
    budgetUsage.outputTokens >= maximum.maxOutput ||
    newTokens >= maximum.maxNew ||
    allTokens >= maximum.maxAll
  ) {
    throw new AuthorityRpcError(
      "provider_token_exhausted",
      "settled provider usage reached a desired stop target; headroom cannot fund another request",
    );
  }
  const hardOutput = checkedProviderSum(maximum.maxOutput, maximum.providerOutputHeadroom);
  const hardNew = checkedProviderSum(
    maximum.maxNew,
    providerInputHeadroom,
    maximum.providerOutputHeadroom,
  );
  const hardAll = checkedProviderSum(
    maximum.maxAll,
    providerInputHeadroom,
    maximum.providerOutputHeadroom,
  );
  if (
    checkedProviderSum(budgetUsage.outputTokens, request.reservedOutputTokens) > hardOutput ||
    checkedProviderSum(newTokens, reservedInputExposure, request.reservedOutputTokens) > hardNew ||
    checkedProviderSum(allTokens, reservedInputExposure, request.reservedOutputTokens) > hardAll
  ) {
    throw new AuthorityRpcError(
      "provider_token_exposure",
      "provider input plus worst-case output exceeds the context window reserved by the compiler-issued hard exposure ceiling",
    );
  }
}

export async function readDurableAttemptTranscript(
  spec: Readonly<AgentLaunchSpec>,
  run: Readonly<RunRecord>,
  attempt: AgentAttemptRecord,
  options: { allowCommittedResponseTail?: boolean } = {},
): Promise<ParsedPiSession> {
  const expected = path.join(spec.workspace.sessionDirectory, `${spec.identity.sessionId}.jsonl`);
  if (
    attempt.sessionFile === undefined ||
    path.resolve(attempt.sessionFile) !== path.resolve(expected)
  ) {
    throw new AuthorityRpcError(
      "provider_transcript_path",
      "attempt session path does not match its immutable launch binding",
    );
  }
  let parsed: ParsedPiSession;
  try {
    parsed = await readPiSessionDurably(expected, {
      maxBytes:
        spec.budgets.transcript.maxBytes +
        (options.allowCommittedResponseTail === true
          ? MAX_PROVIDER_RESPONSE_TRANSCRIPT_OVERSHOOT_BYTES
          : 0),
      allowTruncatedTail: options.allowCommittedResponseTail === true,
    });
  } catch (error) {
    throw new AuthorityRpcError(
      "provider_transcript",
      `Pi transcript could not be durably authenticated: ${errorMessage(error)}`,
    );
  }
  if (
    parsed.diagnostics.some(
      (diagnostic) =>
        diagnostic.code !== "truncated_tail" || options.allowCommittedResponseTail !== true,
    ) ||
    parsed.header.id !== spec.identity.sessionId ||
    parsed.header.cwd !== spec.workspace.cwd
  ) {
    throw new AuthorityRpcError(
      "provider_transcript_header",
      "Pi transcript header or commit boundary does not match the launch specification",
    );
  }
  let expectedParent: string | null = null;
  for (const entry of parsed.entries) {
    if (entry.parentId !== expectedParent) {
      throw new AuthorityRpcError(
        "provider_transcript_branch",
        "contained Pi provider transcript is not one linear parent chain",
      );
    }
    expectedParent = entry.id;
  }
  assertProviderTranscriptMapping(spec, run, attempt, expected, parsed);
  return parsed;
}

export function assertProviderTranscriptMapping(
  spec: Readonly<AgentLaunchSpec>,
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
  sessionFile: string,
  parsed: Readonly<ParsedPiSession>,
): void {
  const planning = spec.planningRevision;
  if (planning === undefined || planning.revision === 0) {
    const mappings = parsed.entries.filter(
      (entry) => entry.type === "custom" && entry.customType === "koni.attempt-session-map",
    );
    const mapping = mappings[0]?.data;
    const expectedMapping = providerAttemptSessionMapping(spec, sessionFile);
    if (
      mappings.length !== 1 ||
      !isRecord(mapping) ||
      !canonicalValuesEqual(mapping, expectedMapping)
    ) {
      throw new AuthorityRpcError(
        "provider_transcript_mapping",
        "Pi transcript attempt mapping does not exactly match the immutable launch specification",
      );
    }
    return;
  }

  const session = run.planningSession;
  const revision = session?.revisions[planning.revision];
  const prior = session?.revisions[planning.revision - 1];
  const attemptMappings = parsed.entries.filter(
    (entry) => entry.type === "custom" && entry.customType === "koni.attempt-session-map",
  );
  const initialMapping = attemptMappings[0]?.data;
  const revisionMaps = parsed.entries.flatMap((entry, index) =>
    entry.type === "custom" &&
    entry.customType === "koni.planning-revision-map" &&
    isRecord(entry.data)
      ? [{ data: entry.data, index }]
      : [],
  );
  const currentMap = revisionMaps.at(-1);
  const expectedCurrentMap = {
    protocol: "koni.planning-revision-map.v1",
    specHash: spec.specHash,
    runId: spec.identity.runId,
    attemptId: spec.identity.attemptId,
    sessionId: spec.identity.sessionId,
    grantId: spec.authority.grantId,
    grantHash: spec.authority.grantHash,
    revision: planning.revision,
    baseRevision: planning.baseRevision,
    priorCheckpointSha256: planning.priorCheckpointSha256,
    priorTranscriptSha256: prior?.transcriptSha256,
    steeringSha256: planning.steeringSha256,
    budgetBaseline: planning.budgetBaseline,
  };
  const initialRevision = session?.revisions[0];
  const stableInitialMapping =
    attemptMappings.length === 1 &&
    isRecord(initialMapping) &&
    initialMapping.protocol === "koni.attempt-session-map.v1" &&
    initialMapping.specHash === attempt.launchSpecHash &&
    initialMapping.runId === spec.identity.runId &&
    initialMapping.ticketId === spec.identity.ticketId &&
    initialMapping.stepId === spec.identity.stepId &&
    initialMapping.attemptId === spec.identity.attemptId &&
    initialMapping.sessionId === spec.identity.sessionId &&
    initialMapping.grantHash === initialRevision?.grantSha256 &&
    initialMapping.sessionFile === sessionFile;
  const contiguousMaps =
    revisionMaps.length === planning.revision &&
    revisionMaps.every(({ data }, index) => data.revision === index + 1);
  const priorPrefixHash =
    currentMap === undefined
      ? undefined
      : canonicalHash({
          header: parsed.header,
          entries: parsed.entries.slice(0, currentMap.index),
        });
  if (
    session?.attemptId !== spec.identity.attemptId ||
    session?.sessionId !== spec.identity.sessionId ||
    session?.currentRevision !== planning.revision ||
    revision?.launchSpecSha256 !== spec.specHash ||
    revision?.grantSha256 !== spec.authority.grantHash ||
    prior?.transcriptSha256 === undefined ||
    !stableInitialMapping ||
    !contiguousMaps ||
    currentMap === undefined ||
    !canonicalValuesEqual(currentMap.data, expectedCurrentMap) ||
    priorPrefixHash !== prior.transcriptSha256
  ) {
    throw new AuthorityRpcError(
      "provider_transcript_mapping",
      "Pi transcript planning revision map does not match the current immutable revision binding",
    );
  }
}

export async function settleProviderRequestFromTranscript(
  spec: Readonly<AgentLaunchSpec>,
  run: Readonly<RunRecord>,
  attempt: AgentAttemptRecord,
  expected?: KoniProviderRequestSettlementInput,
): Promise<SettledProviderRequest> {
  const records = attempt.authorityProviderRequests ?? [];
  const record =
    expected === undefined
      ? records.at(-1)
      : records.find((candidate) => candidate.sequence === expected.sequence);
  if (record === undefined) {
    throw new AuthorityRpcError("provider_settlement", "provider reservation does not exist");
  }
  if (expected !== undefined && record.reservationId !== expected.reservationId) {
    throw new AuthorityRpcError("provider_settlement", "provider reservation identity changed");
  }
  if (record.settledAt !== undefined) {
    const settled = settledProviderRecord(record);
    if (expected !== undefined) assertExpectedProviderSettlement(expected, settled);
    return { record, ...settled, alreadySettled: true };
  }
  if (records.at(-1) !== record) {
    throw new AuthorityRpcError(
      "provider_settlement",
      "only the final provider reservation may be unsettled",
    );
  }
  const transcript = await readDurableAttemptTranscript(spec, run, attempt, {
    allowCommittedResponseTail: true,
  });
  let derived: ReturnType<typeof deriveProviderSettlement>;
  try {
    derived = deriveProviderSettlement(transcript.entries, record.baselineEntryId);
  } catch (error) {
    throw new AuthorityRpcError(
      "provider_settlement_transcript",
      `Pi provider response cannot be uniquely reconciled: ${errorMessage(error)}`,
    );
  }
  if (derived === undefined) {
    throw new AuthorityRpcError(
      "provider_settlement_pending",
      "provider reservation has no committed canonical assistant response",
    );
  }
  const assistant = transcript.byId.get(derived.assistantEntryId);
  const message = assistant?.message;
  if (
    assistant?.type !== "message" ||
    !isRecord(message) ||
    message.role !== "assistant" ||
    message.api !== spec.model.api ||
    message.provider !== spec.model.provider ||
    message.model !== spec.model.id
  ) {
    throw new AuthorityRpcError(
      "provider_settlement_model",
      "canonical Pi assistant entry does not match the compiler-issued model binding",
    );
  }
  if (
    checkedProviderSum(derived.usage.input, derived.usage.cacheRead, derived.usage.cacheWrite) >
      record.prospectiveInputTokens ||
    derived.usage.output > record.reservedOutputTokens
  ) {
    throw new AuthorityRpcError(
      "provider_settlement_exposure",
      "canonical Pi assistant usage exceeds its durable request reservation",
    );
  }
  const settled = {
    assistantEntryId: derived.assistantEntryId,
    assistantEntrySha256: derived.assistantEntrySha256,
    usage: derived.usage,
  };
  if (expected !== undefined) assertExpectedProviderSettlement(expected, settled);
  return { record, ...settled, alreadySettled: false };
}

export async function deriveCanonicalProviderExposureRetirement(
  spec: Readonly<AgentLaunchSpec>,
  run: Readonly<RunRecord>,
  attempt: AgentAttemptRecord,
  authorizationSha256: Sha256Digest,
  retiredAt: string,
): Promise<NonNullable<AgentProviderRequestRecord["retirement"]> | undefined> {
  const record = attempt.authorityProviderRequests?.at(-1);
  if (record === undefined || !isOpenProviderRequest(record)) return undefined;
  const authorityPauseRetirement = ():
    NonNullable<AgentProviderRequestRecord["retirement"]> | undefined => {
    if (attempt.status !== "interrupted" || attempt.error !== "Run paused") return undefined;
    const material = {
      protocol: "koni.provider-exposure-retirement.v1" as const,
      disposition: "operator_acknowledged_authority_pause" as const,
      pauseReasonSha256: rawSha256(attempt.error),
      authorizationSha256,
      retiredAt,
    };
    return { ...material, sha256: canonicalHash(material) };
  };
  // The authority itself has stopped this attempt, so a successor cannot overlap it. Provider
  // usage remains unknowable and is retained as worst-case exposure, but a synthetic assistant
  // terminal must not be required after a normal authority restart. Prefer a canonical terminal
  // when one exists, however: it is stronger evidence and carries the provider response identity.
  let transcript: Awaited<ReturnType<typeof readDurableAttemptTranscript>>;
  try {
    transcript = await readDurableAttemptTranscript(spec, run, attempt, {
      allowCommittedResponseTail: true,
    });
  } catch (error) {
    const pause = authorityPauseRetirement();
    if (pause !== undefined) return pause;
    throw error;
  }
  const baselineIndex = transcript.entries.findIndex(
    (entry) => entry.id === record.baselineEntryId,
  );
  if (baselineIndex < 0) return authorityPauseRetirement();
  const suffix = transcript.entries.slice(baselineIndex + 1);
  const assistants = suffix.filter(
    (entry) =>
      entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant",
  );
  // A contained session can terminate after Koni reserved a request but before Pi persisted any
  // canonical assistant terminal. The durable transcript must prove that absence; this prevents
  // the fallback from shadowing a canonical provider error that remains reconcilable.
  if (
    assistants.length === 0 &&
    new Set<AttemptStatus>(["failed", "aborted"]).has(attempt.status) &&
    attempt.error !== undefined &&
    isProviderExposureHoldBlocker(attempt.error) &&
    attempt.terminalAcceptedAt == null &&
    attempt.terminalOutputSha256 == null &&
    record.assistantEntryId == null
  ) {
    const material = {
      protocol: "koni.provider-exposure-retirement.v1" as const,
      disposition: "operator_acknowledged_unreconciled_request" as const,
      failureReasonSha256: rawSha256(attempt.error),
      authorizationSha256,
      retiredAt,
    };
    return { ...material, sha256: canonicalHash(material) };
  }
  // A tool result can be durably recorded before Pi appends its canonical abort/error terminal
  // for the same provider request. The final assistant entry is the accounting boundary; earlier
  // assistant entries remain auditable attempt history and do not make that terminal ambiguous.
  const assistant = assistants.at(-1);
  if (assistant === undefined || suffix.at(-1)?.id !== assistant.id) {
    return authorityPauseRetirement();
  }
  const message = assistant.message;
  if (!isRecord(message) || !isRecord(message.usage)) return authorityPauseRetirement();
  const usageIsZero =
    Number(message.usage.input) === 0 &&
    Number(message.usage.output) === 0 &&
    Number(message.usage.cacheRead) === 0 &&
    Number(message.usage.cacheWrite) === 0;
  const declaredResponseId =
    typeof message.responseId === "string" &&
    message.responseId.length > 0 &&
    message.responseId.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(message.responseId)
      ? message.responseId
      : undefined;
  // A zero-usage error or abort terminal is provably unbilled with nothing to reconcile, and any
  // provider can emit one without a response id (seen with an OpenAI-style abort and, separately, an
  // Anthropic-style api_error; both reported all-zero usage and no responseId, which otherwise
  // wedged the run with an unreconcilable held reservation and no recovery action). This branch is
  // provider-agnostic — it keys only on the normalized stop reason and zero usage, not on any
  // provider identity. Fall back to the durable assistant entry id (always present, unique,
  // idempotent) so the terminal can still be retired and retried.
  const responseId =
    declaredResponseId ??
    (usageIsZero &&
    (message.stopReason === "error" || message.stopReason === "aborted") &&
    typeof assistant.id === "string" &&
    assistant.id.length > 0 &&
    assistant.id.length <= 512
      ? assistant.id
      : undefined);
  // Codex zeroes usage on abort/error terminals; anthropic-style adapters report the prompt
  // tokens the interrupted request actually consumed (observed live: a paused Claude planner
  // recorded 49K prompt tokens with "This operation was aborted"). Partial usage is equally
  // uncertain either way — retirement retains the full worst-case reservation — so usage does
  // not gate the boundary, and abort wording varies by adapter.
  const commonTerminalBoundary =
    message.api === spec.model.api &&
    message.provider === spec.model.provider &&
    message.model === spec.model.id &&
    responseId !== undefined;
  const canonicalAbort = commonTerminalBoundary && message.stopReason === "aborted";
  const errorMessage =
    typeof message.errorMessage === "string" &&
    message.errorMessage.length > 0 &&
    Buffer.byteLength(message.errorMessage, "utf8") <= 4_096 &&
    !/[\u0000\u007f]/u.test(message.errorMessage)
      ? message.errorMessage
      : undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  const terminalToolCalls = content.filter((item) => isRecord(item) && item.type === "toolCall");
  const terminalToolCallIds = terminalToolCalls.map((item) => item.id);
  const issuedToolNames = new Set(spec.tools.map((tool) => tool.name));
  const terminalToolCallsAreDurablyInert =
    terminalToolCalls.every(
      (item) =>
        typeof item.id === "string" &&
        item.id.length > 0 &&
        Buffer.byteLength(item.id, "utf8") <= 2_048 &&
        typeof item.name === "string" &&
        issuedToolNames.has(item.name) &&
        isRecord(item.arguments) &&
        providerTerminalToolCallIsDurablyInert(run, attempt, item.id),
    ) && new Set(terminalToolCallIds).size === terminalToolCallIds.length;
  const canonicalProviderError =
    commonTerminalBoundary &&
    message.stopReason === "error" &&
    errorMessage !== undefined &&
    content.every(
      (item) =>
        isRecord(item) &&
        (item.type === "thinking" || item.type === "text" || item.type === "toolCall"),
    ) &&
    terminalToolCallsAreDurablyInert;
  if (!canonicalAbort && !canonicalProviderError) return authorityPauseRetirement();
  const material = {
    protocol: "koni.provider-exposure-retirement.v1" as const,
    disposition: canonicalProviderError
      ? ("operator_acknowledged_provider_error" as const)
      : ("operator_acknowledged_canonical_abort" as const),
    assistantEntryId: assistant.id,
    assistantEntrySha256: canonicalHash(assistant),
    responseId,
    ...(canonicalProviderError ? { errorMessageSha256: rawSha256(errorMessage) } : {}),
    authorizationSha256,
    retiredAt,
  };
  return { ...material, sha256: canonicalHash(material) };
}

export function providerTerminalToolCallIsDurablyInert(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
  callId: string,
): boolean {
  return (
    !(attempt.authorityToolResults ?? []).some((result) => result.callId === callId) &&
    !Object.values(run.pendingEffects ?? {}).some(
      (effect) => effect.attemptId === attempt.id && effect.callId === callId,
    ) &&
    !Object.values(run.pendingChecks ?? {}).some(
      (check) => check.attemptId === attempt.id && check.callId === callId,
    ) &&
    !(run.checks ?? []).some((check) => check.attemptId === attempt.id && check.callId === callId)
  );
}

export function settledProviderRecord(record: AgentProviderRequestRecord): {
  assistantEntryId: string;
  assistantEntrySha256: Sha256Digest;
  usage: KoniAttemptUsage;
} {
  if (
    record.assistantEntryId === undefined ||
    record.assistantEntrySha256 === undefined ||
    record.inputTokens === undefined ||
    record.outputTokens === undefined ||
    record.cacheReadTokens === undefined ||
    record.cacheWriteTokens === undefined
  ) {
    throw new AuthorityRpcError(
      "provider_settlement",
      "provider settlement is only partially durable",
    );
  }
  return {
    assistantEntryId: record.assistantEntryId,
    assistantEntrySha256: record.assistantEntrySha256,
    usage: providerUsage(
      record.inputTokens,
      record.outputTokens,
      record.cacheReadTokens,
      record.cacheWriteTokens,
    ),
  };
}

export function assertExpectedProviderSettlement(
  expected: KoniProviderRequestSettlementInput,
  actual: {
    assistantEntryId: string;
    assistantEntrySha256: Sha256Digest;
    usage: KoniAttemptUsage;
  },
): void {
  if (
    expected.assistantEntryId !== actual.assistantEntryId ||
    expected.assistantEntrySha256 !== actual.assistantEntrySha256 ||
    !canonicalValuesEqual(expected.usage, actual.usage)
  ) {
    throw new AuthorityRpcError(
      "provider_settlement_mismatch",
      "runtime settlement projection differs from canonical Pi transcript evidence",
    );
  }
}

export function applyProviderSettlement(
  attempt: AgentAttemptRecord,
  settled: SettledProviderRequest,
  at: string,
): void {
  const record = attempt.authorityProviderRequests?.find(
    (candidate) => candidate.sequence === settled.record.sequence,
  );
  if (
    record === undefined ||
    record.reservationId !== settled.record.reservationId ||
    record.settledAt !== undefined ||
    settled.alreadySettled
  ) {
    throw new AuthorityRpcError(
      "provider_settlement",
      "provider reservation changed before settlement commit",
    );
  }
  record.assistantEntryId = settled.assistantEntryId;
  record.assistantEntrySha256 = settled.assistantEntrySha256;
  record.inputTokens = settled.usage.input;
  record.outputTokens = settled.usage.output;
  record.cacheReadTokens = settled.usage.cacheRead;
  record.cacheWriteTokens = settled.usage.cacheWrite;
  record.settledAt = at;
  attempt.inputTokens = checkedProviderSum(attempt.inputTokens, settled.usage.input);
  attempt.outputTokens = checkedProviderSum(attempt.outputTokens, settled.usage.output);
  attempt.cacheReadTokens = checkedProviderSum(attempt.cacheReadTokens, settled.usage.cacheRead);
  attempt.cacheWriteTokens = checkedProviderSum(attempt.cacheWriteTokens, settled.usage.cacheWrite);
}

export function providerSettlementResponse(
  settled: SettledProviderRequest,
): KoniProviderRequestSettlement {
  return {
    protocol: "koni.provider-request-settlement.v1",
    sequence: settled.record.sequence,
    reservationId: settled.record.reservationId,
    assistantEntryId: settled.assistantEntryId,
    assistantEntrySha256: settled.assistantEntrySha256,
    usage: structuredClone(settled.usage),
  };
}

export function providerRequestRecoveryRecord(record: AgentProviderRequestRecord) {
  const base = {
    sequence: record.sequence,
    reservationId: record.reservationId,
    api: record.api,
    modelId: record.modelId,
    payloadSha256: record.payloadSha256,
    payloadSizeBytes: record.payloadSizeBytes,
    prospectiveInputTokens: record.prospectiveInputTokens,
    reservedOutputTokens: record.reservedOutputTokens,
    ...(record.serializedOutputCap === undefined
      ? {}
      : { serializedOutputCap: structuredClone(record.serializedOutputCap) }),
    baselineEntryId: record.baselineEntryId,
  };
  if (record.retirement !== undefined) {
    return { ...base, retirement: structuredClone(record.retirement) };
  }
  if (record.settledAt === undefined) return base;
  const settled = settledProviderRecord(record);
  return {
    ...base,
    settlement: {
      assistantEntryId: settled.assistantEntryId,
      assistantEntrySha256: settled.assistantEntrySha256,
      usage: structuredClone(settled.usage),
    },
  };
}

export function providerAttemptSessionMapping(
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

export function providerUsage(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): KoniAttemptUsage {
  const newTokens = checkedProviderSum(input, output);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    newTokens,
    allTokens: checkedProviderSum(newTokens, cacheRead, cacheWrite),
  };
}

export function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalHash(left) === canonicalHash(right);
  } catch {
    return false;
  }
}

export function finishAttemptRecord(
  attempt: AgentAttemptRecord,
  outcome: Extract<ManagedSessionOutcome, { status: "completed" }>,
  at: string,
  summary: string,
): void {
  attempt.status = "completed";
  attempt.endedAt = at;
  attempt.terminalSummary = summary;
  if (attempt.authorityProviderRequests === undefined) applyUsage(attempt, outcome.usage);
}

export function providerOutcomeAccountingIssue(
  attempt: AgentAttemptRecord,
  usage: ManagedSessionOutcome["usage"] | undefined,
  requireOutcomeProjection = true,
): string | undefined {
  const requests = attempt.authorityProviderRequests;
  if (requests === undefined) return undefined;
  if (requests.some(isOpenProviderRequest)) {
    return "Provider request remains reserved without a canonical assistant settlement; worst-case exposure is held";
  }
  if (usage === undefined) {
    return !requireOutcomeProjection ||
      (requests.length === 0 &&
        attempt.inputTokens === 0 &&
        attempt.outputTokens === 0 &&
        attempt.cacheReadTokens === 0 &&
        attempt.cacheWriteTokens === 0)
      ? undefined
      : "Attempt ended without an exact final provider-usage projection";
  }
  if (!requireOutcomeProjection) return undefined;
  let newTokens: number;
  let allTokens: number;
  try {
    newTokens = checkedProviderSum(attempt.inputTokens, attempt.outputTokens);
    allTokens = checkedProviderSum(newTokens, attempt.cacheReadTokens, attempt.cacheWriteTokens);
  } catch (error) {
    return errorMessage(error);
  }
  if (
    usage.input !== attempt.inputTokens ||
    usage.output !== attempt.outputTokens ||
    usage.cacheRead !== attempt.cacheReadTokens ||
    usage.cacheWrite !== attempt.cacheWriteTokens ||
    usage.newTokens !== newTokens ||
    usage.allTokens !== allTokens
  ) {
    return "Attempt outcome usage differs from authority-settled canonical Pi transcript totals";
  }
  return undefined;
}

export function hasUnsettledProviderRequest(attempt: AgentAttemptRecord): boolean {
  const final = attempt.authorityProviderRequests?.at(-1);
  return final !== undefined && isOpenProviderRequest(final);
}

/**
 * Compose the provider's own reported cause with the accounting consequence. Callers that match on
 * the accounting text keep working: the consequence stays a prefix, so both the substring check in
 * `isProviderExposureHoldBlocker` and the unanchored retryable-infrastructure pattern still hit.
 */
export function withProviderCause(accountingIssue: string | undefined, error: string): string {
  if (accountingIssue === undefined) return error;
  const cause = error.trim();
  if (cause.length === 0 || accountingIssue.includes(cause)) return accountingIssue;
  return `${accountingIssue}; provider reported: ${cause}`;
}

export function isOpenProviderRequest(record: AgentProviderRequestRecord): boolean {
  return record.settledAt === undefined && record.retirement === undefined;
}

export function isProviderPredecessor(status: AgentAttemptRecord["status"]): boolean {
  return status === "terminal_accepted" || isTerminalAttempt(status);
}

export function applyUsage(
  attempt: AgentAttemptRecord,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): void {
  attempt.inputTokens = usage.input;
  attempt.outputTokens = usage.output;
  attempt.cacheReadTokens = usage.cacheRead;
  attempt.cacheWriteTokens = usage.cacheWrite;
}

export function isTerminalAttempt(status: AgentAttemptRecord["status"]): boolean {
  return new Set(["completed", "failed", "aborted", "interrupted"]).has(status);
}
