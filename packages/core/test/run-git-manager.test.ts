import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunGitManager } from "../src/git/run-manager.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run Git namespaces and explicit promotion", () => {
  it("creates an isolated run worktree and publishes only after explicit promotion", async () => {
    const root = await repository();
    const manager = new RunGitManager(root);
    const namespace = await manager.createNamespace("run-one", "refs/heads/main");
    await writeFile(path.join(namespace.git.runWorktree, "feature.txt"), "feature\n");
    await git(namespace.git.runWorktree, "add", "feature.txt");
    await git(namespace.git.runWorktree, "commit", "-m", "feature");
    expect(await exists(path.join(root, "feature.txt"))).toBe(false);

    const prepared = await manager.preparePromotion(namespace.git, "Merge Koni run run-one");
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected a ready promotion");
    namespace.git.candidateOid = prepared.candidateOid;
    namespace.git.promotionTargetOid = prepared.targetOid;
    expect(await exists(path.join(root, "feature.txt"))).toBe(false);
    await manager.publishPromotion(namespace.git);
    await git(root, "reset", "--hard", "HEAD");
    expect(await readFile(path.join(root, "feature.txt"), "utf8")).toBe("feature\n");
    await manager.cleanup(namespace.git);
  });

  it("reports target/run conflicts instead of publishing either side", async () => {
    const root = await repository();
    const manager = new RunGitManager(root);
    const namespace = await manager.createNamespace("run-conflict", "refs/heads/main");
    await writeFile(path.join(namespace.git.runWorktree, "README.md"), "from run\n");
    await git(namespace.git.runWorktree, "add", "README.md");
    await git(namespace.git.runWorktree, "commit", "-m", "run edit");
    await writeFile(path.join(root, "README.md"), "from target\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "target edit");
    const prepared = await manager.preparePromotion(namespace.git, "Merge conflict");
    expect(prepared.status).toBe("conflicts");
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("from target\n");
    await expect(manager.cleanup(namespace.git)).rejects.toThrow("not integrated");
    expect(await readFile(path.join(namespace.git.runWorktree, "README.md"), "utf8")).toBe(
      "from run\n",
    );
  });
});

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-run-git-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "koni@example.invalid");
  await git(root, "config", "user.name", "Koni Test");
  await writeFile(path.join(root, "README.md"), "initial\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "initial");
  return root;
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...argv], { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
  });
}
