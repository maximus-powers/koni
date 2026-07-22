import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitLifecycleError, IsolatedGitLifecycle } from "../src/git/lifecycle.js";
import {
  compileGitBehaviorPolicy,
  createGitRunTemplateContext,
  type GitBehaviorPolicy,
  type GitRunAdmission,
} from "../src/git/behavior-policy.js";

// Self-contained coverage for on-demand target-branch provisioning (planRun's
// TargetProvisioning). Kept independent of the broader lifecycle suite so the exact
// create/base/typo-safety contract is legible in one place.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run target provisioning", () => {
  it("refuses a missing target unless provisioning is explicitly requested", async () => {
    const root = await repository();
    await expect(lifecycle(root).planRun(
      "run-missing-target",
      "refs/heads/feature-new",
      admission("run-missing-target"),
    )).rejects.toMatchObject({
      code: "target_missing",
      message: expect.stringContaining("--new-target"),
    });
    expect(await branchExists(root, "feature-new")).toBe(false);
  });

  it("provisions a new target branch from the current HEAD when requested", async () => {
    const root = await repository();
    const mainOid = await gitOutput(root, "rev-parse", "refs/heads/main");
    const state = await lifecycle(root).planRun(
      "run-new-target",
      "refs/heads/feature-new",
      admission("run-new-target"),
      { create: true },
    );
    expect(state.target).toEqual({ ref: "refs/heads/feature-new", selectedOid: mainOid });
    expect(state.planning.baseOid).toBe(mainOid);
    expect(await gitOutput(root, "rev-parse", "refs/heads/feature-new")).toBe(mainOid);
  });

  it("provisions from an explicit base and rejects a missing base without touching refs", async () => {
    const root = await repository();
    await git(root, "checkout", "-b", "release-base");
    await writeFile(path.join(root, "release.ts"), "release\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "release base");
    const releaseOid = await gitOutput(root, "rev-parse", "refs/heads/release-base");
    await git(root, "checkout", "main");

    const state = await lifecycle(root).planRun(
      "run-based-target",
      "refs/heads/feature-from-release",
      admission("run-based-target"),
      { create: true, baseRef: "release-base" },
    );
    expect(state.target.selectedOid).toBe(releaseOid);
    expect(await gitOutput(root, "rev-parse", "refs/heads/feature-from-release")).toBe(releaseOid);

    await expect(lifecycle(root).planRun(
      "run-bad-base",
      "refs/heads/feature-bad-base",
      admission("run-bad-base"),
      { create: true, baseRef: "does-not-exist" },
    )).rejects.toMatchObject({ code: "base_unresolved" });
    // A rejected plan must not leave the target half-provisioned.
    expect(await branchExists(root, "feature-bad-base")).toBe(false);
  });
});

function lifecycle(root: string): IsolatedGitLifecycle {
  return new IsolatedGitLifecycle(root, {
    identity: { name: "Koni Test", email: "koni@example.invalid" },
  });
}

function policy(): GitBehaviorPolicy {
  const result = compileGitBehaviorPolicy({
    profileGit: {
      enabled: true,
      backend: "git_cli",
      integration_branch: "current",
      ticket_branch_template: "koni/default/tickets/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}",
      worktree_root: ".koni-worktrees/default",
      integration_strategy: "squash",
      commit_template: "{{ ticket.operation }}: {{ ticket.title }}",
      commit_trailers: {},
    },
    runTypeGit: {
      branch_template: "koni/default/runs/{{ run.id }}",
      ticket_branch_template: "koni/default/tickets/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}",
    },
  });
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join("; "));
  return result.value;
}

function admission(runId: string): GitRunAdmission {
  return {
    policy: policy(),
    run: createGitRunTemplateContext({
      id: runId,
      objective: `Test ${runId}`,
      profileHash: `sha256:${"a".repeat(64)}`,
    }),
  };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-target-provisioning-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "koni@example.invalid");
  await git(root, "config", "user.name", "Koni Test");
  await writeFile(path.join(root, "README.md"), "initial\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  const output = await gitOutput(root, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`);
  return output.length > 0;
}

async function git(cwd: string, ...argv: string[]): Promise<void> {
  await gitOutput(cwd, ...argv);
}

function gitOutput(cwd: string, ...argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...argv], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new Error(`git ${argv.join(" ")} failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}
