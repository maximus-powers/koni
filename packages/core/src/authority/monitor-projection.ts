import {
  MONITOR_ATTENTION_PROTOCOL,
  MONITOR_EVENTS_PROTOCOL,
  MONITOR_SNAPSHOT_PROTOCOL,
  MAX_MONITOR_EVENTS,
  MAX_MONITOR_PROPOSALS,
  MAX_MONITOR_RUNS,
  type MonitorAttention,
  type MonitorEvent,
  type MonitorEventKind,
  type MonitorEvents,
  type MonitorPlanSectionId,
  type MonitorRunSummary,
  type MonitorSnapshot,
} from "../monitor/protocol.js";
import type {
  ControlProposalDisposition,
  ControlProposalInspection,
} from "../control-center/protocol.js";
import { terminalSafeText } from "../monitor/terminal.js";
import type { ProjectAuthorityState } from "./project-store.js";
import type { AgentAttemptRecord, RunRecord, TicketRecord } from "../state/run-record.js";
import { projectQuestionBatchCapabilities } from "../state/question-batch.js";
import type { RunSummary, RunSummaryPage } from "./run-summary-page.js";

export const MAX_DURABLE_MONITOR_EVENTS = 10_000;

type PendingMonitorEvent = Omit<MonitorEvent, "sequence">;

/**
 * Derive operator-facing semantic events from the exact before/after records in one authority
 * transaction. The project store assigns their global sequence numbers atomically with the run.
 */
export function deriveMonitorEvents(
  previous: RunRecord | undefined,
  current: RunRecord,
): PendingMonitorEvent[] {
  const events: PendingMonitorEvent[] = [];
  const at = current.updatedAt;
  const base = { at, runId: current.id, runRevision: current.revision };
  const push = (
    kind: MonitorEventKind,
    title: string,
    detail?: string,
    ticketId?: string,
  ): void => {
    events.push({
      ...base,
      kind,
      title: safe(title, 256, "Koni run updated"),
      detail: optionalSafe(detail, 1_024),
      ticketId,
    });
  };

  if (previous === undefined) {
    push(
      "run_created",
      `Started: ${objectivePreview(current.objective)}`,
      `Run type: ${humanize(current.runTypeId)}`,
    );
  }

  const priorPhase = previous?.lifecycle.phase;
  const priorStage = previous?.currentPipelineStageId;
  if (priorPhase !== current.lifecycle.phase || priorStage !== current.currentPipelineStageId) {
    const stage =
      current.currentPipelineStageId === undefined
        ? humanize(current.lifecycle.phase)
        : humanize(current.currentPipelineStageId);
    push("stage_changed", `Stage: ${stage}`, phaseDetail(current));
  }

  for (const ticket of Object.values(current.tickets).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const prior = previous?.tickets[ticket.id];
    if (
      ticket.status === "proposed" &&
      prior?.status !== "proposed" &&
      ticket.executionControl?.proposalRequest !== undefined
    ) {
      push("proposal_opened", "Change proposal needs a decision", ticket.summary, ticket.id);
    } else if (
      prior?.status === "proposed" &&
      ticket.status !== "proposed" &&
      prior.executionControl?.proposalRequest !== undefined
    ) {
      push("proposal_resolved", "Change proposal decision recorded", ticket.summary, ticket.id);
    }
    if (ticket.status === "completed" && prior?.status !== "completed") {
      push("ticket_completed", `Completed: ${ticket.title}`, ticket.summary, ticket.id);
    }
  }

  for (const question of Object.values(current.questions).sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const prior = previous?.questions[question.id];
    if (
      question.answeredAt === undefined &&
      (prior === undefined || prior.answeredAt !== undefined)
    ) {
      push("question_opened", "Question needs input", question.prompt);
    } else if (question.answeredAt !== undefined && prior?.answeredAt === undefined) {
      push("question_resolved", "Question answered", question.prompt);
    }
  }

  const priorPlanStatus = previous?.plan?.status;
  if (current.plan?.status === "awaiting_approval" && priorPlanStatus !== "awaiting_approval") {
    push("plan_ready", "Plan ready for review", `Plan revision ${current.plan.revision}`);
  } else if (
    priorPlanStatus === "awaiting_approval" &&
    current.plan?.status !== "awaiting_approval"
  ) {
    push(
      "plan_resolved",
      "Plan review resolved",
      current.plan === undefined ? undefined : `Plan revision ${current.plan.revision}`,
    );
  }

  if (current.lifecycle.phase === "blocked" && priorPhase !== "blocked") {
    push("blocked", "Run blocked", current.lifecycle.blocker ?? "Koni needs operator attention.");
  }
  if (current.lifecycle.phase === "failed" && priorPhase !== "failed") {
    push(
      "failed",
      "Run failed",
      current.lifecycle.terminalReason ?? current.lifecycle.blocker ?? "The run failed.",
    );
  }
  if (current.lifecycle.phase === "merge_ready" && priorPhase !== "merge_ready") {
    push("merge_ready", "Run ready to merge", `Target: ${current.git.target.ref}`);
  }
  return events;
}

export function appendMonitorEvents(
  state: ProjectAuthorityState,
  pending: readonly PendingMonitorEvent[],
): void {
  let cursor = state.monitorEventCursor ?? 0;
  const journal = [...(state.monitorEvents ?? [])];
  for (const event of pending) {
    cursor += 1;
    journal.push({ ...event, sequence: cursor });
  }
  state.monitorEventCursor = cursor;
  state.monitorEvents = journal.slice(-MAX_DURABLE_MONITOR_EVENTS);
}

export function projectMonitorSnapshot(
  state: ProjectAuthorityState,
  runs: readonly RunRecord[],
  requestedLimit: number,
): MonitorSnapshot {
  const limit = boundedInteger(requestedLimit, 1, MAX_MONITOR_RUNS, "monitor run limit");
  const live = runs.filter((run) => run.lifecycle.phase !== "deleted");
  const selected = live.slice(0, limit);
  return {
    protocol: MONITOR_SNAPSHOT_PROTOCOL,
    revision: state.revision,
    eventCursor: state.monitorEventCursor ?? 0,
    totalRuns: live.length,
    truncated: live.length > selected.length,
    runs: selected.map(projectRunSummary),
  };
}

/** Project the legacy monitor protocol from an already-bounded, revision-bound authority page. */
export function projectMonitorSnapshotFromPage(
  state: ProjectAuthorityState,
  page: RunSummaryPage,
): MonitorSnapshot {
  if (page.revision !== state.revision || page.includeDeleted) {
    throw new Error("monitor run page does not match the exact live authority snapshot");
  }
  return {
    protocol: MONITOR_SNAPSHOT_PROTOCOL,
    revision: state.revision,
    eventCursor: state.monitorEventCursor ?? 0,
    totalRuns: page.totalRuns,
    truncated: page.nextCursor !== undefined,
    runs: page.runs.map(projectPagedMonitorSummary),
  };
}

export function projectMonitorEvents(
  state: ProjectAuthorityState,
  after: number,
  requestedLimit: number,
): MonitorEvents {
  const cursor = state.monitorEventCursor ?? 0;
  if (!Number.isSafeInteger(after) || after < 0 || after > cursor) {
    throw new Error("monitor event cursor is outside the durable journal");
  }
  const limit = boundedInteger(requestedLimit, 1, MAX_MONITOR_EVENTS, "monitor event limit");
  const available = (state.monitorEvents ?? []).filter((event) => event.sequence > after);
  const page = available.slice(0, limit);
  const nextCursor = page.at(-1)?.sequence ?? cursor;
  return {
    protocol: MONITOR_EVENTS_PROTOCOL,
    fromCursor: after,
    nextCursor,
    truncated: available.length > page.length,
    events: structuredClone(page),
  };
}

export function projectMonitorAttention(run: RunRecord): MonitorAttention {
  const questions = Object.values(run.questions)
    .filter((question) => question.answeredAt === undefined)
    .sort(
      (left, right) => left.askedAt.localeCompare(right.askedAt) || left.id.localeCompare(right.id),
    )
    .map((question) => {
      const batch =
        question.batchId === undefined ? undefined : run.questionBatches?.[question.batchId];
      const capabilities =
        batch === undefined ? undefined : projectQuestionBatchCapabilities(batch);
      return {
        id: question.id,
        prompt: safe(question.prompt, 4_096, "Koni needs a decision."),
        options: question.options.map((option) => ({
          id: option.id,
          label: safe(option.label, 256, "Option"),
          description: safe(option.description, 1_024, "No additional details."),
        })),
        allowsNotes: question.allowsNotes,
        askedAt: question.askedAt,
        ...(batch === undefined
          ? {}
          : {
              batchId: batch.id,
              batchVersion: batch.version,
              batchPosition: question.batchPosition ?? 1,
              batchSize: question.batchSize ?? capabilities!.totalCount,
            }),
        ...(question.recommendationOptionId === undefined
          ? {}
          : { recommendedOptionId: question.recommendationOptionId }),
        answerSaved: question.answerRevision !== undefined || question.answeredAt !== undefined,
        resolvesBatchOnSubmit:
          batch === undefined ||
          (batch.status === "pending_answers" &&
            capabilities!.pendingQuestionIds.every((id) => id === question.id)),
      };
    });
  const plan =
    run.lifecycle.phase === "awaiting_approval" && run.plan?.status === "awaiting_approval"
      ? {
          revision: run.plan.revision,
          sections: Object.fromEntries(
            PLAN_SECTIONS.map((section) => [
              section,
              (run.plan!.concise[section] ?? []).slice(0, 50).map((item) => ({
                title: safe(item.title, 256, "Plan item"),
                description: safe(item.description, 2_048, "No additional details."),
              })),
            ]),
          ) as Record<MonitorPlanSectionId, Array<{ title: string; description: string }>>,
          graphSeedCounts: graphSeedCounts(run.plan.graphSeed),
        }
      : undefined;
  return {
    protocol: MONITOR_ATTENTION_PROTOCOL,
    runId: run.id,
    runRevision: run.revision,
    questions,
    proposals: projectActionableProposals(run),
    plan,
  };
}

/**
 * One exact bounded proposal view shared by proposal.inspect, the full control center, and the Pi
 * companion. It reads durable records only and never changes ticket or lifecycle state.
 */
export function projectControlProposalInspection(
  run: RunRecord,
  ticket: TicketRecord,
): ControlProposalInspection {
  const control = ticket.executionControl;
  const request = control?.proposalRequest;
  if (request === undefined) throw new Error("ticket is not a durable change proposal");
  const targetNodeIds = [...(control?.changeControlScopeNodeIds ?? ticket.targetNodeIds)];
  const decision = control?.proposalDecision;
  return {
    runId: run.id,
    ticketId: ticket.id,
    sourceTicketId: request.sourceTicketId,
    status: ticket.status,
    title: safe(ticket.title, 4_096, "Change proposal"),
    summary: safe(ticket.summary, 32_768, "Review the proposed upstream change."),
    targetNodeIds,
    createdAt: ticket.createdAt,
    ...(decision === undefined
      ? {}
      : {
          decision: {
            decision: decision.decision,
            authoritySha256: decision.sha256,
            ...(decision.message === undefined
              ? {}
              : { message: safe(decision.message, 8_000, "Decision recorded.") }),
            actor: safe(decision.actor, 256, "operator"),
            decidedAt: decision.recordedAt,
          },
        }),
    disposition: projectProposalDisposition(run, ticket),
  };
}

export function validateDurableMonitorJournal(state: ProjectAuthorityState): void {
  const cursor = state.monitorEventCursor ?? 0;
  const events = state.monitorEvents ?? [];
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    events.length > MAX_DURABLE_MONITOR_EVENTS ||
    cursor < events.length
  ) {
    throw new Error("authority monitor journal metadata is invalid");
  }
  let previous = cursor - events.length;
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence !== previous + 1 ||
      event.sequence > cursor
    ) {
      throw new Error("authority monitor journal sequence is invalid");
    }
    if (
      !EVENT_KINDS.has(event.kind) ||
      !RUN_ID.test(event.runId) ||
      !Number.isSafeInteger(event.runRevision) ||
      event.runRevision < 0 ||
      !Number.isFinite(Date.parse(event.at)) ||
      !boundedStoredText(event.title, 256, false) ||
      !boundedStoredText(event.detail, 1_024, true) ||
      !boundedStoredText(event.ticketId, 256, true)
    ) {
      throw new Error("authority monitor journal event is invalid");
    }
    previous = event.sequence;
  }
  if (events.length > 0 && events.at(-1)!.sequence !== cursor) {
    throw new Error("authority monitor journal does not end at its cursor");
  }
}

function projectRunSummary(run: RunRecord): MonitorRunSummary {
  const tickets = Object.values(run.tickets);
  const attempts = Object.values(run.attempts);
  const input = sum(attempts, (attempt) => attempt.inputTokens);
  const output = sum(attempts, (attempt) => attempt.outputTokens);
  const cache = sum(attempts, (attempt) =>
    safeAdd(attempt.cacheReadTokens, attempt.cacheWriteTokens),
  );
  const fresh = safeAdd(input, output);
  const pendingQuestions = Object.values(run.questions).filter(
    (question) => question.answeredAt === undefined,
  );
  const planApproval =
    run.lifecycle.phase === "awaiting_approval" && run.plan?.status === "awaiting_approval";
  const mergeReady =
    run.lifecycle.phase === "merge_ready" &&
    run.git.promotion?.status === "ready" &&
    run.git.promotion.candidateOid !== undefined;
  return {
    id: run.id,
    runRevision: run.revision,
    objectivePreview: objectivePreview(run.objective),
    runType: safe(humanize(run.runTypeId), 128, "Run"),
    phase: run.lifecycle.phase,
    stage:
      run.currentPipelineStageId === undefined
        ? undefined
        : safe(humanize(run.currentPipelineStageId), 256, "Work"),
    updatedAt: run.updatedAt,
    tickets: {
      completed: tickets.filter((ticket) => ticket.status === "completed").length,
      total: tickets.length,
    },
    agents: {
      // A blocked run executes nothing; advertising "active" agents there misreads as progress.
      active: run.lifecycle.phase === "blocked" ? 0 : attempts.filter(activeAttempt).length,
      total: attempts.length,
    },
    tokens: { new: fresh, cache, total: safeAdd(fresh, cache) },
    questionCount: pendingQuestions.length,
    proposalCount: tickets.filter(actionableProposal).length,
    planApproval,
    blocker: optionalSafe(run.lifecycle.blocker, 1_024),
    failure:
      run.lifecycle.phase === "failed"
        ? safe(
            run.lifecycle.terminalReason ?? run.lifecycle.blocker ?? "The run failed.",
            1_024,
            "The run failed.",
          )
        : undefined,
    mergeReady,
  };
}

function projectPagedMonitorSummary(run: RunSummary): MonitorRunSummary {
  return {
    id: run.id,
    runRevision: run.runRevision,
    objectivePreview: run.objectivePreview,
    runType: run.runType,
    phase: run.phase,
    stage: run.stage,
    updatedAt: run.updatedAt,
    tickets: { completed: run.tickets.completed, total: run.tickets.total },
    agents: { active: run.agents.active, total: run.agents.total },
    tokens: { new: run.tokens.new, cache: run.tokens.cached, total: run.tokens.providerTotal },
    questionCount: run.pendingQuestions,
    proposalCount: run.pendingProposals,
    planApproval: run.planApproval,
    blocker: run.blocker,
    failure: run.failure,
    mergeReady: run.mergeReady,
  };
}

const PLAN_SECTIONS: readonly MonitorPlanSectionId[] = [
  "architecture",
  "decisions",
  "risk",
  "verification",
];
const EVENT_KINDS = new Set<MonitorEventKind>([
  "run_created",
  "stage_changed",
  "ticket_completed",
  "question_opened",
  "question_resolved",
  "proposal_opened",
  "proposal_resolved",
  "plan_ready",
  "plan_resolved",
  "blocked",
  "failed",
  "merge_ready",
  "run_updated",
]);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function graphSeedCounts(value: unknown): Record<string, number> {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return {};
  const counts: Record<string, number> = {};
  for (const candidate of value.nodes) {
    if (!isRecord(candidate) || typeof candidate.type !== "string") continue;
    const key = safe(candidate.type, 128, "node");
    counts[key] = safeAdd(counts[key] ?? 0, 1);
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function projectActionableProposals(run: RunRecord): ControlProposalInspection[] {
  return Object.values(run.tickets)
    .filter(actionableProposal)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .slice(0, MAX_MONITOR_PROPOSALS)
    .map((ticket) => projectControlProposalInspection(run, ticket));
}

function actionableProposal(ticket: TicketRecord): boolean {
  return (
    ticket.status === "proposed" &&
    ticket.executionControl?.proposalRequest !== undefined &&
    ticket.executionControl.proposalDisposition === undefined
  );
}

function projectProposalDisposition(
  run: RunRecord,
  ticket: TicketRecord,
): ControlProposalDisposition {
  const disposition = ticket.executionControl?.proposalDisposition;
  if (disposition === undefined || disposition.kind === "approved") return { kind: "pending" };
  if (disposition.kind === "rejected") return { kind: "rejected" };
  if (disposition.kind === "no_op") return { kind: "no_op" };
  const applicationTicketId = disposition.applicationTicketId;
  if (applicationTicketId === undefined)
    throw new Error("proposal application disposition has no application ticket");
  const application = run.tickets[applicationTicketId];
  if (application === undefined)
    throw new Error("proposal application disposition names a missing ticket");
  return { kind: "application", applicationTicketId, applicationStatus: application.status };
}

function phaseDetail(run: RunRecord): string | undefined {
  if (run.lifecycle.phase === "blocked") return run.lifecycle.blocker;
  if (run.lifecycle.phase === "failed") return run.lifecycle.terminalReason;
  if (run.currentPipelineStageId !== undefined)
    return `Run phase: ${humanize(run.lifecycle.phase)}`;
  return undefined;
}

function objectivePreview(value: string): string {
  return safe(value.replace(/\s+/gu, " ").trim(), 240, "Untitled Koni run");
}

function humanize(value: string): string {
  const words = value
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (words.length === 0) return "Work";
  return words[0]!.toLocaleUpperCase("en-US") + words.slice(1);
}

function activeAttempt(attempt: AgentAttemptRecord): boolean {
  return (
    attempt.status === "queued" ||
    attempt.status === "running" ||
    attempt.status === "waiting_question" ||
    attempt.status === "terminal_accepted"
  );
}

function sum<Value>(values: readonly Value[], select: (value: Value) => number): number {
  return values.reduce((total, value) => safeAdd(total, select(value)), 0);
}

function safeAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0)
    return Number.MAX_SAFE_INTEGER;
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function safe(value: string, maximum: number, fallback: string): string {
  const normalized = terminalSafeText(value, { maxCodePoints: maximum });
  return normalized.length === 0 ? fallback : normalized;
}

function optionalSafe(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = terminalSafeText(value, { maxCodePoints: maximum });
  return normalized.length === 0 ? undefined : normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedStoredText(value: unknown, maximum: number, optional: boolean): boolean {
  if (value === undefined) return optional;
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= maximum &&
    terminalSafeText(value, { maxCodePoints: maximum }) === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
