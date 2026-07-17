import path from "node:path";
import type {
  RunGitLifecycleRecord,
  TicketGitCycleRecord,
} from "../src/git/lifecycle.js";
import type { RunRecord, TicketRecord } from "../src/state/run-record.js";

const OID = "a".repeat(40);

export function fixtureRunGit(
  projectRoot: string,
  runId: string,
  mode: "planning" | "approved" = "planning",
): RunGitLifecycleRecord {
  const commonDirectory = path.join(projectRoot, ".git");
  const root = path.join(commonDirectory, "koni", "worktrees", "runs", runId);
  const runRef = `refs/heads/koni/runs/${runId}`;
  return {
    protocol: "koni.git-lifecycle.v1",
    runId,
    projectRoot,
    commonDirectory,
    target: { ref: "refs/heads/main", selectedOid: OID },
    namespace: {
      root,
      runRef,
      planningWorktree: projectRoot,
      runWorktree: projectRoot,
      ticketRoot: projectRoot,
    },
    planning: {
      status: mode === "planning" ? "ready" : "retired",
      baseOid: OID,
      worktree: projectRoot,
      createdAt: "2026-07-16T00:00:00.000Z",
      retiredAt: mode === "planning" ? undefined : "2026-07-16T00:00:01.000Z",
      blocker: undefined,
    },
    run: {
      status: mode === "planning" ? "unmaterialized" : "ready",
      branchRef: runRef,
      worktree: projectRoot,
      headOid: mode === "planning" ? undefined : OID,
      materializedAt: mode === "planning" ? undefined : "2026-07-16T00:00:01.000Z",
      retiredAt: undefined,
      blocker: undefined,
    },
    ticketCycles: {},
    ticketCycleOrder: [],
    promotion: undefined,
  };
}

export function attachFixtureTicketCycle(run: RunRecord, ticket: TicketRecord): TicketGitCycleRecord {
  if (run.git.run.status !== "ready") {
    run.git.planning.status = "retired";
    run.git.planning.retiredAt ??= "2026-07-16T00:00:01.000Z";
    run.git.run.status = "ready";
    run.git.run.headOid = OID;
    run.git.run.materializedAt ??= "2026-07-16T00:00:01.000Z";
  }
  const cycleId = `cycle-${ticket.id}`;
  const branchRef = `refs/heads/koni/tickets/${run.id}/${ticket.id}/cycles/${cycleId}`;
  const worktree = run.projectRoot;
  const cycle: TicketGitCycleRecord = {
    cycleId,
    ticketId: ticket.id,
    ordinal: 1,
    status: "active",
    baseRunOid: run.git.run.headOid!,
    branchRef,
    worktree,
    ticketHeadOid: run.git.run.headOid!,
    integratedRunOid: undefined,
    squashCommitOid: undefined,
    createdAt: "2026-07-16T00:00:02.000Z",
    integratedAt: undefined,
    retiredAt: undefined,
    blocker: undefined,
  };
  run.git.ticketCycles[cycleId] = cycle;
  if (!run.git.ticketCycleOrder.includes(cycleId)) run.git.ticketCycleOrder.push(cycleId);
  ticket.gitCycleId = cycleId;
  ticket.worktreePath = worktree;
  ticket.branch = branchRef;
  return cycle;
}
