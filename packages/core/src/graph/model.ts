import type { JsonValue } from "../authority/protocol.js";
import { canonicalHash, isSha256Digest, type Sha256Digest } from "../shared/canonical.js";

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

export const GRAPH_CONTEXTUAL_STATE_PROTOCOL = "koni.graph-contextual-state.v1" as const;
export const WORKING_SPEC_PROTOCOL = "koni.working-spec.v1" as const;
export const GRAPH_CHANGE_NOTE_PROTOCOL = "koni.graph-note.v2" as const;

export interface ContextualRecordProvenance {
  runId: string;
  generation: number;
  ticketId?: string;
  stepId?: string;
  attemptId?: string;
  sessionId?: string;
  personaId: string;
  authorityGrantHash?: Sha256Digest;
  launchSpecHash?: Sha256Digest;
  authoritativeContextHash?: Sha256Digest;
  semanticRevision: number;
  semanticHash: Sha256Digest;
  /** The durable contextual state on which this append/update was based. */
  contextualRevision: number;
  contextualHash: Sha256Digest;
  lineage?: {
    branchEpoch: number;
    reason: string;
    parentAttemptId?: string;
    parentSessionId?: string;
    parentEntryId?: string;
  };
  recordedAt: string;
}

export interface WorkingSpecBaseline {
  objective: string;
  intake: Record<string, string>;
  acceptedPlan: {
    architecture: string;
    decisions: string;
    risk: string;
    verification: string;
  } | null;
  resolvedDecisions: string;
  verificationIntent: string;
  source: {
    kind: "approved_plan" | "direct_approval";
    artifactPath: string;
    artifactSha256: Sha256Digest;
    planRevision: number;
    attemptId?: string;
  };
}

export interface WorkingSpecVersionRecord {
  protocol: typeof WORKING_SPEC_PROTOCOL;
  recordType: "working_spec";
  id: string;
  runId: string;
  generation: number;
  ownerPersonaId: string;
  version: number;
  digest: Sha256Digest;
  baselineDigest: Sha256Digest;
  baseline: WorkingSpecBaseline;
  guidance: string;
  affectedNodeIds: string[];
  repositoryPaths: string[];
  supersedes?: string;
  provenance: ContextualRecordProvenance & { kind: "baseline" | "owner_update" };
}

export interface GraphChangeNoteRecord {
  protocol: typeof GRAPH_CHANGE_NOTE_PROTOCOL;
  recordType: "change_note";
  id: string;
  runId: string;
  generation: number;
  subject: {
    kind: "run_root" | "semantic_node";
    id: string;
  };
  kind: "observation" | "implementation_detail" | "rationale" | "nit" | "open_question";
  body: string;
  repositoryPaths: string[];
  targetNodeHashes: Record<string, Sha256Digest>;
  supersedes?: string;
  provenance: ContextualRecordProvenance & { kind: "change_note" };
}

export type GraphContextualRecord = WorkingSpecVersionRecord | GraphChangeNoteRecord;

export interface GraphContextualLink {
  sourceId: string;
  relation: "context_for" | "affects" | "references_path" | "supersedes";
  targetKind: "run_root" | "semantic_node" | "repository_path" | "context_record";
  targetId: string;
}

/**
 * Contextual state is embedded in the durable run-graph artifact but deliberately excluded from
 * `TypedGraph.hash`. Its own CAS epoch lets notes/specification guidance advance without making a
 * prepared semantic `GraphDelta` stale.
 */
export interface GraphContextualState {
  protocol: typeof GRAPH_CONTEXTUAL_STATE_PROTOCOL;
  revision: number;
  hash: Sha256Digest;
  runRootId: string;
  ownerPersonaId?: string;
  canonicalWorkingSpecId?: string;
  records: Record<string, GraphContextualRecord>;
  links: GraphContextualLink[];
}

export function workingSpecDigest(input: Pick<
  WorkingSpecVersionRecord,
  "baselineDigest" | "guidance" | "affectedNodeIds" | "repositoryPaths"
>): Sha256Digest {
  return canonicalHash({
    baselineDigest: input.baselineDigest,
    guidance: input.guidance,
    affectedNodeIds: [...input.affectedNodeIds],
    repositoryPaths: [...input.repositoryPaths],
  });
}

export function graphContextualStateHash(
  state: Omit<GraphContextualState, "hash">,
): Sha256Digest {
  return canonicalHash(state);
}

export function createGraphContextualState(
  runRootId: string,
  ownerPersonaId?: string,
): GraphContextualState {
  const draft: Omit<GraphContextualState, "hash"> = {
    protocol: GRAPH_CONTEXTUAL_STATE_PROTOCOL,
    revision: 0,
    runRootId,
    ...(ownerPersonaId === undefined ? {} : { ownerPersonaId }),
    records: Object.create(null) as Record<string, GraphContextualRecord>,
    links: [],
  };
  return { ...draft, hash: graphContextualStateHash(draft) };
}

export function sealGraphContextualState(
  state: Omit<GraphContextualState, "hash">,
): GraphContextualState {
  const cloned = structuredClone(state);
  const sealed = { ...cloned, hash: graphContextualStateHash(cloned) };
  validateGraphContextualState(sealed);
  return sealed;
}

export function validateGraphContextualState(state: GraphContextualState): void {
  const diagnostics: string[] = [];
  if (state.protocol !== GRAPH_CONTEXTUAL_STATE_PROTOCOL) diagnostics.push("unsupported contextual graph protocol");
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) diagnostics.push("invalid contextual revision");
  if (!isIdentifier(state.runRootId)) diagnostics.push("invalid contextual run-root identity");
  if (state.ownerPersonaId !== undefined && !isIdentifier(state.ownerPersonaId)) diagnostics.push("invalid working-spec owner");
  if (state.canonicalWorkingSpecId !== undefined && !isIdentifier(state.canonicalWorkingSpecId)) {
    diagnostics.push("invalid canonical working-spec identity");
  }
  if (graphContextualStateHash(withoutContextualHash(state)) !== state.hash) {
    diagnostics.push("contextual graph hash does not match its records");
  }
  const canonical = state.canonicalWorkingSpecId === undefined
    ? undefined
    : state.records[state.canonicalWorkingSpecId];
  if (
    state.canonicalWorkingSpecId !== undefined &&
    (canonical === undefined || canonical.recordType !== "working_spec" || canonical.ownerPersonaId !== state.ownerPersonaId)
  ) diagnostics.push("canonical working-spec identity does not name an owner-bound working specification");
  const successorCounts = new Map<string, number>();
  for (const [id, record] of Object.entries(state.records)) {
    if (record.id !== id || !isIdentifier(id) || !isIdentifier(record.runId)) {
      diagnostics.push(`invalid contextual record identity: ${id}`);
      continue;
    }
    if (!Number.isSafeInteger(record.generation) || record.generation < 0) {
      diagnostics.push(`invalid contextual record generation: ${id}`);
    }
    validateContextualProvenance(record, diagnostics);
    if (record.supersedes !== undefined) {
      if (!isIdentifier(record.supersedes) || record.supersedes === record.id) {
        diagnostics.push(`invalid contextual supersession: ${id}`);
      }
      successorCounts.set(record.supersedes, (successorCounts.get(record.supersedes) ?? 0) + 1);
    }
    if (record.recordType === "working_spec") {
      if (
        record.protocol !== WORKING_SPEC_PROTOCOL ||
        !isIdentifier(record.ownerPersonaId) ||
        !Number.isSafeInteger(record.version) ||
        record.version < 1 ||
        !isSha256Digest(record.baselineDigest) ||
        !isSha256Digest(record.digest) ||
        canonicalHash(record.baseline) !== record.baselineDigest ||
        workingSpecDigest(record) !== record.digest ||
        record.guidance.length === 0 ||
        record.guidance.includes("\u0000") ||
        new Set(record.affectedNodeIds).size !== record.affectedNodeIds.length ||
        record.affectedNodeIds.some((nodeId) => !isIdentifier(nodeId)) ||
        !validRepositoryPathList(record.repositoryPaths) ||
        !isSafeArtifactPath(record.baseline.source.artifactPath) ||
        !isSha256Digest(record.baseline.source.artifactSha256) ||
        !Number.isSafeInteger(record.baseline.source.planRevision) ||
        record.baseline.source.planRevision < 0
      ) diagnostics.push(`invalid working-spec record: ${id}`);
    } else if (
      record.protocol !== GRAPH_CHANGE_NOTE_PROTOCOL ||
      !isIdentifier(record.subject.id) ||
      (record.subject.kind !== "run_root" && record.subject.kind !== "semantic_node") ||
      record.body.length === 0 ||
      record.body.includes("\u0000") ||
      Buffer.byteLength(record.body, "utf8") > 1024 * 1024 ||
      !validRepositoryPathList(record.repositoryPaths) ||
      Object.entries(record.targetNodeHashes).some(([nodeId, hash]) => !isIdentifier(nodeId) || !isSha256Digest(hash)) ||
      (record.subject.kind === "run_root" && Object.keys(record.targetNodeHashes).length !== 0) ||
      (record.subject.kind === "semantic_node" &&
        (Object.keys(record.targetNodeHashes).length !== 1 || record.targetNodeHashes[record.subject.id] === undefined))
    ) diagnostics.push(`invalid graph-note record: ${id}`);
  }
  for (const [id, count] of successorCounts) {
    if (count > 1) diagnostics.push(`contextual record ${id} has more than one successor`);
  }
  const linkKeys = new Set<string>();
  for (const link of state.links) {
    const key = `${link.sourceId}\0${link.relation}\0${link.targetKind}\0${link.targetId}`;
    if (
      linkKeys.has(key) ||
      state.records[link.sourceId] === undefined ||
      !["context_for", "affects", "references_path", "supersedes"].includes(link.relation) ||
      !["run_root", "semantic_node", "repository_path", "context_record"].includes(link.targetKind) ||
      link.targetId.length === 0 ||
      (link.targetKind === "repository_path" && !isSafeProjectPath(link.targetId)) ||
      (link.targetKind !== "repository_path" && !isIdentifier(link.targetId))
    ) {
      diagnostics.push(`invalid or duplicate contextual link: ${link.sourceId}.${link.relation}`);
    }
    linkKeys.add(key);
  }
  if (diagnostics.length > 0) throw new GraphValidationError([...new Set(diagnostics)].sort());
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

  public repositoryPaths(node: GraphNode): string[] {
    const definition = this.nodeTypes.get(node.type);
    if (definition === undefined) return [];
    const paths = new Set<string>();
    for (const [field, fieldDefinition] of Object.entries(definition.fields)) {
      collectRepositoryPaths(node.spec[field], fieldDefinition, paths);
    }
    return [...paths].sort();
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

  public repositoryPaths(id: string): string[] {
    const node = this.#nodes.get(id);
    return node === undefined ? [] : this.#schema.repositoryPaths(node);
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

function collectRepositoryPaths(
  value: JsonValue | undefined,
  definition: GraphFieldDefinition,
  output: Set<string>,
): void {
  if (value === undefined) return;
  if (definition.type === "path" && typeof value === "string") {
    output.add(value);
    return;
  }
  if (definition.type === "list" && Array.isArray(value) && definition.items !== undefined) {
    for (const item of value) collectRepositoryPaths(item, definition.items, output);
    return;
  }
  if (definition.type === "object" && isRecord(value) && definition.properties !== undefined) {
    for (const [field, child] of Object.entries(definition.properties)) {
      collectRepositoryPaths(value[field], child, output);
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

function validateContextualProvenance(
  record: GraphContextualRecord,
  diagnostics: string[],
): void {
  const provenance = record.provenance;
  const update = record.recordType === "working_spec" && provenance.kind === "owner_update";
  const note = record.recordType === "change_note";
  if (
    provenance.runId !== record.runId ||
    provenance.generation !== record.generation ||
    !isIdentifier(provenance.personaId) ||
    !Number.isSafeInteger(provenance.semanticRevision) || provenance.semanticRevision < 0 ||
    !isSha256Digest(provenance.semanticHash) ||
    !Number.isSafeInteger(provenance.contextualRevision) || provenance.contextualRevision < 0 ||
    !isSha256Digest(provenance.contextualHash) ||
    !Number.isFinite(Date.parse(provenance.recordedAt)) ||
    ((update || note) && (
      provenance.ticketId === undefined || !isIdentifier(provenance.ticketId) ||
      provenance.stepId === undefined || !isIdentifier(provenance.stepId) ||
      provenance.attemptId === undefined || !isIdentifier(provenance.attemptId) ||
      provenance.sessionId === undefined || !isIdentifier(provenance.sessionId) ||
      !isSha256Digest(provenance.authorityGrantHash) ||
      !isSha256Digest(provenance.launchSpecHash) ||
      !isSha256Digest(provenance.authoritativeContextHash) ||
      provenance.lineage === undefined ||
      !Number.isSafeInteger(provenance.lineage.branchEpoch) || provenance.lineage.branchEpoch < 0
    ))
  ) diagnostics.push(`invalid contextual provenance: ${record.id}`);
}

function validRepositoryPathList(values: readonly string[]): boolean {
  return new Set(values).size === values.length && values.every(isSafeProjectPath);
}

function isSafeArtifactPath(value: string): boolean {
  return value.length > 0 && value !== "." && isSafeProjectPath(value);
}

function withoutContextualHash(state: GraphContextualState): Omit<GraphContextualState, "hash"> {
  const { hash: _hash, ...material } = state;
  return material;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
