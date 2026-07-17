import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAuthorityEndpoint } from "../src/authority/endpoint.js";
import type { TransactionWrite } from "../src/authority/file-journal.js";
import {
  NativeRunCompilerProgram,
  NativeRunProgramError,
} from "../src/compiler/run-program.js";
import type { VerifiedProfileBaseline } from "../src/compiler/profile-package.js";
import type { GraphNode } from "../src/graph/model.js";
import type { AgentLaunchSpec } from "../src/pi/launch-spec.js";
import { canonicalHash, rawSha256, type Sha256Digest } from "../src/shared/canonical.js";
import { installProfile, loadProfilePackage } from "../src/profile/install.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import {
  assertRunRecord,
  type AgentAttemptRecord,
  type RunQuestionRecord,
  type RunRecord,
} from "../src/state/run-record.js";
import type { ReadyAssignment } from "../src/state/scheduler.js";
import { attachFixtureTicketCycle, fixtureRunGit } from "./run-record-fixtures.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];
const FIXED_NOW = new Date("2026-07-16T19:00:00.000Z");

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native compiler-authoritative run program", () => {
  it("reloads the authenticated package baseline for each future run while preserving pinned runs", async () => {
    const project = await installedProject("coding-profile");
    let loaderCalls = 0;
    const program = await NativeRunCompilerProgram.create({
      projectRoot: project.projectRoot,
      packageBaseline: project.baseline,
      packageBaselineLoader: async () => {
        loaderCalls += 1;
        return project.baseline;
      },
      now: () => new Date(FIXED_NOW),
    });

    const first = await program.resolveRun({
      runId: "run-before-profile-reload",
      objective: "Pin the first effective configuration",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Pin the first effective configuration" },
    });
    await persistWrites(project.projectRoot, first.artifactWrites ?? []);
    const firstRun = runRecord(
      project.projectRoot,
      "run-before-profile-reload",
      "Pin the first effective configuration",
      first,
    );

    const projectYaml = path.join(project.projectRoot, ".koni", "project.yaml");
    await writeFile(projectYaml, (await readFile(projectYaml, "utf8")).replace(
      "title: Software project",
      "title: Future-run configuration",
    ));
    const second = await program.resolveRun({
      runId: "run-after-profile-reload",
      objective: "Compile the newly edited configuration",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Compile the newly edited configuration" },
    });

    expect(loaderCalls).toBe(2);
    expect(second.compiledConfigHash).not.toBe(first.compiledConfigHash);
    await expect(program.prepareAttempt({
      kind: "planning",
      run: firstRun,
      attemptId: "attempt-from-pinned-first-run",
      sessionId: "session-from-pinned-first-run",
      nextAuthorityRevision: 2,
      expectedAuthorityStateHash: digest("pinned-first-run"),
      lineage: { branchEpoch: 0, reason: "initial" },
    })).resolves.toMatchObject({
      spec: {
        identity: { runId: firstRun.id },
      },
    });
    expect(loaderCalls).toBe(2);
  });

  it("pins coding resolution, injects answered questions once, and recovers the immutable Pi attempt", async () => {
    const project = await installedProject("coding-profile");
    const personasPath = path.join(project.projectRoot, ".koni", "personas.yaml");
    await writeFile(personasPath, (await readFile(personasPath, "utf8")).replace(
      "  model_role: planner\n",
      "  model_role: planner\n  skills:\n  - configure-koni\n",
    ));
    const program = await compilerProgram(project);
    const runId = "run-native-planning";
    const resolved = await program.resolveRun({
      runId,
      objective: "Add a compact notes workflow",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Add a compact notes workflow" },
      overrides: {
        maxParallel: 2,
        roles: {
          ticket_worker: { model: "gpt-role-worker", thinkingLevel: "low" },
        },
        agents: {
          lead: { thinkingLevel: "max" },
          implementer: { model: "gpt-persona-worker" },
        },
      },
    });
    expect(resolved.executionConfig.maxParallel).toBe(2);
    expect(resolved.executionConfig.agents["run-planner"]).toMatchObject({
      model: "gpt-5.6-terra",
      thinkingLevel: "xhigh",
    });
    expect(resolved.executionConfig.agents.implementer).toMatchObject({
      model: "gpt-persona-worker",
      thinkingLevel: "low",
    });
    expect(resolved.executionConfig.agents["architecture-mapper"]).toMatchObject({
      model: "gpt-role-worker",
      thinkingLevel: "low",
    });
    expect(resolved.executionConfig.agents.lead?.thinkingLevel).toBe("max");
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);

    const run = runRecord(project.projectRoot, runId, "Add a compact notes workflow", resolved);
    run.questions["question-product"] = answeredQuestion();
    const prepared = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-planning-one",
      sessionId: "session-planning-one",
      nextAuthorityRevision: 4,
      expectedAuthorityStateHash: digest("authority-four"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(prepared.spec.lineage).toEqual({ branchEpoch: 0, reason: "initial" });
    expect(prepared.spec.resources.entries.some((entry) => entry.kind === "context")).toBe(false);
    expect(prepared.spec.resources.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "skills/configure-koni/SKILL.md" }),
      expect.objectContaining({ relativePath: "skills/configure-koni/references/agents-and-skills.md" }),
    ]));
    expect(prepared.spec.persona.systemPrompt).toContain("koni_context only when you need an explicit refresh");
    expect(prepared.contextContent).toContain("Use local-first storage");
    expect(prepared.contextContent).toContain("Keep export reversible");
    expect(prepared.contextContent?.match(/Use local-first storage/gu)).toHaveLength(1);
    expect(prepared.toolNames).toContain("koni_context");
    expect(prepared.toolNames).toContain("koni_read_resource");
    expect(prepared.spec.tools.find((tool) => tool.name === "koni_read_resource")?.executionMode).toBe("parallel");
    expect(prepared.spec.budgets.transcript).toEqual({ maxBytes: 64 * 1024 * 1024 });
    expect(prepared.spec.budgets.repositoryCalls).toEqual({ max: 16 });
    expect(prepared.spec.budgets.tokens).toMatchObject({ maxNew: 120_000 });
    expect(prepared.spec.persona.systemPrompt).toContain("bounded to 16 total");
    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);

    const attempt = attemptRecord(prepared.spec, "planning", "running");
    run.attempts[attempt.id] = attempt;
    const projectYaml = path.join(project.projectRoot, ".koni", "project.yaml");
    await writeFile(projectYaml, (await readFile(projectYaml, "utf8")).replace(
      "title: Software project",
      "title: Changed after this run was pinned",
    ));
    const restarted = await compilerProgram(project);
    const recovered = await restarted.recoverAttempt({ run, attempt, spec: prepared.spec });
    expect(recovered.spec).toBe(prepared.spec);
    expect(recovered.contextContent).toBe(prepared.contextContent);
    expect(canonicalHash(recovered.authorityGrant!)).toBe(prepared.spec.authority.grantHash);
    expect(recovered.toolNames).toEqual(prepared.spec.tools.map((tool) => tool.name));
    expect(await restarted.refreshCompactionSnapshot({ run, attempt, spec: prepared.spec })).toMatchObject({
      touchedFiles: [],
      receiptIds: [],
      unresolvedQuestions: [],
    });
    const receiptPath = `runs/${run.id}/attempts/${attempt.id}/tool-receipts/write.json`;
    const receiptBytes = Buffer.from(`${JSON.stringify({
      receiptId: "receipt-write-notes",
      summary: "Wrote src/notes.ts",
      value: { path: "src/notes.ts", sha256: digest("notes-bytes") },
    })}\n`, "utf8");
    await persistWrites(project.projectRoot, [{
      path: receiptPath,
      bytes: receiptBytes,
      expectedSha256: null,
    }]);
    attempt.authorityToolResults = [{
      sequence: 1,
      callId: "call-write-notes",
      toolName: "koni_write_file",
      outcome: "accepted",
      argumentsSha256: rawSha256("{}"),
      argumentsSizeBytes: 2,
      receiptSha256: rawSha256(receiptBytes),
      receiptSizeBytes: receiptBytes.byteLength,
      artifactPath: receiptPath,
      recordedAt: FIXED_NOW.toISOString(),
    }];
    expect(await restarted.refreshCompactionSnapshot({ run, attempt, spec: prepared.spec })).toMatchObject({
      touchedFiles: ["src/notes.ts"],
      receiptIds: ["receipt-write-notes"],
    });

    await expect(program.resolveRun({
      runId: "run-invalid-thinking",
      objective: "Reject a legacy level",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Reject a legacy level" },
      overrides: { agents: { lead: { thinkingLevel: "ultra" } } },
    })).rejects.toBeInstanceOf(NativeRunProgramError);
  });

  it("resumes relocated legacy planning without weakening native detached planning", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const runId = "run-relocated-legacy-planning";
    const objective = "Resume a planning attempt after legacy Git relocation";
    const resolved = await program.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);

    const run = runRecord(project.projectRoot, runId, objective, resolved);
    run.git = fixtureRunGit(project.projectRoot, runId, "approved");
    const namespace = run.git.namespace;
    namespace.planningWorktree = path.join(namespace.root, "planning");
    namespace.runWorktree = path.join(namespace.root, "integration");
    namespace.ticketRoot = path.join(namespace.root, "tickets");
    run.git.planning.worktree = namespace.planningWorktree;
    run.git.run.worktree = namespace.runWorktree;

    await expect(program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-native-missing-planner",
      sessionId: "session-native-missing-planner",
      nextAuthorityRevision: 2,
      expectedAuthorityStateHash: digest("native-missing-planner"),
      lineage: { branchEpoch: 0, reason: "initial" },
    })).rejects.toMatchObject({ code: "planning_workspace" });

    const source = {
      targetRef: run.git.target.ref,
      targetBaseOid: run.git.target.selectedOid,
      runBranch: run.git.namespace.runRef.slice("refs/heads/".length),
      runWorktree: namespace.root,
      namespaceStatus: "ready" as const,
      materializedAt: FIXED_NOW.toISOString(),
    };
    const stagingWorktree = path.join(
      run.git.commonDirectory,
      "koni",
      "worktrees",
      "migrations",
      runId,
      "integration",
    );
    run.legacyGitMigration = {
      protocol: "koni.legacy-run-git-migration.v1",
      status: "relocated",
      sourceGitSha256: canonicalHash(source),
      source,
      migratedAt: FIXED_NOW.toISOString(),
      reason: undefined,
      relocation: {
        protocol: "koni.legacy-run-relocation.v1",
        runId,
        sourceGitSha256: canonicalHash(source),
        projectRoot: run.projectRoot,
        commonDirectory: run.git.commonDirectory,
        target: {
          ref: run.git.target.ref,
          selectedOid: run.git.target.selectedOid,
          observedOid: run.git.target.selectedOid,
        },
        source: {
          branchRef: run.git.namespace.runRef,
          worktree: namespace.root,
          expectedHeadOid: run.git.run.headOid!,
          registered: true,
          clean: true,
        },
        destination: {
          namespaceRoot: namespace.root,
          stagingWorktree,
          planningWorktree: namespace.planningWorktree,
          runWorktree: namespace.runWorktree,
          ticketRoot: namespace.ticketRoot,
        },
        expectedAbsentPaths: [
          namespace.planningWorktree,
          namespace.runWorktree,
          namespace.ticketRoot,
          stagingWorktree,
        ].sort(),
        ticketProjectionIds: [],
        priorPhase: "planning",
        plannedAt: FIXED_NOW.toISOString(),
      },
      relocationIntentId: "legacy-relocate-run-relocated-legacy-planning",
      relocatedAt: FIXED_NOW.toISOString(),
      retirementIntentId: undefined,
      retiredAt: undefined,
    };
    expect(() => assertRunRecord(run)).not.toThrow();

    await expect(program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-relocated-legacy-planner",
      sessionId: "session-relocated-legacy-planner",
      nextAuthorityRevision: 3,
      expectedAuthorityStateHash: digest("relocated-legacy-planner"),
      lineage: { branchEpoch: 0, reason: "initial" },
    })).resolves.toMatchObject({
      spec: { workspace: { cwd: path.resolve(namespace.runWorktree) } },
    });
  });

  it("compiles a coding plan into deterministic tickets and validates a scoped graph mutation", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const runId = "run-native-coding";
    const resolved = await program.resolveRun({
      runId,
      objective: "Add note pinning",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Add note pinning" },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, "Add note pinning", resolved);
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-plan",
      output: planningOutput({ work_kind: "general" }),
    });
    expect(Object.keys(planning.plan.full).sort()).toEqual(["architecture", "decisions", "risk", "verification"]);
    expect(Object.keys(planning.plan.concise).sort()).toEqual(["architecture", "decisions", "risk", "verification"]);
    for (const domain of ["architecture", "decisions", "risk", "verification"] as const) {
      expect(planning.plan.full[domain]).toMatch(/^## /u);
      expect(planning.plan.concise[domain]).toEqual([
        expect.objectContaining({ title: expect.any(String), description: expect.any(String) }),
      ]);
    }
    expect(planning.plan.concise.architecture?.[0]?.title).toBe("Notes ownership seam");
    const incompleteFull = fullPlans();
    delete incompleteFull.verification;
    await expect(program.compilePlanningOutput({
      run,
      attemptId: "attempt-incomplete-plan",
      output: {
        ...planningOutput({ work_kind: "general" }) as Record<string, unknown>,
        full: incompleteFull,
      },
    })).rejects.toBeInstanceOf(NativeRunProgramError);
    await expect(program.compilePlanningOutput({
      run,
      attemptId: "attempt-malformed-plan",
      output: {
        full: fullPlans(),
        concise: { architecture: ["Truncated prose is not a structured mini-plan"] },
        graphSeed: { rootSpec: { work_kind: "general" }, nodes: [], edges: [] },
      },
    })).rejects.toBeInstanceOf(NativeRunProgramError);

    run.plan = { ...planning.plan, status: "approved" };
    run.graphHash = planning.graphHash;
    run.graphRevision = planning.graphRevision ?? 0;
    const approved = await program.initializeApprovedPlan(run);
    expect(Object.values(approved.tickets)).toHaveLength(1);
    const architectureTicket = Object.values(approved.tickets)[0]!;
    expect(architectureTicket.operationId).toBe("architecture.objective.map");
    await persistWrites(project.projectRoot, approved.artifactWrites ?? []);
    run.graphHash = approved.graphHash;
    run.graphRevision = approved.graphRevision;
    run.tickets = approved.tickets;

    const initialProjection = await program.projectGraph(run, architectureTicket.id);
    expect(initialProjection.nodes).toHaveLength(1);
    expect(initialProjection.nodes[0]?.type).toBe("objective");
    const assignment = assignmentFor(run, architectureTicket.id);
    const prepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment,
      attemptId: "attempt-architecture",
      sessionId: "session-architecture",
      nextAuthorityRevision: 9,
      expectedAuthorityStateHash: digest("authority-nine"),
      lineage: {
        branchEpoch: 1,
        reason: "rework",
        parentAttemptId: "attempt-plan",
        parentSessionId: "session-plan",
      },
    });
    expect(prepared.spec.lineage).toEqual({
      branchEpoch: 1,
      reason: "rework",
      parentAttemptId: "attempt-plan",
      parentSessionId: "session-plan",
    });
    expect(prepared.spec.persona.id).toBe("architecture-mapper");
    expect(prepared.spec.model).toMatchObject({ id: "gpt-5.6-luna", thinkingLevel: "medium" });
    expect(prepared.toolNames).toContain("koni_graph_context");
    expect(prepared.toolNames).toContain("koni_record_note");
    expect(prepared.toolNames).not.toContain("koni_write_file");
    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);
    const architectureAttempt = attemptRecord(prepared.spec, "ticket", "running");
    run.attempts[architectureAttempt.id] = architectureAttempt;
    const graphContext = await program.executeAgentTool({
      run,
      attempt: architectureAttempt,
      grant: prepared.authorityGrant!,
      call: {
        callId: "call-graph-context",
        name: "koni_graph_context",
        arguments: { anchors: [initialProjection.nodes[0]!.id], maxDepth: 1, direction: "both" },
      },
    });
    expect(graphContext.value).toMatchObject({
      protocol: "koni.graph-context.v1",
      graphSha256: run.graphHash,
      nodes: [expect.objectContaining({ id: initialProjection.nodes[0]!.id })],
    });
    const note = await program.executeAgentTool({
      run,
      attempt: architectureAttempt,
      grant: prepared.authorityGrant!,
      call: {
        callId: "call-record-note",
        name: "koni_record_note",
        arguments: {
          nodeId: initialProjection.nodes[0]!.id,
          kind: "rationale",
          body: "Keep the note boundary local to the application system.",
        },
      },
    });
    expect(note.value).toMatchObject({ nodeId: initialProjection.nodes[0]!.id, kind: "rationale", status: "working" });
    expect(note.activity).toEqual([
      expect.objectContaining({ kind: "agent", nodeId: initialProjection.nodes[0]!.id, ticketId: architectureTicket.id }),
    ]);
    expect(note.artifactWrites).toHaveLength(1);

    const root = initialProjection.nodes[0]!;
    const compiled = await program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: "attempt-architecture",
      output: {
        status: "completed",
        summary: "Mapped the notes application boundary",
        graphDelta: {
          protocol: "koni.graph-delta.v1",
          expectedGraphHash: run.graphHash,
          upsertNodes: [{
            expectedNodeHash: null,
            node: {
              schema_version: "1.0",
              id: "system-notes-app",
              type: "system",
              title: "Notes application",
              status: "active",
              spec: {
                kind: "app",
                responsibility: "Own note creation and pinning",
                contract_required: false,
                contract_reason: "Repository-local behavior is sufficient",
                owned_paths: ["src"],
              },
              edges: {},
              annotations: {},
            },
          }],
          deleteNodes: [],
          addEdges: [{ source: root.id, relation: "systems", target: "system-notes-app" }],
          removeEdges: [],
        },
      },
    });
    expect(compiled.outcome).toEqual({
      status: "completed",
      summary: "Mapped the notes application boundary",
    });
    expect(compiled.graphRevision).toBe(2);
    expect(compiled.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "graph_added", nodeId: "system-notes-app" }),
    ]));
    expect(Object.values(compiled.tickets ?? {}).some((ticket) => ticket.operationId === "design.objective.plan-change")).toBe(true);
    await persistWrites(project.projectRoot, compiled.artifactWrites ?? []);
    run.graphHash = compiled.graphHash;
    run.graphRevision = compiled.graphRevision!;
    run.tickets = compiled.tickets!;
    const projected = await program.projectGraph(run, architectureTicket.id);
    expect(projected.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([root.id, "system-notes-app"]));
    expect(projected.edges).toContainEqual({ source: root.id, relation: "systems", target: "system-notes-app" });
  });

  it("uses the same native compiler program for the research profile", async () => {
    const project = await installedProject("research-profile");
    const nodesPath = path.join(project.projectRoot, ".koni", "graph", "nodes.yaml");
    await writeFile(nodesPath, (await readFile(nodesPath, "utf8")).replace(
      [
        "    objective:",
        "      type: string",
        "      description: The bounded empirical research objective used to clarify and test the proposition.",
      ].join("\n"),
      [
        "    objective:",
        "      type: string",
        "      description: The bounded empirical research objective used to clarify and test the proposition.",
        "    fixture_command:",
        "      type: json",
        "      description: Exact provider-free verifier argv for this executable parity fixture.",
        "    scientific_inputs:",
        "      type: json",
        "      description: Exact project-file prerequisites bound into the verifier argv.",
      ].join("\n"),
    ));
    const rulesPath = path.join(project.projectRoot, ".koni", "rules", "research.yaml");
    await writeFile(rulesPath, (await readFile(rulesPath, "utf8")).replace(
      [
        "    target_nodes: $target",
        "    read_scope: $target",
        "    write_scope: $target",
        "- id: ticket.experiment-portfolio",
      ].join("\n"),
      [
        "    target_nodes: $target",
        "    read_scope: $target",
        "    write_scope: $target",
        "    read_paths: [fixtures]",
        "- id: ticket.experiment-portfolio",
      ].join("\n"),
    ));
    const workflowsPath = path.join(project.projectRoot, ".koni", "workflows", "research.yaml");
    const workflows = await readFile(workflowsPath, "utf8");
    const drillClaimStep = [
      "  - id: drill-claims",
      "    persona: hypothesis-planner",
      "    depends_on: []",
      "    expected_output: claim graph delta within formulation scope",
      "    validation_action: compile-ticket",
    ].join("\n");
    expect(workflows).toContain(drillClaimStep);
    await writeFile(workflowsPath, workflows.replace(
      drillClaimStep,
      `${drillClaimStep}\n    checks:\n    - scoped-probe-set\n    - exact-prerequisite-set`,
    ));
    const checksPath = path.join(project.projectRoot, ".koni", "checks", "research.yaml");
    await writeFile(checksPath, `${await readFile(checksPath, "utf8")}\n` + [
      "- id: scoped-probe-set",
      "  kind: composite",
      "  applies_to: [drill-hypothesis]",
      "  receipt_type: compiler.scoped-probe-set",
      "  graph_set:",
      "    members: $target",
      "    member_node_types: [hypothesis]",
      "    member_check: scoped-operational-probe",
      "    min_members: 1",
      "",
    ].join("\n"));
    await writeFile(checksPath, `${await readFile(checksPath, "utf8")}` + [
      "- id: exact-prerequisite-set",
      "  kind: command",
      "  applies_to: [drill-hypothesis]",
      "  command_source:",
      "    kind: ticket",
      "    role: ticket",
      "    field: fixture_command",
      "  cwd: .",
      "  timeout_seconds: 60",
      "  result_protocol: koni.fixture-result.v1",
      "  required_result_fields: [protocol, status]",
      "  result_schema:",
      "    type: object",
      "    required: [protocol, status]",
      "    properties:",
      "      protocol: {type: string, const: koni.fixture-result.v1}",
      "      status: {type: string, const: passed}",
      "  argv_input_bindings:",
      "    from: scientific_inputs",
      "    path_field: path",
      "    required_fields: [asset_id, role, path]",
      "    require_nonempty: true",
      "    require_project_file: true",
      "    require_exact_argument: true",
      "  receipt_type: runtime.fixture-receipt",
      "  effect: read_only",
      "  environment:",
      "    inherit: [PATH]",
      "    set: {}",
      "  retry_policy:",
      "    max_attempts: 1",
      "    transient_exit_codes: []",
      "    backoff_seconds: []",
      "",
    ].join("\n"));
    await mkdir(path.join(project.projectRoot, "fixtures"), { recursive: true });
    await writeFile(path.join(project.projectRoot, "fixtures", "research-input.json"), "{}\n");
    const program = await compilerProgram(project);
    const runId = "run-native-research";
    const resolved = await program.resolveRun({
      runId,
      objective: "Test whether retrieval improves bounded factual recall",
      runTypeId: "medium",
      targetRef: "refs/heads/main",
      intake: { goal: "Test whether retrieval improves bounded factual recall" },
    });
    expect(resolved.profile.lineage).toBe("koni.research");
    expect(resolved.executionConfig.maxParallel).toBe(3);
    expect(resolved.executionConfig.agents["run-planner"]).toMatchObject({
      model: "gpt-5.6-sol",
      thinkingLevel: "xhigh",
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, "Test whether retrieval improves bounded factual recall", resolved);
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-research-plan",
      output: planningOutput({
        objective: "Measure a bounded factual-recall delta",
        fixture_command: ["node", "scripts/verify-research.mjs", "fixtures/research-input.json"],
        scientific_inputs: [{ asset_id: "fixture-input", role: "dataset", path: "fixtures/research-input.json" }],
      }),
    });
    run.plan = { ...planning.plan, status: "approved" };
    run.graphHash = planning.graphHash;
    const approved = await program.initializeApprovedPlan(run);
    expect(Object.values(approved.tickets)).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: "formulation.hypothesis.drill-hypothesis" }),
    ]));
    await persistWrites(project.projectRoot, approved.artifactWrites ?? []);
    run.graphHash = approved.graphHash;
    run.graphRevision = approved.graphRevision;
    run.tickets = approved.tickets;
    const ticket = Object.values(run.tickets).find((candidate) =>
      candidate.operationId === "formulation.hypothesis.drill-hypothesis")!;
    const assignment = assignmentFor(run, ticket.id);
    const prepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment,
      attemptId: "attempt-scoped-check",
      sessionId: "session-scoped-check",
      nextAuthorityRevision: 13,
      expectedAuthorityStateHash: digest("authority-thirteen"),
      lineage: {
        branchEpoch: 1,
        reason: "rework",
        parentAttemptId: "attempt-research-plan",
        parentSessionId: "session-research-plan",
      },
    });
    expect(prepared.toolNames).toContain("koni_run_check");
    expect(prepared.authorityGrant?.configuredChecks).toEqual({
      ids: ["exact-prerequisite-set", "scoped-probe-set"],
      networkAccess: false,
      maxTimeoutMs: 900_000,
    });
    expect(prepared.spec.tools.find((tool) => tool.name === "koni_run_check")?.maxResultBytes)
      .toBeGreaterThanOrEqual(1024 * 1024);
    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);
    const attempt = attemptRecord(prepared.spec, "ticket", "running");
    run.attempts[attempt.id] = attempt;
    const prerequisitePath = path.join(project.projectRoot, "fixtures", "research-input.json");
    await unlink(prerequisitePath);
    await expect(program.resolveAgentCheck({
      run,
      attempt,
      checkId: "exact-prerequisite-set",
    })).rejects.toMatchObject({ code: "check_input_binding" });
    await writeFile(prerequisitePath, "{}\n");
    const exactCheck = await program.resolveAgentCheck({
      run,
      attempt,
      checkId: "exact-prerequisite-set",
    });
    expect(exactCheck).toMatchObject({
      kind: "command",
      commands: [expect.objectContaining({
        argv: ["node", "scripts/verify-research.mjs", "fixtures/research-input.json"],
        inputPaths: ["fixtures/research-input.json"],
        resultProtocol: "koni.fixture-result.v1",
      })],
    });
    const exactCommand = exactCheck.commands[0]!;
    const exactResult = { protocol: "koni.fixture-result.v1", status: "passed" };
    const exactStdout = `${JSON.stringify(exactResult)}\n`;
    const exactManifest = digest("exact-prerequisite-manifest");
    const exactExecution = {
      checkId: exactCommand.checkId,
      definitionHash: exactCommand.definitionHash,
      startedAt: "2026-07-16T18:59:56.000Z",
      completedAt: "2026-07-16T18:59:57.000Z",
      resolvedExecutable: "/usr/bin/node",
      argv: ["/usr/bin/node", ...exactCommand.argv.slice(1)],
      environmentSha256: digest("exact-check-environment"),
      exitCode: 0,
      signal: null,
      stdout: exactStdout,
      stderr: "",
      stdoutSha256: rawSha256(exactStdout),
      stdoutSizeBytes: Buffer.byteLength(exactStdout, "utf8"),
      stderrSha256: rawSha256(""),
      stderrSizeBytes: 0,
      preManifestSha256: exactManifest,
      postManifestSha256: exactManifest,
      sandboxKind: "macos-seatbelt.v1",
      sandboxProfileSha256: digest("exact-sandbox-profile"),
      resultSource: {
        kind: "stdout" as const,
        bytesSha256: rawSha256(exactStdout),
        sizeBytes: Buffer.byteLength(exactStdout, "utf8"),
        value: exactResult,
      },
      outputFiles: [],
    };
    const compiledExactCheck = await program.compileAgentCheckResult({
      run,
      attempt,
      check: exactCheck,
      executions: [exactExecution],
    });
    expect(compiledExactCheck).toMatchObject({
      accepted: true,
      passed: true,
      tickets: expect.any(Object),
      ruleAuthorityEvidence: { protocol: "koni.rule-authority-evidence.v1" },
    });
    const check = await program.resolveAgentCheck({
      run,
      attempt,
      checkId: "scoped-probe-set",
    });
    expect(check).toMatchObject({
      kind: "composite",
      commands: [expect.objectContaining({
        checkId: "scoped-operational-probe",
        effect: "read_only",
        expectedExitCodes: [0],
        resultProtocol: "process-exit.v1",
      })],
    });
    const command = check.commands[0]!;
    const stdout = `${JSON.stringify({ protocol: "process-exit.v1", status: "passed" })}\n`;
    const manifest = digest("unchanged-worktree");
    const execution = {
      checkId: command.checkId,
      definitionHash: command.definitionHash,
      startedAt: "2026-07-16T18:59:58.000Z",
      completedAt: "2026-07-16T18:59:59.000Z",
      resolvedExecutable: "/usr/bin/python3",
      argv: ["/usr/bin/python3", ...command.argv.slice(1)],
      environmentSha256: digest("check-environment"),
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      stdoutSha256: rawSha256(stdout),
      stdoutSizeBytes: Buffer.byteLength(stdout, "utf8"),
      stderrSha256: rawSha256(""),
      stderrSizeBytes: 0,
      preManifestSha256: manifest,
      postManifestSha256: manifest,
      sandboxKind: "macos-seatbelt.v1",
      sandboxProfileSha256: digest("sandbox-profile"),
      resultSource: {
        kind: "stdout" as const,
        bytesSha256: rawSha256(stdout),
        sizeBytes: Buffer.byteLength(stdout, "utf8"),
        value: { protocol: "process-exit.v1", status: "passed" },
      },
      outputFiles: [],
    };
    const compiledCheck = await program.compileAgentCheckResult({
      run,
      attempt,
      check,
      executions: [execution],
    });
    expect(compiledCheck).toMatchObject({
      accepted: true,
      passed: true,
      value: { accepted: true, passed: true },
      evidence: {
        protocol: "koni.agent-check-execution-evidence.v1",
        requestedCheckId: "scoped-probe-set",
      },
      ruleAuthorityEvidence: { protocol: "koni.rule-authority-evidence.v1" },
    });
    const completedOutput = {
      status: "completed",
      summary: "Compiled the hypothesis drill after its current scoped check",
    };
    await expect(program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: attempt.id,
      output: completedOutput,
    })).rejects.toMatchObject({ code: "assignment_checks_incomplete" });
    run.checks = [{
      id: "check-current-scoped-probe",
      attemptId: attempt.id,
      callId: "call-current-scoped-probe",
      requestedCheckId: check.requestedCheckId,
      definitionHash: check.definitionHash,
      kind: check.kind,
      accepted: compiledCheck.accepted,
      passed: compiledCheck.passed,
      summary: compiledCheck.summary,
      commands: [{
        checkId: execution.checkId,
        definitionHash: execution.definitionHash,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        resolvedExecutable: execution.resolvedExecutable,
        argv: execution.argv,
        environmentSha256: execution.environmentSha256,
        exitCode: execution.exitCode,
        signal: execution.signal,
        stdoutSha256: execution.stdoutSha256,
        stdoutSizeBytes: execution.stdoutSizeBytes,
        stdoutArtifactPath: "runs/run-native-research/checks/current/stdout.txt",
        stderrSha256: execution.stderrSha256,
        stderrSizeBytes: execution.stderrSizeBytes,
        stderrArtifactPath: "runs/run-native-research/checks/current/stderr.txt",
        preManifestSha256: execution.preManifestSha256,
        postManifestSha256: execution.postManifestSha256,
        sandboxKind: execution.sandboxKind,
        sandboxProfileSha256: execution.sandboxProfileSha256,
        resultSource: {
          kind: execution.resultSource.kind,
          bytesSha256: execution.resultSource.bytesSha256,
          sizeBytes: execution.resultSource.sizeBytes,
        },
        outputFiles: [],
      }],
      evidenceSha256: canonicalHash(compiledCheck.evidence),
      evidenceSizeBytes: Buffer.byteLength(JSON.stringify(compiledCheck.evidence), "utf8"),
      evidenceArtifactPath: "runs/run-native-research/checks/current/evidence.json",
      recordedAt: "2026-07-16T19:00:00.000Z",
    }];
    run.checks.push({
      id: "check-current-exact-prerequisite",
      attemptId: attempt.id,
      callId: "call-current-exact-prerequisite",
      requestedCheckId: exactCheck.requestedCheckId,
      definitionHash: exactCheck.definitionHash,
      kind: exactCheck.kind,
      accepted: compiledExactCheck.accepted,
      passed: compiledExactCheck.passed,
      summary: compiledExactCheck.summary,
      commands: [{
        checkId: exactExecution.checkId,
        definitionHash: exactExecution.definitionHash,
        startedAt: exactExecution.startedAt,
        completedAt: exactExecution.completedAt,
        resolvedExecutable: exactExecution.resolvedExecutable,
        argv: exactExecution.argv,
        environmentSha256: exactExecution.environmentSha256,
        exitCode: exactExecution.exitCode,
        signal: exactExecution.signal,
        stdoutSha256: exactExecution.stdoutSha256,
        stdoutSizeBytes: exactExecution.stdoutSizeBytes,
        stdoutArtifactPath: "runs/run-native-research/checks/exact/stdout.txt",
        stderrSha256: exactExecution.stderrSha256,
        stderrSizeBytes: exactExecution.stderrSizeBytes,
        stderrArtifactPath: "runs/run-native-research/checks/exact/stderr.txt",
        preManifestSha256: exactExecution.preManifestSha256,
        postManifestSha256: exactExecution.postManifestSha256,
        sandboxKind: exactExecution.sandboxKind,
        sandboxProfileSha256: exactExecution.sandboxProfileSha256,
        resultSource: {
          kind: exactExecution.resultSource.kind,
          bytesSha256: exactExecution.resultSource.bytesSha256,
          sizeBytes: exactExecution.resultSource.sizeBytes,
        },
        outputFiles: [],
      }],
      evidenceSha256: canonicalHash(compiledExactCheck.evidence),
      evidenceSizeBytes: Buffer.byteLength(JSON.stringify(compiledExactCheck.evidence), "utf8"),
      evidenceArtifactPath: "runs/run-native-research/checks/exact/evidence.json",
      recordedAt: "2026-07-16T19:00:00.000Z",
    });
    await expect(program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: attempt.id,
      output: completedOutput,
    })).resolves.toMatchObject({
      outcome: { status: "completed", summary: completedOutput.summary },
    });
  });

  it("prepares a research small run for direct approval without launching a planner", async () => {
    const project = await installedProject("research-profile");
    const program = await compilerProgram(project);
    const runId = "run-native-research-direct";
    const objective = "Measure whether retrieval improves bounded factual recall";
    const resolved = await program.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    expect(resolved.planningMode).toBe("direct");
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, objective, resolved);
    run.workingSpecOwnerId = resolved.workingSpecOwnerId!;
    const reviewable = await program.initializeDirectApproval(run);
    expect(reviewable.plan).toMatchObject({
      revision: 1,
      full: {},
      concise: {},
      graphSeed: undefined,
    });
    expect(reviewable.graphHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(reviewable.artifactWrites?.map((write) => write.path)).toEqual([
      `runs/${runId}/direct-approval.json`,
      `runs/${runId}/direct-approval-graph.json`,
    ]);
    await persistWrites(project.projectRoot, reviewable.artifactWrites ?? []);
    run.plan = { ...reviewable.plan, status: "approved" };
    run.graphHash = reviewable.graphHash;
    const approved = await program.initializeApprovedPlan(run);
    expect(Object.values(approved.tickets)).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: "formulation.hypothesis.drill-hypothesis" }),
    ]));
    const graphWrite = approved.artifactWrites?.find((write) => write.path.endsWith("/program/graph.json"));
    const directGraph = JSON.parse(Buffer.from(graphWrite!.bytes).toString("utf8")) as {
      contextual: {
        ownerPersonaId: string;
        revision: number;
        canonicalWorkingSpecId: string;
        records: Record<string, { baseline: { acceptedPlan: unknown; source: { kind: string } } }>;
      };
    };
    expect(directGraph.contextual).toMatchObject({ ownerPersonaId: resolved.workingSpecOwnerId, revision: 1 });
    expect(directGraph.contextual.records[directGraph.contextual.canonicalWorkingSpecId]).toMatchObject({
      baseline: { acceptedPlan: null, source: { kind: "direct_approval" } },
    });
  });

  it("resolves exactly one working-spec owner before producing any run artifacts", async () => {
    const unique = await installedProject("coding-profile");
    const uniqueProgram = await compilerProgram(unique);
    const fallback = await uniqueProgram.resolveRun({
      runId: "run-owner-fallback",
      objective: "Resolve the unique lead",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Resolve the unique lead" },
    });
    expect(fallback.workingSpecOwnerId).toBe("lead");

    await expect(uniqueProgram.resolveRun({
      runId: "run-owner-invalid",
      objective: "Reject an unknown explicit owner",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Reject an unknown explicit owner" },
      overrides: { workingSpecOwner: "missing-persona" },
    })).rejects.toMatchObject({ code: "working_spec_owner_invalid" });
    const uniqueEndpoint = await discoverAuthorityEndpoint(unique.projectRoot);
    await expect(readFile(path.join(uniqueEndpoint.stateRoot, "runs/run-owner-invalid/program/graph.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const zero = await installedProject("coding-profile");
    const zeroPersonas = path.join(zero.projectRoot, ".koni", "personas.yaml");
    await writeFile(zeroPersonas, (await readFile(zeroPersonas, "utf8")).replace(
      "  model_role: lead\n",
      "  model_role: ticket_worker\n",
    ));
    await expect((await compilerProgram(zero)).resolveRun({
      runId: "run-owner-zero",
      objective: "Reject zero leads",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Reject zero leads" },
    })).rejects.toMatchObject({ code: "working_spec_owner_resolution" });

    const multiple = await installedProject("coding-profile");
    const multiplePersonas = path.join(multiple.projectRoot, ".koni", "personas.yaml");
    await writeFile(multiplePersonas, (await readFile(multiplePersonas, "utf8")).replace(
      "  model_role: ticket_worker\n",
      "  model_role: lead\n",
    ));
    await expect((await compilerProgram(multiple)).resolveRun({
      runId: "run-owner-multiple",
      objective: "Reject multiple leads",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Reject multiple leads" },
    })).rejects.toMatchObject({ code: "working_spec_owner_resolution" });
  }, 20_000);

  it("pins an explicit owner, persists the approved baseline, and isolates note/spec CAS from semantic state", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const runId = "run-contextual-graph";
    const objective = "Persist bounded graph-native working context";
    const resolved = await program.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
      overrides: { workingSpecOwner: "architecture-mapper" },
    });
    expect(resolved.workingSpecOwnerId).toBe("architecture-mapper");
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, objective, resolved);
    run.workingSpecOwnerId = resolved.workingSpecOwnerId!;

    const planning = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-context-plan",
      sessionId: "session-context-plan",
      nextAuthorityRevision: 2,
      expectedAuthorityStateHash: digest("context-plan-state"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    await persistWrites(project.projectRoot, planning.artifactWrites ?? []);
    const planningAttempt = attemptRecord(planning.spec, "planning", "running");
    run.attempts[planningAttempt.id] = planningAttempt;
    const endpoint = await discoverAuthorityEndpoint(project.projectRoot);
    const graphPath = path.join(endpoint.stateRoot, `runs/${runId}/program/graph.json`);
    const shell = JSON.parse(await readFile(graphPath, "utf8")) as {
      graphSha256: Sha256Digest;
      revision: number;
      contextual: { runRootId: string; revision: number; hash: Sha256Digest; records: Record<string, unknown> };
    };
    const semanticBefore = { hash: shell.graphSha256, revision: shell.revision };
    const planningNote = await program.executeAgentTool({
      run,
      attempt: planningAttempt,
      grant: planning.authorityGrant!,
      spec: planning.spec,
      call: {
        callId: "call-planning-root-note",
        name: "koni_record_note",
        arguments: {
          nodeId: shell.contextual.runRootId,
          kind: "observation",
          body: "Planning evidence belongs to the stable run root.",
          paths: ["README.md"],
        },
      },
    });
    await persistWrites(project.projectRoot, planningNote.artifactWrites ?? []);
    const noted = JSON.parse(await readFile(graphPath, "utf8")) as typeof shell;
    expect({ hash: noted.graphSha256, revision: noted.revision }).toEqual(semanticBefore);
    expect(noted.contextual.revision).toBe(1);

    const compiledPlan = await program.compilePlanningOutput({
      run,
      attemptId: planningAttempt.id,
      output: planningOutput({ work_kind: "general" }),
    });
    await persistWrites(project.projectRoot, compiledPlan.artifactWrites ?? []);
    run.plan = { ...compiledPlan.plan, status: "awaiting_approval" };
    run.graphHash = compiledPlan.graphHash;
    run.graphRevision = compiledPlan.graphRevision ?? 0;
    planningAttempt.terminalAcceptedAt = FIXED_NOW.toISOString();
    const approved = await program.initializeApprovedPlan(run);
    await persistWrites(project.projectRoot, approved.artifactWrites ?? []);
    run.plan = { ...run.plan, status: "approved" };
    run.graphHash = approved.graphHash;
    run.graphRevision = approved.graphRevision;
    run.tickets = approved.tickets;

    const approvedArtifact = JSON.parse(await readFile(graphPath, "utf8")) as {
      graphSha256: Sha256Digest;
      semanticSha256: Sha256Digest;
      revision: number;
      nodes: Record<string, GraphNode>;
      contextual: {
        revision: number;
        hash: Sha256Digest;
        canonicalWorkingSpecId: string;
        ownerPersonaId: string;
        records: Record<string, {
          protocol: string;
          version?: number;
          digest?: Sha256Digest;
          supersedes?: string;
          baseline?: { source: { artifactPath: string; artifactSha256: Sha256Digest } };
          provenance: Record<string, unknown>;
        }>;
      };
    };
    expect(approvedArtifact.contextual.ownerPersonaId).toBe("architecture-mapper");
    expect(approvedArtifact.contextual.revision).toBe(2);
    const baselineId = approvedArtifact.contextual.canonicalWorkingSpecId;
    const baseline = approvedArtifact.contextual.records[baselineId]!;
    expect(baseline).toMatchObject({ protocol: "koni.working-spec.v1", version: 1 });
    expect(baseline.baseline?.source.artifactPath).toContain("planning-output.json");
    const nativeNote = Object.values(approvedArtifact.contextual.records)
      .find((record) => record.protocol === "koni.graph-note.v2")!;
    expect(nativeNote.provenance).toMatchObject({
      runId,
      generation: run.generation,
      ticketId: "run-planning",
      attemptId: planningAttempt.id,
      sessionId: planningAttempt.sessionId,
      personaId: planningAttempt.personaId,
      semanticRevision: 0,
      contextualRevision: 0,
      authorityGrantHash: planning.spec.authority.grantHash,
      launchSpecHash: planning.spec.specHash,
      lineage: planning.spec.lineage,
    });

    await expect(program.executeAgentTool({
      run,
      attempt: planningAttempt,
      grant: planning.authorityGrant!,
      spec: planning.spec,
      call: {
        callId: "call-non-owner-update",
        name: "koni_update_working_spec",
        arguments: {
          expectedContextualRevision: approvedArtifact.contextual.revision,
          expectedCanonicalDigest: baseline.digest,
          guidance: "A non-owner must never advance canonical guidance.",
        },
      },
    })).rejects.toMatchObject({ code: "working_spec_owner" });

    const ownerTicket = Object.values(run.tickets).find((ticket) =>
      ticket.steps.some((step) => step.personaId === "architecture-mapper"));
    expect(ownerTicket).toBeDefined();
    const assignment = assignmentFor(run, ownerTicket!.id);
    const ownerPrepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment,
      attemptId: "attempt-context-owner",
      sessionId: "session-context-owner",
      nextAuthorityRevision: 3,
      expectedAuthorityStateHash: digest("context-owner-state"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(ownerPrepared.toolNames).toContain("koni_update_working_spec");
    await persistWrites(project.projectRoot, ownerPrepared.artifactWrites ?? []);
    const ownerAttempt = attemptRecord(ownerPrepared.spec, "ticket", "running");
    run.attempts[ownerAttempt.id] = ownerAttempt;
    const firstDynamic = await program.selectDynamicGraphContext({ run, attempt: ownerAttempt, spec: ownerPrepared.spec });
    const secondDynamic = await program.selectDynamicGraphContext({ run, attempt: ownerAttempt, spec: ownerPrepared.spec });
    expect(firstDynamic.envelopeHash).toBe(secondDynamic.envelopeHash);
    expect(program.dynamicContextCacheStats()).toMatchObject({ selections: 2, indexBuilds: 1 });

    const systemNode = (id: string, repositoryPath: string): GraphNode => ({
      schema_version: "1.0",
      id,
      type: "system",
      title: id,
      status: "active",
      spec: {
        kind: "app",
        responsibility: `Own ${id}`,
        contract_required: false,
        contract_reason: "Repository-local behavior is sufficient",
        owned_paths: [repositoryPath],
      },
      edges: {},
      annotations: {},
    });
    approvedArtifact.nodes["system-a-other"] = systemNode("system-a-other", "src/other.ts");
    approvedArtifact.nodes["system-z-touched"] = systemNode("system-z-touched", "src/touched.ts");
    approvedArtifact.graphSha256 = canonicalHash(approvedArtifact.nodes);
    approvedArtifact.semanticSha256 = approvedArtifact.graphSha256;
    run.graphHash = approvedArtifact.graphSha256;
    await writeFile(graphPath, `${JSON.stringify(approvedArtifact, null, 2)}\n`);

    const beforeTouch = await program.selectDynamicGraphContext({ run, attempt: ownerAttempt, spec: ownerPrepared.spec });
    const beforeTouchIds = beforeTouch.envelope.selection.selected.map((entry) => entry.id);
    expect(beforeTouchIds.indexOf("semantic_node:system-a-other"))
      .toBeLessThan(beforeTouchIds.indexOf("semantic_node:system-z-touched"));

    const receiptPath = `runs/${run.id}/attempts/${ownerAttempt.id}/tool-receipts/write-touched.json`;
    const receiptBytes = Buffer.from(`${JSON.stringify({
      receiptId: "receipt-write-touched",
      summary: "Wrote src/touched.ts",
      value: { path: "src/touched.ts", sha256: digest("touched-bytes") },
    })}\n`, "utf8");
    await persistWrites(project.projectRoot, [{ path: receiptPath, bytes: receiptBytes, expectedSha256: null }]);
    ownerAttempt.authorityToolResults = [{
      sequence: 1,
      callId: "call-write-touched",
      toolName: "koni_write_file",
      outcome: "accepted",
      argumentsSha256: rawSha256("{}"),
      argumentsSizeBytes: 2,
      receiptSha256: rawSha256(receiptBytes),
      receiptSizeBytes: receiptBytes.byteLength,
      artifactPath: receiptPath,
      recordedAt: FIXED_NOW.toISOString(),
    }];
    const afterTouch = await program.selectDynamicGraphContext({ run, attempt: ownerAttempt, spec: ownerPrepared.spec });
    const afterTouchIds = afterTouch.envelope.selection.selected.map((entry) => entry.id);
    expect(afterTouchIds.indexOf("semantic_node:system-z-touched"))
      .toBeLessThan(afterTouchIds.indexOf("semantic_node:system-a-other"));
    expect(afterTouch.envelopeHash).not.toBe(beforeTouch.envelopeHash);
    expect(program.dynamicContextCacheStats()).toMatchObject({ selections: 4, indexBuilds: 2 });

    await expect(program.executeAgentTool({
      run,
      attempt: ownerAttempt,
      grant: ownerPrepared.authorityGrant!,
      spec: ownerPrepared.spec,
      call: {
        callId: "call-working-spec-scope-expansion",
        name: "koni_update_working_spec",
        arguments: {
          expectedContextualRevision: approvedArtifact.contextual.revision,
          expectedCanonicalDigest: baseline.digest,
          guidance: "Attempt an unauthorized semantic expansion.",
          affectedNodeIds: ["missing-node"],
        },
      },
    })).rejects.toMatchObject({ code: "working_spec_scope" });

    const update = await program.executeAgentTool({
      run,
      attempt: ownerAttempt,
      grant: ownerPrepared.authorityGrant!,
      spec: ownerPrepared.spec,
      call: {
        callId: "call-working-spec-update",
        name: "koni_update_working_spec",
        arguments: {
          expectedContextualRevision: approvedArtifact.contextual.revision,
          expectedCanonicalDigest: baseline.digest,
          guidance: "Implement only the compiler-selected architecture boundary and verify its existing contract.",
        },
      },
    });
    await persistWrites(project.projectRoot, update.artifactWrites ?? []);
    const updated = JSON.parse(await readFile(graphPath, "utf8")) as typeof approvedArtifact;
    expect({ hash: updated.graphSha256, revision: updated.revision }).toEqual({
      hash: approvedArtifact.graphSha256,
      revision: approvedArtifact.revision,
    });
    expect(updated.contextual.revision).toBe(approvedArtifact.contextual.revision + 1);
    const current = updated.contextual.records[updated.contextual.canonicalWorkingSpecId]!;
    expect(current).toMatchObject({ version: 2, supersedes: baselineId });
    expect(current.baseline?.source).toEqual(baseline.baseline?.source);
    expect(updated.contextual.records[baselineId]).toBeDefined();
    const postUpdateDynamic = await program.selectDynamicGraphContext({ run, attempt: ownerAttempt, spec: ownerPrepared.spec });
    expect(postUpdateDynamic.envelope.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "working_spec",
        value: expect.objectContaining({ version: 2, guidance: expect.stringContaining("compiler-selected") }),
      }),
    ]));
    expect(program.dynamicContextCacheStats()).toMatchObject({ selections: 5, indexBuilds: 3 });

    await expect(program.executeAgentTool({
      run,
      attempt: ownerAttempt,
      grant: ownerPrepared.authorityGrant!,
      spec: ownerPrepared.spec,
      call: {
        callId: "call-working-spec-stale",
        name: "koni_update_working_spec",
        arguments: {
          expectedContextualRevision: approvedArtifact.contextual.revision,
          expectedCanonicalDigest: baseline.digest,
          guidance: "This stale request must not commit.",
        },
      },
    })).rejects.toMatchObject({ code: "working_spec_cas" });
    expect(JSON.parse(await readFile(graphPath, "utf8"))).toEqual(updated);
  });
});

async function installedProject(packageDirectory: "coding-profile" | "research-profile"): Promise<{
  root: string;
  projectRoot: string;
  baseline: VerifiedProfileBaseline;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-native-program-"));
  temporaryRoots.push(root);
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  git(projectRoot, ["init", "--initial-branch=main"]);
  git(projectRoot, ["config", "user.name", "Koni Test"]);
  git(projectRoot, ["config", "user.email", "koni@example.invalid"]);
  await writeFile(path.join(projectRoot, "README.md"), "# Fixture\n");
  git(projectRoot, ["add", "README.md"]);
  git(projectRoot, ["commit", "-m", "fixture"]);
  const packageRoot = path.resolve(repositoryRoot, "packages", packageDirectory);
  const baseline = await loadProfilePackage(packageRoot);
  await installProfile(projectRoot, packageRoot);
  return { root, projectRoot, baseline };
}

async function compilerProgram(project: {
  projectRoot: string;
  baseline: VerifiedProfileBaseline;
}): Promise<NativeRunCompilerProgram> {
  return NativeRunCompilerProgram.create({
    projectRoot: project.projectRoot,
    packageBaseline: project.baseline,
    now: () => new Date(FIXED_NOW),
  });
}

function runRecord(
  projectRoot: string,
  id: string,
  objective: string,
  resolved: Awaited<ReturnType<NativeRunCompilerProgram["resolveRun"]>>,
): RunRecord {
  const lifecycle = reduceRunLifecycle(newRunLifecycle(id), {
    type: "planning_started",
    atMs: FIXED_NOW.getTime(),
  }).state;
  return {
    protocol: "koni.run-record.v1",
    id,
    revision: 1,
    generation: lifecycle.generation,
    projectRoot,
    profile: resolved.profile,
    compiledConfigHash: resolved.compiledConfigHash,
    runTypeId: resolved.runTypeId,
    planningMode: resolved.planningMode,
    objective,
    intake: { goal: objective },
    executionConfig: resolved.executionConfig,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    lifecycle,
    pipelineStageIds: resolved.pipelineStageIds,
    currentPipelineStageId: resolved.pipelineStageIds.find((id) => id.includes("plan")),
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(projectRoot, id),
  };
}

function answeredQuestion(): RunQuestionRecord {
  return {
    id: "question-product",
    attemptId: "attempt-before-disconnect",
    prompt: "Which storage boundary should the notes workflow use?",
    options: [{
      id: "local",
      label: "Use local-first storage",
      description: "Keep the first slice within the repository and browser.",
    }],
    allowsNotes: true,
    askedAt: "2026-07-16T18:58:00.000Z",
    answeredAt: "2026-07-16T18:59:00.000Z",
    selectedOptionId: "local",
    notes: "Keep export reversible",
  };
}

function attemptRecord(
  spec: AgentLaunchSpec,
  kind: NonNullable<AgentAttemptRecord["kind"]>,
  status: AgentAttemptRecord["status"],
): AgentAttemptRecord {
  return {
    id: spec.identity.attemptId,
    sessionId: spec.identity.sessionId,
    ticketId: spec.identity.ticketId,
    stepId: spec.identity.stepId,
    personaId: spec.persona.id,
    modelProvider: spec.model.provider,
    modelId: spec.model.id,
    thinkingLevel: spec.model.thinkingLevel,
    status,
    launchSpecHash: spec.specHash,
    sessionFile: undefined,
    startedAt: FIXED_NOW.toISOString(),
    endedAt: undefined,
    terminalSummary: undefined,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lineage: structuredClone(spec.lineage),
    authorityMessages: [],
    authorityToolResults: [],
    authorityCompactions: [],
    kind,
  };
}

function assignmentFor(run: RunRecord, ticketId: string): ReadyAssignment {
  const ticket = run.tickets[ticketId]!;
  attachFixtureTicketCycle(run, ticket);
  const step = ticket.steps[0]!;
  return {
    runId: run.id,
    ticketId,
    stepId: step.id,
    personaId: step.personaId,
    priority: ticket.priority,
  };
}

function planningOutput(rootSpec: Record<string, unknown>): unknown {
  return {
    full: fullPlans(),
    concise: {
      architecture: [{
        title: "Notes ownership seam",
        description: "Ground the work in the smallest repository-native boundary.",
      }],
      decisions: [{
        title: "Preserve compatibility",
        description: "Reuse the established contracts unless evidence requires a change.",
      }],
      risk: [{
        title: "Bound the blast radius",
        description: "Keep mutation and recovery within the selected run scope.",
      }],
      verification: [{
        title: "Prove the observable outcome",
        description: "Use the cheapest trustworthy repository-native verification seam.",
      }],
    },
    graphSeed: { rootSpec, nodes: [], edges: [] },
  };
}

function fullPlans(): Record<string, string> {
  return {
    architecture: "## Architecture\nGround the smallest repository-native boundary.",
    decisions: "## Decisions\nPreserve compatibility and reversible choices.",
    risk: "## Risk\nBound the blast radius and keep recovery explicit.",
    verification: "## Verification\nProve the observable outcome at its production seam.",
  };
}

async function persistWrites(projectRoot: string, writes: readonly TransactionWrite[]): Promise<void> {
  const endpoint = await discoverAuthorityEndpoint(projectRoot);
  for (const write of writes) {
    const destination = path.join(endpoint.stateRoot, write.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, write.bytes);
  }
}

function digest(value: string): Sha256Digest {
  return canonicalHash(value);
}

function git(cwd: string, argv: string[]): string {
  const result = spawnSync("git", argv, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${argv.join(" ")} failed`);
  return result.stdout.trim();
}
