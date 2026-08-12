import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveCompilerTicketDependencies } from "../src/compiler/ticket-dependencies.js";
import type { DerivedTicketDefinition, DerivedTicketScope } from "../src/contracts/rules.js";
import { canonicalHash } from "../src/shared/canonical.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type { RunRecord, TicketRecord, TicketStepRecord } from "../src/state/run-record.js";
import {
  beginAssignment,
  deriveReadyAssignments,
  finishAssignment,
} from "../src/state/scheduler.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("compiler ticket dependency projection", () => {
  it("derives a deterministic conflict closure that survives incremental reconciliation", async () => {
    const root = await projectRoot();
    const definitions = [
      definition("ticket-a", 30, scope({ writeNodes: ["node-shared"] })),
      definition("ticket-b", 20, scope({ readNodes: ["node-shared"], writeNodes: ["node-b"] })),
      definition("ticket-c", 10, scope({ readNodes: ["node-shared"], writeNodes: ["node-b"] })),
      definition("ticket-d", 0, scope({ writeNodes: ["node-independent"] })),
    ];
    const dependencies = deriveCompilerTicketDependencies(definitions, root);
    expect(Object.fromEntries(dependencies)).toEqual({
      "ticket-a": [],
      "ticket-b": ["ticket-a"],
      "ticket-c": ["ticket-a", "ticket-b"],
      "ticket-d": [],
    });
    expect(
      Object.fromEntries(deriveCompilerTicketDependencies([...definitions].reverse(), root)),
    ).toEqual(Object.fromEntries(dependencies));
  });

  it("orders run-plan compilation before execution for the same run node", async () => {
    const root = await projectRoot();
    const definitions = [
      definition("ticket-run", 200, scope({ writeNodes: ["run-a"] }), {
        operation: "run-experiment",
        operationRegistryId: "execution.run.run-experiment",
      }),
    ];
    const retained = [
      {
        id: "ticket-compile",
        priority: -190_230,
        operationRegistryId: "execution.node.compile-run-plan",
        scope: scope({ writeNodes: ["run-a"] }),
      },
    ];

    expect(
      Object.fromEntries(deriveCompilerTicketDependencies(definitions, root, retained)),
    ).toEqual({
      "ticket-compile": [],
      "ticket-run": ["ticket-compile"],
    });
  });

  it("orders an asset implementation before runtime execution that reads the asset", async () => {
    const root = await projectRoot();
    const definitions = [
      definition("ticket-run", 200, scope({ readNodes: ["asset-a"], writeNodes: ["run-a"] }), {
        operation: "run-experiment",
        operationRegistryId: "execution.run.run-experiment",
      }),
      definition("ticket-asset", 155, scope({ writeNodes: ["asset-a"] }), {
        operation: "implement-asset",
        operationRegistryId: "asset-resolution.asset.implement-asset",
      }),
    ];

    expect(Object.fromEntries(deriveCompilerTicketDependencies(definitions, root))).toEqual({
      "ticket-asset": [],
      "ticket-run": ["ticket-asset"],
    });
  });

  it("orders an asset implementation before run-plan compilation even before execution is projected", async () => {
    const root = await projectRoot();
    const definitions = [
      definition("ticket-compile", 190, scope({ readNodes: ["asset-a"], writeNodes: ["run-a"] }), {
        operation: "compile-run-plan",
        operationRegistryId: "execution.node.compile-run-plan",
      }),
      definition("ticket-asset", 155, scope({ writeNodes: ["asset-a"] }), {
        operation: "implement-asset",
        operationRegistryId: "asset-resolution.asset.implement-asset",
      }),
    ];

    expect(Object.fromEntries(deriveCompilerTicketDependencies(definitions, root))).toEqual({
      "ticket-asset": [],
      "ticket-compile": ["ticket-asset"],
    });
  });

  it("orders runtime assets before both run-plan compilation and execution", async () => {
    const root = await projectRoot();
    const definitions = [
      definition("ticket-run", 200, scope({ readNodes: ["asset-a"], writeNodes: ["run-a"] }), {
        operation: "run-experiment",
        operationRegistryId: "execution.run.run-experiment",
      }),
      definition("ticket-asset", 155, scope({ writeNodes: ["asset-a"] }), {
        operation: "implement-asset",
        operationRegistryId: "asset-resolution.asset.implement-asset",
      }),
    ];
    const retained = [
      {
        id: "ticket-compile",
        priority: -190_230,
        operationRegistryId: "execution.node.compile-run-plan",
        scope: scope({ writeNodes: ["run-a"] }),
      },
    ];

    expect(
      Object.fromEntries(deriveCompilerTicketDependencies(definitions, root, retained)),
    ).toEqual({
      "ticket-asset": [],
      "ticket-compile": ["ticket-asset"],
      "ticket-run": ["ticket-asset", "ticket-compile"],
    });
  });

  it("orders a gate recheck before run-plan work that reads the gate", async () => {
    const root = await projectRoot();
    const definitions = [
      definition("ticket-compile", 190, scope({ readNodes: ["gate-a"], writeNodes: ["run-a"] }), {
        operation: "compile-run-plan",
        operationRegistryId: "execution.node.compile-run-plan",
      }),
      definition("ticket-gate", 0, scope({ readNodes: ["asset-a"], writeNodes: ["gate-a"] }), {
        operation: "run-gate",
        operationRegistryId: "gates.gate.run-gate",
      }),
      definition("ticket-asset", 155, scope({ writeNodes: ["asset-a"] }), {
        operation: "implement-asset",
        operationRegistryId: "asset-resolution.asset.implement-asset",
      }),
    ];

    expect(Object.fromEntries(deriveCompilerTicketDependencies(definitions, root))).toEqual({
      "ticket-asset": [],
      "ticket-compile": ["ticket-gate"],
      "ticket-gate": ["ticket-asset"],
    });
  });

  it("settles narrower equal-priority path authority before an overlapping broad scope", async () => {
    const root = await projectRoot();
    const definitions = [
      definition(
        "ticket-a-broad-consumer",
        20,
        scope({
          readPaths: ["program/assets"],
          writePaths: ["program/assets"],
        }),
      ),
      definition(
        "ticket-z-specific-producer",
        20,
        scope({
          readPaths: ["program/assets/dev_suite"],
          writePaths: ["program/assets/dev_suite"],
        }),
      ),
    ];

    expect(Object.fromEntries(deriveCompilerTicketDependencies(definitions, root))).toEqual({
      "ticket-a-broad-consumer": ["ticket-z-specific-producer"],
      "ticket-z-specific-producer": [],
    });
  });

  it("serializes hard-link aliases and fails closed when path authority is unsafe", async () => {
    const root = await projectRoot();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "canonical.ts"), "export {};\n");
    await link(path.join(root, "src", "canonical.ts"), path.join(root, "src", "hardlink.ts"));
    const hardlinks = deriveCompilerTicketDependencies(
      [
        definition("ticket-a", 20, scope({ writePaths: ["src/canonical.ts"] })),
        definition("ticket-b", 10, scope({ readPaths: ["src/hardlink.ts"] })),
      ],
      root,
    );
    expect(hardlinks.get("ticket-b")).toEqual(["ticket-a"]);

    await symlink("canonical.ts", path.join(root, "src", "alias.ts"));
    expect(() =>
      deriveCompilerTicketDependencies(
        [
          definition("ticket-a", 20, scope({ writePaths: ["src/canonical.ts"] })),
          definition("ticket-b", 10, scope({ readPaths: ["src/alias.ts"] })),
        ],
        root,
      ),
    ).toThrow(/could not be compared safely/u);
  });
});

describe("dependency- and scope-safe scheduler admission", () => {
  it("admits retained run-plan compilation before conflicting runtime execution", async () => {
    const root = await projectRoot();
    const run = runRecord(root, 1);
    run.tickets["ticket-compile"] = ticket("ticket-compile", -190_230, {
      operationId: "execution.node.compile-run-plan",
      writeNodes: ["run-a"],
    });
    run.tickets["ticket-run"] = ticket("ticket-run", -200_220, {
      operationId: "execution.run.run-experiment",
      writeNodes: ["run-a"],
    });

    expect(deriveReadyAssignments(run, 1).ready.map((assignment) => assignment.ticketId)).toEqual([
      "ticket-compile",
    ]);
  });

  it("selects the deterministic maximal disjoint set under maxParallel", async () => {
    const root = await projectRoot();
    const run = runRecord(root, 3);
    run.tickets["ticket-a"] = ticket("ticket-a", 0, { writeNodes: ["shared"] });
    run.tickets["ticket-b"] = ticket("ticket-b", 1, { readNodes: ["shared"] });
    run.tickets["ticket-c"] = ticket("ticket-c", 2, { writeNodes: ["independent"] });
    const projection = deriveReadyAssignments(run, 3);
    expect(projection.ready.map((assignment) => assignment.ticketId)).toEqual([
      "ticket-a",
      "ticket-c",
    ]);
    expect(projection.scopeConflicts).toEqual([
      {
        ticketId: "ticket-b",
        stepId: "work",
        conflictsWithTicketId: "ticket-a",
        conflictsWithStepId: "work",
        reason: "overlapping_scope",
      },
    ]);
  });

  it("reserves running assignment scope across crash recovery and rejects stale admission", async () => {
    const root = await projectRoot();
    const run = runRecord(root, 2);
    run.tickets["ticket-b"] = ticket("ticket-b", 1, { readNodes: ["shared"] });
    const stale = deriveReadyAssignments(run, 2).ready[0]!;
    const active = ticket("ticket-a", 0, { writeNodes: ["shared"] });
    active.status = "running";
    active.steps[0]!.status = "running";
    active.steps[0]!.attemptIds = ["attempt-live"];
    run.tickets[active.id] = active;

    const recovered = deriveReadyAssignments(run, 2);
    expect(recovered.activeCount).toBe(1);
    expect(recovered.ready).toEqual([]);
    expect(recovered.scopeConflicts[0]).toMatchObject({
      ticketId: "ticket-b",
      conflictsWithTicketId: "ticket-a",
    });
    expect(() => beginAssignment(run, stale, "attempt-stale", "2026-07-17T00:00:00.000Z")).toThrow(
      /not currently scheduler-admissible/u,
    );
  });

  it("uses physical path authority and conservatively aliases missing case/Unicode variants", async () => {
    const root = await projectRoot();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "canonical.ts"), "export {};\n");
    await link(path.join(root, "src", "canonical.ts"), path.join(root, "src", "hardlink.ts"));
    const hardlinkRun = runRecord(root, 2);
    hardlinkRun.tickets["ticket-a"] = ticket("ticket-a", 0, { writePaths: ["src/canonical.ts"] });
    hardlinkRun.tickets["ticket-b"] = ticket("ticket-b", 1, { readPaths: ["src/hardlink.ts"] });
    expect(
      deriveReadyAssignments(hardlinkRun, 2).ready.map((assignment) => assignment.ticketId),
    ).toEqual(["ticket-a"]);

    const missingRun = runRecord(root, 2);
    missingRun.tickets["ticket-a"] = ticket("ticket-a", 0, { writePaths: ["src/Café.ts"] });
    missingRun.tickets["ticket-b"] = ticket("ticket-b", 1, { readPaths: ["src/CAFE\u0301.ts"] });
    expect(
      deriveReadyAssignments(missingRun, 2).ready.map((assignment) => assignment.ticketId),
    ).toEqual(["ticket-a"]);
  });

  it("fails closed on symlinks instead of launching ambiguous file authority", async () => {
    const root = await projectRoot();
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "canonical.ts"), "export {};\n");
    await symlink("canonical.ts", path.join(root, "src", "alias.ts"));
    const run = runRecord(root, 2);
    run.tickets["ticket-a"] = ticket("ticket-a", 0, { writePaths: ["src/canonical.ts"] });
    run.tickets["ticket-b"] = ticket("ticket-b", 1, { readPaths: ["src/alias.ts"] });
    const projection = deriveReadyAssignments(run, 2);
    expect(projection.ready.map((assignment) => assignment.ticketId)).toEqual(["ticket-a"]);
    expect(projection.scopeConflicts[0]?.reason).toBe("scope_authority_unavailable");
  });

  it("executes a non-linear step DAG and reopens only descendants of a failed review owner", async () => {
    const root = await projectRoot();
    const run = runRecord(root, 1);
    const value = ticket("ticket-dag", 0, {});
    value.steps = [
      step("review", ["implement"]),
      step("docs", []),
      step("implement", ["explore"]),
      step("explore", []),
    ];
    value.steps[0]!.kind = "review";
    value.steps[2]!.kind = "production";
    value.reviewFailureReopenFrom = "implement";
    value.reviewReworkLimit = 1;
    value.reviewReworkCount = 0;
    value.reviewReworks = [];
    run.tickets[value.id] = value;

    expect(deriveReadyAssignments(run, 1).ready[0]?.stepId).toBe("docs");
    value.steps[1]!.status = "completed";
    expect(deriveReadyAssignments(run, 1).ready[0]?.stepId).toBe("explore");
    value.steps[3]!.status = "completed";
    expect(deriveReadyAssignments(run, 1).ready[0]?.stepId).toBe("implement");
    value.steps[2]!.status = "completed";
    const review = deriveReadyAssignments(run, 1).ready[0]!;
    beginAssignment(run, review, "attempt-review", "2026-07-17T00:00:01.000Z");
    expect(
      finishAssignment(
        run,
        review,
        { status: "failed", blocker: "boundary missing" },
        "2026-07-17T00:00:02.000Z",
      ),
    ).toEqual({ disposition: "review_rework" });
    expect(value.steps.map((candidate) => [candidate.id, candidate.status])).toEqual([
      ["review", "pending"],
      ["docs", "completed"],
      ["implement", "pending"],
      ["explore", "completed"],
    ]);
  });

  it("admits no work while paused or deleted", async () => {
    const root = await projectRoot();
    const run = runRecord(root, 2);
    run.tickets["ticket-a"] = ticket("ticket-a", 0, {});
    run.lifecycle = reduceRunLifecycle(run.lifecycle, { type: "pause_requested", atMs: 10 }).state;
    run.lifecycle = reduceRunLifecycle(run.lifecycle, { type: "pause_settled", atMs: 11 }).state;
    expect(deriveReadyAssignments(run, 2).ready).toEqual([]);
    run.lifecycle = reduceRunLifecycle(run.lifecycle, { type: "delete_requested", atMs: 12 }).state;
    run.lifecycle = reduceRunLifecycle(run.lifecycle, { type: "delete_settled", atMs: 13 }).state;
    expect(deriveReadyAssignments(run, 2).ready).toEqual([]);
  });
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-scheduler-authority-"));
  roots.push(root);
  return root;
}

function runRecord(projectRoot: string, maxParallel: number): RunRecord {
  let lifecycle = newRunLifecycle("run-scope");
  lifecycle = reduceRunLifecycle(lifecycle, { type: "planning_started", atMs: 1 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_submitted", atMs: 2 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approval_requested", atMs: 3 }).state;
  lifecycle = reduceRunLifecycle(lifecycle, { type: "plan_approved", atMs: 4 }).state;
  return {
    protocol: "koni.run-record.v1",
    id: "run-scope",
    revision: 0,
    generation: 0,
    projectRoot,
    profile: {
      packageName: "@koni/coding-profile",
      packageVersion: "1.0.0",
      lineage: "koni.software",
      bundleHash: canonicalHash("bundle"),
    },
    compiledConfigHash: canonicalHash("configuration"),
    runTypeId: "medium",
    objective: "Exercise safe scheduling",
    intake: { goal: "Exercise safe scheduling" },
    executionConfig: {
      maxParallel,
      disjointScopeParallelism: true,
      questionPolicy: "some",
      instructions: "",
      agents: {},
    },
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    lifecycle,
    pipelineStageIds: ["planning", "approval", "orchestrate"],
    currentPipelineStageId: "orchestrate",
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(projectRoot, "run-scope", "approved"),
  };
}

function ticket(
  id: string,
  priority: number,
  options: {
    operationId?: string;
    dependencyIds?: string[];
    readNodes?: string[];
    writeNodes?: string[];
    readPaths?: string[];
    writePaths?: string[];
  },
): TicketRecord {
  return {
    id,
    operationId: options.operationId ?? "implement",
    title: id,
    summary: id,
    status: "queued",
    priority,
    dependencyIds: options.dependencyIds ?? [],
    targetNodeIds: [],
    readNodeIds: options.readNodes ?? [],
    writeNodeIds: options.writeNodes ?? [],
    readPaths: options.readPaths ?? [],
    writePaths: options.writePaths ?? [],
    steps: [step("work", [])],
    worktreePath: undefined,
    branch: undefined,
    blocker: undefined,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
}

function step(id: string, dependsOn: string[]): TicketStepRecord {
  return {
    id,
    title: id,
    personaId: "worker",
    kind: "production",
    dependsOn,
    status: "pending",
    attemptIds: [],
    summary: undefined,
    startedAt: undefined,
    completedAt: undefined,
  };
}

function scope(options: {
  readNodes?: string[];
  writeNodes?: string[];
  readPaths?: string[];
  writePaths?: string[];
}): DerivedTicketScope {
  return {
    read_node_ids: options.readNodes ?? [],
    write_node_ids: options.writeNodes ?? [],
    read_paths: options.readPaths ?? [],
    write_paths: options.writePaths ?? [],
  };
}

function definition(
  id: string,
  rulePriority: number,
  ticketScope: DerivedTicketScope,
  options: { operation?: string; operationRegistryId?: string } = {},
): DerivedTicketDefinition {
  const material = {
    protocol: "koni.derived-ticket.v1" as const,
    id,
    rule_id: `rule-${id}`,
    rule_phase: "work",
    rule_priority: rulePriority,
    anchor_node_id: "anchor",
    operation: options.operation ?? "implement",
    operation_registry_id: options.operationRegistryId ?? "implement",
    operation_dispatch_priority: 0,
    ranking_hints: [],
    title: id,
    target_node_ids: [],
    scope: ticketScope,
    source_state_key: "ready",
    target_state_key: "complete",
    obligation_keys: [],
    workflow: [],
    configuration_sha256: canonicalHash("configuration"),
  };
  return { ...material, definition_sha256: canonicalHash(material) };
}
