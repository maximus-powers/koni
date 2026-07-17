import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityClient } from "../src/authority/client.js";
import {
  authorityRevisionStateHash,
  RunAuthorityEngine,
  type RunCompilerProgram,
} from "../src/authority/run-engine.js";
import type { AuthorityGrant } from "../src/authority/grants.js";
import { ManagedSessionSupervisor } from "../src/pi/supervisor.js";
import type { KoniContextProvider } from "../src/pi/compaction.js";
import type {
  AuthorityBackedTool,
  ManagedPiSessionFactory,
  PiSessionAdapter,
} from "../src/pi/managed-session.js";
import {
  AGENT_LAUNCH_SPEC_PROTOCOL,
  computeLaunchResourceSetHash,
  createAgentLaunchSpec,
  type AgentLaunchSpec,
} from "../src/pi/launch-spec.js";
import {
  koniToolMaxResultBytes,
  koniToolSchemaHash,
  type KoniToolName,
} from "../src/pi/tool-catalog.js";
import { canonicalHash, rawSha256 } from "../src/shared/canonical.js";
import { parseConfigCatalog, parseConfigSnapshot } from "../src/control-center/protocol.js";
import { installProfile } from "../src/profile/install.js";
import type { RunRecord, TicketRecord } from "../src/state/run-record.js";
import {
  TERMINAL_TOOL_NAME,
  fixtureLaunchSpec,
  fixtureTool,
} from "./pi-managed-fixtures.js";

const roots: string[] = [];
const engines: RunAuthorityEngine[] = [];
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("run authority engine", () => {
  it("owns real catalog-driven configuration resource creation, duplication, and deletion", async () => {
    const root = await repository();
    await installProfile(root, codingProfile);
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: fakeProgram(),
      supervisor: new ManagedSessionSupervisor(),
      profilePackageRootLoader: async () => codingProfile,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    const catalog = parseConfigCatalog((await client.request("config.catalog")).result);
    const snapshot = parseConfigSnapshot((await client.request("config.get")).result);
    const section = catalog.sections.find((candidate) => candidate.title === "Run Types")!;
    const option = section.createOptions!.find((candidate) => candidate.title === "Based on Small")!;
    await client.request("config.resource.create", {
      cas: snapshot.cas,
      sectionId: section.id,
      templateId: option.id,
      name: "Authority Flow",
    }, { expectedRevision: client.revision, idempotencyKey: "config-create-authority-flow" });
    expect(await readFile(path.join(root, ".koni", "run-types", "authority-flow.yaml"), "utf8"))
      .toContain("id: authority-flow");

    let nextCatalog = parseConfigCatalog((await client.request("config.catalog")).result);
    let nextSnapshot = parseConfigSnapshot((await client.request("config.get")).result);
    const created = nextCatalog.sections.find((candidate) => candidate.title === "Run Types")!
      .resources.find((candidate) => candidate.title === "Authority Flow")!;
    await client.request("config.resource.duplicate", {
      cas: nextSnapshot.cas,
      resourceId: created.id,
      name: "Authority Flow Copy",
    }, { expectedRevision: client.revision, idempotencyKey: "config-duplicate-authority-flow" });
    expect(await readFile(path.join(root, ".koni", "run-types", "authority-flow-copy.yaml"), "utf8"))
      .toContain("id: authority-flow-copy");

    nextCatalog = parseConfigCatalog((await client.request("config.catalog")).result);
    nextSnapshot = parseConfigSnapshot((await client.request("config.get")).result);
    const copy = nextCatalog.sections.find((candidate) => candidate.title === "Run Types")!
      .resources.find((candidate) => candidate.title === "Authority Flow Copy")!;
    await client.request("config.resource.delete", {
      cas: nextSnapshot.cas,
      resourceId: copy.id,
    }, { expectedRevision: client.revision, idempotencyKey: "config-delete-authority-flow" });
    await expect(readFile(path.join(root, ".koni", "run-types", "authority-flow-copy.yaml")))
      .rejects.toMatchObject({ code: "ENOENT" });
    client.close();
  }, 120_000);

  it("moves a run from provisional creation through approval to explicit publication", async () => {
    const root = await repository();
    let sequence = 0;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: fakeProgram(),
      supervisor: new ManagedSessionSupervisor(),
      now: () => new Date(1_784_179_200_000 + sequence * 1_000),
      createId: (kind) => `${kind}-${++sequence}`,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request("run.create", {
      objective: "Build the feature",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Build the feature" },
    }, { expectedRevision: 0, idempotencyKey: "create-feature" });
    const runId = (created.result as { runId: string }).runId;
    expect((await engine.store.getRun(runId)).lifecycle.phase).toMatch(/draft|planning|awaiting_approval/u);

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval");
    const planned = await engine.store.getRun(runId);
    expect(planned.plan?.concise.architecture).toEqual([
      { title: "Use existing seam", description: "Keep the change within the repository boundary." },
    ]);
    const firstPlanner = Object.values(planned.attempts).find((attempt) => attempt.kind === "planning")!;
    await client.request("authority.ping");
    await client.request("plan.revise", {
      runId,
      instructions: "Keep the same architecture, but make the verification proof explicit.",
    }, {
      expectedRevision: client.revision,
      idempotencyKey: "revise-feature-plan",
    });
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return current.lifecycle.phase === "awaiting_approval" &&
        Object.values(current.attempts).filter((attempt) => attempt.kind === "planning").length === 2;
    });
    const revised = await engine.store.getRun(runId);
    const planners = Object.values(revised.attempts)
      .filter((attempt) => attempt.kind === "planning")
      .sort((left, right) => (left.lineage?.branchEpoch ?? 0) - (right.lineage?.branchEpoch ?? 0));
    expect(planners[0]!.id).toBe(firstPlanner.id);
    expect(planners[0]!.status).toMatch(/completed|interrupted/u);
    expect(planners[1]!.sessionId).not.toBe(firstPlanner.sessionId);
    expect(planners[1]!.lineage).toMatchObject({
      branchEpoch: 1,
      reason: "rework",
      parentAttemptId: firstPlanner.id,
      parentSessionId: firstPlanner.sessionId,
    });
    expect(planners[1]!.authorityMessages).toEqual([]);
    expect(revised.plan?.steeringHistory.at(-1)?.instructions).toContain("verification proof");
    await client.request("authority.ping");
    await client.request("plan.approve", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "approve-feature",
    });

    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "merge_ready");
    const ready = await engine.store.getRun(runId);
    expect(ready.tickets["ticket-one"]?.steps[0]?.summary).toBe("Implemented feature");
    expect(ready.git.promotion?.candidateOid).toMatch(/^[0-9a-f]{40}$/u);
    expect(Object.values(ready.attempts).filter((attempt) =>
      attempt.personaId === "lead" || attempt.personaId === "supervisor"
    )).toEqual([]);

    await client.request("authority.ping");
    await client.request("run.merge", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "merge-feature",
    });
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "completed");
    const completed = await engine.store.getRun(runId);
    expect(completed.git.promotion).toMatchObject({ status: "published" });
    expect(completed.attempts).toEqual(expect.objectContaining({
      [Object.keys(completed.attempts)[0]!]: expect.objectContaining({ status: "completed" }),
    }));
    client.close();
  });

  it("moves a direct-approval run to review without creating a planner attempt", async () => {
    const root = await repository();
    let sequence = 0;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: directApprovalProgram(),
      supervisor: new ManagedSessionSupervisor(),
      now: () => new Date(1_784_179_200_000 + sequence * 1_000),
      createId: (kind) => `${kind}-${++sequence}`,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({
      projectRoot: root,
      client: "tui",
      version: "1.0.0",
    });

    const created = await client.request("run.create", {
      objective: "Measure a bounded retrieval effect",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Measure a bounded retrieval effect" },
    }, { expectedRevision: 0, idempotencyKey: "create-direct-research" });
    const runId = (created.result as { runId: string }).runId;
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval");

    const reviewable = await engine.store.getRun(runId);
    expect(reviewable.planningMode).toBe("direct");
    expect(reviewable.attempts).toEqual({});
    expect(reviewable.plan).toMatchObject({
      status: "awaiting_approval",
      full: {},
      concise: {},
    });
    expect(reviewable.plan?.graphSeed).toBeUndefined();
    client.close();
  });

  it("executes exactly one review rework before closing on a fresh passing review", async () => {
    const root = await repository();
    let sequence = 0;
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: reviewReworkProgram(),
      supervisor: new ManagedSessionSupervisor(),
      now: () => new Date(1_784_179_200_000 + sequence * 1_000),
      createId: (kind) => `${kind}-${++sequence}`,
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });

    const created = await client.request("run.create", {
      objective: "Implement and independently review the feature",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Implement and independently review the feature" },
    }, { expectedRevision: 0, idempotencyKey: "create-review-rework" });
    const runId = (created.result as { runId: string }).runId;
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval");

    await client.request("authority.ping");
    await client.request("plan.approve", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "approve-review-rework",
    });
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      if (current.lifecycle.phase === "blocked") {
        throw new Error(`review-rework run blocked: ${current.lifecycle.blocker ?? "unknown blocker"}`);
      }
      return current.lifecycle.phase === "merge_ready";
    });

    const ready = await engine.store.getRun(runId);
    const settled = ready.tickets["ticket-one"]!;
    expect(settled.reviewReworkCount).toBe(1);
    expect(settled.reviewReworks).toEqual([
      expect.objectContaining({
        ordinal: 1,
        reopenFromStepId: "implement",
        blocker: "Reviewer found one correctable defect",
      }),
    ]);
    const implementation = settled.steps.find((step) => step.id === "implement")!;
    const review = settled.steps.find((step) => step.id === "review")!;
    expect(implementation.attemptIds).toHaveLength(2);
    expect(review.attemptIds).toHaveLength(2);
    expect(new Set([...implementation.attemptIds, ...review.attemptIds]).size).toBe(4);
    expect(settled.reviewReworks?.[0]?.failedReviewAttemptId).toBe(review.attemptIds[0]);
    expect(review.summary).toBe("Fresh review passed");
    expect(settled.status).toBe("completed");
    expect(ready.git.ticketCycles[settled.gitCycleId!]?.status).toBe("retired");
    client.close();
  });

  it("keeps paused usage at zero across restart and creates only one resume successor", async () => {
    const root = await repository();
    const harness = new LifecycleHarness();
    const program = lifecycleProgram(harness);
    let engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });

    const created = await client.request("run.create", {
      objective: "Exercise durable pause and resume",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Exercise durable pause and resume" },
    }, { expectedRevision: 0, idempotencyKey: "create-lifecycle-run" });
    const runId = (created.result as { runId: string }).runId;
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval");
    await client.request("authority.ping");
    await client.request("plan.approve", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "approve-lifecycle-run",
    });
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return harness.adapters.length === 1 &&
        Object.values(current.attempts).some((attempt) => attempt.status === "running") &&
        totalUsage(current) > 0;
    });

    await client.request("authority.ping");
    await client.request("run.pause", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "pause-lifecycle-run",
    });
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "paused");
    const paused = await engine.store.getRun(runId);
    const pausedUsage = totalUsage(paused);
    const pausedPrompts = harness.promptCalls;
    harness.adapters[0]!.emitUsage(100, 50, 500, 25);
    await client.request("authority.ping");
    expect(totalUsage(await engine.store.getRun(runId))).toBe(pausedUsage);
    expect(harness.promptCalls).toBe(pausedPrompts);

    client.close();
    await engine.stop();
    engines.splice(engines.indexOf(engine), 1);
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    expect((await engine.store.getRun(runId)).lifecycle.phase).toBe("paused");
    expect(harness.promptCalls).toBe(pausedPrompts);
    expect(totalUsage(await engine.store.getRun(runId))).toBe(pausedUsage);

    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await client.request("run.resume", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "resume-lifecycle-run",
    });
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return harness.adapters.length === 2 &&
        Object.values(current.attempts).filter((attempt) => attempt.status === "running").length === 1;
    });
    await client.request("authority.ping");
    const resumed = await engine.store.getRun(runId);
    const ticketAttempts = Object.values(resumed.attempts).filter((attempt) => attempt.ticketId === "ticket-one");
    expect(ticketAttempts).toHaveLength(2);
    expect(new Set(ticketAttempts.map((attempt) => attempt.id)).size).toBe(2);
    expect(ticketAttempts.filter((attempt) => attempt.status === "running")).toHaveLength(1);
    expect(harness.promptCalls).toBe(pausedPrompts + 1);
    client.close();
  });

  it("quiesces active sessions through the cross-build restart control before daemon exit", async () => {
    const root = await repository();
    const harness = new LifecycleHarness();
    const program = lifecycleProgram(harness);
    let shutdownRequested = false;
    let engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
      requestAuthorityShutdown: () => { shutdownRequested = true; },
    });
    engines.push(engine);
    await engine.start();
    let client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    const created = await client.request("run.create", {
      objective: "Preserve a live run across a Core refresh",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Preserve a live run across a Core refresh" },
    }, { expectedRevision: 0, idempotencyKey: "create-refresh-run" });
    const runId = (created.result as { runId: string }).runId;
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval");
    await client.request("authority.ping");
    await client.request("plan.approve", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "approve-refresh-run",
    });
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return harness.adapters.length === 1 &&
        Object.values(current.attempts).some((attempt) => attempt.status === "running");
    });
    client.close();

    const control = await AuthorityClient.connect({
      projectRoot: root,
      client: "compat-control",
      version: "9.0.0",
      buildSha256: `sha256:${"d".repeat(64)}`,
      compatibilityControl: true,
    });
    const quiesced = await control.request("authority.quiesce", undefined, {
      expectedRevision: control.revision,
      idempotencyKey: "refresh-quiesce",
    });
    expect(quiesced.result).toMatchObject({ status: "quiesced", pausedRunIds: [runId] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdownRequested).toBe(true);
    const paused = await engine.store.getRun(runId);
    expect(paused.lifecycle.phase).toBe("paused");
    expect(Object.values(paused.attempts).filter((attempt) => attempt.status === "running")).toEqual([]);
    control.close();

    await engine.stop();
    engines.splice(engines.indexOf(engine), 1);
    engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program,
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    expect((await engine.store.getRun(runId)).lifecycle.phase).toBe("paused");
    client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });
    await client.request("run.resume", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "resume-after-refresh",
    });
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return harness.adapters.length === 2 &&
        Object.values(current.attempts).filter((attempt) => attempt.status === "running").length === 1;
    });
    client.close();
  });

  it("rejects every late effect and cached token after active deletion", async () => {
    const root = await repository();
    const harness = new DeletionHarness();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: deletionProgram(harness),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });

    const created = await client.request("run.create", {
      objective: "Exercise terminal deletion authority",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Exercise terminal deletion authority" },
    }, { expectedRevision: 0, idempotencyKey: "create-deletion-run" });
    const runId = (created.result as { runId: string }).runId;
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval");
    await client.request("authority.ping");
    await client.request("plan.approve", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "approve-deletion-run",
    });
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return harness.adapter !== undefined &&
        harness.writeTool !== undefined &&
        Object.values(current.attempts).some((attempt) => attempt.status === "running") &&
        totalUsage(current) > 0;
    });

    await client.request("authority.ping");
    await client.request("run.delete", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "delete-active-run",
    });
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "deleted");
    const deleted = await engine.store.getRun(runId);
    const deletedUsage = totalUsage(deleted);
    const deletedTickets = canonicalHash(deleted.tickets);
    const deletedActivity = canonicalHash(deleted.activity);
    const deletedReceipts = Object.values(deleted.attempts).reduce(
      (total, attempt) => total + (attempt.authorityToolResults?.length ?? 0),
      0,
    );
    const deletedPrompts = harness.promptCalls;

    await expect(harness.writeTool!.execute("late-write", {
      path: "late.txt",
      content: "must not exist\n",
      expectedSha256: null,
    })).rejects.toMatchObject({ code: "tool_identity" });
    harness.adapter!.emitTerminal({ result: "late-result" });
    harness.adapter!.emitUsage(100, 50, 500, 25);
    await client.request("authority.ping");

    const afterLateEvents = await engine.store.getRun(runId);
    expect(afterLateEvents.lifecycle.phase).toBe("deleted");
    expect(totalUsage(afterLateEvents)).toBe(deletedUsage);
    expect(canonicalHash(afterLateEvents.tickets)).toBe(deletedTickets);
    expect(canonicalHash(afterLateEvents.activity)).toBe(deletedActivity);
    expect(Object.values(afterLateEvents.attempts).reduce(
      (total, attempt) => total + (attempt.authorityToolResults?.length ?? 0),
      0,
    )).toBe(deletedReceipts);
    expect(harness.promptCalls).toBe(deletedPrompts);
    await expect(readFile(path.join(root, "late.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    client.close();
  });

  it("creates one bounded integration ticket for a target conflict without resolver chains", async () => {
    const root = await repository();
    const harness = new GitConflictHarness();
    const engine = await RunAuthorityEngine.open({
      projectRoot: root,
      version: "1.0.0",
      program: gitConflictProgram(harness),
      supervisor: new ManagedSessionSupervisor(),
    });
    engines.push(engine);
    await engine.start();
    const client = await AuthorityClient.connect({ projectRoot: root, client: "tui", version: "1.0.0" });

    const created = await client.request("run.create", {
      objective: "Exercise bounded target conflict integration",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Exercise bounded target conflict integration" },
    }, { expectedRevision: 0, idempotencyKey: "create-conflict-run" });
    const runId = (created.result as { runId: string }).runId;
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "awaiting_approval");
    await client.request("authority.ping");
    await client.request("plan.approve", { runId }, {
      expectedRevision: client.revision,
      idempotencyKey: "approve-conflict-run",
    });
    await waitFor(async () => (await engine.store.getRun(runId)).lifecycle.phase === "verifying");

    await writeFile(path.join(root, "README.md"), "target-side change\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "target-side change");
    harness.releaseVerification();
    await waitFor(async () => {
      const current = await engine.store.getRun(runId);
      return current.tickets["integrate-target"] !== undefined && harness.integrationAttempts === 1;
    });

    const conflicted = await engine.store.getRun(runId);
    const integrationTickets = Object.values(conflicted.tickets).filter((candidate) =>
      candidate.operationId === "resolve-target-integration"
    );
    expect(integrationTickets).toHaveLength(1);
    expect(harness.integrationTicketCalls).toBe(1);
    expect(integrationTickets[0]).toMatchObject({
      id: "integrate-target",
      status: "running",
    });
    expect(integrationTickets[0]!.integrationForTicketId).toBeUndefined();
    expect(Object.values(conflicted.tickets).filter((candidate) =>
      candidate.integrationForTicketId === "integrate-target"
    )).toEqual([]);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("target-side change\n");
    expect(await readFile(path.join(conflicted.git.run.worktree, "README.md"), "utf8")).toBe("run-side change\n");
    await client.request("authority.ping");
    expect(Object.values((await engine.store.getRun(runId)).tickets).filter((candidate) =>
      candidate.operationId === "resolve-target-integration"
    )).toHaveLength(1);
    client.close();
  });
});

function directApprovalProgram(): RunCompilerProgram {
  const planned = fakeProgram();
  return {
    ...planned,
    async resolveRun(request) {
      const resolved = await planned.resolveRun(request);
      return {
        ...resolved,
        planningMode: "direct",
        pipelineStageIds: ["intake", "approval", "initialize", "orchestrate", "verification", "promotion"],
      };
    },
    async initializeDirectApproval(run) {
      return {
        plan: {
          revision: 1,
          status: "planning",
          full: {},
          concise: {},
          graphSeed: undefined,
          steeringHistory: [],
        },
        graphHash: canonicalHash({ runId: run.id, root: run.objective }),
        graphRevision: 0,
      };
    },
  };
}

function reviewReworkProgram(): RunCompilerProgram {
  const direct = directApprovalProgram();
  return {
    ...direct,
    async initializeApprovedPlan() {
      return {
        graphHash: `sha256:${"c".repeat(64)}`,
        graphRevision: 1,
        tickets: { "ticket-one": reviewTicket() },
      };
    },
    async compileAssignmentOutput({ run, assignment }) {
      if (assignment.stepId === "review" && run.tickets[assignment.ticketId]?.reviewReworkCount === 0) {
        return { outcome: { status: "failed", blocker: "Reviewer found one correctable defect" } };
      }
      return {
        outcome: {
          status: "completed",
          summary: assignment.stepId === "review" ? "Fresh review passed" : "Implemented feature",
        },
      };
    },
  };
}

function lifecycleProgram(harness: LifecycleHarness): RunCompilerProgram {
  const direct = directApprovalProgram();
  return {
    ...direct,
    async prepareAttempt(input) {
      const ticketId = input.assignment?.ticketId ?? "run-planning";
      const stepId = input.assignment?.stepId ?? "combined-plan";
      const workspace = input.kind === "verification"
        ? input.run.git.run.worktree
        : input.run.git.ticketCycles[input.run.tickets[ticketId]!.gitCycleId!]!.worktree;
      const spec = fixtureLaunchSpec({
        cwd: workspace,
        sessionDirectory: path.join(input.run.projectRoot, ".sessions", input.attemptId),
        runId: input.run.id,
        ticketId,
        stepId,
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
  };
}

function deletionProgram(harness: DeletionHarness): RunCompilerProgram {
  const direct = directApprovalProgram();
  const terminalSchema = Type.Object({ result: Type.String() }, { additionalProperties: false });
  const names: KoniToolName[] = ["koni_write_file", "koni_submit_output"];
  return {
    ...direct,
    async prepareAttempt(input) {
      const ticketId = input.assignment?.ticketId ?? "run-planning";
      const stepId = input.assignment?.stepId ?? "implement";
      const workspace = input.run.git.ticketCycles[input.run.tickets[ticketId]!.gitCycleId!]!.worktree;
      const context = "Compiler-bound deletion parity context";
      const grant: AuthorityGrant = {
        protocol: "koni.authority-grant.v1",
        grantId: `grant-${input.attemptId}`,
        runId: input.run.id,
        ticketId,
        stepId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        epoch: 1,
        generation: input.run.generation,
        allowedTools: names,
        readPaths: ["."],
        writePaths: ["late.txt"],
        expectedRevision: input.nextAuthorityRevision,
        expectedStateHash: input.expectedAuthorityStateHash,
      };
      expect(grant.expectedStateHash).toBe(
        authorityRevisionStateHash(input.run.projectRoot, input.nextAuthorityRevision),
      );
      const systemPrompt = "Wait for terminal authority.";
      const initialPrompt = "Begin bounded work.";
      const spec = createAgentLaunchSpec({
        protocol: AGENT_LAUNCH_SPEC_PROTOCOL,
        issuedAt: new Date().toISOString(),
        identity: { runId: input.run.id, ticketId, stepId, attemptId: input.attemptId, sessionId: input.sessionId },
        lineage: input.lineage,
        authority: {
          grantId: grant.grantId,
          grantHash: canonicalHash(grant),
          generation: grant.generation,
          epoch: grant.epoch,
          expectedRevision: grant.expectedRevision,
          expectedStateHash: grant.expectedStateHash as `sha256:${string}`,
          authoritativeContextHash: rawSha256(context),
        },
        workspace: { cwd: workspace, sessionDirectory: path.join(input.run.projectRoot, ".sessions", input.attemptId) },
        persona: {
          id: "implementer",
          systemPrompt,
          systemPromptHash: rawSha256(systemPrompt),
          initialPrompt,
          initialPromptHash: rawSha256(initialPrompt),
        },
        model: { provider: "openai-codex", id: "test-model", thinkingLevel: "high" },
        tools: names.map((name) => ({
          name,
          schemaHash: koniToolSchemaHash(name, terminalSchema),
          executionMode: "sequential" as const,
          maxResultBytes: koniToolMaxResultBytes(name),
        })),
        resources: { setHash: computeLaunchResourceSetHash([]), entries: [] },
        budgets: {
          tokens: {
            maxInput: 10_000,
            maxOutput: 10_000,
            maxCacheRead: 10_000,
            maxCacheWrite: 10_000,
            maxNew: 20_000,
            maxAll: 40_000,
          },
          transcript: { maxBytes: 64 * 1024 * 1024 },
          retries: { maxProviderRetries: 0, baseDelayMs: 0 },
        },
        terminal: {
          toolName: "koni_submit_output",
          outputSchemaHash: canonicalHash(terminalSchema),
          maxOutputBytes: 64 * 1024,
        },
      });
      return {
        spec,
        authorityGrant: grant,
        toolNames: names,
        terminalOutputSchema: terminalSchema,
        contextContent: context,
        compactionSnapshot: {
          objective: input.run.objective,
          plan: { architecture: "Approved", decisions: "Approved", risk: "Bounded", verification: "Pending" },
          graphRefs: [],
          touchedFiles: [],
          receiptIds: [],
          checkIds: [],
          unresolvedQuestions: [],
          nextAction: "Perform bounded work",
        },
        factory: (async (_spec, options) => harness.create(spec, options.tools)) satisfies ManagedPiSessionFactory,
      };
    },
  };
}

function gitConflictProgram(harness: GitConflictHarness): RunCompilerProgram {
  const direct = directApprovalProgram();
  return {
    ...direct,
    async prepareAttempt(input) {
      const ticketId = input.assignment?.ticketId ?? "run-planning";
      const stepId = input.assignment?.stepId ?? "implement";
      const workspace = input.run.git.ticketCycles[input.run.tickets[ticketId]!.gitCycleId!]!.worktree;
      const spec = fixtureLaunchSpec({
        cwd: workspace,
        sessionDirectory: path.join(input.run.projectRoot, ".sessions", input.attemptId),
        runId: input.run.id,
        ticketId,
        stepId,
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
    async verifyRun() {
      await harness.verification;
      return { ok: true };
    },
    async createIntegrationTicket() {
      harness.integrationTicketCalls += 1;
      const value = ticket();
      value.id = "integrate-target";
      value.operationId = "resolve-target-integration";
      value.title = "Integrate target conflict";
      value.summary = "Preserve run and target changes in one bounded resolver";
      value.steps[0]!.id = "resolve-conflict";
      value.steps[0]!.title = "Resolve conflict";
      value.steps[0]!.personaId = "integrator";
      value.steps[0]!.kind = "integration";
      return value;
    },
  };
}

function fakeProgram(): RunCompilerProgram {
  return {
    async resolveRun(request) {
      return {
        profile: {
          packageName: "@koni/coding-profile",
          packageVersion: "0.6.0",
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
          instructions: "Ask only material questions.",
          agents: {
            lead: { provider: "test", model: "test-model", thinkingLevel: "off" },
          },
        },
      };
    },
    async initializeDirectApproval() { throw new Error("not used"); },
    async prepareAttempt(input) {
      const ticketId = input.assignment?.ticketId ?? "run-planning";
      const stepId = input.assignment?.stepId ?? "combined-plan";
      const workspace = input.kind === "planning"
        ? input.run.git.planning.worktree
        : input.kind === "verification"
          ? input.run.git.run.worktree
          : input.run.git.ticketCycles[input.run.tickets[ticketId]!.gitCycleId!]!.worktree;
      const spec = fixtureLaunchSpec({
        cwd: workspace,
        sessionDirectory: path.join(input.run.projectRoot, ".sessions", input.attemptId),
        runId: input.run.id,
        ticketId,
        stepId,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        lineage: input.lineage,
      }) as AgentLaunchSpec;
      const adapter = new CompletingAdapter(spec, input.kind);
      return {
        spec,
        tools: [fixtureTool()],
        contextProvider: contextProvider(spec),
        factory: (async () => adapter) satisfies ManagedPiSessionFactory,
      };
    },
    async compilePlanningOutput() {
      return {
        plan: {
          revision: 1,
          status: "planning",
          full: {
            architecture: "## Architecture\nUse the existing seam.",
            decisions: "## Decisions\nNo new platform.",
            risk: "## Risk\nRoutine and bounded.",
            verification: "## Verification\nRun the focused proof.",
          },
          concise: {
            architecture: [{
              title: "Use existing seam",
              description: "Keep the change within the repository boundary.",
            }],
            decisions: [{ title: "No new platform", description: "Reuse established ownership." }],
            risk: [{ title: "Routine scope", description: "No migration or external side effect." }],
            verification: [{ title: "Focused proof", description: "Exercise the observable outcome." }],
          },
          graphSeed: { objective: "feature" },
          steeringHistory: [],
        },
      };
    },
    async initializeApprovedPlan() {
      return {
        graphHash: `sha256:${"c".repeat(64)}`,
        graphRevision: 1,
        tickets: { "ticket-one": ticket() },
      };
    },
    async compileAssignmentOutput() {
      return { outcome: { status: "completed", summary: "Implemented feature" } };
    },
    async verifyRun() {
      return { ok: true };
    },
    async createIntegrationTicket() {
      return { ...ticket(), id: "integrate-target", operationId: "resolve-target-integration" };
    },
  };
}

class CompletingAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  public constructor(
    private readonly spec: AgentLaunchSpec,
    private readonly kind: string,
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] { return [TERMINAL_TOOL_NAME]; }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    this.emit({
      type: "tool_execution_start",
      toolCallId: "terminal",
      toolName: TERMINAL_TOOL_NAME,
      args: { result: this.kind },
    });
    this.emit({
      type: "tool_execution_end",
      toolCallId: "terminal",
      toolName: TERMINAL_TOOL_NAME,
      result: { content: [{ type: "text", text: "accepted" }], terminate: true },
      isError: false,
    });
  }
  public async continue(): Promise<void> { await this.prompt(); }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {}
  public dispose(): void {}
  private emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

class LifecycleHarness {
  public readonly adapters: LifecycleAdapter[] = [];

  public get promptCalls(): number {
    return this.adapters.reduce((total, adapter) => total + adapter.promptCalls, 0);
  }

  public create(spec: AgentLaunchSpec): LifecycleAdapter {
    const adapter = new LifecycleAdapter(spec);
    this.adapters.push(adapter);
    return adapter;
  }
}

class LifecycleAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  public promptCalls = 0;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #drain = deferred<void>();

  public constructor(private readonly spec: AgentLaunchSpec) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] { return [TERMINAL_TOOL_NAME]; }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    this.promptCalls += 1;
    this.emitUsage(3, 2, 5, 1);
    await this.#drain.promise;
  }
  public async continue(): Promise<void> { await this.prompt(); }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> { this.#drain.resolve(); }
  public dispose(): void {}
  public emitUsage(input: number, output: number, cacheRead: number, cacheWrite: number): void {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        api: "openai-responses",
        provider: "openai-codex",
        model: "test-model",
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          totalTokens: input + output + cacheRead + cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    } as unknown as AgentSessionEvent;
    for (const listener of this.#listeners) listener(event);
  }
}

class DeletionHarness {
  public adapter: DeletionAdapter | undefined;
  public writeTool: AuthorityBackedTool | undefined;

  public get promptCalls(): number {
    return this.adapter?.promptCalls ?? 0;
  }

  public create(spec: AgentLaunchSpec, tools: readonly AuthorityBackedTool[]): DeletionAdapter {
    this.writeTool = tools.find((tool) => tool.name === "koni_write_file");
    this.adapter = new DeletionAdapter(spec, tools);
    return this.adapter;
  }
}

class DeletionAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  public promptCalls = 0;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #drain = deferred<void>();

  public constructor(
    private readonly spec: AgentLaunchSpec,
    private readonly tools: readonly AuthorityBackedTool[],
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] { return this.tools.map((tool) => tool.name); }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    this.promptCalls += 1;
    this.emitUsage(3, 2, 5, 1);
    await this.#drain.promise;
  }
  public async continue(): Promise<void> { await this.prompt(); }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> { this.#drain.resolve(); }
  public dispose(): void {}
  public emitTerminal(output: unknown): void {
    for (const listener of this.#listeners) {
      listener({
        type: "tool_execution_start",
        toolCallId: "late-terminal",
        toolName: "koni_submit_output",
        args: output,
      } as AgentSessionEvent);
      listener({
        type: "tool_execution_end",
        toolCallId: "late-terminal",
        toolName: "koni_submit_output",
        result: { content: [{ type: "text", text: "late" }], terminate: true },
        isError: false,
      } as AgentSessionEvent);
    }
  }
  public emitUsage(input: number, output: number, cacheRead: number, cacheWrite: number): void {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        api: "openai-responses",
        provider: "openai-codex",
        model: "test-model",
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          totalTokens: input + output + cacheRead + cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    } as unknown as AgentSessionEvent;
    for (const listener of this.#listeners) listener(event);
  }
}

class GitConflictHarness {
  public integrationAttempts = 0;
  public integrationTicketCalls = 0;
  readonly #verification = deferred<void>();

  public get verification(): Promise<void> { return this.#verification.promise; }
  public releaseVerification(): void { this.#verification.resolve(); }

  public create(spec: AgentLaunchSpec): PiSessionAdapter {
    if (spec.identity.ticketId === "integrate-target") {
      this.integrationAttempts += 1;
      return new HangingAdapter(spec);
    }
    return new FileCompletingAdapter(spec, "run-side change\n");
  }
}

class FileCompletingAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  public constructor(
    private readonly spec: AgentLaunchSpec,
    private readonly content: string,
  ) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] { return [TERMINAL_TOOL_NAME]; }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> {
    await writeFile(path.join(this.spec.workspace.cwd, "README.md"), this.content);
    for (const listener of this.#listeners) {
      listener({
        type: "tool_execution_start",
        toolCallId: "terminal",
        toolName: TERMINAL_TOOL_NAME,
        args: { result: "completed" },
      } as AgentSessionEvent);
      listener({
        type: "tool_execution_end",
        toolCallId: "terminal",
        toolName: TERMINAL_TOOL_NAME,
        result: { content: [{ type: "text", text: "accepted" }], terminate: true },
        isError: false,
      } as AgentSessionEvent);
    }
  }
  public async continue(): Promise<void> { await this.prompt(); }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> {}
  public dispose(): void {}
}

class HangingAdapter implements PiSessionAdapter {
  public readonly sessionId: string;
  public readonly sessionFile: string;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #drain = deferred<void>();

  public constructor(private readonly spec: AgentLaunchSpec) {
    this.sessionId = spec.identity.sessionId;
    this.sessionFile = path.join(spec.workspace.sessionDirectory, `${this.sessionId}.jsonl`);
  }

  public getActiveToolNames(): readonly string[] { return [TERMINAL_TOOL_NAME]; }
  public appendMapping(): void {}
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  public async prompt(): Promise<void> { await this.#drain.promise; }
  public async continue(): Promise<void> { await this.prompt(); }
  public async steer(): Promise<void> {}
  public async followUp(): Promise<void> {}
  public async abort(): Promise<void> { this.#drain.resolve(); }
  public dispose(): void {}
}

function contextProvider(spec: AgentLaunchSpec): KoniContextProvider {
  return {
    async loadBoundContext() { throw new Error("not used in the offline engine seam"); },
    async loadCompactionSnapshot() { throw new Error("not used in the offline engine seam"); },
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
          status: "continue",
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

function ticket(): TicketRecord {
  const now = "2026-07-16T00:00:00.000Z";
  return {
    id: "ticket-one",
    operationId: "implement-change",
    title: "Implement feature",
    summary: "Implement the approved feature",
    status: "todo",
    priority: 0,
    dependencyIds: [],
    targetNodeIds: ["change-one"],
    readPaths: ["."],
    writePaths: ["README.md"],
    steps: [{
      id: "implement",
      title: "Implement",
      personaId: "implementer",
      kind: "production",
      status: "pending",
      attemptIds: [],
      summary: undefined,
      startedAt: undefined,
      completedAt: undefined,
    }],
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function reviewTicket(): TicketRecord {
  const value = ticket();
  value.steps.push({
    id: "review",
    title: "Review",
    personaId: "reviewer",
    kind: "review",
    status: "pending",
    attemptIds: [],
    summary: undefined,
    startedAt: undefined,
    completedAt: undefined,
  });
  value.reviewFailureReopenFrom = "implement";
  value.reviewReworkLimit = 1;
  value.reviewReworkCount = 0;
  value.reviewReworks = [];
  return value;
}

function totalUsage(run: { attempts: RunRecord["attempts"] }): number {
  return Object.values(run.attempts).reduce((total, attempt) => total +
    attempt.inputTokens + attempt.outputTokens + attempt.cacheReadTokens + attempt.cacheWriteTokens, 0);
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for authority state");
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-engine-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "koni@example.invalid");
  await git(root, "config", "user.name", "Koni Test");
  await writeFile(path.join(root, "README.md"), "initial\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "initial");
  return root;
}

function git(cwd: string, ...argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...argv], { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve()
      : reject(new Error(Buffer.concat(stderr).toString("utf8"))));
  });
}
