import { describe, expect, it } from "vitest";
import {
  DynamicGraphContextBudgetError,
  DynamicGraphContextSelector,
} from "../src/graph/context-selector.js";
import {
  GRAPH_CHANGE_NOTE_PROTOCOL,
  WORKING_SPEC_PROTOCOL,
  GraphSchema,
  TypedGraph,
  createGraphContextualState,
  sealGraphContextualState,
  workingSpecDigest,
  type GraphChangeNoteRecord,
  type GraphContextualState,
  type GraphNode,
  type WorkingSpecVersionRecord,
} from "../src/graph/model.js";
import { canonicalHash, type Sha256Digest } from "../src/shared/canonical.js";

const digest = (value: unknown): Sha256Digest => canonicalHash(value);

function node(id: string, paths: string[], edges: string[] = []): GraphNode {
  return {
    schema_version: "1.0",
    id,
    type: "work",
    title: id,
    status: "open",
    spec: { paths },
    edges: edges.length === 0 ? {} : { links: edges },
    annotations: {},
  };
}

function graph(): TypedGraph {
  const schema = new GraphSchema({
    nodeTypes: [{
      id: "work",
      description: "work",
      statuses: ["open"],
      initial_status: "open",
      fields: { paths: { type: "list", items: { type: "path" } } },
    }],
    edgeTypes: [{ source: "work", relation: "links", targets: ["work"] }],
  });
  return new TypedGraph(schema, [
    node("active", ["src/active.ts"], ["near"]),
    node("near", ["src/near.ts"], ["far"]),
    node("far", ["src/far.ts"]),
    node("path-match", ["src/active.ts"]),
    node("unrelated", ["other/unrelated.ts"]),
  ]);
}

function baseline(runId: string, prior: GraphContextualState): WorkingSpecVersionRecord {
  const material = {
    objective: "Ship bounded graph context",
    intake: { goal: "Ship bounded graph context" },
    acceptedPlan: {
      architecture: "Use the run graph.",
      decisions: "Keep semantic and contextual CAS independent.",
      risk: "Reject stale notes.",
      verification: "Exercise every model request.",
    },
    resolvedDecisions: "Keep semantic and contextual CAS independent.",
    verificationIntent: "Exercise every model request.",
    source: {
      kind: "approved_plan" as const,
      artifactPath: `runs/${runId}/attempts/plan/planning-output.json`,
      artifactSha256: digest("plan"),
      planRevision: 1,
      attemptId: "plan",
    },
  };
  const baselineDigest = digest(material);
  const guidance = "Use the current graph, paths, and provenance.";
  return {
    protocol: WORKING_SPEC_PROTOCOL,
    recordType: "working_spec",
    id: "spec-current",
    runId,
    generation: 0,
    ownerPersonaId: "lead",
    version: 1,
    baselineDigest,
    baseline: material,
    guidance,
    affectedNodeIds: ["active"],
    repositoryPaths: ["src/active.ts"],
    digest: workingSpecDigest({ baselineDigest, guidance, affectedNodeIds: ["active"], repositoryPaths: ["src/active.ts"] }),
    provenance: {
      kind: "baseline",
      runId,
      generation: 0,
      personaId: "lead",
      semanticRevision: 3,
      semanticHash: digest("semantic"),
      contextualRevision: prior.revision,
      contextualHash: prior.hash,
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function noteRecord(
  runId: string,
  prior: GraphContextualState,
  graphValue: TypedGraph,
  id: string,
  target: string,
  recordedAt: string,
  options: { supersedes?: string; stale?: boolean; generation?: number } = {},
): GraphChangeNoteRecord {
  return {
    protocol: GRAPH_CHANGE_NOTE_PROTOCOL,
    recordType: "change_note",
    id,
    runId,
    generation: options.generation ?? 0,
    subject: { kind: "semantic_node", id: target },
    kind: "observation",
    body: `${id} body`,
    repositoryPaths: [],
    targetNodeHashes: {
      [target]: options.stale ? digest("stale") : digest(graphValue.node(target)),
    },
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
    provenance: {
      kind: "change_note",
      runId,
      generation: options.generation ?? 0,
      ticketId: "ticket",
      stepId: "step",
      attemptId: "attempt",
      sessionId: "session",
      personaId: "worker",
      authorityGrantHash: digest("grant"),
      launchSpecHash: digest("launch"),
      authoritativeContextHash: digest("assignment"),
      semanticRevision: 3,
      semanticHash: graphValue.hash,
      contextualRevision: prior.revision,
      contextualHash: prior.hash,
      lineage: { branchEpoch: 0, reason: "initial" },
      recordedAt,
    },
  };
}

function contextual(runId: string, graphValue: TypedGraph): GraphContextualState {
  const empty = createGraphContextualState("run-root-test", "lead");
  const spec = baseline(runId, empty);
  const direct = noteRecord(runId, empty, graphValue, "note-direct", "active", "2026-01-05T00:00:00.000Z");
  const old = noteRecord(runId, empty, graphValue, "note-old", "near", "2026-01-02T00:00:00.000Z");
  const successor = noteRecord(runId, empty, graphValue, "note-new", "near", "2026-01-03T00:00:00.000Z", { supersedes: old.id });
  const stale = noteRecord(runId, empty, graphValue, "note-stale", "near", "2026-01-06T00:00:00.000Z", { stale: true });
  const wrongGeneration = noteRecord(runId, empty, graphValue, "note-generation", "near", "2026-01-07T00:00:00.000Z", { generation: 2 });
  const records = Object.fromEntries([spec, direct, old, successor, stale, wrongGeneration].map((record) => [record.id, record]));
  return sealGraphContextualState({
    protocol: empty.protocol,
    revision: 6,
    runRootId: empty.runRootId,
    ownerPersonaId: "lead",
    canonicalWorkingSpecId: spec.id,
    records,
    links: [
      { sourceId: spec.id, relation: "context_for", targetKind: "run_root", targetId: empty.runRootId },
      { sourceId: spec.id, relation: "affects", targetKind: "semantic_node", targetId: "active" },
      ...[direct, old, successor, stale, wrongGeneration].map((record) => ({
        sourceId: record.id,
        relation: "context_for" as const,
        targetKind: "semantic_node" as const,
        targetId: record.subject.id,
      })),
      { sourceId: successor.id, relation: "supersedes", targetKind: "context_record", targetId: old.id },
    ],
  });
}

function selectionInput(selectorGraph = graph()) {
  const runId = "run-test";
  const context = contextual(runId, selectorGraph);
  return {
    cacheKey: digest([0, 3, selectorGraph.hash, context.revision, context.hash]),
    identity: {
      runId,
      ticketId: "ticket",
      stepId: "step",
      attemptId: "attempt",
      sessionId: "session",
      personaId: "worker",
      grantHash: digest("grant"),
      launchSpecHash: digest("launch"),
      generation: 0,
    },
    objective: "Ship bounded graph context",
    runUpdatedAt: "2026-01-08T00:00:00.000Z",
    semanticRevision: 3,
    semanticHash: selectorGraph.hash,
    contextual: context,
    graph: selectorGraph,
    nodePaths: Object.fromEntries(selectorGraph.nodes().map((value) => [value.id, selectorGraph.repositoryPaths(value.id)])),
    legacyNotes: [{
      protocol: "koni.graph-note.v1" as const,
      id: "note-legacy-current",
      runId,
      ticketId: "ticket",
      stepId: "step",
      attemptId: "attempt",
      sessionId: "session",
      personaId: "worker",
      nodeId: "active",
      kind: "rationale" as const,
      body: "Legacy graph-native compatibility note.",
      status: "working" as const,
      graphSha256: selectorGraph.hash,
      nodeSha256: digest(selectorGraph.node("active")),
      contextSha256: digest("assignment"),
      launchSpecSha256: digest("launch"),
      recordedAt: "2026-01-04T00:00:00.000Z",
    }, {
      protocol: "koni.graph-note.v1" as const,
      id: "note-legacy-stale",
      runId,
      ticketId: "ticket",
      stepId: "step",
      attemptId: "attempt",
      sessionId: "session",
      personaId: "worker",
      nodeId: "active",
      kind: "rationale" as const,
      body: "Stale legacy note.",
      status: "working" as const,
      graphSha256: selectorGraph.hash,
      nodeSha256: digest("old-node"),
      contextSha256: digest("assignment"),
      launchSpecSha256: digest("launch"),
      recordedAt: "2026-01-09T00:00:00.000Z",
    }],
    ticketTargetIds: ["active"],
    stepTargetIds: ["active"],
    scopedPaths: ["src/active.ts"],
    graphActivity: selectorGraph.nodes().map((value, index) => ({ nodeId: value.id, at: `2026-01-0${index + 1}T00:00:00.000Z` })),
    compatibleAttemptIds: new Set(["attempt"]),
    abandonedAttemptIds: new Set<string>(),
    maxInputTokens: 400_000,
  } as const;
}

describe("dynamic graph context selection", () => {
  it("filters stale/superseded/incompatible records and ranks active, linked, distance, then path records deterministically", () => {
    const selector = new DynamicGraphContextSelector();
    const selected = selector.select(selectionInput());
    const ids = selected.envelope.selection.selected.map((entry) => entry.id);

    expect(ids.slice(0, 4)).toEqual([
      "working_spec:spec-current",
      "run_objective:run-root-test",
      "semantic_node:active",
      "change_note:note-direct",
    ]);
    expect(ids.indexOf("semantic_node:near")).toBeLessThan(ids.indexOf("semantic_node:far"));
    expect(ids.indexOf("semantic_node:far")).toBeLessThan(ids.indexOf("semantic_node:path-match"));
    expect(ids).toContain("change_note:note-new");
    expect(ids).toContain("change_note:note-legacy-current");
    expect(ids).not.toContain("change_note:note-legacy-stale");
    expect(ids).not.toContain("change_note:note-old");
    expect(ids).not.toContain("change_note:note-stale");
    expect(ids).not.toContain("change_note:note-generation");
    expect(ids).not.toContain("semantic_node:unrelated");
    expect(selected.envelope.budget.utf8Bytes).toBe(Buffer.byteLength(selected.content, "utf8"));
    expect(selected.envelope.budget.estimatedTokens).toBe(Math.ceil(Buffer.byteLength(selected.content, "utf8") / 4));
  });

  it("recomputes every selection, reuses an unchanged index, and keys a changed contextual state separately", () => {
    const selector = new DynamicGraphContextSelector();
    const input = selectionInput();
    selector.select(input);
    selector.select(input);
    expect(selector.stats()).toMatchObject({ selections: 2, indexBuilds: 1 });

    selector.select({ ...input, cacheKey: digest([input.cacheKey, "changed"]) });
    expect(selector.stats()).toMatchObject({ selections: 3, indexBuilds: 2 });
  });

  it("omits whole low-ranked records under all three limits and fails deterministically when mandatory content cannot fit", () => {
    const selector = new DynamicGraphContextSelector();
    const input = selectionInput();
    const bounded = selector.select({ ...input, maxInputTokens: 4_000 });
    expect(bounded.envelope.records.map((record) => record.kind)).toEqual(expect.arrayContaining(["working_spec", "run_objective"]));
    expect(bounded.envelope.budget.selectedRecords).toBeLessThanOrEqual(256);
    expect(bounded.envelope.budget.utf8Bytes).toBeLessThanOrEqual(bounded.envelope.budget.maxBytes);
    expect(bounded.envelope.budget.estimatedTokens).toBeLessThanOrEqual(bounded.envelope.budget.maxEstimatedTokens);
    expect(bounded.envelope.selection.budgetOmissionCount).toBeGreaterThan(0);

    expect(() => selector.select({ ...input, maxInputTokens: 1 }))
      .toThrowError(DynamicGraphContextBudgetError);
  });
});
