use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphLine {
    pub text: String,
    #[serde(default)]
    pub node_spans: Vec<NodeSpan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeSpan {
    pub start: usize,
    pub end: usize,
    pub node_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VisualNode {
    id: String,
    node_type: String,
    title: String,
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
        let title = object
            .get("short_title")
            .or_else(|| object.get("label"))
            .or_else(|| object.get("title"))
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .map(|title| compact_node_title(title, &node_type))
            .unwrap_or_else(|| format!("Untitled {}", node_type.replace(['_', '-'], " ")));
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
            edges,
        })
    }
}

#[derive(Debug, Clone)]
struct DisplayEdge {
    parent: String,
    child: String,
    label: String,
}

#[derive(Debug, Clone)]
struct TreeRow {
    node_id: String,
    text: String,
    incoming_relation: Option<String>,
    prefix: String,
    node_start: usize,
    node_end: usize,
    node_type: String,
}

/// Deterministic terminal graph renderer. Primary relationships form the tree; secondary
/// relationships are rendered directly beneath their source so the topology stays readable in a
/// narrow dashboard instead of routing long lanes around full document titles.
#[derive(Debug, Clone)]
pub struct GraphRenderer {
    ascii: bool,
    show_titles: bool,
    hierarchy: Vec<String>,
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
            hierarchy: Vec::new(),
            parent_preferences: BTreeMap::new(),
            reverse_labels: BTreeMap::new(),
        }
    }

    pub fn with_titles(mut self, show_titles: bool) -> Self {
        self.show_titles = show_titles;
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
            }];
        }
        let by_id: HashMap<_, _> = nodes.iter().map(|node| (node.id.clone(), node)).collect();
        let display_edges = self.display_edges(nodes, &by_id);
        let tree_edges = self.primary_tree_edges(&display_edges, &by_id);
        let tree_keys: HashSet<_> = tree_edges
            .iter()
            .map(|edge| (edge.parent.clone(), edge.child.clone(), edge.label.clone()))
            .collect();

        let mut children: HashMap<String, Vec<DisplayEdge>> = HashMap::new();
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
                self.edge_child_key(left, &by_id)
                    .cmp(&self.edge_child_key(right, &by_id))
            });
        }

        let mut relations: HashMap<String, Vec<DisplayEdge>> = HashMap::new();
        for edge in display_edges {
            if !tree_keys.contains(&(edge.parent.clone(), edge.child.clone(), edge.label.clone())) {
                relations.entry(edge.parent.clone()).or_default().push(edge);
            }
        }
        for edges in relations.values_mut() {
            edges.sort_by(|left, right| {
                (
                    format_relation(&left.label),
                    self.edge_child_key(left, &by_id),
                )
                    .cmp(&(
                        format_relation(&right.label),
                        self.edge_child_key(right, &by_id),
                    ))
            });
        }

        let mut roots: Vec<_> = nodes
            .iter()
            .filter(|node| !child_ids.contains(&node.id))
            .collect();
        roots.sort_by(|left, right| self.node_key(left).cmp(&self.node_key(right)));
        if roots.is_empty() {
            roots.push(&nodes[0]);
        }

        let mut rows = Vec::new();
        let mut emitted = HashSet::new();
        for (index, root) in roots.iter().enumerate() {
            self.append_rows(
                &mut rows,
                root,
                &children,
                &by_id,
                "",
                index + 1 == roots.len(),
                true,
                None,
                &mut emitted,
            );
        }
        for node in nodes {
            if !emitted.contains(&node.id) {
                self.append_rows(
                    &mut rows,
                    node,
                    &children,
                    &by_id,
                    "",
                    true,
                    true,
                    None,
                    &mut emitted,
                );
            }
        }
        self.format_rows(rows, relations, &by_id, width)
    }

    fn display_edges<'a>(
        &self,
        nodes: &'a [VisualNode],
        by_id: &HashMap<String, &'a VisualNode>,
    ) -> Vec<DisplayEdge> {
        let mut output = Vec::new();
        let mut seen = HashSet::new();
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
                    let (parent, child, label) = if target_rank < source_rank
                        && let Some(label) = reverse_label
                    {
                        (target.id.clone(), source.id.clone(), label.clone())
                    } else {
                        (source.id.clone(), target.id.clone(), relation.clone())
                    };
                    if seen.insert((parent.clone(), child.clone(), label.clone())) {
                        output.push(DisplayEdge {
                            parent,
                            child,
                            label,
                        });
                    }
                }
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

    fn primary_tree_edges(
        &self,
        edges: &[DisplayEdge],
        by_id: &HashMap<String, &VisualNode>,
    ) -> Vec<DisplayEdge> {
        let mut by_child: HashMap<String, Vec<&DisplayEdge>> = HashMap::new();
        for edge in edges {
            by_child.entry(edge.child.clone()).or_default().push(edge);
        }
        let mut selected = Vec::new();
        for candidates in by_child.values() {
            let chosen = candidates.iter().min_by_key(|edge| {
                let parent = by_id[&edge.parent];
                let child = by_id[&edge.child];
                (
                    self.parent_priority(parent, child),
                    self.node_key(parent),
                    edge.label.clone(),
                    parent.id.clone(),
                )
            });
            if let Some(edge) = chosen {
                selected.push((*edge).clone());
            }
        }
        selected
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

    #[allow(clippy::too_many_arguments)]
    fn append_rows<'a>(
        &self,
        rows: &mut Vec<TreeRow>,
        node: &'a VisualNode,
        children: &HashMap<String, Vec<DisplayEdge>>,
        by_id: &HashMap<String, &'a VisualNode>,
        prefix: &str,
        is_last: bool,
        is_root: bool,
        incoming_label: Option<&str>,
        emitted: &mut HashSet<String>,
    ) {
        if !emitted.insert(node.id.clone()) {
            return;
        }
        let (mid, last, pipe, space) = if self.ascii {
            ("+-", "`-", "|  ", "   ")
        } else {
            ("├─", "└─", "│  ", "   ")
        };
        let branch = if is_root {
            String::new()
        } else if is_last {
            last.to_owned()
        } else {
            mid.to_owned()
        };
        let incoming_relation =
            incoming_label.map(|label| format!("{prefix}{branch}<{}>", format_relation(label)));
        let content_prefix = if is_root {
            prefix.to_owned()
        } else {
            format!("{prefix}{}", if is_last { space } else { pipe })
        };
        let type_badge = format!("[{}]", node.node_type);
        let node_ref = if self.show_titles {
            format!("{type_badge} {}", node.title)
        } else {
            type_badge.clone()
        };
        let node_start = content_prefix.chars().count();
        let text = format!("{content_prefix}{node_ref}");
        rows.push(TreeRow {
            node_id: node.id.clone(),
            text,
            incoming_relation,
            prefix: content_prefix.clone(),
            node_start,
            node_end: node_start + type_badge.chars().count(),
            node_type: node.node_type.clone(),
        });
        let child_edges = children.get(&node.id).cloned().unwrap_or_default();
        let child_prefix = content_prefix;
        let count = child_edges.len();
        for (index, edge) in child_edges.into_iter().enumerate() {
            if let Some(child) = by_id.get(&edge.child) {
                self.append_rows(
                    rows,
                    child,
                    children,
                    by_id,
                    &child_prefix,
                    index + 1 == count,
                    false,
                    Some(&edge.label),
                    emitted,
                );
            }
        }
    }

    fn format_rows(
        &self,
        rows: Vec<TreeRow>,
        relations: HashMap<String, Vec<DisplayEdge>>,
        by_id: &HashMap<String, &VisualNode>,
        width: usize,
    ) -> Vec<GraphLine> {
        let mut output = Vec::new();
        for row in rows {
            if let Some(relation) = row.incoming_relation.as_deref() {
                output.push(GraphLine {
                    text: truncate_graph_line(relation, width),
                    node_spans: Vec::new(),
                });
            }
            output.push(GraphLine {
                text: truncate_graph_line(&row.text, width),
                node_spans: (row.node_start < width)
                    .then(|| NodeSpan {
                        start: row.node_start,
                        end: row.node_end.min(width),
                        node_type: row.node_type.clone(),
                    })
                    .into_iter()
                    .collect(),
            });
            let edges = relations.get(&row.node_id).cloned().unwrap_or_default();
            let count = edges.len();
            for (index, edge) in edges.into_iter().enumerate() {
                let Some(target) = by_id.get(&edge.child) else {
                    continue;
                };
                let (branch, arrow) = if self.ascii {
                    (if index + 1 == count { "`-" } else { "+-" }, "->")
                } else {
                    (
                        if index + 1 == count {
                            "└─"
                        } else {
                            "├─"
                        },
                        "→",
                    )
                };
                let prefix = row.prefix.clone();
                let relation =
                    format!("{prefix}{branch}<{}>{arrow} ", format_relation(&edge.label));
                let target_ref = if self.show_titles {
                    format!("[{}] {}", target.node_type, target.title)
                } else {
                    format!("[{}]", target.node_type)
                };
                let target_start = relation.chars().count();
                let target_end = target_start + format!("[{}]", target.node_type).chars().count();
                output.push(GraphLine {
                    text: truncate_graph_line(&format!("{relation}{target_ref}"), width),
                    node_spans: (target_start < width)
                        .then(|| NodeSpan {
                            start: target_start,
                            end: target_end.min(width),
                            node_type: target.node_type.clone(),
                        })
                        .into_iter()
                        .collect(),
                });
            }
        }
        output
    }

    fn hierarchy_rank(&self, node_type: &str) -> usize {
        self.hierarchy
            .iter()
            .position(|candidate| candidate == node_type)
            .unwrap_or(self.hierarchy.len())
    }

    fn node_key<'a>(&self, node: &'a VisualNode) -> (usize, &'a str, &'a str) {
        (self.hierarchy_rank(&node.node_type), &node.title, &node.id)
    }

    fn edge_child_key<'a>(
        &self,
        edge: &DisplayEdge,
        by_id: &HashMap<String, &'a VisualNode>,
    ) -> (usize, &'a str, &'a str) {
        self.node_key(by_id[&edge.child])
    }
}

fn format_relation(label: &str) -> String {
    label.replace('_', "-")
}

fn compact_node_title(title: &str, node_type: &str) -> String {
    let after_marker = title
        .split_once('—')
        .map(|(_, rest)| rest)
        .or_else(|| title.split_once(" - ").map(|(_, rest)| rest))
        .unwrap_or(title);
    let stopwords = [
        "a", "an", "the", "for", "any", "of", "to", "is", "are", "be", "when", "every", "exactly",
        "that", "this", "and",
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

fn truncate_graph_line(text: &str, width: usize) -> String {
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
    use serde_json::json;

    use super::*;

    #[test]
    fn renders_primary_tree_and_secondary_relation_lane() {
        let values = vec![
            json!({"id":"h","type":"hypothesis","title":"Root","edges":{"claims":["c1","c2"]}}),
            json!({"id":"c1","type":"claim","title":"First","edges":{"related":["c2"]}}),
            json!({"id":"c2","type":"claim","title":"Second","edges":{}}),
        ];
        let text = GraphRenderer::default()
            .render_values(&values, 72)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("[hypothesis]"));
        assert!(text.contains("<claims>"));
        assert!(text.contains("<related>"));
        assert!(text.contains("→ [claim]"), "{text}");
    }

    #[test]
    fn preserves_distinct_relationships_between_the_same_nodes() {
        let values = vec![
            json!({"id":"a","type":"task","title":"A","edges":{"blocks":["b"],"informs":["b"]}}),
            json!({"id":"b","type":"task","title":"B","edges":{}}),
        ];
        let rendered = GraphRenderer::new(true)
            .render_values(&values, 100)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("blocks"), "{rendered}");
        assert!(rendered.contains("informs"), "{rendered}");
    }

    #[test]
    fn reverses_research_edges_for_display() {
        let values = vec![
            json!({"id":"c","type":"claim","title":"Claim","edges":{}}),
            json!({"id":"e","type":"experiment","title":"Trial","edges":{"target_claims":["c"]}}),
        ];
        let text = GraphRenderer::default()
            .with_hierarchy(vec!["claim".to_owned(), "experiment".to_owned()])
            .with_reverse_labels(BTreeMap::from([(
                ("experiment".to_owned(), "target_claims".to_owned()),
                "tests".to_owned(),
            )]))
            .render_values(&values, 60)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.lines().next().unwrap().contains("[claim]"));
        assert!(text.contains("<tests>"));
        assert!(text.contains("[experiment]"));
    }

    #[test]
    fn default_renderer_does_not_invent_domain_specific_edge_direction() {
        let values = vec![
            json!({"id":"c","type":"claim","title":"Claim","edges":{}}),
            json!({"id":"e","type":"experiment","title":"Trial","edges":{"target_claims":["c"]}}),
        ];
        let text = GraphRenderer::default()
            .render_values(&values, 60)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.lines().next().unwrap().contains("[experiment]"));
        assert!(text.contains("<target-claims>"));
    }

    #[test]
    fn ascii_mode_avoids_box_drawing() {
        let values = vec![
            json!({"id":"h","type":"hypothesis","title":"Root","edges":{"claims":["c"]}}),
            json!({"id":"c","type":"claim","title":"Child","edges":{}}),
        ];
        let text = GraphRenderer::new(true)
            .render_values(&values, 60)
            .into_iter()
            .map(|line| line.text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!text.contains('├'));
        assert!(text.contains("<claims>"));
        assert!(text.contains('`') || text.contains('+'));
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

        assert!(text.contains("Untitled research question"), "{text}");
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
    fn secondary_relationships_render_beneath_sources_without_outer_lanes() {
        let values = vec![
            json!({"id":"h","type":"hypothesis","title":"Finite list sortedness","edges":{"claims":["c1","c2"]}}),
            json!({"id":"c1","type":"claim","title":"Sound true result","edges":{"related":["c2"]}}),
            json!({"id":"c2","type":"claim","title":"Complete false result","edges":{}}),
        ];
        let lines = GraphRenderer::default().render_values(&values, 64);
        let related = lines
            .iter()
            .find(|line| line.text.contains("<related>"))
            .expect("secondary relation row");

        assert!(
            related.text.contains("→ [claim] Complete false result"),
            "{related:?}"
        );
        assert!(lines.iter().all(|line| line.text.chars().count() <= 64));
        assert!(!lines.iter().any(|line| line.text.ends_with('│')));
    }
}
