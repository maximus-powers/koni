//! Differential-capture normalization and structural comparison.
//!
//! Oracle and Rust captures intentionally contain different UUIDs, paths,
//! timestamps, process IDs, Git object IDs, and derived hashes.  This module
//! applies a declarative policy to both captures before comparing them; it does
//! not contain research- or Updog-specific branches.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::error::{KoniError, Result, io_error};
use crate::graph::normalized_hash;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizationPolicy {
    pub schema_version: String,
    pub protocol: String,
    #[serde(default)]
    pub identity_maps: Vec<IdentityMapPolicy>,
    #[serde(default)]
    pub scalar_replacements: Vec<ScalarReplacementPolicy>,
    #[serde(default)]
    pub drop_fields: Vec<String>,
    #[serde(default)]
    pub ordering: OrderingPolicy,
    #[serde(default)]
    pub hashes: HashPolicy,
    #[serde(default)]
    pub stdout: StdoutPolicy,
}

impl NormalizationPolicy {
    pub fn load(path: &Path) -> Result<Self> {
        load_yaml_or_json(path)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdentityMapPolicy {
    pub name: String,
    #[serde(rename = "match")]
    pub pattern: String,
    pub replacement: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScalarReplacementPolicy {
    pub name: String,
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub fields_matching: Option<String>,
    pub replacement: Value,
    #[serde(default)]
    pub preserve_relative_suffix: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OrderingPolicy {
    #[serde(default)]
    pub mappings: String,
    #[serde(default)]
    pub preserve_sequence_for: Vec<String>,
    #[serde(default)]
    pub sort_as_sets: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HashPolicy {
    #[serde(default)]
    pub policy: String,
    #[serde(default)]
    pub algorithm: String,
    #[serde(default)]
    pub fields_matching: Option<String>,
    #[serde(default)]
    pub compare_original_only_when: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StdoutPolicy {
    #[serde(default)]
    pub compare: String,
    #[serde(default)]
    pub ignore_prefixes: Vec<String>,
    #[serde(default)]
    pub preserve_prefixes: Vec<String>,
}

#[derive(Debug, Clone)]
struct CompiledIdentity {
    policy: IdentityMapPolicy,
    pattern: Regex,
}

#[derive(Debug, Clone)]
struct CompiledScalar {
    policy: ScalarReplacementPolicy,
    field_pattern: Option<Regex>,
}

/// A compiled policy. Each call to [`normalize`](Self::normalize) creates a
/// fresh identity session so two independent captures both number identities
/// from one.
#[derive(Debug, Clone)]
pub struct ParityNormalizer {
    policy: NormalizationPolicy,
    identities: Vec<CompiledIdentity>,
    scalars: Vec<CompiledScalar>,
    hash_pattern: Option<Regex>,
    identity_token: Regex,
    dropped: BTreeSet<String>,
    preserve_sequences: BTreeSet<String>,
    set_arrays: BTreeSet<String>,
}

impl ParityNormalizer {
    pub fn new(policy: NormalizationPolicy) -> Result<Self> {
        if policy.schema_version != "1.0" {
            return Err(KoniError::Profile(format!(
                "unsupported parity normalization schema {}",
                policy.schema_version
            )));
        }
        if policy.protocol.trim().is_empty() {
            return Err(KoniError::Profile(
                "parity normalization protocol must not be empty".to_owned(),
            ));
        }
        if !policy.ordering.mappings.is_empty() && policy.ordering.mappings != "sort_keys" {
            return Err(KoniError::Profile(format!(
                "unsupported parity mapping ordering {}",
                policy.ordering.mappings
            )));
        }
        if !policy.hashes.policy.is_empty()
            && policy.hashes.policy != "recompute_after_normalization"
        {
            return Err(KoniError::Profile(format!(
                "unsupported parity hash policy {}",
                policy.hashes.policy
            )));
        }
        let mut identity_names = BTreeSet::new();
        let identities = policy
            .identity_maps
            .iter()
            .map(|entry| {
                if !identity_names.insert(entry.name.clone()) {
                    return Err(KoniError::Profile(format!(
                        "duplicate parity identity map {}",
                        entry.name
                    )));
                }
                if !entry.replacement.contains("{ordinal}") {
                    return Err(KoniError::Profile(format!(
                        "identity map {} replacement must contain {{ordinal}}",
                        entry.name
                    )));
                }
                let pattern =
                    compile_regex(&entry.pattern, &format!("identity map {}", entry.name))?;
                Ok(CompiledIdentity {
                    policy: entry.clone(),
                    pattern,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let scalars = policy
            .scalar_replacements
            .iter()
            .map(|entry| {
                if entry.fields.is_empty() && entry.fields_matching.is_none() {
                    return Err(KoniError::Profile(format!(
                        "scalar replacement {} has no fields or fields_matching",
                        entry.name
                    )));
                }
                let field_pattern = entry
                    .fields_matching
                    .as_deref()
                    .map(|pattern| {
                        compile_regex(pattern, &format!("scalar replacement {}", entry.name))
                    })
                    .transpose()?;
                Ok(CompiledScalar {
                    policy: entry.clone(),
                    field_pattern,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let hash_pattern = policy
            .hashes
            .fields_matching
            .as_deref()
            .map(|pattern| compile_regex(pattern, "hash fields"))
            .transpose()?;
        if !policy.hashes.algorithm.is_empty() && policy.hashes.algorithm != "sha256-canonical-json"
        {
            return Err(KoniError::Profile(format!(
                "unsupported parity hash algorithm {}",
                policy.hashes.algorithm
            )));
        }
        let overlap: Vec<_> = policy
            .ordering
            .preserve_sequence_for
            .iter()
            .filter(|field| policy.ordering.sort_as_sets.contains(field))
            .cloned()
            .collect();
        if !overlap.is_empty() {
            return Err(KoniError::Profile(format!(
                "parity array fields cannot be both ordered and set-like: {}",
                overlap.join(", ")
            )));
        }
        Ok(Self {
            identities,
            scalars,
            hash_pattern,
            identity_token: compile_regex(r"[A-Za-z0-9][A-Za-z0-9_-]*", "identity token scanner")?,
            dropped: policy.drop_fields.iter().cloned().collect(),
            preserve_sequences: policy
                .ordering
                .preserve_sequence_for
                .iter()
                .cloned()
                .collect(),
            set_arrays: policy.ordering.sort_as_sets.iter().cloned().collect(),
            policy,
        })
    }

    pub fn from_policy_path(path: &Path) -> Result<Self> {
        Self::new(NormalizationPolicy::load(path)?)
    }

    pub fn policy(&self) -> &NormalizationPolicy {
        &self.policy
    }

    pub fn normalize(&self, capture: &Value) -> Value {
        let roots = infer_project_roots(capture, &self.scalars);
        self.normalize_with_project_roots(capture, &roots)
    }

    pub fn normalize_with_project_roots(&self, capture: &Value, roots: &[PathBuf]) -> Value {
        let roots = roots
            .iter()
            .map(|root| normalize_separators(&root.to_string_lossy()))
            .filter(|root| !root.is_empty())
            .collect();
        let mut session = NormalizationSession::new(self, roots);
        session.preseed_definition_identities(capture);
        session.normalize_value(capture, &[], None)
    }

    pub fn normalize_file(&self, path: &Path) -> Result<Value> {
        Ok(self.normalize(&load_capture(path)?))
    }

    /// Apply identity normalization and stdout line filtering from the policy.
    /// Line order remains observable.
    pub fn normalize_stdout(&self, stdout: &str) -> Vec<String> {
        let mut session = NormalizationSession::new(self, Vec::new());
        stdout
            .lines()
            .filter(|line| {
                !self
                    .policy
                    .stdout
                    .ignore_prefixes
                    .iter()
                    .any(|prefix| line.starts_with(prefix))
            })
            .map(|line| session.normalize_identity_string(line))
            .collect()
    }
}

struct NormalizationSession<'a> {
    normalizer: &'a ParityNormalizer,
    roots: Vec<String>,
    identity_values: Vec<HashMap<String, String>>,
    next_ordinals: Vec<usize>,
}

impl<'a> NormalizationSession<'a> {
    fn new(normalizer: &'a ParityNormalizer, mut roots: Vec<String>) -> Self {
        roots.sort_by_key(|root| std::cmp::Reverse(root.len()));
        roots.dedup();
        Self {
            normalizer,
            roots,
            identity_values: vec![HashMap::new(); normalizer.identities.len()],
            next_ordinals: vec![1; normalizer.identities.len()],
        }
    }

    /// Allocate ordinals from canonical identity-definition sites before
    /// walking arbitrary references. This prevents a lexically earlier field
    /// such as `active: [T-b, T-a]` from changing the stable mapping established
    /// by ticket records whose map key and `id` agree.
    fn preseed_definition_identities(&mut self, capture: &Value) {
        let mut definitions = Vec::new();
        self.collect_identity_definitions(capture, &mut definitions);
        definitions
            .sort_by(|left, right| (left.0, &left.2, &left.1).cmp(&(right.0, &right.2, &right.1)));
        definitions.dedup_by(|left, right| left.0 == right.0 && left.1 == right.1);
        for (identity_index, raw, _) in definitions {
            self.allocate_identity(identity_index, &raw);
        }
    }

    fn collect_identity_definitions(
        &self,
        value: &Value,
        output: &mut Vec<(usize, String, String)>,
    ) {
        match value {
            Value::Object(map) => {
                if let Some(raw_id) = map.get("id").and_then(Value::as_str)
                    && let Some(identity_index) = self.identity_index(raw_id)
                {
                    output.push((
                        identity_index,
                        raw_id.to_owned(),
                        self.semantic_sort_key(value),
                    ));
                }
                for (key, child) in map {
                    if child.get("id").and_then(Value::as_str) == Some(key)
                        && let Some(identity_index) = self.identity_index(key)
                    {
                        output.push((identity_index, key.clone(), self.semantic_sort_key(child)));
                    }
                    self.collect_identity_definitions(child, output);
                }
            }
            Value::Array(values) => {
                for value in values {
                    self.collect_identity_definitions(value, output);
                }
            }
            _ => {}
        }
    }

    fn semantic_sort_key(&self, value: &Value) -> String {
        canonical_json(&self.scrub_for_sort(value, None))
    }

    fn scrub_for_sort(&self, value: &Value, field: Option<&str>) -> Value {
        match value {
            Value::Object(map) => {
                let mut output = BTreeMap::new();
                for (key, value) in map {
                    if key == "id" || self.normalizer.dropped.contains(key) {
                        continue;
                    }
                    if self
                        .normalizer
                        .hash_pattern
                        .as_ref()
                        .is_some_and(|pattern| pattern.is_match(key))
                    {
                        output.insert(key.clone(), Value::String("<hash>".to_owned()));
                    } else {
                        output.insert(key.clone(), self.scrub_for_sort(value, Some(key)));
                    }
                }
                Value::Object(output.into_iter().collect())
            }
            Value::Array(values) => {
                let mut values: Vec<_> = values
                    .iter()
                    .map(|value| self.scrub_for_sort(value, field))
                    .collect();
                if field.is_some_and(|field| self.normalizer.set_arrays.contains(field)) {
                    values.sort_by_key(canonical_json);
                }
                Value::Array(values)
            }
            scalar => {
                if let Some(field) = field
                    && let Some(replacement) = self.normalizer.scalars.iter().find_map(|entry| {
                        let matches = entry
                            .policy
                            .fields
                            .iter()
                            .any(|candidate| candidate == field)
                            || entry
                                .field_pattern
                                .as_ref()
                                .is_some_and(|pattern| pattern.is_match(field));
                        (matches && is_scalar(scalar)).then(|| entry.policy.replacement.clone())
                    })
                {
                    return replacement;
                }
                match scalar {
                    Value::String(value) => Value::String(self.scrub_identity_string(value)),
                    value => value.clone(),
                }
            }
        }
    }

    fn scrub_identity_string(&self, value: &str) -> String {
        if let Some(index) = self.identity_index(value) {
            return format!(
                "<identity:{}>",
                self.normalizer.identities[index].policy.name
            );
        }
        let mut output = String::with_capacity(value.len());
        let mut cursor = 0;
        for matched in self.normalizer.identity_token.find_iter(value) {
            let Some(index) = self.identity_index(matched.as_str()) else {
                continue;
            };
            output.push_str(&value[cursor..matched.start()]);
            output.push_str(&format!(
                "<identity:{}>",
                self.normalizer.identities[index].policy.name
            ));
            cursor = matched.end();
        }
        if cursor == 0 {
            value.to_owned()
        } else {
            output.push_str(&value[cursor..]);
            output
        }
    }

    fn normalize_value(&mut self, value: &Value, path: &[String], field: Option<&str>) -> Value {
        match value {
            Value::Object(map) => self.normalize_mapping(map, path),
            Value::Array(items) => {
                let mut items: Vec<_> = items
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        let mut child_path = path.to_vec();
                        child_path.push(index.to_string());
                        self.normalize_value(value, &child_path, field)
                    })
                    .collect();
                if field.is_some_and(|field| self.field_is_set_like(field, path)) {
                    items.sort_by_key(canonical_json);
                }
                Value::Array(items)
            }
            scalar => {
                let replaced = field
                    .and_then(|field| self.scalar_replacement(field, path, scalar))
                    .unwrap_or_else(|| scalar.clone());
                match replaced {
                    Value::String(value) => Value::String(self.normalize_identity_string(&value)),
                    other => other,
                }
            }
        }
    }

    fn normalize_mapping(&mut self, map: &Map<String, Value>, path: &[String]) -> Value {
        let mut keys: Vec<_> = map.keys().collect();
        keys.sort();
        let mut normalized = BTreeMap::new();
        for key in keys {
            let mut child_path = path.to_vec();
            child_path.push(key.clone());
            if self.field_is_dropped(key, &child_path) {
                continue;
            }
            let normalized_key = self.normalize_identity_string(key);
            let value = self.normalize_value(&map[key], &child_path, Some(key));
            normalized.insert(normalized_key, value);
        }
        self.recompute_hashes(&mut normalized);
        Value::Object(normalized.into_iter().collect())
    }

    fn field_is_dropped(&self, field: &str, path: &[String]) -> bool {
        self.normalizer.dropped.contains(field) || self.normalizer.dropped.contains(&path.join("."))
    }

    fn field_is_set_like(&self, field: &str, path: &[String]) -> bool {
        if self.normalizer.preserve_sequences.contains(field)
            || self.normalizer.preserve_sequences.contains(&path.join("."))
        {
            return false;
        }
        self.normalizer.set_arrays.contains(field)
            || self.normalizer.set_arrays.contains(&path.join("."))
    }

    fn scalar_replacement(&self, field: &str, path: &[String], value: &Value) -> Option<Value> {
        let path = path.join(".");
        self.normalizer.scalars.iter().find_map(|entry| {
            let matches = entry
                .policy
                .fields
                .iter()
                .any(|candidate| candidate == field || candidate == &path)
                || entry
                    .field_pattern
                    .as_ref()
                    .is_some_and(|pattern| pattern.is_match(field));
            if !matches || !is_scalar(value) {
                return None;
            }
            if entry.policy.preserve_relative_suffix {
                return Some(self.replace_path(value, &entry.policy.replacement));
            }
            Some(entry.policy.replacement.clone())
        })
    }

    fn replace_path(&self, value: &Value, replacement: &Value) -> Value {
        let (Some(value), Some(replacement)) = (value.as_str(), replacement.as_str()) else {
            return replacement.clone();
        };
        let value = normalize_separators(value);
        for root in &self.roots {
            if value == *root {
                return Value::String(replacement.to_owned());
            }
            if let Some(suffix) = value.strip_prefix(root)
                && suffix.starts_with('/')
            {
                return Value::String(format!("{replacement}{suffix}"));
            }
        }
        if !looks_absolute(&value) {
            let suffix = value.trim_start_matches("./");
            return Value::String(if suffix.is_empty() {
                replacement.to_owned()
            } else {
                format!("{replacement}/{suffix}")
            });
        }
        Value::String(replacement.to_owned())
    }

    fn normalize_identity_string(&mut self, value: &str) -> String {
        if let Some(replacement) = self.identity_replacement(value) {
            return replacement;
        }
        let matches: Vec<_> = self
            .normalizer
            .identity_token
            .find_iter(value)
            .map(|matched| (matched.start(), matched.end(), matched.as_str().to_owned()))
            .collect();
        let mut output = String::with_capacity(value.len());
        let mut cursor = 0;
        for (start, end, token) in matches {
            let Some(replacement) = self.identity_replacement(&token) else {
                continue;
            };
            output.push_str(&value[cursor..start]);
            output.push_str(&replacement);
            cursor = end;
        }
        if cursor == 0 {
            value.to_owned()
        } else {
            output.push_str(&value[cursor..]);
            output
        }
    }

    fn identity_replacement(&mut self, value: &str) -> Option<String> {
        let index = self.identity_index(value)?;
        if let Some(replacement) = self.identity_values[index].get(value) {
            return Some(replacement.clone());
        }
        Some(self.allocate_identity(index, value))
    }

    fn identity_index(&self, value: &str) -> Option<usize> {
        self.normalizer
            .identities
            .iter()
            .position(|entry| entry.pattern.is_match(value))
    }

    fn allocate_identity(&mut self, index: usize, value: &str) -> String {
        if let Some(replacement) = self.identity_values[index].get(value) {
            return replacement.clone();
        }
        let ordinal = self.next_ordinals[index];
        self.next_ordinals[index] += 1;
        let replacement = self.normalizer.identities[index]
            .policy
            .replacement
            .replace("{ordinal}", &ordinal.to_string());
        self.identity_values[index].insert(value.to_owned(), replacement.clone());
        replacement
    }

    fn recompute_hashes(&self, map: &mut BTreeMap<String, Value>) {
        if self.normalizer.policy.hashes.policy != "recompute_after_normalization" {
            return;
        }
        let Some(pattern) = &self.normalizer.hash_pattern else {
            return;
        };
        if self
            .normalizer
            .policy
            .hashes
            .compare_original_only_when
            .iter()
            .any(|condition| map.get(condition).is_some_and(truthy))
        {
            return;
        }
        let hash_fields: Vec<_> = map
            .keys()
            .filter(|key| pattern.is_match(key))
            .cloned()
            .collect();
        if hash_fields.is_empty() {
            return;
        }
        let owner: BTreeMap<_, _> = map
            .iter()
            .filter(|(key, _)| !pattern.is_match(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        for field in hash_fields {
            let shape = map.get(&field).cloned().unwrap_or(Value::Null);
            map.insert(field.clone(), rehash_shape(&shape, &field, &owner, &[]));
        }
    }
}

fn rehash_shape(
    shape: &Value,
    field: &str,
    owner: &BTreeMap<String, Value>,
    slot: &[String],
) -> Value {
    match shape {
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    let mut child = slot.to_vec();
                    child.push(key.clone());
                    (key.clone(), rehash_shape(value, field, owner, &child))
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let mut child = slot.to_vec();
                    child.push(index.to_string());
                    rehash_shape(value, field, owner, &child)
                })
                .collect(),
        ),
        _ => Value::String(normalized_hash(&json!({
            "field": field,
            "slot": slot,
            "owner": owner,
        }))),
    }
}

fn infer_project_roots(capture: &Value, scalars: &[CompiledScalar]) -> Vec<PathBuf> {
    let mut preferred = Vec::new();
    let mut fallback = Vec::new();
    collect_project_roots(capture, scalars, &mut preferred, &mut fallback);
    if preferred.is_empty() {
        preferred = fallback;
    }
    preferred.sort();
    preferred.dedup();
    preferred.into_iter().map(PathBuf::from).collect()
}

fn collect_project_roots(
    value: &Value,
    scalars: &[CompiledScalar],
    preferred: &mut Vec<String>,
    fallback: &mut Vec<String>,
) {
    match value {
        Value::Object(map) => {
            for (field, value) in map {
                let configured_path = scalars.iter().any(|entry| {
                    entry.policy.preserve_relative_suffix
                        && entry
                            .policy
                            .fields
                            .iter()
                            .any(|candidate| candidate == field)
                });
                if configured_path
                    && let Some(path) = value.as_str()
                    && looks_absolute(path)
                {
                    if matches!(field.as_str(), "root" | "project_root") {
                        preferred.push(normalize_separators(path));
                    } else if field == "cwd" {
                        fallback.push(normalize_separators(path));
                    }
                }
                collect_project_roots(value, scalars, preferred, fallback);
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_project_roots(value, scalars, preferred, fallback);
            }
        }
        _ => {}
    }
}

pub fn load_capture(path: &Path) -> Result<Value> {
    load_yaml_or_json(path)
}

fn load_yaml_or_json<T>(path: &Path) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let text = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
        serde_json::from_str(&text).map_err(|source| KoniError::Json {
            path: path.to_path_buf(),
            source,
        })
    } else {
        serde_yaml::from_str(&text).map_err(|source| KoniError::Yaml {
            path: path.to_path_buf(),
            source,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StructuralDiffKind {
    MissingLeft,
    MissingRight,
    TypeMismatch,
    ValueMismatch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StructuralDiff {
    pub path: String,
    pub kind: StructuralDiffKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParityComparison {
    pub equal: bool,
    pub normalized_left: Value,
    pub normalized_right: Value,
    pub diffs: Vec<StructuralDiff>,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct ParityComparator {
    normalizer: ParityNormalizer,
    max_diffs: usize,
}

impl ParityComparator {
    pub fn new(normalizer: ParityNormalizer) -> Self {
        Self {
            normalizer,
            max_diffs: 1_000,
        }
    }

    pub fn from_policy(policy: NormalizationPolicy) -> Result<Self> {
        Ok(Self::new(ParityNormalizer::new(policy)?))
    }

    pub fn from_policy_path(path: &Path) -> Result<Self> {
        Ok(Self::new(ParityNormalizer::from_policy_path(path)?))
    }

    pub fn with_max_diffs(mut self, max_diffs: usize) -> Self {
        self.max_diffs = max_diffs.max(1);
        self
    }

    pub fn normalizer(&self) -> &ParityNormalizer {
        &self.normalizer
    }

    pub fn compare(&self, left: &Value, right: &Value) -> ParityComparison {
        let normalized_left = self.normalizer.normalize(left);
        let normalized_right = self.normalizer.normalize(right);
        let mut diffs = Vec::new();
        let mut truncated = false;
        structural_diff(
            &normalized_left,
            &normalized_right,
            "$",
            &mut diffs,
            self.max_diffs,
            &mut truncated,
        );
        ParityComparison {
            equal: diffs.is_empty(),
            normalized_left,
            normalized_right,
            diffs,
            truncated,
        }
    }

    pub fn compare_files(&self, left: &Path, right: &Path) -> Result<ParityComparison> {
        Ok(self.compare(&load_capture(left)?, &load_capture(right)?))
    }
}

pub fn structural_diffs(left: &Value, right: &Value) -> Vec<StructuralDiff> {
    let mut diffs = Vec::new();
    let mut truncated = false;
    structural_diff(left, right, "$", &mut diffs, usize::MAX, &mut truncated);
    diffs
}

fn structural_diff(
    left: &Value,
    right: &Value,
    path: &str,
    diffs: &mut Vec<StructuralDiff>,
    max_diffs: usize,
    truncated: &mut bool,
) {
    if left == right {
        return;
    }
    if diffs.len() >= max_diffs {
        *truncated = true;
        return;
    }
    match (left, right) {
        (Value::Object(left), Value::Object(right)) => {
            let keys: BTreeSet<_> = left.keys().chain(right.keys()).collect();
            for key in keys {
                let child = object_path(path, key);
                match (left.get(key), right.get(key)) {
                    (Some(left), Some(right)) => {
                        structural_diff(left, right, &child, diffs, max_diffs, truncated)
                    }
                    (Some(left), None) => push_diff(
                        diffs,
                        max_diffs,
                        truncated,
                        StructuralDiff {
                            path: child,
                            kind: StructuralDiffKind::MissingRight,
                            left: Some(left.clone()),
                            right: None,
                        },
                    ),
                    (None, Some(right)) => push_diff(
                        diffs,
                        max_diffs,
                        truncated,
                        StructuralDiff {
                            path: child,
                            kind: StructuralDiffKind::MissingLeft,
                            left: None,
                            right: Some(right.clone()),
                        },
                    ),
                    (None, None) => unreachable!(),
                }
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            let length = left.len().max(right.len());
            for index in 0..length {
                let child = format!("{path}[{index}]");
                match (left.get(index), right.get(index)) {
                    (Some(left), Some(right)) => {
                        structural_diff(left, right, &child, diffs, max_diffs, truncated)
                    }
                    (Some(left), None) => push_diff(
                        diffs,
                        max_diffs,
                        truncated,
                        StructuralDiff {
                            path: child,
                            kind: StructuralDiffKind::MissingRight,
                            left: Some(left.clone()),
                            right: None,
                        },
                    ),
                    (None, Some(right)) => push_diff(
                        diffs,
                        max_diffs,
                        truncated,
                        StructuralDiff {
                            path: child,
                            kind: StructuralDiffKind::MissingLeft,
                            left: None,
                            right: Some(right.clone()),
                        },
                    ),
                    (None, None) => unreachable!(),
                }
            }
        }
        _ => push_diff(
            diffs,
            max_diffs,
            truncated,
            StructuralDiff {
                path: path.to_owned(),
                kind: if json_type(left) == json_type(right) {
                    StructuralDiffKind::ValueMismatch
                } else {
                    StructuralDiffKind::TypeMismatch
                },
                left: Some(left.clone()),
                right: Some(right.clone()),
            },
        ),
    }
}

fn push_diff(
    diffs: &mut Vec<StructuralDiff>,
    max_diffs: usize,
    truncated: &mut bool,
    diff: StructuralDiff,
) {
    if diffs.len() >= max_diffs {
        *truncated = true;
    } else {
        diffs.push(diff);
    }
}

fn object_path(parent: &str, key: &str) -> String {
    if key
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
    {
        format!("{parent}.{key}")
    } else {
        format!(
            "{parent}[{}]",
            serde_json::to_string(key).expect("key serializes")
        )
    }
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn compile_regex(pattern: &str, owner: &str) -> Result<Regex> {
    Regex::new(pattern)
        .map_err(|error| KoniError::Profile(format!("invalid {owner} regex {pattern:?}: {error}")))
}

fn is_scalar(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

fn looks_absolute(value: &str) -> bool {
    value.starts_with('/') || value.starts_with("//") || value.as_bytes().get(1) == Some(&b':')
}

fn normalize_separators(value: &str) -> String {
    value.replace('\\', "/").trim_end_matches('/').to_owned()
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("string serializes"),
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
                        serde_json::to_string(key).expect("key serializes"),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn policy() -> NormalizationPolicy {
        serde_yaml::from_str(include_str!("../../../reference/parity/normalization.yaml")).unwrap()
    }

    #[test]
    fn actual_policy_loads_and_normalizes_dynamic_capture_state() {
        let comparator = ParityComparator::from_policy(policy()).unwrap();
        let left = json!({
            "root": "/private/tmp/oracle/project",
            "id": "019f4d92-9908-76e8-844d-aca65b829fd4",
            "ticket_id": "T-a1",
            "worktree": "/private/tmp/oracle/project/.worktrees/T-a1",
            "created_at": "2026-07-10T10:00:00Z",
            "pid": 9182,
            "annotations": {"color": "blue"},
            "target_nodes": ["019f4d92-9908-76e8-844d-aca65b829fd4", "019f4d92-9908-76e8-844d-aca65b829fd5"],
            "events": ["started", "finished"],
            "graph_hash": "sha256:oracle",
            "input_hashes": {"graph": "sha256:oracle-graph", "ticket": "sha256:oracle-ticket"}
        });
        let right = json!({
            "pid": 77,
            "created_at": "2030-01-01T00:00:00Z",
            "ticket_id": "T-f9",
            "id": "019f4d92-9908-76e8-844d-aca65b829fe4",
            "root": "/var/folders/rust/project",
            "worktree": "/var/folders/rust/project/.worktrees/T-f9",
            "target_nodes": ["019f4d92-9908-76e8-844d-aca65b829fe5", "019f4d92-9908-76e8-844d-aca65b829fe4"],
            "events": ["started", "finished"],
            "graph_hash": "sha256:rust",
            "input_hashes": {"ticket": "sha256:rust-ticket", "graph": "sha256:rust-graph"},
            "annotations": {"color": "green"}
        });

        let comparison = comparator.compare(&left, &right);
        assert!(comparison.equal, "{:#?}", comparison.diffs);
        assert_eq!(comparison.normalized_left["root"], "<project-root>");
        assert_eq!(
            comparison.normalized_left["worktree"],
            "<project-root>/.worktrees/<ticket:1>"
        );
        assert_eq!(comparison.normalized_left["created_at"], "<timestamp>");
        assert_eq!(comparison.normalized_left["pid"], 1);
        assert!(comparison.normalized_left.get("annotations").is_none());
        assert!(
            comparison.normalized_left["graph_hash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
        assert!(comparison.normalized_left["input_hashes"].is_object());
    }

    #[test]
    fn identity_references_and_mapping_keys_use_stable_ordinals() {
        let normalizer = ParityNormalizer::new(policy()).unwrap();
        let capture = json!({
            "tickets": {
                "T-aa": {"id": "T-aa", "target_nodes": ["019f4d92-9908-76e8-844d-aca65b829fd4"]},
                "T-bb": {"id": "T-bb", "target_nodes": ["019f4d92-9908-76e8-844d-aca65b829fd4"]}
            },
            "active": ["T-bb", "T-aa"]
        });
        let normalized = normalizer.normalize(&capture);
        assert!(normalized["tickets"].get("<ticket:1>").is_some());
        assert!(normalized["tickets"].get("<ticket:2>").is_some());
        assert_eq!(normalized["active"], json!(["<ticket:2>", "<ticket:1>"]));
        assert_eq!(
            normalized["tickets"]["<ticket:1>"]["target_nodes"],
            json!(["<node:1>"])
        );
        assert_eq!(
            normalized["tickets"]["<ticket:2>"]["target_nodes"],
            json!(["<node:1>"])
        );
    }

    #[test]
    fn definition_ordinals_follow_semantics_instead_of_random_raw_id_order() {
        let comparator = ParityComparator::from_policy(policy()).unwrap();
        let left = json!({
            "tickets": {
                "T-aa": {"id": "T-aa", "title": "Zulu"},
                "T-bb": {"id": "T-bb", "title": "Alpha"}
            },
            "active": ["T-bb", "T-aa"]
        });
        let right = json!({
            "tickets": {
                "T-11": {"id": "T-11", "title": "Alpha"},
                "T-ff": {"id": "T-ff", "title": "Zulu"}
            },
            "active": ["T-11", "T-ff"]
        });
        let comparison = comparator.compare(&left, &right);
        assert!(comparison.equal, "{:#?}", comparison.diffs);
        assert_eq!(
            comparison.normalized_left["active"],
            json!(["<ticket:1>", "<ticket:2>"])
        );
    }

    #[test]
    fn set_like_arrays_sort_but_event_sequences_remain_observable() {
        let comparator = ParityComparator::from_policy(policy()).unwrap();
        let left = json!({
            "obligation_keys": ["b", "a"],
            "events": ["leased", "closed"]
        });
        let right = json!({
            "obligation_keys": ["a", "b"],
            "events": ["closed", "leased"]
        });
        let comparison = comparator.compare(&left, &right);
        assert!(!comparison.equal);
        assert_eq!(comparison.diffs.len(), 2);
        assert_eq!(comparison.diffs[0].path, "$.events[0]");
        assert_eq!(
            comparison.normalized_left["obligation_keys"],
            json!(["a", "b"])
        );
    }

    #[test]
    fn structural_diff_reports_missing_type_and_value_changes() {
        let left = json!({"ticket": {"status": "todo", "priority": 1}, "events": []});
        let right = json!({"ticket": {"status": "closed", "priority": "high", "extra": true}});
        let diffs = structural_diffs(&left, &right);
        assert_eq!(diffs.len(), 4);
        assert!(diffs.iter().any(|diff| {
            diff.path == "$.ticket.status" && diff.kind == StructuralDiffKind::ValueMismatch
        }));
        assert!(diffs.iter().any(|diff| {
            diff.path == "$.ticket.priority" && diff.kind == StructuralDiffKind::TypeMismatch
        }));
        assert!(diffs.iter().any(|diff| {
            diff.path == "$.ticket.extra" && diff.kind == StructuralDiffKind::MissingLeft
        }));
        assert!(diffs.iter().any(|diff| {
            diff.path == "$.events" && diff.kind == StructuralDiffKind::MissingRight
        }));
    }

    #[test]
    fn comparator_loads_yaml_and_json_captures() {
        let temp = TempDir::new().unwrap();
        let left = temp.path().join("oracle.yaml");
        let right = temp.path().join("rust.json");
        fs::write(&left, "ticket_id: T-aa\ncreated_at: oracle-time\n").unwrap();
        fs::write(&right, r#"{"ticket_id":"T-bb","created_at":"rust-time"}"#).unwrap();
        let comparator = ParityComparator::from_policy(policy()).unwrap();
        assert!(comparator.compare_files(&left, &right).unwrap().equal);
    }

    #[test]
    fn stdout_ignores_configured_dynamic_lines_and_normalizes_ids() {
        let normalizer = ParityNormalizer::new(policy()).unwrap();
        let lines = normalizer.normalize_stdout(
            "Created autoresearch project at /tmp/a\nGraph valid T-aa\nClosed T-aa\n",
        );
        assert_eq!(
            lines,
            vec![
                "Graph valid <ticket:1>".to_owned(),
                "Closed <ticket:1>".to_owned()
            ]
        );
    }
}
