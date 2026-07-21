import {
  COMPILED_BEHAVIOR_PROTOCOL,
  INTAKE_FIELD_KINDS,
  LEAD_JUDGMENT_OUTPUT_PROTOCOL,
  LEAD_JUDGMENT_PROTOCOL,
  LEAD_JUDGMENT_TRIGGERS,
  RUN_STAGE_KINDS,
  type CompiledActionCatalog,
  type CompiledAgentRoleBehavior,
  type CompiledBehaviorIr,
  type CompiledIntakeField,
  type CompiledIntakeOption,
  type CompiledLeadJudgmentBehavior,
  type CompiledPlanningBehavior,
  type CompiledQuestionBehavior,
  type CompiledRunStage,
  type CompiledRunTypeBehavior,
  type CompiledWorkspaceBehavior,
  type IntakeFieldKind,
  type LeadJudgmentTrigger,
  type LeadJudgmentOutput,
  type RunStageKind,
} from "../contracts/behavior.js";
import type {
  CompiledAgentResource,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import { canonicalEncode, canonicalHash, compareUtf8 } from "../shared/canonical.js";
import {
  DiagnosticBag,
  pointer,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "../shared/diagnostics.js";
import {
  QUESTION_POLICIES,
  presentationQuestionPolicy,
  questionPolicyDisposition,
  type QuestionPolicy,
  type QuestionPolicyInput,
  type QuestionPolicyDisposition,
} from "../state/question-policy.js";
import { compileGitBehaviorPolicy, type GitBehaviorPolicy } from "../git/behavior-policy.js";

export interface BehaviorRunTypeSource {
  readonly id: string;
  readonly sha256: `sha256:${string}`;
  readonly document: ConfigurationObject;
}

export interface CompileConfigurationBehaviorInput {
  readonly profile: ConfigurationObject;
  readonly project: ConfigurationObject;
  readonly runTypeOrder: readonly string[];
  readonly runTypes: readonly BehaviorRunTypeSource[];
  readonly agents: ReadonlyMap<string, CompiledAgentResource>;
  readonly personas: ReadonlyMap<string, ConfigurationObject>;
  readonly actions: CompiledActionCatalog;
}

const PROFILE_IDENTITY_FIELDS = ["id", "version", "description"] as const;
const INITIALIZATION_FIELDS = ["root_node_type", "goal_field", "planning_context_field", "planning_seed_operation", "root_status"] as const;
const PROFILE_ORCHESTRATION_FIELDS = ["max_parallel", "max_boundaries_per_lead", "disjoint_scope_parallelism"] as const;
const CHANGE_CONTROL_FIELDS = ["working_spec_owner"] as const;
const REPORTING_FIELDS = ["bundle_kind"] as const;
const RUN_CARD_SECTIONS = new Set(["goal", "pipeline", "graph", "tickets", "checks", "report"]);
const QUESTION_SCOPES = new Set(["run", "ticket"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const INTAKE_ALIASES: Readonly<Record<string, IntakeFieldKind>> = Object.freeze({
  string: "string",
  text: "text",
  multiline: "text",
  path: "path",
  boolean: "boolean",
  integer: "integer",
  number: "number",
  choice: "choice",
  select: "choice",
  multi_choice: "multi_choice",
  json: "json",
});
const MAX_RUN_INTAKE_BYTES = 4 * 1024 * 1024;

export function compileConfigurationBehavior(
  input: CompileConfigurationBehaviorInput,
): ValidationResult<CompiledBehaviorIr> {
  const bag = new DiagnosticBag();
  const profile = compileProfileBehavior(input.profile, bag);
  const runTypes: Record<string, CompiledRunTypeBehavior> = Object.create(null) as Record<string, CompiledRunTypeBehavior>;
  for (const source of input.runTypes) {
    const behavior = compileRunTypeBehavior(
      source,
      input.profile.git,
      profile?.orchestration.maxBoundariesPerLead,
      input.agents,
      input.personas,
      input.actions,
      bag,
    );
    if (behavior !== undefined) runTypes[source.id] = behavior;
  }
  const projectDefault = typeof input.project.default_run_type === "string" ? input.project.default_run_type : undefined;
  if (projectDefault === undefined || runTypes[projectDefault] === undefined) {
    bag.error("configuration.behavior_default", "/project/default_run_type", "default run type has no compiled behavior");
  }
  if (bag.hasErrors() || profile === undefined || projectDefault === undefined) return validationFailure(bag.sorted());
  const material = {
    protocol: COMPILED_BEHAVIOR_PROTOCOL,
    profile,
    defaultRunTypeId: projectDefault,
    runTypeOrder: [...input.runTypeOrder],
    runTypes,
    actions: input.actions,
  };
  return validationSuccess(deepFreeze({ ...material, sha256: canonicalHash(material) }), bag.sorted());
}

function compileProfileBehavior(
  document: ConfigurationObject,
  bag: DiagnosticBag,
): CompiledBehaviorIr["profile"] | undefined {
  const identity = record(document.profile, "/profile/profile", bag);
  if (identity !== undefined) rejectUnknown(identity, PROFILE_IDENTITY_FIELDS, "/profile/profile", bag);
  const id = text(identity?.id, "/profile/profile/id", bag);

  const initialization = record(document.initialization, "/profile/initialization", bag);
  if (initialization !== undefined) rejectUnknown(initialization, INITIALIZATION_FIELDS, "/profile/initialization", bag);
  const rootNodeType = text(initialization?.root_node_type, "/profile/initialization/root_node_type", bag);
  const goalField = text(initialization?.goal_field, "/profile/initialization/goal_field", bag);
  const planningContextField = text(initialization?.planning_context_field, "/profile/initialization/planning_context_field", bag);
  const planningSeedOperation = text(initialization?.planning_seed_operation, "/profile/initialization/planning_seed_operation", bag);
  const rootStatus = text(initialization?.root_status, "/profile/initialization/root_status", bag);

  const orchestration = record(document.orchestration, "/profile/orchestration", bag);
  if (orchestration !== undefined) rejectUnknown(orchestration, PROFILE_ORCHESTRATION_FIELDS, "/profile/orchestration", bag);
  const maxParallel = positiveInteger(orchestration?.max_parallel, "/profile/orchestration/max_parallel", bag);
  const maxBoundariesPerLead = positiveInteger(orchestration?.max_boundaries_per_lead, "/profile/orchestration/max_boundaries_per_lead", bag);
  if (maxBoundariesPerLead !== undefined && maxBoundariesPerLead !== 1) {
    bag.error(
      "configuration.unsupported_value",
      "/profile/orchestration/max_boundaries_per_lead",
      "the current Lead judgment protocol supports exactly one boundary per attempt",
    );
  }
  const supportedMaxBoundariesPerLead = maxBoundariesPerLead === 1 ? 1 as const : undefined;
  const disjointScopeParallelism = booleanValue(orchestration?.disjoint_scope_parallelism, "/profile/orchestration/disjoint_scope_parallelism", bag);

  if (document.change_control !== undefined) {
    const control = record(document.change_control, "/profile/change_control", bag);
    if (control !== undefined) {
      rejectUnknown(control, CHANGE_CONTROL_FIELDS, "/profile/change_control", bag);
      if (control.working_spec_owner !== undefined) {
        text(control.working_spec_owner, "/profile/change_control/working_spec_owner", bag);
      }
    }
  }
  let reportingBundleKind: string | undefined;
  if (document.reporting !== undefined) {
    const reporting = record(document.reporting, "/profile/reporting", bag);
    if (reporting !== undefined) {
      rejectUnknown(reporting, REPORTING_FIELDS, "/profile/reporting", bag);
      reportingBundleKind = text(reporting.bundle_kind, "/profile/reporting/bundle_kind", bag);
    }
  }
  const requiredValues = [id, rootNodeType, goalField, planningContextField, planningSeedOperation, rootStatus,
    maxParallel, supportedMaxBoundariesPerLead, disjointScopeParallelism];
  if (requiredValues.some((value) => value === undefined)) return undefined;
  return {
    id: id!,
    initialization: {
      rootNodeType: rootNodeType!, goalField: goalField!, planningContextField: planningContextField!,
      planningSeedOperation: planningSeedOperation!, rootStatus: rootStatus!,
    },
    orchestration: {
      maxParallel: maxParallel!, maxBoundariesPerLead: supportedMaxBoundariesPerLead!,
      disjointScopeParallelism: disjointScopeParallelism!,
    },
    ...(reportingBundleKind === undefined ? {} : { reportingBundleKind }),
  };
}

function compileRunTypeBehavior(
  source: BehaviorRunTypeSource,
  profileGit: ConfigurationValue | undefined,
  maxBoundariesPerLead: 1 | undefined,
  agents: ReadonlyMap<string, CompiledAgentResource>,
  personas: ReadonlyMap<string, ConfigurationObject>,
  actions: CompiledActionCatalog,
  bag: DiagnosticBag,
): CompiledRunTypeBehavior | undefined {
  const root = `/run_types/${source.id}`;
  const gitResult = compileGitBehaviorPolicy({
    profileGit,
    runTypeGit: source.document.git,
    profilePath: "/profile/git",
    runTypePath: `${root}/git`,
  });
  bag.extend(gitResult.diagnostics);
  const git: GitBehaviorPolicy | undefined = gitResult.ok ? gitResult.value : undefined;
  const title = text(source.document.title, pointer(root, "title"), bag);
  const description = source.document.description === undefined ? "" : text(source.document.description, pointer(root, "description"), bag) ?? "";
  const intake = compileIntake(source.document.intake, pointer(root, "intake"), bag);
  const objectiveFieldId = compileObjectiveFieldId(source.document.intake, pointer(root, "intake"), bag);
  const pipeline = compilePipeline(source.document.pipeline, pointer(root, "pipeline"), actions, personas, bag);
  const questions = compileQuestions(source.document.questions, pointer(root, "questions"), bag);
  const runCardSections = compileRunCard(source.document.run_card, pointer(root, "run_card"), bag);
  const roles = compileRoles(source.document.agents, pointer(root, "agents"), agents, personas, bag);
  const orchestration = record(source.document.orchestration, pointer(root, "orchestration"), bag);
  if (orchestration !== undefined) rejectUnknown(orchestration, ["auto_start", "max_parallel", "compile_action", "lead_action", "lead_triggers", "report_action"], pointer(root, "orchestration"), bag);
  const autoStart = booleanValue(orchestration?.auto_start, `${root}/orchestration/auto_start`, bag);
  const maxParallel = positiveInteger(orchestration?.max_parallel, `${root}/orchestration/max_parallel`, bag);
  const compileAction = actionSelector(orchestration?.compile_action, `${root}/orchestration/compile_action`, actions, bag);
  const leadAction = actionSelector(orchestration?.lead_action, `${root}/orchestration/lead_action`, actions, bag);
  const leadTriggers = compileLeadTriggers(orchestration?.lead_triggers, `${root}/orchestration/lead_triggers`, bag);
  const reportAction = actionSelector(orchestration?.report_action, `${root}/orchestration/report_action`, actions, bag);
  const leadJudgment = leadAction === undefined || maxBoundariesPerLead === undefined
    ? undefined
    : compileLeadJudgment(leadAction, leadTriggers, maxBoundariesPerLead, actions, agents, personas, roles, `${root}/orchestration/lead_action`, bag);
  const instructions = source.document.instructions === undefined ? undefined : record(source.document.instructions, pointer(root, "instructions"), bag);
  if (instructions !== undefined) rejectUnknown(instructions, ["planning"], pointer(root, "instructions"), bag);
  const planningInstructions = instructions?.planning === undefined ? "" : text(instructions.planning, `${root}/instructions/planning`, bag) ?? "";
  const planning = compilePlanning(source.document.planning, pointer(root, "planning"), pipeline, bag);
  const workspace = compileWorkspace(source.document.workspace, pointer(root, "workspace"), bag);
  validatePipelineTopology(pipeline, reportAction, root, bag);
  const objective = objectiveFieldId === undefined ? undefined : intake.find((field) => field.id === objectiveFieldId);
  if (objective === undefined || (objective.kind !== "string" && objective.kind !== "text") || !objective.required) {
    bag.error("configuration.intake_objective", `${root}/intake/objective_field`, "run intake objective_field must name a required string or text field");
  }
  if ([title, git, autoStart, maxParallel, compileAction, leadAction, leadJudgment, reportAction].some((value) => value === undefined) ||
      intake.length === 0 || pipeline.length === 0 || questions === undefined || roles.length === 0 || objective === undefined ||
      pipeline.some((stage) => stage.kind === "planning") !== (planning !== undefined)) return undefined;
  const material = {
    id: source.id,
    title: title!,
    description,
    intake,
    objectiveFieldId: objective!.id,
    pipeline,
    questions,
    runCardSections,
    roles,
    leadJudgment: leadJudgment!,
    git: git!,
    autoStart: autoStart!,
    maxParallel: maxParallel!,
    actionSelectors: { compile: compileAction!, lead: leadAction!, report: reportAction! },
    ...(planning === undefined ? {} : { planning }),
    planningInstructions,
    ...(workspace === undefined ? {} : { workspace }),
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function compileIntake(value: ConfigurationValue | undefined, path: string, bag: DiagnosticBag): readonly CompiledIntakeField[] {
  const intake = record(value, path, bag);
  if (intake === undefined) return [];
  rejectUnknown(intake, ["fields", "order", "objective_field"], path, bag);
  const fields = record(intake.fields, pointer(path, "fields"), bag);
  const order = uniqueTextList(intake.order, pointer(path, "order"), bag);
  if (fields === undefined) return [];
  const output: CompiledIntakeField[] = [];
  for (const [index, id] of order.entries()) {
    const fieldPath = pointer(pointer(path, "fields"), id);
    const field = record(fields[id], fieldPath, bag);
    if (field === undefined) continue;
    rejectUnknown(field, ["label", "description", "type", "required", "default", "options"], fieldPath, bag);
    const label = text(field.label, pointer(fieldPath, "label"), bag);
    const description = field.description === undefined ? "" : text(field.description, pointer(fieldPath, "description"), bag) ?? "";
    const configuredType = text(field.type, pointer(fieldPath, "type"), bag);
    const kind = configuredType === undefined ? undefined : INTAKE_ALIASES[configuredType];
    if (configuredType !== undefined && (kind === undefined || !INTAKE_FIELD_KINDS.includes(kind))) bag.error("configuration.intake_field_type", pointer(fieldPath, "type"), `unsupported intake field type ${configuredType}`);
    const required = field.required === undefined ? false : booleanValue(field.required, pointer(fieldPath, "required"), bag);
    const options = compileIntakeOptions(field.options, pointer(fieldPath, "options"), bag);
    if ((kind === "choice" || kind === "multi_choice") && options.length === 0) bag.error("configuration.intake_options", pointer(fieldPath, "options"), `${kind} intake field requires options`);
    if (kind !== undefined && kind !== "choice" && kind !== "multi_choice" && field.options !== undefined) bag.error("configuration.intake_options", pointer(fieldPath, "options"), `${kind} intake field must not define options`);
    if (kind !== undefined && field.default !== undefined && !matchesIntakeValue(field.default, kind, options)) bag.error("configuration.intake_default", pointer(fieldPath, "default"), `default does not match ${kind} intake field`);
    if (label !== undefined && kind !== undefined && required !== undefined) output.push({
      id, label, description, kind, required, ...(field.default === undefined ? {} : { default: structuredClone(field.default) }), options,
    });
    if (!Object.hasOwn(fields, id)) bag.error("configuration.unknown_intake_field", pointer(pointer(path, "order"), index), `intake field ${id} is not defined`);
  }
  for (const id of Object.keys(fields)) if (!order.includes(id)) bag.error("configuration.missing_intake_order", pointer(pointer(path, "fields"), id), "intake field is absent from presentation order");
  return output;
}

function compileObjectiveFieldId(value: ConfigurationValue | undefined, path: string, bag: DiagnosticBag): string | undefined {
  const intake = record(value, path, bag);
  if (intake === undefined) return undefined;
  if (intake.objective_field === undefined) {
    bag.warning("configuration.legacy_objective_field", pointer(path, "objective_field"), "legacy run type defaults objective_field to goal; save the explicit field during the next targeted profile migration");
    return "goal";
  }
  return text(intake.objective_field, pointer(path, "objective_field"), bag);
}

function compileIntakeOptions(value: ConfigurationValue | undefined, path: string, bag: DiagnosticBag): readonly CompiledIntakeOption[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    bag.error("configuration.intake_options", path, "intake options must be a list");
    return [];
  }
  const output: CompiledIntakeOption[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = pointer(path, index);
    let option: CompiledIntakeOption | undefined;
    if (typeof item === "string" && item.length > 0) option = { value: item, label: item };
    else if (isRecord(item)) {
      rejectUnknown(item, ["value", "label", "description"], itemPath, bag);
      const optionValue = text(item.value, pointer(itemPath, "value"), bag);
      const label = text(item.label, pointer(itemPath, "label"), bag);
      const description = item.description === undefined ? undefined : text(item.description, pointer(itemPath, "description"), bag);
      if (optionValue !== undefined && label !== undefined) option = { value: optionValue, label, ...(description === undefined ? {} : { description }) };
    } else bag.error("configuration.intake_options", itemPath, "intake option must be text or {value,label,description}");
    if (option !== undefined) {
      if (seen.has(option.value)) bag.error("configuration.duplicate_intake_option", itemPath, `intake option ${option.value} is duplicated`);
      else { seen.add(option.value); output.push(option); }
    }
  });
  return output;
}

function compilePipeline(
  value: ConfigurationValue | undefined,
  path: string,
  actions: CompiledActionCatalog,
  personas: ReadonlyMap<string, ConfigurationObject>,
  bag: DiagnosticBag,
): readonly CompiledRunStage[] {
  const pipeline = record(value, path, bag);
  if (pipeline === undefined) return [];
  rejectUnknown(pipeline, ["stages", "order"], path, bag);
  const stages = record(pipeline.stages, pointer(path, "stages"), bag);
  const order = uniqueTextList(pipeline.order, pointer(path, "order"), bag);
  if (stages === undefined) return [];
  const output: CompiledRunStage[] = [];
  for (const [index, id] of order.entries()) {
    const stagePath = pointer(pointer(path, "stages"), id);
    const stage = record(stages[id], stagePath, bag);
    if (stage === undefined) continue;
    rejectUnknown(stage, ["kind", "title", "config"], stagePath, bag);
    const title = text(stage.title, pointer(stagePath, "title"), bag);
    const kindValue = text(stage.kind, pointer(stagePath, "kind"), bag);
    const kind = kindValue !== undefined && RUN_STAGE_KINDS.includes(kindValue as RunStageKind) ? kindValue as RunStageKind : undefined;
    if (kindValue !== undefined && kind === undefined) bag.error("configuration.pipeline_kind", pointer(stagePath, "kind"), `unsupported pipeline stage kind ${kindValue}`);
    const config = stage.config === undefined ? {} : record(stage.config, pointer(stagePath, "config"), bag);
    let compiledConfig: CompiledRunStage["config"] | undefined;
    if (kind === "action" && config !== undefined) {
      rejectUnknown(config, ["action", "compiler_owned", "automatic"], pointer(stagePath, "config"), bag);
      const action = text(config.action, `${stagePath}/config/action`, bag);
      const compilerOwned = config.compiler_owned === undefined ? false : booleanValue(config.compiler_owned, `${stagePath}/config/compiler_owned`, bag);
      const automatic = config.automatic === undefined ? compilerOwned ?? false : booleanValue(config.automatic, `${stagePath}/config/automatic`, bag);
      if (action !== undefined && compilerOwned === false && actions.aliases[action] === undefined) bag.error("configuration.dangling_reference", `${stagePath}/config/action`, `action ${action} is not configured`);
      if (action !== undefined && compilerOwned !== undefined && automatic !== undefined) compiledConfig = { kind: "action", action: compilerOwned ? action : actions.aliases[action]!, compilerOwned, automatic };
    } else if ((kind === "planning" || kind === "agent_review") && config !== undefined) {
      rejectUnknown(config, ["persona", "prompt"], pointer(stagePath, "config"), bag);
      const persona = text(config.persona, `${stagePath}/config/persona`, bag);
      const prompt = text(config.prompt, `${stagePath}/config/prompt`, bag);
      if (persona !== undefined && !personas.has(persona)) bag.error("configuration.dangling_reference", `${stagePath}/config/persona`, `persona ${persona} is not configured`);
      if (persona !== undefined && prompt !== undefined) compiledConfig = { kind: "agent", persona, prompt };
    } else if (kind === "checkpoint" && config !== undefined) {
      rejectUnknown(config, ["checkpoint"], pointer(stagePath, "config"), bag);
      const checkpoint = text(config.checkpoint, `${stagePath}/config/checkpoint`, bag);
      if (checkpoint !== undefined) compiledConfig = { kind: "checkpoint", checkpoint };
    } else if (kind !== undefined) {
      if (config !== undefined && Object.keys(config).length > 0) bag.error("configuration.pipeline_config", pointer(stagePath, "config"), `${kind} stage does not accept configuration`);
      compiledConfig = { kind: "none" };
    }
    if (title !== undefined && kind !== undefined && compiledConfig !== undefined) output.push({ id, title, kind, config: compiledConfig });
    if (!Object.hasOwn(stages, id)) bag.error("configuration.unknown_stage", pointer(pointer(path, "order"), index), `pipeline stage ${id} is not defined`);
  }
  for (const id of Object.keys(stages)) if (!order.includes(id)) bag.error("configuration.unordered_stage", pointer(pointer(path, "stages"), id), "pipeline stage is absent from order");
  return output;
}

function validatePipelineTopology(stages: readonly CompiledRunStage[], reportAction: string | undefined, root: string, bag: DiagnosticBag): void {
  const positions = (kind: RunStageKind) => stages.flatMap((stage, index) => stage.kind === kind ? [index] : []);
  for (const kind of ["approval", "initialize", "orchestration", "target_sync", "checkpoint", "promotion"] as const) {
    if (positions(kind).length !== 1) bag.error("configuration.pipeline_topology", `${root}/pipeline`, `pipeline must contain exactly one ${kind} stage`);
  }
  if (stages[0]?.kind !== "action" || stages[0].config.kind !== "action" || !stages[0].config.compilerOwned || !stages[0].config.automatic || stages[0].config.action !== "planning.intake") bag.error("configuration.pipeline_topology", `${root}/pipeline/order/0`, "pipeline must begin with the automatic compiler-owned planning.intake adapter");
  if (stages.at(-1)?.kind !== "promotion") bag.error("configuration.pipeline_topology", `${root}/pipeline/order`, "promotion must be the final stage");
  const approval = positions("approval")[0] ?? -1;
  const initialize = positions("initialize")[0] ?? -1;
  const orchestration = positions("orchestration")[0] ?? -1;
  const targetSync = positions("target_sync")[0] ?? -1;
  const checkpoint = positions("checkpoint")[0] ?? -1;
  const promotion = positions("promotion")[0] ?? -1;
  if (!(approval > 0 && initialize > approval && orchestration > initialize && targetSync > orchestration && checkpoint > targetSync && promotion > checkpoint)) bag.error("configuration.pipeline_topology", `${root}/pipeline/order`, "pipeline must order approval, initialization, orchestration, target sync, checkpoint, and promotion monotonically");
  for (const index of positions("planning")) if (!(index > 0 && index < approval)) bag.error("configuration.pipeline_topology", `${root}/pipeline/order/${index}`, "planning stages must be between intake and approval");
  for (const index of positions("agent_review")) if (!(index > targetSync && index < promotion)) bag.error("configuration.pipeline_topology", `${root}/pipeline/order/${index}`, "agent review must occur after target sync and before promotion");
  for (const index of positions("checkpoint")) {
    const stage = stages[index]!;
    if (stage.config.kind !== "checkpoint" || stage.config.checkpoint !== "verification") bag.error("configuration.pipeline_checkpoint", `${root}/pipeline/stages/${stage.id}/config/checkpoint`, "native pipeline supports only the verification checkpoint adapter");
  }
  const reports = stages.filter((stage): stage is CompiledRunStage & { config: Extract<CompiledRunStage["config"], { kind: "action" }> } =>
    stage.kind === "action" && stage.config.kind === "action" && !stage.config.compilerOwned && stage.config.action === reportAction);
  if (reports.length !== 1 || !reports[0]!.config.automatic) bag.error("configuration.pipeline_topology", `${root}/pipeline`, "pipeline must contain exactly one automatic configured report action");
  const reportIndex = reports.length === 1 ? stages.indexOf(reports[0]!) : -1;
  const lastReview = Math.max(-1, ...positions("agent_review"));
  if (!(reportIndex > checkpoint && reportIndex > lastReview && reportIndex < promotion)) bag.error("configuration.pipeline_topology", `${root}/pipeline/order`, "report action must run after verification and every independent review, immediately before promotion work");
}

function compileQuestions(value: ConfigurationValue | undefined, path: string, bag: DiagnosticBag): CompiledQuestionBehavior | undefined {
  const questions = record(value, path, bag);
  if (questions === undefined) return undefined;
  rejectUnknown(questions, ["policy", "default_scope"], path, bag);
  const policy = text(questions.policy, pointer(path, "policy"), bag);
  const defaultScope = text(questions.default_scope, pointer(path, "default_scope"), bag);
  if (policy !== undefined && !QUESTION_POLICIES.includes(policy as QuestionPolicy)) bag.error("configuration.question_policy", pointer(path, "policy"), `unsupported question policy ${policy}`);
  if (defaultScope !== undefined && !QUESTION_SCOPES.has(defaultScope)) bag.error("configuration.question_scope", pointer(path, "default_scope"), `unsupported question scope ${defaultScope}`);
  if (policy === undefined || defaultScope === undefined || !QUESTION_POLICIES.includes(policy as QuestionPolicy) || !QUESTION_SCOPES.has(defaultScope)) return undefined;
  return {
    policy: policy as CompiledQuestionBehavior["policy"],
    presentation: presentationQuestionPolicy(policy as QuestionPolicy),
    defaultScope: defaultScope as CompiledQuestionBehavior["defaultScope"],
    toolAvailable: true,
  };
}

function compileRunCard(value: ConfigurationValue | undefined, path: string, bag: DiagnosticBag): readonly string[] {
  const card = record(value, path, bag);
  if (card === undefined) return [];
  rejectUnknown(card, ["sections"], path, bag);
  const sections = uniqueTextList(card.sections, pointer(path, "sections"), bag);
  sections.forEach((section, index) => {
    if (!RUN_CARD_SECTIONS.has(section)) bag.error("configuration.run_card_section", pointer(pointer(path, "sections"), index), `unsupported run-card section ${section}`);
  });
  return sections;
}

function compilePlanning(
  value: ConfigurationValue | undefined,
  path: string,
  stages: readonly CompiledRunStage[],
  bag: DiagnosticBag,
): CompiledPlanningBehavior | undefined {
  const stageIds = stages.filter((stage) => stage.kind === "planning").map((stage) => stage.id);
  if (stageIds.length === 0) {
    if (value !== undefined) bag.error("configuration.planning_unused", path, "run type without planning stages must not define planning policy");
    return undefined;
  }
  const planning = record(value, path, bag);
  if (planning === undefined) return undefined;
  rejectUnknown(planning, ["max_repository_tool_calls", "token_budget"], path, bag);
  const maxRepositoryToolCalls = positiveInteger(planning.max_repository_tool_calls, pointer(path, "max_repository_tool_calls"), bag);
  const token = record(planning.token_budget, pointer(path, "token_budget"), bag);
  if (token !== undefined) rejectUnknown(token, ["metric", "limit", "synthesis_reserve", "on_exhausted"], pointer(path, "token_budget"), bag);
  const metric = enumText(token?.metric, `${path}/token_budget/metric`, ["new_tokens"] as const, bag);
  const limit = positiveInteger(token?.limit, `${path}/token_budget/limit`, bag);
  const synthesisReserve = positiveInteger(token?.synthesis_reserve, `${path}/token_budget/synthesis_reserve`, bag);
  const onExhausted = enumText(token?.on_exhausted, `${path}/token_budget/on_exhausted`, ["force_synthesis"] as const, bag);
  if (limit !== undefined && synthesisReserve !== undefined && synthesisReserve >= limit) bag.error("configuration.planning_token_policy", `${path}/token_budget/synthesis_reserve`, "synthesis reserve must be smaller than the token limit");
  if ([maxRepositoryToolCalls, metric, limit, synthesisReserve, onExhausted].some((item) => item === undefined) || synthesisReserve! >= limit!) return undefined;
  return {
    maxRepositoryToolCalls: maxRepositoryToolCalls!,
    tokenPolicy: { metric: metric!, limit: limit!, synthesisReserve: synthesisReserve!, synthesisThreshold: limit! - synthesisReserve!, onExhausted: onExhausted! },
  };
}

/**
 * Operator-owned worktree bootstrap (for example a dependency install) executed once after a
 * run/ticket worktree is materialized, so configured proof commands can resolve their toolchain
 * in fresh checkouts without manual preparation.
 */
function compileWorkspace(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): CompiledWorkspaceBehavior | undefined {
  if (value === undefined) return undefined;
  const workspace = record(value, path, bag);
  if (workspace === undefined) return undefined;
  rejectUnknown(workspace, ["bootstrap"], path, bag);
  const bootstrap = record(workspace.bootstrap, pointer(path, "bootstrap"), bag);
  if (bootstrap === undefined) return undefined;
  rejectUnknown(bootstrap, ["argv", "timeout_seconds"], pointer(path, "bootstrap"), bag);
  const argvValue = bootstrap.argv;
  const argv = Array.isArray(argvValue) && argvValue.length >= 1 && argvValue.length <= 32 &&
      argvValue.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 1_024)
    ? argvValue.map((item) => String(item))
    : undefined;
  if (argv === undefined) {
    bag.error("configuration.workspace_bootstrap", pointer(path, "bootstrap"), "bootstrap argv must be 1-32 bounded strings");
  }
  const timeoutSeconds = bootstrap.timeout_seconds === undefined
    ? 600
    : positiveInteger(bootstrap.timeout_seconds, `${path}/bootstrap/timeout_seconds`, bag);
  if (timeoutSeconds !== undefined && timeoutSeconds > 3_600) {
    bag.error("configuration.workspace_bootstrap", `${path}/bootstrap/timeout_seconds`, "bootstrap timeout must not exceed 3600 seconds");
    return undefined;
  }
  if (argv === undefined || timeoutSeconds === undefined) return undefined;
  return { bootstrap: { argv, timeoutMs: timeoutSeconds * 1_000 } };
}

function compileRoles(
  value: ConfigurationValue | undefined,
  path: string,
  agents: ReadonlyMap<string, CompiledAgentResource>,
  personas: ReadonlyMap<string, ConfigurationObject>,
  bag: DiagnosticBag,
): readonly CompiledAgentRoleBehavior[] {
  const config = record(value, path, bag);
  if (config === undefined) return [];
  rejectUnknown(config, ["roles", "personas"], path, bag);
  const roles = record(config.roles, pointer(path, "roles"), bag);
  const overrides = record(config.personas, pointer(path, "personas"), bag);
  if (overrides !== undefined && Object.keys(overrides).length > 0) bag.error("configuration.persona_override", pointer(path, "personas"), "run-type persona overrides are not supported; configure shared persona resources or role defaults");
  if (roles === undefined) return [];
  const output: CompiledAgentRoleBehavior[] = [];
  for (const id of Object.keys(roles).sort(compareUtf8)) {
    const rolePath = pointer(pointer(path, "roles"), id);
    const role = record(roles[id], rolePath, bag);
    if (role === undefined) continue;
    rejectUnknown(role, ["provider", "model", "thinking_level"], rolePath, bag);
    const model = text(role.model, pointer(rolePath, "model"), bag);
    const thinkingLevel = text(role.thinking_level, pointer(rolePath, "thinking_level"), bag);
    if (thinkingLevel !== undefined && !THINKING_LEVELS.has(thinkingLevel)) bag.error("configuration.thinking_level", pointer(rolePath, "thinking_level"), `unsupported Pi thinking level ${thinkingLevel}`);
    const provider = role.provider === undefined ? providerForRole(id, agents, personas, rolePath, bag) : text(role.provider, pointer(rolePath, "provider"), bag);
    if (model !== undefined && thinkingLevel !== undefined && THINKING_LEVELS.has(thinkingLevel) && provider !== undefined) output.push({
      id, title: titleCase(id), provider, model,
      thinkingLevel: thinkingLevel as CompiledAgentRoleBehavior["thinkingLevel"],
    });
  }
  return output;
}

function providerForRole(
  roleId: string,
  agents: ReadonlyMap<string, CompiledAgentResource>,
  personas: ReadonlyMap<string, ConfigurationObject>,
  path: string,
  bag: DiagnosticBag,
): string | undefined {
  const providers = new Set<string>();
  for (const persona of personas.values()) {
    if (persona.model_role !== roleId || typeof persona.agent !== "string") continue;
    const provider = agents.get(persona.agent)?.document.provider;
    if (typeof provider === "string" && provider.length > 0) providers.add(provider);
  }
  if (providers.size !== 1) {
    bag.error("configuration.role_provider", pointer(path, "provider"), providers.size === 0
      ? `role ${roleId} has no provider and no persona agent can supply one`
      : `role ${roleId} resolves to multiple providers: ${[...providers].sort(compareUtf8).join(", ")}`);
    return undefined;
  }
  return [...providers][0];
}

function actionSelector(value: ConfigurationValue | undefined, path: string, actions: CompiledActionCatalog, bag: DiagnosticBag): string | undefined {
  const selector = text(value, path, bag);
  if (selector !== undefined && actions.aliases[selector] === undefined) bag.error("configuration.dangling_reference", path, `action ${selector} is not configured`);
  return selector === undefined ? undefined : actions.aliases[selector];
}

function compileLeadJudgment(
  actionId: string,
  triggers: readonly LeadJudgmentTrigger[],
  maxBoundariesPerAttempt: 1,
  actions: CompiledActionCatalog,
  agents: ReadonlyMap<string, CompiledAgentResource>,
  personas: ReadonlyMap<string, ConfigurationObject>,
  roles: readonly CompiledAgentRoleBehavior[],
  path: string,
  bag: DiagnosticBag,
): CompiledLeadJudgmentBehavior | undefined {
  const action = actions.actions[actionId];
  if (action === undefined) {
    bag.error("configuration.lead_action", path, `lead action ${actionId} is not configured`);
    return undefined;
  }
  let valid = true;
  const reject = (code: string, message: string): void => {
    valid = false;
    bag.error(code, path, message);
  };
  if (action.actor !== "compiler") reject("configuration.lead_action_actor", "lead judgment action must be invoked by the compiler");
  if (action.checkout !== "main") reject("configuration.lead_action_checkout", "lead judgment action must use the read-only main checkout");
  if (action.parameters.length > 0 || action.allowedTicketStates.length > 0) {
    reject("configuration.lead_action_scope", "lead judgment action must not accept parameters or depend on ticket state");
  }
  const spawns = action.recipe.filter((step) => step.primitive === "agent.spawn");
  if (spawns.length !== 1) reject("configuration.lead_action_spawn", "lead judgment action must contain exactly one agent.spawn step");
  if (!action.compensation.some((step) => step.primitive === "agent.stop" && step.arguments.target === "spawned_process_group")) {
    reject("configuration.lead_action_compensation", "lead judgment action must stop its spawned process group during compensation");
  }
  const spawn = spawns[0];
  const personaId = typeof spawn?.arguments.persona === "string" ? spawn.arguments.persona : undefined;
  const prompt = typeof spawn?.arguments.prompt === "string" ? spawn.arguments.prompt : undefined;
  if (personaId === undefined || spawn?.arguments.persona_from !== undefined || spawn?.arguments.ticket !== undefined) {
    reject("configuration.lead_action_persona", "lead judgment action must name one literal run-level persona");
  }
  if (prompt === undefined || prompt.trim().length === 0) {
    reject("configuration.lead_action_prompt", "lead judgment action must provide a bounded prompt");
  } else if (/pull\s+loop|until\s+(?:the\s+)?compiler-verifiable\s+terminal|poll(?:ing)?\s+(?:the\s+)?(?:board|tickets?)/iu.test(prompt)) {
    reject("configuration.lead_action_unbounded", "lead judgment prompt must request one bounded judgment, not deterministic polling or a pull loop");
  }
  if (spawn?.arguments.transport !== "compiler_broker" || spawn.arguments.duplicate_policy !== "reject") {
    reject("configuration.lead_action_transport", "lead judgment must use compiler_broker transport with duplicate rejection");
  }
  const persona = personaId === undefined ? undefined : personas.get(personaId);
  const roleId = typeof persona?.model_role === "string" ? persona.model_role : undefined;
  if (persona === undefined || roleId === undefined) {
    reject("configuration.lead_action_persona", `lead judgment persona ${personaId ?? "<missing>"} has no configured model role`);
  } else if (!roles.some((role) => role.id === roleId)) {
    reject("configuration.lead_action_role", `lead judgment role ${roleId} has no run-type model selection`);
  }
  const capabilities = isRecord(persona?.capabilities) ? persona.capabilities : undefined;
  if (capabilities?.workspace_access !== "read_only" || capabilities.commands !== "read_only") {
    reject("configuration.lead_action_authority", "lead judgment persona must have read-only workspace and command capabilities");
  }
  const agentId = typeof persona?.agent === "string" ? persona.agent : undefined;
  const agent = agentId === undefined ? undefined : agents.get(agentId);
  const instructionRecord = isRecord(agent?.document.instructions) ? agent.document.instructions : undefined;
  const instructionText = instructionRecord?.source === "inline" && typeof instructionRecord.text === "string"
    ? instructionRecord.text
    : undefined;
  if (agent === undefined || instructionText === undefined) {
    reject("configuration.lead_agent_contract", "lead judgment persona must resolve to one inline, compiler-visible agent instruction contract");
  } else {
    if (/pull\s+loop|\bkoni_runtime\b|\bwait_worker\b|\byield_lead\b/iu.test(instructionText)) {
      reject("configuration.lead_agent_unbounded", "lead agent instructions still reference the removed deterministic pull-loop runtime protocol");
    }
    if (!/\bkoni_submit_output\b/u.test(instructionText) ||
        !/\bproceed\b/iu.test(instructionText) || !/\bblocked\b/iu.test(instructionText) ||
        !/koni\.lead-judgment-output\.v1/u.test(instructionText)) {
      reject("configuration.lead_agent_contract", "lead agent instructions must name the exact bounded terminal tool, protocol, and dispositions");
    }
  }
  if (!valid || personaId === undefined || roleId === undefined || prompt === undefined) return undefined;
  return deepFreeze({
    protocol: LEAD_JUDGMENT_PROTOCOL,
    actionId,
    personaId,
    roleId,
    prompt,
    triggers: [...triggers],
    maxBoundariesPerAttempt,
    terminal: {
      protocol: LEAD_JUDGMENT_OUTPUT_PROTOCOL,
      dispositions: ["proceed", "blocked"],
    },
  });
}

export interface NormalizedRunIntake {
  readonly objective: string;
  readonly values: ConfigurationObject;
}

/** Admission helper: each semantic trigger may issue at most one fresh Lead attempt. */
export function shouldIssueLeadJudgment(
  behavior: CompiledRunTypeBehavior,
  trigger: LeadJudgmentTrigger,
  priorTriggers: readonly LeadJudgmentTrigger[],
): boolean {
  if (!behavior.leadJudgment.triggers.includes(trigger)) return false;
  for (const prior of priorTriggers) {
    if (!behavior.leadJudgment.triggers.includes(prior)) {
      throw new BehaviorInputError("lead_trigger", `durable lead history contains unsupported trigger ${prior}`);
    }
  }
  const occurrences = priorTriggers.filter((prior) => prior === trigger).length;
  if (occurrences > 1) throw new BehaviorInputError("lead_replay", `lead judgment trigger ${trigger} was issued more than once`);
  return occurrences === 0;
}

function compileLeadTriggers(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): readonly LeadJudgmentTrigger[] {
  // Absence preserves the v1 behavior of already-authored profiles. An explicit empty list is a
  // deliberate opt-out for profiles whose compiler owns deterministic scheduling and deadlocks.
  if (value === undefined) return [...LEAD_JUDGMENT_TRIGGERS];
  const configured = uniqueTextList(value, path, bag);
  const output: LeadJudgmentTrigger[] = [];
  configured.forEach((trigger, index) => {
    if (!LEAD_JUDGMENT_TRIGGERS.includes(trigger as LeadJudgmentTrigger)) {
      bag.error(
        "configuration.lead_trigger",
        pointer(path, index),
        `unsupported Lead judgment trigger ${trigger}`,
      );
      return;
    }
    output.push(trigger as LeadJudgmentTrigger);
  });
  return output;
}

/** Strict terminal decoder shared by the authority and focused tests. */
export function parseLeadJudgmentOutput(value: unknown): LeadJudgmentOutput {
  if (!isRecord(value)) throw new BehaviorInputError("lead_output", "lead judgment output must be an object");
  const keys = Object.keys(value).sort(compareUtf8);
  if (keys.join("\u0000") !== ["disposition", "protocol", "summary"].sort(compareUtf8).join("\u0000")) {
    throw new BehaviorInputError("lead_output", "lead judgment output has missing or unknown fields");
  }
  if (value.protocol !== LEAD_JUDGMENT_OUTPUT_PROTOCOL) {
    throw new BehaviorInputError("lead_output_protocol", "lead judgment output protocol is missing or unsupported");
  }
  if (value.disposition !== "proceed" && value.disposition !== "blocked") {
    throw new BehaviorInputError("lead_output_disposition", "lead judgment disposition must be proceed or blocked");
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0 ||
      Buffer.byteLength(value.summary, "utf8") > 4_096 || value.summary.includes("\u0000")) {
    throw new BehaviorInputError("lead_output_summary", "lead judgment summary must be nonempty, NUL-free, and at most 4096 bytes");
  }
  return deepFreeze({
    protocol: LEAD_JUDGMENT_OUTPUT_PROTOCOL,
    disposition: value.disposition,
    summary: value.summary.trim(),
  });
}

export function normalizeRunIntake(
  behavior: CompiledRunTypeBehavior,
  supplied: ConfigurationObject,
): NormalizedRunIntake {
  const fields = new Map(behavior.intake.map((field) => [field.id, field] as const));
  for (const id of Object.keys(supplied)) if (!fields.has(id)) throw new BehaviorInputError("intake_unknown", `run type ${behavior.id} does not accept intake field ${id}`);
  const values: Record<string, ConfigurationValue> = Object.create(null) as Record<string, ConfigurationValue>;
  for (const field of behavior.intake) {
    const candidate = supplied[field.id] ?? field.default;
    if (candidate === undefined || candidate === null || candidate === "") {
      if (field.required) throw new BehaviorInputError("intake_required", `${field.label} is required`);
      continue;
    }
    if (!matchesIntakeValue(candidate, field.kind, field.options)) throw new BehaviorInputError("intake_type", `${field.label} does not match ${field.kind}`);
    values[field.id] = structuredClone(candidate);
  }
  const objective = values[behavior.objectiveFieldId];
  if (typeof objective !== "string" || objective.trim().length === 0) throw new BehaviorInputError("objective_required", "run objective is required");
  let encoded: string;
  try {
    encoded = canonicalEncode(values);
  } catch (error) {
    throw new BehaviorInputError("intake_canonical", error instanceof Error ? error.message : String(error));
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_RUN_INTAKE_BYTES) throw new BehaviorInputError("intake_size", `run intake exceeds ${MAX_RUN_INTAKE_BYTES} bytes`);
  return deepFreeze({ objective: objective.trim(), values });
}

export function configuredQuestionDisposition(
  behavior: CompiledRunTypeBehavior,
  questions: readonly QuestionPolicyInput[],
): QuestionPolicyDisposition & { readonly defaultScope: "run" | "ticket" } {
  return { ...questionPolicyDisposition(behavior.questions.policy, questions), defaultScope: behavior.questions.defaultScope };
}

/** `auto_start` applies only after approval; intake, planning, questions, and approval still run. */
export function postApprovalDisposition(behavior: CompiledRunTypeBehavior): "supervise_execution" | "pause_before_execution" {
  return behavior.autoStart ? "supervise_execution" : "pause_before_execution";
}

export function planningTokenDisposition(
  behavior: CompiledRunTypeBehavior,
  newTokens: number,
): "continue" | "force_synthesis" | "exhausted" {
  if (!Number.isSafeInteger(newTokens) || newTokens < 0) throw new BehaviorInputError("token_usage", "new-token usage must be a nonnegative safe integer");
  const policy = behavior.planning?.tokenPolicy;
  if (policy === undefined) throw new BehaviorInputError("planning_policy", `run type ${behavior.id} has no planning token policy`);
  if (newTokens >= policy.limit) return "exhausted";
  if (newTokens >= policy.synthesisThreshold) return policy.onExhausted;
  return "continue";
}

/** Typed scheduler seam; authority applies run maxParallel as a profile-bounded ceiling. */
export function effectiveOrchestrationPolicy(
  profile: CompiledBehaviorIr["profile"],
  run: CompiledRunTypeBehavior,
): Readonly<{
  maxParallel: number;
  maxBoundariesPerLead: 1;
  disjointScopeParallelism: boolean;
}> {
  return deepFreeze({
    maxParallel: Math.min(profile.orchestration.maxParallel, run.maxParallel),
    maxBoundariesPerLead: profile.orchestration.maxBoundariesPerLead,
    disjointScopeParallelism: profile.orchestration.disjointScopeParallelism,
  });
}

export function resolveRunBehavior(configuration: Readonly<{ behavior: CompiledBehaviorIr }>, runTypeId: string): CompiledRunTypeBehavior {
  const behavior = configuration.behavior.runTypes[runTypeId];
  if (behavior === undefined) throw new BehaviorInputError("run_type_unknown", `run type ${runTypeId} is not configured`);
  return behavior;
}

export class BehaviorInputError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "BehaviorInputError";
  }
}

function matchesIntakeValue(value: ConfigurationValue, kind: IntakeFieldKind, options: readonly CompiledIntakeOption[]): boolean {
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  if (kind === "json") return true;
  if (kind === "multi_choice") return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && options.some((option) => option.value === item));
  if (typeof value !== "string") return false;
  if (kind === "path") return value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..");
  if (kind === "choice") return options.some((option) => option.value === value);
  return value.trim().length > 0;
}

function record(value: ConfigurationValue | undefined, path: string, bag: DiagnosticBag): ConfigurationObject | undefined {
  if (!isRecord(value)) {
    bag.error("configuration.field_type", path, "value must be a mapping");
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is ConfigurationObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(value: ConfigurationObject, allowed: readonly string[], path: string, bag: DiagnosticBag): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) bag.error("configuration.unknown_field", pointer(path, key), "field is not supported");
}

function text(value: ConfigurationValue | undefined, path: string, bag: DiagnosticBag): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    bag.error("configuration.field_type", path, "value must be a nonempty string");
    return undefined;
  }
  return value;
}

function booleanValue(value: ConfigurationValue | undefined, path: string, bag: DiagnosticBag): boolean | undefined {
  if (typeof value !== "boolean") {
    bag.error("configuration.field_type", path, "value must be boolean");
    return undefined;
  }
  return value;
}

function positiveInteger(value: ConfigurationValue | undefined, path: string, bag: DiagnosticBag): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    bag.error("configuration.field_type", path, "value must be a positive safe integer");
    return undefined;
  }
  return value;
}

function uniqueTextList(value: ConfigurationValue | undefined, path: string, bag: DiagnosticBag): readonly string[] {
  if (!Array.isArray(value)) {
    bag.error("configuration.field_type", path, "value must be a string list");
    return [];
  }
  const output: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const candidate = text(item, pointer(path, index), bag);
    if (candidate === undefined) return;
    if (seen.has(candidate)) bag.error("configuration.duplicate_value", pointer(path, index), `value ${candidate} is duplicated`);
    else { seen.add(candidate); output.push(candidate); }
  });
  return output;
}

function enumText<const Values extends readonly string[]>(value: ConfigurationValue | undefined, path: string, values: Values, bag: DiagnosticBag): Values[number] | undefined {
  const candidate = text(value, path, bag);
  if (candidate !== undefined && !values.includes(candidate)) {
    bag.error("configuration.enum", path, `value must be one of ${values.join(", ")}`);
    return undefined;
  }
  return candidate as Values[number] | undefined;
}

function titleCase(value: string): string {
  return value.split(/[-_]/u).map((part) => part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
