import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { GraphNodeView } from "./view-model.js";
import type { KoniPalette } from "./markdown.js";
import {
  cockpitBooleanOption,
  cockpitStringArrayMapOption,
  cockpitStringArrayOption,
  cockpitStringMapOption,
  type CompiledCockpitView,
} from "./cockpit-config.js";

interface GraphDisplayEdge {
  source: string;
  target: string;
  relation: string;
}

export interface GraphRenderOptions {
  hierarchy?: readonly string[];
  primaryParentPreferences?: Readonly<Record<string, readonly string[]>>;
  reverseDisplayEdges?: Readonly<Record<string, string>>;
  showTitles?: boolean;
}

export interface GraphFocusOptions {
  focusedIndex?: number;
  /** External focus neighborhood (a focused ticket's nodes): titles lift, mutual edges light. */
  highlightNodeIds?: ReadonlySet<string>;
  /** Grey-out mode: nodes outside the focus neighborhood drop marker color and title tier. */
  dimNonNeighborhood?: boolean;
  /** Node ids whose rows extend a `─` run to the right edge (the feed gutter attaches there). */
  rightConnectors?: ReadonlyMap<string, { highlighted: boolean }>;
}

export function configuredGraphOptions(view: CompiledCockpitView | undefined): GraphRenderOptions {
  const hierarchy = cockpitStringArrayOption(view, "hierarchy");
  const primaryParentPreferences = cockpitStringArrayMapOption(view, "primary_parent_preferences");
  const reverseDisplayEdges = cockpitStringMapOption(view, "reverse_display_edges");
  return {
    ...(hierarchy === undefined ? {} : { hierarchy }),
    ...(primaryParentPreferences === undefined ? {} : { primaryParentPreferences }),
    ...(reverseDisplayEdges === undefined ? {} : { reverseDisplayEdges }),
    showTitles: cockpitBooleanOption(view, "show_titles", true),
  };
}

interface NestedGraphRow {
  node: GraphNodeView;
  structural: string;
  prefix: string;
  isRoot: boolean;
  isLast: boolean;
  /** Primary-outline parent id when this row was emitted under an incoming edge. */
  parentId?: string;
  markerStart: number;
  markerEnd: number;
  titleStart: number;
}

interface ExpandedGraphRow {
  structural: string;
  nodeRow?: NestedGraphRow;
  /** Cursor-focused title overlay: pre-truncated text painted in place of the short label. */
  focusTitle?: { start: number; end: number; text: string };
  /** Structural cells to emphasize because they belong to the focused node's relationships. */
  structuralHighlight?: { start: number; end: number };
}

export interface GraphViewResult {
  lines: string[];
  /** Display line index of each node row, in outline order (parallel to the node cursor). */
  nodeLines: number[];
  /** Nodes in the same outline order as `nodeLines`; index them with the graph cursor. */
  orderedNodes: GraphNodeView[];
}

interface GraphOutline {
  rows: NestedGraphRow[];
  children: Map<string, GraphDisplayEdge[]>;
  primaryByChild: Map<string, GraphDisplayEdge>;
  secondary: GraphDisplayEdge[];
  byId: Map<string, GraphNodeView>;
}

/** The exact node order the graph panel displays; index it with the panel's node cursor. */
export function graphOutlineNodes(
  nodes: readonly GraphNodeView[],
  edges: readonly { source: string; target: string; relation?: string }[],
  options: GraphRenderOptions = {},
): GraphNodeView[] {
  if (nodes.length === 0) return [];
  return buildGraphOutline(nodes, edges, Number.MAX_SAFE_INTEGER, options).rows.map(
    (row) => row.node,
  );
}

function buildGraphOutline(
  nodes: readonly GraphNodeView[],
  edges: readonly { source: string; target: string; relation?: string }[],
  width: number,
  options: GraphRenderOptions,
): GraphOutline {
  const compareNodes = (left: GraphNodeView, right: GraphNodeView): number =>
    graphNodeCompare(left, right, options.hierarchy);
  const ordered = [...nodes].sort(compareNodes);
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const normalized = normalizeGraphEdges(edges, byId, options.reverseDisplayEdges, compareNodes);
  const primaryByChild = choosePrimaryGraphEdges(
    normalized,
    byId,
    compareNodes,
    options.primaryParentPreferences,
  );
  const primaryKeys = new Set([...primaryByChild.values()].map(graphEdgeKey));
  const secondary = normalized.filter((edge) => !primaryKeys.has(graphEdgeKey(edge)));
  const children = new Map<string, GraphDisplayEdge[]>();
  for (const edge of primaryByChild.values()) {
    const list = children.get(edge.source) ?? [];
    list.push(edge);
    children.set(edge.source, list);
  }
  for (const list of children.values()) {
    list.sort(
      (left, right) =>
        compareNodes(byId.get(left.target)!, byId.get(right.target)!) ||
        left.relation.localeCompare(right.relation),
    );
  }

  const rows: NestedGraphRow[] = [];
  const emitted = new Set<string>();
  const append = (
    node: GraphNodeView,
    rawPrefix: string,
    isLast: boolean,
    isRoot: boolean,
    incoming?: GraphDisplayEdge,
  ): void => {
    if (emitted.has(node.id)) return;
    emitted.add(node.id);
    const prefix = compactGraphPrefix(rawPrefix, width);
    const branch = isRoot ? "" : isLast ? "└─" : "├─";
    const edgeBranch = isRoot
      ? ""
      : `${branch}<${formatGraphRelation(incoming?.relation ?? "related")}>─`;
    const badge = graphBadge(node.type, width);
    const structural = `${prefix}${edgeBranch}${badge}`;
    const markerStart = visibleWidth(`${prefix}${edgeBranch}`);
    const markerEnd = markerStart + visibleWidth(badge);
    rows.push({
      node,
      structural,
      prefix,
      isRoot,
      isLast,
      ...(incoming === undefined ? {} : { parentId: incoming.source }),
      markerStart,
      markerEnd,
      titleStart: markerEnd + 1,
    });
    const outgoing = children.get(node.id) ?? [];
    const childPrefix = isRoot ? "" : `${prefix}${isLast ? "   " : "│  "}`;
    outgoing.forEach((edge, index) => {
      const child = byId.get(edge.target);
      if (child !== undefined)
        append(child, childPrefix, index + 1 === outgoing.length, false, edge);
    });
  };

  const roots = ordered.filter((node) => !primaryByChild.has(node.id));
  const rootList = roots.length === 0 ? ordered.slice(0, 1) : roots;
  rootList.forEach((node, index) => append(node, "", index + 1 === rootList.length, true));
  for (const node of ordered) append(node, "", true, true);
  return { rows, children, primaryByChild, secondary, byId };
}

/**
 * Autoresearch-v2 relationship outline with Koni's one deliberate addition: concise titles are
 * painted after every connector, so title letters replace a line cell while topology continues
 * underneath. Primary relationships form the nested outline; secondary relationships get their
 * own labeled endpoint rows and shared vertical lanes.
 */
export function renderGraphLines(
  nodes: readonly GraphNodeView[],
  edges: readonly { source: string; target: string; relation?: string }[],
  width: number,
  palette: KoniPalette,
  options: GraphRenderOptions = {},
): string[] {
  return renderGraphView(nodes, edges, width, palette, options).lines;
}

/** Full graph projection: rendered lines plus the node-cursor line map. */
export function renderGraphView(
  nodes: readonly GraphNodeView[],
  edges: readonly { source: string; target: string; relation?: string }[],
  width: number,
  palette: KoniPalette,
  options: GraphRenderOptions & GraphFocusOptions = {},
): GraphViewResult {
  if (nodes.length === 0 || width < 3) return { lines: [], nodeLines: [], orderedNodes: [] };
  const { rows, secondary } = buildGraphOutline(nodes, edges, width, options);

  const focusedNodeId =
    options.focusedIndex === undefined ? undefined : rows[options.focusedIndex]?.node.id;
  // The focused node's direct relationships light up with it: neighbor titles leave the muted
  // tier and the connecting edge cells adopt the accent tone. An external highlight set (the
  // focused ticket's neighborhood) joins the same lift.
  const highlightSet = options.highlightNodeIds;
  const neighborIds = new Set<string>(highlightSet ?? []);
  if (focusedNodeId !== undefined) {
    for (const row of rows) {
      if (row.parentId === focusedNodeId) neighborIds.add(row.node.id);
      if (row.node.id === focusedNodeId && row.parentId !== undefined)
        neighborIds.add(row.parentId);
    }
    for (const edge of secondary) {
      if (edge.source === focusedNodeId) neighborIds.add(edge.target);
      if (edge.target === focusedNodeId) neighborIds.add(edge.source);
    }
  }
  // An edge lights up when it touches the focused node or joins two highlighted nodes.
  const edgeLit = (a: string, b: string): boolean =>
    (focusedNodeId !== undefined && (a === focusedNodeId || b === focusedNodeId)) ||
    (highlightSet !== undefined && highlightSet.has(a) && highlightSet.has(b));

  const rowByNode = new Map(rows.map((row, index) => [row.node.id, index]));
  const endpoints = new Map<number, { edgeIndex: number; source: boolean }[]>();
  secondary.forEach((edge, edgeIndex) => {
    const source = rowByNode.get(edge.source);
    const target = rowByNode.get(edge.target);
    if (source === undefined || target === undefined || source === target) return;
    const sourceList = endpoints.get(source) ?? [];
    sourceList.push({ edgeIndex, source: true });
    endpoints.set(source, sourceList);
    const targetList = endpoints.get(target) ?? [];
    targetList.push({ edgeIndex, source: false });
    endpoints.set(target, targetList);
  });

  const expanded: ExpandedGraphRow[] = [];
  const nodeLines: number[] = [];
  const endpointRows = new Map<string, number>();
  const endpointStarts = new Map<string, number>();
  rows.forEach((row, rowIndex) => {
    nodeLines.push(expanded.length);
    const branchTouchesFocus = row.parentId !== undefined && edgeLit(row.node.id, row.parentId);
    const branchHighlight = branchTouchesFocus
      ? { start: visibleWidth(row.prefix), end: row.markerStart }
      : undefined;
    if (options.focusedIndex === rowIndex && options.showTitles !== false) {
      // The cursor row shows the complete title: the first segment replaces the short label
      // and up to two continuation rows carry the rest between the tree rails.
      const available = Math.max(1, width - row.titleStart);
      const segments = wrapTextWithAnsi(row.node.fullTitle, available).slice(0, 3);
      const overlay = (text: string): NonNullable<ExpandedGraphRow["focusTitle"]> => {
        const clipped = truncateToWidth(text, available, "…");
        return {
          start: row.titleStart,
          end: row.titleStart + visibleWidth(clipped),
          text: clipped,
        };
      };
      expanded.push({
        structural: row.structural,
        nodeRow: row,
        focusTitle: overlay(segments[0] ?? row.node.fullTitle),
        ...(branchHighlight === undefined ? {} : { structuralHighlight: branchHighlight }),
      });
      const continuationPrefix = row.isRoot ? "" : `${row.prefix}${row.isLast ? "   " : "│  "}`;
      for (const segment of segments.slice(1)) {
        expanded.push({ structural: continuationPrefix, focusTitle: overlay(segment) });
      }
    } else {
      expanded.push({
        structural: row.structural,
        nodeRow: row,
        ...(branchHighlight === undefined ? {} : { structuralHighlight: branchHighlight }),
      });
    }
    const rowEndpoints = (endpoints.get(rowIndex) ?? []).sort(
      (left, right) =>
        left.edgeIndex - right.edgeIndex || Number(right.source) - Number(left.source),
    );
    for (const endpoint of rowEndpoints) {
      const edge = secondary[endpoint.edgeIndex]!;
      const childPrefix = row.isRoot ? "" : `${row.prefix}${row.isLast ? "   " : "│  "}`;
      const local = endpoint.source ? `├─<${formatGraphRelation(edge.relation)}>─` : "├────";
      const structural = `${childPrefix}${local}`;
      const key = `${endpoint.edgeIndex}:${endpoint.source ? "source" : "target"}`;
      endpointRows.set(key, expanded.length);
      endpointStarts.set(key, Math.max(0, visibleWidth(structural) - 1));
      const incident = edgeLit(edge.source, edge.target);
      expanded.push({
        structural,
        ...(incident
          ? {
              structuralHighlight: {
                start: visibleWidth(childPrefix),
                end: visibleWidth(structural),
              },
            }
          : {}),
      });
    }
  });

  const canvas = Array.from({ length: Math.max(1, expanded.length) }, () =>
    Array.from({ length: width }, () => " "),
  );
  const highlight = Array.from({ length: Math.max(1, expanded.length) }, () =>
    Array.from({ length: width }, () => false),
  );
  const markHighlight = (y: number, fromX: number, toX: number): void => {
    const row = highlight[y];
    if (row === undefined) return;
    for (let x = Math.max(0, fromX); x <= Math.min(width - 1, toX); x += 1) row[x] = true;
  };
  const usedLanes: number[] = [];
  secondary.forEach((edge, edgeIndex) => {
    const sourceY = endpointRows.get(`${edgeIndex}:source`);
    const targetY = endpointRows.get(`${edgeIndex}:target`);
    if (sourceY === undefined || targetY === undefined) return;
    const sourceStart = endpointStarts.get(`${edgeIndex}:source`) ?? 0;
    const targetStart = endpointStarts.get(`${edgeIndex}:target`) ?? 0;
    const sourceNodeRow = rows[rowByNode.get(edge.source)!]!;
    const targetNodeRow = rows[rowByNode.get(edge.target)!]!;
    const base = Math.min(
      width - 1,
      Math.max(
        sourceStart,
        targetStart,
        visibleWidth(sourceNodeRow.structural),
        visibleWidth(targetNodeRow.structural),
      ) + 2,
    );
    let lane = base;
    while (lane < width - 1 && usedLanes.some((candidate) => Math.abs(candidate - lane) < 2))
      lane += 1;
    usedLanes.push(lane);
    const top = Math.min(sourceY, targetY);
    const bottom = Math.max(sourceY, targetY);
    const topStart = top === sourceY ? sourceStart : targetStart;
    const bottomStart = bottom === sourceY ? sourceStart : targetStart;
    if (top === bottom) {
      drawGraphHorizontal(canvas, top, Math.min(sourceStart, targetStart), lane);
    } else {
      // Clean corners: the horizontal runs stop one cell short and dedicated corner glyphs turn
      // into the shared vertical lane instead of stamping a crossing at every joint.
      drawGraphHorizontal(canvas, top, topStart, lane - 1);
      drawGraphHorizontal(canvas, bottom, bottomStart, lane - 1);
      drawGraphVertical(canvas, lane, top + 1, bottom - 1);
      mergeGraphCorner(canvas, top, lane, "╮");
      mergeGraphCorner(canvas, bottom, lane, "╯");
    }
    if (edgeLit(edge.source, edge.target)) {
      markHighlight(top, topStart, lane);
      markHighlight(bottom, bottomStart, lane);
      for (let y = top; y <= bottom; y += 1) markHighlight(y, lane, lane);
    }
  });
  expanded.forEach((row, y) => {
    const range = row.structuralHighlight;
    if (range !== undefined) markHighlight(y, range.start, range.end - 1);
  });

  expanded.forEach((row, y) => writeGraphText(canvas[y]!, 0, row.structural));
  expanded.forEach((row, y) => {
    if (options.showTitles === false) return;
    if (row.focusTitle !== undefined) {
      writeGraphText(canvas[y]!, row.focusTitle.start, row.focusTitle.text);
      return;
    }
    if (row.nodeRow === undefined) return;
    const available = Math.max(0, width - row.nodeRow.titleStart);
    writeGraphText(
      canvas[y]!,
      row.nodeRow.titleStart,
      truncateToWidth(row.nodeRow.node.label, available, "…"),
    );
  });

  // Feed connectors: wired node rows extend a rail to the right edge, where the gutter picks
  // it up. Lane crossings degrade to ┼ through the ordinary merge rules.
  const connectors = options.rightConnectors;
  if (connectors !== undefined && connectors.size > 0) {
    expanded.forEach((row, y) => {
      const nodeRow = row.nodeRow;
      if (nodeRow === undefined) return;
      const connector = connectors.get(nodeRow.node.id);
      if (connector === undefined) return;
      const cells = canvas[y]!;
      let lastText = -1;
      for (let x = cells.length - 1; x >= 0; x -= 1) {
        if (cells[x] !== " ") {
          lastText = x;
          break;
        }
      }
      const from = lastText + 2;
      if (from > width - 1) return;
      for (let x = from; x <= width - 1; x += 1) mergeGraphCell(canvas, y, x, "─");
      if (connector.highlighted) markHighlight(y, from, width - 1);
    });
  }

  const dimming = options.dimNonNeighborhood === true;
  const lines = canvas.map((cells, y) => {
    const nodeRow = expanded[y]?.nodeRow;
    const focus = expanded[y]?.focusTitle;
    const neighborRow = nodeRow !== undefined && neighborIds.has(nodeRow.node.id);
    // Grey-out mode: every node outside the focus neighborhood loses its marker color and
    // title tier; the structural tree skeleton stays readable in the ordinary border tone.
    const dimRow =
      dimming &&
      nodeRow !== undefined &&
      nodeRow.node.id !== focusedNodeId &&
      !neighborIds.has(nodeRow.node.id);
    let output = "";
    let mode:
      | "edge"
      | "edge-hi"
      | "marker"
      | "dim-marker"
      | "title"
      | "muted-title"
      | "neighbor-title"
      | "focus-title" = "edge";
    let segment = "";
    const flush = (): void => {
      if (segment.length === 0) return;
      output +=
        mode === "marker"
          ? palette.bold(graphNodeStyle(nodeRow?.node.type ?? "", segment, palette))
          : mode === "dim-marker"
            ? palette.dim(segment)
            : mode === "title"
              ? palette.muted(segment)
              : mode === "muted-title"
                ? palette.dim(segment)
                : mode === "neighbor-title"
                  ? palette.text(segment)
                  : mode === "focus-title"
                    ? palette.selected(segment)
                    : mode === "edge-hi"
                      ? palette.accent(segment)
                      : palette.border(segment);
      segment = "";
    };
    cells.forEach((cell, x) => {
      const base =
        focus !== undefined && x >= focus.start && x < focus.end
          ? "focus-title"
          : nodeRow === undefined || x < nodeRow.markerStart
            ? "edge"
            : x < nodeRow.markerEnd
              ? dimRow
                ? "dim-marker"
                : "marker"
              : x >= nodeRow.titleStart && cell.trim().length > 0
                ? GRAPH_STRUCTURE_GLYPHS.has(cell)
                  ? "edge"
                  : dimRow
                    ? "muted-title"
                    : neighborRow
                      ? "neighbor-title"
                      : nodeRow.node.muted
                        ? "muted-title"
                        : "title"
                : "edge";
      const nextMode = base === "edge" && highlight[y]?.[x] === true ? "edge-hi" : base;
      if (nextMode !== mode) {
        flush();
        mode = nextMode;
      }
      segment += cell;
    });
    flush();
    return truncateToWidth(output.trimEnd(), width, "…");
  });
  return { lines, nodeLines, orderedNodes: rows.map((row) => row.node) };
}

const GRAPH_STRUCTURE_GLYPHS: ReadonlySet<string> = new Set([
  "─",
  "│",
  "╭",
  "╮",
  "╰",
  "╯",
  "┬",
  "┴",
  "┤",
  "├",
  "┼",
]);

function drawGraphHorizontal(canvas: string[][], y: number, from: number, to: number): void {
  const left = Math.min(from, to);
  const right = Math.max(from, to);
  if (to < from) return;
  for (let x = left; x <= right; x += 1) mergeGraphCell(canvas, y, x, "─");
}

function drawGraphVertical(canvas: string[][], x: number, from: number, to: number): void {
  const top = Math.min(from, to);
  const bottom = Math.max(from, to);
  if (to < from) return;
  for (let y = top; y <= bottom; y += 1) mergeGraphCell(canvas, y, x, "│");
}

function mergeGraphCell(canvas: string[][], y: number, x: number, value: string): void {
  const row = canvas[y];
  if (row === undefined || x < 0 || x >= row.length) return;
  const previous = row[x];
  row[x] = previous === " " || previous === value ? value : "┼";
}

/** A lane corner keeps its rounded glyph alone and degrades to a tee/crossing when shared. */
function mergeGraphCorner(canvas: string[][], y: number, x: number, corner: "╮" | "╯"): void {
  const row = canvas[y];
  if (row === undefined || x < 0 || x >= row.length) return;
  const previous = row[x];
  if (previous === " " || previous === corner) row[x] = corner;
  else if (previous === "─") row[x] = corner === "╮" ? "┬" : "┴";
  else if (previous === "│") row[x] = "┤";
  else row[x] = "┼";
}

function writeGraphText(row: string[], start: number, value: string): void {
  let x = start;
  for (const grapheme of graphGraphemes(value)) {
    const cells = Math.max(0, visibleWidth(grapheme));
    if (cells === 0 || x + cells > row.length) break;
    row[x] = grapheme;
    for (let offset = 1; offset < cells; offset += 1) row[x + offset] = "";
    x += cells;
  }
}

function normalizeGraphEdges(
  edges: readonly { source: string; target: string; relation?: string }[],
  byId: ReadonlyMap<string, GraphNodeView>,
  reverseDisplayEdges: Readonly<Record<string, string>> | undefined,
  compareNodes: (left: GraphNodeView, right: GraphNodeView) => number,
): GraphDisplayEdge[] {
  const valid = edges
    .filter((edge) => edge.source !== edge.target && byId.has(edge.source) && byId.has(edge.target))
    .map((edge) => {
      const relation = edge.relation ?? "related";
      const sourceType = byId.get(edge.source)!.type;
      const reversed = reverseDisplayEdges?.[`${sourceType}.${relation}`];
      return reversed === undefined
        ? { source: edge.source, target: edge.target, relation }
        : { source: edge.target, target: edge.source, relation: reversed };
    })
    .sort((left, right) => graphEdgeKey(left).localeCompare(graphEdgeKey(right)));
  const byPair = new Map<string, GraphDisplayEdge[]>();
  for (const edge of valid) {
    const pair = [edge.source, edge.target].sort().join("\u0000");
    const list = byPair.get(pair) ?? [];
    list.push(edge);
    byPair.set(pair, list);
  }
  const output: GraphDisplayEdge[] = [];
  for (const pairEdges of byPair.values()) {
    const directions = new Set(pairEdges.map((edge) => `${edge.source}\u0000${edge.target}`));
    const reciprocal = directions.size > 1;
    if (!reciprocal) {
      const seen = new Set<string>();
      for (const edge of pairEdges) {
        const key = graphEdgeKey(edge);
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(edge);
      }
      continue;
    }
    const [leftId, rightId] = [pairEdges[0]!.source, pairEdges[0]!.target].sort((left, right) =>
      compareNodes(byId.get(left)!, byId.get(right)!),
    );
    const forward = pairEdges.filter((edge) => edge.source === leftId && edge.target === rightId);
    const labels = [
      ...new Set((forward.length > 0 ? forward : pairEdges).map((edge) => edge.relation)),
    ].sort();
    output.push({ source: leftId!, target: rightId!, relation: labels.join("/") || "related" });
  }
  return output.sort((left, right) => graphEdgeKey(left).localeCompare(graphEdgeKey(right)));
}

function choosePrimaryGraphEdges(
  edges: readonly GraphDisplayEdge[],
  byId: ReadonlyMap<string, GraphNodeView>,
  compareNodes: (left: GraphNodeView, right: GraphNodeView) => number,
  primaryParentPreferences: Readonly<Record<string, readonly string[]>> | undefined,
): Map<string, GraphDisplayEdge> {
  const output = new Map<string, GraphDisplayEdge>();
  const sorted = [...edges].sort(
    (left, right) =>
      compareNodes(byId.get(left.target)!, byId.get(right.target)!) ||
      parentPreferenceRank(left, byId, primaryParentPreferences) -
        parentPreferenceRank(right, byId, primaryParentPreferences) ||
      compareNodes(byId.get(left.source)!, byId.get(right.source)!) ||
      left.relation.localeCompare(right.relation),
  );
  for (const edge of sorted) {
    if (output.has(edge.target)) continue;
    let ancestor: string | undefined = edge.source;
    let cyclic = false;
    while (ancestor !== undefined) {
      if (ancestor === edge.target) {
        cyclic = true;
        break;
      }
      ancestor = output.get(ancestor)?.source;
    }
    if (!cyclic) output.set(edge.target, edge);
  }
  return output;
}

function parentPreferenceRank(
  edge: GraphDisplayEdge,
  byId: ReadonlyMap<string, GraphNodeView>,
  preferences: Readonly<Record<string, readonly string[]>> | undefined,
): number {
  const childType = byId.get(edge.target)?.type;
  const parentType = byId.get(edge.source)?.type;
  if (childType === undefined || parentType === undefined) return Number.MAX_SAFE_INTEGER;
  const order = preferences?.[childType];
  const index = order?.indexOf(parentType) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function graphNodeCompare(
  left: GraphNodeView,
  right: GraphNodeView,
  hierarchy?: readonly string[],
): number {
  return (
    graphTypeRank(left.type, hierarchy) - graphTypeRank(right.type, hierarchy) ||
    left.type.localeCompare(right.type) ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id)
  );
}

function graphTypeRank(type: string, configured?: readonly string[]): number {
  const normalized = type.toLocaleLowerCase("en-US");
  const order = configured ?? [
    "goal",
    "objective",
    "problem",
    "requirement",
    "architecture",
    "decision",
    "change",
    "hypothesis",
    "claim",
    "literature",
    "method",
    "experiment",
    "ablation",
    "implementation",
    "metric",
    "evidence",
    "result",
    "verification",
    "gate",
    "report",
  ];
  const index = order.findIndex(
    (candidate) => normalized === candidate || normalized.includes(candidate),
  );
  return index < 0 ? order.length : index;
}

function graphEdgeKey(edge: GraphDisplayEdge): string {
  return `${edge.source}\u0000${edge.relation}\u0000${edge.target}`;
}

export function formatGraphRelation(value: string): string {
  const normalized = value
    .replace(/^target_claims$/u, "claims")
    .replace(/^tested_by$/u, "tests")
    .replace(/^applies_to$/u, "applies")
    .replace(/^negative_evidence$/u, "neg-evidence")
    .replace(/^change_requests$/u, "changes")
    .replace(/_/gu, "-");
  return truncateToWidth(normalized, 18, "…");
}

function compactGraphPrefix(prefix: string, width: number): string {
  const budget = Math.max(3, Math.min(12, Math.floor(width / 3)));
  if (visibleWidth(prefix) <= budget) return prefix;
  return `…${truncateToWidth(prefix.slice(-(budget - 1)), budget - 1, "")}`;
}

export function graphBadge(type: string, width: number): string {
  if (width >= 48)
    return `[${truncateToWidth(type.replace(/_/gu, "-"), Math.max(1, width - 2), "…")}]`;
  const known: Readonly<Record<string, string | undefined>> = {
    hypothesis: "hy",
    literature: "li",
    paper: "pa",
    claim: "cl",
    experiment: "ex",
    method: "mt",
    metric: "me",
    prerequisite: "pr",
    decision: "de",
    ablation: "ab",
    asset: "as",
    gate: "gt",
    implementation: "im",
    run: "rn",
    evidence: "ev",
    report: "rp",
    "change-request": "cr",
  };
  const normalized = type.toLocaleLowerCase("en-US").replace(/_/gu, "-");
  const initials = normalized
    .split("-")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2);
  const fallback = Array.from(normalized)
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .slice(0, 2)
    .join("");
  return `[${known[normalized] ?? initials.padEnd(2, fallback[1] ?? fallback[0] ?? "?")}]`;
}

export function graphNodeStyle(type: string, value: string, palette: KoniPalette): string {
  const styles = [
    palette.accent,
    palette.info,
    palette.success,
    palette.warning,
    palette.error,
  ] as const;
  const hash = Array.from(type).reduce(
    (total, character) => total + (character.codePointAt(0) ?? 0),
    0,
  );
  return styles[hash % styles.length]!(value);
}

function graphGraphemes(value: string): string[] {
  if (Intl.Segmenter === undefined) return Array.from(value);
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map(
    (entry) => entry.segment,
  );
}
