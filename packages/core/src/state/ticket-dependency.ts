import type { TicketRecord } from "./run-record.js";

export const COMPILER_INAPPLICABLE_TICKET =
  "Current compiler predicate no longer applies after prior execution";
export const COMPILER_SUPERSEDED_BEFORE_EXECUTION =
  "Superseded before execution by newer compiler state";
export const COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR =
  "Superseded by the existing planned asset implementation workflow";
export const COMPILER_ROUTED_TO_MANIFEST_GATE_RECHECK =
  "Superseded by a current manifest-bound gate recheck";

export function ticketDependencySettled(ticket: Readonly<TicketRecord> | undefined): boolean {
  return (
    ticket?.status === "completed" ||
    (ticket?.status === "cancelled" &&
      (ticket.blocker === COMPILER_INAPPLICABLE_TICKET ||
        ticket.blocker === COMPILER_SUPERSEDED_BEFORE_EXECUTION ||
        ticket.blocker === COMPILER_ROUTED_TO_PLANNED_ASSET_REPAIR ||
        ticket.blocker === COMPILER_ROUTED_TO_MANIFEST_GATE_RECHECK))
  );
}
