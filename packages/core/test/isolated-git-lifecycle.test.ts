import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitLifecycleError,
  IsolatedGitLifecycle,
  type GitIntentJournal,
  type GitIntentSettlement,
  type GitLifecycleIntent,
  type GitEffectFaultPoint,
  type RunGitLifecycleRecord,
} from "../src/git/lifecycle.js";
import { inspectGitPathScope } from "../src/git/path-scope.js";

const roots: string[] = [];
const sourceScope = {
  allowed: [{ kind: "prefix", path: "src" }] as const,
  compilerOwned: [{ kind: "prefix", path: "src/generated" }] as const,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pure TypeScript isolated Git lifecycle", () => {
  it("lists only selectable user target branches", async () => {
    const root = await repository();
    await git(root, "branch", "recent-feature");
    await git(root, "branch", "koni/runs/internal");
    const branches = await lifecycle(root).recentTargetBranches();
    expect(branches.map((branch) => branch.name).sort()).toEqual(["main", "recent-feature"]);
    expect(branches.every((branch) => branch.ref === `refs/heads/${branch.name}`)).toBe(true);
  });

  it("keeps planning detached and creates the first permanent run ref only on approval", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await authority.planRun("run-planning", "refs/heads/main");
    const refsBefore = await refs(root);

    state = await authority.materializePlanning(state, journal);
    expect(await refs(root)).toEqual(refsBefore);
    expect(await gitOutput(state.planning.worktree, "symbolic-ref", "-q", "HEAD", [0, 1])).toBe("");
    expect(await gitOutput(state.planning.worktree, "rev-parse", "HEAD")).toBe(state.target.selectedOid);
    expect(await exists(state.run.worktree)).toBe(false);

    state = await authority.approveRun(state, journal);
    expect(state.planning.status).toBe("retired");
    expect(await exists(state.planning.worktree)).toBe(false);
    expect(await gitOutput(root, "rev-parse", state.run.branchRef)).toBe(state.target.selectedOid);
    expect(await gitOutput(state.run.worktree, "symbolic-ref", "HEAD")).toBe(state.run.branchRef);
    expect((await authority.approveRun(state, journal)).run).toEqual(state.run);
    expect(journal.pending.size).toBe(0);
  });

  it("rejects a symlinked compiler namespace without touching its destination", async () => {
    const root = await repository();
    const external = await mkdtemp(path.join(tmpdir(), "koni-git-symlink-target-"));
    roots.push(external);
    await symlink(external, path.join(root, ".git", "koni"));
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    const state = await authority.planRun("run-symlink", "refs/heads/main");
    await expect(authority.materializePlanning(state, journal)).rejects.toMatchObject({
      code: "ownership_mismatch",
    });
    expect(await exists(path.join(external, "worktrees"))).toBe(false);
  });

  it("shares one checkout across a ticket cycle and publishes one scoped squash commit", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-ticket");
    state = await authority.openTicketCycle(
      state,
      { ticketId: "TK-1", cycleId: "cycle-1" },
      journal,
    );
    const checkout = state.ticketCycles["cycle-1"]!.worktree;
    await writeFile(path.join(checkout, "src", "feature.ts"), "export const feature = true;\n");
    const inspected = await authority.inspectTicketScope(state, "cycle-1", sourceScope);
    expect(inspected.accepted).toBe(true);

    state = await authority.commitTicketCandidate(
      state,
      { cycleId: "cycle-1", scope: sourceScope, subject: "feat: add feature" },
      journal,
    );
    const ticketHead = state.ticketCycles["cycle-1"]!.ticketHeadOid;
    const priorRun = state.run.headOid!;
    const published = await authority.publishTicketCandidate(
      state,
      { cycleId: "cycle-1", scope: sourceScope, subject: "feat: publish feature" },
      journal,
    );
    expect(published.status).toBe("integrated");
    if (published.status !== "integrated") throw new Error("expected integration");
    state = published.lifecycle;
    expect(state.ticketCycles["cycle-1"]!.worktree).toBe(checkout);
    expect(await readFile(path.join(state.run.worktree, "src", "feature.ts"), "utf8"))
      .toBe("export const feature = true;\n");
    expect(await gitOutput(root, "rev-list", "--parents", "-n", "1", state.run.headOid!))
      .toBe(`${state.run.headOid} ${priorRun}`);
    expect(state.run.headOid).not.toBe(ticketHead);
    expect(await gitOutput(state.run.worktree, "status", "--porcelain")).toBe("");
  });

  it("rejects out-of-scope and compiler-owned edits before checkpointing", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-scope");
    state = await authority.openTicketCycle(
      state,
      { ticketId: "TK-scope", cycleId: "scope-1" },
      journal,
    );
    const checkout = state.ticketCycles["scope-1"]!.worktree;
    await writeFile(path.join(checkout, "README.md"), "unauthorized\n");
    await expect(authority.commitTicketCandidate(
      state,
      { cycleId: "scope-1", scope: sourceScope, subject: "bad edit" },
      journal,
    )).rejects.toMatchObject({ code: "scope_violation" });
    await git(checkout, "checkout", "--", "README.md");
    await mkdir(path.join(checkout, "src", "generated"));
    await writeFile(path.join(checkout, "src", "generated", "authority.ts"), "bad\n");
    await expect(authority.commitTicketCandidate(
      state,
      { cycleId: "scope-1", scope: sourceScope, subject: "bad authority edit" },
      journal,
    )).rejects.toMatchObject({ code: "scope_violation" });
    expect(await exists(path.join(checkout, "src", "generated", "authority.ts"))).toBe(true);
  });

  it("reports concurrent ticket conflicts without leaving either checkout conflicted", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-conflicts");
    state = await authority.openTicketCycle(state, { ticketId: "TK-A", cycleId: "A-1" }, journal);
    state = await authority.openTicketCycle(state, { ticketId: "TK-B", cycleId: "B-1" }, journal);
    for (const [cycle, contents] of [["A-1", "from A\n"], ["B-1", "from B\n"]] as const) {
      const checkout = state.ticketCycles[cycle]!.worktree;
      await writeFile(path.join(checkout, "src", "base.ts"), contents);
      state = await authority.commitTicketCandidate(
        state,
        { cycleId: cycle, scope: sourceScope, subject: `change ${cycle}` },
        journal,
      );
    }
    const first = await authority.publishTicketCandidate(
      state,
      { cycleId: "A-1", scope: sourceScope, subject: "publish A" },
      journal,
    );
    if (first.status !== "integrated") throw new Error("expected first integration");
    state = first.lifecycle;
    const second = await authority.publishTicketCandidate(
      state,
      { cycleId: "B-1", scope: sourceScope, subject: "publish B" },
      journal,
    );
    expect(second.status).toBe("conflict");
    if (second.status !== "conflict") throw new Error("expected conflict");
    expect(second.conflict.paths).toContain("src/base.ts");
    expect(await gitOutput(state.run.worktree, "status", "--porcelain")).toBe("");
    expect(await gitOutput(state.ticketCycles["B-1"]!.worktree, "status", "--porcelain")).toBe("");
    expect(await readFile(path.join(state.run.worktree, "src", "base.ts"), "utf8")).toBe("from A\n");
  }, 15_000);

  it("rejects a moved run ref under CAS without altering the ticket candidate", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-moved");
    state = await authority.openTicketCycle(state, { ticketId: "TK-M", cycleId: "M-1" }, journal);
    const ticketWorktree = state.ticketCycles["M-1"]!.worktree;
    await writeFile(path.join(ticketWorktree, "src", "candidate.ts"), "candidate\n");
    state = await authority.commitTicketCandidate(
      state,
      { cycleId: "M-1", scope: sourceScope, subject: "candidate" },
      journal,
    );
    const ticketHead = state.ticketCycles["M-1"]!.ticketHeadOid;
    await writeFile(path.join(state.run.worktree, "src", "external.ts"), "external\n");
    await git(state.run.worktree, "add", "src/external.ts");
    await git(state.run.worktree, "commit", "-m", "external run move");
    await expect(authority.publishTicketCandidate(
      state,
      { cycleId: "M-1", scope: sourceScope, subject: "must reject" },
      journal,
    )).rejects.toMatchObject({ code: "ref_moved" });
    expect(await gitOutput(root, "rev-parse", state.ticketCycles["M-1"]!.branchRef)).toBe(ticketHead);
    expect(await readFile(path.join(ticketWorktree, "src", "candidate.ts"), "utf8")).toBe("candidate\n");
  });

  it("allocates auditable reissue cycles and preserves dirty retired work", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-reissue");
    state = await authority.openTicketCycle(state, { ticketId: "TK-X", cycleId: "X-1" }, journal);
    await writeFile(path.join(state.ticketCycles["X-1"]!.worktree, "src", "one.ts"), "one\n");
    state = await authority.commitTicketCandidate(
      state,
      { cycleId: "X-1", scope: sourceScope, subject: "first cycle" },
      journal,
    );
    const first = await authority.publishTicketCandidate(
      state,
      { cycleId: "X-1", scope: sourceScope, subject: "publish first" },
      journal,
    );
    if (first.status !== "integrated") throw new Error("expected integration");
    state = first.lifecycle;
    const firstPath = state.ticketCycles["X-1"]!.worktree;
    await writeFile(path.join(firstPath, "uncommitted.txt"), "preserve me\n");
    const preserved = await authority.retireTicketCycle(state, "X-1", journal);
    expect(preserved.ticketCycles["X-1"]!.status).toBe("preserved");
    expect(await readFile(path.join(firstPath, "uncommitted.txt"), "utf8")).toBe("preserve me\n");
    await unlink(path.join(firstPath, "uncommitted.txt"));
    const laterRetired = await authority.retireTicketCycle(preserved, "X-1", journal);
    expect(laterRetired.ticketCycles["X-1"]!.status).toBe("retired");

    state = await authority.openTicketCycle(state, { ticketId: "TK-X", cycleId: "X-2" }, journal);
    expect(state.ticketCycles["X-2"]!.ordinal).toBe(2);
    expect(state.ticketCycles["X-2"]!.worktree).not.toBe(firstPath);
    expect(state.ticketCycles["X-2"]!.branchRef).not.toBe(state.ticketCycles["X-1"]!.branchRef);
  });

  it("keeps target promotion explicit, rejects target movement, and never overwrites a dirty target checkout", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await integratedFeature(authority, journal, "run-promotion", "promote.ts");
    let prepared = await authority.prepareTargetPromotion(state, { subject: "merge run" });
    state = prepared.lifecycle;
    expect(prepared.preparation.status).toBe("ready");

    await writeFile(path.join(root, "operator.txt"), "do not delete\n");
    await expect(authority.publishTargetPromotion(state, journal)).rejects.toMatchObject({
      code: "dirty_checkout",
    });
    expect(await readFile(path.join(root, "operator.txt"), "utf8")).toBe("do not delete\n");
    await unlink(path.join(root, "operator.txt"));

    await writeFile(path.join(root, "target-only.txt"), "target moved\n");
    await git(root, "add", "target-only.txt");
    await git(root, "commit", "-m", "move target");
    await expect(authority.publishTargetPromotion(state, journal)).rejects.toMatchObject({
      code: "ref_moved",
    });
    expect(await gitOutput(root, "show", "HEAD:target-only.txt")).toBe("target moved");

    prepared = await authority.prepareTargetPromotion(state, { subject: "merge updated target" });
    expect(prepared.preparation.status).toBe("ready");
    state = await authority.publishTargetPromotion(prepared.lifecycle, journal);
    expect(state.promotion?.status).toBe("published");
    expect(await readFile(path.join(root, "src", "promote.ts"), "utf8")).toBe("feature\n");
    expect(await readFile(path.join(root, "target-only.txt"), "utf8")).toBe("target moved\n");
    const settlements = journal.settlements.length;
    expect(await authority.publishTargetPromotion(state, journal)).toEqual(state);
    expect(journal.settlements).toHaveLength(settlements);
  });

  it("turns target merge conflicts into integration work without changing the target", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-target-conflict");
    state = await authority.openTicketCycle(state, { ticketId: "TK-C", cycleId: "C-1" }, journal);
    await writeFile(path.join(state.ticketCycles["C-1"]!.worktree, "src", "base.ts"), "run\n");
    state = await authority.commitTicketCandidate(
      state,
      { cycleId: "C-1", scope: sourceScope, subject: "run edit" },
      journal,
    );
    const published = await authority.publishTicketCandidate(
      state,
      { cycleId: "C-1", scope: sourceScope, subject: "publish run edit" },
      journal,
    );
    if (published.status !== "integrated") throw new Error("expected integration");
    state = published.lifecycle;
    await writeFile(path.join(root, "src", "base.ts"), "target\n");
    await git(root, "add", "src/base.ts");
    await git(root, "commit", "-m", "target conflict");
    const targetBefore = await gitOutput(root, "rev-parse", "HEAD");
    const prepared = await authority.prepareTargetPromotion(state, { subject: "conflicting merge" });
    expect(prepared.preparation.status).toBe("integration_required");
    expect(await gitOutput(root, "rev-parse", "HEAD")).toBe(targetBefore);
    expect(await gitOutput(root, "status", "--porcelain")).toBe("");
  });

  it("recognizes a completed target checkout after a crash and preserves later operator work", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await integratedFeature(healthy, journal, "run-target-recovery", "target-recovery.ts");
    const prepared = await healthy.prepareTargetPromotion(state, { subject: "target recovery" });
    if (prepared.preparation.status !== "ready") throw new Error("expected promotion");
    state = prepared.lifecycle;
    const crashing = lifecycle(root, (point) => {
      if (point === "after_target_checkout") throw new Error("target settlement crash");
    });
    await expect(crashing.publishTargetPromotion(state, journal)).rejects.toThrow("target settlement crash");
    await writeFile(path.join(root, "operator-after-publish.txt"), "keep later work\n");
    const recovered = await healthy.recoverIntent(state, onlyPending(journal), journal);
    expect(recovered.status).toBe("completed");
    expect(recovered.lifecycle.promotion?.status).toBe("published");
    expect(await readFile(path.join(root, "operator-after-publish.txt"), "utf8"))
      .toBe("keep later work\n");
  });

  it("recovers crash-forward approval and publication intents from exact state", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    let crashPoint = "after_run_ref";
    const crashing = lifecycle(root, (point) => {
      if (point === crashPoint) throw new Error(`simulated crash at ${point}`);
    });
    let state = await crashing.planRun("run-recovery", "refs/heads/main");
    state = await crashing.materializePlanning(state, journal);
    await expect(crashing.approveRun(state, journal)).rejects.toThrow("simulated crash");
    const approvalIntent = onlyPending(journal);
    const healthy = lifecycle(root);
    let recovered = await healthy.recoverIntent(state, approvalIntent, journal);
    expect(recovered.status).toBe("completed");
    state = recovered.lifecycle;
    expect(state.run.status).toBe("ready");
    expect(await exists(state.planning.worktree)).toBe(false);

    state = await healthy.openTicketCycle(state, { ticketId: "TK-R", cycleId: "R-1" }, journal);
    await writeFile(path.join(state.ticketCycles["R-1"]!.worktree, "src", "recovery.ts"), "ok\n");
    state = await healthy.commitTicketCandidate(
      state,
      { cycleId: "R-1", scope: sourceScope, subject: "recovery candidate" },
      journal,
    );
    crashPoint = "after_run_publish_ref";
    await expect(crashing.publishTicketCandidate(
      state,
      { cycleId: "R-1", scope: sourceScope, subject: "recovery publish" },
      journal,
    )).rejects.toThrow("simulated crash");
    const publishIntent = onlyPending(journal);
    recovered = await healthy.recoverIntent(state, publishIntent, journal);
    expect(recovered.status).toBe("completed");
    state = recovered.lifecycle;
    expect(await readFile(path.join(state.run.worktree, "src", "recovery.ts"), "utf8")).toBe("ok\n");
    expect(await gitOutput(state.run.worktree, "status", "--porcelain")).toBe("");
  });

  it("records failed publication compensation as a forward commit and recovers it exactly once", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await approvedRun(healthy, journal, "run-forward-compensation");
    state = await healthy.openTicketCycle(
      state,
      { ticketId: "TK-F", cycleId: "F-1" },
      journal,
    );
    await writeFile(
      path.join(state.ticketCycles["F-1"]!.worktree, "src", "forward.ts"),
      "candidate\n",
    );
    state = await healthy.commitTicketCandidate(
      state,
      { cycleId: "F-1", scope: sourceScope, subject: "forward candidate" },
      journal,
    );
    const priorOid = state.run.headOid!;
    const settlementBaseline = journal.settlements.length;
    const failing = lifecycle(root, (point) => {
      if (point === "before_run_checkout_repair") throw new Error("injected checkout failure");
      if (point === "after_forward_compensation_ref") throw new Error("compensation settlement crash");
    });
    await expect(failing.publishTicketCandidate(
      state,
      { cycleId: "F-1", scope: sourceScope, subject: "publish forward candidate" },
      journal,
    )).rejects.toThrow("compensation settlement crash");

    const compensationIntent = onlyPending(journal);
    expect(compensationIntent.kind).toBe("forward_compensation");
    if (compensationIntent.kind !== "forward_compensation") {
      throw new Error("expected forward compensation intent");
    }
    const compensationOid = await gitOutput(root, "rev-parse", compensationIntent.reference);
    expect(compensationOid).not.toBe(priorOid);
    expect(compensationOid).not.toBe(compensationIntent.candidateOid);
    expect(await gitOutput(root, "rev-list", "--parents", "-n", "1", compensationOid))
      .toBe(`${compensationOid} ${compensationIntent.candidateOid}`);
    expect(await gitOutput(root, "show", "-s", "--format=%T", compensationOid))
      .toBe(await gitOutput(root, "show", "-s", "--format=%T", priorOid));
    await git(root, "merge-base", "--is-ancestor", compensationIntent.candidateOid, compensationOid);

    expect(journal.settlements).toHaveLength(settlementBaseline + 1);
    const failedReceipt = journal.settlements.at(-1)!;
    expect(failedReceipt.status).toBe("blocked");
    expect(failedReceipt.compensation).toEqual({
      originalIntentId: compensationIntent.originalIntentId,
      priorOid,
      candidateOid: compensationIntent.candidateOid,
    });
    const durableFailureState = structuredClone(failedReceipt.lifecycle);
    let recovered = await healthy.recoverIntent(durableFailureState, compensationIntent, journal);
    expect(recovered.status).toBe("completed");
    expect(recovered.lifecycle.run.headOid).toBe(compensationOid);
    expect(recovered.lifecycle.ticketCycles["F-1"]!.status).toBe("preserved");
    expect(journal.pending.size).toBe(0);
    expect(journal.settlements).toHaveLength(settlementBaseline + 2);
    expect(journal.settlements.at(-1)!.compensation).toEqual({
      originalIntentId: compensationIntent.originalIntentId,
      priorOid,
      candidateOid: compensationIntent.candidateOid,
      compensationOid,
    });

    const receiptsAfterFirstRestart = structuredClone(journal.settlements);
    for (const pending of [...journal.pending.values()]) {
      recovered = await healthy.recoverIntent(recovered.lifecycle, pending, journal);
    }
    expect(await gitOutput(root, "rev-parse", compensationIntent.reference)).toBe(compensationOid);
    expect(journal.settlements).toEqual(receiptsAfterFirstRestart);
    expect(await gitOutput(root, "rev-list", "--count", `${priorOid}..${compensationOid}`)).toBe("2");
  });

  it("preserves ambiguous work added after a publication crash instead of resetting it", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await approvedRun(healthy, journal, "run-preserve-crash");
    state = await healthy.openTicketCycle(state, { ticketId: "TK-P", cycleId: "P-1" }, journal);
    await writeFile(path.join(state.ticketCycles["P-1"]!.worktree, "src", "planned.ts"), "planned\n");
    state = await healthy.commitTicketCandidate(
      state,
      { cycleId: "P-1", scope: sourceScope, subject: "planned candidate" },
      journal,
    );
    const crashing = lifecycle(root, (point) => {
      if (point === "after_run_publish_ref") throw new Error("publication crash");
    });
    await expect(crashing.publishTicketCandidate(
      state,
      { cycleId: "P-1", scope: sourceScope, subject: "publish planned" },
      journal,
    )).rejects.toThrow("publication crash");
    const intent = onlyPending(journal);
    expect(intent.kind).toBe("ticket_publish");
    if (intent.kind !== "ticket_publish") throw new Error("expected ticket publication intent");
    await writeFile(path.join(state.run.worktree, "operator-recovery.txt"), "preserve this\n");
    const recovered = await healthy.recoverIntent(state, intent, journal);
    expect(recovered.status).toBe("preserved");
    expect(await readFile(path.join(state.run.worktree, "operator-recovery.txt"), "utf8"))
      .toBe("preserve this\n");
    expect(recovered.lifecycle.ticketCycles["P-1"]!.status).toBe("preserved");
    expect(journal.pending.size).toBe(0);
    expect(journal.settlements.at(-1)?.status).toBe("blocked");
    expect(journal.settlements.at(-1)?.compensation?.compensationOid).toBeUndefined();
    expect(await gitOutput(root, "rev-parse", intent.runRef)).toBe(intent.squashCommitOid);
    expect(await gitOutput(state.run.worktree, "status", "--porcelain", "--untracked-files=all"))
      .toContain("operator-recovery.txt");
  });

  it("finishes cleanup after a crash between worktree retirement and ref deletion", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await integratedFeature(healthy, journal, "run-cleanup-recovery", "retire.ts");
    const cycleId = state.ticketCycleOrder[0]!;
    const cycle = state.ticketCycles[cycleId]!;
    const crashing = lifecycle(root, (point) => {
      if (point === "after_ticket_worktree_retired") throw new Error("cleanup crash");
    });
    await expect(crashing.retireTicketCycle(state, cycleId, journal)).rejects.toThrow("cleanup crash");
    expect(await exists(cycle.worktree)).toBe(false);
    expect(await gitOutput(root, "rev-parse", cycle.branchRef)).toBe(cycle.ticketHeadOid);
    const recovered = await healthy.recoverIntent(state, onlyPending(journal), journal);
    expect(recovered.status).toBe("completed");
    state = recovered.lifecycle;
    expect(state.ticketCycles[cycleId]!.status).toBe("retired");
    await expect(gitOutput(root, "rev-parse", "--verify", cycle.branchRef)).rejects.toThrow();
  });

  it("retires an abandoned planning checkout without ever changing the target", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await authority.planRun("run-abandon-planning", "refs/heads/main");
    const targetBefore = await gitOutput(root, "rev-parse", "refs/heads/main");
    state = await authority.materializePlanning(state, journal);
    const retired = await authority.retireAbandonedRun(state, journal);
    expect(retired.status).toBe("retired");
    state = retired.lifecycle;
    expect(state.planning.status).toBe("retired");
    expect(state.run.status).toBe("retired");
    expect(await exists(state.planning.worktree)).toBe(false);
    expect(await gitOutput(root, "rev-parse", "refs/heads/main")).toBe(targetBefore);
    await expect(gitOutput(root, "rev-parse", "--verify", state.run.branchRef)).rejects.toThrow();
  });

  it("preserves a dirty abandoned ticket and deletes none of the run namespace", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-abandon-dirty");
    state = await authority.openTicketCycle(state, { ticketId: "TK-D", cycleId: "D-1" }, journal);
    const cycle = state.ticketCycles["D-1"]!;
    await writeFile(path.join(cycle.worktree, "dirty.txt"), "keep me\n");
    const result = await authority.retireAbandonedRun(state, journal);
    expect(result.status).toBe("preserved");
    expect(await readFile(path.join(cycle.worktree, "dirty.txt"), "utf8")).toBe("keep me\n");
    expect(await gitOutput(root, "rev-parse", cycle.branchRef)).toBe(cycle.ticketHeadOid);
    expect(await gitOutput(root, "rev-parse", state.run.branchRef)).toBe(state.run.headOid);
    expect(journal.pending.size).toBe(0);
  });

  it("recovers abandoned-run deletion after worktrees are gone but before refs are deleted", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await approvedRun(healthy, journal, "run-abandon-recovery");
    state = await healthy.openTicketCycle(state, { ticketId: "TK-Z", cycleId: "Z-1" }, journal);
    const cycle = state.ticketCycles["Z-1"]!;
    const targetBefore = await gitOutput(root, "rev-parse", state.target.ref);
    const crashing = lifecycle(root, (point) => {
      if (point === "after_abandoned_worktrees_retired") throw new Error("abandon crash");
    });
    await expect(crashing.retireAbandonedRun(state, journal)).rejects.toThrow("abandon crash");
    expect(await exists(cycle.worktree)).toBe(false);
    expect(await exists(state.run.worktree)).toBe(false);
    expect(await gitOutput(root, "rev-parse", cycle.branchRef)).toBe(cycle.ticketHeadOid);
    const recovered = await healthy.recoverIntent(state, onlyPending(journal), journal);
    expect(recovered.status).toBe("completed");
    expect(recovered.lifecycle.run.status).toBe("retired");
    expect(recovered.lifecycle.ticketCycles["Z-1"]!.status).toBe("retired");
    await expect(gitOutput(root, "rev-parse", "--verify", cycle.branchRef)).rejects.toThrow();
    await expect(gitOutput(root, "rev-parse", "--verify", state.run.branchRef)).rejects.toThrow();
    expect(await gitOutput(root, "rev-parse", state.target.ref)).toBe(targetBefore);
  });

  it("retires only clean, integrated compiler namespaces and leaves user worktrees alone", async () => {
    const root = await repository();
    await git(root, "branch", "user-work");
    const userWorktree = `${root}-user-worktree`;
    roots.push(userWorktree);
    await git(root, "worktree", "add", userWorktree, "user-work");
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await integratedFeature(authority, journal, "run-cleanup", "cleanup.ts");
    const cycleId = state.ticketCycleOrder[0]!;
    state = await authority.retireTicketCycle(state, cycleId, journal);
    expect(state.ticketCycles[cycleId]!.status).toBe("retired");
    const prepared = await authority.prepareTargetPromotion(state, { subject: "publish cleanup run" });
    if (prepared.preparation.status !== "ready") throw new Error("expected promotion");
    state = await authority.publishTargetPromotion(prepared.lifecycle, journal);
    state = await authority.retireRunNamespace(state, journal);
    expect(state.run.status).toBe("retired");
    expect(await exists(userWorktree)).toBe(true);
    expect(await gitOutput(userWorktree, "symbolic-ref", "HEAD")).toBe("refs/heads/user-work");
  });
});

describe("Git path scope", () => {
  it("uses explicit exact/prefix/glob semantics and compiler ownership wins", () => {
    expect(inspectGitPathScope(
      ["app/a.ts", "app/nested/b.ts", "app/a.ts.evil", ".codex/koni/profile.yaml"],
      {
        allowed: [
          { kind: "exact", path: "app/a.ts" },
          { kind: "glob", pattern: "app/**/*.ts" },
          { kind: "prefix", path: ".codex" },
        ],
      },
    )).toEqual({
      accepted: false,
      changedPaths: [".codex/koni/profile.yaml", "app/a.ts", "app/a.ts.evil", "app/nested/b.ts"],
      outOfScopePaths: ["app/a.ts.evil"],
      compilerOwnedPaths: [".codex/koni/profile.yaml"],
    });
  });
});

class MemoryJournal implements GitIntentJournal {
  public readonly pending = new Map<string, GitLifecycleIntent>();
  public readonly settlements: GitIntentSettlement[] = [];

  public async prepare(intent: GitLifecycleIntent): Promise<void> {
    if (this.pending.has(intent.id)) throw new Error(`duplicate intent ${intent.id}`);
    this.pending.set(intent.id, structuredClone(intent));
  }

  public async settle(intentId: string, settlement: GitIntentSettlement): Promise<void> {
    if (!this.pending.delete(intentId)) throw new Error(`unknown intent ${intentId}`);
    this.settlements.push(structuredClone(settlement));
  }

  public async supersedeWithCompensation(
    failedIntentId: string,
    failedSettlement: GitIntentSettlement,
    compensation: Extract<GitLifecycleIntent, { kind: "forward_compensation" }>,
  ): Promise<void> {
    if (!this.pending.delete(failedIntentId)) throw new Error(`unknown intent ${failedIntentId}`);
    if (this.pending.has(compensation.id)) throw new Error(`duplicate intent ${compensation.id}`);
    this.settlements.push(structuredClone(failedSettlement));
    this.pending.set(compensation.id, structuredClone(compensation));
  }
}

function onlyPending(journal: MemoryJournal): GitLifecycleIntent {
  expect(journal.pending.size).toBe(1);
  return structuredClone([...journal.pending.values()][0]!);
}

function lifecycle(
  root: string,
  fault?: (point: GitEffectFaultPoint) => void,
): IsolatedGitLifecycle {
  return new IsolatedGitLifecycle(root, {
    identity: { name: "Koni Test", email: "koni@example.invalid" },
    ...(fault === undefined ? {} : { effectFault: (point) => fault(point) }),
  });
}

async function approvedRun(
  authority: IsolatedGitLifecycle,
  journal: MemoryJournal,
  runId: string,
): Promise<RunGitLifecycleRecord> {
  let state = await authority.planRun(runId, "refs/heads/main");
  state = await authority.materializePlanning(state, journal);
  return authority.approveRun(state, journal);
}

async function integratedFeature(
  authority: IsolatedGitLifecycle,
  journal: MemoryJournal,
  runId: string,
  file: string,
): Promise<RunGitLifecycleRecord> {
  let state = await approvedRun(authority, journal, runId);
  state = await authority.openTicketCycle(state, { ticketId: "TK-feature", cycleId: "feature-1" }, journal);
  await writeFile(path.join(state.ticketCycles["feature-1"]!.worktree, "src", file), "feature\n");
  state = await authority.commitTicketCandidate(
    state,
    { cycleId: "feature-1", scope: sourceScope, subject: "feature candidate" },
    journal,
  );
  const published = await authority.publishTicketCandidate(
    state,
    { cycleId: "feature-1", scope: sourceScope, subject: "publish feature" },
    journal,
  );
  if (published.status !== "integrated") throw new Error("expected feature integration");
  return published.lifecycle;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-isolated-git-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "koni@example.invalid");
  await git(root, "config", "user.name", "Koni Test");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "README.md"), "initial\n");
  await writeFile(path.join(root, "src", "base.ts"), "base\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}

async function refs(root: string): Promise<string[]> {
  const output = await gitOutput(root, "for-each-ref", "--format=%(refname):%(objectname)", "refs/heads");
  return output.length === 0 ? [] : output.split("\n").sort();
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await readFile(candidate);
    return true;
  } catch {
    try {
      await gitOutput(candidate, "rev-parse", "--git-dir");
      return true;
    } catch {
      return false;
    }
  }
}

async function git(cwd: string, ...argv: string[]): Promise<void> {
  await gitOutput(cwd, ...argv);
}

function gitOutput(
  cwd: string,
  ...input: Array<string | readonly number[]>
): Promise<string> {
  const maybeCodes = input.at(-1);
  const accepted = Array.isArray(maybeCodes) ? maybeCodes : [0];
  const argv = (Array.isArray(maybeCodes) ? input.slice(0, -1) : input) as string[];
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...argv], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== null && accepted.includes(code)) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
  });
}
