import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import {
  DERIVED_FACT_PROTOCOL,
  DERIVED_TICKET_PROTOCOL,
  RULE_EVALUATION_PROTOCOL,
  type CompiledRuleEvaluation,
  type CompiledRuleEvaluationMaterial,
  type DerivedFact,
  type DerivedGraphMutationPolicy,
  type DerivedTicketDefinition,
  type DerivedWorkflowStep,
  type DerivedWorkflowStepKind,
  type DerivationKind,
  type RuleEvaluationInput,
} from "../contracts/rules.js";
import { canonicalHash, compareUtf8, type Sha256Digest } from "../shared/canonical.js";
import {
  DiagnosticBag,
  pointer,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "../shared/diagnostics.js";
import {
  ExpressionEvaluationError,
  GraphExpressionEvaluator,
  type RuleDomainAdapter,
} from "./expressions.js";

const RULE_FIELDS = ["id", "phase", "priority", "for_each", "bind", "when", "derive", "emit"] as const;
const EMIT_FIELDS = [
  "operation",
  "registry_entry_id",
  "source_state",
  "target_state",
  "obligations",
  "target_nodes",
  "read_scope",
  "write_scope",
  "read_paths",
  "write_paths",
  "workflow",
  "title",
] as const;
const WORKFLOW_FIELDS = [
  "id",
  "version",
  "applies_to",
  "review_failure_reopen_from",
  "review_failure_routes",
  "steps",
] as const;
const STEP_FIELDS = [
  "id",
  "kind",
  "persona",
  "depends_on",
  "required",
  "read_scope",
  "write_scope",
  "read_paths",
  "write_paths",
  "preserve_source_paths_from",
  "expected_output",
  "graph_mutation",
  "validation_action",
  "required_receipts",
  "escalation_triggers",
  "stop_conditions",
  "checks",
] as const;
const DERIVATION_FIELDS = new Set([
  "kind",
  "key",
  "target",
  "field",
  "value",
  "severity",
  "reason",
]);

const DERIVATION_KINDS = new Set<DerivationKind>([
  "obligation",
  "projection",
  "readiness",
  "program_state",
  "gate_request",
  "check_request",
  "barrier",
  "warning",
]);

const WORKFLOW_STEP_KINDS = new Set<DerivedWorkflowStepKind>([
  "production",
  "integration",
  "review",
  "agent",
  "manual",
]);

const GRAPH_MUTATION_POLICIES = new Set<DerivedGraphMutationPolicy>([
  "allowed",
  "forbidden",
  "required",
]);

interface ParsedRule {
  id: string;
  phase: string;
  priority: number;
  forEach: ConfigurationValue;
  bind: string;
  when: ConfigurationValue;
  derivations: ParsedDerivation[];
  emit?: ParsedEmit;
}

interface ParsedDerivation {
  source: ConfigurationObject;
  kind: DerivationKind;
  args: ConfigurationObject;
}

interface ParsedEmit {
  source: ConfigurationObject;
  operation: string;
  registryEntryId?: string;
  sourceState: string;
  targetState: string;
  obligations: string[];
  targetNodes: ConfigurationValue;
  readScope: ConfigurationValue;
  writeScope: ConfigurationValue;
  readPaths: readonly ConfigurationValue[];
  writePaths: readonly ConfigurationValue[];
  workflow?: string;
  title?: string;
}

interface ParsedOperation {
  id: string;
  publicOperation: string;
  stage: string;
  targetTypes: string[];
  workflow?: string;
  dispatchPriority: number;
  rankingHints: string[];
}

interface ParsedWorkflow {
  id: string;
  appliesTo: string[];
  reviewFailureReopenFrom?: string;
  steps: readonly ConfigurationObject[];
}

interface TicketMaterial extends Omit<DerivedTicketDefinition, "definition_sha256"> {}
interface FactMaterial extends Omit<DerivedFact, "fact_sha256"> {}

export interface EvaluateConfiguredRulesOptions {
  readonly adapter?: RuleDomainAdapter;
  /** Optional focused rule subset, principally for parity fixtures and diagnostics. */
  readonly ruleIds?: readonly string[];
  /** Optional phase subset. Applied to both derivation and ticket passes. */
  readonly phases?: readonly string[];
}

/**
 * Evaluate all configured derivations, then compile ticket definitions over
 * the resulting private graph epoch. No durable state is mutated.
 */
export function evaluateConfiguredRules(
  input: RuleEvaluationInput,
  options: EvaluateConfiguredRulesOptions = {},
): ValidationResult<CompiledRuleEvaluation> {
  const bag = new DiagnosticBag();
  try {
    const rules = parseRules(input.configuration, options);
    const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph, options.adapter);
    const programState: Record<string, ConfigurationValue> = { schema_version: "1.0" };
    const facts = materializeDerivations(rules, evaluator, programState, input.configuration);
    const tickets = deriveTickets(rules, evaluator, input.configuration);
    const material: CompiledRuleEvaluationMaterial = {
      protocol: RULE_EVALUATION_PROTOCOL,
      configuration_sha256: input.configuration.configuration_sha256,
      input_graph_sha256: evaluator.inputGraphSha256,
      derived_graph_sha256: evaluator.graphSha256,
      facts,
      program_state: cloneObject(programState),
      tickets,
    };
    const evaluation: CompiledRuleEvaluation = {
      ...material,
      evaluation_sha256: canonicalHash(material),
    };
    return validationSuccess(deepFreeze(evaluation), bag.sorted());
  } catch (error) {
    if (error instanceof ExpressionEvaluationError || error instanceof RuleCompilationError) {
      bag.error(error.code, error.path, error.message);
    } else {
      bag.error(
        "rule.internal_failure",
        "/rules",
        "rule compilation failed at a non-diagnostic boundary",
      );
    }
    return validationFailure(bag.sorted());
  }
}

export class RuleCompilationError extends Error {
  public readonly code: string;
  public readonly path: string;

  public constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "RuleCompilationError";
    this.code = code;
    this.path = path;
  }
}

function parseRules(
  configuration: CompiledConfiguration,
  options: EvaluateConfiguredRulesOptions,
): ParsedRule[] {
  const requestedIds = options.ruleIds === undefined
    ? undefined
    : new Set(uniqueSortedStrings(options.ruleIds, "/options/ruleIds"));
  const phases = options.phases === undefined
    ? undefined
    : new Set(uniqueSortedStrings(options.phases, "/options/phases"));
  if (requestedIds !== undefined) {
    for (const id of requestedIds) {
      if (!Object.hasOwn(configuration.registries.rules, id)) {
        fail("rule.unknown_rule", "/options/ruleIds", `requested rule ${id} is not configured`);
      }
    }
  }
  const rules: ParsedRule[] = [];
  for (const [registryId, source] of Object.entries(configuration.registries.rules)) {
    if (requestedIds !== undefined && !requestedIds.has(registryId)) continue;
    const path = `/registries/rules/${escapePointer(registryId)}`;
    const rule = exactRecord(source, path, RULE_FIELDS, ["id", "for_each"]);
    const id = nonemptyString(rule.id, pointer(path, "id"));
    if (id !== registryId) fail("rule.registry_id", pointer(path, "id"), `rule id ${id} does not match registry key ${registryId}`);
    const phase = optionalString(rule.phase, pointer(path, "phase")) ?? "";
    if (phases !== undefined && !phases.has(phase)) continue;
    const priority = optionalSignedInteger(rule.priority, pointer(path, "priority")) ?? 0;
    const derivations = parseDerivations(rule.derive, pointer(path, "derive"));
    rules.push({
      id,
      phase,
      priority,
      forEach: cloneValue(rule.for_each!),
      bind: optionalString(rule.bind, pointer(path, "bind")) ?? "target",
      when: cloneValue(rule.when ?? true),
      derivations,
      ...(rule.emit === undefined ? {} : { emit: parseEmit(rule.emit, pointer(path, "emit")) }),
    });
  }
  rules.sort(compareRules);
  return rules;
}

function parseDerivations(
  value: ConfigurationValue | undefined,
  path: string,
): ParsedDerivation[] {
  if (value === undefined) return [];
  const sources = arrayValue(value, path);
  return sources.map((source, index) => {
    const itemPath = pointer(path, index);
    const derivation = record(source, itemPath);
    const kind = nonemptyString(derivation.kind, pointer(itemPath, "kind"));
    if (!DERIVATION_KINDS.has(kind as DerivationKind)) {
      fail("rule.derivation_kind", pointer(itemPath, "kind"), `unsupported derivation kind ${kind}`);
    }
    for (const field of ["key", "target", "field", "severity", "reason"] as const) {
      if (derivation[field] !== undefined) optionalString(derivation[field], pointer(itemPath, field));
    }
    const args: Record<string, ConfigurationValue> = Object.create(null) as Record<string, ConfigurationValue>;
    for (const key of Object.keys(derivation).sort(compareUtf8)) {
      if (!DERIVATION_FIELDS.has(key)) args[key] = cloneValue(derivation[key]!);
    }
    return {
      source: cloneObject(derivation),
      kind: kind as DerivationKind,
      args: cloneObject(args),
    };
  });
}

function parseEmit(value: ConfigurationValue, path: string): ParsedEmit {
  const emit = exactRecord(
    value,
    path,
    EMIT_FIELDS,
    ["operation", "source_state", "target_state"],
  );
  return {
    source: cloneObject(emit),
    operation: nonemptyString(emit.operation, pointer(path, "operation")),
    ...(emit.registry_entry_id === undefined
      ? {}
      : { registryEntryId: nonemptyString(emit.registry_entry_id, pointer(path, "registry_entry_id")) }),
    sourceState: nonemptyString(emit.source_state, pointer(path, "source_state")),
    targetState: nonemptyString(emit.target_state, pointer(path, "target_state")),
    obligations: uniqueSortedStrings(optionalStringArray(emit.obligations, pointer(path, "obligations")), pointer(path, "obligations")),
    targetNodes: cloneValue(emit.target_nodes ?? { variable: "target" }),
    readScope: cloneValue(emit.read_scope ?? { variable: "target" }),
    writeScope: cloneValue(emit.write_scope ?? { variable: "target" }),
    readPaths: cloneArray(emit.read_paths, pointer(path, "read_paths")),
    writePaths: cloneArray(emit.write_paths, pointer(path, "write_paths")),
    ...(emit.workflow === undefined ? {} : { workflow: nonemptyString(emit.workflow, pointer(path, "workflow")) }),
    ...(emit.title === undefined ? {} : { title: nonemptyString(emit.title, pointer(path, "title")) }),
  };
}

function materializeDerivations(
  rules: readonly ParsedRule[],
  evaluator: GraphExpressionEvaluator,
  programState: Record<string, ConfigurationValue>,
  configuration: CompiledConfiguration,
): DerivedFact[] {
  const facts: DerivedFact[] = [];
  for (const rule of rules) {
    if (rule.derivations.length === 0) continue;
    const rulePath = `/registries/rules/${escapePointer(rule.id)}`;
    const candidates = evaluator.select(rule.forEach, pointer(rulePath, "for_each"));
    const matched: string[] = [];
    for (const candidate of candidates) {
      const matches = evaluator.withBinding(
        rule.bind,
        [candidate],
        () => evaluator.evaluate(rule.when, pointer(rulePath, "when")),
        pointer(rulePath, "bind"),
      );
      if (matches) matched.push(candidate);
    }
    for (const anchorNodeId of matched) {
      for (const [ordinal, derivation] of rule.derivations.entries()) {
        const path = pointer(pointer(rulePath, "derive"), ordinal);
        const idHash = canonicalHash([
          rule.id,
          anchorNodeId,
          ordinal,
          derivation.source,
          configuration.configuration_sha256,
        ]);
        const material: FactMaterial = {
          protocol: DERIVED_FACT_PROTOCOL,
          id: `DF-${digestBody(idHash).slice(0, 16)}`,
          rule_id: rule.id,
          rule_phase: rule.phase,
          rule_priority: rule.priority,
          anchor_node_id: anchorNodeId,
          ordinal,
          kind: derivation.kind,
          ...optionalFactFields(derivation.source, path),
          args: derivation.args,
        };
        const fact: DerivedFact = {
          ...material,
          fact_sha256: canonicalHash(material),
        };
        facts.push(deepFreeze(fact));
        evaluator.materializeDerivation(
          anchorNodeId,
          derivation.kind,
          derivation.source,
          rule.id,
          programState,
          path,
        );
      }
    }
  }
  return facts;
}

function deriveTickets(
  rules: readonly ParsedRule[],
  evaluator: GraphExpressionEvaluator,
  configuration: CompiledConfiguration,
): DerivedTicketDefinition[] {
  const tickets = new Map<string, DerivedTicketDefinition>();
  for (const rule of rules) {
    if (rule.emit === undefined) continue;
    const rulePath = `/registries/rules/${escapePointer(rule.id)}`;
    const candidates = evaluator.select(rule.forEach, pointer(rulePath, "for_each"));
    for (const candidate of candidates) {
      const ticket = evaluator.withBinding(
        rule.bind,
        [candidate],
        () => evaluator.evaluate(rule.when, pointer(rulePath, "when"))
          ? deriveTicket(rule, rule.emit!, candidate, evaluator, configuration, rulePath)
          : undefined,
        pointer(rulePath, "bind"),
      );
      if (ticket === undefined) continue;
      const existing = tickets.get(ticket.id);
      if (existing !== undefined) {
        if (existing.definition_sha256 !== ticket.definition_sha256) {
          fail("rule.ticket_id_collision", pointer(rulePath, "emit"), `ticket ${ticket.id} has conflicting deterministic definitions`);
        }
        continue;
      }
      tickets.set(ticket.id, ticket);
    }
  }
  return [...tickets.values()];
}

function deriveTicket(
  rule: ParsedRule,
  emit: ParsedEmit,
  candidate: string,
  evaluator: GraphExpressionEvaluator,
  configuration: CompiledConfiguration,
  rulePath: string,
): DerivedTicketDefinition | undefined {
  const emitPath = pointer(rulePath, "emit");
  const targetNodeIds = [...evaluator.select(emit.targetNodes, pointer(emitPath, "target_nodes"))];
  if (targetNodeIds.length === 0) return undefined;
  const readNodeIds = [...evaluator.select(emit.readScope, pointer(emitPath, "read_scope"))];
  const writeNodeIds = [...evaluator.select(emit.writeScope, pointer(emitPath, "write_scope"))];
  return evaluator.withBinding(
    "ticket_read_scope",
    readNodeIds,
    () => evaluator.withBinding(
      "ticket_write_scope",
      writeNodeIds,
      () => {
        const readPaths = resolvePathScopes(emit.readPaths, evaluator, pointer(emitPath, "read_paths"));
        const writePaths = resolvePathScopes(emit.writePaths, evaluator, pointer(emitPath, "write_paths"));
        const operation = resolveOperation(rule, emit, targetNodeIds, evaluator, configuration, emitPath);
        const workflowId = emit.workflow ?? operation.workflow;
        const workflow = workflowId === undefined
          ? undefined
          : parseWorkflow(workflowId, emit.operation, configuration, emitPath);
        const id = deterministicTicketId(
          rule.id,
          targetNodeIds,
          emit.sourceState,
          configuration.configuration_sha256,
        );
        const steps = workflow === undefined
          ? []
          : compileWorkflowSteps(
              workflow,
              id,
              evaluator,
              readNodeIds,
              writeNodeIds,
              readPaths,
              writePaths,
              configuration.configuration_sha256,
              emitPath,
            );
        const anchor = evaluator.node(candidate);
        const title = emit.title === undefined
          ? `${emit.operation}: ${anchor?.title ?? "graph transition"}`
          : renderTicketTitle(emit.title, anchor, emit.operation);
        const material: TicketMaterial = {
          protocol: DERIVED_TICKET_PROTOCOL,
          id,
          rule_id: rule.id,
          rule_phase: rule.phase,
          rule_priority: rule.priority,
          anchor_node_id: candidate,
          operation: emit.operation,
          operation_registry_id: operation.id,
          operation_dispatch_priority: operation.dispatchPriority,
          ranking_hints: Object.freeze([...operation.rankingHints]),
          title,
          target_node_ids: Object.freeze(targetNodeIds),
          scope: deepFreeze({
            read_node_ids: readNodeIds,
            write_node_ids: writeNodeIds,
            read_paths: readPaths,
            write_paths: writePaths,
          }),
          source_state_key: emit.sourceState,
          target_state_key: emit.targetState,
          obligation_keys: Object.freeze([...emit.obligations]),
          ...(workflowId === undefined ? {} : { workflow_id: workflowId }),
          ...(workflow?.reviewFailureReopenFrom === undefined
            ? {}
            : { review_failure_reopen_from: workflow.reviewFailureReopenFrom }),
          workflow: Object.freeze(steps),
          configuration_sha256: configuration.configuration_sha256,
        };
        return deepFreeze({ ...material, definition_sha256: canonicalHash(material) });
      },
      pointer(emitPath, "write_scope"),
    ),
    pointer(emitPath, "read_scope"),
  );
}

export function deterministicTicketId(
  ruleId: string,
  targetNodeIds: readonly string[],
  sourceStateKey: string,
  configurationSha256: Sha256Digest,
): string {
  const targets = uniqueSortedStrings(targetNodeIds, "/ticket/target_node_ids");
  const hash = canonicalHash([ruleId, targets, sourceStateKey, configurationSha256]);
  return `TK-${digestBody(hash).slice(0, 16)}`;
}

function resolveOperation(
  rule: ParsedRule,
  emit: ParsedEmit,
  targetNodeIds: readonly string[],
  evaluator: GraphExpressionEvaluator,
  configuration: CompiledConfiguration,
  path: string,
): ParsedOperation {
  if (emit.registryEntryId !== undefined) {
    const source = configuration.registries.operations[emit.registryEntryId];
    if (source === undefined) {
      fail("rule.unknown_operation", pointer(path, "registry_entry_id"), `operation registry entry ${emit.registryEntryId} is not configured`);
    }
    return parseOperation(emit.registryEntryId, source);
  }
  const targetTypes = new Set<string>();
  for (const id of targetNodeIds) {
    const node = evaluator.node(id);
    if (node !== undefined) targetTypes.add(node.type);
  }
  const candidates = Object.entries(configuration.registries.operations)
    .map(([id, source]) => parseOperation(id, source))
    .filter((operation) =>
      operation.publicOperation === emit.operation &&
      [...targetTypes].every((type) => operation.targetTypes.includes(type)));
  const phaseMatches = candidates.filter((operation) => operation.stage === rule.phase);
  const matches = phaseMatches.length > 0 ? phaseMatches : candidates;
  if (matches.length === 0) {
    fail("rule.unknown_operation", pointer(path, "operation"), `rule ${rule.id} emits unknown operation ${emit.operation}`);
  }
  if (matches.length > 1) {
    fail(
      "rule.ambiguous_operation",
      pointer(path, "operation"),
      `operation ${emit.operation} is ambiguous for target types ${[...targetTypes].sort(compareUtf8).join(", ")}: ${matches.map((item) => item.id).sort(compareUtf8).join(", ")}`,
    );
  }
  return matches[0]!;
}

function parseOperation(id: string, source: ConfigurationObject): ParsedOperation {
  const path = `/registries/operations/${escapePointer(id)}`;
  const recordValue = record(source, path);
  const sourceId = nonemptyString(recordValue.id, pointer(path, "id"));
  if (sourceId !== id) fail("rule.operation_registry_id", pointer(path, "id"), `operation id ${sourceId} does not match registry key ${id}`);
  return {
    id,
    publicOperation: optionalString(recordValue.operation, pointer(path, "operation")) ?? id,
    stage: nonemptyString(recordValue.stage, pointer(path, "stage")),
    targetTypes: uniqueSortedStrings(optionalStringArray(recordValue.target_types, pointer(path, "target_types")), pointer(path, "target_types")),
    ...(recordValue.workflow === undefined ? {} : { workflow: nonemptyString(recordValue.workflow, pointer(path, "workflow")) }),
    dispatchPriority: optionalSignedInteger(recordValue.dispatch_priority, pointer(path, "dispatch_priority")) ?? 0,
    rankingHints: optionalStringArray(recordValue.ranking_hints, pointer(path, "ranking_hints")),
  };
}

function parseWorkflow(
  id: string,
  operation: string,
  configuration: CompiledConfiguration,
  emitPath: string,
): ParsedWorkflow {
  const source = configuration.registries.workflows[id];
  if (source === undefined) {
    fail("rule.unknown_workflow", pointer(emitPath, "workflow"), `workflow ${id} is not configured`);
  }
  const path = `/registries/workflows/${escapePointer(id)}`;
  const workflow = exactRecord(source, path, WORKFLOW_FIELDS, ["id", "steps"]);
  const sourceId = nonemptyString(workflow.id, pointer(path, "id"));
  if (sourceId !== id) fail("rule.workflow_registry_id", pointer(path, "id"), `workflow id ${sourceId} does not match registry key ${id}`);
  const appliesTo = uniqueSortedStrings(optionalStringArray(workflow.applies_to, pointer(path, "applies_to")), pointer(path, "applies_to"));
  if (appliesTo.length > 0 && !appliesTo.includes(operation)) {
    fail("rule.workflow_operation", pointer(path, "applies_to"), `workflow ${id} does not apply to operation ${operation}`);
  }
  const steps = arrayValue(workflow.steps!, pointer(path, "steps")).map((step, index) =>
    exactRecord(step, pointer(pointer(path, "steps"), index), STEP_FIELDS, ["id", "persona"]));
  const reviewFailureReopenFrom = parseReviewFailureReopenFrom(workflow, path);
  if (
    reviewFailureReopenFrom !== undefined &&
    !steps.some((step) => optionalString(step.id, pointer(path, "steps")) === reviewFailureReopenFrom)
  ) {
    fail(
      "rule.review_rework_step",
      pointer(path, "review_failure_reopen_from"),
      `workflow ${id} reopens unknown step ${reviewFailureReopenFrom}`,
    );
  }
  return {
    id,
    appliesTo,
    ...(reviewFailureReopenFrom === undefined ? {} : { reviewFailureReopenFrom }),
    steps,
  };
}

function parseReviewFailureReopenFrom(
  workflow: ConfigurationObject,
  path: string,
): string | undefined {
  const direct = optionalString(
    workflow.review_failure_reopen_from,
    pointer(path, "review_failure_reopen_from"),
  );
  if (workflow.review_failure_routes === undefined) return direct;
  const routes = record(workflow.review_failure_routes, pointer(path, "review_failure_routes"));
  const reopen = Object.entries(routes).flatMap(([routeId, value]) => {
    const routePath = pointer(pointer(path, "review_failure_routes"), routeId);
    const route = record(value, routePath);
    if (optionalString(route.disposition, pointer(routePath, "disposition")) !== "reopen") return [];
    return [nonemptyString(route.reopen_from, pointer(routePath, "reopen_from"))];
  });
  if (new Set(reopen).size > 1) {
    fail(
      "rule.review_rework_ambiguous",
      pointer(path, "review_failure_routes"),
      "workflow declares multiple distinct review-rework owner steps",
    );
  }
  const routed = reopen[0];
  if (direct !== undefined && routed !== undefined && direct !== routed) {
    fail(
      "rule.review_rework_ambiguous",
      pointer(path, "review_failure_routes"),
      "workflow direct and routed review-rework owners disagree",
    );
  }
  return direct ?? routed;
}

function compileWorkflowSteps(
  workflow: ParsedWorkflow,
  ticketId: string,
  evaluator: GraphExpressionEvaluator,
  ticketReadNodeIds: readonly string[],
  ticketWriteNodeIds: readonly string[],
  ticketReadPaths: readonly string[],
  ticketWritePaths: readonly string[],
  configurationSha256: Sha256Digest,
  emitPath: string,
): DerivedWorkflowStep[] {
  const ids = new Set<string>();
  const parsed = workflow.steps.map((step, index) => {
    const path = `/registries/workflows/${escapePointer(workflow.id)}/steps/${index}`;
    const id = nonemptyString(step.id, pointer(path, "id"));
    if (ids.has(id)) fail("rule.duplicate_workflow_step", pointer(path, "id"), `workflow ${workflow.id} has duplicate step ${id}`);
    ids.add(id);
    return { step, path, id };
  });
  for (const { step, path } of parsed) {
    for (const dependency of optionalStringArray(step.depends_on, pointer(path, "depends_on"))) {
      if (!ids.has(dependency)) fail("rule.unknown_workflow_step", pointer(path, "depends_on"), `workflow dependency references unknown step ${dependency}`);
    }
  }
  validateWorkflowDag(workflow.id, parsed);
  if (
    workflow.reviewFailureReopenFrom !== undefined &&
    !parsed.some(({ step, id }) =>
      (optionalString(step.kind, "/kind") ?? "production") === "review" &&
      transitivelyDependsOn(id, workflow.reviewFailureReopenFrom!, parsed))
  ) {
    fail(
      "rule.review_rework_dependency",
      `/registries/workflows/${escapePointer(workflow.id)}/review_failure_reopen_from`,
      `workflow ${workflow.id} review does not depend on its rework owner ${workflow.reviewFailureReopenFrom}`,
    );
  }

  const output: DerivedWorkflowStep[] = [];
  for (const { step, path, id } of parsed) {
    const readNodeIds = [...evaluator.select(step.read_scope ?? { variable: "ticket_read_scope" }, pointer(path, "read_scope"))];
    const writeNodeIds = [...evaluator.select(step.write_scope ?? { variable: "ticket_write_scope" }, pointer(path, "write_scope"))];
    if (!isSubset(readNodeIds, ticketReadNodeIds)) {
      fail("rule.step_scope", pointer(path, "read_scope"), `workflow ${workflow.id} step ${id} graph read scope exceeds ticket read scope`);
    }
    if (!isSubset(writeNodeIds, ticketWriteNodeIds)) {
      fail("rule.step_scope", pointer(path, "write_scope"), `workflow ${workflow.id} step ${id} graph write scope exceeds ticket write scope`);
    }
    const readPaths = step.read_paths === undefined
      ? undefined
      : resolvePathScopes(arrayValue(step.read_paths, pointer(path, "read_paths")), evaluator, pointer(path, "read_paths"));
    const writePaths = step.write_paths === undefined
      ? undefined
      : resolvePathScopes(arrayValue(step.write_paths, pointer(path, "write_paths")), evaluator, pointer(path, "write_paths"));
    for (const selected of readPaths ?? []) {
      if (!pathCoveredByScope(selected, ticketReadPaths)) {
        fail("rule.step_path_scope", pointer(path, "read_paths"), `workflow ${workflow.id} step ${id} read path ${selected} is outside ticket read scope`);
      }
    }
    for (const selected of writePaths ?? []) {
      if (!pathCoveredByScope(selected, ticketWritePaths)) {
        fail("rule.step_path_scope", pointer(path, "write_paths"), `workflow ${workflow.id} step ${id} write path ${selected} is outside ticket write scope`);
      }
    }
    const kind = optionalString(step.kind, pointer(path, "kind")) ?? "production";
    if (!WORKFLOW_STEP_KINDS.has(kind as DerivedWorkflowStepKind)) {
      fail("rule.workflow_step_kind", pointer(path, "kind"), `unsupported workflow step kind ${kind}`);
    }
    const graphMutation = optionalString(step.graph_mutation, pointer(path, "graph_mutation")) ?? "allowed";
    if (!GRAPH_MUTATION_POLICIES.has(graphMutation as DerivedGraphMutationPolicy)) {
      fail("rule.graph_mutation", pointer(path, "graph_mutation"), `unsupported graph mutation policy ${graphMutation}`);
    }
    const preserveSourcePathsFrom = optionalString(step.preserve_source_paths_from, pointer(path, "preserve_source_paths_from"));
    if (preserveSourcePathsFrom !== undefined && !transitivelyDependsOn(id, preserveSourcePathsFrom, parsed)) {
      fail("rule.preserve_source_dependency", pointer(path, "preserve_source_paths_from"), `step ${id} does not transitively depend on ${preserveSourcePathsFrom}`);
    }
    const differsReadNodes = !arraysEqual(readNodeIds, ticketReadNodeIds);
    const differsWriteNodes = !arraysEqual(writeNodeIds, ticketWriteNodeIds);
    const contextMaterial = [
      ticketId,
      id,
      ticketReadNodeIds,
      ticketWriteNodeIds,
      ticketReadPaths,
      ticketWritePaths,
      readPaths ?? null,
      writePaths ?? null,
      configurationSha256,
      preserveSourcePathsFrom ?? null,
      differsReadNodes ? readNodeIds : null,
      differsWriteNodes ? writeNodeIds : null,
    ];
    output.push(deepFreeze({
      id,
      kind: kind as DerivedWorkflowStepKind,
      persona_id: nonemptyString(step.persona, pointer(path, "persona")),
      depends_on: Object.freeze(uniqueSortedStrings(optionalStringArray(step.depends_on, pointer(path, "depends_on")), pointer(path, "depends_on"))),
      required: optionalBoolean(step.required, pointer(path, "required")) ?? true,
      ...(differsReadNodes ? { read_node_ids: Object.freeze(readNodeIds) } : {}),
      ...(differsWriteNodes ? { write_node_ids: Object.freeze(writeNodeIds) } : {}),
      ...(readPaths === undefined ? {} : { read_paths: Object.freeze(readPaths) }),
      ...(writePaths === undefined ? {} : { write_paths: Object.freeze(writePaths) }),
      ...(preserveSourcePathsFrom === undefined ? {} : { preserve_source_paths_from: preserveSourcePathsFrom }),
      expected_outputs: Object.freeze(step.expected_output === undefined
        ? []
        : [nonemptyString(step.expected_output, pointer(path, "expected_output"))]),
      graph_mutation: graphMutation as DerivedGraphMutationPolicy,
      ...(step.validation_action === undefined
        ? {}
        : { validation_action: nonemptyString(step.validation_action, pointer(path, "validation_action")) }),
      required_receipts: Object.freeze(uniqueSortedStrings(optionalStringArray(step.required_receipts, pointer(path, "required_receipts")), pointer(path, "required_receipts"))),
      escalation_triggers: Object.freeze(uniqueSortedStrings(optionalStringArray(step.escalation_triggers, pointer(path, "escalation_triggers")), pointer(path, "escalation_triggers"))),
      stop_conditions: Object.freeze(uniqueSortedStrings(optionalStringArray(step.stop_conditions, pointer(path, "stop_conditions")), pointer(path, "stop_conditions"))),
      validation_checks: Object.freeze(uniqueSortedStrings(optionalStringArray(step.checks, pointer(path, "checks")), pointer(path, "checks"))),
      context_sha256: canonicalHash(contextMaterial),
    }));
  }
  void emitPath;
  return output;
}

function validateWorkflowDag(
  workflowId: string,
  steps: readonly { step: ConfigurationObject; path: string; id: string }[],
): void {
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    const cycleIndex = visiting.indexOf(id);
    if (cycleIndex >= 0) {
      fail("rule.workflow_cycle", `/registries/workflows/${escapePointer(workflowId)}/steps`, `workflow dependency cycle: ${[...visiting.slice(cycleIndex), id].join(" -> ")}`);
    }
    if (visited.has(id)) return;
    visiting.push(id);
    const entry = byId.get(id)!;
    for (const dependency of optionalStringArray(entry.step.depends_on, pointer(entry.path, "depends_on"))) visit(dependency);
    visiting.pop();
    visited.add(id);
  };
  for (const id of [...byId.keys()].sort(compareUtf8)) visit(id);
}

function transitivelyDependsOn(
  stepId: string,
  expected: string,
  steps: readonly { step: ConfigurationObject; path: string; id: string }[],
): boolean {
  const byId = new Map(steps.map((step) => [step.id, step.step] as const));
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (!seen.add(id)) return false;
    for (const dependency of optionalStringArray(byId.get(id)?.depends_on, "/depends_on")) {
      if (dependency === expected || visit(dependency)) return true;
    }
    return false;
  };
  return visit(stepId);
}

function resolvePathScopes(
  definitions: readonly ConfigurationValue[],
  evaluator: GraphExpressionEvaluator,
  path: string,
): string[] {
  const output = new Set<string>();
  for (const [index, definition] of definitions.entries()) {
    const itemPath = pointer(path, index);
    if (typeof definition === "string") {
      output.add(validateScopePath(definition, itemPath));
      continue;
    }
    const projection = exactRecord(definition, itemPath, ["select", "field"], ["select", "field"]);
    const field = nonemptyString(projection.field, pointer(itemPath, "field"));
    for (const nodeId of evaluator.select(projection.select!, pointer(itemPath, "select"))) {
      const value = evaluator.field(nodeId, field);
      if (value === undefined) continue;
      const values = typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.map((item, valueIndex) => nonemptyString(item, pointer(pointer(itemPath, "value"), valueIndex)))
          : fail("rule.path_projection", itemPath, `path projection ${nodeId}.${field} must be a path string or list of path strings`);
      for (const selected of values) output.add(validateScopePath(selected, itemPath));
    }
  }
  return [...output].sort(compareUtf8);
}

function validateScopePath(value: string, path: string): string {
  if (value.length === 0 || value.includes("\0") || value.includes("*") || value.includes("?")) {
    fail("rule.path_scope", path, "ticket path scope must be a nonempty literal path without NUL or glob characters");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    fail("rule.path_scope", path, `ticket path scope must be project-relative: ${value}`);
  }
  const segments = normalized.split("/");
  if (segments.includes("..")) fail("rule.path_scope", path, `ticket path scope may not escape the project: ${value}`);
  const compact = segments.filter((segment) => segment !== "" && segment !== ".");
  return compact.length === 0 ? "." : compact.join("/");
}

function pathCoveredByScope(path: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`));
}

function renderTicketTitle(
  template: string,
  target: ReturnType<GraphExpressionEvaluator["node"]>,
  operation: string,
): string {
  return template
    .replaceAll("{{ operation }}", operation)
    .replaceAll("{{ target.title }}", target?.title ?? "graph transition")
    .replaceAll("{{ target.type }}", target?.type ?? "node")
    .replaceAll("{{ target.id }}", target?.id ?? "unknown");
}

function optionalFactFields(source: ConfigurationObject, path: string): Partial<FactMaterial> {
  return {
    ...(source.key === undefined ? {} : { key: nonemptyString(source.key, pointer(path, "key")) }),
    ...(source.target === undefined ? {} : { target: nonemptyString(source.target, pointer(path, "target")) }),
    ...(source.field === undefined ? {} : { field: nonemptyString(source.field, pointer(path, "field")) }),
    ...(source.value === undefined ? {} : { value: cloneValue(source.value) }),
    ...(source.severity === undefined ? {} : { severity: nonemptyString(source.severity, pointer(path, "severity")) }),
    ...(source.reason === undefined ? {} : { reason: nonemptyString(source.reason, pointer(path, "reason")) }),
  };
}

function compareRules(left: ParsedRule, right: ParsedRule): number {
  return compareUtf8(left.phase, right.phase) || right.priority - left.priority || compareUtf8(left.id, right.id);
}

function isSubset(left: readonly string[], right: readonly string[]): boolean {
  const allowed = new Set(right);
  return left.every((value) => allowed.has(value));
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function digestBody(hash: Sha256Digest): string {
  return hash.slice("sha256:".length);
}

function exactRecord(
  value: ConfigurationValue,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = [],
): ConfigurationObject {
  const output = record(value, path);
  const permitted = new Set(allowed);
  for (const key of Object.keys(output)) {
    if (!permitted.has(key)) fail("rule.unknown_field", pointer(path, key), `configuration contains unknown field ${key}`);
  }
  for (const key of required) {
    if (output[key] === undefined) fail("rule.missing_field", pointer(path, key), `required field ${key} is missing`);
  }
  return output;
}

function record(value: ConfigurationValue, path: string): ConfigurationObject {
  if (!isConfigurationObject(value)) {
    fail("rule.mapping", path, "expected a mapping");
  }
  return value;
}

function arrayValue(value: ConfigurationValue, path: string): readonly ConfigurationValue[] {
  if (!Array.isArray(value)) fail("rule.array", path, "expected an array");
  return value;
}

function cloneArray(value: ConfigurationValue | undefined, path: string): readonly ConfigurationValue[] {
  return value === undefined ? [] : arrayValue(value, path).map(cloneValue);
}

function nonemptyString(value: ConfigurationValue | undefined, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("rule.string", path, "expected a nonempty string");
  }
  return value;
}

function optionalString(value: ConfigurationValue | undefined, path: string): string | undefined {
  return value === undefined ? undefined : nonemptyString(value, path);
}

function optionalBoolean(value: ConfigurationValue | undefined, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail("rule.boolean", path, "expected a boolean");
  return value;
}

function optionalSignedInteger(value: ConfigurationValue | undefined, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("rule.integer", path, "expected a safe integer");
  }
  return value;
}

function optionalStringArray(value: ConfigurationValue | undefined, path: string): string[] {
  if (value === undefined) return [];
  return arrayValue(value, path).map((item, index) => nonemptyString(item, pointer(path, index)));
}

function uniqueSortedStrings(values: readonly string[], path: string): string[] {
  const sorted = [...values].sort(compareUtf8);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      fail("rule.duplicate_value", path, `duplicate value ${sorted[index]}`);
    }
  }
  return sorted;
}

function cloneValue(value: ConfigurationValue): ConfigurationValue {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isConfigurationObject(value)) return cloneObject(value);
  return value;
}

function isConfigurationObject(value: ConfigurationValue): value is ConfigurationObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneObject(value: ConfigurationObject): ConfigurationObject {
  const output: Record<string, ConfigurationValue> = Object.create(null) as Record<string, ConfigurationValue>;
  for (const key of Object.keys(value).sort(compareUtf8)) output[key] = cloneValue(value[key]!);
  return output;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function fail(code: string, path: string, message: string): never {
  throw new RuleCompilationError(code, path, message);
}
