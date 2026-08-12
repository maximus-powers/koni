import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  feedLayout,
  renderGraphFeed,
  type GraphFeedInput,
} from "../src/control-center/graph-feed.js";
import { plainKoniPalette, type KoniPalette } from "../src/control-center/markdown.js";
import type { GraphFeedView } from "../src/control-center/view-model.js";

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
  {
    id: "orphan",
    type: "report",
    marker: "R",
    label: "Weekly report",
    fullTitle: "Weekly report",
    muted: false,
  },
];

const EDGES = [
  { source: "claim", relation: "tested_by", target: "experiment" },
  { source: "experiment", relation: "verified_by", target: "gate" },
];

const AGENT = {
  id: "attempt-one",
  persona: "Implementer",
  model: "GPT-5.6 Terra",
  thinking: "high",
  tokens: "48K",
  working: true,
};

function feed(): GraphFeedView {
  return {
    tickets: [
      {
        id: "t1",
        title: "Wire cache policy",
        status: "Running",
        tone: "running",
        nodeIds: ["claim", "experiment"],
        readNodeIds: [],
        offGraphCount: 0,
        agents: [AGENT],
      },
      {
        id: "t2",
        title: "Migrate gate",
        status: "Review",
        tone: "review",
        nodeIds: ["gate"],
        readNodeIds: [],
        offGraphCount: 0,
        agents: [{ ...AGENT, id: "attempt-two", persona: "Verifier", working: false }],
      },
    ],
    runAgents: [],
    queuedCount: 0,
    blockedCount: 0,
  };
}

function baseInput(overrides: Partial<GraphFeedInput> = {}): GraphFeedInput {
  return {
    nodes: NODES,
    edges: EDGES,
    feed: feed(),
    width: 80,
    height: 20,
    palette: plainKoniPalette,
    scroll: { graph: 0, tickets: 0 },
    animationFrame: 0,
    ...overrides,
  };
}

/** Tags every style so per-cell paint decisions are assertable through the ANSI-free seam. */
function tagPalette(): KoniPalette {
  return {
    ...plainKoniPalette,
    accent: (value) => `«A:${value}»`,
    text: (value) => `«T:${value}»`,
    muted: (value) => `«M:${value}»`,
    dim: (value) => `«D:${value}»`,
    border: (value) => `«B:${value}»`,
    selected: (value) => `«S:${value}»`,
    info: (value) => `«I:${value}»`,
    warning: (value) => `«W:${value}»`,
    success: (value) => `«G:${value}»`,
  };
}

describe("graph feed layout", () => {
  it("splits the tab into graph, gutter, and tickets columns at representative widths", () => {
    expect(feedLayout(104)).toEqual({ graphW: 59, gutterW: 5, ticketsW: 40, stacked: false });
    expect(feedLayout(64)).toEqual({ graphW: 36, gutterW: 4, ticketsW: 24, stacked: false });
    expect(feedLayout(52)).toEqual({ graphW: 29, gutterW: 3, ticketsW: 20, stacked: false });
    expect(feedLayout(40).stacked).toBe(true);
  });

  it("renders exactly height lines of exactly width cells with both columns populated", () => {
    const view = renderGraphFeed(baseInput());
    expect(view.lines).toHaveLength(20);
    for (const line of view.lines) expect(visibleWidth(line)).toBe(80);
    const text = view.lines.join("\n");
    // Graph labels on the left, card titles on the right.
    expect(text).toContain("Cache policy");
    expect(text).toContain("Wire cache policy");
    const layout = feedLayout(80);
    const firstCardLine = view.lines.find((line) => line.includes("Wire cache policy"))!;
    expect(firstCardLine.indexOf("Wire cache policy")).toBeGreaterThan(layout.graphW);
  });
});

describe("graph feed connectors", () => {
  it("wires each lane ticket from its node rows to its card junction", () => {
    const view = renderGraphFeed(baseInput());
    const layout = feedLayout(80);
    const text = view.lines.join("\n");
    // Node rows extend rails into the gutter.
    const claimRow = view.lines[view.nodeLines[0]!]!;
    expect(claimRow.slice(layout.graphW - 2, layout.graphW + layout.gutterW)).toContain("─");
    // Card rails carry a junction tee where the lane enters.
    const t1 = view.ticketLines.find((entry) => entry.id === "t1")!;
    const junctionLine = view.lines[t1.row + 1]!;
    expect(junctionLine).toContain("┤");
    // Two lanes render at two distinct gutter columns.
    expect(text).toContain("╮");
    expect(text).toContain("╰");
  });

  it("marks lanes clipped by the viewport with vertical arrows", () => {
    const input = baseInput({
      feed: { ...feed(), tickets: [feed().tickets[1]!] },
      height: 2,
    });
    const view = renderGraphFeed(input);
    // The gate node row sits below a 2-row viewport; its lane clips with a down arrow.
    expect(view.lines.join("\n")).toContain("↡");
  });
});

describe("graph feed focus and grey-out", () => {
  it("highlights the focused ticket's neighborhood and dims everything else", () => {
    const view = renderGraphFeed(
      baseInput({
        palette: tagPalette(),
        focus: { column: "tickets", nodeIndex: 0, ticketId: "t2" },
      }),
    );
    const text = view.lines.join("\n");
    // The focused card title renders selected; the other card dims.
    expect(text).toMatch(/«S:Migrate gate»/u);
    expect(text).toMatch(/«D:Wire cache policy»/u);
    // Its wired node lifts out of the muted tier; unrelated nodes drop to dim.
    // (Tag inflation can clip the closing guillemet at the column edge.)
    expect(text).toMatch(/«T:Bound/u);
    expect(text).toMatch(/«D:Cache»/u);
    expect(text).toMatch(/«D:Weekly»/u);
    // Its lane paints accent.
    expect(text).toMatch(/«A:[^»]*[─│╮╯╰┤]/u);
  });

  it("lifts cards wired to the focused graph node and dims the rest", () => {
    const gateIndex = renderGraphFeed(baseInput()).orderedNodes.findIndex(
      (node) => node.id === "gate",
    );
    const view = renderGraphFeed(
      baseInput({
        palette: tagPalette(),
        focus: { column: "graph", nodeIndex: gateIndex },
      }),
    );
    const text = view.lines.join("\n");
    // The gate-wired card keeps its normal title; the unrelated card dims.
    expect(text).toMatch(/«T:Migrate gate»/u);
    expect(text).toMatch(/«D:Wire cache policy»/u);
    // Non-neighborhood nodes dim.
    expect(text).toMatch(/«D:Weekly»/u);
  });

  it("renders without any grey-out when unfocused", () => {
    const view = renderGraphFeed(baseInput({ palette: tagPalette() }));
    const text = view.lines.join("\n");
    expect(text).not.toMatch(/«S:/u);
    expect(text).toMatch(/«T:Wire cache policy»/u);
    expect(text).toMatch(/«T:Migrate gate»/u);
    expect(text).not.toMatch(/«D:Wire cache policy»/u);
  });
});

describe("graph feed states", () => {
  it("keeps the tickets column alive when no graph has landed yet", () => {
    const view = renderGraphFeed(baseInput({ nodes: [], edges: [] }));
    const text = view.lines.join("\n");
    expect(text).toContain("The graph appears as planning lands.");
    expect(text).toContain("Wire cache policy");
  });

  it("shows the quiet empty state with queued and blocked counts", () => {
    const view = renderGraphFeed(
      baseInput({
        feed: { tickets: [], runAgents: [], queuedCount: 3, blockedCount: 1 },
      }),
    );
    const text = view.lines.join("\n");
    expect(text).toContain("◦ No active work");
    expect(text).toContain("3 queued · 1 blocked");
  });

  it("lists active run-level cognition as a compact header line", () => {
    const view = renderGraphFeed(
      baseInput({
        width: 100,
        feed: {
          ...feed(),
          runAgents: [{ ...AGENT, id: "attempt-lead", persona: "Lead", tokens: "112K" }],
        },
      }),
    );
    expect(view.lines.join("\n")).toContain("Lead · GPT-5.6 Terra · high · 112K");
  });

  it("falls back to a full-width graph below the supported width", () => {
    const view = renderGraphFeed(baseInput({ width: 40 }));
    for (const line of view.lines) expect(visibleWidth(line)).toBe(40);
    expect(view.lines.join("\n")).toContain("Cache policy");
    expect(view.ticketLines).toEqual([]);
  });

  it("animates working gears with the ticker frame and keeps queued gears static", () => {
    const frame0 = renderGraphFeed(baseInput({ palette: tagPalette() })).lines.join("\n");
    const frame1 = renderGraphFeed(
      baseInput({ palette: tagPalette(), animationFrame: 1 }),
    ).lines.join("\n");
    expect(frame0).toMatch(/«A:⚙»/u);
    expect(frame1).toMatch(/«I:⚙»/u);
    // The queued verifier's gear stays muted in both frames.
    expect(frame0).toMatch(/«M:⚙»/u);
    expect(frame1).toMatch(/«M:⚙»/u);
  });
});
