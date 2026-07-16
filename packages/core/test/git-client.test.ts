import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient, GitCommandError } from "../src/git/client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-git-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "koni@example.invalid");
  await git(root, "config", "user.name", "Koni Test");
  await writeFile(path.join(root, "README.md"), "initial\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "initial");
  return root;
}

describe("Git client", () => {
  it("discovers the common directory and lists recent local branches", async () => {
    const root = await repository();
    await git(root, "branch", "feature");
    const identity = await GitClient.discover(root);
    expect(identity.worktreeRoot).toBe(await realpath(root));
    expect(identity.commonDirectory).toBe(await realpath(path.join(root, ".git")));
    const branches = await new GitClient(root).recentBranches();
    expect(branches.map((branch) => branch.name).sort()).toEqual(["feature", "main"]);
    expect(branches.every((branch) => /^[0-9a-f]{40,64}$/u.test(branch.oid))).toBe(true);
  });

  it("publishes a ref only when the expected old oid still matches", async () => {
    const root = await repository();
    const client = new GitClient(root);
    const oldOid = await client.resolveRef("refs/heads/main");
    await git(root, "checkout", "-b", "candidate");
    await writeFile(path.join(root, "feature.txt"), "feature\n");
    await git(root, "add", "feature.txt");
    await git(root, "commit", "-m", "feature");
    const newOid = await client.resolveRef("refs/heads/candidate");
    await client.updateRef("refs/heads/main", newOid, oldOid);
    expect(await client.resolveRef("refs/heads/main")).toBe(newOid);
    await expect(client.updateRef("refs/heads/main", oldOid, oldOid)).rejects.toBeInstanceOf(
      GitCommandError,
    );
  });

  it("creates an isolated worktree branch from an exact commit", async () => {
    const root = await repository();
    const client = new GitClient(root);
    const oid = await client.resolveRef("refs/heads/main");
    const worktree = path.join(path.dirname(root), `${path.basename(root)}-worktree`);
    roots.push(worktree);
    await client.createWorktree(worktree, "koni/run-one", oid);
    expect(await new GitClient(worktree).resolveRef("HEAD")).toBe(oid);
  });
});

function git(cwd: string, ...argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...argv], { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8")));
      }
    });
  });
}
