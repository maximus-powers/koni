import { describe, expect, it } from "vitest";
import { graphOutlineNodes, renderGraphView } from "../src/control-center/graph-view.js";
import { plainKoniPalette, type KoniPalette } from "../src/control-center/markdown.js";

const NODES = [
  {
    id: "claim",
    type: "claim",
    marker: "C",
    label: "Cache policy",
    fullTitle: "Cache policy",
    muted: false,
  },
  {
    id: "experiment",
    type: "experiment",
    marker: "E",
    label: "Measure cache",
    fullTitle: "Measure cache",
    muted: false,
  },
  {
    id: "gate",
    type: "gate",
    marker: "G",
    label: "Bound regression",
    fullTitle: "Bound regression",
    muted: true,
  },
];

const EDGES = [
  { source: "claim", relation: "tested_by", target: "experiment" },
  { source: "experiment", relation: "verified_by", target: "gate" },
  { source: "claim", relation: "constrains", target: "gate" },
];

/** Tags every style so per-cell paint decisions are assertable through the ANSI-free seam. */
function tagPalette(): KoniPalette {
  return {
    ...plainKoniPalette,
    accent: (value) => `«A:${value}»`,
    text: (value) => `«T:${value}»`,
    muted: (value) => `«M:${value}»`,
    dim: (value) => `«D:${value}»`,
    border: (value) => `«B:${value}»`,
  };
}

describe("graph view rendering", () => {
  it("turns secondary-relationship lanes with clean corner glyphs instead of crossings", () => {
    const lines = renderGraphView(NODES, EDGES, 46, plainKoniPalette).lines;
    const text = lines.join("\n");
    expect(text).toContain("╮");
    expect(text).toContain("╯");
    // The joint between the horizontal stub and the lane is a corner, never a bare crossing.
    expect(text).toMatch(/─╮/u);
  });

  it("exposes the outline order used by the node cursor", () => {
    const ordered = graphOutlineNodes(NODES, EDGES);
    expect(ordered.map((node) => node.id)).toEqual(["claim", "experiment", "gate"]);
    const view = renderGraphView(NODES, EDGES, 46, plainKoniPalette);
    expect(view.orderedNodes.map((node) => node.id)).toEqual(ordered.map((node) => node.id));
    expect(view.nodeLines).toHaveLength(ordered.length);
  });

  it("highlights the focused node's relationships and lifts its neighbors out of the muted tier", () => {
    const focused = renderGraphView(NODES, EDGES, 46, tagPalette(), { focusedIndex: 0 });
    const text = focused.lines.join("\n");
    // The focused claim's secondary lane toward the gate adopts the accent tone.
    expect(text).toMatch(/«A:[^»]*[─│╮╯]/u);
    // The gate is a neighbor of the focused claim: its title paints as normal text even
    // though the node itself is muted. (Titles segment per cell, so match the first word.)
    expect(text).toMatch(/«T:Bound»/u);
    const unfocused = renderGraphView(NODES, EDGES, 46, tagPalette()).lines.join("\n");
    expect(unfocused).toMatch(/«D:Bound»/u);
    expect(unfocused).not.toMatch(/«A:[^»]*[─│╮╯]/u);
  });

  it("lifts an external highlight neighborhood and lights the edges joining its members", () => {
    const view = renderGraphView(NODES, EDGES, 46, tagPalette(), {
      highlightNodeIds: new Set(["claim", "gate"]),
    });
    const text = view.lines.join("\n");
    // Both highlighted titles leave their muted/dim tiers.
    expect(text).toMatch(/«T:Cache»/u);
    expect(text).toMatch(/«T:Bound»/u);
    // The claim→gate secondary lane joins two highlighted nodes, so it lights up.
    expect(text).toMatch(/«A:[^»]*[─│╮╯]/u);
    // The experiment is outside the set and keeps its ordinary title tier.
    expect(text).toMatch(/«M:Measure»/u);
  });

  it("dims every node outside the focus neighborhood in grey-out mode", () => {
    // Focus the gate (outline index 2): the experiment and claim are neighbors via
    // verified_by/constrains, so nothing dims in this tight fixture. Focus the claim
    // instead and add an isolated node to observe the dim tier.
    const nodes = [
      ...NODES,
      {
        id: "orphan",
        type: "report",
        marker: "R",
        label: "Weekly report",
        fullTitle: "Weekly report",
        muted: false,
      },
    ];
    const view = renderGraphView(nodes, EDGES, 46, tagPalette(), {
      focusedIndex: 0,
      dimNonNeighborhood: true,
    });
    const text = view.lines.join("\n");
    // The orphan is outside the claim's neighborhood: title AND marker drop to dim.
    expect(text).toMatch(/«D:Weekly»/u);
    expect(text).toMatch(/«D:\[report\]»|«D:\[rp\]»/u);
    // Neighbors keep their lift; the focused title keeps its selected overlay.
    expect(text).toMatch(/«T:Measure»/u);
    const plain = renderGraphView(nodes, EDGES, 46, tagPalette(), { focusedIndex: 0 });
    expect(plain).toBeDefined();
    expect(plain.lines.join("\n")).not.toMatch(/«D:Weekly»/u);
  });

  it("extends right connectors to the edge, crossing lanes as ┼ and highlighting when asked", () => {
    const connectors = new Map([
      ["claim", { highlighted: true }],
      ["gate", { highlighted: false }],
    ]);
    const plain = renderGraphView(NODES, EDGES, 46, plainKoniPalette, {
      rightConnectors: connectors,
    });
    // Both wired rows reach the right edge with a rail; unwired rows stay untouched.
    expect(plain.lines[plain.nodeLines[0]!]).toMatch(/─$/u);
    expect(plain.lines[plain.nodeLines[2]!]).toMatch(/─$/u);
    expect(plain.lines[plain.nodeLines[1]!]).not.toMatch(/─$/u);
    // The secondary lane's corner rows are preserved next to the new rails.
    expect(plain.lines.join("\n")).toContain("╮");
    expect(plain.lines.join("\n")).toContain("╯");

    const tagged = renderGraphView(NODES, EDGES, 46, tagPalette(), {
      rightConnectors: connectors,
    });
    const claimLine = tagged.lines[tagged.nodeLines[0]!]!;
    const gateLine = tagged.lines[tagged.nodeLines[2]!]!;
    // The claim's rail is highlighted (accent); the gate's stays border grey.
    expect(claimLine).toMatch(/«A:[^»]*─/u);
    expect(gateLine).not.toMatch(/«A:[^»]*─/u);
    expect(gateLine).toMatch(/«B:[^»]*─/u);
  });
});
