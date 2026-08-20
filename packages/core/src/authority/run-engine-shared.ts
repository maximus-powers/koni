import type { ActionExecutionJournal, CompiledActionDefinition } from "../contracts/behavior.js";
import { AuthorityRpcError } from "./server.js";

import type {
  AgentAttemptRecord,
  AgentProviderTokenTotals,
  RunRecord,
  TicketRecord,
} from "../state/run-record.js";
import { type ReadyAssignment } from "../state/scheduler.js";

import { SETTLED_PRE_SEMANTIC_VALIDATION_REISSUE_ACTIVITY } from "./run-engine-contracts.js";

/**
 * True when a compensated journal's own recovery step attests that configured compensation
 * preserved the exact pre-semantic state. Effect receipts for idempotent recipe primitives
 * (locks, validations) legitimately remain; the attested disposition is the safety boundary
 * for retiring the accepted attempt and reissuing the step.
 */
/**
 * How many times this step's accepted output has already been retired after validation proved
 * that pre-semantic state was preserved. This single budget covers both in-journal compensation
 * and a separately configured recovery action. Once spent, the rejection has survived three
 * independent attempts and the run stops rather than churning provider work indefinitely.
 */
export function preSemanticValidationReissueCount(
  run: Readonly<RunRecord>,
  ticketId: string,
  stepId: string,
): number {
  const interruptedAttempts = Object.values(run.attempts).filter(
    (candidate) =>
      candidate.ticketId === ticketId &&
      candidate.stepId === stepId &&
      candidate.status === "interrupted" &&
      (candidate.terminalSummary?.startsWith(
        "Retired accepted output after a compensated validation",
      ) === true ||
        candidate.terminalSummary?.startsWith(
          "Retired accepted output after configured recovery preserved pre-semantic state",
        ) === true),
  ).length;
  const settledRecoveryResumes = run.activity.filter(
    (entry) =>
      entry.kind === "compiler" &&
      entry.ticketId === ticketId &&
      entry.message ===
        `${SETTLED_PRE_SEMANTIC_VALIDATION_REISSUE_ACTIVITY}: ${ticketId}/${stepId}`,
  ).length;
  return interruptedAttempts + settledRecoveryResumes;
}

export function compensationPreservedPreSemanticState(journal: ActionExecutionJournal): boolean {
  return journal.steps.some(
    (step) =>
      step.phase === "compensation" &&
      step.primitive === "recovery.dispatch" &&
      step.status === "completed" &&
      isRecord(step.output) &&
      step.output.disposition === "preserved_pre_semantic_state",
  );
}

export function recoveryPreservedPreSemanticState(journal: ActionExecutionJournal): boolean {
  return journal.steps.some(
    (step) =>
      step.phase === "recipe" &&
      step.primitive === "recovery.dispatch" &&
      step.status === "completed" &&
      isRecord(step.output) &&
      step.output.disposition === "preserved_pre_semantic_state",
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function humanizeIdentifier(value: string): string {
  const words = value.replace(/[._-]+/gu, " ").trim();
  return words.length === 0 ? "Agent" : `${words[0]!.toUpperCase()}${words.slice(1)}`;
}

export function selectedRunAction(
  run: Readonly<RunRecord>,
  selector: string,
): CompiledActionDefinition {
  const catalog = run.behavior?.actions;
  if (catalog === undefined) {
    throw new AuthorityRpcError(
      "action_catalog_missing",
      "native run has no pinned action catalog",
    );
  }
  const actionId = catalog.aliases[selector] ?? selector;
  const action = catalog.actions[actionId];
  if (action === undefined) {
    throw new AuthorityRpcError(
      "action_selector_missing",
      `pinned action selector does not resolve: ${selector}`,
    );
  }
  return action;
}

export function assignmentUsesConfiguredValidation(
  run: Readonly<RunRecord>,
  assignment: Readonly<ReadyAssignment>,
): boolean {
  return (
    run.behavior !== undefined &&
    run.tickets[assignment.ticketId]?.steps.some(
      (step) => step.id === assignment.stepId && step.validationAction !== undefined,
    ) === true
  );
}

/**
 * Resolve the ticket generation without rewriting legacy records. A ticket already executing in
 * its second or later durable Git cycle predates the explicit field, so the cycle ordinal is the
 * only authenticated evidence that its original obligation was reissued.
 */
export function currentTicketExecutionEpoch(
  run: Readonly<Pick<RunRecord, "tickets" | "git">>,
  ticket: Readonly<TicketRecord>,
): number {
  if (ticket.executionEpoch !== undefined) return ticket.executionEpoch;
  const cycle =
    ticket.gitCycleId === undefined ? undefined : run.git.ticketCycles[ticket.gitCycleId];
  return Math.max(0, (cycle?.ordinal ?? 1) - 1);
}

/**
 * Epoch-less attempts belong to generation zero unless the current legacy record is already in a
 * later cycle. In that ambiguous compatibility shape they are deliberately excluded: inheriting
 * an old terminal conversation would be unsafe and wasteful, while beginning a fresh root loses
 * no durable audit evidence.
 */
export function attemptTicketExecutionEpoch(
  run: Readonly<RunRecord>,
  ticket: Readonly<TicketRecord>,
  attempt: Readonly<AgentAttemptRecord>,
): number | undefined {
  if (attempt.ticketExecutionEpoch !== undefined) return attempt.ticketExecutionEpoch;
  if (ticket.executionEpoch !== undefined) return 0;
  const cycle =
    ticket.gitCycleId === undefined ? undefined : run.git.ticketCycles[ticket.gitCycleId];
  return (cycle?.ordinal ?? 1) > 1 ? undefined : 0;
}

export function checkedProviderSum(...values: number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum)) {
    throw new AuthorityRpcError(
      "provider_usage",
      "provider token accounting exceeds safe integer range",
    );
  }
  return sum;
}

/** True when a run's blocker is only a held provider-exposure reservation (auto-recoverable). */
export function isProviderExposureHoldBlocker(blocker: string | undefined): boolean {
  return (
    blocker !== undefined &&
    (blocker.includes("worst-case exposure is held") ||
      blocker.includes("worst-case exposure remains held") ||
      blocker.includes("worst-case exposure blocks a successor attempt"))
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export function planningTokenUsageFromBaseline(
  attempt: Readonly<AgentAttemptRecord>,
  baseline: Readonly<AgentProviderTokenTotals> | undefined,
): AgentProviderTokenTotals {
  const origin = baseline ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const usage = {
    inputTokens: attempt.inputTokens - origin.inputTokens,
    outputTokens: attempt.outputTokens - origin.outputTokens,
    cacheReadTokens: attempt.cacheReadTokens - origin.cacheReadTokens,
    cacheWriteTokens: attempt.cacheWriteTokens - origin.cacheWriteTokens,
  };
  if (Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new AuthorityRpcError(
      "planning_revision_budget",
      "cumulative provider usage moved behind the active planning revision baseline",
    );
  }
  return usage;
}

export function assignmentForAttempt(
  run: Readonly<RunRecord>,
  attempt: Readonly<AgentAttemptRecord>,
): ReadyAssignment | undefined {
  if (attempt.kind === "planning") return undefined;
  const ticket = run.tickets[attempt.ticketId];
  const step = ticket?.steps.find((candidate) => candidate.id === attempt.stepId);
  if (ticket === undefined || step === undefined) return undefined;
  return {
    runId: run.id,
    ticketId: ticket.id,
    stepId: step.id,
    personaId: step.personaId,
    priority: ticket.priority,
  };
}

export function encodeJsonArtifact(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024 || bytes.includes(0)) {
    throw new AuthorityRpcError(
      "artifact_size",
      "agent artifact is empty, oversized, or contains NUL",
    );
  }
  return bytes;
}

export function toolString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthorityRpcError("tool_arguments", `${key} must be a nonempty string`);
  }
  return value;
}
