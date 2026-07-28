import type { JsonValue } from "../authority/protocol.js";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import {
  GraphSchema,
  GraphValidationError,
  type GraphSchemaDefinition,
  type GraphEdgeTypeDefinition,
  type GraphFieldDefinition,
  type GraphGateCapabilityContract,
  type GraphCompilerFieldSource,
  type GraphNodeTypeDefinition,
} from "../graph/model.js";
import { canonicalHash, compareUtf8, type Sha256Digest } from "../shared/canonical.js";
import {
  DiagnosticBag,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "../shared/diagnostics.js";
import { GraphExpressionEvaluator } from "./expressions.js";

const FIELD_TYPES = new Set<GraphFieldDefinition["type"]>([
  "string",
  "boolean",
  "number",
  "integer",
  "list",
  "object",
  "path",
  "node_ref",
  "json",
]);

export interface CompiledGraphPathSetDefinition {
  readonly select: ConfigurationValue;
  readonly nodeTypes: readonly string[];
  readonly field: string;
}

export interface CompiledGraphConstraintDefinition {
  readonly id: string;
  readonly kind: "path_sets_disjoint";
  readonly left: CompiledGraphPathSetDefinition;
  readonly right: CompiledGraphPathSetDefinition;
  readonly distinctNodes: boolean;
}

export interface CompiledGateEvaluationContextDefinition {
  readonly select: ConfigurationValue;
  readonly readPaths: readonly (
    | string
    | {
        readonly select: ConfigurationValue;
        readonly field: string;
      }
  )[];
}

export interface CompiledGatePolicyDefinition {
  readonly id: string;
  readonly gateNodeTypes: readonly string[];
  readonly gateSubjects: ConfigurationValue;
  readonly candidateNodeTypes: readonly string[];
  readonly candidatePool: ConfigurationValue;
  readonly evaluationTargets: Readonly<{
    select: ConfigurationValue;
    cardinality: "exactly_one" | "zero_or_one" | "one_or_more";
  }>;
  readonly capability: GraphGateCapabilityContract;
  readonly passingReceiptStatuses: readonly string[];
  readonly obligationKeyTemplate: string;
  readonly missingGateObligationKeyTemplate: string;
  readonly applicability: Readonly<{
    subjectNodeTypes: readonly string[];
    requiredSubjectNodeTypes: readonly string[];
    contextClassOrder: readonly string[];
    directGates: ConfigurationValue;
    inheritedGates: ConfigurationValue;
    context: ConfigurationValue;
    contextClasses: ConfigurationObject;
  }>;
  readonly context?: CompiledGateEvaluationContextDefinition;
  readonly contractSha256: Sha256Digest;
}

/** Build the executable graph schema owned by graph/model.ts from compiler configuration. */
export function projectGraphSchemaDefinition(
  configuration: CompiledConfiguration,
): ValidationResult<GraphSchemaDefinition> {
  const bag = new DiagnosticBag();
  const gatePolicies = projectGatePolicyDefinitions(configuration);
  bag.extend(gatePolicies.diagnostics);
  const policiesById = new Map(
    gatePolicies.ok ? gatePolicies.value.map((policy) => [policy.id, policy] as const) : [],
  );
  const nodeTypes: GraphNodeTypeDefinition[] = [];
  for (const [registryId, source] of Object.entries(configuration.registries.node_types)) {
    const path = `/registries/node_types/${escapePointer(registryId)}`;
    const id = requiredString(source.id, `${path}/id`, bag);
    const description = requiredString(source.description, `${path}/description`, bag);
    const statuses = stringArray(source.statuses, `${path}/statuses`, bag);
    const initialStatus = requiredString(source.initial_status, `${path}/initial_status`, bag);
    const fields = fieldMap(source.fields, `${path}/fields`, bag);
    if (id !== undefined && id !== registryId) {
      bag.error(
        "graph_schema.registry_id",
        `${path}/id`,
        `node type id ${id} does not match registry key ${registryId}`,
      );
    }
    if (
      id === undefined ||
      description === undefined ||
      initialStatus === undefined ||
      fields === undefined
    )
      continue;
    nodeTypes.push({
      id,
      description,
      ...(source.stage === undefined
        ? {}
        : { stage: requiredString(source.stage, `${path}/stage`, bag) ?? "" }),
      ...(source.annotations === undefined
        ? {}
        : { annotations: jsonObject(source.annotations, `${path}/annotations`, bag) }),
      statuses,
      initial_status: initialStatus,
      ...(source.semantic_fields === undefined
        ? {}
        : { semantic_fields: stringArray(source.semantic_fields, `${path}/semantic_fields`, bag) }),
      ...(source.compiler_owned_fields === undefined
        ? {}
        : {
            compiler_owned_fields: stringArray(
              source.compiler_owned_fields,
              `${path}/compiler_owned_fields`,
              bag,
            ),
          }),
      ...(source.agent_visible_compiler_owned_fields === undefined
        ? {}
        : {
            agent_visible_compiler_owned_fields: stringArray(
              source.agent_visible_compiler_owned_fields,
              `${path}/agent_visible_compiler_owned_fields`,
              bag,
            ),
          }),
      ...(source.compiler_field_sources === undefined
        ? {}
        : {
            compiler_field_sources: compilerFieldSources(
              source.compiler_field_sources,
              `${path}/compiler_field_sources`,
              bag,
            ),
          }),
      ...(source.gate_required === undefined
        ? {}
        : {
            gate_required:
              booleanValue(source.gate_required, `${path}/gate_required`, bag) ?? false,
          }),
      ...(source.required_any === undefined
        ? {}
        : { required_any: nestedStringArrays(source.required_any, `${path}/required_any`, bag) }),
      fields,
    });
  }
  nodeTypes.sort((left, right) => compareUtf8(left.id, right.id));

  const edgeTypes: GraphEdgeTypeDefinition[] = [];
  for (const [index, source] of configuration.edge_types.entries()) {
    const path = `/edge_types/${index}`;
    const sourceType = requiredString(source.source, `${path}/source`, bag);
    const relation = requiredString(source.relation, `${path}/relation`, bag);
    const targets = stringArray(source.targets, `${path}/targets`, bag);
    if (sourceType === undefined || relation === undefined) continue;
    const when =
      source.when === undefined
        ? undefined
        : edgePredicate(source.when, `${path}/when`, policiesById, bag);
    edgeTypes.push({
      source: sourceType,
      relation,
      targets,
      ...(source.inverse === undefined
        ? {}
        : { inverse: requiredString(source.inverse, `${path}/inverse`, bag) ?? "" }),
      ...(source.bidirectional === undefined
        ? {}
        : {
            bidirectional:
              booleanValue(source.bidirectional, `${path}/bidirectional`, bag) ?? false,
          }),
      ...(source.min === undefined
        ? {}
        : { min: nonnegativeInteger(source.min, `${path}/min`, bag) ?? 0 }),
      ...(source.max === undefined
        ? {}
        : { max: nonnegativeInteger(source.max, `${path}/max`, bag) ?? 0 }),
      ...(source.acyclic === undefined
        ? {}
        : { acyclic: booleanValue(source.acyclic, `${path}/acyclic`, bag) ?? false }),
      ...(when === undefined ? {} : { when }),
    });
  }
  const requiredByGatePolicies = new Set(
    [...policiesById.values()].flatMap((policy) => [
      ...policy.applicability.requiredSubjectNodeTypes,
    ]),
  );
  for (const nodeType of nodeTypes) {
    const required = requiredByGatePolicies.has(nodeType.id);
    if ((nodeType.gate_required ?? false) !== required) {
      bag.error(
        "graph_schema.gate_required",
        `/registries/node_types/${escapePointer(nodeType.id)}/gate_required`,
        required
          ? `node type ${nodeType.id} is required by a gate policy and must declare gate_required: true`
          : `node type ${nodeType.id} declares gate_required but is not required by any gate policy`,
      );
    }
  }
  edgeTypes.sort(
    (left, right) =>
      compareUtf8(left.source, right.source) || compareUtf8(left.relation, right.relation),
  );
  if (bag.hasErrors()) return validationFailure(bag.sorted());
  const definition = deepFreeze({ nodeTypes, edgeTypes });
  let schema: GraphSchema | undefined;
  try {
    // Keep semantic graph validation in its owning runtime while returning a
    // definition that consumers can instantiate without a second failure path.
    schema = new GraphSchema(definition);
  } catch (error) {
    if (error instanceof GraphValidationError) {
      for (const message of error.diagnostics) {
        bag.error("graph_schema.semantic", "/graph_schema", message);
      }
    } else {
      bag.error(
        "graph_schema.semantic",
        "/graph_schema",
        "graph runtime rejected the compiled schema",
      );
    }
  }
  if (schema !== undefined) {
    bag.extend(projectGraphConstraintDefinitions(configuration, schema).diagnostics);
  }
  if (bag.hasErrors()) return validationFailure(bag.sorted());
  return validationSuccess(definition, bag.sorted());
}

/** Compile the finite gate-policy subset consumed by graph and rule authority. */
export function projectGatePolicyDefinitions(
  configuration: CompiledConfiguration,
): ValidationResult<readonly CompiledGatePolicyDefinition[]> {
  const bag = new DiagnosticBag();
  const output: CompiledGatePolicyDefinition[] = [];
  const knownNodeTypes = new Set(Object.keys(configuration.registries.node_types));
  const evaluator = new GraphExpressionEvaluator(configuration, {
    nodes: () => [],
    node: () => undefined,
  });
  for (const binding of [
    "gate",
    "winner",
    "candidate",
    "target",
    "evaluation_targets",
    "subject",
    "ancestors",
    "direct_gates",
    "inherited_gates",
    "applicable_gates",
    "context",
  ])
    evaluator.bind(binding, []);
  for (const [registryId, raw] of Object.entries(configuration.registries.gate_policies)) {
    const path = `/registries/gate_policies/${escapePointer(registryId)}`;
    gateExactKeys(
      raw,
      path,
      [
        "id",
        "description",
        "gate_node_types",
        "gate_subjects",
        "candidate_node_types",
        "candidate_pool",
        "evaluation_targets",
        "capability",
        "selection",
        "passing_receipt_statuses",
        "auto_evaluate",
        "execution_ready",
        "obligation_key_template",
        "missing_gate_obligation_key_template",
        "applicability",
        "context",
      ],
      bag,
    );
    const id = requiredString(raw.id, `${path}/id`, bag);
    if (id !== undefined && id !== registryId) {
      bag.error(
        "gate_policy.registry_id",
        `${path}/id`,
        `gate policy id ${id} does not match registry key ${registryId}`,
      );
    }
    const gateNodeTypes = uniqueTrimmedStrings(raw.gate_node_types, `${path}/gate_node_types`, bag);
    const candidateNodeTypes = uniqueTrimmedStrings(
      raw.candidate_node_types,
      `${path}/candidate_node_types`,
      bag,
    );
    for (const [label, values] of [
      ["gate_node_types", gateNodeTypes],
      ["candidate_node_types", candidateNodeTypes],
    ] as const) {
      for (const value of values)
        if (!knownNodeTypes.has(value)) {
          bag.error(
            "gate_policy.node_type",
            `${path}/${label}`,
            `gate policy ${registryId} references unknown node type ${value}`,
          );
        }
    }
    const capabilitySource = objectValue(raw.capability, `${path}/capability`, bag);
    if (capabilitySource !== undefined)
      gateExactKeys(
        capabilitySource,
        `${path}/capability`,
        [
          "required_name_fields",
          "required_version_req_fields",
          "provider_collection_fields",
          "provider_name_fields",
          "provider_version_fields",
        ],
        bag,
      );
    const capabilityMaterial = {
      policy_id: registryId,
      gate_node_types: gateNodeTypes,
      candidate_node_types: candidateNodeTypes,
      required_name_fields: uniqueFieldPaths(
        capabilitySource?.required_name_fields,
        `${path}/capability/required_name_fields`,
        bag,
      ),
      required_version_req_fields: uniqueFieldPaths(
        capabilitySource?.required_version_req_fields,
        `${path}/capability/required_version_req_fields`,
        bag,
      ),
      provider_collection_fields: uniqueFieldPaths(
        capabilitySource?.provider_collection_fields,
        `${path}/capability/provider_collection_fields`,
        bag,
      ),
      provider_name_fields: uniqueFieldPaths(
        capabilitySource?.provider_name_fields,
        `${path}/capability/provider_name_fields`,
        bag,
      ),
      provider_version_fields: uniqueFieldPaths(
        capabilitySource?.provider_version_fields,
        `${path}/capability/provider_version_fields`,
        bag,
      ),
    } as const;
    const capability: GraphGateCapabilityContract = deepFreeze({
      ...capabilityMaterial,
      contract_sha256: canonicalHash(capabilityMaterial),
    });
    const passingReceiptStatuses = uniqueTrimmedStrings(
      raw.passing_receipt_statuses,
      `${path}/passing_receipt_statuses`,
      bag,
    );
    const obligationKeyTemplate = requiredString(
      raw.obligation_key_template,
      `${path}/obligation_key_template`,
      bag,
    );
    const missingGateObligationKeyTemplate = requiredString(
      raw.missing_gate_obligation_key_template,
      `${path}/missing_gate_obligation_key_template`,
      bag,
    );
    if (obligationKeyTemplate !== undefined && !obligationKeyTemplate.includes("{{ gate.id }}")) {
      bag.error(
        "gate_policy.obligation_template",
        `${path}/obligation_key_template`,
        "gate obligation template must contain {{ gate.id }}",
      );
    }
    if (
      missingGateObligationKeyTemplate !== undefined &&
      !missingGateObligationKeyTemplate.includes("{{ subject.id }}")
    ) {
      bag.error(
        "gate_policy.missing_obligation_template",
        `${path}/missing_gate_obligation_key_template`,
        "missing-gate obligation template must contain {{ subject.id }}",
      );
    }
    const applicabilitySource = objectValue(raw.applicability, `${path}/applicability`, bag);
    if (applicabilitySource !== undefined)
      gateExactKeys(
        applicabilitySource,
        `${path}/applicability`,
        [
          "subject_node_types",
          "required_subject_node_types",
          "context_class_order",
          "direct_gates",
          "inherited_gates",
          "context",
          "context_classes",
        ],
        bag,
      );
    const subjectNodeTypes = uniqueTrimmedStrings(
      applicabilitySource?.subject_node_types,
      `${path}/applicability/subject_node_types`,
      bag,
    );
    const requiredSubjectNodeTypes = uniqueTrimmedStrings(
      applicabilitySource?.required_subject_node_types,
      `${path}/applicability/required_subject_node_types`,
      bag,
      true,
    );
    for (const value of subjectNodeTypes)
      if (!knownNodeTypes.has(value)) {
        bag.error(
          "gate_policy.subject_node_type",
          `${path}/applicability/subject_node_types`,
          `unknown gate subject node type ${value}`,
        );
      }
    for (const value of requiredSubjectNodeTypes) {
      if (!subjectNodeTypes.includes(value)) {
        bag.error(
          "gate_policy.required_subject",
          `${path}/applicability/required_subject_node_types`,
          `${value} is not an applicability subject type`,
        );
      }
    }
    const contextClassOrder = uniqueTrimmedStrings(
      applicabilitySource?.context_class_order,
      `${path}/applicability/context_class_order`,
      bag,
    );
    const contextClasses =
      objectValue(
        applicabilitySource?.context_classes,
        `${path}/applicability/context_classes`,
        bag,
      ) ?? {};
    if (
      contextClassOrder.length !== Object.keys(contextClasses).length ||
      contextClassOrder.some((name) => !Object.hasOwn(contextClasses, name))
    )
      bag.error(
        "gate_policy.context_classes",
        `${path}/applicability/context_classes`,
        "context classes must exactly match context_class_order",
      );
    const classified = new Map<string, string>();
    for (const className of contextClassOrder) {
      const classSource = objectValue(
        contextClasses[className],
        `${path}/applicability/context_classes/${escapePointer(className)}`,
        bag,
      );
      const nodes =
        classSource === undefined
          ? undefined
          : objectValue(
              classSource.nodes,
              `${path}/applicability/context_classes/${escapePointer(className)}/nodes`,
              bag,
            );
      if (classSource !== undefined)
        gateExactKeys(
          classSource,
          `${path}/applicability/context_classes/${escapePointer(className)}`,
          ["nodes"],
          bag,
        );
      if (nodes !== undefined)
        gateExactKeys(
          nodes,
          `${path}/applicability/context_classes/${escapePointer(className)}/nodes`,
          ["node_types"],
          bag,
        );
      for (const nodeType of uniqueTrimmedStrings(
        nodes?.node_types,
        `${path}/applicability/context_classes/${escapePointer(className)}/nodes/node_types`,
        bag,
      )) {
        const prior = classified.get(nodeType);
        if (prior !== undefined)
          bag.error(
            "gate_policy.context_class_overlap",
            `${path}/applicability/context_classes`,
            `${nodeType} belongs to both ${prior} and ${className}`,
          );
        classified.set(nodeType, className);
      }
    }
    for (const subjectType of subjectNodeTypes)
      if (!classified.has(subjectType)) {
        bag.error(
          "gate_policy.context_class_missing",
          `${path}/applicability/context_classes`,
          `${subjectType} has no applicability context class`,
        );
      }
    const evaluationTargetsSource = objectValue(
      raw.evaluation_targets,
      `${path}/evaluation_targets`,
      bag,
    );
    if (evaluationTargetsSource !== undefined)
      gateExactKeys(
        evaluationTargetsSource,
        `${path}/evaluation_targets`,
        ["select", "cardinality"],
        bag,
      );
    const cardinality = optionalGateCardinality(
      evaluationTargetsSource?.cardinality,
      `${path}/evaluation_targets/cardinality`,
      bag,
    );
    const context = gateEvaluationContext(raw.context, `${path}/context`, evaluator, bag);
    for (const [label, selector] of [
      ["gate_subjects", raw.gate_subjects],
      ["candidate_pool", raw.candidate_pool],
      ["evaluation_targets", evaluationTargetsSource?.select],
      ["applicability/direct_gates", applicabilitySource?.direct_gates],
      ["applicability/inherited_gates", applicabilitySource?.inherited_gates],
      ["applicability/context", applicabilitySource?.context],
    ] as const)
      validateSelector(selector, `${path}/${label}`, evaluator, bag);
    if (
      id === undefined ||
      raw.gate_subjects === undefined ||
      raw.candidate_pool === undefined ||
      evaluationTargetsSource?.select === undefined ||
      obligationKeyTemplate === undefined ||
      missingGateObligationKeyTemplate === undefined ||
      applicabilitySource?.direct_gates === undefined ||
      applicabilitySource.inherited_gates === undefined ||
      applicabilitySource.context === undefined
    )
      continue;
    const material = {
      id,
      gateNodeTypes,
      gateSubjects: structuredClone(raw.gate_subjects),
      candidateNodeTypes,
      candidatePool: structuredClone(raw.candidate_pool),
      evaluationTargets: {
        select: structuredClone(evaluationTargetsSource.select),
        cardinality,
      },
      capability,
      passingReceiptStatuses,
      obligationKeyTemplate,
      missingGateObligationKeyTemplate,
      applicability: {
        subjectNodeTypes,
        requiredSubjectNodeTypes,
        contextClassOrder,
        directGates: structuredClone(applicabilitySource.direct_gates),
        inheritedGates: structuredClone(applicabilitySource.inherited_gates),
        context: structuredClone(applicabilitySource.context),
        contextClasses: structuredClone(contextClasses),
      },
      ...(context === undefined ? {} : { context }),
    } as const;
    output.push(deepFreeze({ ...material, contractSha256: canonicalHash(material) }));
  }
  output.sort((left, right) => compareUtf8(left.id, right.id));
  if (bag.hasErrors()) return validationFailure(bag.sorted());
  return validationSuccess(deepFreeze(output), bag.sorted());
}

/** Parse and type-check every whole-graph invariant the compiled profile can execute. */
export function projectGraphConstraintDefinitions(
  configuration: CompiledConfiguration,
  schema: GraphSchema,
): ValidationResult<readonly CompiledGraphConstraintDefinition[]> {
  const bag = new DiagnosticBag();
  const constraints: CompiledGraphConstraintDefinition[] = [];
  const evaluator = new GraphExpressionEvaluator(configuration, {
    nodes: () => [],
    node: () => undefined,
  });
  for (const [registryId, source] of Object.entries(configuration.registries.graph_constraints)) {
    const root = `/registries/graph_constraints/${escapePointer(registryId)}`;
    exactKeys(source, root, ["id", "kind", "left", "right", "distinct_nodes"], bag);
    const id = requiredString(source.id, `${root}/id`, bag);
    if (id !== undefined && id !== registryId) {
      bag.error(
        "graph_constraint.registry_id",
        `${root}/id`,
        `graph constraint id ${id} does not match registry key ${registryId}`,
      );
    }
    const kind = requiredString(source.kind, `${root}/kind`, bag);
    if (kind !== undefined && kind !== "path_sets_disjoint") {
      bag.error(
        "graph_constraint.kind",
        `${root}/kind`,
        `unsupported graph constraint kind ${kind}`,
      );
    }
    const left = graphPathSet(source.left, `${root}/left`, schema, bag);
    const right = graphPathSet(source.right, `${root}/right`, schema, bag);
    const distinctNodes =
      source.distinct_nodes === undefined
        ? false
        : (booleanValue(source.distinct_nodes, `${root}/distinct_nodes`, bag) ?? false);
    if (
      id === undefined ||
      kind !== "path_sets_disjoint" ||
      left === undefined ||
      right === undefined
    )
      continue;
    for (const [side, definition] of [
      ["left", left],
      ["right", right],
    ] as const) {
      try {
        evaluator.select(definition.select, `${root}/${side}/select`);
      } catch (error) {
        bag.error(
          "graph_constraint.selector",
          `${root}/${side}/select`,
          error instanceof Error ? error.message : "graph constraint selector is invalid",
        );
      }
    }
    if (canonicalHash(left) === canonicalHash(right) && !distinctNodes) {
      bag.error(
        "graph_constraint.self_compare",
        root,
        `graph constraint ${id} compares one path set with itself and must set distinct_nodes: true`,
      );
    }
    constraints.push(deepFreeze({ id, kind, left, right, distinctNodes }));
  }
  constraints.sort((left, right) => compareUtf8(left.id, right.id));
  if (bag.hasErrors()) return validationFailure(bag.sorted());
  return validationSuccess(deepFreeze(constraints), bag.sorted());
}

function edgePredicate(
  value: ConfigurationValue,
  path: string,
  policies: ReadonlyMap<string, CompiledGatePolicyDefinition>,
  bag: DiagnosticBag,
): GraphEdgeTypeDefinition["when"] {
  const source = objectValue(value, path, bag);
  if (source === undefined) return undefined;
  gateExactKeys(source, path, ["op", "gate_policy", "subject", "gate_subject"], bag);
  const op = requiredString(source.op, `${path}/op`, bag);
  const policyId = requiredString(source.gate_policy, `${path}/gate_policy`, bag);
  const subject = requiredString(source.subject, `${path}/subject`, bag);
  const gateSubject = requiredString(source.gate_subject, `${path}/gate_subject`, bag);
  if (op !== undefined && op !== "gate_policy_compatible") {
    bag.error("graph_schema.edge_predicate", `${path}/op`, `unsupported edge predicate ${op}`);
  }
  if (subject !== undefined && subject !== "$source") {
    bag.error(
      "graph_schema.edge_predicate_subject",
      `${path}/subject`,
      "edge predicate subject must be $source",
    );
  }
  if (gateSubject !== undefined && gateSubject !== "$target") {
    bag.error(
      "graph_schema.edge_predicate_target",
      `${path}/gate_subject`,
      "edge predicate gate_subject must be $target",
    );
  }
  const policy = policyId === undefined ? undefined : policies.get(policyId);
  if (policyId !== undefined && policy === undefined) {
    bag.error(
      "graph_schema.edge_predicate_policy",
      `${path}/gate_policy`,
      `unknown gate policy ${policyId}`,
    );
  }
  if (
    op !== "gate_policy_compatible" ||
    policy === undefined ||
    subject !== "$source" ||
    gateSubject !== "$target"
  )
    return undefined;
  return deepFreeze({
    op,
    gate_policy: policy.id,
    subject,
    gate_subject: gateSubject,
    capability: policy.capability,
  });
}

function gateEvaluationContext(
  value: ConfigurationValue | undefined,
  path: string,
  evaluator: GraphExpressionEvaluator,
  bag: DiagnosticBag,
): CompiledGateEvaluationContextDefinition | undefined {
  if (value === undefined) return undefined;
  const source = objectValue(value, path, bag);
  if (source === undefined) return undefined;
  gateExactKeys(source, path, ["select", "read_paths"], bag);
  validateSelector(source.select, `${path}/select`, evaluator, bag);
  const rawPaths = source.read_paths;
  if (!Array.isArray(rawPaths)) {
    bag.error(
      "gate_policy.context_read_paths",
      `${path}/read_paths`,
      "gate context read_paths must be an array",
    );
    return source.select === undefined
      ? undefined
      : { select: structuredClone(source.select), readPaths: [] };
  }
  const readPaths: Array<string | { select: ConfigurationValue; field: string }> = [];
  for (const [index, raw] of rawPaths.entries()) {
    const itemPath = `${path}/read_paths/${index}`;
    if (typeof raw === "string") {
      const normalized = normalizedScopePath(raw);
      if (normalized === undefined)
        bag.error(
          "gate_policy.context_path",
          itemPath,
          "gate context path must be project-relative and literal",
        );
      else readPaths.push(normalized);
      continue;
    }
    const projection = objectValue(raw, itemPath, bag);
    if (projection === undefined) continue;
    gateExactKeys(projection, itemPath, ["select", "field"], bag);
    validateSelector(projection.select, `${itemPath}/select`, evaluator, bag);
    const field = requiredString(projection.field, `${itemPath}/field`, bag);
    if (field !== undefined && !isContractFieldPath(field)) {
      bag.error(
        "gate_policy.context_field",
        `${itemPath}/field`,
        `invalid gate context field path ${field}`,
      );
    }
    if (projection.select !== undefined && field !== undefined && isContractFieldPath(field)) {
      readPaths.push({ select: structuredClone(projection.select), field });
    }
  }
  if (source.select === undefined) return undefined;
  return deepFreeze({ select: structuredClone(source.select), readPaths });
}

function validateSelector(
  value: ConfigurationValue | undefined,
  path: string,
  evaluator: GraphExpressionEvaluator,
  bag: DiagnosticBag,
): void {
  if (value === undefined) {
    bag.error("gate_policy.selector", path, "gate policy selector is required");
    return;
  }
  try {
    evaluator.select(value, path);
  } catch (error) {
    bag.error(
      "gate_policy.selector",
      path,
      error instanceof Error ? error.message : "gate policy selector is invalid",
    );
  }
}

function optionalGateCardinality(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): "exactly_one" | "zero_or_one" | "one_or_more" {
  if (value === undefined) return "exactly_one";
  const parsed = requiredString(value, path, bag);
  if (parsed === "exactly_one" || parsed === "zero_or_one" || parsed === "one_or_more")
    return parsed;
  bag.error(
    "gate_policy.cardinality",
    path,
    `unsupported gate evaluation cardinality ${parsed ?? ""}`,
  );
  return "exactly_one";
}

function uniqueTrimmedStrings(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
  allowEmpty = false,
): string[] {
  if (value === undefined && allowEmpty) return [];
  const values = stringArray(value, path, bag);
  if (
    (!allowEmpty && values.length === 0) ||
    values.some((item) => item.trim() !== item) ||
    new Set(values).size !== values.length
  ) {
    bag.error(
      "gate_policy.string_set",
      path,
      `expected ${allowEmpty ? "a" : "a nonempty"} unique array of trimmed strings`,
    );
  }
  return values;
}

function uniqueFieldPaths(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): string[] {
  const values = uniqueTrimmedStrings(value, path, bag);
  if (values.some((item) => !isContractFieldPath(item))) {
    bag.error("gate_policy.field_path", path, "gate capability fields must be dotted field paths");
  }
  return values;
}

function jsonObject(
  value: ConfigurationValue,
  path: string,
  bag: DiagnosticBag,
): Record<string, JsonValue> {
  const object = objectValue(value, path, bag);
  if (object === undefined) return {};
  return toJsonValue(object) as Record<string, JsonValue>;
}

function gateExactKeys(
  value: ConfigurationObject,
  path: string,
  allowed: readonly string[],
  bag: DiagnosticBag,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value).sort(compareUtf8)) {
    if (!allowedSet.has(key)) {
      bag.error(
        "gate_policy.unknown_field",
        `${path}/${escapePointer(key)}`,
        `unknown gate-policy field ${key}`,
      );
    }
  }
}

function normalizedScopePath(value: string): string | undefined {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("*") ||
    value.includes("?") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  )
    return undefined;
  const segments = value.split("/");
  if (segments.includes("..")) return undefined;
  const compact = segments.filter((segment) => segment !== "" && segment !== ".");
  return compact.length === 0 ? "." : compact.join("/");
}

function fieldMap(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): Record<string, GraphFieldDefinition> | undefined {
  if (value === undefined) return {};
  const object = objectValue(value, path, bag);
  if (object === undefined) return undefined;
  const output: Record<string, GraphFieldDefinition> = Object.create(null) as Record<
    string,
    GraphFieldDefinition
  >;
  for (const key of Object.keys(object).sort(compareUtf8)) {
    const definition = fieldDefinition(object[key], `${path}/${escapePointer(key)}`, bag);
    if (definition !== undefined) output[key] = definition;
  }
  return output;
}

function fieldDefinition(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): GraphFieldDefinition | undefined {
  const source = objectValue(value, path, bag);
  if (source === undefined) return undefined;
  const type = requiredString(source.type, `${path}/type`, bag);
  if (type !== undefined && !FIELD_TYPES.has(type as GraphFieldDefinition["type"])) {
    bag.error("graph_schema.field_type", `${path}/type`, `unsupported graph field type ${type}`);
  }
  if (type === undefined || !FIELD_TYPES.has(type as GraphFieldDefinition["type"]))
    return undefined;
  const properties =
    source.properties === undefined
      ? undefined
      : fieldMap(source.properties, `${path}/properties`, bag);
  const items =
    source.items === undefined ? undefined : fieldDefinition(source.items, `${path}/items`, bag);
  return {
    type: type as GraphFieldDefinition["type"],
    ...(source.required === undefined
      ? {}
      : { required: booleanValue(source.required, `${path}/required`, bag) ?? false }),
    ...(source.enum === undefined ? {} : { enum: jsonArray(source.enum, `${path}/enum`, bag) }),
    ...(source.pattern === undefined
      ? {}
      : { pattern: requiredString(source.pattern, `${path}/pattern`, bag) ?? "" }),
    ...(items === undefined ? {} : { items }),
    ...(properties === undefined ? {} : { properties }),
    ...(source.additional_properties === undefined
      ? {}
      : {
          additional_properties:
            booleanValue(source.additional_properties, `${path}/additional_properties`, bag) ??
            false,
        }),
    ...(source.unique_by === undefined
      ? {}
      : { unique_by: requiredString(source.unique_by, `${path}/unique_by`, bag) ?? "" }),
    ...(source.subset_of === undefined
      ? {}
      : { subset_of: requiredString(source.subset_of, `${path}/subset_of`, bag) ?? "" }),
    ...(source.disjoint_from === undefined
      ? {}
      : {
          disjoint_from: requiredString(source.disjoint_from, `${path}/disjoint_from`, bag) ?? "",
        }),
    ...(source.description === undefined
      ? {}
      : { description: requiredString(source.description, `${path}/description`, bag) ?? "" }),
  };
}

function graphPathSet(
  value: ConfigurationValue | undefined,
  path: string,
  schema: GraphSchema,
  bag: DiagnosticBag,
): CompiledGraphPathSetDefinition | undefined {
  const source = objectValue(value, path, bag);
  if (source === undefined) return undefined;
  exactKeys(source, path, ["select", "node_types", "field"], bag);
  if (source.select === undefined) {
    bag.error("graph_constraint.select", `${path}/select`, "graph path set requires a selector");
  }
  const nodeTypes = stringArray(source.node_types, `${path}/node_types`, bag);
  if (
    nodeTypes.length === 0 ||
    nodeTypes.some((nodeType) => nodeType.trim() !== nodeType) ||
    new Set(nodeTypes).size !== nodeTypes.length
  ) {
    bag.error(
      "graph_constraint.node_types",
      `${path}/node_types`,
      "graph path-set node types must be nonempty, unique, trimmed names",
    );
  }
  const field = requiredString(source.field, `${path}/field`, bag);
  if (field !== undefined && !isContractFieldPath(field)) {
    bag.error(
      "graph_constraint.field",
      `${path}/field`,
      `graph path-set field ${field} is not a valid dotted field path`,
    );
  }
  for (const nodeType of nodeTypes) {
    const nodeDefinition = schema.nodeTypes.get(nodeType);
    if (nodeDefinition === undefined) {
      bag.error(
        "graph_constraint.node_type",
        `${path}/node_types`,
        `graph path set references unknown node type ${nodeType}`,
      );
      continue;
    }
    if (field === undefined || !isContractFieldPath(field)) continue;
    const definition = nodeFieldDefinition(nodeDefinition, field);
    const pathTyped =
      definition?.type === "path" ||
      (definition?.type === "list" && definition.items?.type === "path");
    if (!pathTyped) {
      bag.error(
        "graph_constraint.path_field",
        `${path}/field`,
        `graph path-set field ${field} on node type ${nodeType} must be path or list<path>`,
      );
    }
  }
  if (source.select === undefined || field === undefined) return undefined;
  return deepFreeze({ select: structuredClone(source.select), nodeTypes, field });
}

function nodeFieldDefinition(
  nodeType: GraphNodeTypeDefinition,
  fieldPath: string,
): GraphFieldDefinition | undefined {
  const normalized = fieldPath.replace(/^\$\./u, "").replace(/^spec\./u, "");
  const [root, ...children] = normalized.split(".");
  let definition: GraphFieldDefinition | undefined = nodeType.fields[root!];
  for (const child of children) definition = definition?.properties?.[child];
  return definition;
}

function isContractFieldPath(value: string): boolean {
  if (value.trim() !== value || value.length === 0) return false;
  return value
    .replace(/^\$\./u, "")
    .split(".")
    .every((segment) => segment.length > 0 && /^[A-Za-z0-9_-]+$/u.test(segment));
}

function exactKeys(
  value: ConfigurationObject,
  path: string,
  allowed: readonly string[],
  bag: DiagnosticBag,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value).sort(compareUtf8)) {
    if (!allowedSet.has(key)) {
      bag.error(
        "graph_constraint.unknown_field",
        `${path}/${escapePointer(key)}`,
        `unknown graph constraint field ${key}`,
      );
    }
  }
}

function nestedStringArrays(
  value: ConfigurationValue,
  path: string,
  bag: DiagnosticBag,
): string[][] {
  if (!Array.isArray(value)) {
    bag.error("graph_schema.string_arrays", path, "expected an array of string arrays");
    return [];
  }
  return value.map((item, index) => stringArray(item, `${path}/${index}`, bag));
}

function stringArray(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): string[] {
  if (!Array.isArray(value)) {
    bag.error("graph_schema.string_array", path, "expected an array of strings");
    return [];
  }
  const output: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = requiredString(item, `${path}/${index}`, bag);
    if (parsed !== undefined) output.push(parsed);
  }
  return output;
}

function jsonArray(value: ConfigurationValue, path: string, bag: DiagnosticBag): JsonValue[] {
  if (!Array.isArray(value)) {
    bag.error("graph_schema.json_array", path, "expected an array");
    return [];
  }
  return value.map(toJsonValue);
}

function toJsonValue(value: ConfigurationValue): JsonValue {
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object" && value !== null) {
    const object = value as ConfigurationObject;
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(object).sort(compareUtf8))
      output[key] = toJsonValue(object[key]!);
    return output;
  }
  return value;
}

function objectValue(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): ConfigurationObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    bag.error("graph_schema.mapping", path, "expected a mapping");
    return undefined;
  }
  return value as ConfigurationObject;
}

function compilerFieldSources(
  value: ConfigurationValue,
  path: string,
  bag: DiagnosticBag,
): Record<string, GraphCompilerFieldSource> {
  const source = objectValue(value, path, bag);
  if (source === undefined) return {};
  const output: Record<string, GraphCompilerFieldSource> = Object.create(null) as Record<
    string,
    GraphCompilerFieldSource
  >;
  const supported = new Set<GraphCompilerFieldSource>([
    "run.id",
    "run.objective",
    "run.run_type_id",
    "run.git.target.ref",
  ]);
  for (const [field, raw] of Object.entries(source).sort(([left], [right]) =>
    compareUtf8(left, right),
  )) {
    const selected = requiredString(raw, `${path}/${escapePointer(field)}`, bag);
    if (selected === undefined) continue;
    if (!supported.has(selected as GraphCompilerFieldSource)) {
      bag.error(
        "graph_schema.compiler_field_source",
        `${path}/${escapePointer(field)}`,
        `unsupported compiler field source ${selected}`,
      );
      continue;
    }
    output[field] = selected as GraphCompilerFieldSource;
  }
  return output;
}

function requiredString(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    bag.error("graph_schema.string", path, "expected a nonempty string");
    return undefined;
  }
  return value;
}

function booleanValue(
  value: ConfigurationValue,
  path: string,
  bag: DiagnosticBag,
): boolean | undefined {
  if (typeof value !== "boolean") {
    bag.error("graph_schema.boolean", path, "expected a boolean");
    return undefined;
  }
  return value;
}

function nonnegativeInteger(
  value: ConfigurationValue,
  path: string,
  bag: DiagnosticBag,
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    bag.error("graph_schema.integer", path, "expected a nonnegative safe integer");
    return undefined;
  }
  return value;
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
