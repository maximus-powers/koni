import path from "node:path";
import { Type, type TSchema } from "typebox";
import type { JsonValue } from "../authority/protocol.js";
import { LEAD_JUDGMENT_OUTPUT_PROTOCOL } from "../contracts/behavior.js";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import type { DerivedTicketDefinition, DerivedWorkflowStep } from "../contracts/rules.js";
import {
  GraphValidationError,
  TypedGraph,
  type GraphCompilerFieldSource,
  type GraphDelta,
  type GraphEdge,
  type GraphFieldDefinition,
  type GraphNode,
  type GraphNodeTypeDefinition,
} from "../graph/model.js";
import { canonicalHash, isSha256Digest } from "../shared/canonical.js";
import { type RunRecord, type TicketRecord } from "../state/run-record.js";
import { reviewReworkAppliesToStep } from "../state/scheduler.js";
import {
  prepareFilesystemManifestAcceptance,
  type RuleAuthorityEvidence,
} from "./domain-adapter.js";
import { projectGraphSchemaDefinition } from "./graph-schema.js";
import {
  PLAN_DOMAINS,
  PlanningArtifactValidationError,
  parsePlanningArtifact,
  parsePlanningGraphSeed,
  type PlanDomain,
  type PlanningGraphSeed,
} from "./planning-artifact.js";

import {
  compareText,
  digestBody,
  fail,
  isRecord,
  optionalRecord,
  optionalSafeInteger,
  predicateMatches,
  requireValidation,
  requiredNonempty,
  requiredRecord,
  resolveReviewEffectTokens,
  setNestedSpec,
  stringArray,
} from "./run-check-execution.js";
import {
  MAX_PLAN_CHARS,
  type AssignmentChangeControlContract,
  type PlanningOutput,
} from "./run-program-contracts.js";
import {
  LEGACY_DELIVERY_NODE_SHA256,
  assertConfiguredGraphConstraints,
  preserveCompilerOwnedSpec,
  rejectCompilerOwnedSpec,
  requireGraphSchema,
  reviewEffectSetAlreadyApplied,
  setNodeField,
  typedGateIdentityCatalog,
  validateEffectCount,
  validateOperationReceiptCoverage,
  validateReviewEffectCoverage,
} from "./run-program-support.js";

export function planningTerminalSchema(graphSeed: TSchema): TSchema {
  const miniItem = Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 160 }),
      description: Type.String({ minLength: 1, maxLength: 1_200 }),
    },
    { additionalProperties: false },
  );
  const domains = Object.fromEntries(
    PLAN_DOMAINS.map((domain) => [
      domain,
      Type.String({ minLength: 1, maxLength: MAX_PLAN_CHARS }),
    ]),
  );
  const concise = Object.fromEntries(
    PLAN_DOMAINS.map((domain) => [domain, Type.Array(miniItem, { minItems: 1, maxItems: 7 })]),
  );
  return Type.Object(
    {
      title: Type.Optional(Type.String({ minLength: 3, maxLength: 60 })),
      full: Type.Object(domains, { additionalProperties: false }),
      concise: Type.Object(concise, { additionalProperties: false }),
      graphSeed,
    },
    { additionalProperties: false },
  );
}

export function planningPatchTerminalSchema(): TSchema {
  const miniItem = Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 160 }),
      description: Type.String({ minLength: 1, maxLength: 1_200 }),
    },
    { additionalProperties: false },
  );
  const full = Type.Object(
    Object.fromEntries(
      PLAN_DOMAINS.map((domain) => [
        domain,
        Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PLAN_CHARS })),
      ]),
    ),
    { additionalProperties: false, minProperties: 1 },
  );
  const concise = Type.Object(
    Object.fromEntries(
      PLAN_DOMAINS.map((domain) => [
        domain,
        Type.Optional(Type.Array(miniItem, { minItems: 1, maxItems: 7 })),
      ]),
    ),
    { additionalProperties: false, minProperties: 1 },
  );
  const edge = Type.Object(
    {
      source: Type.String({ minLength: 1, maxLength: 128 }),
      relation: Type.String({ minLength: 1, maxLength: 128 }),
      target: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  );
  const node = Type.Object(
    {
      key: Type.String({ minLength: 1, maxLength: 128 }),
      type: Type.String({ minLength: 1, maxLength: 128 }),
      title: Type.String({ minLength: 1, maxLength: 240 }),
      spec: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
    },
    { additionalProperties: false },
  );
  const graphSeed = Type.Object(
    {
      setRootSpec: Type.Optional(
        Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
      ),
      removeRootSpecFields: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
          maxItems: 1_024,
          uniqueItems: true,
        }),
      ),
      upsertNodes: Type.Optional(Type.Array(node, { maxItems: 1_024 })),
      removeNodeKeys: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          maxItems: 1_024,
          uniqueItems: true,
        }),
      ),
      addEdges: Type.Optional(Type.Array(edge, { maxItems: 4_096 })),
      removeEdges: Type.Optional(Type.Array(edge, { maxItems: 4_096 })),
    },
    { additionalProperties: false, minProperties: 1 },
  );
  return Type.Object(
    {
      baseRevision: Type.Integer({ minimum: 0 }),
      baseArtifactSha256: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
      title: Type.Optional(Type.String({ minLength: 3, maxLength: 60 })),
      full: Type.Optional(full),
      concise: Type.Optional(concise),
      graphSeed: Type.Optional(graphSeed),
    },
    { additionalProperties: false, minProperties: 3 },
  );
}

export interface PlanningGraphSeedContract {
  schema: TSchema;
  context: JsonValue;
}

export function planningProtectedRootSpecFields(configuration: CompiledConfiguration): string[] {
  const initialization = configuration.behavior.profile.initialization;
  const rootType = requiredNonempty(
    initialization.rootNodeType,
    "compiled initialization root node type",
  );
  const definition = requireValidation(
    projectGraphSchemaDefinition(configuration),
    "graph_schema_invalid",
    "compiled profile graph schema is invalid",
  );
  const rootDefinition = definition.nodeTypes.find((nodeType) => nodeType.id === rootType);
  if (rootDefinition === undefined) {
    fail("graph_seed_root_type", `unknown root node type ${rootType}`);
  }
  return [
    requiredNonempty(initialization.goalField, "compiled initialization goal field").replace(
      /^spec\./u,
      "",
    ),
    requiredNonempty(
      initialization.planningContextField,
      "compiled initialization planning context field",
    ).replace(/^spec\./u, ""),
    ...compilerOwnedSpecFields(rootDefinition),
  ];
}

export function leadJudgmentTerminalSchema(): TSchema {
  return Type.Object(
    {
      protocol: Type.Literal(LEAD_JUDGMENT_OUTPUT_PROTOCOL),
      disposition: Type.Union([Type.Literal("proceed"), Type.Literal("blocked")]),
      summary: Type.String({ minLength: 1, maxLength: 4_096 }),
    },
    { additionalProperties: false },
  );
}

export function planningGraphSeedContract(
  configuration: CompiledConfiguration,
): PlanningGraphSeedContract {
  const initialization = configuration.behavior.profile.initialization;
  const rootType = requiredNonempty(
    initialization.rootNodeType,
    "compiled initialization root node type",
  );
  const goalField = requiredNonempty(
    initialization.goalField,
    "compiled initialization goal field",
  ).replace(/^spec\./u, "");
  const contextField = requiredNonempty(
    initialization.planningContextField,
    "compiled initialization planning context field",
  ).replace(/^spec\./u, "");
  const operationId = requiredNonempty(
    initialization.planningSeedOperation,
    "compiled initialization planning seed operation",
  );
  const operation = configuration.registries.operations[operationId];
  if (operation === undefined)
    fail("graph_seed_operation", `planning seed operation ${operationId} is missing`);
  const allowedTypeIds = stringArray(
    operation.allowed_new_node_types,
    "planning seed allowed node types",
  );
  const maximum = optionalSafeInteger(operation.max_new_nodes) ?? 1_024;
  const definition = requireValidation(
    projectGraphSchemaDefinition(configuration),
    "graph_schema_invalid",
    "compiled profile graph schema is invalid",
  );
  const nodeTypes = new Map(definition.nodeTypes.map((nodeType) => [nodeType.id, nodeType]));
  const rootDefinition = nodeTypes.get(rootType);
  if (rootDefinition === undefined)
    fail("graph_seed_root_type", `unknown root node type ${rootType}`);
  const allowedNodeTypes = allowedTypeIds.map((id) => {
    const nodeType = nodeTypes.get(id);
    if (nodeType === undefined)
      fail("graph_seed_node_type", `planning seed operation allows unknown node type ${id}`);
    return nodeType;
  });
  if (allowedNodeTypes.length === 0)
    fail("graph_seed_node_type", "planning seed operation allows no node types");
  const participatingTypes = new Set([rootType, ...allowedTypeIds]);
  const edgeTypes = definition.edgeTypes.filter(
    (edge) =>
      participatingTypes.has(edge.source) &&
      edge.targets.some((target) => participatingTypes.has(target)),
  );
  const protectedRootFields = new Set([
    goalField,
    contextField,
    ...compilerOwnedSpecFields(rootDefinition),
  ]);
  const rootFields = planningFieldDefinitions(rootDefinition, protectedRootFields);
  const nodeSchemas = allowedNodeTypes.map((nodeType) => planningNodeSeedSchema(nodeType));
  const relationNames = [...new Set(edgeTypes.map((edge) => edge.relation))].sort(compareText);
  const schema = graphSeedSchema({
    rootDefinition,
    rootFields,
    nodeSchemas,
    relationNames,
    maximum,
  });
  return {
    schema,
    context: {
      rule: "Use the literal $root for the existing objective. rootSpec enriches that node but does not declare a key. Every other endpoint must equal a declared nodes[].key, and all declared nodes must connect to $root.",
      root: {
        key: "$root",
        type: rootDefinition.id,
        description: rootDefinition.description,
        specFields: planningFieldContract(rootFields),
      },
      allowedNodeTypes: allowedNodeTypes.map((nodeType) => ({
        id: nodeType.id,
        description: nodeType.description,
        requiredAny: (nodeType.required_any ?? []).map((group) => [...group]),
        specFields: planningFieldContract(planningFieldDefinitions(nodeType)),
      })),
      canonicalEdges: edgeTypes.map((edge) => ({
        sourceType: edge.source,
        relation: edge.relation,
        targetTypes: edge.targets.filter((target) => participatingTypes.has(target)),
        ...(edge.bidirectional === undefined ? {} : { bidirectional: edge.bidirectional }),
      })),
      maxNewNodes: maximum,
      forbidden: [
        "node types outside allowedNodeTypes",
        "spec fields not declared for that node type",
        "compiler-owned fields, status, tickets, receipts, and implementation progress",
        "invented, inverse, or redundant relationship names",
      ],
    },
  };
}

export function graphSeedSchema(input: {
  rootDefinition: GraphNodeTypeDefinition;
  rootFields: Record<string, GraphFieldDefinition>;
  nodeSchemas: TSchema[];
  relationNames: string[];
  maximum: number;
}): TSchema {
  const relation =
    input.relationNames.length === 0
      ? Type.String({ minLength: 1, maxLength: 128 })
      : literalUnion(input.relationNames, {
          description:
            "A canonical relation from the compiled graph contract. It must be valid for the selected source and target node types.",
        });
  return Type.Object(
    {
      rootSpec: planningSpecSchema(input.rootDefinition, input.rootFields, {
        description:
          "Only declared, agent-authored spec fields merged into the existing run-objective root. This does not declare a local node key; edges reference that objective with the literal $root.",
      }),
      nodes: Type.Array(schemaUnion(input.nodeSchemas), {
        maxItems: input.maximum,
        description:
          "Typed semantic nodes introduced by this seed. Every key must be unique and every node must be connected by edges to $root.",
      }),
      edges: Type.Array(
        Type.Object(
          {
            source: Type.String({
              minLength: 1,
              maxLength: 128,
              description:
                "Either the literal $root for the existing run objective or a key declared in nodes.",
            }),
            relation,
            target: Type.String({
              minLength: 1,
              maxLength: 128,
              description:
                "Either the literal $root for the existing run objective or a key declared in nodes.",
            }),
          },
          { additionalProperties: false },
        ),
        {
          maxItems: 4_096,
          description:
            "Canonical relationships whose endpoints are only $root or keys declared in nodes. Never use a title, rootSpec field, or invented root alias as an endpoint.",
        },
      ),
    },
    { additionalProperties: false },
  );
}

export function planningNodeSeedSchema(definition: GraphNodeTypeDefinition): TSchema {
  return Type.Object(
    {
      key: Type.String({
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        description:
          "Unique local key declared by this node. Do not declare $root or invent another alias for the existing run objective.",
      }),
      type: Type.Literal(definition.id, { description: definition.description }),
      title: Type.String({ minLength: 1, maxLength: 16_384 }),
      spec: planningSpecSchema(definition, planningFieldDefinitions(definition)),
    },
    {
      additionalProperties: false,
      description: `${definition.id}: ${definition.description}`,
    },
  );
}

export function planningSpecSchema(
  definition: GraphNodeTypeDefinition,
  fields: Record<string, GraphFieldDefinition>,
  options: Record<string, unknown> = {},
): TSchema {
  const properties: Record<string, TSchema> = Object.create(null) as Record<string, TSchema>;
  for (const [name, field] of Object.entries(fields).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const schema = graphFieldSchema(field);
    properties[name] = field.required === true ? schema : Type.Optional(schema);
  }
  const requiredAny = (definition.required_any ?? [])
    .map((group) => group.filter((name) => Object.hasOwn(fields, name)))
    .filter((group) => group.length > 0);
  const requirement =
    requiredAny.length === 0
      ? ""
      : ` At least one field from each configured group is required: ${requiredAny.map((group) => `[${group.join(", ")}]`).join("; ")}.`;
  const description = `${typeof options.description === "string" ? options.description : `Spec for ${definition.id}.`}${requirement}`;
  return Type.Object(properties, { ...options, description, additionalProperties: false });
}

export function planningFieldDefinitions(
  definition: GraphNodeTypeDefinition,
  excluded: ReadonlySet<string> = new Set(compilerOwnedSpecFields(definition)),
): Record<string, GraphFieldDefinition> {
  return Object.fromEntries(
    Object.entries(definition.fields).filter(([name]) => !excluded.has(name)),
  );
}

export function compilerOwnedSpecFields(definition: GraphNodeTypeDefinition): string[] {
  return (definition.compiler_owned_fields ?? []).flatMap((field) => {
    const match = /^spec\.([^.]+)(?:\.|$)/u.exec(field);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

export function planningFieldContract(fields: Record<string, GraphFieldDefinition>): JsonValue {
  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [name, field] of Object.entries(fields).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    output[name] = graphFieldContract(field);
  }
  return output;
}

export function assignmentMutationContract(
  configuration: CompiledConfiguration,
  ticket: DerivedTicketDefinition,
): JsonValue {
  const operation = configuration.registries.operations[ticket.operation_registry_id];
  if (operation === undefined)
    fail("operation_missing", `ticket ${ticket.id} operation is unavailable`);
  const schema = requireGraphSchema(configuration);
  const allowedNew = stringArray(operation.allowed_new_node_types, "allowed new node types");
  const allowedExisting = stringArray(
    operation.allowed_existing_node_types,
    "allowed existing node types",
  );
  const participating = new Set([...allowedNew, ...allowedExisting]);
  const nodeTypes = [...participating].sort(compareText).map((id) => {
    const definition = schema.nodeTypes.get(id);
    if (definition === undefined)
      fail(
        "operation_node_type",
        `operation ${ticket.operation_registry_id} allows unknown node type ${id}`,
      );
    return {
      id,
      description: definition.description,
      initialStatus: definition.initial_status,
      allowedForNew: allowedNew.includes(id),
      allowedForExisting: allowedExisting.includes(id),
      requiredAny: (definition.required_any ?? []).map((group) => [...group]),
      specFields: planningFieldContract(planningFieldDefinitions(definition)),
      compilerFieldSources: structuredClone(compilerFieldSourcesForNodeType(definition)),
    };
  });
  return {
    maxNewNodes: optionalSafeInteger(operation.max_new_nodes) ?? 0,
    allowNodeDeletion: operation.allow_node_deletion === true,
    allowEdgeDeletion: operation.allow_edge_deletion === true,
    nodeTypes,
    canonicalEdges: schema.edgeTypes
      .filter(
        (edge) =>
          participating.has(edge.source) ||
          edge.targets.some((target) => participating.has(target)),
      )
      .map((edge) => ({
        sourceType: edge.source,
        relation: edge.relation,
        targetTypes: [...edge.targets],
        ...(edge.bidirectional === undefined ? {} : { bidirectional: edge.bidirectional }),
      })),
  };
}

export function newNodeAuthorityInstruction(
  mutationContract: JsonValue,
  graphMutation: "allowed" | "forbidden" | "required",
): string | undefined {
  if (graphMutation === "forbidden" || !isRecord(mutationContract)) return undefined;
  const maximum = mutationContract.maxNewNodes;
  const nodeTypes = mutationContract.nodeTypes;
  if (!Number.isSafeInteger(maximum) || (maximum as number) <= 0 || !Array.isArray(nodeTypes)) {
    return undefined;
  }
  const allowedTypes = nodeTypes.flatMap((candidate) =>
    isRecord(candidate) && candidate.allowedForNew === true && typeof candidate.id === "string"
      ? [candidate.id]
      : [],
  );
  if (allowedTypes.length === 0) return undefined;
  return (
    "New graph nodes are governed separately from existing-node write IDs. " +
    `This step may create at most ${maximum as number} new graph nodes, limited to these configured types: ${allowedTypes.join(", ")}. ` +
    "A missing node of an allowed type is not an authority gap: create it when the current output contract requires it, and connect it only through canonical edges in the injected mutationContract."
  );
}

export function assignmentCompilerOwnedFields(
  configuration: CompiledConfiguration,
  ticket: DerivedTicketDefinition,
): string[] {
  const operation = configuration.registries.operations[ticket.operation_registry_id];
  if (operation === undefined)
    fail("operation_missing", `ticket ${ticket.id} operation is unavailable`);
  const schema = requireGraphSchema(configuration);
  const participating = new Set([
    ...stringArray(operation.allowed_new_node_types, "allowed new node types"),
    ...stringArray(operation.allowed_existing_node_types, "allowed existing node types"),
  ]);
  return [...participating].sort(compareText).flatMap((nodeType) => {
    const definition = schema.nodeTypes.get(nodeType);
    if (definition === undefined) {
      fail(
        "operation_node_type",
        `operation ${ticket.operation_registry_id} allows unknown node type ${nodeType}`,
      );
    }
    return Object.keys(compilerFieldSourcesForNodeType(definition))
      .sort(compareText)
      .map((field) => `${nodeType}.${field}`);
  });
}

export function reviewPredecessorHasCommandEvidence(
  predecessorExecution: Record<string, unknown> | undefined,
): boolean {
  if (predecessorExecution === undefined || !Array.isArray(predecessorExecution.predecessors)) {
    return false;
  }
  return predecessorExecution.predecessors.some((predecessorValue) => {
    const predecessor = optionalRecord(predecessorValue);
    if (predecessor === undefined || !Array.isArray(predecessor.checks)) return false;
    return predecessor.checks.some((checkValue) => {
      const check = optionalRecord(checkValue);
      return check !== undefined && Array.isArray(check.commands) && check.commands.length > 0;
    });
  });
}

export function boundedHistoricalPreparationCheck(
  check: ConfigurationObject,
  maximumInlineStreamBytes: number,
): ConfigurationObject {
  let remainingBytes = maximumInlineStreamBytes;
  const projectStream = (value: unknown): ConfigurationObject | undefined => {
    const stream = optionalRecord(value);
    if (stream === undefined) return undefined;
    const content = typeof stream.content === "string" ? stream.content : undefined;
    if (content === undefined || stream.encoding === "omitted") return structuredClone(stream);
    const bytes = Buffer.from(content, "utf8");
    const included = Math.min(bytes.byteLength, remainingBytes);
    remainingBytes -= included;
    if (included === bytes.byteLength) return structuredClone(stream);
    const prefix = bytes.subarray(0, included).toString("utf8");
    return {
      ...structuredClone(stream),
      content: prefix,
      includedBytes: Buffer.byteLength(prefix, "utf8"),
      truncated: true,
      omission:
        "Authenticated historical stream was truncated to the bounded cross-ticket evidence budget.",
    };
  };
  const commands = Array.isArray(check.commands)
    ? check.commands.map((value) => {
        const command = requiredRecord(value, "historical preparation command");
        const stdout = projectStream(command.stdout);
        const stderr = projectStream(command.stderr);
        return {
          ...structuredClone(command),
          ...(stdout === undefined ? {} : { stdout }),
          ...(stderr === undefined ? {} : { stderr }),
        };
      })
    : [];
  return {
    ...structuredClone(check),
    commands,
    sourceEvidenceSha256: canonicalHash(check),
  };
}

export function graphFieldContract(field: GraphFieldDefinition): JsonValue {
  return {
    type: field.type,
    required: field.required === true,
    ...(field.enum === undefined ? {} : { enum: structuredClone(field.enum) }),
    ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.items === undefined ? {} : { items: graphFieldContract(field.items) }),
    ...(field.properties === undefined
      ? {}
      : { properties: planningFieldContract(field.properties) }),
    ...(field.additional_properties === undefined
      ? {}
      : { additionalProperties: field.additional_properties }),
    ...(field.unique_by === undefined ? {} : { uniqueBy: field.unique_by }),
    ...(field.subset_of === undefined ? {} : { subsetOf: field.subset_of }),
    ...(field.disjoint_from === undefined ? {} : { disjointFrom: field.disjoint_from }),
  };
}

export function graphFieldSchema(field: GraphFieldDefinition): TSchema {
  const description = field.description === undefined ? {} : { description: field.description };
  if (field.enum !== undefined) {
    const variants = field.enum.flatMap((value): TSchema[] => {
      if (value === null) return [Type.Null()];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [Type.Literal(value)];
      }
      return [];
    });
    if (variants.length === field.enum.length && variants.length > 0)
      return schemaUnion(variants, description);
  }
  switch (field.type) {
    case "string":
      return Type.String({
        ...description,
        ...(field.pattern === undefined ? {} : { pattern: field.pattern }),
      });
    case "path":
    case "node_ref":
      return Type.String(description);
    case "boolean":
      return Type.Boolean(description);
    case "number":
      return Type.Number(description);
    case "integer":
      return Type.Integer(description);
    case "list":
      return Type.Array(
        field.items === undefined ? Type.Unknown() : graphFieldSchema(field.items),
        description,
      );
    case "object": {
      if (field.properties === undefined)
        return Type.Record(Type.String(), Type.Unknown(), description);
      const properties: Record<string, TSchema> = Object.create(null) as Record<string, TSchema>;
      for (const [name, child] of Object.entries(field.properties).sort(([left], [right]) =>
        compareText(left, right),
      )) {
        const schema = graphFieldSchema(child);
        properties[name] = child.required === true ? schema : Type.Optional(schema);
      }
      return Type.Object(properties, {
        ...description,
        additionalProperties: field.additional_properties !== false,
      });
    }
    case "json":
      return Type.Unknown(description);
  }
}

export function literalUnion(values: string[], options: Record<string, unknown> = {}): TSchema {
  return schemaUnion(
    values.map((value) => Type.Literal(value)),
    options,
  );
}

export function schemaUnion(schemas: TSchema[], options: Record<string, unknown> = {}): TSchema {
  if (schemas.length === 1) return { ...schemas[0], ...options };
  return Type.Union(schemas, options);
}

export function assignmentTerminalSchema(
  policy: DerivedWorkflowStep["graph_mutation"],
  changeControl: AssignmentChangeControlContract = {
    role: "ordinary",
    allowUpstreamRequest: false,
    requireChangeApplication: false,
  },
  stepKind: DerivedWorkflowStep["kind"] = "agent",
): TSchema {
  const graphDelta = Type.Object(
    {
      protocol: Type.Literal("koni.graph-delta.v1"),
      expectedGraphHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
      upsertNodes: Type.Array(
        Type.Object(
          {
            node: Type.Object(
              {
                schema_version: Type.Literal("1.0"),
                id: Type.String({ minLength: 1, maxLength: 128 }),
                type: Type.String({ minLength: 1, maxLength: 128 }),
                title: Type.String({ minLength: 1, maxLength: 16_384 }),
                status: Type.String({ minLength: 1, maxLength: 128 }),
                spec: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
                edges: Type.Record(
                  Type.String({ minLength: 1, maxLength: 128 }),
                  Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { uniqueItems: true }),
                ),
                annotations: Type.Record(
                  Type.String({ minLength: 1, maxLength: 256 }),
                  Type.Unknown(),
                ),
              },
              { additionalProperties: false },
            ),
            expectedNodeHash: Type.Union([
              Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
              Type.Null(),
            ]),
          },
          { additionalProperties: false },
        ),
        { maxItems: 1_024 },
      ),
      deleteNodes: Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 128 }),
            expectedNodeHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 1_024 },
      ),
      addEdges: Type.Array(edgeSchema(), { maxItems: 4_096 }),
      removeEdges: Type.Array(edgeSchema(), { maxItems: 4_096 }),
    },
    { additionalProperties: false },
  );
  const baseCompleteFields: Record<string, TSchema> = {
    status: Type.Literal("completed", {
      description:
        'Required. The exact literal string "completed" (not "success"/"done"/"ok"/a hash) — use it when the step succeeded.',
    }),
    summary: Type.String({
      minLength: 1,
      maxLength: 1_024,
      description:
        "One concise sentence describing what this step accomplished. Plain text, at most 1024 characters.",
    }),
  };
  const normalFields = { ...baseCompleteFields };
  if (stepKind === "review") {
    normalFields.reviewVerdict = Type.Literal("approved", {
      description:
        'Required for a passing review. Use "approved" only when no material finding remains.',
    });
  }
  if (policy === "required") normalFields.graphDelta = graphDelta;
  else if (policy === "allowed")
    normalFields.graphDelta = Type.Optional(Type.Union([graphDelta, Type.Null()]));
  const complete: TSchema[] = [];
  if (!changeControl.requireChangeApplication) {
    complete.push(Type.Object(normalFields, { additionalProperties: false }));
  }
  if (changeControl.allowUpstreamRequest) {
    complete.push(
      Type.Object(
        {
          ...baseCompleteFields,
          ...(stepKind === "review"
            ? {
                reviewVerdict: Type.Literal("changes_requested", {
                  description:
                    "Required when a review identifies a repair outside the current grant and requests upstream authority.",
                }),
              }
            : {}),
          upstreamChangeRequest: Type.Object(
            {
              targetNodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
                minItems: 1,
                maxItems: 1_024,
                uniqueItems: true,
              }),
              fulfillment: Type.Union(
                [Type.Literal("planned_asset_repair"), Type.Literal("dynamic_scope_change")],
                {
                  description:
                    'Use "planned_asset_repair" only when the existing asset implementation workflow can satisfy the entire request by editing its authored source files/contracts. Use "dynamic_scope_change" when fulfillment requires execution, a runtime artifact/output root, a new run or other node, or authority beyond that asset\'s source write grant.',
                },
              ),
              summary: Type.String({ minLength: 1, maxLength: 1_024 }),
              reason: Type.String({ minLength: 1, maxLength: 4_096 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    );
  }
  if (changeControl.requireChangeApplication) {
    complete.push(
      Type.Object(
        {
          ...baseCompleteFields,
          ...(stepKind === "review" ? { reviewVerdict: Type.Literal("approved") } : {}),
          changeApplication: Type.Object(
            {
              operation: Type.String({ minLength: 1, maxLength: 128 }),
              targetNodeIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
                minItems: 1,
                maxItems: 1_024,
                uniqueItems: true,
              }),
              summary: Type.String({ minLength: 1, maxLength: 1_024 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    );
  }
  const failed = Type.Object(
    {
      status: Type.Literal("failed", {
        description:
          'Required. The exact literal string "failed" — use it only when the objective is genuinely impossible within this grant, not to probe the schema.',
      }),
      ...(stepKind === "review"
        ? {
            reviewVerdict: Type.Literal("rejected", {
              description:
                "Required for a rejected review. The blocker is the deterministic repair contract.",
            }),
          }
        : {}),
      summary: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 1_024,
          description:
            "Optional concise outcome summary. The blocker remains the complete repair diagnosis.",
        }),
      ),
      blocker: Type.String({
        minLength: 1,
        maxLength: 64 * 1024,
        description:
          'A specific, self-contained diagnosis: the exact obstacle, what you tried (edits, checks and their output), and why nothing in your grant can resolve it. Never a placeholder such as "test" or "probe".',
      }),
    },
    { additionalProperties: false },
  );
  return Type.Union([...complete, failed]);
}

export function edgeSchema(): TSchema {
  return Type.Object(
    {
      source: Type.String({ minLength: 1, maxLength: 128 }),
      relation: Type.String({ minLength: 1, maxLength: 128 }),
      target: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  );
}

export function parsePlanningOutput(value: unknown): PlanningOutput {
  return planningArtifactBoundary(() => parsePlanningArtifact(value));
}

export function parsePlanningSeed(value: unknown): PlanningGraphSeed {
  return planningArtifactBoundary(() => parsePlanningGraphSeed(value));
}

export function planningArtifactBoundary<Value>(operation: () => Value): Value {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PlanningArtifactValidationError) fail(error.code, error.message);
    throw error;
  }
}

export function remapPlanningSeedGateContractKeys(
  nodes: readonly PlanningGraphSeed["nodes"][number][],
  gateIds: ReadonlyMap<string, string>,
): PlanningGraphSeed["nodes"] {
  return nodes.map((node) => {
    const contracts = node.spec.gate_contracts;
    if (!isRecord(contracts)) return structuredClone(node);
    const remapped: Record<string, ConfigurationValue> = {};
    for (const [key, contract] of Object.entries(contracts)) {
      const resolved = gateIds.get(key) ?? key;
      if (Object.hasOwn(remapped, resolved)) {
        fail(
          "graph_seed_gate_contract",
          `graph seed node ${node.key} defines duplicate gate contract ${resolved}`,
        );
      }
      const materializedContract = structuredClone(contract);
      if (
        resolved !== key &&
        isRecord(materializedContract) &&
        Array.isArray(materializedContract.argv)
      ) {
        materializedContract.argv = materializedContract.argv.map((argument) =>
          argument === key ? resolved : argument,
        );
      }
      remapped[resolved] = materializedContract;
    }
    return {
      ...structuredClone(node),
      spec: { ...structuredClone(node.spec), gate_contracts: remapped as JsonValue },
    };
  });
}

export function assertDevelopmentOnlySeedScope(run: RunRecord, seed: PlanningGraphSeed): void {
  const developmentOnly = /\bdevelopment(?:-|\s)only\b/iu.test(run.objective);
  const sealedFinalHoldout = /\bsealed\s+final\s+holdouts?\b/iu.test(run.objective);
  if (!developmentOnly || !sealedFinalHoldout) return;

  const prohibited =
    /\bholdouts?\b|\bheld[-\s]?out\b|\bheldout\b|\bfinal[-_\s]?(?:split|subjects?)\b/iu;
  const graphText = JSON.stringify({
    rootSpec: seed.rootSpec,
    nodes: seed.nodes,
    edges: seed.edges,
  });
  if (!prohibited.test(graphText)) return;
  fail(
    "graph_seed_sealed_holdout",
    "development-only objectives that prohibit sealed final holdouts may not seed holdout or final-split graph content",
  );
}

export function compilePlanningSeed(
  configuration: CompiledConfiguration,
  run: RunRecord,
  seed: PlanningGraphSeed,
  fullPlan: Record<PlanDomain, string>,
  projectRoot: string,
): TypedGraph {
  assertDevelopmentOnlySeedScope(run, seed);
  const schema = requireGraphSchema(configuration);
  const initialization = configuration.behavior.profile.initialization;
  const rootType = requiredNonempty(
    initialization.rootNodeType,
    "compiled initialization root node type",
  );
  const goalField = requiredNonempty(
    initialization.goalField,
    "compiled initialization goal field",
  ).replace(/^spec\./u, "");
  const contextField = requiredNonempty(
    initialization.planningContextField,
    "compiled initialization planning context field",
  ).replace(/^spec\./u, "");
  if (Object.hasOwn(seed.rootSpec, goalField) || Object.hasOwn(seed.rootSpec, contextField)) {
    fail(
      "graph_seed_protected_root",
      "graph seed rootSpec may not replace the run goal or compiler planning context",
    );
  }
  const operationId = requiredNonempty(
    initialization.planningSeedOperation,
    "compiled initialization planning seed operation",
  );
  const operation = configuration.registries.operations[operationId];
  if (operation === undefined)
    fail("graph_seed_operation", `planning seed operation ${operationId} is missing`);
  const allowedTypes = new Set(
    stringArray(operation.allowed_new_node_types, "planning seed allowed node types"),
  );
  const maximum = optionalSafeInteger(operation.max_new_nodes) ?? 1_024;
  if (seed.nodes.length > maximum)
    fail("graph_seed_node_limit", `graph seed exceeds operation limit ${maximum}`);
  const rootDefinition = schema.nodeTypes.get(rootType);
  if (rootDefinition === undefined)
    fail("graph_seed_root_type", `unknown root node type ${rootType}`);
  const rootId = `root-${digestBody(canonicalHash([run.id, rootType])).slice(0, 20)}`;
  const ids = new Map<string, string>([["$root", rootId]]);
  for (const node of seed.nodes) {
    if (!allowedTypes.has(node.type))
      fail("graph_seed_node_type", `planning seed operation does not allow ${node.type}`);
    ids.set(
      node.key,
      `${node.type}-${digestBody(canonicalHash([run.id, node.key, node.type])).slice(0, 20)}`,
    );
  }
  const materializedNodes = remapPlanningSeedGateContractKeys(
    seed.nodes,
    new Map(
      seed.nodes
        .filter((node) => node.type === "gate")
        .map((node) => [node.key, ids.get(node.key)!]),
    ),
  );
  const nodes: GraphNode[] = [
    {
      schema_version: "1.0",
      id: rootId,
      type: rootType,
      title: run.objective,
      status: requiredNonempty(initialization.rootStatus, "compiled initialization root status"),
      spec: {
        [goalField]: run.objective,
        ...structuredClone(seed.rootSpec),
        [contextField]: {
          protocol: "koni.approved-planning-context.v1",
          fullPlanSha256: canonicalHash(fullPlan),
          runTypeId: run.runTypeId,
        },
      },
      edges: {},
      annotations: {},
    },
  ];
  for (const source of materializedNodes) {
    const definition = schema.nodeTypes.get(source.type)!;
    rejectCompilerOwnedSpec(
      definition.compiler_owned_fields ?? [],
      source.spec,
      `graph seed node ${source.key}`,
    );
    nodes.push({
      schema_version: "1.0",
      id: ids.get(source.key)!,
      type: source.type,
      title: source.title,
      status: definition.initial_status,
      spec: structuredClone(source.spec),
      edges: {},
      annotations: {},
    });
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of seed.edges) {
    const source = byId.get(ids.get(edge.source)!)!;
    const target = byId.get(ids.get(edge.target)!)!;
    const resolved = schema.resolveEdge(source.type, edge.relation, target.type);
    const canonicalSource = resolved.reversed ? target : source;
    const canonicalTarget = resolved.reversed ? source : target;
    const targets = canonicalSource.edges[resolved.definition.relation] ?? [];
    if (!targets.includes(canonicalTarget.id)) targets.push(canonicalTarget.id);
    targets.sort(compareText);
    canonicalSource.edges[resolved.definition.relation] = targets;
  }
  try {
    const graph = new TypedGraph(schema, nodes, { projectRoot });
    assertConfiguredGraphConstraints(configuration, graph, projectRoot);
    return graph;
  } catch (error) {
    if (error instanceof GraphValidationError)
      fail(
        "graph_seed_invalid",
        "planning graph seed violates its typed schema",
        error.diagnostics,
      );
    throw error;
  }
}

/**
 * Direct-approval runs approve the objective itself: no model plan or approved planning context is
 * invented. The root-only graph is still fully schema validated so the normal rule compiler can
 * deterministically derive the first research/formulation tickets.
 */
export function compileDirectInitialGraph(
  configuration: CompiledConfiguration,
  run: RunRecord,
  projectRoot: string,
): TypedGraph {
  const schema = requireGraphSchema(configuration);
  const initialization = configuration.behavior.profile.initialization;
  const rootType = requiredNonempty(
    initialization.rootNodeType,
    "compiled initialization root node type",
  );
  const goalField = requiredNonempty(
    initialization.goalField,
    "compiled initialization goal field",
  ).replace(/^spec\./u, "");
  const rootDefinition = schema.nodeTypes.get(rootType);
  if (rootDefinition === undefined)
    fail("direct_approval_root_type", `unknown root node type ${rootType}`);
  // Direct runs intentionally skip the planner, but Research roots still require a
  // declarative scientific field. Preserve the compiler-owned intake objective and
  // use the separately collected proposition when the run type provides one.
  const directScientificField =
    rootDefinition.fields.hypothesis !== undefined
      ? "hypothesis"
      : rootDefinition.fields.statement !== undefined
        ? "statement"
        : undefined;
  const directScientificProposition =
    typeof run.intake.hypothesis === "string" && run.intake.hypothesis.trim().length > 0
      ? run.intake.hypothesis.trim()
      : run.objective;
  const rootId = `root-${digestBody(canonicalHash([run.id, rootType])).slice(0, 20)}`;
  try {
    const graph = new TypedGraph(
      schema,
      [
        {
          schema_version: "1.0",
          id: rootId,
          type: rootType,
          title: run.objective,
          status: requiredNonempty(
            initialization.rootStatus,
            "compiled initialization root status",
          ),
          spec: {
            [goalField]: run.objective,
            ...(directScientificField === undefined
              ? {}
              : { [directScientificField]: directScientificProposition }),
          },
          edges: {},
          annotations: { run_root: true },
        },
      ],
      { projectRoot },
    );
    assertConfiguredGraphConstraints(configuration, graph, projectRoot);
    return graph;
  } catch (error) {
    if (error instanceof GraphValidationError) {
      fail(
        "direct_approval_graph_invalid",
        "direct-approval root violates its typed schema",
        error.diagnostics,
      );
    }
    throw error;
  }
}

/**
 * Collapse the graph delta's redundant relationship views into the canonical edge mutation lane.
 *
 * A node upsert must carry a complete node for strict per-node CAS, so models naturally express a
 * relationship change both by editing `node.edges` and by using `addEdges`/`removeEdges`. Treat the
 * former as an ergonomic view of the latter, then restore the authoritative stored edge snapshot
 * before applying the upsert. The node hash check remains exact, while edge scope, direction,
 * deletion policy, predicates, and graph validation still run through their existing compiler
 * path. Annotations are deliberately not normalized because they have separate authority.
 */
export function normalizeAgentGraphRelationships(
  graph: TypedGraph,
  delta: GraphDelta,
  reviewReworkWritableNodeIds: readonly string[] = [],
): GraphDelta {
  const normalized = structuredClone(delta);
  const reviewReworkWritable = new Set(reviewReworkWritableNodeIds);
  const explicitAdds = new Set(normalized.addEdges.map(graphEdgeKey));
  const explicitRemovals = new Set(normalized.removeEdges.map(graphEdgeKey));
  const addKeys = new Set(explicitAdds);
  const removeKeys = new Set(explicitRemovals);

  const addEdge = (edge: GraphEdge): void => {
    const key = graphEdgeKey(edge);
    if (explicitRemovals.has(key)) {
      fail(
        "graph_delta_edge_conflict",
        `relationship ${edge.source}.${edge.relation} -> ${edge.target} is both added and removed`,
      );
    }
    if (!addKeys.has(key)) {
      normalized.addEdges.push(edge);
      addKeys.add(key);
    }
  };
  const removeEdge = (edge: GraphEdge): void => {
    const key = graphEdgeKey(edge);
    if (explicitAdds.has(key)) {
      fail(
        "graph_delta_edge_conflict",
        `relationship ${edge.source}.${edge.relation} -> ${edge.target} is both added and removed`,
      );
    }
    if (!removeKeys.has(key)) {
      normalized.removeEdges.push(edge);
      removeKeys.add(key);
    }
  };

  for (const mutation of normalized.upsertNodes) {
    const existing = graph.node(mutation.node.id);
    // Review recovery can replay the original create-shaped delta after the compiler has preserved
    // that ticket's accepted pre-review node. Durable graph_added activity is the ownership
    // receipt, so bind the replay to the exact current node instead of failing its original CAS.
    if (
      existing !== undefined &&
      mutation.expectedNodeHash === null &&
      reviewReworkWritable.has(existing.id)
    ) {
      mutation.expectedNodeHash = canonicalHash(existing);
    }
    const priorEdges = existing?.edges ?? {};
    const requestedEdges = mutation.node.edges;
    const relations = new Set([...Object.keys(priorEdges), ...Object.keys(requestedEdges)]);
    for (const relation of [...relations].sort(compareText)) {
      const priorTargets = new Set(priorEdges[relation] ?? []);
      const requestedTargets = new Set(requestedEdges[relation] ?? []);
      for (const target of [...requestedTargets].sort(compareText)) {
        if (!priorTargets.has(target)) addEdge({ source: mutation.node.id, relation, target });
      }
      for (const target of [...priorTargets].sort(compareText)) {
        if (!requestedTargets.has(target)) {
          const edge = { source: mutation.node.id, relation, target };
          // A create-shaped recovery output keeps relationships in the dedicated edge lane. If
          // that exact add was already preserved, the empty embedded snapshot does not delete it.
          if (!explicitAdds.has(graphEdgeKey(edge))) removeEdge(edge);
        }
      }
    }
    mutation.node.edges = structuredClone(priorEdges);
  }
  return normalized;
}

export function graphEdgeKey(edge: GraphEdge): string {
  return `${edge.source}\0${edge.relation}\0${edge.target}`;
}

/** Every graph node whose current state can materially affect review of a candidate delta. */
export function graphDeltaReviewCandidateNodeIds(delta: GraphDelta): string[] {
  const candidates = new Set<string>();
  for (const mutation of delta.upsertNodes) {
    candidates.add(mutation.node.id);
    for (const targets of Object.values(mutation.node.edges)) {
      for (const target of targets) candidates.add(target);
    }
  }
  for (const deletion of delta.deleteNodes) candidates.add(deletion.id);
  for (const edge of [...delta.addEdges, ...delta.removeEdges]) {
    candidates.add(edge.source);
    candidates.add(edge.target);
  }
  return [...candidates].sort(compareText);
}

/**
 * Later workflow steps retain authority over nodes this ticket created in earlier steps. The
 * original compiled definition cannot name those nodes because their IDs did not exist when the
 * ticket was derived. Compiler-authored graph activity is the durable ownership receipt; callers
 * still suppress write authority for graph-mutation-forbidden steps.
 */
export function ticketCreatedNodeIds(
  run: RunRecord,
  ticket: TicketRecord,
  graph: TypedGraph,
): string[] {
  return [
    ...new Set(
      run.activity
        .filter(
          (activity) =>
            activity.kind === "graph_added" &&
            activity.ticketId === ticket.id &&
            activity.nodeId !== undefined &&
            graph.node(activity.nodeId) !== undefined,
        )
        .map((activity) => activity.nodeId!),
    ),
  ].sort(compareText);
}

export function reviewReworkCoversStep(ticket: TicketRecord, stepId: string): boolean {
  const rework = ticket.reviewReworks?.at(-1);
  if (rework === undefined) return false;
  if (rework.scope === "review_only") {
    return ticket.steps.find((step) => step.id === stepId)?.kind === "review";
  }
  return reviewReworkAppliesToStep(ticket, stepId);
}

export function validateAgentGraphDelta(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  ticket: DerivedTicketDefinition,
  step: DerivedWorkflowStep,
  delta: GraphDelta,
  additionalWritableNodeIds: readonly string[] = [],
): void {
  // The whole-graph hash may have moved while the worker was in flight (a disjoint sibling ticket
  // committed its own compile). That is not a conflict: every check below validates each mutation
  // against the CURRENT `graph`, and `applyRebased` re-runs the per-node expectedNodeHash CAS, so a
  // node this delta actually touches changing underneath it still fails. The scheduler forbids a
  // concurrent ticket from writing any node in this delta's read/write scope, so a moved
  // whole-graph hash reflects only untouched sibling work — rebase instead of wedging the run.
  if (delta.expectedGraphHash !== graph.hash && !isSha256Digest(delta.expectedGraphHash)) {
    fail("graph_delta_cas", "agent graph delta carries no valid expected graph hash");
  }
  const operation = configuration.registries.operations[ticket.operation_registry_id];
  if (operation === undefined && !ticket.rule_id.startsWith("compiler."))
    fail("operation_missing", "ticket operation disappeared from pinned config");
  const writable = new Set([
    ...(step.write_node_ids ?? ticket.scope.write_node_ids),
    ...additionalWritableNodeIds,
  ]);
  const reviewReworkOwned = new Set(additionalWritableNodeIds);
  const allowedNew = new Set(
    stringArray(operation?.allowed_new_node_types, "allowed new node types"),
  );
  const allowedExisting = new Set(
    stringArray(operation?.allowed_existing_node_types, "allowed existing node types"),
  );
  const schema = requireGraphSchema(configuration);
  const typedGateIds = new Set(
    typedGateIdentityCatalog(configuration, graph).gateNodes.map((node) => node.id),
  );
  let added = 0;
  for (const mutation of delta.upsertNodes) {
    const existing = graph.node(mutation.node.id);
    if (existing === undefined) {
      added += 1;
      if (!allowedNew.has(mutation.node.type))
        fail("graph_delta_new_type", `operation cannot add ${mutation.node.type}`);
      const definition = schema.nodeTypes.get(mutation.node.type);
      if (definition === undefined || mutation.node.status !== definition.initial_status) {
        fail(
          "graph_delta_new_status",
          "new graph nodes must carry the compiler-declared initial status",
        );
      }
      rejectCompilerOwnedSpec(
        definition.compiler_owned_fields ?? [],
        mutation.node.spec,
        `new node ${mutation.node.id}`,
      );
      if (
        Object.keys(mutation.node.edges).length > 0 ||
        Object.keys(mutation.node.annotations).length > 0
      ) {
        fail(
          "graph_delta_embedded_state",
          "new node relationships and annotations must use dedicated authority tools/edge mutations",
        );
      }
    } else {
      if (!writable.has(existing.id))
        fail("graph_delta_write_scope", `node ${existing.id} is outside the step write scope`);
      if (
        allowedExisting.size > 0 &&
        !allowedExisting.has(existing.type) &&
        !reviewReworkOwned.has(existing.id)
      )
        fail("graph_delta_existing_type", `operation cannot update ${existing.type}`);
      if (mutation.node.type !== existing.type || mutation.node.status !== existing.status) {
        fail("graph_delta_compiler_state", "agent graph deltas may not change node type or status");
      }
      if (
        canonicalHash(mutation.node.edges) !== canonicalHash(existing.edges) ||
        canonicalHash(mutation.node.annotations) !== canonicalHash(existing.annotations)
      ) {
        fail(
          "graph_delta_embedded_state",
          "relationships and annotations must not be smuggled through a node upsert",
        );
      }
      preserveCompilerOwnedSpec(
        schema.nodeTypes.get(existing.type)?.compiler_owned_fields ?? [],
        existing,
        mutation.node,
      );
      if (operation?.operation === "implement-asset" && existing.type === "asset") {
        const existingContracts = optionalRecord(existing.spec.gate_contracts);
        assertAssetImplementationObligationsPreserved(existing, mutation.node, {
          removableGateContractIds: Object.keys(existingContracts ?? {}).filter(
            (gateId) => !typedGateIds.has(gateId),
          ),
        });
      }
      if (existing.type === "run") {
        assertRunPlanObligationsPreserved(existing, mutation.node);
        assertRunPlanUsesRepositoryOwnedArgv(mutation.node);
      }
    }
  }
  const maximum = optionalSafeInteger(operation?.max_new_nodes) ?? 0;
  if (added > maximum)
    fail("graph_delta_new_limit", `operation permits at most ${maximum} new nodes`);
  if (delta.deleteNodes.length > 0 && operation?.allow_node_deletion !== true)
    fail("graph_delta_delete", "operation does not allow node deletion");
  for (const deletion of delta.deleteNodes)
    if (!writable.has(deletion.id))
      fail("graph_delta_write_scope", `node ${deletion.id} is outside the step write scope`);
  if (delta.removeEdges.length > 0 && operation?.allow_edge_deletion !== true)
    fail("graph_delta_edge_delete", "operation does not allow relationship deletion");
  const addedIds = new Set(
    delta.upsertNodes.filter((item) => item.expectedNodeHash === null).map((item) => item.node.id),
  );
  const projected = new Map(graph.nodes().map((node) => [node.id, node]));
  for (const item of delta.upsertNodes) projected.set(item.node.id, item.node);
  for (const edge of [...delta.addEdges, ...delta.removeEdges]) {
    const source = projected.get(edge.source);
    const target = projected.get(edge.target);
    if (source === undefined || target === undefined)
      fail("graph_delta_edge_node", "graph edge references a missing node");
    const resolved = schema.resolveEdge(source.type, edge.relation, target.type);
    const canonicalSourceId = resolved.reversed ? target.id : source.id;
    if (!writable.has(canonicalSourceId) && !addedIds.has(canonicalSourceId)) {
      fail(
        "graph_delta_edge_scope",
        `relationship source ${canonicalSourceId} is outside the write scope`,
      );
    }
  }
}

/** Asset implementation must satisfy an admitted plan, not make missing work disappear. */
export function assertAssetImplementationObligationsPreserved(
  existing: GraphNode,
  updated: GraphNode,
  options: { readonly removableGateContractIds?: readonly string[] } = {},
): void {
  if (
    canonicalHash(existing.spec.capabilities ?? null) !==
    canonicalHash(updated.spec.capabilities ?? null)
  ) {
    fail(
      "asset_implementation_obligation",
      `asset ${existing.id} implementation cannot change its planned capability declarations`,
    );
  }
  const existingPlan = optionalRecord(existing.spec.implementation_plan);
  const updatedPlan = optionalRecord(updated.spec.implementation_plan);
  const existingImplementation = optionalRecord(existing.spec.implementation);
  const updatedImplementation = optionalRecord(updated.spec.implementation);
  assertDeclaredStringsPreserved(
    existing.id,
    "implementation file",
    existingPlan?.files,
    updatedPlan?.files,
  );
  assertDeclaredStringsPreserved(
    existing.id,
    "implementation entrypoint",
    existingImplementation?.entrypoints,
    updatedImplementation?.entrypoints,
  );
  const existingContracts = optionalRecord(existing.spec.gate_contracts);
  const updatedContracts = optionalRecord(updated.spec.gate_contracts);
  const removableContracts = new Set(options.removableGateContractIds ?? []);
  for (const gateId of Object.keys(existingContracts ?? {}).sort(compareText)) {
    if (updatedContracts?.[gateId] !== undefined || removableContracts.has(gateId)) continue;
    fail(
      "asset_implementation_obligation",
      `asset ${existing.id} implementation cannot remove declared gate contract ${gateId}`,
    );
  }
}

/** Recovery may correct a runtime contract, but it may not erase accepted execution obligations. */
export function assertRunPlanObligationsPreserved(existing: GraphNode, updated: GraphNode): void {
  const existingContract = optionalRecord(existing.spec.runtime_contract);
  if (existingContract === undefined) return;
  const updatedContract = optionalRecord(updated.spec.runtime_contract);
  for (const field of [
    "command",
    "composed_verification_command",
    "result_protocol",
    "required_measurements",
    "asset_entrypoints",
    "scientific_inputs",
  ] as const) {
    if (existingContract[field] === undefined || updatedContract?.[field] !== undefined) continue;
    fail(
      "runtime_contract_obligation",
      `run ${existing.id} update cannot remove established runtime obligation ${field}`,
    );
  }
}

/** Runtime plans must execute repository-owned programs, never source text smuggled through argv. */
export function assertRunPlanUsesRepositoryOwnedArgv(node: Readonly<GraphNode>): void {
  const contract = optionalRecord(node.spec.runtime_contract);
  if (contract === undefined) return;
  const interpreters =
    /^(?:bash|bun|deno|fish|node|perl|php|python(?:\d+(?:\.\d+)*)?|ruby|sh|zsh)$/u;
  const inlineFlags = new Set(["-c", "-e", "--eval", "--execute"]);
  for (const field of ["command", "composed_verification_command"] as const) {
    const raw = contract[field];
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== "string"))
      continue;
    const argv = raw as string[];
    const executable = path.basename(argv[0]!).toLowerCase();
    const embedsInlineSource =
      (interpreters.test(executable) &&
        argv.slice(1).some((argument) => inlineFlags.has(argument))) ||
      argv.some(
        (argument) =>
          argument.includes("\n") || argument.includes("\r") || /(?:^|\s)<<-?\s*/u.test(argument),
      );
    if (embedsInlineSource) {
      fail(
        "runtime_contract_inline_argv",
        `run ${node.id} ${field} cannot embed an inline interpreter payload; put the logic in a repository file and pass that project-relative path as a plain argv element`,
      );
    }
  }
}

export function assertDeclaredStringsPreserved(
  assetId: string,
  label: string,
  existing: unknown,
  updated: unknown,
): void {
  const required = Array.isArray(existing)
    ? existing.filter((value): value is string => typeof value === "string")
    : [];
  const retained = new Set(
    Array.isArray(updated)
      ? updated.filter((value): value is string => typeof value === "string")
      : [],
  );
  for (const value of required.sort(compareText)) {
    if (retained.has(value)) continue;
    fail(
      "asset_implementation_obligation",
      `asset ${assetId} implementation cannot remove declared ${label} ${value}`,
    );
  }
}

export function materializeCompilerFieldSources(
  configuration: CompiledConfiguration,
  run: RunRecord,
  delta: GraphDelta,
): GraphDelta {
  const schema = requireGraphSchema(configuration);
  const materialized = structuredClone(delta);
  for (const mutation of materialized.upsertNodes) {
    const definition = schema.nodeTypes.get(mutation.node.type);
    if (definition === undefined) continue;
    const legacyDelivery = canonicalHash(definition) === LEGACY_DELIVERY_NODE_SHA256;
    if (mutation.expectedNodeHash !== null && !legacyDelivery) continue;
    for (const [field, source] of Object.entries(compilerFieldSourcesForNodeType(definition))) {
      if (!field.startsWith("spec.")) {
        fail("compiler_field_source", `compiler field source ${field} must target spec.*`);
      }
      setNestedSpec(
        mutation.node.spec,
        field.slice("spec.".length),
        compilerFieldSourceValue(run, source),
      );
    }
  }
  return materialized;
}

export function compilerFieldSourcesForNodeType(
  definition: GraphNodeTypeDefinition,
): Readonly<Record<string, GraphCompilerFieldSource>> {
  if (definition.compiler_field_sources !== undefined) return definition.compiler_field_sources;
  // Exact compatibility for Coding 0.7/early-0.8 runs. Their delivery target was model-authored,
  // which allowed `main` to be guessed even when immutable run Git targeted another branch. New
  // profiles declare this binding directly; only the frozen legacy node contract is inferred.
  return canonicalHash(definition) === LEGACY_DELIVERY_NODE_SHA256
    ? { "spec.target_branch": "run.git.target.ref" }
    : {};
}

export function compilerFieldSourceValue(
  run: RunRecord,
  source: GraphCompilerFieldSource,
): JsonValue {
  switch (source) {
    case "run.id":
      return run.id;
    case "run.objective":
      return run.objective;
    case "run.run_type_id":
      return run.runTypeId;
    case "run.git.target.ref":
      return run.git.target.ref;
  }
}

export async function applyReviewEffects(input: {
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  ticket: DerivedTicketDefinition;
  step: DerivedWorkflowStep;
  reviewId: string;
  actor: string;
  candidateNodeIds: readonly string[];
  projectRoot: string;
  evidence?: RuleAuthorityEvidence;
}): Promise<{
  graph: TypedGraph;
  changes: Array<{ kind: "modified"; nodeId: string; nodeType: string; title: string }>;
}> {
  const { configuration, graph, ticket, step } = input;
  if (step.kind !== "review") return { graph, changes: [] };
  const operation = configuration.registries.operations[ticket.operation_registry_id];
  if (operation === undefined) return { graph, changes: [] };
  let current = graph;
  const changes: Array<{ kind: "modified"; nodeId: string; nodeType: string; title: string }> = [];
  if (operation.operation === "implement-asset") {
    for (const nodeId of input.candidateNodeIds) {
      const node = current.node(nodeId);
      if (node === undefined) continue;
      const acceptance = await prepareFilesystemManifestAcceptance(
        configuration,
        node,
        input.projectRoot,
      );
      if (acceptance === undefined) continue;
      if (acceptance.blockingErrors.length > 0) {
        fail(
          "filesystem_manifest_acceptance",
          `review cannot accept ${node.id}: ${acceptance.blockingErrors.join("; ")}`,
        );
      }
      const owned = new Set(
        stringArray(
          configuration.registries.node_types[node.type]?.compiler_owned_fields,
          `node type ${node.type} compiler-owned fields`,
        ),
      );
      if (!owned.has(acceptance.outputField)) {
        fail(
          "filesystem_manifest_authority",
          `filesystem manifest output ${acceptance.outputField} is not compiler-owned for ${node.type}`,
        );
      }
      const updated = structuredClone(node);
      setNodeField(updated, acceptance.outputField, acceptance.manifest as unknown as JsonValue);
      if (canonicalHash(updated) === canonicalHash(node)) continue;
      const applied = current.apply({
        protocol: "koni.graph-delta.v1",
        expectedGraphHash: current.hash,
        upsertNodes: [{ node: updated, expectedNodeHash: canonicalHash(node) }],
        deleteNodes: [],
        addEdges: [],
        removeEdges: [],
      });
      current = applied.graph;
      changes.push({ kind: "modified", nodeId: node.id, nodeType: node.type, title: node.title });
    }
  }
  if (!Array.isArray(operation.review_effects)) return { graph: current, changes };
  for (const rawEffect of operation.review_effects) {
    const effect = requiredRecord(
      rawEffect,
      `review effect for ${ticket.id}`,
    ) as ConfigurationObject;
    if (effect.verdict !== "passed") continue;
    const select = requiredRecord(effect.select, "review effect selector");
    const nodeTypes = new Set(stringArray(select.node_types, "review effect node types"));
    const set = requiredRecord(effect.set, "review effect set") as ConfigurationObject;
    const classified = input.candidateNodeIds
      .map((id) => current.node(id))
      .flatMap((node) => {
        if (node === undefined || (nodeTypes.size > 0 && !nodeTypes.has(node.type))) return [];
        const pending = predicateMatches(node, optionalRecord(select.predicate));
        if (!pending && !reviewEffectSetAlreadyApplied(node, set, input.reviewId, input.actor))
          return [];
        return [{ node, pending }];
      });
    const candidates = classified.map(({ node }) => node);
    validateEffectCount(candidates.length, optionalRecord(effect.count));
    const preconditions = Array.isArray(effect.preconditions) ? effect.preconditions : [];
    for (const { node, pending } of classified) {
      // Preconditions describe the legal transition source. A hash-bound replay may already be
      // in the exact configured after-state (including fields whose source predicate was absent),
      // so only newly transitioning candidates must still satisfy them.
      if (!pending) continue;
      for (const precondition of preconditions) {
        if (!predicateMatches(node, requiredRecord(precondition, "review effect precondition"))) {
          fail("review_effect_precondition", `review effect precondition failed for ${node.id}`);
        }
      }
    }
    await validateOperationReceiptCoverage({
      configuration,
      graph: current,
      operationId: ticket.operation_registry_id,
      operation,
      candidates,
      projectRoot: input.projectRoot,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
    await validateReviewEffectCoverage({
      configuration,
      graph: current,
      ticket,
      effect,
      candidates,
      projectRoot: input.projectRoot,
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    });
    for (const node of candidates) {
      const updated = structuredClone(node);
      for (const [field, value] of Object.entries(set)) {
        const resolved = resolveReviewEffectTokens(value, input.reviewId, input.actor);
        if (field === "status") updated.status = requiredNonempty(resolved, "review effect status");
        else if (field.startsWith("spec."))
          setNestedSpec(updated.spec, field.slice("spec.".length), resolved);
        else fail("review_effect_field", `unsupported compiler review effect field ${field}`);
      }
      // A terminal action may be replayed after its graph writes were durably published but its
      // ticket/action settlement was interrupted. Revalidating that exact after-state must not
      // manufacture a second graph revision or require another model attempt.
      if (canonicalHash(updated) === canonicalHash(node)) continue;
      const applied = current.apply({
        protocol: "koni.graph-delta.v1",
        expectedGraphHash: current.hash,
        upsertNodes: [{ node: updated, expectedNodeHash: canonicalHash(node) }],
        deleteNodes: [],
        addEdges: [],
        removeEdges: [],
      });
      current = applied.graph;
      changes.push({ kind: "modified", nodeId: node.id, nodeType: node.type, title: node.title });
    }
  }
  return { graph: current, changes };
}

/**
 * Recognize the exact compiler-owned after-state of a review effect.
 *
 * This is deliberately narrower than ignoring the selector predicate: every static field in the
 * configured `set` must already match, and token fields are accepted only when the prior value is
 * a non-empty authenticated compiler value. At least one static field is required so an effect
 * containing only a fresh review token can never select an otherwise-unqualified node.
 */
