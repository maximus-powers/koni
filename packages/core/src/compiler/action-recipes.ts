import {
  ACTION_CATALOG_PROTOCOL,
  ACTION_EXECUTION_JOURNAL_PROTOCOL,
  ACTION_EXECUTION_PLAN_PROTOCOL,
  type ActionExecutionJournal,
  type ActionExecutionJournalStep,
  type ActionExecutionPlan,
  type ActionInvocationContext,
  type ActionParameterType,
  type ActionPrimitiveHost,
  type CompiledActionCatalog,
  type CompiledActionDefinition,
  type CompiledActionParameter,
  type CompiledActionStep,
  type PreparedActionStep,
} from "../contracts/behavior.js";
import type { ConfigurationObject, ConfigurationValue } from "../contracts/configuration.js";
import { canonicalEncode, canonicalHash, compareUtf8, rawSha256 } from "../shared/canonical.js";
import {
  DiagnosticBag,
  pointer,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "../shared/diagnostics.js";

export interface ActionSourceRecord {
  readonly id: string;
  readonly path: string;
  readonly document: ConfigurationObject;
}

const ACTION_FIELDS = [
  "id",
  "actor",
  "aliases",
  "params",
  "allowed_ticket_states",
  "requires_main_checkout",
  "requires_ticket_worktree",
  "recipe",
  "compensation",
  "recovery",
] as const;
const PARAMETER_FIELDS = ["type", "required", "description", "default"] as const;
const STEP_FIELDS = new Set(["id", "primitive"]);
const PARAMETER_TYPES = new Set<ActionParameterType>([
  "string",
  "ticket_id",
  "path",
  "json",
  "boolean",
  "integer",
  "number",
]);

type PrimitiveArgumentKind = "string" | "boolean" | "string_list" | "json";
interface PrimitiveArgumentSpec {
  readonly kind: PrimitiveArgumentKind;
  readonly required?: boolean;
  readonly nullable?: boolean;
  readonly values?: readonly string[];
}
interface PrimitiveSpec {
  readonly arguments: Readonly<Record<string, PrimitiveArgumentSpec>>;
  readonly validate?: (
    argumentsValue: ConfigurationObject,
    path: string,
    bag: DiagnosticBag,
  ) => void;
}
const stringArg = (required = false, values?: readonly string[]): PrimitiveArgumentSpec => ({
  kind: "string",
  ...(required ? { required: true } : {}),
  ...(values === undefined ? {} : { values }),
});
const nullableStringArg = (): PrimitiveArgumentSpec => ({ kind: "string", nullable: true });
const boolArg = (): PrimitiveArgumentSpec => ({ kind: "boolean" });
const listArg = (): PrimitiveArgumentSpec => ({ kind: "string_list" });
const jsonArg = (required = false): PrimitiveArgumentSpec => ({
  kind: "json",
  ...(required ? { required: true } : {}),
});

/** Exact typed primitive ABI shared with Koni's Pi-native TypeScript authority effect host. */
export const ACTION_PRIMITIVE_SCHEMAS: Readonly<Record<string, PrimitiveSpec>> = Object.freeze({
  "agent.spawn": {
    arguments: {
      duplicate_policy: stringArg(false, ["reject"]),
      persona: stringArg(),
      persona_from: stringArg(),
      prompt: stringArg(true),
      request_fields: listArg(),
      ticket: stringArg(),
      transport: stringArg(false, ["compiler_broker"]),
    },
  },
  "agent.stop": { arguments: { target: stringArg(true) } },
  "board.render": { arguments: { orchestration_controls: listArg(), view: stringArg() } },
  "check.run": {
    arguments: { check: stringArg(), checks_from_current_step: boolArg(), ticket: stringArg() },
    validate: requireOneOf("check", "checks_from_current_step"),
  },
  "context.compile": {
    arguments: {
      hash_manifest: boolArg(),
      include: listArg(),
      kind: stringArg(),
      step: nullableStringArg(),
      ticket: stringArg(true),
    },
  },
  "event.append": { arguments: { data: jsonArg(), ticket: stringArg(), type: stringArg(true) } },
  "git.commit": { arguments: { message: stringArg(true) } },
  "git.integrate_squash": {
    arguments: {
      message: stringArg(),
      preserve_other_leases: boolArg(),
      retain_closed_worktree: boolArg(),
      ticket: stringArg(true),
    },
  },
  "graph.apply_delta": {
    arguments: {
      authority_from_operation: boolArg(),
      project_only_owned_scope: boolArg(),
      ticket: stringArg(true),
    },
  },
  "graph.inspect": { arguments: {} },
  "graph.validate": { arguments: {} },
  "graph.write": { arguments: { dry_run_first: boolArg(), source: stringArg(true) } },
  "integration.validate": { arguments: { ticket: stringArg() } },
  "lease.acquire": { arguments: { ticket: stringArg(true) } },
  "lease.release": { arguments: { ticket: stringArg(true) } },
  "lock.acquire": { arguments: {} },
  "output.record": {
    arguments: {
      payload: jsonArg(true),
      persona: stringArg(true),
      step: stringArg(true),
      ticket: stringArg(true),
    },
  },
  "output.validate": {
    arguments: {
      concrete_project_relative_file_refs: boolArg(),
      require_context: boolArg(),
      require_product_change_declarations: boolArg(),
      ticket: stringArg(true),
      validate_change_handoffs: boolArg(),
    },
  },
  "profile.validate": { arguments: {} },
  "project.validate": { arguments: {} },
  "receipt.write": {
    arguments: { hash_bind_context: boolArg(), receipt: jsonArg(), receipt_type: stringArg() },
    validate: requireOneOf("receipt", "receipt_type"),
  },
  "recovery.dispatch": {
    arguments: {
      keep_integration_clean: boolArg(),
      mode: stringArg(),
      modes: listArg(),
      never_write_pass_on_failed_checklist: boolArg(),
      preserve_evidence_and_audit: boolArg(),
      preserve_fixpoint_receipt: boolArg(),
      preserve_started_runtime_receipt: boolArg(),
      preserve_worktree: boolArg(),
      write_blocked_migration_receipt: boolArg(),
    },
  },
  "report.render": {
    arguments: {
      deterministic: boolArg(),
      projections_from: stringArg(false, ["profile.reports"]),
    },
  },
  "review.record": {
    arguments: { notes: stringArg(), status: stringArg(true), ticket: stringArg(true) },
  },
  "review.validate": {
    arguments: {
      bind_current_output: boolArg(),
      request_review_and_stop_if_missing: boolArg(),
      require_no_live_worker: boolArg(),
      strict_checklist_when_passing: boolArg(),
      strict_transition_checklist: boolArg(),
      ticket: stringArg(true),
    },
  },
  "rollback.forward_reversal": { arguments: { reason: stringArg(true), target: stringArg(true) } },
  "rules.evaluate": {
    arguments: {
      derive_assets_and_gates: boolArg(),
      mode: stringArg(),
      paused_mode: stringArg(),
      ticket: stringArg(),
    },
  },
  "scope.validate": {
    arguments: {
      change_control_barrier: stringArg(),
      duplicate_worker_policy: stringArg(),
      overlap: stringArg(),
      refresh_from_integration: stringArg(),
      reject_dirty_protected_tooling: boolArg(),
      require_active_lease: boolArg(),
      require_compiler_worktree: boolArg(),
      require_no_upstream_change_hold: boolArg(),
      single_flight: stringArg(),
      ticket: stringArg(),
      validate_step_persona_dependencies: boolArg(),
    },
  },
  "snapshot.write": {
    arguments: { reason: stringArg(true), recompute_from_integration_projection: boolArg() },
  },
  "ticket.inspect": { arguments: {} },
  "ticket.transition": { arguments: { ticket: stringArg(true), to: stringArg(true) } },
  "ticket.validate": { arguments: { ticket: stringArg() } },
  "tickets.reconcile": {
    arguments: {
      reconcile_change_control: boolArg(),
      recover_workers_and_leases: boolArg(),
      retire_obsolete: boolArg(),
    },
  },
  "worktree.create": {
    arguments: {
      branch_template_from: stringArg(true, ["git.ticket_branch_template"]),
      ticket: stringArg(true),
    },
  },
});

/** Compatibility projection for callers that only need the names; compilation uses typed schemas. */
export const ACTION_PRIMITIVE_ARGUMENTS: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(ACTION_PRIMITIVE_SCHEMAS).map(([primitive, schema]) => [
        primitive,
        Object.keys(schema.arguments),
      ]),
    ),
  );

export function compileActionCatalog(
  sources: readonly ActionSourceRecord[],
): ValidationResult<CompiledActionCatalog> {
  const bag = new DiagnosticBag();
  const actions: Record<string, CompiledActionDefinition> = Object.create(null) as Record<
    string,
    CompiledActionDefinition
  >;
  const aliasClaims = new Map<string, { actionId: string; path: string }>();

  for (const source of [...sources].sort((left, right) => compareUtf8(left.id, right.id))) {
    const action = compileAction(source, bag);
    if (action === undefined) continue;
    if (actions[action.id] !== undefined) {
      bag.error(
        "configuration.duplicate_action",
        pointer(source.path, "id"),
        `action ${action.id} is duplicated`,
      );
      continue;
    }
    actions[action.id] = action;
    for (const alias of [action.id, ...action.aliases]) {
      const previous = aliasClaims.get(alias);
      if (previous !== undefined && previous.actionId !== action.id) {
        bag.error(
          "configuration.duplicate_action_alias",
          source.path,
          `action selector ${alias} is claimed by ${previous.actionId} and ${action.id}`,
        );
      } else {
        aliasClaims.set(alias, { actionId: action.id, path: source.path });
      }
    }
  }

  for (const action of Object.values(actions)) {
    if (action.recovery !== undefined && aliasClaims.get(action.recovery)?.actionId === undefined) {
      const source = sources.find((candidate) => candidate.id === action.id);
      bag.error(
        "configuration.dangling_reference",
        pointer(source?.path ?? "/actions", "recovery"),
        `recovery action ${action.recovery} is not defined`,
      );
    }
  }
  if (bag.hasErrors()) return validationFailure(bag.sorted());

  const aliases: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const alias of [...aliasClaims.keys()].sort(compareUtf8)) {
    aliases[alias] = aliasClaims.get(alias)!.actionId;
  }
  const material = { protocol: ACTION_CATALOG_PROTOCOL, actions, aliases };
  const catalog: CompiledActionCatalog = deepFreeze({
    ...material,
    sha256: canonicalHash(material),
  });
  return validationSuccess(catalog, bag.sorted());
}

function compileAction(
  source: ActionSourceRecord,
  bag: DiagnosticBag,
): CompiledActionDefinition | undefined {
  const errorsBefore = errorCount(bag);
  const value = source.document;
  rejectUnknown(value, ACTION_FIELDS, source.path, bag);
  const id = requiredIdentifier(value.id, pointer(source.path, "id"), bag);
  if (id !== undefined && id !== source.id) {
    bag.error(
      "configuration.action_id",
      pointer(source.path, "id"),
      "action registry identity changed during compilation",
    );
  }
  const actorValue = value.actor ?? "compiler";
  const actor: "compiler" | "lead" | undefined =
    actorValue === "compiler" || actorValue === "lead" ? actorValue : undefined;
  if (actor === undefined)
    bag.error(
      "configuration.action_actor",
      pointer(source.path, "actor"),
      "action actor must be compiler or lead",
    );
  const aliases = optionalUniqueStrings(value.aliases, pointer(source.path, "aliases"), bag);
  const parameters = compileParameters(value.params, pointer(source.path, "params"), bag);
  const allowedTicketStates = optionalUniqueStrings(
    value.allowed_ticket_states,
    pointer(source.path, "allowed_ticket_states"),
    bag,
  );
  const main =
    optionalBoolean(
      value.requires_main_checkout,
      pointer(source.path, "requires_main_checkout"),
      bag,
    ) ?? false;
  const ticket =
    optionalBoolean(
      value.requires_ticket_worktree,
      pointer(source.path, "requires_ticket_worktree"),
      bag,
    ) ?? false;
  if (main && ticket)
    bag.error(
      "configuration.action_checkout",
      source.path,
      "action cannot require both main and ticket checkout",
    );
  const recipe = compileSteps(value.recipe, pointer(source.path, "recipe"), parameters, bag, true);
  const compensation =
    value.compensation === undefined
      ? []
      : compileSteps(
          value.compensation,
          pointer(source.path, "compensation"),
          parameters,
          bag,
          false,
        );
  const recovery =
    value.recovery === undefined
      ? undefined
      : requiredIdentifier(value.recovery, pointer(source.path, "recovery"), bag);
  if (
    (allowedTicketStates.length > 0 || ticket) &&
    !parameters.some((parameter) => parameter.type === "ticket_id")
  ) {
    bag.error(
      "configuration.action_ticket_parameter",
      pointer(source.path, "params"),
      "ticket-scoped action requires a ticket_id parameter",
    );
  }
  if (
    id === undefined ||
    actor === undefined ||
    recipe.length === 0 ||
    errorCount(bag) > errorsBefore
  )
    return undefined;
  const material = {
    id,
    actor,
    aliases,
    parameters,
    allowedTicketStates,
    checkout: main ? ("main" as const) : ticket ? ("ticket" as const) : ("none" as const),
    recipe,
    compensation,
    ...(recovery === undefined ? {} : { recovery }),
  };
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function compileParameters(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): readonly CompiledActionParameter[] {
  if (value === undefined) return [];
  const record = asRecord(value, path, bag);
  if (record === undefined) return [];
  const parameters: CompiledActionParameter[] = [];
  for (const id of Object.keys(record).sort(compareUtf8)) {
    const parameterPath = pointer(path, id);
    if (!isIdentifier(id))
      bag.error(
        "configuration.action_parameter_id",
        parameterPath,
        "action parameter id is invalid",
      );
    const parameter = asRecord(record[id], parameterPath, bag);
    if (parameter === undefined) continue;
    rejectUnknown(parameter, PARAMETER_FIELDS, parameterPath, bag);
    const typeValue = requiredText(parameter.type, pointer(parameterPath, "type"), bag);
    const type =
      typeValue !== undefined && PARAMETER_TYPES.has(typeValue as ActionParameterType)
        ? (typeValue as ActionParameterType)
        : undefined;
    if (typeValue !== undefined && type === undefined)
      bag.error(
        "configuration.action_parameter_type",
        pointer(parameterPath, "type"),
        `unsupported action parameter type ${typeValue}`,
      );
    const required =
      optionalBoolean(parameter.required, pointer(parameterPath, "required"), bag) ?? false;
    const description =
      parameter.description === undefined
        ? ""
        : (requiredText(parameter.description, pointer(parameterPath, "description"), bag) ?? "");
    if (required && parameter.default !== undefined)
      bag.error(
        "configuration.action_parameter_default",
        pointer(parameterPath, "default"),
        "required action parameter must not define a default",
      );
    if (
      type !== undefined &&
      parameter.default !== undefined &&
      !matchesParameterType(parameter.default, type)
    ) {
      bag.error(
        "configuration.action_parameter_default",
        pointer(parameterPath, "default"),
        `default does not match ${type}`,
      );
    }
    if (type !== undefined) {
      parameters.push({
        id,
        type,
        required,
        description,
        ...(parameter.default === undefined ? {} : { default: cloneValue(parameter.default) }),
      });
    }
  }
  return parameters;
}

function compileSteps(
  value: ConfigurationValue | undefined,
  path: string,
  parameters: readonly CompiledActionParameter[],
  bag: DiagnosticBag,
  required: boolean,
): readonly CompiledActionStep[] {
  if (!Array.isArray(value)) {
    bag.error(
      "configuration.action_recipe",
      path,
      required ? "action recipe must be a nonempty list" : "action compensation must be a list",
    );
    return [];
  }
  if (required && value.length === 0)
    bag.error("configuration.action_recipe", path, "action recipe must be nonempty");
  const parameterIds = new Set(parameters.map((parameter) => parameter.id));
  const parameterTypes = new Map(parameters.map((parameter) => [parameter.id, parameter] as const));
  const ids = new Set<string>();
  const steps: CompiledActionStep[] = [];
  for (const [index, item] of value.entries()) {
    const stepPath = pointer(path, index);
    const record = asRecord(item, stepPath, bag);
    if (record === undefined) continue;
    const primitive = requiredText(record.primitive, pointer(stepPath, "primitive"), bag);
    const schema = primitive === undefined ? undefined : ACTION_PRIMITIVE_SCHEMAS[primitive];
    if (primitive !== undefined && schema === undefined)
      bag.error(
        "configuration.action_primitive",
        pointer(stepPath, "primitive"),
        `unsupported action primitive ${primitive}`,
      );
    const explicitId =
      record.id === undefined
        ? undefined
        : requiredIdentifier(record.id, pointer(stepPath, "id"), bag);
    const id = explicitId ?? `step-${index + 1}`;
    if (ids.has(id))
      bag.error(
        "configuration.action_step_id",
        pointer(stepPath, "id"),
        `action step id ${id} is duplicated`,
      );
    ids.add(id);
    const argumentsValue: Record<string, ConfigurationValue> = Object.create(null) as Record<
      string,
      ConfigurationValue
    >;
    for (const [key, argument] of Object.entries(record)) {
      if (STEP_FIELDS.has(key)) continue;
      const argumentSpec = schema?.arguments[key];
      if (schema !== undefined && argumentSpec === undefined)
        bag.error(
          "configuration.action_primitive_argument",
          pointer(stepPath, key),
          `${primitive} does not accept argument ${key}`,
        );
      validateTemplates(argument, pointer(stepPath, key), parameterIds, bag);
      if (argumentSpec !== undefined)
        validatePrimitiveArgument(
          argument,
          argumentSpec,
          pointer(stepPath, key),
          parameterTypes,
          bag,
        );
      argumentsValue[key] = cloneValue(argument);
    }
    if (schema !== undefined) {
      for (const [key, spec] of Object.entries(schema.arguments)) {
        if (spec.required === true && !Object.hasOwn(argumentsValue, key))
          bag.error(
            "configuration.action_primitive_argument",
            pointer(stepPath, key),
            `${primitive} requires argument ${key}`,
          );
      }
      schema.validate?.(argumentsValue, stepPath, bag);
    }
    if (primitive !== undefined && schema !== undefined)
      steps.push({ id, primitive, arguments: argumentsValue });
  }
  return steps;
}

const TEMPLATE = /\$\{([^}]+)\}/gu;
const MAX_PRIMITIVE_OUTPUT_BYTES = 256 * 1024;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const MAX_ACTION_PLAN_BYTES = 4 * 1024 * 1024;

function validateTemplates(
  value: ConfigurationValue,
  path: string,
  parameters: ReadonlySet<string>,
  bag: DiagnosticBag,
): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(TEMPLATE)) {
      const reference = match[1] ?? "";
      if (reference.startsWith("params.")) {
        const id = reference.slice("params.".length);
        if (!parameters.has(id))
          bag.error(
            "configuration.action_template",
            path,
            `action template references unknown parameter ${id}`,
          );
      } else {
        bag.error(
          "configuration.action_template",
          path,
          `unsupported action template reference ${reference}`,
        );
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => validateTemplates(item, pointer(path, index), parameters, bag));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value))
      validateTemplates(item, pointer(path, key), parameters, bag);
  }
}

function validatePrimitiveArgument(
  value: ConfigurationValue,
  spec: PrimitiveArgumentSpec,
  path: string,
  parameters: ReadonlyMap<string, CompiledActionParameter>,
  bag: DiagnosticBag,
): void {
  if (value === null && spec.nullable === true) return;
  const whole = typeof value === "string" ? /^\$\{params\.([^}]+)\}$/u.exec(value) : null;
  if (whole !== null) {
    const parameter = parameters.get(whole[1]!);
    if (parameter === undefined) return;
    if (
      !parameterTypeMatchesPrimitive(parameter.type, spec.kind) &&
      !(spec.nullable === true && !parameter.required && parameter.default === undefined)
    ) {
      bag.error(
        "configuration.action_primitive_argument_type",
        path,
        `parameter ${parameter.id} (${parameter.type}) cannot supply ${spec.kind}`,
      );
    }
    return;
  }
  if (typeof value === "string" && value.includes("${")) {
    if (spec.kind !== "string")
      bag.error(
        "configuration.action_primitive_argument_type",
        path,
        `interpolated text cannot supply ${spec.kind}`,
      );
    return;
  }
  const matches =
    spec.kind === "json" ||
    (spec.kind === "string" && typeof value === "string") ||
    (spec.kind === "boolean" && typeof value === "boolean") ||
    (spec.kind === "string_list" &&
      Array.isArray(value) &&
      value.every((item) => typeof item === "string"));
  if (!matches)
    bag.error(
      "configuration.action_primitive_argument_type",
      path,
      `argument must be ${spec.kind}`,
    );
  if (
    spec.kind === "string" &&
    typeof value === "string" &&
    spec.values !== undefined &&
    !spec.values.includes(value)
  ) {
    bag.error(
      "configuration.action_primitive_argument_value",
      path,
      `argument must be one of ${spec.values.join(", ")}`,
    );
  }
}

function parameterTypeMatchesPrimitive(
  type: ActionParameterType,
  kind: PrimitiveArgumentKind,
): boolean {
  if (kind === "json") return true;
  if (kind === "boolean") return type === "boolean";
  if (kind === "string_list") return type === "json";
  return type === "string" || type === "ticket_id" || type === "path";
}

function requireOneOf(...keys: readonly string[]): NonNullable<PrimitiveSpec["validate"]> {
  return (argumentsValue, path, bag) => {
    if (!keys.some((key) => Object.hasOwn(argumentsValue, key))) {
      bag.error(
        "configuration.action_primitive_argument",
        path,
        `primitive requires one of ${keys.join(", ")}`,
      );
    }
  };
}

function assertResolvedSteps(
  steps: readonly PreparedActionStep[],
  actionId: string,
  phase: "recipe" | "compensation",
): void {
  const bag = new DiagnosticBag();
  for (const [index, step] of steps.entries()) {
    const schema = ACTION_PRIMITIVE_SCHEMAS[step.primitive];
    if (schema === undefined)
      throw new ActionRecipeError(
        "primitive_unknown",
        `${actionId} contains unsupported primitive ${step.primitive}`,
      );
    const path = `/actions/${actionId}/${phase}/${index}`;
    for (const key of Object.keys(step.arguments)) {
      const spec = schema.arguments[key];
      if (spec === undefined)
        bag.error(
          "configuration.action_primitive_argument",
          pointer(path, key),
          `${step.primitive} does not accept argument ${key}`,
        );
      else
        validatePrimitiveArgument(step.arguments[key]!, spec, pointer(path, key), new Map(), bag);
    }
    for (const [key, spec] of Object.entries(schema.arguments)) {
      if (spec.required === true && !Object.hasOwn(step.arguments, key))
        bag.error(
          "configuration.action_primitive_argument",
          pointer(path, key),
          `${step.primitive} requires argument ${key}`,
        );
    }
    schema.validate?.(step.arguments, path, bag);
  }
  if (bag.hasErrors())
    throw new ActionRecipeError(
      "resolved_primitive",
      bag
        .sorted()
        .map((item) => `${item.path}: ${item.message}`)
        .join("; "),
    );
}

export function prepareActionInvocation(
  input: Readonly<{
    catalog: CompiledActionCatalog;
    selector: string;
    invocationId: string;
    actor: "compiler" | "lead";
    parameters?: ConfigurationObject;
    context: ActionInvocationContext;
  }>,
): ActionExecutionPlan {
  const actionId = input.catalog.aliases[input.selector];
  if (actionId === undefined)
    throw new ActionRecipeError(
      "action_unknown",
      `configured action ${input.selector} does not exist`,
    );
  const action = input.catalog.actions[actionId];
  if (action === undefined)
    throw new ActionRecipeError(
      "action_catalog_corrupt",
      `action catalog has no canonical ${actionId}`,
    );
  if (input.invocationId.trim().length === 0)
    throw new ActionRecipeError("invocation_id", "action invocation id is required");
  if (input.actor !== action.actor)
    throw new ActionRecipeError(
      "action_actor",
      `${action.id} may be invoked only by ${action.actor}`,
    );
  if (action.checkout !== "none" && action.checkout !== input.context.checkout) {
    throw new ActionRecipeError(
      "checkout_mismatch",
      `${action.id} requires the ${action.checkout} checkout`,
    );
  }
  if (
    action.allowedTicketStates.length > 0 &&
    (input.context.ticketState === undefined ||
      !action.allowedTicketStates.includes(input.context.ticketState))
  ) {
    throw new ActionRecipeError(
      "ticket_state",
      `${action.id} is not allowed from ticket state ${input.context.ticketState ?? "unknown"}`,
    );
  }
  const supplied = input.parameters ?? {};
  const known = new Set(action.parameters.map((parameter) => parameter.id));
  for (const key of Object.keys(supplied)) {
    if (!known.has(key))
      throw new ActionRecipeError(
        "parameter_unknown",
        `${action.id} does not accept parameter ${key}`,
      );
  }
  const parameters: Record<string, ConfigurationValue> = Object.create(null) as Record<
    string,
    ConfigurationValue
  >;
  for (const parameter of action.parameters) {
    const value = supplied[parameter.id] ?? parameter.default;
    if (value === undefined) {
      if (parameter.required)
        throw new ActionRecipeError(
          "parameter_required",
          `${action.id} requires parameter ${parameter.id}`,
        );
      parameters[parameter.id] = null;
      continue;
    }
    if (!matchesParameterType(value, parameter.type))
      throw new ActionRecipeError(
        "parameter_type",
        `${action.id}.${parameter.id} must be ${parameter.type}`,
      );
    parameters[parameter.id] = cloneValue(value);
  }
  const scope = { params: parameters, context: input.context.values ?? {} };
  const recipe = action.recipe.map((step) => resolveStep(step, scope));
  const compensation = action.compensation.map((step) => resolveStep(step, scope));
  assertResolvedSteps(recipe, action.id, "recipe");
  assertResolvedSteps(compensation, action.id, "compensation");
  const material = {
    protocol: ACTION_EXECUTION_PLAN_PROTOCOL,
    invocationId: input.invocationId,
    catalogSha256: input.catalog.sha256,
    actionId: action.id,
    actionSha256: action.sha256,
    actor: action.actor,
    context: cloneValue(input.context),
    parameters,
    recipe,
    compensation,
    ...(action.recovery === undefined
      ? {}
      : { recovery: input.catalog.aliases[action.recovery] ?? action.recovery }),
  };
  if (Buffer.byteLength(canonicalEncode(material), "utf8") > MAX_ACTION_PLAN_BYTES) {
    throw new ActionRecipeError(
      "plan_size",
      `action execution plan exceeds ${MAX_ACTION_PLAN_BYTES} bytes`,
    );
  }
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

export interface ExecuteActionPlanOptions {
  /** A hash-authenticated nonterminal journal produced for this exact plan. */
  readonly journal?: ActionExecutionJournal;
  /** Authority persistence hook; called after every state transition before another effect. */
  readonly persist?: (journal: ActionExecutionJournal) => Promise<void>;
}

export function createActionExecutionJournal(plan: ActionExecutionPlan): ActionExecutionJournal {
  assertActionExecutionPlan(plan);
  return journalWithHash(plan, "running", []);
}

export function validateActionExecutionJournal(
  plan: ActionExecutionPlan,
  candidate: ActionExecutionJournal,
): ActionExecutionJournal {
  assertActionExecutionPlan(plan);
  if (
    candidate.protocol !== ACTION_EXECUTION_JOURNAL_PROTOCOL ||
    canonicalHash(withoutJournalSha(candidate)) !== candidate.sha256
  ) {
    throw new ActionRecipeError("journal_hash", "action journal protocol or hash is invalid");
  }
  const allowedJournalFields = new Set([
    "protocol",
    "planSha256",
    "invocationId",
    "catalogSha256",
    "actionId",
    "actionSha256",
    "contextSha256",
    "status",
    "steps",
    "recoveryActionId",
    "sha256",
  ]);
  if (Object.keys(candidate).some((key) => !allowedJournalFields.has(key))) {
    throw new ActionRecipeError("journal_shape", "action journal contains an unknown field");
  }
  if (
    candidate.planSha256 !== plan.sha256 ||
    candidate.invocationId !== plan.invocationId ||
    candidate.catalogSha256 !== plan.catalogSha256 ||
    candidate.actionId !== plan.actionId ||
    candidate.actionSha256 !== plan.actionSha256 ||
    candidate.contextSha256 !== canonicalHash(plan.context)
  ) {
    throw new ActionRecipeError(
      "journal_identity",
      "action journal does not belong to this exact plan, catalog, action, invocation, and context",
    );
  }
  if (!Array.isArray(candidate.steps))
    throw new ActionRecipeError("journal_steps", "action journal steps must be a list");
  const recipeCompleted: ActionExecutionJournalStep[] = [];
  let recipeFailure: ActionExecutionJournalStep | undefined;
  const compensationCompleted: ActionExecutionJournalStep[] = [];
  let compensationFailure: ActionExecutionJournalStep | undefined;
  let phase: "recipe" | "compensation" = "recipe";
  for (const entry of candidate.steps) {
    validateJournalEntryShape(entry);
    if (entry.phase === "recipe") {
      if (phase !== "recipe" || recipeFailure !== undefined)
        throw new ActionRecipeError(
          "journal_order",
          "recipe journal entries must be one ordered prefix followed by at most one failure",
        );
      const expected = plan.recipe[recipeCompleted.length];
      if (
        expected === undefined ||
        entry.stepId !== expected.id ||
        entry.primitive !== expected.primitive
      )
        throw new ActionRecipeError(
          "journal_order",
          "recipe journal step is duplicated, unknown, or out of order",
        );
      if (entry.status === "completed") recipeCompleted.push(entry);
      else {
        recipeFailure = entry;
        phase = "compensation";
      }
    } else {
      phase = "compensation";
      if (recipeFailure === undefined || compensationFailure !== undefined)
        throw new ActionRecipeError(
          "journal_order",
          "compensation requires one recipe failure and one ordered compensation prefix",
        );
      const expected = plan.compensation[compensationCompleted.length];
      if (
        expected === undefined ||
        entry.stepId !== expected.id ||
        entry.primitive !== expected.primitive
      )
        throw new ActionRecipeError(
          "journal_order",
          "compensation journal step is duplicated, unknown, or out of order",
        );
      if (entry.status === "completed") compensationCompleted.push(entry);
      else compensationFailure = entry;
    }
  }
  const allRecipe = recipeCompleted.length === plan.recipe.length;
  const allCompensation = compensationCompleted.length === plan.compensation.length;
  const valid =
    (candidate.status === "running" &&
      candidate.recoveryActionId === undefined &&
      recipeFailure === undefined &&
      !allRecipe &&
      candidate.steps.length === recipeCompleted.length) ||
    (candidate.status === "completed" &&
      candidate.recoveryActionId === undefined &&
      recipeFailure === undefined &&
      allRecipe &&
      candidate.steps.length === recipeCompleted.length) ||
    (candidate.status === "compensating" &&
      candidate.recoveryActionId === undefined &&
      recipeFailure !== undefined &&
      compensationFailure === undefined &&
      plan.compensation.length > 0 &&
      !allCompensation) ||
    (candidate.status === "failed" &&
      candidate.recoveryActionId === undefined &&
      plan.recovery === undefined &&
      recipeFailure !== undefined &&
      plan.compensation.length === 0 &&
      candidate.steps.length === recipeCompleted.length + 1) ||
    (candidate.status === "compensated" &&
      candidate.recoveryActionId === undefined &&
      recipeFailure !== undefined &&
      compensationFailure === undefined &&
      plan.compensation.length > 0 &&
      allCompensation) ||
    (candidate.status === "compensation_failed" &&
      candidate.recoveryActionId === undefined &&
      recipeFailure !== undefined &&
      compensationFailure !== undefined &&
      plan.recovery === undefined) ||
    (candidate.status === "recovery_required" &&
      plan.recovery !== undefined &&
      candidate.recoveryActionId === plan.recovery &&
      recipeFailure !== undefined &&
      ((plan.compensation.length === 0 && compensationFailure === undefined) ||
        compensationFailure !== undefined));
  if (!valid)
    throw new ActionRecipeError(
      "journal_state",
      `action journal steps are impossible for state ${candidate.status}`,
    );
  return deepFreeze(structuredClone(candidate));
}

export async function executeActionPlan(
  plan: ActionExecutionPlan,
  host: ActionPrimitiveHost,
  options: ExecuteActionPlanOptions = {},
): Promise<ActionExecutionJournal> {
  assertActionExecutionPlan(plan);
  let journal =
    options.journal === undefined
      ? createActionExecutionJournal(plan)
      : validateActionExecutionJournal(plan, options.journal);
  if (
    ["completed", "failed", "compensated", "compensation_failed", "recovery_required"].includes(
      journal.status,
    )
  ) {
    return journal;
  }
  if (options.journal === undefined) await options.persist?.(journal);

  if (journal.status === "running") {
    const completed = journal.steps.length;
    for (let index = completed; index < plan.recipe.length; index += 1) {
      const step = plan.recipe[index]!;
      let output: ConfigurationValue;
      try {
        output = await executeHostPrimitive(host, plan, "recipe", step);
      } catch (error) {
        const steps = [...journal.steps, failedEntry(step, "recipe", error)];
        journal = journalWithHash(
          plan,
          plan.compensation.length === 0
            ? plan.recovery === undefined
              ? "failed"
              : "recovery_required"
            : "compensating",
          steps,
        );
        await options.persist?.(journal);
        break;
      }
      const steps = [...journal.steps, completedEntry(step, "recipe", output)];
      journal = journalWithHash(
        plan,
        index + 1 === plan.recipe.length ? "completed" : "running",
        steps,
      );
      // Persistence failure is not an effect failure: stop immediately. Re-entry uses the same
      // effectKey, so the authority host reconciles/deduplicates the already-issued primitive.
      await options.persist?.(journal);
    }
  }

  if (journal.status === "compensating") {
    const completed = journal.steps.filter(
      (step) => step.phase === "compensation" && step.status === "completed",
    ).length;
    for (let index = completed; index < plan.compensation.length; index += 1) {
      const step = plan.compensation[index]!;
      let output: ConfigurationValue;
      try {
        output = await executeHostPrimitive(host, plan, "compensation", step);
      } catch (error) {
        journal = journalWithHash(
          plan,
          plan.recovery === undefined ? "compensation_failed" : "recovery_required",
          [...journal.steps, failedEntry(step, "compensation", error)],
        );
        await options.persist?.(journal);
        break;
      }
      const steps = [...journal.steps, completedEntry(step, "compensation", output)];
      journal = journalWithHash(
        plan,
        index + 1 === plan.compensation.length ? "compensated" : "compensating",
        steps,
      );
      await options.persist?.(journal);
    }
  }
  return journal;
}

export class ActionRecipeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ActionRecipeError";
  }
}

function assertActionExecutionPlan(plan: ActionExecutionPlan): void {
  if (
    plan.protocol !== ACTION_EXECUTION_PLAN_PROTOCOL ||
    canonicalHash(withoutSha(plan)) !== plan.sha256 ||
    !Array.isArray(plan.recipe) ||
    !Array.isArray(plan.compensation)
  ) {
    throw new ActionRecipeError(
      "plan_hash",
      "action execution plan protocol, shape, or hash is invalid",
    );
  }
}

function journalWithHash(
  plan: ActionExecutionPlan,
  status: ActionExecutionJournal["status"],
  steps: readonly ActionExecutionJournalStep[],
): ActionExecutionJournal {
  const material = {
    protocol: ACTION_EXECUTION_JOURNAL_PROTOCOL,
    planSha256: plan.sha256,
    invocationId: plan.invocationId,
    catalogSha256: plan.catalogSha256,
    actionId: plan.actionId,
    actionSha256: plan.actionSha256,
    contextSha256: canonicalHash(plan.context),
    status,
    ...(status === "recovery_required" && plan.recovery !== undefined
      ? { recoveryActionId: plan.recovery }
      : {}),
    steps: steps.map((step) => structuredClone(step)),
  };
  const encoded = canonicalEncode(material);
  if (Buffer.byteLength(encoded, "utf8") > MAX_JOURNAL_BYTES) {
    throw new ActionRecipeError(
      "journal_size",
      `action journal exceeds ${MAX_JOURNAL_BYTES} bytes`,
    );
  }
  return deepFreeze({ ...material, sha256: canonicalHash(material) });
}

function completedEntry(
  step: PreparedActionStep,
  phase: "recipe" | "compensation",
  output: ConfigurationValue,
): ActionExecutionJournalStep {
  return {
    stepId: step.id,
    primitive: step.primitive,
    phase,
    status: "completed",
    output: cloneValue(output),
  };
}

async function executeHostPrimitive(
  host: ActionPrimitiveHost,
  plan: ActionExecutionPlan,
  phase: "recipe" | "compensation",
  step: PreparedActionStep,
): Promise<ConfigurationValue> {
  const output = await host.execute({
    invocationId: plan.invocationId,
    planSha256: plan.sha256,
    effectKey: `${plan.invocationId}:${phase}:${step.id}:${plan.sha256}`,
    actionId: plan.actionId,
    actor: plan.actor,
    phase,
    step,
    context: plan.context,
  });
  try {
    const encoded = canonicalEncode(output);
    if (Buffer.byteLength(encoded, "utf8") > MAX_PRIMITIVE_OUTPUT_BYTES) {
      throw new ActionRecipeError(
        "primitive_output_size",
        `primitive output exceeds ${MAX_PRIMITIVE_OUTPUT_BYTES} bytes`,
      );
    }
  } catch (error) {
    throw new ActionRecipeError(
      "primitive_output",
      `primitive ${step.primitive} returned a noncanonical value: ${errorText(error)}`,
    );
  }
  return cloneValue(output);
}

function failedEntry(
  step: PreparedActionStep,
  phase: "recipe" | "compensation",
  error: unknown,
): ActionExecutionJournalStep {
  return {
    stepId: step.id,
    primitive: step.primitive,
    phase,
    status: "failed",
    error: boundedErrorText(error),
  };
}

function validateJournalEntryShape(entry: ActionExecutionJournalStep): void {
  if (typeof entry !== "object" || entry === null)
    throw new ActionRecipeError("journal_steps", "action journal step must be a record");
  const allowed =
    entry.status === "completed"
      ? new Set(["stepId", "primitive", "phase", "status", "output"])
      : new Set(["stepId", "primitive", "phase", "status", "error"]);
  if (Object.keys(entry).some((key) => !allowed.has(key)))
    throw new ActionRecipeError(
      "journal_steps",
      "action journal step contains unknown or state-incompatible fields",
    );
  if (
    typeof entry.stepId !== "string" ||
    typeof entry.primitive !== "string" ||
    (entry.phase !== "recipe" && entry.phase !== "compensation") ||
    (entry.status !== "completed" && entry.status !== "failed")
  ) {
    throw new ActionRecipeError("journal_steps", "action journal step shape is invalid");
  }
  if (entry.status === "completed" && entry.output === undefined)
    throw new ActionRecipeError("journal_steps", "completed action journal step requires output");
  if (entry.status === "failed" && (typeof entry.error !== "string" || entry.error.length === 0))
    throw new ActionRecipeError("journal_steps", "failed action journal step requires error text");
}

function resolveStep(
  step: CompiledActionStep,
  scope: Readonly<{ params: ConfigurationObject; context: ConfigurationObject }>,
): PreparedActionStep {
  return { ...step, arguments: resolveTemplates(step.arguments, scope) as ConfigurationObject };
}

function resolveTemplates(
  value: ConfigurationValue,
  scope: Readonly<{ params: ConfigurationObject; context: ConfigurationObject }>,
): ConfigurationValue {
  if (typeof value === "string") {
    const whole = /^\$\{([^}]+)\}$/u.exec(value);
    if (whole !== null) return cloneValue(resolveReference(whole[1]!, scope));
    return value.replace(TEMPLATE, (_match, reference: string) =>
      scalarText(resolveReference(reference, scope)),
    );
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, scope));
  if (isRecord(value)) {
    const result: Record<string, ConfigurationValue> = Object.create(null) as Record<
      string,
      ConfigurationValue
    >;
    for (const [key, item] of Object.entries(value)) result[key] = resolveTemplates(item, scope);
    return result;
  }
  return value;
}

function resolveReference(
  reference: string,
  scope: Readonly<{ params: ConfigurationObject; context: ConfigurationObject }>,
): ConfigurationValue {
  const [namespace, ...segments] = reference.split(".");
  let value: ConfigurationValue | undefined =
    namespace === "params" ? scope.params : namespace === "context" ? scope.context : undefined;
  for (const segment of segments) value = isRecord(value) ? value[segment] : undefined;
  if (value === undefined) return null;
  return value;
}

function scalarText(value: ConfigurationValue): string {
  if (value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  throw new ActionRecipeError(
    "template_scalar",
    "structured action parameter cannot be interpolated into text",
  );
}

function matchesParameterType(value: ConfigurationValue, type: ActionParameterType): boolean {
  if (type === "json") return true;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (typeof value !== "string") return false;
  if (type === "ticket_id") return value.trim().length > 0;
  if (type === "path")
    return value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..");
  return true;
}

function requiredIdentifier(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): string | undefined {
  const text = requiredText(value, path, bag);
  if (text !== undefined && !isIdentifier(text)) {
    bag.error("configuration.identifier", path, "value must be a lowercase semantic identifier");
    return undefined;
  }
  return text;
}

function requiredText(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    bag.error("configuration.field_type", path, "value must be a nonempty string");
    return undefined;
  }
  return value;
}

function optionalBoolean(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    bag.error("configuration.field_type", path, "value must be boolean");
    return undefined;
  }
  return value;
}

function optionalUniqueStrings(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    bag.error("configuration.field_type", path, "value must be a string list");
    return [];
  }
  const values: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const text = requiredText(item, pointer(path, index), bag);
    if (text === undefined) return;
    if (seen.has(text))
      bag.error(
        "configuration.duplicate_value",
        pointer(path, index),
        `value ${text} is duplicated`,
      );
    else {
      seen.add(text);
      values.push(text);
    }
  });
  return values;
}

function rejectUnknown(
  value: ConfigurationObject,
  allowed: readonly string[],
  path: string,
  bag: DiagnosticBag,
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value))
    if (!accepted.has(key))
      bag.error("configuration.unknown_field", pointer(path, key), "field is not supported");
}

function asRecord(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): ConfigurationObject | undefined {
  if (!isRecord(value)) {
    bag.error("configuration.field_type", path, "value must be a mapping");
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is ConfigurationObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u.test(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function withoutSha(plan: ActionExecutionPlan): Omit<ActionExecutionPlan, "sha256"> {
  const { sha256: _sha256, ...material } = plan;
  return material;
}

function withoutJournalSha(
  journal: ActionExecutionJournal,
): Omit<ActionExecutionJournal, "sha256"> {
  const { sha256: _sha256, ...material } = journal;
  return material;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedErrorText(error: unknown): string {
  const full = errorText(error);
  const bytes = Buffer.from(full, "utf8");
  if (bytes.byteLength <= MAX_ERROR_BYTES) return full;
  const digest = rawSha256(bytes);
  let end = Math.min(full.length, MAX_ERROR_BYTES - 96);
  while (end > 0 && Buffer.byteLength(full.slice(0, end), "utf8") > MAX_ERROR_BYTES - 96) end -= 1;
  return `${full.slice(0, end)}… [truncated ${digest}]`;
}

function errorCount(bag: DiagnosticBag): number {
  return bag.sorted().filter((item) => item.severity === "error").length;
}
