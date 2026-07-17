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
  type GraphNodeTypeDefinition,
} from "../graph/model.js";
import { compareUtf8 } from "../shared/canonical.js";
import {
  DiagnosticBag,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "../shared/diagnostics.js";

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

/** Build the executable graph schema owned by graph/model.ts from compiler configuration. */
export function projectGraphSchemaDefinition(
  configuration: CompiledConfiguration,
): ValidationResult<GraphSchemaDefinition> {
  const bag = new DiagnosticBag();
  const nodeTypes: GraphNodeTypeDefinition[] = [];
  for (const [registryId, source] of Object.entries(configuration.registries.node_types)) {
    const path = `/registries/node_types/${escapePointer(registryId)}`;
    const id = requiredString(source.id, `${path}/id`, bag);
    const description = requiredString(source.description, `${path}/description`, bag);
    const statuses = stringArray(source.statuses, `${path}/statuses`, bag);
    const initialStatus = requiredString(source.initial_status, `${path}/initial_status`, bag);
    const fields = fieldMap(source.fields, `${path}/fields`, bag);
    if (id !== undefined && id !== registryId) {
      bag.error("graph_schema.registry_id", `${path}/id`, `node type id ${id} does not match registry key ${registryId}`);
    }
    if (id === undefined || description === undefined || initialStatus === undefined || fields === undefined) continue;
    nodeTypes.push({
      id,
      description,
      ...(source.stage === undefined ? {} : { stage: requiredString(source.stage, `${path}/stage`, bag) ?? "" }),
      statuses,
      initial_status: initialStatus,
      ...(source.compiler_owned_fields === undefined
        ? {}
        : { compiler_owned_fields: stringArray(source.compiler_owned_fields, `${path}/compiler_owned_fields`, bag) }),
      ...(source.agent_visible_compiler_owned_fields === undefined
        ? {}
        : {
            agent_visible_compiler_owned_fields: stringArray(
              source.agent_visible_compiler_owned_fields,
              `${path}/agent_visible_compiler_owned_fields`,
              bag,
            ),
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
    edgeTypes.push({
      source: sourceType,
      relation,
      targets,
      ...(source.inverse === undefined ? {} : { inverse: requiredString(source.inverse, `${path}/inverse`, bag) ?? "" }),
      ...(source.bidirectional === undefined
        ? {}
        : { bidirectional: booleanValue(source.bidirectional, `${path}/bidirectional`, bag) ?? false }),
      ...(source.min === undefined ? {} : { min: nonnegativeInteger(source.min, `${path}/min`, bag) ?? 0 }),
      ...(source.max === undefined ? {} : { max: nonnegativeInteger(source.max, `${path}/max`, bag) ?? 0 }),
      ...(source.acyclic === undefined ? {} : { acyclic: booleanValue(source.acyclic, `${path}/acyclic`, bag) ?? false }),
    });
  }
  edgeTypes.sort((left, right) => compareUtf8(left.source, right.source) || compareUtf8(left.relation, right.relation));
  if (bag.hasErrors()) return validationFailure(bag.sorted());
  const definition = deepFreeze({ nodeTypes, edgeTypes });
  try {
    // Keep semantic graph validation in its owning runtime while returning a
    // definition that consumers can instantiate without a second failure path.
    new GraphSchema(definition);
  } catch (error) {
    if (error instanceof GraphValidationError) {
      for (const message of error.diagnostics) {
        bag.error("graph_schema.semantic", "/graph_schema", message);
      }
    } else {
      bag.error("graph_schema.semantic", "/graph_schema", "graph runtime rejected the compiled schema");
    }
  }
  if (bag.hasErrors()) return validationFailure(bag.sorted());
  return validationSuccess(definition, bag.sorted());
}

function fieldMap(
  value: ConfigurationValue | undefined,
  path: string,
  bag: DiagnosticBag,
): Record<string, GraphFieldDefinition> | undefined {
  if (value === undefined) return {};
  const object = objectValue(value, path, bag);
  if (object === undefined) return undefined;
  const output: Record<string, GraphFieldDefinition> = Object.create(null) as Record<string, GraphFieldDefinition>;
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
  if (type === undefined || !FIELD_TYPES.has(type as GraphFieldDefinition["type"])) return undefined;
  const properties = source.properties === undefined ? undefined : fieldMap(source.properties, `${path}/properties`, bag);
  const items = source.items === undefined ? undefined : fieldDefinition(source.items, `${path}/items`, bag);
  return {
    type: type as GraphFieldDefinition["type"],
    ...(source.required === undefined ? {} : { required: booleanValue(source.required, `${path}/required`, bag) ?? false }),
    ...(source.enum === undefined ? {} : { enum: jsonArray(source.enum, `${path}/enum`, bag) }),
    ...(source.pattern === undefined ? {} : { pattern: requiredString(source.pattern, `${path}/pattern`, bag) ?? "" }),
    ...(items === undefined ? {} : { items }),
    ...(properties === undefined ? {} : { properties }),
    ...(source.additional_properties === undefined
      ? {}
      : { additional_properties: booleanValue(source.additional_properties, `${path}/additional_properties`, bag) ?? false }),
    ...(source.unique_by === undefined ? {} : { unique_by: requiredString(source.unique_by, `${path}/unique_by`, bag) ?? "" }),
    ...(source.subset_of === undefined ? {} : { subset_of: requiredString(source.subset_of, `${path}/subset_of`, bag) ?? "" }),
    ...(source.disjoint_from === undefined ? {} : { disjoint_from: requiredString(source.disjoint_from, `${path}/disjoint_from`, bag) ?? "" }),
    ...(source.description === undefined ? {} : { description: requiredString(source.description, `${path}/description`, bag) ?? "" }),
  };
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

function jsonArray(
  value: ConfigurationValue,
  path: string,
  bag: DiagnosticBag,
): JsonValue[] {
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
    for (const key of Object.keys(object).sort(compareUtf8)) output[key] = toJsonValue(object[key]!);
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
