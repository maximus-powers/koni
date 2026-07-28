import type {
  CompiledActionCatalog,
  CompiledBehaviorIr,
  CompiledRunTypeBehavior,
} from "../../src/contracts/behavior.js";
import {
  LEAD_JUDGMENT_OUTPUT_PROTOCOL,
  LEAD_JUDGMENT_PROTOCOL,
} from "../../src/contracts/behavior.js";
import { compileActionCatalog } from "../../src/compiler/action-recipes.js";
import { compileGitBehaviorPolicy } from "../../src/git/behavior-policy.js";
import { canonicalHash } from "../../src/shared/canonical.js";
import { createRunBehaviorSnapshot, type RunBehaviorSnapshot } from "../../src/state/run-record.js";

/** Minimal typed behavior used only by compiler fixtures whose subject is another registry. */
export function minimalCompiledBehavior(profileId: string): CompiledBehaviorIr {
  const actionMaterial = {
    protocol: "koni.action-catalog.v1" as const,
    actions: Object.freeze({}),
    aliases: Object.freeze({}),
  };
  const actions: CompiledActionCatalog = Object.freeze({
    ...actionMaterial,
    sha256: canonicalHash(actionMaterial),
  });
  const profile: CompiledBehaviorIr["profile"] = Object.freeze({
    id: profileId,
    initialization: Object.freeze({
      rootNodeType: "objective",
      goalField: "spec.goal",
      planningContextField: "spec.planning_context",
      planningSeedOperation: "initialize",
      rootStatus: "active",
    }),
    orchestration: Object.freeze({
      maxParallel: 1,
      maxBoundariesPerLead: 1,
      disjointScopeParallelism: true,
    }),
  });
  const material = {
    protocol: "koni.compiled-behavior.v1" as const,
    profile,
    defaultRunTypeId: "fixture",
    runTypeOrder: Object.freeze([]),
    runTypes: Object.freeze({}),
    actions,
  };
  return Object.freeze({ ...material, sha256: canonicalHash(material) });
}

/** Exact hash-valid behavior snapshot for authority tests with a synthetic compiler program. */
export function runBehaviorSnapshotFixture(
  runTypeId: string,
  profileId = "fixture",
  overrides: Readonly<{
    autoStart?: boolean;
    questions?: Readonly<{ defaultScope?: "run" | "ticket" }>;
    planning?: Readonly<{ limit?: number; synthesisReserve?: number }>;
  }> = {},
): RunBehaviorSnapshot {
  const base = minimalCompiledBehavior(profileId);
  const compiledActions = compileActionCatalog([
    {
      id: "compile",
      path: "/fixture/actions/compile",
      document: {
        id: "compile",
        actor: "compiler",
        recipe: [{ id: "validate-project", primitive: "project.validate" }],
      },
    },
    {
      id: "compile-with-compensation",
      path: "/fixture/actions/compile-with-compensation",
      document: {
        id: "compile-with-compensation",
        actor: "compiler",
        recipe: [{ id: "validate-project", primitive: "project.validate" }],
        compensation: [{ id: "dispatch", primitive: "recovery.dispatch" }],
      },
    },
    {
      id: "report",
      path: "/fixture/actions/report",
      document: {
        id: "report",
        actor: "compiler",
        requires_main_checkout: true,
        recipe: [
          { id: "validate-project", primitive: "project.validate" },
          {
            id: "render",
            primitive: "report.render",
            deterministic: true,
            projections_from: "profile.reports",
          },
        ],
      },
    },
    {
      id: "spawn-lead",
      path: "/fixture/actions/spawn-lead",
      document: {
        id: "spawn-lead",
        actor: "compiler",
        requires_main_checkout: true,
        recipe: [
          {
            id: "judge",
            primitive: "agent.spawn",
            persona: "lead",
            prompt:
              "Make one bounded readiness judgment and return proceed or blocked. Never poll or schedule tickets.",
            transport: "compiler_broker",
            duplicate_policy: "reject",
          },
        ],
        compensation: [{ id: "stop", primitive: "agent.stop", target: "spawned_process_group" }],
      },
    },
  ]);
  if (!compiledActions.ok)
    throw new Error(compiledActions.diagnostics.map((item) => item.message).join("; "));
  const actions = compiledActions.value;
  const git = compileGitBehaviorPolicy({
    profileGit: {
      enabled: true,
      backend: "git_cli",
      integration_branch: "current",
      branch_template: "koni/runs/{{ run.id }}/integration",
      ticket_branch_template:
        "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}",
      worktree_root: ".koni-worktrees",
      integration_strategy: "squash",
      commit_template: "{{ ticket.operation }}: {{ ticket.title }}",
      commit_trailers: {},
    },
    runTypeGit: {
      branch_template: "koni/runs/{{ run.id }}/integration",
      ticket_branch_template:
        "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}",
    },
  });
  if (!git.ok) throw new Error(git.diagnostics.map((item) => item.message).join("; "));
  const planningLimit = overrides.planning?.limit ?? 100_000;
  const synthesisReserve = overrides.planning?.synthesisReserve ?? 20_000;
  if (
    !Number.isSafeInteger(planningLimit) ||
    planningLimit < 2 ||
    !Number.isSafeInteger(synthesisReserve) ||
    synthesisReserve < 1 ||
    synthesisReserve >= planningLimit
  )
    throw new Error("fixture planning limit and synthesis reserve are invalid");
  const runMaterial: Omit<CompiledRunTypeBehavior, "sha256"> = {
    id: runTypeId,
    title: "Fixture",
    description: "Synthetic authority fixture",
    intake: [
      {
        id: "goal",
        label: "Goal",
        description: "Test objective",
        kind: "text",
        required: true,
        options: [],
      },
    ],
    objectiveFieldId: "goal",
    pipeline: [
      {
        id: "intake",
        title: "Intake",
        kind: "action",
        config: { kind: "action", action: "planning.intake", compilerOwned: true, automatic: true },
      },
      {
        id: "plan",
        title: "Plan",
        kind: "planning",
        config: { kind: "agent", persona: "lead", prompt: "Plan the fixture." },
      },
      { id: "approval", title: "Approval", kind: "approval", config: { kind: "none" } },
      { id: "initialize", title: "Initialize", kind: "initialize", config: { kind: "none" } },
      { id: "orchestrate", title: "Orchestrate", kind: "orchestration", config: { kind: "none" } },
      { id: "target-sync", title: "Target sync", kind: "target_sync", config: { kind: "none" } },
      {
        id: "verification",
        title: "Verification",
        kind: "checkpoint",
        config: { kind: "checkpoint", checkpoint: "verification" },
      },
      {
        id: "report",
        title: "Report",
        kind: "action",
        config: { kind: "action", action: "report", compilerOwned: false, automatic: true },
      },
      { id: "promotion", title: "Promotion", kind: "promotion", config: { kind: "none" } },
    ],
    questions: {
      policy: "high_impact_only",
      presentation: "some",
      defaultScope: overrides.questions?.defaultScope ?? "run",
      toolAvailable: true,
    },
    runCardSections: ["goal", "pipeline", "graph", "tickets", "checks", "report"],
    roles: [
      { id: "lead", title: "Lead", provider: "test", model: "test-model", thinkingLevel: "off" },
    ],
    leadJudgment: {
      protocol: LEAD_JUDGMENT_PROTOCOL,
      actionId: "spawn-lead",
      personaId: "lead",
      roleId: "lead",
      prompt:
        "Make one bounded readiness judgment and return proceed or blocked. Never poll or schedule tickets.",
      triggers: ["orchestration_entry", "compiler_deadlock"],
      maxBoundariesPerAttempt: 1,
      terminal: {
        protocol: LEAD_JUDGMENT_OUTPUT_PROTOCOL,
        dispositions: ["proceed", "blocked"],
      },
    },
    git: git.value,
    autoStart: overrides.autoStart ?? true,
    maxParallel: 1,
    actionSelectors: { compile: "compile", lead: "spawn-lead", report: "report" },
    planning: {
      maxRepositoryToolCalls: 8,
      tokenPolicy: {
        metric: "new_tokens",
        limit: planningLimit,
        synthesisReserve,
        synthesisThreshold: planningLimit - synthesisReserve,
        onExhausted: "force_synthesis",
      },
    },
    planningInstructions: "Produce one bounded plan.",
  };
  const runType: CompiledRunTypeBehavior = Object.freeze({
    ...runMaterial,
    sha256: canonicalHash(runMaterial),
  });
  const behaviorMaterial = {
    protocol: "koni.compiled-behavior.v1" as const,
    profile: base.profile,
    defaultRunTypeId: runTypeId,
    runTypeOrder: [runTypeId],
    runTypes: { [runTypeId]: runType },
    actions,
  };
  const behavior: CompiledBehaviorIr = Object.freeze({
    ...behaviorMaterial,
    sha256: canonicalHash(behaviorMaterial),
  });
  return createRunBehaviorSnapshot(behavior, runTypeId);
}
