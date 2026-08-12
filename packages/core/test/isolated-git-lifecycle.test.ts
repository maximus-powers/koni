import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertGitLifecycleIntent,
  assertRunGitLifecycleRecord,
  IsolatedGitLifecycle,
  type GitIntentJournal,
  type GitIntentSettlement,
  type GitLifecycleIntent,
  type GitEffectFaultPoint,
  type RunGitLifecycleRecord,
} from "../src/git/lifecycle.js";
import { GitClient } from "../src/git/client.js";
import {
  compileGitBehaviorPolicy,
  createGitRunTemplateContext,
  resolveLegacyPolicyWorktreeRoot,
  resolveRepositoryWorktreeNamespaceRoot,
  type GitBehaviorPolicy,
  type GitRunAdmission,
  type GitTicketTemplateContext,
} from "../src/git/behavior-policy.js";
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

  it("plans a run from the committed tip of a dirty checked-out target without touching its work", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    await writeFile(path.join(root, ".koni-local"), "uncommitted profile\n", "utf8");
    await writeFile(path.join(root, "scratch.txt"), "work in progress\n", "utf8");
    let state = await authority.planRun(
      "run-dirty-target",
      "refs/heads/main",
      admission("run-dirty-target"),
    );
    expect(state.target.selectedOid).toBe(await gitOutput(root, "rev-parse", "refs/heads/main"));
    expect((await refs(root)).some((ref) => ref.includes("run-dirty-target"))).toBe(false);
    state = await authority.materializePlanning(state, new MemoryJournal());
    expect(await gitOutput(state.planning.worktree, "rev-parse", "HEAD")).toBe(
      state.target.selectedOid,
    );
    await expect(
      readFile(path.join(state.planning.worktree, "scratch.txt"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, "scratch.txt"), "utf8")).toBe("work in progress\n");
    expect(await readFile(path.join(root, ".koni-local"), "utf8")).toBe("uncommitted profile\n");
    const dirty = await authority.inspectDirtyTargetCheckout("refs/heads/main");
    expect(dirty?.paths).toEqual([".koni-local", "scratch.txt"]);
    expect(await realpath(dirty!.worktree)).toBe(await realpath(root));
    expect(await authority.inspectDirtyTargetCheckout("refs/heads/missing")).toBeUndefined();
  });

  it("admits compiler-owned worktrees when Koni is launched from a linked checkout", async () => {
    const root = await repository();
    const linkedParent = await mkdtemp(path.join(tmpdir(), "koni-linked-caller-"));
    roots.push(linkedParent);
    const linked = path.join(linkedParent, "checkout");
    await git(root, "worktree", "add", "-b", "linked-caller", linked, "main");
    const authority = lifecycle(linked);
    const journal = new MemoryJournal();

    let state = await authority.planRun(
      "run-linked-caller",
      "refs/heads/main",
      admission("run-linked-caller"),
    );
    state = await authority.materializePlanning(state, journal);

    expect(state.projectRoot).toBe(await gitOutput(linked, "rev-parse", "--show-toplevel"));
    expect(state.namespace.root.split(path.sep)).not.toContain(".git");
    expect(path.relative(root, state.namespace.root).startsWith("..")).toBe(true);
    expect(await gitOutput(state.planning.worktree, "rev-parse", "HEAD")).toBe(
      state.target.selectedOid,
    );
  });

  it("keeps new worktrees outside developer-tool .git deny patterns", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await authority.planRun(
      "run-developer-tool-compatible",
      "refs/heads/main",
      admission("run-developer-tool-compatible"),
    );
    state = await authority.materializePlanning(state, journal);

    const defaultGitDeny = /(?:^|[\\/])\.git(?:[\\/]|$)/u;
    expect(defaultGitDeny.test(state.namespace.root)).toBe(false);
    expect(defaultGitDeny.test(state.planning.worktree)).toBe(false);
    expect(await readFile(path.join(state.planning.worktree, "src", "base.ts"), "utf8")).toBe(
      "base\n",
    );
  });

  it("keeps planning detached and creates the first permanent run ref only on approval", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await authority.planRun(
      "run-planning",
      "refs/heads/main",
      admission("run-planning"),
    );
    const refsBefore = await refs(root);

    state = await authority.materializePlanning(state, journal);
    expect(await refs(root)).toEqual(refsBefore);
    expect(await gitOutput(state.planning.worktree, "symbolic-ref", "-q", "HEAD", [0, 1])).toBe("");
    expect(await gitOutput(state.planning.worktree, "rev-parse", "HEAD")).toBe(
      state.target.selectedOid,
    );
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
    const ownedRoot = resolveRepositoryWorktreeNamespaceRoot(
      await realpath(path.join(root, ".git")),
    );
    await mkdir(path.dirname(ownedRoot), { recursive: true });
    await symlink(external, ownedRoot);
    const authority = lifecycle(root);
    await expect(
      authority.planRun("run-symlink", "refs/heads/main", admission("run-symlink")),
    ).rejects.toMatchObject({
      code: "ownership_mismatch",
    });
    expect(await exists(path.join(external, ".koni-worktrees", "default"))).toBe(false);
  });

  it("requires policy admission and resolves different templates to different exact owned namespaces", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    await expect(authority.planRun("run-missing-policy", "refs/heads/main")).rejects.toMatchObject({
      code: "invalid_state",
    });

    const alpha = await authority.planRun(
      "run-alpha",
      "refs/heads/main",
      admission("run-alpha", policy("squash", "alpha")),
    );
    const beta = await authority.planRun(
      "run-beta",
      "refs/heads/main",
      admission("run-beta", policy("squash", "beta")),
    );
    expect(alpha.namespace.runRef).toBe("refs/heads/koni/alpha/runs/run-alpha");
    expect(beta.namespace.runRef).toBe("refs/heads/koni/beta/runs/run-beta");
    expect(alpha.namespace.root).toContain("/.koni-worktrees/alpha/runs/koni/alpha/runs/run-alpha");
    expect(beta.namespace.root).toContain("/.koni-worktrees/beta/runs/koni/beta/runs/run-beta");
    expect(alpha.namespace.root.split(path.sep)).not.toContain(".git");
    expect(beta.namespace.root.split(path.sep)).not.toContain(".git");
    expect(alpha.namespace.root).not.toBe(beta.namespace.root);
  });

  it("keeps the explicit operator target authoritative over the profile default", async () => {
    const root = await repository();
    await git(root, "branch", "feature-target");
    const selectedPolicy = compiledPolicy(
      {
        branch_template: "koni/default-target/runs/{{ run.id }}",
        ticket_branch_template:
          "koni/default-target/tickets/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}",
      },
      "main",
    );
    expect(selectedPolicy.targetSelection.default).toEqual({ ref: "refs/heads/main" });
    const state = await lifecycle(root).planRun(
      "run-feature-target",
      "refs/heads/feature-target",
      admission("run-feature-target", selectedPolicy),
    );
    expect(state.target.ref).toBe("refs/heads/feature-target");
    expect(state.target.selectedOid).toBe(
      await gitOutput(root, "rev-parse", "refs/heads/feature-target"),
    );
  });

  it("rejects rendered ref prefix collisions before journaling or creating a ticket ref", async () => {
    const root = await repository();
    const refsBefore = await refs(root);
    const compiled = compileGitBehaviorPolicy({
      profileGit: {
        enabled: true,
        backend: "git_cli",
        integration_branch: "current",
        ticket_branch_template: "koni/collision/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}",
        worktree_root: ".koni-worktrees/collision",
        integration_strategy: "squash",
        commit_template: "{{ ticket.operation }}: {{ ticket.title }}",
        commit_trailers: {},
      },
      runTypeGit: {
        branch_template: "koni/collision/{{ run.id }}",
        ticket_branch_template: "koni/collision/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}",
      },
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) throw new Error("expected policy collision rejection");
    expect(compiled.diagnostics.map((item) => item.message).join(" ")).toContain("leaf/prefix");
    expect(await refs(root)).toEqual(refsBefore);
  });

  it("pins policy and resolved namespace so later profile changes cannot rewrite an active run", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    const alphaPolicy = policy("squash", "pinned-alpha");
    const betaPolicy = policy("merge", "future-beta");
    let state = await authority.planRun(
      "run-policy-pinned",
      "refs/heads/main",
      admission("run-policy-pinned", alphaPolicy),
    );
    const namespace = structuredClone(state.namespace);
    const policyHash = state.policy!.policySha256;
    state = await authority.materializePlanning(JSON.parse(JSON.stringify(state)), journal);
    state = await authority.approveRun(state, journal);
    state = await authority.openTicketCycle(state, ticket("TK-pinned", "cycle-pinned"), journal);

    expect(betaPolicy.policySha256).not.toBe(policyHash);
    expect(state.policy!.policySha256).toBe(policyHash);
    expect(state.namespace).toEqual(namespace);
    expect(state.run.branchRef).toBe("refs/heads/koni/pinned-alpha/runs/run-policy-pinned");
    expect(state.ticketCycles["cycle-pinned"]!.branchRef).toBe(
      "refs/heads/koni/pinned-alpha/tickets/run-policy-pinned/TK-pinned/cycle-pinned",
    );
    expect(state.ticketCycles["cycle-pinned"]!.worktree).toContain(
      "/.koni-worktrees/pinned-alpha/",
    );
  });

  it("round-trips a no-policy legacy record and preserves its historical refs, paths, and promotion mode", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await legacyPlannedRecord(root, "run-legacy-policy");
    const bytes = JSON.stringify(state);
    state = JSON.parse(bytes) as RunGitLifecycleRecord;
    assertRunGitLifecycleRecord(state);
    expect(JSON.stringify(state)).toBe(bytes);
    expect(state.policy).toBeUndefined();
    expect(state.namespace.runRef).toBe("refs/heads/koni/runs/run-legacy-policy");
    expect(state.namespace.root).toContain("/koni/worktrees/runs/run-legacy-policy");

    state = await authority.materializePlanning(state, journal);
    state = await authority.approveRun(state, journal);
    state = await authority.openTicketCycle(
      state,
      { ticketId: "TK-legacy", cycleId: "cycle-legacy" },
      journal,
    );
    expect(state.ticketCycles["cycle-legacy"]!.branchRef).toBe(
      "refs/heads/koni/tickets/run-legacy-policy/TK-legacy/cycles/cycle-legacy",
    );
    await writeFile(
      path.join(state.ticketCycles["cycle-legacy"]!.worktree, "src", "legacy.ts"),
      "legacy\n",
    );
    state = await authority.commitTicketCandidate(
      state,
      { cycleId: "cycle-legacy", scope: sourceScope, subject: "legacy candidate" },
      journal,
    );
    const published = await authority.publishTicketCandidate(
      state,
      { cycleId: "cycle-legacy", scope: sourceScope, subject: "legacy publish" },
      journal,
    );
    if (published.status !== "integrated") throw new Error("expected legacy integration");
    const prepared = await authority.prepareTargetPromotion(published.lifecycle, {
      subject: "legacy promotion",
    });
    if (prepared.preparation.status !== "ready") throw new Error("expected legacy promotion");
    state = await authority.publishTargetPromotion(prepared.lifecycle, journal);
    expect(state.promotion!.candidateOid).toBe(state.run.headOid);
    expect(await gitOutput(root, "rev-parse", "refs/heads/main")).toBe(state.run.headOid);
  }, 15_000);

  it("shares one checkout across a ticket cycle and publishes one scoped squash commit", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-ticket");
    state = await authority.openTicketCycle(state, ticket("TK-1", "cycle-1"), journal);
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
    expect(await readFile(path.join(state.run.worktree, "src", "feature.ts"), "utf8")).toBe(
      "export const feature = true;\n",
    );
    expect(await gitOutput(root, "rev-list", "--parents", "-n", "1", state.run.headOid!)).toBe(
      `${state.run.headOid} ${priorRun}`,
    );
    expect(state.run.headOid).not.toBe(ticketHead);
    expect(await gitOutput(state.run.worktree, "status", "--porcelain")).toBe("");
  });

  it("authenticates the exact former policy-backed layout without selecting it for new runs", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await authority.planRun(
      "run-legacy-policy-layout",
      "refs/heads/main",
      admission("run-legacy-policy-layout"),
    );
    const branch = state.namespace.runRef.slice("refs/heads/".length);
    const legacyRoot = path.join(
      resolveLegacyPolicyWorktreeRoot(state.commonDirectory, state.policy!),
      "runs",
      ...branch.split("/"),
    );
    state.namespace = {
      root: legacyRoot,
      runRef: state.namespace.runRef,
      planningWorktree: path.join(legacyRoot, "planning"),
      runWorktree: path.join(legacyRoot, "integration"),
      ticketRoot: path.join(legacyRoot, "tickets"),
    };
    state.planning.worktree = state.namespace.planningWorktree;
    state.run.worktree = state.namespace.runWorktree;

    assertRunGitLifecycleRecord(JSON.parse(JSON.stringify(state)));
    state = await authority.materializePlanning(state, journal);
    expect(state.namespace.root.split(path.sep)).toContain(".git");
    expect(await gitOutput(state.planning.worktree, "rev-parse", "HEAD")).toBe(
      state.target.selectedOid,
    );
  });

  it("renders commit policy from persisted ticket context and ignores caller-supplied copy", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    const selectedPolicy = compiledPolicy(
      {
        branch_template: "koni/commits/runs/{{ run.id }}",
        ticket_branch_template: "koni/commits/tickets/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}",
      },
      "current",
      "merge",
      { "Review-Id": "{{ review.id }}", "Profile-Hash": "{{ profile.hash }}" },
    );
    let state = await approvedRun(authority, journal, "run-commit-policy", selectedPolicy);
    state = await authority.openTicketCycle(
      state,
      {
        ticketId: "TK-commit",
        cycleId: "cycle-commit",
        templateContext: {
          id: "TK-commit",
          cycleId: "cycle-commit",
          operation: "feature",
          title: "Policy rendered subject",
        },
      },
      journal,
    );
    const checkout = state.ticketCycles["cycle-commit"]!.worktree;
    await writeFile(path.join(checkout, "src", "commit-policy.ts"), "policy\n");
    state = await authority.commitTicketCandidate(
      state,
      { cycleId: "cycle-commit", scope: sourceScope, subject: "CALLER MUST NOT WIN" },
      journal,
    );
    const ticketHead = state.ticketCycles["cycle-commit"]!.ticketHeadOid;
    const candidateMessage = await gitOutput(root, "show", "-s", "--format=%B", ticketHead);
    expect(candidateMessage).toContain("feature: Policy rendered subject");
    expect(candidateMessage).not.toContain("CALLER MUST NOT WIN");
    expect(candidateMessage).not.toContain("Review-Id:");

    const published = await authority.publishTicketCandidate(
      state,
      {
        cycleId: "cycle-commit",
        scope: sourceScope,
        subject: "CALLER STILL MUST NOT WIN",
        reviewId: "review-exact",
      },
      journal,
    );
    if (published.status !== "integrated") throw new Error("expected integration");
    const runHead = published.lifecycle.run.headOid!;
    const publicationMessage = await gitOutput(root, "show", "-s", "--format=%B", runHead);
    expect(publicationMessage).toContain("feature: Policy rendered subject");
    expect(publicationMessage).toContain("Review-Id: review-exact");
    expect(publicationMessage).toContain(`Profile-Hash: sha256:${"a".repeat(64)}`);
    expect(publicationMessage).not.toContain("CALLER STILL MUST NOT WIN");
    expect(parentCount(await gitOutput(root, "rev-list", "--parents", "-n", "1", runHead))).toBe(2);
  });

  it("rejects out-of-scope and compiler-owned edits before checkpointing", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-scope");
    state = await authority.openTicketCycle(state, ticket("TK-scope", "scope-1"), journal);
    const checkout = state.ticketCycles["scope-1"]!.worktree;
    await writeFile(path.join(checkout, "README.md"), "unauthorized\n");
    await expect(
      authority.commitTicketCandidate(
        state,
        { cycleId: "scope-1", scope: sourceScope, subject: "bad edit" },
        journal,
      ),
    ).rejects.toMatchObject({ code: "scope_violation" });
    await git(checkout, "checkout", "--", "README.md");
    await mkdir(path.join(checkout, "src", "generated"));
    await writeFile(path.join(checkout, "src", "generated", "authority.ts"), "bad\n");
    await expect(
      authority.commitTicketCandidate(
        state,
        { cycleId: "scope-1", scope: sourceScope, subject: "bad authority edit" },
        journal,
      ),
    ).rejects.toMatchObject({ code: "scope_violation" });
    expect(await exists(path.join(checkout, "src", "generated", "authority.ts"))).toBe(true);
  });

  it("reports concurrent ticket conflicts without leaving either checkout conflicted", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-conflicts");
    state = await authority.openTicketCycle(state, ticket("TK-A", "A-1"), journal);
    state = await authority.openTicketCycle(state, ticket("TK-B", "B-1"), journal);
    for (const [cycle, contents] of [
      ["A-1", "from A\n"],
      ["B-1", "from B\n"],
    ] as const) {
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
    expect(await readFile(path.join(state.run.worktree, "src", "base.ts"), "utf8")).toBe(
      "from A\n",
    );
  }, 15_000);

  it("rejects a moved run ref under CAS without altering the ticket candidate", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-moved");
    state = await authority.openTicketCycle(state, ticket("TK-M", "M-1"), journal);
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
    await expect(
      authority.publishTicketCandidate(
        state,
        { cycleId: "M-1", scope: sourceScope, subject: "must reject" },
        journal,
      ),
    ).rejects.toMatchObject({ code: "ref_moved" });
    expect(await gitOutput(root, "rev-parse", state.ticketCycles["M-1"]!.branchRef)).toBe(
      ticketHead,
    );
    expect(await readFile(path.join(ticketWorktree, "src", "candidate.ts"), "utf8")).toBe(
      "candidate\n",
    );
  });

  it("allocates auditable reissue cycles and preserves dirty retired work", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-reissue");
    state = await authority.openTicketCycle(state, ticket("TK-X", "X-1"), journal);
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

    state = await authority.openTicketCycle(state, ticket("TK-X", "X-2"), journal);
    expect(state.ticketCycles["X-2"]!.ordinal).toBe(2);
    expect(state.ticketCycles["X-2"]!.worktree).not.toBe(firstPath);
    expect(state.ticketCycles["X-2"]!.branchRef).not.toBe(state.ticketCycles["X-1"]!.branchRef);
  });

  it("keeps target promotion explicit, rejects target movement, and never overwrites a dirty target checkout", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await integratedFeature(authority, journal, "run-promotion", "promote.ts");
    state = await synchronized(authority, state, journal);
    let prepared = await authority.prepareTargetPromotion(state, { subject: "merge run" });
    state = prepared.lifecycle;
    expect(prepared.preparation.status).toBe("ready");

    await writeFile(path.join(root, "operator.txt"), "do not delete\n");
    await expect(authority.publishTargetPromotion(state, journal)).rejects.toMatchObject({
      code: "dirty_checkout",
    });
    expect(await readFile(path.join(root, "operator.txt"), "utf8")).toBe("do not delete\n");
    await unlink(path.join(root, "operator.txt"));

    await mkdir(path.join(root, ".koni"), { recursive: true });
    await writeFile(path.join(root, ".koni", "project.yaml"), "profile: local\n");
    await git(root, "add", ".koni/project.yaml");
    await git(root, "commit", "-m", "track project profile");
    state = await synchronized(authority, state, journal);
    prepared = await authority.prepareTargetPromotion(state, { subject: "merge tracked config" });
    state = prepared.lifecycle;
    await writeFile(path.join(root, ".koni", "project.yaml"), "profile: changed locally\n");
    await expect(authority.publishTargetPromotion(state, journal)).rejects.toMatchObject({
      code: "dirty_checkout",
    });
    expect(await readFile(path.join(root, ".koni", "project.yaml"), "utf8")).toBe(
      "profile: changed locally\n",
    );
    await writeFile(path.join(root, ".koni", "project.yaml"), "profile: local\n");

    await writeFile(path.join(root, "target-only.txt"), "target moved\n");
    await git(root, "add", "target-only.txt");
    await git(root, "commit", "-m", "move target");
    await expect(authority.publishTargetPromotion(state, journal)).rejects.toMatchObject({
      code: "ref_moved",
    });
    expect(await gitOutput(root, "show", "HEAD:target-only.txt")).toBe("target moved");

    await expect(
      authority.prepareTargetPromotion(state, { subject: "merge updated target" }),
    ).rejects.toThrow("advanced after target_sync");
    state = await synchronized(authority, state, journal);
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
    state = await authority.openTicketCycle(state, ticket("TK-C", "C-1"), journal);
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
    const synchronizedResult = await authority.synchronizeTargetIntoRun(
      state,
      { subject: "conflicting merge" },
      journal,
    );
    expect(synchronizedResult.status).toBe("integration_required");
    expect(await gitOutput(root, "rev-parse", "HEAD")).toBe(targetBefore);
    expect(await gitOutput(root, "status", "--porcelain")).toBe("");
  });

  it("materializes both sides of a conflicted candidate in a clean integration checkout", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-ticket-conflict-preview");

    await writeFile(path.join(root, "src", "base.ts"), "candidate\n");
    await writeFile(path.join(root, "src", "candidate-only.ts"), "candidate only\n");
    await git(root, "add", "src/base.ts", "src/candidate-only.ts");
    await git(root, "commit", "-m", "candidate side");
    const candidateOid = await gitOutput(root, "rev-parse", "HEAD");

    state = await authority.openTicketCycle(state, ticket("TK-run", "run-1"), journal);
    await writeFile(path.join(state.ticketCycles["run-1"]!.worktree, "src", "base.ts"), "run\n");
    state = await authority.commitTicketCandidate(
      state,
      { cycleId: "run-1", scope: sourceScope, subject: "run side" },
      journal,
    );
    const published = await authority.publishTicketCandidate(
      state,
      { cycleId: "run-1", scope: sourceScope, subject: "publish run side" },
      journal,
    );
    if (published.status !== "integrated") throw new Error("expected run-side integration");
    state = published.lifecycle;

    state = await authority.openTicketCycle(
      state,
      {
        ...ticket("TK-integrate", "integrate-1"),
        integrationCandidateOid: candidateOid,
      },
      journal,
    );
    const cycle = state.ticketCycles["integrate-1"]!;
    const conflicted = await readFile(path.join(cycle.worktree, "src", "base.ts"), "utf8");
    expect(conflicted).toContain("<<<<<<<");
    expect(conflicted).toContain("run");
    expect(conflicted).toContain("candidate");
    expect(conflicted).toContain(">>>>>>>");
    expect(await readFile(path.join(cycle.worktree, "src", "candidate-only.ts"), "utf8")).toBe(
      "candidate only\n",
    );
    expect(await gitOutput(cycle.worktree, "status", "--porcelain")).toBe("");
    expect(cycle.baseRunOid).toBe(state.run.headOid);
    expect(cycle.ticketHeadOid).not.toBe(cycle.baseRunOid);
  });

  it("recovers target_sync by exact CAS and replays the synchronized state across restart", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await integratedFeature(healthy, journal, "run-sync-recovery", "sync-run.ts");
    await writeFile(path.join(root, "target-sync.ts"), "target\n");
    await git(root, "add", "target-sync.ts");
    await git(root, "commit", "-m", "advance target before sync");
    const targetOid = await gitOutput(root, "rev-parse", "HEAD");
    const priorRunOid = state.run.headOid!;
    const crashing = lifecycle(root, (point) => {
      if (point === "after_target_sync_ref") throw new Error("target sync settlement crash");
    });
    await expect(
      crashing.synchronizeTargetIntoRun(state, { subject: "sync crash recovery" }, journal),
    ).rejects.toThrow("target sync settlement crash");
    const intent = onlyPending(journal);
    expect(intent.kind).toBe("target_sync");

    const recovered = await healthy.recoverIntent(state, intent, journal);
    expect(recovered.status).toBe("completed");
    state = recovered.lifecycle;
    expect(state.targetSynchronization).toMatchObject({
      status: "synchronized",
      priorRunOid,
      targetOid,
      runOid: state.run.headOid,
    });
    const serialized = JSON.stringify(state);
    const settlements = journal.settlements.length;
    const replay = await healthy.synchronizeTargetIntoRun(
      structuredClone(state),
      { subject: "must replay" },
      journal,
    );
    expect(replay.status).toBe("synchronized");
    expect(JSON.stringify(replay.lifecycle)).toBe(serialized);
    expect(journal.settlements).toHaveLength(settlements);
    expect(await gitOutput(state.run.worktree, "status", "--porcelain")).toBe("");
  }, 15_000);

  it("applies the pinned squash versus merge strategy to ticket and final target ancestry", async () => {
    const results: Record<string, { ticketParents: number; targetParents: number }> = {};
    for (const strategy of ["squash", "merge"] as const) {
      const root = await repository();
      const authority = lifecycle(root);
      const journal = new MemoryJournal();
      const selectedPolicy = policy(strategy, strategy);
      let state = await integratedFeature(
        authority,
        journal,
        `run-${strategy}`,
        `${strategy}-feature.ts`,
        selectedPolicy,
      );
      const ticketCommit = state.run.headOid!;
      await writeFile(path.join(root, `${strategy}-target.ts`), "target\n");
      await git(root, "add", `${strategy}-target.ts`);
      await git(root, "commit", "-m", `${strategy} target advance`);
      state = await synchronized(authority, state, journal);
      const prepared = await authority.prepareTargetPromotion(state, {
        subject: `${strategy} final promotion`,
      });
      if (prepared.preparation.status !== "ready") throw new Error("expected ready promotion");
      state = await authority.publishTargetPromotion(prepared.lifecycle, journal);
      results[strategy] = {
        ticketParents: parentCount(
          await gitOutput(root, "rev-list", "--parents", "-n", "1", ticketCommit),
        ),
        targetParents: parentCount(
          await gitOutput(root, "rev-list", "--parents", "-n", "1", state.promotion!.candidateOid!),
        ),
      };
    }
    expect(results.squash).toEqual({ ticketParents: 1, targetParents: 1 });
    expect(results.merge).toEqual({ ticketParents: 2, targetParents: 2 });
  }, 20_000);

  it("recognizes a completed target checkout after a crash and preserves later operator work", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await integratedFeature(
      healthy,
      journal,
      "run-target-recovery",
      "target-recovery.ts",
    );
    state = await synchronized(healthy, state, journal);
    const prepared = await healthy.prepareTargetPromotion(state, { subject: "target recovery" });
    if (prepared.preparation.status !== "ready") throw new Error("expected promotion");
    state = prepared.lifecycle;
    const crashing = lifecycle(root, (point) => {
      if (point === "after_target_checkout") throw new Error("target settlement crash");
    });
    await expect(crashing.publishTargetPromotion(state, journal)).rejects.toThrow(
      "target settlement crash",
    );
    await writeFile(path.join(root, "operator-after-publish.txt"), "keep later work\n");
    const recovered = await healthy.recoverIntent(state, onlyPending(journal), journal);
    expect(recovered.status).toBe("completed");
    expect(recovered.lifecycle.promotion?.status).toBe("published");
    expect(await readFile(path.join(root, "operator-after-publish.txt"), "utf8")).toBe(
      "keep later work\n",
    );
  });

  it("recovers crash-forward approval and publication intents from exact state", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    let crashPoint = "after_run_ref";
    const crashing = lifecycle(root, (point) => {
      if (point === crashPoint) throw new Error(`simulated crash at ${point}`);
    });
    let state = await crashing.planRun(
      "run-recovery",
      "refs/heads/main",
      admission("run-recovery"),
    );
    state = await crashing.materializePlanning(state, journal);
    await expect(crashing.approveRun(state, journal)).rejects.toThrow("simulated crash");
    const approvalIntent = onlyPending(journal);
    const healthy = lifecycle(root);
    let recovered = await healthy.recoverIntent(state, approvalIntent, journal);
    expect(recovered.status).toBe("completed");
    state = recovered.lifecycle;
    expect(state.run.status).toBe("ready");
    expect(await exists(state.planning.worktree)).toBe(false);

    state = await healthy.openTicketCycle(state, ticket("TK-R", "R-1"), journal);
    await writeFile(path.join(state.ticketCycles["R-1"]!.worktree, "src", "recovery.ts"), "ok\n");
    state = await healthy.commitTicketCandidate(
      state,
      { cycleId: "R-1", scope: sourceScope, subject: "recovery candidate" },
      journal,
    );
    crashPoint = "after_run_publish_ref";
    await expect(
      crashing.publishTicketCandidate(
        state,
        { cycleId: "R-1", scope: sourceScope, subject: "recovery publish" },
        journal,
      ),
    ).rejects.toThrow("simulated crash");
    const publishIntent = onlyPending(journal);
    recovered = await healthy.recoverIntent(state, publishIntent, journal);
    expect(recovered.status).toBe("completed");
    state = recovered.lifecycle;
    expect(await readFile(path.join(state.run.worktree, "src", "recovery.ts"), "utf8")).toBe(
      "ok\n",
    );
    expect(await gitOutput(state.run.worktree, "status", "--porcelain")).toBe("");
  });

  it("records failed publication compensation as a forward commit and recovers it exactly once", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await approvedRun(healthy, journal, "run-forward-compensation");
    state = await healthy.openTicketCycle(state, ticket("TK-F", "F-1"), journal);
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
      if (point === "after_forward_compensation_ref")
        throw new Error("compensation settlement crash");
    });
    await expect(
      failing.publishTicketCandidate(
        state,
        { cycleId: "F-1", scope: sourceScope, subject: "publish forward candidate" },
        journal,
      ),
    ).rejects.toThrow("compensation settlement crash");

    const compensationIntent = onlyPending(journal);
    expect(compensationIntent.kind).toBe("forward_compensation");
    if (compensationIntent.kind !== "forward_compensation") {
      throw new Error("expected forward compensation intent");
    }
    const compensationOid = await gitOutput(root, "rev-parse", compensationIntent.reference);
    expect(compensationOid).not.toBe(priorOid);
    expect(compensationOid).not.toBe(compensationIntent.candidateOid);
    expect(await gitOutput(root, "rev-list", "--parents", "-n", "1", compensationOid)).toBe(
      `${compensationOid} ${compensationIntent.candidateOid}`,
    );
    expect(await gitOutput(root, "show", "-s", "--format=%T", compensationOid)).toBe(
      await gitOutput(root, "show", "-s", "--format=%T", priorOid),
    );
    await git(
      root,
      "merge-base",
      "--is-ancestor",
      compensationIntent.candidateOid,
      compensationOid,
    );

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
    expect(await gitOutput(root, "rev-list", "--count", `${priorOid}..${compensationOid}`)).toBe(
      "2",
    );
  });

  it("preserves ambiguous work added after a publication crash instead of resetting it", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await approvedRun(healthy, journal, "run-preserve-crash");
    state = await healthy.openTicketCycle(state, ticket("TK-P", "P-1"), journal);
    await writeFile(
      path.join(state.ticketCycles["P-1"]!.worktree, "src", "planned.ts"),
      "planned\n",
    );
    state = await healthy.commitTicketCandidate(
      state,
      { cycleId: "P-1", scope: sourceScope, subject: "planned candidate" },
      journal,
    );
    const crashing = lifecycle(root, (point) => {
      if (point === "after_run_publish_ref") throw new Error("publication crash");
    });
    await expect(
      crashing.publishTicketCandidate(
        state,
        { cycleId: "P-1", scope: sourceScope, subject: "publish planned" },
        journal,
      ),
    ).rejects.toThrow("publication crash");
    const intent = onlyPending(journal);
    expect(intent.kind).toBe("ticket_publish");
    if (intent.kind !== "ticket_publish") throw new Error("expected ticket publication intent");
    await writeFile(path.join(state.run.worktree, "operator-recovery.txt"), "preserve this\n");
    const recovered = await healthy.recoverIntent(state, intent, journal);
    expect(recovered.status).toBe("preserved");
    expect(await readFile(path.join(state.run.worktree, "operator-recovery.txt"), "utf8")).toBe(
      "preserve this\n",
    );
    expect(recovered.lifecycle.ticketCycles["P-1"]!.status).toBe("preserved");
    expect(journal.pending.size).toBe(0);
    expect(journal.settlements.at(-1)?.status).toBe("blocked");
    expect(journal.settlements.at(-1)?.compensation?.compensationOid).toBeUndefined();
    expect(await gitOutput(root, "rev-parse", intent.runRef)).toBe(intent.squashCommitOid);
    expect(
      await gitOutput(state.run.worktree, "status", "--porcelain", "--untracked-files=all"),
    ).toContain("operator-recovery.txt");
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
    await expect(crashing.retireTicketCycle(state, cycleId, journal)).rejects.toThrow(
      "cleanup crash",
    );
    expect(await exists(cycle.worktree)).toBe(false);
    expect(await gitOutput(root, "rev-parse", cycle.branchRef)).toBe(cycle.ticketHeadOid);
    const recovered = await healthy.recoverIntent(state, onlyPending(journal), journal);
    expect(recovered.status).toBe("completed");
    state = recovered.lifecycle;
    expect(state.ticketCycles[cycleId]!.status).toBe("retired");
    await expect(gitOutput(root, "rev-parse", "--verify", cycle.branchRef)).rejects.toThrow();
  });

  it("checkpoints and archives exact ticket bytes before a fresh supersession cycle", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-supersede");
    state = await authority.openTicketCycle(state, ticket("TK-change", "change-1"), journal);
    const runHead = state.run.headOid!;
    const targetHead = await gitOutput(root, "rev-parse", "refs/heads/main");
    const priorCycle = structuredClone(state.ticketCycles["change-1"]!);
    await writeFile(path.join(priorCycle.worktree, "src", "superseded.ts"), "preserved bytes\n");
    const authoritySha256 = `sha256:${"b".repeat(64)}`;

    state = await authority.supersedeTicketCycle(
      state,
      {
        cycleId: "change-1",
        scope: sourceScope,
        subject: "archive superseded ticket",
        supersessionSha256: authoritySha256,
      },
      journal,
    );

    const retired = state.ticketCycles["change-1"]!;
    expect(retired).toMatchObject({
      status: "retired",
      supersessionSha256: authoritySha256,
      supersededAt: retired.retiredAt,
    });
    expect(retired.archiveRef).toBe(
      supersessionRef(state.runId, retired.ticketId, retired.cycleId, authoritySha256),
    );
    expect(await gitOutput(root, "show", `${retired.archiveRef}:src/superseded.ts`)).toBe(
      "preserved bytes",
    );
    expect(await exists(priorCycle.worktree)).toBe(false);
    await expect(gitOutput(root, "rev-parse", "--verify", priorCycle.branchRef)).rejects.toThrow();
    expect(await gitOutput(root, "rev-parse", state.run.branchRef)).toBe(runHead);
    expect(await gitOutput(root, "rev-parse", "refs/heads/main")).toBe(targetHead);

    const replayed = await authority.supersedeTicketCycle(
      state,
      {
        cycleId: "change-1",
        scope: sourceScope,
        subject: "must replay",
        supersessionSha256: authoritySha256,
      },
      journal,
    );
    expect(replayed).toEqual(state);
    state = await authority.openTicketCycle(state, ticket("TK-change", "change-2"), journal);
    expect(state.ticketCycles["change-2"]).toMatchObject({
      ticketId: "TK-change",
      status: "active",
      baseRunOid: runHead,
      ticketHeadOid: runHead,
    });
  });

  it.each([
    "after_ticket_supersession_archive",
    "after_ticket_supersession_worktree_retired",
    "after_ticket_supersession_ref_retired",
  ] as const)("recovers ticket supersession after %s", async (faultPoint) => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await approvedRun(healthy, journal, `run-${faultPoint}`);
    state = await healthy.openTicketCycle(state, ticket("TK-recover", "recover-1"), journal);
    await writeFile(
      path.join(state.ticketCycles["recover-1"]!.worktree, "src", "recover.ts"),
      `${faultPoint}\n`,
    );
    const crashing = lifecycle(root, (point) => {
      if (point === faultPoint) throw new Error(`crash at ${faultPoint}`);
    });
    const authoritySha256 = `sha256:${"c".repeat(64)}`;
    await expect(
      crashing.supersedeTicketCycle(
        state,
        {
          cycleId: "recover-1",
          scope: sourceScope,
          subject: "checkpoint before recovery",
          supersessionSha256: authoritySha256,
        },
        journal,
      ),
    ).rejects.toThrow(`crash at ${faultPoint}`);

    const intent = onlyPending(journal);
    expect(intent.kind).toBe("ticket_supersede");
    const durableCheckpoint = structuredClone(journal.settlements.at(-1)!.lifecycle);
    const recovered = await healthy.recoverIntent(durableCheckpoint, intent, journal);
    expect(recovered.status).toBe("completed");
    const retired = recovered.lifecycle.ticketCycles["recover-1"]!;
    expect(retired).toMatchObject({
      status: "retired",
      archiveRef: intent.kind === "ticket_supersede" ? intent.archiveRef : undefined,
      supersessionSha256: authoritySha256,
    });
    expect(await gitOutput(root, "show", `${retired.archiveRef}:src/recover.ts`)).toBe(faultPoint);
    expect(journal.pending.size).toBe(0);
  });

  it("preserves operator work instead of completing a crashed ticket supersession", async () => {
    const root = await repository();
    const journal = new MemoryJournal();
    const healthy = lifecycle(root);
    let state = await approvedRun(healthy, journal, "run-supersede-preserve");
    state = await healthy.openTicketCycle(state, ticket("TK-preserve", "preserve-1"), journal);
    const cycle = state.ticketCycles["preserve-1"]!;
    await writeFile(path.join(cycle.worktree, "src", "before.ts"), "before\n");
    const crashing = lifecycle(root, (point) => {
      if (point === "after_ticket_supersession_archive") throw new Error("archive crash");
    });
    await expect(
      crashing.supersedeTicketCycle(
        state,
        {
          cycleId: cycle.cycleId,
          scope: sourceScope,
          subject: "preserve recovery",
          supersessionSha256: `sha256:${"d".repeat(64)}`,
        },
        journal,
      ),
    ).rejects.toThrow("archive crash");
    const intent = onlyPending(journal);
    const durableCheckpoint = structuredClone(journal.settlements.at(-1)!.lifecycle);
    await writeFile(path.join(cycle.worktree, "operator-after-crash.txt"), "do not delete\n");

    if (intent.kind !== "ticket_supersede") throw new Error("expected supersession intent");
    expect(() =>
      assertGitLifecycleIntent({
        ...intent,
        archiveRef: `${intent.archiveRef}-tampered`,
      }),
    ).toThrow("archive ref");
    expect(() =>
      assertGitLifecycleIntent({
        ...intent,
        supersessionSha256: `sha256:${"e".repeat(64)}`,
      }),
    ).toThrow("archive ref");

    const recovered = await healthy.recoverIntent(durableCheckpoint, intent, journal);
    expect(recovered.status).toBe("preserved");
    expect(recovered.lifecycle.ticketCycles[cycle.cycleId]!.status).toBe("preserved");
    expect(await readFile(path.join(cycle.worktree, "operator-after-crash.txt"), "utf8")).toBe(
      "do not delete\n",
    );
    expect(await gitOutput(root, "rev-parse", cycle.branchRef)).toBe(
      durableCheckpoint.ticketCycles[cycle.cycleId]!.ticketHeadOid,
    );
    expect(await gitOutput(root, "rev-parse", intent.archiveRef)).toBe(intent.expectedTicketOid);
  });

  it("retires an abandoned planning checkout without ever changing the target", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await authority.planRun(
      "run-abandon-planning",
      "refs/heads/main",
      admission("run-abandon-planning"),
    );
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

  it("previews clean abandoned resources deterministically without mutating Git", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await authority.planRun(
      "run-abandon-preview",
      "refs/heads/main",
      admission("run-abandon-preview"),
    );
    state = await authority.materializePlanning(state, journal);
    const targetBefore = await gitOutput(root, "rev-parse", state.target.ref);
    const refsBefore = await refs(root);

    const first = await authority.inspectAbandonedRun(state);
    const second = await authority.inspectAbandonedRun(state);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      protocol: "koni.git-abandoned-run-inspection.v1",
      runId: "run-abandon-preview",
      deleteOwnedSafe: true,
      warnings: [],
    });
    expect(first.resources).toEqual([
      expect.objectContaining({
        kind: "planning",
        id: "planning",
        refState: "not_applicable",
        worktreeState: "owned_clean",
        registered: true,
        dirtyPaths: [],
        safeToDelete: true,
      }),
    ]);
    expect(await exists(state.planning.worktree)).toBe(true);
    expect(await refs(root)).toEqual(refsBefore);
    expect(await gitOutput(root, "rev-parse", state.target.ref)).toBe(targetBefore);
  });

  it("fails a deletion preview closed on dirty and moved owned resources", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-abandon-preview-dirty");
    state = await authority.openTicketCycle(state, ticket("TK-preview", "preview-1"), journal);
    const cycle = state.ticketCycles["preview-1"]!;
    await writeFile(path.join(cycle.worktree, "dirty-preview.txt"), "preserve me\n");
    await writeFile(path.join(state.run.worktree, "src", "moved-preview.ts"), "moved\n");
    await git(state.run.worktree, "add", "src/moved-preview.ts");
    await git(state.run.worktree, "commit", "-m", "move run ref outside authority");
    const movedRunOid = await gitOutput(root, "rev-parse", state.run.branchRef);
    const targetBefore = await gitOutput(root, "rev-parse", state.target.ref);

    const preview = await authority.inspectAbandonedRun(state);
    const run = preview.resources.find((resource) => resource.kind === "run")!;
    const inspectedTicket = preview.resources.find((resource) => resource.kind === "ticket")!;

    expect(preview.deleteOwnedSafe).toBe(false);
    expect(run).toMatchObject({
      refState: "moved",
      observedRefOid: movedRunOid,
      worktreeState: "ownership_mismatch",
      safeToDelete: false,
    });
    expect(inspectedTicket).toMatchObject({
      refState: "matches",
      worktreeState: "owned_dirty",
      dirtyPaths: ["dirty-preview.txt"],
      safeToDelete: false,
    });
    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("run:run: recorded ref no longer points"),
        expect.stringContaining("ticket:preview-1: worktree has uncommitted changes"),
      ]),
    );
    expect(await readFile(path.join(cycle.worktree, "dirty-preview.txt"), "utf8")).toBe(
      "preserve me\n",
    );
    expect(await gitOutput(root, "rev-parse", state.target.ref)).toBe(targetBefore);
  });

  it("fails a deletion preview closed when unregistered data occupies an owned path", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await authority.planRun(
      "run-abandon-preview-unregistered",
      "refs/heads/main",
      admission("run-abandon-preview-unregistered"),
    );
    state = await authority.materializePlanning(state, journal);
    await git(root, "worktree", "unlock", state.planning.worktree);
    await git(root, "worktree", "remove", state.planning.worktree);
    await mkdir(state.planning.worktree, { recursive: true });
    await writeFile(path.join(state.planning.worktree, "operator-data.txt"), "keep\n");

    const preview = await authority.inspectAbandonedRun(state);

    expect(preview.deleteOwnedSafe).toBe(false);
    expect(preview.resources).toEqual([
      expect.objectContaining({
        kind: "planning",
        registered: false,
        worktreeState: "unregistered_present",
        safeToDelete: false,
      }),
    ]);
    expect(await readFile(path.join(state.planning.worktree, "operator-data.txt"), "utf8")).toBe(
      "keep\n",
    );
  });

  it("observes target movement without preparing or publishing a merge", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const state = await authority.planRun(
      "run-target-observe",
      "refs/heads/main",
      admission("run-target-observe"),
    );
    const initial = await authority.observeTargetRef(state);
    expect(initial).toEqual({
      protocol: "koni.git-target-ref-observation.v1",
      runId: state.runId,
      ref: state.target.ref,
      selectedOid: state.target.selectedOid,
      observedOid: state.target.selectedOid,
      changedSinceSelection: false,
    });

    await writeFile(path.join(root, "target-observation.txt"), "target moved\n");
    await git(root, "add", "target-observation.txt");
    await git(root, "commit", "-m", "move observed target");
    const moved = await authority.observeTargetRef(state);
    expect(moved.observedOid).not.toBe(state.target.selectedOid);
    expect(moved.changedSinceSelection).toBe(true);
    expect(await refs(root)).toContain(`refs/heads/main:${moved.observedOid}`);
  });

  it("preserves a dirty abandoned ticket and deletes none of the run namespace", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-abandon-dirty");
    state = await authority.openTicketCycle(state, ticket("TK-D", "D-1"), journal);
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
    state = await healthy.openTicketCycle(state, ticket("TK-Z", "Z-1"), journal);
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

  it("retires clean owned worktrees while preserving abandoned run branches", async () => {
    const root = await repository();
    const authority = lifecycle(root);
    const journal = new MemoryJournal();
    let state = await approvedRun(authority, journal, "run-preserve-branches");
    state = await authority.openTicketCycle(state, ticket("TK-P", "P-1"), journal);
    const cycle = state.ticketCycles["P-1"]!;

    const result = await authority.retireAbandonedRun(state, journal, {
      preserveBranches: true,
    });

    expect(result.status).toBe("retired");
    expect(await exists(cycle.worktree)).toBe(false);
    expect(await exists(state.run.worktree)).toBe(false);
    expect(await gitOutput(root, "rev-parse", cycle.branchRef)).toBe(cycle.ticketHeadOid);
    expect(await gitOutput(root, "rev-parse", state.run.branchRef)).toBe(state.run.headOid);
    expect(result.lifecycle.ticketCycles["P-1"]!.status).toBe("preserved");
    expect(result.lifecycle.run.status).toBe("preserved");
    expect(journal.pending.size).toBe(0);
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
    state = await synchronized(authority, state, journal);
    const prepared = await authority.prepareTargetPromotion(state, {
      subject: "publish cleanup run",
    });
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
    expect(
      inspectGitPathScope(
        ["app/a.ts", "app/nested/b.ts", "app/a.ts.evil", ".codex/koni/profile.yaml"],
        {
          allowed: [
            { kind: "exact", path: "app/a.ts" },
            { kind: "glob", pattern: "app/**/*.ts" },
            { kind: "prefix", path: ".codex" },
          ],
        },
      ),
    ).toEqual({
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

function policy(strategy: "squash" | "merge" = "squash", suffix = "default"): GitBehaviorPolicy {
  return compiledPolicy(
    {
      branch_template: `koni/${suffix}/runs/{{ run.id }}`,
      ticket_branch_template: `koni/${suffix}/tickets/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}`,
    },
    "current",
    strategy,
    {},
    `.koni-worktrees/${suffix}`,
  );
}

function compiledPolicy(
  refs: { branch_template: string; ticket_branch_template: string },
  integrationBranch = "current",
  strategy: "squash" | "merge" = "squash",
  commitTrailers: Readonly<Record<string, string>> = {},
  worktreeRoot = ".koni-worktrees/custom",
): GitBehaviorPolicy {
  const result = compileGitBehaviorPolicy({
    profileGit: {
      enabled: true,
      backend: "git_cli",
      integration_branch: integrationBranch,
      ticket_branch_template: refs.ticket_branch_template,
      worktree_root: worktreeRoot,
      integration_strategy: strategy,
      commit_template: "{{ ticket.operation }}: {{ ticket.title }}",
      commit_trailers: commitTrailers,
    },
    runTypeGit: refs,
  });
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join("; "));
  return result.value;
}

function admission(runId: string, selectedPolicy = policy()): GitRunAdmission {
  return {
    policy: selectedPolicy,
    run: createGitRunTemplateContext({
      id: runId,
      objective: `Test ${runId}`,
      profileHash: `sha256:${"a".repeat(64)}`,
    }),
  };
}

function ticket(
  ticketId: string,
  cycleId: string,
  reviewId?: string,
): { ticketId: string; cycleId: string; templateContext: GitTicketTemplateContext } {
  return {
    ticketId,
    cycleId,
    templateContext: {
      id: ticketId,
      cycleId,
      operation: "test",
      title: ticketId,
      ...(reviewId === undefined ? {} : { reviewId }),
    },
  };
}

function supersessionRef(
  runId: string,
  ticketId: string,
  cycleId: string,
  authoritySha256: string,
): string {
  return `refs/koni/archive/${runId}/tickets/${ticketId}/cycles/${cycleId}/${authoritySha256.slice("sha256:".length)}`;
}

async function approvedRun(
  authority: IsolatedGitLifecycle,
  journal: MemoryJournal,
  runId: string,
  selectedPolicy = policy(),
): Promise<RunGitLifecycleRecord> {
  let state = await authority.planRun(runId, "refs/heads/main", admission(runId, selectedPolicy));
  state = await authority.materializePlanning(state, journal);
  return authority.approveRun(state, journal);
}

async function integratedFeature(
  authority: IsolatedGitLifecycle,
  journal: MemoryJournal,
  runId: string,
  file: string,
  selectedPolicy = policy(),
): Promise<RunGitLifecycleRecord> {
  let state = await approvedRun(authority, journal, runId, selectedPolicy);
  state = await authority.openTicketCycle(state, ticket("TK-feature", "feature-1"), journal);
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

async function synchronized(
  authority: IsolatedGitLifecycle,
  state: RunGitLifecycleRecord,
  journal: MemoryJournal,
): Promise<RunGitLifecycleRecord> {
  const result = await authority.synchronizeTargetIntoRun(
    state,
    { subject: "sync target into run" },
    journal,
  );
  if (result.status !== "synchronized") throw new Error("expected target synchronization");
  return result.lifecycle;
}

async function legacyPlannedRecord(root: string, runId: string): Promise<RunGitLifecycleRecord> {
  const identity = await GitClient.discover(root);
  const selectedOid = await gitOutput(root, "rev-parse", "refs/heads/main");
  const namespaceRoot = path.join(identity.commonDirectory, "koni", "worktrees", "runs", runId);
  return {
    protocol: "koni.git-lifecycle.v1",
    runId,
    projectRoot: identity.worktreeRoot,
    commonDirectory: identity.commonDirectory,
    target: { ref: "refs/heads/main", selectedOid },
    namespace: {
      root: namespaceRoot,
      runRef: `refs/heads/koni/runs/${runId}`,
      planningWorktree: path.join(namespaceRoot, "planning"),
      runWorktree: path.join(namespaceRoot, "integration"),
      ticketRoot: path.join(namespaceRoot, "tickets"),
    },
    planning: {
      status: "planned",
      baseOid: selectedOid,
      worktree: path.join(namespaceRoot, "planning"),
      createdAt: undefined,
      retiredAt: undefined,
      blocker: undefined,
    },
    run: {
      status: "unmaterialized",
      branchRef: `refs/heads/koni/runs/${runId}`,
      worktree: path.join(namespaceRoot, "integration"),
      headOid: undefined,
      materializedAt: undefined,
      retiredAt: undefined,
      blocker: undefined,
    },
    ticketCycles: {},
    ticketCycleOrder: [],
    promotion: undefined,
  };
}

function parentCount(line: string): number {
  return Math.max(0, line.trim().split(/\s+/u).length - 1);
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-isolated-git-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  roots.push(resolveRepositoryWorktreeNamespaceRoot(await realpath(path.join(root, ".git"))));
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
  const output = await gitOutput(
    root,
    "for-each-ref",
    "--format=%(refname):%(objectname)",
    "refs/heads",
  );
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

function gitOutput(cwd: string, ...input: Array<string | readonly number[]>): Promise<string> {
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
      if (code !== null && accepted.includes(code))
        resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
  });
}
