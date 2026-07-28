import type { RunLifecycleState } from "./run-lifecycle.js";

/**
 * A blocked run executes nothing. Durable ticket/step records legitimately keep their
 * "running" status (execution resumes from that exact state), but every human- and
 * agent-facing projection must present them as interrupted so a wedged run is never
 * mistaken for active work.
 */
export function runExecutionHalted(lifecycle: Pick<RunLifecycleState, "phase">): boolean {
  return lifecycle.phase === "blocked";
}

/** True when a nominally in-flight ticket/step status is actually halted by a run-level block. */
export function interruptedByRunBlock(
  status: string,
  lifecycle: Pick<RunLifecycleState, "phase">,
): boolean {
  return runExecutionHalted(lifecycle) && (status === "running" || status === "review");
}

/** Machine-readable effective status for agent-facing read tools. */
export function effectiveStatus(
  status: string,
  lifecycle: Pick<RunLifecycleState, "phase">,
): string {
  return interruptedByRunBlock(status, lifecycle)
    ? `interrupted (run blocked, was ${status})`
    : status;
}

/** Human display label for interrupted work in the control center and overlays. */
export const INTERRUPTED_DISPLAY_LABEL = "Interrupted — run blocked";
