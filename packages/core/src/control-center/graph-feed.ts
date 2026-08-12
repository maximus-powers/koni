import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { GraphFeedTicketView, GraphFeedView, GraphNodeView } from "./view-model.js";
import type { KoniPalette } from "./markdown.js";
import { graphOutlineNodes, renderGraphView, type GraphRenderOptions } from "./graph-view.js";

/**
 * The Graph tab's live feed: the project graph (the plan) on the left, the active tickets
 * (the work) on the right, and the agents driving them (the cognition) nested inside each
 * ticket card. A shared gutter wires each ticket card to its graph nodes with routed lanes.
 *
 * Pure compositor: every frame derives from the immutable snapshot, so live updates are free.
 */

export interface GraphFeedFocus {
  column: "graph" | "tickets";
  /** Graph node cursor (outline order); meaningful when `column === "graph"`. */
  nodeIndex: number;
  /** Ticket-card cursor by id; the feed reorders live, so an index would drift. */
  ticketId?: string;
}

export interface GraphFeedInput {
  nodes: readonly GraphNodeView[];
  edges: readonly { source: string; target: string; relation?: string }[];
  feed: GraphFeedView;
  width: number;
  height: number;
  palette: KoniPalette;
  graphOptions?: GraphRenderOptions;
  /** Present only while the details panel is focused on the Graph tab. */
  focus?: GraphFeedFocus;
  /** Committed operator ticket selection: its lane always draws, without any grey-out. */
  selectedTicketId?: string;
  scroll: { graph: number; tickets: number };
  /** 0..3, from the component's 500ms work ticker; animates the working gears. */
  animationFrame: number;
}

export interface GraphFeedResult {
  /** Exactly `height` lines, each exactly `width` visible cells. */
  lines: string[];
  /** Viewport-relative node rows in outline order; -1 when scrolled out of view. */
  nodeLines: number[];
  /** Nodes in outline order; index them with the graph cursor. */
  orderedNodes: GraphNodeView[];
  /** Viewport-relative card title rows for pointer targets and cursor follow. */
  ticketLines: { id: string; row: number }[];
  /** Scrolls after cursor-follow clamping; the controller persists them. */
  resolvedScroll: { graph: number; tickets: number };
}

export interface GraphFeedLayout {
  graphW: number;
  gutterW: number;
  ticketsW: number;
  stacked: boolean;
}

/** Column split: tickets ~38% (20..40), gutter 3..5, graph the rest; stack below ~49 cells. */
export function feedLayout(width: number): GraphFeedLayout {
  const ticketsW = clamp(Math.round(width * 0.38), 20, 40);
  const gutterW = clamp(Math.floor(width / 16), 3, 5);
  const graphW = width - gutterW - ticketsW;
  if (graphW < 26) return { graphW: width, gutterW: 0, ticketsW: width, stacked: true };
  return { graphW, gutterW, ticketsW, stacked: false };
}

type LaneTier = "accent" | "border" | "dim";

interface CardGeometry {
  titleRow: number;
  junctionRow: number;
  lastRow: number;
}

interface TicketRow {
  /** Chrome glyph at column 0 (╭ │ ╰ or space); junctions rewrite it at compose time. */
  rail: string;
  /** Pre-styled text from column 1 on. */
  body: string;
  cardId?: string;
  focused?: boolean;
  dimmed?: boolean;
}

export function renderGraphFeed(input: GraphFeedInput): GraphFeedResult {
  const { width, height, palette, feed } = input;
  if (width < 8 || height < 1) {
    return {
      lines: Array.from({ length: Math.max(0, height) }, () => " ".repeat(Math.max(0, width))),
      nodeLines: [],
      orderedNodes: [],
      ticketLines: [],
      resolvedScroll: { graph: 0, tickets: 0 },
    };
  }
  const layout = feedLayout(width);

  const focusedTicket =
    input.focus?.column === "tickets"
      ? (feed.tickets.find((ticket) => ticket.id === input.focus?.ticketId) ?? feed.tickets[0])
      : undefined;
  const dimActive =
    input.focus !== undefined && (focusedTicket !== undefined || input.focus.column === "graph");

  // Lane priority: the focused ticket first, then the committed selection, then feed order.
  const laneXs = laneColumns(layout.gutterW);
  const laneOrder = dedupeTickets([
    ...(focusedTicket === undefined ? [] : [focusedTicket]),
    ...(input.selectedTicketId === undefined
      ? []
      : feed.tickets.filter((ticket) => ticket.id === input.selectedTicketId)),
    ...feed.tickets,
  ]).filter((ticket) => ticket.nodeIds.length > 0);
  const laneTickets = layout.stacked ? [] : laneOrder.slice(0, laneXs.length);
  const laneByTicket = new Map(laneTickets.map((ticket, index) => [ticket.id, laneXs[index]!]));

  // Graph column focus options. The cursor's node id resolves through the same outline order
  // the renderer (and the node modal) use, so connector highlighting agrees with the cursor.
  const clampedNodeIndex =
    input.focus?.column === "graph"
      ? clamp(input.focus.nodeIndex, 0, Math.max(0, input.nodes.length - 1))
      : undefined;
  const focusedNodeId =
    clampedNodeIndex === undefined
      ? undefined
      : graphOutlineNodes(input.nodes, input.edges, input.graphOptions ?? {})[clampedNodeIndex]?.id;
  const highlightNodeIds =
    focusedTicket === undefined
      ? undefined
      : new Set([...focusedTicket.nodeIds, ...focusedTicket.readNodeIds]);
  const graphView = renderGraphView(input.nodes, input.edges, layout.graphW, palette, {
    ...input.graphOptions,
    ...(clampedNodeIndex === undefined ? {} : { focusedIndex: clampedNodeIndex }),
    ...(highlightNodeIds === undefined ? {} : { highlightNodeIds }),
    ...(dimActive ? { dimNonNeighborhood: true } : {}),
    ...(layout.stacked
      ? {}
      : { rightConnectors: connectorMap(laneTickets, focusedTicket, focusedNodeId) }),
  });
  const graphLines =
    graphView.lines.length > 0
      ? graphView.lines
      : [palette.muted("The graph appears as planning lands.")];

  // Tickets column rows.
  const ticketRows = renderTicketCards(input, layout.ticketsW, focusedTicket, focusedNodeId);
  const cardRows = ticketRows.geometry;

  // Scroll resolution with cursor follow.
  const graphFollow =
    input.focus?.column === "graph" && clampedNodeIndex !== undefined
      ? (graphView.nodeLines[clampedNodeIndex] ?? 0)
      : undefined;
  const graphScroll =
    graphFollow === undefined
      ? clamp(input.scroll.graph, 0, Math.max(0, graphLines.length - height))
      : visibleOffset(input.scroll.graph, graphFollow, height);
  const ticketFollow =
    focusedTicket === undefined ? undefined : cardRows.get(focusedTicket.id)?.titleRow;
  const ticketScroll =
    ticketFollow === undefined
      ? clamp(input.scroll.tickets, 0, Math.max(0, ticketRows.rows.length - height))
      : visibleOffset(input.scroll.tickets, ticketFollow, height);

  // Gutter canvas.
  const gutter: ({ ch: string; tier: LaneTier } | undefined)[][] = Array.from(
    { length: height },
    () => Array.from({ length: layout.gutterW }, () => undefined),
  );
  const junctionRail = new Map<number, LaneTier>();
  if (!layout.stacked) {
    const rowByNodeId = new Map(
      graphView.orderedNodes.map((node, index) => [node.id, graphView.nodeLines[index]!]),
    );
    for (const ticket of laneTickets) {
      const laneX = laneByTicket.get(ticket.id)!;
      const tier = laneTier(ticket, focusedTicket, focusedNodeId, dimActive);
      const geometry = cardRows.get(ticket.id);
      if (geometry === undefined) continue;
      const junctionY = geometry.junctionRow - ticketScroll;
      const nodeYs = ticket.nodeIds
        .map((id) => rowByNodeId.get(id))
        .filter((row): row is number => row !== undefined)
        .map((row) => row - graphScroll);
      drawLane(gutter, layout.gutterW, height, laneX, nodeYs, junctionY, tier);
      if (junctionY >= 0 && junctionY < height) junctionRail.set(junctionY, tier);
    }
    // Overflow tickets keep their cards but get a dim stub instead of a lane.
    for (const ticket of laneOrder.slice(laneXs.length)) {
      const geometry = cardRows.get(ticket.id);
      if (geometry === undefined) continue;
      const junctionY = geometry.junctionRow - ticketScroll;
      if (junctionY < 0 || junctionY >= height) continue;
      for (let x = Math.max(0, layout.gutterW - 2); x < layout.gutterW; x += 1) {
        if (gutter[junctionY]![x] === undefined) gutter[junctionY]![x] = { ch: "┄", tier: "dim" };
      }
      if (!junctionRail.has(junctionY)) junctionRail.set(junctionY, "dim");
    }
  }

  // Compose.
  const lines: string[] = [];
  const clippedBelow = ticketRows.rows.length - ticketScroll - height;
  for (let y = 0; y < height; y += 1) {
    const graphLine = graphLines[y + graphScroll] ?? "";
    const graphPart = layout.stacked
      ? padAnsi(graphLine, width)
      : padAnsi(graphLine, layout.graphW);
    if (layout.stacked) {
      lines.push(graphPart);
      continue;
    }
    const gutterPart = paintGutterRow(gutter[y]!, palette);
    const row = ticketRows.rows[y + ticketScroll];
    let ticketPart: string;
    if (row === undefined) {
      ticketPart = " ".repeat(layout.ticketsW);
    } else {
      const junctionTier = junctionRail.get(y);
      const rail = paintRail(row, junctionTier, palette);
      const isLastVisible = y === height - 1;
      const body =
        isLastVisible && clippedBelow > 0
          ? padAnsi(
              palette.dim(` … ${clippedBelow} more line${clippedBelow === 1 ? "" : "s"}`),
              layout.ticketsW - 1,
            )
          : padAnsi(row.body, layout.ticketsW - 1);
      ticketPart = `${rail}${body}`;
    }
    lines.push(`${graphPart}${gutterPart}${ticketPart}`);
  }

  return {
    lines,
    nodeLines: graphView.nodeLines.map((row) => {
      const visible = row - graphScroll;
      return visible >= 0 && visible < height ? visible : -1;
    }),
    orderedNodes: graphView.orderedNodes,
    ticketLines: layout.stacked
      ? []
      : [...cardRows.entries()]
          .map(([id, geometry]) => ({ id, row: geometry.titleRow - ticketScroll }))
          .filter((entry) => entry.row >= 0 && entry.row < height),
    resolvedScroll: { graph: graphScroll, tickets: ticketScroll },
  };
}

function connectorMap(
  laneTickets: readonly GraphFeedTicketView[],
  focusedTicket: GraphFeedTicketView | undefined,
  focusedNodeId: string | undefined,
): ReadonlyMap<string, { highlighted: boolean }> {
  const map = new Map<string, { highlighted: boolean }>();
  for (const ticket of laneTickets) {
    const lit =
      (focusedTicket !== undefined && ticket.id === focusedTicket.id) ||
      (focusedNodeId !== undefined && ticket.nodeIds.includes(focusedNodeId));
    for (const nodeId of ticket.nodeIds) {
      const existing = map.get(nodeId);
      map.set(nodeId, { highlighted: (existing?.highlighted ?? false) || lit });
    }
  }
  return map;
}

function laneTier(
  ticket: GraphFeedTicketView,
  focusedTicket: GraphFeedTicketView | undefined,
  focusedNodeId: string | undefined,
  dimActive: boolean,
): LaneTier {
  if (focusedTicket !== undefined) return ticket.id === focusedTicket.id ? "accent" : "dim";
  if (focusedNodeId !== undefined) return ticket.nodeIds.includes(focusedNodeId) ? "accent" : "dim";
  return dimActive ? "dim" : "border";
}

/** Lane columns spaced two apart, nearest-to-cards first (the focused ticket claims it). */
function laneColumns(gutterW: number): number[] {
  const columns: number[] = [];
  for (let x = gutterW - 2; x >= 0; x -= 2) columns.push(x);
  if (columns.length === 0 && gutterW > 0) columns.push(0);
  return columns;
}

/** Route one ticket's lane: node rows enter from the left, the junction row exits right. */
function drawLane(
  gutter: ({ ch: string; tier: LaneTier } | undefined)[][],
  gutterW: number,
  height: number,
  laneX: number,
  nodeYs: readonly number[],
  junctionY: number,
  tier: LaneTier,
): void {
  const put = (y: number, x: number, ch: string): void => {
    if (y < 0 || y >= height || x < 0 || x >= gutterW) return;
    const row = gutter[y]!;
    const existing = row[x];
    if (existing === undefined || existing.ch === " ") {
      row[x] = { ch, tier };
      return;
    }
    if (existing.ch === ch) {
      // Same glyph: the brighter tier wins so a focused lane never greys at crossings.
      if (tier === "accent") existing.tier = "accent";
      return;
    }
    row[x] = { ch: "┼", tier: existing.tier === "accent" || tier === "accent" ? "accent" : tier };
  };

  const onscreen = nodeYs.filter((y) => y >= 0 && y < height);
  const above = nodeYs.some((y) => y < 0);
  const below = nodeYs.some((y) => y >= height);
  const junctionVisible = junctionY >= 0 && junctionY < height;

  // Horizontal runs stop one short of the lane; the joints get deliberate glyphs below.
  for (const y of onscreen) {
    if (y === junctionY) {
      for (let x = 0; x < gutterW; x += 1) put(y, x, "─");
      continue;
    }
    for (let x = 0; x < laneX; x += 1) put(y, x, "─");
  }
  if (junctionVisible && !onscreen.includes(junctionY)) {
    for (let x = laneX + 1; x < gutterW; x += 1) put(junctionY, x, "─");
  }

  const spanYs = [
    ...onscreen,
    ...(junctionVisible ? [junctionY] : []),
    ...(above ? [0] : []),
    ...(below ? [height - 1] : []),
  ];
  if (spanYs.length === 0) return;
  const top = Math.min(...spanYs);
  const bottom = Math.max(...spanYs);
  for (let y = top; y <= bottom; y += 1) {
    const isNode = onscreen.includes(y) && y !== junctionY;
    const isJunction = junctionVisible && y === junctionY && !onscreen.includes(junctionY);
    if (isNode || isJunction) continue;
    put(y, laneX, "│");
  }
  for (const y of onscreen) {
    if (y === junctionY) continue;
    const up = y > top;
    const down = y < bottom;
    put(y, laneX, up && down ? "┤" : down ? "╮" : "╯");
  }
  if (junctionVisible && !onscreen.includes(junctionY)) {
    const up = junctionY > top;
    const down = junctionY < bottom;
    put(junctionY, laneX, up && down ? "├" : down ? "╭" : "╰");
  }
  // Clip indicators for endpoints beyond the viewport always win their cell: a merged
  // crossing glyph would hide the fact that the lane continues off-screen.
  if (above && height > 0) gutter[0]![laneX] = { ch: "↟", tier };
  if (below && height > 0) gutter[height - 1]![laneX] = { ch: "↡", tier };
}

function paintGutterRow(
  row: readonly ({ ch: string; tier: LaneTier } | undefined)[],
  palette: KoniPalette,
): string {
  let output = "";
  let mode: LaneTier | "blank" = "blank";
  let segment = "";
  const flush = (): void => {
    if (segment.length === 0) return;
    output +=
      mode === "accent"
        ? palette.accent(segment)
        : mode === "dim"
          ? palette.dim(segment)
          : mode === "border"
            ? palette.border(segment)
            : segment;
    segment = "";
  };
  for (const cell of row) {
    const nextMode: LaneTier | "blank" = cell === undefined ? "blank" : cell.tier;
    if (nextMode !== mode) {
      flush();
      mode = nextMode;
    }
    segment += cell?.ch ?? " ";
  }
  flush();
  return output;
}

function paintRail(
  row: TicketRow,
  junctionTier: LaneTier | undefined,
  palette: KoniPalette,
): string {
  let glyph = row.rail;
  if (junctionTier !== undefined && row.cardId !== undefined) {
    glyph = glyph === "│" ? "┤" : glyph === "╭" ? "┬" : glyph === "╰" ? "┴" : glyph;
  }
  if (glyph === " ") return " ";
  const chrome =
    row.focused === true
      ? palette.borderActive
      : junctionTier === "accent"
        ? palette.accent
        : palette.border;
  return chrome(glyph);
}

function renderTicketCards(
  input: GraphFeedInput,
  ticketsW: number,
  focusedTicket: GraphFeedTicketView | undefined,
  focusedNodeId: string | undefined,
): { rows: TicketRow[]; geometry: Map<string, CardGeometry> } {
  const { palette, feed } = input;
  const rows: TicketRow[] = [];
  const geometry = new Map<string, CardGeometry>();
  const bodyW = ticketsW - 1;

  const gear = (working: boolean): string => {
    if (!working) return palette.muted("⚙");
    const styles = [palette.accent, palette.info, palette.success, palette.info] as const;
    return styles[clamp(input.animationFrame, 0, 3)]!("⚙");
  };

  // Run-level cognition header: compact lines, never cards (no graph target, no connectors).
  if (feed.runAgents.length > 0) {
    for (const agent of feed.runAgents.slice(0, 2)) {
      const text = ` ${agent.persona} · ${agent.model} · ${agent.thinking} · ${agent.tokens}`;
      rows.push({
        rail: " ",
        body: `${gear(agent.working)}${palette.muted(truncateToWidth(text, bodyW - 1, "…"))}`,
      });
    }
    if (feed.runAgents.length > 2)
      rows.push({ rail: " ", body: palette.dim(` +${feed.runAgents.length - 2} more`) });
    rows.push({ rail: " ", body: "" });
  }

  if (feed.tickets.length === 0) {
    rows.push({ rail: " ", body: palette.muted("◦ No active work") });
    const counts = [
      ...(feed.queuedCount > 0 ? [`${feed.queuedCount} queued`] : []),
      ...(feed.blockedCount > 0 ? [`${feed.blockedCount} blocked`] : []),
    ];
    if (counts.length > 0) rows.push({ rail: " ", body: palette.dim(`  ${counts.join(" · ")}`) });
    return { rows, geometry };
  }

  feed.tickets.forEach((ticket, index) => {
    const focused = focusedTicket !== undefined && ticket.id === focusedTicket.id;
    const neighbor = focusedNodeId !== undefined && ticket.nodeIds.includes(focusedNodeId);
    const dimmed =
      (focusedTicket !== undefined && !focused) || (focusedNodeId !== undefined && !neighbor);
    const bar =
      ticket.tone === "interrupted"
        ? palette.warning("▍")
        : ticket.tone === "review"
          ? palette.info("▍")
          : palette.accent("▍");
    const barGlyph = dimmed ? palette.dim("▍") : bar;
    const text = (value: string): string =>
      dimmed ? palette.dim(value) : focused ? palette.selected(value) : palette.text(value);
    const meta = (value: string): string => (dimmed ? palette.dim(value) : palette.muted(value));

    const titleRow = rows.length;
    const chip = ticket.offGraphCount > 0 ? ` +${ticket.offGraphCount} off-graph` : "";
    const titleBudget = Math.max(4, bodyW - 3 - (chip.length > 0 ? chip.length : 0));
    if (focused) {
      const segments = wrapTextWithAnsi(ticket.title, titleBudget).slice(0, 2);
      rows.push({
        rail: "╭",
        body: ` ${barGlyph} ${text(segments[0] ?? ticket.title)}${chip.length > 0 ? palette.dim(chip) : ""}`,
        cardId: ticket.id,
        focused,
        dimmed,
      });
      for (const segment of segments.slice(1)) {
        rows.push({ rail: "│", body: `   ${text(segment)}`, cardId: ticket.id, focused, dimmed });
      }
    } else {
      rows.push({
        rail: "╭",
        body: ` ${barGlyph} ${text(truncateToWidth(ticket.title, titleBudget, "…"))}${chip.length > 0 ? palette.dim(chip) : ""}`,
        cardId: ticket.id,
        focused,
        dimmed,
      });
    }

    const inline = ticketsW >= 34;
    const agents = ticket.agents.slice(0, 3);
    let junctionRow = rows.length;
    agents.forEach((agent, agentIndex) => {
      if (agentIndex === 0) junctionRow = rows.length;
      if (inline) {
        const line = ` ${agent.persona} · ${agent.model} · ${agent.thinking} · ${agent.tokens}`;
        rows.push({
          rail: "│",
          body: ` ${gear(agent.working && !dimmed)}${meta(truncateToWidth(line, bodyW - 3, "…"))}`,
          cardId: ticket.id,
          focused,
          dimmed,
        });
      } else {
        rows.push({
          rail: "│",
          body: ` ${gear(agent.working && !dimmed)} ${meta(truncateToWidth(agent.persona, bodyW - 4, "…"))}`,
          cardId: ticket.id,
          focused,
          dimmed,
        });
        rows.push({
          rail: "│",
          body: `   ${meta(truncateToWidth(`${agent.model} · ${agent.thinking} · ${agent.tokens}`, bodyW - 4, "…"))}`,
          cardId: ticket.id,
          focused,
          dimmed,
        });
      }
    });
    if (ticket.agents.length > 3) {
      rows.push({
        rail: "│",
        body: palette.dim(`   +${ticket.agents.length - 3} more`),
        cardId: ticket.id,
        focused,
        dimmed,
      });
    }
    if (agents.length === 0) {
      const label = ticket.status;
      rows.push({
        rail: "│",
        body: `   ${meta(truncateToWidth(label, bodyW - 4, "…"))}`,
        cardId: ticket.id,
        focused,
        dimmed,
      });
      junctionRow = rows.length - 1;
    }
    rows.push({ rail: "╰", body: "", cardId: ticket.id, focused, dimmed });
    const lastRow = rows.length - 1;
    geometry.set(ticket.id, {
      titleRow,
      junctionRow: Math.min(junctionRow, lastRow),
      lastRow,
    });
    if (index + 1 < feed.tickets.length) rows.push({ rail: " ", body: "" });
  });

  return { rows, geometry };
}

function dedupeTickets(tickets: readonly GraphFeedTicketView[]): GraphFeedTicketView[] {
  const seen = new Set<string>();
  const output: GraphFeedTicketView[] = [];
  for (const ticket of tickets) {
    if (seen.has(ticket.id)) continue;
    seen.add(ticket.id);
    output.push(ticket);
  }
  return output;
}

/** Same follow rule as the panel scrollers: keep the selected line inside the window. */
function visibleOffset(current: number, selectedLine: number, capacity: number): number {
  if (selectedLine < current) return selectedLine;
  if (selectedLine >= current + capacity) return Math.max(0, selectedLine - capacity + 2);
  return current;
}

function padAnsi(line: string, width: number): string {
  const visible = visibleWidth(line);
  if (visible >= width) return truncateToWidth(line, width, "…");
  return `${line}${" ".repeat(width - visible)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
