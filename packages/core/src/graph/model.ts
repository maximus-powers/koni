import type { JsonValue } from "../authority/protocol.js";
import { canonicalHash, type Sha256Digest } from "../shared/canonical.js";

export interface GraphNode {
  schema_version: "1.0";
  id: string;
  type: string;
  title: string;
  status: string;
  spec: Record<string, JsonValue>;
  edges: Record<string, string[]>;
  annotations: Record<string, JsonValue>;
}

export interface GraphFieldDefinition {
  type:
    | "string"
    | "boolean"
    | "number"
    | "integer"
    | "list"
    | "object"
    | "path"
    | "node_ref"
    | "json";
  required?: boolean;
  enum?: JsonValue[];
  pattern?: string;
  items?: GraphFieldDefinition;
  properties?: Record<string, GraphFieldDefinition>;
  additional_properties?: boolean;
  unique_by?: string;
  subset_of?: string;
  disjoint_from?: string;
  description?: string;
}

export interface GraphNodeTypeDefinition {
  id: string;
  description: string;
  stage?: string;
  statuses: string[];
  initial_status: string;
  compiler_owned_fields?: string[];
  agent_visible_compiler_owned_fields?: string[];
  required_any?: string[][];
  fields: Record<string, GraphFieldDefinition>;
}

export interface GraphEdgeTypeDefinition {
  source: string;
  relation: string;
  targets: string[];
  inverse?: string;
  bidirectional?: boolean;
  min?: number;
  max?: number;
  acyclic?: boolean;
}

export interface GraphSchemaDefinition {
  nodeTypes: readonly GraphNodeTypeDefinition[];
  edgeTypes: readonly GraphEdgeTypeDefinition[];
}

export interface GraphEdge {
  source: string;
  relation: string;
  target: string;
}

export interface GraphDelta {
  protocol: "koni.graph-delta.v1";
  expectedGraphHash: Sha256Digest;
  upsertNodes: { node: GraphNode; expectedNodeHash: Sha256Digest | null }[];
  deleteNodes: { id: string; expectedNodeHash: Sha256Digest }[];
  addEdges: GraphEdge[];
  removeEdges: GraphEdge[];
}

export interface AppliedGraphDelta {
  graph: TypedGraph;
  hash: Sha256Digest;
  changes: {
    kind: "added" | "modified" | "deleted";
    nodeId: string;
    nodeType: string;
    title: string;
  }[];
}

export class GraphValidationError extends Error {
  public readonly diagnostics: readonly string[];

  public constructor(diagnostics: readonly string[]) {
    super(diagnostics.join("\n"));
    this.name = "GraphValidationError";
    this.diagnostics = diagnostics;
  }
}

export class GraphSchema {
  readonly nodeTypes: ReadonlyMap<string, GraphNodeTypeDefinition>;
  readonly edgeTypes: readonly GraphEdgeTypeDefinition[];

  public constructor(definition: GraphSchemaDefinition) {
    const diagnostics: string[] = [];
    const nodeTypes = new Map<string, GraphNodeTypeDefinition>();
    for (const nodeType of definition.nodeTypes) {
      if (!isIdentifier(nodeType.id) || nodeTypes.has(nodeType.id)) {
        diagnostics.push(`invalid or duplicate node type: ${nodeType.id}`);
      }
      if (nodeType.description.trim().length === 0) {
        diagnostics.push(`node type ${nodeType.id} must have a description`);
      }
      if (!nodeType.statuses.includes(nodeType.initial_status)) {
        diagnostics.push(`node type ${nodeType.id} initial status is not declared`);
      }
      nodeTypes.set(nodeType.id, structuredClone(nodeType));
    }
    const keys = new Set<string>();
    for (const edge of definition.edgeTypes) {
      const key = `${edge.source}\0${edge.relation}`;
      if (!isIdentifier(edge.relation) || keys.has(key)) {
        diagnostics.push(`invalid or duplicate edge type: ${edge.source}.${edge.relation}`);
      }
      keys.add(key);
      if (!nodeTypes.has(edge.source) || edge.targets.some((target) => !nodeTypes.has(target))) {
        diagnostics.push(`edge ${edge.source}.${edge.relation} references an unknown node type`);
      }
      if (edge.bidirectional === true && (edge.inverse === undefined || !isIdentifier(edge.inverse))) {
        diagnostics.push(`bidirectional edge ${edge.source}.${edge.relation} requires an inverse name`);
      }
      if ((edge.min ?? 0) < 0 || (edge.max !== undefined && edge.max < (edge.min ?? 0))) {
        diagnostics.push(`edge ${edge.source}.${edge.relation} has invalid cardinality`);
      }
    }
    if (diagnostics.length > 0) {
      throw new GraphValidationError(diagnostics.sort());
    }
    this.nodeTypes = nodeTypes;
    this.edgeTypes = definition.edgeTypes.map((edge) => structuredClone(edge));
  }

  public resolveEdge(sourceType: string, relation: string, targetType: string): {
    definition: GraphEdgeTypeDefinition;
    reversed: boolean;
  } {
    const matches: { definition: GraphEdgeTypeDefinition; reversed: boolean }[] = [];
    for (const definition of this.edgeTypes) {
      if (
        definition.source === sourceType &&
        definition.relation === relation &&
        definition.targets.includes(targetType)
      ) {
        matches.push({ definition, reversed: false });
      }
      if (
        definition.bidirectional === true &&
        definition.inverse === relation &&
        definition.targets.includes(sourceType) &&
        definition.source === targetType
      ) {
        matches.push({ definition, reversed: true });
      }
    }
    if (matches.length !== 1) {
      throw new GraphValidationError([
        matches.length === 0
          ? `edge is not permitted: ${sourceType}.${relation} -> ${targetType}`
          : `edge is ambiguous: ${sourceType}.${relation} -> ${targetType}`,
      ]);
    }
    return matches[0]!;
  }
}

export class TypedGraph {
  readonly #schema: GraphSchema;
  readonly #nodes: Map<string, GraphNode>;

  public constructor(schema: GraphSchema, nodes: readonly GraphNode[] = []) {
    this.#schema = schema;
    this.#nodes = new Map(nodes.map((node) => [node.id, structuredClone(node)]));
    this.validate();
  }

  public get hash(): Sha256Digest {
    return canonicalHash(this.toJSON());
  }

  public node(id: string): GraphNode | undefined {
    const node = this.#nodes.get(id);
    return node === undefined ? undefined : structuredClone(node);
  }

  public nodes(): GraphNode[] {
    return [...this.#nodes.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => structuredClone(node));
  }

  public edges(): GraphEdge[] {
    return this.nodes().flatMap((node) =>
      Object.entries(node.edges)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([relation, targets]) =>
          [...targets].sort().map((target) => ({ source: node.id, relation, target })),
        ),
    );
  }

  public neighbors(id: string, relation?: string): GraphNode[] {
    const node = this.#nodes.get(id);
    if (node === undefined) {
      return [];
    }
    const ids = new Set<string>();
    for (const definition of this.#schema.edgeTypes) {
      if (definition.source === node.type && (relation === undefined || relation === definition.relation)) {
        for (const target of node.edges[definition.relation] ?? []) ids.add(target);
      }
      if (
        definition.bidirectional === true &&
        definition.targets.includes(node.type) &&
        (relation === undefined || relation === definition.inverse)
      ) {
        for (const candidate of this.#nodes.values()) {
          if (
            candidate.type === definition.source &&
            (candidate.edges[definition.relation] ?? []).includes(id)
          ) ids.add(candidate.id);
        }
      }
    }
    return [...ids].sort().map((neighborId) => structuredClone(this.#nodes.get(neighborId)!));
  }

  public traverse(
    starts: readonly string[],
    options: { relation?: string; minDepth?: number; maxDepth: number },
  ): GraphNode[] {
    const minDepth = options.minDepth ?? 1;
    if (minDepth < 0 || options.maxDepth < minDepth || options.maxDepth > 64) {
      throw new Error("graph traversal depth is invalid or unbounded");
    }
    const seen = new Set(starts);
    const queue = starts.map((id) => ({ id, depth: 0 }));
    const output: GraphNode[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= options.maxDepth) continue;
      for (const neighbor of this.neighbors(current.id, options.relation)) {
        if (seen.has(neighbor.id)) continue;
        seen.add(neighbor.id);
        const depth = current.depth + 1;
        if (depth >= minDepth) output.push(neighbor);
        queue.push({ id: neighbor.id, depth });
      }
    }
    return output;
  }

  public apply(delta: GraphDelta): AppliedGraphDelta {
    if (delta.protocol !== "koni.graph-delta.v1" || delta.expectedGraphHash !== this.hash) {
      throw new GraphValidationError(["graph delta expected hash is stale or unsupported"]);
    }
    const graph = new TypedGraph(this.#schema, this.nodes());
    const changes: AppliedGraphDelta["changes"] = [];
    for (const mutation of delta.upsertNodes) {
      const existing = graph.#nodes.get(mutation.node.id);
      const actual = existing === undefined ? null : canonicalHash(existing);
      if (actual !== mutation.expectedNodeHash) {
        throw new GraphValidationError([`node changed before graph delta: ${mutation.node.id}`]);
      }
      graph.#nodes.set(mutation.node.id, structuredClone(mutation.node));
      changes.push({
        kind: existing === undefined ? "added" : "modified",
        nodeId: mutation.node.id,
        nodeType: mutation.node.type,
        title: mutation.node.title,
      });
    }
    for (const deletion of delta.deleteNodes) {
      const existing = graph.#nodes.get(deletion.id);
      if (existing === undefined || canonicalHash(existing) !== deletion.expectedNodeHash) {
        throw new GraphValidationError([`node changed before deletion: ${deletion.id}`]);
      }
      graph.#nodes.delete(deletion.id);
      for (const node of graph.#nodes.values()) {
        for (const targets of Object.values(node.edges)) {
          const index = targets.indexOf(deletion.id);
          if (index >= 0) targets.splice(index, 1);
        }
      }
      changes.push({ kind: "deleted", nodeId: existing.id, nodeType: existing.type, title: existing.title });
    }
    for (const edge of delta.removeEdges) graph.#mutateEdge(edge, false);
    for (const edge of delta.addEdges) graph.#mutateEdge(edge, true);
    graph.validate();
    return { graph, hash: graph.hash, changes };
  }

  public validate(): void {
    const diagnostics: string[] = [];
    for (const node of this.#nodes.values()) {
      validateNode(node, this.#schema, diagnostics);
    }
    for (const definition of this.#schema.edgeTypes) {
      for (const node of this.#nodes.values()) {
        if (node.type !== definition.source) continue;
        const targets = node.edges[definition.relation] ?? [];
        if (targets.length < (definition.min ?? 0)) {
          diagnostics.push(`${node.id}.${definition.relation} has fewer than ${definition.min} targets`);
        }
        if (definition.max !== undefined && targets.length > definition.max) {
          diagnostics.push(`${node.id}.${definition.relation} has more than ${definition.max} targets`);
        }
        for (const targetId of targets) {
          const target = this.#nodes.get(targetId);
          if (target === undefined) diagnostics.push(`${node.id}.${definition.relation} targets missing node ${targetId}`);
          else if (!definition.targets.includes(target.type)) {
            diagnostics.push(`${node.id}.${definition.relation} cannot target ${target.type}`);
          }
        }
      }
      if (definition.acyclic === true) validateAcyclic(this.#nodes, definition, diagnostics);
    }
    if (diagnostics.length > 0) throw new GraphValidationError([...new Set(diagnostics)].sort());
  }

  public toJSON(): Record<string, GraphNode> {
    const output: Record<string, GraphNode> = Object.create(null) as Record<string, GraphNode>;
    for (const node of this.nodes()) output[node.id] = node;
    return output;
  }

  #mutateEdge(edge: GraphEdge, add: boolean): void {
    const source = this.#nodes.get(edge.source);
    const target = this.#nodes.get(edge.target);
    if (source === undefined || target === undefined) {
      throw new GraphValidationError([`edge references a missing node: ${edge.source} -> ${edge.target}`]);
    }
    const resolved = this.#schema.resolveEdge(source.type, edge.relation, target.type);
    const canonicalSource = resolved.reversed ? target : source;
    const canonicalTarget = resolved.reversed ? source : target;
    const relation = resolved.definition.relation;
    const targets = canonicalSource.edges[relation] ?? [];
    if (add) {
      if (!targets.includes(canonicalTarget.id)) targets.push(canonicalTarget.id);
      targets.sort();
      canonicalSource.edges[relation] = targets;
    } else {
      canonicalSource.edges[relation] = targets.filter((id) => id !== canonicalTarget.id);
    }
  }
}

function validateNode(node: GraphNode, schema: GraphSchema, diagnostics: string[]): void {
  const definition = schema.nodeTypes.get(node.type);
  if (!isIdentifier(node.id) || definition === undefined) {
    diagnostics.push(`node ${node.id} has an invalid identity or unknown type ${node.type}`);
    return;
  }
  if (node.schema_version !== "1.0" || node.title.trim().length === 0) {
    diagnostics.push(`node ${node.id} has an invalid schema version or empty title`);
  }
  if (!definition.statuses.includes(node.status)) diagnostics.push(`node ${node.id} has invalid status ${node.status}`);
  for (const [field, fieldDefinition] of Object.entries(definition.fields)) {
    const value = node.spec[field];
    if (value === undefined) {
      if (fieldDefinition.required === true) diagnostics.push(`node ${node.id} is missing spec.${field}`);
    } else {
      validateField(value, fieldDefinition, `node ${node.id} spec.${field}`, diagnostics);
    }
  }
  for (const field of Object.keys(node.spec)) {
    if (!(field in definition.fields)) diagnostics.push(`node ${node.id} has unknown spec field ${field}`);
  }
  for (const group of definition.required_any ?? []) {
    if (!group.some((field) => node.spec[field] !== undefined)) {
      diagnostics.push(`node ${node.id} requires one of ${group.join(", ")}`);
    }
  }
  for (const relation of Object.keys(node.edges)) {
    const targets = node.edges[relation]!;
    if (!schema.edgeTypes.some((edge) => edge.source === node.type && edge.relation === relation)) {
      diagnostics.push(`node ${node.id} stores unknown or redundant inverse edge ${relation}`);
    }
    if (new Set(targets).size !== targets.length) {
      diagnostics.push(`node ${node.id}.${relation} has duplicate targets`);
    }
  }
}

function validateField(
  value: JsonValue,
  definition: GraphFieldDefinition,
  location: string,
  diagnostics: string[],
): void {
  const validType =
    (definition.type === "string" && typeof value === "string") ||
    (definition.type === "node_ref" && typeof value === "string" && isIdentifier(value)) ||
    definition.type === "json" ||
    (definition.type === "path" && typeof value === "string" && isSafeProjectPath(value)) ||
    (definition.type === "boolean" && typeof value === "boolean") ||
    (definition.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (definition.type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) ||
    (definition.type === "list" && Array.isArray(value)) ||
    (definition.type === "object" && isRecord(value));
  if (!validType) {
    diagnostics.push(`${location} has wrong type; expected ${definition.type}`);
    return;
  }
  if (definition.enum !== undefined && !definition.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    diagnostics.push(`${location} is not one of its declared values`);
  }
  if (definition.pattern !== undefined && typeof value === "string") {
    try {
      if (!new RegExp(definition.pattern, "u").test(value)) diagnostics.push(`${location} does not match its pattern`);
    } catch {
      diagnostics.push(`${location} has an invalid configured pattern`);
    }
  }
  if (Array.isArray(value)) {
    if (definition.items !== undefined) {
      value.forEach((item, index) => validateField(item, definition.items!, `${location}[${index}]`, diagnostics));
    }
    if (definition.unique_by !== undefined) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = isRecord(item) ? item[definition.unique_by] : undefined;
        const encoded = JSON.stringify(key);
        if (key === undefined || seen.has(encoded)) diagnostics.push(`${location} is not unique by ${definition.unique_by}`);
        seen.add(encoded);
      }
    }
  }
  if (isRecord(value) && definition.properties !== undefined) {
    for (const [field, child] of Object.entries(definition.properties)) {
      const childValue = value[field];
      if (childValue === undefined) {
        if (child.required === true) diagnostics.push(`${location}.${field} is required`);
      } else validateField(childValue, child, `${location}.${field}`, diagnostics);
    }
    if (definition.additional_properties === false) {
      for (const field of Object.keys(value)) {
        if (!(field in definition.properties)) diagnostics.push(`${location}.${field} is not allowed`);
      }
    }
  }
}

function validateAcyclic(
  nodes: ReadonlyMap<string, GraphNode>,
  definition: GraphEdgeTypeDefinition,
  diagnostics: string[],
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      diagnostics.push(`edge ${definition.source}.${definition.relation} contains a cycle at ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of nodes.get(id)?.edges[definition.relation] ?? []) {
      if (nodes.get(target)?.type === definition.source) visit(target);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes.values()) if (node.type === definition.source) visit(node.id);
}

function isSafeProjectPath(value: string): boolean {
  return value === "." || (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
