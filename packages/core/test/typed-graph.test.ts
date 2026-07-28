import { describe, expect, it } from "vitest";
import {
  GraphSchema,
  GraphValidationError,
  TypedGraph,
  type GraphNode,
} from "../src/graph/model.js";

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
