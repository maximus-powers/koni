import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthorityClient } from "../src/authority/client.js";
import {
  RunAuthorityEngine,
  type RunCompilerProgram,
} from "../src/authority/run-engine.js";
import type { KoniContextProvider } from "../src/pi/compaction.js";
import type {
  ManagedPiSessionFactory,
  PiSessionAdapter,
} from "../src/pi/managed-session.js";
import type { AgentLaunchSpec } from "../src/pi/launch-spec.js";
import { ManagedSessionSupervisor } from "../src/pi/supervisor.js";
import {
  adoptProjectLegacyRun,
  previewProjectLegacyRunAdoption,
  resumeProjectRun,
} from "../src/operator/authority-bootstrap.js";
import {
  applyLegacyProjectMigration,
  planLegacyProjectMigration,
  type LegacyRunBarrierEvidence,
  type LegacyRunMigrationAuthority,
} from "../src/profile/migration.js";
import {
  loadLegacyRunMigrationEvidence,
  assessLegacyRunAdoption,
} from "../src/profile/run-adoption.js";
import { canonicalHash } from "../src/shared/canonical.js";
import { KONI_PI_PACKAGE_ROOT_ENV } from "../src/runtime/pi-peer-runtime.js";
import { fixtureLaunchSpec, fixtureTool, TERMINAL_TOOL_NAME } from "./pi-managed-fixtures.js";

const exec = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const codingProfile = path.join(repositoryRoot, "packages", "coding-profile");
const roots: string[] = [];
const engines: RunAuthorityEngine[] = [];
let priorPiPackageRoot: string | undefined;

beforeEach(async () => {
  priorPiPackageRoot = process.env[KONI_PI_PACKAGE_ROOT_ENV];
  process.env[KONI_PI_PACKAGE_ROOT_ENV] = await realpath(path.join(
    repositoryRoot,
    "node_modules/@earendil-works/pi-coding-agent",
  ));
});

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (priorPiPackageRoot === undefined) delete process.env[KONI_PI_PACKAGE_ROOT_ENV];
  else process.env[KONI_PI_PACKAGE_ROOT_ENV] = priorPiPackageRoot;
}, 30_000);

describe("production Rust-era run adoption", () => {
  it("registers one paused successor, survives restart, and starts fresh Pi recovery from committed legacy work", async () => {
    const fixture = await migratedLegacyProject();
    const evidenceBefore = await loadLegacyRunMigrationEvidence(fixture.project, fixture.migrationId);
    const sourceStateBefore = await readFile(path.join(fixture.sourceRunRoot, "state.yaml"));
    const harness = new PlanningHarness();

    let engine = await openEngine(fixture.project, harness);
    const preview = await previewProjectLegacyRunAdoption({
      projectRoot: fixture.project,
      version: "1.0.0",
      migrationId: fixture.migrationId,
    });
    expect(preview.runs).toContainEqual(expect.objectContaining({
      runId: "legacy-active",
      sourceStatus: "active",
      disposition: "ready",
    }));
    expect(preview.runs).toContainEqual(expect.objectContaining({
      runId: "legacy-concluded",
      disposition: "blocked",
      blockers: [expect.objectContaining({ code: "terminal_history_only" })],
    }));

    const adopted = await adoptProjectLegacyRun({
      projectRoot: fixture.project,
      version: "1.0.0",
      migrationId: fixture.migrationId,
      runId: "legacy-active",
    });
    expect(adopted.status).toBe("adopted_paused");
    expect(adopted.successorRunId).not.toBe("legacy-active");
    const successor = await engine.store.getRun(adopted.successorRunId);
    expect(successor.lifecycle).toMatchObject({ phase: "paused", resumePhase: "draft" });
    expect(successor.attempts).toEqual({});
    expect(successor.legacyRunAdoption).toMatchObject({
      sourceRunId: "legacy-active",
      sourceStatus: "active",
      planningBaseOid: fixture.integrationHead,
      migrationPlanBytesSha256: evidenceBefore.planBytesSha256,
      migrationReceiptSha256: evidenceBefore.receiptSha256,
      sessionLineage: { kind: "fresh_successor" },
    });
    expect(await readFile(path.join(fixture.sourceRunRoot, "state.yaml"))).toEqual(sourceStateBefore);

    let client = await AuthorityClient.connect({ projectRoot: fixture.project, client: "tui", version: "1.0.0" });
    const duplicate = (await client.request("migration.legacy.adopt", {
      migrationId: fixture.migrationId,
      runId: "legacy-active",
    }, {
      expectedRevision: client.revision,
      idempotencyKey: "adopt-active-again",
    })).result as { successorRunId: string; status: string };
    expect(duplicate).toMatchObject({
      successorRunId: adopted.successorRunId,
      status: "already_adopted",
    });
    expect((await engine.store.listRuns({ includeDeleted: true })).map((run) => run.id))
      .toEqual([adopted.successorRunId]);

    client.close();
    await engine.stop();
    engines.splice(engines.indexOf(engine), 1);

    engine = await openEngine(fixture.project, harness);
    await resumeProjectRun({
      projectRoot: fixture.project,
      version: "1.0.0",
      runId: adopted.successorRunId,
    });
    client = await AuthorityClient.connect({ projectRoot: fixture.project, client: "tui", version: "1.0.0" });
    try {
      await waitFor(async () => {
        const run = await engine.store.getRun(adopted.successorRunId);
        return Object.values(run.attempts).some((attempt) => attempt.kind === "planning") &&
          harness.promptCalls === 1;
      });
    } catch (error) {
      const current = await engine.store.getRun(adopted.successorRunId);
      throw new Error(`recovery planning did not launch: ${JSON.stringify({
        phase: current.lifecycle.phase,
        blocker: current.lifecycle.blocker,
        git: current.git,
        activity: current.activity,
      })}`, { cause: error });
    }
    const resumed = await engine.store.getRun(adopted.successorRunId);
    const planner = Object.values(resumed.attempts).find((attempt) => attempt.kind === "planning")!;
    expect(resumed.legacyRunAdoption).toMatchObject({
      resumeVerifiedAt: expect.any(String),
      resumeVerificationSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(planner.lineage).toMatchObject({ branchEpoch: 0, reason: "recovery" });
    expect(planner.lineage?.parentAttemptId).toBeUndefined();
    expect(planner.lineage?.parentSessionId).toBeUndefined();
    expect(harness.promptCalls).toBe(1);
    expect(await readFile(path.join(resumed.git.planning.worktree, "legacy-work.txt"), "utf8"))
      .toBe("committed legacy implementation\n");
    expect(await readFile(path.join(fixture.sourceRunRoot, "state.yaml"))).toEqual(sourceStateBefore);

    await client.request("authority.ping");
    await client.request("run.pause", { runId: adopted.successorRunId }, {
      expectedRevision: client.revision,
      idempotencyKey: "pause-recovery-test",
    });
    await waitFor(async () => (await engine.store.getRun(adopted.successorRunId)).lifecycle.phase === "paused");
    client.close();
  }, 60_000);

  it("fails closed on dirty legacy work, source drift, and exact archived-receipt drift", async () => {
    const dirty = await migratedLegacyProject();
    await writeFile(path.join(dirty.integrationWorktree, "uncommitted.txt"), "do not absorb\n");
    const dirtyEvidence = await loadLegacyRunMigrationEvidence(dirty.project, dirty.migrationId);
    const dirtyAssessment = await assessLegacyRunAdoption(dirtyEvidence, "legacy-active");
    expect(dirtyAssessment).toMatchObject({
      disposition: "blocked",
      blockers: [expect.objectContaining({ code: "source_worktree_dirty" })],
    });

    const sourceDrift = await migratedLegacyProject();
    const sourceHarness = new PlanningHarness();
    const sourceEngine = await openEngine(sourceDrift.project, sourceHarness);
    let sourceClient = await AuthorityClient.connect({ projectRoot: sourceDrift.project, client: "tui", version: "1.0.0" });
    const sourceAdopted = (await sourceClient.request("migration.legacy.adopt", {
      migrationId: sourceDrift.migrationId,
      runId: "legacy-active",
    }, {
      expectedRevision: sourceClient.revision,
      idempotencyKey: "adopt-before-source-drift",
    })).result as { successorRunId: string };
    await writeFile(path.join(sourceDrift.sourceRunRoot, "drift.txt"), "changed after adoption\n");
    await expect(sourceClient.request("run.resume", { runId: sourceAdopted.successorRunId }, {
      expectedRevision: sourceClient.revision,
      idempotencyKey: "resume-after-source-drift",
    })).rejects.toMatchObject({ code: "legacy_resume_blocked" });
    expect(sourceHarness.promptCalls).toBe(0);
    expect((await sourceEngine.store.getRun(sourceAdopted.successorRunId)).lifecycle.phase).toBe("paused");
    sourceClient.close();

    const receiptDrift = await migratedLegacyProject();
    const receiptHarness = new PlanningHarness();
    const receiptEngine = await openEngine(receiptDrift.project, receiptHarness);
    const receiptClient = await AuthorityClient.connect({ projectRoot: receiptDrift.project, client: "tui", version: "1.0.0" });
    const receiptAdopted = (await receiptClient.request("migration.legacy.adopt", {
      migrationId: receiptDrift.migrationId,
      runId: "legacy-active",
    }, {
      expectedRevision: receiptClient.revision,
      idempotencyKey: "adopt-before-receipt-drift",
    })).result as { successorRunId: string };
    const receiptPath = path.join(receiptDrift.project, ".koni", ".managed", "migrations", receiptDrift.migrationId, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    receipt.appliedAt = "2099-01-01T00:00:00.000Z";
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    await expect(receiptClient.request("run.resume", { runId: receiptAdopted.successorRunId }, {
      expectedRevision: receiptClient.revision,
      idempotencyKey: "resume-after-receipt-drift",
    })).rejects.toMatchObject({ code: "legacy_resume_evidence_changed" });
    expect(receiptHarness.promptCalls).toBe(0);
    expect((await receiptEngine.store.getRun(receiptAdopted.successorRunId)).lifecycle.phase).toBe("paused");
    receiptClient.close();
  }, 90_000);
});

interface LegacyFixture {
  project: string;
  migrationId: string;
  sourceRunRoot: string;
  integrationWorktree: string;
  integrationHead: string;
}

async function migratedLegacyProject(): Promise<LegacyFixture> {
  const project = await realpath(await mkdtemp(path.join(tmpdir(), "koni-legacy-adoption-")));
  roots.push(project);
  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "koni@example.invalid");
  await git(project, "config", "user.name", "Koni Test");
  await writeFile(path.join(project, "README.md"), "initial\n");
  await git(project, "add", "README.md");
  await git(project, "commit", "-m", "initial");
  const baseCommit = await gitOutput(project, "rev-parse", "HEAD");

  await mkdir(path.join(project, ".codex"), { recursive: true });
  await cp(path.join(repositoryRoot, ".codex", "koni"), path.join(project, ".codex", "koni"), { recursive: true });
  await cp(path.join(repositoryRoot, ".codex", "agents"), path.join(project, ".codex", "agents"), { recursive: true });

  const stateRoot = path.join(project, ".git", "koni");
  const sourceRunRoot = path.join(stateRoot, "runs", "legacy-active");
  const terminalRunRoot = path.join(stateRoot, "runs", "legacy-concluded");
  await mkdir(sourceRunRoot, { recursive: true });
  await mkdir(terminalRunRoot, { recursive: true });
  await writeFile(path.join(sourceRunRoot, "state.yaml"), "stage: execute\n");
  await writeFile(path.join(terminalRunRoot, "state.yaml"), "stage: complete\n");

  const integrationWorktree = path.join(stateRoot, "worktrees", "legacy-active", "integration");
  await mkdir(path.dirname(integrationWorktree), { recursive: true });
  await git(project, "worktree", "add", "-b", "koni/runs/legacy-active", integrationWorktree, "main");
  await writeFile(path.join(integrationWorktree, "legacy-work.txt"), "committed legacy implementation\n");
  await git(integrationWorktree, "add", "legacy-work.txt");
  await git(integrationWorktree, "commit", "-m", "legacy implementation");
  const integrationHead = await gitOutput(integrationWorktree, "rev-parse", "HEAD");

  await writeFile(path.join(stateRoot, "project.yaml"), `
selected_run: legacy-active
runs:
  legacy-active:
    status: active
    goal: Preserve and continue this active run
    profile_id: software
    profile_version: 0.2.0
    run_type_id: medium
    target_branch: refs/heads/main
    base_commit: "${baseCommit}"
    config_snapshot_hash: legacy-config
    integration_branch: refs/heads/koni/runs/legacy-active
    integration_worktree: "${integrationWorktree}"
    created_at: "2026-07-01T00:00:00Z"
    updated_at: "2026-07-01T00:01:00Z"
  legacy-concluded:
    status: concluded
    goal: Retain completed history
    profile_id: software
    profile_version: 0.2.0
    run_type_id: medium
    target_branch: refs/heads/main
    base_commit: "${baseCommit}"
    config_snapshot_hash: legacy-config
    created_at: "2026-06-01T00:00:00Z"
    updated_at: "2026-06-01T00:01:00Z"
`);

  const migrationId = `adoption-${roots.length}`;
  const plan = await planLegacyProjectMigration({
    projectRoot: project,
    profilePackageRoot: codingProfile,
    migrationId,
  });
  await applyLegacyProjectMigration(plan, {
    profilePackageRoot: codingProfile,
    runAuthority: barrierAuthority(),
  });
  return { project, migrationId, sourceRunRoot, integrationWorktree, integrationHead };
}

function barrierAuthority(): LegacyRunMigrationAuthority {
  return {
    async withQuiescedRuns(request, publishWhileHeld) {
      const material = {
        ...request,
        quiescedAt: "2026-07-16T12:00:00.000Z",
        quiescedRunIds: request.runBindings.map(({ id }) => id),
      };
      const evidence: LegacyRunBarrierEvidence = {
        ...material,
        evidenceSha256: canonicalHash(material),
      };
      return publishWhileHeld(evidence);
    },
  };
}

async function openEngine(project: string, harness: PlanningHarness): Promise<RunAuthorityEngine> {
  const engine = await RunAuthorityEngine.open({
    projectRoot: project,
    version: "1.0.0",
    program: adoptionProgram(harness),
    supervisor: new ManagedSessionSupervisor(),
  });
  engines.push(engine);
  await engine.start();
  return engine;
}

function adoptionProgram(harness: PlanningHarness): RunCompilerProgram {
  return {
    async resolveRun(request) {
      return {
        profile: {
          packageName: "@koni/coding-profile",
          packageVersion: "1.0.0",
          lineage: "koni.software",
          bundleHash: `sha256:${"a".repeat(64)}`,
        },
        compiledConfigHash: `sha256:${"b".repeat(64)}`,
        runTypeId: request.runTypeId,
        workingSpecOwnerId: "lead",
        planningMode: "agent",
        pipelineStageIds: ["intake", "combined-plan", "approval", "orchestrate", "verification", "promotion"],
        executionConfig: {
          maxParallel: 1,
          questionPolicy: "some",
          instructions: "Recover from exact retained legacy evidence.",
          agents: { lead: { provider: "test", model: "test-model", thinkingLevel: "off" } },
        },
      };
    },
    async initializeDirectApproval() { throw new Error("not used"); },
    async prepareAttempt(input) {
      const spec = fixtureLaunchSpec({
        cwd: input.run.git.planning.worktree,
        sessionDirectory: path.join(input.run.projectRoot, ".sessions", input.attemptId),
        runId: input.run.id,
        ticketId: "run-planning",
        stepId: "combined-plan",
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        lineage: input.lineage,
      }) as AgentLaunchSpec;
      return {
        spec,
        tools: [fixtureTool()],
        contextProvider: contextProvider(spec),
        factory: (async () => harness.create(spec)) satisfies ManagedPiSessionFactory,
      };
    },
    async compilePlanningOutput() { throw new Error("not reached by hanging provider-free adapter"); },
    async initializeApprovedPlan() { throw new Error("not used"); },
    async compileAssignmentOutput() { throw new Error("not used"); },
    async verifyRun() { throw new Error("not used"); },
    async createIntegrationTicket() { throw new Error("not used"); },
  };
}

class PlanningHarness {
  public readonly adapters: HangingAdapter[] = [];

  public get promptCalls(): number {
    return this.adapters.reduce((total, adapter) => total + adapter.promptCalls, 0);
  }

  public create(spec: AgentLaunchSpec): HangingAdapter {
    const adapter = new HangingAdapter(spec);
    this.adapters.push(adapter);
    return adapter;
  }
}

class HangingAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  public promptCalls = 0;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #drain = deferred<void>();

  public constructor(spec: AgentLaunchSpec) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] { return [TERMINAL_TOOL_NAME]; }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> { this.promptCalls += 1; await this.#drain.promise; }
  public async continue(): Promise<void> { await this.prompt(); }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> { this.#drain.resolve(); }
  public dispose(): void {}
}

function contextProvider(spec: AgentLaunchSpec): KoniContextProvider {
  return {
    async loadBoundContext() { throw new Error("not used"); },
    async loadCompactionSnapshot() { throw new Error("not used"); },
    async authorizeCompaction() { return { authorizationId: "unused-compaction" }; },
    async acquireRecoveryClaim() {
      return {
        protocol: "koni.attempt-recovery-claim.v1",
        claimId: `claim-${spec.identity.attemptId}`,
        state: {
          protocol: "koni.attempt-recovery.v1",
          specHash: spec.specHash,
          ...spec.identity,
          grantHash: spec.authority.grantHash,
          generation: spec.authority.generation,
          epoch: spec.authority.epoch,
          stateHash: spec.authority.expectedStateHash,
          status: "continue" as const,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
          authorizedMessages: [],
          authorizedToolResults: [],
          authorizedCompactions: [],
        },
        async release() {},
      };
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for legacy adoption state");
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", ["-C", cwd, ...args]);
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}
