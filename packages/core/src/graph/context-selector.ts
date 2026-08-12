import {
  canonicalEncode,
  canonicalHash,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import type { JsonValue } from "../authority/protocol.js";
import {
  type GraphChangeNoteRecord,
  type GraphContextualRecord,
  type GraphContextualState,
  type GraphEdge,
  type GraphNode,
  type WorkingSpecVersionRecord,
  type TypedGraph,
  validateGraphContextualState,
} from "./model.js";

export const DYNAMIC_GRAPH_CONTEXT_PROTOCOL = "koni.dynamic-graph-context.v1" as const;
export const MAX_DYNAMIC_GRAPH_RECORDS = 256;
export const MAX_DYNAMIC_GRAPH_BYTES = 1_048_576;

export interface LegacyGraphNoteRecord {
  protocol: "koni.graph-note.v1";
  id: string;
  runId: string;
  ticketId: string;
  stepId: string;
  attemptId: string;
  sessionId?: string;
  personaId: string;
  nodeId: string;
  kind: GraphChangeNoteRecord["kind"];
  body: string;
  status: "working";
  supersedes?: string;
  graphSha256: Sha256Digest;
  nodeSha256: Sha256Digest;
  contextSha256: Sha256Digest;
  authorityGrantSha256?: Sha256Digest;
  launchSpecSha256: Sha256Digest;
  generation?: number;
  lineage?: GraphChangeNoteRecord["provenance"]["lineage"];
  repositoryPaths?: string[];
  recordedAt: string;
}

export interface DynamicGraphSelectionRequest {
  anchors?: readonly string[];
  relations?: readonly string[];
  direction?: "outgoing" | "incoming" | "both";
  maxDepth?: number;
  nodeTypes?: readonly string[];
}

export interface DynamicGraphSelectionInput {
  /** Compatibility label only; cache coherence is derived from the durable bindings below. */
  cacheKey: string;
  identity: {
    runId: string;
    ticketId: string;
    stepId: string;
    attemptId: string;
    sessionId: string;
    personaId: string;
    grantHash: Sha256Digest;
    launchSpecHash: Sha256Digest;
    generation: number;
  };
  objective: string;
  runUpdatedAt: string;
  semanticRevision: number;
  semanticHash: Sha256Digest;
  contextual: GraphContextualState;
  graph: TypedGraph;
  /** Compiler-resolved directed relation arcs, including configured inverse names when present. */
  arcs?: readonly { from: string; relation: string; to: string }[];
  nodePaths: Readonly<Record<string, readonly string[]>>;
  legacyNotes?: readonly LegacyGraphNoteRecord[];
  ticketTargetIds: readonly string[];
  stepTargetIds: readonly string[];
  scopedPaths: readonly string[];
  touchedPaths?: readonly string[];
  graphActivity?: readonly { nodeId?: string; at: string }[];
  compatibleAttemptIds: ReadonlySet<string>;
  abandonedAttemptIds: ReadonlySet<string>;
  maxInputTokens: number;
  request?: DynamicGraphSelectionRequest;
}

export type DynamicGraphProjectedRecord =
  | { kind: "working_spec"; id: string; value: DynamicWorkingSpecProjection }
  | { kind: "run_objective"; id: string; objective: string }
  | {
      kind: "semantic_node";
      id: string;
      node: GraphNode;
      repositoryPaths: string[];
      semanticProjection: JsonValue;
      semanticSha256: Sha256Digest;
      nodeTypeContract: {
        description: string;
        stage?: string;
        annotations: Record<string, JsonValue>;
        semanticFields: readonly string[];
        compilerOwnedFields: readonly string[];
        agentVisibleCompilerOwnedFields: readonly string[];
        gateRequired: boolean;
      };
    }
  | { kind: "change_note"; id: string; value: GraphChangeNoteRecord | LegacyGraphNoteRecord };

export type DynamicWorkingSpecProjection = Omit<WorkingSpecVersionRecord, "baseline"> & {
  /** Immutable provenance remains visible when the canonical baseline body is deduplicated. */
  baselineSource: WorkingSpecVersionRecord["baseline"]["source"];
  /**
   * Owner guidance normally renders the immutable baseline verbatim. Keep only one copy in the
   * transient prompt; retain the baseline when guidance has diverged so neither authority is lost.
   */
  baseline?: WorkingSpecVersionRecord["baseline"];
};

export interface DynamicGraphContextEnvelope {
  protocol: typeof DYNAMIC_GRAPH_CONTEXT_PROTOCOL;
  binding: {
    runId: string;
    ticketId: string;
    stepId: string;
    attemptId: string;
    sessionId: string;
    personaId: string;
    grantHash: Sha256Digest;
    launchSpecHash: Sha256Digest;
    generation: number;
    semanticRevision: number;
    semanticHash: Sha256Digest;
    schemaHash: Sha256Digest;
    contextualRevision: number;
    contextualHash: Sha256Digest;
  };
  budget: {
    maxRecords: number;
    maxBytes: number;
    maxEstimatedTokens: number;
    selectedRecords: number;
    utf8Bytes: number;
    estimatedTokens: number;
  };
  selection: {
    candidateCount: number;
    filteredCount: number;
    budgetOmissionCount: number;
    selected: Array<{ id: string; reason: string }>;
  };
  records: DynamicGraphProjectedRecord[];
}

export interface SelectedDynamicGraphContext {
  envelope: DynamicGraphContextEnvelope;
  content: string;
  envelopeHash: Sha256Digest;
}

export class DynamicGraphContextBudgetError extends Error {
  public readonly code = "dynamic_context_budget";

  public constructor(message: string) {
    super(message);
    this.name = "DynamicGraphContextBudgetError";
  }
}

interface SelectionIndex {
  nodes: ReadonlyMap<string, GraphNode>;
  edges: readonly GraphEdge[];
  outgoing: ReadonlyMap<string, readonly Arc[]>;
  incoming: ReadonlyMap<string, readonly Arc[]>;
  nodePaths: ReadonlyMap<string, readonly string[]>;
  contextualRecords: readonly GraphContextualRecord[];
  legacyNotes: readonly LegacyGraphNoteRecord[];
  contextLinks: ReadonlyMap<string, ContextRecordLinks>;
}

interface ContextRecordLinks {
  runRoot: boolean;
  nodeIds: readonly string[];
  repositoryPaths: readonly string[];
}

interface Arc {
  relation: string;
  nodeId: string;
}

interface RankedRecord {
  key: string;
  reason: string;
  mandatory: boolean;
  tier: number;
  distance: number;
  pathQuality: number;
  activityAt: string;
  stableId: string;
  projected: DynamicGraphProjectedRecord;
}

/**
 * Indexes only durable graph material. Every `select` invocation reruns compatibility filtering,
 * shortest-distance ranking, projection, and whole-record budgeting against active attempt state.
 */
export class DynamicGraphContextSelector {
  readonly #indexes = new Map<string, SelectionIndex>();
  #selectionCount = 0;
  #indexBuildCount = 0;

  public stats(): { selections: number; indexBuilds: number; cachedIndexes: number } {
    return {
      selections: this.#selectionCount,
      indexBuilds: this.#indexBuildCount,
      cachedIndexes: this.#indexes.size,
    };
  }

  public clear(): void {
    this.#indexes.clear();
  }

  public select(input: DynamicGraphSelectionInput): SelectedDynamicGraphContext {
    this.#selectionCount += 1;
    validateGraphContextualState(input.contextual);
    if (
      input.semanticHash !== input.graph.hash ||
      !Number.isSafeInteger(input.semanticRevision) ||
      input.semanticRevision < 0 ||
      !Number.isSafeInteger(input.identity.generation) ||
      input.identity.generation < 0 ||
      !Number.isSafeInteger(input.maxInputTokens) ||
      input.maxInputTokens < 1
    ) {
      throw new Error(
        "dynamic graph context input does not match its durable semantic state or budget",
      );
    }
    const index = this.#index(input);
    const request = input.request;
    const ticketTargets = existingIds(index.nodes, input.ticketTargetIds);
    const stepTargets = existingIds(index.nodes, input.stepTargetIds);
    const explicitAnchors = existingIds(index.nodes, request?.anchors ?? []);
    const exactTargets = new Set([...ticketTargets, ...stepTargets, ...explicitAnchors]);

    const activeSpec =
      input.contextual.canonicalWorkingSpecId === undefined
        ? undefined
        : input.contextual.records[input.contextual.canonicalWorkingSpecId];
    const compatibleSpec =
      activeSpec?.recordType === "working_spec" &&
      activeSpec.runId === input.identity.runId &&
      activeSpec.generation === input.identity.generation
        ? activeSpec
        : undefined;
    const linkedSpecNodes =
      compatibleSpec === undefined
        ? []
        : [
            ...new Set([
              ...compatibleSpec.affectedNodeIds,
              ...(index.contextLinks.get(compatibleSpec.id)?.nodeIds ?? []),
            ]),
          ]
            .filter((id) => index.nodes.has(id))
            .sort(compareText);
    const starts = [...new Set([...exactTargets, ...linkedSpecNodes])].sort(compareText);
    const distances = shortestDistances(index, starts, request);
    const activePaths = normalizePaths([...input.scopedPaths, ...(input.touchedPaths ?? [])]);
    // Run activity advances independently of semantic/contextual graph CAS. Recompute it for every
    // request rather than retaining mutable recency in the revision-keyed durable graph index.
    const activityAt = latestGraphActivity(input.graphActivity ?? []);

    const ranked: RankedRecord[] = [];
    const runRootKey = input.contextual.runRootId;
    if (compatibleSpec !== undefined) {
      ranked.push({
        key: `working_spec:${compatibleSpec.id}`,
        reason: "active_canonical_working_spec",
        mandatory: true,
        tier: 0,
        distance: 0,
        pathQuality: pathOverlapQuality(
          [
            ...compatibleSpec.repositoryPaths,
            ...(index.contextLinks.get(compatibleSpec.id)?.repositoryPaths ?? []),
          ],
          activePaths,
        ),
        activityAt: compatibleSpec.provenance.recordedAt,
        stableId: `0:${compatibleSpec.id}`,
        projected: {
          kind: "working_spec",
          id: compatibleSpec.id,
          value: projectWorkingSpec(compatibleSpec),
        },
      });
    }
    ranked.push({
      key: `run_objective:${runRootKey}`,
      reason: "run_objective",
      mandatory: true,
      tier: 0,
      distance: 0,
      pathQuality: 0,
      activityAt: input.runUpdatedAt,
      stableId: `1:${runRootKey}`,
      projected: { kind: "run_objective", id: runRootKey, objective: input.objective },
    });

    for (const node of index.nodes.values()) {
      const distance = distances.get(node.id);
      const pathQuality = pathOverlapQuality(index.nodePaths.get(node.id) ?? [], activePaths);
      const exact = exactTargets.has(node.id);
      const linked = linkedSpecNodes.includes(node.id);
      if (!exact && distance === undefined && pathQuality === 0 && !linked) continue;
      if (request?.nodeTypes !== undefined && !exact && !request.nodeTypes.includes(node.type))
        continue;
      ranked.push({
        key: `semantic_node:${node.id}`,
        reason: exact
          ? stepTargets.includes(node.id)
            ? "exact_active_step_target"
            : "exact_active_ticket_target"
          : distance !== undefined
            ? `graph_neighbor_distance_${distance}`
            : pathQuality === 2
              ? "exact_scoped_path_overlap"
              : pathQuality === 1
                ? "ancestor_or_descendant_path_overlap"
                : "active_working_spec_link",
        mandatory: false,
        tier: exact ? 1 : distance !== undefined ? 3 : 4,
        distance: distance ?? Number.MAX_SAFE_INTEGER,
        pathQuality,
        activityAt: activityAt.get(node.id) ?? "",
        stableId: node.id,
        projected: {
          kind: "semantic_node",
          id: node.id,
          node: structuredClone(node),
          repositoryPaths: [...(index.nodePaths.get(node.id) ?? [])],
          semanticProjection: input.graph.semanticProjection(node.id)!,
          semanticSha256: input.graph.semanticHash(node.id)!,
          nodeTypeContract: projectNodeTypeContract(input.graph, node),
        },
      });
    }

    const noteCandidates = [
      ...index.contextualRecords.filter(
        (record): record is GraphChangeNoteRecord => record.recordType === "change_note",
      ),
      ...index.legacyNotes,
    ];
    // Supersession is evaluated only after generation, lineage, and stale-target filtering. An
    // incompatible or abandoned successor must not hide otherwise-current guidance.
    const compatibleNotes = noteCandidates.filter((note) => noteCompatible(note, input, index));
    const supersededNoteIds = new Set(
      compatibleNotes.flatMap((note) => (note.supersedes === undefined ? [] : [note.supersedes])),
    );
    for (const note of compatibleNotes) {
      if (supersededNoteIds.has(note.id)) continue;
      const subject = noteSubject(note);
      const links =
        note.protocol === "koni.graph-note.v1" ? undefined : index.contextLinks.get(note.id);
      const anchorNodeIds = [
        ...new Set([
          ...(subject.kind === "semantic_node" ? [subject.id] : []),
          ...(links?.nodeIds ?? []),
        ]),
      ];
      const paths = normalizePaths([...notePaths(note), ...(links?.repositoryPaths ?? [])]);
      const pathQuality = pathOverlapQuality(paths, activePaths);
      const direct =
        subject.kind === "run_root" ||
        links?.runRoot === true ||
        anchorNodeIds.some((id) => exactTargets.has(id) || distances.get(id) === 0);
      const linkedDistances = anchorNodeIds
        .map((id) => distances.get(id))
        .filter((value): value is number => value !== undefined);
      const distance = linkedDistances.length === 0 ? undefined : Math.min(...linkedDistances);
      const hasGraphRelationship = direct || distance !== undefined;
      if (!hasGraphRelationship && pathQuality === 0) continue;
      ranked.push({
        key: `change_note:${note.id}`,
        reason: direct
          ? "directly_linked_current_note"
          : distance !== undefined
            ? `linked_note_graph_distance_${distance}`
            : pathQuality === 2
              ? "note_exact_scoped_path_overlap"
              : "note_ancestor_or_descendant_path_overlap",
        mandatory: false,
        tier: direct ? 2 : distance !== undefined ? 3 : 4,
        distance: distance ?? Number.MAX_SAFE_INTEGER,
        pathQuality,
        activityAt: noteRecordedAt(note),
        stableId: note.id,
        projected: { kind: "change_note", id: note.id, value: structuredClone(note) },
      });
    }

    ranked.sort(compareRanked);
    const candidateCount =
      1 + index.nodes.size + index.contextualRecords.length + index.legacyNotes.length;
    const filteredCount = Math.max(0, candidateCount - ranked.length);
    return budgetEnvelope(input, ranked, candidateCount, filteredCount);
  }

  #index(input: DynamicGraphSelectionInput): SelectionIndex {
    // Never trust a caller-supplied cache label as the coherence boundary. The durable epochs and
    // hashes are the cache key; mutable activity and active-attempt state are recomputed outside it.
    const durableKey = canonicalHash({
      runId: input.identity.runId,
      generation: input.identity.generation,
      semanticRevision: input.semanticRevision,
      semanticHash: input.semanticHash,
      schemaHash: input.graph.schemaHash,
      contextualRevision: input.contextual.revision,
      contextualHash: input.contextual.hash,
    });
    const cached = this.#indexes.get(durableKey);
    if (cached !== undefined) return cached;
    this.#indexBuildCount += 1;
    const nodes = new Map(input.graph.nodes().map((node) => [node.id, node]));
    const edges = input.graph.edges();
    const outgoing = new Map<string, Arc[]>();
    const incoming = new Map<string, Arc[]>();
    const arcs =
      input.arcs ??
      edges.map((edge) => ({ from: edge.source, relation: edge.relation, to: edge.target }));
    for (const arc of arcs) {
      if (!nodes.has(arc.from) || !nodes.has(arc.to)) continue;
      appendArc(outgoing, arc.from, { relation: arc.relation, nodeId: arc.to });
      appendArc(incoming, arc.to, { relation: arc.relation, nodeId: arc.from });
    }
    sortArcs(outgoing);
    sortArcs(incoming);
    const contextualRecords = Object.values(input.contextual.records).sort((left, right) =>
      compareText(left.id, right.id),
    );
    const legacyNotes = [...(input.legacyNotes ?? [])].sort((left, right) =>
      compareText(left.id, right.id),
    );
    const contextLinks = new Map<
      string,
      {
        runRoot: boolean;
        nodeIds: Set<string>;
        repositoryPaths: Set<string>;
      }
    >();
    for (const link of input.contextual.links) {
      const current = contextLinks.get(link.sourceId) ?? {
        runRoot: false,
        nodeIds: new Set<string>(),
        repositoryPaths: new Set<string>(),
      };
      if (link.targetKind === "run_root") current.runRoot = true;
      if (link.targetKind === "semantic_node") current.nodeIds.add(link.targetId);
      if (link.targetKind === "repository_path") current.repositoryPaths.add(link.targetId);
      contextLinks.set(link.sourceId, current);
    }
    const projectedContextLinks = new Map<string, ContextRecordLinks>();
    for (const [id, links] of contextLinks) {
      projectedContextLinks.set(id, {
        runRoot: links.runRoot,
        nodeIds: [...links.nodeIds].sort(compareText),
        repositoryPaths: [...links.repositoryPaths].sort(compareText),
      });
    }
    const nodePaths = new Map<string, readonly string[]>();
    for (const id of [...nodes.keys()].sort(compareText)) {
      nodePaths.set(id, normalizePaths(input.nodePaths[id] ?? []));
    }
    const built: SelectionIndex = {
      nodes,
      edges,
      outgoing,
      incoming,
      nodePaths,
      contextualRecords,
      legacyNotes,
      contextLinks: projectedContextLinks,
    };
    this.#indexes.set(durableKey, built);
    while (this.#indexes.size > 8) this.#indexes.delete(this.#indexes.keys().next().value!);
    return built;
  }
}

function projectWorkingSpec(record: WorkingSpecVersionRecord): DynamicWorkingSpecProjection {
  const canonicalBaselineGuidance = JSON.stringify(
    {
      objective: record.baseline.objective,
      intake: record.baseline.intake,
      acceptedPlan: record.baseline.acceptedPlan,
      resolvedDecisions: record.baseline.resolvedDecisions,
      verificationIntent: record.baseline.verificationIntent,
    },
    null,
    2,
  );
  const { baseline, ...metadata } = structuredClone(record);
  return {
    ...metadata,
    baselineSource: structuredClone(baseline.source),
    ...(record.guidance === canonicalBaselineGuidance ? {} : { baseline }),
  };
}

function projectNodeTypeContract(
  graph: TypedGraph,
  node: GraphNode,
): Extract<DynamicGraphProjectedRecord, { kind: "semantic_node" }>["nodeTypeContract"] {
  const contract = graph.nodeTypeContract(node.type);
  if (contract === undefined)
    throw new Error(`dynamic graph context cannot resolve node type ${node.type}`);
  return {
    description: contract.description,
    ...(contract.stage === undefined ? {} : { stage: contract.stage }),
    annotations: structuredClone(contract.annotations ?? {}),
    semanticFields: [...(contract.semantic_fields ?? [])],
    compilerOwnedFields: [...(contract.compiler_owned_fields ?? [])],
    agentVisibleCompilerOwnedFields: [...(contract.agent_visible_compiler_owned_fields ?? [])],
    gateRequired: contract.gate_required ?? false,
  };
}

function noteCompatible(
  note: GraphChangeNoteRecord | LegacyGraphNoteRecord,
  input: DynamicGraphSelectionInput,
  index: SelectionIndex,
): boolean {
  if (note.runId !== input.identity.runId) return false;
  const generation =
    note.protocol === "koni.graph-note.v1"
      ? (note.generation ?? input.identity.generation)
      : note.generation;
  if (generation !== input.identity.generation) return false;
  const attemptId =
    note.protocol === "koni.graph-note.v1" ? note.attemptId : note.provenance.attemptId;
  if (
    attemptId !== undefined &&
    (input.abandonedAttemptIds.has(attemptId) || !input.compatibleAttemptIds.has(attemptId))
  )
    return false;
  const subject = noteSubject(note);
  if (subject.kind === "run_root") return subject.id === input.contextual.runRootId;
  const node = index.nodes.get(subject.id);
  if (node === undefined) return false;
  const recordedHash =
    note.protocol === "koni.graph-note.v1" ? note.nodeSha256 : note.targetNodeHashes[subject.id];
  return recordedHash !== undefined && recordedHash === canonicalHash(node);
}

function noteSubject(note: GraphChangeNoteRecord | LegacyGraphNoteRecord): {
  kind: "run_root" | "semantic_node";
  id: string;
} {
  return note.protocol === "koni.graph-note.v1"
    ? { kind: "semantic_node", id: note.nodeId }
    : note.subject;
}

function notePaths(note: GraphChangeNoteRecord | LegacyGraphNoteRecord): readonly string[] {
  return note.protocol === "koni.graph-note.v1"
    ? (note.repositoryPaths ?? [])
    : note.repositoryPaths;
}

function noteRecordedAt(note: GraphChangeNoteRecord | LegacyGraphNoteRecord): string {
  return note.protocol === "koni.graph-note.v1" ? note.recordedAt : note.provenance.recordedAt;
}

function latestGraphActivity(
  activities: readonly { nodeId?: string; at: string }[],
): ReadonlyMap<string, string> {
  const activityAt = new Map<string, string>();
  for (const activity of activities) {
    if (activity.nodeId === undefined) continue;
    const prior = activityAt.get(activity.nodeId);
    if (prior === undefined || activity.at > prior) activityAt.set(activity.nodeId, activity.at);
  }
  return activityAt;
}

function shortestDistances(
  index: SelectionIndex,
  starts: readonly string[],
  request: DynamicGraphSelectionRequest | undefined,
): Map<string, number> {
  const output = new Map<string, number>();
  const queue = starts.map((id) => ({ id, distance: 0 }));
  for (const id of starts) output.set(id, 0);
  const maxDepth = request?.maxDepth ?? Number.MAX_SAFE_INTEGER;
  const direction = request?.direction ?? "both";
  const relations = request?.relations === undefined ? undefined : new Set(request.relations);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (current.distance >= maxDepth) continue;
    const arcs = [
      ...(direction === "outgoing" || direction === "both"
        ? (index.outgoing.get(current.id) ?? [])
        : []),
      ...(direction === "incoming" || direction === "both"
        ? (index.incoming.get(current.id) ?? [])
        : []),
    ].filter((arc) => relations === undefined || relations.has(arc.relation));
    arcs.sort(
      (left, right) =>
        compareText(left.nodeId, right.nodeId) || compareText(left.relation, right.relation),
    );
    for (const arc of arcs) {
      if (output.has(arc.nodeId)) continue;
      const distance = current.distance + 1;
      output.set(arc.nodeId, distance);
      queue.push({ id: arc.nodeId, distance });
    }
  }
  return output;
}

function budgetEnvelope(
  input: DynamicGraphSelectionInput,
  ranked: readonly RankedRecord[],
  candidateCount: number,
  filteredCount: number,
): SelectedDynamicGraphContext {
  const tokenLimit = Math.max(1, Math.floor(input.maxInputTokens / 4));
  const byteLimit = Math.min(MAX_DYNAMIC_GRAPH_BYTES, 4 * tokenLimit);
  let selected = [...ranked];
  const optional = () => selected.filter((record) => !record.mandatory);
  while (selected.length > MAX_DYNAMIC_GRAPH_RECORDS) removeLowestOptional(selected);
  let built = buildEnvelope(
    input,
    selected,
    candidateCount,
    filteredCount,
    byteLimit,
    tokenLimit,
    ranked.length,
  );
  while (
    built.envelope.budget.selectedRecords > MAX_DYNAMIC_GRAPH_RECORDS ||
    built.envelope.budget.utf8Bytes > byteLimit ||
    built.envelope.budget.estimatedTokens > tokenLimit
  ) {
    if (optional().length === 0) {
      throw new DynamicGraphContextBudgetError(
        `mandatory dynamic graph context exceeds limits (records=${built.envelope.budget.selectedRecords}/${MAX_DYNAMIC_GRAPH_RECORDS}, bytes=${built.envelope.budget.utf8Bytes}/${byteLimit}, tokens=${built.envelope.budget.estimatedTokens}/${tokenLimit})`,
      );
    }
    removeLowestOptional(selected);
    built = buildEnvelope(
      input,
      selected,
      candidateCount,
      filteredCount,
      byteLimit,
      tokenLimit,
      ranked.length,
    );
  }
  return built;
}

function buildEnvelope(
  input: DynamicGraphSelectionInput,
  selected: readonly RankedRecord[],
  candidateCount: number,
  filteredCount: number,
  byteLimit: number,
  tokenLimit: number,
  eligibleCount: number,
): SelectedDynamicGraphContext {
  const base = {
    protocol: DYNAMIC_GRAPH_CONTEXT_PROTOCOL,
    binding: {
      ...input.identity,
      semanticRevision: input.semanticRevision,
      semanticHash: input.semanticHash,
      schemaHash: input.graph.schemaHash,
      contextualRevision: input.contextual.revision,
      contextualHash: input.contextual.hash,
    },
    selection: {
      candidateCount,
      filteredCount,
      budgetOmissionCount: eligibleCount - selected.length,
      selected: selected.map((record) => ({ id: record.key, reason: record.reason })),
    },
    records: selected.map((record) => structuredClone(record.projected)),
  } as const;
  let metrics = { utf8Bytes: 0, estimatedTokens: 0 };
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const envelope: DynamicGraphContextEnvelope = {
      ...base,
      budget: {
        maxRecords: MAX_DYNAMIC_GRAPH_RECORDS,
        maxBytes: byteLimit,
        maxEstimatedTokens: tokenLimit,
        selectedRecords: selected.length,
        ...metrics,
      },
    };
    const content = canonicalEncode(envelope);
    const utf8Bytes = Buffer.byteLength(content, "utf8");
    const next = {
      utf8Bytes,
      estimatedTokens: Math.ceil(utf8Bytes / 4),
    };
    if (next.utf8Bytes === metrics.utf8Bytes && next.estimatedTokens === metrics.estimatedTokens) {
      return { envelope, content, envelopeHash: rawSha256(content) };
    }
    metrics = next;
  }
  throw new DynamicGraphContextBudgetError(
    "dynamic graph context budget metadata did not converge",
  );
}

function removeLowestOptional(selected: RankedRecord[]): void {
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    if (!selected[index]!.mandatory) {
      selected.splice(index, 1);
      return;
    }
  }
}

function compareRanked(left: RankedRecord, right: RankedRecord): number {
  if (left.mandatory && right.mandatory) return compareText(left.stableId, right.stableId);
  return (
    left.tier - right.tier ||
    left.distance - right.distance ||
    right.pathQuality - left.pathQuality ||
    right.activityAt.localeCompare(left.activityAt) ||
    compareText(left.stableId, right.stableId)
  );
}

function pathOverlapQuality(
  candidatePaths: readonly string[],
  activePaths: readonly string[],
): number {
  let quality = 0;
  for (const candidate of candidatePaths) {
    for (const active of activePaths) {
      if (candidate === active) return 2;
      if (
        active === "." ||
        candidate === "." ||
        candidate.startsWith(`${active}/`) ||
        active.startsWith(`${candidate}/`)
      ) {
        quality = 1;
      }
    }
  }
  return quality;
}

function normalizePaths(values: readonly string[]): string[] {
  const output = new Set<string>();
  for (const value of values) {
    if (
      value === "." ||
      (value.length > 0 &&
        value.length <= 16 * 1024 &&
        !value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes("\u0000") &&
        !value.split("/").some((part) => part === "" || part === "." || part === ".."))
    )
      output.add(value);
  }
  return [...output].sort(compareText);
}

function existingIds(nodes: ReadonlyMap<string, GraphNode>, values: readonly string[]): string[] {
  return [...new Set(values)].filter((id) => nodes.has(id)).sort(compareText);
}

function appendArc(map: Map<string, Arc[]>, id: string, arc: Arc): void {
  const values = map.get(id) ?? [];
  values.push(arc);
  map.set(id, values);
}

function sortArcs(map: Map<string, Arc[]>): void {
  for (const values of map.values()) {
    values.sort(
      (left, right) =>
        compareText(left.relation, right.relation) || compareText(left.nodeId, right.nodeId),
    );
  }
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
