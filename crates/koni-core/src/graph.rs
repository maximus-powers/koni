use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::error::{KoniError, Result, io_error};

pub type NodeId = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Node {
    #[serde(default = "default_schema_version")]
    pub schema_version: String,
    pub id: NodeId,
    #[serde(rename = "type")]
    pub node_type: String,
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub spec: Value,
    #[serde(default)]
    pub edges: BTreeMap<String, Vec<NodeId>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub annotations: BTreeMap<String, Value>,
    #[serde(flatten)]
    pub extensions: BTreeMap<String, Value>,
}

fn default_schema_version() -> String {
    "1.0".to_owned()
}

impl Node {
    pub fn new(node_type: impl Into<String>, title: impl Into<String>, spec: Value) -> Self {
        Self {
            schema_version: default_schema_version(),
            id: Uuid::now_v7().to_string(),
            node_type: node_type.into(),
            title: title.into(),
            status: "active".to_owned(),
            spec,
            edges: BTreeMap::new(),
            annotations: BTreeMap::new(),
            extensions: BTreeMap::new(),
        }
    }

    pub fn field(&self, path: &str) -> Option<&Value> {
        if path.is_empty() || path == "." {
            return None;
        }
        let root = self.as_value();
        let mut value = &root;
        for segment in path.trim_start_matches("$.").split('.') {
            value = match value {
                Value::Object(map) => map.get(segment)?,
                Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
                _ => return None,
            };
        }
        // The temporary root cannot be borrowed by the caller. Keep direct access for
        // common roots and let expression evaluation use `field_owned` for arbitrary paths.
        match path.trim_start_matches("$.") {
            "spec" => Some(&self.spec),
            _ => None,
        }
    }

    pub fn field_owned(&self, path: &str) -> Option<Value> {
        let mut value = self.as_value();
        for segment in path.trim_start_matches("$.").split('.') {
            value = match value {
                Value::Object(mut map) => map.remove(segment)?,
                Value::Array(mut items) => {
                    let index = segment.parse::<usize>().ok()?;
                    if index >= items.len() {
                        return None;
                    }
                    items.remove(index)
                }
                _ => return None,
            };
        }
        Some(value)
    }

    pub fn as_value(&self) -> Value {
        serde_json::to_value(self).expect("node serialization is infallible")
    }

    pub fn semantic_hash(&self, ignored_fields: &BTreeSet<String>) -> String {
        let mut value = self.as_value();
        if let Value::Object(map) = &mut value {
            for field in ignored_fields {
                map.remove(field);
            }
        }
        normalized_hash(&value)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Graph {
    nodes: BTreeMap<NodeId, Node>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeRef {
    pub source: NodeId,
    pub relation: String,
    pub target: NodeId,
}

impl Graph {
    pub fn load(root: &Path) -> Result<Self> {
        if !root.exists() {
            return Ok(Self::default());
        }
        let mut graph = Self::default();
        for entry in WalkDir::new(root).follow_links(false) {
            let entry = entry.map_err(|error| KoniError::Graph(error.to_string()))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if !matches!(extension, "yaml" | "yml" | "json") {
                continue;
            }
            let text = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
            let node: Node = if extension == "json" {
                serde_json::from_str(&text).map_err(|source| KoniError::Json {
                    path: path.to_path_buf(),
                    source,
                })?
            } else {
                serde_yaml::from_str(&text).map_err(|source| KoniError::Yaml {
                    path: path.to_path_buf(),
                    source,
                })?
            };
            graph.insert(node)?;
        }
        graph.validate_references()?;
        Ok(graph)
    }

    pub fn save_node(&self, root: &Path, node_id: &str) -> Result<PathBuf> {
        let node = self
            .nodes
            .get(node_id)
            .ok_or_else(|| KoniError::NotFound(format!("node {node_id}")))?;
        let directory = root.join(&node.node_type);
        fs::create_dir_all(&directory).map_err(|error| io_error(&directory, error))?;
        let path = directory.join(format!("{}--{}.yaml", slugify(&node.title), node.id));
        atomic_write_yaml(&path, node)?;
        Ok(path)
    }

    pub fn insert(&mut self, node: Node) -> Result<()> {
        if node.id.trim().is_empty() {
            return Err(KoniError::Graph("node id must not be empty".to_owned()));
        }
        if node.node_type.trim().is_empty() {
            return Err(KoniError::Graph(format!(
                "node {} has an empty type",
                node.id
            )));
        }
        if self.nodes.contains_key(&node.id) {
            return Err(KoniError::Graph(format!("duplicate node id {}", node.id)));
        }
        self.nodes.insert(node.id.clone(), node);
        Ok(())
    }

    pub fn upsert(&mut self, node: Node) {
        self.nodes.insert(node.id.clone(), node);
    }

    pub fn remove(&mut self, node_id: &str) -> Option<Node> {
        let removed = self.nodes.remove(node_id);
        if removed.is_some() {
            for node in self.nodes.values_mut() {
                for targets in node.edges.values_mut() {
                    targets.retain(|target| target != node_id);
                }
            }
        }
        removed
    }

    /// Remove only the addressed node, leaving incoming relationships for a
    /// caller-owned multi-node transaction to rewrite explicitly. The graph
    /// is intentionally allowed to be temporarily invalid; callers must run
    /// reference validation before publishing it.
    pub(crate) fn remove_transaction_node(&mut self, node_id: &str) -> Option<Node> {
        self.nodes.remove(node_id)
    }

    pub fn node(&self, node_id: &str) -> Option<&Node> {
        self.nodes.get(node_id)
    }

    pub fn node_mut(&mut self, node_id: &str) -> Option<&mut Node> {
        self.nodes.get_mut(node_id)
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    pub fn nodes_of_type<'a>(&'a self, node_type: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.nodes
            .values()
            .filter(move |node| node.node_type == node_type)
    }

    pub fn outgoing<'a>(&'a self, node_id: &str, relation: Option<&str>) -> Vec<&'a Node> {
        let Some(node) = self.node(node_id) else {
            return Vec::new();
        };
        node.edges
            .iter()
            .filter(|(name, _)| relation.is_none_or(|expected| expected == *name))
            .flat_map(|(_, targets)| targets)
            .filter_map(|target| self.node(target))
            .collect()
    }

    pub fn incoming<'a>(&'a self, node_id: &str, relation: Option<&str>) -> Vec<&'a Node> {
        self.nodes
            .values()
            .filter(|source| {
                source.edges.iter().any(|(name, targets)| {
                    relation.is_none_or(|expected| expected == name)
                        && targets.iter().any(|target| target == node_id)
                })
            })
            .collect()
    }

    pub fn traverse(
        &self,
        starts: &[NodeId],
        relation: Option<&str>,
        direction: Direction,
        max_depth: usize,
    ) -> Vec<&Node> {
        self.traverse_range(starts, relation, direction, 1, max_depth)
    }

    /// Deterministic, cycle-safe breadth-first traversal bounded by an exact
    /// inclusive depth window. Nodes reached before `min_depth` still expand;
    /// they simply do not appear in the result.
    pub fn traverse_range(
        &self,
        starts: &[NodeId],
        relation: Option<&str>,
        direction: Direction,
        min_depth: usize,
        max_depth: usize,
    ) -> Vec<&Node> {
        let mut seen: BTreeSet<NodeId> = starts.iter().cloned().collect();
        let mut queue: VecDeque<(NodeId, usize)> =
            starts.iter().cloned().map(|id| (id, 0)).collect();
        let mut output = Vec::new();
        while let Some((current, depth)) = queue.pop_front() {
            if depth >= max_depth {
                continue;
            }
            let neighbors = match direction {
                Direction::Outgoing => self.outgoing(&current, relation),
                Direction::Incoming => self.incoming(&current, relation),
            };
            for node in neighbors {
                if seen.insert(node.id.clone()) {
                    let reached_depth = depth + 1;
                    if reached_depth >= min_depth {
                        output.push(node);
                    }
                    queue.push_back((node.id.clone(), reached_depth));
                }
            }
        }
        output
    }

    pub fn edges(&self) -> Vec<EdgeRef> {
        self.nodes
            .values()
            .flat_map(|source| {
                source.edges.iter().flat_map(move |(relation, targets)| {
                    targets.iter().map(move |target| EdgeRef {
                        source: source.id.clone(),
                        relation: relation.clone(),
                        target: target.clone(),
                    })
                })
            })
            .collect()
    }

    pub fn validate_references(&self) -> Result<()> {
        let missing: Vec<_> = self
            .edges()
            .into_iter()
            .filter(|edge| !self.nodes.contains_key(&edge.target))
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        Err(KoniError::Graph(format!(
            "missing edge targets: {}",
            missing
                .iter()
                .map(|edge| format!("{}.{} -> {}", edge.source, edge.relation, edge.target))
                .collect::<Vec<_>>()
                .join(", ")
        )))
    }

    pub fn normalized_hash(&self) -> String {
        normalized_hash(&self.nodes)
    }

    pub fn semantic_hash(&self, ignored_fields: &BTreeSet<String>) -> String {
        let nodes: BTreeMap<_, _> = self
            .nodes
            .iter()
            .map(|(id, node)| (id, node.semantic_hash(ignored_fields)))
            .collect();
        normalized_hash(&nodes)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Outgoing,
    Incoming,
}

pub fn normalized_hash<T: Serialize>(value: &T) -> String {
    let value = serde_json::to_value(value).expect("serializable values normalize");
    let canonical = canonical_json(&value);
    let digest = Sha256::digest(canonical.as_bytes());
    format!("sha256:{}", hex::encode(digest))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => {
            serde_json::to_string(value).expect("string serialization succeeds")
        }
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("key serialization succeeds"),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub fn atomic_write_yaml<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }
    let temp_path = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("yaml")
    ));
    let text = serde_yaml::to_string(value).map_err(|source| KoniError::Yaml {
        path: path.to_path_buf(),
        source,
    })?;
    fs::write(&temp_path, text).map_err(|error| io_error(&temp_path, error))?;
    fs::rename(&temp_path, path).map_err(|error| io_error(path, error))?;
    Ok(())
}

pub fn slugify(input: &str) -> String {
    let mut output = String::new();
    let mut dash = false;
    for character in input.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            output.push(character);
            dash = false;
        } else if !dash && !output.is_empty() {
            output.push('-');
            dash = true;
        }
        if output.len() >= 64 {
            break;
        }
    }
    output.trim_matches('-').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_is_cycle_safe() {
        let mut graph = Graph::default();
        let mut first = Node::new("system", "First", serde_json::json!({}));
        let mut second = Node::new("system", "Second", serde_json::json!({}));
        first.id = "first".to_owned();
        second.id = "second".to_owned();
        first
            .edges
            .insert("contains".to_owned(), vec![second.id.clone()]);
        second
            .edges
            .insert("contains".to_owned(), vec![first.id.clone()]);
        graph.insert(first).unwrap();
        graph.insert(second).unwrap();

        let reached = graph.traverse(
            &["first".to_owned()],
            Some("contains"),
            Direction::Outgoing,
            10,
        );
        assert_eq!(
            reached
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec!["second"]
        );
    }

    #[test]
    fn traversal_honors_min_depth_without_reintroducing_cycle_origins() {
        let mut graph = Graph::default();
        let mut first = Node::new("system", "First", serde_json::json!({}));
        let mut second = Node::new("system", "Second", serde_json::json!({}));
        let mut third = Node::new("system", "Third", serde_json::json!({}));
        first.id = "first".to_owned();
        second.id = "second".to_owned();
        third.id = "third".to_owned();
        first
            .edges
            .insert("next".to_owned(), vec![second.id.clone()]);
        second
            .edges
            .insert("next".to_owned(), vec![third.id.clone()]);
        third
            .edges
            .insert("next".to_owned(), vec![first.id.clone()]);
        graph.insert(first).unwrap();
        graph.insert(second).unwrap();
        graph.insert(third).unwrap();

        let reached = graph.traverse_range(
            &["first".to_owned()],
            Some("next"),
            Direction::Outgoing,
            2,
            8,
        );
        assert_eq!(
            reached
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec!["third"]
        );
    }

    #[test]
    fn normalized_hash_ignores_mapping_order() {
        let first = serde_json::json!({"b": 2, "a": 1});
        let second = serde_json::json!({"a": 1, "b": 2});
        assert_eq!(normalized_hash(&first), normalized_hash(&second));
    }

    #[test]
    fn removing_node_removes_backlinks() {
        let mut graph = Graph::default();
        let mut source = Node::new("system", "Source", serde_json::json!({}));
        let target = Node::new("system", "Target", serde_json::json!({}));
        source
            .edges
            .insert("depends_on".to_owned(), vec![target.id.clone()]);
        let target_id = target.id.clone();
        let source_id = source.id.clone();
        graph.insert(source).unwrap();
        graph.insert(target).unwrap();
        graph.remove(&target_id);
        assert!(graph.node(&source_id).unwrap().edges["depends_on"].is_empty());
    }
}
