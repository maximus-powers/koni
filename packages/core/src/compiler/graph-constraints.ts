import type { CompiledConfiguration, ConfigurationValue } from "../contracts/configuration.js";
import type { CompilerGraphNode, CompilerGraphProjection } from "../contracts/rules.js";
import {
  GraphSchema,
  GraphValidationError,
  type GraphNode,
  type TypedGraph,
} from "../graph/model.js";
import { canonicalEncode, compareUtf8 } from "../shared/canonical.js";
import {
  createProjectPathAuthority,
  normalizeProjectRelativePath,
  type ProjectPathAuthority,
} from "../shared/project-path-authority.js";
import { GraphExpressionEvaluator } from "./expressions.js";
import {
  projectGraphConstraintDefinitions,
  projectGraphSchemaDefinition,
  type CompiledGraphConstraintDefinition,
  type CompiledGraphPathSetDefinition,
} from "./graph-schema.js";

interface SelectedGraphPath {
  readonly nodeId: string;
  readonly path: string;
}

interface GraphPathConstraintConflict {
  readonly left_node: string;
  readonly left_path: string;
  readonly right_node: string;
  readonly right_path: string;
}

/** Execute every configured whole-graph invariant against one immutable graph epoch. */
export function validateConfiguredGraphConstraints(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  projectRoot: string,
): void {
  const schemaProjection = projectGraphSchemaDefinition(configuration);
  if (!schemaProjection.ok) {
    throw new GraphValidationError(schemaProjection.diagnostics.map(formatCompilerDiagnostic));
  }
  const schema = new GraphSchema(schemaProjection.value);
  const constraintProjection = projectGraphConstraintDefinitions(configuration, schema);
  if (!constraintProjection.ok) {
    throw new GraphValidationError(constraintProjection.diagnostics.map(formatCompilerDiagnostic));
  }
  const projection = compilerGraphProjection(graph);
  const evaluator = new GraphExpressionEvaluator(configuration, projection);
  const pathAuthority = createProjectPathAuthority(projectRoot);
  const diagnostics: string[] = [];
  for (const constraint of constraintProjection.value) {
    validatePathSetsDisjoint(constraint, evaluator, projection, pathAuthority, diagnostics);
  }
  if (diagnostics.length > 0) {
    throw new GraphValidationError([...new Set(diagnostics)].sort(compareUtf8));
  }
}

function validatePathSetsDisjoint(
  constraint: CompiledGraphConstraintDefinition,
  evaluator: GraphExpressionEvaluator,
  graph: CompilerGraphProjection,
  pathAuthority: ProjectPathAuthority,
  diagnostics: string[],
): void {
  let left: readonly SelectedGraphPath[];
  let right: readonly SelectedGraphPath[];
  try {
    left = selectedGraphPathSet(evaluator, graph, constraint, "left", constraint.left);
    right = selectedGraphPathSet(evaluator, graph, constraint, "right", constraint.right);
  } catch (error) {
    diagnostics.push(
      error instanceof Error
        ? error.message
        : `graph constraint ${constraint.id} could not select path authority`,
    );
    return;
  }
  const conflicts = new Map<string, GraphPathConstraintConflict>();
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (constraint.distinctNodes && leftPath.nodeId === rightPath.nodeId) continue;
      let overlaps: boolean;
      try {
        overlaps = pathAuthority.pathsOverlap(leftPath.path, rightPath.path);
      } catch {
        diagnostics.push(
          `graph constraint ${constraint.id} could not safely compare selected path authority`,
        );
        return;
      }
      if (!overlaps) continue;
      const conflict = canonicalGraphPathConflict(leftPath, rightPath);
      conflicts.set(canonicalEncode(conflict), conflict);
    }
  }
  if (conflicts.size === 0) return;
  const sorted = [...conflicts.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([, conflict]) => conflict);
  const bounded = sorted.slice(0, 8);
  const omitted = sorted.length - bounded.length;
  diagnostics.push(
    `graph constraint ${constraint.id} requires selected path sets to be authority-disjoint; ` +
      `conflicts=${JSON.stringify(bounded)}${omitted > 0 ? `; ${omitted} additional conflict(s) omitted` : ""}`,
  );
}

function selectedGraphPathSet(
  evaluator: GraphExpressionEvaluator,
  graph: CompilerGraphProjection,
  constraint: CompiledGraphConstraintDefinition,
  side: "left" | "right",
  definition: CompiledGraphPathSetDefinition,
): readonly SelectedGraphPath[] {
  const selected = evaluator.select(
    definition.select,
    `/graph_constraints/${constraint.id}/${side}/select`,
  );
  const output = new Map<string, SelectedGraphPath>();
  for (const nodeId of selected) {
    const node = graph.node(nodeId);
    if (node === undefined) {
      throw new GraphValidationError([
        `graph constraint ${constraint.id} ${side} selector returned missing node ${nodeId}`,
      ]);
    }
    if (!definition.nodeTypes.includes(node.type)) {
      throw new GraphValidationError([
        `graph constraint ${constraint.id} ${side} selector returned undeclared node type ${node.type}`,
      ]);
    }
    for (const value of projectedNodePathValues(node, definition.field, constraint.id, side)) {
      const selectedPath = { nodeId: node.id, path: normalizeProjectRelativePath(value) };
      output.set(`${selectedPath.nodeId}\0${selectedPath.path}`, selectedPath);
    }
  }
  return [...output.values()].sort(
    (left, right) => compareUtf8(left.nodeId, right.nodeId) || compareUtf8(left.path, right.path),
  );
}

function projectedNodePathValues(
  node: CompilerGraphNode,
  field: string,
  constraintId: string,
  side: "left" | "right",
): readonly string[] {
  const value = compilerNodeFieldValue(node, field);
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...new Set(value)].sort(compareUtf8);
  }
  throw new GraphValidationError([
    `graph constraint ${constraintId} ${side} projection ${node.id}.${field} must be a path string or list of path strings`,
  ]);
}

function compilerNodeFieldValue(
  node: CompilerGraphNode,
  field: string,
): ConfigurationValue | undefined {
  const normalized = field.replace(/^\$\./u, "");
  const [root, ...segments] = normalized.split(".");
  let value: ConfigurationValue | undefined =
    root === "spec"
      ? node.spec
      : root === "annotations"
        ? node.annotations
        : root === "fields"
          ? node.fields
          : node.spec[root!];
  const remainder =
    root === "spec" || root === "annotations" || root === "fields" ? segments : segments;
  for (const segment of remainder) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function canonicalGraphPathConflict(
  left: SelectedGraphPath,
  right: SelectedGraphPath,
): GraphPathConstraintConflict {
  const leftIdentity = `${left.nodeId}\0${left.path}`;
  const rightIdentity = `${right.nodeId}\0${right.path}`;
  const [first, second] =
    compareUtf8(leftIdentity, rightIdentity) <= 0 ? [left, right] : [right, left];
  return {
    left_node: first.nodeId,
    left_path: first.path,
    right_node: second.nodeId,
    right_path: second.path,
  };
}

function compilerGraphProjection(graph: TypedGraph): CompilerGraphProjection {
  const nodes = graph.nodes().map(compilerGraphNode);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    nodes: () => nodes,
    node: (id) => byId.get(id),
  };
}

function compilerGraphNode(node: GraphNode): CompilerGraphNode {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    status: node.status,
    spec: structuredClone(node.spec),
    edges: structuredClone(node.edges),
    annotations: structuredClone(node.annotations),
  };
}

function formatCompilerDiagnostic(diagnostic: {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}): string {
  return `${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`;
}

function isRecord(value: unknown): value is Record<string, ConfigurationValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
