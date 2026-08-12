import { describe, expect, it } from "vitest";
import {
  GraphSchema,
  GraphValidationError,
  TypedGraph,
  type GraphNode,
} from "../src/graph/model.js";
import { canonicalHash } from "../src/shared/canonical.js";

const schema = new GraphSchema({
  nodeTypes: [
    {
      id: "claim",
      description: "A bounded empirical claim.",
      statuses: ["active", "satisfied"],
      initial_status: "active",
      fields: { statement: { type: "string", required: true } },
    },
    {
      id: "experiment",
      description: "An experiment that tests a claim.",
      statuses: ["planned", "complete"],
      initial_status: "planned",
      fields: { command: { type: "list", required: true, items: { type: "string" } } },
    },
  ],
  edgeTypes: [
    {
      source: "experiment",
      relation: "tests",
      inverse: "tested_by",
      bidirectional: true,
      targets: ["claim"],
      min: 1,
    },
  ],
});

describe("typed graph and canonical bidirectional relationships", () => {
  it("stores one canonical edge while traversing both directions", () => {
    const graph = new TypedGraph(schema, [claim(), experiment(["claim-a"])]);
    expect(graph.edges()).toEqual([
      { source: "experiment-a", relation: "tests", target: "claim-a" },
    ]);
    expect(graph.neighbors("claim-a", "tested_by").map((node) => node.id)).toEqual([
      "experiment-a",
    ]);
    expect(graph.neighbors("experiment-a", "tests").map((node) => node.id)).toEqual(["claim-a"]);
  });

  it("normalizes an inverse delta to the canonical edge instead of creating a reciprocal duplicate", () => {
    const graph = new TypedGraph(schema, [claim()]);
    const applied = graph.apply({
      protocol: "koni.graph-delta.v1",
      expectedGraphHash: graph.hash,
      upsertNodes: [{ node: experiment([]), expectedNodeHash: null }],
      deleteNodes: [],
      addEdges: [{ source: "claim-a", relation: "tested_by", target: "experiment-a" }],
      removeEdges: [],
    });
    expect(applied.graph.edges()).toEqual([
      { source: "experiment-a", relation: "tests", target: "claim-a" },
    ]);
  });

  it("reports an edge-only delta as a modification of its canonical source node", () => {
    const graph = new TypedGraph(schema, [
      claim(),
      { ...claim(), id: "claim-b", title: "Claim B" },
      experiment(["claim-a"]),
    ]);

    const applied = graph.apply({
      protocol: "koni.graph-delta.v1",
      expectedGraphHash: graph.hash,
      upsertNodes: [],
      deleteNodes: [],
      addEdges: [{ source: "claim-b", relation: "tested_by", target: "experiment-a" }],
      removeEdges: [],
    });

    expect(applied.graph.edges()).toEqual([
      { source: "experiment-a", relation: "tests", target: "claim-a" },
      { source: "experiment-a", relation: "tests", target: "claim-b" },
    ]);
    expect(applied.changes).toEqual([
      {
        kind: "modified",
        nodeId: "experiment-a",
        nodeType: "experiment",
        title: "Experiment A",
      },
    ]);
  });

  it("rejects redundant inverse storage and stale deltas", () => {
    const badClaim = claim();
    badClaim.edges.tested_by = ["experiment-a"];
    expect(() => new TypedGraph(schema, [badClaim, experiment(["claim-a"])])).toThrowError(
      GraphValidationError,
    );
    const graph = new TypedGraph(schema, [claim(), experiment(["claim-a"])]);
    expect(() =>
      graph.apply({
        protocol: "koni.graph-delta.v1",
        expectedGraphHash: `sha256:${"0".repeat(64)}`,
        upsertNodes: [],
        deleteNodes: [],
        addEdges: [],
        removeEdges: [],
      }),
    ).toThrow(/stale/);
  });

  it("rebases a delta authored against an older whole-graph hash when its own nodes are untouched", () => {
    // Simulate a disjoint sibling ticket moving the whole-graph hash: the worker authored its
    // delta against `staleHash`, but by settlement the committed graph added an unrelated node.
    const base = new TypedGraph(schema, [claim()]);
    const staleHash = base.hash;
    const current = base.apply({
      protocol: "koni.graph-delta.v1",
      expectedGraphHash: staleHash,
      upsertNodes: [
        { node: { ...claim(), id: "claim-b", title: "Claim B" }, expectedNodeHash: null },
      ],
      deleteNodes: [],
      addEdges: [],
      removeEdges: [],
    }).graph;
    expect(current.hash).not.toBe(staleHash);
    const staleDelta = {
      protocol: "koni.graph-delta.v1" as const,
      expectedGraphHash: staleHash,
      upsertNodes: [{ node: experiment([]), expectedNodeHash: null }],
      deleteNodes: [],
      addEdges: [{ source: "claim-a", relation: "tested_by", target: "experiment-a" }],
      removeEdges: [],
    };
    // Strict apply refuses the moved hash; rebase applies it because the worker's own nodes
    // (experiment-a add, its edge to claim-a) are untouched by the sibling's claim-b add.
    expect(() => current.apply(staleDelta)).toThrow(/stale/);
    const rebased = current.applyRebased(staleDelta);
    expect(rebased.graph.node("experiment-a")?.id).toBe("experiment-a");
    expect(rebased.graph.node("claim-b")?.id).toBe("claim-b");
    expect(rebased.graph.edges()).toContainEqual({
      source: "experiment-a",
      relation: "tests",
      target: "claim-a",
    });
  });

  it("still rejects a rebased delta when a node it modifies changed underneath it", () => {
    const base = new TypedGraph(schema, [claim()]);
    const staleHash = base.hash;
    const staleNodeHash = canonicalHash(base.node("claim-a")!);
    // The worker modifies claim-a; meanwhile the committed graph already changed claim-a's spec.
    const current = base.apply({
      protocol: "koni.graph-delta.v1",
      expectedGraphHash: staleHash,
      upsertNodes: [
        {
          node: { ...claim(), spec: { statement: "A changed by someone else" } },
          expectedNodeHash: staleNodeHash,
        },
      ],
      deleteNodes: [],
      addEdges: [],
      removeEdges: [],
    }).graph;
    const conflictingDelta = {
      protocol: "koni.graph-delta.v1" as const,
      expectedGraphHash: staleHash,
      upsertNodes: [
        {
          node: { ...claim(), spec: { statement: "A changed by the worker" } },
          expectedNodeHash: staleNodeHash,
        },
      ],
      deleteNodes: [],
      addEdges: [],
      removeEdges: [],
    };
    // Rebase re-targets the whole-graph hash but the per-node expectedNodeHash CAS still fires.
    expect(() => current.applyRebased(conflictingDelta)).toThrow(/node changed/);
  });
});

function claim(): GraphNode {
  return {
    schema_version: "1.0",
    id: "claim-a",
    type: "claim",
    title: "Claim A",
    status: "active",
    spec: { statement: "A is true" },
    edges: {},
    annotations: {},
  };
}

function experiment(targets: string[]): GraphNode {
  return {
    schema_version: "1.0",
    id: "experiment-a",
    type: "experiment",
    title: "Experiment A",
    status: "planned",
    spec: { command: ["npm", "test"] },
    edges: { tests: targets },
    annotations: {},
  };
}
