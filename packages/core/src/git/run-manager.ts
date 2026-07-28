import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { GitClient } from "./client.js";

/**
 * Compatibility shape used only by the pre-lifecycle RunGitManager facade.
 * New authority state uses RunGitLifecycleRecord from lifecycle.ts.
 */
export interface LegacyRunGitRecord {
  targetRef: string;
  targetBaseOid: string;
  runBranch: string;
  runWorktree: string;
  candidateOid: string | undefined;
  promotionTargetOid: string | undefined;
  mergeReadyAt: string | undefined;
  mergedOid: string | undefined;
  namespaceStatus?: "planned" | "ready" | "cleaned";
  materializedAt?: string;
}

export interface RunGitNamespace {
  git: LegacyRunGitRecord;
  projectRoot: string;
}

export type IntegrationResult =
  | { status: "ready"; candidateOid: string; targetOid: string }
  | { status: "conflicts"; targetOid: string; conflictReport: string };

export class RunGitManager {
  readonly #projectRoot: string;

  public constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
  }

  public async recentTargetBranches(
    limit = 20,
  ): Promise<{ ref: string; name: string; oid: string }[]> {
    const client = new GitClient(this.#projectRoot);
    return (await client.recentBranches(limit)).map((branch) => ({
      ref: `refs/heads/${branch.name}`,
      name: branch.name,
      oid: branch.oid,
    }));
  }

  /** Resolve and name a run namespace without creating a branch or worktree. */
  public async planNamespace(runId: string, targetRef: string): Promise<RunGitNamespace> {
    assertRunId(runId);
    assertTargetRef(targetRef);
    const identity = await GitClient.discover(this.#projectRoot);
    const client = new GitClient(identity.worktreeRoot);
    const targetBaseOid = await client.resolveRef(targetRef);
    const runBranch = `koni/runs/${runId}`;
    const runWorktree = path.join(identity.commonDirectory, "koni", "worktrees", "runs", runId);
    return {
      projectRoot: identity.worktreeRoot,
      git: {
        targetRef,
        targetBaseOid,
        runBranch,
        runWorktree,
        candidateOid: undefined,
        promotionTargetOid: undefined,
        mergeReadyAt: undefined,
        mergedOid: undefined,
      },
    };
  }

  /** Idempotently materialize a previously persisted namespace plan. */
  public async materializeNamespace(namespace: RunGitNamespace): Promise<void> {
    const { git } = namespace;
    const identity = await GitClient.discover(this.#projectRoot);
    if (namespace.projectRoot !== identity.worktreeRoot) {
      throw new Error("run Git namespace belongs to a different repository");
    }
    const repository = new GitClient(identity.worktreeRoot);
    const targetBase = await repository.resolveRef(git.targetRef);
    if (targetBase !== git.targetBaseOid) {
      // The run intentionally starts from the exact target snapshot selected during intake.
      // Later target movement is handled by promotion merge-tree, not by silently rebasing here.
      const objectStillExists = await repository.tryResolveRef(git.targetBaseOid);
      if (objectStillExists !== git.targetBaseOid) {
        throw new Error("persisted run base commit no longer resolves");
      }
    }

    if (await pathExists(git.runWorktree)) {
      const worktreeIdentity = await GitClient.discover(git.runWorktree);
      const worktree = new GitClient(worktreeIdentity.worktreeRoot);
      const head = await worktree.resolveRef("HEAD");
      const branchHead = await repository.tryResolveRef(`refs/heads/${git.runBranch}`);
      if (
        worktreeIdentity.commonDirectory === identity.commonDirectory &&
        branchHead !== undefined &&
        head === branchHead
      )
        return;
      throw new Error("existing run worktree does not match the persisted namespace");
    }

    await mkdir(path.dirname(git.runWorktree), { recursive: true, mode: 0o700 });
    const branchRef = `refs/heads/${git.runBranch}`;
    const existing = await repository.tryResolveRef(branchRef);
    if (existing === undefined) {
      await repository.createWorktree(git.runWorktree, git.runBranch, git.targetBaseOid);
      return;
    }
    if (existing !== git.targetBaseOid) {
      throw new Error("persisted run branch already exists at an unexpected commit");
    }
    await repository.addExistingBranchWorktree(git.runWorktree, git.runBranch);
  }

  public async createNamespace(runId: string, targetRef: string): Promise<RunGitNamespace> {
    const namespace = await this.planNamespace(runId, targetRef);
    await this.materializeNamespace(namespace);
    return namespace;
  }

  public async preparePromotion(
    git: LegacyRunGitRecord,
    message: string,
  ): Promise<IntegrationResult> {
    assertTargetRef(git.targetRef);
    const repository = new GitClient(this.#projectRoot);
    const worktree = new GitClient(git.runWorktree);
    const targetOid = await repository.resolveRef(git.targetRef);
    const runOid = await worktree.resolveRef("HEAD");
    const dirty = await worktree.statusPorcelain();
    if (dirty.byteLength !== 0) {
      throw new Error("run worktree has uncommitted changes and cannot be promoted");
    }
    if (targetOid === runOid) {
      return { status: "ready", candidateOid: runOid, targetOid };
    }
    const merged = await repository.mergeTree(targetOid, runOid);
    if (merged.conflicts.length > 0 || merged.tree === undefined) {
      return {
        status: "conflicts",
        targetOid,
        conflictReport: merged.conflicts || "Git did not return a merged tree",
      };
    }
    const candidateOid = await repository.commitTree(merged.tree, [targetOid, runOid], message);
    return { status: "ready", candidateOid, targetOid };
  }

  public async publishPromotion(git: LegacyRunGitRecord): Promise<string> {
    if (git.candidateOid === undefined || git.promotionTargetOid === undefined) {
      throw new Error("run does not have a prepared promotion candidate");
    }
    const repository = new GitClient(this.#projectRoot);
    await repository.updateRef(git.targetRef, git.candidateOid, git.promotionTargetOid);
    return git.candidateOid;
  }

  public async cleanup(git: LegacyRunGitRecord): Promise<void> {
    const repository = new GitClient(this.#projectRoot);
    if (!git.runBranch.startsWith("koni/runs/")) {
      throw new Error("refusing to clean a non-Koni run branch");
    }
    const branchRef = `refs/heads/${git.runBranch}`;
    const branchOid = await repository.tryResolveRef(branchRef);
    const targetOid = await repository.resolveRef(git.targetRef);
    if (branchOid !== undefined && !(await repository.isAncestor(branchOid, targetOid))) {
      throw new Error("refusing to clean a run branch that is not integrated into its target");
    }
    const identity = await GitClient.discover(this.#projectRoot);
    const expected = path.join(
      identity.commonDirectory,
      "koni",
      "worktrees",
      "runs",
      git.runBranch.slice("koni/runs/".length),
    );
    if (path.resolve(git.runWorktree) !== expected) {
      throw new Error("refusing to clean a run worktree outside its compiler-owned namespace");
    }
    const registered = (await repository.worktrees()).find(
      (entry) => path.resolve(entry.path) === path.resolve(git.runWorktree),
    );
    if (registered !== undefined) {
      if (registered.branch !== branchRef || registered.head !== branchOid) {
        throw new Error("run worktree identity no longer matches its compiler-owned branch");
      }
      const worktreeIdentity = await GitClient.discover(git.runWorktree);
      if (
        (await realpath(worktreeIdentity.commonDirectory)) !==
        (await realpath(identity.commonDirectory))
      ) {
        throw new Error("run worktree belongs to another repository");
      }
      if ((await new GitClient(git.runWorktree).statusEntries()).length !== 0) {
        throw new Error("refusing to clean a dirty run worktree");
      }
      await repository.unlockWorktree(git.runWorktree);
      await repository.removeWorktree(git.runWorktree);
    } else if (await pathExists(git.runWorktree)) {
      throw new Error("unregistered data occupies the recorded run worktree path");
    }
    if (branchOid !== undefined) {
      await repository.deleteRef(branchRef, branchOid);
    }
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function assertRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value)) {
    throw new Error(`invalid run id: ${value}`);
  }
}

function assertTargetRef(value: string): void {
  if (
    !value.startsWith("refs/heads/") ||
    value.length > 1_024 ||
    /[\u0000-\u0020~^:?*\\[\]]/u.test(value)
  ) {
    throw new Error(`target must be a safe local branch ref: ${value}`);
  }
}
