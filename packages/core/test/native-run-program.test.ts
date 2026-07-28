import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { discoverAuthorityEndpoint } from "../src/authority/endpoint.js";
import { snapshotContainedPaths } from "../src/authority/process-runner.js";
import type { TransactionWrite } from "../src/authority/file-journal.js";
import { decideBoundCheckRetry } from "../src/authority/execution-policy.js";
import {
  commandInfrastructureFailure,
  NativeRunCompilerProgram,
  NativeRunProgramError,
  orderedReviewPredecessorStepIds,
  rebindRuleEvidenceAcrossNonInterferingGraphChange,
  resolvePinnedGateAutoEvaluationContexts,
} from "../src/compiler/run-program.js";
import {
  type HistoricalBehaviorCompatibilityError,
  assertHistoricalBehaviorMatchesRun,
  projectHistoricalCompiledBehavior,
} from "../src/compiler/historical-behavior.js";
import { compileProjectDirectory } from "../src/compiler/project-directory.js";
import {
  projectGatePolicyDefinitions,
  projectGraphSchemaDefinition,
} from "../src/compiler/graph-schema.js";
import {
  RULE_AUTHORITY_EVIDENCE_PROTOCOL,
  createRuleAuthorityEvidence,
  ruleInputGraphSha256,
  rulePredicateEvidenceKey,
} from "../src/compiler/domain-adapter.js";
import {
  computeProfileBundleSha256,
  type VerifiedProfileBaseline,
} from "../src/compiler/profile-package.js";
import type {
  ProfileBaselineFile,
  ProfilePackageManifest,
} from "../src/contracts/profile-package.js";
import type { CompiledConfiguration } from "../src/contracts/configuration.js";
import { GraphSchema, TypedGraph, type GraphNode } from "../src/graph/model.js";
import type { AgentLaunchSpec } from "../src/pi/launch-spec.js";
import {
  canonicalEncode,
  canonicalHash,
  rawSha256,
  type Sha256Digest,
} from "../src/shared/canonical.js";
import { installProfile, loadProfilePackage } from "../src/profile/install.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import {
  deriveApprovedChangeMaterialization,
  deriveTerminalResolverReconciliation,
} from "../src/state/change-control.js";
import {
  assertRunRecord,
  terminalFailureBindingFromProof,
  type AgentAttemptRecord,
  type RunQuestionRecord,
  type RunRecord,
  type TerminalFailureSettlementProof,
  type TerminalSuccessSettlementProof,
} from "../src/state/run-record.js";
import type { ReadyAssignment } from "../src/state/scheduler.js";
import { attachFixtureTicketCycle, fixtureRunGit } from "./run-record-fixtures.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];
const FIXED_NOW = new Date("2026-07-16T19:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("native compiler-authoritative run program", () => {
  it("gives review the ordered transitive execution evidence, not only its immediate parent", () => {
    const workflow = [
      { id: "establish-baseline", depends_on: [] },
      { id: "implement", depends_on: ["establish-baseline"] },
      { id: "review", depends_on: ["implement"] },
    ];

    expect(orderedReviewPredecessorStepIds(workflow, workflow[2]!)).toEqual([
      "establish-baseline",
      "implement",
    ]);
  });

  it("rejects obvious setup failures without rejecting an ordinary expected-red assertion", () => {
    expect(
      commandInfrastructureFailure(
        "FAIL feature.test.ts > renders General\nAssertionError: expected 'Sales Notes' to be 'General'",
        "",
      ),
    ).toBeUndefined();
    expect(commandInfrastructureFailure("", "Error: Cannot find module 'framer-motion'")).toContain(
      "could not load one of its modules",
    );
    expect(commandInfrastructureFailure("", "ReferenceError: React is not defined")).toContain(
      "test harness failed before its focused assertions ran",
    );
    expect(
      commandInfrastructureFailure("", "Error: Objects are not valid as a React child"),
    ).toContain("test harness failed before its focused assertions ran");
    expect(commandInfrastructureFailure("No test files found, exiting with code 1", "")).toContain(
      "did not execute a test",
    );
  });

  it("admits an expected-red missing local module only when it is an exact declared input", () => {
    const localFailure = [
      "Error: Cannot find module './SalesNotesFields' imported from",
      "'/tmp/worktree/apps/books/src/components/SalesNotesFields.test.tsx'",
    ].join(" ");
    const declaredInputs = [
      "apps/books/src/components/SalesNotesFields.test.tsx",
      "apps/books/src/components/SalesNotesFields.tsx",
    ];

    expect(commandInfrastructureFailure("", localFailure, declaredInputs)).toBeUndefined();
    expect(
      commandInfrastructureFailure(
        "",
        [
          localFailure,
          "Serialized Error: { code: 'ERR_MODULE_NOT_FOUND' }",
          "Caused by: Error: Failed to load url ./SalesNotesFields (resolved id: ./SalesNotesFields). Does the file exist?",
        ].join("\n"),
        declaredInputs,
      ),
    ).toBeUndefined();
    expect(commandInfrastructureFailure("", localFailure, declaredInputs.slice(0, 1))).toContain(
      "could not load one of its modules",
    );
    expect(
      commandInfrastructureFailure(
        "",
        `${localFailure}\nError: Cannot find module 'framer-motion'`,
        declaredInputs,
      ),
    ).toContain("could not load one of its modules");
    expect(
      commandInfrastructureFailure(
        "",
        `${localFailure}\nReferenceError: React is not defined`,
        declaredInputs,
      ),
    ).toContain("test harness failed before its focused assertions ran");
  });

  it("rebinds current check evidence across only non-interfering graph changes", async () => {
    const project = await installedProject("coding-profile");
    await mkdir(path.join(project.projectRoot, "src"), { recursive: true });
    await mkdir(path.join(project.projectRoot, "tests"), { recursive: true });
    await mkdir(path.join(project.projectRoot, "test-support"), { recursive: true });
    await writeFile(
      path.join(project.projectRoot, "src/feature.ts"),
      "export const label = 'legacy';\n",
    );
    await writeFile(
      path.join(project.projectRoot, "tests/feature.test.mjs"),
      "process.exitCode = 1;\n",
    );
    await writeFile(
      path.join(project.projectRoot, "test-support/vitest.config.ts"),
      "export default {};\n",
    );
    const compiled = await compileProjectDirectory(project.projectRoot, project.baseline);
    if (!compiled.ok) throw new Error("coding fixture configuration did not compile");
    const projected = projectGraphSchemaDefinition(compiled.value);
    if (!projected.ok) throw new Error("coding fixture graph schema did not compile");
    const schema = new GraphSchema(projected.value);
    const program = await compilerProgram(project);
    const runId = "run-review-evidence-successor";
    const resolved = await program.resolveRun({
      runId,
      objective: "Preserve current promotion evidence across review status effects",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Preserve current promotion evidence across review status effects" },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(
      project.projectRoot,
      runId,
      "Preserve current promotion evidence",
      resolved,
    );
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-review-evidence-plan",
      output: proofPreparationPlanningOutput(),
    });
    run.plan = { ...planning.plan, status: "approved" };
    run.graphHash = planning.graphHash;
    run.graphRevision = planning.graphRevision ?? 0;
    materializeApprovedFixtureRun(run);
    const initialized = await program.initializeApprovedPlan(run);
    const graphWrite = initialized.artifactWrites?.find((write) =>
      write.path.endsWith("/program/graph.json"),
    );
    const graphArtifact = JSON.parse(Buffer.from(graphWrite!.bytes).toString("utf8")) as {
      nodes: Record<string, GraphNode>;
    };
    const nodes = Object.values(graphArtifact.nodes);
    const proof = nodes.find((node) => node.type === "proof")!;
    const prepared = { ...structuredClone(proof), status: "prepared" };
    const passing = { ...structuredClone(proof), status: "passing" };
    const beforeNodes = nodes.map((node) => (node.id === proof.id ? prepared : node));
    const afterNodes = nodes.map((node) => (node.id === proof.id ? passing : node));
    const before = new TypedGraph(schema, beforeNodes, { projectRoot: project.projectRoot });
    const after = new TypedGraph(schema, afterNodes, { projectRoot: project.projectRoot });
    const leaf = { op: "check_passed", subject: "$target", check: "promotion-proof-set" };
    const beforeSha256 = ruleInputGraphSha256(compiled.value, before);
    const key = rulePredicateEvidenceKey({
      configurationSha256: compiled.value.configuration_sha256,
      inputGraphSha256: beforeSha256,
      leaf,
      subjectNodeId: proof.id,
      bindings: { target: [proof.id] },
    });
    const evidence = createRuleAuthorityEvidence({
      protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
      configurationSha256: compiled.value.configuration_sha256,
      inputGraphSha256: beforeSha256,
      predicates: {
        [key]: {
          key,
          result: true,
          recordedAt: FIXED_NOW.toISOString(),
          sourceReceiptIds: ["check-evidence-current-promotion"],
          leaf,
          subjectNodeId: proof.id,
          bindings: { target: [proof.id] },
        },
      },
    });
    const rebound = rebindRuleEvidenceAcrossNonInterferingGraphChange({
      configuration: compiled.value,
      before,
      after,
      evidence,
    });
    expect(rebound).toMatchObject({
      inputGraphSha256: ruleInputGraphSha256(compiled.value, after),
      predicates: expect.objectContaining({
        [rulePredicateEvidenceKey({
          configurationSha256: compiled.value.configuration_sha256,
          inputGraphSha256: ruleInputGraphSha256(compiled.value, after),
          leaf,
          subjectNodeId: proof.id,
          bindings: { target: [proof.id] },
        })]: expect.objectContaining({ result: true }),
      }),
    });
    const objective = nodes.find((node) => node.type === "objective")!;
    const unrelatedAfter = new TypedGraph(
      schema,
      afterNodes.map((node) =>
        node.id === objective.id
          ? { ...structuredClone(node), title: "Unrelated delivery metadata changed" }
          : node,
      ),
      { projectRoot: project.projectRoot },
    );
    const unrelatedRebound = rebindRuleEvidenceAcrossNonInterferingGraphChange({
      configuration: compiled.value,
      before,
      after: unrelatedAfter,
      evidence,
    });
    expect(unrelatedRebound?.inputGraphSha256).toBe(
      ruleInputGraphSha256(compiled.value, unrelatedAfter),
    );
    expect(Object.values(unrelatedRebound?.predicates ?? {})).toEqual([
      expect.objectContaining({ result: true, subjectNodeId: proof.id }),
    ]);
    expect(
      rebindRuleEvidenceAcrossNonInterferingGraphChange({
        configuration: compiled.value,
        before,
        after: new TypedGraph(
          schema,
          afterNodes.map((node) =>
            node.id === proof.id
              ? { ...structuredClone(passing), title: "Changed semantic title" }
              : node,
          ),
          { projectRoot: project.projectRoot },
        ),
        evidence,
      }),
    ).toBeUndefined();
    expect(
      rebindRuleEvidenceAcrossNonInterferingGraphChange({
        configuration: compiled.value,
        before,
        after: new TypedGraph(
          schema,
          beforeNodes.map((node) =>
            node.id === proof.id ? { ...structuredClone(prepared), status: "superseded" } : node,
          ),
          { projectRoot: project.projectRoot },
        ),
        evidence,
      }),
    ).toBeUndefined();
  }, 30_000);

  it("projects the compiler-validated project default into the operator catalog", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);

    expect(await program.controlCatalog()).toMatchObject({
      protocol: "koni.control-catalog.v1",
      defaultRunTypeId: "continuous-improvement",
      runTypes: expect.arrayContaining([expect.objectContaining({ id: "medium" })]),
    });
  }, 30_000);

  it("reconstructs only the durable active behavior for authenticated software 0.7 runs", async () => {
    const project = await installedProject("coding-profile");
    const compiled = await compileProjectDirectory(project.projectRoot, project.baseline);
    if (!compiled.ok) throw new Error("coding fixture configuration did not compile");
    const legacy = legacySoftwareConfigurationFixture(compiled.value, "medium");
    const before = canonicalHash(legacy);
    const behavior = projectHistoricalCompiledBehavior(legacy, "medium");
    if (behavior === undefined) throw new Error("historical behavior was not projected");

    const program = await compilerProgram(project);
    const objective = "Resume one immutable pre-behavior run";
    const resolved = await program.resolveRun({
      runId: "run-historical-behavior",
      objective,
      runTypeId: "medium",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    const run = runRecord(project.projectRoot, "run-historical-behavior", objective, resolved);
    delete run.behavior;
    assertHistoricalBehaviorMatchesRun(run, behavior, legacy);

    expect(canonicalHash(legacy)).toBe(before);
    expect(Object.keys(behavior.runTypes)).toEqual(["medium"]);
    expect(behavior.runTypes.medium?.pipeline.map((stage) => stage.id)).toEqual(
      run.pipelineStageIds,
    );

    const customizedGit = structuredClone(legacy) as unknown as MutableConfigurationFixture;
    const medium = requiredMutableFixtureRecord(
      requiredMutableFixtureRecord(customizedGit.run_types, "run types").medium,
      "medium run type",
    );
    const document = requiredMutableFixtureRecord(medium.document, "medium run type document");
    requiredMutableFixtureRecord(document.git, "medium Git policy").branch_template =
      "custom/runs/{{ run.id }}";
    expect(() =>
      projectHistoricalCompiledBehavior(
        customizedGit as unknown as CompiledConfiguration,
        "medium",
      ),
    ).toThrow(
      expect.objectContaining<Partial<HistoricalBehaviorCompatibilityError>>({
        code: "historical_behavior_git",
      }),
    );

    const driftedRun = structuredClone(run);
    if (driftedRun.executionConfig === undefined)
      throw new Error("fixture run has no execution config");
    driftedRun.executionConfig.agents.lead!.model = "gpt-drift";
    expect(() => assertHistoricalBehaviorMatchesRun(driftedRun, behavior, legacy)).toThrow(
      expect.objectContaining<Partial<HistoricalBehaviorCompatibilityError>>({
        code: "historical_behavior_drift",
      }),
    );
  }, 30_000);

  it("prepares and strictly compiles one read-only run-level Lead judgment", async () => {
    // The bundled Coding presets intentionally skip automatic Lead gates; Research retains them,
    // proving that the bounded qualitative boundary remains a supported configured primitive.
    const project = await installedProject("research-profile");
    const program = await compilerProgram(project);
    const objective = "Prepare a bounded ticket orchestration run";
    const resolved = await program.resolveRun({
      runId: "run-lead-judgment",
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, "run-lead-judgment", objective, resolved);
    const prepared = await program.prepareAttempt({
      kind: "lead",
      leadTrigger: "orchestration_entry",
      run,
      attemptId: "attempt-lead-entry",
      sessionId: "session-lead-entry",
      nextAuthorityRevision: 2,
      expectedAuthorityStateHash: digest("lead-entry"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });

    expect(prepared.spec.identity).toMatchObject({
      runId: run.id,
      ticketId: "run-orchestration",
      stepId: "lead-orchestration-entry",
    });
    expect(prepared.spec.workspace.cwd).toBe(project.projectRoot);
    if (prepared.authorityGrant === undefined)
      throw new Error("prepared Lead attempt has no authority grant");
    expect(prepared.authorityGrant.readPaths).toEqual([]);
    expect(prepared.authorityGrant.writePaths).toEqual([]);
    expect(prepared.toolNames).toEqual(["koni_submit_output"]);
    expect(prepared.contextContent).toContain('"kind": "lead_judgment"');
    expect(prepared.contextContent).toContain('"trigger": "orchestration_entry"');
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        protocol: "koni.lead-judgment-output.v1",
        disposition: "proceed",
        summary: "The approved run is ready for deterministic scheduling.",
      }),
    ).toBe(true);
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        protocol: "koni.lead-judgment-output.v1",
        disposition: "proceed",
        summary: "ready",
        ticketsToStart: ["TK-1"],
      }),
    ).toBe(false);

    const attempt = attemptRecord(prepared.spec, "lead", "running");
    run.attempts[attempt.id] = attempt;
    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);
    const recovered = await (
      await compilerProgram(project)
    ).recoverAttempt({
      run,
      attempt,
      spec: prepared.spec,
    });
    expect(recovered.toolNames).toEqual(prepared.toolNames);
    expect(recovered.contextContent).toBe(prepared.contextContent);
    await expect(
      program.compileLeadJudgmentOutput({
        run,
        attemptId: attempt.id,
        output: {
          protocol: "koni.lead-judgment-output.v1",
          disposition: "proceed",
          summary: "The approved run is ready for deterministic scheduling.",
        },
      }),
    ).resolves.toEqual({
      protocol: "koni.lead-judgment-output.v1",
      disposition: "proceed",
      summary: "The approved run is ready for deterministic scheduling.",
    });
    await expect(
      program.compileLeadJudgmentOutput({
        run,
        attemptId: attempt.id,
        output: {
          protocol: "koni.lead-judgment-output.v1",
          disposition: "proceed",
          summary: "ready",
          schedule: ["TK-1"],
        },
      }),
    ).rejects.toMatchObject({ code: "lead_output" });
  }, 30_000);

  it("requires and compiles the configured independent run review instead of skipping agent_review", async () => {
    const project = await installedProject("coding-profile");
    const program = await compilerProgram(project);
    const large = await program.resolveRun({
      runId: "run-large-review",
      objective: "Exercise the independent review stage",
      runTypeId: "large",
      targetRef: "refs/heads/main",
      intake: { goal: "Exercise the independent review stage" },
    });
    const small = await program.resolveRun({
      runId: "run-small-no-review",
      objective: "Keep a focused run proportional",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Keep a focused run proportional" },
    });
    await persistWrites(project.projectRoot, [
      ...(large.artifactWrites ?? []),
      ...(small.artifactWrites ?? []),
    ]);
    const largeRun = runRecord(
      project.projectRoot,
      "run-large-review",
      "Exercise the independent review stage",
      large,
    );
    const smallRun = runRecord(
      project.projectRoot,
      "run-small-no-review",
      "Keep a focused run proportional",
      small,
    );
    expect(await program.requiresVerificationAttempt(largeRun)).toBe(true);
    expect(await program.requiresVerificationAttempt(smallRun)).toBe(false);

    largeRun.attempts["attempt-independent-review"] = {
      id: "attempt-independent-review",
      sessionId: "session-independent-review",
      ticketId: "run-verification",
      stepId: "independent-review",
      personaId: "reviewer",
      modelProvider: "openai-codex",
      modelId: "review-model",
      thinkingLevel: "max",
      status: "running",
      launchSpecHash: digest("independent-review-launch"),
      sessionFile: undefined,
      startedAt: FIXED_NOW.toISOString(),
      endedAt: undefined,
      terminalSummary: undefined,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lineage: { branchEpoch: 0, reason: "initial" },
      authorityMessages: [],
      authorityToolResults: [],
      authorityCompactions: [],
      kind: "verification",
    };
    await expect(
      program.compileVerificationOutput({
        run: largeRun,
        attemptId: "attempt-independent-review",
        output: { status: "completed", summary: "No evidence-backed blockers remain" },
      }),
    ).resolves.toEqual({
      outcome: { status: "completed", summary: "No evidence-backed blockers remain" },
    });
    await expect(
      program.compileVerificationOutput({
        run: largeRun,
        attemptId: "attempt-independent-review",
        output: { status: "failed", blocker: "The acceptance proof is stale" },
      }),
    ).resolves.toEqual({ outcome: { status: "failed", blocker: "The acceptance proof is stale" } });
  }, 30_000);

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
      sealedModelBindingLoader: fixtureSealedModelBinding,
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
    await writeFile(
      projectYaml,
      (await readFile(projectYaml, "utf8")).replace(
        "title: Software project",
        "title: Future-run configuration",
      ),
    );
    const second = await program.resolveRun({
      runId: "run-after-profile-reload",
      objective: "Compile the newly edited configuration",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Compile the newly edited configuration" },
    });

    expect(loaderCalls).toBe(2);
    expect(second.compiledConfigHash).not.toBe(first.compiledConfigHash);
    await expect(
      program.prepareAttempt({
        kind: "planning",
        run: firstRun,
        attemptId: "attempt-from-pinned-first-run",
        sessionId: "session-from-pinned-first-run",
        nextAuthorityRevision: 2,
        expectedAuthorityStateHash: digest("pinned-first-run"),
        lineage: { branchEpoch: 0, reason: "initial" },
      }),
    ).resolves.toMatchObject({
      spec: {
        identity: { runId: firstRun.id },
      },
    });
    expect(loaderCalls).toBe(2);
  });

  it("pins coding resolution, injects answered questions once, and recovers the immutable Pi attempt", async () => {
    const project = await installedProject("coding-profile");
    const personasPath = path.join(project.projectRoot, ".koni", "personas.yaml");
    await writeFile(
      personasPath,
      (await readFile(personasPath, "utf8")).replace(
        "  model_role: planner\n",
        "  model_role: planner\n  skills:\n  - configure-koni\n",
      ),
    );
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
    expect(prepared.spec.resources.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "skills/configure-koni/SKILL.md" }),
        expect.objectContaining({
          relativePath: "skills/configure-koni/references/agents-and-skills.md",
        }),
      ]),
    );
    expect(prepared.spec.persona.systemPrompt).toContain(
      "reissues your exact bound context before every provider request",
    );
    expect(prepared.spec.persona.initialPrompt).toContain("literal $root");
    expect(prepared.spec.persona.initialPrompt).toContain("never invent a root alias");
    expect(prepared.contextContent).toContain("allowedNodeTypes");
    expect(prepared.contextContent).toContain("canonicalEdges");
    expect(
      Value.Check(prepared.terminalOutputSchema!, planningOutput({ work_kind: "general" })),
    ).toBe(true);
    expect(prepared.spec.persona.initialPrompt).toContain("a concise 3-4 word name for this run");
    // The operator run name is schema-optional (frozen personas may omit it) but bounded.
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
        title: "Compact Notes Workflow",
      }),
    ).toBe(true);
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
        title: "ab",
      }),
    ).toBe(false);
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
        graphSeed: { rootSpec: { work_kind: "general", invented: true }, nodes: [], edges: [] },
      }),
    ).toBe(false);
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
        graphSeed: {
          rootSpec: { work_kind: "general" },
          nodes: [
            { key: "fake-slice", type: "implementation_slice", title: "Fake slice", spec: {} },
          ],
          edges: [{ source: "$root", relation: "implemented_by", target: "fake-slice" }],
        },
      }),
    ).toBe(false);
    expect(prepared.contextContent).toContain("Use local-first storage");
    expect(prepared.contextContent).toContain("Keep export reversible");
    expect(prepared.contextContent?.match(/Use local-first storage/gu)).toHaveLength(1);
    expect(prepared.toolNames).not.toContain("koni_context");
    expect(prepared.toolNames).toContain("koni_read_resource");
    expect(
      prepared.spec.tools.find((tool) => tool.name === "koni_read_resource")?.executionMode,
    ).toBe("parallel");
    expect(prepared.spec.budgets.transcript).toEqual({ maxBytes: 64 * 1024 * 1024 });
    expect(prepared.spec.budgets.repositoryCalls).toEqual({ max: 16 });
    expect(prepared.spec.budgets.tokens).toMatchObject({
      maxNew: 120_000,
      providerOutputHeadroom: 128_000,
    });

    const retried = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-planning-retry",
      sessionId: "session-planning-retry",
      nextAuthorityRevision: 5,
      expectedAuthorityStateHash: digest("authority-five-retry"),
      lineage: {
        branchEpoch: 1,
        reason: "retry",
        parentAttemptId: "attempt-planning-one",
        parentSessionId: "session-planning-one",
        parentEntryId: "entry-planning-one",
        conversationFork: {
          parentLaunchSpecHash: prepared.spec.specHash,
          parentTranscriptSha256: digest("planning-parent-transcript"),
        },
      },
    });
    expect(retried.spec.persona.initialPrompt).toContain(
      "The inherited Pi conversation is the repository and execution ledger",
    );
    expect(retried.spec.persona.initialPrompt).toContain(
      "Discard any speculative reasoning from that failed turn",
    );

    const revisionSteering =
      "Keep the existing Sales Notes record unchanged and store optional fields in sibling records.";
    run.plan = {
      revision: 1,
      status: "planning",
      ...(planningOutput({ work_kind: "new_feature" }) as Pick<
        NonNullable<RunRecord["plan"]>,
        "full" | "concise" | "graphSeed"
      >),
      steeringHistory: [{ at: FIXED_NOW.toISOString(), instructions: revisionSteering }],
    };
    const revised = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-planning-revision",
      sessionId: "session-planning-revision",
      nextAuthorityRevision: 5,
      expectedAuthorityStateHash: digest("authority-five"),
      lineage: {
        branchEpoch: 1,
        reason: "rework",
        parentAttemptId: "attempt-planning-one",
        parentSessionId: "session-planning-one",
        parentEntryId: "entry-planning-one",
      },
    });
    expect(revised.spec.persona.initialPrompt).toContain("Revise the prior small plan");
    expect(revised.spec.persona.initialPrompt).toContain(revisionSteering);
    expect(revised.spec.persona.initialPrompt).toContain("do not repeat repository discovery");
    expect(
      revised.spec.persona.initialPrompt.match(new RegExp(revisionSteering, "gu")),
    ).toHaveLength(1);
    expect(prepared.spec.budgets.retries).toEqual({
      maxProviderRetries: 0,
      baseDelayMs: 0,
    });
    expect(prepared.spec.model).toMatchObject({
      api: "openai-codex-responses",
      catalogMaxTokens: 128_000,
      catalogSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(prepared.spec.persona.systemPrompt).toContain("bounded to 16 total");
    expect(prepared.spec.persona.systemPrompt).toContain("narrowest objective-derived source root");
    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);

    const attempt = attemptRecord(prepared.spec, "planning", "running");
    run.attempts[attempt.id] = attempt;
    const projectYaml = path.join(project.projectRoot, ".koni", "project.yaml");
    await writeFile(
      projectYaml,
      (await readFile(projectYaml, "utf8")).replace(
        "title: Software project",
        "title: Changed after this run was pinned",
      ),
    );
    const restarted = await compilerProgram(project);
    const recovered = await restarted.recoverAttempt({ run, attempt, spec: prepared.spec });
    expect(recovered.spec).toBe(prepared.spec);
    expect(recovered.contextContent).toBe(prepared.contextContent);
    expect(canonicalHash(recovered.authorityGrant!)).toBe(prepared.spec.authority.grantHash);
    expect(recovered.toolNames).toEqual(prepared.spec.tools.map((tool) => tool.name));
    expect(
      await restarted.refreshCompactionSnapshot({ run, attempt, spec: prepared.spec }),
    ).toMatchObject({
      touchedFiles: [],
      receiptIds: [],
      unresolvedQuestions: [],
    });
    const receiptPath = `runs/${run.id}/attempts/${attempt.id}/tool-receipts/write.json`;
    const receipt = {
      receiptId: "receipt-write-notes",
      summary: "Wrote src/notes.ts",
      value: { path: "src/notes.ts", sha256: digest("notes-bytes") },
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
    const canonicalReceipt = canonicalEncode(receipt);
    await persistWrites(project.projectRoot, [
      {
        path: receiptPath,
        bytes: receiptBytes,
        expectedSha256: null,
      },
    ]);
    attempt.authorityToolResults = [
      {
        sequence: 1,
        callId: "call-write-notes",
        toolName: "koni_write_file",
        outcome: "accepted",
        argumentsSha256: rawSha256("{}"),
        argumentsSizeBytes: 2,
        receiptSha256: rawSha256(canonicalReceipt),
        receiptSizeBytes: Buffer.byteLength(canonicalReceipt, "utf8"),
        artifactPath: receiptPath,
        recordedAt: FIXED_NOW.toISOString(),
      },
    ];
    expect(
      await restarted.refreshCompactionSnapshot({ run, attempt, spec: prepared.spec }),
    ).toMatchObject({
      touchedFiles: ["src/notes.ts"],
      receiptIds: ["receipt-write-notes"],
    });

    const listReceiptPath = `runs/${run.id}/attempts/${attempt.id}/tool-receipts/list.json`;
    const listReceipt = {
      receiptId: "receipt-list-tree",
      summary: "Listed src recursively",
      value: {
        entries: [
          { path: "src/one.ts", kind: "file", sizeBytes: 10 },
          { path: "src/generated", kind: "directory", sizeBytes: 0 },
          { path: "src/generated/two.ts", kind: "file", sizeBytes: 20 },
        ],
      },
    };
    const canonicalListReceipt = canonicalEncode(listReceipt);
    await persistWrites(project.projectRoot, [
      {
        path: listReceiptPath,
        bytes: Buffer.from(`${JSON.stringify(listReceipt)}\n`, "utf8"),
        expectedSha256: null,
      },
    ]);
    attempt.authorityToolResults.push({
      sequence: 2,
      callId: "call-list-tree",
      toolName: "koni_list_files",
      outcome: "accepted",
      argumentsSha256: rawSha256("{}"),
      argumentsSizeBytes: 2,
      receiptSha256: rawSha256(canonicalListReceipt),
      receiptSizeBytes: Buffer.byteLength(canonicalListReceipt, "utf8"),
      artifactPath: listReceiptPath,
      recordedAt: FIXED_NOW.toISOString(),
    });
    expect(
      await restarted.refreshCompactionSnapshot({ run, attempt, spec: prepared.spec }),
    ).toMatchObject({
      touchedFiles: ["src/notes.ts"],
      receiptIds: ["receipt-list-tree", "receipt-write-notes"],
    });

    await expect(
      program.resolveRun({
        runId: "run-invalid-thinking",
        objective: "Reject a legacy level",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Reject a legacy level" },
        overrides: { agents: { lead: { thinkingLevel: "ultra" } } },
      }),
    ).rejects.toBeInstanceOf(NativeRunProgramError);
  });

  it("uses the pinned compiled behavior as the sole launch and initialization policy", async () => {
    const project = await installedProject("coding-profile");
    const original = await compilerProgram(project);
    const runId = "run-compiled-behavior-only";
    const objective = "Prove compiled behavior authority";
    const resolved = await original.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    const expectedPlanning = resolved.behavior.runType.planning!;
    const compiledWrite = resolved.artifactWrites?.find(
      (write) => write.path === `runs/${runId}/configuration/compiled.json`,
    );
    expect(compiledWrite).toBeDefined();
    const artifact = JSON.parse(Buffer.from(compiledWrite!.bytes).toString("utf8")) as Record<
      string,
      unknown
    >;
    const configuration = artifact.configuration as Record<string, unknown>;
    const profile = configuration.profile as Record<string, unknown>;
    const initialization = profile.initialization as Record<string, unknown>;
    initialization.root_node_type = "raw-config-must-not-be-read";
    initialization.goal_field = "spec.raw_goal_must_not_be_read";
    initialization.planning_context_field = "spec.raw_context_must_not_be_read";
    initialization.planning_seed_operation = "raw-operation-must-not-be-read";
    initialization.root_status = "raw-status-must-not-be-read";
    const runTypes = configuration.run_types as Record<string, unknown>;
    const small = runTypes.small as Record<string, unknown>;
    const document = small.document as Record<string, unknown>;
    const planning = document.planning as Record<string, unknown>;
    planning.max_repository_tool_calls = 1;
    const rawTokenBudget = planning.token_budget as Record<string, unknown>;
    rawTokenBudget.limit = 2;
    rawTokenBudget.synthesis_reserve = 1;
    delete configuration.configuration_sha256;
    const configurationSha256 = canonicalHash(configuration);
    configuration.configuration_sha256 = configurationSha256;
    delete artifact.artifactSha256;
    artifact.artifactSha256 = canonicalHash(artifact);
    const mutatedWrites = resolved.artifactWrites!.map((write) =>
      write === compiledWrite
        ? { ...write, bytes: Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8") }
        : write,
    );
    const mutatedResolved = {
      ...resolved,
      compiledConfigHash: configurationSha256,
      artifactWrites: mutatedWrites,
    };
    await persistWrites(project.projectRoot, mutatedWrites);
    const run = runRecord(project.projectRoot, runId, objective, mutatedResolved);
    const restarted = await compilerProgram(project);
    const prepared = await restarted.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-compiled-behavior-only",
      sessionId: "session-compiled-behavior-only",
      nextAuthorityRevision: 7,
      expectedAuthorityStateHash: digest("compiled-behavior-authority"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(prepared.spec.budgets.repositoryCalls).toEqual({
      max: expectedPlanning.maxRepositoryToolCalls,
    });
    expect(prepared.spec.budgets.tokens.maxNew).toBe(expectedPlanning.tokenPolicy.limit);
    const compiled = await restarted.compilePlanningOutput({
      run,
      attemptId: prepared.spec.identity.attemptId,
      output: {
        ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
        title: "  Compact   Notes Workflow  ",
      },
    });
    expect(compiled.graphHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The planner-authored operator name is normalized and carried on the durable plan.
    expect(compiled.plan.title).toBe("Compact Notes Workflow");

    const untitled = await restarted.compilePlanningOutput({
      run,
      attemptId: prepared.spec.identity.attemptId,
      output: planningOutput({ work_kind: "general" }),
    });
    expect(untitled.plan.title).toBeUndefined();
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

    await expect(
      program.prepareAttempt({
        kind: "planning",
        run,
        attemptId: "attempt-native-missing-planner",
        sessionId: "session-native-missing-planner",
        nextAuthorityRevision: 2,
        expectedAuthorityStateHash: digest("native-missing-planner"),
        lineage: { branchEpoch: 0, reason: "initial" },
      }),
    ).rejects.toMatchObject({ code: "planning_workspace" });

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

    await expect(
      program.prepareAttempt({
        kind: "planning",
        run,
        attemptId: "attempt-relocated-legacy-planner",
        sessionId: "session-relocated-legacy-planner",
        nextAuthorityRevision: 3,
        expectedAuthorityStateHash: digest("relocated-legacy-planner"),
        lineage: { branchEpoch: 0, reason: "initial" },
      }),
    ).resolves.toMatchObject({
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
    expect(resolved.lifecycleCatalog).toMatchObject({
      protocol: "koni.state-machine-catalog.v1",
      configuration_sha256: resolved.compiledConfigHash,
      machines: { ticket: expect.any(Object), run: expect.any(Object) },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, "Add note pinning", resolved);
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-plan",
      output: planningOutput({ work_kind: "general" }),
    });
    expect(Object.keys(planning.plan.full).sort()).toEqual([
      "architecture",
      "decisions",
      "risk",
      "verification",
    ]);
    expect(Object.keys(planning.plan.concise).sort()).toEqual([
      "architecture",
      "decisions",
      "risk",
      "verification",
    ]);
    for (const domain of ["architecture", "decisions", "risk", "verification"] as const) {
      expect(planning.plan.full[domain]).toMatch(/^## /u);
      expect(planning.plan.concise[domain]).toEqual([
        expect.objectContaining({ title: expect.any(String), description: expect.any(String) }),
      ]);
    }
    expect(planning.plan.concise.architecture?.[0]?.title).toBe("Notes ownership seam");
    const incompleteFull = fullPlans();
    delete incompleteFull.verification;
    await expect(
      program.compilePlanningOutput({
        run,
        attemptId: "attempt-incomplete-plan",
        output: {
          ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
          full: incompleteFull,
        },
      }),
    ).rejects.toBeInstanceOf(NativeRunProgramError);
    await expect(
      program.compilePlanningOutput({
        run,
        attemptId: "attempt-malformed-plan",
        output: {
          full: fullPlans(),
          concise: { architecture: ["Truncated prose is not a structured mini-plan"] },
          graphSeed: { rootSpec: { work_kind: "general" }, nodes: [], edges: [] },
        },
      }),
    ).rejects.toBeInstanceOf(NativeRunProgramError);
    await expect(
      program.compilePlanningOutput({
        run,
        attemptId: "attempt-invented-root-alias",
        output: {
          ...(planningOutput({ work_kind: "general" }) as Record<string, unknown>),
          graphSeed: {
            rootSpec: { work_kind: "general" },
            nodes: [
              {
                key: "notes-change",
                type: "change",
                title: "Add note pinning",
                spec: {},
              },
            ],
            edges: [
              {
                source: "notes-pinning-plan",
                relation: "requires",
                target: "notes-change",
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "graph_seed_edge_key",
      message: expect.stringContaining(
        "notes-pinning-plan; use $root for the existing run objective",
      ),
    });

    run.plan = { ...planning.plan, status: "awaiting_approval" };
    run.graphHash = planning.graphHash;
    run.graphRevision = planning.graphRevision ?? 0;
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "plan_submitted",
      atMs: FIXED_NOW.getTime(),
    }).state;
    const reviewedProjection = await program.projectGraph(run);
    expect(reviewedProjection.nodes).toHaveLength(1);
    expect(reviewedProjection.nodes[0]).toMatchObject({
      type: "objective",
      spec: expect.objectContaining({ work_kind: "general" }),
    });
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "pause_requested",
      atMs: FIXED_NOW.getTime() + 1,
    }).state;
    expect((await program.projectGraph(run)).nodes).toEqual(reviewedProjection.nodes);
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "pause_settled",
      atMs: FIXED_NOW.getTime() + 2,
    }).state;
    expect((await program.projectGraph(run)).nodes).toEqual(reviewedProjection.nodes);
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "resume_requested",
      atMs: FIXED_NOW.getTime() + 3,
    }).state;
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "plan_revision_requested",
      atMs: FIXED_NOW.getTime() + 4,
    }).state;
    run.plan = { ...run.plan, status: "planning" };
    expect((await program.projectGraph(run)).nodes).toEqual(reviewedProjection.nodes);
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "plan_submitted",
      atMs: FIXED_NOW.getTime() + 5,
    }).state;
    run.plan = { ...run.plan, status: "awaiting_approval" };
    run.lifecycle = reduceRunLifecycle(run.lifecycle, {
      type: "plan_approval_requested",
      atMs: FIXED_NOW.getTime() + 6,
    }).state;
    run.plan = { ...run.plan, status: "approving" };
    expect((await program.projectGraph(run)).nodes).toEqual(reviewedProjection.nodes);
    run.plan = { ...run.plan, status: "approved" };
    materializeApprovedFixtureRun(run);
    const approved = await program.initializeApprovedPlan(run);
    expect(Object.values(approved.tickets)).toHaveLength(1);
    const architectureTicket = Object.values(approved.tickets)[0]!;
    expect(architectureTicket.operationId).toBe("architecture.objective.map");
    expect(architectureTicket.executionPolicyBinding).toMatchObject({
      protocol: "koni.execution-policy-binding.v1",
      configurationSha256: resolved.compiledConfigHash,
      operationId: "architecture.objective.map",
      workflowId: "architecture-map",
      workflowVersion: "2.0.0",
      context: {
        outputContract: { text: expect.stringContaining("Add at least one system") },
        reviewContract: {
          text: expect.stringContaining("smallest affected repository-native boundary"),
        },
      },
    });
    expect(
      architectureTicket.steps.every(
        (step) =>
          step.executionPolicyBinding?.stepId === step.id &&
          step.executionPolicyBinding.configurationSha256 === resolved.compiledConfigHash,
      ),
    ).toBe(true);
    expect(architectureTicket.readNodeIds).toBeDefined();
    expect(architectureTicket.writeNodeIds).toBeDefined();
    expect(architectureTicket.steps.every((step) => step.dependsOn !== undefined)).toBe(true);
    await persistWrites(project.projectRoot, approved.artifactWrites ?? []);
    run.graphHash = approved.graphHash;
    run.graphRevision = approved.graphRevision;
    run.tickets = approved.tickets;
    architectureTicket.reviewReworks ??= [];
    architectureTicket.reviewReworks.push({
      ordinal: 1,
      mode: "supervised",
      failedReviewAttemptId: "attempt-prior-review",
      reopenFromStepId: architectureTicket.reviewFailureReopenFrom!,
      blocker: "The prior review found a material parent-consumer route gap.",
      operatorSteering: "Keep the real parent boundary and stub only unrelated leaf components.",
      openedAt: FIXED_NOW.toISOString(),
    });

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
    expect(prepared.contextContent).toContain('"executionPolicy"');
    expect(prepared.contextContent).toContain('"operationId": "architecture.objective.map"');
    expect(prepared.contextContent).toContain('"ref": "refs/heads/main"');
    expect(prepared.contextContent).toContain('"mutationContract"');
    expect(prepared.contextContent).toContain('"allowedForNew": true');
    expect(prepared.spec.persona.initialPrompt).toContain("Operation output contract:");
    expect(prepared.spec.persona.initialPrompt).toContain(
      "The operator explicitly authorized reviewed-blocker recovery 1",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Operator steering for this exact recovery: Keep the real parent boundary",
    );
    expect(prepared.spec.persona.initialPrompt).toContain(
      "Any koni_submit_output call or accepted terminal result in the inherited parent transcript",
    );

    const reviewWorktree = path.join(project.projectRoot, ".ticket-review-worktree");
    await mkdir(reviewWorktree, { recursive: true });
    architectureTicket.worktreePath = reviewWorktree;
    run.git.ticketCycles[architectureTicket.gitCycleId!]!.worktree = reviewWorktree;
    const reviewStep = architectureTicket.steps.find((step) => step.kind === "review")!;
    const reviewRun = structuredClone(run);
    const reviewTicket = reviewRun.tickets[architectureTicket.id]!;
    reviewTicket.reviewReworks!.at(-1)!.scope = "review_only";
    const predecessor = attemptRecord(prepared.spec, "ticket", "completed");
    predecessor.endedAt = FIXED_NOW.toISOString();
    predecessor.terminalSummary = "Expected-red proof command completed.";
    reviewRun.attempts[predecessor.id] = predecessor;
    const predecessorStep = reviewTicket.steps.find((step) => step.id === assignment.stepId)!;
    predecessorStep.status = "completed";
    predecessorStep.attemptIds = [predecessor.id];
    predecessorStep.startedAt = FIXED_NOW.toISOString();
    predecessorStep.completedAt = FIXED_NOW.toISOString();
    predecessorStep.summary = predecessor.terminalSummary;
    const graphOnlyReviewPrepared = await program.prepareAttempt({
      kind: "verification",
      run: reviewRun,
      assignment: {
        runId: run.id,
        ticketId: architectureTicket.id,
        stepId: reviewStep.id,
        personaId: reviewStep.personaId,
        priority: architectureTicket.priority,
      },
      attemptId: "attempt-architecture-review-graph-only",
      sessionId: "session-architecture-review-graph-only",
      nextAuthorityRevision: 10,
      expectedAuthorityStateHash: digest("authority-ten-graph-only"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: "attempt-architecture",
        parentSessionId: "session-architecture",
      },
    });
    expect(graphOnlyReviewPrepared.spec.persona.initialPrompt).toContain(
      "preceding step is graph-only",
    );
    expect(graphOnlyReviewPrepared.spec.persona.initialPrompt).not.toContain(
      "Inspect every command in the compiler-authenticated predecessorExecution evidence",
    );
    expect(graphOnlyReviewPrepared.spec.persona.initialPrompt).toContain(
      "independent rereview of the unchanged compiler-accepted predecessor",
    );
    expect(graphOnlyReviewPrepared.spec.persona.initialPrompt).toContain(
      "historical context, not a required conclusion",
    );
    expect(graphOnlyReviewPrepared.spec.persona.initialPrompt).not.toContain(
      "Materially address every finding",
    );
    const endpoint = await discoverAuthorityEndpoint(project.projectRoot);
    const stdout = Buffer.from(
      "FAIL questionnaire oracle: expected Sales Notes to be General\n",
      "utf8",
    );
    const stderr = Buffer.from("Error: Objects are not valid as a React child\n", "utf8");
    const checkRoot = `runs/${reviewRun.id}/attempts/${predecessor.id}/checks/review-fixture`;
    await mkdir(path.join(endpoint.stateRoot, checkRoot), { recursive: true });
    await writeFile(path.join(endpoint.stateRoot, checkRoot, "stdout.bin"), stdout);
    await writeFile(path.join(endpoint.stateRoot, checkRoot, "stderr.bin"), stderr);
    reviewRun.checks = [
      {
        id: "check-review-fixture",
        attemptId: predecessor.id,
        callId: "call-review-fixture",
        requestedCheckId: "expected-red",
        definitionHash: digest("expected-red-definition"),
        kind: "command",
        accepted: true,
        passed: true,
        summary: "Configured nonzero exit accepted",
        commands: [
          {
            checkId: "expected-red",
            definitionHash: digest("expected-red-definition"),
            startedAt: FIXED_NOW.toISOString(),
            completedAt: FIXED_NOW.toISOString(),
            resolvedExecutable: "/usr/bin/test",
            argv: ["/usr/bin/test", "focused-oracle"],
            environmentSha256: digest("review-environment"),
            exitCode: 1,
            signal: null,
            stdoutSha256: rawSha256(stdout),
            stdoutSizeBytes: stdout.byteLength,
            stdoutArtifactPath: `${checkRoot}/stdout.bin`,
            stderrSha256: rawSha256(stderr),
            stderrSizeBytes: stderr.byteLength,
            stderrArtifactPath: `${checkRoot}/stderr.bin`,
            preManifestSha256: digest("review-manifest"),
            postManifestSha256: digest("review-manifest"),
            sandboxKind: "fixture",
            sandboxProfileSha256: digest("review-sandbox"),
            resultSource: {
              kind: "stdout",
              bytesSha256: rawSha256(stdout),
              sizeBytes: stdout.byteLength,
            },
            outputFiles: [],
          },
        ],
        evidenceSha256: digest("review-evidence"),
        evidenceSizeBytes: 1,
        evidenceArtifactPath: `${checkRoot}/evidence.json`,
        recordedAt: FIXED_NOW.toISOString(),
      },
    ];
    const reviewPrepared = await program.prepareAttempt({
      kind: "verification",
      run: reviewRun,
      assignment: {
        runId: run.id,
        ticketId: architectureTicket.id,
        stepId: reviewStep.id,
        personaId: reviewStep.personaId,
        priority: architectureTicket.priority,
      },
      attemptId: "attempt-architecture-review",
      sessionId: "session-architecture-review",
      nextAuthorityRevision: 10,
      expectedAuthorityStateHash: digest("authority-ten"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: "attempt-architecture",
        parentSessionId: "session-architecture",
      },
    });
    expect(reviewPrepared.spec.identity).toMatchObject({
      ticketId: architectureTicket.id,
      stepId: reviewStep.id,
    });
    expect(reviewPrepared.spec.persona.id).toBe("reviewer");
    expect(reviewPrepared.spec.workspace.cwd).toBe(architectureTicket.worktreePath);
    expect(reviewPrepared.spec.workspace.cwd).not.toBe(run.git.run.worktree);
    expect(reviewPrepared.spec.tools.map((tool) => tool.name)).not.toContain("koni_write_file");
    expect(reviewPrepared.spec.persona.initialPrompt).toContain("Independent review contract:");
    expect(reviewPrepared.spec.persona.initialPrompt).toContain(
      "compiler-authenticated predecessorExecution",
    );
    expect(reviewPrepared.contextContent).toContain('"predecessorExecution"');
    expect(reviewPrepared.contextContent).toContain("expected Sales Notes to be General");
    expect(reviewPrepared.contextContent).toContain("Objects are not valid as a React child");

    const pinnedCockpit = await program.projectCockpitCatalog(run);
    const pinnedLifecycle = await program.projectStateMachineCatalog(run);
    const pinnedExecution = await program.projectExecutionSemanticCatalog(run);
    expect(pinnedCockpit.configurationSha256).toBe(resolved.compiledConfigHash);
    expect(pinnedLifecycle.catalog_sha256).toBe(resolved.lifecycleCatalog?.catalog_sha256);
    expect(pinnedExecution.operations[architectureTicket.operationId]?.sha256).toBe(
      architectureTicket.executionPolicyBinding?.operationSha256,
    );

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
    expect(note.value).toMatchObject({
      nodeId: initialProjection.nodes[0]!.id,
      kind: "rationale",
      status: "working",
    });
    expect(note.activity).toEqual([
      expect.objectContaining({
        kind: "agent",
        nodeId: initialProjection.nodes[0]!.id,
        ticketId: architectureTicket.id,
      }),
    ]);
    expect(note.artifactWrites).toHaveLength(1);

    const root = initialProjection.nodes[0]!;
    const forbiddenCodingHandoff = {
      status: "completed",
      summary: "Attempted to escape the coding ticket through Research change control",
      upstreamChangeRequest: {
        targetNodeIds: [root.id],
        summary: "Broaden architecture",
        reason: "This operation must not own the Research handoff protocol",
      },
    };
    expect(Value.Check(prepared.terminalOutputSchema!, forbiddenCodingHandoff)).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: "attempt-architecture",
        output: forbiddenCodingHandoff,
      }),
    ).rejects.toMatchObject({ code: "change_control_route_forbidden" });
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: "attempt-architecture",
        output: {
          status: "completed",
          summary: "Tried to rename the existing objective while mapping architecture",
          graphDelta: {
            protocol: "koni.graph-delta.v1",
            expectedGraphHash: run.graphHash,
            upsertNodes: [
              {
                expectedNodeHash: canonicalHash(root),
                node: { ...root, title: "Renamed objective" },
              },
            ],
            deleteNodes: [],
            addEdges: [],
            removeEdges: [],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "execution_policy.edge_only_non_edge_change" });
    const obsolete = structuredClone(architectureTicket);
    obsolete.id = "TK-never-started-obsolete";
    obsolete.title = "Obsolete queued follow-up";
    obsolete.status = "ready";
    obsolete.worktreePath = undefined;
    obsolete.branch = undefined;
    delete obsolete.gitCycleId;
    for (const step of obsolete.steps) {
      step.status = "pending";
      step.attemptIds = [];
      step.startedAt = undefined;
      step.completedAt = undefined;
      step.summary = undefined;
    }
    run.tickets[obsolete.id] = obsolete;
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
          upsertNodes: [
            {
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
            },
          ],
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
    expect(compiled.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "graph_added", nodeId: "system-notes-app" }),
      ]),
    );
    expect(
      Object.values(compiled.tickets ?? {}).some(
        (ticket) => ticket.operationId === "design.objective.plan-change",
      ),
    ).toBe(true);
    expect(compiled.tickets?.[obsolete.id]).toMatchObject({
      status: "cancelled",
      blocker: "Superseded before execution by newer compiler state",
      steps: expect.arrayContaining([
        expect.objectContaining({ status: "skipped", attemptIds: [] }),
      ]),
    });
    await persistWrites(project.projectRoot, compiled.artifactWrites ?? []);
    run.graphHash = compiled.graphHash;
    run.graphRevision = compiled.graphRevision!;
    run.tickets = compiled.tickets!;
    const projected = await program.projectGraph(run, architectureTicket.id);
    expect(projected.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([root.id, "system-notes-app"]),
    );
    expect(projected.edges).toContainEqual({
      source: root.id,
      relation: "systems",
      target: "system-notes-app",
    });

    // Current compilers retain the originating definition after its rule stops applying. Runs
    // admitted before that retention existed must still be able to recover the definition from
    // the exact compiler input of an already-issued attempt, without re-evaluating future YAML.
    const endpointAfterGraphChange = await discoverAuthorityEndpoint(project.projectRoot);
    const definitionPath = path.join(
      endpointAfterGraphChange.stateRoot,
      `runs/${run.id}/program/ticket-definitions.json`,
    );
    const definitionArtifact = JSON.parse(await readFile(definitionPath, "utf8")) as {
      retainedDefinitions?: Array<{ id: string }>;
    };
    expect(definitionArtifact.retainedDefinitions?.map((definition) => definition.id)).toContain(
      architectureTicket.id,
    );
    delete definitionArtifact.retainedDefinitions;
    await writeFile(definitionPath, `${JSON.stringify(definitionArtifact)}\n`);
    const issuedAttemptDirectory = path.join(
      endpointAfterGraphChange.stateRoot,
      `runs/${run.id}/attempts/${architectureAttempt.id}`,
    );
    await writeFile(
      path.join(issuedAttemptDirectory, "launch-spec.json"),
      `${JSON.stringify(prepared.spec)}\n`,
    );
    const recoveredDefinitionAttempt = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment,
      attemptId: "attempt-architecture-compat-retry",
      sessionId: "session-architecture-compat-retry",
      nextAuthorityRevision: 11,
      expectedAuthorityStateHash: digest("authority-eleven"),
      lineage: {
        branchEpoch: 2,
        reason: "retry",
        parentAttemptId: architectureAttempt.id,
        parentSessionId: architectureAttempt.sessionId,
      },
    });
    expect(recoveredDefinitionAttempt.spec.identity).toMatchObject({
      ticketId: architectureTicket.id,
      stepId: assignment.stepId,
    });
  });

  it("advances an exact reviewed proof preparation without reissuing the preparation ticket", async () => {
    const project = await installedProject("coding-profile");
    await mkdir(path.join(project.projectRoot, "src"), { recursive: true });
    await mkdir(path.join(project.projectRoot, "tests"), { recursive: true });
    await mkdir(path.join(project.projectRoot, "test-support"), { recursive: true });
    await writeFile(
      path.join(project.projectRoot, "src/feature.ts"),
      "export const label = 'legacy';\n",
    );
    await writeFile(
      path.join(project.projectRoot, "tests/feature.test.mjs"),
      "process.exitCode = 1;\n",
    );
    await writeFile(
      path.join(project.projectRoot, "test-support/vitest.config.ts"),
      "export default { test: { environment: 'node' } };\n",
    );
    git(project.projectRoot, ["add", "src", "tests", "test-support"]);
    git(project.projectRoot, ["commit", "-m", "fixture proof seam"]);

    const program = await compilerProgram(project);
    const runId = "run-proof-preparation-current";
    const objective = "Add one backward-compatible field";
    const resolved = await program.resolveRun({
      runId,
      objective,
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: objective },
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, runId, objective, resolved);
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-proof-plan",
      output: proofPreparationPlanningOutput(),
    });
    run.plan = { ...planning.plan, status: "approved" };
    run.graphHash = planning.graphHash;
    run.graphRevision = planning.graphRevision ?? 0;
    materializeApprovedFixtureRun(run);
    const initialized = await program.initializeApprovedPlan(run);
    await persistWrites(project.projectRoot, initialized.artifactWrites ?? []);
    run.graphHash = initialized.graphHash;
    run.graphRevision = initialized.graphRevision;
    run.tickets = initialized.tickets;
    const preparation = Object.values(run.tickets).find(
      (ticket) => ticket.operationId === "assurance.proof.prepare",
    );
    expect(preparation).toBeDefined();
    if (preparation === undefined) throw new Error("fixture did not derive proof preparation");

    const authorAssignment = assignmentFor(run, preparation.id);
    const authorPrepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment: authorAssignment,
      attemptId: "attempt-proof-author",
      sessionId: "session-proof-author",
      nextAuthorityRevision: 5,
      expectedAuthorityStateHash: digest("proof-authority-five"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(authorPrepared.authorityGrant?.readPaths).toEqual(
      expect.arrayContaining([
        "src/feature.ts",
        "tests/feature.test.mjs",
        "test-support/vitest.config.ts",
      ]),
    );
    expect(authorPrepared.authorityGrant?.writePaths).toEqual(["tests/feature.test.mjs"]);
    await persistWrites(project.projectRoot, authorPrepared.artifactWrites ?? []);
    const author = attemptRecord(authorPrepared.spec, "ticket", "running");
    run.attempts[author.id] = author;
    const baseline = await program.resolveAgentCheck({
      run,
      attempt: author,
      checkId: "baseline-proof-set",
    });
    expect(baseline.commands).toEqual([
      expect.objectContaining({
        inputPaths: expect.arrayContaining([
          "src/feature.ts",
          "tests/feature.test.mjs",
          "test-support/vitest.config.ts",
        ]),
        memberSourcePaths: ["test-support/vitest.config.ts", "tests/feature.test.mjs"],
      }),
    ]);
    author.status = "completed";
    author.endedAt = FIXED_NOW.toISOString();
    author.terminalSummary = "Recorded the honest historical baseline.";
    author.terminalPolicy = semanticTerminalPolicy("proof-author");
    const authorOutput = Buffer.from(
      `${JSON.stringify({
        status: "completed",
        summary: author.terminalSummary,
      })}\n`,
      "utf8",
    );
    author.terminalOutputSha256 = rawSha256(authorOutput);
    author.terminalOutputSizeBytes = authorOutput.byteLength;
    author.terminalAcceptedAt = FIXED_NOW.toISOString();
    const authorStep = preparation.steps.find((step) => step.id === authorAssignment.stepId)!;
    authorStep.status = "completed";
    authorStep.attemptIds = [author.id];
    authorStep.startedAt = FIXED_NOW.toISOString();
    authorStep.completedAt = FIXED_NOW.toISOString();
    authorStep.summary = author.terminalSummary;
    const endpoint = await discoverAuthorityEndpoint(project.projectRoot);
    const authorDirectory = path.join(endpoint.stateRoot, `runs/${run.id}/attempts/${author.id}`);
    await mkdir(authorDirectory, { recursive: true });
    await writeFile(path.join(authorDirectory, "terminal-output.json"), authorOutput);

    const manifest = await snapshotContainedPaths(preparation.worktreePath!, [
      "test-support/vitest.config.ts",
      "tests/feature.test.mjs",
    ]);
    const manifestMaterial = {
      protocol: "koni.run-check-source-manifest.v1" as const,
      configurationSha256: run.compiledConfigHash,
      catalogSha256: preparation.executionPolicyBinding!.catalogSha256,
      bindingSha256: authorStep.executionPolicyBinding!.sha256,
      checkSha256: digest("proof-expected-red-check"),
      commandBindingSha256: digest("proof-expected-red-command"),
      stepId: authorStep.id,
      roots: [...manifest.roots],
      entries: manifest.entries.map((entry) => ({ ...entry })),
      manifestSha256: manifest.manifestSha256,
      capturedAt: FIXED_NOW.toISOString(),
    };
    const sourceManifest = { ...manifestMaterial, sha256: canonicalHash(manifestMaterial) };
    const stdout = Buffer.from("expected legacy assertion failure\n", "utf8");
    const stderr = Buffer.alloc(0);
    const checkDirectory = `runs/${run.id}/attempts/${author.id}/checks/baseline`;
    await mkdir(path.join(endpoint.stateRoot, checkDirectory), { recursive: true });
    await writeFile(path.join(endpoint.stateRoot, checkDirectory, "stdout.bin"), stdout);
    await writeFile(path.join(endpoint.stateRoot, checkDirectory, "stderr.bin"), stderr);
    run.checks = [
      {
        id: "check-proof-baseline",
        attemptId: author.id,
        callId: "call-proof-baseline",
        requestedCheckId: "baseline-proof-set",
        definitionHash: digest("baseline-proof-set-definition"),
        kind: "composite",
        accepted: true,
        passed: true,
        summary: "baseline-proof-set passed",
        commands: [
          {
            checkId: "proof-expected-red",
            definitionHash: digest("proof-expected-red-check"),
            sourceManifest,
            startedAt: FIXED_NOW.toISOString(),
            completedAt: FIXED_NOW.toISOString(),
            resolvedExecutable: "/usr/bin/node",
            argv: ["/usr/bin/node", "tests/feature.test.mjs"],
            environmentSha256: digest("proof-environment"),
            exitCode: 1,
            signal: null,
            stdoutSha256: rawSha256(stdout),
            stdoutSizeBytes: stdout.byteLength,
            stdoutArtifactPath: `${checkDirectory}/stdout.bin`,
            stderrSha256: rawSha256(stderr),
            stderrSizeBytes: stderr.byteLength,
            stderrArtifactPath: `${checkDirectory}/stderr.bin`,
            preManifestSha256: digest("proof-workspace-manifest"),
            postManifestSha256: digest("proof-workspace-manifest"),
            sandboxKind: "fixture",
            sandboxProfileSha256: digest("proof-sandbox"),
            resultSource: {
              kind: "stdout",
              bytesSha256: rawSha256(stdout),
              sizeBytes: stdout.byteLength,
            },
            outputFiles: [],
          },
        ],
        evidenceSha256: digest("proof-baseline-evidence"),
        evidenceSizeBytes: 1,
        evidenceArtifactPath: `${checkDirectory}/evidence.json`,
        recordedAt: FIXED_NOW.toISOString(),
      },
    ];

    const reviewStep = preparation.steps.find((step) => step.kind === "review")!;
    const reviewAssignment: ReadyAssignment = {
      runId: run.id,
      ticketId: preparation.id,
      stepId: reviewStep.id,
      personaId: reviewStep.personaId,
      priority: preparation.priority,
    };
    const reviewPrepared = await program.prepareAttempt({
      kind: "verification",
      run,
      assignment: reviewAssignment,
      attemptId: "attempt-proof-review",
      sessionId: "session-proof-review",
      nextAuthorityRevision: 6,
      expectedAuthorityStateHash: digest("proof-authority-six"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: author.id,
        parentSessionId: author.sessionId,
      },
    });
    await persistWrites(project.projectRoot, reviewPrepared.artifactWrites ?? []);
    const review = attemptRecord(reviewPrepared.spec, "verification", "terminal_accepted");
    review.reviewedGraphHash = run.graphHash;
    review.terminalAcceptedAt = FIXED_NOW.toISOString();
    const reviewOutput = Buffer.from(
      `${JSON.stringify({
        status: "completed",
        summary: "The historical proof is independently reviewed and complete.",
      })}\n`,
      "utf8",
    );
    review.terminalOutputSha256 = rawSha256(reviewOutput);
    review.terminalOutputSizeBytes = reviewOutput.byteLength;
    run.attempts[review.id] = review;
    reviewStep.status = "running";
    reviewStep.attemptIds = [review.id];
    reviewStep.startedAt = FIXED_NOW.toISOString();
    const reviewDirectory = path.join(endpoint.stateRoot, `runs/${run.id}/attempts/${review.id}`);
    await mkdir(reviewDirectory, { recursive: true });
    await writeFile(
      path.join(reviewDirectory, "launch-spec.json"),
      `${JSON.stringify(reviewPrepared.spec)}\n`,
    );
    await writeFile(path.join(reviewDirectory, "terminal-output.json"), reviewOutput);

    const compiled = await program.compileAssignmentOutput({
      run,
      assignment: reviewAssignment,
      attemptId: review.id,
      output: JSON.parse(reviewOutput.toString("utf8")),
    });
    expect(
      Object.values(compiled.tickets ?? {}).some(
        (ticket) => ticket.operationId === "implementation.change.red-green",
      ),
    ).toBe(true);
    await persistWrites(project.projectRoot, compiled.artifactWrites ?? []);
    run.graphHash = compiled.graphHash;
    run.graphRevision = compiled.graphRevision!;
    run.tickets = compiled.tickets!;
    const durablePreparation = run.tickets[preparation.id]!;
    durablePreparation.status = "completed";
    durablePreparation.blocker = undefined;
    for (const step of durablePreparation.steps) {
      step.status = "completed";
      step.completedAt ??= FIXED_NOW.toISOString();
    }
    review.status = "completed";
    review.endedAt = FIXED_NOW.toISOString();
    review.terminalPolicy = semanticTerminalPolicy("proof-review");
    await cp(
      path.join(preparation.worktreePath!, "tests/feature.test.mjs"),
      path.join(run.git.run.worktree, "tests/feature.test.mjs"),
    );
    const current = await program.verifyRun(run);
    expect(current).toMatchObject({
      ok: false,
      reason: expect.stringContaining("implement-change"),
    });
    expect(current.reason).not.toContain("Prepare the historical proof oracle");
    expect(
      Object.values(current.tickets ?? {}).some(
        (ticket) => ticket.operationId === "implementation.change.red-green",
      ),
    ).toBe(true);
    expect(
      current.artifactWrites?.some((write) => write.path.endsWith("ticket-definitions.json")),
    ).toBe(true);

    await writeFile(
      path.join(run.git.run.worktree, "test-support/vitest.config.ts"),
      "export default { test: { environment: 'jsdom' } };\n",
    );
    const supportDrifted = await program.verifyRun(run);
    expect(supportDrifted).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Prepare the historical proof oracle"),
    });
    await writeFile(
      path.join(run.git.run.worktree, "test-support/vitest.config.ts"),
      "export default { test: { environment: 'node' } };\n",
    );

    await writeFile(
      path.join(run.git.run.worktree, "tests/feature.test.mjs"),
      "process.exitCode = 2;\n",
    );
    const drifted = await program.verifyRun(run);
    expect(drifted).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Prepare the historical proof oracle"),
    });

    await writeFile(
      path.join(run.git.run.worktree, "tests/feature.test.mjs"),
      "process.exitCode = 1;\n",
    );
    const failedReview: AgentAttemptRecord = {
      ...structuredClone(review),
      id: "attempt-proof-review-newer-failed",
      sessionId: "session-proof-review-newer-failed",
      status: "failed" as const,
      launchSpecHash: digest("newer-failed-review-spec"),
      terminalSummary: "The newer independent review failed.",
      endedAt: new Date(FIXED_NOW.getTime() + 1_000).toISOString(),
    };
    delete failedReview.terminalPolicy;
    delete failedReview.terminalOutputSha256;
    delete failedReview.terminalOutputSizeBytes;
    delete failedReview.terminalAcceptedAt;
    run.attempts[failedReview.id] = failedReview;
    const preparationReviewStep = durablePreparation.steps.find((step) => step.kind === "review")!;
    preparationReviewStep.attemptIds.push(failedReview.id);
    const superseded = await program.verifyRun(run);
    expect(superseded).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Prepare the historical proof oracle"),
    });
    delete run.attempts[failedReview.id];
    preparationReviewStep.attemptIds = preparationReviewStep.attemptIds.filter(
      (id) => id !== failedReview.id,
    );

    const implementation = Object.values(run.tickets).find(
      (ticket) => ticket.operationId === "implementation.change.red-green",
    );
    expect(implementation).toBeDefined();
    if (implementation === undefined)
      throw new Error("fixture did not derive red-green implementation");
    const implementationAuthorAssignment = assignmentFor(run, implementation.id);
    const implementationAuthor: AgentAttemptRecord = {
      id: "attempt-implementation-author",
      sessionId: "session-implementation-author",
      ticketId: implementation.id,
      stepId: implementationAuthorAssignment.stepId,
      personaId: implementationAuthorAssignment.personaId,
      modelProvider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "high",
      status: "completed",
      launchSpecHash: digest("implementation-author-spec"),
      sessionFile: undefined,
      startedAt: FIXED_NOW.toISOString(),
      endedAt: FIXED_NOW.toISOString(),
      terminalSummary: "Confirmed the current historical baseline before product mutation.",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lineage: { branchEpoch: 0, reason: "initial" },
      authorityMessages: [],
      authorityToolResults: [],
      authorityCompactions: [],
      kind: "ticket",
      terminalPolicy: semanticTerminalPolicy("implementation-author"),
    };
    run.attempts[implementationAuthor.id] = implementationAuthor;
    const implementationAuthorStep = implementation.steps.find(
      (step) => step.id === implementationAuthorAssignment.stepId,
    )!;
    implementationAuthorStep.status = "completed";
    implementationAuthorStep.attemptIds = [implementationAuthor.id];
    implementationAuthorStep.startedAt = FIXED_NOW.toISOString();
    implementationAuthorStep.completedAt = FIXED_NOW.toISOString();
    implementationAuthorStep.summary = implementationAuthor.terminalSummary;
    const implementationStep = implementation.steps.find((step) => step.id === "implement")!;
    const implementationExecution: AgentAttemptRecord = {
      ...structuredClone(implementationAuthor),
      id: "attempt-implementation-execution",
      sessionId: "session-implementation-execution",
      stepId: implementationStep.id,
      launchSpecHash: digest("implementation-execution-spec"),
      terminalSummary: "Implemented the change and ran the exact promotion member.",
      lineage: { branchEpoch: 0, reason: "initial" },
      terminalPolicy: semanticTerminalPolicy("implementation-execution"),
    };
    run.attempts[implementationExecution.id] = implementationExecution;
    implementationStep.status = "completed";
    implementationStep.attemptIds = [implementationExecution.id];
    implementationStep.startedAt = FIXED_NOW.toISOString();
    implementationStep.completedAt = FIXED_NOW.toISOString();
    implementationStep.summary = implementationExecution.terminalSummary;
    const promotionStdout = Buffer.from("all focused promotion assertions passed\n", "utf8");
    const promotionStderr = Buffer.alloc(0);
    const promotionDirectory = `runs/${run.id}/attempts/${implementationExecution.id}/checks/promotion`;
    await mkdir(path.join(endpoint.stateRoot, promotionDirectory), { recursive: true });
    await writeFile(
      path.join(endpoint.stateRoot, promotionDirectory, "stdout.bin"),
      promotionStdout,
    );
    await writeFile(
      path.join(endpoint.stateRoot, promotionDirectory, "stderr.bin"),
      promotionStderr,
    );
    run.checks.push({
      id: "check-proof-promotion",
      attemptId: implementationExecution.id,
      callId: "call-proof-promotion",
      requestedCheckId: "promotion-proof-set",
      definitionHash: digest("promotion-proof-set-definition"),
      kind: "composite",
      accepted: true,
      passed: true,
      summary: "promotion-proof-set passed",
      commands: [
        {
          checkId: "proof-promotion",
          definitionHash: digest("proof-promotion-check"),
          startedAt: FIXED_NOW.toISOString(),
          completedAt: FIXED_NOW.toISOString(),
          resolvedExecutable: "/usr/bin/node",
          argv: ["/usr/bin/node", "tests/feature.test.mjs"],
          environmentSha256: digest("promotion-environment"),
          exitCode: 0,
          signal: null,
          stdoutSha256: rawSha256(promotionStdout),
          stdoutSizeBytes: promotionStdout.byteLength,
          stdoutArtifactPath: `${promotionDirectory}/stdout.bin`,
          stderrSha256: rawSha256(promotionStderr),
          stderrSizeBytes: promotionStderr.byteLength,
          stderrArtifactPath: `${promotionDirectory}/stderr.bin`,
          preManifestSha256: digest("promotion-workspace-manifest"),
          postManifestSha256: digest("promotion-workspace-manifest"),
          sandboxKind: "fixture",
          sandboxProfileSha256: digest("promotion-sandbox"),
          resultSource: {
            kind: "stdout",
            bytesSha256: rawSha256(promotionStdout),
            sizeBytes: promotionStdout.byteLength,
          },
          outputFiles: [],
        },
      ],
      evidenceSha256: digest("proof-promotion-evidence"),
      evidenceSizeBytes: 1,
      evidenceArtifactPath: `${promotionDirectory}/evidence.json`,
      recordedAt: FIXED_NOW.toISOString(),
    });
    const implementationReviewStep = implementation.steps.find((step) => step.kind === "review")!;
    const implementationReviewPrepared = await program.prepareAttempt({
      kind: "verification",
      run,
      assignment: {
        runId: run.id,
        ticketId: implementation.id,
        stepId: implementationReviewStep.id,
        personaId: implementationReviewStep.personaId,
        priority: implementation.priority,
      },
      attemptId: "attempt-implementation-review",
      sessionId: "session-implementation-review",
      nextAuthorityRevision: 8,
      expectedAuthorityStateHash: digest("proof-authority-eight"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: implementationExecution.id,
        parentSessionId: implementationExecution.sessionId,
      },
    });
    const implementationReviewContext = JSON.parse(
      implementationReviewPrepared.contextContent!,
    ) as {
      historicalPreparation?: {
        protocol?: string;
        entries?: Array<{
          subjectNodeId?: string;
          baseline?: { check?: { sourceEvidenceSha256?: string; commands?: unknown[] } };
          sourceContinuity?: { current?: boolean; currentVia?: string };
        }>;
      };
    };
    expect(implementationReviewPrepared.spec.persona.initialPrompt).toContain(
      "immutable cross-ticket preparation authority",
    );
    expect(implementationReviewPrepared.spec.persona.initialPrompt).toContain(
      "conversational lineage does not",
    );
    expect(implementationReviewContext.historicalPreparation).toMatchObject({
      protocol: "koni.review-historical-preparation.v1",
      entries: [
        {
          subjectNodeId: expect.any(String),
          baseline: {
            check: {
              sourceEvidenceSha256: expect.stringMatching(/^sha256:/),
              commands: [expect.objectContaining({ exitCode: 1 })],
            },
          },
          sourceContinuity: {
            current: true,
            currentVia: "preparation_review",
          },
        },
      ],
    });
    expect(implementationReviewPrepared.contextContent).toContain(
      "expected legacy assertion failure",
    );
    expect(implementationReviewPrepared.contextContent).toContain(
      "all focused promotion assertions passed",
    );

    await persistWrites(project.projectRoot, implementationReviewPrepared.artifactWrites ?? []);
    const implementationReview = attemptRecord(
      implementationReviewPrepared.spec,
      "verification",
      "terminal_accepted",
    );
    implementationReview.reviewedGraphHash = run.graphHash!;
    implementationReview.terminalAcceptedAt = FIXED_NOW.toISOString();
    const implementationReviewOutput = Buffer.from(
      `${JSON.stringify({
        status: "completed",
        summary: "The implementation and exact focused proof are independently accepted.",
      })}\n`,
      "utf8",
    );
    implementationReview.terminalOutputSha256 = rawSha256(implementationReviewOutput);
    implementationReview.terminalOutputSizeBytes = implementationReviewOutput.byteLength;
    run.attempts[implementationReview.id] = implementationReview;
    implementationReviewStep.status = "running";
    implementationReviewStep.attemptIds = [implementationReview.id];
    implementationReviewStep.startedAt = FIXED_NOW.toISOString();
    const implementationReviewDirectory = path.join(
      endpoint.stateRoot,
      `runs/${run.id}/attempts/${implementationReview.id}`,
    );
    await mkdir(implementationReviewDirectory, { recursive: true });
    await writeFile(
      path.join(implementationReviewDirectory, "launch-spec.json"),
      `${JSON.stringify(implementationReviewPrepared.spec)}\n`,
    );
    await writeFile(
      path.join(implementationReviewDirectory, "terminal-output.json"),
      implementationReviewOutput,
    );
    const implementationCompiled = await program.compileAssignmentOutput({
      run,
      assignment: {
        runId: run.id,
        ticketId: implementation.id,
        stepId: implementationReviewStep.id,
        personaId: implementationReviewStep.personaId,
        priority: implementation.priority,
      },
      attemptId: implementationReview.id,
      output: JSON.parse(implementationReviewOutput.toString("utf8")),
    });
    await persistWrites(project.projectRoot, implementationCompiled.artifactWrites ?? []);
    run.graphHash = implementationCompiled.graphHash;
    run.graphRevision = implementationCompiled.graphRevision!;
    run.tickets = implementationCompiled.tickets!;
    implementationReview.status = "completed";
    implementationReview.endedAt = FIXED_NOW.toISOString();
    implementationReview.terminalPolicy = semanticTerminalPolicy("implementation-review");
    const durableImplementation = run.tickets[implementation.id]!;
    durableImplementation.status = "completed";
    for (const step of durableImplementation.steps) {
      step.status = "completed";
      step.completedAt ??= FIXED_NOW.toISOString();
    }

    const establish = Object.values(run.tickets).find(
      (ticket) => ticket.operationId === "assurance.proof.establish",
    );
    expect(establish).toBeDefined();
    if (establish === undefined)
      throw new Error("fixture did not retain pre-effect proof establishment");
    const establishExecutionAssignment = assignmentFor(run, establish.id);
    const establishExecution: AgentAttemptRecord = {
      ...structuredClone(implementationExecution),
      id: "attempt-establish-execution",
      sessionId: "session-establish-execution",
      ticketId: establish.id,
      stepId: establishExecutionAssignment.stepId,
      personaId: establishExecutionAssignment.personaId,
      launchSpecHash: digest("establish-execution-spec"),
      terminalSummary: "Replayed the current exact promotion member.",
      lineage: { branchEpoch: 0, reason: "initial" },
      terminalPolicy: semanticTerminalPolicy("establish-execution"),
    };
    run.attempts[establishExecution.id] = establishExecution;
    const establishExecutionStep = establish.steps.find(
      (step) => step.id === establishExecutionAssignment.stepId,
    )!;
    establishExecutionStep.status = "completed";
    establishExecutionStep.attemptIds = [establishExecution.id];
    establishExecutionStep.startedAt = FIXED_NOW.toISOString();
    establishExecutionStep.completedAt = FIXED_NOW.toISOString();
    establishExecutionStep.summary = establishExecution.terminalSummary;
    const establishStdout = Buffer.from("all focused promotion assertions still pass\n", "utf8");
    const establishStderr = Buffer.alloc(0);
    const establishCheckDirectory = `runs/${run.id}/attempts/${establishExecution.id}/checks/promotion`;
    await mkdir(path.join(endpoint.stateRoot, establishCheckDirectory), { recursive: true });
    await writeFile(
      path.join(endpoint.stateRoot, establishCheckDirectory, "stdout.bin"),
      establishStdout,
    );
    await writeFile(
      path.join(endpoint.stateRoot, establishCheckDirectory, "stderr.bin"),
      establishStderr,
    );
    run.checks.push({
      ...structuredClone(run.checks.find((check) => check.id === "check-proof-promotion")!),
      id: "check-establish-promotion",
      attemptId: establishExecution.id,
      callId: "call-establish-promotion",
      commands: [
        {
          ...structuredClone(
            run.checks.find((check) => check.id === "check-proof-promotion")!.commands[0]!,
          ),
          stdoutSha256: rawSha256(establishStdout),
          stdoutSizeBytes: establishStdout.byteLength,
          stdoutArtifactPath: `${establishCheckDirectory}/stdout.bin`,
          stderrSha256: rawSha256(establishStderr),
          stderrSizeBytes: establishStderr.byteLength,
          stderrArtifactPath: `${establishCheckDirectory}/stderr.bin`,
          resultSource: {
            kind: "stdout",
            bytesSha256: rawSha256(establishStdout),
            sizeBytes: establishStdout.byteLength,
          },
        },
      ],
    });
    const establishReviewStep = establish.steps.find((step) => step.kind === "review")!;
    const establishReviewPrepared = await program.prepareAttempt({
      kind: "verification",
      run,
      assignment: {
        runId: run.id,
        ticketId: establish.id,
        stepId: establishReviewStep.id,
        personaId: establishReviewStep.personaId,
        priority: establish.priority,
      },
      attemptId: "attempt-establish-review",
      sessionId: "session-establish-review",
      nextAuthorityRevision: 9,
      expectedAuthorityStateHash: digest("proof-authority-nine"),
      lineage: {
        branchEpoch: 1,
        reason: "review",
        parentAttemptId: establishExecution.id,
        parentSessionId: establishExecution.sessionId,
      },
    });
    const establishReviewContext = JSON.parse(establishReviewPrepared.contextContent!) as {
      historicalPreparation?: {
        entries?: Array<{ sourceContinuity?: { current?: boolean; currentVia?: string } }>;
      };
    };
    expect(establishReviewContext.historicalPreparation?.entries).toEqual([
      expect.objectContaining({
        sourceContinuity: expect.objectContaining({
          current: true,
          currentVia: "review_effect_successor",
        }),
      }),
    ]);
    expect(establishReviewPrepared.contextContent).toContain("expected legacy assertion failure");
    expect(establishReviewPrepared.contextContent).toContain(
      "all focused promotion assertions still pass",
    );
  }, 30_000);

  it("uses the same native compiler program for the research profile", async () => {
    const project = await installedProject("research-profile");
    const nodesPath = path.join(project.projectRoot, ".koni", "graph", "nodes.yaml");
    await writeFile(
      nodesPath,
      (await readFile(nodesPath, "utf8")).replace(
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
          "      description: Exact provider-free verifier argv for this executable fixture.",
          "    scientific_inputs:",
          "      type: json",
          "      description: Exact project-file prerequisites bound into the verifier argv.",
        ].join("\n"),
      ),
    );
    const rulesPath = path.join(project.projectRoot, ".koni", "rules", "research.yaml");
    await writeFile(
      rulesPath,
      (await readFile(rulesPath, "utf8")).replace(
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
      ),
    );
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
    await writeFile(
      workflowsPath,
      workflows.replace(
        drillClaimStep,
        `${drillClaimStep}\n    checks:\n    - scoped-probe-set\n    - exact-prerequisite-set`,
      ),
    );
    const checksPath = path.join(project.projectRoot, ".koni", "checks", "research.yaml");
    await writeFile(
      checksPath,
      (await readFile(checksPath, "utf8")).replace(
        "  receipt_type: compiler.scoped-probe\n  effect: read_only",
        "  receipt_type: compiler.scoped-probe\n  composed_replay: never\n  effect: read_only",
      ),
    );
    await writeFile(
      checksPath,
      `${await readFile(checksPath, "utf8")}\n` +
        [
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
        ].join("\n"),
    );
    await writeFile(
      checksPath,
      `${await readFile(checksPath, "utf8")}` +
        [
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
        ].join("\n"),
    );
    await mkdir(path.join(project.projectRoot, "fixtures"), { recursive: true });
    await writeFile(path.join(project.projectRoot, "fixtures", "research-input.json"), "{}\n");
    const program = await compilerProgram(project);
    const compiledConfiguration = await compileProjectDirectory(
      project.projectRoot,
      project.baseline,
    );
    if (!compiledConfiguration.ok)
      throw new Error("research fixture configuration did not compile");
    const gatePolicies = projectGatePolicyDefinitions(compiledConfiguration.value);
    if (!gatePolicies.ok) throw new Error("research fixture gate policy did not compile");
    const gatePolicy = gatePolicies.value.find(
      (candidate) => candidate.id === "research-capability-gates",
    )!;
    const gateContextMaterial = {
      protocol: "koni.gate-policy-context.v1" as const,
      policy_id: gatePolicy.id,
      policy_contract_sha256: gatePolicy.contractSha256,
      gate_node_id: "gate-fixture",
      winner_node_id: "asset-fixture",
      evaluation_target_node_ids: ["hypothesis-fixture"],
      ancestor_node_ids: [],
      direct_gate_node_ids: ["gate-fixture"],
      inherited_gate_node_ids: [],
      applicable_gate_node_ids: ["gate-fixture"],
      context_node_ids: ["gate-fixture", "asset-fixture", "hypothesis-fixture"],
      read_paths: ["fixtures/research-input.json"],
    };
    const gateContext = {
      ...gateContextMaterial,
      context_sha256: canonicalHash(gateContextMaterial),
    };
    expect(
      resolvePinnedGateAutoEvaluationContexts({
        configuration: compiledConfiguration.value,
        descriptorBoundary: "scoped",
        subjectNodeIds: ["hypothesis-fixture"],
        contexts: [gateContext],
      }),
    ).toEqual([
      expect.objectContaining({
        policyId: gatePolicy.id,
        checkId: "gate-verifier",
        boundary: "scoped",
        gateNodeId: "gate-fixture",
        contextSha256: gateContext.context_sha256,
        readPaths: ["fixtures/research-input.json"],
        sha256: expect.stringMatching(/^sha256:/u),
      }),
    ]);
    expect(
      resolvePinnedGateAutoEvaluationContexts({
        configuration: compiledConfiguration.value,
        descriptorBoundary: "scoped",
        subjectNodeIds: ["unrelated-node"],
        contexts: [gateContext],
      }),
    ).toEqual([]);
    // Gate auto-evaluation is an obligation of the operations its check applies to: a ticket
    // that merely links the gate node (e.g. experiment design) compiles without it, while an
    // applicable operation still binds it.
    expect(
      resolvePinnedGateAutoEvaluationContexts({
        configuration: compiledConfiguration.value,
        descriptorBoundary: "scoped",
        operation: "design-experiment",
        subjectNodeIds: ["hypothesis-fixture"],
        contexts: [gateContext],
      }),
    ).toEqual([]);
    expect(
      resolvePinnedGateAutoEvaluationContexts({
        configuration: compiledConfiguration.value,
        descriptorBoundary: "scoped",
        operation: "implement-asset",
        subjectNodeIds: ["hypothesis-fixture"],
        contexts: [gateContext],
      }),
    ).toHaveLength(1);
    expect(() =>
      resolvePinnedGateAutoEvaluationContexts({
        configuration: compiledConfiguration.value,
        descriptorBoundary: "scoped",
        subjectNodeIds: ["hypothesis-fixture"],
        contexts: [{ ...gateContext, read_paths: ["ambient-secret"] }],
      }),
    ).toThrow(expect.objectContaining({ code: "gate_policy_context_hash" }));
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
    expect(resolved.executionConfig.disjointScopeParallelism).toBe(true);
    expect(resolved.executionConfig.agents["run-planner"]).toMatchObject({
      model: "gpt-5.6-sol",
      thinkingLevel: "xhigh",
    });
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(
      project.projectRoot,
      runId,
      "Test whether retrieval improves bounded factual recall",
      resolved,
    );
    const planning = await program.compilePlanningOutput({
      run,
      attemptId: "attempt-research-plan",
      output: planningOutput({
        objective: "Measure a bounded factual-recall delta",
        fixture_command: ["node", "scripts/verify-research.mjs", "fixtures/research-input.json"],
        scientific_inputs: [
          { asset_id: "fixture-input", role: "dataset", path: "fixtures/research-input.json" },
        ],
      }),
    });
    run.plan = { ...planning.plan, status: "approved" };
    run.graphHash = planning.graphHash;
    materializeApprovedFixtureRun(run);
    const approved = await program.initializeApprovedPlan(run);
    expect(Object.values(approved.tickets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: "formulation.hypothesis.drill-hypothesis" }),
      ]),
    );
    await persistWrites(project.projectRoot, approved.artifactWrites ?? []);
    run.graphHash = approved.graphHash;
    run.graphRevision = approved.graphRevision;
    run.tickets = approved.tickets;
    const ticket = Object.values(run.tickets).find(
      (candidate) => candidate.operationId === "formulation.hypothesis.drill-hypothesis",
    )!;
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
    expect(
      prepared.spec.tools.find((tool) => tool.name === "koni_run_check")?.maxResultBytes,
    ).toBeGreaterThanOrEqual(1024 * 1024);
    await persistWrites(project.projectRoot, prepared.artifactWrites ?? []);
    const attempt = attemptRecord(prepared.spec, "ticket", "running");
    run.attempts[attempt.id] = attempt;
    const prerequisitePath = path.join(ticket.worktreePath!, "fixtures", "research-input.json");
    await unlink(prerequisitePath);
    await expect(
      program.resolveAgentCheck({
        run,
        attempt,
        checkId: "exact-prerequisite-set",
      }),
    ).rejects.toMatchObject({ code: "check_input_binding" });
    await writeFile(prerequisitePath, "{}\n");
    const exactCheck = await program.resolveAgentCheck({
      run,
      attempt,
      checkId: "exact-prerequisite-set",
    });
    expect(exactCheck).toMatchObject({
      kind: "command",
      executionPolicy: {
        checkId: "exact-prerequisite-set",
        effect: "read_only",
        receiptFreshness: "current",
        composedReplay: "required",
      },
      commands: [
        expect.objectContaining({
          argv: ["node", "scripts/verify-research.mjs", "fixtures/research-input.json"],
          inputPaths: ["fixtures/research-input.json"],
          resultProtocol: "koni.fixture-result.v1",
          executionPolicy: expect.objectContaining({
            checkId: "exact-prerequisite-set",
            effect: "read_only",
          }),
        }),
      ],
    });
    const exactCommand = exactCheck.commands[0]!;
    if (exactCheck.executionPolicy === undefined || exactCommand.executionPolicy === undefined) {
      throw new Error("compiler omitted exact prerequisite execution policy");
    }
    const exactCheckPolicy = exactCheck.executionPolicy;
    const exactCommandPolicy = exactCommand.executionPolicy;
    expect(exactCheck.definitionHash).toBe(exactCheckPolicy.checkSha256);
    expect(exactCommand.definitionHash).toBe(exactCommandPolicy.checkSha256);
    expect(
      decideBoundCheckRetry(exactCommandPolicy, {
        attemptNumber: 1,
        exitCode: 1,
        aggregateElapsedSeconds: 1,
      }),
    ).toMatchObject({
      checkId: "exact-prerequisite-set",
      disposition: "terminal_failure",
      backoffSeconds: 0,
    });
    const exactResult = { protocol: "koni.fixture-result.v1", status: "passed" };
    const exactStdout = `${JSON.stringify(exactResult)}\n`;
    const exactManifest = digest("exact-prerequisite-manifest");
    const exactExecution = {
      checkId: exactCommand.checkId,
      definitionHash: exactCommand.definitionHash,
      attemptNumber: 1,
      retryAuditSha256: digest("exact-check-retry-audit"),
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
    const { retryAuditSha256: _retryAuditSha256, ...missingRetryAuditExecution } = exactExecution;
    await expect(
      program.compileAgentCheckResult({
        run,
        attempt,
        check: exactCheck,
        executions: [missingRetryAuditExecution],
      }),
    ).rejects.toMatchObject({ code: "check_execution_retry" });
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
      evidence: {
        commands: [
          expect.objectContaining({
            attemptNumber: 1,
            retryAuditSha256: exactExecution.retryAuditSha256,
          }),
        ],
      },
      ruleAuthorityEvidence: { protocol: "koni.rule-authority-evidence.v1" },
    });
    const check = await program.resolveAgentCheck({
      run,
      attempt,
      checkId: "scoped-probe-set",
    });
    expect(check).toMatchObject({
      kind: "composite",
      executionPolicy: {
        checkId: "scoped-probe-set",
        effect: "read_only",
      },
      commands: [
        expect.objectContaining({
          checkId: "scoped-operational-probe",
          effect: "read_only",
          expectedExitCodes: [0],
          resultProtocol: "process-exit.v1",
          executionPolicy: expect.objectContaining({
            checkId: "scoped-operational-probe",
            composedReplay: "never",
          }),
        }),
      ],
    });
    const command = check.commands[0]!;
    if (check.executionPolicy === undefined || command.executionPolicy === undefined) {
      throw new Error("compiler omitted scoped probe execution policy");
    }
    const scopedCheckPolicy = check.executionPolicy;
    const scopedCommandPolicy = command.executionPolicy;
    expect(check.definitionHash).toBe(scopedCheckPolicy.checkSha256);
    expect(command.definitionHash).toBe(scopedCommandPolicy.checkSha256);
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
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: completedOutput,
      }),
    ).rejects.toMatchObject({ code: "assignment_checks_incomplete" });
    const recordedChecks: NonNullable<RunRecord["checks"]> = [
      {
        id: "check-current-scoped-probe",
        attemptId: attempt.id,
        callId: "call-current-scoped-probe",
        requestedCheckId: check.requestedCheckId,
        definitionHash: check.definitionHash,
        kind: check.kind,
        executionPolicy: scopedCheckPolicy,
        accepted: compiledCheck.accepted,
        passed: compiledCheck.passed,
        summary: compiledCheck.summary,
        commands: [
          {
            checkId: execution.checkId,
            definitionHash: execution.definitionHash,
            executionPolicy: scopedCommandPolicy,
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
          },
        ],
        evidenceSha256: canonicalHash(compiledCheck.evidence),
        evidenceSizeBytes: Buffer.byteLength(JSON.stringify(compiledCheck.evidence), "utf8"),
        evidenceArtifactPath: "runs/run-native-research/checks/current/evidence.json",
        recordedAt: "2026-07-16T19:00:00.000Z",
      },
    ];
    recordedChecks.push({
      id: "check-current-exact-prerequisite",
      attemptId: attempt.id,
      callId: "call-current-exact-prerequisite",
      requestedCheckId: exactCheck.requestedCheckId,
      definitionHash: exactCheck.definitionHash,
      kind: exactCheck.kind,
      executionPolicy: exactCheckPolicy,
      accepted: compiledExactCheck.accepted,
      passed: compiledExactCheck.passed,
      summary: compiledExactCheck.summary,
      commands: [
        {
          checkId: exactExecution.checkId,
          definitionHash: exactExecution.definitionHash,
          executionPolicy: exactCommandPolicy,
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
        },
      ],
      evidenceSha256: canonicalHash(compiledExactCheck.evidence),
      evidenceSizeBytes: Buffer.byteLength(JSON.stringify(compiledExactCheck.evidence), "utf8"),
      evidenceArtifactPath: "runs/run-native-research/checks/exact/evidence.json",
      recordedAt: "2026-07-16T19:00:00.000Z",
    });
    recordedChecks.unshift({
      ...structuredClone(recordedChecks[0]!),
      id: "check-older-scoped-probe",
      callId: "call-older-scoped-probe",
      recordedAt: "2026-07-16T18:00:00.000Z",
    });
    run.checks = recordedChecks;
    const terminalPolicy = await program.projectAssignmentTerminalPolicy({
      run,
      assignment,
      attemptId: attempt.id,
    });
    expect(terminalPolicy).toMatchObject({
      protocol: "koni.assignment-terminal-policy.v1",
      configurationSha256: run.compiledConfigHash,
      executionPolicyBinding: { stepId: assignment.stepId },
      validationCheckIds: ["exact-prerequisite-set", "scoped-probe-set"],
      composedReplayCheckIds: ["exact-prerequisite-set"],
      retainedReceipts: [
        expect.objectContaining({
          runCheckId: "check-current-scoped-probe",
          checkId: "scoped-operational-probe",
        }),
      ],
      sourceManifestPairs: [],
    });
    expect(terminalPolicy.retainedReceipts).toEqual([
      expect.objectContaining({
        runCheckId: "check-current-scoped-probe",
        checkId: "scoped-operational-probe",
      }),
    ]);
    expect(
      terminalPolicy.validationChecks.find((candidate) => candidate.checkId === "scoped-probe-set"),
    ).toMatchObject({
      causalCommands: [expect.objectContaining({ checkId: "scoped-operational-probe" })],
      resolvedCheck: { commands: [] },
      retainedLeafPolicies: [expect.objectContaining({ checkId: "scoped-operational-probe" })],
      replaySelection: {
        replayCheckIds: [],
        skipped: [{ checkId: "scoped-operational-probe", reason: "opted_out" }],
      },
    });
    await expect(
      program.compileAssignmentTerminalReplay({
        run,
        assignment,
        attemptId: attempt.id,
        projectionSha256: terminalPolicy.sha256,
        executions: [
          { checkId: "scoped-probe-set", executions: [] },
          { checkId: "exact-prerequisite-set", executions: [exactExecution] },
        ],
        retainedReceipts: terminalPolicy.retainedReceipts,
      }),
    ).resolves.toMatchObject({
      protocol: "koni.assignment-terminal-replay.v1",
      accepted: true,
      passed: true,
      checks: expect.arrayContaining([
        expect.objectContaining({
          checkId: "scoped-probe-set",
          replayedLeafCheckIds: [],
          retainedLeafCheckIds: ["scoped-operational-probe"],
        }),
        expect.objectContaining({
          checkId: "exact-prerequisite-set",
          replayedLeafCheckIds: ["exact-prerequisite-set"],
          retainedLeafCheckIds: [],
        }),
      ]),
    });
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: completedOutput,
      }),
    ).resolves.toMatchObject({
      outcome: { status: "completed", summary: completedOutput.summary },
    });

    const controlTarget = ticket.targetNodeIds[0]!;
    const upstreamOutput = {
      status: "completed",
      summary: "The hypothesis requires a bounded upstream semantic correction",
      upstreamChangeRequest: {
        targetNodeIds: [controlTarget],
        summary: "Correct the bounded hypothesis contract",
        reason: "The current formulation cannot represent the verified constraint",
      },
    };
    expect(Value.Check(prepared.terminalOutputSchema!, upstreamOutput)).toBe(true);
    const collidingUpstreamOutput = {
      ...upstreamOutput,
      graphDelta: {
        protocol: "koni.graph-delta.v1",
        expectedGraphHash: run.graphHash,
        upsertNodes: [],
        deleteNodes: [],
        addEdges: [],
        removeEdges: [],
      },
    };
    expect(Value.Check(prepared.terminalOutputSchema!, collidingUpstreamOutput)).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: collidingUpstreamOutput,
      }),
    ).rejects.toMatchObject({ code: "change_control_graph_collision" });
    expect(
      Value.Check(prepared.terminalOutputSchema!, {
        ...upstreamOutput,
        upstreamChangeRequest: {
          ...upstreamOutput.upstreamChangeRequest,
          ambientAuthority: true,
        },
      }),
    ).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment,
        attemptId: attempt.id,
        output: {
          ...upstreamOutput,
          upstreamChangeRequest: {
            ...upstreamOutput.upstreamChangeRequest,
            targetNodeIds: ["missing-research-node"],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "change_control_target_missing" });
    const upstream = await program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: attempt.id,
      output: upstreamOutput,
    });
    expect(upstream).toMatchObject({
      outcome: { status: "completed", summary: upstreamOutput.summary },
      changeControl: {
        protocol: "koni.assignment-change-control.v1",
        kind: "upstream_request",
        sourceTicketId: ticket.id,
        sourceStepId: assignment.stepId,
        sourceBindingSha256: ticket.steps[0]!.executionPolicyBinding!.sha256,
        targetNodeIds: [controlTarget],
        publication: {
          protocol: "koni.change-control-publication.v1",
          initialStatus: "proposed",
          disposition: "create",
        },
      },
    });
    expect(upstream).not.toHaveProperty("graphHash");
    expect(upstream).not.toHaveProperty("graphRevision");
    const upstreamControl = upstream.changeControl!;
    if (upstreamControl.kind !== "upstream_request")
      throw new Error("compiler omitted upstream request metadata");
    const sourceTerminalProof = fixtureTerminalSuccessProof({
      runId: run.id,
      ticketId: ticket.id,
      stepId: assignment.stepId,
      attemptId: attempt.id,
      actionInvocationId: "source-change-request-action",
      changeControlSha256: upstreamControl.sha256,
    });
    const proposal = await program.projectChangeControlProposalTicket({
      run,
      changeControl: upstreamControl,
      sourceTerminalProof,
    });
    expect(proposal).toMatchObject({
      id: upstreamControl.publication.proposalTicketId,
      operationId: "lifecycle.change-request",
      status: "proposed",
      targetNodeIds: [controlTarget],
      readNodeIds: [controlTarget],
      writeNodeIds: [],
      readPaths: [],
      writePaths: [],
      executionControl: {
        changeControlScopeNodeIds: [controlTarget],
        proposalRequest: {
          requestSha256: upstreamControl.publication.requestSha256,
          sourceTicketId: ticket.id,
          sourceStepId: assignment.stepId,
        },
      },
      steps: [
        expect.objectContaining({ id: "scope-change", kind: "integration" }),
        expect.objectContaining({ id: "propose-graph-delta", kind: "integration" }),
        expect.objectContaining({ id: "risk-review", kind: "review" }),
      ],
    });
    expect(proposal.steps).toHaveLength(3);
    expect(
      proposal.steps.every(
        (step) => (step.writeNodeIds ?? proposal.writeNodeIds ?? []).length === 0,
      ),
    ).toBe(true);
    expect(proposal.steps.every((step) => step.executionPolicyBinding?.stepId === step.id)).toBe(
      true,
    );
    run.tickets[proposal.id] = proposal;

    const reuseCompilation = await program.compileAssignmentOutput({
      run,
      assignment,
      attemptId: attempt.id,
      output: upstreamOutput,
    });
    if (reuseCompilation.changeControl?.kind !== "upstream_request") {
      throw new Error("compiler omitted replayed upstream request metadata");
    }
    expect(reuseCompilation.changeControl.publication.disposition).toBe("reuse");
    await expect(
      program.projectChangeControlProposalTicket({
        run,
        changeControl: reuseCompilation.changeControl,
        sourceTerminalProof,
      }),
    ).resolves.toEqual(proposal);

    proposal.status = "ready";
    const proposalApprovalMaterial = {
      protocol: "koni.proposal-decision-authority.v2" as const,
      runId: run.id,
      proposalTicketId: proposal.id,
      requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
      eventId: "proposal-approval-event",
      decision: "approval" as const,
      actor: "operator",
      message: "Approve the exact bounded research change",
      recordedAt: FIXED_NOW.toISOString(),
    };
    const proposalApproval = {
      ...proposalApprovalMaterial,
      sha256: canonicalHash(proposalApprovalMaterial),
    };
    proposal.executionControl!.proposalDecision = proposalApproval;
    proposal.executionControl!.proposalDecisionHistory = [proposalApproval];
    proposal.executionControl!.proposalApprovalSha256 = proposalApproval.sha256;
    proposal.executionControl!.proposalDisposition = {
      kind: "approved",
      authoritySha256: proposalApproval.sha256,
    };
    proposal.steps[0]!.status = "completed";
    proposal.steps[0]!.summary = "Bounded the source control scope without mutation";
    proposal.steps[0]!.completedAt = FIXED_NOW.toISOString();
    const proposalCycle = attachFixtureTicketCycle(run, proposal);
    materializeFixtureCheckout(run.git.run.worktree, proposalCycle.worktree);
    const proposalStep = proposal.steps.find((step) => step.id === "propose-graph-delta")!;
    const proposalAssignment: ReadyAssignment = {
      runId: run.id,
      ticketId: proposal.id,
      stepId: proposalStep.id,
      personaId: proposalStep.personaId,
      priority: proposal.priority,
    };
    const proposalPrepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment: proposalAssignment,
      attemptId: "attempt-change-proposal",
      sessionId: "session-change-proposal",
      nextAuthorityRevision: 14,
      expectedAuthorityStateHash: digest("authority-fourteen"),
      lineage: {
        branchEpoch: 0,
        reason: "initial",
      },
    });
    await persistWrites(project.projectRoot, proposalPrepared.artifactWrites ?? []);
    run.attempts[proposalPrepared.spec.identity.attemptId] = attemptRecord(
      proposalPrepared.spec,
      "ticket",
      "running",
    );
    const applicationOutput = {
      status: "completed",
      summary: "Selected the exact bounded semantic application",
      changeApplication: {
        operation: "apply-change-request",
        targetNodeIds: [controlTarget],
        summary: "Apply only the reviewed hypothesis contract correction",
      },
    };
    expect(Value.Check(proposalPrepared.terminalOutputSchema!, applicationOutput)).toBe(true);
    expect(
      Value.Check(proposalPrepared.terminalOutputSchema!, {
        status: "completed",
        summary: "Missing the required typed application",
      }),
    ).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment: proposalAssignment,
        attemptId: proposalPrepared.spec.identity.attemptId,
        output: {
          status: "completed",
          summary: "Missing the required typed application",
        },
      }),
    ).rejects.toMatchObject({ code: "change_control_application_required" });
    expect(
      Value.Check(proposalPrepared.terminalOutputSchema!, {
        ...applicationOutput,
        graphDelta: {
          protocol: "koni.graph-delta.v1",
          expectedGraphHash: run.graphHash,
          upsertNodes: [],
          deleteNodes: [],
          addEdges: [],
          removeEdges: [],
        },
      }),
    ).toBe(false);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment: proposalAssignment,
        attemptId: proposalPrepared.spec.identity.attemptId,
        output: {
          ...applicationOutput,
          changeApplication: {
            ...applicationOutput.changeApplication,
            operation: "change-request",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "change_control_application_route" });
    const exactProposalScope = [...proposal.executionControl!.changeControlScopeNodeIds!];
    proposal.executionControl!.changeControlScopeNodeIds = [];
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment: proposalAssignment,
        attemptId: proposalPrepared.spec.identity.attemptId,
        output: applicationOutput,
      }),
    ).rejects.toMatchObject({ code: "control_ticket_projection" });
    proposal.executionControl!.changeControlScopeNodeIds = exactProposalScope;
    const applicationSelection = await program.compileAssignmentOutput({
      run,
      assignment: proposalAssignment,
      attemptId: proposalPrepared.spec.identity.attemptId,
      output: applicationOutput,
    });
    expect(applicationSelection).toMatchObject({
      outcome: { status: "completed", summary: applicationOutput.summary },
      changeControl: {
        kind: "proposal_application",
        proposalTicketId: proposal.id,
        proposalStepId: "propose-graph-delta",
        proposalBindingSha256: proposal.executionPolicyBinding!.sha256,
        applicationPublicOperation: "apply-change-request",
        applicationOperationId: "lifecycle.apply-change-request",
        targetNodeIds: [controlTarget],
        scope: {
          readNodeIds: [controlTarget],
          writeNodeIds: [controlTarget],
          readPaths: [],
          writePaths: [],
        },
      },
    });
    if (applicationSelection.changeControl?.kind !== "proposal_application") {
      throw new Error("compiler omitted proposal application metadata");
    }
    const executionCatalog = await program.projectExecutionSemanticCatalog(run);
    const proposalTerminalProof = fixtureTerminalSuccessProof({
      runId: run.id,
      ticketId: proposal.id,
      stepId: proposalStep.id,
      attemptId: proposalPrepared.spec.identity.attemptId,
      actionInvocationId: "proposal-terminal-action",
      changeControlSha256: applicationSelection.changeControl.sha256,
    });
    const proposalReviewTerminalProof = fixtureTerminalSuccessProof({
      runId: run.id,
      ticketId: proposal.id,
      stepId: "risk-review",
      attemptId: "attempt-change-proposal-review",
      actionInvocationId: "proposal-review-terminal-action",
    });
    const applicationMaterialization = deriveApprovedChangeMaterialization(executionCatalog, {
      runId: run.id,
      proposalTicketId: proposal.id,
      proposalBinding: proposal.executionPolicyBinding!,
      requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
      approvalSha256: digest("proposal-approval"),
      proposalOutputSha256: applicationSelection.changeControl.proposalOutputSha256,
      proposalStepId: applicationSelection.changeControl.proposalStepId,
      proposalSelectionSha256: applicationSelection.changeControl.sha256,
      selectionSummary: applicationSelection.changeControl.summary,
      proposalTerminalProof,
      reviewSha256: digest("proposal-review"),
      reviewTerminalProof: proposalReviewTerminalProof,
      applicationPublicOperation: applicationSelection.changeControl.applicationPublicOperation,
      targetNodeIds: applicationSelection.changeControl.targetNodeIds,
      scope: applicationSelection.changeControl.scope,
    });
    const applicationTicket = await program.projectApprovedApplicationTicket({
      run,
      materialization: applicationMaterialization,
      selection: applicationSelection.changeControl,
    });
    expect(applicationTicket).toMatchObject({
      id:
        applicationMaterialization.kind === "application"
          ? applicationMaterialization.applicationTicketId
          : expect.any(String),
      operationId: "lifecycle.apply-change-request",
      status: "ready",
      dependencyIds: [proposal.id],
      targetNodeIds: [controlTarget],
      readNodeIds: [controlTarget],
      writeNodeIds: [controlTarget],
      readPaths: [],
      writePaths: [],
      executionControl: {
        changeControlScopeNodeIds: [controlTarget],
        sourceProposalTicketId: proposal.id,
        approvedApplicationSha256: applicationMaterialization.authoritySha256,
      },
    });
    expect(applicationTicket?.steps.map((step) => step.id)).toEqual([
      "inspect-approved-change",
      "apply-approved-delta",
      "verify",
    ]);

    const noOpOutput = {
      status: "completed",
      summary: "The reviewed desired state is already satisfied",
      changeApplication: {
        operation: "no-op",
        targetNodeIds: [controlTarget],
        summary: "Record the reviewed no-op without launching another agent",
      },
    };
    const noOpSelection = await program.compileAssignmentOutput({
      run,
      assignment: proposalAssignment,
      attemptId: proposalPrepared.spec.identity.attemptId,
      output: noOpOutput,
    });
    if (noOpSelection.changeControl?.kind !== "proposal_application") {
      throw new Error("compiler omitted no-op selection metadata");
    }
    expect(noOpSelection.changeControl.scope).toEqual({
      readNodeIds: [],
      writeNodeIds: [],
      readPaths: [],
      writePaths: [],
    });
    const noOpMaterialization = deriveApprovedChangeMaterialization(executionCatalog, {
      runId: run.id,
      proposalTicketId: proposal.id,
      proposalBinding: proposal.executionPolicyBinding!,
      requestSha256: proposal.executionControl!.proposalRequest!.requestSha256,
      approvalSha256: digest("proposal-no-op-approval"),
      proposalOutputSha256: noOpSelection.changeControl.proposalOutputSha256,
      proposalStepId: noOpSelection.changeControl.proposalStepId,
      proposalSelectionSha256: noOpSelection.changeControl.sha256,
      selectionSummary: noOpSelection.changeControl.summary,
      proposalTerminalProof: fixtureTerminalSuccessProof({
        runId: run.id,
        ticketId: proposal.id,
        stepId: proposalStep.id,
        attemptId: proposalPrepared.spec.identity.attemptId,
        actionInvocationId: "proposal-no-op-terminal-action",
        changeControlSha256: noOpSelection.changeControl.sha256,
      }),
      reviewSha256: digest("proposal-no-op-review"),
      reviewTerminalProof: proposalReviewTerminalProof,
      applicationPublicOperation: noOpSelection.changeControl.applicationPublicOperation,
      targetNodeIds: noOpSelection.changeControl.targetNodeIds,
      scope: noOpSelection.changeControl.scope,
    });
    expect(noOpMaterialization.kind).toBe("no_op");
    await expect(
      program.projectApprovedApplicationTicket({
        run,
        materialization: noOpMaterialization,
        selection: noOpSelection.changeControl,
      }),
    ).resolves.toBeUndefined();

    const sourceFailureAttemptId = "attempt-source-terminal-failure";
    const sourceTerminalPolicyMaterial = {
      protocol: "koni.agent-terminal-policy.v1" as const,
      mode: "semantic" as const,
      projectionSha256: terminalPolicy.sha256,
      replayCompilationSha256: digest("source-terminal-replay"),
      receiptEvaluationSha256: digest("source-terminal-receipts"),
      sourcePreservationSha256s: [] as Sha256Digest[],
      acceptedAt: FIXED_NOW.toISOString(),
    };
    const sourceTerminalPolicy = {
      ...sourceTerminalPolicyMaterial,
      sha256: canonicalHash(sourceTerminalPolicyMaterial),
    };
    const sourceTerminalOutputSha256 = digest("source-terminal-failure-output");
    const sourceFailureAttempt: AgentAttemptRecord = {
      ...structuredClone(attempt),
      id: sourceFailureAttemptId,
      sessionId: "session-source-terminal-failure",
      status: "failed",
      terminalPolicy: sourceTerminalPolicy,
      terminalOutputSha256: sourceTerminalOutputSha256,
      endedAt: FIXED_NOW.toISOString(),
      terminalSummary: "Exact configured source validation failed",
    };
    run.attempts[sourceFailureAttemptId] = sourceFailureAttempt;
    const sourceFailureStep = ticket.steps.find((step) => step.id === assignment.stepId)!;
    sourceFailureStep.attemptIds.push(sourceFailureAttemptId);
    const sourceFailureProof = fixtureTerminalFailureProof({
      runId: run.id,
      ticketId: ticket.id,
      stepId: sourceFailureStep.id,
      attemptId: sourceFailureAttemptId,
      actionInvocationId: "source-terminal-failure-action",
      terminalPolicySha256: sourceTerminalPolicy.sha256,
      terminalOutputSha256: sourceTerminalOutputSha256,
    });
    run.terminalFailureProofs = { [sourceFailureProof.sha256]: sourceFailureProof };
    const failureBindingSha256 = terminalFailureBindingFromProof(
      run,
      ticket,
      sourceFailureProof,
    )?.sha256;
    if (failureBindingSha256 === undefined) throw new Error("fixture source failure did not bind");
    const resolverReconciliation = deriveTerminalResolverReconciliation(executionCatalog, {
      runId: run.id,
      sourceTicketId: ticket.id,
      sourceBinding: ticket.executionPolicyBinding!,
      failureBindingSha256,
      existingResolvers: [],
    });
    if (resolverReconciliation.chainSuppressed)
      throw new Error("ordinary source unexpectedly suppressed resolver");
    const resolver = await program.projectTerminalResolverTicket({
      run,
      reconciliation: resolverReconciliation,
      sourceFailureProof,
    });
    expect(resolver).toMatchObject({
      id: resolverReconciliation.resolverTicketId,
      operationId: "lifecycle.resolve-conflict",
      status: "ready",
      dependencyIds: [],
      executionControl: {
        terminalRecovery: {
          sourceTicketId: ticket.id,
          failureBindingSha256s: [failureBindingSha256],
        },
      },
    });
    expect(resolver?.steps.map((step) => step.id)).toEqual(["diagnose", "resolve", "review"]);
    run.tickets[resolver!.id] = resolver!;
    const resolverCycle = attachFixtureTicketCycle(run, resolver!);
    materializeFixtureCheckout(run.git.run.worktree, resolverCycle.worktree);
    const resolverStep = resolver!.steps[0]!;
    const resolverAssignment: ReadyAssignment = {
      runId: run.id,
      ticketId: resolver!.id,
      stepId: resolverStep.id,
      personaId: resolverStep.personaId,
      priority: resolver!.priority,
    };
    const resolverPrepared = await program.prepareAttempt({
      kind: "ticket",
      run,
      assignment: resolverAssignment,
      attemptId: "attempt-terminal-resolver",
      sessionId: "session-terminal-resolver",
      nextAuthorityRevision: 15,
      expectedAuthorityStateHash: digest("authority-fifteen"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    await persistWrites(project.projectRoot, resolverPrepared.artifactWrites ?? []);
    run.attempts[resolverPrepared.spec.identity.attemptId] = attemptRecord(
      resolverPrepared.spec,
      "ticket",
      "running",
    );
    const resolverFailureOutput = {
      status: "failed" as const,
      blocker: "The bounded resolver requires explicit operator recovery",
    };
    expect(Value.Check(resolverPrepared.terminalOutputSchema!, resolverFailureOutput)).toBe(true);
    await expect(
      program.compileAssignmentOutput({
        run,
        assignment: resolverAssignment,
        attemptId: resolverPrepared.spec.identity.attemptId,
        output: resolverFailureOutput,
      }),
    ).resolves.toEqual({ outcome: resolverFailureOutput });
    const resolverReuse = deriveTerminalResolverReconciliation(executionCatalog, {
      runId: run.id,
      sourceTicketId: ticket.id,
      sourceBinding: ticket.executionPolicyBinding!,
      failureBindingSha256,
      existingResolvers: [
        {
          ticketId: resolver!.id,
          sourceTicketId: ticket.id,
          resolverOperationId: resolver!.operationId,
          configurationSha256: run.compiledConfigHash,
          catalogSha256: executionCatalog.sha256,
          failureBindingSha256s: [failureBindingSha256],
          terminal: false,
        },
      ],
    });
    await expect(
      program.projectTerminalResolverTicket({
        run,
        reconciliation: resolverReuse,
        sourceFailureProof,
      }),
    ).resolves.toEqual(resolver);
    const suppressed = deriveTerminalResolverReconciliation(executionCatalog, {
      runId: run.id,
      sourceTicketId: resolver!.id,
      sourceBinding: resolver!.executionPolicyBinding!,
      failureBindingSha256: digest("resolver-terminal-failure-binding"),
      existingResolvers: [],
    });
    expect(suppressed.chainSuppressed).toBe(true);
    await expect(
      program.projectTerminalResolverTicket({
        run,
        reconciliation: suppressed,
        sourceFailureProof,
      }),
    ).resolves.toBeUndefined();
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
    materializeApprovedFixtureRun(run);
    const approved = await program.initializeApprovedPlan(run);
    expect(Object.values(approved.tickets)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: "formulation.hypothesis.drill-hypothesis" }),
      ]),
    );
    const graphWrite = approved.artifactWrites?.find((write) =>
      write.path.endsWith("/program/graph.json"),
    );
    const directGraph = JSON.parse(Buffer.from(graphWrite!.bytes).toString("utf8")) as {
      contextual: {
        ownerPersonaId: string;
        revision: number;
        canonicalWorkingSpecId: string;
        records: Record<string, { baseline: { acceptedPlan: unknown; source: { kind: string } } }>;
      };
    };
    expect(directGraph.contextual).toMatchObject({
      ownerPersonaId: resolved.workingSpecOwnerId,
      revision: 1,
    });
    expect(
      directGraph.contextual.records[directGraph.contextual.canonicalWorkingSpecId],
    ).toMatchObject({
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

    await expect(
      uniqueProgram.resolveRun({
        runId: "run-owner-invalid",
        objective: "Reject an unknown explicit owner",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Reject an unknown explicit owner" },
        overrides: { workingSpecOwner: "missing-persona" },
      }),
    ).rejects.toMatchObject({ code: "working_spec_owner_invalid" });
    const uniqueEndpoint = await discoverAuthorityEndpoint(unique.projectRoot);
    await expect(
      readFile(path.join(uniqueEndpoint.stateRoot, "runs/run-owner-invalid/program/graph.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const zero = await installedProject("coding-profile");
    const zeroPersonas = path.join(zero.projectRoot, ".koni", "personas.yaml");
    await writeFile(
      zeroPersonas,
      (await readFile(zeroPersonas, "utf8")).replace(
        "  model_role: lead\n",
        "  model_role: ticket_worker\n",
      ),
    );
    await expect(
      (await compilerProgram(zero)).resolveRun({
        runId: "run-owner-zero",
        objective: "Reject zero leads",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Reject zero leads" },
      }),
    ).rejects.toMatchObject({
      code: "configuration_invalid",
      details: expect.arrayContaining([expect.stringContaining("configuration.role_provider")]),
    });

    const multiple = await installedProject("coding-profile");
    const multiplePersonas = path.join(multiple.projectRoot, ".koni", "personas.yaml");
    await writeFile(
      multiplePersonas,
      (await readFile(multiplePersonas, "utf8")).replace(
        "  model_role: ticket_worker\n",
        "  model_role: lead\n",
      ),
    );
    await expect(
      (await compilerProgram(multiple)).resolveRun({
        runId: "run-owner-multiple",
        objective: "Reject multiple leads",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Reject multiple leads" },
      }),
    ).rejects.toMatchObject({ code: "working_spec_owner_resolution" });
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
      contextual: {
        runRootId: string;
        revision: number;
        hash: Sha256Digest;
        records: Record<string, unknown>;
      };
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
    materializeApprovedFixtureRun(run);
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
        records: Record<
          string,
          {
            protocol: string;
            version?: number;
            digest?: Sha256Digest;
            supersedes?: string;
            baseline?: { source: { artifactPath: string; artifactSha256: Sha256Digest } };
            provenance: Record<string, unknown>;
          }
        >;
      };
    };
    expect(approvedArtifact.contextual.ownerPersonaId).toBe("architecture-mapper");
    expect(approvedArtifact.contextual.revision).toBe(2);
    const baselineId = approvedArtifact.contextual.canonicalWorkingSpecId;
    const baseline = approvedArtifact.contextual.records[baselineId]!;
    expect(baseline).toMatchObject({ protocol: "koni.working-spec.v1", version: 1 });
    expect(baseline.baseline?.source.artifactPath).toContain("planning-output.json");
    const nativeNote = Object.values(approvedArtifact.contextual.records).find(
      (record) => record.protocol === "koni.graph-note.v2",
    )!;
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

    await expect(
      program.executeAgentTool({
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
      }),
    ).rejects.toMatchObject({ code: "working_spec_owner" });

    const ownerTicket = Object.values(run.tickets).find((ticket) =>
      ticket.steps.some((step) => step.personaId === "architecture-mapper"),
    );
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
    const firstDynamic = await program.selectDynamicGraphContext({
      run,
      attempt: ownerAttempt,
      spec: ownerPrepared.spec,
    });
    const secondDynamic = await program.selectDynamicGraphContext({
      run,
      attempt: ownerAttempt,
      spec: ownerPrepared.spec,
    });
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

    const beforeTouch = await program.selectDynamicGraphContext({
      run,
      attempt: ownerAttempt,
      spec: ownerPrepared.spec,
    });
    const beforeTouchIds = beforeTouch.envelope.selection.selected.map((entry) => entry.id);
    expect(beforeTouchIds.indexOf("semantic_node:system-a-other")).toBeLessThan(
      beforeTouchIds.indexOf("semantic_node:system-z-touched"),
    );

    const receiptPath = `runs/${run.id}/attempts/${ownerAttempt.id}/tool-receipts/write-touched.json`;
    const receipt = {
      receiptId: "receipt-write-touched",
      summary: "Wrote src/touched.ts",
      value: { path: "src/touched.ts", sha256: digest("touched-bytes") },
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
    const canonicalReceipt = canonicalEncode(receipt);
    await persistWrites(project.projectRoot, [
      { path: receiptPath, bytes: receiptBytes, expectedSha256: null },
    ]);
    ownerAttempt.authorityToolResults = [
      {
        sequence: 1,
        callId: "call-write-touched",
        toolName: "koni_write_file",
        outcome: "accepted",
        argumentsSha256: rawSha256("{}"),
        argumentsSizeBytes: 2,
        receiptSha256: rawSha256(canonicalReceipt),
        receiptSizeBytes: Buffer.byteLength(canonicalReceipt, "utf8"),
        artifactPath: receiptPath,
        recordedAt: FIXED_NOW.toISOString(),
      },
    ];
    const afterTouch = await program.selectDynamicGraphContext({
      run,
      attempt: ownerAttempt,
      spec: ownerPrepared.spec,
    });
    const afterTouchIds = afterTouch.envelope.selection.selected.map((entry) => entry.id);
    expect(afterTouchIds.indexOf("semantic_node:system-z-touched")).toBeLessThan(
      afterTouchIds.indexOf("semantic_node:system-a-other"),
    );
    expect(afterTouch.envelopeHash).not.toBe(beforeTouch.envelopeHash);
    expect(program.dynamicContextCacheStats()).toMatchObject({ selections: 4, indexBuilds: 2 });

    await expect(
      program.executeAgentTool({
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
      }),
    ).rejects.toMatchObject({ code: "working_spec_scope" });

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
          guidance:
            "Implement only the compiler-selected architecture boundary and verify its existing contract.",
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
    const postUpdateDynamic = await program.selectDynamicGraphContext({
      run,
      attempt: ownerAttempt,
      spec: ownerPrepared.spec,
    });
    expect(postUpdateDynamic.envelope.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "working_spec",
          value: expect.objectContaining({
            version: 2,
            guidance: expect.stringContaining("compiler-selected"),
          }),
        }),
      ]),
    );
    expect(program.dynamicContextCacheStats()).toMatchObject({ selections: 5, indexBuilds: 3 });

    await expect(
      program.executeAgentTool({
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
      }),
    ).rejects.toMatchObject({ code: "working_spec_cas" });
    expect(JSON.parse(await readFile(graphPath, "utf8"))).toEqual(updated);
  });
});

type MutableConfigurationFixture = Record<string, unknown>;

function legacySoftwareConfigurationFixture(
  configuration: CompiledConfiguration,
  runTypeId: string,
): CompiledConfiguration {
  const legacy = structuredClone(configuration) as unknown as MutableConfigurationFixture;
  delete legacy.behavior;

  const packageIdentity = requiredMutableFixtureRecord(legacy.package, "package identity");
  packageIdentity.version = "0.7.0";
  packageIdentity.profile_version = "0.7.0";

  const profile = requiredMutableFixtureRecord(legacy.profile, "profile");
  profile.git = {
    enabled: true,
    backend: "libgit2",
    integration_branch: "current",
    ticket_branch_template: "koni/{{ run.id }}/{{ ticket.id }}",
    worktree_root: ".worktrees",
    integration_strategy: "squash",
    commit_template: "{{ ticket.operation }}: {{ ticket.title }}",
    ticket_worktree_setup_check: "ticket-worktree-setup",
  };
  profile.storage = {
    backend: "git_common_dir",
    graph_dir: "program/graph",
    tickets_dir: "program/tickets",
    state_path: "program/state.yaml",
    work_dir: "program/work",
    receipts_dir: "program/receipts",
    reports_dir: "program/reports",
    semantic_hash_excludes: [
      "annotations",
      "readiness",
      "obligations",
      "tickets",
      "receipts",
      "compiler",
    ],
    filesystem_scope_excludes: ["node_modules", "target", ".next", "coverage"],
  };
  const orchestration = requiredMutableFixtureRecord(profile.orchestration, "orchestration");
  orchestration.running = true;
  orchestration.lease_stale_seconds = 1_800;
  orchestration.max_fixpoint_passes = 8;

  const runTypes = requiredMutableFixtureRecord(legacy.run_types, "run types");
  const runType = requiredMutableFixtureRecord(runTypes[runTypeId], `run type ${runTypeId}`);
  const document = requiredMutableFixtureRecord(runType.document, `run type ${runTypeId} document`);
  const planning = requiredMutableFixtureRecord(document.planning, "planning");
  planning.session_scope = "run";
  planning.graph_seed_stage =
    runTypeId === "small"
      ? "focused-plan"
      : runTypeId === "large"
        ? "verification-plan"
        : "combined-plan";
  const intake = requiredMutableFixtureRecord(document.intake, "intake");
  delete intake.objective_field;
  document.git = {
    branch_template: "koni/runs/{{ run.slug }}-{{ run.short_id }}",
    ticket_branch_template: "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}",
  };

  const registries = requiredMutableFixtureRecord(legacy.registries, "registries");
  const actions = requiredMutableFixtureRecord(registries.actions, "actions");
  const spawnLead = requiredMutableFixtureRecord(actions["spawn-lead"], "spawn-lead");
  if (!Array.isArray(spawnLead.recipe)) throw new Error("spawn-lead recipe is missing");
  const leadStep = spawnLead.recipe.find((candidate) => {
    const record =
      candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as MutableConfigurationFixture)
        : undefined;
    return record?.id === "lead";
  });
  requiredMutableFixtureRecord(leadStep, "Lead recipe step").prompt =
    "Operate the configured software Lead pull loop until compiler-verifiable terminal state.";

  delete legacy.configuration_sha256;
  legacy.configuration_sha256 = canonicalHash(legacy);
  return legacy as unknown as CompiledConfiguration;
}

function requiredMutableFixtureRecord(value: unknown, label: string): MutableConfigurationFixture {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as MutableConfigurationFixture;
}

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
  const sourcePackageRoot = path.resolve(repositoryRoot, "packages", packageDirectory);
  const packageRoot = path.join(root, "profile-package");
  await cp(sourcePackageRoot, packageRoot, { recursive: true });
  await refreshFixtureProfileManifest(packageRoot);
  const baseline = await loadProfilePackage(packageRoot);
  await installProfile(projectRoot, packageRoot);
  return { root, projectRoot, baseline };
}

async function refreshFixtureProfileManifest(packageRoot: string): Promise<void> {
  const manifestPath = path.join(packageRoot, "koni", "profile-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ProfilePackageManifest;
  const baselineRoot = path.join(packageRoot, "koni", "baseline");
  const files: ProfileBaselineFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
    )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`fixture profile contains a non-regular entry: ${absolute}`);
      const relative = path.relative(baselineRoot, absolute).split(path.sep).join("/");
      const bytes = await readFile(absolute);
      files.push({
        path: relative,
        sha256: rawSha256(bytes),
        size_bytes: bytes.byteLength,
        kind: relative.startsWith("agents/")
          ? "agent"
          : relative.startsWith("resources/skills/")
            ? "skill"
            : /\.ya?ml$/u.test(relative)
              ? "config"
              : "other",
      });
    }
  };
  await visit(baselineRoot);
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  manifest.baseline.files = files;
  manifest.bundle_sha256 = computeProfileBundleSha256(files, manifest.migrations ?? []);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function compilerProgram(project: {
  projectRoot: string;
  baseline: VerifiedProfileBaseline;
}): Promise<NativeRunCompilerProgram> {
  return NativeRunCompilerProgram.create({
    projectRoot: project.projectRoot,
    packageBaseline: project.baseline,
    sealedModelBindingLoader: fixtureSealedModelBinding,
    now: () => new Date(FIXED_NOW),
  });
}

async function fixtureSealedModelBinding(provider: string, modelId: string) {
  return {
    provider,
    id: modelId,
    api: "openai-codex-responses",
    catalogContextWindow: 372_000,
    catalogMaxTokens: 128_000,
    catalogSha256: canonicalHash({ provider, modelId, fixture: "offline-model-catalog" }),
  } as const;
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
    behavior: resolved.behavior,
    objective,
    intake: { goal: objective },
    executionConfig: resolved.executionConfig,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    lifecycle,
    ...(resolved.lifecycleCatalog === undefined
      ? {}
      : { lifecycleCatalog: resolved.lifecycleCatalog }),
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
    options: [
      {
        id: "local",
        label: "Use local-first storage",
        description: "Keep the first slice within the repository and browser.",
      },
    ],
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

function fixtureTerminalSuccessProof(
  input: Readonly<{
    runId: string;
    ticketId: string;
    stepId: string;
    attemptId: string;
    actionInvocationId: string;
    changeControlSha256?: Sha256Digest;
  }>,
): TerminalSuccessSettlementProof {
  const semanticResult = {
    kind: "assignment" as const,
    status: "completed" as const,
    summary: "Completed exact compiler-authorized work",
    ...(input.changeControlSha256 === undefined
      ? {}
      : { changeControlSha256: input.changeControlSha256 }),
  };
  const material = {
    protocol: "koni.terminal-success-settlement.v1" as const,
    runId: input.runId,
    ticketId: input.ticketId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    actionInvocationId: input.actionInvocationId,
    actionPlanSha256: digest(`${input.actionInvocationId}-plan`),
    actionSettlementSha256: digest(`${input.actionInvocationId}-settlement`),
    semanticResult,
    semanticResultSha256: canonicalHash(semanticResult),
    terminalPolicySha256: digest(`${input.attemptId}-terminal-policy`),
    terminalOutputSha256: digest(`${input.attemptId}-terminal-output`),
  };
  return { ...material, sha256: canonicalHash(material) };
}

function fixtureTerminalFailureProof(
  input: Readonly<{
    runId: string;
    ticketId: string;
    stepId: string;
    attemptId: string;
    actionInvocationId: string;
    terminalPolicySha256: Sha256Digest;
    terminalOutputSha256: Sha256Digest;
  }>,
): TerminalFailureSettlementProof {
  const semanticResult = {
    kind: "assignment" as const,
    status: "failed" as const,
    blocker: "Exact configured source validation failed",
  };
  const material = {
    protocol: "koni.terminal-failure-settlement.v1" as const,
    runId: input.runId,
    ticketId: input.ticketId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    actionInvocationId: input.actionInvocationId,
    actionPlanSha256: digest(`${input.actionInvocationId}-plan`),
    actionSettlementSha256: digest(`${input.actionInvocationId}-settlement`),
    semanticResult,
    semanticResultSha256: canonicalHash(semanticResult),
    terminalPolicySha256: input.terminalPolicySha256,
    terminalOutputSha256: input.terminalOutputSha256,
  };
  return { ...material, sha256: canonicalHash(material) };
}

function assignmentFor(run: RunRecord, ticketId: string): ReadyAssignment {
  const ticket = run.tickets[ticketId]!;
  const cycle = attachFixtureTicketCycle(run, ticket);
  materializeFixtureCheckout(run.git.run.worktree, cycle.worktree);
  const step = ticket.steps[0]!;
  return {
    runId: run.id,
    ticketId,
    stepId: step.id,
    personaId: step.personaId,
    priority: ticket.priority,
  };
}

function materializeApprovedFixtureRun(run: RunRecord): void {
  materializeFixtureCheckout(run.projectRoot, run.git.run.worktree);
  run.git.planning.status = "retired";
  run.git.planning.retiredAt ??= FIXED_NOW.toISOString();
  run.git.run.status = "ready";
  run.git.run.headOid = run.git.target.selectedOid;
  run.git.run.materializedAt ??= FIXED_NOW.toISOString();
}

function materializeFixtureCheckout(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    cpSync(path.join(source, entry.name), path.join(destination, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

function planningOutput(rootSpec: Record<string, unknown>): unknown {
  return {
    full: fullPlans(),
    concise: {
      architecture: [
        {
          title: "Notes ownership seam",
          description: "Ground the work in the smallest repository-native boundary.",
        },
      ],
      decisions: [
        {
          title: "Preserve compatibility",
          description: "Reuse the established contracts unless evidence requires a change.",
        },
      ],
      risk: [
        {
          title: "Bound the blast radius",
          description: "Keep mutation and recovery within the selected run scope.",
        },
      ],
      verification: [
        {
          title: "Prove the observable outcome",
          description: "Use the cheapest trustworthy repository-native verification seam.",
        },
      ],
    },
    graphSeed: { rootSpec, nodes: [], edges: [] },
  };
}

function proofPreparationPlanningOutput(): unknown {
  return {
    ...(planningOutput({ work_kind: "new_feature" }) as Record<string, unknown>),
    graphSeed: {
      rootSpec: {
        work_kind: "new_feature",
        motivation: "Preserve an existing field while extending its behavior.",
        scope_boundaries: ["Only the fixture feature seam is in scope."],
        success_signals: ["The focused source proof turns from red to green."],
      },
      nodes: [
        {
          key: "fixture-system",
          type: "system",
          title: "Fixture system",
          spec: {
            kind: "app",
            responsibility: "Own the focused compatibility feature.",
            contract_required: true,
            contract_reason: "The existing field identity must remain stable.",
            owned_paths: ["src"],
            owned_packages: [],
          },
        },
        {
          key: "fixture-contract",
          type: "contract",
          title: "Backward-compatible field contract",
          spec: {
            invariant:
              "The legacy field identity remains available while the new behavior is added.",
            enforcement_point: "The exported fixture feature.",
            observability: "A focused source test exercises the production export.",
            failure_meaning: "Existing data would become unavailable.",
          },
        },
        {
          key: "fixture-change",
          type: "change",
          title: "Add the compatible field behavior",
          spec: {
            current_state: "Only the legacy behavior exists.",
            target_state: "The legacy identity and new behavior coexist.",
            owned_paths: ["src/feature.ts"],
            blast_radius: "One focused source module.",
            risk_factors: ["The legacy identity could be replaced."],
            proof_strategy: "red_green",
            risk_tier: "routine",
            approval_claim: "The focused behavior preserves compatibility.",
            commit_type: "feat(fixture)",
          },
        },
        {
          key: "fixture-proof",
          type: "proof",
          title: "Verify the compatible field behavior",
          spec: {
            purpose: "focused",
            layer: "unit",
            claim: "The production export preserves the legacy identity and adds the new behavior.",
            method: "Execute the focused repository-native source test.",
            command: ["node", "tests/feature.test.mjs"],
            working_directory: ".",
            baseline_check_id: "proof-expected-red",
            source_paths: ["tests/feature.test.mjs"],
            covered_paths: ["src/feature.ts"],
            support_paths: ["test-support/vitest.config.ts"],
            oracle_cases: [
              {
                id: "compatible_field",
                condition: "The legacy field exists before implementation.",
                claim: "The same production seam exposes both compatible behaviors.",
                production_seam: "The exported fixture feature",
                seam_paths: ["src/feature.ts"],
                action: "Import and exercise the production export.",
                assertions: [
                  "The legacy identity remains unchanged.",
                  "The new behavior is optional.",
                ],
              },
            ],
            conditions: ["The legacy behavior is present."],
            expected_signal: "The proof is red before implementation and green afterward.",
            not_proven: ["Unrelated repository behavior."],
            why: "This is the smallest trustworthy production seam.",
          },
        },
      ],
      edges: [
        { source: "$root", relation: "systems", target: "fixture-system" },
        { source: "$root", relation: "contracts", target: "fixture-contract" },
        { source: "fixture-change", relation: "realizes", target: "$root" },
        { source: "fixture-change", relation: "affects", target: "fixture-system" },
        { source: "fixture-change", relation: "affects", target: "fixture-contract" },
        { source: "fixture-contract", relation: "applies_to", target: "fixture-system" },
        { source: "fixture-proof", relation: "verifies", target: "fixture-change" },
        { source: "fixture-proof", relation: "verifies", target: "fixture-contract" },
        { source: "fixture-proof", relation: "uses", target: "fixture-system" },
      ],
    },
  };
}

function semanticTerminalPolicy(seed: string): NonNullable<AgentAttemptRecord["terminalPolicy"]> {
  const material = {
    protocol: "koni.agent-terminal-policy.v1" as const,
    mode: "semantic" as const,
    projectionSha256: digest(`${seed}-projection`),
    replayCompilationSha256: digest(`${seed}-replay`),
    receiptEvaluationSha256: digest(`${seed}-receipt`),
    sourcePreservationSha256s: [],
    acceptedAt: FIXED_NOW.toISOString(),
  };
  return { ...material, sha256: canonicalHash(material) };
}

function fullPlans(): Record<string, string> {
  return {
    architecture: "## Architecture\nGround the smallest repository-native boundary.",
    decisions: "## Decisions\nPreserve compatibility and reversible choices.",
    risk: "## Risk\nBound the blast radius and keep recovery explicit.",
    verification: "## Verification\nProve the observable outcome at its production seam.",
  };
}

async function persistWrites(
  projectRoot: string,
  writes: readonly TransactionWrite[],
): Promise<void> {
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
