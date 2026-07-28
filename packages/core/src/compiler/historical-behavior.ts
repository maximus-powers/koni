import type { CompiledBehaviorIr } from "../contracts/behavior.js";
import type {
  CompiledAgentResource,
  CompiledConfiguration,
  ConfigurationObject,
} from "../contracts/configuration.js";
import {
  CURRENT_SOFTWARE_LEAD_IDENTITY_SHA256,
  CURRENT_SOFTWARE_PROFILE_GIT_SHA256,
  CURRENT_SOFTWARE_RUN_GIT_SHA256,
  LEGACY_SOFTWARE_LEAD_IDENTITY_SHA256,
  LEGACY_SOFTWARE_PROFILE_GIT_SHA256,
  LEGACY_SOFTWARE_RUN_GIT_SHA256,
  LEGACY_SOFTWARE_STORAGE_SHA256,
} from "../contracts/historical-compatibility.js";
import { canonicalHash, type Sha256Digest } from "../shared/canonical.js";
import type { RunRecord } from "../state/run-record.js";
import { compileActionCatalog } from "./action-recipes.js";
import { compileConfigurationBehavior } from "./behavior.js";

type MutableRecord = Record<string, unknown>;

const CURRENT_PROFILE_GIT: ConfigurationObject = Object.freeze({
  enabled: true,
  backend: "git_cli",
  integration_branch: "current",
  ticket_branch_template: "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}",
  worktree_root: ".koni-worktrees",
  integration_strategy: "squash",
  commit_template: "{{ ticket.operation }}: {{ ticket.title }}",
});

const CURRENT_RUN_GIT: ConfigurationObject = Object.freeze({
  branch_template: "koni/runs/{{ run.id }}/integration",
  ticket_branch_template: "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}",
});

const LEGACY_LEAD_PROMPT =
  "Operate the configured software Lead pull loop until compiler-verifiable terminal state.";
const CURRENT_LEAD_PROMPT =
  "Perform one bounded software orchestration-readiness judgment. Review the compiled ticket graph for unresolved material ambiguity or unsafe assumptions, ask only policy-allowed questions, then submit proceed or blocked with a concise rationale. Never poll, schedule deterministic work, or spawn workers.";

const CURRENT_LEAD_IDENTITY: Readonly<{
  description: string;
  instructions: ConfigurationObject;
}> = Object.freeze({
  description:
    "Performs one compiler-bounded qualitative readiness or deadlock judgment for a software run.",
  instructions: Object.freeze({
    source: "inline",
    text: [
      "Perform exactly one fresh, compiler-issued qualitative judgment from the",
      "immutable run context supplied to this attempt. At orchestration entry, decide",
      "whether the approved plan and compiled ticket board contain a material ambiguity",
      "or unsafe assumption that prevents deterministic scheduling. At a compiler",
      "deadlock, identify whether the supplied evidence supports proceeding or requires",
      "an explicit blocker. Treat the compiled graph, ticket board, plan, resolved",
      "questions, receipts, and lifecycle facts as authoritative.",
      "",
      "You are not the scheduler. Never select or dispatch ready tickets, spawn or wait",
      "for workers, perform implementation or review, edit the repository or graph,",
      "manage worktrees, invoke Koni through a shell, retry work, or infer terminal run",
      "completion. Ask only a policy-allowed high-impact question when the answer can",
      "genuinely change the judgment; otherwise make the bounded decision from current",
      "evidence. Preserve uncertainty in the summary instead of manufacturing work.",
      "",
      "Finish with exactly one `koni_submit_output` call using protocol",
      "`koni.lead-judgment-output.v1`, disposition `proceed` or `blocked`, and one concise",
      "evidence-based summary. `proceed` only opens the deterministic authority gate;",
      "it does not authorize any ticket, Git, lifecycle, or compiler effect.",
      "",
    ].join("\n"),
  }),
});

export class HistoricalBehaviorCompatibilityError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "HistoricalBehaviorCompatibilityError";
  }
}

/**
 * Reconstructs the compiled-behavior slice for authenticated 0.7 software runs that predate it.
 *
 * The persisted configuration is never changed. Only exact stock fragments are upgraded, inert
 * fields from the signed retirement catalog are omitted, and just the active run type is compiled.
 * A custom historical Git or Lead contract remains an explicit migration boundary.
 */
export function projectHistoricalCompiledBehavior(
  configuration: CompiledConfiguration,
  runTypeId: string,
): CompiledBehaviorIr | undefined {
  const original = configuration as unknown as MutableRecord;
  if (original.behavior !== undefined) return undefined;

  const packageIdentity = requiredRecord(original.package, "configuration package identity");
  if (
    packageIdentity.profile_lineage !== "koni.software" ||
    packageIdentity.profile_version !== "0.7.0" ||
    packageIdentity.version !== "0.7.0"
  ) {
    throw compatibilityError(
      "historical_behavior_version",
      "pinned configuration has no compiled behavior and is not an authenticated software 0.7 snapshot",
    );
  }

  const projected = structuredClone(configuration) as unknown as MutableRecord;
  const profile = requiredRecord(projected.profile, "historical profile");
  normalizeProfile(profile);

  const runTypes = requiredRecord(projected.run_types, "historical run types");
  const runTypeSource = requiredRecord(runTypes[runTypeId], `historical run type ${runTypeId}`);
  const runTypeDocument = requiredRecord(
    runTypeSource.document,
    `historical run type ${runTypeId} document`,
  );
  normalizeRunType(runTypeDocument);

  const registries = requiredRecord(projected.registries, "historical registries");
  const actions = requiredRecord(registries.actions, "historical action registry");
  normalizeLeadAction(actions);

  const agents = requiredRecord(projected.agents, "historical agents");
  normalizeLeadAgent(agents);
  const personas = requiredRecord(registries.personas, "historical persona registry");

  const actionCatalog = compileActionCatalog(
    Object.entries(actions).map(([id, document]) => ({
      id,
      path: `/registries/actions/${id}`,
      document: requiredRecord(document, `historical action ${id}`) as ConfigurationObject,
    })),
  );
  if (!actionCatalog.ok) {
    throw compatibilityError(
      "historical_behavior_actions",
      "historical action catalog cannot be projected safely",
      diagnosticLines(actionCatalog.diagnostics),
    );
  }

  const project = requiredRecord(projected.project, "historical project");
  const runTypeSha256 = runTypeSource.sha256;
  if (typeof runTypeSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(runTypeSha256)) {
    throw compatibilityError(
      "historical_behavior_run_type",
      `historical run type ${runTypeId} has no valid digest`,
    );
  }
  const result = compileConfigurationBehavior({
    profile: profile as ConfigurationObject,
    project: { ...project, default_run_type: runTypeId },
    runTypeOrder: [runTypeId],
    runTypes: [
      {
        id: runTypeId,
        sha256: runTypeSha256 as Sha256Digest,
        document: runTypeDocument as ConfigurationObject,
      },
    ],
    agents: new Map(
      Object.entries(agents).map(
        ([id, agent]) =>
          [
            id,
            requiredRecord(agent, `historical agent ${id}`) as unknown as CompiledAgentResource,
          ] as const,
      ),
    ),
    personas: new Map(
      Object.entries(personas).map(([id, persona]) => [
        id,
        requiredRecord(persona, `historical persona ${id}`) as ConfigurationObject,
      ]),
    ),
    actions: actionCatalog.value,
  });
  if (!result.ok) {
    throw compatibilityError(
      "historical_behavior_compile",
      `historical run type ${runTypeId} cannot be projected under the current executable contract`,
      diagnosticLines(result.diagnostics),
    );
  }
  return result.value;
}

/** Prevents an in-memory projection from changing choices already persisted on the run. */
export function assertHistoricalBehaviorMatchesRun(
  run: RunRecord,
  behavior: CompiledBehaviorIr,
  configuration: CompiledConfiguration,
): void {
  const runType = behavior.runTypes[run.runTypeId];
  if (runType === undefined) drift(`projection has no active run type ${run.runTypeId}`);
  const executionConfig = run.executionConfig;
  if (executionConfig === undefined)
    drift("durable run has no execution configuration to bind the projection");
  if (runType.maxParallel !== executionConfig.maxParallel)
    drift("max-parallel policy differs from the durable run");
  if (runType.questions.presentation !== executionConfig.questionPolicy)
    drift("question policy differs from the durable run");
  if (runType.planningInstructions !== executionConfig.instructions)
    drift("run instructions differ from the durable run");
  if (
    !sameList(
      runType.pipeline.map((stage) => stage.id),
      run.pipelineStageIds,
    )
  )
    drift("pipeline differs from the durable run");

  const roles = new Map(runType.roles.map((role) => [role.id, role] as const));
  const selectedAgentIds = Object.keys(executionConfig.agents).sort(compareText);
  const configuredAgents = Object.keys(configuration.agents).sort(compareText);
  if (!sameList(configuredAgents, selectedAgentIds))
    drift("agent inventory differs from the durable run");
  const personas = Object.values(configuration.registries.personas);
  for (const id of selectedAgentIds) {
    const persona = personas.find((candidate) => candidate.agent === id);
    const roleId = typeof persona?.model_role === "string" ? persona.model_role : undefined;
    const role = roleId === undefined ? undefined : roles.get(roleId);
    const selected = executionConfig.agents[id];
    if (
      roleId === undefined ||
      role === undefined ||
      selected === undefined ||
      role.provider !== selected.provider ||
      role.model !== selected.model ||
      role.thinkingLevel !== selected.thinkingLevel
    ) {
      drift(`agent ${id} differs from its durable ${roleId ?? "unknown"} role`);
    }
  }
}

function normalizeProfile(profile: MutableRecord): void {
  const git = requiredRecord(profile.git, "historical profile Git policy");
  const gitSha256 = canonicalHash(git);
  if (gitSha256 === LEGACY_SOFTWARE_PROFILE_GIT_SHA256) {
    profile.git = structuredClone(CURRENT_PROFILE_GIT);
  } else if (gitSha256 !== CURRENT_SOFTWARE_PROFILE_GIT_SHA256) {
    throw compatibilityError(
      "historical_behavior_git",
      "historical profile has a customized Git contract that requires explicit migration",
    );
  }

  if (profile.storage !== undefined) {
    if (canonicalHash(profile.storage) !== LEGACY_SOFTWARE_STORAGE_SHA256) {
      throw compatibilityError(
        "historical_behavior_storage",
        "historical profile has customized retired storage semantics",
      );
    }
    delete profile.storage;
  }

  const orchestration = requiredRecord(profile.orchestration, "historical orchestration policy");
  retireExactField(orchestration, "running", true);
  retireExactField(orchestration, "lease_stale_seconds", 1_800);
  retireExactField(orchestration, "max_fixpoint_passes", 8);
}

function normalizeRunType(runType: MutableRecord): void {
  if (runType.planning !== undefined) {
    const planning = requiredRecord(runType.planning, "historical planning policy");
    retireExactField(planning, "session_scope", "run");
    if (planning.graph_seed_stage !== undefined) {
      if (
        typeof planning.graph_seed_stage !== "string" ||
        !["focused-plan", "combined-plan", "verification-plan"].includes(planning.graph_seed_stage)
      ) {
        throw compatibilityError(
          "historical_behavior_planning",
          "historical graph-seed stage has customized semantics",
        );
      }
      delete planning.graph_seed_stage;
    }
  }

  const intake = requiredRecord(runType.intake, "historical run intake");
  if (intake.objective_field === undefined) intake.objective_field = "goal";

  const git = requiredRecord(runType.git, "historical run Git policy");
  const gitSha256 = canonicalHash(git);
  if (gitSha256 === LEGACY_SOFTWARE_RUN_GIT_SHA256) {
    runType.git = structuredClone(CURRENT_RUN_GIT);
  } else if (gitSha256 !== CURRENT_SOFTWARE_RUN_GIT_SHA256) {
    throw compatibilityError(
      "historical_behavior_git",
      "historical run type has a customized Git contract that requires explicit migration",
    );
  }
}

function normalizeLeadAction(actions: MutableRecord): void {
  const spawnLead = requiredRecord(actions["spawn-lead"], "historical spawn-lead action");
  if (!Array.isArray(spawnLead.recipe))
    throw compatibilityError("historical_behavior_lead", "historical spawn-lead recipe is missing");
  const step = spawnLead.recipe.find((candidate) => {
    const record = optionalRecord(candidate);
    return record?.id === "lead" && record.primitive === "agent.spawn";
  });
  const lead = requiredRecord(step, "historical Lead action step");
  if (lead.prompt === LEGACY_LEAD_PROMPT) lead.prompt = CURRENT_LEAD_PROMPT;
}

function normalizeLeadAgent(agents: MutableRecord): void {
  const lead = requiredRecord(agents.lead, "historical Lead agent");
  const document = requiredRecord(lead.document, "historical Lead agent document");
  const identity = { description: document.description, instructions: document.instructions };
  const identitySha256 = canonicalHash(identity);
  if (identitySha256 === LEGACY_SOFTWARE_LEAD_IDENTITY_SHA256) {
    document.description = CURRENT_LEAD_IDENTITY.description;
    document.instructions = structuredClone(CURRENT_LEAD_IDENTITY.instructions);
  } else if (identitySha256 === CURRENT_SOFTWARE_LEAD_IDENTITY_SHA256) {
    return;
  }
  // A customized agent is left intact so the current bounded-Lead compiler can validate it.
}

function retireExactField(record: MutableRecord, key: string, expected: unknown): void {
  if (record[key] === undefined) return;
  if (canonicalHash(record[key]) !== canonicalHash(expected)) {
    throw compatibilityError(
      "historical_behavior_retirement",
      `retired historical field ${key} has a customized value`,
    );
  }
  delete record[key];
}

function requiredRecord(value: unknown, label: string): MutableRecord {
  const record = optionalRecord(value);
  if (record === undefined)
    throw compatibilityError("historical_behavior_shape", `${label} is missing or invalid`);
  return record;
}

function optionalRecord(value: unknown): MutableRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as MutableRecord)
    : undefined;
}

function diagnosticLines(
  diagnostics: readonly { code: string; path: string; message: string }[],
): string[] {
  return diagnostics.map((item) => `${item.code} ${item.path}: ${item.message}`);
}

function compatibilityError(
  code: string,
  message: string,
  details: readonly string[] = [],
): HistoricalBehaviorCompatibilityError {
  return new HistoricalBehaviorCompatibilityError(code, message, details);
}

function drift(message: string): never {
  throw compatibilityError("historical_behavior_drift", message);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
