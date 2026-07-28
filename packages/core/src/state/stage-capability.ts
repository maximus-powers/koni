import { Buffer } from "node:buffer";

/**
 * Versioned, read-only projection of compiler-authored stage controls.
 *
 * This document is not an execution grant. The authority must derive it again from current
 * compiler/lifecycle state and call `validateStageActionInvocation` before dispatching an effect.
 */
export const STAGE_CAPABILITY_CATALOG_PROTOCOL = "koni.stage-capability-catalog.v1" as const;
export const STAGE_ACTION_INVOCATION_PROTOCOL = "koni.stage-action-invocation.v1" as const;

export const STAGE_CAPABILITY_LIMITS = Object.freeze({
  stages: 256,
  actionsPerStage: 64,
  runActions: 64,
  fieldsPerAction: 64,
  optionsPerField: 256,
  stringListItems: 256,
  idBytes: 192,
  titleBytes: 16 * 1024,
  descriptionBytes: 128 * 1024,
  fieldValueBytes: 1024 * 1024,
  catalogBytes: 16 * 1024 * 1024,
  invocationBytes: 2 * 1024 * 1024,
});

export const STAGE_ACTION_INTENTS = [
  "plan_run",
  "approve_run",
  "authorize_promotion",
  "resume_planning",
  "revise_run_plan",
  "answer_question",
  "revise_question",
  "resolve_questions",
  "execute_action",
  "update_orchestration",
  "set_run_running",
  "pause_run",
  "resume_run",
  "retry_blocked",
  "retire_provider_exposure",
  "retry_terminal_resolver",
  "inspect_run_deletion",
  "delete_run",
  "inspect_run_merge",
  "authorize_merge",
  "start_external_loop",
  "drive_external_loop",
  "drive_stage",
  "supervise_run",
  "retry_supervised_stage",
] as const;

export type StageActionIntent = (typeof STAGE_ACTION_INTENTS)[number];

export type StageCapabilityStatus =
  "pending" | "active" | "waiting" | "blocked" | "failed" | "succeeded" | "skipped";

export type StageInteractionMode = "none" | "automatic" | "operator";
export type StageActionScope =
  "run" | "stage" | "ticket" | "attempt" | "question_batch" | "configured_action";
export type StageActionSurface =
  | "immediate"
  | "plan_review"
  | "question_dialog"
  | "action_form"
  | "delete_dialog"
  | "merge_dialog";
export type StageActionConfirmationTone = "routine" | "caution" | "destructive";
export type StageActionFieldKind =
  "text" | "multiline" | "integer" | "number" | "boolean" | "select" | "string_list";
export type StageActionFieldVisibility = "shown" | "summary" | "hidden";
export type StageActionValue = string | number | boolean | string[];

export interface StageCapabilityBinding {
  runId: string;
  runRevision: number;
  generation: number;
  phase: string;
}

export interface StageActionAvailability {
  state: "available" | "disabled";
  /** Human-readable compiler/authority reason. Disabled actions must never rely on UI inference. */
  reason: string;
}

export type StageActionConfirmation =
  | { required: false }
  | {
      required: true;
      tone: StageActionConfirmationTone;
      title: string;
      description: string;
      confirmLabel: string;
    };

export interface StageActionFieldOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * A deliberately bounded action form language. `lockedValue` is compiler-authored context, not
 * operator input. `displayValue` may provide a safe semantic label while the raw value stays
 * hidden. The authority still re-resolves contextual bindings before executing an effect.
 */
export interface StageActionFieldSchema {
  key: string;
  label: string;
  description: string;
  kind: StageActionFieldKind;
  required: boolean;
  locked: boolean;
  visibility: StageActionFieldVisibility;
  defaultValue?: StageActionValue;
  lockedValue?: StageActionValue;
  displayValue?: string;
  options?: readonly StageActionFieldOption[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxBytes?: number;
}

export interface StageActionFormSchema {
  title: string;
  description: string;
  submitLabel: string;
  fields: readonly StageActionFieldSchema[];
}

export interface StageActionCapability {
  /** Opaque compiler-owned identity, unique within one catalog revision. */
  id: string;
  intent: StageActionIntent;
  scope: StageActionScope;
  title: string;
  description: string;
  surface: StageActionSurface;
  availability: StageActionAvailability;
  confirmation: StageActionConfirmation;
  form?: StageActionFormSchema;
}

export interface StageInteractionCapability {
  mode: StageInteractionMode;
  reason: string;
  /** Enter/default activation target. It may be disabled; its reason is then shown verbatim. */
  primaryActionId?: string;
}

export interface StageCapability {
  id: string;
  title: string;
  kind: string;
  category: string;
  position: number;
  status: StageCapabilityStatus;
  current: boolean;
  summary?: string;
  interaction: StageInteractionCapability;
  actions: readonly StageActionCapability[];
}

export interface StageCapabilityCatalog {
  protocol: typeof STAGE_CAPABILITY_CATALOG_PROTOCOL;
  binding: StageCapabilityBinding;
  stages: readonly StageCapability[];
  /** Run-wide controls such as pause, resume, deletion, questions, and merge authorization. */
  runActions: readonly StageActionCapability[];
}

export interface StageActionInvocation {
  protocol: typeof STAGE_ACTION_INVOCATION_PROTOCOL;
  runId: string;
  runRevision: number;
  generation: number;
  capabilityId: string;
  confirmed: boolean;
  values: Readonly<Record<string, StageActionValue>>;
}

export interface ValidatedStageActionInvocation {
  binding: StageCapabilityBinding;
  capability: StageActionCapability;
  /** Includes validated operator values plus exact compiler-authored values for locked fields. */
  values: Readonly<Record<string, StageActionValue>>;
}

export interface DefineBuiltInStageActionInput {
  id: string;
  intent: StageActionIntent;
  available: boolean;
  reason: string;
  title?: string;
  description?: string;
  scope?: StageActionScope;
  surface?: StageActionSurface;
  confirmation?: StageActionConfirmation;
  form?: StageActionFormSchema;
}

export interface DefineStageInteractionInput {
  mode: StageInteractionMode;
  reason: string;
  actions: readonly StageActionCapability[];
  primaryActionId?: string;
}

export class StageCapabilityValidationError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "StageCapabilityValidationError";
    this.path = path;
  }
}

export class StageActionInvocationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "StageActionInvocationError";
    this.code = code;
  }
}

/** Validate and clone one compiler-authored catalog without reordering its semantic pipeline. */
export function defineStageCapabilityCatalog(
  input: StageCapabilityCatalog,
): StageCapabilityCatalog {
  const result = structuredClone(input);
  assertStageCapabilityCatalog(result);
  return result;
}

/** Validate and clone one stage before composing it into a catalog. */
export function defineStageCapability(input: StageCapability): StageCapability {
  const result = structuredClone(input);
  assertStageCapability(result, "$", new Set());
  return result;
}

/**
 * Create one built-in action while requiring the compiler/authority caller to state availability
 * explicitly. Defaults cover the native Koni lifecycle but never infer permission from phase text.
 */
export function defineBuiltInStageAction(
  input: DefineBuiltInStageActionInput,
): StageActionCapability {
  const defaults = BUILT_IN_ACTION_DEFAULTS[input.intent];
  const capability: StageActionCapability = {
    id: input.id,
    intent: input.intent,
    scope: input.scope ?? defaults.scope,
    title: input.title ?? defaults.title,
    description: input.description ?? defaults.description,
    surface: input.surface ?? defaults.surface,
    availability: {
      state: input.available ? "available" : "disabled",
      reason: input.reason,
    },
    confirmation: input.confirmation ?? defaults.confirmation,
    ...(input.form === undefined ? {} : { form: input.form }),
  };
  assertStageActionCapability(capability);
  return structuredClone(capability);
}

/** Derive a stage's interaction mode from explicit compiler-owned actions and a preferred action. */
export function defineStageInteraction(
  input: DefineStageInteractionInput,
): StageInteractionCapability {
  const interaction: StageInteractionCapability = {
    mode: input.mode,
    reason: input.reason,
    ...(input.primaryActionId === undefined ? {} : { primaryActionId: input.primaryActionId }),
  };
  assertStageInteraction(interaction, input.actions, "$.interaction");
  return structuredClone(interaction);
}

/** Fail-closed parser for authority, persistence, and UI transport boundaries. */
export function assertStageCapabilityCatalog(
  value: unknown,
): asserts value is StageCapabilityCatalog {
  assertJsonSize(value, "$", STAGE_CAPABILITY_LIMITS.catalogBytes);
  const root = requiredRecord(value, "$", ["protocol", "binding", "stages", "runActions"]);
  if (root.protocol !== STAGE_CAPABILITY_CATALOG_PROTOCOL) {
    fail("$.protocol", `must equal ${STAGE_CAPABILITY_CATALOG_PROTOCOL}`);
  }
  const binding = requiredRecord(root.binding, "$.binding", [
    "runId",
    "runRevision",
    "generation",
    "phase",
  ]);
  assertId(binding.runId, "$.binding.runId");
  assertNonnegativeSafeInteger(binding.runRevision, "$.binding.runRevision");
  assertNonnegativeSafeInteger(binding.generation, "$.binding.generation");
  assertSingleLine(binding.phase, "$.binding.phase", STAGE_CAPABILITY_LIMITS.idBytes);

  if (!Array.isArray(root.stages) || root.stages.length > STAGE_CAPABILITY_LIMITS.stages) {
    fail("$.stages", `must contain at most ${STAGE_CAPABILITY_LIMITS.stages} stages`);
  }
  if (
    !Array.isArray(root.runActions) ||
    root.runActions.length > STAGE_CAPABILITY_LIMITS.runActions
  ) {
    fail("$.runActions", `must contain at most ${STAGE_CAPABILITY_LIMITS.runActions} actions`);
  }

  const stageIds = new Set<string>();
  const actionIds = new Set<string>();
  let currentStages = 0;
  let lastPosition = -1;
  root.stages.forEach((stage, index) => {
    const path = `$.stages[${index}]`;
    const record = assertStageCapability(stage, path, actionIds);
    if (stageIds.has(record.id)) fail(`${path}.id`, `duplicates stage ${record.id}`);
    stageIds.add(record.id);
    if (record.current) currentStages += 1;
    if (record.position <= lastPosition)
      fail(`${path}.position`, "must increase strictly in pipeline order");
    lastPosition = record.position;
  });
  if (currentStages > 1) fail("$.stages", "must contain at most one current stage");
  root.runActions.forEach((action, index) => {
    const path = `$.runActions[${index}]`;
    const record = assertStageActionCapabilityRecord(action, path);
    if (actionIds.has(record.id)) fail(`${path}.id`, `duplicates action ${record.id}`);
    actionIds.add(record.id);
  });
}

export function assertStageActionCapability(
  value: unknown,
  path = "$",
): asserts value is StageActionCapability {
  assertStageActionCapabilityRecord(value, path);
}

/** Find an action by opaque identity without treating its title as authority. */
export function findStageActionCapability(
  catalog: StageCapabilityCatalog,
  capabilityId: string,
): StageActionCapability | undefined {
  assertStageCapabilityCatalog(catalog);
  return allActions(catalog).find((action) => action.id === capabilityId);
}

/**
 * Revalidate a UI intent against the current, freshly derived catalog. This validates only the
 * intent boundary; the authority remains responsible for dispatch, CAS, receipts, and effects.
 */
export function validateStageActionInvocation(
  catalogValue: unknown,
  invocationValue: unknown,
): ValidatedStageActionInvocation {
  assertStageCapabilityCatalog(catalogValue);
  const catalog = catalogValue;
  const invocation = assertInvocation(invocationValue);
  if (invocation.runId !== catalog.binding.runId) {
    throw new StageActionInvocationError("wrong_run", "stage action belongs to another run");
  }
  if (invocation.runRevision !== catalog.binding.runRevision) {
    throw new StageActionInvocationError(
      "stale_revision",
      `stage action expected run revision ${invocation.runRevision}, current revision is ${catalog.binding.runRevision}`,
    );
  }
  if (invocation.generation !== catalog.binding.generation) {
    throw new StageActionInvocationError(
      "stale_generation",
      `stage action expected generation ${invocation.generation}, current generation is ${catalog.binding.generation}`,
    );
  }
  const capability = allActions(catalog).find((action) => action.id === invocation.capabilityId);
  if (capability === undefined) {
    throw new StageActionInvocationError(
      "unknown_capability",
      "stage action is no longer compiler-authorized",
    );
  }
  if (capability.availability.state !== "available") {
    throw new StageActionInvocationError("disabled", capability.availability.reason);
  }
  if (capability.confirmation.required && !invocation.confirmed) {
    throw new StageActionInvocationError(
      "confirmation_required",
      capability.confirmation.description,
    );
  }
  const values = validateActionValues(capability, invocation.values);
  return {
    binding: structuredClone(catalog.binding),
    capability: structuredClone(capability),
    values,
  };
}

interface BuiltInActionDefaults {
  title: string;
  description: string;
  scope: StageActionScope;
  surface: StageActionSurface;
  confirmation: StageActionConfirmation;
}

const NO_CONFIRMATION: StageActionConfirmation = Object.freeze({ required: false });

const BUILT_IN_ACTION_DEFAULTS: Readonly<Record<StageActionIntent, BuiltInActionDefaults>> = {
  plan_run: defaults(
    "Start planning",
    "Start the compiler-defined planning workflow.",
    "run",
    "immediate",
  ),
  approve_run: defaults(
    "Approve run",
    "Approve the current durable plan for execution.",
    "run",
    "plan_review",
  ),
  authorize_promotion: defaults(
    "Authorize promotion",
    "Authorize compiler-verified work for promotion to its configured target.",
    "run",
    "merge_dialog",
    confirmation(
      "caution",
      "Authorize promotion",
      "Promote only the reviewed compiler result.",
      "Authorize",
    ),
  ),
  resume_planning: defaults(
    "Resume planning",
    "Resume the compiler-defined planning workflow.",
    "run",
    "immediate",
  ),
  revise_run_plan: defaults(
    "Revise plan",
    "Send steering and request a new durable plan revision.",
    "run",
    "plan_review",
  ),
  answer_question: defaults(
    "Answer question",
    "Save an answer in the current durable question batch.",
    "question_batch",
    "question_dialog",
  ),
  revise_question: defaults(
    "Revise answer",
    "Revise a saved answer before the batch resumes.",
    "question_batch",
    "question_dialog",
  ),
  resolve_questions: defaults(
    "Resolve questions",
    "Seal the answered batch and resume its bound attempt.",
    "question_batch",
    "question_dialog",
  ),
  execute_action: defaults(
    "Run action",
    "Execute the selected compiler-configured action.",
    "configured_action",
    "action_form",
  ),
  update_orchestration: defaults(
    "Update orchestration",
    "Apply compiler-validated run orchestration settings.",
    "run",
    "action_form",
  ),
  set_run_running: defaults(
    "Change run state",
    "Apply the compiler-authorized running or paused intent.",
    "run",
    "immediate",
  ),
  pause_run: defaults(
    "Pause run",
    "Stop new admission and durably settle active work.",
    "run",
    "immediate",
  ),
  resume_run: defaults(
    "Resume run",
    "Resume the durable run from its recorded phase.",
    "run",
    "immediate",
  ),
  retry_blocked: defaults(
    "Retry blocked work",
    "Retry the run from its durable blocked phase.",
    "run",
    "immediate",
  ),
  retire_provider_exposure: defaults(
    "Acknowledge provider error",
    "Retire a canonical failed provider request as uncertain exposure without resuming work.",
    "run",
    "immediate",
    confirmation(
      "caution",
      "Acknowledge provider error",
      "Keep the full failed response and worst-case token reservation, then permit a separate retry action.",
      "Acknowledge provider error",
    ),
  ),
  retry_terminal_resolver: defaults(
    "Retry terminal resolver",
    "Archive the exact failed resolver cycle and reissue it from compiler-bound authority.",
    "ticket",
    "action_form",
    confirmation(
      "caution",
      "Retry terminal resolver",
      "Retry only the displayed failed resolver after reviewing its terminal evidence.",
      "Retry resolver",
    ),
  ),
  inspect_run_deletion: defaults(
    "Review deletion",
    "Inspect live work and Koni-owned Git resources before deletion.",
    "run",
    "delete_dialog",
  ),
  delete_run: defaults(
    "Delete run",
    "Stop every associated session and delete or preserve only the reviewed Koni-owned resources.",
    "run",
    "delete_dialog",
    confirmation(
      "destructive",
      "Delete run",
      "This stops the run and applies the selected Git-resource policy.",
      "Delete run",
    ),
  ),
  inspect_run_merge: defaults(
    "Review merge",
    "Inspect destination drift and compiler evidence before merge authorization.",
    "run",
    "merge_dialog",
  ),
  authorize_merge: defaults(
    "Authorize merge",
    "Authorize the reviewed run result for its pinned target branch.",
    "run",
    "merge_dialog",
    confirmation(
      "caution",
      "Authorize merge",
      "Merge only the reviewed compiler result into the displayed target.",
      "Authorize merge",
    ),
  ),
  start_external_loop: defaults(
    "Start external loop",
    "Start the compiler-defined external stage loop.",
    "stage",
    "immediate",
  ),
  drive_external_loop: defaults(
    "Advance external loop",
    "Advance the active compiler-defined external loop.",
    "stage",
    "immediate",
  ),
  drive_stage: defaults(
    "Run stage",
    "Drive the selected manual or checkpoint stage.",
    "stage",
    "immediate",
  ),
  supervise_run: defaults(
    "Advance workflow",
    "Ask the authority to advance ready automatic work once.",
    "stage",
    "immediate",
  ),
  retry_supervised_stage: defaults(
    "Retry stage",
    "Retry the blocked automatic stage from durable state.",
    "stage",
    "immediate",
  ),
};

function defaults(
  title: string,
  description: string,
  scope: StageActionScope,
  surface: StageActionSurface,
  confirmationValue: StageActionConfirmation = NO_CONFIRMATION,
): BuiltInActionDefaults {
  return { title, description, scope, surface, confirmation: confirmationValue };
}

function confirmation(
  tone: StageActionConfirmationTone,
  title: string,
  description: string,
  confirmLabel: string,
): StageActionConfirmation {
  return { required: true, tone, title, description, confirmLabel };
}

function assertStageCapability(
  value: unknown,
  path: string,
  actionIds: Set<string>,
): StageCapability {
  const stage = requiredRecord(value, path, [
    "id",
    "title",
    "kind",
    "category",
    "position",
    "status",
    "current",
    "summary",
    "interaction",
    "actions",
  ]);
  assertId(stage.id, `${path}.id`);
  assertSingleLine(stage.title, `${path}.title`, STAGE_CAPABILITY_LIMITS.titleBytes);
  assertId(stage.kind, `${path}.kind`);
  assertId(stage.category, `${path}.category`);
  assertNonnegativeSafeInteger(stage.position, `${path}.position`);
  if (!isStageStatus(stage.status)) fail(`${path}.status`, "is not a supported stage status");
  if (typeof stage.current !== "boolean") fail(`${path}.current`, "must be a boolean");
  if (stage.current && (stage.status === "succeeded" || stage.status === "skipped")) {
    fail(`${path}.current`, "a terminal successful or skipped stage cannot be current");
  }
  if (stage.summary !== undefined)
    assertText(stage.summary, `${path}.summary`, STAGE_CAPABILITY_LIMITS.descriptionBytes);
  if (
    !Array.isArray(stage.actions) ||
    stage.actions.length > STAGE_CAPABILITY_LIMITS.actionsPerStage
  ) {
    fail(
      `${path}.actions`,
      `must contain at most ${STAGE_CAPABILITY_LIMITS.actionsPerStage} actions`,
    );
  }
  const actions = stage.actions.map((action, index) => {
    const actionPath = `${path}.actions[${index}]`;
    const record = assertStageActionCapabilityRecord(action, actionPath);
    if (actionIds.has(record.id)) fail(`${actionPath}.id`, `duplicates action ${record.id}`);
    actionIds.add(record.id);
    if (!stage.current && record.availability.state === "available") {
      fail(
        `${actionPath}.availability`,
        "a non-current stage cannot expose an available stage action",
      );
    }
    return record;
  });
  assertStageInteraction(stage.interaction, actions, `${path}.interaction`);
  return stage as unknown as StageCapability;
}

function assertStageInteraction(
  value: unknown,
  actions: readonly StageActionCapability[],
  path: string,
): asserts value is StageInteractionCapability {
  const interaction = requiredRecord(value, path, ["mode", "reason", "primaryActionId"]);
  if (!isInteractionMode(interaction.mode))
    fail(`${path}.mode`, "is not a supported interaction mode");
  assertText(interaction.reason, `${path}.reason`, STAGE_CAPABILITY_LIMITS.descriptionBytes);
  if (interaction.primaryActionId !== undefined)
    assertId(interaction.primaryActionId, `${path}.primaryActionId`);
  if (interaction.mode === "none" && actions.length > 0)
    fail(path, "a no-action stage cannot contain actions");
  if (interaction.mode === "operator" && actions.length === 0)
    fail(path, "an operator stage must contain an action");
  if (interaction.mode === "operator" && interaction.primaryActionId === undefined) {
    fail(`${path}.primaryActionId`, "an operator stage requires a primary action");
  }
  if (
    interaction.primaryActionId !== undefined &&
    !actions.some((action) => action.id === interaction.primaryActionId)
  ) {
    fail(`${path}.primaryActionId`, "must identify an action on this stage");
  }
}

function assertStageActionCapabilityRecord(value: unknown, path: string): StageActionCapability {
  const action = requiredRecord(value, path, [
    "id",
    "intent",
    "scope",
    "title",
    "description",
    "surface",
    "availability",
    "confirmation",
    "form",
  ]);
  assertId(action.id, `${path}.id`);
  if (!STAGE_ACTION_INTENTS.includes(action.intent as StageActionIntent))
    fail(`${path}.intent`, "is not a supported action intent");
  if (!isScope(action.scope)) fail(`${path}.scope`, "is not a supported action scope");
  assertSingleLine(action.title, `${path}.title`, STAGE_CAPABILITY_LIMITS.titleBytes);
  assertText(action.description, `${path}.description`, STAGE_CAPABILITY_LIMITS.descriptionBytes);
  if (!isSurface(action.surface)) fail(`${path}.surface`, "is not a supported action surface");
  const availability = requiredRecord(action.availability, `${path}.availability`, [
    "state",
    "reason",
  ]);
  if (availability.state !== "available" && availability.state !== "disabled") {
    fail(`${path}.availability.state`, "must be available or disabled");
  }
  assertText(
    availability.reason,
    `${path}.availability.reason`,
    STAGE_CAPABILITY_LIMITS.descriptionBytes,
  );
  assertConfirmation(action.confirmation, `${path}.confirmation`);
  if (DESTRUCTIVE_CONFIRMATION_INTENTS.has(action.intent as StageActionIntent)) {
    const confirmationValue = action.confirmation;
    if (!confirmationValue.required)
      fail(`${path}.confirmation`, "this action requires explicit confirmation");
  }
  if (action.form !== undefined) assertForm(action.form, `${path}.form`);
  if (action.surface === "action_form" && action.form === undefined) {
    fail(`${path}.form`, "an action-form surface requires a form schema");
  }
  return action as unknown as StageActionCapability;
}

const DESTRUCTIVE_CONFIRMATION_INTENTS = new Set<StageActionIntent>([
  "authorize_promotion",
  "delete_run",
  "authorize_merge",
]);

function assertConfirmation(
  value: unknown,
  path: string,
): asserts value is StageActionConfirmation {
  const confirmationValue = requiredRecord(value, path, [
    "required",
    "tone",
    "title",
    "description",
    "confirmLabel",
  ]);
  if (typeof confirmationValue.required !== "boolean")
    fail(`${path}.required`, "must be a boolean");
  if (!confirmationValue.required) {
    assertExactKeys(confirmationValue, path, ["required"]);
    return;
  }
  if (!isConfirmationTone(confirmationValue.tone))
    fail(`${path}.tone`, "is not a supported confirmation tone");
  assertSingleLine(confirmationValue.title, `${path}.title`, STAGE_CAPABILITY_LIMITS.titleBytes);
  assertText(
    confirmationValue.description,
    `${path}.description`,
    STAGE_CAPABILITY_LIMITS.descriptionBytes,
  );
  assertSingleLine(
    confirmationValue.confirmLabel,
    `${path}.confirmLabel`,
    STAGE_CAPABILITY_LIMITS.titleBytes,
  );
}

function assertForm(value: unknown, path: string): asserts value is StageActionFormSchema {
  const form = requiredRecord(value, path, ["title", "description", "submitLabel", "fields"]);
  assertSingleLine(form.title, `${path}.title`, STAGE_CAPABILITY_LIMITS.titleBytes);
  assertText(form.description, `${path}.description`, STAGE_CAPABILITY_LIMITS.descriptionBytes);
  assertSingleLine(form.submitLabel, `${path}.submitLabel`, STAGE_CAPABILITY_LIMITS.titleBytes);
  if (!Array.isArray(form.fields) || form.fields.length > STAGE_CAPABILITY_LIMITS.fieldsPerAction) {
    fail(
      `${path}.fields`,
      `must contain at most ${STAGE_CAPABILITY_LIMITS.fieldsPerAction} fields`,
    );
  }
  const keys = new Set<string>();
  form.fields.forEach((field, index) => {
    const fieldPath = `${path}.fields[${index}]`;
    const record = assertField(field, fieldPath);
    if (keys.has(record.key)) fail(`${fieldPath}.key`, `duplicates field ${record.key}`);
    keys.add(record.key);
  });
}

function assertField(value: unknown, path: string): StageActionFieldSchema {
  const field = requiredRecord(value, path, [
    "key",
    "label",
    "description",
    "kind",
    "required",
    "locked",
    "visibility",
    "defaultValue",
    "lockedValue",
    "displayValue",
    "options",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "maxBytes",
  ]);
  assertId(field.key, `${path}.key`);
  assertSingleLine(field.label, `${path}.label`, STAGE_CAPABILITY_LIMITS.titleBytes);
  assertText(field.description, `${path}.description`, STAGE_CAPABILITY_LIMITS.descriptionBytes);
  if (!isFieldKind(field.kind)) fail(`${path}.kind`, "is not a supported field kind");
  if (typeof field.required !== "boolean") fail(`${path}.required`, "must be a boolean");
  if (typeof field.locked !== "boolean") fail(`${path}.locked`, "must be a boolean");
  if (!isVisibility(field.visibility))
    fail(`${path}.visibility`, "is not a supported field visibility");
  if (field.locked && field.lockedValue === undefined)
    fail(`${path}.lockedValue`, "is required for a locked field");
  if (!field.locked && field.lockedValue !== undefined)
    fail(`${path}.lockedValue`, "is only valid for a locked field");
  if (field.locked && field.defaultValue !== undefined)
    fail(`${path}.defaultValue`, "cannot accompany a locked value");
  if (field.visibility === "hidden" && !field.locked)
    fail(`${path}.visibility`, "only a locked field may be hidden");
  if (field.visibility === "summary" && field.displayValue === undefined) {
    fail(`${path}.displayValue`, "is required for a summary field");
  }
  if (field.displayValue !== undefined)
    assertText(field.displayValue, `${path}.displayValue`, STAGE_CAPABILITY_LIMITS.titleBytes);
  const minimum = optionalFinite(field.minimum, `${path}.minimum`);
  const maximum = optionalFinite(field.maximum, `${path}.maximum`);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum)
    fail(path, "minimum exceeds maximum");
  const minItems = optionalNonnegativeSafeInteger(field.minItems, `${path}.minItems`);
  const maxItems = optionalNonnegativeSafeInteger(field.maxItems, `${path}.maxItems`);
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems)
    fail(path, "minItems exceeds maxItems");
  if (maxItems !== undefined && maxItems > STAGE_CAPABILITY_LIMITS.stringListItems) {
    fail(`${path}.maxItems`, `must not exceed ${STAGE_CAPABILITY_LIMITS.stringListItems}`);
  }
  const maxBytes = optionalPositiveSafeInteger(field.maxBytes, `${path}.maxBytes`);
  if (maxBytes !== undefined && maxBytes > STAGE_CAPABILITY_LIMITS.fieldValueBytes) {
    fail(`${path}.maxBytes`, `must not exceed ${STAGE_CAPABILITY_LIMITS.fieldValueBytes}`);
  }
  if (field.options !== undefined) {
    if (field.kind !== "select") fail(`${path}.options`, "are only valid for a select field");
    if (
      !Array.isArray(field.options) ||
      field.options.length < 1 ||
      field.options.length > STAGE_CAPABILITY_LIMITS.optionsPerField
    ) {
      fail(`${path}.options`, `must contain 1-${STAGE_CAPABILITY_LIMITS.optionsPerField} options`);
    }
    const values = new Set<string>();
    field.options.forEach((option, index) => {
      const optionPath = `${path}.options[${index}]`;
      const record = requiredRecord(option, optionPath, ["value", "label", "description"]);
      assertSingleLine(
        record.value,
        `${optionPath}.value`,
        STAGE_CAPABILITY_LIMITS.fieldValueBytes,
      );
      assertSingleLine(record.label, `${optionPath}.label`, STAGE_CAPABILITY_LIMITS.titleBytes);
      if (record.description !== undefined)
        assertText(
          record.description,
          `${optionPath}.description`,
          STAGE_CAPABILITY_LIMITS.descriptionBytes,
        );
      if (values.has(record.value)) fail(`${optionPath}.value`, "duplicates another option");
      values.add(record.value);
    });
  } else if (field.kind === "select") {
    fail(`${path}.options`, "are required for a select field");
  }
  if (
    field.kind !== "number" &&
    field.kind !== "integer" &&
    (minimum !== undefined || maximum !== undefined)
  ) {
    fail(path, "numeric bounds are only valid for numeric fields");
  }
  if (field.kind !== "string_list" && (minItems !== undefined || maxItems !== undefined)) {
    fail(path, "item bounds are only valid for string-list fields");
  }
  if (field.defaultValue !== undefined)
    validateFieldValue(
      field as unknown as StageActionFieldSchema,
      field.defaultValue,
      `${path}.defaultValue`,
    );
  if (field.lockedValue !== undefined)
    validateFieldValue(
      field as unknown as StageActionFieldSchema,
      field.lockedValue,
      `${path}.lockedValue`,
    );
  return field as unknown as StageActionFieldSchema;
}

function assertInvocation(value: unknown): StageActionInvocation {
  try {
    assertJsonSize(value, "$", STAGE_CAPABILITY_LIMITS.invocationBytes);
  } catch (error) {
    if (error instanceof StageCapabilityValidationError) {
      throw new StageActionInvocationError("invalid_invocation", error.message);
    }
    throw error;
  }
  const invocation = requiredRecord(value, "$", [
    "protocol",
    "runId",
    "runRevision",
    "generation",
    "capabilityId",
    "confirmed",
    "values",
  ]);
  if (invocation.protocol !== STAGE_ACTION_INVOCATION_PROTOCOL) {
    throw new StageActionInvocationError(
      "protocol",
      `unsupported stage action invocation protocol ${String(invocation.protocol)}`,
    );
  }
  try {
    assertId(invocation.runId, "$.runId");
    assertNonnegativeSafeInteger(invocation.runRevision, "$.runRevision");
    assertNonnegativeSafeInteger(invocation.generation, "$.generation");
    assertId(invocation.capabilityId, "$.capabilityId");
    if (typeof invocation.confirmed !== "boolean") fail("$.confirmed", "must be a boolean");
    const values = requiredRecord(invocation.values, "$.values", undefined);
    if (Object.keys(values).length > STAGE_CAPABILITY_LIMITS.fieldsPerAction) {
      fail("$.values", `must contain at most ${STAGE_CAPABILITY_LIMITS.fieldsPerAction} values`);
    }
    for (const [key, fieldValue] of Object.entries(values)) {
      assertId(key, `$.values.${key}`);
      assertActionValue(fieldValue, `$.values.${key}`);
    }
  } catch (error) {
    if (error instanceof StageCapabilityValidationError) {
      throw new StageActionInvocationError("invalid_invocation", error.message);
    }
    throw error;
  }
  return invocation as unknown as StageActionInvocation;
}

function validateActionValues(
  capability: StageActionCapability,
  supplied: Readonly<Record<string, StageActionValue>>,
): Readonly<Record<string, StageActionValue>> {
  const fields = capability.form?.fields ?? [];
  const definitions = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(supplied)) {
    if (!definitions.has(key))
      throw new StageActionInvocationError("unknown_field", `action does not accept field ${key}`);
  }
  const values: Record<string, StageActionValue> = {};
  for (const field of fields) {
    if (field.locked) {
      if (
        Object.hasOwn(supplied, field.key) &&
        !valuesEqual(supplied[field.key]!, field.lockedValue!)
      ) {
        throw new StageActionInvocationError(
          "locked_field",
          `field ${field.key} is compiler-bound and cannot be changed`,
        );
      }
      values[field.key] = structuredClone(field.lockedValue!);
      continue;
    }
    const value = supplied[field.key] ?? field.defaultValue;
    if (value === undefined) {
      if (field.required)
        throw new StageActionInvocationError("required_field", `field ${field.key} is required`);
      continue;
    }
    try {
      validateFieldValue(field, value, `$.values.${field.key}`);
    } catch (error) {
      if (error instanceof StageCapabilityValidationError) {
        throw new StageActionInvocationError("invalid_field", error.message);
      }
      throw error;
    }
    values[field.key] = structuredClone(value);
  }
  return values;
}

function validateFieldValue(field: StageActionFieldSchema, value: unknown, path: string): void {
  switch (field.kind) {
    case "text":
    case "multiline":
    case "select": {
      if (typeof value !== "string") fail(path, `must be a ${field.kind} string`);
      const maxBytes = field.maxBytes ?? STAGE_CAPABILITY_LIMITS.fieldValueBytes;
      if (field.required) assertText(value, path, maxBytes);
      else assertOptionalText(value, path, maxBytes);
      if (field.kind === "text" || field.kind === "select") assertNoNewline(value, path);
      if (field.kind === "select" && !field.options?.some((option) => option.value === value)) {
        fail(path, "must identify one of the compiler-authored options");
      }
      return;
    }
    case "integer":
    case "number":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (field.kind === "integer" && !Number.isSafeInteger(value))
      ) {
        fail(path, `must be a finite ${field.kind}`);
      }
      if (field.minimum !== undefined && value < field.minimum)
        fail(path, `must be at least ${field.minimum}`);
      if (field.maximum !== undefined && value > field.maximum)
        fail(path, `must be at most ${field.maximum}`);
      return;
    case "boolean":
      if (typeof value !== "boolean") fail(path, "must be a boolean");
      return;
    case "string_list": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
        fail(path, "must be a string array");
      const minimum = field.minItems ?? (field.required ? 1 : 0);
      const maximum = field.maxItems ?? STAGE_CAPABILITY_LIMITS.stringListItems;
      if (value.length < minimum || value.length > maximum)
        fail(path, `must contain ${minimum}-${maximum} values`);
      const maxBytes = field.maxBytes ?? STAGE_CAPABILITY_LIMITS.fieldValueBytes;
      value.forEach((item, index) => assertText(item, `${path}[${index}]`, maxBytes));
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
        fail(path, `must contain at most ${maxBytes} aggregate UTF-8 bytes`);
      }
      return;
    }
  }
}

function assertActionValue(value: unknown, path: string): asserts value is StageActionValue {
  if (typeof value === "string") {
    assertOptionalText(value, path, STAGE_CAPABILITY_LIMITS.fieldValueBytes);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "must be a finite number");
    return;
  }
  if (typeof value === "boolean") return;
  if (
    Array.isArray(value) &&
    value.length <= STAGE_CAPABILITY_LIMITS.stringListItems &&
    value.every((item) => typeof item === "string")
  ) {
    value.forEach((item, index) =>
      assertText(item, `${path}[${index}]`, STAGE_CAPABILITY_LIMITS.fieldValueBytes),
    );
    return;
  }
  fail(path, "must be a string, finite number, boolean, or bounded string array");
}

function allActions(catalog: StageCapabilityCatalog): StageActionCapability[] {
  return [...catalog.runActions, ...catalog.stages.flatMap((stage) => stage.actions)];
}

function requiredRecord(
  value: unknown,
  path: string,
  keys: readonly string[] | undefined,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, "must be an object");
  const record = value as Record<string, unknown>;
  if (keys !== undefined) assertExactKeys(record, path, keys);
  return record;
}

function assertJsonSize(value: unknown, path: string, maxBytes: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(path, "must be acyclic JSON data");
  }
  if (encoded === undefined) fail(path, "must be JSON data");
  if (Buffer.byteLength(encoded, "utf8") > maxBytes)
    fail(path, `must contain at most ${maxBytes} JSON bytes`);
}

function assertExactKeys(
  record: Record<string, unknown>,
  path: string,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not part of this protocol version");
  }
}

function assertId(value: unknown, path: string): asserts value is string {
  assertSingleLine(value, path, STAGE_CAPABILITY_LIMITS.idBytes);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value))
    fail(path, "must be a safe nonempty identifier");
}

function assertSingleLine(value: unknown, path: string, maxBytes: number): asserts value is string {
  assertText(value, path, maxBytes);
  assertNoNewline(value, path);
}

function assertNoNewline(value: string, path: string): void {
  if (value.includes("\n") || value.includes("\r")) fail(path, "must be a single line");
}

function assertText(value: unknown, path: string, maxBytes: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "must be meaningful text");
  assertOptionalText(value, path, maxBytes);
}

function assertOptionalText(
  value: unknown,
  path: string,
  maxBytes: number,
): asserts value is string {
  if (typeof value !== "string") fail(path, "must be text");
  if (Buffer.byteLength(value, "utf8") > maxBytes)
    fail(path, `must contain at most ${maxBytes} UTF-8 bytes`);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(path, "must contain valid Unicode scalar text");
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) fail(path, "must contain valid Unicode scalar text");
    if (
      (unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) ||
      (unit >= 0x7f && unit <= 0x9f)
    ) {
      fail(path, "must not contain terminal control characters");
    }
  }
}

function assertNonnegativeSafeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(path, "must be a nonnegative safe integer");
}

function optionalNonnegativeSafeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  assertNonnegativeSafeInteger(value, path);
  return value;
}

function optionalPositiveSafeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail(path, "must be a positive safe integer");
  return value;
}

function optionalFinite(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function valuesEqual(left: StageActionValue, right: StageActionValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => item === right[index])
    );
  }
  return left === right;
}

function isStageStatus(value: unknown): value is StageCapabilityStatus {
  return (
    typeof value === "string" &&
    new Set<StageCapabilityStatus>([
      "pending",
      "active",
      "waiting",
      "blocked",
      "failed",
      "succeeded",
      "skipped",
    ]).has(value as StageCapabilityStatus)
  );
}

function isInteractionMode(value: unknown): value is StageInteractionMode {
  return value === "none" || value === "automatic" || value === "operator";
}

function isScope(value: unknown): value is StageActionScope {
  return (
    value === "run" ||
    value === "stage" ||
    value === "ticket" ||
    value === "attempt" ||
    value === "question_batch" ||
    value === "configured_action"
  );
}

function isSurface(value: unknown): value is StageActionSurface {
  return (
    value === "immediate" ||
    value === "plan_review" ||
    value === "question_dialog" ||
    value === "action_form" ||
    value === "delete_dialog" ||
    value === "merge_dialog"
  );
}

function isConfirmationTone(value: unknown): value is StageActionConfirmationTone {
  return value === "routine" || value === "caution" || value === "destructive";
}

function isFieldKind(value: unknown): value is StageActionFieldKind {
  return (
    value === "text" ||
    value === "multiline" ||
    value === "integer" ||
    value === "number" ||
    value === "boolean" ||
    value === "select" ||
    value === "string_list"
  );
}

function isVisibility(value: unknown): value is StageActionFieldVisibility {
  return value === "shown" || value === "summary" || value === "hidden";
}

function fail(path: string, message: string): never {
  throw new StageCapabilityValidationError(path, message);
}
