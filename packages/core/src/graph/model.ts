import type { JsonValue } from "../authority/protocol.js";
import type { ConfigurationObject, ConfigurationValue } from "../contracts/configuration.js";
import { canonicalHash, isSha256Digest, type Sha256Digest } from "../shared/canonical.js";
import { satisfies, valid, validRange } from "semver";
import {
  ProjectPathAuthorityError,
  createProjectPathAuthority,
  normalizeProjectRelativePath,
  type ProjectPathAuthority,
} from "../shared/project-path-authority.js";

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
    "string" | "boolean" | "number" | "integer" | "list" | "object" | "path" | "node_ref" | "json";
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

export type GraphCompilerFieldSource =
  "run.id" | "run.objective" | "run.run_type_id" | "run.git.target.ref";

export interface GraphNodeTypeDefinition {
  id: string;
  description: string;
  stage?: string;
  /** Profile-authored ontology guidance exposed with model-facing graph context. */
  annotations?: Record<string, JsonValue>;
  statuses: string[];
  initial_status: string;
  /** Exact authored paths that participate in semantic receipt identity. Empty means the full node. */
  semantic_fields?: string[];
  compiler_owned_fields?: string[];
  agent_visible_compiler_owned_fields?: string[];
  /** Deterministic run metadata materialized by the compiler when a node is first admitted. */
  compiler_field_sources?: Record<string, GraphCompilerFieldSource>;
  /** Must agree exactly with the required-subject union of configured gate policies. */
  gate_required?: boolean;
  required_any?: string[][];
  fields: Record<string, GraphFieldDefinition>;
}

export interface GraphGateCapabilityContract {
  readonly policy_id: string;
  readonly gate_node_types: readonly string[];
  readonly candidate_node_types: readonly string[];
  readonly required_name_fields: readonly string[];
  readonly required_version_req_fields: readonly string[];
  readonly provider_collection_fields: readonly string[];
  readonly provider_name_fields: readonly string[];
  readonly provider_version_fields: readonly string[];
  readonly contract_sha256: Sha256Digest;
}

/** Finite edge predicate IR. Unsupported profile predicates are rejected before this layer. */
export interface GraphEdgeGateCompatibilityPredicate {
  readonly op: "gate_policy_compatible";
  readonly gate_policy: string;
  readonly subject: "$source";
  readonly gate_subject: "$target";
  readonly capability: GraphGateCapabilityContract;
}

export type GraphEdgePredicateDefinition = GraphEdgeGateCompatibilityPredicate;

export interface GraphEdgeTypeDefinition {
  source: string;
  relation: string;
  targets: string[];
  inverse?: string;
  bidirectional?: boolean;
  min?: number;
  max?: number;
  acyclic?: boolean;
  when?: GraphEdgePredicateDefinition;
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

export interface TypedGraphValidationOptions {
  /** Required when a configured path collection compares physical project authority. */
  projectRoot?: string;
}

export const GRAPH_CONTEXTUAL_STATE_PROTOCOL = "koni.graph-contextual-state.v1" as const;
export const WORKING_SPEC_PROTOCOL = "koni.working-spec.v1" as const;
export const GRAPH_CHANGE_NOTE_PROTOCOL = "koni.graph-note.v2" as const;

const MAX_OWNER_WORKING_SPEC_BYTES = 1024 * 1024;
const MAX_BASELINE_WORKING_SPEC_BYTES = 8 * 1024 * 1024;
const MAX_GRAPH_NOTE_BYTES = 1024 * 1024;

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
  intake: ConfigurationObject;
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

export function workingSpecDigest(
  input: Pick<
    WorkingSpecVersionRecord,
    "baselineDigest" | "guidance" | "affectedNodeIds" | "repositoryPaths"
  >,
): Sha256Digest {
  return canonicalHash({
    baselineDigest: input.baselineDigest,
    guidance: input.guidance,
    affectedNodeIds: [...input.affectedNodeIds],
    repositoryPaths: [...input.repositoryPaths],
  });
}

export function graphContextualStateHash(state: Omit<GraphContextualState, "hash">): Sha256Digest {
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
  if (state.protocol !== GRAPH_CONTEXTUAL_STATE_PROTOCOL)
    diagnostics.push("unsupported contextual graph protocol");
  if (!Number.isSafeInteger(state.revision) || state.revision < 0)
    diagnostics.push("invalid contextual revision");
  if (!isIdentifier(state.runRootId)) diagnostics.push("invalid contextual run-root identity");
  if (state.ownerPersonaId !== undefined && !isIdentifier(state.ownerPersonaId))
    diagnostics.push("invalid working-spec owner");
  if (state.canonicalWorkingSpecId !== undefined && !isIdentifier(state.canonicalWorkingSpecId)) {
    diagnostics.push("invalid canonical working-spec identity");
  }
  if (graphContextualStateHash(withoutContextualHash(state)) !== state.hash) {
    diagnostics.push("contextual graph hash does not match its records");
  }
  const canonical =
    state.canonicalWorkingSpecId === undefined
      ? undefined
      : state.records[state.canonicalWorkingSpecId];
  if (
    state.canonicalWorkingSpecId !== undefined &&
    (canonical === undefined ||
      canonical.recordType !== "working_spec" ||
      canonical.ownerPersonaId !== state.ownerPersonaId)
  )
    diagnostics.push(
      "canonical working-spec identity does not name an owner-bound working specification",
    );
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
        Buffer.byteLength(record.guidance, "utf8") >
          (record.provenance.kind === "baseline"
            ? MAX_BASELINE_WORKING_SPEC_BYTES
            : MAX_OWNER_WORKING_SPEC_BYTES) ||
        !validWorkingSpecBaseline(record.baseline) ||
        new Set(record.affectedNodeIds).size !== record.affectedNodeIds.length ||
        record.affectedNodeIds.some((nodeId) => !isIdentifier(nodeId)) ||
        !validRepositoryPathList(record.repositoryPaths) ||
        !isSafeArtifactPath(record.baseline.source.artifactPath) ||
        !isSha256Digest(record.baseline.source.artifactSha256) ||
        !Number.isSafeInteger(record.baseline.source.planRevision) ||
        record.baseline.source.planRevision < 0
      )
        diagnostics.push(`invalid working-spec record: ${id}`);
    } else if (
      record.protocol !== GRAPH_CHANGE_NOTE_PROTOCOL ||
      !isIdentifier(record.subject.id) ||
      (record.subject.kind !== "run_root" && record.subject.kind !== "semantic_node") ||
      record.body.length === 0 ||
      record.body.includes("\u0000") ||
      Buffer.byteLength(record.body, "utf8") > MAX_GRAPH_NOTE_BYTES ||
      !validRepositoryPathList(record.repositoryPaths) ||
      Object.entries(record.targetNodeHashes).some(
        ([nodeId, hash]) => !isIdentifier(nodeId) || !isSha256Digest(hash),
      ) ||
      (record.subject.kind === "run_root" && Object.keys(record.targetNodeHashes).length !== 0) ||
      (record.subject.kind === "semantic_node" &&
        (Object.keys(record.targetNodeHashes).length !== 1 ||
          record.targetNodeHashes[record.subject.id] === undefined))
    )
      diagnostics.push(`invalid graph-note record: ${id}`);
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
      !["run_root", "semantic_node", "repository_path", "context_record"].includes(
        link.targetKind,
      ) ||
      link.targetId.length === 0 ||
      (link.targetKind === "repository_path" && !isSafeProjectPath(link.targetId)) ||
      (link.targetKind !== "repository_path" && !isIdentifier(link.targetId))
    ) {
      diagnostics.push(`invalid or duplicate contextual link: ${link.sourceId}.${link.relation}`);
    }
    linkKeys.add(key);
  }
  validateContextualRelationships(state, diagnostics);
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
      validateUniqueContractPaths(
        nodeType,
        "semantic_fields",
        nodeType.semantic_fields ?? [],
        diagnostics,
      );
      validateUniqueContractPaths(
        nodeType,
        "compiler_owned_fields",
        nodeType.compiler_owned_fields ?? [],
        diagnostics,
      );
      validateUniqueContractPaths(
        nodeType,
        "agent_visible_compiler_owned_fields",
        nodeType.agent_visible_compiler_owned_fields ?? [],
        diagnostics,
      );
      const semantic = new Set(nodeType.semantic_fields ?? []);
      const compilerOwned = new Set(nodeType.compiler_owned_fields ?? []);
      const overlap = [...semantic].filter((field) => compilerOwned.has(field)).sort();
      if (overlap.length > 0) {
        diagnostics.push(
          `node type ${nodeType.id} fields cannot be both semantic and compiler-owned: ${overlap.join(", ")}`,
        );
      }
      for (const visible of nodeType.agent_visible_compiler_owned_fields ?? []) {
        if (!compilerOwned.has(visible)) {
          diagnostics.push(`node type ${nodeType.id} exposes non-compiler-owned field ${visible}`);
        }
      }
      for (const [field, source] of Object.entries(nodeType.compiler_field_sources ?? {})) {
        if (!compilerOwned.has(field)) {
          diagnostics.push(`node type ${nodeType.id} binds non-compiler-owned field ${field}`);
        }
        if (
          !new Set<GraphCompilerFieldSource>([
            "run.id",
            "run.objective",
            "run.run_type_id",
            "run.git.target.ref",
          ]).has(source)
        ) {
          diagnostics.push(
            `node type ${nodeType.id} uses unsupported compiler field source ${source}`,
          );
        }
      }
      for (const [field, definition] of Object.entries(nodeType.fields)) {
        validateFieldDefinition(nodeType, definition, `spec.${field}`, diagnostics);
      }
      for (const group of nodeType.required_any ?? []) {
        if (group.length === 0)
          diagnostics.push(`node type ${nodeType.id} has an empty required_any group`);
        for (const field of group) {
          const root = field.replace(/^spec\./u, "").split(".")[0] ?? "";
          if (
            !isContractFieldPath(field) ||
            (Object.keys(nodeType.fields).length > 0 &&
              !Object.hasOwn(nodeType.fields, root) &&
              !(nodeType.semantic_fields ?? []).includes(root))
          )
            diagnostics.push(
              `node type ${nodeType.id} required_any references undeclared field ${field}`,
            );
        }
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
      if (
        edge.bidirectional === true &&
        (edge.inverse === undefined || !isIdentifier(edge.inverse))
      ) {
        diagnostics.push(
          `bidirectional edge ${edge.source}.${edge.relation} requires an inverse name`,
        );
      }
      if ((edge.min ?? 0) < 0 || (edge.max !== undefined && edge.max < (edge.min ?? 0))) {
        diagnostics.push(`edge ${edge.source}.${edge.relation} has invalid cardinality`);
      }
      if (edge.when !== undefined) validateEdgePredicate(edge, diagnostics);
    }
    if (diagnostics.length > 0) {
      throw new GraphValidationError(diagnostics.sort());
    }
    this.nodeTypes = nodeTypes;
    this.edgeTypes = definition.edgeTypes.map((edge) => structuredClone(edge));
  }

  public get hash(): Sha256Digest {
    return canonicalHash({
      nodeTypes: [...this.nodeTypes.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      edgeTypes: [...this.edgeTypes].sort(
        (left, right) =>
          left.source.localeCompare(right.source) || left.relation.localeCompare(right.relation),
      ),
    });
  }

  public nodeTypeContract(nodeType: string): GraphNodeTypeDefinition | undefined {
    const definition = this.nodeTypes.get(nodeType);
    return definition === undefined ? undefined : structuredClone(definition);
  }

  /** Semantic receipt projection: select semantic paths, then subtract compiler-owned paths. */
  public semanticProjection(node: GraphNode): JsonValue {
    const definition = this.nodeTypes.get(node.type);
    if (definition === undefined) return {};
    const source = structuredClone(node) as unknown as Record<string, JsonValue>;
    const projection: Record<string, JsonValue> =
      (definition.semantic_fields ?? []).length === 0 ? structuredClone(source) : {};
    for (const field of definition.semantic_fields ?? []) {
      const value = valueAtDottedPath(source, field);
      if (value !== undefined) setValueAtDottedPath(projection, field, structuredClone(value));
    }
    for (const field of definition.compiler_owned_fields ?? [])
      removeValueAtDottedPath(projection, field);
    return projection;
  }

  public semanticHash(node: GraphNode): Sha256Digest {
    return canonicalHash(this.semanticProjection(node));
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

  public resolveEdge(
    sourceType: string,
    relation: string,
    targetType: string,
  ): {
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
  readonly #validationOptions: TypedGraphValidationOptions;

  public constructor(
    schema: GraphSchema,
    nodes: readonly GraphNode[] = [],
    validationOptions: TypedGraphValidationOptions = {},
  ) {
    this.#schema = schema;
    this.#nodes = new Map(nodes.map((node) => [node.id, structuredClone(node)]));
    this.#validationOptions = { ...validationOptions };
    this.validate();
  }

  public get hash(): Sha256Digest {
    return canonicalHash(this.toJSON());
  }

  public get schemaHash(): Sha256Digest {
    return this.#schema.hash;
  }

  public nodeTypeContract(nodeType: string): GraphNodeTypeDefinition | undefined {
    return this.#schema.nodeTypeContract(nodeType);
  }

  public semanticProjection(id: string): JsonValue | undefined {
    const node = this.#nodes.get(id);
    return node === undefined ? undefined : this.#schema.semanticProjection(node);
  }

  public semanticHash(id: string): Sha256Digest | undefined {
    const node = this.#nodes.get(id);
    return node === undefined ? undefined : this.#schema.semanticHash(node);
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
      if (
        definition.source === node.type &&
        (relation === undefined || relation === definition.relation)
      ) {
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
          )
            ids.add(candidate.id);
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

  /**
   * Apply an agent-authored delta, rebasing it onto the current graph when it was authored against
   * an older whole-graph hash. Every per-node `expectedNodeHash` check in `apply` still runs, so a
   * genuine conflict (a node the delta adds/modifies/deletes changed underneath it) still throws.
   * Only the coarse whole-graph-hash equality is relaxed. This is safe because the scheduler forbids
   * a concurrent ticket from writing any node in this delta's read/write scope
   * (`assignmentScopesConflict` checks write/write, write/read, and read/write), so a moved
   * whole-graph hash during a worker's flight reflects only disjoint sibling work on untouched nodes.
   */
  public applyRebased(delta: GraphDelta): AppliedGraphDelta {
    return this.apply(
      delta.expectedGraphHash === this.hash ? delta : { ...delta, expectedGraphHash: this.hash },
    );
  }

  public apply(delta: GraphDelta): AppliedGraphDelta {
    if (delta.protocol !== "koni.graph-delta.v1" || delta.expectedGraphHash !== this.hash) {
      throw new GraphValidationError(["graph delta expected hash is stale or unsupported"]);
    }
    const graph = new TypedGraph(this.#schema, this.nodes(), this.#validationOptions);
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
      changes.push({
        kind: "deleted",
        nodeId: existing.id,
        nodeType: existing.type,
        title: existing.title,
      });
    }
    for (const edge of delta.removeEdges) graph.#mutateEdge(edge, false);
    for (const edge of delta.addEdges) graph.#mutateEdge(edge, true);
    graph.validate();
    return { graph, hash: graph.hash, changes };
  }

  public validate(): void {
    const diagnostics: string[] = [];
    const pathAuthority =
      this.#validationOptions.projectRoot === undefined
        ? undefined
        : createProjectPathAuthority(this.#validationOptions.projectRoot);
    for (const node of this.#nodes.values()) {
      validateNode(node, this.#schema, this.#validationOptions, pathAuthority, diagnostics);
    }
    for (const definition of this.#schema.edgeTypes) {
      for (const node of this.#nodes.values()) {
        if (node.type !== definition.source) continue;
        const targets = node.edges[definition.relation] ?? [];
        if (targets.length < (definition.min ?? 0)) {
          diagnostics.push(
            `${node.id}.${definition.relation} has fewer than ${definition.min} targets`,
          );
        }
        if (definition.max !== undefined && targets.length > definition.max) {
          diagnostics.push(
            `${node.id}.${definition.relation} has more than ${definition.max} targets`,
          );
        }
        for (const targetId of targets) {
          const target = this.#nodes.get(targetId);
          if (target === undefined)
            diagnostics.push(`${node.id}.${definition.relation} targets missing node ${targetId}`);
          else if (!definition.targets.includes(target.type)) {
            diagnostics.push(`${node.id}.${definition.relation} cannot target ${target.type}`);
          } else if (definition.when !== undefined) {
            const failure = edgePredicateFailure(definition.when, node, target);
            if (failure !== undefined) {
              diagnostics.push(
                `${node.id}.${definition.relation} -> ${target.id} violates configured edge predicate: ${failure}`,
              );
            }
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
      throw new GraphValidationError([
        `edge references a missing node: ${edge.source} -> ${edge.target}`,
      ]);
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

function validateNode(
  node: GraphNode,
  schema: GraphSchema,
  options: TypedGraphValidationOptions,
  pathAuthority: ProjectPathAuthority | undefined,
  diagnostics: string[],
): void {
  const definition = schema.nodeTypes.get(node.type);
  if (!isIdentifier(node.id) || definition === undefined) {
    diagnostics.push(`node ${node.id} has an invalid identity or unknown type ${node.type}`);
    return;
  }
  if (node.schema_version !== "1.0" || node.title.trim().length === 0) {
    diagnostics.push(`node ${node.id} has an invalid schema version or empty title`);
  }
  if (!definition.statuses.includes(node.status))
    diagnostics.push(`node ${node.id} has invalid status ${node.status}`);
  for (const [field, fieldDefinition] of Object.entries(definition.fields)) {
    const value = node.spec[field];
    if (value === undefined) {
      if (fieldDefinition.required === true)
        diagnostics.push(`node ${node.id} is missing spec.${field}`);
    } else {
      validateField(
        value,
        fieldDefinition,
        `node ${node.id} spec.${field}`,
        `spec.${field}`,
        node,
        options,
        pathAuthority,
        diagnostics,
      );
    }
  }
  if (Object.keys(definition.fields).length > 0) {
    for (const field of Object.keys(node.spec)) {
      if (!(field in definition.fields))
        diagnostics.push(`node ${node.id} has unknown spec field ${field}`);
    }
  }
  for (const group of definition.required_any ?? []) {
    if (
      !group.some((field) => {
        const direct = valueAtDottedPath(node as unknown as Record<string, JsonValue>, field);
        const fallback = valueAtDottedPath(
          node as unknown as Record<string, JsonValue>,
          `spec.${field.replace(/^spec\./u, "")}`,
        );
        return !configurationValueIsEmpty(direct ?? fallback);
      })
    ) {
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
  fieldPath: string,
  rootNode: GraphNode,
  options: TypedGraphValidationOptions,
  pathAuthority: ProjectPathAuthority | undefined,
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
  if (
    definition.enum !== undefined &&
    !definition.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
  ) {
    diagnostics.push(`${location} is not one of its declared values`);
  }
  if (definition.pattern !== undefined && typeof value === "string") {
    try {
      if (!new RegExp(definition.pattern, "u").test(value))
        diagnostics.push(`${location} does not match its pattern`);
    } catch {
      diagnostics.push(`${location} has an invalid configured pattern`);
    }
  }
  if (Array.isArray(value)) {
    if (definition.items !== undefined) {
      value.forEach((item, index) =>
        validateField(
          item,
          definition.items!,
          `${location}[${index}]`,
          `${fieldPath}[]`,
          rootNode,
          options,
          pathAuthority,
          diagnostics,
        ),
      );
    }
    if (definition.unique_by !== undefined) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = isRecord(item) ? item[definition.unique_by] : undefined;
        const encoded = JSON.stringify(key);
        if (key === undefined || seen.has(encoded))
          diagnostics.push(`${location} is not unique by ${definition.unique_by}`);
        seen.add(encoded);
      }
    }
  }
  if (isRecord(value) && definition.properties !== undefined) {
    for (const [field, child] of Object.entries(definition.properties)) {
      const childValue = value[field];
      if (childValue === undefined) {
        if (child.required === true) diagnostics.push(`${location}.${field} is required`);
      } else
        validateField(
          childValue,
          child,
          `${location}.${field}`,
          `${fieldPath}.${field}`,
          rootNode,
          options,
          pathAuthority,
          diagnostics,
        );
    }
    if (definition.additional_properties === false) {
      for (const field of Object.keys(value)) {
        if (!(field in definition.properties))
          diagnostics.push(`${location}.${field} is not allowed`);
      }
    }
  }
  validateFieldSubset(value, definition, location, fieldPath, rootNode, diagnostics);
  validateFieldDisjoint(
    value,
    definition,
    location,
    fieldPath,
    rootNode,
    options,
    pathAuthority,
    diagnostics,
  );
}

function validateFieldDefinition(
  nodeType: GraphNodeTypeDefinition,
  definition: GraphFieldDefinition,
  fieldPath: string,
  diagnostics: string[],
): void {
  if (definition.items !== undefined && definition.type !== "list") {
    diagnostics.push(
      `node type ${nodeType.id} field ${fieldPath} configures items but is not a list`,
    );
  }
  if (
    (definition.properties !== undefined || definition.additional_properties !== undefined) &&
    definition.type !== "object"
  ) {
    diagnostics.push(
      `node type ${nodeType.id} field ${fieldPath} configures object properties but is not an object`,
    );
  }
  if (definition.pattern !== undefined) {
    if (!new Set(["string", "path", "node_ref"]).has(definition.type)) {
      diagnostics.push(
        `node type ${nodeType.id} field ${fieldPath} configures a string pattern for non-string type ${definition.type}`,
      );
    } else {
      try {
        new RegExp(definition.pattern, "u");
      } catch {
        diagnostics.push(
          `node type ${nodeType.id} field ${fieldPath} has an invalid configured pattern`,
        );
      }
    }
  }
  for (const [name, child] of Object.entries(definition.properties ?? {})) {
    if (!isContractPathSegment(name)) {
      diagnostics.push(
        `node type ${nodeType.id} field ${fieldPath} has invalid property name ${JSON.stringify(name)}`,
      );
    }
    validateFieldDefinition(nodeType, child, `${fieldPath}.${name}`, diagnostics);
  }
  if (definition.items !== undefined) {
    validateFieldDefinition(nodeType, definition.items, `${fieldPath}[]`, diagnostics);
  }
  for (const [keyword, reference] of [
    ["subset_of", definition.subset_of],
    ["disjoint_from", definition.disjoint_from],
  ] as const) {
    if (reference === undefined) continue;
    if (!isContractFieldPath(reference)) {
      diagnostics.push(
        `node type ${nodeType.id} field ${fieldPath} has invalid ${keyword} reference ${JSON.stringify(reference)}`,
      );
      continue;
    }
    const sourceItemType = constrainedCollectionItemType(definition);
    if (sourceItemType === undefined) {
      diagnostics.push(
        `node type ${nodeType.id} field ${fieldPath} configures ${keyword} but must be a list with string or path items`,
      );
      continue;
    }
    const target = nodeFieldDefinition(nodeType, reference);
    if (target === undefined) {
      diagnostics.push(
        `node type ${nodeType.id} field ${fieldPath} ${keyword} references undeclared root-node field ${reference}`,
      );
      continue;
    }
    const targetItemType = constrainedCollectionItemType(target);
    if (targetItemType === undefined) {
      diagnostics.push(
        `node type ${nodeType.id} field ${fieldPath} ${keyword} reference ${reference} must be a list with string or path items`,
      );
    } else if (targetItemType !== sourceItemType) {
      diagnostics.push(
        `node type ${nodeType.id} field ${fieldPath} ${keyword} reference ${reference} has incompatible item type ${targetItemType}; expected ${sourceItemType}`,
      );
    }
  }
  if (definition.unique_by !== undefined) {
    const property = definition.unique_by;
    if (!isContractPathSegment(property)) {
      diagnostics.push(
        `node type ${nodeType.id} field ${fieldPath} unique_by property ${JSON.stringify(property)} must name one direct list-item property`,
      );
    }
    const items =
      definition.type === "list" && definition.items?.type === "object"
        ? definition.items
        : undefined;
    if (items === undefined) {
      diagnostics.push(
        `node type ${nodeType.id} field ${fieldPath} configures unique_by but must be a list with object items`,
      );
    } else {
      const identity = items.properties?.[property];
      if (identity === undefined) {
        diagnostics.push(
          `node type ${nodeType.id} field ${fieldPath} unique_by references undeclared list-item property ${property}`,
        );
      } else if (identity.required !== true) {
        diagnostics.push(
          `node type ${nodeType.id} field ${fieldPath} unique_by property ${property} must be required`,
        );
      } else if (
        !new Set(["string", "integer", "number", "boolean", "path", "node_ref"]).has(identity.type)
      ) {
        diagnostics.push(
          `node type ${nodeType.id} field ${fieldPath} unique_by property ${property} must be scalar`,
        );
      }
    }
  }
}

function validateUniqueContractPaths(
  nodeType: GraphNodeTypeDefinition,
  label: string,
  values: readonly string[],
  diagnostics: string[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!isContractFieldPath(value) || value.trim() !== value || seen.has(value)) {
      diagnostics.push(
        `node type ${nodeType.id} ${label} must contain unique, trimmed dotted paths`,
      );
    }
    seen.add(value);
  }
}

function validateEdgePredicate(edge: GraphEdgeTypeDefinition, diagnostics: string[]): void {
  const predicate = edge.when!;
  if (
    predicate.op !== "gate_policy_compatible" ||
    predicate.subject !== "$source" ||
    predicate.gate_subject !== "$target" ||
    predicate.gate_policy !== predicate.capability.policy_id
  ) {
    diagnostics.push(
      `edge ${edge.source}.${edge.relation} has an invalid gate compatibility predicate`,
    );
    return;
  }
  const capability = predicate.capability;
  const { contract_sha256: configuredHash, ...material } = capability;
  if (!isSha256Digest(configuredHash) || configuredHash !== canonicalHash(material)) {
    diagnostics.push(
      `edge ${edge.source}.${edge.relation} gate capability contract hash is invalid`,
    );
  }
  if (!capability.candidate_node_types.includes(edge.source)) {
    diagnostics.push(
      `edge ${edge.source}.${edge.relation} source is outside gate-policy candidates`,
    );
  }
  if (edge.targets.some((target) => !capability.gate_node_types.includes(target))) {
    diagnostics.push(
      `edge ${edge.source}.${edge.relation} target is outside gate-policy gate types`,
    );
  }
  for (const [label, values] of Object.entries({
    gate_node_types: capability.gate_node_types,
    candidate_node_types: capability.candidate_node_types,
    required_name_fields: capability.required_name_fields,
    required_version_req_fields: capability.required_version_req_fields,
    provider_collection_fields: capability.provider_collection_fields,
    provider_name_fields: capability.provider_name_fields,
    provider_version_fields: capability.provider_version_fields,
  })) {
    if (
      values.length === 0 ||
      new Set(values).size !== values.length ||
      values.some((value) => value.trim() !== value || value.length === 0)
    )
      diagnostics.push(
        `edge ${edge.source}.${edge.relation} capability ${label} must be nonempty, unique, trimmed strings`,
      );
  }
}

/**
 * Return why this capability edge is rejected, in terms the author can act on.
 *
 * "violates configured edge predicate" alone does not say which field is missing, so an agent
 * that adds a `validates` link without the matching capability contract re-submits the same
 * invalid edge every recovery cycle (observed live: five compensated attempts on one step).
 */
function edgePredicateFailure(
  predicate: GraphEdgePredicateDefinition,
  source: GraphNode,
  target: GraphNode,
): string | undefined {
  const capability = predicate.capability;
  if (!capability.candidate_node_types.includes(source.type)) {
    return `${source.type} is not a candidate node type for gate policy ${predicate.gate_policy} (expected ${capability.candidate_node_types.join(", ")})`;
  }
  if (!capability.gate_node_types.includes(target.type)) {
    return `${target.type} is not a gate node type for gate policy ${predicate.gate_policy} (expected ${capability.gate_node_types.join(", ")})`;
  }
  const requiredName = firstStringAtNodePaths(target, capability.required_name_fields);
  const requiredVersion = firstStringAtNodePaths(target, capability.required_version_req_fields);
  if (requiredName === undefined) {
    return `${target.id} declares no required capability name at ${capability.required_name_fields.join(" or ")}`;
  }
  if (requiredVersion === undefined) {
    return `${target.id} declares no required capability version range at ${capability.required_version_req_fields.join(" or ")}`;
  }
  if (validRange(requiredVersion) === null) {
    return `${target.id} required capability version range ${requiredVersion} is not a valid semantic-version range`;
  }
  if (!edgeCapabilityProvided(capability, source, requiredName, requiredVersion)) {
    return `${source.id} provides no capability named ${requiredName} satisfying ${requiredVersion} at ${capability.provider_collection_fields.join(" or ")}; add that capability entry (and the matching per-gate contract) before linking it to ${target.id}`;
  }
  return undefined;
}

function edgeCapabilityProvided(
  capability: GraphEdgePredicateDefinition["capability"],
  source: GraphNode,
  requiredName: string,
  requiredVersion: string,
): boolean {
  for (const field of capability.provider_collection_fields) {
    const collection = valueAtDottedPath(source as unknown as Record<string, JsonValue>, field);
    if (!Array.isArray(collection)) continue;
    for (const candidate of collection) {
      if (!isRecord(candidate)) continue;
      const name = firstStringAtObjectPaths(candidate, capability.provider_name_fields);
      const version = firstStringAtObjectPaths(candidate, capability.provider_version_fields);
      if (
        name === requiredName &&
        version !== undefined &&
        valid(version) !== null &&
        satisfies(version, requiredVersion)
      )
        return true;
    }
  }
  return false;
}

function firstStringAtNodePaths(node: GraphNode, paths: readonly string[]): string | undefined {
  const root = node as unknown as Record<string, JsonValue>;
  for (const path of paths) {
    const value = valueAtDottedPath(root, path);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstStringAtObjectPaths(
  root: Record<string, JsonValue>,
  paths: readonly string[],
): string | undefined {
  for (const path of paths) {
    const value = valueAtDottedPath(root, path.replace(/^spec\./u, ""));
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function valueAtDottedPath(
  root: Record<string, JsonValue>,
  configuredPath: string,
): JsonValue | undefined {
  let current: JsonValue = root;
  for (const segment of configuredPath.replace(/^\$?\./u, "").split(".")) {
    if (!isRecord(current) || current[segment] === undefined) return undefined;
    current = current[segment]!;
  }
  return current;
}

function setValueAtDottedPath(
  root: Record<string, JsonValue>,
  configuredPath: string,
  value: JsonValue,
): void {
  const segments = configuredPath.replace(/^\$?\./u, "").split(".");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (!isRecord(child)) current[segment] = {};
    current = current[segment] as Record<string, JsonValue>;
  }
  current[segments.at(-1)!] = value;
}

function removeValueAtDottedPath(root: Record<string, JsonValue>, configuredPath: string): void {
  const segments = configuredPath.replace(/^\$?\./u, "").split(".");
  let current: Record<string, JsonValue> | undefined = root;
  for (const segment of segments.slice(0, -1)) {
    const child: JsonValue | undefined = current[segment];
    current = isRecord(child) ? child : undefined;
    if (current === undefined) return;
  }
  delete current[segments.at(-1)!];
}

function configurationValueIsEmpty(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function validateFieldSubset(
  value: JsonValue,
  definition: GraphFieldDefinition,
  location: string,
  fieldPath: string,
  rootNode: GraphNode,
  diagnostics: string[],
): void {
  const reference = definition.subset_of;
  if (reference === undefined || !Array.isArray(value)) return;
  const itemType = constrainedCollectionItemType(definition);
  if (itemType === undefined) {
    diagnostics.push(`${location} has an invalid configured subset_of constraint`);
    return;
  }
  const referenceValue = rootNodeFieldValue(rootNode, reference);
  if (!Array.isArray(referenceValue)) {
    diagnostics.push(`${location} subset_of reference ${reference} is missing or is not a list`);
    return;
  }
  const allowed = new Set<string>();
  for (const [index, candidate] of referenceValue.entries()) {
    const normalized = normalizedCollectionScalar(itemType, candidate);
    if (normalized === undefined) {
      diagnostics.push(
        `${location} subset_of reference ${reference}[${index}] cannot be normalized as ${itemType}`,
      );
      return;
    }
    allowed.add(normalized);
  }
  const missing = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const normalized = normalizedCollectionScalar(itemType, candidate);
    if (normalized === undefined) {
      diagnostics.push(
        `${location}[${index}] cannot be normalized as ${itemType} for subset_of ${reference}`,
      );
    } else if (!allowed.has(normalized)) {
      missing.add(normalized);
    }
  }
  if (missing.size === 0) return;
  const diagnosis =
    itemType === "path"
      ? `missing normalized paths ${JSON.stringify([...missing].sort().slice(0, 8))}${missing.size > 8 ? " (additional values omitted)" : ""}`
      : `${missing.size} value(s) are not present`;
  diagnostics.push(
    `${location} (${fieldPath}) must be a subset of root field ${reference}; ${diagnosis}`,
  );
}

function validateFieldDisjoint(
  value: JsonValue,
  definition: GraphFieldDefinition,
  location: string,
  fieldPath: string,
  rootNode: GraphNode,
  options: TypedGraphValidationOptions,
  pathAuthority: ProjectPathAuthority | undefined,
  diagnostics: string[],
): void {
  const reference = definition.disjoint_from;
  if (reference === undefined || !Array.isArray(value)) return;
  const itemType = constrainedCollectionItemType(definition);
  if (itemType === undefined) {
    diagnostics.push(`${location} has an invalid configured disjoint_from constraint`);
    return;
  }
  const referenceValue = rootNodeFieldValue(rootNode, reference);
  if (!Array.isArray(referenceValue)) {
    diagnostics.push(
      `${location} disjoint_from reference ${reference} is missing or is not a list`,
    );
    return;
  }
  const other = referenceValue.map((candidate, index) => {
    const normalized = normalizedCollectionScalar(itemType, candidate);
    if (normalized === undefined) {
      diagnostics.push(
        `${location} disjoint_from reference ${reference}[${index}] cannot be normalized as ${itemType}`,
      );
    }
    return normalized;
  });
  if (other.some((candidate) => candidate === undefined)) return;
  const overlapping = new Set<string>();
  for (const [index, candidateValue] of value.entries()) {
    const candidate = normalizedCollectionScalar(itemType, candidateValue);
    if (candidate === undefined) {
      diagnostics.push(
        `${location}[${index}] cannot be normalized as ${itemType} for disjoint_from ${reference}`,
      );
      continue;
    }
    try {
      const conflicts =
        itemType === "string"
          ? other.includes(candidate)
          : options.projectRoot === undefined
            ? (() => {
                throw new ProjectPathAuthorityError("project_root", "project root is unavailable");
              })()
            : other.some((otherPath) => pathAuthority!.pathsOverlap(candidate, otherPath!));
      if (conflicts) overlapping.add(candidate);
    } catch {
      diagnostics.push(`${location} could not safely compare its disjoint_from path authority`);
      return;
    }
  }
  if (overlapping.size === 0) return;
  const diagnosis =
    itemType === "path"
      ? `overlapping normalized paths ${JSON.stringify([...overlapping].sort().slice(0, 8))}${overlapping.size > 8 ? " (additional values omitted)" : ""}`
      : `${overlapping.size} value(s) overlap`;
  diagnostics.push(
    `${location} (${fieldPath}) must be disjoint from root field ${reference}; ${diagnosis}`,
  );
}

function constrainedCollectionItemType(
  definition: GraphFieldDefinition,
): "string" | "path" | undefined {
  if (definition.type !== "list") return undefined;
  return definition.items?.type === "string" || definition.items?.type === "path"
    ? definition.items.type
    : undefined;
}

function normalizedCollectionScalar(
  itemType: "string" | "path",
  value: JsonValue,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (itemType === "string") return value;
  try {
    return normalizeProjectRelativePath(value);
  } catch {
    return undefined;
  }
}

function rootNodeFieldValue(node: GraphNode, reference: string): JsonValue | undefined {
  const normalized = reference.replace(/^\$\./u, "").replace(/^spec\./u, "");
  let value: JsonValue | undefined = node.spec;
  for (const segment of normalized.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function nodeFieldDefinition(
  nodeType: GraphNodeTypeDefinition,
  reference: string,
): GraphFieldDefinition | undefined {
  const normalized = reference.replace(/^\$\./u, "").replace(/^spec\./u, "");
  const [root, ...children] = normalized.split(".");
  let definition: GraphFieldDefinition | undefined = nodeType.fields[root!];
  for (const child of children) definition = definition?.properties?.[child];
  return definition;
}

function isContractFieldPath(value: string): boolean {
  if (value.trim() !== value || value.length === 0) return false;
  return value.replace(/^\$\./u, "").split(".").every(isContractPathSegment);
}

function isContractPathSegment(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/u.test(value);
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
      diagnostics.push(
        `edge ${definition.source}.${definition.relation} contains a cycle at ${id}`,
      );
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
  return (
    value === "." ||
    (value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
  );
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function validateContextualProvenance(record: GraphContextualRecord, diagnostics: string[]): void {
  const provenance = record.provenance;
  const baseline = record.recordType === "working_spec" && provenance.kind === "baseline";
  const update = record.recordType === "working_spec" && provenance.kind === "owner_update";
  const note = record.recordType === "change_note" && provenance.kind === "change_note";
  const optionalIds = [
    provenance.ticketId,
    provenance.stepId,
    provenance.attemptId,
    provenance.sessionId,
  ];
  const optionalHashes = [
    provenance.authorityGrantHash,
    provenance.launchSpecHash,
    provenance.authoritativeContextHash,
  ];
  if (
    (!baseline && !update && !note) ||
    provenance.runId !== record.runId ||
    provenance.generation !== record.generation ||
    !isIdentifier(provenance.personaId) ||
    optionalIds.some((value) => value !== undefined && !isIdentifier(value)) ||
    optionalHashes.some((value) => value !== undefined && !isSha256Digest(value)) ||
    !Number.isSafeInteger(provenance.semanticRevision) ||
    provenance.semanticRevision < 0 ||
    !isSha256Digest(provenance.semanticHash) ||
    !Number.isSafeInteger(provenance.contextualRevision) ||
    provenance.contextualRevision < 0 ||
    !isSha256Digest(provenance.contextualHash) ||
    !Number.isFinite(Date.parse(provenance.recordedAt)) ||
    ((update || note) &&
      (provenance.ticketId === undefined ||
        provenance.stepId === undefined ||
        provenance.attemptId === undefined ||
        provenance.sessionId === undefined ||
        !isSha256Digest(provenance.authorityGrantHash) ||
        !isSha256Digest(provenance.launchSpecHash) ||
        !isSha256Digest(provenance.authoritativeContextHash) ||
        provenance.lineage === undefined ||
        !Number.isSafeInteger(provenance.lineage.branchEpoch) ||
        provenance.lineage.branchEpoch < 0 ||
        !["initial", "retry", "rework", "review", "recovery", "integration"].includes(
          provenance.lineage.reason,
        ) ||
        (provenance.lineage.parentAttemptId !== undefined &&
          !isIdentifier(provenance.lineage.parentAttemptId)) ||
        (provenance.lineage.parentSessionId !== undefined &&
          !isIdentifier(provenance.lineage.parentSessionId)) ||
        (provenance.lineage.parentAttemptId === undefined) !==
          (provenance.lineage.parentSessionId === undefined) ||
        (provenance.lineage.parentEntryId !== undefined &&
          (provenance.lineage.parentAttemptId === undefined ||
            Buffer.byteLength(provenance.lineage.parentEntryId, "utf8") === 0 ||
            Buffer.byteLength(provenance.lineage.parentEntryId, "utf8") > 128 ||
            /[\u0000-\u001f\u007f]/u.test(provenance.lineage.parentEntryId)))))
  )
    diagnostics.push(`invalid contextual provenance: ${record.id}`);
}

function validWorkingSpecBaseline(value: unknown): value is WorkingSpecBaseline {
  if (!isRecord(value)) return false;
  const intake = value.intake;
  const acceptedPlan = value.acceptedPlan;
  const source = value.source;
  if (
    typeof value.objective !== "string" ||
    !isRecord(intake) ||
    Object.values(intake).some((entry) => !validConfigurationValue(entry)) ||
    typeof value.resolvedDecisions !== "string" ||
    typeof value.verificationIntent !== "string" ||
    !isRecord(source) ||
    (source.kind !== "approved_plan" && source.kind !== "direct_approval") ||
    typeof source.artifactPath !== "string" ||
    !isSafeArtifactPath(source.artifactPath) ||
    !isSha256Digest(source.artifactSha256) ||
    !Number.isSafeInteger(source.planRevision) ||
    Number(source.planRevision) < 0 ||
    (source.attemptId !== undefined &&
      (typeof source.attemptId !== "string" || !isIdentifier(source.attemptId))) ||
    (source.kind === "approved_plan" && source.attemptId === undefined) ||
    (source.kind === "direct_approval" && source.attemptId !== undefined)
  )
    return false;
  const validPlan =
    acceptedPlan === null ||
    (isRecord(acceptedPlan) &&
      typeof acceptedPlan.architecture === "string" &&
      typeof acceptedPlan.decisions === "string" &&
      typeof acceptedPlan.risk === "string" &&
      typeof acceptedPlan.verification === "string");
  return (
    validPlan &&
    ((source.kind === "approved_plan" && acceptedPlan !== null) ||
      (source.kind === "direct_approval" && acceptedPlan === null))
  );
}

function validConfigurationValue(value: unknown, depth = 0): value is ConfigurationValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((entry) => validConfigurationValue(entry, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => validConfigurationValue(entry, depth + 1));
}

function validateContextualRelationships(state: GraphContextualState, diagnostics: string[]): void {
  const records = state.records;
  const successors = new Map<string, string[]>();
  const specifications: WorkingSpecVersionRecord[] = [];
  for (const record of Object.values(records)) {
    if (record.recordType === "working_spec") {
      specifications.push(record);
      if (record.ownerPersonaId !== state.ownerPersonaId) {
        diagnostics.push(`working specification ${record.id} is not bound to the contextual owner`);
      }
      if (
        (record.version === 1 &&
          (record.supersedes !== undefined || record.provenance.kind !== "baseline")) ||
        (record.version > 1 &&
          (record.supersedes === undefined || record.provenance.kind !== "owner_update"))
      )
        diagnostics.push(`invalid working-spec version lineage: ${record.id}`);
    }
    if (record.supersedes === undefined) continue;
    const values = successors.get(record.supersedes) ?? [];
    values.push(record.id);
    successors.set(record.supersedes, values);
    const prior = records[record.supersedes];
    if (record.recordType === "working_spec") {
      if (
        prior === undefined ||
        prior.recordType !== "working_spec" ||
        record.version !== prior.version + 1 ||
        record.ownerPersonaId !== prior.ownerPersonaId ||
        record.runId !== prior.runId ||
        record.generation !== prior.generation ||
        record.baselineDigest !== prior.baselineDigest
      )
        diagnostics.push(`invalid working-spec predecessor: ${record.id}`);
    } else if (
      (prior === undefined && !/^note-[0-9a-f]{24}$/u.test(record.supersedes)) ||
      (prior !== undefined &&
        (prior.recordType !== "change_note" ||
          prior.runId !== record.runId ||
          prior.subject.kind !== record.subject.kind ||
          prior.subject.id !== record.subject.id))
    ) {
      diagnostics.push(`invalid graph-note predecessor: ${record.id}`);
    }
  }

  if (specifications.length > 0) {
    const baselines = specifications.filter((record) => record.version === 1);
    const terminals = specifications.filter((record) => !successors.has(record.id));
    const versions = new Set(specifications.map((record) => record.version));
    if (
      baselines.length !== 1 ||
      terminals.length !== 1 ||
      versions.size !== specifications.length
    ) {
      diagnostics.push("working specifications do not form one sequential version chain");
    }
    if (state.canonicalWorkingSpecId !== terminals[0]?.id) {
      diagnostics.push("canonical working specification is not the terminal version");
    }
  } else if (state.canonicalWorkingSpecId !== undefined) {
    diagnostics.push("canonical working specification exists without a version chain");
  }

  const links = new Set(state.links.map(contextualLinkKey));
  const requireLink = (
    sourceId: string,
    relation: GraphContextualLink["relation"],
    targetKind: GraphContextualLink["targetKind"],
    targetId: string,
  ): void => {
    if (!links.has(contextualLinkKey({ sourceId, relation, targetKind, targetId }))) {
      diagnostics.push(
        `contextual record ${sourceId} is missing its ${relation} link to ${targetId}`,
      );
    }
  };
  for (const link of state.links) {
    const record = records[link.sourceId];
    if (record === undefined) continue;
    const valid =
      record.recordType === "working_spec"
        ? (link.relation === "context_for" &&
            link.targetKind === "run_root" &&
            link.targetId === state.runRootId) ||
          (link.relation === "affects" &&
            link.targetKind === "semantic_node" &&
            record.affectedNodeIds.includes(link.targetId)) ||
          (link.relation === "references_path" &&
            link.targetKind === "repository_path" &&
            record.repositoryPaths.includes(link.targetId)) ||
          (link.relation === "supersedes" &&
            link.targetKind === "context_record" &&
            record.supersedes === link.targetId)
        : (link.relation === "context_for" &&
            link.targetKind === record.subject.kind &&
            link.targetId === record.subject.id) ||
          (link.relation === "references_path" &&
            link.targetKind === "repository_path" &&
            record.repositoryPaths.includes(link.targetId)) ||
          (link.relation === "supersedes" &&
            link.targetKind === "context_record" &&
            record.supersedes === link.targetId);
    if (!valid)
      diagnostics.push(`contextual link does not match record ${record.id}: ${link.relation}`);
  }
  for (const record of Object.values(records)) {
    if (record.recordType === "working_spec") {
      requireLink(record.id, "context_for", "run_root", state.runRootId);
      for (const targetId of record.affectedNodeIds)
        requireLink(record.id, "affects", "semantic_node", targetId);
    } else {
      requireLink(record.id, "context_for", record.subject.kind, record.subject.id);
    }
    for (const targetId of record.repositoryPaths) {
      requireLink(record.id, "references_path", "repository_path", targetId);
    }
    if (record.supersedes !== undefined) {
      requireLink(record.id, "supersedes", "context_record", record.supersedes);
    }
  }
}

function contextualLinkKey(link: GraphContextualLink): string {
  return `${link.sourceId}\u0000${link.relation}\u0000${link.targetKind}\u0000${link.targetId}`;
}

function validRepositoryPathList(values: readonly string[]): boolean {
  return (
    Array.isArray(values) &&
    new Set(values).size === values.length &&
    values.every(isSafeProjectPath)
  );
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
