import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { RunGitRecord } from "../state/run-record.js";
import { GitClient } from "./client.js";

export interface RunGitNamespace {
  git: RunGitRecord;
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

  public async recentTargetBranches(limit = 20): Promise<{ ref: string; name: string; oid: string }[]> {
    const client = new GitClient(this.#projectRoot);
    return (await client.recentBranches(limit)).map((branch) => ({
      ref: `refs/heads/${branch.name}`,
      name: branch.name,
      oid: branch.oid,
    }));
  }

  public async createNamespace(runId: string, targetRef: string): Promise<RunGitNamespace> {
    assertRunId(runId);
    assertTargetRef(targetRef);
    const identity = await GitClient.discover(this.#projectRoot);
    const client = new GitClient(identity.worktreeRoot);
    const targetBaseOid = await client.resolveRef(targetRef);
    const runBranch = `koni/runs/${runId}`;
    const runWorktree = path.join(identity.commonDirectory, "koni", "worktrees", "runs", runId);
    await mkdir(path.dirname(runWorktree), { recursive: true, mode: 0o700 });
    await rm(runWorktree, { recursive: true, force: true });
    await client.createWorktree(runWorktree, runBranch, targetBaseOid);
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

  public async preparePromotion(git: RunGitRecord, message: string): Promise<IntegrationResult> {
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

  public async publishPromotion(git: RunGitRecord): Promise<string> {
    if (git.candidateOid === undefined || git.promotionTargetOid === undefined) {
      throw new Error("run does not have a prepared promotion candidate");
    }
    const repository = new GitClient(this.#projectRoot);
    await repository.updateRef(git.targetRef, git.candidateOid, git.promotionTargetOid);
    return git.candidateOid;
  }

  public async cleanup(git: RunGitRecord): Promise<void> {
    const repository = new GitClient(this.#projectRoot);
    try {
      await repository.removeWorktree(git.runWorktree);
    } catch {
      await rm(git.runWorktree, { recursive: true, force: true });
    }
  }
}

function assertRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value)) {
    throw new Error(`invalid run id: ${value}`);
  }
}

function assertTargetRef(value: string): void {
  if (!value.startsWith("refs/heads/") || value.length > 1_024 || /[\u0000-\u0020~^:?*\\[\]]/u.test(value)) {
    throw new Error(`target must be a safe local branch ref: ${value}`);
  }
}
