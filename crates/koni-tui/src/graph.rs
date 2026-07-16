use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphLine {
    pub text: String,
    #[serde(default)]
    pub node_spans: Vec<NodeSpan>,
    #[serde(default)]
    pub title_spans: Vec<TextSpan>,
    #[serde(default)]
    pub edge_spans: Vec<NodeSpan>,
}

/// Canonical identity for one relationship in the persisted graph.
///
/// The renderer can reorient or share connector cells for presentation, so a
/// painted span may carry more than one of these references. Keeping the raw
/// identity attached lets higher-level views (notably the ticket diff lens)
/// color the relationship by meaning rather than by terminal coordinates.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct GraphEdgeRef {
    pub source: String,
    pub relation: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeSpan {
    pub start: usize,
    pub end: usize,
    pub node_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub edge_refs: Vec<GraphEdgeRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextSpan {
    pub start: usize,
    pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EdgeCell {
    node_type: String,
    edge_refs: Vec<GraphEdgeRef>,
}

type EdgeCells = BTreeMap<usize, EdgeCell>;

fn merge_edge_refs(target: &mut Vec<GraphEdgeRef>, incoming: &[GraphEdgeRef]) {
    for edge_ref in incoming {
        if !target.contains(edge_ref) {
            target.push(edge_ref.clone());
        }
    }
    target.sort();
}

fn mark_edge_cell(
    cells: &mut EdgeCells,
    column: usize,
    node_type: &str,
    edge_refs: &[GraphEdgeRef],
) {
    let cell = cells.entry(column).or_insert_with(|| EdgeCell {
        node_type: node_type.to_owned(),
        edge_refs: Vec::new(),
    });
    merge_edge_refs(&mut cell.edge_refs, edge_refs);
}

#[derive(Debug, Clone)]
struct NestedRow {
    node_id: String,
    structural: String,
    edge_types: EdgeCells,
    prefix: String,
    prefix_edge_types: EdgeCells,
    is_last: bool,
    is_root: bool,
    parent_type: Option<String>,
    node_type: String,
    node_start: usize,
    node_end: usize,
    title: String,
}

#[derive(Debug, Clone)]
struct ExpandedNestedRow {
    structural: String,
    edge_types: EdgeCells,
    node_span: Option<NodeSpan>,
    title_start: Option<usize>,
    title: Option<String>,
}

#[derive(Debug, Clone)]
struct RelationPair {
    source_row: usize,
    target_row: usize,
    source_id: String,
    target_id: String,
    target_type: String,
    label: String,
    edge_refs: Vec<GraphEdgeRef>,
}

#[derive(Debug, Clone, Copy)]
struct NestedChars {
    mid: &'static str,
    last: &'static str,
    pipe: &'static str,
    space: &'static str,
}

#[derive(Debug, Clone)]
struct LaneAssignment {
    pair_index: usize,
    lane_x: usize,
    target_type: String,
    edge_refs: Vec<GraphEdgeRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GraphLayout {
    Canvas,
    Nested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpwardEdgePolicy {
    Preserve,
    MappedOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VisualNode {
    id: String,
    node_type: String,
    title: String,
    sort_title: String,
    edges: BTreeMap<String, Vec<String>>,
}

impl VisualNode {
    fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let id = object.get("id")?.as_str()?.to_owned();
        let node_type = object
            .get("type")
            .or_else(|| object.get("node_type"))?
            .as_str()?
            .to_owned();
        let raw_title = object
            .get("short_title")
            .or_else(|| object.get("label"))
            .or_else(|| object.get("title"))
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("Untitled {}", node_type.replace(['_', '-'], " ")));
        // Autoresearch-v2 orders topology by the canonical node title, not by
        // the shortened text painted into the terminal. Keeping those two
        // values separate prevents title compaction from silently reshaping
        // every secondary-edge lane.
        let sort_title = object
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or(&raw_title)
            .to_owned();
        let title = compact_node_title(&raw_title, &node_type);
        let edges = object
            .get("edges")
            .and_then(Value::as_object)
            .map(|edges| {
                edges
                    .iter()
                    .map(|(relation, targets)| {
                        let targets = targets
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(ToOwned::to_owned)
                            .collect();
                        (relation.clone(), targets)
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            id,
            node_type,
            title,
            sort_title,
            edges,
        })
    }
}

#[derive(Debug, Clone)]
struct DisplayEdge {
    parent: String,
    child: String,
    label: String,
    reoriented: bool,
    raw_source: String,
    raw_target: String,
    edge_refs: Vec<GraphEdgeRef>,
}

#[derive(Debug, Clone)]
struct CanvasPlacement {
    semantic_id: String,
    node_type: String,
    badge: String,
    title: String,
    start_x: usize,
    badge_end_x: usize,
    end_x: usize,
    center_x: usize,
    y: usize,
    layer: usize,
}

#[derive(Debug, Clone)]
struct CanvasVisualNode {
    visual_id: String,
    semantic_id: String,
    layer: usize,
    node: VisualNode,
}

#[derive(Debug, Clone)]
struct CanvasVisualEdge {
    parent: String,
    child: String,
    edge_refs: Vec<GraphEdgeRef>,
}

#[derive(Debug, Clone, Copy)]
struct CanvasRoute {
    source_x: usize,
    source_y: usize,
    target_x: usize,
    target_y: usize,
    route_y: usize,
}

/// Deterministic terminal graph renderer.
///
/// The renderer supports autoresearch-v2's compact nested relationship outline
/// plus an optional layered canvas for non-research profiles. Koni paints short
/// titles after the relationship linework, so title letters replace connector
/// cells without obscuring the typed node marker.
#[derive(Debug, Clone)]
pub struct GraphRenderer {
    ascii: bool,
    show_titles: bool,
    layout: GraphLayout,
    upward_edge_policy: UpwardEdgePolicy,
    hierarchy: Vec<String>,
    layers: Vec<Vec<String>>,
    repeat_semantic_types: HashSet<String>,
    parent_preferences: BTreeMap<String, Vec<String>>,
    reverse_labels: BTreeMap<(String, String), String>,
}

impl Default for GraphRenderer {
    fn default() -> Self {
        Self::new(false)
    }
}

impl GraphRenderer {
    pub fn new(ascii: bool) -> Self {
        Self {
            ascii,
            show_titles: true,
            layout: GraphLayout::Nested,
            upward_edge_policy: UpwardEdgePolicy::Preserve,
            hierarchy: Vec::new(),
            layers: Vec::new(),
            repeat_semantic_types: HashSet::new(),
            parent_preferences: BTreeMap::new(),
            reverse_labels: BTreeMap::new(),
        }
    }

    pub fn with_titles(mut self, show_titles: bool) -> Self {
        self.show_titles = show_titles;
        self
    }

    pub fn with_layout(mut self, layout: &str) -> Self {
        self.layout = match layout {
            "canvas" | "layered" | "dag" | "semantic_layers" | "semantic-layers" => {
                GraphLayout::Canvas
            }
            "nested" | "outline" | "relationship_outline" | "relationship-outline" => {
                GraphLayout::Nested
            }
            _ => GraphLayout::Nested,
        };
        self
    }

    pub fn with_upward_edge_policy(mut self, policy: &str) -> Self {
        self.upward_edge_policy = match policy {
            "mapped_only" | "mapped-only" => UpwardEdgePolicy::MappedOnly,
            _ => UpwardEdgePolicy::Preserve,
        };
        self
    }

    pub fn with_parent_preferences(mut self, preferences: BTreeMap<String, Vec<String>>) -> Self {
        self.parent_preferences = preferences;
        self
    }

    pub fn with_hierarchy(mut self, hierarchy: Vec<String>) -> Self {
        if !hierarchy.is_empty() {
            self.hierarchy = hierarchy;
        }
        self
    }

    pub fn with_layers(mut self, layers: Vec<Vec<String>>) -> Self {
        self.layers = layers
            .into_iter()
            .filter(|layer| !layer.is_empty())
            .collect();
        self
    }

    pub fn with_repeat_semantic_types(mut self, node_types: Vec<String>) -> Self {
        self.repeat_semantic_types = node_types.into_iter().collect();
        self
    }

    pub fn with_reverse_labels(mut self, labels: BTreeMap<(String, String), String>) -> Self {
        self.reverse_labels = labels;
        self
    }

    pub fn render_values(&self, values: &[Value], width: usize) -> Vec<GraphLine> {
        let mut nodes: Vec<_> = values.iter().filter_map(VisualNode::from_value).collect();
        nodes.sort_by(|left, right| self.node_key(left).cmp(&self.node_key(right)));
        self.render(&nodes, width.max(20))
    }

    fn render(&self, nodes: &[VisualNode], width: usize) -> Vec<GraphLine> {
        if nodes.is_empty() {
            return vec![GraphLine {
                text: "no graph nodes".to_owned(),
                node_spans: Vec::new(),
                title_spans: Vec::new(),
                edge_spans: Vec::new(),
            }];
        }
        let by_id: HashMap<_, _> = nodes.iter().map(|node| (node.id.clone(), node)).collect();
        let display_edges = self.display_edges(nodes, &by_id);
        match self.layout {
            GraphLayout::Canvas => self.render_canvas(nodes, &display_edges, &by_id, width),
            GraphLayout::Nested => self.render_nested(nodes, &display_edges, &by_id, width),
        }
    }

    fn render_canvas(
        &self,
        nodes: &[VisualNode],
        display_edges: &[DisplayEdge],
        by_id: &HashMap<String, &VisualNode>,
        width: usize,
    ) -> Vec<GraphLine> {
        let (visual_nodes, visual_edges) = self.canvas_visual_model(nodes, display_edges, by_id);
        let mut nodes_by_layer = BTreeMap::<usize, Vec<&CanvasVisualNode>>::new();
        for visual in &visual_nodes {
            nodes_by_layer.entry(visual.layer).or_default().push(visual);
        }
        for layer_nodes in nodes_by_layer.values_mut() {
            layer_nodes.sort_by(|left, right| {
                (self.node_key(&left.node), &left.visual_id)
                    .cmp(&(self.node_key(&right.node), &right.visual_id))
            });
        }

        let compact_badges = width < 48;
        let mut placements = Vec::<CanvasPlacement>::new();
        let mut placement_by_id = HashMap::<String, usize>::new();
        let mut cursor_y = 0usize;
        let mut layer_bottoms = BTreeMap::<usize, usize>::new();

        for (layer, layer_nodes) in &nodes_by_layer {
            // Autoresearch-v2 keeps semantic type/title ordering stable within
            // a depth row. Relationship routing must not reorder the nodes.
            let ordered = layer_nodes.clone();
            let compact_titles = ordered.len() > 1;
            let lanes = canvas_lanes(
                &ordered,
                width,
                compact_badges,
                compact_titles,
                self.show_titles,
            );
            let layer_top = cursor_y;
            let lane_spacing = usize::from(lanes.len() > 1) + 1;
            for (lane_index, lane) in lanes.iter().enumerate() {
                let y = layer_top + lane_index * lane_spacing;
                let lane_width = lane
                    .iter()
                    .map(|node| {
                        canvas_token_width(
                            node,
                            compact_badges,
                            compact_titles,
                            self.show_titles,
                            width,
                        )
                    })
                    .sum::<usize>()
                    + lane.len().saturating_sub(1) * 2;
                let mut x = width.saturating_sub(lane_width) / 2;
                for node in lane {
                    let badge = canvas_badge(&node.node.node_type, compact_badges);
                    let title = if self.show_titles {
                        canvas_title(node, compact_badges, compact_titles, width)
                    } else {
                        String::new()
                    };
                    let badge_width = badge.chars().count();
                    let title_width = title.chars().count();
                    let slot_width = canvas_token_width(
                        node,
                        compact_badges,
                        compact_titles,
                        self.show_titles,
                        width,
                    );
                    let safe_start = if lane.len() == 1 {
                        width.saturating_sub(badge_width) / 2
                    } else {
                        x.min(width.saturating_sub(1))
                    };
                    let badge_end_x = (safe_start + badge_width).min(width);
                    let end_x = (badge_end_x
                        + usize::from(self.show_titles && !title.is_empty())
                        + title_width)
                        .min(width);
                    let placement = CanvasPlacement {
                        semantic_id: node.semantic_id.clone(),
                        node_type: node.node.node_type.clone(),
                        badge,
                        title,
                        start_x: safe_start,
                        badge_end_x,
                        end_x,
                        center_x: safe_start + badge_width.saturating_sub(1) / 2,
                        y,
                        layer: *layer,
                    };
                    placement_by_id.insert(node.visual_id.clone(), placements.len());
                    placements.push(placement);
                    x = safe_start.saturating_add(slot_width).saturating_add(2);
                }
            }
            let bottom = layer_top + lanes.len().saturating_sub(1) * lane_spacing;
            layer_bottoms.insert(*layer, bottom);
            let outgoing = visual_edges
                .iter()
                .filter(|edge| {
                    placement_by_id
                        .get(&edge.parent)
                        .and_then(|index| placements.get(*index))
                        .is_some_and(|placement| placement.layer == *layer)
                })
                .count();
            // Autoresearch-v2 uses one vertical continuation row followed by
            // one shared horizontal relationship row between semantic
            // layers. Keeping that fixed rhythm is what makes the result read
            // as a graph instead of a collection of individually routed
            // boxes.
            cursor_y = bottom + if outgoing == 0 { 2 } else { 3 };
        }

        let height = placements
            .iter()
            .map(|placement| placement.y)
            .max()
            .unwrap_or(0)
            + 1;
        let mut edge_grid = vec![vec![0u8; width]; height];
        let mut edge_types = vec![EdgeCells::new(); height];
        let mut routed_pairs = HashSet::<(String, String)>::new();
        for edge in &visual_edges {
            if !routed_pairs.insert((edge.parent.clone(), edge.child.clone())) {
                continue;
            }
            let (Some(source_index), Some(target_index)) = (
                placement_by_id.get(&edge.parent),
                placement_by_id.get(&edge.child),
            ) else {
                continue;
            };
            let mut source = &placements[*source_index];
            let mut target = &placements[*target_index];
            if (target.y, target.center_x) < (source.y, source.center_x) {
                std::mem::swap(&mut source, &mut target);
            }
            // The original layered renderer only projects downward semantic
            // relationships. Same-layer links remain canonical data but do
            // not turn a layer of sibling nodes into a text-level chain.
            if source.layer >= target.layer || source.y == target.y {
                continue;
            }
            let source_bottom = *layer_bottoms.get(&source.layer).unwrap_or(&source.y);
            let route_y = source_bottom
                .saturating_add(2)
                .min(target.y.saturating_sub(1));
            let route = CanvasRoute {
                source_x: source.center_x.min(width.saturating_sub(1)),
                source_y: source.y,
                target_x: target.center_x.min(width.saturating_sub(1)),
                target_y: target.y,
                route_y,
            };
            draw_canvas_route(
                &mut edge_grid,
                &mut edge_types,
                route,
                &target.node_type,
                &edge.edge_refs,
            );
        }

        let mut canvas = vec![vec![' '; width]; height];
        for y in 0..height {
            for x in 0..width {
                if edge_grid[y][x] != 0 {
                    canvas[y][x] = canvas_edge_char(edge_grid[y][x], self.ascii);
                }
            }
        }

        let mut node_spans = vec![Vec::<NodeSpan>::new(); height];
        let mut title_spans = vec![Vec::<TextSpan>::new(); height];
        // Node badges and titles are painted after the relationship canvas.
        // This keeps the optional canvas continuous while ensuring node text
        // wins wherever it crosses a line, just as it does in the default
        // nested renderer.
        for placement in &placements {
            paint_canvas_text(
                &mut canvas[placement.y],
                placement.start_x,
                &placement.badge,
            );
            node_spans[placement.y].push(NodeSpan {
                start: placement.start_x,
                end: placement.badge_end_x,
                node_type: placement.node_type.clone(),
                node_id: Some(placement.semantic_id.clone()),
                edge_refs: Vec::new(),
            });
            if self.show_titles && !placement.title.is_empty() && placement.badge_end_x < width {
                canvas[placement.y][placement.badge_end_x] = ' ';
                let title_start = placement.badge_end_x + 1;
                paint_canvas_text(&mut canvas[placement.y], title_start, &placement.title);
                title_spans[placement.y].push(TextSpan {
                    start: title_start,
                    end: placement.end_x,
                    node_id: Some(placement.semantic_id.clone()),
                });
            }
        }

        let mut output = Vec::new();
        for y in 0..height {
            let text = canvas[y].iter().collect::<String>().trim_end().to_owned();
            let line_width = text.chars().count();
            output.push(GraphLine {
                text,
                node_spans: node_spans[y]
                    .iter()
                    .filter(|span| span.start < line_width)
                    .cloned()
                    .collect(),
                title_spans: title_spans[y]
                    .iter()
                    .filter(|span| span.start < line_width)
                    .cloned()
                    .collect(),
                edge_spans: compress_edge_spans(&edge_types[y], &canvas[y], line_width),
            });
        }
        while output.last().is_some_and(|line| line.text.is_empty()) {
            output.pop();
        }
        if output.is_empty() {
            vec![GraphLine {
                text: "no graph nodes".to_owned(),
                node_spans: Vec::new(),
                title_spans: Vec::new(),
                edge_spans: Vec::new(),
            }]
        } else {
            output
        }
    }

    fn canvas_visual_model(
        &self,
        nodes: &[VisualNode],
        display_edges: &[DisplayEdge],
        by_id: &HashMap<String, &VisualNode>,
    ) -> (Vec<CanvasVisualNode>, Vec<CanvasVisualEdge>) {
        let base_layers = self.canvas_node_layers(nodes, display_edges, by_id);
        let mut visuals = Vec::<CanvasVisualNode>::new();
        let mut visual_index = HashMap::<(String, usize), usize>::new();

        // Autoresearch keeps ordinary semantic nodes in one configured layer.
        // Selected types (notably gates) are projected contextually after each
        // parent layer, but remain one canonical graph record.
        for node in nodes {
            if self.repeat_semantic_types.contains(&node.node_type) {
                continue;
            }
            let layer = *base_layers.get(&node.id).unwrap_or(&0);
            ensure_canvas_visual_node(&mut visuals, &mut visual_index, node, layer);
        }

        let mut visual_edges = Vec::<CanvasVisualEdge>::new();
        let mut visual_edge_index = HashMap::<(String, String), usize>::new();
        for edge in display_edges {
            let (Some(source), Some(target)) = (by_id.get(&edge.parent), by_id.get(&edge.child))
            else {
                continue;
            };
            if self.parent_priority(source, target) >= 1_000 {
                continue;
            }
            let source_base = *base_layers.get(&source.id).unwrap_or(&0);
            let target_layer = if self.repeat_semantic_types.contains(&target.node_type) {
                source_base.saturating_add(1)
            } else {
                *base_layers.get(&target.id).unwrap_or(&0)
            };
            if target_layer <= source_base {
                continue;
            }
            let target_visual =
                ensure_canvas_visual_node(&mut visuals, &mut visual_index, target, target_layer);
            let source_visual = visuals
                .iter()
                .filter(|visual| visual.semantic_id == source.id && visual.layer < target_layer)
                .max_by_key(|visual| visual.layer)
                .map(|visual| visual.visual_id.clone())
                .unwrap_or_else(|| {
                    ensure_canvas_visual_node(&mut visuals, &mut visual_index, source, source_base)
                });
            let visual_pair = (source_visual.clone(), target_visual.clone());
            if let Some(index) = visual_edge_index.get(&visual_pair).copied() {
                merge_edge_refs(&mut visual_edges[index].edge_refs, &edge.edge_refs);
            } else {
                visual_edge_index.insert(visual_pair, visual_edges.len());
                visual_edges.push(CanvasVisualEdge {
                    parent: source_visual,
                    child: target_visual,
                    edge_refs: edge.edge_refs.clone(),
                });
            }
        }

        for node in nodes {
            if visuals.iter().any(|visual| visual.semantic_id == node.id) {
                continue;
            }
            let layer = *base_layers.get(&node.id).unwrap_or(&0);
            ensure_canvas_visual_node(&mut visuals, &mut visual_index, node, layer);
        }
        visuals.sort_by(|left, right| {
            (
                left.layer,
                self.node_key(&left.node),
                left.visual_id.as_str(),
            )
                .cmp(&(
                    right.layer,
                    self.node_key(&right.node),
                    right.visual_id.as_str(),
                ))
        });
        visual_edges
            .sort_by(|left, right| (&left.parent, &left.child).cmp(&(&right.parent, &right.child)));
        (visuals, visual_edges)
    }

    fn canvas_node_layers(
        &self,
        nodes: &[VisualNode],
        display_edges: &[DisplayEdge],
        by_id: &HashMap<String, &VisualNode>,
    ) -> HashMap<String, usize> {
        if !self.layers.is_empty() {
            let configured = self
                .layers
                .iter()
                .enumerate()
                .flat_map(|(layer, types)| {
                    types
                        .iter()
                        .cloned()
                        .map(move |node_type| (node_type, layer))
                })
                .collect::<HashMap<_, _>>();
            return nodes
                .iter()
                .map(|node| {
                    let fallback = self.hierarchy_rank(&node.node_type);
                    (
                        node.id.clone(),
                        configured.get(&node.node_type).copied().unwrap_or(fallback),
                    )
                })
                .collect();
        }

        // Old profiles only declared hierarchy and preferred parents. Recover
        // semantic layers from every hierarchy-compatible relationship so a
        // secondary claim -> experiment edge still lowers the experiment even
        // when the outline renderer chose hypothesis as its primary parent.
        let mut layers = nodes
            .iter()
            .map(|node| (node.id.clone(), 0usize))
            .collect::<HashMap<_, _>>();
        let hierarchy_configured = !self.hierarchy.is_empty();
        for _ in 0..nodes.len().max(1) {
            let mut changed = false;
            for edge in display_edges {
                let (Some(parent_node), Some(child_node)) =
                    (by_id.get(&edge.parent), by_id.get(&edge.child))
                else {
                    continue;
                };
                let parent_rank = self.hierarchy_rank(&parent_node.node_type);
                let child_rank = self.hierarchy_rank(&child_node.node_type);
                if parent_node.node_type == child_node.node_type
                    || (hierarchy_configured && parent_rank >= child_rank)
                {
                    continue;
                }
                if self
                    .parent_preferences
                    .get(&child_node.node_type)
                    .is_some_and(|preferences| !preferences.contains(&parent_node.node_type))
                {
                    continue;
                }
                let parent = *layers.get(&edge.parent).unwrap_or(&0);
                let next = parent.saturating_add(1).min(nodes.len());
                let child = layers.entry(edge.child.clone()).or_default();
                if *child < next {
                    *child = next;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        compress_canvas_layers(layers)
    }

    fn render_nested(
        &self,
        nodes: &[VisualNode],
        display_edges: &[DisplayEdge],
        by_id: &HashMap<String, &VisualNode>,
        width: usize,
    ) -> Vec<GraphLine> {
        let mut tree_edges = self.primary_tree_edges(display_edges, by_id);
        // The outline draws one primary branch for a parent/child pair. Keep
        // every canonical relationship identity on that shared branch so a
        // ticket that adds or renames a secondary relation can still color the
        // connector accurately.
        for tree_edge in &mut tree_edges {
            for edge in display_edges
                .iter()
                .filter(|edge| edge.parent == tree_edge.parent && edge.child == tree_edge.child)
            {
                merge_edge_refs(&mut tree_edge.edge_refs, &edge.edge_refs);
            }
        }
        let tree_pairs = tree_edges
            .iter()
            .map(|edge| (edge.parent.clone(), edge.child.clone()))
            .collect::<HashSet<_>>();
        let mut children = BTreeMap::<String, Vec<DisplayEdge>>::new();
        let mut child_ids = HashSet::new();
        for edge in &tree_edges {
            child_ids.insert(edge.child.clone());
            children
                .entry(edge.parent.clone())
                .or_default()
                .push(edge.clone());
        }
        for edges in children.values_mut() {
            edges.sort_by(|left, right| {
                (self.edge_child_key(left, by_id), &left.label)
                    .cmp(&(self.edge_child_key(right, by_id), &right.label))
            });
        }
        let mut relations = BTreeMap::<String, Vec<DisplayEdge>>::new();
        for edge in display_edges {
            if !tree_pairs.contains(&(edge.parent.clone(), edge.child.clone())) {
                relations
                    .entry(edge.parent.clone())
                    .or_default()
                    .push(edge.clone());
            }
        }
        for edges in relations.values_mut() {
            edges.sort_by(|left, right| {
                (
                    format_relation(&left.label),
                    self.edge_child_key(left, by_id),
                )
                    .cmp(&(
                        format_relation(&right.label),
                        self.edge_child_key(right, by_id),
                    ))
            });
        }

        let mut roots = nodes
            .iter()
            .filter(|node| !child_ids.contains(&node.id))
            .collect::<Vec<_>>();
        roots.sort_by(|left, right| self.node_key(left).cmp(&self.node_key(right)));
        if roots.is_empty() {
            roots.push(&nodes[0]);
        }
        let mut rows = Vec::new();
        let mut emitted = HashSet::new();
        for (index, root) in roots.iter().enumerate() {
            self.append_nested_rows(
                &mut rows,
                root,
                &children,
                by_id,
                "",
                BTreeMap::new(),
                index + 1 == roots.len(),
                true,
                None,
                None,
                &[],
                width < 40,
                &mut emitted,
            );
        }
        for node in nodes {
            if emitted.contains(&node.id) {
                continue;
            }
            self.append_nested_rows(
                &mut rows,
                node,
                &children,
                by_id,
                "",
                BTreeMap::new(),
                true,
                true,
                None,
                None,
                &[],
                width < 40,
                &mut emitted,
            );
        }
        self.format_nested_rows(rows, &relations, width)
    }

    #[allow(clippy::too_many_arguments)]
    fn append_nested_rows<'a>(
        &self,
        rows: &mut Vec<NestedRow>,
        node: &'a VisualNode,
        children: &BTreeMap<String, Vec<DisplayEdge>>,
        by_id: &HashMap<String, &'a VisualNode>,
        prefix: &str,
        prefix_edge_types: EdgeCells,
        is_last: bool,
        is_root: bool,
        parent_type: Option<&str>,
        incoming_label: Option<&str>,
        incoming_edge_refs: &[GraphEdgeRef],
        compact_badges: bool,
        emitted: &mut HashSet<String>,
    ) {
        if !emitted.insert(node.id.clone()) {
            return;
        }
        let chars = nested_chars(self.ascii);
        let branch = if is_root {
            ""
        } else if is_last {
            chars.last
        } else {
            chars.mid
        };
        let edge_branch = if is_root {
            String::new()
        } else {
            nested_edge_branch(branch, incoming_label)
        };
        let mut edge_types = prefix_edge_types.clone();
        if let Some(parent_type) = parent_type {
            for (offset, character) in edge_branch.chars().enumerate() {
                if !character.is_whitespace() {
                    mark_edge_cell(
                        &mut edge_types,
                        prefix.chars().count() + offset,
                        parent_type,
                        incoming_edge_refs,
                    );
                }
            }
        }
        let badge = canvas_badge(&node.node_type, compact_badges);
        let node_start = prefix.chars().count() + edge_branch.chars().count();
        let node_end = node_start + badge.chars().count();
        rows.push(NestedRow {
            node_id: node.id.clone(),
            structural: format!("{prefix}{edge_branch}{badge}"),
            edge_types,
            prefix: prefix.to_owned(),
            prefix_edge_types: prefix_edge_types.clone(),
            is_last,
            is_root,
            parent_type: parent_type.map(ToOwned::to_owned),
            node_type: node.node_type.clone(),
            node_start,
            node_end,
            title: node.title.clone(),
        });

        let child_edges = children.get(&node.id).cloned().unwrap_or_default();
        if child_edges.is_empty() {
            return;
        }
        let (child_prefix, child_prefix_edge_types) = if is_root {
            (String::new(), BTreeMap::new())
        } else {
            let segment = if is_last { chars.space } else { chars.pipe };
            let mut edge_types = prefix_edge_types;
            if !is_last {
                for (offset, character) in segment.chars().enumerate() {
                    if !character.is_whitespace() {
                        mark_edge_cell(
                            &mut edge_types,
                            prefix.chars().count() + offset,
                            &node.node_type,
                            &[],
                        );
                    }
                }
            }
            (format!("{prefix}{segment}"), edge_types)
        };
        let count = child_edges.len();
        for (index, edge) in child_edges.into_iter().enumerate() {
            let Some(child) = by_id.get(&edge.child) else {
                continue;
            };
            self.append_nested_rows(
                rows,
                child,
                children,
                by_id,
                &child_prefix,
                child_prefix_edge_types.clone(),
                index + 1 == count,
                false,
                Some(&node.node_type),
                Some(&edge.label),
                &edge.edge_refs,
                compact_badges,
                emitted,
            );
        }
    }

    fn format_nested_rows(
        &self,
        rows: Vec<NestedRow>,
        relations: &BTreeMap<String, Vec<DisplayEdge>>,
        width: usize,
    ) -> Vec<GraphLine> {
        let row_by_node = rows
            .iter()
            .enumerate()
            .map(|(index, row)| (row.node_id.clone(), index))
            .collect::<HashMap<_, _>>();
        let relation_pairs = nested_relation_pairs(relations, &row_by_node);
        let (expanded, endpoint_rows, endpoint_starts) =
            expand_nested_rows(&rows, &relation_pairs, self.ascii);
        let mut canvas = vec![vec![' '; width]; expanded.len().max(1)];
        let mut edge_types = vec![EdgeCells::new(); canvas.len()];
        for (y, row) in expanded.iter().enumerate() {
            for (x, character) in row.structural.chars().take(width).enumerate() {
                canvas[y][x] = character;
            }
            edge_types[y] = row.edge_types.clone();
        }

        if !relation_pairs.is_empty() && width > 1 {
            let assignments =
                assign_nested_relation_lanes(&relation_pairs, &rows, &endpoint_starts, width);
            let mut edge_grid = vec![vec![0u8; width]; canvas.len()];
            for assignment in &assignments {
                let (Some(source_y), Some(target_y)) = (
                    endpoint_rows.get(&(assignment.pair_index, true)),
                    endpoint_rows.get(&(assignment.pair_index, false)),
                ) else {
                    continue;
                };
                connect_nested_relation_points(
                    &mut edge_grid,
                    &mut edge_types,
                    assignment.lane_x,
                    *source_y,
                    *target_y,
                    &assignment.target_type,
                    &assignment.edge_refs,
                );
            }
            for assignment in &assignments {
                let (Some(source_y), Some(target_y)) = (
                    endpoint_rows.get(&(assignment.pair_index, true)),
                    endpoint_rows.get(&(assignment.pair_index, false)),
                ) else {
                    continue;
                };
                let source_start = endpoint_starts
                    .get(&(assignment.pair_index, true))
                    .copied()
                    .unwrap_or(0)
                    .min(width - 1);
                let target_start = endpoint_starts
                    .get(&(assignment.pair_index, false))
                    .copied()
                    .unwrap_or(0)
                    .min(width - 1);
                draw_nested_horizontal_connector(
                    &mut edge_grid,
                    &mut edge_types,
                    source_start,
                    assignment.lane_x,
                    *source_y,
                    &assignment.target_type,
                    &assignment.edge_refs,
                );
                draw_nested_horizontal_connector(
                    &mut edge_grid,
                    &mut edge_types,
                    target_start,
                    assignment.lane_x,
                    *target_y,
                    &assignment.target_type,
                    &assignment.edge_refs,
                );
            }
            for y in 0..edge_grid.len() {
                for x in 0..width {
                    if edge_grid[y][x] != 0 && canvas[y][x] == ' ' {
                        canvas[y][x] = canvas_edge_char(edge_grid[y][x], self.ascii);
                    }
                }
            }
        }

        // Titles are deliberately painted last. This is the only visual
        // difference from autoresearch-v2: topology remains identical, while
        // title letters win wherever a relationship lane passes underneath.
        for (y, row) in expanded.iter().enumerate() {
            let (Some(start), Some(title)) = (row.title_start, row.title.as_deref()) else {
                continue;
            };
            if !self.show_titles {
                continue;
            }
            let available = width.saturating_sub(start);
            let title = truncate_graph_line(title, available);
            for (offset, character) in title.chars().enumerate() {
                let x = start + offset;
                if x >= width {
                    break;
                }
                canvas[y][x] = character;
            }
        }

        let mut output = Vec::new();
        for (y, row) in expanded.iter().enumerate() {
            let text = canvas[y].iter().collect::<String>().trim_end().to_owned();
            let line_width = text.chars().count();
            let node_spans = row
                .node_span
                .as_ref()
                .filter(|span| span.start < line_width)
                .map(|span| NodeSpan {
                    start: span.start,
                    end: span.end.min(line_width),
                    node_type: span.node_type.clone(),
                    node_id: span.node_id.clone(),
                    edge_refs: span.edge_refs.clone(),
                })
                .into_iter()
                .collect();
            let title_spans = row
                .title_start
                .filter(|start| self.show_titles && *start < line_width)
                .map(|start| TextSpan {
                    start,
                    end: (start
                        + truncate_graph_line(
                            row.title.as_deref().unwrap_or_default(),
                            width.saturating_sub(start),
                        )
                        .chars()
                        .count())
                    .min(line_width),
                    node_id: row.node_span.as_ref().and_then(|span| span.node_id.clone()),
                })
                .into_iter()
                .collect();
            output.push(GraphLine {
                text,
                node_spans,
                title_spans,
                edge_spans: compress_edge_spans(&edge_types[y], &canvas[y], line_width),
            });
        }
        output
    }

    fn primary_tree_edges(
        &self,
        edges: &[DisplayEdge],
        by_id: &HashMap<String, &VisualNode>,
    ) -> Vec<DisplayEdge> {
        let mut by_child = BTreeMap::<String, Vec<&DisplayEdge>>::new();
        for edge in edges {
            by_child.entry(edge.child.clone()).or_default().push(edge);
        }
        by_child
            .into_values()
            .filter_map(|candidates| {
                candidates
                    .into_iter()
                    .min_by_key(|edge| {
                        let parent = by_id[&edge.parent];
                        let child = by_id[&edge.child];
                        let priority = self.parent_priority(parent, child);
                        (
                            if priority >= 1_000 {
                                1_000 + self.hierarchy_rank(&parent.node_type)
                            } else {
                                priority
                            },
                            self.hierarchy_rank(&parent.node_type),
                            parent.sort_title.clone(),
                            parent.id.clone(),
                            edge.label.clone(),
                        )
                    })
                    .cloned()
            })
            .collect()
    }

    fn display_edges<'a>(
        &self,
        nodes: &'a [VisualNode],
        by_id: &HashMap<String, &'a VisualNode>,
    ) -> Vec<DisplayEdge> {
        let mut candidates = Vec::new();
        for source in nodes {
            for (relation, targets) in &source.edges {
                for target_id in targets {
                    let Some(target) = by_id.get(target_id) else {
                        continue;
                    };
                    if source.id == target.id {
                        continue;
                    }
                    let source_rank = self.hierarchy_rank(&source.node_type);
                    let target_rank = self.hierarchy_rank(&target.node_type);
                    let reverse_label = self
                        .reverse_labels
                        .get(&(source.node_type.clone(), relation.clone()));
                    if target_rank < source_rank
                        && reverse_label.is_none()
                        && self.upward_edge_policy == UpwardEdgePolicy::MappedOnly
                    {
                        continue;
                    }
                    let reoriented = target_rank < source_rank && reverse_label.is_some();
                    let (parent, child, label) = if reoriented {
                        (
                            target.id.clone(),
                            source.id.clone(),
                            reverse_label.expect("reoriented edge has a label").clone(),
                        )
                    } else {
                        (source.id.clone(), target.id.clone(), relation.clone())
                    };
                    candidates.push(DisplayEdge {
                        parent,
                        child,
                        label,
                        reoriented,
                        raw_source: source.id.clone(),
                        raw_target: target.id.clone(),
                        edge_refs: vec![GraphEdgeRef {
                            source: source.id.clone(),
                            relation: relation.clone(),
                            target: target.id.clone(),
                        }],
                    });
                }
            }
        }
        // Older graphs can contain both A -> B and B -> A even though the
        // canvas has no arrowheads and the relationship is visually one
        // two-way connection. Keep the direction that flows down the semantic
        // hierarchy (or the deterministic node order within one layer). This
        // removes the redundant second route without collapsing distinct
        // relations that share the same canonical direction.
        let raw_pairs = candidates
            .iter()
            .map(|edge| (edge.raw_source.clone(), edge.raw_target.clone()))
            .collect::<HashSet<_>>();
        let mut reciprocal_refs = HashMap::<(String, String), Vec<GraphEdgeRef>>::new();
        for edge in &candidates {
            if raw_pairs.contains(&(edge.raw_target.clone(), edge.raw_source.clone())) {
                let key = if edge.raw_source <= edge.raw_target {
                    (edge.raw_source.clone(), edge.raw_target.clone())
                } else {
                    (edge.raw_target.clone(), edge.raw_source.clone())
                };
                merge_edge_refs(reciprocal_refs.entry(key).or_default(), &edge.edge_refs);
            }
        }
        candidates.retain(|edge| {
            if !raw_pairs.contains(&(edge.raw_target.clone(), edge.raw_source.clone())) {
                return true;
            }
            let source = by_id[&edge.raw_source];
            let target = by_id[&edge.raw_target];
            let source_rank = self.hierarchy_rank(&source.node_type);
            let target_rank = self.hierarchy_rank(&target.node_type);
            source_rank < target_rank
                || (source_rank == target_rank && self.node_key(source) <= self.node_key(target))
        });
        for edge in &mut candidates {
            let key = if edge.raw_source <= edge.raw_target {
                (edge.raw_source.clone(), edge.raw_target.clone())
            } else {
                (edge.raw_target.clone(), edge.raw_source.clone())
            };
            if let Some(edge_refs) = reciprocal_refs.get(&key) {
                merge_edge_refs(&mut edge.edge_refs, edge_refs);
            }
        }
        // A legacy profile may persist both directions of one inverse pair.
        // When hierarchy display reorients one of those edges onto the same
        // parent/child pair as a canonical edge, show the fact once. Distinct
        // canonical relations between the same nodes remain visible.
        let canonical_pairs = candidates
            .iter()
            .filter(|edge| !edge.reoriented)
            .map(|edge| (edge.parent.clone(), edge.child.clone()))
            .collect::<HashSet<_>>();
        let mut output = Vec::<DisplayEdge>::new();
        let mut edge_index = HashMap::<(String, String, String), usize>::new();
        for edge in candidates.into_iter().filter(|edge| {
            !(edge.reoriented
                && canonical_pairs.contains(&(edge.parent.clone(), edge.child.clone())))
        }) {
            let key = (edge.parent.clone(), edge.child.clone(), edge.label.clone());
            if let Some(index) = edge_index.get(&key).copied() {
                merge_edge_refs(&mut output[index].edge_refs, &edge.edge_refs);
            } else {
                edge_index.insert(key, output.len());
                output.push(edge);
            }
        }
        output.sort_by(|left, right| {
            let left_parent = by_id[&left.parent];
            let right_parent = by_id[&right.parent];
            (
                self.node_key(left_parent),
                self.edge_child_key(left, by_id),
                &left.label,
            )
                .cmp(&(
                    self.node_key(right_parent),
                    self.edge_child_key(right, by_id),
                    &right.label,
                ))
        });
        output
    }

    fn parent_priority(&self, parent: &VisualNode, child: &VisualNode) -> usize {
        self.parent_preferences
            .get(&child.node_type)
            .and_then(|preferences| {
                preferences
                    .iter()
                    .position(|candidate| candidate == &parent.node_type)
            })
            .unwrap_or_else(|| {
                if self.parent_preferences.contains_key(&child.node_type) {
                    1_000
                } else {
                    self.hierarchy_rank(&parent.node_type)
                }
            })
    }

    fn hierarchy_rank(&self, node_type: &str) -> usize {
        self.hierarchy
            .iter()
            .position(|candidate| candidate == node_type)
            .unwrap_or(self.hierarchy.len())
    }

    fn node_key<'a>(&self, node: &'a VisualNode) -> (usize, &'a str, &'a str) {
        (
            self.hierarchy_rank(&node.node_type),
            &node.sort_title,
            &node.id,
        )
    }

    fn edge_child_key<'a>(
        &self,
        edge: &DisplayEdge,
        by_id: &HashMap<String, &'a VisualNode>,
    ) -> (usize, &'a str, &'a str) {
        self.node_key(by_id[&edge.child])
    }
}

fn canvas_badge(node_type: &str, compact: bool) -> String {
    if !compact {
        return format!("[{node_type}]");
    }
    let autoresearch_label = match node_type {
        "hypothesis" => Some("hy"),
        "literature" => Some("li"),
        "paper" => Some("pa"),
        "claim" => Some("cl"),
        "experiment" => Some("ex"),
        "method" => Some("mt"),
        "metric" => Some("me"),
        "prerequisite" => Some("pr"),
        "decision" => Some("de"),
        "ablation" => Some("ab"),
        "asset" => Some("as"),
        "gate" => Some("gt"),
        "implementation" => Some("im"),
        "run" => Some("rn"),
        "evidence" => Some("ev"),
        "report" => Some("rp"),
        "change-request" => Some("cr"),
        _ => None,
    };
    if let Some(label) = autoresearch_label {
        return format!("[{label}]");
    }
    let label = node_type
        .split(['_', '-'])
        .filter_map(|part| part.chars().next())
        .take(2)
        .collect::<String>();
    let label = if label.chars().count() >= 2 {
        label
    } else {
        node_type
            .chars()
            .filter(|character| character.is_alphanumeric())
            .take(2)
            .collect()
    };
    format!("[{}]", if label.is_empty() { "?" } else { &label })
}

fn ensure_canvas_visual_node(
    visuals: &mut Vec<CanvasVisualNode>,
    index: &mut HashMap<(String, usize), usize>,
    node: &VisualNode,
    layer: usize,
) -> String {
    let key = (node.id.clone(), layer);
    if let Some(existing) = index.get(&key).and_then(|offset| visuals.get(*offset)) {
        return existing.visual_id.clone();
    }
    let visual_id = format!("{}@{layer}", node.id);
    index.insert(key, visuals.len());
    visuals.push(CanvasVisualNode {
        visual_id: visual_id.clone(),
        semantic_id: node.id.clone(),
        layer,
        node: node.clone(),
    });
    visual_id
}

fn canvas_token_width(
    node: &CanvasVisualNode,
    compact_badge: bool,
    compact_title: bool,
    show_titles: bool,
    width: usize,
) -> usize {
    let badge_width = canvas_badge(&node.node.node_type, compact_badge)
        .chars()
        .count();
    if !show_titles {
        return badge_width.min(width);
    }
    if !compact_title {
        return (badge_width
            + 1
            + canvas_title(node, compact_badge, false, width)
                .chars()
                .count())
        .min(width);
    }
    (badge_width + 1 + canvas_title_budget(compact_title, width)).min(width)
}

fn canvas_title(
    node: &CanvasVisualNode,
    compact_badge: bool,
    compact_title: bool,
    width: usize,
) -> String {
    let badge_width = canvas_badge(&node.node.node_type, compact_badge)
        .chars()
        .count();
    let available = if compact_title {
        canvas_title_budget(true, width)
    } else {
        width.saturating_sub(badge_width + 1)
    };
    if compact_title {
        compact_canvas_title_words(&node.node.title, available, 4)
    } else {
        truncate_graph_line(
            &node.node.title,
            available.min(node.node.title.chars().count()),
        )
    }
}

fn canvas_title_budget(compact_title: bool, width: usize) -> usize {
    if !compact_title {
        return width.saturating_sub(16).min(42);
    }
    match width {
        0..=47 => 10,
        48..=71 => 14,
        _ => 24,
    }
}

fn compact_canvas_title_words(title: &str, available: usize, preferred_words: usize) -> String {
    let mut selected = Vec::new();
    for word in title.split_whitespace() {
        if selected.len() >= preferred_words {
            break;
        }
        let candidate_width = selected
            .iter()
            .map(|part: &&str| part.chars().count())
            .sum::<usize>()
            + selected.len()
            + word.chars().count();
        if candidate_width > available && !selected.is_empty() {
            break;
        }
        selected.push(word);
    }
    if selected.is_empty() {
        truncate_graph_line(title, available.max(1))
    } else {
        selected.join(" ")
    }
}

fn canvas_lanes<'a>(
    nodes: &[&'a CanvasVisualNode],
    width: usize,
    compact_badges: bool,
    compact_titles: bool,
    show_titles: bool,
) -> Vec<Vec<&'a CanvasVisualNode>> {
    let mut lanes = Vec::<Vec<&CanvasVisualNode>>::new();
    let mut lane = Vec::<&CanvasVisualNode>::new();
    let mut used = 0usize;
    for node in nodes {
        let token_width =
            canvas_token_width(node, compact_badges, compact_titles, show_titles, width);
        let needed = token_width + usize::from(!lane.is_empty()) * 2;
        if !lane.is_empty() && used + needed > width {
            lanes.push(std::mem::take(&mut lane));
            used = 0;
        }
        used += token_width + usize::from(!lane.is_empty()) * 2;
        lane.push(*node);
    }
    if !lane.is_empty() {
        lanes.push(lane);
    }
    lanes
}

fn compress_canvas_layers(layers: HashMap<String, usize>) -> HashMap<String, usize> {
    let mut values = layers.values().copied().collect::<Vec<_>>();
    values.sort_unstable();
    values.dedup();
    let remap = values
        .into_iter()
        .enumerate()
        .map(|(index, layer)| (layer, index))
        .collect::<HashMap<_, _>>();
    layers
        .into_iter()
        .map(|(node, layer)| (node, remap.get(&layer).copied().unwrap_or(0)))
        .collect()
}

fn draw_canvas_route(
    grid: &mut [Vec<u8>],
    edge_types: &mut [EdgeCells],
    route: CanvasRoute,
    node_type: &str,
    edge_refs: &[GraphEdgeRef],
) {
    if route.target_y <= route.source_y {
        return;
    }
    let source_start_y = (route.source_y + 1).min(route.target_y);
    let target_end_y = route.target_y.saturating_sub(1);
    connect_canvas_points_typed(
        grid,
        edge_types,
        route.source_x,
        source_start_y,
        route.source_x,
        route.route_y,
        node_type,
        edge_refs,
    );
    connect_canvas_points_typed(
        grid,
        edge_types,
        route.source_x,
        route.route_y,
        route.target_x,
        route.route_y,
        node_type,
        edge_refs,
    );
    connect_canvas_points_typed(
        grid,
        edge_types,
        route.target_x,
        route.route_y,
        route.target_x,
        target_end_y,
        node_type,
        edge_refs,
    );
}

#[allow(clippy::too_many_arguments)]
fn connect_canvas_points_typed(
    grid: &mut [Vec<u8>],
    edge_types: &mut [EdgeCells],
    start_x: usize,
    start_y: usize,
    end_x: usize,
    end_y: usize,
    node_type: &str,
    edge_refs: &[GraphEdgeRef],
) {
    if start_x == end_x && start_y == end_y {
        return;
    }
    if start_x == end_x {
        let (low, high) = (start_y.min(end_y), start_y.max(end_y));
        for y in low..high {
            mark_canvas_edge_typed(
                grid, edge_types, start_x, y, EDGE_SOUTH, node_type, edge_refs,
            );
            mark_canvas_edge_typed(
                grid,
                edge_types,
                start_x,
                y + 1,
                EDGE_NORTH,
                node_type,
                edge_refs,
            );
        }
        return;
    }
    if start_y == end_y {
        let (low, high) = (start_x.min(end_x), start_x.max(end_x));
        for x in low..high {
            mark_canvas_edge_typed(
                grid, edge_types, x, start_y, EDGE_EAST, node_type, edge_refs,
            );
            mark_canvas_edge_typed(
                grid,
                edge_types,
                x + 1,
                start_y,
                EDGE_WEST,
                node_type,
                edge_refs,
            );
        }
    }
}

fn mark_canvas_edge_typed(
    grid: &mut [Vec<u8>],
    edge_types: &mut [EdgeCells],
    x: usize,
    y: usize,
    direction: u8,
    node_type: &str,
    edge_refs: &[GraphEdgeRef],
) {
    mark_canvas_edge(grid, x, y, direction);
    if let Some(row) = edge_types.get_mut(y) {
        mark_edge_cell(row, x, node_type, edge_refs);
    }
}

fn paint_canvas_text(row: &mut [char], start: usize, value: &str) {
    for (offset, character) in value.chars().enumerate() {
        let Some(cell) = row.get_mut(start + offset) else {
            break;
        };
        *cell = character;
    }
}

fn nested_chars(ascii: bool) -> NestedChars {
    if ascii {
        NestedChars {
            mid: "+-",
            last: "`-",
            pipe: "|  ",
            space: "   ",
        }
    } else {
        NestedChars {
            mid: "├─",
            last: "└─",
            pipe: "│  ",
            space: "   ",
        }
    }
}

fn nested_edge_branch(branch: &str, label: Option<&str>) -> String {
    let Some(label) = label else {
        return branch.to_owned();
    };
    let tail = branch.chars().last().unwrap_or_default();
    format!("{branch}<{}>{tail}", format_relation(label))
}

fn nested_relation_pairs(
    relations: &BTreeMap<String, Vec<DisplayEdge>>,
    row_by_node: &HashMap<String, usize>,
) -> Vec<RelationPair> {
    let mut pairs = Vec::<RelationPair>::new();
    let mut pair_index = HashMap::<(String, String), usize>::new();
    for (source_id, edges) in relations {
        let Some(source_row) = row_by_node.get(source_id).copied() else {
            continue;
        };
        for edge in edges {
            let Some(target_row) = row_by_node.get(&edge.child).copied() else {
                continue;
            };
            if source_row == target_row {
                continue;
            }
            let key = (source_id.clone(), edge.child.clone());
            if let Some(index) = pair_index.get(&key).copied() {
                merge_edge_refs(&mut pairs[index].edge_refs, &edge.edge_refs);
                continue;
            }
            pair_index.insert(key, pairs.len());
            pairs.push(RelationPair {
                source_row,
                target_row,
                source_id: source_id.clone(),
                target_id: edge.child.clone(),
                target_type: String::new(),
                label: edge.label.clone(),
                edge_refs: edge.edge_refs.clone(),
            });
        }
    }
    pairs.sort_by(|left, right| {
        (
            left.source_row.min(left.target_row),
            left.source_row.max(left.target_row),
            &left.source_id,
            &left.target_id,
        )
            .cmp(&(
                right.source_row.min(right.target_row),
                right.source_row.max(right.target_row),
                &right.source_id,
                &right.target_id,
            ))
    });
    pairs
}

type NestedEndpointRows = HashMap<(usize, bool), usize>;
type ExpandedNestedRows = (
    Vec<ExpandedNestedRow>,
    NestedEndpointRows,
    NestedEndpointRows,
);

fn expand_nested_rows(
    rows: &[NestedRow],
    pairs: &[RelationPair],
    ascii: bool,
) -> ExpandedNestedRows {
    let mut endpoints = BTreeMap::<usize, Vec<(usize, bool)>>::new();
    for (index, pair) in pairs.iter().enumerate() {
        endpoints
            .entry(pair.source_row)
            .or_default()
            .push((index, true));
        endpoints
            .entry(pair.target_row)
            .or_default()
            .push((index, false));
    }
    let mut expanded = Vec::new();
    let mut endpoint_rows = HashMap::new();
    let mut endpoint_starts = HashMap::new();
    for (row_index, row) in rows.iter().enumerate() {
        expanded.push(ExpandedNestedRow {
            structural: row.structural.clone(),
            edge_types: row.edge_types.clone(),
            node_span: Some(NodeSpan {
                start: row.node_start,
                end: row.node_end,
                node_type: row.node_type.clone(),
                node_id: Some(row.node_id.clone()),
                edge_refs: Vec::new(),
            }),
            title_start: Some(row.node_end + 1),
            title: Some(row.title.clone()),
        });
        for (pair_index, source) in endpoints.get(&row_index).into_iter().flatten() {
            let label = source.then_some(pairs[*pair_index].label.as_str());
            let (track, edge_types) =
                nested_relation_track_prefix(row, label, &pairs[*pair_index].edge_refs, ascii);
            endpoint_rows.insert((*pair_index, *source), expanded.len());
            endpoint_starts.insert(
                (*pair_index, *source),
                track.chars().count().saturating_sub(1),
            );
            expanded.push(ExpandedNestedRow {
                structural: track,
                edge_types,
                node_span: None,
                title_start: None,
                title: None,
            });
        }
    }
    (expanded, endpoint_rows, endpoint_starts)
}

fn nested_relation_track_prefix(
    row: &NestedRow,
    label: Option<&str>,
    edge_refs: &[GraphEdgeRef],
    ascii: bool,
) -> (String, EdgeCells) {
    let chars = nested_chars(ascii);
    let local_branch = nested_edge_branch(chars.mid, label);
    if row.is_root {
        let mut edge_types = EdgeCells::new();
        for (index, character) in local_branch.chars().enumerate() {
            if !character.is_whitespace() {
                mark_edge_cell(&mut edge_types, index, &row.node_type, edge_refs);
            }
        }
        return (local_branch, edge_types);
    }
    let segment = if row.is_last { chars.space } else { chars.pipe };
    let child_prefix = format!("{}{segment}", row.prefix);
    let track = format!("{child_prefix}{local_branch}");
    let mut edge_types = row.prefix_edge_types.clone();
    if !row.is_last
        && let Some(parent_type) = row.parent_type.as_deref()
    {
        for (offset, character) in segment.chars().enumerate() {
            if !character.is_whitespace() {
                mark_edge_cell(
                    &mut edge_types,
                    row.prefix.chars().count() + offset,
                    parent_type,
                    &[],
                );
            }
        }
    }
    for (offset, character) in local_branch.chars().enumerate() {
        if !character.is_whitespace() {
            mark_edge_cell(
                &mut edge_types,
                child_prefix.chars().count() + offset,
                &row.node_type,
                edge_refs,
            );
        }
    }
    (track, edge_types)
}

fn assign_nested_relation_lanes(
    pairs: &[RelationPair],
    rows: &[NestedRow],
    endpoint_starts: &HashMap<(usize, bool), usize>,
    width: usize,
) -> Vec<LaneAssignment> {
    let mut used = Vec::<(usize, (usize, usize))>::new();
    let mut output = Vec::new();
    for (index, pair) in pairs.iter().enumerate() {
        let span = (
            pair.source_row.min(pair.target_row),
            pair.source_row.max(pair.target_row),
        );
        let base = endpoint_starts
            .get(&(index, true))
            .copied()
            .unwrap_or(0)
            .max(endpoint_starts.get(&(index, false)).copied().unwrap_or(0))
            .max(rows[pair.source_row].structural.chars().count())
            .max(rows[pair.target_row].structural.chars().count())
            .saturating_add(2)
            .min(width.saturating_sub(1));
        let mut lane_x = base;
        'spacing: for spacing in (1..=3usize).rev() {
            for candidate in base..width {
                if used
                    .iter()
                    .all(|(used_x, _)| candidate.abs_diff(*used_x) >= spacing)
                {
                    lane_x = candidate;
                    break 'spacing;
                }
            }
        }
        used.push((lane_x, span));
        output.push(LaneAssignment {
            pair_index: index,
            lane_x,
            target_type: if pair.target_type.is_empty() {
                rows[pair.target_row].node_type.clone()
            } else {
                pair.target_type.clone()
            },
            edge_refs: pair.edge_refs.clone(),
        });
    }
    output
}

fn connect_nested_relation_points(
    grid: &mut [Vec<u8>],
    edge_types: &mut [EdgeCells],
    x: usize,
    start_y: usize,
    end_y: usize,
    node_type: &str,
    edge_refs: &[GraphEdgeRef],
) {
    if start_y == end_y {
        return;
    }
    if start_y < end_y {
        for y in start_y..end_y {
            mark_nested_edge(grid, edge_types, x, y, EDGE_SOUTH, node_type, edge_refs);
            mark_nested_edge(grid, edge_types, x, y + 1, EDGE_NORTH, node_type, edge_refs);
        }
    } else {
        for y in (end_y..start_y).rev() {
            mark_nested_edge(grid, edge_types, x, y + 1, EDGE_NORTH, node_type, edge_refs);
            mark_nested_edge(grid, edge_types, x, y, EDGE_SOUTH, node_type, edge_refs);
        }
    }
}

fn draw_nested_horizontal_connector(
    grid: &mut [Vec<u8>],
    edge_types: &mut [EdgeCells],
    start_x: usize,
    lane_x: usize,
    row: usize,
    node_type: &str,
    edge_refs: &[GraphEdgeRef],
) {
    if start_x == lane_x || row >= grid.len() {
        return;
    }
    let step = if lane_x > start_x { 1isize } else { -1 };
    let low = start_x.min(lane_x);
    let high = start_x.max(lane_x);
    let cap = lane_x.checked_add_signed(-step);
    let gaps = (low.saturating_add(1)..high)
        .filter(|column| {
            Some(*column) != cap
                && *column != lane_x
                && *column != start_x
                && grid[row][*column] & (EDGE_NORTH | EDGE_SOUTH) != 0
        })
        .collect::<HashSet<_>>();
    let mut x = start_x;
    while x != lane_x {
        let Some(next) = x.checked_add_signed(step) else {
            break;
        };
        if !gaps.contains(&x) && !gaps.contains(&next) {
            mark_nested_edge(
                grid,
                edge_types,
                x,
                row,
                if step > 0 { EDGE_EAST } else { EDGE_WEST },
                node_type,
                edge_refs,
            );
            mark_nested_edge(
                grid,
                edge_types,
                next,
                row,
                if step > 0 { EDGE_WEST } else { EDGE_EAST },
                node_type,
                edge_refs,
            );
        }
        x = next;
    }
    if let Some(cap_x) = cap {
        mark_nested_edge(
            grid,
            edge_types,
            cap_x,
            row,
            if step > 0 { EDGE_EAST } else { EDGE_WEST },
            node_type,
            edge_refs,
        );
        mark_nested_edge(
            grid,
            edge_types,
            lane_x,
            row,
            if step > 0 { EDGE_WEST } else { EDGE_EAST },
            node_type,
            edge_refs,
        );
    }
}

fn mark_nested_edge(
    grid: &mut [Vec<u8>],
    edge_types: &mut [EdgeCells],
    x: usize,
    y: usize,
    direction: u8,
    node_type: &str,
    edge_refs: &[GraphEdgeRef],
) {
    mark_canvas_edge(grid, x, y, direction);
    if let Some(row) = edge_types.get_mut(y) {
        mark_edge_cell(row, x, node_type, edge_refs);
    }
}

fn compress_edge_spans(types: &EdgeCells, canvas: &[char], line_width: usize) -> Vec<NodeSpan> {
    let mut spans = Vec::new();
    let mut current: Option<(usize, usize, EdgeCell)> = None;
    for (x, character) in canvas.iter().enumerate().take(line_width) {
        let edge_cell = types
            .get(&x)
            .filter(|_| !character.is_whitespace())
            .cloned();
        match (&mut current, edge_cell) {
            (Some((_, end, active)), Some(next)) if *active == next && *end == x => {
                *end += 1;
            }
            (Some((start, end, active)), next) => {
                spans.push(NodeSpan {
                    start: *start,
                    end: *end,
                    node_type: active.node_type.clone(),
                    node_id: None,
                    edge_refs: active.edge_refs.clone(),
                });
                current = next.map(|cell| (x, x + 1, cell));
            }
            (None, Some(cell)) => current = Some((x, x + 1, cell)),
            (None, None) => {}
        }
    }
    if let Some((start, end, cell)) = current {
        spans.push(NodeSpan {
            start,
            end,
            node_type: cell.node_type,
            node_id: None,
            edge_refs: cell.edge_refs,
        });
    }
    spans
}

const EDGE_NORTH: u8 = 1;
const EDGE_SOUTH: u8 = 2;
const EDGE_WEST: u8 = 4;
const EDGE_EAST: u8 = 8;

fn mark_canvas_edge(grid: &mut [Vec<u8>], x: usize, y: usize, direction: u8) {
    let Some(row) = grid.get_mut(y) else {
        return;
    };
    let Some(cell) = row.get_mut(x) else {
        return;
    };
    *cell |= direction;
}

fn canvas_edge_char(mask: u8, ascii: bool) -> char {
    if ascii {
        let horizontal = mask & (EDGE_WEST | EDGE_EAST) != 0;
        let vertical = mask & (EDGE_NORTH | EDGE_SOUTH) != 0;
        return match (horizontal, vertical) {
            (true, false) => '-',
            (false, true) => '|',
            _ => '+',
        };
    }
    match mask {
        3 => '│',
        12 => '─',
        9 => '└',
        5 => '┘',
        10 => '┌',
        6 => '┐',
        11 => '├',
        7 => '┤',
        14 => '┬',
        13 => '┴',
        15 => '┼',
        1 | 2 => '│',
        4 | 8 => '─',
        _ => '┼',
    }
}

fn format_relation(label: &str) -> String {
    match label {
        "target_claims" => "claims".to_owned(),
        "tested_by" => "tests".to_owned(),
        "applies_to" => "applies".to_owned(),
        "negative_evidence" => "neg-evidence".to_owned(),
        "change_requests" => "changes".to_owned(),
        _ => label.replace('_', "-"),
    }
}

fn compact_node_title(title: &str, node_type: &str) -> String {
    let after_marker = title
        .split_once('—')
        .map(|(_, rest)| rest)
        .or_else(|| title.split_once(" - ").map(|(_, rest)| rest))
        .unwrap_or(title);
    let stopwords = [
        "a", "an", "the", "for", "any", "of", "to", "is", "are", "be", "when", "every", "exactly",
        "that", "this", "and", "at", "by", "declared", "from", "in", "into", "observed", "on",
        "recorded", "with",
    ];
    let mut words = after_marker
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .filter(|word| {
            let lower = word.to_ascii_lowercase();
            !stopwords.contains(&lower.as_str())
                && lower != node_type.replace(['_', '-'], " ")
                && !looks_like_node_code(&lower)
        })
        .take(4)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if words.len() < 2 {
        words = after_marker
            .split_whitespace()
            .map(|word| word.trim_matches(|character: char| !character.is_alphanumeric()))
            .filter(|word| !word.is_empty())
            .take(4)
            .map(ToOwned::to_owned)
            .collect();
    }
    if words.is_empty() {
        format!("Untitled {}", node_type.replace(['_', '-'], " "))
    } else {
        if words.len() == 1 {
            let type_label = node_type.replace(['_', '-'], " ");
            words.push(if words[0].eq_ignore_ascii_case(&type_label) {
                "node".to_owned()
            } else {
                type_label
            });
        }
        words.join(" ")
    }
}

fn looks_like_node_code(word: &str) -> bool {
    let mut chars = word.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && chars.clone().any(|character| character.is_ascii_digit())
        && chars.all(|character| character.is_ascii_alphanumeric())
}

pub(crate) fn truncate_graph_line(text: &str, width: usize) -> String {
    let count = text.chars().count();
    if count <= width {
        return text.to_owned();
    }
    if width <= 1 {
        return "…".chars().take(width).collect();
    }
    format!("{}…", text.chars().take(width - 1).collect::<String>())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::json;

    use super::*;

    fn display_edges(renderer: &GraphRenderer, values: &[Value]) -> Vec<DisplayEdge> {
        let mut nodes = values
            .iter()
            .filter_map(VisualNode::from_value)
            .collect::<Vec<_>>();
        nodes.sort_by(|left, right| renderer.node_key(left).cmp(&renderer.node_key(right)));
        let by_id = nodes
            .iter()
            .map(|node| (node.id.clone(), node))
            .collect::<HashMap<_, _>>();
        renderer.display_edges(&nodes, &by_id)
    }

    #[test]
    fn explicit_layered_canvas_keeps_centered_semantic_geometry() {
        let values = vec![
            json!({"id":"h","type":"hypothesis","title":"Root","edges":{"claims":["c1","c2"]}}),
            json!({"id":"c1","type":"claim","title":"First","edges":{"related":["c2"]}}),
            json!({"id":"c2","type":"claim","title":"Second","edges":{}}),
        ];
        let lines = GraphRenderer::default()
            .with_layout("layered")
            .with_hierarchy(vec!["hypothesis".to_owned(), "claim".to_owned()])
            .with_layers(vec![
                vec!["hypothesis".to_owned()],
                vec!["claim".to_owned()],
            ])
            .render_values(&values, 72);
        let text = lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            text,
            concat!(
                "                              [hypothesis] Root hypothesis\n",
                "                                   │\n",
                "      ─────────────────────────────┴─────\n",
                "   [claim] First claim               [claim] Second claim"
            )
        );
        assert!(!text.contains("<claims>"), "{text}");
        assert!(lines.iter().any(|line| !line.title_spans.is_empty()));
    }

    #[test]
    fn rendered_spans_retain_semantic_node_and_edge_identity() {
        let values = vec![
            json!({
                "id":"claim-a",
                "type":"claim",
                "title":"Claim A",
                "edges":{"tested_by":["experiment-a"]}
            }),
            json!({
                "id":"experiment-a",
                "type":"experiment",
                "title":"Experiment A",
                "edges":{}
            }),
        ];
        let lines = GraphRenderer::default().render_values(&values, 72);
        assert!(lines.iter().flat_map(|line| &line.node_spans).any(|span| {
            span.node_id.as_deref() == Some("claim-a") && span.edge_refs.is_empty()
        }));
        assert!(
            lines
                .iter()
                .flat_map(|line| &line.title_spans)
                .any(|span| { span.node_id.as_deref() == Some("experiment-a") })
        );
        assert!(lines.iter().flat_map(|line| &line.edge_spans).any(|span| {
            span.edge_refs.contains(&GraphEdgeRef {
                source: "claim-a".to_owned(),
                relation: "tested_by".to_owned(),
                target: "experiment-a".to_owned(),
            })
        }));
    }

    #[test]
    fn compact_canvas_badges_match_autoresearch_type_labels() {
        assert_eq!(canvas_badge("hypothesis", true), "[hy]");
        assert_eq!(canvas_badge("gate", true), "[gt]");
        assert_eq!(canvas_badge("method", true), "[mt]");
        assert_eq!(canvas_badge("metric", true), "[me]");
        assert_eq!(canvas_badge("change-request", true), "[cr]");
        assert_eq!(canvas_badge("custom_node", true), "[cn]");
    }

    #[test]
    fn layered_canvas_repeats_configured_semantic_types_without_duplicate_records() {
        let values = vec![
            json!({
                "id":"h",
                "type":"hypothesis",
                "title":"Root",
                "edges":{"claims":["c"],"gates":["g"]}
            }),
            json!({
                "id":"c",
                "type":"claim",
                "title":"Claim",
                "edges":{"gates":["g"]}
            }),
            json!({"id":"g","type":"gate","title":"Shared gate","edges":{}}),
        ];
        let lines = GraphRenderer::default()
            .with_layout("layered")
            .with_hierarchy(vec![
                "hypothesis".to_owned(),
                "claim".to_owned(),
                "gate".to_owned(),
            ])
            .with_layers(vec![
                vec!["hypothesis".to_owned()],
                vec!["claim".to_owned()],
                vec!["gate".to_owned()],
            ])
            .with_parent_preferences(BTreeMap::from([
                ("claim".to_owned(), vec!["hypothesis".to_owned()]),
                (
                    "gate".to_owned(),
                    vec!["hypothesis".to_owned(), "claim".to_owned()],
                ),
            ]))
            .with_repeat_semantic_types(vec!["gate".to_owned()])
            .render_values(&values, 72);

        assert_eq!(
            lines
                .iter()
                .flat_map(|line| &line.node_spans)
                .filter(|span| span.node_type == "gate")
                .count(),
            2,
            "{lines:#?}"
        );
    }

    #[test]
    fn legacy_profiles_derive_layers_from_secondary_hierarchy_edges() {
        let values = vec![
            json!({"id":"h","type":"hypothesis","title":"Root","edges":{"claims":["c"],"experiments":["e"]}}),
            json!({"id":"c","type":"claim","title":"Claim","edges":{"tested_by":["e"]}}),
            json!({"id":"e","type":"experiment","title":"Experiment","edges":{}}),
        ];
        let lines = GraphRenderer::default()
            .with_layout("layered")
            .with_hierarchy(vec![
                "hypothesis".to_owned(),
                "claim".to_owned(),
                "experiment".to_owned(),
            ])
            .with_parent_preferences(BTreeMap::from([
                ("claim".to_owned(), vec!["hypothesis".to_owned()]),
                (
                    "experiment".to_owned(),
                    vec!["hypothesis".to_owned(), "claim".to_owned()],
                ),
            ]))
            .render_values(&values, 80);
        let claim_y = lines
            .iter()
            .position(|line| line.text.contains("[claim] Claim"))
            .unwrap();
        let experiment_y = lines
            .iter()
            .position(|line| line.text.contains("[experiment] Experiment"))
            .unwrap();

        assert!(claim_y < experiment_y, "{lines:#?}");
    }

    #[test]
    fn canvas_keeps_muted_title_spans_separate_from_colored_node_badges() {
        let values = vec![
            json!({
                "id":"h",
                "type":"hypothesis",
                "title":"Deterministic finite list behavior",
                "edges":{"claims":["c1","c2"]}
            }),
            json!({
                "id":"c1",
                "type":"claim",
                "title":"First claim",
                "edges":{"related":["c2"]}
            }),
            json!({
                "id":"c2",
                "type":"claim",
                "title":"Second claim",
                "edges":{}
            }),
        ];
        let lines = GraphRenderer::default()
            .with_layout("layered")
            .with_hierarchy(vec!["hypothesis".to_owned(), "claim".to_owned()])
            .with_layers(vec![
                vec!["hypothesis".to_owned()],
                vec!["claim".to_owned()],
            ])
            .render_values(&values, 64);
        let target = lines
            .iter()
            .find(|line| line.text.contains("[claim] Second claim"))
            .unwrap();
        let second_byte = target.text.find("Second claim").unwrap();
        let second_start = target.text[..second_byte].chars().count();
        let title = target
            .title_spans
            .iter()
            .find(|span| span.start == second_start)
            .unwrap_or_else(|| panic!("missing second title span at {second_start}: {target:?}"));
        assert_eq!(
            target.text.chars().nth(target.node_spans[0].end),
            Some(' '),
            "{target:?}"
        );

        assert_eq!(
            target
                .text
                .chars()
                .skip(title.start)
                .take(title.end - title.start)
                .collect::<String>(),
            "Second claim"
        );
    }

    #[test]
    fn preserves_distinct_relationships_between_the_same_nodes() {
        let values = vec![
            json!({"id":"a","type":"task","title":"A","edges":{"blocks":["b"],"informs":["b"]}}),
            json!({"id":"b","type":"task","title":"B","edges":{}}),
        ];
        let edges = display_edges(&GraphRenderer::new(true), &values);
        assert_eq!(edges.len(), 2);
        assert_eq!(
            edges
                .iter()
                .map(|edge| edge.label.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["blocks", "informs"])
        );
    }

    #[test]
    fn collapses_unconfigured_reciprocal_pairs_into_one_visual_connection() {
        let values = vec![
            json!({"id":"l","type":"literature","title":"Source","edges":{"informs":["c"]}}),
            json!({"id":"c","type":"claim","title":"Finding","edges":{"literature":["l"]}}),
        ];
        let renderer = GraphRenderer::default()
            .with_hierarchy(vec!["literature".to_owned(), "claim".to_owned()]);
        let edges = display_edges(&renderer, &values);

        assert_eq!(edges.len(), 1, "{edges:?}");
        assert_eq!(edges[0].parent, "l");
        assert_eq!(edges[0].child, "c");
        assert_eq!(edges[0].label, "informs");
    }

    #[test]
    fn reverses_research_edges_for_display() {
        let values = vec![
            json!({"id":"c","type":"claim","title":"Claim","edges":{}}),
            json!({"id":"e","type":"experiment","title":"Trial","edges":{"target_claims":["c"]}}),
        ];
        let renderer = GraphRenderer::default()
            .with_hierarchy(vec!["claim".to_owned(), "experiment".to_owned()])
            .with_reverse_labels(BTreeMap::from([(
                ("experiment".to_owned(), "target_claims".to_owned()),
                "tests".to_owned(),
            )]));
        let edges = display_edges(&renderer, &values);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].parent, "c");
        assert_eq!(edges[0].child, "e");
        assert_eq!(edges[0].label, "tests");
        let text = renderer
            .clone()
            .with_layout("nested")
            .render_values(&values, 60)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.lines().next().unwrap().contains("[claim]"));
        assert!(text.contains("[experiment]"), "{text}");
    }

    #[test]
    fn explicit_nested_layout_keeps_primary_spine_and_side_lanes() {
        let values = vec![
            json!({"id":"h","type":"hypothesis","title":"Root hypothesis","edges":{"claims":["c1","c2"]}}),
            json!({"id":"c1","type":"claim","title":"Primary claim","edges":{"tested_by":["e"],"related":["c2"]}}),
            json!({"id":"c2","type":"claim","title":"Secondary claim","edges":{"tested_by":["e"]}}),
            json!({"id":"e","type":"experiment","title":"Shared experiment","edges":{}}),
        ];
        let lines = GraphRenderer::default()
            .with_layout("nested")
            .with_hierarchy(vec![
                "hypothesis".to_owned(),
                "claim".to_owned(),
                "experiment".to_owned(),
            ])
            .with_parent_preferences(BTreeMap::from([
                ("claim".to_owned(), vec!["hypothesis".to_owned()]),
                ("experiment".to_owned(), vec!["claim".to_owned()]),
            ]))
            .render_values(&values, 88);
        let text = lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            text.lines()
                .next()
                .unwrap()
                .starts_with("[hypothesis] Root"),
            "{text}"
        );
        assert!(text.contains("├─<claims>─[claim] Primary claim"), "{text}");
        assert!(
            text.contains("└─<claims>─[claim] Secondary claim"),
            "{text}"
        );
        assert!(text.contains("<tests>"), "{text}");
        assert!(text.contains('│') && text.contains('─'), "{text}");
        assert!(lines.iter().any(|line| !line.title_spans.is_empty()));
        assert!(lines.iter().any(|line| !line.edge_spans.is_empty()));
    }

    #[test]
    fn nested_relationship_outline_geometry_stays_stable() {
        let values = vec![
            json!({
                "id":"h",
                "type":"hypothesis",
                "title":"Sortedness hypothesis",
                "edges":{"claims":["c1","c2"],"experiments":["e"]}
            }),
            // Canonical title order is deliberately opposite the compact
            // display-title order. AR sorts by these full titles.
            json!({
                "id":"c1",
                "type":"claim",
                "title":"C1 — Zebra result",
                "short_title":"Zebra display",
                "edges":{"tested_by":["e"]}
            }),
            json!({
                "id":"c2",
                "type":"claim",
                "title":"C2 — Alpha result",
                "short_title":"Alpha display",
                "edges":{"tested_by":["e"]}
            }),
            json!({
                "id":"e",
                "type":"experiment",
                "title":"Shared experiment",
                "edges":{
                    "target_claims":["c1","c2"],
                    "methods":["m"],
                    "ablations":["a"]
                }
            }),
            json!({"id":"m","type":"method","title":"Shared method","edges":{}}),
            json!({
                "id":"a",
                "type":"ablation",
                "title":"Control ablation",
                "edges":{"method":["m"],"target_claims":["c1"]}
            }),
        ];
        let text = GraphRenderer::default()
            .with_layout("nested")
            .with_titles(false)
            .with_upward_edge_policy("mapped_only")
            .with_hierarchy(vec![
                "hypothesis".to_owned(),
                "claim".to_owned(),
                "experiment".to_owned(),
                "method".to_owned(),
                "ablation".to_owned(),
            ])
            .with_parent_preferences(BTreeMap::from([
                (
                    "claim".to_owned(),
                    vec!["claim".to_owned(), "hypothesis".to_owned()],
                ),
                (
                    "experiment".to_owned(),
                    vec!["hypothesis".to_owned(), "claim".to_owned()],
                ),
                (
                    "method".to_owned(),
                    vec![
                        "experiment".to_owned(),
                        "claim".to_owned(),
                        "hypothesis".to_owned(),
                    ],
                ),
                (
                    "ablation".to_owned(),
                    vec![
                        "method".to_owned(),
                        "experiment".to_owned(),
                        "claim".to_owned(),
                    ],
                ),
            ]))
            .with_reverse_labels(BTreeMap::from([
                (
                    ("experiment".to_owned(), "target_claims".to_owned()),
                    "tested_by".to_owned(),
                ),
                (
                    ("ablation".to_owned(), "target_claims".to_owned()),
                    "ablations".to_owned(),
                ),
            ]))
            .render_values(&values, 52)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");

        assert_eq!(
            text,
            r#"[hypothesis]
├─<claims>─[claim]
│  ├─<tests>──────────────────┐
│  ├─<ablations>──────────────│──┐
├─<claims>─[claim]            │  │
│  ├─<tests>──────────────────│──│──┐
└─<experiments>─[experiment]  │  │  │
   ├──────────────────────────┘  │  │
   ├─────────────────────────────│──┘
   ├─<methods>─[method]          │
   └─<ablations>─[ablation]      │
      ├──────────────────────────┘"#
        );
    }

    #[test]
    fn collapses_legacy_reciprocal_edges_into_one_display_relationship() {
        let values = vec![
            json!({"id":"c","type":"claim","title":"Claim","edges":{"tested_by":["e"]}}),
            json!({"id":"e","type":"experiment","title":"Trial","edges":{"target_claims":["c"]}}),
        ];
        let renderer = GraphRenderer::default()
            .with_hierarchy(vec!["claim".to_owned(), "experiment".to_owned()])
            .with_reverse_labels(BTreeMap::from([(
                ("experiment".to_owned(), "target_claims".to_owned()),
                "tests".to_owned(),
            )]));
        let edges = display_edges(&renderer, &values);
        assert_eq!(edges.len(), 1, "{edges:?}");
        assert_eq!(edges[0].parent, "c");
        assert_eq!(edges[0].child, "e");
        assert_eq!(edges[0].label, "tested_by");
        assert_eq!(edges[0].edge_refs.len(), 2, "{edges:?}");
    }

    #[test]
    fn default_renderer_does_not_invent_domain_specific_edge_direction() {
        let values = vec![
            json!({"id":"c","type":"claim","title":"Claim","edges":{}}),
            json!({"id":"e","type":"experiment","title":"Trial","edges":{"target_claims":["c"]}}),
        ];
        let edges = display_edges(&GraphRenderer::default(), &values);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].parent, "e");
        assert_eq!(edges[0].child, "c");
        assert_eq!(edges[0].label, "target_claims");
    }

    #[test]
    fn ascii_mode_avoids_box_drawing() {
        let values = vec![
            json!({"id":"h","type":"hypothesis","title":"Root","edges":{"claims":["c"]}}),
            json!({"id":"c","type":"claim","title":"Child","edges":{}}),
        ];
        let text = GraphRenderer::new(true)
            .with_hierarchy(vec!["hypothesis".to_owned(), "claim".to_owned()])
            .render_values(&values, 60)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!text.contains('├'));
        assert!(text.contains('|') || text.contains('-'), "{text}");
    }

    #[test]
    fn untitled_nodes_use_a_human_fallback_instead_of_their_id() {
        let values = vec![json!({
            "id":"019f-secret-internal-id",
            "type":"research_question",
            "edges":{}
        })];
        let text = GraphRenderer::default()
            .render_values(&values, 60)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(text.contains("Untitled research"), "{text}");
        assert!(!text.contains("019f-secret"), "{text}");
    }

    #[test]
    fn long_domain_titles_become_two_to_four_word_map_labels() {
        let values = vec![
            json!({
                "id":"c1",
                "type":"claim",
                "title":"C1 — Public interface returns exact Boolean results for supported calls",
                "edges":{"gates":["g1"]}
            }),
            json!({
                "id":"g1",
                "type":"gate",
                "title":"G1 — Exact Boolean interface acceptance gate",
                "edges":{}
            }),
        ];
        let text = GraphRenderer::default()
            .render_values(&values, 80)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            text.contains("[claim] Public interface returns exact"),
            "{text}"
        );
        assert!(
            text.contains("[gate] Exact Boolean interface acceptance"),
            "{text}"
        );
        assert!(!text.contains("supported calls"), "{text}");
    }

    #[test]
    fn dense_relationships_stay_inside_the_canvas_width() {
        let values = vec![
            json!({"id":"h","type":"hypothesis","title":"Finite list sortedness","edges":{"claims":["c1","c2"]}}),
            json!({"id":"c1","type":"claim","title":"Sound true result","edges":{"related":["c2"]}}),
            json!({"id":"c2","type":"claim","title":"Complete false result","edges":{}}),
        ];
        let lines = GraphRenderer::default()
            .with_hierarchy(vec!["hypothesis".to_owned(), "claim".to_owned()])
            .render_values(&values, 64);
        let text = lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(lines.iter().all(|line| line.text.chars().count() <= 64));
        assert!(text.contains("Sound true result"), "{text}");
        assert!(text.contains("Complete false result"), "{text}");
        assert!(text.contains('│') || text.contains('─'), "{text}");
    }
}
