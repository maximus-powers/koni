import type { RunRecord, TicketRecord, TicketStepRecord } from "./run-record.js";

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
  activeCount: number;
  availableSlots: number;
}

export function deriveReadyAssignments(run: RunRecord, maxParallel: number): SchedulerProjection {
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

  if (!run.lifecycle.runningIntent || !new Set(["planning", "executing", "verifying"]).has(run.lifecycle.phase)) {
    return { ready: [], blocked, activeCount, availableSlots };
  }

  for (const ticket of tickets) {
    if (!new Set(["todo", "ready", "running", "review"]).has(ticket.status)) {
      continue;
    }
    const waitingOn = ticket.dependencyIds.filter(
      (dependencyId) => run.tickets[dependencyId]?.status !== "completed",
    );
    if (waitingOn.length > 0) {
      blocked.push({ ticketId: ticket.id, waitingOn: waitingOn.sort() });
      continue;
    }
    if (ticket.steps.some((step) => step.status === "running")) {
      continue;
    }
    const step = ticket.steps.find((candidate) => candidate.status === "pending");
    if (step !== undefined) {
      candidates.push({ ticket, step });
    }
  }

  candidates.sort(
    (left, right) =>
      left.ticket.priority - right.ticket.priority ||
      left.ticket.id.localeCompare(right.ticket.id) ||
      left.step.id.localeCompare(right.step.id),
  );
  return {
    ready: candidates.slice(0, availableSlots).map(({ ticket, step }) => ({
      runId: run.id,
      ticketId: ticket.id,
      stepId: step.id,
      personaId: step.personaId,
      priority: ticket.priority,
    })),
    blocked: blocked.sort((left, right) => left.ticketId.localeCompare(right.ticketId)),
    activeCount,
    availableSlots,
  };
}

export function beginAssignment(
  run: RunRecord,
  assignment: ReadyAssignment,
  attemptId: string,
  at: string,
): void {
  const { ticket, step } = resolveAssignment(run, assignment);
  if (step.status !== "pending") {
    throw new Error(`step is not pending: ${ticket.id}/${step.id}`);
  }
  if (ticket.dependencyIds.some((id) => run.tickets[id]?.status !== "completed")) {
    throw new Error(`ticket dependencies are not complete: ${ticket.id}`);
  }
  step.status = "running";
  step.attemptIds.push(attemptId);
  step.startedAt = at;
  ticket.status = "running";
  ticket.updatedAt = at;
}

export function finishAssignment(
  run: RunRecord,
  assignment: ReadyAssignment,
  outcome: { status: "completed"; summary: string } | { status: "failed"; blocker: string },
  at: string,
): void {
  const { ticket, step } = resolveAssignment(run, assignment);
  if (step.status !== "running") {
    throw new Error(`step is not running: ${ticket.id}/${step.id}`);
  }
  step.completedAt = at;
  ticket.updatedAt = at;
  if (outcome.status === "failed") {
    step.status = "failed";
    ticket.status = "blocked";
    ticket.blocker = outcome.blocker;
    return;
  }
  step.status = "completed";
  step.summary = outcome.summary;
  ticket.blocker = undefined;
  ticket.status = ticket.steps.every((candidate) =>
    candidate.status === "completed" || candidate.status === "skipped"
  ) ? "completed" : "ready";
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
  if (ticket === undefined || step === undefined || step.personaId !== assignment.personaId) {
    throw new Error("assignment no longer matches compiled ticket state");
  }
  return { ticket, step };
}
