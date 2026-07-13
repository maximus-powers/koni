use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use indexmap::IndexMap;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::codex::{NativeCodexCatalog, project_root_for_profile};
use crate::error::{KoniError, Result, io_error};
use crate::expr::{ExpressionSymbols, LeafPredicate, Predicate, PredicateOp, Selector, ValueType};
use crate::graph::normalized_hash;

pub const PROFILE_SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileManifest {
    #[serde(default = "default_profile_schema")]
    pub schema_version: String,
    #[serde(default = "default_engine_requirement", alias = "engine_version")]
    pub engine: String,
    pub profile: ProfileMetadata,
    #[serde(default)]
    pub initialization: InitializationConfig,
    #[serde(default)]
    pub storage: StorageConfig,
    #[serde(default)]
    pub git: GitConfig,
    #[serde(default)]
    pub orchestration: OrchestrationConfig,
    #[serde(default, skip_serializing_if = "ChangeControlConfig::is_default")]
    pub change_control: ChangeControlConfig,
    #[serde(default, skip_serializing_if = "ReportingConfig::is_default")]
    pub reporting: ReportingConfig,
    #[serde(default)]
    pub imports: ImportsConfig,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, toml::Value>,
}

fn default_profile_schema() -> String {
    PROFILE_SCHEMA_VERSION.to_owned()
}

fn default_engine_requirement() -> String {
    ">=0.1,<0.2".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportingConfig {
    #[serde(default = "default_report_bundle_kind")]
    pub bundle_kind: String,
}

impl ReportingConfig {
    fn is_default(&self) -> bool {
        self.bundle_kind == default_report_bundle_kind()
    }
}

impl Default for ReportingConfig {
    fn default() -> Self {
        Self {
            bundle_kind: default_report_bundle_kind(),
        }
    }
}

fn default_report_bundle_kind() -> String {
    "report-bundle".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChangeControlConfig {
    #[serde(default = "default_awaiting_approval_state")]
    pub awaiting_approval_state: String,
    #[serde(default = "default_held_source_state")]
    pub held_source_state: String,
}

impl ChangeControlConfig {
    fn is_default(&self) -> bool {
        self.awaiting_approval_state == default_awaiting_approval_state()
            && self.held_source_state == default_held_source_state()
    }
}

impl Default for ChangeControlConfig {
    fn default() -> Self {
        Self {
            awaiting_approval_state: default_awaiting_approval_state(),
            held_source_state: default_held_source_state(),
        }
    }
}

fn default_awaiting_approval_state() -> String {
    "proposed".to_owned()
}

fn default_held_source_state() -> String {
    "blocked".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileMetadata {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InitializationConfig {
    #[serde(default)]
    pub root_node_type: Option<String>,
    #[serde(default)]
    pub goal_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_context_field: Option<String>,
    #[serde(default)]
    pub root_status: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageBackend {
    #[default]
    Tracked,
    GitCommonDir,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageConfig {
    #[serde(default)]
    pub backend: StorageBackend,
    #[serde(default = "default_graph_dir", alias = "graph")]
    pub graph_dir: PathBuf,
    #[serde(default = "default_tickets_dir", alias = "tickets")]
    pub tickets_dir: PathBuf,
    #[serde(default = "default_state_path", alias = "state")]
    pub state_path: PathBuf,
    #[serde(default = "default_work_dir", alias = "work")]
    pub work_dir: PathBuf,
    #[serde(default = "default_receipts_dir", alias = "receipts")]
    pub receipts_dir: PathBuf,
    #[serde(default = "default_reports_dir", alias = "reports")]
    pub reports_dir: PathBuf,
    #[serde(default = "default_annotations")]
    pub semantic_hash_excludes: Vec<String>,
    /// Project-relative transient/build trees omitted from filesystem scope
    /// inventories. Exact argv-bound inputs remain hashed independently.
    #[serde(default)]
    pub filesystem_scope_excludes: Vec<PathBuf>,
}

impl Default for StorageConfig {
    fn default() -> Self {
        Self {
            backend: StorageBackend::Tracked,
            graph_dir: default_graph_dir(),
            tickets_dir: default_tickets_dir(),
            state_path: default_state_path(),
            work_dir: default_work_dir(),
            receipts_dir: default_receipts_dir(),
            reports_dir: default_reports_dir(),
            semantic_hash_excludes: default_annotations(),
            filesystem_scope_excludes: Vec::new(),
        }
    }
}

fn default_graph_dir() -> PathBuf {
    "program/graph".into()
}
fn default_tickets_dir() -> PathBuf {
    "program/tickets".into()
}
fn default_state_path() -> PathBuf {
    "program/state.yaml".into()
}
fn default_work_dir() -> PathBuf {
    "program/work".into()
}
fn default_receipts_dir() -> PathBuf {
    "program/receipts".into()
}
fn default_reports_dir() -> PathBuf {
    "program/reports".into()
}
fn default_annotations() -> Vec<String> {
    vec!["annotations".to_owned()]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_git_backend")]
    pub backend: String,
    #[serde(default = "default_integration_branch")]
    pub integration_branch: String,
    #[serde(default = "default_ticket_branch")]
    pub ticket_branch_template: String,
    #[serde(default = "default_worktree_root")]
    pub worktree_root: PathBuf,
    #[serde(default = "default_integration_strategy")]
    pub integration_strategy: String,
    #[serde(default = "default_commit_template")]
    pub commit_template: String,
    #[serde(default)]
    pub commit_trailers: BTreeMap<String, String>,
}

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            backend: default_git_backend(),
            integration_branch: default_integration_branch(),
            ticket_branch_template: default_ticket_branch(),
            worktree_root: default_worktree_root(),
            integration_strategy: default_integration_strategy(),
            commit_template: default_commit_template(),
            commit_trailers: BTreeMap::new(),
        }
    }
}

fn default_true() -> bool {
    true
}
fn default_git_backend() -> String {
    "libgit2".to_owned()
}
fn default_integration_branch() -> String {
    "current".to_owned()
}
fn default_ticket_branch() -> String {
    "koni/ticket/{{ ticket.id }}".to_owned()
}
fn default_worktree_root() -> PathBuf {
    ".worktrees".into()
}
fn default_integration_strategy() -> String {
    "squash".to_owned()
}
fn default_commit_template() -> String {
    "{{ ticket.operation }}: {{ ticket.title }}".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrationConfig {
    #[serde(default = "default_true")]
    pub running: bool,
    #[serde(default = "default_parallelism")]
    pub max_parallel: usize,
    #[serde(default = "default_lease_seconds")]
    pub lease_stale_seconds: u64,
    #[serde(default = "default_fixpoint_passes")]
    pub max_fixpoint_passes: usize,
    /// Hard upper bound on durable broker boundaries a single Lead Codex
    /// process may cross. The default deliberately makes every boundary a
    /// fresh, non-resumed Codex turn.
    #[serde(
        default = "default_lead_boundaries",
        skip_serializing_if = "is_default_lead_boundaries"
    )]
    pub max_boundaries_per_lead: usize,
    #[serde(default)]
    pub disjoint_scope_parallelism: bool,
}

impl Default for OrchestrationConfig {
    fn default() -> Self {
        Self {
            running: true,
            max_parallel: default_parallelism(),
            lease_stale_seconds: default_lease_seconds(),
            max_fixpoint_passes: default_fixpoint_passes(),
            max_boundaries_per_lead: default_lead_boundaries(),
            disjoint_scope_parallelism: true,
        }
    }
}

fn default_parallelism() -> usize {
    3
}
fn default_lease_seconds() -> u64 {
    30 * 60
}
fn default_fixpoint_passes() -> usize {
    8
}
fn default_lead_boundaries() -> usize {
    1
}
fn is_default_lead_boundaries(value: &usize) -> bool {
    *value == default_lead_boundaries()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportsConfig {
    #[serde(default)]
    pub graph: Vec<PathBuf>,
    #[serde(default)]
    pub rules: Vec<PathBuf>,
    #[serde(default)]
    pub operations: Vec<PathBuf>,
    #[serde(default)]
    pub workflows: Vec<PathBuf>,
    #[serde(default)]
    pub actions: Vec<PathBuf>,
    #[serde(default)]
    pub checks: Vec<PathBuf>,
    #[serde(default)]
    pub personas: Vec<PathBuf>,
    #[serde(default)]
    pub reports: Vec<PathBuf>,
    #[serde(default)]
    pub cockpit: Vec<PathBuf>,
    #[serde(default, alias = "lifecycle")]
    pub lifecycles: Vec<PathBuf>,
}

impl ImportsConfig {
    pub fn ordered_paths(&self) -> impl Iterator<Item = &PathBuf> {
        self.graph
            .iter()
            .chain(&self.rules)
            .chain(&self.operations)
            .chain(&self.workflows)
            .chain(&self.actions)
            .chain(&self.checks)
            .chain(&self.personas)
            .chain(&self.reports)
            .chain(&self.cockpit)
            .chain(&self.lifecycles)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModuleDocument {
    #[serde(default)]
    pub schema_version: Option<String>,
    #[serde(default)]
    pub module: Option<ModuleMetadata>,
    #[serde(default)]
    pub node_types: Vec<NodeTypeDef>,
    #[serde(default)]
    pub edge_types: Vec<EdgeTypeDef>,
    /// Domain-neutral capability, candidate-selection, and gate-target
    /// contracts. Policies are authored by profiles; the engine supplies only
    /// deterministic SemVer matching, ranking, and receipt binding.
    #[serde(default)]
    pub gate_policies: Vec<GatePolicyDef>,
    #[serde(default)]
    pub queries: Vec<QueryDef>,
    #[serde(default)]
    pub rules: Vec<RuleDef>,
    #[serde(default)]
    pub operations: Vec<OperationDef>,
    #[serde(default)]
    pub workflows: Vec<WorkflowDef>,
    #[serde(default)]
    pub actions: Vec<ActionDef>,
    #[serde(default)]
    pub checks: Vec<CheckDef>,
    #[serde(default)]
    pub personas: Vec<PersonaDef>,
    #[serde(default)]
    pub reports: Vec<ReportDef>,
    #[serde(default)]
    pub views: Vec<ViewDef>,
    #[serde(default, alias = "lifecycle")]
    pub state_machines: Vec<StateMachineDef>,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleMetadata {
    pub id: String,
    #[serde(default = "default_module_version")]
    pub version: String,
}

fn default_module_version() -> String {
    "1.0.0".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeTypeDef {
    pub id: String,
    /// Human-facing semantic contract for this node type.
    ///
    /// New profiles should always provide this field. It remains optional on
    /// input so profiles installed before descriptions became first-class can
    /// still compile; agent-facing contracts use [`Self::effective_description`]
    /// to give those legacy nodes an explicit, deterministic explanation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub required_any: Vec<Vec<String>>,
    #[serde(default)]
    pub statuses: Vec<String>,
    #[serde(default)]
    pub initial_status: Option<String>,
    #[serde(default)]
    pub semantic_fields: Vec<String>,
    #[serde(default)]
    pub compiler_owned_fields: Vec<String>,
    /// Whether this type participates in the profile's gate admission model.
    /// Phase-one records and validates this contract; admission is enforced by
    /// the gate-readiness phase rather than inferred from a type name.
    #[serde(default)]
    pub gate_required: bool,
    /// Optional compiler-owned projection of one project-contained filesystem
    /// tree. Profiles name every semantic input; the engine supplies only the
    /// generic inventory/currentness mechanism.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem_manifest: Option<FilesystemManifestDef>,
    #[serde(default)]
    pub fields: BTreeMap<String, FieldDef>,
    #[serde(default)]
    pub annotations: BTreeMap<String, Value>,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FilesystemManifestDef {
    /// Project-relative root path read from the configured node field.
    pub root_field: String,
    /// Object whose exact authored value is bound into the contract hash.
    pub implementation_contract_field: String,
    /// Nonempty implementation kind string.
    pub implementation_kind_field: String,
    /// Nonempty list of unique project-relative entrypoint paths.
    pub implementation_entrypoints_field: String,
    /// Additional authored fields whose exact values participate in the
    /// filesystem contract hash. This lets profiles bind plans, capabilities,
    /// gate contracts, and vendor expectations without teaching the compiler
    /// any of those domain concepts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contract_fields: Vec<String>,
    /// Compiler-owned node field receiving the complete derived manifest.
    pub output_field: String,
    /// Optional project-relative boundaries under which authored roots must
    /// remain. Empty means any project-contained root.
    #[serde(default)]
    pub allowed_root_prefixes: Vec<String>,
    #[serde(default)]
    pub scan: FilesystemScanPolicyDef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<FilesystemSourcePolicyDef>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FilesystemScanPolicyDef {
    #[serde(default)]
    pub ignored_file_names: Vec<String>,
    #[serde(default)]
    pub ignored_path_components: Vec<String>,
    #[serde(default)]
    pub ignored_suffixes: Vec<String>,
    #[serde(default)]
    pub ignored_path_prefixes: Vec<String>,
    #[serde(default)]
    pub symlinks: FilesystemSymlinkPolicy,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilesystemSymlinkPolicy {
    #[default]
    Reject,
    Contained,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FilesystemSourcePolicyDef {
    pub field: String,
    pub external_values: Vec<String>,
    #[serde(default = "default_unspecified_source")]
    pub unspecified_value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<FilesystemVendorPolicyDef>,
}

fn default_unspecified_source() -> String {
    "unspecified".to_owned()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FilesystemVendorPolicyDef {
    #[serde(default)]
    pub path_fields: Vec<String>,
    #[serde(default)]
    pub blocked_reason_fields: Vec<String>,
}

impl NodeTypeDef {
    /// Returns the description agents should use when interpreting this node.
    ///
    /// The generated sentence is deliberately deterministic: it keeps legacy
    /// profiles useful without silently inventing domain semantics, and it is
    /// replaced by the authored description in every current bundled profile.
    pub fn effective_description(&self) -> String {
        self.description
            .as_deref()
            .map(str::trim)
            .filter(|description| !description.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                if self.stage.trim().is_empty() {
                    format!("Legacy semantic graph node of type `{}`.", self.id)
                } else {
                    format!(
                        "Legacy semantic graph node of type `{}` in the `{}` stage.",
                        self.id, self.stage
                    )
                }
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldDef {
    #[serde(rename = "type", default)]
    pub value_type: FieldType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub items: Option<Box<FieldDef>>,
    /// Named child contracts for object fields. Child `required` flags are
    /// evaluated relative to this object rather than the enclosing node.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub properties: BTreeMap<String, FieldDef>,
    /// JSON-Schema-style object openness. Omission preserves the historical
    /// open-object behavior; `false` makes the configured property set exact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additional_properties: Option<bool>,
    /// Optional regular-expression constraint for string-like fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, rename = "enum")]
    pub enum_values: Vec<Value>,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    #[default]
    Json,
    String,
    Integer,
    Number,
    Boolean,
    Path,
    NodeRef,
    List,
    Object,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeTypeDef {
    pub source: String,
    pub relation: String,
    pub targets: Vec<String>,
    #[serde(default)]
    pub min: usize,
    #[serde(default)]
    pub max: Option<usize>,
    #[serde(default)]
    pub acyclic: bool,
    #[serde(default)]
    pub inverse: Option<String>,
    #[serde(default)]
    pub on_delete: EdgeDeletePolicy,
    /// Optional predicate evaluated for every concrete source/target pair.
    /// Validation binds exactly `$source` and `$target` to those nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<Predicate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatePolicyDef {
    pub id: String,
    #[serde(default)]
    pub description: String,
    /// Node types allowed as the gate side of this policy.
    pub gate_node_types: Vec<String>,
    /// Exact active gate universe considered at compiler boundaries.
    pub gate_subjects: Selector,
    /// Candidate types allowed to provide the capability.
    pub candidate_node_types: Vec<String>,
    /// Profile-owned candidate universe. It is evaluated with `$gate` bound.
    pub candidate_pool: Selector,
    /// Exact semantic target(s) evaluated by the gate. Phase two consumes this
    /// independently of an enclosing ticket.
    pub evaluation_targets: GateEvaluationTargetsDef,
    pub capability: GateCapabilityDef,
    pub selection: GateSelectionDef,
    /// Exact receipt statuses that satisfy a gate once currentness is proven.
    pub passing_receipt_statuses: Vec<String>,
    /// Profile-owned blocking obligation identity for a concrete gate.
    pub obligation_key_template: String,
    /// Profile-owned obligation identity when a required subject has no gate.
    pub missing_gate_obligation_key_template: String,
    /// Subject-level applicability reserved for inherited gate readiness. It
    /// distinguishes required subjects with no gates from node types for which
    /// gates are optional, without embedding domain topology in Rust.
    pub applicability: GateApplicabilityDef,
    /// Graph/file context required by an evaluation. These values are exposed
    /// now so automatic evaluation can use the same policy contract later.
    #[serde(default)]
    pub context: Option<GateEvaluationContextDef>,
    /// Profile-owned precondition for executing the selected winner. Automatic
    /// evaluation is skipped until this predicate proves the concrete runtime
    /// and its compiler-owned manifests are ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_ready: Option<Predicate>,
    /// Reserved typed trigger for compiler-boundary evaluation. Phase one
    /// validates and hashes it; phase two performs the automatic invocation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_evaluate: Option<GateAutoEvaluateDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateApplicabilityDef {
    pub subject_node_types: Vec<String>,
    #[serde(default)]
    pub required_subject_node_types: Vec<String>,
    pub context_class_order: Vec<String>,
    pub direct_gates: Selector,
    pub inherited_gates: Selector,
    pub context: Selector,
    #[serde(default)]
    pub context_classes: BTreeMap<String, Selector>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateAutoEvaluateDef {
    pub check: String,
    #[serde(default)]
    pub boundaries: Vec<GateCompileBoundary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateCompileBoundary {
    Full,
    Scoped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateEvaluationTargetsDef {
    pub select: Selector,
    #[serde(default = "default_gate_target_cardinality")]
    pub cardinality: GateTargetCardinality,
}

fn default_gate_target_cardinality() -> GateTargetCardinality {
    GateTargetCardinality::ExactlyOne
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateTargetCardinality {
    ExactlyOne,
    ZeroOrOne,
    OneOrMore,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateEvaluationContextDef {
    pub select: Selector,
    #[serde(default)]
    pub read_paths: Vec<PathScopeDef>,
}

/// One reusable capability protocol: an exact configured name and one full
/// SemVer provider version satisfying a configured SemVer requirement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateCapabilityDef {
    pub required_name_fields: Vec<String>,
    pub required_version_req_fields: Vec<String>,
    pub provider_collection_fields: Vec<String>,
    pub provider_name_fields: Vec<String>,
    pub provider_version_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateSelectionDef {
    pub mode: GateSelectionMode,
    #[serde(default)]
    pub ranks: Vec<GateRankDef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tie_break: Option<GateTieBreakDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateTieBreakDef {
    pub field: String,
    pub direction: GateSortDirection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateSortDirection {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateSelectionMode {
    RankedFirst,
    ExactlyOne,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateRankDef {
    pub id: String,
    pub kind: GateRankKind,
    /// Configured candidate field aliases. Map-result fields may contain `*`
    /// to visit authored array members deterministically.
    #[serde(default)]
    pub fields: Vec<String>,
    #[serde(default)]
    pub relations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateRankKind {
    MapHasGateKey,
    MergedMapValueEquals,
    FieldEqualsGateId,
    EdgeContainsGate,
    MergedMapHasGateKey,
    Compatible,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeDeletePolicy {
    #[default]
    Remove,
    Restrict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryDef {
    pub id: String,
    #[serde(default)]
    pub params: BTreeMap<String, ValueType>,
    #[serde(default)]
    pub node_types: Vec<String>,
    #[serde(default)]
    pub statuses: Vec<String>,
    #[serde(default)]
    pub status_excluding: Vec<String>,
    #[serde(default)]
    pub traverse: Option<QueryTraverseDef>,
    #[serde(default)]
    pub select: Option<Selector>,
    #[serde(default, rename = "where")]
    pub predicate: Option<Predicate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryTraverseDef {
    pub from: Selector,
    #[serde(default)]
    pub relations: Vec<String>,
    #[serde(default)]
    pub direction: crate::expr::TraverseDirection,
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
}

fn default_max_depth() -> usize {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleDef {
    pub id: String,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub priority: i32,
    pub for_each: Selector,
    #[serde(default = "default_rule_binding")]
    pub bind: String,
    #[serde(default = "default_true_predicate")]
    pub when: Predicate,
    #[serde(default)]
    pub derive: Vec<DerivationDef>,
    #[serde(default)]
    pub emit: Option<TicketEmitDef>,
}

fn default_rule_binding() -> String {
    "target".to_owned()
}

fn default_true_predicate() -> Predicate {
    Predicate::Constant(true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DerivationDef {
    pub kind: DerivationKind,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub field: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default, flatten)]
    pub args: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DerivationKind {
    Obligation,
    Projection,
    Readiness,
    ProgramState,
    GateRequest,
    CheckRequest,
    Barrier,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketEmitDef {
    pub operation: String,
    #[serde(default)]
    pub registry_entry_id: Option<String>,
    pub source_state: String,
    pub target_state: String,
    #[serde(default)]
    pub obligations: Vec<String>,
    #[serde(default = "default_target_selector")]
    pub target_nodes: Selector,
    #[serde(default = "default_target_selector")]
    pub read_scope: Selector,
    #[serde(default = "default_target_selector")]
    pub write_scope: Selector,
    /// Literal project-relative paths or graph-field projections that belong
    /// in the ticket's filesystem read scope.
    #[serde(default)]
    pub read_paths: Vec<PathScopeDef>,
    /// Literal project-relative paths or graph-field projections that belong
    /// in the ticket's filesystem write scope.
    #[serde(default)]
    pub write_paths: Vec<PathScopeDef>,
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

/// One declarative filesystem-scope source.
///
/// String values are literal project-relative paths:
///
/// ```yaml
/// write_paths:
///   - packages/core
/// ```
///
/// Mapping values project a field from every node selected at ticket-emission
/// time. The field may resolve to one path string or a list of path strings:
///
/// ```yaml
/// write_paths:
///   - select: $target
///     field: spec.owned_paths
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PathScopeDef {
    Literal(PathBuf),
    Projection(PathProjectionDef),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathProjectionDef {
    pub select: Selector,
    pub field: String,
}

fn default_target_selector() -> Selector {
    Selector::Variable(crate::expr::VariableSelectorEnvelope {
        variable: "target".to_owned(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationDef {
    /// Stable, profile-defined registry identifier.
    pub id: String,
    /// Public operation placed on a ticket.
    #[serde(default)]
    pub operation: String,
    pub stage: String,
    #[serde(default)]
    pub target_types: Vec<String>,
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default)]
    pub allowed_new_node_types: Vec<String>,
    #[serde(default)]
    pub allowed_existing_node_types: Vec<String>,
    /// Optional per-type restriction for existing-node updates. A configured
    /// type must preserve every non-edge field and may only add targets on the
    /// listed relations. Omission preserves the historical broader authority.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub existing_node_edge_additions_only: BTreeMap<String, Vec<String>>,
    /// Maximum number of distinct graph nodes one submitted graph delta may
    /// introduce. The budget is profile-owned and domain-neutral.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_new_nodes: Option<usize>,
    /// Optional domain-neutral provenance contract for operations that turn a
    /// graph portfolio into receipt-backed candidate nodes. Omission preserves
    /// the historical operation behavior and serialized profile hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_coverage: Option<ReceiptCoverageDef>,
    #[serde(default)]
    pub allow_node_deletion: bool,
    /// Permit complete-node upserts to remove relationships already present
    /// on the materialized node. The conservative default prevents a worker
    /// from dropping unrelated graph context while adding its own links.
    #[serde(default)]
    pub allow_edge_deletion: bool,
    #[serde(default)]
    pub change_control_barrier: bool,
    /// Typed lifecycle role for upstream change control. Ordinary operations
    /// may hand off bounded upstream corrections; proposal/application/
    /// disposition roles form the compiler-owned approval transaction.
    #[serde(default, skip_serializing_if = "OperationChangeControlDef::is_default")]
    pub change_control: OperationChangeControlDef,
    /// Permit changes to the profile-defined gate contract surface. Runtime
    /// protection is introduced by the change-control phase; this typed flag
    /// replaces an unvalidated extension today.
    #[serde(default)]
    pub allow_gate_contract_edits: bool,
    /// Mark work whose completion is not blocked by unresolved gates. Admission
    /// enforcement is intentionally deferred to the next gate slice.
    #[serde(default)]
    pub gate_blocking_exempt: bool,
    #[serde(default)]
    pub single_flight_group: Option<String>,
    #[serde(default)]
    pub review_contract: String,
    #[serde(default)]
    pub output_contract: String,
    /// Profile-owned scheduling preference. Higher values are dispatched
    /// before lower values; equal priorities use stable ticket metadata.
    #[serde(default, skip_serializing_if = "is_zero_i64")]
    pub dispatch_priority: i64,
    #[serde(default)]
    pub ranking_hints: Vec<String>,
    #[serde(default)]
    pub checks: Vec<String>,
    /// Compiler-owned graph mutations that become authoritative only after a
    /// hash-bound configured reviewer returns the selected verdict.
    ///
    /// Omission preserves the historical review behavior and profile hash.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub review_effects: Vec<ReviewEffectDef>,
    #[serde(default, flatten)]
    pub extensions: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "role", rename_all = "snake_case", deny_unknown_fields)]
pub enum OperationChangeControlDef {
    Ordinary {
        #[serde(default)]
        allow_upstream_requests: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        proposal_operation: Option<String>,
    },
    Proposal {
        proposal_step: String,
        application_operations: Vec<String>,
    },
    Application,
    Disposition {
        outcome: ChangeControlDispositionKind,
    },
}

impl Default for OperationChangeControlDef {
    fn default() -> Self {
        Self::Ordinary {
            allow_upstream_requests: false,
            proposal_operation: None,
        }
    }
}

impl OperationChangeControlDef {
    fn is_default(&self) -> bool {
        matches!(
            self,
            Self::Ordinary {
                allow_upstream_requests: false,
                proposal_operation: None,
            }
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeControlDispositionKind {
    NoOp,
}

/// Exact provenance coverage required before an operation may pass review or
/// cross its finish boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptCoverageDef {
    /// Delta-touched nodes of these types are the candidate interpretations.
    pub candidate_node_types: Vec<String>,
    /// Nodes whose receipts must be interpreted, reached from every ticket
    /// target through one bounded mixed-relation traversal.
    pub required_nodes: ReceiptCoverageTraversalDef,
    /// Candidate-owned relationship that names the interpreted nodes.
    pub candidate_link_relation: String,
    /// Whether the aggregate candidate links must equal or merely contain the
    /// required set.
    #[serde(default)]
    pub coverage: ReceiptCoverageMode,
    /// Compiler receipt kind and accepted terminal statuses.
    pub receipt_type: String,
    pub receipt_statuses: Vec<String>,
    /// Optional candidate field containing the exact receipt IDs cited by that
    /// candidate. When configured, it must be a list field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_refs_path: Option<String>,
    /// Candidate field containing an object keyed by interpreted node ID.
    pub disposition_map_path: String,
    pub disposition: ReceiptDispositionDef,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptCoverageTraversalDef {
    /// Every listed relation is traversable at every hop, allowing a profile
    /// to describe a heterogeneous semantic path without engine domain code.
    pub relations: Vec<String>,
    #[serde(default)]
    pub direction: crate::expr::TraverseDirection,
    #[serde(default = "default_receipt_coverage_min_depth")]
    pub min_depth: usize,
    pub max_depth: usize,
    /// Only reached nodes of these types enter the required receipt set;
    /// intermediate traversal nodes may have any configured type.
    pub node_types: Vec<String>,
}

fn default_receipt_coverage_min_depth() -> usize {
    1
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptCoverageMode {
    #[default]
    Exact,
    AtLeast,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptDispositionDef {
    /// Paths are relative to one disposition-map entry.
    pub value_path: String,
    pub receipt_id_path: String,
    pub rationale_path: String,
    pub allowed_values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReviewEffectDef {
    pub id: String,
    pub verdict: String,
    pub select: ReviewEffectSelectorDef,
    pub count: ReviewEffectCountDef,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preconditions: Vec<ReviewEffectFieldPredicateDef>,
    /// Exact set-coverage contracts evaluated for every selected candidate
    /// before compiler-owned fields are stamped and again when the durable
    /// review is consumed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub coverage: Vec<ReviewEffectCoverageDef>,
    pub set: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReviewEffectSelectorDef {
    pub node_types: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predicate: Option<ReviewEffectFieldPredicateDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReviewEffectCountDef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exact: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReviewEffectFieldPredicateDef {
    pub field: String,
    pub op: ReviewEffectFieldPredicateOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEffectFieldPredicateOp {
    Equals,
    Present,
    Absent,
    NonEmpty,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReviewEffectCoverageDef {
    pub id: String,
    pub required: Selector,
    pub actual: ReviewEffectCoverageActualDef,
    #[serde(default)]
    pub mode: ReviewEffectCoverageMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReviewEffectCoverageActualDef {
    pub kind: ReviewEffectCoverageActualKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
    /// Optional exact vocabulary for object-map values. This lets a profile
    /// require an explicit disposition for every required key rather than
    /// accepting null or arbitrary metadata as coverage.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_values: Vec<Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEffectCoverageActualKind {
    FieldValue,
    FieldValues,
    ObjectKeys,
    OutgoingRelation,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEffectCoverageMode {
    #[default]
    Exact,
}

fn is_zero_i64(value: &i64) -> bool {
    *value == 0
}

impl OperationDef {
    pub fn public_operation(&self) -> &str {
        if self.operation.is_empty() {
            &self.id
        } else {
            &self.operation
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDef {
    pub id: String,
    #[serde(default = "default_module_version")]
    pub version: String,
    #[serde(default)]
    pub applies_to: Vec<String>,
    /// Earliest workflow step whose output should be superseded when Lead
    /// review fails. All transitive dependents are reopened with it. Omitting
    /// this preserves the legacy integration-only rework behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_failure_reopen_from: Option<String>,
    pub steps: Vec<WorkflowStepDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowStepDef {
    pub id: String,
    #[serde(default)]
    pub kind: WorkflowStepKind,
    pub persona: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default = "default_true")]
    pub required: bool,
    #[serde(default = "default_ticket_read_scope")]
    pub read_scope: Selector,
    #[serde(default = "default_ticket_write_scope")]
    pub write_scope: Selector,
    #[serde(default)]
    pub expected_output: String,
    #[serde(default)]
    pub validation_action: Option<String>,
    #[serde(default)]
    pub required_receipts: Vec<String>,
    #[serde(default)]
    pub escalation_triggers: Vec<String>,
    #[serde(default)]
    pub stop_conditions: Vec<String>,
    #[serde(default)]
    pub checks: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStepKind {
    #[default]
    Production,
    Integration,
    Review,
    Agent,
    Manual,
}

fn default_ticket_read_scope() -> Selector {
    Selector::Variable(crate::expr::VariableSelectorEnvelope {
        variable: "ticket_read_scope".to_owned(),
    })
}

fn default_ticket_write_scope() -> Selector {
    Selector::Variable(crate::expr::VariableSelectorEnvelope {
        variable: "ticket_write_scope".to_owned(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionDef {
    pub id: String,
    #[serde(default = "default_action_actor")]
    pub actor: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub params: BTreeMap<String, ActionParameterDef>,
    #[serde(default)]
    pub allowed_ticket_states: Vec<String>,
    #[serde(default)]
    pub requires_main_checkout: bool,
    #[serde(default)]
    pub requires_ticket_worktree: bool,
    #[serde(default)]
    pub recipe: Vec<ActionStepDef>,
    #[serde(default)]
    pub compensation: Vec<ActionStepDef>,
    #[serde(default)]
    pub recovery: Option<String>,
}

fn default_action_actor() -> String {
    "compiler".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionParameterDef {
    #[serde(rename = "type", default)]
    pub value_type: ParameterType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParameterType {
    #[default]
    String,
    Boolean,
    Integer,
    Number,
    Path,
    NodeId,
    TicketId,
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionStepDef {
    #[serde(default)]
    pub id: Option<String>,
    pub primitive: String,
    #[serde(default)]
    pub when: Option<Predicate>,
    #[serde(default, flatten)]
    pub args: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckDef {
    pub id: String,
    pub kind: CheckKind,
    #[serde(default)]
    pub predicate: Option<Predicate>,
    #[serde(default)]
    pub applies_to: Vec<String>,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default)]
    pub argv_from: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_source: Option<DynamicCommandSourceDef>,
    #[serde(default = "default_check_cwd")]
    pub cwd: PathBuf,
    #[serde(default = "default_check_timeout")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub result_protocol: Option<String>,
    #[serde(default = "default_result_protocol_field")]
    pub result_protocol_field: String,
    #[serde(default)]
    pub required_result_fields: Vec<String>,
    #[serde(default)]
    pub result_schema: Option<Value>,
    #[serde(default)]
    pub result_line_prefix: Option<String>,
    #[serde(default)]
    pub result_acceptance: Option<ResultAcceptanceDef>,
    #[serde(default)]
    pub result_identity_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynamic_result: Option<DynamicResultDef>,
    #[serde(default)]
    pub allow_nonpassing_receipt: bool,
    #[serde(default)]
    pub argv_input_bindings: Option<ArgvInputBindingsDef>,
    #[serde(default)]
    pub artifact_paths: Vec<String>,
    pub receipt_type: String,
    #[serde(default)]
    pub retry_policy: RetryPolicyDef,
    #[serde(default = "default_process_effect")]
    pub effect: ProcessEffect,
    #[serde(default)]
    pub environment: EnvironmentPolicyDef,
}

/// A bounded, ticket-relative source for a dynamically resolved command.
///
/// Node sources only inspect nodes already authorized by the ticket's target or
/// read scope. Ticket sources inspect the virtual ticket value assembled by the
/// runtime from the ticket record and its target contract. Runtime resolution
/// must produce exactly one candidate command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicCommandSourceDef {
    pub kind: DynamicSourceKind,
    pub field: String,
    pub role: String,
    #[serde(default)]
    pub selection: Option<DynamicNodeSelection>,
    #[serde(default)]
    pub node_types: Vec<String>,
    /// Resolve the node source through a configured gate policy winner instead
    /// of selecting an arbitrary scoped node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_policy: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DynamicSourceKind {
    Node,
    Ticket,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DynamicNodeSelection {
    Target,
    ReadScope,
}

/// Result validation whose requirements are projected from the exact contract
/// candidate bound while resolving the command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicResultDef {
    #[serde(default)]
    pub required_keys: Option<DynamicRequiredKeysDef>,
    #[serde(default)]
    pub result_path: Option<DynamicResultPathDef>,
    #[serde(default)]
    pub artifacts: Option<ResultArtifactPolicyDef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicResultPathDef {
    #[serde(flatten)]
    pub source: DynamicBoundValueSourceDef,
    pub path_authorities: Vec<DynamicPathAuthorityDef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicRequiredKeysDef {
    pub source: DynamicBoundValueSourceDef,
    pub actual_field: String,
    pub relation: KeySetRelation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicBoundValueSourceDef {
    pub role: String,
    pub field: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicPathAuthorityDef {
    pub authority: TicketPathAuthority,
    pub provenance: DynamicPathProvenance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TicketPathAuthority {
    ReadPaths,
    WritePaths,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DynamicPathProvenance {
    ReadEvidence,
    ProducedOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeySetRelation {
    Superset,
    Exact,
}

/// Policy for artifact paths declared by the typed command result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultArtifactPolicyDef {
    pub field: String,
    /// Accept result-array items that are directly represented as path strings.
    #[serde(default)]
    pub allow_path_strings: bool,
    /// Accept result-array objects and extract their path from this field.
    #[serde(default)]
    pub path_field: Option<String>,
    /// Ticket filesystem authorities and provenance roles permitted for each
    /// result-declared artifact. Multiple entries allow a generic check to
    /// accept either immutable read evidence or freshly produced output.
    pub path_authorities: Vec<DynamicPathAuthorityDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultAcceptanceDef {
    pub field: String,
    pub values: Vec<Value>,
}

fn default_check_cwd() -> PathBuf {
    ".".into()
}
fn default_check_timeout() -> u64 {
    15 * 60
}
fn default_result_protocol_field() -> String {
    "protocol".to_owned()
}
fn default_process_effect() -> ProcessEffect {
    ProcessEffect::ReadOnly
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArgvInputBindingsDef {
    pub from: String,
    #[serde(default = "default_binding_path_field")]
    pub path_field: String,
    #[serde(default)]
    pub required_fields: Vec<String>,
    #[serde(default)]
    pub require_nonempty: bool,
    #[serde(default)]
    pub require_project_file: bool,
    #[serde(default)]
    pub require_exact_argument: bool,
}

fn default_binding_path_field() -> String {
    "path".to_owned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    Command,
    Graph,
    Agent,
    Manual,
    Composite,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessEffect {
    #[default]
    ReadOnly,
    WorkspaceWrite,
    External,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RetryPolicyDef {
    #[serde(default)]
    pub max_attempts: usize,
    #[serde(default)]
    pub transient_exit_codes: Vec<i32>,
    #[serde(default)]
    pub backoff_seconds: Vec<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EnvironmentPolicyDef {
    #[serde(default)]
    pub inherit: Vec<String>,
    #[serde(default)]
    pub set: BTreeMap<String, String>,
    #[serde(default)]
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaDef {
    pub id: String,
    #[serde(default)]
    pub prompt: Option<PathBuf>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub model_role: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub sandbox: Option<SandboxDef>,
    /// Name of a project-scoped custom agent in `.codex/agents/*.toml`.
    #[serde(default)]
    pub codex_agent: Option<String>,
    /// Native repository skill names whose bundles are required by this persona.
    #[serde(default)]
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxDef {
    #[serde(default = "default_sandbox_mode")]
    pub mode: String,
    #[serde(default = "default_approval_policy")]
    pub approval_policy: String,
    #[serde(default)]
    pub network_access: bool,
    #[serde(default)]
    pub writable_roots: Vec<String>,
}

impl Default for SandboxDef {
    fn default() -> Self {
        Self {
            mode: default_sandbox_mode(),
            approval_policy: default_approval_policy(),
            network_access: false,
            writable_roots: Vec::new(),
        }
    }
}

fn default_sandbox_mode() -> String {
    "workspace-write".to_owned()
}
fn default_approval_policy() -> String {
    "never".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportDef {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub formats: Vec<ReportFormat>,
    #[serde(default)]
    pub source: Value,
    #[serde(default)]
    pub columns: Vec<ReportColumnDef>,
    #[serde(default)]
    pub filter: Option<Predicate>,
    pub output: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportFormat {
    Json,
    Markdown,
    Yaml,
    Csv,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportColumnDef {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewDef {
    pub id: String,
    pub title: String,
    #[serde(default = "default_view_kind")]
    pub kind: String,
    #[serde(default)]
    pub source: Value,
    #[serde(default)]
    pub columns: Vec<ReportColumnDef>,
    #[serde(default)]
    pub filter: Option<Predicate>,
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default)]
    pub options: BTreeMap<String, Value>,
}

fn default_view_kind() -> String {
    "table".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateMachineDef {
    pub id: String,
    pub initial: String,
    pub states: Vec<String>,
    #[serde(default)]
    pub terminal_states: Vec<String>,
    pub transitions: Vec<StateTransitionDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTransitionDef {
    pub id: String,
    pub from: Vec<String>,
    pub to: String,
    #[serde(default)]
    pub guard: Option<Predicate>,
    #[serde(default)]
    pub actors: Vec<String>,
}

/// Immutable, validated profile IR consumed by the engine.
#[derive(Debug, Clone)]
pub struct CompiledProfile {
    pub manifest: ProfileManifest,
    pub root: PathBuf,
    pub imported_files: Vec<PathBuf>,
    pub node_types: IndexMap<String, NodeTypeDef>,
    pub edge_types: Vec<EdgeTypeDef>,
    pub gate_policies: IndexMap<String, GatePolicyDef>,
    pub queries: IndexMap<String, QueryDef>,
    pub rules: IndexMap<String, RuleDef>,
    pub operations: IndexMap<String, OperationDef>,
    pub workflows: IndexMap<String, WorkflowDef>,
    pub actions: IndexMap<String, ActionDef>,
    pub checks: IndexMap<String, CheckDef>,
    pub personas: IndexMap<String, PersonaDef>,
    pub reports: IndexMap<String, ReportDef>,
    pub views: IndexMap<String, ViewDef>,
    pub state_machines: IndexMap<String, StateMachineDef>,
    pub native_codex: NativeCodexCatalog,
    pub hash: String,
}

/// The effective, runnable persona after resolving an optional native Codex
/// custom agent beneath explicit Koni overrides.
#[derive(Debug, Clone)]
pub struct ResolvedPersona {
    pub id: String,
    pub description: String,
    pub instructions: String,
    pub instruction_source: PathBuf,
    pub model_role: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub sandbox: SandboxDef,
    pub codex_agent: Option<String>,
    /// Whether `instructions` came from an explicit Koni prompt rather
    /// than solely from the native agent's developer-instruction layer.
    pub explicit_prompt: bool,
    pub skills: Vec<String>,
    /// Safe `codex exec --config` assignments inherited from the referenced
    /// native custom-agent layer. Koni intentionally omits model,
    /// reasoning, sandbox, and approval keys because its run policy owns them.
    pub native_codex_config_overrides: Vec<String>,
}

impl ResolvedPersona {
    pub fn codex_config_overrides(&self) -> impl Iterator<Item = &str> {
        self.native_codex_config_overrides
            .iter()
            .map(String::as_str)
    }
}

impl CompiledProfile {
    pub fn resolve_persona(&self, id: &str) -> Result<ResolvedPersona> {
        let persona = self
            .personas
            .get(id)
            .ok_or_else(|| KoniError::NotFound(format!("profile persona {id}")))?;
        self.resolve_persona_def(persona)
    }

    pub fn resolve_persona_def(&self, persona: &PersonaDef) -> Result<ResolvedPersona> {
        let native_agent = persona
            .codex_agent
            .as_deref()
            .map(|name| {
                self.native_codex.agent(name).ok_or_else(|| {
                    KoniError::Profile(format!(
                        "persona {} references unknown Codex custom agent {name}",
                        persona.id
                    ))
                })
            })
            .transpose()?;
        let (instructions, instruction_source) = if let Some(prompt) = &persona.prompt {
            let path = self.root.join(prompt);
            let instructions = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
            (instructions, path)
        } else if let Some(agent) = native_agent {
            (
                agent.developer_instructions.clone(),
                self.native_codex.project_root.join(&agent.path),
            )
        } else {
            return Err(KoniError::Profile(format!(
                "persona {} must define prompt or codex_agent",
                persona.id
            )));
        };
        let description = if persona.description.trim().is_empty() {
            native_agent
                .map(|agent| agent.description.clone())
                .unwrap_or_default()
        } else {
            persona.description.clone()
        };
        let mut sandbox = persona.sandbox.clone().unwrap_or_default();
        if persona.sandbox.is_none()
            && let Some(mode) = native_agent.and_then(|agent| agent.sandbox_mode.clone())
        {
            sandbox.mode = mode;
        }
        let native_codex_config_overrides = native_agent
            .map(native_agent_config_overrides)
            .unwrap_or_default();
        Ok(ResolvedPersona {
            id: persona.id.clone(),
            description,
            instructions,
            instruction_source,
            model_role: persona.model_role.clone(),
            model: persona
                .model
                .clone()
                .or_else(|| native_agent.and_then(|agent| agent.model.clone())),
            reasoning_effort: persona
                .reasoning_effort
                .clone()
                .or_else(|| native_agent.and_then(|agent| agent.model_reasoning_effort.clone())),
            sandbox,
            codex_agent: persona.codex_agent.clone(),
            explicit_prompt: persona.prompt.is_some(),
            skills: persona.skills.clone(),
            native_codex_config_overrides,
        })
    }

    pub fn action(&self, id_or_alias: &str) -> Option<&ActionDef> {
        self.actions.get(id_or_alias).or_else(|| {
            self.actions
                .values()
                .find(|action| action.aliases.iter().any(|alias| alias == id_or_alias))
        })
    }

    pub fn operation_for(
        &self,
        public_operation: &str,
        stage: Option<&str>,
        target_types: &BTreeSet<String>,
    ) -> Option<&OperationDef> {
        self.operations.values().find(|entry| {
            entry.public_operation() == public_operation
                && stage.is_none_or(|stage| entry.stage == stage)
                && target_types
                    .iter()
                    .all(|node_type| entry.target_types.contains(node_type))
        })
    }

    pub fn expression_symbols(&self) -> ExpressionSymbols {
        let node_types = self.node_types.keys().cloned().collect();
        let mut queries: BTreeSet<String> = self.queries.keys().cloned().collect();
        // A node type name is valid shorthand for a query selecting that type.
        queries.extend(self.node_types.keys().cloned());
        let receipt_coverages = self
            .operations
            .iter()
            .filter(|(_, operation)| operation.receipt_coverage.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        let review_effects = self
            .operations
            .iter()
            .flat_map(|(operation_id, operation)| {
                operation
                    .review_effects
                    .iter()
                    .filter(|effect| !effect.coverage.is_empty())
                    .map(move |effect| format!("{operation_id}#{}", effect.id))
            })
            .collect();
        ExpressionSymbols {
            node_types,
            queries,
            receipt_coverages,
            review_effects,
            gate_policies: self.gate_policies.keys().cloned().collect(),
            variables: BTreeMap::new(),
        }
    }
}

fn native_agent_config_overrides(agent: &crate::codex::CodexAgentDef) -> Vec<String> {
    let mut overrides = vec![format!(
        "developer_instructions={}",
        toml::Value::String(agent.developer_instructions.clone())
    )];
    if let Some(mcp_servers) = agent.config.get("mcp_servers") {
        overrides.push(format!("mcp_servers={mcp_servers}"));
    }
    if let Some(skills_config) = agent
        .config
        .get("skills")
        .and_then(toml::Value::as_table)
        .and_then(|skills| skills.get("config"))
    {
        overrides.push(format!("skills.config={skills_config}"));
    }
    overrides
}

pub struct ProfileCompiler;

impl ProfileCompiler {
    pub fn compile(input: &Path) -> Result<CompiledProfile> {
        let manifest_path = locate_manifest(input)?;
        let root = manifest_path
            .parent()
            .ok_or_else(|| {
                KoniError::Profile(format!(
                    "manifest has no parent: {}",
                    manifest_path.display()
                ))
            })?
            .to_path_buf();
        let manifest_text =
            fs::read_to_string(&manifest_path).map_err(|error| io_error(&manifest_path, error))?;
        let manifest: ProfileManifest =
            match manifest_path.extension().and_then(|value| value.to_str()) {
                Some("yaml" | "yml") => {
                    serde_yaml::from_str(&manifest_text).map_err(|source| KoniError::Yaml {
                        path: manifest_path.clone(),
                        source,
                    })?
                }
                _ => toml::from_str(&manifest_text).map_err(|source| KoniError::Toml {
                    path: manifest_path.clone(),
                    source,
                })?,
            };
        validate_manifest(&manifest)?;

        let mut document = ModuleDocument::default();
        let mut imported_files = Vec::new();
        let mut imported = BTreeSet::new();
        for relative in manifest.imports.ordered_paths() {
            let path = resolve_import(&root, relative)?;
            let identity = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if !imported.insert(identity.clone()) {
                return Err(KoniError::Profile(format!(
                    "duplicate profile import {identity}"
                )));
            }
            let text = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
            let module: ModuleDocument =
                serde_yaml::from_str(&text).map_err(|source| KoniError::Yaml {
                    path: path.clone(),
                    source,
                })?;
            merge_document(&mut document, module);
            imported_files.push(path);
        }

        let project_root = project_root_for_profile(&root);
        let native_codex = NativeCodexCatalog::discover(&project_root)?;
        let mut profile = compile_document(manifest, root, imported_files, document, native_codex)?;
        validate_profile(&profile)?;
        profile.hash = profile_hash(&profile)?;
        Ok(profile)
    }
}

fn locate_manifest(input: &Path) -> Result<PathBuf> {
    if input.is_file() {
        return Ok(input.to_path_buf());
    }
    let candidates = [
        input.join("profile.yaml"),
        input.join("koni.yaml"),
        input.join(".codex/koni/profile.yaml"),
        input.join(".codex/koni/koni.yaml"),
        input.join("koni.toml"),
        input.join(".codex/koni/koni.toml"),
    ];
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| KoniError::NotFound(format!("profile manifest under {}", input.display())))
}

fn validate_manifest(manifest: &ProfileManifest) -> Result<()> {
    if manifest.schema_version != PROFILE_SCHEMA_VERSION {
        return Err(KoniError::Profile(format!(
            "unsupported profile schema {}; expected {}",
            manifest.schema_version, PROFILE_SCHEMA_VERSION
        )));
    }
    validate_identifier("profile id", &manifest.profile.id)?;
    if manifest.profile.version.trim().is_empty() {
        return Err(KoniError::Profile(
            "profile version must not be empty".to_owned(),
        ));
    }
    if manifest.engine.trim().is_empty() {
        return Err(KoniError::Profile(
            "engine requirement must not be empty".to_owned(),
        ));
    }
    validate_identifier("report bundle kind", &manifest.reporting.bundle_kind)?;
    let engine_requirement = VersionReq::parse(&manifest.engine).map_err(|error| {
        KoniError::Profile(format!("invalid engine version requirement: {error}"))
    })?;
    let engine_version =
        Version::parse(env!("CARGO_PKG_VERSION")).expect("crate version is semver");
    if !engine_requirement.matches(&engine_version) {
        return Err(KoniError::Profile(format!(
            "profile requires engine {}, but this Koni build is {}",
            manifest.engine, engine_version
        )));
    }
    if manifest.orchestration.max_parallel == 0
        || manifest.orchestration.max_fixpoint_passes == 0
        || manifest.orchestration.max_boundaries_per_lead == 0
    {
        return Err(KoniError::Profile(
            "orchestration max_parallel, max_fixpoint_passes, and max_boundaries_per_lead must be positive"
                .to_owned(),
        ));
    }
    if manifest.git.enabled {
        if manifest.git.backend != "libgit2" {
            return Err(KoniError::Profile(format!(
                "unsupported Git backend {}; expected libgit2",
                manifest.git.backend
            )));
        }
        if manifest.git.integration_strategy != "squash" {
            return Err(KoniError::Profile(format!(
                "unsupported Git integration strategy {}; expected squash",
                manifest.git.integration_strategy
            )));
        }
        if !manifest
            .git
            .ticket_branch_template
            .contains("{{ ticket.id }}")
        {
            return Err(KoniError::Profile(
                "git.ticket_branch_template must contain {{ ticket.id }}".to_owned(),
            ));
        }
    }
    for path in [
        &manifest.storage.graph_dir,
        &manifest.storage.tickets_dir,
        &manifest.storage.state_path,
        &manifest.storage.work_dir,
        &manifest.storage.receipts_dir,
        &manifest.storage.reports_dir,
        &manifest.git.worktree_root,
    ] {
        validate_relative_path(path, "configured storage/Git path")?;
    }
    if manifest
        .storage
        .filesystem_scope_excludes
        .iter()
        .collect::<BTreeSet<_>>()
        .len()
        != manifest.storage.filesystem_scope_excludes.len()
    {
        return Err(KoniError::Profile(
            "storage.filesystem_scope_excludes must not contain duplicates".to_owned(),
        ));
    }
    for path in &manifest.storage.filesystem_scope_excludes {
        validate_project_relative_scope_path(path)?;
        if path == Path::new(".") {
            return Err(KoniError::Profile(
                "storage.filesystem_scope_excludes may not exclude the entire project".to_owned(),
            ));
        }
    }
    let state_root = manifest
        .storage
        .state_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if state_root != Path::new(".") {
        for path in [
            &manifest.storage.graph_dir,
            &manifest.storage.tickets_dir,
            &manifest.storage.work_dir,
            &manifest.storage.receipts_dir,
            &manifest.storage.reports_dir,
        ] {
            if !path.starts_with(state_root) {
                return Err(KoniError::Profile(format!(
                    "configured state path {} is outside state root {}",
                    path.display(),
                    state_root.display()
                )));
            }
        }
    }
    Ok(())
}

fn resolve_import(root: &Path, relative: &Path) -> Result<PathBuf> {
    validate_relative_path(relative, "profile import")?;
    let path = root.join(relative);
    if !path.is_file() {
        return Err(KoniError::NotFound(format!(
            "profile import {}",
            path.display()
        )));
    }
    let canonical_root = root.canonicalize().map_err(|error| io_error(root, error))?;
    let canonical = path
        .canonicalize()
        .map_err(|error| io_error(&path, error))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(KoniError::Profile(format!(
            "profile import escapes profile root: {}",
            relative.display()
        )));
    }
    Ok(path)
}

fn validate_relative_path(path: &Path, label: &str) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(KoniError::Profile(format!(
            "{label} must be a nonempty relative path: {}",
            path.display()
        )));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(KoniError::Profile(format!(
            "{label} may not escape its root: {}",
            path.display()
        )));
    }
    Ok(())
}

/// Validate the lexical containment contract shared by literal ticket path
/// scopes and their eventual runtime projections.
///
/// This intentionally rejects parent components even when a later component
/// would return inside the project. Runtime projection must call the same
/// validator for every field-derived path before adding it to a ticket.
pub fn validate_project_relative_scope_path(path: &Path) -> Result<()> {
    let raw = path
        .to_str()
        .ok_or_else(|| KoniError::Profile("ticket path scope must be valid UTF-8".to_owned()))?;
    if raw.contains('\0') {
        return Err(KoniError::Profile(
            "ticket path scope must not contain a NUL byte".to_owned(),
        ));
    }
    if raw.contains(['*', '?', '[', ']']) {
        return Err(KoniError::Profile(format!(
            "ticket path scope must be a literal path, not a glob: {raw}"
        )));
    }
    let normalized = raw.replace('\\', "/");
    let bytes = normalized.as_bytes();
    if bytes.get(1) == Some(&b':') {
        return Err(KoniError::Profile(format!(
            "ticket path scope must be project-relative, not drive-qualified: {raw}"
        )));
    }
    validate_relative_path(Path::new(&normalized), "ticket path scope")
}

fn merge_document(target: &mut ModuleDocument, mut source: ModuleDocument) {
    target.node_types.append(&mut source.node_types);
    target.edge_types.append(&mut source.edge_types);
    target.gate_policies.append(&mut source.gate_policies);
    target.queries.append(&mut source.queries);
    target.rules.append(&mut source.rules);
    target.operations.append(&mut source.operations);
    target.workflows.append(&mut source.workflows);
    target.actions.append(&mut source.actions);
    target.checks.append(&mut source.checks);
    target.personas.append(&mut source.personas);
    target.reports.append(&mut source.reports);
    target.views.append(&mut source.views);
    target.state_machines.append(&mut source.state_machines);
}

fn compile_document(
    manifest: ProfileManifest,
    root: PathBuf,
    imported_files: Vec<PathBuf>,
    document: ModuleDocument,
    native_codex: NativeCodexCatalog,
) -> Result<CompiledProfile> {
    Ok(CompiledProfile {
        manifest,
        root,
        imported_files,
        node_types: unique_map("node type", document.node_types, |item| &item.id)?,
        edge_types: document.edge_types,
        gate_policies: unique_map("gate policy", document.gate_policies, |item| &item.id)?,
        queries: unique_map("query", document.queries, |item| &item.id)?,
        rules: unique_map("rule", document.rules, |item| &item.id)?,
        operations: unique_map("operation registry entry", document.operations, |item| {
            &item.id
        })?,
        workflows: unique_map("workflow", document.workflows, |item| &item.id)?,
        actions: unique_map("action", document.actions, |item| &item.id)?,
        checks: unique_map("check", document.checks, |item| &item.id)?,
        personas: unique_map("persona", document.personas, |item| &item.id)?,
        reports: unique_map("report", document.reports, |item| &item.id)?,
        views: unique_map("view", document.views, |item| &item.id)?,
        state_machines: unique_map("state machine", document.state_machines, |item| &item.id)?,
        native_codex,
        hash: String::new(),
    })
}

fn unique_map<T, F>(label: &str, items: Vec<T>, id: F) -> Result<IndexMap<String, T>>
where
    F: Fn(&T) -> &str,
{
    let mut output = IndexMap::new();
    for item in items {
        let key = id(&item).to_owned();
        validate_identifier(label, &key)?;
        if output.insert(key.clone(), item).is_some() {
            return Err(KoniError::Profile(format!("duplicate {label} {key}")));
        }
    }
    Ok(output)
}

fn validate_identifier(label: &str, value: &str) -> Result<()> {
    if value.trim().is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character == '/' || character == '\\')
    {
        return Err(KoniError::Profile(format!("invalid {label}: {value:?}")));
    }
    Ok(())
}

fn validate_profile(profile: &CompiledProfile) -> Result<()> {
    validate_node_types(profile)?;
    validate_edges(profile)?;
    validate_queries(profile)?;
    validate_gate_policies(profile)?;
    validate_rules(profile)?;
    validate_operations(profile)?;
    validate_workflows(profile)?;
    validate_actions(profile)?;
    validate_checks(profile)?;
    validate_personas(profile)?;
    validate_reports(profile)?;
    validate_views(profile)?;
    validate_state_machines(profile)?;
    Ok(())
}

fn validate_node_types(profile: &CompiledProfile) -> Result<()> {
    if let Some(root_type) = &profile.manifest.initialization.root_node_type
        && !profile.node_types.contains_key(root_type)
    {
        return profile_error(format!(
            "initialization root_node_type references unknown node type {root_type}"
        ));
    }
    if let Some(planning_context_path) = &profile.manifest.initialization.planning_context_field {
        let root_type = profile
            .manifest
            .initialization
            .root_node_type
            .as_deref()
            .ok_or_else(|| {
                KoniError::Profile(
                    "initialization planning_context_field requires root_node_type".to_owned(),
                )
            })?;
        let planning_context_field = normalized_root_spec_field(planning_context_path).ok_or_else(
            || {
                KoniError::Profile(format!(
                    "initialization planning_context_field {planning_context_path:?} must be a nonempty root spec path such as planning_context or spec.planning_context"
                ))
            },
        )?;
        let root = &profile.node_types[root_type];
        if profile
            .manifest
            .initialization
            .goal_field
            .as_deref()
            .map(normalized_spec_path_for_comparison)
            .is_some_and(|goal_field| goal_field == planning_context_field)
        {
            return profile_error(format!(
                "initialization planning_context_field {planning_context_path} must differ from goal_field"
            ));
        }
        let Some(field) = root.fields.get(planning_context_field) else {
            return profile_error(format!(
                "initialization planning_context_field {planning_context_path} is not declared by node type {root_type}"
            ));
        };
        if field.value_type != FieldType::Object {
            return profile_error(format!(
                "initialization planning_context_field {planning_context_path} must reference an object field on node type {root_type}"
            ));
        }
    }
    if let (Some(root_type), Some(goal_field)) = (
        &profile.manifest.initialization.root_node_type,
        &profile.manifest.initialization.goal_field,
    ) {
        let node = &profile.node_types[root_type];
        let field = goal_field
            .trim_start_matches("spec.")
            .split('.')
            .next()
            .unwrap_or_default();
        if field.is_empty()
            || (!node.fields.is_empty()
                && !node.fields.contains_key(field)
                && !node.required_any.iter().flatten().any(|known| {
                    known.trim_start_matches("spec.") == goal_field.trim_start_matches("spec.")
                }))
        {
            return profile_error(format!(
                "initialization goal_field {goal_field} is not declared by node type {root_type}"
            ));
        }
    }
    if let (Some(root_type), Some(root_status)) = (
        &profile.manifest.initialization.root_node_type,
        &profile.manifest.initialization.root_status,
    ) {
        let statuses = &profile.node_types[root_type].statuses;
        if !statuses.is_empty() && !statuses.contains(root_status) {
            return profile_error(format!(
                "initialization root_status {root_status} is not valid for node type {root_type}"
            ));
        }
    }
    for node in profile.node_types.values() {
        if node
            .description
            .as_deref()
            .is_some_and(|description| description.trim().is_empty())
        {
            return profile_error(format!(
                "node type {} description must not be empty",
                node.id
            ));
        }
        if node.statuses.iter().any(|status| status.trim().is_empty()) {
            return profile_error(format!("node type {} contains an empty status", node.id));
        }
        if let Some(initial_status) = &node.initial_status
            && !node.statuses.contains(initial_status)
        {
            return profile_error(format!(
                "node type {} initial_status {} is not declared in statuses",
                node.id, initial_status
            ));
        }
        for (field, definition) in &node.fields {
            validate_field_definition(&node.id, field, definition)?;
        }
        if let Some(manifest) = &node.filesystem_manifest {
            validate_filesystem_manifest(node, manifest)?;
        }
        for group in &node.required_any {
            if group.is_empty() || group.iter().any(|field| field.trim().is_empty()) {
                return profile_error(format!(
                    "node type {} has an empty required_any group",
                    node.id
                ));
            }
            if !node.fields.is_empty() {
                for field in group {
                    let root = field.split('.').next().unwrap_or_default();
                    if !node.fields.contains_key(root)
                        && !node.semantic_fields.iter().any(|known| known == root)
                    {
                        return profile_error(format!(
                            "node type {} required_any references undeclared field {}",
                            node.id, field
                        ));
                    }
                }
            }
        }
        let semantic: BTreeSet<_> = node.semantic_fields.iter().collect();
        let owned: BTreeSet<_> = node.compiler_owned_fields.iter().collect();
        let overlap: Vec<_> = semantic.intersection(&owned).copied().collect();
        if !overlap.is_empty() {
            return profile_error(format!(
                "node type {} fields cannot be both semantic and compiler-owned: {}",
                node.id,
                overlap.into_iter().cloned().collect::<Vec<_>>().join(", ")
            ));
        }
    }
    Ok(())
}

fn validate_filesystem_manifest(
    node: &NodeTypeDef,
    manifest: &FilesystemManifestDef,
) -> Result<()> {
    let owner = format!("node type {} filesystem_manifest", node.id);
    validate_optional_unique_manifest_values(
        &manifest.contract_fields,
        &format!("{owner} contract_fields"),
    )?;
    for (label, path) in [
        ("root_field", manifest.root_field.as_str()),
        (
            "implementation_contract_field",
            manifest.implementation_contract_field.as_str(),
        ),
        (
            "implementation_kind_field",
            manifest.implementation_kind_field.as_str(),
        ),
        (
            "implementation_entrypoints_field",
            manifest.implementation_entrypoints_field.as_str(),
        ),
        ("output_field", manifest.output_field.as_str()),
    ] {
        validate_contract_field_path(path)
            .map_err(|error| KoniError::Profile(format!("{owner} {label}: {error}")))?;
    }
    for path in &manifest.contract_fields {
        validate_contract_field_path(path).map_err(|error| {
            KoniError::Profile(format!("{owner} contract_fields {path}: {error}"))
        })?;
        filesystem_manifest_node_field(node, path, &owner)?;
    }
    let root = filesystem_manifest_node_field(node, &manifest.root_field, &owner)?;
    if !matches!(root.value_type, FieldType::String | FieldType::Path) {
        return profile_error(format!(
            "{owner} root_field {} must be string or path",
            manifest.root_field
        ));
    }
    let contract =
        filesystem_manifest_node_field(node, &manifest.implementation_contract_field, &owner)?;
    if contract.value_type != FieldType::Object {
        return profile_error(format!(
            "{owner} implementation_contract_field {} must be an object",
            manifest.implementation_contract_field
        ));
    }
    if !manifest
        .implementation_kind_field
        .starts_with(&format!("{}.", manifest.implementation_contract_field))
        || !manifest
            .implementation_entrypoints_field
            .starts_with(&format!("{}.", manifest.implementation_contract_field))
    {
        return profile_error(format!(
            "{owner} implementation kind and entrypoints fields must be children of {}",
            manifest.implementation_contract_field
        ));
    }
    let kind = filesystem_manifest_node_field(node, &manifest.implementation_kind_field, &owner)?;
    if kind.value_type != FieldType::String {
        return profile_error(format!(
            "{owner} implementation_kind_field {} must be a string",
            manifest.implementation_kind_field
        ));
    }
    let entrypoints =
        filesystem_manifest_node_field(node, &manifest.implementation_entrypoints_field, &owner)?;
    if entrypoints.value_type != FieldType::List
        || entrypoints
            .items
            .as_deref()
            .is_none_or(|item| !matches!(item.value_type, FieldType::String | FieldType::Path))
    {
        return profile_error(format!(
            "{owner} implementation_entrypoints_field {} must be a list with string or path items",
            manifest.implementation_entrypoints_field
        ));
    }
    if !node.compiler_owned_fields.contains(&manifest.output_field) {
        return profile_error(format!(
            "{owner} output_field {} must be explicitly compiler-owned",
            manifest.output_field
        ));
    }
    let mut input_fields = vec![
        manifest.root_field.as_str(),
        manifest.implementation_contract_field.as_str(),
        manifest.implementation_kind_field.as_str(),
        manifest.implementation_entrypoints_field.as_str(),
    ];
    input_fields.extend(manifest.contract_fields.iter().map(String::as_str));
    if let Some(source) = &manifest.source {
        input_fields.push(source.field.as_str());
        if let Some(vendor) = &source.vendor {
            input_fields.extend(vendor.path_fields.iter().map(String::as_str));
            input_fields.extend(vendor.blocked_reason_fields.iter().map(String::as_str));
        }
    }
    for input in input_fields {
        if dotted_paths_alias(input, &manifest.output_field) {
            return profile_error(format!(
                "{owner} input field {input} aliases compiler output {}",
                manifest.output_field
            ));
        }
        if node
            .compiler_owned_fields
            .iter()
            .any(|owned| dotted_paths_alias(input, owned))
        {
            return profile_error(format!(
                "{owner} input field {input} must not be compiler-owned"
            ));
        }
    }
    let output_root = manifest
        .output_field
        .trim_start_matches("$.")
        .split('.')
        .next()
        .unwrap_or_default();
    if matches!(
        output_root,
        "schema_version" | "id" | "type" | "title" | "status" | "edges" | "annotations"
    ) {
        return profile_error(format!(
            "{owner} output_field {} conflicts with a core node field",
            manifest.output_field
        ));
    }
    if manifest.output_field.starts_with("spec.") {
        let output = filesystem_manifest_node_field(node, &manifest.output_field, &owner)?;
        if output.value_type != FieldType::Object {
            return profile_error(format!(
                "{owner} output_field {} must be an object",
                manifest.output_field
            ));
        }
    }
    validate_optional_unique_manifest_values(
        &manifest.scan.ignored_file_names,
        &format!("{owner} scan.ignored_file_names"),
    )?;
    validate_optional_unique_manifest_values(
        &manifest.scan.ignored_path_components,
        &format!("{owner} scan.ignored_path_components"),
    )?;
    validate_optional_unique_manifest_values(
        &manifest.scan.ignored_suffixes,
        &format!("{owner} scan.ignored_suffixes"),
    )?;
    validate_optional_unique_manifest_values(
        &manifest.scan.ignored_path_prefixes,
        &format!("{owner} scan.ignored_path_prefixes"),
    )?;
    validate_optional_unique_manifest_values(
        &manifest.allowed_root_prefixes,
        &format!("{owner} allowed_root_prefixes"),
    )?;
    for prefix in &manifest.allowed_root_prefixes {
        validate_project_relative_scope_path(Path::new(prefix)).map_err(|error| {
            KoniError::Profile(format!("{owner} allowed_root_prefixes {prefix:?}: {error}"))
        })?;
    }
    for value in manifest
        .scan
        .ignored_file_names
        .iter()
        .chain(&manifest.scan.ignored_path_components)
    {
        if Path::new(value).components().count() != 1 {
            return profile_error(format!(
                "{owner} ignored file names and path components must be single names: {value:?}"
            ));
        }
    }
    for prefix in &manifest.scan.ignored_path_prefixes {
        validate_project_relative_scope_path(Path::new(prefix)).map_err(|error| {
            KoniError::Profile(format!(
                "{owner} scan.ignored_path_prefixes {prefix:?}: {error}"
            ))
        })?;
    }
    if let Some(source) = &manifest.source {
        let source_field = filesystem_manifest_node_field(node, &source.field, &owner)?;
        if source_field.value_type != FieldType::String {
            return profile_error(format!(
                "{owner} source.field {} must be a string",
                source.field
            ));
        }
        validate_nonempty_unique_values(
            &source.external_values,
            &format!("{owner} source.external_values"),
        )?;
        if source.unspecified_value.trim().is_empty()
            || source.unspecified_value.trim() != source.unspecified_value
        {
            return profile_error(format!(
                "{owner} source.unspecified_value must be nonempty and trimmed"
            ));
        }
        if let Some(vendor) = &source.vendor {
            validate_optional_unique_manifest_values(
                &vendor.path_fields,
                &format!("{owner} source.vendor.path_fields"),
            )?;
            validate_optional_unique_manifest_values(
                &vendor.blocked_reason_fields,
                &format!("{owner} source.vendor.blocked_reason_fields"),
            )?;
            for path in &vendor.path_fields {
                let field = filesystem_manifest_node_field(node, path, &owner)?;
                let valid = matches!(field.value_type, FieldType::String | FieldType::Path)
                    || (field.value_type == FieldType::List
                        && field.items.as_deref().is_some_and(|item| {
                            matches!(item.value_type, FieldType::String | FieldType::Path)
                        }));
                if !valid {
                    return profile_error(format!(
                        "{owner} vendor path field {path} must be string, path, or a list of them"
                    ));
                }
            }
            for path in &vendor.blocked_reason_fields {
                if filesystem_manifest_node_field(node, path, &owner)?.value_type
                    != FieldType::String
                {
                    return profile_error(format!(
                        "{owner} vendor blocked reason field {path} must be a string"
                    ));
                }
            }
        }
    }
    Ok(())
}

fn dotted_paths_alias(left: &str, right: &str) -> bool {
    let left = left.trim_start_matches("$.");
    let right = right.trim_start_matches("$.");
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|suffix| suffix.starts_with('.'))
        || right
            .strip_prefix(left)
            .is_some_and(|suffix| suffix.starts_with('.'))
}

fn filesystem_manifest_node_field<'a>(
    node: &'a NodeTypeDef,
    path: &str,
    owner: &str,
) -> Result<&'a FieldDef> {
    node_field_definition(node, path)
        .ok_or_else(|| KoniError::Profile(format!("{owner} field {path} is not declared")))
}

fn validate_optional_unique_manifest_values(values: &[String], label: &str) -> Result<()> {
    if values
        .iter()
        .any(|value| value.trim().is_empty() || value.trim() != value)
    {
        return profile_error(format!("{label} must contain only nonempty trimmed values"));
    }
    if values.iter().collect::<BTreeSet<_>>().len() != values.len() {
        return profile_error(format!("{label} must not contain duplicates"));
    }
    Ok(())
}

fn validate_field_definition(node_type: &str, path: &str, field: &FieldDef) -> Result<()> {
    if field.items.is_some() && field.value_type != FieldType::List {
        return profile_error(format!(
            "node type {node_type} field {path} configures items but is not a list"
        ));
    }
    if (!field.properties.is_empty() || field.additional_properties.is_some())
        && field.value_type != FieldType::Object
    {
        return profile_error(format!(
            "node type {node_type} field {path} configures object properties but is not an object"
        ));
    }
    if let Some(pattern) = &field.pattern {
        if !matches!(
            field.value_type,
            FieldType::String | FieldType::Path | FieldType::NodeRef
        ) {
            return profile_error(format!(
                "node type {node_type} field {path} configures a string pattern for non-string type {:?}",
                field.value_type
            ));
        }
        regex::Regex::new(pattern).map_err(|error| {
            KoniError::Profile(format!(
                "node type {node_type} field {path} has invalid regex pattern {pattern:?}: {error}"
            ))
        })?;
    }
    if let Some(items) = &field.items {
        validate_field_definition(node_type, &format!("{path}[]"), items)?;
    }
    for (name, property) in &field.properties {
        if name.trim().is_empty()
            || name.trim() != name
            || name.chars().any(|character| {
                matches!(character, '.' | '[' | ']' | '/' | '\\') || character.is_whitespace()
            })
        {
            return profile_error(format!(
                "node type {node_type} field {path} has invalid property name {name:?}"
            ));
        }
        validate_field_definition(node_type, &format!("{path}.{name}"), property)?;
    }
    Ok(())
}

fn normalized_root_spec_field(path: &str) -> Option<&str> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed != path {
        return None;
    }
    let field = trimmed.strip_prefix("spec.").unwrap_or(trimmed);
    if field.is_empty()
        || field.contains('.')
        || field
            .chars()
            .any(|character| character.is_whitespace() || character == '/' || character == '\\')
    {
        return None;
    }
    Some(field)
}

fn normalized_spec_path_for_comparison(path: &str) -> &str {
    let trimmed = path.trim();
    trimmed.strip_prefix("spec.").unwrap_or(trimmed)
}

fn validate_edges(profile: &CompiledProfile) -> Result<()> {
    let mut seen = BTreeSet::new();
    for edge in &profile.edge_types {
        if !profile.node_types.contains_key(&edge.source) {
            return profile_error(format!(
                "edge {}.{} has unknown source type",
                edge.source, edge.relation
            ));
        }
        if edge.relation.trim().is_empty() || edge.targets.is_empty() {
            return profile_error(format!(
                "edge {}.{} must have a relation and targets",
                edge.source, edge.relation
            ));
        }
        for target in &edge.targets {
            if !profile.node_types.contains_key(target) {
                return profile_error(format!(
                    "edge {}.{} references unknown target type {}",
                    edge.source, edge.relation, target
                ));
            }
        }
        if edge.max.is_some_and(|max| max < edge.min) {
            return profile_error(format!(
                "edge {}.{} has max below min",
                edge.source, edge.relation
            ));
        }
        if !seen.insert((edge.source.clone(), edge.relation.clone())) {
            return profile_error(format!(
                "duplicate edge declaration {}.{}",
                edge.source, edge.relation
            ));
        }
        if let Some(predicate) = &edge.when {
            let symbols = profile
                .expression_symbols()
                .with_variable("source", ValueType::Node)
                .with_variable("target", ValueType::Node);
            predicate.validate(&symbols).map_err(|error| {
                profile_expr_error("edge", &format!("{}.{}", edge.source, edge.relation), error)
            })?;
        }
    }
    for edge in profile
        .edge_types
        .iter()
        .filter(|edge| edge.inverse.is_some())
    {
        let inverse = edge.inverse.as_deref().expect("filtered inverse exists");
        for target_type in &edge.targets {
            let reciprocal = profile.edge_types.iter().find(|candidate| {
                candidate.source == *target_type && candidate.relation == inverse
            });
            let Some(reciprocal) = reciprocal else {
                return profile_error(format!(
                    "edge {}.{} declares inverse {inverse}, but target type {target_type} does not own it",
                    edge.source, edge.relation
                ));
            };
            if !reciprocal.targets.contains(&edge.source) {
                return profile_error(format!(
                    "edge {}.{} inverse {}.{inverse} cannot target its source type",
                    edge.source, edge.relation, target_type
                ));
            }
        }
    }
    Ok(())
}

fn validate_gate_policies(profile: &CompiledProfile) -> Result<()> {
    for policy in profile.gate_policies.values() {
        if policy.description.trim().is_empty() {
            return profile_error(format!(
                "gate policy {} description must not be empty",
                policy.id
            ));
        }
        if policy.gate_node_types.is_empty() || policy.candidate_node_types.is_empty() {
            return profile_error(format!(
                "gate policy {} requires nonempty gate_node_types and candidate_node_types",
                policy.id
            ));
        }
        validate_known_node_types(
            profile,
            &policy.gate_node_types,
            &format!("gate policy {} gate_node_types", policy.id),
        )?;
        if policy
            .applicability
            .required_subject_node_types
            .iter()
            .any(|node_type| !policy.applicability.subject_node_types.contains(node_type))
        {
            return profile_error(format!(
                "gate policy {} applicability required_subject_node_types must be a subset of subject_node_types",
                policy.id
            ));
        }
        if policy
            .applicability
            .required_subject_node_types
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != policy.applicability.required_subject_node_types.len()
        {
            return profile_error(format!(
                "gate policy {} applicability required_subject_node_types must be unique",
                policy.id
            ));
        }
        validate_known_node_types(
            profile,
            &policy.candidate_node_types,
            &format!("gate policy {} candidate_node_types", policy.id),
        )?;
        let gate_symbols = profile
            .expression_symbols()
            .with_variable("gate", ValueType::Node);
        policy
            .gate_subjects
            .validate(&profile.expression_symbols())
            .map_err(|error| {
                profile_expr_error("gate policy", &policy.id, format!("gate_subjects: {error}"))
            })?;
        for (label, selector) in [
            ("candidate_pool", &policy.candidate_pool),
            ("evaluation_targets", &policy.evaluation_targets.select),
        ] {
            selector.validate(&gate_symbols).map_err(|error| {
                profile_expr_error("gate policy", &policy.id, format!("{label}: {error}"))
            })?;
        }
        if let Some(context) = &policy.context {
            let context_symbols = gate_symbols
                .clone()
                .with_variable("winner", ValueType::Node)
                .with_variable("candidate", ValueType::Node)
                .with_variable("target", ValueType::NodeSet)
                .with_variable("evaluation_targets", ValueType::NodeSet)
                .with_variable("ancestors", ValueType::NodeSet)
                .with_variable("direct_gates", ValueType::NodeSet)
                .with_variable("inherited_gates", ValueType::NodeSet)
                .with_variable("applicable_gates", ValueType::NodeSet);
            context.select.validate(&context_symbols).map_err(|error| {
                profile_expr_error("gate policy", &policy.id, format!("context: {error}"))
            })?;
            let context_path_symbols = context_symbols
                .clone()
                .with_variable("context", ValueType::NodeSet);
            for path in &context.read_paths {
                match path {
                    PathScopeDef::Literal(path) => {
                        validate_project_relative_scope_path(path)?;
                    }
                    PathScopeDef::Projection(projection) => {
                        projection
                            .select
                            .validate(&context_path_symbols)
                            .map_err(|error| {
                                profile_expr_error(
                                    "gate policy",
                                    &policy.id,
                                    format!("context read path: {error}"),
                                )
                            })?;
                        validate_gate_field_path(
                            &policy.id,
                            "context read path field",
                            &projection.field,
                        )?;
                    }
                }
            }
        }
        if let Some(predicate) = &policy.execution_ready {
            let execution_symbols = gate_symbols
                .clone()
                .with_variable("winner", ValueType::Node)
                .with_variable("candidate", ValueType::Node)
                .with_variable("target", ValueType::NodeSet)
                .with_variable("evaluation_targets", ValueType::NodeSet)
                .with_variable("ancestors", ValueType::NodeSet)
                .with_variable("direct_gates", ValueType::NodeSet)
                .with_variable("inherited_gates", ValueType::NodeSet)
                .with_variable("applicable_gates", ValueType::NodeSet)
                .with_variable("context", ValueType::NodeSet);
            predicate.validate(&execution_symbols).map_err(|error| {
                profile_expr_error(
                    "gate policy",
                    &policy.id,
                    format!("execution_ready: {error}"),
                )
            })?;
            validate_gate_execution_ready_predicate(&policy.id, predicate)?;
        }
        if policy.applicability.subject_node_types.is_empty() {
            return profile_error(format!(
                "gate policy {} applicability subject_node_types must be nonempty",
                policy.id
            ));
        }
        validate_known_node_types(
            profile,
            &policy.applicability.subject_node_types,
            &format!("gate policy {} applicability subjects", policy.id),
        )?;
        if policy.applicability.context_class_order.is_empty()
            || policy
                .applicability
                .context_class_order
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != policy.applicability.context_class_order.len()
            || policy
                .applicability
                .context_class_order
                .iter()
                .any(|class| class.trim().is_empty())
        {
            return profile_error(format!(
                "gate policy {} applicability context_class_order must be nonempty, unique, and contain nonempty names",
                policy.id
            ));
        }
        if policy
            .applicability
            .context_classes
            .keys()
            .collect::<BTreeSet<_>>()
            != policy
                .applicability
                .context_class_order
                .iter()
                .collect::<BTreeSet<_>>()
        {
            return profile_error(format!(
                "gate policy {} applicability context_classes must exactly match context_class_order",
                policy.id
            ));
        }
        let applicability_symbols = profile
            .expression_symbols()
            .with_variable("subject", ValueType::Node)
            .with_variable("ancestors", ValueType::NodeSet);
        for (label, selector) in [
            ("direct_gates", &policy.applicability.direct_gates),
            ("inherited_gates", &policy.applicability.inherited_gates),
            ("context", &policy.applicability.context),
        ] {
            selector.validate(&applicability_symbols).map_err(|error| {
                profile_expr_error(
                    "gate policy",
                    &policy.id,
                    format!("applicability {label}: {error}"),
                )
            })?;
        }
        let mut classified_types = BTreeMap::<String, String>::new();
        for (class, selector) in &policy.applicability.context_classes {
            validate_identifier("gate applicability context class", class)?;
            selector
                .validate(&profile.expression_symbols())
                .map_err(|error| {
                    profile_expr_error(
                        "gate policy",
                        &policy.id,
                        format!("applicability context class {class}: {error}"),
                    )
                })?;
            let Selector::Nodes(envelope) = selector else {
                return profile_error(format!(
                    "gate policy {} applicability context class {} must be a static nodes selector",
                    policy.id, class
                ));
            };
            if envelope.nodes.node_types.is_empty()
                || !envelope.nodes.statuses.is_empty()
                || !envelope.nodes.status_excluding.is_empty()
                || envelope.nodes.where_.is_some()
            {
                return profile_error(format!(
                    "gate policy {} applicability context class {} must classify only by nonempty node_types",
                    policy.id, class
                ));
            }
            for node_type in &envelope.nodes.node_types {
                if let Some(previous) = classified_types.insert(node_type.clone(), class.clone()) {
                    return profile_error(format!(
                        "gate policy {} applicability node type {} belongs to both {} and {}",
                        policy.id, node_type, previous, class
                    ));
                }
            }
        }
        for subject_type in &policy.applicability.subject_node_types {
            if !classified_types.contains_key(subject_type) {
                return profile_error(format!(
                    "gate policy {} applicability subject type {} has no context class",
                    policy.id, subject_type
                ));
            }
        }
        if let Some(auto) = &policy.auto_evaluate {
            let check = profile.checks.get(&auto.check).ok_or_else(|| {
                KoniError::Profile(format!(
                    "gate policy {} auto_evaluate references unknown check {}",
                    policy.id, auto.check
                ))
            })?;
            validate_gate_auto_evaluate_check(policy, check)?;
            if auto.boundaries.is_empty()
                || auto.boundaries.iter().collect::<BTreeSet<_>>().len() != auto.boundaries.len()
            {
                return profile_error(format!(
                    "gate policy {} auto_evaluate boundaries must be nonempty and unique",
                    policy.id
                ));
            }
        }
        for (label, paths) in [
            (
                "required_name_fields",
                &policy.capability.required_name_fields,
            ),
            (
                "required_version_req_fields",
                &policy.capability.required_version_req_fields,
            ),
            (
                "provider_collection_fields",
                &policy.capability.provider_collection_fields,
            ),
            (
                "provider_name_fields",
                &policy.capability.provider_name_fields,
            ),
            (
                "provider_version_fields",
                &policy.capability.provider_version_fields,
            ),
        ] {
            if paths.is_empty() {
                return profile_error(format!(
                    "gate policy {} capability {label} must be nonempty",
                    policy.id
                ));
            }
            if paths.iter().collect::<BTreeSet<_>>().len() != paths.len() {
                return profile_error(format!(
                    "gate policy {} capability {label} must not contain duplicates",
                    policy.id
                ));
            }
            for path in paths {
                validate_gate_field_path(&policy.id, label, path)?;
            }
        }
        if policy.capability.provider_name_fields.is_empty()
            || policy.capability.provider_version_fields.is_empty()
        {
            return profile_error(format!(
                "gate policy {} capability provider field aliases must be nonempty",
                policy.id
            ));
        }
        match policy.selection.mode {
            GateSelectionMode::RankedFirst
                if policy.selection.ranks.is_empty() || policy.selection.tie_break.is_none() =>
            {
                return profile_error(format!(
                    "gate policy {} ranked_first selection requires ranks and an explicit tie_break",
                    policy.id
                ));
            }
            GateSelectionMode::ExactlyOne
                if !policy.selection.ranks.is_empty() || policy.selection.tie_break.is_some() =>
            {
                return profile_error(format!(
                    "gate policy {} exactly_one selection must not declare ranks or a tie_break",
                    policy.id
                ));
            }
            _ => {}
        }
        if let Some(tie_break) = &policy.selection.tie_break {
            validate_gate_field_path(&policy.id, "selection tie_break field", &tie_break.field)?;
        }
        let mut rank_ids = BTreeSet::new();
        for rank in &policy.selection.ranks {
            validate_identifier("gate rank", &rank.id)?;
            if !rank_ids.insert(&rank.id) {
                return profile_error(format!(
                    "gate policy {} has duplicate rank {}",
                    policy.id, rank.id
                ));
            }
            let fields_required = matches!(
                rank.kind,
                GateRankKind::MapHasGateKey
                    | GateRankKind::MergedMapValueEquals
                    | GateRankKind::FieldEqualsGateId
                    | GateRankKind::MergedMapHasGateKey
            );
            let relations_required = rank.kind == GateRankKind::EdgeContainsGate;
            if fields_required != !rank.fields.is_empty() {
                return profile_error(format!(
                    "gate policy {} rank {} has invalid fields for {:?}",
                    policy.id, rank.id, rank.kind
                ));
            }
            if relations_required != !rank.relations.is_empty() {
                return profile_error(format!(
                    "gate policy {} rank {} has invalid relations for {:?}",
                    policy.id, rank.id, rank.kind
                ));
            }
            for field in &rank.fields {
                validate_gate_rank_path(&policy.id, &rank.id, field)?;
            }
            for relation in &rank.relations {
                let compatible_relation = profile.edge_types.iter().any(|edge| {
                    edge.relation == *relation
                        && policy.candidate_node_types.contains(&edge.source)
                        && edge
                            .targets
                            .iter()
                            .any(|target| policy.gate_node_types.contains(target))
                });
                if !compatible_relation {
                    return profile_error(format!(
                        "gate policy {} rank {} relation {} is not an edge from a candidate node type to a gate node type",
                        policy.id, rank.id, relation
                    ));
                }
            }
            if (rank.kind == GateRankKind::MergedMapValueEquals) != rank.value.is_some() {
                return profile_error(format!(
                    "gate policy {} rank {} value is required only for merged_map_value_equals",
                    policy.id, rank.id
                ));
            }
        }
        if policy.selection.mode == GateSelectionMode::RankedFirst
            && policy
                .selection
                .ranks
                .last()
                .is_none_or(|rank| rank.kind != GateRankKind::Compatible)
        {
            return profile_error(format!(
                "gate policy {} ranked_first selection must end with compatible fallback",
                policy.id
            ));
        }
        if policy.passing_receipt_statuses.is_empty()
            || policy
                .passing_receipt_statuses
                .iter()
                .any(|status| status.trim().is_empty() || status != status.trim())
            || policy
                .passing_receipt_statuses
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != policy.passing_receipt_statuses.len()
        {
            return profile_error(format!(
                "gate policy {} passing_receipt_statuses must be nonempty, unique, trimmed strings",
                policy.id
            ));
        }
        if !policy.obligation_key_template.contains("{{ gate.id }}") {
            return profile_error(format!(
                "gate policy {} obligation_key_template must contain {{{{ gate.id }}}}",
                policy.id
            ));
        }
        if !policy
            .missing_gate_obligation_key_template
            .contains("{{ subject.id }}")
        {
            return profile_error(format!(
                "gate policy {} missing_gate_obligation_key_template must contain {{{{ subject.id }}}}",
                policy.id
            ));
        }
    }
    let required_by_policies = profile
        .gate_policies
        .values()
        .flat_map(|policy| {
            policy
                .applicability
                .required_subject_node_types
                .iter()
                .cloned()
        })
        .collect::<BTreeSet<_>>();
    for node_type in profile.node_types.values() {
        if node_type.gate_required && !required_by_policies.contains(&node_type.id) {
            return profile_error(format!(
                "node type {} declares gate_required but is not required by any gate policy",
                node_type.id
            ));
        }
        if required_by_policies.contains(&node_type.id) && !node_type.gate_required {
            return profile_error(format!(
                "node type {} is required by a gate policy but does not declare gate_required",
                node_type.id
            ));
        }
    }
    validate_gate_policy_dependency_cycles(profile)
}

fn validate_gate_execution_ready_predicate(policy_id: &str, predicate: &Predicate) -> Result<()> {
    match predicate {
        Predicate::Constant(_) => Ok(()),
        Predicate::All(envelope) => envelope.all.iter().try_for_each(|predicate| {
            validate_gate_execution_ready_predicate(policy_id, predicate)
        }),
        Predicate::Any(envelope) => envelope.any.iter().try_for_each(|predicate| {
            validate_gate_execution_ready_predicate(policy_id, predicate)
        }),
        Predicate::Not(envelope) => {
            validate_gate_execution_ready_predicate(policy_id, &envelope.not)
        }
        Predicate::Leaf(leaf) => validate_gate_execution_ready_leaf(policy_id, leaf),
        Predicate::ForAll(_) | Predicate::Exists(_) => profile_error(format!(
            "gate policy {policy_id} execution_ready may use only constants, all/any/not, field_equals, field_present, and filesystem_manifest_current"
        )),
    }
}

fn validate_gate_execution_ready_leaf(policy_id: &str, leaf: &LeafPredicate) -> Result<()> {
    if leaf.subject.as_deref() != Some("$winner") {
        return profile_error(format!(
            "gate policy {policy_id} execution_ready leaves must bind subject exactly to $winner"
        ));
    }
    if !matches!(
        leaf.op,
        PredicateOp::FieldEquals
            | PredicateOp::FieldPresent
            | PredicateOp::FilesystemManifestCurrent
    ) {
        return profile_error(format!(
            "gate policy {policy_id} execution_ready uses unsupported predicate {:?}",
            leaf.op
        ));
    }
    let allowed_args = if leaf.op == PredicateOp::FieldEquals {
        BTreeSet::from(["equals"])
    } else {
        BTreeSet::new()
    };
    let has_extraneous_input = leaf.relation.is_some()
        || leaf.query.is_some()
        || !leaf.values.is_empty()
        || leaf.exact.is_some()
        || leaf.min.is_some()
        || leaf.max.is_some()
        || !leaf.node_types.is_empty()
        || !leaf.statuses.is_empty()
        || leaf.receipt_type.is_some()
        || leaf.receipt_coverage.is_some()
        || leaf.review_operation.is_some()
        || leaf.review_effect.is_some()
        || leaf.coverage_targets.is_some()
        || leaf.check.is_some()
        || leaf.gate_policy.is_some()
        || leaf.gate_subject.is_some()
        || leaf.numerator.is_some()
        || leaf.denominator.is_some()
        || leaf.left.is_some()
        || leaf.right.is_some()
        || leaf.relation_kind.is_some()
        || leaf
            .args
            .keys()
            .any(|key| !allowed_args.contains(key.as_str()));
    let expected_shape = match leaf.op {
        PredicateOp::FieldEquals => {
            leaf.field.is_some() && (leaf.value.is_some() ^ leaf.args.contains_key("equals"))
        }
        PredicateOp::FieldPresent => {
            leaf.field.is_some() && leaf.value.is_none() && leaf.args.is_empty()
        }
        PredicateOp::FilesystemManifestCurrent => {
            leaf.field.is_none() && leaf.value.is_none() && leaf.args.is_empty()
        }
        _ => unreachable!(),
    };
    let cyclic_field = leaf.field.as_deref().is_some_and(|field| {
        let field = field.trim_start_matches("$.");
        ["readiness", "obligations", "gate_state", "compiler"]
            .iter()
            .any(|owned| field == *owned || field.starts_with(&format!("{owned}.")))
    });
    if has_extraneous_input || !expected_shape || cyclic_field {
        return profile_error(format!(
            "gate policy {policy_id} execution_ready {:?} has fields outside its closed proof contract",
            leaf.op
        ));
    }
    Ok(())
}

fn validate_gate_auto_evaluate_check(policy: &GatePolicyDef, check: &CheckDef) -> Result<()> {
    if policy.execution_ready.is_none() {
        return profile_error(format!(
            "gate policy {} automatic evaluation requires execution_ready",
            policy.id
        ));
    }
    if check.kind != CheckKind::Command
        || check.effect != ProcessEffect::ReadOnly
        || !check.allow_nonpassing_receipt
    {
        return profile_error(format!(
            "gate policy {} automatic check {} must be a read_only command with allow_nonpassing_receipt",
            policy.id, check.id
        ));
    }

    let Some(source) = check.command_source.as_ref() else {
        return profile_error(format!(
            "gate policy {} automatic check {} must use a node command_source with gate_policy {} and may not use argv or argv_from",
            policy.id, check.id, policy.id
        ));
    };
    if !check.argv.is_empty()
        || check.argv_from.is_some()
        || source.kind != DynamicSourceKind::Node
        || source.gate_policy.as_deref() != Some(policy.id.as_str())
    {
        return profile_error(format!(
            "gate policy {} automatic check {} must use a node command_source with gate_policy {} and may not use argv or argv_from",
            policy.id, check.id, policy.id
        ));
    }
    if source.role == "ticket"
        || dynamic_field_uses_ticket_variable(&source.field)
        || check
            .environment
            .set
            .values()
            .any(|value| value.contains("${ticket") || value.contains("$ticket"))
        || check.cwd.to_string_lossy().contains("${ticket")
    {
        return profile_error(format!(
            "gate policy {} automatic check {} must not depend on the ticket role or $ticket command variables",
            policy.id, check.id
        ));
    }

    if check.argv_input_bindings.is_some() {
        return profile_error(format!(
            "gate policy {} automatic check {} must not configure argv_input_bindings",
            policy.id, check.id
        ));
    }
    if !check.artifact_paths.is_empty() {
        return profile_error(format!(
            "gate policy {} automatic check {} must not configure artifact_paths",
            policy.id, check.id
        ));
    }

    if let Some(dynamic) = &check.dynamic_result {
        let uses_ticket_role = dynamic.required_keys.as_ref().is_some_and(|required| {
            required.source.role != source.role
                || dynamic_field_uses_ticket_variable(&required.source.field)
        }) || dynamic.result_path.as_ref().is_some_and(|result| {
            result.source.role != source.role
                || dynamic_field_uses_ticket_variable(&result.source.field)
        });
        if uses_ticket_role {
            return profile_error(format!(
                "gate policy {} automatic check {} dynamic sources must use selected winner role {} and no $ticket variables",
                policy.id, check.id, source.role
            ));
        }

        let uses_produced_output = dynamic
            .result_path
            .as_ref()
            .into_iter()
            .flat_map(|result| &result.path_authorities)
            .chain(
                dynamic
                    .artifacts
                    .as_ref()
                    .into_iter()
                    .flat_map(|artifacts| &artifacts.path_authorities),
            )
            .any(|authority| authority.provenance == DynamicPathProvenance::ProducedOutput);
        if uses_produced_output {
            return profile_error(format!(
                "gate policy {} automatic check {} must not use produced_output path authorities",
                policy.id, check.id
            ));
        }
        if dynamic.result_path.is_some() || dynamic.artifacts.is_some() {
            return profile_error(format!(
                "gate policy {} automatic check {} must not configure dynamic result_path or artifacts",
                policy.id, check.id
            ));
        }
    }
    Ok(())
}

fn dynamic_field_uses_ticket_variable(field: &str) -> bool {
    if field.contains("$ticket") {
        return true;
    }
    let mut remaining = field;
    while let Some(open) = remaining.find('[') {
        remaining = &remaining[open + 1..];
        let Some(close) = remaining.find(']') else {
            return false;
        };
        let raw = remaining[..close].trim();
        if raw
            .strip_prefix('$')
            .is_some_and(|variable| variable == "ticket" || variable.starts_with("ticket."))
        {
            return true;
        }
        remaining = &remaining[close + 1..];
    }
    false
}

fn validate_gate_field_path(policy: &str, label: &str, path: &str) -> Result<()> {
    if path.trim().is_empty()
        || path != path.trim()
        || path.contains(['[', ']', '*'])
        || path.split('.').any(|segment| segment.is_empty())
    {
        return profile_error(format!(
            "gate policy {policy} {label} is not a simple nonempty field path: {path:?}"
        ));
    }
    Ok(())
}

fn validate_gate_rank_path(policy: &str, rank: &str, path: &str) -> Result<()> {
    if path.trim().is_empty()
        || path != path.trim()
        || path.split('.').any(|segment| segment.is_empty())
        || path.contains(['[', ']'])
        || path.matches('*').count() > 1
    {
        return profile_error(format!(
            "gate policy {policy} rank {rank} has invalid field path {path:?}"
        ));
    }
    Ok(())
}

fn validate_queries(profile: &CompiledProfile) -> Result<()> {
    let base_symbols = profile.expression_symbols();
    let relation_names: BTreeSet<_> = profile
        .edge_types
        .iter()
        .map(|edge| edge.relation.as_str())
        .collect();
    for query in profile.queries.values() {
        if !query.params.is_empty() {
            return profile_error(format!(
                "query {} declares params, but query arguments are not implemented; remove params so evaluation fails closed",
                query.id
            ));
        }
        validate_known_node_types(profile, &query.node_types, &format!("query {}", query.id))?;
        let mut symbols = base_symbols.clone();
        symbols.variables.extend(query.params.clone());
        symbols.variables.insert("node".to_owned(), ValueType::Node);
        if let Some(select) = &query.select {
            select
                .validate(&symbols)
                .map_err(|error| profile_expr_error("query", &query.id, error))?;
        }
        if let Some(traverse) = &query.traverse {
            traverse
                .from
                .validate(&symbols)
                .map_err(|error| profile_expr_error("query", &query.id, error))?;
            if traverse.max_depth == 0 {
                return profile_error(format!(
                    "query {} traverse max_depth must be positive",
                    query.id
                ));
            }
            for relation in &traverse.relations {
                if !relation_names.contains(relation.as_str()) {
                    return profile_error(format!(
                        "query {} references unknown relation {}",
                        query.id, relation
                    ));
                }
            }
        }
        if let Some(predicate) = &query.predicate {
            predicate
                .validate(&symbols)
                .map_err(|error| profile_expr_error("query", &query.id, error))?;
        }
    }
    validate_query_cycles(profile)
}

fn validate_query_cycles(profile: &CompiledProfile) -> Result<()> {
    let mut dependencies: HashMap<&str, BTreeSet<String>> = HashMap::new();
    for query in profile.queries.values() {
        let mut refs = BTreeSet::new();
        if let Some(select) = &query.select {
            select.referenced_queries(&mut refs);
        }
        if let Some(traverse) = &query.traverse {
            traverse.from.referenced_queries(&mut refs);
        }
        if let Some(predicate) = &query.predicate {
            predicate.referenced_queries(&mut refs);
        }
        dependencies.insert(&query.id, refs);
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for id in profile.queries.keys() {
        visit_dependency(id, &dependencies, &mut visiting, &mut visited, "query")?;
    }
    Ok(())
}

fn validate_gate_policy_dependency_cycles(profile: &CompiledProfile) -> Result<()> {
    let mut dependencies = HashMap::<String, BTreeSet<String>>::new();
    for query in profile.queries.values() {
        let mut query_refs = BTreeSet::new();
        let mut policy_refs = BTreeSet::new();
        if let Some(select) = &query.select {
            select.referenced_queries(&mut query_refs);
            select.referenced_gate_policies(&mut policy_refs);
        }
        if let Some(traverse) = &query.traverse {
            traverse.from.referenced_queries(&mut query_refs);
            traverse.from.referenced_gate_policies(&mut policy_refs);
        }
        if let Some(predicate) = &query.predicate {
            predicate.referenced_queries(&mut query_refs);
            predicate.referenced_gate_policies(&mut policy_refs);
        }
        dependencies.insert(
            format!("query:{}", query.id),
            query_refs
                .into_iter()
                .map(|id| format!("query:{id}"))
                .chain(
                    policy_refs
                        .into_iter()
                        .map(|id| format!("gate-policy:{id}")),
                )
                .collect(),
        );
    }
    for policy in profile.gate_policies.values() {
        let mut query_refs = BTreeSet::new();
        let mut policy_refs = BTreeSet::new();
        let mut collect = |selector: &Selector| {
            selector.referenced_queries(&mut query_refs);
            selector.referenced_gate_policies(&mut policy_refs);
        };
        collect(&policy.gate_subjects);
        collect(&policy.candidate_pool);
        collect(&policy.evaluation_targets.select);
        collect(&policy.applicability.direct_gates);
        collect(&policy.applicability.inherited_gates);
        collect(&policy.applicability.context);
        for selector in policy.applicability.context_classes.values() {
            collect(selector);
        }
        if let Some(context) = &policy.context {
            collect(&context.select);
            for path in &context.read_paths {
                if let PathScopeDef::Projection(projection) = path {
                    collect(&projection.select);
                }
            }
        }
        if let Some(execution_ready) = &policy.execution_ready {
            execution_ready.referenced_queries(&mut query_refs);
            execution_ready.referenced_gate_policies(&mut policy_refs);
        }
        dependencies.insert(
            format!("gate-policy:{}", policy.id),
            query_refs
                .into_iter()
                .map(|id| format!("query:{id}"))
                .chain(
                    policy_refs
                        .into_iter()
                        .map(|id| format!("gate-policy:{id}")),
                )
                .collect(),
        );
    }
    fn visit(
        id: &str,
        dependencies: &HashMap<String, BTreeSet<String>>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> Result<()> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.to_owned()) {
            return profile_error(format!("query/gate-policy dependency cycle includes {id}"));
        }
        if let Some(next) = dependencies.get(id) {
            for dependency in next {
                if dependencies.contains_key(dependency) {
                    visit(dependency, dependencies, visiting, visited)?;
                }
            }
        }
        visiting.remove(id);
        visited.insert(id.to_owned());
        Ok(())
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for id in dependencies.keys() {
        visit(id, &dependencies, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn visit_dependency<'a>(
    id: &'a str,
    dependencies: &HashMap<&'a str, BTreeSet<String>>,
    visiting: &mut HashSet<String>,
    visited: &mut HashSet<String>,
    label: &str,
) -> Result<()> {
    if visited.contains(id) {
        return Ok(());
    }
    if !visiting.insert(id.to_owned()) {
        return profile_error(format!("{label} dependency cycle includes {id}"));
    }
    if let Some(next) = dependencies.get(id) {
        for dependency in next {
            if dependencies.contains_key(dependency.as_str()) {
                visit_dependency(dependency, dependencies, visiting, visited, label)?;
            }
        }
    }
    visiting.remove(id);
    visited.insert(id.to_owned());
    Ok(())
}

fn validate_rules(profile: &CompiledProfile) -> Result<()> {
    let base_symbols = profile.expression_symbols();
    for rule in profile.rules.values() {
        let symbols = base_symbols
            .clone()
            .with_variable(rule.bind.clone(), ValueType::Node)
            .with_variable("target", ValueType::Node);
        rule.for_each
            .validate(&symbols)
            .map_err(|error| profile_expr_error("rule", &rule.id, error))?;
        rule.when
            .validate(&symbols)
            .map_err(|error| profile_expr_error("rule", &rule.id, error))?;
        let mut referenced_checks = BTreeSet::new();
        rule.when.referenced_checks(&mut referenced_checks);
        for check in referenced_checks {
            let definition = profile.checks.get(&check).ok_or_else(|| {
                KoniError::Profile(format!("rule {} references unknown check {check}", rule.id))
            })?;
            if definition.kind == CheckKind::Graph && definition.predicate.is_none() {
                return profile_error(format!(
                    "rule {} references graph check {check} without a predicate",
                    rule.id
                ));
            }
        }
        if rule.derive.is_empty() && rule.emit.is_none() {
            return profile_error(format!(
                "rule {} neither derives state nor emits a ticket",
                rule.id
            ));
        }
        for derive in &rule.derive {
            match derive.kind {
                DerivationKind::Obligation if derive.key.as_deref().is_none_or(str::is_empty) => {
                    return profile_error(format!(
                        "rule {} obligation derivation requires key",
                        rule.id
                    ));
                }
                DerivationKind::Projection if derive.field.as_deref().is_none_or(str::is_empty) => {
                    return profile_error(format!(
                        "rule {} projection derivation requires field",
                        rule.id
                    ));
                }
                _ => {}
            }
        }
        if let Some(emit) = &rule.emit {
            if emit.operation.trim().is_empty()
                || emit.source_state.trim().is_empty()
                || emit.target_state.trim().is_empty()
            {
                return profile_error(format!(
                    "rule {} ticket emission requires operation, source_state, and target_state",
                    rule.id
                ));
            }
            for selector in [&emit.target_nodes, &emit.read_scope, &emit.write_scope] {
                selector
                    .validate(&symbols)
                    .map_err(|error| profile_expr_error("rule", &rule.id, error))?;
            }
            validate_path_scopes(&rule.id, "read_paths", &emit.read_paths, &symbols)?;
            validate_path_scopes(&rule.id, "write_paths", &emit.write_paths, &symbols)?;
        }
    }
    Ok(())
}

fn validate_path_scopes(
    rule_id: &str,
    scope_name: &str,
    scopes: &[PathScopeDef],
    symbols: &ExpressionSymbols,
) -> Result<()> {
    for (index, scope) in scopes.iter().enumerate() {
        let owner = format!("rule {rule_id} {scope_name}[{index}]");
        match scope {
            PathScopeDef::Literal(path) => validate_project_relative_scope_path(path)
                .map_err(|error| KoniError::Profile(format!("{owner}: {error}")))?,
            PathScopeDef::Projection(projection) => {
                validate_nonempty_path_selector(&projection.select)
                    .map_err(|error| KoniError::Profile(format!("{owner} selector: {error}")))?;
                projection
                    .select
                    .validate(symbols)
                    .map_err(|error| profile_expr_error(&owner, "selector", error))?;
                validate_path_projection_field(&projection.field)
                    .map_err(|error| KoniError::Profile(format!("{owner} field: {error}")))?;
            }
        }
    }
    Ok(())
}

fn validate_nonempty_path_selector(selector: &Selector) -> std::result::Result<(), String> {
    match selector {
        Selector::Named(name) if name.trim().is_empty() => {
            Err("named selector must not be empty".to_owned())
        }
        Selector::Variable(envelope) if envelope.variable.trim().is_empty() => {
            Err("selector variable must not be empty".to_owned())
        }
        Selector::Query(envelope) if envelope.query.trim().is_empty() => {
            Err("query selector must not be empty".to_owned())
        }
        Selector::Ids(envelope) if envelope.ids.is_empty() => {
            Err("ids selector must contain at least one id".to_owned())
        }
        Selector::Union(envelope) if envelope.union.is_empty() => {
            Err("union selector must not be empty".to_owned())
        }
        Selector::Intersection(envelope) if envelope.intersection.is_empty() => {
            Err("intersection selector must not be empty".to_owned())
        }
        _ => Ok(()),
    }
}

fn validate_path_projection_field(field: &str) -> std::result::Result<(), String> {
    if field.is_empty() || field.trim() != field {
        return Err(
            "projected field must be nonempty and have no surrounding whitespace".to_owned(),
        );
    }
    let segments: Vec<_> = field.split('.').collect();
    if segments.iter().any(|segment| {
        segment.is_empty()
            || !segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
            })
    }) {
        return Err(format!(
            "projected field {field:?} must use nonempty dot-separated field names"
        ));
    }
    Ok(())
}

fn validate_operations(profile: &CompiledProfile) -> Result<()> {
    let public_operations: BTreeSet<_> = profile
        .operations
        .values()
        .map(OperationDef::public_operation)
        .collect();
    for operation in profile.operations.values() {
        validate_identifier("public operation", operation.public_operation())?;
        for legacy in [
            "proposal_only",
            "requires_approved_change_hash",
            "disposition_only",
        ] {
            if operation.extensions.contains_key(legacy) {
                return profile_error(format!(
                    "operation {} uses legacy extension {legacy}; configure typed change_control instead",
                    operation.id
                ));
            }
        }
        if operation.stage.trim().is_empty() {
            return profile_error(format!("operation {} has an empty stage", operation.id));
        }
        validate_known_node_types(
            profile,
            &operation.target_types,
            &format!("operation {} target_types", operation.id),
        )?;
        validate_known_node_types(
            profile,
            &operation.allowed_new_node_types,
            &format!("operation {} allowed_new_node_types", operation.id),
        )?;
        validate_known_node_types(
            profile,
            &operation.allowed_existing_node_types,
            &format!("operation {} allowed_existing_node_types", operation.id),
        )?;
        for (node_type, relations) in &operation.existing_node_edge_additions_only {
            if !operation.allowed_existing_node_types.contains(node_type) {
                return profile_error(format!(
                    "operation {} edge-addition-only type {node_type} is not in allowed_existing_node_types",
                    operation.id
                ));
            }
            if relations.is_empty()
                || relations.iter().any(|relation| relation.trim().is_empty())
                || relations.iter().collect::<BTreeSet<_>>().len() != relations.len()
            {
                return profile_error(format!(
                    "operation {} edge-addition-only relations for {node_type} must be nonempty and unique",
                    operation.id
                ));
            }
            for relation in relations {
                if !profile
                    .edge_types
                    .iter()
                    .any(|edge| edge.source == *node_type && edge.relation == *relation)
                {
                    return profile_error(format!(
                        "operation {} edge-addition-only relation {node_type}.{relation} is not declared",
                        operation.id
                    ));
                }
            }
        }
        if let Some(contract) = &operation.receipt_coverage {
            validate_receipt_coverage(profile, operation, contract)?;
        }
        if let Some(workflow) = &operation.workflow
            && !profile.workflows.contains_key(workflow)
        {
            return profile_error(format!(
                "operation {} references unknown workflow {}",
                operation.id, workflow
            ));
        }
        for check in &operation.checks {
            if !profile.checks.contains_key(check) {
                return profile_error(format!(
                    "operation {} references unknown check {}",
                    operation.id, check
                ));
            }
        }
        validate_review_effects(profile, operation)?;
        validate_change_control_operation(profile, operation)?;
    }
    for rule in profile.rules.values() {
        if let Some(emit) = &rule.emit {
            if !public_operations.contains(emit.operation.as_str()) {
                return profile_error(format!(
                    "rule {} emits unknown operation {}",
                    rule.id, emit.operation
                ));
            }
            if let Some(registry) = &emit.registry_entry_id {
                let Some(entry) = profile.operations.get(registry) else {
                    return profile_error(format!(
                        "rule {} pins unknown registry entry {}",
                        rule.id, registry
                    ));
                };
                if entry.public_operation() != emit.operation {
                    return profile_error(format!(
                        "rule {} emits {} but pins registry entry {} for {}",
                        rule.id,
                        emit.operation,
                        registry,
                        entry.public_operation()
                    ));
                }
            }
            if let Some(workflow) = &emit.workflow
                && !profile.workflows.contains_key(workflow)
            {
                return profile_error(format!(
                    "rule {} references unknown workflow {}",
                    rule.id, workflow
                ));
            }
        }
    }
    Ok(())
}

fn validate_change_control_operation(
    profile: &CompiledProfile,
    operation: &OperationDef,
) -> Result<()> {
    match &operation.change_control {
        OperationChangeControlDef::Ordinary {
            allow_upstream_requests,
            proposal_operation,
        } => {
            if !allow_upstream_requests {
                if proposal_operation.is_some() {
                    return profile_error(format!(
                        "ordinary operation {} names a change-control proposal route while upstream requests are disabled",
                        operation.id
                    ));
                }
                return Ok(());
            }
            let route = proposal_operation.as_deref().ok_or_else(|| {
                KoniError::Profile(format!(
                    "ordinary operation {} enables upstream requests without proposal_operation",
                    operation.id
                ))
            })?;
            let matches = profile
                .operations
                .values()
                .filter(|candidate| candidate.public_operation() == route)
                .collect::<Vec<_>>();
            if matches.len() != 1
                || !matches!(
                    &matches[0].change_control,
                    OperationChangeControlDef::Proposal { .. }
                )
            {
                return profile_error(format!(
                    "ordinary operation {} must resolve proposal_operation {route} to exactly one typed proposal operation",
                    operation.id
                ));
            }
            Ok(())
        }
        OperationChangeControlDef::Application => Ok(()),
        OperationChangeControlDef::Proposal {
            proposal_step,
            application_operations,
        } => {
            let workflow_id = operation.workflow.as_deref().ok_or_else(|| {
                KoniError::Profile(format!(
                    "change-control proposal operation {} requires a workflow",
                    operation.id
                ))
            })?;
            let workflow = profile.workflows.get(workflow_id).ok_or_else(|| {
                KoniError::Profile(format!(
                    "change-control proposal operation {} references missing workflow {workflow_id}",
                    operation.id
                ))
            })?;
            let step = workflow
                .steps
                .iter()
                .find(|step| step.id == *proposal_step)
                .ok_or_else(|| {
                    KoniError::Profile(format!(
                        "change-control proposal operation {} references missing proposal step {proposal_step}",
                        operation.id
                    ))
                })?;
            if step.kind == WorkflowStepKind::Review {
                return profile_error(format!(
                    "change-control proposal step {}.{} cannot be a review step",
                    operation.id, proposal_step
                ));
            }
            let review_steps = workflow
                .steps
                .iter()
                .filter(|step| step.kind == WorkflowStepKind::Review)
                .collect::<Vec<_>>();
            if review_steps.len() != 1 {
                return profile_error(format!(
                    "change-control proposal operation {} requires exactly one review step",
                    operation.id
                ));
            }
            let mut dependencies = review_steps[0]
                .depends_on
                .iter()
                .cloned()
                .collect::<BTreeSet<_>>();
            loop {
                let before = dependencies.len();
                for dependency in dependencies.clone() {
                    if let Some(step) = workflow.steps.iter().find(|step| step.id == dependency) {
                        dependencies.extend(step.depends_on.iter().cloned());
                    }
                }
                if dependencies.len() == before {
                    break;
                }
            }
            if !dependencies.contains(proposal_step) {
                return profile_error(format!(
                    "change-control proposal review {}.{} must transitively depend on proposal step {proposal_step}",
                    operation.id, review_steps[0].id
                ));
            }
            validate_nonempty_unique_values(
                application_operations,
                &format!(
                    "operation {} change_control application_operations",
                    operation.id
                ),
            )?;
            for application in application_operations {
                let matches = profile
                    .operations
                    .values()
                    .filter(|candidate| candidate.public_operation() == application)
                    .collect::<Vec<_>>();
                if matches.len() != 1
                    || !matches!(
                        &matches[0].change_control,
                        OperationChangeControlDef::Application
                            | OperationChangeControlDef::Disposition { .. }
                    )
                {
                    return profile_error(format!(
                        "change-control proposal operation {} must resolve {application} to exactly one typed application or disposition operation",
                        operation.id
                    ));
                }
            }
            if !operation.allowed_new_node_types.is_empty()
                || !operation.allowed_existing_node_types.is_empty()
                || operation.allow_node_deletion
                || operation.allow_edge_deletion
                || operation.allow_gate_contract_edits
            {
                return profile_error(format!(
                    "change-control proposal operation {} must have zero direct graph mutation authority",
                    operation.id
                ));
            }
            Ok(())
        }
        OperationChangeControlDef::Disposition { .. } => {
            if !operation.allowed_new_node_types.is_empty()
                || !operation.allowed_existing_node_types.is_empty()
                || operation.allow_node_deletion
                || operation.allow_edge_deletion
                || operation.allow_gate_contract_edits
            {
                return profile_error(format!(
                    "change-control disposition operation {} must have zero graph mutation authority",
                    operation.id
                ));
            }
            Ok(())
        }
    }
}

fn validate_receipt_coverage(
    profile: &CompiledProfile,
    operation: &OperationDef,
    contract: &ReceiptCoverageDef,
) -> Result<()> {
    let owner = format!("operation {} receipt_coverage", operation.id);
    if contract.candidate_node_types.is_empty() {
        return profile_error(format!("{owner} requires candidate_node_types"));
    }
    validate_known_node_types(
        profile,
        &contract.candidate_node_types,
        &format!("{owner} candidate_node_types"),
    )?;
    let writable_types = operation
        .allowed_new_node_types
        .iter()
        .chain(&operation.allowed_existing_node_types)
        .collect::<BTreeSet<_>>();
    for candidate_type in &contract.candidate_node_types {
        if !writable_types.contains(candidate_type) {
            return profile_error(format!(
                "{owner} candidate type {candidate_type} is not writable by the operation"
            ));
        }
    }

    let traversal = &contract.required_nodes;
    if traversal.relations.is_empty() {
        return profile_error(format!(
            "{owner} required_nodes.relations must not be empty"
        ));
    }
    if traversal.min_depth == 0
        || traversal.max_depth == 0
        || traversal.min_depth > traversal.max_depth
        || traversal.max_depth > 32
    {
        return profile_error(format!(
            "{owner} required_nodes depth must satisfy 1 <= min_depth <= max_depth <= 32"
        ));
    }
    if traversal.node_types.is_empty() {
        return profile_error(format!(
            "{owner} required_nodes.node_types must not be empty"
        ));
    }
    validate_known_node_types(
        profile,
        &traversal.node_types,
        &format!("{owner} required_nodes.node_types"),
    )?;
    let relation_names = profile
        .edge_types
        .iter()
        .map(|edge| edge.relation.as_str())
        .collect::<BTreeSet<_>>();
    let mut seen_relations = BTreeSet::new();
    for relation in &traversal.relations {
        if !relation_names.contains(relation.as_str()) {
            return profile_error(format!(
                "{owner} required_nodes references unknown relation {relation}"
            ));
        }
        if !seen_relations.insert(relation) {
            return profile_error(format!(
                "{owner} required_nodes repeats relation {relation}"
            ));
        }
    }

    validate_identifier(
        &format!("{owner} candidate_link_relation"),
        &contract.candidate_link_relation,
    )?;
    for candidate_type in &contract.candidate_node_types {
        let edge = profile
            .edge_types
            .iter()
            .find(|edge| {
                edge.source == *candidate_type && edge.relation == contract.candidate_link_relation
            })
            .ok_or_else(|| {
                KoniError::Profile(format!(
                    "{owner} candidate type {candidate_type} does not own relation {}",
                    contract.candidate_link_relation
                ))
            })?;
        for required_type in &traversal.node_types {
            if !edge.targets.contains(required_type) {
                return profile_error(format!(
                    "{owner} candidate relation {candidate_type}.{} cannot target required type {required_type}",
                    contract.candidate_link_relation
                ));
            }
        }
    }

    validate_identifier(&format!("{owner} receipt_type"), &contract.receipt_type)?;
    validate_nonempty_unique_values(
        &contract.receipt_statuses,
        &format!("{owner} receipt_statuses"),
    )?;
    validate_nonempty_unique_values(
        &contract.disposition.allowed_values,
        &format!("{owner} disposition.allowed_values"),
    )?;
    for (label, path) in [
        (
            "disposition_map_path",
            contract.disposition_map_path.as_str(),
        ),
        (
            "disposition.value_path",
            contract.disposition.value_path.as_str(),
        ),
        (
            "disposition.receipt_id_path",
            contract.disposition.receipt_id_path.as_str(),
        ),
        (
            "disposition.rationale_path",
            contract.disposition.rationale_path.as_str(),
        ),
    ] {
        validate_contract_field_path(path)
            .map_err(|error| KoniError::Profile(format!("{owner} {label}: {error}")))?;
    }
    if let Some(path) = &contract.receipt_refs_path {
        validate_contract_field_path(path)
            .map_err(|error| KoniError::Profile(format!("{owner} receipt_refs_path: {error}")))?;
    }
    let entry_paths = [
        contract.disposition.value_path.as_str(),
        contract.disposition.receipt_id_path.as_str(),
        contract.disposition.rationale_path.as_str(),
    ];
    if entry_paths.into_iter().collect::<BTreeSet<_>>().len() != entry_paths.len() {
        return profile_error(format!(
            "{owner} disposition value, receipt, and rationale paths must be distinct"
        ));
    }

    for candidate_type in &contract.candidate_node_types {
        let definition = &profile.node_types[candidate_type];
        let disposition_field = node_field_definition(definition, &contract.disposition_map_path)
            .ok_or_else(|| {
                KoniError::Profile(format!(
                    "{owner} disposition_map_path {} is not declared by candidate type {candidate_type}",
                    contract.disposition_map_path
                ))
            })?;
        if disposition_field.value_type != FieldType::Object {
            return profile_error(format!(
                "{owner} disposition_map_path {} must be an object on candidate type {candidate_type}",
                contract.disposition_map_path
            ));
        }
        if let Some(path) = &contract.receipt_refs_path {
            let receipt_refs = node_field_definition(definition, path).ok_or_else(|| {
                KoniError::Profile(format!(
                    "{owner} receipt_refs_path {path} is not declared by candidate type {candidate_type}"
                ))
            })?;
            if receipt_refs.value_type != FieldType::List
                || receipt_refs
                    .items
                    .as_deref()
                    .is_none_or(|item| item.value_type != FieldType::String)
            {
                return profile_error(format!(
                    "{owner} receipt_refs_path {path} must be a list with string items on candidate type {candidate_type}"
                ));
            }
        }
    }
    Ok(())
}

fn validate_nonempty_unique_values(values: &[String], label: &str) -> Result<()> {
    if values.is_empty()
        || values
            .iter()
            .any(|value| value.trim().is_empty() || value.trim() != value)
    {
        return profile_error(format!("{label} must contain nonempty trimmed values"));
    }
    if values.iter().collect::<BTreeSet<_>>().len() != values.len() {
        return profile_error(format!("{label} must not contain duplicates"));
    }
    Ok(())
}

fn validate_contract_field_path(path: &str) -> std::result::Result<(), String> {
    if path.trim().is_empty() || path.trim() != path {
        return Err("field path must be nonempty and have no surrounding whitespace".to_owned());
    }
    let normalized = path.strip_prefix("$.").unwrap_or(path);
    if normalized.split('.').any(|segment| {
        segment.is_empty()
            || !segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
            })
    }) {
        return Err(format!(
            "field path {path:?} must use nonempty dot-separated field names"
        ));
    }
    Ok(())
}

fn node_field_definition<'a>(definition: &'a NodeTypeDef, path: &str) -> Option<&'a FieldDef> {
    let normalized = path
        .strip_prefix("$.")
        .unwrap_or(path)
        .strip_prefix("spec.")
        .unwrap_or_else(|| path.strip_prefix("$.").unwrap_or(path));
    let mut segments = normalized.split('.');
    let mut field = definition.fields.get(segments.next()?)?;
    for segment in segments {
        field = field.properties.get(segment)?;
    }
    Some(field)
}

fn validate_review_effects(profile: &CompiledProfile, operation: &OperationDef) -> Result<()> {
    if operation.review_effects.is_empty() {
        return Ok(());
    }
    let workflow = operation
        .workflow
        .as_deref()
        .and_then(|id| profile.workflows.get(id))
        .ok_or_else(|| {
            KoniError::Profile(format!(
                "operation {} configures review_effects without a workflow",
                operation.id
            ))
        })?;
    let review_steps = workflow
        .steps
        .iter()
        .filter(|step| step.kind == WorkflowStepKind::Review)
        .count();
    if review_steps != 1 {
        return profile_error(format!(
            "operation {} configures review_effects but workflow {} has {} review steps; exactly one compiler-bound review boundary is required",
            operation.id, workflow.id, review_steps
        ));
    }

    let candidate_types = operation
        .allowed_new_node_types
        .iter()
        .chain(&operation.allowed_existing_node_types)
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut effect_ids = BTreeSet::new();
    let mut selected_types = BTreeSet::new();
    for effect in &operation.review_effects {
        validate_identifier("review effect", &effect.id)?;
        if !effect_ids.insert(effect.id.as_str()) {
            return profile_error(format!(
                "operation {} has duplicate review effect {}",
                operation.id, effect.id
            ));
        }
        if effect.verdict != "passed" {
            return profile_error(format!(
                "operation {} review effect {} must use verdict passed; failed or unknown verdicts can never mutate graph state",
                operation.id, effect.id
            ));
        }
        if effect.select.node_types.is_empty() {
            return profile_error(format!(
                "operation {} review effect {} has an empty node type selector",
                operation.id, effect.id
            ));
        }
        let effect_types = effect
            .select
            .node_types
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        if effect_types.len() != effect.select.node_types.len() {
            return profile_error(format!(
                "operation {} review effect {} has duplicate node types",
                operation.id, effect.id
            ));
        }
        validate_known_node_types(
            profile,
            &effect.select.node_types,
            &format!(
                "operation {} review effect {} selector",
                operation.id, effect.id
            ),
        )?;
        if let Some(node_type) = effect_types
            .iter()
            .find(|node_type| !candidate_types.contains(*node_type))
        {
            return profile_error(format!(
                "operation {} review effect {} selects {}, which the operation cannot introduce or modify",
                operation.id, effect.id, node_type
            ));
        }
        if let Some(node_type) = effect_types
            .iter()
            .find(|node_type| selected_types.contains(*node_type))
        {
            return profile_error(format!(
                "operation {} review effects have ambiguous overlapping selectors for node type {}",
                operation.id, node_type
            ));
        }
        selected_types.extend(effect_types.iter().cloned());

        validate_review_effect_count(operation, effect)?;
        if let Some(predicate) = &effect.select.predicate {
            validate_review_effect_predicate(profile, operation, effect, predicate)?;
        }
        for predicate in &effect.preconditions {
            validate_review_effect_predicate(profile, operation, effect, predicate)?;
        }
        validate_review_effect_coverage(profile, operation, effect)?;
        if effect.set.is_empty() {
            return profile_error(format!(
                "operation {} review effect {} has no compiler-owned set mappings",
                operation.id, effect.id
            ));
        }
        let paths = effect.set.keys().collect::<Vec<_>>();
        for (index, left) in paths.iter().enumerate() {
            validate_path_projection_field(left).map_err(|error| {
                KoniError::Profile(format!(
                    "operation {} review effect {} destination: {}",
                    operation.id, effect.id, error
                ))
            })?;
            if paths.iter().skip(index + 1).any(|right| {
                left.starts_with(&format!("{right}.")) || right.starts_with(&format!("{left}."))
            }) {
                return profile_error(format!(
                    "operation {} review effect {} has overlapping destination paths",
                    operation.id, effect.id
                ));
            }
            for node_type in &effect.select.node_types {
                let definition = &profile.node_types[node_type];
                if !definition
                    .compiler_owned_fields
                    .iter()
                    .any(|owned| owned == *left)
                {
                    return profile_error(format!(
                        "operation {} review effect {} destination {} is not explicitly compiler-owned for node type {}",
                        operation.id, effect.id, left, node_type
                    ));
                }
                if !node_declares_review_effect_field(definition, left) {
                    return profile_error(format!(
                        "operation {} review effect {} destination {} is not a declared field of node type {}",
                        operation.id, effect.id, left, node_type
                    ));
                }
            }
            validate_review_effect_value_tokens(operation, effect, &effect.set[*left])?;
        }
    }
    Ok(())
}

fn validate_review_effect_count(operation: &OperationDef, effect: &ReviewEffectDef) -> Result<()> {
    let count = &effect.count;
    if count.exact.is_some() && (count.min.is_some() || count.max.is_some()) {
        return profile_error(format!(
            "operation {} review effect {} count uses exact or min/max, not both",
            operation.id, effect.id
        ));
    }
    if count.exact.is_none() && count.min.is_none() && count.max.is_none() {
        return profile_error(format!(
            "operation {} review effect {} requires an exact, min, or max count bound",
            operation.id, effect.id
        ));
    }
    if count.exact == Some(0) || count.min == Some(0) || count.max == Some(0) {
        return profile_error(format!(
            "operation {} review effect {} count must select at least one node",
            operation.id, effect.id
        ));
    }
    if let (Some(min), Some(max)) = (count.min, count.max)
        && min > max
    {
        return profile_error(format!(
            "operation {} review effect {} count min exceeds max",
            operation.id, effect.id
        ));
    }
    Ok(())
}

fn validate_review_effect_predicate(
    profile: &CompiledProfile,
    operation: &OperationDef,
    effect: &ReviewEffectDef,
    predicate: &ReviewEffectFieldPredicateDef,
) -> Result<()> {
    validate_path_projection_field(&predicate.field).map_err(|error| {
        KoniError::Profile(format!(
            "operation {} review effect {} predicate: {}",
            operation.id, effect.id, error
        ))
    })?;
    match predicate.op {
        ReviewEffectFieldPredicateOp::Equals if predicate.value.is_none() => {
            return profile_error(format!(
                "operation {} review effect {} equals predicate for {} requires value",
                operation.id, effect.id, predicate.field
            ));
        }
        ReviewEffectFieldPredicateOp::Present
        | ReviewEffectFieldPredicateOp::Absent
        | ReviewEffectFieldPredicateOp::NonEmpty
            if predicate.value.is_some() =>
        {
            return profile_error(format!(
                "operation {} review effect {} {:?} predicate for {} cannot configure value",
                operation.id, effect.id, predicate.op, predicate.field
            ));
        }
        _ => {}
    }
    for node_type in &effect.select.node_types {
        if !node_declares_review_effect_field(&profile.node_types[node_type], &predicate.field) {
            return profile_error(format!(
                "operation {} review effect {} predicate field {} is not declared for selected node type {}",
                operation.id, effect.id, predicate.field, node_type
            ));
        }
    }
    Ok(())
}

fn validate_review_effect_coverage(
    profile: &CompiledProfile,
    operation: &OperationDef,
    effect: &ReviewEffectDef,
) -> Result<()> {
    let symbols = profile
        .expression_symbols()
        .with_variable("target", ValueType::NodeSet)
        .with_variable("candidate", ValueType::Node);
    let mut ids = BTreeSet::new();
    for coverage in &effect.coverage {
        validate_identifier("review effect coverage", &coverage.id)?;
        if !ids.insert(coverage.id.as_str()) {
            return profile_error(format!(
                "operation {} review effect {} has duplicate coverage contract {}",
                operation.id, effect.id, coverage.id
            ));
        }
        coverage.required.validate(&symbols).map_err(|error| {
            KoniError::Profile(format!(
                "operation {} review effect {} coverage {} selector: {}",
                operation.id, effect.id, coverage.id, error
            ))
        })?;
        match coverage.actual.kind {
            ReviewEffectCoverageActualKind::FieldValue
            | ReviewEffectCoverageActualKind::FieldValues
            | ReviewEffectCoverageActualKind::ObjectKeys => {
                let field = coverage.actual.field.as_deref().ok_or_else(|| {
                    KoniError::Profile(format!(
                        "operation {} review effect {} coverage {} requires actual.field",
                        operation.id, effect.id, coverage.id
                    ))
                })?;
                if coverage.actual.relation.is_some() {
                    return profile_error(format!(
                        "operation {} review effect {} coverage {} field source cannot configure relation",
                        operation.id, effect.id, coverage.id
                    ));
                }
                validate_path_projection_field(field).map_err(|error| {
                    KoniError::Profile(format!(
                        "operation {} review effect {} coverage {} actual field: {}",
                        operation.id, effect.id, coverage.id, error
                    ))
                })?;
                let expected_type = match coverage.actual.kind {
                    ReviewEffectCoverageActualKind::FieldValue => None,
                    ReviewEffectCoverageActualKind::FieldValues => Some(FieldType::List),
                    ReviewEffectCoverageActualKind::ObjectKeys => Some(FieldType::Object),
                    ReviewEffectCoverageActualKind::OutgoingRelation => unreachable!(),
                };
                for node_type in &effect.select.node_types {
                    let definition = &profile.node_types[node_type];
                    let Some(field_definition) = review_effect_field_definition(definition, field)
                    else {
                        return profile_error(format!(
                            "operation {} review effect {} coverage {} field {} is not declared for selected node type {}",
                            operation.id, effect.id, coverage.id, field, node_type
                        ));
                    };
                    let valid_type = expected_type
                        .is_some_and(|expected| field_definition.value_type == expected)
                        || (coverage.actual.kind == ReviewEffectCoverageActualKind::FieldValue
                            && matches!(
                                field_definition.value_type,
                                FieldType::String | FieldType::NodeRef
                            ));
                    if !valid_type {
                        return profile_error(format!(
                            "operation {} review effect {} coverage {} field {} has an incompatible type for selected node type {}",
                            operation.id, effect.id, coverage.id, field, node_type
                        ));
                    }
                    if coverage.actual.kind == ReviewEffectCoverageActualKind::FieldValues
                        && !field_definition.items.as_deref().is_some_and(|items| {
                            matches!(items.value_type, FieldType::String | FieldType::NodeRef)
                        })
                    {
                        return profile_error(format!(
                            "operation {} review effect {} coverage {} field {} list items must be string or node_ref for selected node type {}",
                            operation.id, effect.id, coverage.id, field, node_type
                        ));
                    }
                }
                if matches!(
                    coverage.actual.kind,
                    ReviewEffectCoverageActualKind::FieldValue
                        | ReviewEffectCoverageActualKind::FieldValues
                ) && !coverage.actual.allowed_values.is_empty()
                {
                    return profile_error(format!(
                        "operation {} review effect {} coverage {} allowed_values applies only to object_keys",
                        operation.id, effect.id, coverage.id
                    ));
                }
            }
            ReviewEffectCoverageActualKind::OutgoingRelation => {
                let relation = coverage.actual.relation.as_deref().ok_or_else(|| {
                    KoniError::Profile(format!(
                        "operation {} review effect {} coverage {} requires actual.relation",
                        operation.id, effect.id, coverage.id
                    ))
                })?;
                if coverage.actual.field.is_some() || !coverage.actual.allowed_values.is_empty() {
                    return profile_error(format!(
                        "operation {} review effect {} coverage {} relation source cannot configure field or allowed_values",
                        operation.id, effect.id, coverage.id
                    ));
                }
                for node_type in &effect.select.node_types {
                    if !profile
                        .edge_types
                        .iter()
                        .any(|edge| edge.source == *node_type && edge.relation == relation)
                    {
                        return profile_error(format!(
                            "operation {} review effect {} coverage {} relation {} is not declared for selected node type {}",
                            operation.id, effect.id, coverage.id, relation, node_type
                        ));
                    }
                }
            }
        }
        if coverage.actual.kind != ReviewEffectCoverageActualKind::ObjectKeys
            && !coverage.actual.allowed_values.is_empty()
        {
            return profile_error(format!(
                "operation {} review effect {} coverage {} allowed_values requires object_keys",
                operation.id, effect.id, coverage.id
            ));
        }
        if coverage.actual.allowed_values.iter().any(Value::is_null) {
            return profile_error(format!(
                "operation {} review effect {} coverage {} allowed_values cannot contain null",
                operation.id, effect.id, coverage.id
            ));
        }
    }
    Ok(())
}

fn node_declares_review_effect_field(node: &NodeTypeDef, path: &str) -> bool {
    review_effect_field_definition(node, path).is_some()
        || (!path.starts_with("spec.")
            && (matches!(
                path,
                "schema_version" | "id" | "type" | "title" | "status" | "edges" | "annotations"
            ) || node.compiler_owned_fields.iter().any(|field| field == path)))
}

fn review_effect_field_definition<'a>(node: &'a NodeTypeDef, path: &str) -> Option<&'a FieldDef> {
    let mut segments = path.trim_start_matches("$.").split('.');
    let root = segments.next()?;
    if root != "spec" {
        return None;
    }
    let first = segments.next()?;
    let mut field = node.fields.get(first)?;
    for segment in segments {
        field = field.properties.get(segment)?;
    }
    Some(field)
}

fn validate_review_effect_value_tokens(
    operation: &OperationDef,
    effect: &ReviewEffectDef,
    value: &Value,
) -> Result<()> {
    match value {
        Value::String(token) if token.starts_with('$') => {
            if !matches!(token.as_str(), "$review.id" | "$actor") {
                return profile_error(format!(
                    "operation {} review effect {} uses unknown compiler token {}",
                    operation.id, effect.id, token
                ));
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_review_effect_value_tokens(operation, effect, item)?;
            }
        }
        Value::Object(object) => {
            for item in object.values() {
                validate_review_effect_value_tokens(operation, effect, item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_workflows(profile: &CompiledProfile) -> Result<()> {
    let operation_names: BTreeSet<_> = profile
        .operations
        .values()
        .map(OperationDef::public_operation)
        .collect();
    for workflow in profile.workflows.values() {
        if workflow.steps.is_empty() {
            return profile_error(format!("workflow {} has no steps", workflow.id));
        }
        for operation in &workflow.applies_to {
            if !operation_names.contains(operation.as_str())
                && !profile.operations.contains_key(operation)
            {
                return profile_error(format!(
                    "workflow {} applies to unknown operation {}",
                    workflow.id, operation
                ));
            }
        }
        let ids: BTreeSet<_> = workflow.steps.iter().map(|step| step.id.as_str()).collect();
        if ids.len() != workflow.steps.len() {
            return profile_error(format!("workflow {} has duplicate step ids", workflow.id));
        }
        if let Some(reopen_from) = &workflow.review_failure_reopen_from {
            let Some(reopen_step) = workflow.steps.iter().find(|step| step.id == *reopen_from)
            else {
                return profile_error(format!(
                    "workflow {} review_failure_reopen_from references unknown step {}",
                    workflow.id, reopen_from
                ));
            };
            if reopen_step.kind == WorkflowStepKind::Review {
                return profile_error(format!(
                    "workflow {} review_failure_reopen_from cannot reference review step {}",
                    workflow.id, reopen_from
                ));
            }
        }
        let mut dependencies: HashMap<&str, BTreeSet<String>> = HashMap::new();
        for step in &workflow.steps {
            validate_identifier("workflow step", &step.id)?;
            if !profile.personas.contains_key(&step.persona) {
                return profile_error(format!(
                    "workflow {} step {} references unknown persona {}",
                    workflow.id, step.id, step.persona
                ));
            }
            for dependency in &step.depends_on {
                if !ids.contains(dependency.as_str()) {
                    return profile_error(format!(
                        "workflow {} step {} has unknown dependency {}",
                        workflow.id, step.id, dependency
                    ));
                }
                if dependency == &step.id {
                    return profile_error(format!(
                        "workflow {} step {} depends on itself",
                        workflow.id, step.id
                    ));
                }
            }
            if let Some(action) = &step.validation_action
                && !profile.actions.contains_key(action)
            {
                return profile_error(format!(
                    "workflow {} step {} references unknown action {}",
                    workflow.id, step.id, action
                ));
            }
            if step.kind == WorkflowStepKind::Review {
                let review_actions = if let Some(action) = &step.validation_action {
                    profile.actions.get(action).into_iter().collect::<Vec<_>>()
                } else {
                    profile
                        .actions
                        .values()
                        .filter(|action| {
                            action
                                .recipe
                                .iter()
                                .any(|primitive| primitive.primitive == "review.record")
                        })
                        .collect::<Vec<_>>()
                };
                if review_actions.len() != 1
                    || !review_actions[0]
                        .recipe
                        .iter()
                        .any(|primitive| primitive.primitive == "review.record")
                {
                    return profile_error(format!(
                        "workflow {} review step {} must resolve exactly one validation action containing review.record",
                        workflow.id, step.id
                    ));
                }
            }
            for check in &step.checks {
                if !profile.checks.contains_key(check) {
                    return profile_error(format!(
                        "workflow {} step {} references unknown check {}",
                        workflow.id, step.id, check
                    ));
                }
            }
            dependencies.insert(&step.id, step.depends_on.iter().cloned().collect());
        }
        let mut visiting = HashSet::new();
        let mut visited = HashSet::new();
        for id in &ids {
            visit_dependency(
                id,
                &dependencies,
                &mut visiting,
                &mut visited,
                "workflow step",
            )?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectResource {
    Config,
    Graph,
    Tickets,
    State,
    Workspace,
    Git,
    Process,
    External,
    Audit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectClass {
    ReadOnly,
    Validation,
    ReversibleWrite,
    DurableWrite,
    Irreversible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrimitiveEffect {
    pub class: EffectClass,
    #[serde(default)]
    pub reads: BTreeSet<EffectResource>,
    #[serde(default)]
    pub writes: BTreeSet<EffectResource>,
    #[serde(default)]
    pub invalidates_validation: bool,
}

impl PrimitiveEffect {
    fn read(resources: impl IntoIterator<Item = EffectResource>) -> Self {
        Self {
            class: EffectClass::ReadOnly,
            reads: resources.into_iter().collect(),
            writes: BTreeSet::new(),
            invalidates_validation: false,
        }
    }

    fn validation(resources: impl IntoIterator<Item = EffectResource>) -> Self {
        Self {
            class: EffectClass::Validation,
            reads: resources.into_iter().collect(),
            writes: BTreeSet::new(),
            invalidates_validation: false,
        }
    }

    fn write(
        class: EffectClass,
        resources: impl IntoIterator<Item = EffectResource>,
        invalidates_validation: bool,
    ) -> Self {
        let writes: BTreeSet<_> = resources.into_iter().collect();
        Self {
            class,
            reads: writes.clone(),
            writes,
            invalidates_validation,
        }
    }
}

/// Effect signature for every primitive exposed to profile recipes.
/// Unknown primitives are rejected instead of being treated as shell escapes.
pub fn primitive_effect(step: &ActionStepDef) -> std::result::Result<PrimitiveEffect, String> {
    use EffectClass::{DurableWrite, Irreversible, ReversibleWrite};
    use EffectResource::{Audit, Config, External, Git, Graph, Process, State, Tickets, Workspace};

    let effect = match step.primitive.as_str() {
        "lock.acquire" | "lock.release" | "transaction.begin" | "transaction.journal" => {
            PrimitiveEffect::write(ReversibleWrite, [Audit], false)
        }
        "profile.validate" => PrimitiveEffect::validation([Config]),
        "graph.validate" => PrimitiveEffect::validation([Graph]),
        "ticket.validate" => PrimitiveEffect::validation([Tickets]),
        "scope.validate" | "output.validate" | "review.validate" => {
            PrimitiveEffect::validation([Graph, Tickets, State, Workspace])
        }
        "project.validate" | "integration.validate" => {
            PrimitiveEffect::validation([Config, Graph, Tickets, State, Workspace, Git])
        }
        "rules.evaluate" => PrimitiveEffect::write(ReversibleWrite, [Graph, State], true),
        "tickets.reconcile" => PrimitiveEffect::write(ReversibleWrite, [Tickets], true),
        "state.write" | "state.transition" => {
            PrimitiveEffect::write(ReversibleWrite, [State], true)
        }
        "graph.write" | "graph.apply_delta" => {
            PrimitiveEffect::write(ReversibleWrite, [Graph], true)
        }
        "ticket.write" | "ticket.transition" => {
            PrimitiveEffect::write(ReversibleWrite, [Tickets], true)
        }
        "lease.acquire" | "lease.release" => {
            PrimitiveEffect::write(ReversibleWrite, [Tickets, Audit], true)
        }
        "snapshot.write" | "event.append" | "receipt.write" => {
            PrimitiveEffect::write(ReversibleWrite, [Audit], false)
        }
        // Context inputs are supplied by the action runtime, so the profile
        // recipe does not need to duplicate ticket/step arguments here.
        "context.compile" => PrimitiveEffect::write(ReversibleWrite, [Audit], false),
        "output.record" | "review.record" => {
            PrimitiveEffect::write(ReversibleWrite, [Tickets, Audit], true)
        }
        "report.render" => PrimitiveEffect::write(ReversibleWrite, [Workspace, Audit], false),
        "worktree.create" | "worktree.retire" => {
            PrimitiveEffect::write(ReversibleWrite, [Git, Workspace], true)
        }
        "worktree.remove" => PrimitiveEffect::write(Irreversible, [Git, Workspace], false),
        "git.merge_tree" | "git.checkout_tree" => {
            PrimitiveEffect::write(ReversibleWrite, [Git, Workspace], true)
        }
        "git.commit" | "git.integrate_squash" => PrimitiveEffect::write(DurableWrite, [Git], false),
        "agent.spawn" | "agent.stop" => PrimitiveEffect::write(Irreversible, [Process], false),
        "check.run" => PrimitiveEffect::validation([Workspace, Process]),
        "process.run" => match step.args.get("effect").and_then(Value::as_str) {
            Some("read_only") => PrimitiveEffect::read([Workspace, Process]),
            Some("workspace_write") => {
                PrimitiveEffect::write(ReversibleWrite, [Workspace, Process], true)
            }
            Some("external") => PrimitiveEffect::write(Irreversible, [Process, External], false),
            Some(other) => return Err(format!("process.run has unknown effect {other}")),
            None => {
                return Err(
                    "process.run must declare effect: read_only, workspace_write, or external"
                        .to_owned(),
                );
            }
        },
        "recovery.dispatch" => {
            PrimitiveEffect::write(ReversibleWrite, [Audit, Git, Tickets, State], true)
        }
        "rollback.forward_reversal" => PrimitiveEffect::write(
            DurableWrite,
            [Graph, Tickets, State, Audit, Git, Workspace],
            false,
        ),
        "board.render" | "graph.inspect" | "ticket.inspect" | "state.inspect" => {
            PrimitiveEffect::read([Graph, Tickets, State])
        }
        other => return Err(format!("unknown primitive {other}")),
    };
    Ok(effect)
}

fn validate_actions(profile: &CompiledProfile) -> Result<()> {
    let mut command_names = BTreeMap::new();
    for action in profile.actions.values() {
        for name in std::iter::once(&action.id).chain(&action.aliases) {
            if let Some(previous) = command_names.insert(name, &action.id) {
                return profile_error(format!(
                    "action command/alias {name} belongs to both {previous} and {}",
                    action.id
                ));
            }
        }
        if action.recipe.is_empty() {
            return profile_error(format!("action {} has an empty recipe", action.id));
        }
        if action.actor.trim().is_empty() {
            return profile_error(format!("action {} has an empty actor", action.id));
        }
        if action.requires_main_checkout && action.requires_ticket_worktree {
            return profile_error(format!(
                "action {} cannot require both main and ticket checkouts",
                action.id
            ));
        }
        if action.requires_ticket_worktree
            && !action
                .params
                .keys()
                .any(|name| name == "ticket" || name == "ticket_id")
        {
            return profile_error(format!(
                "action {} requires a ticket worktree but declares no ticket parameter",
                action.id
            ));
        }
        validate_action_steps(action, &action.recipe, false)?;
        validate_action_steps(action, &action.compensation, true)?;
        let integration_steps: Vec<_> = action
            .recipe
            .iter()
            .enumerate()
            .filter(|(_, step)| step.primitive == "git.integrate_squash")
            .map(|(index, _)| index)
            .collect();
        if integration_steps.len() > 1 {
            return profile_error(format!(
                "action {} may contain at most one git.integrate_squash boundary",
                action.id
            ));
        }
        if profile.manifest.storage.backend == StorageBackend::GitCommonDir
            && integration_steps
                .first()
                .is_some_and(|index| *index + 1 != action.recipe.len())
        {
            return profile_error(format!(
                "git-common-dir action {} must place git.integrate_squash last so sidecar effects cannot publish before product integration",
                action.id
            ));
        }
        if let Some(recovery) = &action.recovery
            && recovery == &action.id
        {
            return profile_error(format!(
                "action {} cannot recover by recursively invoking itself",
                action.id
            ));
        }
    }
    for action in profile.actions.values() {
        if let Some(recovery) = &action.recovery
            && !profile.actions.contains_key(recovery)
        {
            return profile_error(format!(
                "action {} references unknown recovery action {}",
                action.id, recovery
            ));
        }
    }
    Ok(())
}

fn validate_action_steps(
    action: &ActionDef,
    steps: &[ActionStepDef],
    compensation: bool,
) -> Result<()> {
    let mut validated = false;
    let mut irreversible_seen = false;
    let mut needs_recovery = false;
    let mut step_ids = BTreeSet::new();
    for (index, step) in steps.iter().enumerate() {
        if let Some(id) = &step.id
            && !step_ids.insert(id)
        {
            return profile_error(format!("action {} has duplicate step id {}", action.id, id));
        }
        let effect = primitive_effect(step).map_err(|error| {
            KoniError::Profile(format!("action {} step {}: {error}", action.id, index + 1))
        })?;
        if let Some(predicate) = &step.when {
            let symbols = ExpressionSymbols::default()
                .with_variable("ticket", ValueType::Ticket)
                .with_variable("target", ValueType::Node);
            predicate.validate(&symbols).map_err(|error| {
                KoniError::Profile(format!(
                    "action {} step {} guard: {error}",
                    action.id,
                    index + 1
                ))
            })?;
        }
        match effect.class {
            EffectClass::Validation => {
                if irreversible_seen && !compensation {
                    return profile_error(format!(
                        "action {} performs validation after an irreversible/durable step; validate before the boundary",
                        action.id
                    ));
                }
                validated = true;
            }
            EffectClass::ReversibleWrite if effect.invalidates_validation => {
                if irreversible_seen && !compensation {
                    return profile_error(format!(
                        "action {} mutates validated state after an irreversible/durable step",
                        action.id
                    ));
                }
                validated = false;
            }
            EffectClass::DurableWrite | EffectClass::Irreversible => {
                if !validated && !compensation {
                    return profile_error(format!(
                        "action {} reaches {} before current state has been validated",
                        action.id, step.primitive
                    ));
                }
                irreversible_seen = true;
                needs_recovery = true;
            }
            EffectClass::ReadOnly | EffectClass::ReversibleWrite => {}
        }
    }
    if needs_recovery
        && action.recovery.is_none()
        && action.compensation.is_empty()
        && !compensation
    {
        return profile_error(format!(
            "action {} crosses an irreversible/durable boundary without compensation or recovery",
            action.id
        ));
    }
    Ok(())
}

fn validate_checks(profile: &CompiledProfile) -> Result<()> {
    let operation_names: BTreeSet<_> = profile
        .operations
        .values()
        .map(OperationDef::public_operation)
        .collect();
    for check in profile.checks.values() {
        if check.receipt_type.trim().is_empty() {
            return profile_error(format!("check {} has an empty receipt_type", check.id));
        }
        if let Some(predicate) = &check.predicate {
            if check.kind != CheckKind::Graph {
                return profile_error(format!(
                    "check {} configures predicate but is not a graph check",
                    check.id
                ));
            }
            let symbols = profile
                .expression_symbols()
                .with_variable("target", ValueType::Node)
                .with_variable("node", ValueType::Node);
            predicate
                .validate(&symbols)
                .map_err(|error| profile_expr_error("check", &check.id, error))?;
            let mut nested_checks = BTreeSet::new();
            predicate.referenced_checks(&mut nested_checks);
            if !nested_checks.is_empty() {
                return profile_error(format!(
                    "graph check {} may not recursively reference checks",
                    check.id
                ));
            }
        }
        validate_relative_path(&check.cwd, &format!("check {} cwd", check.id))?;
        if check.timeout_seconds == 0 {
            return profile_error(format!(
                "check {} timeout_seconds must be positive",
                check.id
            ));
        }
        let command_sources = usize::from(!check.argv.is_empty())
            + usize::from(check.argv_from.is_some())
            + usize::from(check.command_source.is_some());
        if matches!(check.kind, CheckKind::Command) && command_sources != 1 {
            return profile_error(format!(
                "command check {} requires exactly one of argv, argv_from, or command_source",
                check.id
            ));
        }
        if !matches!(check.kind, CheckKind::Command) && command_sources != 0 {
            return profile_error(format!(
                "non-command check {} may not configure argv, argv_from, or command_source",
                check.id
            ));
        }
        if check.argv.iter().any(|argument| argument.contains('\0')) {
            return profile_error(format!("check {} argv contains a NUL byte", check.id));
        }
        if check
            .environment
            .set
            .values()
            .any(|value| value.contains("<PRIVATE_TMP>"))
        {
            return profile_error(format!(
                "check {} environment uses reserved compiler token <PRIVATE_TMP>",
                check.id
            ));
        }
        if let Some(source) = &check.argv_from
            && source
                .as_str()
                .is_none_or(|field| validate_dynamic_field_syntax(field).is_err())
        {
            return profile_error(format!(
                "check {} argv_from must be a nonempty dynamic field string",
                check.id
            ));
        }
        if let Some(source) = &check.command_source {
            validate_dynamic_command_source(profile, check, source)?;
        }
        if check
            .result_protocol
            .as_deref()
            .is_some_and(|protocol| protocol.trim().is_empty())
        {
            return profile_error(format!("check {} has an empty result_protocol", check.id));
        }
        if check.result_protocol.is_some() && check.result_protocol_field.trim().is_empty() {
            return profile_error(format!(
                "check {} has an empty result_protocol_field",
                check.id
            ));
        }
        if check.result_protocol.is_none()
            && (!check.required_result_fields.is_empty()
                || check.result_schema.is_some()
                || check.result_line_prefix.is_some()
                || check.result_acceptance.is_some()
                || check.result_identity_field.is_some()
                || check.dynamic_result.is_some())
        {
            return profile_error(format!(
                "check {} configures result validation without result_protocol",
                check.id
            ));
        }
        if let Some(schema) = &check.result_schema {
            jsonschema::validator_for(schema).map_err(|error| {
                KoniError::Profile(format!(
                    "check {} has an invalid result_schema: {error}",
                    check.id
                ))
            })?;
        }
        if let Some(acceptance) = &check.result_acceptance
            && (acceptance.field.trim().is_empty() || acceptance.values.is_empty())
        {
            return profile_error(format!(
                "check {} result_acceptance requires a nonempty field and values",
                check.id
            ));
        }
        if check
            .result_identity_field
            .as_deref()
            .is_some_and(|field| field.trim().is_empty())
        {
            return profile_error(format!(
                "check {} has an empty result_identity_field",
                check.id
            ));
        }
        if let Some(dynamic_result) = &check.dynamic_result {
            validate_dynamic_result(check, dynamic_result)?;
        }
        if let Some(bindings) = &check.argv_input_bindings {
            if check.argv_from.is_none() && check.command_source.is_none() {
                return profile_error(format!(
                    "check {} argv_input_bindings requires argv_from or command_source",
                    check.id
                ));
            }
            if validate_dynamic_field_syntax(&bindings.from).is_err()
                || validate_dynamic_field_syntax(&bindings.path_field).is_err()
            {
                return profile_error(format!(
                    "check {} argv_input_bindings requires valid from and path_field paths",
                    check.id
                ));
            }
            if bindings
                .required_fields
                .iter()
                .any(|field| validate_dynamic_field_syntax(field).is_err())
            {
                return profile_error(format!(
                    "check {} argv_input_bindings contains a malformed required field",
                    check.id
                ));
            }
            if bindings
                .required_fields
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != bindings.required_fields.len()
            {
                return profile_error(format!(
                    "check {} argv_input_bindings required_fields must not contain duplicates",
                    check.id
                ));
            }
        }
        if check.artifact_paths.iter().collect::<BTreeSet<_>>().len() != check.artifact_paths.len()
        {
            return profile_error(format!(
                "check {} artifact_paths must not contain duplicates",
                check.id
            ));
        }
        for artifact in &check.artifact_paths {
            validate_relative_path(
                Path::new(artifact),
                &format!("check {} artifact path", check.id),
            )?;
        }
        for operation in &check.applies_to {
            if !operation_names.contains(operation.as_str())
                && !profile.operations.contains_key(operation)
            {
                return profile_error(format!(
                    "check {} applies to unknown operation {}",
                    check.id, operation
                ));
            }
        }
        if check.retry_policy.max_attempts == 0
            && (!check.retry_policy.transient_exit_codes.is_empty()
                || !check.retry_policy.backoff_seconds.is_empty())
        {
            return profile_error(format!(
                "check {} defines retry details with max_attempts 0",
                check.id
            ));
        }
    }
    Ok(())
}

fn validate_dynamic_command_source(
    profile: &CompiledProfile,
    check: &CheckDef,
    source: &DynamicCommandSourceDef,
) -> Result<()> {
    if validate_dynamic_field_syntax(&source.field).is_err() {
        return profile_error(format!(
            "check {} command_source has malformed field {}",
            check.id, source.field
        ));
    }
    validate_dynamic_role(&source.role, &check.id, "command_source")?;
    match source.kind {
        DynamicSourceKind::Node => {
            if source.role == "ticket" {
                return profile_error(format!(
                    "check {} node command_source role ticket is reserved for the virtual ticket",
                    check.id
                ));
            }
            if source.node_types.is_empty()
                || (source.gate_policy.is_none() && source.selection.is_none())
                || (source.gate_policy.is_some() && source.selection.is_some())
            {
                return profile_error(format!(
                    "check {} node command_source requires nonempty node_types and exactly one of selection or gate_policy",
                    check.id
                ));
            }
            let unique = source.node_types.iter().collect::<BTreeSet<_>>();
            if unique.len() != source.node_types.len()
                || source
                    .node_types
                    .iter()
                    .any(|node_type| node_type.trim().is_empty())
            {
                return profile_error(format!(
                    "check {} node command_source requires unique nonempty node_types",
                    check.id
                ));
            }
            validate_known_node_types(
                profile,
                &source.node_types,
                &format!("check {} command_source", check.id),
            )?;
            if let Some(policy_id) = &source.gate_policy {
                let policy = profile.gate_policies.get(policy_id).ok_or_else(|| {
                    KoniError::Profile(format!(
                        "check {} command_source references unknown gate policy {}",
                        check.id, policy_id
                    ))
                })?;
                if source.node_types.iter().collect::<BTreeSet<_>>()
                    != policy.candidate_node_types.iter().collect::<BTreeSet<_>>()
                {
                    return profile_error(format!(
                        "check {} command_source node_types must exactly match gate policy {} candidate_node_types",
                        check.id, policy_id
                    ));
                }
            }
        }
        DynamicSourceKind::Ticket => {
            if source.selection.is_some()
                || !source.node_types.is_empty()
                || source.gate_policy.is_some()
            {
                return profile_error(format!(
                    "check {} ticket command_source may not configure selection or node_types",
                    check.id
                ));
            }
        }
    }
    Ok(())
}

fn validate_dynamic_result(check: &CheckDef, result: &DynamicResultDef) -> Result<()> {
    if result.required_keys.is_none() && result.result_path.is_none() && result.artifacts.is_none()
    {
        return profile_error(format!(
            "check {} dynamic_result must configure required_keys, result_path, or artifacts",
            check.id
        ));
    }
    let command_role = check
        .command_source
        .as_ref()
        .map(|source| source.role.as_str());
    let validate_bound_source = |source: &DynamicBoundValueSourceDef, label: &str| -> Result<()> {
        validate_dynamic_role(&source.role, &check.id, label)?;
        if command_role.is_none_or(|role| source.role != role && source.role != "ticket") {
            return profile_error(format!(
                "check {} {label} role {} is not the bound command role or ticket",
                check.id, source.role
            ));
        }
        if validate_dynamic_field_syntax(&source.field).is_err() {
            return profile_error(format!(
                "check {} {label} has malformed field {}",
                check.id, source.field
            ));
        }
        Ok(())
    };
    let validate_path_authorities = |authorities: &[DynamicPathAuthorityDef],
                                     label: &str|
     -> Result<()> {
        if authorities.is_empty() {
            return profile_error(format!(
                "check {} {label} requires at least one path authority",
                check.id
            ));
        }
        if authorities.iter().collect::<BTreeSet<_>>().len() != authorities.len() {
            return profile_error(format!(
                "check {} {label} path authorities must not contain duplicates",
                check.id
            ));
        }
        for authority in authorities {
            let valid = matches!(
                (authority.authority, authority.provenance),
                (
                    TicketPathAuthority::ReadPaths,
                    DynamicPathProvenance::ReadEvidence
                ) | (
                    TicketPathAuthority::WritePaths,
                    DynamicPathProvenance::ProducedOutput
                )
            );
            if !valid {
                return profile_error(format!(
                    "check {} {label} must pair read_paths with read_evidence or write_paths with produced_output",
                    check.id
                ));
            }
        }
        Ok(())
    };

    if check.command_source.is_none() {
        return profile_error(format!(
            "check {} dynamic_result requires command_source so projected values are bound to an exact candidate",
            check.id
        ));
    }
    if let Some(required) = &result.required_keys {
        validate_bound_source(&required.source, "dynamic_result required_keys source")?;
        if validate_dynamic_field_syntax(&required.actual_field).is_err() {
            return profile_error(format!(
                "check {} dynamic_result required_keys has malformed actual_field {}",
                check.id, required.actual_field
            ));
        }
        if !check
            .required_result_fields
            .iter()
            .any(|field| field == &required.actual_field)
        {
            return profile_error(format!(
                "check {} dynamic_result required_keys actual_field {} must be a required_result_field",
                check.id, required.actual_field
            ));
        }
    }
    if let Some(result_path) = &result.result_path {
        validate_bound_source(&result_path.source, "dynamic_result result_path")?;
        validate_path_authorities(&result_path.path_authorities, "dynamic_result result_path")?;
    }
    if let Some(artifacts) = &result.artifacts {
        if validate_dynamic_field_syntax(&artifacts.field).is_err() {
            return profile_error(format!(
                "check {} dynamic_result artifacts has malformed field {}",
                check.id, artifacts.field
            ));
        }
        if !check
            .required_result_fields
            .iter()
            .any(|field| field == &artifacts.field)
        {
            return profile_error(format!(
                "check {} dynamic_result artifacts field {} must be a required_result_field",
                check.id, artifacts.field
            ));
        }
        if !artifacts.allow_path_strings && artifacts.path_field.is_none() {
            return profile_error(format!(
                "check {} dynamic_result artifacts must allow path strings or configure path_field",
                check.id
            ));
        }
        if let Some(path_field) = &artifacts.path_field
            && validate_dynamic_field_syntax(path_field).is_err()
        {
            return profile_error(format!(
                "check {} dynamic_result artifacts has malformed path_field {}",
                check.id, path_field
            ));
        }
        validate_path_authorities(&artifacts.path_authorities, "dynamic_result artifacts")?;
    }
    Ok(())
}

fn validate_dynamic_role(role: &str, check_id: &str, label: &str) -> Result<()> {
    let mut characters = role.chars();
    let starts_valid = characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_');
    if !starts_valid
        || !characters
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return profile_error(format!(
            "check {check_id} {label} role must be a nonempty identifier"
        ));
    }
    Ok(())
}

fn validate_dynamic_field_syntax(field: &str) -> std::result::Result<(), ()> {
    if field.trim() != field
        || field.is_empty()
        || field
            .chars()
            .any(|character| character == '\0' || character.is_whitespace())
    {
        return Err(());
    }
    let mut bracket_depth = 0_u8;
    let mut segment_has_character = false;
    let mut bracket_has_character = false;
    let mut after_bracket = false;
    for character in field.chars() {
        match character {
            '[' => {
                if bracket_depth != 0 {
                    return Err(());
                }
                bracket_depth = 1;
                bracket_has_character = false;
                after_bracket = false;
            }
            ']' => {
                if bracket_depth != 1 || !bracket_has_character {
                    return Err(());
                }
                bracket_depth = 0;
                after_bracket = true;
            }
            '.' if bracket_depth == 0 => {
                if !segment_has_character {
                    return Err(());
                }
                segment_has_character = false;
                after_bracket = false;
            }
            _ if bracket_depth == 1 => bracket_has_character = true,
            _ if after_bracket => return Err(()),
            _ if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') => {
                segment_has_character = true;
            }
            _ => return Err(()),
        }
    }
    if bracket_depth == 0 && segment_has_character {
        Ok(())
    } else {
        Err(())
    }
}

fn validate_personas(profile: &CompiledProfile) -> Result<()> {
    for persona in profile.personas.values() {
        if let Some(prompt) = &persona.prompt {
            validate_relative_path(prompt, &format!("persona {} prompt", persona.id))?;
            let prompt = profile.root.join(prompt);
            if !prompt.is_file() {
                return Err(KoniError::NotFound(format!(
                    "persona {} prompt {}",
                    persona.id,
                    prompt.display()
                )));
            }
        } else if persona.codex_agent.is_none() {
            return profile_error(format!(
                "persona {} must define prompt or codex_agent",
                persona.id
            ));
        }
        if persona
            .codex_agent
            .as_deref()
            .is_some_and(|name| name.trim().is_empty())
        {
            return profile_error(format!(
                "persona {} codex_agent must not be empty",
                persona.id
            ));
        }
        let resolved = profile.resolve_persona_def(persona)?;
        let mut unique_skills = BTreeSet::new();
        for skill in &persona.skills {
            if skill.trim().is_empty() {
                return profile_error(format!(
                    "persona {} skill name must not be empty",
                    persona.id
                ));
            }
            if !unique_skills.insert(skill) {
                return profile_error(format!(
                    "persona {} references Codex skill {skill} more than once",
                    persona.id
                ));
            }
            if profile.native_codex.skill(skill).is_none() {
                return profile_error(format!(
                    "persona {} references unknown Codex skill {skill}",
                    persona.id
                ));
            }
        }
        if resolved.sandbox.mode.trim().is_empty()
            || resolved.sandbox.approval_policy.trim().is_empty()
        {
            return profile_error(format!(
                "persona {} sandbox mode/policy must not be empty",
                persona.id
            ));
        }
        if !matches!(
            resolved.sandbox.mode.as_str(),
            "read-only" | "workspace-write" | "danger-full-access"
        ) {
            return profile_error(format!(
                "persona {} uses unsupported Codex sandbox mode {}",
                persona.id, resolved.sandbox.mode
            ));
        }
        if !matches!(
            resolved.sandbox.approval_policy.as_str(),
            "never" | "on-request" | "on-failure" | "untrusted"
        ) {
            return profile_error(format!(
                "persona {} uses unsupported Codex approval policy {}",
                persona.id, resolved.sandbox.approval_policy
            ));
        }
        for root in &resolved.sandbox.writable_roots {
            if matches!(root.as_str(), "git_metadata" | "main_git_metadata") {
                return profile_error(format!(
                    "persona {} writable root {root} is forbidden; Git metadata is compiler-only authority",
                    persona.id
                ));
            }
            if matches!(root.as_str(), "project_root" | "ticket_worktree") {
                continue;
            }
            let root_path = Path::new(root);
            validate_relative_path(root_path, &format!("persona {} writable root", persona.id))?;
            if root_path.components().next().is_some_and(
                |component| matches!(component, Component::Normal(name) if name == ".git"),
            ) {
                return profile_error(format!(
                    "persona {} writable root {root} is forbidden; .git is compiler-only authority",
                    persona.id
                ));
            }
        }
        if resolved.sandbox.approval_policy == "never"
            && !resolved.sandbox.writable_roots.is_empty()
        {
            return profile_error(format!(
                "autonomous persona {} may not declare extra writable roots; its compiler-issued worktree is the complete write boundary",
                persona.id
            ));
        }
    }
    Ok(())
}

fn validate_reports(profile: &CompiledProfile) -> Result<()> {
    let symbols = profile
        .expression_symbols()
        .with_variable("row", ValueType::Json)
        .with_variable("node", ValueType::Node)
        .with_variable("ticket", ValueType::Ticket)
        .with_variable("receipt", ValueType::Receipt);
    for report in profile.reports.values() {
        if report.formats.is_empty() {
            return profile_error(format!("report {} requires at least one format", report.id));
        }
        validate_relative_path(&report.output, &format!("report {} output", report.id))?;
        let mut columns = BTreeSet::new();
        for column in &report.columns {
            if !columns.insert(&column.id) {
                return profile_error(format!(
                    "report {} has duplicate column {}",
                    report.id, column.id
                ));
            }
        }
        if let Some(filter) = &report.filter {
            filter
                .validate(&symbols)
                .map_err(|error| profile_expr_error("report", &report.id, error))?;
        }
    }
    Ok(())
}

fn validate_views(profile: &CompiledProfile) -> Result<()> {
    let symbols = profile
        .expression_symbols()
        .with_variable("row", ValueType::Json)
        .with_variable("node", ValueType::Node)
        .with_variable("ticket", ValueType::Ticket)
        .with_variable("receipt", ValueType::Receipt);
    for view in profile.views.values() {
        if view.kind.trim().is_empty() {
            return profile_error(format!("view {} has an empty kind", view.id));
        }
        let mut columns = BTreeSet::new();
        for column in &view.columns {
            if !columns.insert(&column.id) {
                return profile_error(format!(
                    "view {} has duplicate column {}",
                    view.id, column.id
                ));
            }
        }
        if let Some(filter) = &view.filter {
            filter
                .validate(&symbols)
                .map_err(|error| profile_expr_error("view", &view.id, error))?;
        }
        for action in &view.actions {
            if profile.action(action).is_none() {
                return profile_error(format!(
                    "view {} references unknown action {}",
                    view.id, action
                ));
            }
        }
    }
    Ok(())
}

fn validate_state_machines(profile: &CompiledProfile) -> Result<()> {
    for machine in profile.state_machines.values() {
        let states: BTreeSet<_> = machine.states.iter().collect();
        if states.len() != machine.states.len() || states.is_empty() {
            return profile_error(format!(
                "state machine {} has empty or duplicate states",
                machine.id
            ));
        }
        if !states.contains(&machine.initial) {
            return profile_error(format!(
                "state machine {} initial state {} is unknown",
                machine.id, machine.initial
            ));
        }
        for terminal in &machine.terminal_states {
            if !states.contains(terminal) {
                return profile_error(format!(
                    "state machine {} terminal state {} is unknown",
                    machine.id, terminal
                ));
            }
        }
        let mut transition_ids = BTreeSet::new();
        for transition in &machine.transitions {
            if !transition_ids.insert(&transition.id) {
                return profile_error(format!(
                    "state machine {} has duplicate transition {}",
                    machine.id, transition.id
                ));
            }
            if transition.from.is_empty()
                || transition.from.iter().any(|state| !states.contains(state))
            {
                return profile_error(format!(
                    "state machine {} transition {} has unknown/empty from states",
                    machine.id, transition.id
                ));
            }
            if !states.contains(&transition.to) {
                return profile_error(format!(
                    "state machine {} transition {} has unknown destination {}",
                    machine.id, transition.id, transition.to
                ));
            }
            if let Some(guard) = &transition.guard {
                let symbols = profile
                    .expression_symbols()
                    .with_variable("record", ValueType::Json)
                    .with_variable("ticket", ValueType::Ticket);
                guard
                    .validate(&symbols)
                    .map_err(|error| profile_expr_error("state machine", &machine.id, error))?;
                return profile_error(format!(
                    "state machine {} transition {} uses a guard, but ticket-record guard evaluation is not implemented; refusing to compile ignored lifecycle policy",
                    machine.id, transition.id
                ));
            }
        }
    }
    let uses_change_control = profile
        .operations
        .values()
        .any(|operation| !OperationChangeControlDef::is_default(&operation.change_control));
    if uses_change_control {
        let machine = profile.state_machines.get("ticket").ok_or_else(|| {
            KoniError::Profile("typed change control requires a ticket state machine".to_owned())
        })?;
        let config = &profile.manifest.change_control;
        for (role, state) in [
            ("awaiting_approval_state", &config.awaiting_approval_state),
            ("held_source_state", &config.held_source_state),
        ] {
            if !machine.states.contains(state) || machine.terminal_states.contains(state) {
                return profile_error(format!(
                    "change_control.{role} {state} must name a nonterminal ticket state"
                ));
            }
        }
        if config.awaiting_approval_state == config.held_source_state
            || config.awaiting_approval_state == machine.initial
            || config.held_source_state == machine.initial
        {
            return profile_error(
                "change-control awaiting, held-source, and initial ticket states must be distinct"
                    .to_owned(),
            );
        }
        let compiler_transition = |from: &str, to: &str| {
            machine.transitions.iter().any(|transition| {
                transition.from.iter().any(|state| state == from)
                    && transition.to == to
                    && (transition.actors.is_empty()
                        || transition.actors.iter().any(|actor| actor == "compiler"))
            })
        };
        let terminal = machine.terminal_states.first().ok_or_else(|| {
            KoniError::Profile("typed change control requires a terminal ticket state".to_owned())
        })?;
        if !compiler_transition(&config.awaiting_approval_state, &machine.initial)
            || !compiler_transition(&config.awaiting_approval_state, terminal)
            || !compiler_transition(&config.held_source_state, &machine.initial)
            || !machine.transitions.iter().any(|transition| {
                transition.to == config.held_source_state
                    && (transition.actors.is_empty()
                        || transition.actors.iter().any(|actor| actor == "compiler"))
            })
        {
            return profile_error(
                "typed change control requires compiler transitions awaiting-approval -> initial/terminal, active -> held-source, and held-source -> initial"
                    .to_owned(),
            );
        }
    }
    Ok(())
}

fn validate_known_node_types(
    profile: &CompiledProfile,
    types: &[String],
    label: &str,
) -> Result<()> {
    for node_type in types {
        if !profile.node_types.contains_key(node_type) {
            return profile_error(format!("{label} references unknown node type {node_type}"));
        }
    }
    Ok(())
}

fn profile_expr_error(owner: &str, id: &str, error: String) -> KoniError {
    KoniError::Profile(format!("{owner} {id} expression: {error}"))
}

fn profile_error<T>(message: String) -> Result<T> {
    Err(KoniError::Profile(message))
}

#[derive(Serialize)]
struct ProfileHashInput<'a> {
    manifest: &'a ProfileManifest,
    node_types: &'a IndexMap<String, NodeTypeDef>,
    edge_types: &'a [EdgeTypeDef],
    gate_policies: &'a IndexMap<String, GatePolicyDef>,
    queries: &'a IndexMap<String, QueryDef>,
    rules: &'a IndexMap<String, RuleDef>,
    operations: &'a IndexMap<String, OperationDef>,
    workflows: &'a IndexMap<String, WorkflowDef>,
    actions: &'a IndexMap<String, ActionDef>,
    checks: &'a IndexMap<String, CheckDef>,
    personas: &'a IndexMap<String, PersonaDef>,
    persona_prompts: BTreeMap<String, String>,
    native_resources: BTreeMap<String, String>,
    reports: &'a IndexMap<String, ReportDef>,
    views: &'a IndexMap<String, ViewDef>,
    state_machines: &'a IndexMap<String, StateMachineDef>,
}

fn profile_hash(profile: &CompiledProfile) -> Result<String> {
    let mut persona_prompts = BTreeMap::new();
    let mut native_resources = BTreeMap::new();
    if let Some(config) = &profile.native_codex.project_config {
        native_resources.insert("project-config".to_owned(), config.hash.clone());
    }
    for (id, persona) in &profile.personas {
        if let Some(prompt) = &persona.prompt {
            let path = profile.root.join(prompt);
            let contents = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
            persona_prompts.insert(id.clone(), contents);
        }
        if let Some(agent_name) = &persona.codex_agent {
            let agent = profile.native_codex.agent(agent_name).ok_or_else(|| {
                KoniError::Profile(format!(
                    "persona {id} references unknown Codex custom agent {agent_name}"
                ))
            })?;
            native_resources.insert(
                format!("persona:{id}:agent:{agent_name}"),
                agent.hash.clone(),
            );
        }
        for skill_name in &persona.skills {
            let skill = profile.native_codex.skill(skill_name).ok_or_else(|| {
                KoniError::Profile(format!(
                    "persona {id} references unknown Codex skill {skill_name}"
                ))
            })?;
            native_resources.insert(
                format!("persona:{id}:skill:{skill_name}"),
                skill.hash.clone(),
            );
        }
    }
    let input = ProfileHashInput {
        manifest: &profile.manifest,
        node_types: &profile.node_types,
        edge_types: &profile.edge_types,
        gate_policies: &profile.gate_policies,
        queries: &profile.queries,
        rules: &profile.rules,
        operations: &profile.operations,
        workflows: &profile.workflows,
        actions: &profile.actions,
        checks: &profile.checks,
        personas: &profile.personas,
        persona_prompts,
        native_resources,
        reports: &profile.reports,
        views: &profile.views,
        state_machines: &profile.state_machines,
    };
    // Keep the public Result boundary even though every IR node derives Serialize.
    serde_json::to_value(&input)
        .map_err(|error| KoniError::Profile(format!("could not hash profile: {error}")))?;
    Ok(normalized_hash(&input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    fn manifest() -> &'static str {
        r#"
schema_version = "1.0"
engine = ">=0.1,<0.2"

[profile]
id = "fixture"
version = "1.0.0"
description = "typed fixture"

[storage]
backend = "tracked"
graph_dir = "program/graph"
tickets_dir = "program/tickets"
state_path = "program/state.yaml"
work_dir = "program/work"
receipts_dir = "program/receipts"
reports_dir = "program/reports"

[imports]
graph = ["module.yaml"]
"#
    }

    fn yaml_manifest() -> &'static str {
        r#"
schema_version: "1.0"
engine: ">=0.1,<0.2"
profile:
  id: fixture-yaml
  version: 1.0.0
  description: typed YAML fixture
storage:
  backend: tracked
  graph_dir: program/graph
  tickets_dir: program/tickets
  state_path: program/state.yaml
  work_dir: program/work
  receipts_dir: program/receipts
  reports_dir: program/reports
imports:
  graph: [module.yaml]
"#
    }

    fn valid_module() -> &'static str {
        r#"
node_types:
  - id: system
    description: An architectural boundary whose dependencies and implementation state are tracked by this fixture.
    stage: architecture
    required_any: [[name]]
    statuses: [draft, active, satisfied]
    semantic_fields: [name]
    compiler_owned_fields: [readiness]

edge_types:
  - source: system
    relation: depends_on
    targets: [system]
    acyclic: true

queries:
  - id: active_systems
    node_types: [system]
    status_excluding: [satisfied]

rules:
  - id: system.dependencies
    phase: architecture
    for_each: active_systems
    when:
      op: edge_count
      subject: $target
      relation: depends_on
      exact: 0
    derive:
      - kind: obligation
        key: system.dependencies
        severity: blocking

operations:
  - id: architecture.system.implement
    operation: implement
    stage: architecture
    target_types: [system]
    workflow: implement-system
    allowed_existing_node_types: [system]
    review_contract: reviewed change
    output_contract: scoped patch
    ranking_hints: [stage, target]
    checks: [unit]

workflows:
  - id: implement-system
    applies_to: [implement]
    steps:
      - id: work
        persona: coder
        expected_output: scoped patch
        validation_action: compile
        checks: [unit]

actions:
  - id: recover
    recipe:
      - primitive: profile.validate
  - id: compile
    aliases: [compile-full]
    recipe:
      - primitive: project.validate
      - primitive: rules.evaluate
      - primitive: project.validate
      - primitive: git.commit
    recovery: recover

checks:
  - id: unit
    kind: command
    applies_to: [implement]
    argv: [cargo, test]
    cwd: .
    timeout_seconds: 60
    receipt_type: test

personas:
  - id: coder
    prompt: personas/coder.md
    model_role: ticket_worker
    sandbox:
      mode: workspace-write
      approval_policy: never
      network_access: false

reports:
  - id: board
    title: Board
    formats: [json]
    source: tickets
    output: program/reports/board

state_machines:
  - id: ticket
    initial: todo
    states: [todo, in_progress, closed]
    terminal_states: [closed]
    transitions:
      - id: start
        from: [todo]
        to: in_progress
      - id: finish
        from: [in_progress]
        to: closed
"#
    }

    fn module_with_path_scopes(scopes: &str) -> String {
        let scopes = scopes
            .lines()
            .map(|line| format!("      {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let rule = format!(
            r#"
  - id: system.path-scope
    phase: architecture
    for_each: active_systems
    when: true
    emit:
      operation: implement
      registry_entry_id: architecture.system.implement
      source_state: system-unscoped
      target_state: system-scoped
      target_nodes: $target
      read_scope: $target
      write_scope: $target
{scopes}
"#
        );
        valid_module().replace("\noperations:", &format!("{rule}\noperations:"))
    }

    fn module_with_review_effects() -> String {
        valid_module()
            .replace(
                "    compiler_owned_fields: [readiness]\n",
                "    compiler_owned_fields: [readiness, spec.acceptance, spec.accepted_by]\n    fields:\n      name: {type: string}\n      acceptance: {type: string}\n      accepted_by: {type: string}\n      target_ref: {type: node_ref}\n      target_refs: {type: list, items: {type: node_ref}}\n      dispositions: {type: object}\n",
            )
            .replace(
                "    ranking_hints: [stage, target]\n",
                r#"    ranking_hints: [stage, target]
    review_effects:
      - id: accept-system
        verdict: passed
        select:
          node_types: [system]
          predicate: {field: spec.acceptance, op: absent}
        count: {exact: 1}
        preconditions:
          - {field: spec.accepted_by, op: absent}
        coverage:
          - id: exact-target-ref
            required: $target
            actual: {kind: field_value, field: spec.target_ref}
          - id: exact-target-refs
            required: $target
            actual: {kind: field_values, field: spec.target_refs}
          - id: exact-dispositions
            required: $target
            actual: {kind: object_keys, field: spec.dispositions, allowed_values: [accepted]}
          - id: exact-dependencies
            required: $target
            actual: {kind: outgoing_relation, relation: depends_on}
        set:
          spec.acceptance: accepted
          spec.accepted_by: "$actor"
"#,
            )
            .replace(
                "        checks: [unit]\n\nactions:",
                "        checks: [unit]\n      - id: review\n        kind: review\n        persona: reviewer\n        depends_on: [work]\n        validation_action: review\n\nactions:",
            )
            .replace(
                "  - id: recover\n",
                "  - id: review\n    recipe:\n      - primitive: review.record\n\n  - id: recover\n",
            )
            .replace(
                "\nreports:\n",
                "\n  - id: reviewer\n    prompt: personas/coder.md\n    model_role: reviewer\n    sandbox:\n      mode: read-only\n      approval_policy: never\n      network_access: false\n\nreports:\n",
            )
    }

    fn module_with_filesystem_manifest() -> String {
        valid_module().replace(
            "    compiler_owned_fields: [readiness]\n",
            r#"    compiler_owned_fields: [readiness, asset_manifest]
    filesystem_manifest:
      root_field: spec.implementation_plan.root
      implementation_contract_field: spec.implementation
      implementation_kind_field: spec.implementation.kind
      implementation_entrypoints_field: spec.implementation.entrypoints
      output_field: asset_manifest
      allowed_root_prefixes: [artifacts]
      scan:
        ignored_file_names: [manifest.yaml]
        ignored_path_components: [__pycache__]
        ignored_suffixes: [.pyc]
        ignored_path_prefixes: [scratch]
        symlinks: reject
      source:
        field: spec.source_strategy
        external_values: [external, downloaded]
        vendor:
          path_fields: [spec.vendor.paths]
          blocked_reason_fields: [spec.vendor.blocked_reason]
    fields:
      name: {type: string}
      implementation_plan:
        type: object
        properties:
          root: {type: path}
      implementation:
        type: object
        properties:
          kind: {type: string}
          entrypoints: {type: list, items: {type: path}}
      source_strategy: {type: string}
      vendor:
        type: object
        properties:
          paths: {type: list, items: {type: path}}
          blocked_reason: {type: string}
"#,
        )
    }

    fn module_with_structured_dynamic_check() -> String {
        valid_module().replace(
            "\npersonas:\n",
            r#"
  - id: dynamic-contract
    kind: command
    applies_to: [implement]
    command_source:
      kind: node
      selection: read_scope
      node_types: [system]
      role: candidate
      field: spec.contracts[$target.id].command
    cwd: .
    result_protocol: fixture.result.v1
    required_result_fields: [measurements, artifacts]
    dynamic_result:
      required_keys:
        source: {role: candidate, field: 'spec.contracts[$target.id].required_measurements'}
        actual_field: measurements
        relation: exact
      result_path:
        role: ticket
        field: result_path
        path_authorities:
          - {authority: write_paths, provenance: produced_output}
      artifacts:
        field: artifacts
        allow_path_strings: true
        path_field: path
        path_authorities:
          - {authority: read_paths, provenance: read_evidence}
          - {authority: write_paths, provenance: produced_output}
    artifact_paths: [artifacts/static.json]
    receipt_type: dynamic.receipt

personas:
"#,
        )
    }

    fn fixture(module: &str) -> TempDir {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("koni.toml"), manifest());
        write(&temp.path().join("module.yaml"), module);
        write(
            &temp.path().join("personas/coder.md"),
            "You are a bounded coder.\n",
        );
        temp
    }

    fn automatic_gate_profile() -> CompiledProfile {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../profiles/research");
        let mut profile = ProfileCompiler::compile(&root).unwrap();
        profile
            .gate_policies
            .get_mut("research-capability-gates")
            .unwrap()
            .auto_evaluate = Some(GateAutoEvaluateDef {
            check: "gate-verifier".to_owned(),
            boundaries: vec![GateCompileBoundary::Full, GateCompileBoundary::Scoped],
        });
        profile
    }

    #[test]
    fn persona_writable_roots_cannot_grant_git_authority() {
        for forbidden in ["git_metadata", "main_git_metadata", ".git", ".git/koni"] {
            let module = valid_module().replace(
                "      network_access: false\n",
                &format!("      network_access: false\n      writable_roots: [{forbidden}]\n"),
            );
            let temp = fixture(&module);
            let error = ProfileCompiler::compile(temp.path())
                .expect_err("Git authority must remain compiler-only")
                .to_string();
            assert!(
                error.contains("compiler-only authority"),
                "{forbidden}: {error}"
            );
        }
    }

    #[test]
    fn autonomous_personas_cannot_add_project_or_extra_writable_roots() {
        for forbidden in ["project_root", "ticket_worktree", "scratch"] {
            let module = valid_module().replace(
                "      network_access: false\n",
                &format!("      network_access: false\n      writable_roots: [{forbidden}]\n"),
            );
            let temp = fixture(&module);
            let error = ProfileCompiler::compile(temp.path())
                .expect_err("autonomous write authority must be exactly one worktree")
                .to_string();
            assert!(
                error.contains("may not declare extra writable roots"),
                "{error}"
            );
        }
    }

    fn automatic_gate_validation_error(
        base: &CompiledProfile,
        mutate: fn(&mut CheckDef),
    ) -> String {
        let mut profile = base.clone();
        mutate(profile.checks.get_mut("gate-verifier").unwrap());
        validate_gate_policies(&profile)
            .expect_err("unsafe automatic gate check must fail closed")
            .to_string()
    }

    #[test]
    fn automatic_gate_check_accepts_only_ticket_independent_read_only_input_validation() {
        let mut profile = automatic_gate_profile();
        let check = profile.checks.get_mut("gate-verifier").unwrap();
        check.dynamic_result = Some(DynamicResultDef {
            required_keys: Some(DynamicRequiredKeysDef {
                source: DynamicBoundValueSourceDef {
                    role: "asset".to_owned(),
                    field: "spec.required_measurements".to_owned(),
                },
                actual_field: "measurements".to_owned(),
                relation: KeySetRelation::Superset,
            }),
            result_path: None,
            artifacts: None,
        });

        validate_gate_policies(&profile).unwrap();
        validate_checks(&profile).unwrap();
    }

    type CheckMutationCase = (&'static str, fn(&mut CheckDef), &'static str);

    #[test]
    fn automatic_gate_check_rejects_ticket_or_nonpolicy_command_resolution() {
        let base = automatic_gate_profile();
        let cases: Vec<CheckMutationCase> = vec![
            (
                "static argv",
                |check| {
                    check.command_source = None;
                    check.argv = vec!["true".to_owned()];
                },
                "must use a node command_source with gate_policy research-capability-gates",
            ),
            (
                "argv_from",
                |check| {
                    check.command_source = None;
                    check.argv_from = Some(Value::String("ticket.command".to_owned()));
                },
                "may not use argv or argv_from",
            ),
            (
                "different gate policy",
                |check| {
                    check.command_source.as_mut().unwrap().gate_policy =
                        Some("other-policy".to_owned());
                },
                "must use a node command_source with gate_policy research-capability-gates",
            ),
            (
                "ticket command source",
                |check| {
                    let source = check.command_source.as_mut().unwrap();
                    source.kind = DynamicSourceKind::Ticket;
                    source.role = "ticket".to_owned();
                },
                "must use a node command_source with gate_policy research-capability-gates",
            ),
            (
                "ticket role",
                |check| {
                    check.command_source.as_mut().unwrap().role = "ticket".to_owned();
                },
                "must not depend on the ticket role",
            ),
            (
                "ticket field variable",
                |check| {
                    check.command_source.as_mut().unwrap().field =
                        "spec.gate_contracts[$ticket.id].command".to_owned();
                },
                "must not depend on the ticket role or $ticket command variables",
            ),
            (
                "ticket dynamic result source",
                |check| {
                    check.dynamic_result = Some(DynamicResultDef {
                        required_keys: Some(DynamicRequiredKeysDef {
                            source: DynamicBoundValueSourceDef {
                                role: "ticket".to_owned(),
                                field: "runtime_contract.required_measurements".to_owned(),
                            },
                            actual_field: "measurements".to_owned(),
                            relation: KeySetRelation::Exact,
                        }),
                        result_path: None,
                        artifacts: None,
                    });
                },
                "dynamic sources must use selected winner role asset and no $ticket variables",
            ),
            (
                "ticket variable in candidate dynamic source",
                |check| {
                    check.dynamic_result = Some(DynamicResultDef {
                        required_keys: Some(DynamicRequiredKeysDef {
                            source: DynamicBoundValueSourceDef {
                                role: "asset".to_owned(),
                                field: "spec.required[$ticket.id]".to_owned(),
                            },
                            actual_field: "measurements".to_owned(),
                            relation: KeySetRelation::Exact,
                        }),
                        result_path: None,
                        artifacts: None,
                    });
                },
                "no $ticket variables",
            ),
            (
                "unknown candidate alias role",
                |check| {
                    check.dynamic_result = Some(DynamicResultDef {
                        required_keys: Some(DynamicRequiredKeysDef {
                            source: DynamicBoundValueSourceDef {
                                role: "candidate".to_owned(),
                                field: "spec.required".to_owned(),
                            },
                            actual_field: "measurements".to_owned(),
                            relation: KeySetRelation::Exact,
                        }),
                        result_path: None,
                        artifacts: None,
                    });
                },
                "selected winner role asset",
            ),
            (
                "ticket variable in environment",
                |check| {
                    check
                        .environment
                        .set
                        .insert("KONI_TICKET".to_owned(), "${ticket.id}".to_owned());
                },
                "must not depend on the ticket role",
            ),
        ];

        for (label, mutate, expected) in cases {
            let error = automatic_gate_validation_error(&base, mutate);
            assert!(error.contains(expected), "{label}: {error}");
        }
    }

    #[test]
    fn automatic_gate_check_rejects_outputs_artifacts_and_write_authority() {
        let base = automatic_gate_profile();
        let read_authority = DynamicPathAuthorityDef {
            authority: TicketPathAuthority::ReadPaths,
            provenance: DynamicPathProvenance::ReadEvidence,
        };
        let produced_authority = DynamicPathAuthorityDef {
            authority: TicketPathAuthority::WritePaths,
            provenance: DynamicPathProvenance::ProducedOutput,
        };

        let mut result_path = base.clone();
        result_path
            .checks
            .get_mut("gate-verifier")
            .unwrap()
            .dynamic_result = Some(DynamicResultDef {
            required_keys: None,
            result_path: Some(DynamicResultPathDef {
                source: DynamicBoundValueSourceDef {
                    role: "asset".to_owned(),
                    field: "spec.result_path".to_owned(),
                },
                path_authorities: vec![read_authority.clone()],
            }),
            artifacts: None,
        });
        let error = validate_gate_policies(&result_path)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("must not configure dynamic result_path or artifacts"),
            "{error}"
        );

        let mut artifacts = base.clone();
        artifacts
            .checks
            .get_mut("gate-verifier")
            .unwrap()
            .dynamic_result = Some(DynamicResultDef {
            required_keys: None,
            result_path: None,
            artifacts: Some(ResultArtifactPolicyDef {
                field: "artifacts".to_owned(),
                allow_path_strings: true,
                path_field: None,
                path_authorities: vec![read_authority],
            }),
        });
        let error = validate_gate_policies(&artifacts).unwrap_err().to_string();
        assert!(
            error.contains("must not configure dynamic result_path or artifacts"),
            "{error}"
        );

        let mut produced = base.clone();
        produced
            .checks
            .get_mut("gate-verifier")
            .unwrap()
            .dynamic_result = Some(DynamicResultDef {
            required_keys: None,
            result_path: Some(DynamicResultPathDef {
                source: DynamicBoundValueSourceDef {
                    role: "asset".to_owned(),
                    field: "spec.result_path".to_owned(),
                },
                path_authorities: vec![produced_authority],
            }),
            artifacts: None,
        });
        let error = validate_gate_policies(&produced).unwrap_err().to_string();
        assert!(
            error.contains("must not use produced_output path authorities"),
            "{error}"
        );

        let cases: Vec<CheckMutationCase> = vec![
            (
                "argv input bindings",
                |check| {
                    check.argv_input_bindings = Some(ArgvInputBindingsDef {
                        from: "spec.inputs".to_owned(),
                        path_field: "path".to_owned(),
                        required_fields: vec!["path".to_owned()],
                        require_nonempty: true,
                        require_project_file: true,
                        require_exact_argument: true,
                    });
                },
                "must not configure argv_input_bindings",
            ),
            (
                "static artifact paths",
                |check| check.artifact_paths = vec!["results/output.json".to_owned()],
                "must not configure artifact_paths",
            ),
            (
                "workspace write",
                |check| check.effect = ProcessEffect::WorkspaceWrite,
                "must be a read_only command with allow_nonpassing_receipt",
            ),
            (
                "external effect",
                |check| check.effect = ProcessEffect::External,
                "must be a read_only command with allow_nonpassing_receipt",
            ),
            (
                "nonpassing receipt disabled",
                |check| check.allow_nonpassing_receipt = false,
                "must be a read_only command with allow_nonpassing_receipt",
            ),
        ];
        for (label, mutate, expected) in cases {
            let error = automatic_gate_validation_error(&base, mutate);
            assert!(error.contains(expected), "{label}: {error}");
        }
    }

    #[test]
    fn direct_self_query_dependency_fails_closed() {
        let module = valid_module().replace(
            "  - id: active_systems\n    node_types: [system]\n    status_excluding: [satisfied]",
            "  - id: active_systems\n    select: active_systems",
        );
        let error = ProfileCompiler::compile(fixture(&module).path()).unwrap_err();
        assert!(
            error.to_string().contains("query dependency cycle"),
            "{error}"
        );
    }

    fn manifest_with_initialization(initialization: &str) -> String {
        manifest().replace(
            "\n[storage]",
            &format!("\n[initialization]\n{initialization}\n\n[storage]"),
        )
    }

    fn module_with_planning_context(field_type: &str) -> String {
        valid_module().replace(
            "    compiler_owned_fields: [readiness]\n",
            &format!(
                r#"    compiler_owned_fields: [readiness, spec.planning_context]
    fields:
      name: {{type: string}}
      planning_context:
        type: {field_type}
        required: false
        description: The bounded approved plan and resolved decisions for this run.
"#,
            ),
        )
    }

    #[test]
    fn compiles_modular_profile_into_typed_ir() {
        let temp = fixture(valid_module());
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        assert_eq!(profile.manifest.profile.id, "fixture");
        assert_eq!(profile.node_types.len(), 1);
        assert_eq!(profile.edge_types[0].relation, "depends_on");
        assert_eq!(
            profile.operations["architecture.system.implement"].public_operation(),
            "implement"
        );
        assert_eq!(
            profile.operations["architecture.system.implement"].dispatch_priority, 0,
            "omitting dispatch_priority preserves the neutral scheduling default"
        );
        assert!(
            serde_json::to_value(&profile.operations["architecture.system.implement"])
                .unwrap()
                .get("dispatch_priority")
                .is_none(),
            "the neutral priority must not perturb profiles that omit it"
        );
        assert!(
            serde_json::to_value(&profile.operations["architecture.system.implement"])
                .unwrap()
                .get("receipt_coverage")
                .is_none(),
            "an omitted provenance contract must not perturb legacy operation hashes"
        );
        let legacy_check = serde_json::to_value(&profile.checks["unit"]).unwrap();
        assert!(
            legacy_check.get("command_source").is_none()
                && legacy_check.get("dynamic_result").is_none(),
            "omitted structured command fields must not perturb legacy check hashes"
        );
        assert!(
            serde_json::to_value(&profile.operations["architecture.system.implement"])
                .unwrap()
                .get("existing_node_edge_additions_only")
                .is_none(),
            "an omitted edge-only restriction must not perturb legacy operation hashes"
        );
        assert_eq!(profile.action("compile-full").unwrap().id, "compile");
        assert_eq!(
            profile.manifest.reporting.bundle_kind, "report-bundle",
            "profiles that omit reporting metadata remain domain-neutral"
        );
        assert!(
            serde_json::to_value(&profile.manifest)
                .unwrap()
                .get("reporting")
                .is_none(),
            "the neutral reporting default must not perturb already-pinned profile hashes"
        );
        assert_eq!(
            profile.manifest.orchestration.max_boundaries_per_lead, 1,
            "omitted profiles default every durable Lead boundary to a fresh process"
        );
        assert!(
            serde_json::to_value(&profile.manifest.orchestration)
                .unwrap()
                .get("max_boundaries_per_lead")
                .is_none(),
            "the compatibility default must not perturb already-pinned profile hashes"
        );
        assert!(
            serde_json::to_value(&profile.workflows["implement-system"])
                .unwrap()
                .get("review_failure_reopen_from")
                .is_none(),
            "an absent optional rework policy must not perturb pinned profile hashes"
        );
        assert!(
            serde_json::to_value(&profile.operations["architecture.system.implement"])
                .unwrap()
                .get("review_effects")
                .is_none(),
            "omitted review effects must not perturb legacy profile hashes"
        );
        assert!(
            profile
                .manifest
                .initialization
                .planning_context_field
                .is_none(),
            "legacy profiles default the optional planning handoff to disabled"
        );
        assert!(
            serde_json::to_value(&profile.manifest.initialization)
                .unwrap()
                .get("planning_context_field")
                .is_none(),
            "a disabled planning handoff must not perturb legacy profile hashes"
        );
        assert!(profile.hash.starts_with("sha256:"));

        let again = ProfileCompiler::compile(&temp.path().join("koni.toml")).unwrap();
        assert_eq!(profile.hash, again.hash);
    }

    #[test]
    fn operation_dispatch_priority_is_typed_and_profile_hashed() {
        let baseline = fixture(valid_module());
        let baseline = ProfileCompiler::compile(baseline.path()).unwrap();
        let prioritized_module = valid_module().replace(
            "    ranking_hints: [stage, target]\n",
            "    dispatch_priority: 42\n    ranking_hints: [stage, target]\n",
        );
        let prioritized = fixture(&prioritized_module);
        let prioritized = ProfileCompiler::compile(prioritized.path()).unwrap();

        assert_eq!(
            prioritized.operations["architecture.system.implement"].dispatch_priority,
            42
        );
        assert_ne!(baseline.hash, prioritized.hash);
    }

    fn module_with_receipt_coverage() -> String {
        valid_module()
            .replace(
                "    compiler_owned_fields: [readiness]\n",
                r#"    compiler_owned_fields: [readiness]
    fields:
      dispositions: {type: object, required: false}
      receipt_refs: {type: list, required: false, items: {type: string}}
"#,
            )
            .replace(
                "    ranking_hints: [stage, target]\n",
                r#"    ranking_hints: [stage, target]
    receipt_coverage:
      candidate_node_types: [system]
      required_nodes:
        relations: [depends_on]
        direction: outgoing
        min_depth: 1
        max_depth: 1
        node_types: [system]
      candidate_link_relation: depends_on
      coverage: exact
      receipt_type: test
      receipt_statuses: [passed]
      receipt_refs_path: spec.receipt_refs
      disposition_map_path: spec.dispositions
      disposition:
        value_path: disposition
        receipt_id_path: receipt_id
        rationale_path: rationale
        allowed_values: [accepted, rejected]
"#,
            )
    }

    #[test]
    fn validates_and_hashes_configured_receipt_coverage() {
        let baseline = fixture(valid_module());
        let baseline = ProfileCompiler::compile(baseline.path()).unwrap();
        let configured = fixture(&module_with_receipt_coverage());
        let configured = ProfileCompiler::compile(configured.path()).unwrap();
        let contract = configured.operations["architecture.system.implement"]
            .receipt_coverage
            .as_ref()
            .unwrap();
        assert_eq!(contract.coverage, ReceiptCoverageMode::Exact);
        assert_eq!(contract.required_nodes.max_depth, 1);
        assert_ne!(baseline.hash, configured.hash);

        for (from, to, expected) in [
            ("max_depth: 1", "max_depth: 0", "depth must satisfy"),
            (
                "relations: [depends_on]",
                "relations: [missing]",
                "unknown relation missing",
            ),
            (
                "disposition_map_path: spec.dispositions",
                "disposition_map_path: spec.missing",
                "is not declared",
            ),
            (
                "candidate_link_relation: depends_on",
                "candidate_link_relation: missing",
                "does not own relation missing",
            ),
        ] {
            let invalid = fixture(&module_with_receipt_coverage().replace(from, to));
            let error = ProfileCompiler::compile(invalid.path()).unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    #[test]
    fn review_effects_are_typed_validated_and_profile_hashed() {
        let baseline = ProfileCompiler::compile(fixture(valid_module()).path()).unwrap();
        let configured = fixture(&module_with_review_effects());
        let configured = ProfileCompiler::compile(configured.path()).unwrap();
        let effects = &configured.operations["architecture.system.implement"].review_effects;
        assert_eq!(effects.len(), 1);
        assert_eq!(effects[0].id, "accept-system");
        assert_eq!(effects[0].count.exact, Some(1));
        assert_eq!(effects[0].coverage.len(), 4);
        assert_eq!(
            effects[0].coverage[0].actual.kind,
            ReviewEffectCoverageActualKind::FieldValue
        );
        assert_eq!(effects[0].set["spec.accepted_by"], "$actor");
        assert_ne!(baseline.hash, configured.hash);
    }

    #[test]
    fn review_effects_reject_agent_owned_unknown_and_ambiguous_contracts() {
        let valid = module_with_review_effects();
        let cases = [
            (
                valid.replace(
                    "[readiness, spec.acceptance, spec.accepted_by]",
                    "[readiness, spec.accepted_by]",
                ),
                "not explicitly compiler-owned",
            ),
            (
                valid.replace(
                    "spec.accepted_by: \"$actor\"",
                    "spec.accepted_by: \"$unknown\"",
                ),
                "unknown compiler token",
            ),
            (
                valid.replace("field: spec.acceptance", "field: spec.missing"),
                "not declared",
            ),
        ];
        for (index, (module, expected)) in cases.into_iter().enumerate() {
            let configured = fixture(&module);
            let error = ProfileCompiler::compile(configured.path())
                .expect_err("invalid review effect must fail closed")
                .to_string();
            assert!(
                error.contains(expected),
                "case {index} expected {expected:?}, got {error}"
            );
        }

        let ambiguous = valid.replacen(
            "          spec.accepted_by: \"$actor\"\n",
            r#"          spec.accepted_by: "$actor"
      - id: second-system-effect
        verdict: passed
        select: {node_types: [system]}
        count: {exact: 1}
        set: {spec.acceptance: accepted-again}
"#,
            1,
        );
        let configured = fixture(&ambiguous);
        let error = ProfileCompiler::compile(configured.path())
            .expect_err("overlapping selectors must fail closed")
            .to_string();
        assert!(error.contains("ambiguous overlapping selectors"), "{error}");

        for (module, expected) in [
            (
                valid.replace(
                    "actual: {kind: field_value, field: spec.target_ref}",
                    "actual: {kind: field_value, field: spec.target_refs}",
                ),
                "incompatible type",
            ),
            (
                valid.replace("kind: field_values", "kind: object_keys"),
                "incompatible type",
            ),
            (
                valid.replace(
                    "actual: {kind: outgoing_relation, relation: depends_on}",
                    "actual: {kind: outgoing_relation, relation: missing}",
                ),
                "relation missing is not declared",
            ),
            (
                valid.replace(
                    "          - id: exact-target-ref\n",
                    "          - id: exact-target-refs\n",
                ),
                "duplicate coverage contract",
            ),
        ] {
            let configured = fixture(&module);
            let error = ProfileCompiler::compile(configured.path())
                .expect_err("invalid coverage contract must fail closed")
                .to_string();
            assert!(
                error.contains(expected),
                "expected {expected:?}, got {error}"
            );
        }
    }

    #[test]
    fn filesystem_manifests_are_typed_validated_and_profile_hashed() {
        let baseline = ProfileCompiler::compile(fixture(valid_module()).path()).unwrap();
        let configured =
            ProfileCompiler::compile(fixture(&module_with_filesystem_manifest()).path()).unwrap();
        let manifest = configured.node_types["system"]
            .filesystem_manifest
            .as_ref()
            .expect("typed filesystem manifest");
        assert_eq!(manifest.output_field, "asset_manifest");
        assert_eq!(manifest.allowed_root_prefixes, vec!["artifacts"]);
        assert_eq!(manifest.scan.symlinks, FilesystemSymlinkPolicy::Reject);
        assert_ne!(baseline.hash, configured.hash);
    }

    #[test]
    fn filesystem_manifests_reject_invalid_field_and_path_contracts() {
        let valid = module_with_filesystem_manifest();
        for (module, expected) in [
            (
                valid.replace(
                    "root_field: spec.implementation_plan.root",
                    "root_field: spec.missing",
                ),
                "field spec.missing is not declared",
            ),
            (
                valid.replace(
                    "implementation_kind_field: spec.implementation.kind",
                    "implementation_kind_field: spec.source_strategy",
                ),
                "must be children",
            ),
            (
                valid.replace(
                    "compiler_owned_fields: [readiness, asset_manifest]",
                    "compiler_owned_fields: [readiness]",
                ),
                "must be explicitly compiler-owned",
            ),
            (
                valid.replace(
                    "allowed_root_prefixes: [artifacts]",
                    "allowed_root_prefixes: [../outside]",
                ),
                "escape",
            ),
            (
                valid.replace(
                    "path_fields: [spec.vendor.paths]",
                    "path_fields: [spec.vendor]",
                ),
                "vendor path field",
            ),
            (
                valid
                    .replace(
                        "output_field: asset_manifest",
                        "output_field: spec.implementation",
                    )
                    .replace(
                        "compiler_owned_fields: [readiness, asset_manifest]",
                        "compiler_owned_fields: [readiness, spec.implementation]",
                    ),
                "aliases compiler output",
            ),
            (
                valid.replace(
                    "compiler_owned_fields: [readiness, asset_manifest]",
                    "compiler_owned_fields: [readiness, asset_manifest, spec.implementation_plan]",
                ),
                "must not be compiler-owned",
            ),
        ] {
            let error = ProfileCompiler::compile(fixture(&module).path())
                .expect_err("invalid filesystem manifest must fail closed")
                .to_string();
            assert!(
                error.contains(expected),
                "expected {expected:?}, got {error}"
            );
        }
    }

    #[test]
    fn structured_dynamic_checks_are_typed_and_profile_hashed() {
        let module = module_with_structured_dynamic_check();
        let temp = fixture(&module);
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        let check = &profile.checks["dynamic-contract"];
        let source = check.command_source.as_ref().unwrap();
        assert_eq!(source.kind, DynamicSourceKind::Node);
        assert_eq!(source.selection, Some(DynamicNodeSelection::ReadScope));
        assert_eq!(source.node_types, vec!["system"]);
        assert_eq!(source.role, "candidate");
        let dynamic = check.dynamic_result.as_ref().unwrap();
        assert_eq!(
            dynamic.required_keys.as_ref().unwrap().relation,
            KeySetRelation::Exact
        );
        let artifacts = dynamic.artifacts.as_ref().unwrap();
        assert!(artifacts.allow_path_strings);
        assert_eq!(artifacts.path_field.as_deref(), Some("path"));
        assert_eq!(artifacts.path_authorities.len(), 2);

        let changed = fixture(&module.replace("relation: exact", "relation: superset"));
        let changed = ProfileCompiler::compile(changed.path()).unwrap();
        assert_ne!(profile.hash, changed.hash);
    }

    #[test]
    fn structured_dynamic_checks_reject_ambiguous_unbounded_and_malformed_contracts() {
        let valid = module_with_structured_dynamic_check();
        let cases = [
            (
                valid.replace(
                    "    command_source:\n",
                    "    argv: [echo, ambiguous]\n    command_source:\n",
                ),
                "exactly one of argv, argv_from, or command_source",
            ),
            (
                valid.replace("      selection: read_scope\n", ""),
                "requires nonempty node_types and exactly one of selection or gate_policy",
            ),
            (
                valid.replace("      node_types: [system]", "      node_types: [unknown]"),
                "unknown node type unknown",
            ),
            (
                valid.replace("      role: candidate", "      role: ticket"),
                "role ticket is reserved for the virtual ticket",
            ),
            (
                valid.replace(
                    "source: {role: candidate, field:",
                    "source: {role: unbound, field:",
                ),
                "is not the bound command role or ticket",
            ),
            (
                valid.replace(
                    "        allow_path_strings: true\n        path_field: path\n",
                    "        allow_path_strings: false\n",
                ),
                "must allow path strings or configure path_field",
            ),
            (
                valid.replace(
                    "      field: spec.contracts[$target.id].command",
                    "      field: spec.contracts[unterminated.command",
                ),
                "has malformed field",
            ),
            (
                valid.replace(
                    "artifact_paths: [artifacts/static.json]",
                    "artifact_paths: [artifacts/static.json, artifacts/static.json]",
                ),
                "artifact_paths must not contain duplicates",
            ),
        ];
        for (module, expected) in cases {
            let temp = fixture(&module);
            let error = ProfileCompiler::compile(temp.path()).unwrap_err();
            assert!(
                error.to_string().contains(expected),
                "expected {expected:?}, got {error}"
            );
        }
    }

    #[test]
    fn ticket_dynamic_sources_forbid_node_selection_and_accept_ticket_projection() {
        let module = module_with_structured_dynamic_check()
            .replace("      kind: node", "      kind: ticket")
            .replace("      selection: read_scope\n", "")
            .replace("      node_types: [system]\n", "")
            .replace("      role: candidate", "      role: ticket")
            .replace("role: candidate", "role: ticket");
        let temp = fixture(&module);
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        assert_eq!(
            profile.checks["dynamic-contract"]
                .command_source
                .as_ref()
                .unwrap()
                .kind,
            DynamicSourceKind::Ticket
        );

        let malformed = module.replace(
            "      kind: ticket",
            "      kind: ticket\n      selection: target",
        );
        let temp = fixture(&malformed);
        let error = ProfileCompiler::compile(temp.path()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("may not configure selection or node_types")
        );
    }

    #[test]
    fn validates_typed_planning_context_initialization() {
        for planning_context_path in ["planning_context", "spec.planning_context"] {
            let module = module_with_planning_context("object");
            let temp = fixture(&module);
            write(
                &temp.path().join("koni.toml"),
                &manifest_with_initialization(&format!(
                    "root_node_type = \"system\"\ngoal_field = \"name\"\nplanning_context_field = \"{planning_context_path}\""
                )),
            );

            let profile = ProfileCompiler::compile(temp.path()).unwrap();
            assert_eq!(
                profile
                    .manifest
                    .initialization
                    .planning_context_field
                    .as_deref(),
                Some(planning_context_path)
            );
            assert_eq!(
                profile.node_types["system"].fields["planning_context"].value_type,
                FieldType::Object
            );
        }
    }

    #[test]
    fn rejects_invalid_planning_context_initialization() {
        let cases = [
            (
                "planning_context_field = \"planning_context\"".to_owned(),
                module_with_planning_context("object"),
                "planning_context_field requires root_node_type",
            ),
            (
                "root_node_type = \"system\"\ngoal_field = \"name\"\nplanning_context_field = \" \""
                    .to_owned(),
                module_with_planning_context("object"),
                "must be a nonempty root spec path",
            ),
            (
                "root_node_type = \"system\"\ngoal_field = \"name\"\nplanning_context_field = \"planning_context.plan\""
                    .to_owned(),
                module_with_planning_context("object"),
                "must be a nonempty root spec path",
            ),
            (
                "root_node_type = \"system\"\ngoal_field = \"planning_context\"\nplanning_context_field = \"spec.planning_context\""
                    .to_owned(),
                module_with_planning_context("object"),
                "must differ from goal_field",
            ),
            (
                "root_node_type = \"system\"\ngoal_field = \"name\"\nplanning_context_field = \"planning_context\""
                    .to_owned(),
                valid_module().to_owned(),
                "is not declared by node type system",
            ),
            (
                "root_node_type = \"system\"\ngoal_field = \"name\"\nplanning_context_field = \"planning_context\""
                    .to_owned(),
                module_with_planning_context("string"),
                "must reference an object field on node type system",
            ),
            (
                "root_node_type = \"missing\"\ngoal_field = \"name\"\nplanning_context_field = \"planning_context\""
                    .to_owned(),
                module_with_planning_context("object"),
                "root_node_type references unknown node type missing",
            ),
        ];

        for (initialization, module, expected) in cases {
            let temp = fixture(&module);
            write(
                &temp.path().join("koni.toml"),
                &manifest_with_initialization(&initialization),
            );
            let error = ProfileCompiler::compile(temp.path())
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn persona_prompt_contents_are_bound_into_the_profile_hash() {
        let temp = fixture(valid_module());
        let original = ProfileCompiler::compile(temp.path()).unwrap();

        write(
            &temp.path().join("personas/coder.md"),
            "You are a bounded coder with a revised contract.\n",
        );
        let revised = ProfileCompiler::compile(temp.path()).unwrap();

        assert_ne!(original.hash, revised.hash);
    }

    #[test]
    fn native_codex_agent_and_skill_resolve_as_persona_defaults_and_hash_inputs() {
        let temp = TempDir::new().unwrap();
        let profile_root = temp.path().join(".codex/koni");
        write(&profile_root.join("koni.toml"), manifest());
        let native_module = valid_module().replace(
            r#"personas:
  - id: coder
    prompt: personas/coder.md
    model_role: ticket_worker
    sandbox:
      mode: workspace-write
      approval_policy: never
      network_access: false
"#,
            r#"personas:
  - id: coder
    codex_agent: reviewer
    skills: [review]
    model_role: ticket_worker
"#,
        );
        write(&profile_root.join("module.yaml"), &native_module);
        write(
            &temp.path().join(".codex/config.toml"),
            "[agents]\nmax_threads = 4\n",
        );
        write(
            &temp.path().join(".codex/agents/reviewer.toml"),
            r#"name = "reviewer"
description = "Review changes against their contracts."
developer_instructions = "Review like an owner."
model = "gpt-native"
model_reasoning_effort = "high"
sandbox_mode = "read-only"

[mcp_servers.docs]
url = "https://example.test/mcp"

[skills]
config = [{ path = ".agents/skills/review/SKILL.md", enabled = true }]
"#,
        );
        write(
            &temp.path().join(".agents/skills/review/SKILL.md"),
            "---\nname: review\ndescription: Review a change\n---\nReview carefully.\n",
        );
        write(
            &temp.path().join(".agents/skills/review/scripts/check.sh"),
            "#!/bin/sh\nexit 0\n",
        );

        let original = ProfileCompiler::compile(temp.path()).unwrap();
        let persona = original.resolve_persona("coder").unwrap();
        assert_eq!(persona.instructions, "Review like an owner.");
        assert!(!persona.explicit_prompt);
        assert_eq!(
            persona.description,
            "Review changes against their contracts."
        );
        assert_eq!(persona.model.as_deref(), Some("gpt-native"));
        assert_eq!(persona.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(persona.sandbox.mode, "read-only");
        let overrides = persona.codex_config_overrides().collect::<Vec<_>>();
        for assignment in &overrides {
            let (_, value) = assignment
                .split_once('=')
                .expect("native config override is an assignment");
            value
                .parse::<toml::Value>()
                .expect("native config override has a TOML-safe value");
        }
        assert!(
            overrides
                .iter()
                .any(|value| value.starts_with("developer_instructions="))
        );
        assert!(
            overrides
                .iter()
                .any(|value| value.starts_with("mcp_servers="))
        );
        assert!(
            overrides
                .iter()
                .any(|value| value.starts_with("skills.config="))
        );

        write(
            &temp.path().join(".agents/skills/review/scripts/check.sh"),
            "#!/bin/sh\nexit 1\n",
        );
        let changed_skill = ProfileCompiler::compile(temp.path()).unwrap();
        assert_ne!(original.hash, changed_skill.hash);

        write(
            &temp.path().join(".codex/config.toml"),
            "[agents]\nmax_threads = 5\n",
        );
        let changed_project_config = ProfileCompiler::compile(temp.path()).unwrap();
        assert_ne!(changed_skill.hash, changed_project_config.hash);
    }

    #[test]
    fn native_persona_references_must_resolve() {
        let temp = TempDir::new().unwrap();
        let profile_root = temp.path().join(".codex/koni");
        write(&profile_root.join("koni.toml"), manifest());
        let native_module = valid_module().replace(
            r#"personas:
  - id: coder
    prompt: personas/coder.md
    model_role: ticket_worker
    sandbox:
      mode: workspace-write
      approval_policy: never
      network_access: false
"#,
            r#"personas:
  - id: coder
    codex_agent: missing
    model_role: ticket_worker
"#,
        );
        write(&profile_root.join("module.yaml"), &native_module);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("persona coder references unknown Codex custom agent missing"),
            "{error}"
        );
    }

    #[test]
    fn node_descriptions_are_validated_and_bound_into_the_profile_hash() {
        let temp = fixture(valid_module());
        let original = ProfileCompiler::compile(temp.path()).unwrap();
        assert_eq!(
            original.node_types["system"].effective_description(),
            "An architectural boundary whose dependencies and implementation state are tracked by this fixture."
        );

        let revised_module = valid_module().replace(
            "An architectural boundary whose dependencies and implementation state are tracked by this fixture.",
            "A revised architectural boundary contract for this fixture.",
        );
        write(&temp.path().join("module.yaml"), &revised_module);
        let revised = ProfileCompiler::compile(temp.path()).unwrap();
        assert_ne!(original.hash, revised.hash);

        let invalid_module = valid_module().replace(
            "description: An architectural boundary whose dependencies and implementation state are tracked by this fixture.",
            "description: '   '",
        );
        write(&temp.path().join("module.yaml"), &invalid_module);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("node type system description must not be empty"),
            "{error}"
        );
    }

    #[test]
    fn compiles_recursive_object_fields_and_validates_regex_patterns() {
        let nested_module = valid_module().replace(
            "    compiler_owned_fields: [readiness]\n",
            r#"    compiler_owned_fields: [readiness]
    fields:
      contract:
        type: object
        required: true
        additional_properties: false
        properties:
          protocol_range:
            type: string
            required: true
            pattern: '^(?:>=|<)[0-9]+\.[0-9]+$'
          outcomes:
            type: list
            required: true
            items:
              type: object
              additional_properties: false
              properties:
                name: {type: string, required: true}
"#,
        );
        let temp = fixture(&nested_module);
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        let contract = &profile.node_types["system"].fields["contract"];
        assert_eq!(contract.additional_properties, Some(false));
        assert_eq!(
            contract.properties["protocol_range"].pattern.as_deref(),
            Some("^(?:>=|<)[0-9]+\\.[0-9]+$")
        );
        assert_eq!(
            contract.properties["outcomes"]
                .items
                .as_ref()
                .unwrap()
                .properties["name"]
                .value_type,
            FieldType::String
        );

        let invalid_pattern =
            nested_module.replace("'^(?:>=|<)[0-9]+\\.[0-9]+$'", "'[unterminated'");
        let temp = fixture(&invalid_pattern);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(error.contains("invalid regex pattern"), "{error}");
        assert!(error.contains("contract.protocol_range"), "{error}");
    }

    #[test]
    fn rejects_nested_field_keywords_on_incompatible_types() {
        let invalid_properties = valid_module().replace(
            "    compiler_owned_fields: [readiness]\n",
            r#"    compiler_owned_fields: [readiness]
    fields:
      invalid:
        type: string
        properties:
          child: {type: string}
"#,
        );
        let temp = fixture(&invalid_properties);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("configures object properties but is not an object"),
            "{error}"
        );

        let invalid_items = valid_module().replace(
            "    compiler_owned_fields: [readiness]\n",
            r#"    compiler_owned_fields: [readiness]
    fields:
      invalid:
        type: object
        items: {type: string}
"#,
        );
        let temp = fixture(&invalid_items);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("configures items but is not a list"),
            "{error}"
        );
    }

    #[test]
    fn legacy_node_without_description_gets_an_agent_facing_fallback() {
        let legacy_module = valid_module().replace(
            "    description: An architectural boundary whose dependencies and implementation state are tracked by this fixture.\n",
            "",
        );
        let temp = fixture(&legacy_module);
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        let node = &profile.node_types["system"];

        assert!(node.description.is_none());
        assert_eq!(
            node.effective_description(),
            "Legacy semantic graph node of type `system` in the `architecture` stage."
        );
    }

    #[test]
    fn compiles_canonical_yaml_profile_entrypoint() {
        let temp = TempDir::new().unwrap();
        write(&temp.path().join("profile.yaml"), yaml_manifest());
        write(&temp.path().join("module.yaml"), valid_module());
        write(
            &temp.path().join("personas/coder.md"),
            "You are a bounded coder.\n",
        );
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        assert_eq!(profile.manifest.profile.id, "fixture-yaml");
        assert_eq!(profile.node_types.len(), 1);
        assert!(profile.hash.starts_with("sha256:"));
    }

    #[test]
    fn ticket_path_scopes_default_to_empty() {
        let emit: TicketEmitDef = serde_yaml::from_str(
            r#"
operation: implement
source_state: before
target_state: after
"#,
        )
        .unwrap();
        assert!(emit.read_paths.is_empty());
        assert!(emit.write_paths.is_empty());
    }

    #[test]
    fn compiles_literal_and_projected_ticket_path_scopes() {
        let module = module_with_path_scopes(
            r#"read_paths:
  - package.json
  - select: $target
    field: spec.owned_paths
write_paths:
  - packages/core
  - select: $target
    field: spec.owned_paths"#,
        );
        let temp = fixture(&module);
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        let emit = profile.rules["system.path-scope"].emit.as_ref().unwrap();
        assert_eq!(emit.read_paths.len(), 2);
        assert_eq!(emit.write_paths.len(), 2);
        assert!(matches!(
            &emit.read_paths[0],
            PathScopeDef::Literal(path) if path == Path::new("package.json")
        ));
        assert!(matches!(
            &emit.write_paths[1],
            PathScopeDef::Projection(PathProjectionDef { field, .. })
                if field == "spec.owned_paths"
        ));
    }

    #[test]
    fn rejects_absolute_or_escaping_literal_ticket_paths() {
        for path in [
            "/etc/passwd",
            "../outside",
            "packages/../../outside",
            "C:\\Windows",
        ] {
            let module = module_with_path_scopes(&format!("write_paths:\n  - '{path}'"));
            let temp = fixture(&module);
            let error = ProfileCompiler::compile(temp.path())
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("ticket path scope")
                    && (error.contains("relative") || error.contains("escape")),
                "{path}: {error}"
            );
        }
    }

    #[test]
    fn rejects_empty_projected_path_field_or_selector() {
        let empty_field = module_with_path_scopes(
            r#"write_paths:
  - select: $target
    field: " ""#,
        );
        let temp = fixture(&empty_field);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("projected field must be nonempty"),
            "{error}"
        );

        let empty_selector = module_with_path_scopes(
            r#"write_paths:
  - select: {ids: []}
    field: spec.owned_paths"#,
        );
        let temp = fixture(&empty_selector);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("ids selector must contain at least one id"),
            "{error}"
        );
    }

    #[test]
    fn rejects_irreversible_step_before_post_mutation_validation() {
        let module = valid_module().replace(
            "      - primitive: project.validate\n      - primitive: git.commit",
            "      - primitive: agent.spawn\n      - primitive: graph.validate\n      - primitive: git.commit",
        );
        let temp = fixture(&module);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("agent.spawn before current state has been validated"),
            "{error}"
        );
    }

    #[test]
    fn worktree_retirement_effects_preserve_the_recovery_boundary() {
        let step = |primitive: &str| ActionStepDef {
            id: None,
            primitive: primitive.to_owned(),
            when: None,
            args: BTreeMap::new(),
        };

        for primitive in ["lease.release", "worktree.retire"] {
            let effect = primitive_effect(&step(primitive)).expect("known primitive effect");
            assert_eq!(effect.class, EffectClass::ReversibleWrite);
            assert!(effect.invalidates_validation);
        }

        let removal = primitive_effect(&step("worktree.remove")).expect("known removal effect");
        assert_eq!(removal.class, EffectClass::Irreversible);
        assert!(!removal.invalidates_validation);
    }

    #[test]
    fn rejects_edge_to_unknown_node_type() {
        let module = valid_module().replace("targets: [system]", "targets: [missing]");
        let temp = fixture(&module);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown target type missing"), "{error}");
    }

    #[test]
    fn rejects_workflow_dependency_cycle() {
        let module = valid_module().replace(
            "      - id: work\n        persona: coder",
            "      - id: work\n        persona: coder\n        depends_on: [review]\n      - id: review\n        persona: coder\n        depends_on: [work]",
        );
        let temp = fixture(&module);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(error.contains("dependency cycle"), "{error}");
    }

    #[test]
    fn validates_review_failure_rework_boundary() {
        let valid = valid_module().replace(
            "    applies_to: [implement]\n    steps:",
            "    applies_to: [implement]\n    review_failure_reopen_from: work\n    steps:",
        );
        let temp = fixture(&valid);
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        assert_eq!(
            profile.workflows["implement-system"]
                .review_failure_reopen_from
                .as_deref(),
            Some("work")
        );

        let unknown = valid.replace(
            "review_failure_reopen_from: work",
            "review_failure_reopen_from: missing",
        );
        let temp = fixture(&unknown);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("review_failure_reopen_from references unknown step missing"),
            "{error}"
        );

        let review = valid.replace(
            "      - id: work\n        persona: coder",
            "      - id: work\n        kind: review\n        persona: coder",
        );
        let temp = fixture(&review);
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("review_failure_reopen_from cannot reference review step work"),
            "{error}"
        );
    }

    #[test]
    fn imports_cannot_escape_profile_root() {
        let temp = TempDir::new().unwrap();
        write(
            &temp.path().join("koni.toml"),
            &manifest().replace("module.yaml", "../outside.yaml"),
        );
        let error = ProfileCompiler::compile(temp.path())
            .unwrap_err()
            .to_string();
        assert!(error.contains("may not escape"), "{error}");
    }

    #[test]
    fn ordinary_change_control_defaults_closed_and_does_not_perturb_serialization() {
        let temp = fixture(valid_module());
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        let operation = &profile.operations["architecture.system.implement"];

        assert_eq!(
            operation.change_control,
            OperationChangeControlDef::Ordinary {
                allow_upstream_requests: false,
                proposal_operation: None,
            }
        );
        assert!(
            serde_json::to_value(operation)
                .unwrap()
                .get("change_control")
                .is_none(),
            "the safe ordinary default remains omitted from pinned legacy profiles"
        );
    }

    #[test]
    fn legacy_change_control_extensions_are_rejected() {
        for legacy in [
            "proposal_only",
            "requires_approved_change_hash",
            "disposition_only",
        ] {
            let module = valid_module().replace(
                "    ranking_hints: [stage, target]\n",
                &format!("    {legacy}: true\n    ranking_hints: [stage, target]\n"),
            );
            let temp = fixture(&module);
            let error = ProfileCompiler::compile(temp.path())
                .expect_err("untyped change-control authority must fail closed")
                .to_string();
            assert!(
                error.contains(&format!("uses legacy extension {legacy}")),
                "{legacy}: {error}"
            );
        }
    }

    #[test]
    fn enabled_ordinary_change_control_requires_one_typed_proposal_route() {
        let module = valid_module().replace(
            "    ranking_hints: [stage, target]\n",
            r#"    change_control:
      role: ordinary
      allow_upstream_requests: true
      proposal_operation: implement
    ranking_hints: [stage, target]
"#,
        );
        let temp = fixture(&module);
        let error = ProfileCompiler::compile(temp.path())
            .expect_err("an ordinary operation cannot route to another ordinary operation")
            .to_string();
        assert!(
            error.contains(
                "must resolve proposal_operation implement to exactly one typed proposal operation"
            ),
            "{error}"
        );
    }
}
