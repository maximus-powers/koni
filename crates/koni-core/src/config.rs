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
use crate::schema2_migration::{
    AgentInstructionSourceV2, CapabilityPolicyV2, CommandAccessV2, KONI_SCHEMA2_VERSION,
    KoniAgentResourceV2, WorkspaceAccessV2,
};

/// Historical profile schema retained for installed schema-1 projects.
pub const PROFILE_SCHEMA_VERSION: &str = "1.0";
/// Provider-neutral profile schema used by `.koni` catalogs.
pub const PROFILE_SCHEMA_V2_VERSION: &str = KONI_SCHEMA2_VERSION;
const SCHEMA2_AGENT_PROVIDER: &str = "openai-codex";

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
    /// Compiler-enforced budgets for the ticket context bundle and the two
    /// bounded knowledge-ledger broker capabilities. The default is omitted
    /// from serialization so profiles pinned before graph context expansion
    /// retain their existing semantic hash.
    #[serde(default, skip_serializing_if = "ContextPolicy::is_default")]
    pub context: ContextPolicy,
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct ProfileMetadata {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitializationConfig {
    #[serde(default)]
    pub root_node_type: Option<String>,
    #[serde(default)]
    pub goal_field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_context_field: Option<String>,
    /// Registry entry whose graph mutation authority bounds the typed graph
    /// seed compiled from an approved planning stage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning_seed_operation: Option<String>,
    #[serde(default)]
    pub root_status: Option<String>,
}

/// Profile-owned hard budgets for graph-backed agent context.
///
/// These values bound compiler work as well as model-visible output. Runtime
/// callers may ask for a smaller neighborhood, but cannot raise these limits.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContextPolicy {
    #[serde(default = "default_context_expansion_max_depth")]
    pub expansion_max_depth: usize,
    #[serde(default = "default_context_expansion_max_nodes")]
    pub expansion_max_nodes: usize,
    #[serde(default = "default_context_expansion_max_calls_per_step")]
    pub expansion_max_calls_per_step: usize,
    #[serde(default = "default_context_expansion_max_response_bytes")]
    pub expansion_max_response_bytes: usize,
    #[serde(default = "default_context_note_max_bytes")]
    pub note_max_bytes: usize,
    #[serde(default = "default_context_note_max_calls_per_step")]
    pub note_max_calls_per_step: usize,
    #[serde(default = "default_context_notes_max_bundle_bytes")]
    pub notes_max_bundle_bytes: usize,
}

impl ContextPolicy {
    fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

impl Default for ContextPolicy {
    fn default() -> Self {
        Self {
            expansion_max_depth: default_context_expansion_max_depth(),
            expansion_max_nodes: default_context_expansion_max_nodes(),
            expansion_max_calls_per_step: default_context_expansion_max_calls_per_step(),
            expansion_max_response_bytes: default_context_expansion_max_response_bytes(),
            note_max_bytes: default_context_note_max_bytes(),
            note_max_calls_per_step: default_context_note_max_calls_per_step(),
            notes_max_bundle_bytes: default_context_notes_max_bundle_bytes(),
        }
    }
}

fn default_context_expansion_max_depth() -> usize {
    2
}

fn default_context_expansion_max_nodes() -> usize {
    32
}

fn default_context_expansion_max_calls_per_step() -> usize {
    4
}

fn default_context_expansion_max_response_bytes() -> usize {
    64 * 1024
}

fn default_context_note_max_bytes() -> usize {
    4 * 1024
}

fn default_context_note_max_calls_per_step() -> usize {
    16
}

fn default_context_notes_max_bundle_bytes() -> usize {
    32 * 1024
}

const CONTEXT_EXPANSION_DEPTH_HARD_MAX: usize = 8;
const CONTEXT_EXPANSION_NODES_HARD_MAX: usize = 256;
const CONTEXT_EXPANSION_CALLS_HARD_MAX: usize = 16;
const CONTEXT_EXPANSION_RESPONSE_BYTES_HARD_MAX: usize = 256 * 1024;
const CONTEXT_NOTE_BYTES_HARD_MAX: usize = 16 * 1024;
const CONTEXT_NOTE_CALLS_HARD_MAX: usize = 64;
const CONTEXT_NOTES_BUNDLE_BYTES_HARD_MAX: usize = 128 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageBackend {
    #[default]
    Tracked,
    GitCommonDir,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
    /// Optional idempotent static command check run once in every newly
    /// leased ticket worktree before a worker is allowed to start. This is the
    /// profile-owned hook for dependency installation or local tool setup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket_worktree_setup_check: Option<String>,
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
            ticket_worktree_setup_check: None,
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
    /// Domain-neutral invariants over selected semantic graph fields. These
    /// run against the whole graph before rules may emit work.
    #[serde(default)]
    pub graph_constraints: Vec<GraphConstraintDef>,
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
#[serde(deny_unknown_fields)]
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
    /// Compiler-owned paths that remain visible in model-facing graph
    /// context. Ownership still forbids agent mutation; this list separates
    /// read visibility from write authority for inputs such as an approved
    /// planning handoff.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_visible_compiler_owned_fields: Vec<String>,
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
    /// Require this list's values to be contained by a list field on the same
    /// root node. This remains valid at any recursive object/list-item depth;
    /// the reference always resolves from the root node rather than relative
    /// to the nested value instance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subset_of: Option<String>,
    /// Require this list to have no values in common with a compatible list
    /// field on the same root node. String values use exact identity. Path
    /// values use normalized authority overlap, so equality and either
    /// ancestor/descendant direction are conflicts. Declare this on one side
    /// only; disjointness is symmetric at validation time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disjoint_from: Option<String>,
    /// Require every object in this list to have a distinct value for one
    /// declared, required scalar property on the list item contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique_by: Option<String>,
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
#[serde(deny_unknown_fields)]
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
    /// Treat one stored edge as traversable from both endpoints. `relation`
    /// is the canonical authored direction and `inverse` is its reverse alias;
    /// agents must not persist a second reciprocal edge.
    #[serde(default, skip_serializing_if = "is_false")]
    pub bidirectional: bool,
    #[serde(default)]
    pub on_delete: EdgeDeletePolicy,
    /// Optional predicate evaluated for every concrete source/target pair.
    /// Validation binds exactly `$source` and `$target` to those nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<Predicate>,
}

fn is_false(value: &bool) -> bool {
    !*value
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct QueryTraverseDef {
    pub from: Selector,
    #[serde(default)]
    pub relations: Vec<String>,
    #[serde(default)]
    pub direction: crate::expr::TraverseDirection,
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
}

/// One typed set of project paths selected from the semantic graph.
///
/// `node_types` is deliberately explicit even when the selector is a named
/// query. It makes the field contract statically checkable and causes a
/// selector that later returns a different type to fail closed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphPathSetDef {
    pub select: Selector,
    pub node_types: Vec<String>,
    pub field: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphConstraintKind {
    PathSetsDisjoint,
}

/// A profile-authored whole-graph invariant. The compiler supplies only the
/// deterministic selector, typed field, and filesystem-authority mechanics;
/// profiles decide which domain concepts must be kept apart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphConstraintDef {
    pub id: String,
    pub kind: GraphConstraintKind,
    pub left: GraphPathSetDef,
    pub right: GraphPathSetDef,
    #[serde(default)]
    pub distinct_nodes: bool,
}

fn default_max_depth() -> usize {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
    /// Composite check whose independently reviewed historical command
    /// members establish immutable proof-source paths for this operation.
    /// The compiler validates the complete workflow/review contract and uses
    /// the declaration at ticket emission and lease admission; omission keeps
    /// ordinary operations outside prepared-source authority.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proof_source_preparation_check: Option<String>,
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
    /// Designate the one operation a recovery compensation may use to resolve
    /// a terminal ticket failure. This is typed so recovery policy cannot hide
    /// in an inert extension or select an ambiguous resolver.
    #[serde(default, skip_serializing_if = "is_false")]
    pub terminal_resolver: bool,
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
#[serde(deny_unknown_fields)]
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
    /// Compiler-bound routing for structured independent-review failure
    /// domains. New workflows should prefer this map over the legacy single
    /// `review_failure_reopen_from` boundary so a reviewer can distinguish a
    /// correction the selected step is authorized to make from an upstream
    /// defect that must stop automatic dispatch.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub review_failure_routes: BTreeMap<String, ReviewFailureRouteDef>,
    pub steps: Vec<WorkflowStepDef>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewFailureDisposition {
    Reopen,
    Block,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewFailureRecovery {
    /// Preserve the rejected materialization and return to planning against
    /// the clean integration state. The blocked candidate must never become
    /// the source tree for upstream proof or scope repair.
    ReplanFromCleanIntegration,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReviewFailureRouteDef {
    pub disposition: ReviewFailureDisposition,
    /// Human/model-facing classification boundary. This is trusted profile
    /// configuration and is included in the compiler-bound review packet.
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reopen_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<ReviewFailureRecovery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_instructions: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// Optional filesystem read scope for this step. Omission inherits the
    /// ticket's complete read scope; an explicit empty list grants no product
    /// filesystem reads. Projections are resolved when the ticket is emitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_paths: Option<Vec<PathScopeDef>>,
    /// Optional filesystem write scope for this step. Omission inherits the
    /// ticket's complete write scope; an explicit empty list makes the step
    /// product-filesystem read-only. Projections are resolved when the ticket
    /// is emitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_paths: Option<Vec<PathScopeDef>>,
    /// Earlier causal workflow step whose graph-selected proof sources must
    /// remain byte-identical when this step executes. The referenced step must
    /// be a transitive dependency; omission preserves legacy workflows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preserve_source_paths_from: Option<String>,
    #[serde(default)]
    pub expected_output: String,
    /// Compiler-enforced permission for this step to author semantic graph
    /// changes. Keeping this on the step lets one workflow separate analysis
    /// from graph production without relying on prompt wording.
    #[serde(default, skip_serializing_if = "graph_mutation_is_allowed")]
    pub graph_mutation: GraphMutationPolicyDef,
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
pub enum GraphMutationPolicyDef {
    #[default]
    Allowed,
    Forbidden,
    Required,
}

fn graph_mutation_is_allowed(value: &GraphMutationPolicyDef) -> bool {
    *value == GraphMutationPolicyDef::Allowed
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct CheckDef {
    pub id: String,
    pub kind: CheckKind,
    #[serde(default)]
    pub predicate: Option<Predicate>,
    /// Complete, deterministic graph-local command-member selection for a
    /// composite check. Omission preserves registry-selected legacy checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_set: Option<GraphCheckSetDef>,
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
    /// Exit codes which make the process execution itself successful. An
    /// empty list preserves the conventional `[0]` default. Profiles can use
    /// an explicit non-zero code for compiler-owned expected-red checks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expected_exit_codes: Vec<i32>,
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
    /// Whether a passing receipt must still match the current workspace or is
    /// durable causal evidence for an earlier workflow boundary. Historical
    /// receipts remain integrity- and ticket-bound; they are never promoted
    /// into current graph evidence.
    #[serde(default, skip_serializing_if = "receipt_freshness_is_current")]
    pub receipt_freshness: ReceiptFreshness,
    /// Whether the command must be replayed automatically against the composed
    /// run tree after target synchronization. Side-effecting or prohibitively
    /// expensive execution can opt out explicitly while a distinct read-only
    /// currentness check remains replayable.
    #[serde(default, skip_serializing_if = "composed_replay_is_required")]
    pub composed_replay: ComposedReplayPolicy,
    #[serde(default)]
    pub retry_policy: RetryPolicyDef,
    #[serde(default = "default_process_effect")]
    pub effect: ProcessEffect,
    #[serde(default)]
    pub environment: EnvironmentPolicyDef,
}

/// Profile-owned contract for compiling one target-anchored semantic
/// neighborhood into exact registered command-check members.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GraphCheckSetDef {
    pub members: Selector,
    pub member_node_types: Vec<String>,
    /// Literal child command check. Exactly one of this field and
    /// `member_check_field` must be configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_check: Option<String>,
    /// Node field containing a registry-backed child command-check ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_check_field: Option<String>,
    pub source_paths_field: String,
    pub covered_paths_field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory_field: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub statuses: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub status_excluding: Vec<String>,
    #[serde(default = "default_graph_set_min_members")]
    pub min_members: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_members: Option<usize>,
}

fn default_graph_set_min_members() -> usize {
    1
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
#[serde(deny_unknown_fields)]
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
pub enum ReceiptFreshness {
    #[default]
    Current,
    Historical,
}

fn receipt_freshness_is_current(value: &ReceiptFreshness) -> bool {
    *value == ReceiptFreshness::Current
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposedReplayPolicy {
    #[default]
    Required,
    Never,
}

fn composed_replay_is_required(value: &ComposedReplayPolicy) -> bool {
    *value == ComposedReplayPolicy::Required
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
#[serde(deny_unknown_fields)]
pub struct RetryPolicyDef {
    #[serde(default)]
    pub max_attempts: usize,
    #[serde(default)]
    pub transient_exit_codes: Vec<i32>,
    #[serde(default)]
    pub backoff_seconds: Vec<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvironmentPolicyDef {
    #[serde(default)]
    pub inherit: Vec<String>,
    #[serde(default)]
    pub set: BTreeMap<String, String>,
    #[serde(default)]
    pub remove: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// Schema-2 provider-neutral reasoning policy.
    #[serde(default)]
    pub thinking_level: Option<String>,
    /// Historical schema-1 Codex reasoning policy.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    /// Schema-2 Koni-owned authority policy.
    #[serde(default)]
    pub capabilities: Option<CapabilityPolicyV2>,
    /// Historical schema-1 Codex sandbox policy.
    #[serde(default)]
    pub sandbox: Option<SandboxDef>,
    /// Name of a provider-neutral agent resource in `.koni/agents/*.yaml`.
    #[serde(default)]
    pub agent: Option<String>,
    /// Name of a project-scoped custom agent in `.codex/agents/*.toml`.
    #[serde(default)]
    pub codex_agent: Option<String>,
    /// Native repository skill names whose bundles are required by this persona.
    #[serde(default)]
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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

/// A validated schema-2 agent resource with its resolved instruction content.
#[derive(Debug, Clone)]
pub struct KoniAgentDefV2 {
    pub resource: KoniAgentResourceV2,
    pub path: PathBuf,
    pub instructions: String,
    pub instruction_source: PathBuf,
    pub hash: String,
}

/// Provider-neutral resources discovered below `.koni/agents`.
#[derive(Debug, Clone)]
pub struct KoniAgentCatalogV2 {
    pub project_root: PathBuf,
    pub profile_root: PathBuf,
    pub agents: BTreeMap<String, KoniAgentDefV2>,
    pub files: BTreeMap<PathBuf, String>,
    pub hash: String,
    references: BTreeMap<String, String>,
}

impl KoniAgentCatalogV2 {
    fn empty(project_root: &Path, profile_root: &Path) -> Self {
        Self {
            project_root: project_root.to_path_buf(),
            profile_root: profile_root.to_path_buf(),
            agents: BTreeMap::new(),
            files: BTreeMap::new(),
            hash: normalized_hash(&BTreeMap::<PathBuf, String>::new()),
            references: BTreeMap::new(),
        }
    }

    fn discover(project_root: &Path, profile_root: &Path) -> Result<Self> {
        let agents_root = profile_root.join("agents");
        if !agents_root.exists() {
            return Ok(Self::empty(project_root, profile_root));
        }
        let root_metadata =
            fs::symlink_metadata(&agents_root).map_err(|error| io_error(&agents_root, error))?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return profile_error(format!(
                "schema-2 agent resource root must be a real directory: {}",
                agents_root.display()
            ));
        }

        let mut paths = fs::read_dir(&agents_root)
            .map_err(|error| io_error(&agents_root, error))?
            .map(|entry| {
                entry
                    .map(|entry| entry.path())
                    .map_err(|error| io_error(&agents_root, error))
            })
            .collect::<Result<Vec<_>>>()?;
        paths.sort();

        let mut catalog = Self::empty(project_root, profile_root);
        for path in paths {
            if !matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("yaml" | "yml")
            ) {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(|error| io_error(&path, error))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return profile_error(format!(
                    "schema-2 agent resource must be a regular, non-symlink file: {}",
                    path.display()
                ));
            }
            let text = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
            let resource: KoniAgentResourceV2 =
                serde_yaml::from_str(&text).map_err(|source| KoniError::Yaml {
                    path: path.clone(),
                    source,
                })?;
            validate_schema2_agent_resource(&resource, &path)?;

            let (instructions, instruction_source) = match &resource.instructions {
                AgentInstructionSourceV2::Inline { text } => {
                    if text.trim().is_empty() {
                        return profile_error(format!(
                            "schema-2 agent {} inline instructions must not be empty",
                            resource.id
                        ));
                    }
                    (text.clone(), path.clone())
                }
                AgentInstructionSourceV2::Path { path: relative } => {
                    let instruction_path = resolve_profile_resource(
                        profile_root,
                        relative,
                        &format!("schema-2 agent {} instruction path", resource.id),
                    )?;
                    let instructions = fs::read_to_string(&instruction_path)
                        .map_err(|error| io_error(&instruction_path, error))?;
                    if instructions.trim().is_empty() {
                        return profile_error(format!(
                            "schema-2 agent {} instructions must not be empty: {}",
                            resource.id,
                            instruction_path.display()
                        ));
                    }
                    (instructions, instruction_path)
                }
            };

            let resource_relative = project_relative_path(project_root, &path);
            catalog
                .files
                .insert(resource_relative, normalized_hash(&text.as_bytes()));
            if instruction_source != path {
                catalog.files.insert(
                    project_relative_path(project_root, &instruction_source),
                    normalized_hash(&instructions.as_bytes()),
                );
            }
            let hash = normalized_hash(&(&resource, &instructions));
            let id = resource.id.clone();
            for reference in std::iter::once(&resource.id).chain(resource.aliases.iter()) {
                if let Some(owner) = catalog.references.insert(reference.clone(), id.clone()) {
                    return profile_error(format!(
                        "schema-2 agent reference {reference} is claimed by both {owner} and {id}"
                    ));
                }
            }
            let definition = KoniAgentDefV2 {
                resource,
                path,
                instructions,
                instruction_source,
                hash,
            };
            if catalog.agents.insert(id.clone(), definition).is_some() {
                return profile_error(format!("duplicate schema-2 agent id {id}"));
            }
        }
        catalog.hash = normalized_hash(&catalog.files);
        Ok(catalog)
    }

    pub fn agent(&self, reference: &str) -> Option<&KoniAgentDefV2> {
        self.references
            .get(reference)
            .and_then(|id| self.agents.get(id))
    }
}

fn validate_schema2_agent_resource(resource: &KoniAgentResourceV2, path: &Path) -> Result<()> {
    if resource.schema_version != PROFILE_SCHEMA_V2_VERSION {
        return profile_error(format!(
            "schema-2 agent resource {} declares schema {}; expected {}",
            path.display(),
            resource.schema_version,
            PROFILE_SCHEMA_V2_VERSION
        ));
    }
    validate_identifier("schema-2 agent id", &resource.id)?;
    if resource.description.trim().is_empty() {
        return profile_error(format!(
            "schema-2 agent {} description must not be empty",
            resource.id
        ));
    }
    if resource.provider != SCHEMA2_AGENT_PROVIDER {
        return profile_error(format!(
            "schema-2 agent {} uses unsupported provider {}; expected {}",
            resource.id, resource.provider, SCHEMA2_AGENT_PROVIDER
        ));
    }
    for (label, value) in [
        ("model", resource.model.as_deref()),
        ("thinking_level", resource.thinking_level.as_deref()),
    ] {
        if value.is_some_and(|value| value.trim().is_empty()) {
            return profile_error(format!(
                "schema-2 agent {} {label} must not be empty",
                resource.id
            ));
        }
    }
    let mut references = BTreeSet::new();
    references.insert(resource.id.as_str());
    for alias in &resource.aliases {
        validate_identifier("schema-2 agent alias", alias)?;
        if !references.insert(alias) {
            return profile_error(format!(
                "schema-2 agent {} repeats reference {alias}",
                resource.id
            ));
        }
    }
    let mut skills = BTreeSet::new();
    for skill in &resource.skills {
        if skill.trim().is_empty() || !skills.insert(skill) {
            return profile_error(format!(
                "schema-2 agent {} has an empty or duplicate skill reference",
                resource.id
            ));
        }
    }
    validate_capabilities(
        &resource.capabilities,
        &format!("schema-2 agent {}", resource.id),
    )
}

fn resolve_profile_resource(root: &Path, relative: &Path, label: &str) -> Result<PathBuf> {
    validate_relative_path(relative, label)?;
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path).map_err(|error| io_error(&path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return profile_error(format!(
            "{label} must reference a regular, non-symlink file: {}",
            path.display()
        ));
    }
    let canonical_root = root.canonicalize().map_err(|error| io_error(root, error))?;
    let canonical = path
        .canonicalize()
        .map_err(|error| io_error(&path, error))?;
    if !canonical.starts_with(canonical_root) {
        return profile_error(format!(
            "{label} escapes the profile root: {}",
            relative.display()
        ));
    }
    Ok(path)
}

fn project_relative_path(project_root: &Path, path: &Path) -> PathBuf {
    path.strip_prefix(project_root)
        .unwrap_or(path)
        .to_path_buf()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct ReportColumnDef {
    pub id: String,
    #[serde(default)]
    pub title: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct StateMachineDef {
    pub id: String,
    pub initial: String,
    pub states: Vec<String>,
    #[serde(default)]
    pub terminal_states: Vec<String>,
    pub transitions: Vec<StateTransitionDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    pub graph_constraints: IndexMap<String, GraphConstraintDef>,
    pub rules: IndexMap<String, RuleDef>,
    pub operations: IndexMap<String, OperationDef>,
    pub workflows: IndexMap<String, WorkflowDef>,
    pub actions: IndexMap<String, ActionDef>,
    pub checks: IndexMap<String, CheckDef>,
    pub personas: IndexMap<String, PersonaDef>,
    pub reports: IndexMap<String, ReportDef>,
    pub views: IndexMap<String, ViewDef>,
    pub state_machines: IndexMap<String, StateMachineDef>,
    /// Provider-neutral schema-2 agent resources. Empty for schema 1.
    pub koni_agents: KoniAgentCatalogV2,
    /// Historical Codex-native resources for schema 1. Under schema 2 this
    /// catalog contains only `.agents/skills` and no executable Codex config.
    pub native_codex: NativeCodexCatalog,
    pub hash: String,
}

/// The effective, runnable persona after resolving its schema-specific agent
/// resource beneath explicit Koni overrides.
#[derive(Debug, Clone)]
pub struct ResolvedPersona {
    pub id: String,
    pub description: String,
    pub instructions: String,
    pub instruction_source: PathBuf,
    pub model_role: String,
    pub model: Option<String>,
    /// Provider-neutral schema-2 name. Mirrored into `reasoning_effort` until
    /// all historical engine consumers have moved to this field.
    pub thinking_level: Option<String>,
    pub reasoning_effort: Option<String>,
    /// Koni-owned schema-2 authority policy. Schema-1 personas leave this
    /// unset and continue to use their historical sandbox contract.
    pub capabilities: Option<CapabilityPolicyV2>,
    pub sandbox: SandboxDef,
    pub agent: Option<String>,
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
        validate_persona_schema_fields(&self.manifest.schema_version, persona)?;
        if self.manifest.schema_version == PROFILE_SCHEMA_V2_VERSION {
            return self.resolve_schema2_persona(persona);
        }

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
            thinking_level: None,
            reasoning_effort: persona
                .reasoning_effort
                .clone()
                .or_else(|| native_agent.and_then(|agent| agent.model_reasoning_effort.clone())),
            capabilities: None,
            sandbox,
            agent: None,
            codex_agent: persona.codex_agent.clone(),
            explicit_prompt: persona.prompt.is_some(),
            skills: persona.skills.clone(),
            native_codex_config_overrides,
        })
    }

    fn resolve_schema2_persona(&self, persona: &PersonaDef) -> Result<ResolvedPersona> {
        let agent = persona
            .agent
            .as_deref()
            .map(|reference| {
                self.koni_agents.agent(reference).ok_or_else(|| {
                    KoniError::Profile(format!(
                        "persona {} references unknown schema-2 agent {reference}",
                        persona.id
                    ))
                })
            })
            .transpose()?;
        let (instructions, instruction_source) = if let Some(prompt) = &persona.prompt {
            let path = resolve_profile_resource(
                &self.root,
                prompt,
                &format!("persona {} prompt", persona.id),
            )?;
            let instructions = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
            (instructions, path)
        } else if let Some(agent) = agent {
            (agent.instructions.clone(), agent.instruction_source.clone())
        } else {
            return Err(KoniError::Profile(format!(
                "schema-2 persona {} must define prompt or agent",
                persona.id
            )));
        };
        let capabilities = persona
            .capabilities
            .clone()
            .or_else(|| agent.map(|agent| agent.resource.capabilities.clone()))
            .ok_or_else(|| {
                KoniError::Profile(format!(
                    "schema-2 persona {} must define capabilities or inherit them from agent",
                    persona.id
                ))
            })?;
        validate_capabilities(&capabilities, &format!("persona {}", persona.id))?;
        let thinking_level = persona
            .thinking_level
            .clone()
            .or_else(|| agent.and_then(|agent| agent.resource.thinking_level.clone()));
        let description = if persona.description.trim().is_empty() {
            agent
                .map(|agent| agent.resource.description.clone())
                .unwrap_or_default()
        } else {
            persona.description.clone()
        };
        let skills = if persona.skills.is_empty() {
            agent
                .map(|agent| agent.resource.skills.clone())
                .unwrap_or_default()
        } else {
            persona.skills.clone()
        };
        Ok(ResolvedPersona {
            id: persona.id.clone(),
            description,
            instructions,
            instruction_source,
            model_role: persona.model_role.clone(),
            model: persona
                .model
                .clone()
                .or_else(|| agent.and_then(|agent| agent.resource.model.clone())),
            thinking_level: thinking_level.clone(),
            reasoning_effort: thinking_level,
            sandbox: capabilities_to_sandbox(&capabilities),
            capabilities: Some(capabilities),
            agent: agent.map(|agent| agent.resource.id.clone()),
            codex_agent: None,
            explicit_prompt: persona.prompt.is_some(),
            skills,
            native_codex_config_overrides: Vec::new(),
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
            operations: self.operations.keys().cloned().collect(),
            checks: self.checks.keys().cloned().collect(),
            receipt_coverages,
            review_effects,
            gate_policies: self.gate_policies.keys().cloned().collect(),
            variables: BTreeMap::new(),
        }
    }
}

fn validate_persona_schema_fields(schema_version: &str, persona: &PersonaDef) -> Result<()> {
    for (current, current_present, legacy, legacy_present) in [
        (
            "agent",
            persona.agent.is_some(),
            "codex_agent",
            persona.codex_agent.is_some(),
        ),
        (
            "thinking_level",
            persona.thinking_level.is_some(),
            "reasoning_effort",
            persona.reasoning_effort.is_some(),
        ),
        (
            "capabilities",
            persona.capabilities.is_some(),
            "sandbox",
            persona.sandbox.is_some(),
        ),
    ] {
        if current_present && legacy_present {
            return profile_error(format!(
                "persona {} defines conflicting {current} and {legacy} fields",
                persona.id
            ));
        }
    }
    if schema_version == PROFILE_SCHEMA_V2_VERSION {
        let legacy = [
            ("codex_agent", persona.codex_agent.is_some()),
            ("reasoning_effort", persona.reasoning_effort.is_some()),
            ("sandbox", persona.sandbox.is_some()),
        ]
        .into_iter()
        .filter_map(|(field, present)| present.then_some(field))
        .collect::<Vec<_>>();
        if !legacy.is_empty() {
            return profile_error(format!(
                "schema-2 persona {} contains legacy field{} {}; use agent, thinking_level, and capabilities",
                persona.id,
                if legacy.len() == 1 { "" } else { "s" },
                legacy.join(", ")
            ));
        }
    } else {
        let current = [
            ("agent", persona.agent.is_some()),
            ("thinking_level", persona.thinking_level.is_some()),
            ("capabilities", persona.capabilities.is_some()),
        ]
        .into_iter()
        .filter_map(|(field, present)| present.then_some(field))
        .collect::<Vec<_>>();
        if !current.is_empty() {
            return profile_error(format!(
                "schema-1 persona {} contains schema-2 field{} {}; migrate the profile before using provider-neutral persona fields",
                persona.id,
                if current.len() == 1 { "" } else { "s" },
                current.join(", ")
            ));
        }
    }
    Ok(())
}

fn validate_capabilities(capabilities: &CapabilityPolicyV2, owner: &str) -> Result<()> {
    if capabilities.workspace_access == WorkspaceAccessV2::ReadOnly
        && capabilities.commands == CommandAccessV2::WorkspaceWrite
    {
        return profile_error(format!(
            "{owner} grants workspace-write commands inside a read-only workspace"
        ));
    }
    if capabilities.workspace_access == WorkspaceAccessV2::ReadOnly
        && !capabilities.writable_roots.is_empty()
    {
        return profile_error(format!(
            "{owner} may not declare writable roots with read-only workspace access"
        ));
    }
    for root in &capabilities.writable_roots {
        if matches!(root.as_str(), "git_metadata" | "main_git_metadata") {
            return profile_error(format!(
                "{owner} writable root {root} is forbidden; Git metadata is compiler-only authority"
            ));
        }
        if matches!(root.as_str(), "project_root" | "ticket_worktree") {
            continue;
        }
        let root_path = Path::new(root);
        validate_relative_path(root_path, &format!("{owner} writable root"))?;
        if root_path
            .components()
            .next()
            .is_some_and(|component| matches!(component, Component::Normal(name) if name == ".git"))
        {
            return profile_error(format!(
                "{owner} writable root {root} is forbidden; .git is compiler-only authority"
            ));
        }
    }
    Ok(())
}

fn capabilities_to_sandbox(capabilities: &CapabilityPolicyV2) -> SandboxDef {
    SandboxDef {
        mode: match capabilities.workspace_access {
            WorkspaceAccessV2::ReadOnly => "read-only".to_owned(),
            WorkspaceAccessV2::WorkspaceWrite => "workspace-write".to_owned(),
        },
        approval_policy: "never".to_owned(),
        network_access: capabilities.network_access,
        writable_roots: capabilities.writable_roots.clone(),
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
        Self::compile_inner(input, None)
    }

    /// Compile a profile staged outside its eventual project root while still
    /// resolving project-scoped resources such as `.agents/skills` against the
    /// real repository. Migration callers use this before publishing `.koni`.
    pub fn compile_with_project_root(input: &Path, project_root: &Path) -> Result<CompiledProfile> {
        Self::compile_inner(input, Some(project_root))
    }

    fn compile_inner(input: &Path, project_root: Option<&Path>) -> Result<CompiledProfile> {
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
            validate_module_document(&module, &identity, &manifest.schema_version)?;
            merge_document(&mut document, module);
            imported_files.push(path);
        }

        let project_root = project_root
            .map(Path::to_path_buf)
            .unwrap_or_else(|| project_root_for_profile(&root));
        let (native_codex, koni_agents) = if manifest.schema_version == PROFILE_SCHEMA_V2_VERSION {
            (
                NativeCodexCatalog::discover_skills_only(&project_root)?,
                KoniAgentCatalogV2::discover(&project_root, &root)?,
            )
        } else {
            (
                NativeCodexCatalog::discover(&project_root)?,
                KoniAgentCatalogV2::empty(&project_root, &root),
            )
        };
        let mut profile = compile_document(
            manifest,
            root,
            imported_files,
            document,
            koni_agents,
            native_codex,
        )?;
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
        input.join(".koni/profile.yaml"),
        input.join(".koni/koni.yaml"),
        input.join(".koni/koni.toml"),
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
    reject_unsupported_keys("profile manifest", manifest.extensions.keys())?;
    if !matches!(
        manifest.schema_version.as_str(),
        PROFILE_SCHEMA_VERSION | PROFILE_SCHEMA_V2_VERSION
    ) {
        return Err(KoniError::Profile(format!(
            "unsupported profile schema {}; expected {} or {}",
            manifest.schema_version, PROFILE_SCHEMA_VERSION, PROFILE_SCHEMA_V2_VERSION
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
    validate_context_policy(&manifest.context)?;
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

fn validate_context_policy(policy: &ContextPolicy) -> Result<()> {
    let limits = [
        (
            "expansion_max_depth",
            policy.expansion_max_depth,
            CONTEXT_EXPANSION_DEPTH_HARD_MAX,
        ),
        (
            "expansion_max_nodes",
            policy.expansion_max_nodes,
            CONTEXT_EXPANSION_NODES_HARD_MAX,
        ),
        (
            "expansion_max_calls_per_step",
            policy.expansion_max_calls_per_step,
            CONTEXT_EXPANSION_CALLS_HARD_MAX,
        ),
        (
            "expansion_max_response_bytes",
            policy.expansion_max_response_bytes,
            CONTEXT_EXPANSION_RESPONSE_BYTES_HARD_MAX,
        ),
        (
            "note_max_bytes",
            policy.note_max_bytes,
            CONTEXT_NOTE_BYTES_HARD_MAX,
        ),
        (
            "note_max_calls_per_step",
            policy.note_max_calls_per_step,
            CONTEXT_NOTE_CALLS_HARD_MAX,
        ),
        (
            "notes_max_bundle_bytes",
            policy.notes_max_bundle_bytes,
            CONTEXT_NOTES_BUNDLE_BYTES_HARD_MAX,
        ),
    ];
    for (field, value, maximum) in limits {
        if value == 0 {
            return profile_error(format!("context.{field} must be positive"));
        }
        if value > maximum {
            return profile_error(format!(
                "context.{field} must not exceed the compiler hard maximum {maximum}"
            ));
        }
    }
    if policy.note_max_bytes > policy.notes_max_bundle_bytes {
        return profile_error(
            "context.note_max_bytes must not exceed context.notes_max_bundle_bytes".to_owned(),
        );
    }
    Ok(())
}

fn validate_module_document(
    module: &ModuleDocument,
    identity: &str,
    profile_schema: &str,
) -> Result<()> {
    reject_unsupported_keys(
        &format!("profile module {identity}"),
        module.extensions.keys(),
    )?;
    if profile_schema == PROFILE_SCHEMA_V2_VERSION
        && let Some(module_schema) = &module.schema_version
        && module_schema != profile_schema
    {
        return profile_error(format!(
            "profile module {identity} declares schema {module_schema}, but the profile declares {profile_schema}"
        ));
    }
    Ok(())
}

fn reject_unsupported_keys<'a>(owner: &str, keys: impl Iterator<Item = &'a String>) -> Result<()> {
    let keys = keys.cloned().collect::<Vec<_>>();
    if keys.is_empty() {
        return Ok(());
    }
    profile_error(format!(
        "{owner} contains unsupported field{}: {}",
        if keys.len() == 1 { "" } else { "s" },
        keys.join(", ")
    ))
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
    // Ticket scopes are matched as exact path prefixes, never parsed by a glob
    // engine. Reject the two unambiguous wildcard characters while preserving
    // ordinary repository names such as Next.js `[companyId]` route segments.
    if raw.contains(['*', '?']) {
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
    target
        .graph_constraints
        .append(&mut source.graph_constraints);
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
    koni_agents: KoniAgentCatalogV2,
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
        graph_constraints: unique_map("graph constraint", document.graph_constraints, |item| {
            &item.id
        })?,
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
        koni_agents,
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
    validate_graph_constraints(profile)?;
    validate_gate_policies(profile)?;
    validate_rules(profile)?;
    validate_proof_preparation_predicate_declarations(profile)?;
    validate_operations(profile)?;
    validate_planning_seed_operation(profile)?;
    validate_workflows(profile)?;
    validate_actions(profile)?;
    validate_checks(profile)?;
    validate_ticket_worktree_setup(profile)?;
    validate_personas(profile)?;
    validate_reports(profile)?;
    validate_views(profile)?;
    validate_state_machines(profile)?;
    Ok(())
}

fn validate_proof_preparation_predicate_declarations(profile: &CompiledProfile) -> Result<()> {
    fn validate(owner: &str, predicate: &Predicate, profile: &CompiledProfile) -> Result<()> {
        match predicate {
            Predicate::Constant(_) | Predicate::Exists(_) => Ok(()),
            Predicate::All(envelope) => envelope
                .all
                .iter()
                .try_for_each(|predicate| validate(owner, predicate, profile)),
            Predicate::Any(envelope) => envelope
                .any
                .iter()
                .try_for_each(|predicate| validate(owner, predicate, profile)),
            Predicate::Not(envelope) => validate(owner, &envelope.not, profile),
            Predicate::ForAll(envelope) => validate(owner, &envelope.for_all.satisfies, profile),
            Predicate::Leaf(leaf) if leaf.op == PredicateOp::ProofPreparationCurrent => {
                let Some(operation_id) = leaf.preparation_operation.as_deref() else {
                    return profile_error(format!(
                        "{owner} proof_preparation_current requires preparation_operation"
                    ));
                };
                let Some(check_id) = leaf.check.as_deref() else {
                    return profile_error(format!(
                        "{owner} proof_preparation_current requires check"
                    ));
                };
                let operation = profile.operations.get(operation_id).ok_or_else(|| {
                    KoniError::Profile(format!(
                        "{owner} proof_preparation_current references unknown operation {operation_id}"
                    ))
                })?;
                if operation.proof_source_preparation_check.as_deref() != Some(check_id) {
                    return profile_error(format!(
                        "{owner} proof_preparation_current operation {operation_id} declares proof_source_preparation_check {:?}, not {check_id}",
                        operation.proof_source_preparation_check
                    ));
                }
                Ok(())
            }
            Predicate::Leaf(_) => Ok(()),
        }
    }

    for edge in &profile.edge_types {
        if let Some(predicate) = &edge.when {
            validate(
                &format!("edge {}.{}", edge.source, edge.relation),
                predicate,
                profile,
            )?;
        }
    }
    for query in profile.queries.values() {
        if let Some(predicate) = &query.predicate {
            validate(&format!("query {}", query.id), predicate, profile)?;
        }
    }
    for rule in profile.rules.values() {
        validate(&format!("rule {}", rule.id), &rule.when, profile)?;
    }
    for check in profile.checks.values() {
        if let Some(predicate) = &check.predicate {
            validate(&format!("check {}", check.id), predicate, profile)?;
        }
    }
    for policy in profile.gate_policies.values() {
        if let Some(predicate) = &policy.execution_ready {
            validate(
                &format!("gate policy {} execution_ready", policy.id),
                predicate,
                profile,
            )?;
        }
    }
    Ok(())
}

fn validate_planning_seed_operation(profile: &CompiledProfile) -> Result<()> {
    let Some(operation_id) = profile
        .manifest
        .initialization
        .planning_seed_operation
        .as_deref()
    else {
        return Ok(());
    };
    let root_type = profile
        .manifest
        .initialization
        .root_node_type
        .as_deref()
        .ok_or_else(|| {
            KoniError::Profile(
                "initialization planning_seed_operation requires root_node_type".to_owned(),
            )
        })?;
    let operation = profile.operations.get(operation_id).ok_or_else(|| {
        KoniError::Profile(format!(
            "initialization planning_seed_operation references unknown operation registry entry {operation_id}"
        ))
    })?;
    if operation.stage != "initialization"
        || operation.target_types.len() != 1
        || operation.target_types.first().map(String::as_str) != Some(root_type)
    {
        return profile_error(format!(
            "initialization planning_seed_operation {operation_id} must use stage initialization and target only root node type {root_type}"
        ));
    }
    if !operation
        .allowed_existing_node_types
        .iter()
        .any(|node_type| node_type == root_type)
    {
        return profile_error(format!(
            "initialization planning_seed_operation {operation_id} must permit existing root node type {root_type}"
        ));
    }
    if operation
        .existing_node_edge_additions_only
        .contains_key(root_type)
    {
        return profile_error(format!(
            "initialization planning_seed_operation {operation_id} must permit semantic root updates, not only edge additions for {root_type}"
        ));
    }
    if operation.allowed_new_node_types.is_empty() || operation.max_new_nodes == Some(0) {
        return profile_error(format!(
            "initialization planning_seed_operation {operation_id} must permit at least one new typed graph node"
        ));
    }
    if operation.workflow.is_some()
        || !operation.checks.is_empty()
        || operation.receipt_coverage.is_some()
        || !operation.review_effects.is_empty()
        || operation.change_control_barrier
        || !operation.change_control.is_default()
        || operation.allow_node_deletion
        || operation.allow_edge_deletion
        || operation.allow_gate_contract_edits
        || operation.terminal_resolver
    {
        return profile_error(format!(
            "initialization planning_seed_operation {operation_id} must be a compiler-only graph authority without workflow, checks, receipt/review effects, deletion, gate, change-control, or recovery behavior"
        ));
    }
    if let Some(rule) = profile.rules.values().find(|rule| {
        rule.emit.as_ref().is_some_and(|emit| {
            emit.operation == operation.public_operation()
                || emit.registry_entry_id.as_deref() == Some(operation_id)
        })
    }) {
        return profile_error(format!(
            "initialization planning_seed_operation {operation_id} is compiler-only and cannot be emitted by rule {}",
            rule.id
        ));
    }
    Ok(())
}

fn validate_ticket_worktree_setup(profile: &CompiledProfile) -> Result<()> {
    let Some(check_id) = &profile.manifest.git.ticket_worktree_setup_check else {
        return Ok(());
    };
    if !profile.manifest.git.enabled {
        return profile_error(
            "git.ticket_worktree_setup_check requires git.enabled = true".to_owned(),
        );
    }
    let check = profile.checks.get(check_id).ok_or_else(|| {
        KoniError::Profile(format!(
            "git.ticket_worktree_setup_check references unknown check {check_id}"
        ))
    })?;
    if check.kind != CheckKind::Command
        || check.effect != ProcessEffect::WorkspaceWrite
        || check.argv.is_empty()
        || check.argv_from.is_some()
        || check.command_source.is_some()
    {
        return profile_error(format!(
            "git.ticket_worktree_setup_check {check_id} must be a static workspace_write command check"
        ));
    }
    if check.receipt_freshness != ReceiptFreshness::Current
        || check.allow_nonpassing_receipt
        || check.result_protocol.is_some()
        || check.dynamic_result.is_some()
    {
        return profile_error(format!(
            "git.ticket_worktree_setup_check {check_id} must require a current passing process receipt without a result protocol"
        ));
    }
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
        reject_unsupported_keys(&format!("node type {}", node.id), node.extensions.keys())?;
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
        for (field, definition) in &node.fields {
            validate_field_collection_constraints(node, field, definition)?;
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
        let mut visible_owned = BTreeSet::new();
        for field in &node.agent_visible_compiler_owned_fields {
            if field.trim().is_empty() || !visible_owned.insert(field) {
                return profile_error(format!(
                    "node type {} agent_visible_compiler_owned_fields must contain unique nonempty paths",
                    node.id
                ));
            }
            if !owned.contains(field) {
                return profile_error(format!(
                    "node type {} exposes {} to agents but it is not compiler-owned",
                    node.id, field
                ));
            }
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

fn validate_field_collection_constraints(
    node: &NodeTypeDef,
    path: &str,
    field: &FieldDef,
) -> Result<()> {
    if let Some(reference) = &field.subset_of {
        validate_compatible_scalar_list_reference(node, path, field, "subset_of", reference)?;
    }
    if let Some(reference) = &field.disjoint_from {
        validate_compatible_scalar_list_reference(node, path, field, "disjoint_from", reference)?;
    }
    if let Some(property) = &field.unique_by {
        validate_unique_by_contract(node, path, field, property)?;
    }
    if let Some(items) = &field.items {
        validate_field_collection_constraints(node, &format!("{path}[]"), items)?;
    }
    for (name, property) in &field.properties {
        validate_field_collection_constraints(node, &format!("{path}.{name}"), property)?;
    }
    Ok(())
}

fn validate_compatible_scalar_list_reference(
    node: &NodeTypeDef,
    path: &str,
    field: &FieldDef,
    keyword: &str,
    reference: &str,
) -> Result<FieldType> {
    validate_contract_field_path(reference).map_err(|error| {
        KoniError::Profile(format!(
            "node type {} field {path} has invalid {keyword} reference {reference:?}: {error}",
            node.id
        ))
    })?;
    let source_item_type = constrained_scalar_item_type(field).ok_or_else(|| {
        KoniError::Profile(format!(
            "node type {} field {path} configures {keyword} but must be a list with string or path items",
            node.id
        ))
    })?;
    let target = node_field_definition(node, reference).ok_or_else(|| {
        KoniError::Profile(format!(
            "node type {} field {path} {keyword} references undeclared root-node field {reference}",
            node.id
        ))
    })?;
    let target_item_type = constrained_scalar_item_type(target).ok_or_else(|| {
        KoniError::Profile(format!(
            "node type {} field {path} {keyword} reference {reference} must be a list with string or path items",
            node.id
        ))
    })?;
    if source_item_type != target_item_type {
        return profile_error(format!(
            "node type {} field {path} {keyword} reference {reference} has incompatible item type {:?}; expected {:?}",
            node.id, target_item_type, source_item_type
        ));
    }
    Ok(source_item_type)
}

fn constrained_scalar_item_type(field: &FieldDef) -> Option<FieldType> {
    if field.value_type != FieldType::List {
        return None;
    }
    let item_type = field.items.as_deref()?.value_type;
    matches!(item_type, FieldType::String | FieldType::Path).then_some(item_type)
}

fn validate_unique_by_contract(
    node: &NodeTypeDef,
    path: &str,
    field: &FieldDef,
    property: &str,
) -> Result<()> {
    validate_contract_field_path(property).map_err(|error| {
        KoniError::Profile(format!(
            "node type {} field {path} has invalid unique_by property {property:?}: {error}",
            node.id
        ))
    })?;
    if property.contains('.') || property.starts_with("$.") || property.starts_with("spec.") {
        return profile_error(format!(
            "node type {} field {path} unique_by property {property:?} must name one direct list-item property",
            node.id
        ));
    }
    let items = field.items.as_deref().filter(|items| {
        field.value_type == FieldType::List && items.value_type == FieldType::Object
    });
    let Some(items) = items else {
        return profile_error(format!(
            "node type {} field {path} configures unique_by but must be a list with object items",
            node.id
        ));
    };
    let Some(identity) = items.properties.get(property) else {
        return profile_error(format!(
            "node type {} field {path} unique_by references undeclared list-item property {property}",
            node.id
        ));
    };
    if !identity.required {
        return profile_error(format!(
            "node type {} field {path} unique_by property {property} must be required",
            node.id
        ));
    }
    if !matches!(
        identity.value_type,
        FieldType::String
            | FieldType::Integer
            | FieldType::Number
            | FieldType::Boolean
            | FieldType::Path
            | FieldType::NodeRef
    ) {
        return profile_error(format!(
            "node type {} field {path} unique_by property {property} must be a scalar string, number, boolean, path, or node_ref",
            node.id
        ));
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
        if edge.bidirectional {
            let inverse = edge
                .inverse
                .as_deref()
                .filter(|value| !value.trim().is_empty());
            let Some(inverse) = inverse else {
                return profile_error(format!(
                    "bidirectional edge {}.{} requires a nonempty inverse alias",
                    edge.source, edge.relation
                ));
            };
            if inverse == edge.relation {
                return profile_error(format!(
                    "bidirectional edge {}.{} inverse alias must differ from its canonical relation",
                    edge.source, edge.relation
                ));
            }
            for target_type in &edge.targets {
                if profile.edge_types.iter().any(|candidate| {
                    candidate.source == *target_type && candidate.relation == inverse
                }) {
                    return profile_error(format!(
                        "bidirectional edge {}.{} already exposes reverse alias {target_type}.{inverse}; remove the redundant reciprocal edge declaration",
                        edge.source, edge.relation
                    ));
                }
            }
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
        .filter(|edge| edge.inverse.is_some() && !edge.bidirectional)
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
            if fields_required == rank.fields.is_empty() {
                return profile_error(format!(
                    "gate policy {} rank {} has invalid fields for {:?}",
                    policy.id, rank.id, rank.kind
                ));
            }
            if relations_required == rank.relations.is_empty() {
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
        || leaf.preparation_operation.is_some()
        || leaf.preparation_targets.is_some()
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

fn configured_relation_names(profile: &CompiledProfile) -> BTreeSet<&str> {
    profile
        .edge_types
        .iter()
        .flat_map(|edge| {
            std::iter::once(edge.relation.as_str()).chain(
                edge.bidirectional
                    .then_some(edge.inverse.as_deref())
                    .flatten(),
            )
        })
        .collect()
}

fn validate_queries(profile: &CompiledProfile) -> Result<()> {
    let base_symbols = profile.expression_symbols();
    let relation_names = configured_relation_names(profile);
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

fn validate_graph_constraints(profile: &CompiledProfile) -> Result<()> {
    let symbols = profile.expression_symbols();
    for constraint in profile.graph_constraints.values() {
        for (side_name, side) in [("left", &constraint.left), ("right", &constraint.right)] {
            side.select.validate(&symbols).map_err(|error| {
                profile_expr_error(
                    "graph constraint",
                    &constraint.id,
                    format!("{side_name} selector: {error}"),
                )
            })?;
            if side.node_types.is_empty()
                || side
                    .node_types
                    .iter()
                    .any(|node_type| node_type.trim().is_empty())
                || side.node_types.iter().collect::<BTreeSet<_>>().len() != side.node_types.len()
            {
                return profile_error(format!(
                    "graph constraint {} {} node_types must be nonempty, unique, trimmed names",
                    constraint.id, side_name
                ));
            }
            validate_known_node_types(
                profile,
                &side.node_types,
                &format!("graph constraint {} {side_name}", constraint.id),
            )?;
            validate_contract_field_path(&side.field).map_err(|error| {
                KoniError::Profile(format!(
                    "graph constraint {} {side_name} has invalid field {:?}: {error}",
                    constraint.id, side.field
                ))
            })?;
            for node_type in &side.node_types {
                let definition = node_field_definition(&profile.node_types[node_type], &side.field)
                    .ok_or_else(|| {
                        KoniError::Profile(format!(
                            "graph constraint {} {side_name} field {} is not declared by node type {}",
                            constraint.id, side.field, node_type
                        ))
                    })?;
                let path_typed = definition.value_type == FieldType::Path
                    || (definition.value_type == FieldType::List
                        && definition
                            .items
                            .as_deref()
                            .is_some_and(|item| item.value_type == FieldType::Path));
                if !path_typed {
                    return profile_error(format!(
                        "graph constraint {} {side_name} field {} on node type {} must be Path or list<Path>",
                        constraint.id, side.field, node_type
                    ));
                }
            }
        }
        if constraint.left == constraint.right && !constraint.distinct_nodes {
            return profile_error(format!(
                "graph constraint {} compares one path set with itself and must set distinct_nodes: true",
                constraint.id
            ));
        }
    }
    Ok(())
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
        let unsupported_extensions = operation
            .extensions
            .keys()
            .filter(|key| key.as_str() != "portfolio_guidance");
        reject_unsupported_keys(
            &format!("operation {}", operation.id),
            unsupported_extensions,
        )?;
        if let Some(guidance) = operation.extensions.get("portfolio_guidance") {
            validate_portfolio_guidance(&operation.id, guidance)?;
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
        validate_proof_source_preparation_operation(profile, operation)?;
        validate_review_effects(profile, operation)?;
        validate_change_control_operation(profile, operation)?;
        validate_terminal_resolver(operation)?;
    }
    let terminal_resolvers = profile
        .operations
        .values()
        .filter(|operation| operation.terminal_resolver)
        .map(|operation| operation.id.as_str())
        .collect::<Vec<_>>();
    if terminal_resolvers.len() > 1 {
        return profile_error(format!(
            "profile declares multiple terminal resolver operations: {}",
            terminal_resolvers.join(", ")
        ));
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

fn validate_proof_source_preparation_operation(
    profile: &CompiledProfile,
    operation: &OperationDef,
) -> Result<()> {
    let Some(check_id) = operation.proof_source_preparation_check.as_deref() else {
        return Ok(());
    };
    validate_identifier("proof source preparation check", check_id)?;
    let check = profile.checks.get(check_id).ok_or_else(|| {
        KoniError::Profile(format!(
            "operation {} proof_source_preparation_check references unknown check {check_id}",
            operation.id
        ))
    })?;
    let graph_set = check.graph_set.as_ref().filter(|_| check.kind == CheckKind::Composite).ok_or_else(
        || {
            KoniError::Profile(format!(
                "operation {} proof_source_preparation_check {check_id} must be a composite graph-set check",
                operation.id
            ))
        },
    )?;
    if !normalized_check_operations(profile, check).contains(operation.public_operation()) {
        return profile_error(format!(
            "operation {} proof_source_preparation_check {check_id} does not apply to operation {}",
            operation.id,
            operation.public_operation()
        ));
    }

    let workflow_id = operation.workflow.as_deref().ok_or_else(|| {
        KoniError::Profile(format!(
            "operation {} proof_source_preparation_check requires a workflow",
            operation.id
        ))
    })?;
    let workflow = profile.workflows.get(workflow_id).ok_or_else(|| {
        KoniError::Profile(format!(
            "operation {} proof_source_preparation_check references missing workflow {workflow_id}",
            operation.id
        ))
    })?;
    let scheduled = workflow
        .steps
        .iter()
        .flat_map(|step| {
            step.checks
                .iter()
                .filter(move |scheduled| scheduled.as_str() == check_id)
                .map(move |_| step)
        })
        .collect::<Vec<_>>();
    let [baseline_step] = scheduled.as_slice() else {
        return profile_error(format!(
            "operation {} proof_source_preparation_check {check_id} must be scheduled exactly once in workflow {workflow_id}; found {}",
            operation.id,
            scheduled.len()
        ));
    };
    if !baseline_step.required || baseline_step.kind == WorkflowStepKind::Review {
        return profile_error(format!(
            "operation {} proof source preparation step {} must be required and non-review",
            operation.id, baseline_step.id
        ));
    }
    if check.receipt_type.trim().is_empty()
        || !baseline_step
            .required_receipts
            .contains(&check.receipt_type)
    {
        return profile_error(format!(
            "operation {} proof source preparation step {} must require composite receipt type {}",
            operation.id, baseline_step.id, check.receipt_type
        ));
    }

    for child_id in graph_set_child_check_ids(profile, check, graph_set)? {
        let child = profile
            .checks
            .get(&child_id)
            .expect("graph-set child IDs are registry validated");
        if child.kind != CheckKind::Command || child.effect != ProcessEffect::ReadOnly {
            return profile_error(format!(
                "operation {} proof source preparation child {child_id} must be a read-only command check",
                operation.id
            ));
        }
        if child.receipt_freshness != ReceiptFreshness::Historical {
            return profile_error(format!(
                "operation {} proof source preparation child {child_id} must declare receipt_freshness: historical",
                operation.id
            ));
        }
        if !normalized_check_operations(profile, child).contains(operation.public_operation()) {
            return profile_error(format!(
                "operation {} proof source preparation child {child_id} does not apply to operation {}",
                operation.id,
                operation.public_operation()
            ));
        }
    }

    let review_steps = workflow
        .steps
        .iter()
        .filter(|step| step.kind == WorkflowStepKind::Review)
        .collect::<Vec<_>>();
    let [review_step] = review_steps.as_slice() else {
        return profile_error(format!(
            "operation {} proof source preparation workflow {workflow_id} requires exactly one review step; found {}",
            operation.id,
            review_steps.len()
        ));
    };
    if !review_step.required
        || review_step.persona == baseline_step.persona
        || !workflow_step_has_ancestor(
            &workflow
                .steps
                .iter()
                .map(|step| {
                    (
                        step.id.as_str(),
                        step.depends_on.iter().cloned().collect::<BTreeSet<_>>(),
                    )
                })
                .collect::<HashMap<_, _>>(),
            &review_step.id,
            &baseline_step.id,
        )
    {
        return profile_error(format!(
            "operation {} proof source preparation review {} must be required, use a persona independent from {}, and transitively depend on it",
            operation.id, review_step.id, baseline_step.id
        ));
    }
    Ok(())
}

fn graph_set_child_check_ids(
    profile: &CompiledProfile,
    parent: &CheckDef,
    graph_set: &GraphCheckSetDef,
) -> Result<BTreeSet<String>> {
    match (
        graph_set.member_check.as_deref(),
        graph_set.member_check_field.as_deref(),
    ) {
        (Some(check_id), None) => {
            if !profile.checks.contains_key(check_id) {
                return profile_error(format!(
                    "composite check {} graph_set references unknown child check {check_id}",
                    parent.id
                ));
            }
            Ok(BTreeSet::from([check_id.to_owned()]))
        }
        (None, Some(field_path)) => {
            let mut check_ids = BTreeSet::new();
            for node_type in &graph_set.member_node_types {
                let definition = profile.node_types.get(node_type).ok_or_else(|| {
                    KoniError::Profile(format!(
                        "composite check {} references unknown member node type {node_type}",
                        parent.id
                    ))
                })?;
                let field = graph_set_node_field(definition, node_type, field_path, &parent.id)?;
                for value in &field.enum_values {
                    let Some(check_id) = value.as_str() else {
                        return profile_error(format!(
                            "composite check {} graph_set member_check_field {} on node type {} must contain only string check IDs",
                            parent.id, field_path, node_type
                        ));
                    };
                    if !profile.checks.contains_key(check_id) {
                        return profile_error(format!(
                            "composite check {} graph_set references unknown child check {check_id}",
                            parent.id
                        ));
                    }
                    check_ids.insert(check_id.to_owned());
                }
            }
            Ok(check_ids)
        }
        _ => profile_error(format!(
            "composite check {} graph_set requires exactly one child-check source",
            parent.id
        )),
    }
}

fn validate_terminal_resolver(operation: &OperationDef) -> Result<()> {
    if !operation.terminal_resolver {
        return Ok(());
    }
    if operation.workflow.is_none() {
        return profile_error(format!(
            "terminal resolver operation {} must name a workflow",
            operation.id
        ));
    }
    if !operation.gate_blocking_exempt {
        return profile_error(format!(
            "terminal resolver operation {} must be gate_blocking_exempt",
            operation.id
        ));
    }
    if operation.change_control_barrier {
        return profile_error(format!(
            "terminal resolver operation {} must not create a change-control barrier",
            operation.id
        ));
    }
    if operation.allow_node_deletion {
        return profile_error(format!(
            "terminal resolver operation {} must not allow node deletion",
            operation.id
        ));
    }
    if operation
        .single_flight_group
        .as_deref()
        .is_none_or(|group| group.trim().is_empty())
    {
        return profile_error(format!(
            "terminal resolver operation {} must declare a nonempty single_flight_group",
            operation.id
        ));
    }
    if !operation.change_control.is_default() {
        return profile_error(format!(
            "terminal resolver operation {} must use closed ordinary change control",
            operation.id
        ));
    }
    Ok(())
}

fn validate_portfolio_guidance(operation_id: &str, guidance: &Value) -> Result<()> {
    let owner = format!("operation {operation_id} portfolio_guidance");
    let object = guidance
        .as_object()
        .ok_or_else(|| KoniError::Profile(format!("{owner} must be an object")))?;
    const ALLOWED: [&str; 5] = [
        "preferred_count",
        "unit",
        "group_when",
        "split_when",
        "avoid",
    ];
    let unsupported = object
        .keys()
        .filter(|key| !ALLOWED.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported.is_empty() {
        return profile_error(format!(
            "{owner} contains unsupported field{}: {}",
            if unsupported.len() == 1 { "" } else { "s" },
            unsupported.join(", ")
        ));
    }
    object
        .get("preferred_count")
        .and_then(Value::as_u64)
        .filter(|count| *count > 0)
        .ok_or_else(|| {
            KoniError::Profile(format!(
                "{owner}.preferred_count must be a positive integer"
            ))
        })?;
    for field in ["unit", "group_when", "split_when", "avoid"] {
        if object
            .get(field)
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return profile_error(format!("{owner}.{field} must be a nonempty string"));
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
    let relation_names = configured_relation_names(profile);
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
            let destination = left.as_str();
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
                if let Some(manifest) = definition.filesystem_manifest.as_ref() {
                    let output = manifest.output_field.as_str();
                    if destination == output
                        || destination.starts_with(&format!("{output}."))
                        || output.starts_with(&format!("{destination}."))
                    {
                        return profile_error(format!(
                            "operation {} review effect {} destination {} overlaps compiler-derived filesystem manifest output {} for node type {}",
                            operation.id, effect.id, destination, output, node_type
                        ));
                    }
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
        if workflow.review_failure_reopen_from.is_some()
            && !workflow.review_failure_routes.is_empty()
        {
            return profile_error(format!(
                "workflow {} cannot configure both review_failure_reopen_from and review_failure_routes",
                workflow.id
            ));
        }
        for (domain, route) in &workflow.review_failure_routes {
            validate_identifier("review failure domain", domain)?;
            if domain == "none" {
                return profile_error(format!(
                    "workflow {} review failure domain none is reserved for passed reviews",
                    workflow.id
                ));
            }
            if route.description.trim().is_empty() {
                return profile_error(format!(
                    "workflow {} review failure route {} requires a nonempty description",
                    workflow.id, domain
                ));
            }
            match route.disposition {
                ReviewFailureDisposition::Reopen => {
                    let Some(reopen_from) = route.reopen_from.as_deref() else {
                        return profile_error(format!(
                            "workflow {} review failure route {} with disposition reopen requires reopen_from",
                            workflow.id, domain
                        ));
                    };
                    let Some(reopen_step) =
                        workflow.steps.iter().find(|step| step.id == reopen_from)
                    else {
                        return profile_error(format!(
                            "workflow {} review failure route {} references unknown reopen_from step {}",
                            workflow.id, domain, reopen_from
                        ));
                    };
                    if reopen_step.kind == WorkflowStepKind::Review {
                        return profile_error(format!(
                            "workflow {} review failure route {} cannot reopen review step {}",
                            workflow.id, domain, reopen_from
                        ));
                    }
                    if route.recovery.is_some() || route.recovery_instructions.is_some() {
                        return profile_error(format!(
                            "workflow {} review failure route {} with disposition reopen cannot configure blocked recovery",
                            workflow.id, domain
                        ));
                    }
                }
                ReviewFailureDisposition::Block => {
                    if route.reopen_from.is_some() {
                        return profile_error(format!(
                            "workflow {} review failure route {} with disposition block cannot configure reopen_from",
                            workflow.id, domain
                        ));
                    }
                    if route.recovery != Some(ReviewFailureRecovery::ReplanFromCleanIntegration)
                        || route
                            .recovery_instructions
                            .as_deref()
                            .is_none_or(|instructions| instructions.trim().is_empty())
                    {
                        return profile_error(format!(
                            "workflow {} review failure route {} with disposition block requires replan_from_clean_integration and nonempty recovery_instructions",
                            workflow.id, domain
                        ));
                    }
                }
            }
        }
        let workflow_scope_symbols = profile
            .expression_symbols()
            .with_variable("target", ValueType::Node)
            .with_variable("ticket_read_scope", ValueType::NodeSet)
            .with_variable("ticket_write_scope", ValueType::NodeSet);
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
            for (label, selector) in [
                ("read_scope", &step.read_scope),
                ("write_scope", &step.write_scope),
            ] {
                selector
                    .validate(&workflow_scope_symbols)
                    .map_err(|error| {
                        profile_expr_error(
                            "workflow step",
                            &format!("{}:{}:{label}", workflow.id, step.id),
                            error,
                        )
                    })?;
            }
            if let Some(paths) = &step.read_paths {
                validate_path_scopes(
                    &format!("workflow {} step {}", workflow.id, step.id),
                    "read_paths",
                    paths,
                    &workflow_scope_symbols,
                )?;
            }
            if let Some(paths) = &step.write_paths {
                validate_path_scopes(
                    &format!("workflow {} step {}", workflow.id, step.id),
                    "write_paths",
                    paths,
                    &workflow_scope_symbols,
                )?;
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
        for step in &workflow.steps {
            let Some(source_step_id) = step.preserve_source_paths_from.as_deref() else {
                continue;
            };
            validate_identifier("preserve_source_paths_from step", source_step_id)?;
            let Some(source_step) = workflow
                .steps
                .iter()
                .find(|candidate| candidate.id == source_step_id)
            else {
                return profile_error(format!(
                    "workflow {} step {} preserve_source_paths_from references unknown step {}",
                    workflow.id, step.id, source_step_id
                ));
            };
            if !workflow_step_has_ancestor(&dependencies, &step.id, source_step_id) {
                return profile_error(format!(
                    "workflow {} step {} preserve_source_paths_from {} must name a transitive dependency",
                    workflow.id, step.id, source_step_id
                ));
            }
            let current_sets = workflow_step_graph_sets(profile, step);
            let source_sets = workflow_step_graph_sets(profile, source_step);
            if current_sets.len() != 1 || source_sets.len() != 1 {
                return profile_error(format!(
                    "workflow {} step {} preserve_source_paths_from {} requires exactly one graph-set check on each step (found {} and {})",
                    workflow.id,
                    step.id,
                    source_step_id,
                    current_sets.len(),
                    source_sets.len()
                ));
            }
            if !graph_sets_preserve_compatible(current_sets[0].1, source_sets[0].1) {
                return profile_error(format!(
                    "workflow {} step {} graph-set check {} is not source-compatible with dependency step {} check {}",
                    workflow.id, step.id, current_sets[0].0, source_step_id, source_sets[0].0
                ));
            }
        }
    }
    Ok(())
}

fn workflow_step_has_ancestor(
    dependencies: &HashMap<&str, BTreeSet<String>>,
    step_id: &str,
    expected_ancestor: &str,
) -> bool {
    let mut pending = vec![step_id.to_owned()];
    let mut visited = BTreeSet::new();
    while let Some(current) = pending.pop() {
        if !visited.insert(current.clone()) {
            continue;
        }
        for dependency in dependencies.get(current.as_str()).into_iter().flatten() {
            if dependency == expected_ancestor {
                return true;
            }
            pending.push(dependency.clone());
        }
    }
    false
}

fn workflow_step_graph_sets<'a>(
    profile: &'a CompiledProfile,
    step: &'a WorkflowStepDef,
) -> Vec<(&'a str, &'a GraphCheckSetDef)> {
    step.checks
        .iter()
        .filter_map(|check_id| {
            profile
                .checks
                .get(check_id)
                .and_then(|check| check.graph_set.as_ref())
                .map(|graph_set| (check_id.as_str(), graph_set))
        })
        .collect()
}

fn graph_sets_preserve_compatible(current: &GraphCheckSetDef, source: &GraphCheckSetDef) -> bool {
    current.members == source.members
        && current.member_node_types == source.member_node_types
        && current.source_paths_field == source.source_paths_field
        && current.covered_paths_field == source.covered_paths_field
        && current.working_directory_field == source.working_directory_field
        && current.statuses == source.statuses
        && current.status_excluding == source.status_excluding
        && current.min_members == source.min_members
        && current.max_members == source.max_members
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
        "snapshot.write"
            if step
                .args
                .get("recompute_from_integration_projection")
                .and_then(Value::as_bool)
                .unwrap_or(false) =>
        {
            // Projection refresh writes only declared compiler-owned graph
            // fields and validates the result internally; semantic validation
            // therefore remains current for the following integration CAS.
            PrimitiveEffect::write(ReversibleWrite, [Audit, Graph], false)
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
    if let Some(action) = profile.actions.values().find(|action| {
        action
            .recipe
            .iter()
            .chain(&action.compensation)
            .any(|step| {
                step.primitive == "recovery.dispatch"
                    && step.args.get("mode").and_then(Value::as_str)
                        == Some("block_and_emit_single_resolver")
            })
    }) {
        let resolver_count = profile
            .operations
            .values()
            .filter(|operation| operation.terminal_resolver)
            .count();
        if resolver_count != 1 {
            return profile_error(format!(
                "action {} uses recovery.dispatch mode block_and_emit_single_resolver but the profile declares {resolver_count} terminal resolver operations; expected exactly one",
                action.id
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
        match (check.kind, check.graph_set.as_ref()) {
            (CheckKind::Composite, Some(graph_set)) => {
                validate_graph_check_set(profile, check, graph_set)?;
            }
            (CheckKind::Composite, None) => {
                return profile_error(format!("composite check {} requires graph_set", check.id));
            }
            (_, Some(_)) => {
                return profile_error(format!(
                    "non-composite check {} may not configure graph_set",
                    check.id
                ));
            }
            (_, None) => {}
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
        if check
            .expected_exit_codes
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != check.expected_exit_codes.len()
        {
            return profile_error(format!(
                "check {} expected_exit_codes must not contain duplicates",
                check.id
            ));
        }
        if !matches!(check.kind, CheckKind::Command) && !check.expected_exit_codes.is_empty() {
            return profile_error(format!(
                "non-command check {} may not configure expected_exit_codes",
                check.id
            ));
        }
        if check.receipt_freshness == ReceiptFreshness::Historical
            && (!matches!(check.kind, CheckKind::Command)
                || check.effect != ProcessEffect::ReadOnly)
        {
            return profile_error(format!(
                "check {} historical receipt_freshness requires a read_only command check",
                check.id
            ));
        }
        if check.receipt_freshness == ReceiptFreshness::Historical
            && (check.result_protocol.is_some()
                || check.dynamic_result.is_some()
                || !check.artifact_paths.is_empty())
        {
            return profile_error(format!(
                "check {} historical receipt_freshness may record process evidence but not current result or artifact evidence",
                check.id
            ));
        }
        if check.composed_replay == ComposedReplayPolicy::Never
            && !matches!(check.kind, CheckKind::Command)
        {
            return profile_error(format!(
                "check {} composed_replay is only meaningful for command checks",
                check.id
            ));
        }
        if check.expected_exit_codes.iter().any(|code| {
            check
                .retry_policy
                .transient_exit_codes
                .iter()
                .any(|transient| transient == code)
        }) {
            return profile_error(format!(
                "check {} may not use the same exit code as both expected and transient",
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
        let effective_attempts = check.retry_policy.max_attempts.max(1);
        if effective_attempts > crate::process::MAX_CHECK_ATTEMPTS as usize {
            return profile_error(format!(
                "check {} retry_policy requests {effective_attempts} attempts; the maximum is {}",
                check.id,
                crate::process::MAX_CHECK_ATTEMPTS
            ));
        }
        let aggregate_seconds = check
            .timeout_seconds
            .checked_mul(effective_attempts as u64)
            .ok_or_else(|| {
                KoniError::Profile(format!(
                    "check {} aggregate retry timeout overflowed",
                    check.id
                ))
            })?;
        if aggregate_seconds > crate::process::MAX_CHECK_TOTAL_EXECUTION_SECONDS {
            return profile_error(format!(
                "check {} requests {aggregate_seconds} aggregate execution seconds; the maximum is {}",
                check.id,
                crate::process::MAX_CHECK_TOTAL_EXECUTION_SECONDS
            ));
        }
    }
    Ok(())
}

fn validate_graph_check_set(
    profile: &CompiledProfile,
    parent: &CheckDef,
    graph_set: &GraphCheckSetDef,
) -> Result<()> {
    let symbols = profile
        .expression_symbols()
        .with_variable("target", ValueType::Node);
    graph_set.members.validate(&symbols).map_err(|error| {
        profile_expr_error(
            "composite check",
            &parent.id,
            format!("graph_set members: {error}"),
        )
    })?;
    if !validate_graph_set_selector(profile, &parent.id, &graph_set.members)? {
        return profile_error(format!(
            "composite check {} graph_set members must be rooted directly at or traverse from $target",
            parent.id
        ));
    }

    validate_nonempty_unique_values(
        &graph_set.member_node_types,
        &format!("composite check {} graph_set member_node_types", parent.id),
    )?;
    validate_known_node_types(
        profile,
        &graph_set.member_node_types,
        &format!("composite check {} graph_set", parent.id),
    )?;
    if graph_set.min_members == 0 {
        return profile_error(format!(
            "composite check {} graph_set min_members must be positive",
            parent.id
        ));
    }
    if graph_set
        .max_members
        .is_some_and(|maximum| maximum < graph_set.min_members)
    {
        return profile_error(format!(
            "composite check {} graph_set max_members must be at least min_members",
            parent.id
        ));
    }

    validate_optional_unique_manifest_values(
        &graph_set.statuses,
        &format!("composite check {} graph_set statuses", parent.id),
    )?;
    validate_optional_unique_manifest_values(
        &graph_set.status_excluding,
        &format!("composite check {} graph_set status_excluding", parent.id),
    )?;
    if graph_set
        .statuses
        .iter()
        .any(|status| graph_set.status_excluding.contains(status))
    {
        return profile_error(format!(
            "composite check {} graph_set statuses and status_excluding must be disjoint",
            parent.id
        ));
    }
    let known_statuses = graph_set
        .member_node_types
        .iter()
        .flat_map(|node_type| profile.node_types[node_type].statuses.iter())
        .collect::<BTreeSet<_>>();
    for status in graph_set.statuses.iter().chain(&graph_set.status_excluding) {
        if !known_statuses.contains(status) {
            return profile_error(format!(
                "composite check {} graph_set references unknown member status {}",
                parent.id, status
            ));
        }
    }

    if graph_set.source_paths_field == graph_set.covered_paths_field {
        return profile_error(format!(
            "composite check {} graph_set source_paths_field and covered_paths_field must differ",
            parent.id
        ));
    }
    for node_type in &graph_set.member_node_types {
        let definition = &profile.node_types[node_type];
        validate_graph_set_path_list_field(
            definition,
            node_type,
            &graph_set.source_paths_field,
            &parent.id,
            "source_paths_field",
        )?;
        validate_graph_set_path_list_field(
            definition,
            node_type,
            &graph_set.covered_paths_field,
            &parent.id,
            "covered_paths_field",
        )?;
        if let Some(path) = &graph_set.working_directory_field {
            let field = graph_set_node_field(definition, node_type, path, &parent.id)?;
            if field.value_type != FieldType::Path {
                return profile_error(format!(
                    "composite check {} graph_set working_directory_field {} on node type {} must be a path",
                    parent.id, path, node_type
                ));
            }
        }
    }

    match (
        graph_set.member_check.as_deref(),
        graph_set.member_check_field.as_deref(),
    ) {
        (Some(check_id), None) if !check_id.trim().is_empty() => {
            validate_graph_set_child_check(profile, parent, check_id)?;
        }
        (None, Some(field_path)) if !field_path.trim().is_empty() => {
            let mut child_check_ids = BTreeSet::new();
            for node_type in &graph_set.member_node_types {
                let definition = &profile.node_types[node_type];
                let field = graph_set_node_field(definition, node_type, field_path, &parent.id)?;
                if field.value_type != FieldType::String || field.enum_values.is_empty() {
                    return profile_error(format!(
                        "composite check {} graph_set member_check_field {} on node type {} must be a string with a nonempty enum",
                        parent.id, field_path, node_type
                    ));
                }
                for value in &field.enum_values {
                    let Some(check_id) = value.as_str() else {
                        return profile_error(format!(
                            "composite check {} graph_set member_check_field {} on node type {} must contain only string check IDs",
                            parent.id, field_path, node_type
                        ));
                    };
                    child_check_ids.insert(check_id.to_owned());
                }
            }
            for child_check_id in child_check_ids {
                validate_graph_set_child_check(profile, parent, &child_check_id)?;
            }
        }
        _ => {
            return profile_error(format!(
                "composite check {} graph_set requires exactly one of member_check or member_check_field",
                parent.id
            ));
        }
    }
    Ok(())
}

/// Returns whether every positive selector branch stays anchored to the
/// ticket target. A bare `$target` is a safe, exact one-member graph set; the
/// compiler still applies node-type, status, scope, and cardinality filters.
fn validate_graph_set_selector(
    profile: &CompiledProfile,
    check_id: &str,
    selector: &Selector,
) -> Result<bool> {
    match selector {
        Selector::Named(name) if name == "$target" => Ok(true),
        Selector::Traverse(envelope) => {
            validate_graph_set_selector(profile, check_id, &envelope.traverse.from)?;
            let relations = envelope
                .traverse
                .relation
                .iter()
                .chain(&envelope.traverse.relations)
                .map(String::as_str)
                .collect::<Vec<_>>();
            if relations.is_empty()
                || relations
                    .iter()
                    .any(|relation| relation.trim().is_empty() || relation.trim() != *relation)
                || relations.iter().collect::<BTreeSet<_>>().len() != relations.len()
            {
                return profile_error(format!(
                    "composite check {check_id} graph_set traversal requires explicit unique relations"
                ));
            }
            let known_relations = configured_relation_names(profile);
            for relation in relations {
                if !known_relations.contains(relation) {
                    return profile_error(format!(
                        "composite check {check_id} graph_set traversal references unknown relation {relation}"
                    ));
                }
            }
            Ok(true)
        }
        Selector::Union(envelope) => {
            for branch in &envelope.union {
                if !validate_graph_set_selector(profile, check_id, branch)? {
                    return profile_error(format!(
                        "composite check {check_id} graph_set branches must be rooted directly at or traverse from $target"
                    ));
                }
            }
            Ok(true)
        }
        Selector::Intersection(envelope) => {
            for branch in &envelope.intersection {
                if !validate_graph_set_selector(profile, check_id, branch)? {
                    return profile_error(format!(
                        "composite check {check_id} graph_set branches must be rooted directly at or traverse from $target"
                    ));
                }
            }
            Ok(true)
        }
        Selector::Difference(envelope) => {
            let left = validate_graph_set_selector(profile, check_id, &envelope.difference.left)?;
            let right = validate_graph_set_selector(profile, check_id, &envelope.difference.right)?;
            if !left || !right {
                return profile_error(format!(
                    "composite check {check_id} graph_set branches must be rooted directly at or traverse from $target"
                ));
            }
            Ok(true)
        }
        _ => profile_error(format!(
            "composite check {check_id} graph_set members may only use $target, target-anchored traversals, and set operations"
        )),
    }
}

fn graph_set_node_field<'a>(
    definition: &'a NodeTypeDef,
    node_type: &str,
    path: &str,
    check_id: &str,
) -> Result<&'a FieldDef> {
    validate_contract_field_path(path).map_err(|error| {
        KoniError::Profile(format!(
            "composite check {check_id} graph_set field {path:?} is malformed: {error}"
        ))
    })?;
    node_field_definition(definition, path).ok_or_else(|| {
        KoniError::Profile(format!(
            "composite check {check_id} graph_set field {path} is not declared by node type {node_type}"
        ))
    })
}

fn validate_graph_set_path_list_field(
    definition: &NodeTypeDef,
    node_type: &str,
    path: &str,
    check_id: &str,
    label: &str,
) -> Result<()> {
    let field = graph_set_node_field(definition, node_type, path, check_id)?;
    if field.value_type != FieldType::List
        || !field
            .items
            .as_deref()
            .is_some_and(|item| item.value_type == FieldType::Path)
    {
        return profile_error(format!(
            "composite check {check_id} graph_set {label} {path} on node type {node_type} must be a list with path items"
        ));
    }
    Ok(())
}

fn validate_graph_set_child_check(
    profile: &CompiledProfile,
    parent: &CheckDef,
    child_check_id: &str,
) -> Result<()> {
    let child = profile.checks.get(child_check_id).ok_or_else(|| {
        KoniError::Profile(format!(
            "composite check {} graph_set references unknown child check {}",
            parent.id, child_check_id
        ))
    })?;
    if child.kind != CheckKind::Command || child.effect != ProcessEffect::ReadOnly {
        return profile_error(format!(
            "composite check {} graph_set child {} must be a read-only command check",
            parent.id, child_check_id
        ));
    }
    let parent_operations = normalized_check_operations(profile, parent);
    let child_operations = normalized_check_operations(profile, child);
    if !parent_operations.is_subset(&child_operations) {
        return profile_error(format!(
            "composite check {} graph_set child {} does not apply to every parent operation",
            parent.id, child_check_id
        ));
    }
    Ok(())
}

fn normalized_check_operations(profile: &CompiledProfile, check: &CheckDef) -> BTreeSet<String> {
    let configured = if check.applies_to.is_empty() {
        profile
            .operations
            .values()
            .map(OperationDef::public_operation)
            .collect::<Vec<_>>()
    } else {
        check.applies_to.iter().map(String::as_str).collect()
    };
    configured
        .into_iter()
        .map(|operation| {
            profile
                .operations
                .get(operation)
                .map(OperationDef::public_operation)
                .unwrap_or(operation)
                .to_owned()
        })
        .collect()
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
            validate_node_command_field_contract(profile, check, source)?;
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

fn validate_node_command_field_contract(
    profile: &CompiledProfile,
    check: &CheckDef,
    source: &DynamicCommandSourceDef,
) -> Result<()> {
    for node_type in &source.node_types {
        let definition = profile
            .node_types
            .get(node_type)
            .expect("node command source types were validated");
        if source.field.contains('[') {
            let normalized = source.field.strip_prefix("spec.").unwrap_or(&source.field);
            let root_end = normalized.find(['.', '[']).unwrap_or(normalized.len());
            let root = &normalized[..root_end];
            let field = definition.fields.get(root).ok_or_else(|| {
                KoniError::Profile(format!(
                    "check {} command_source field {} is not declared by node type {}",
                    check.id, source.field, node_type
                ))
            })?;
            if !matches!(field.value_type, FieldType::Object | FieldType::Json) {
                return profile_error(format!(
                    "check {} dynamic command_source field {} requires an object contract on node type {}",
                    check.id, source.field, node_type
                ));
            }
            continue;
        }

        let field = node_field_definition(definition, &source.field).ok_or_else(|| {
            KoniError::Profile(format!(
                "check {} command_source field {} is not declared by node type {}",
                check.id, source.field, node_type
            ))
        })?;
        if field.value_type != FieldType::List
            || !field
                .items
                .as_deref()
                .is_some_and(|items| items.value_type == FieldType::String)
        {
            return profile_error(format!(
                "check {} command_source field {} on node type {} must be a list with string items",
                check.id, source.field, node_type
            ));
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
    let schema2 = profile.manifest.schema_version == PROFILE_SCHEMA_V2_VERSION;
    if schema2 {
        for agent in profile.koni_agents.agents.values() {
            for skill in &agent.resource.skills {
                if profile.native_codex.skill(skill).is_none() {
                    return profile_error(format!(
                        "schema-2 agent {} references unknown repository skill {skill}",
                        agent.resource.id
                    ));
                }
            }
        }
    }
    for persona in profile.personas.values() {
        validate_persona_schema_fields(&profile.manifest.schema_version, persona)?;
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
        } else if schema2 && persona.agent.is_none() {
            return profile_error(format!(
                "schema-2 persona {} must define prompt or agent",
                persona.id
            ));
        } else if !schema2 && persona.codex_agent.is_none() {
            return profile_error(format!(
                "persona {} must define prompt or codex_agent",
                persona.id
            ));
        }
        let agent_reference = if schema2 {
            persona.agent.as_deref()
        } else {
            persona.codex_agent.as_deref()
        };
        if agent_reference.is_some_and(|name| name.trim().is_empty()) {
            return profile_error(format!(
                "persona {} {} must not be empty",
                persona.id,
                if schema2 { "agent" } else { "codex_agent" }
            ));
        }
        if persona
            .thinking_level
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return profile_error(format!(
                "persona {} thinking_level must not be empty",
                persona.id
            ));
        }
        let resolved = profile.resolve_persona_def(persona)?;
        let mut unique_skills = BTreeSet::new();
        for skill in &resolved.skills {
            if skill.trim().is_empty() {
                return profile_error(format!(
                    "persona {} skill name must not be empty",
                    persona.id
                ));
            }
            if !unique_skills.insert(skill) {
                return profile_error(format!(
                    "persona {} references repository skill {skill} more than once",
                    persona.id
                ));
            }
            if profile.native_codex.skill(skill).is_none() {
                return profile_error(format!(
                    "persona {} references unknown repository skill {skill}",
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
                "persona {} uses unsupported runtime sandbox mode {}",
                persona.id, resolved.sandbox.mode
            ));
        }
        if !matches!(
            resolved.sandbox.approval_policy.as_str(),
            "never" | "on-request" | "on-failure" | "untrusted"
        ) {
            return profile_error(format!(
                "persona {} uses unsupported runtime approval policy {}",
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
    #[serde(skip_serializing_if = "IndexMap::is_empty")]
    graph_constraints: &'a IndexMap<String, GraphConstraintDef>,
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
    let schema2 = profile.manifest.schema_version == PROFILE_SCHEMA_V2_VERSION;
    if !schema2 && let Some(config) = &profile.native_codex.project_config {
        native_resources.insert("project-config".to_owned(), config.hash.clone());
    }
    for (id, persona) in &profile.personas {
        let resolved = profile.resolve_persona_def(persona)?;
        if let Some(prompt) = &persona.prompt {
            let path = profile.root.join(prompt);
            let contents = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
            persona_prompts.insert(id.clone(), contents);
        }
        if let Some(agent_name) = &persona.agent {
            let agent = profile.koni_agents.agent(agent_name).ok_or_else(|| {
                KoniError::Profile(format!(
                    "persona {id} references unknown schema-2 agent {agent_name}"
                ))
            })?;
            native_resources.insert(
                format!("persona:{id}:agent:{}", agent.resource.id),
                agent.hash.clone(),
            );
        } else if let Some(agent_name) = &persona.codex_agent {
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
        for skill_name in &resolved.skills {
            let skill = profile.native_codex.skill(skill_name).ok_or_else(|| {
                KoniError::Profile(format!(
                    "persona {id} references unknown repository skill {skill_name}"
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
        graph_constraints: &profile.graph_constraints,
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

    fn graph_set_check_definition(id: &str, member_mapping: &str) -> String {
        format!(
            r#"  - id: {id}
    kind: composite
    applies_to: [implement]
    receipt_type: proof_set
    graph_set:
      members:
        traverse:
          from: $target
          relation: verified_by
          min_depth: 1
          max_depth: 1
          node_types: [proof]
      member_node_types: [proof]
      {member_mapping}
      source_paths_field: spec.source_paths
      covered_paths_field: spec.covered_paths
      working_directory_field: spec.working_directory
      statuses: [planned]
      status_excluding: [superseded]
      min_members: 1
      max_members: 4
"#,
        )
    }

    fn module_with_graph_check_set() -> String {
        let proof_contract = r#"  - id: proof
    description: A repository-backed executable proof obligation.
    stage: assurance
    statuses: [planned, passing, superseded]
    semantic_fields: [claim]
    fields:
      claim: {type: string, required: true}
      check_id: {type: string, required: true, enum: [unit]}
      command: {type: list, required: true, items: {type: string, required: true}}
      source_paths: {type: list, required: true, items: {type: path, required: true}}
      covered_paths: {type: list, required: true, items: {type: path, required: true}}
      working_directory: {type: path, required: true}

"#;
        let proof_edge = r#"  - source: proof
    relation: verifies
    inverse: verified_by
    bidirectional: true
    targets: [system]

"#;
        let check = graph_set_check_definition("proof-set", "member_check: unit");
        valid_module()
            .replace(
                "edge_types:\n",
                &format!("{proof_contract}edge_types:\n{proof_edge}"),
            )
            .replace("        checks: [unit]\n", "        checks: [proof-set]\n")
            .replace("checks:\n", &format!("checks:\n{check}"))
    }

    fn module_with_proof_source_preparation() -> String {
        module_with_graph_check_set()
            .replace(
                "    ranking_hints: [stage, target]\n",
                "    ranking_hints: [stage, target]\n    proof_source_preparation_check: proof-set\n",
            )
            .replace(
                "    receipt_type: test\n",
                "    receipt_type: test\n    receipt_freshness: historical\n",
            )
            .replace(
                "        checks: [proof-set]\n\nactions:",
                "        checks: [proof-set]\n        required_receipts: [proof_set]\n      - id: review\n        kind: review\n        persona: reviewer\n        depends_on: [work]\n        validation_action: review\n\nactions:",
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
        valid_module()
            .replace(
                "    compiler_owned_fields: [readiness]\n",
                "    compiler_owned_fields: [readiness]\n    fields:\n      contracts: {type: object}\n",
            )
            .replace(
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

    fn schema2_manifest() -> String {
        manifest().replacen("schema_version = \"1.0\"", "schema_version = \"2.0\"", 1)
    }

    fn schema2_module(persona: &str) -> String {
        let legacy_persona = r#"personas:
  - id: coder
    prompt: personas/coder.md
    model_role: ticket_worker
    sandbox:
      mode: workspace-write
      approval_policy: never
      network_access: false
"#;
        format!(
            "schema_version: \"2.0\"\n{}",
            valid_module().replace(legacy_persona, persona)
        )
    }

    fn write_schema2_fixture(temp: &TempDir, persona: &str, provider: &str) -> PathBuf {
        let root = temp.path().join(".koni");
        write(&root.join("koni.toml"), &schema2_manifest());
        write(&root.join("module.yaml"), &schema2_module(persona));
        write(
            &root.join("agents/reviewer.yaml"),
            &format!(
                r#"schema_version: "2.0"
id: reviewer
description: Review changes against their contracts.
instructions:
  source: path
  path: agent-prompts/reviewer.md
aliases: [reviewer-alias]
provider: {provider}
model: gpt-native
thinking_level: high
capabilities:
  workspace_access: read_only
  commands: read_only
  network_access: false
skills: [review]
"#
            ),
        );
        write(
            &root.join("agent-prompts/reviewer.md"),
            "Review like an owner.\n",
        );
        write(
            &temp.path().join(".agents/skills/review/SKILL.md"),
            "---\nname: review\ndescription: Review a change\n---\nReview carefully.\n",
        );
        root
    }

    #[test]
    fn schema2_prefers_koni_and_resolves_provider_neutral_agent_resources() {
        let temp = TempDir::new().unwrap();
        let profile_root = write_schema2_fixture(
            &temp,
            r#"personas:
  - id: coder
    agent: reviewer-alias
    model_role: ticket_worker
"#,
            "openai-codex",
        );
        write(&temp.path().join("koni.toml"), "not valid toml = [\n");
        write(
            &temp.path().join(".codex/koni/koni.toml"),
            "also not valid toml = [\n",
        );
        write(
            &temp.path().join(".codex/config.toml"),
            "invalid executable codex config = [\n",
        );
        write(
            &temp.path().join(".codex/agents/reviewer.toml"),
            "invalid executable codex agent = [\n",
        );

        let original = ProfileCompiler::compile(temp.path()).unwrap();
        assert_eq!(original.root, profile_root);
        assert_eq!(original.manifest.schema_version, "2.0");
        assert!(original.native_codex.project_config.is_none());
        assert!(original.native_codex.agents.is_empty());
        assert!(original.native_codex.skill("review").is_some());
        assert!(original.koni_agents.agent("reviewer-alias").is_some());

        let persona = original.resolve_persona("coder").unwrap();
        assert_eq!(persona.instructions, "Review like an owner.\n");
        assert_eq!(
            persona.instruction_source,
            profile_root.join("agent-prompts/reviewer.md")
        );
        assert_eq!(
            persona.description,
            "Review changes against their contracts."
        );
        assert_eq!(persona.model.as_deref(), Some("gpt-native"));
        assert_eq!(persona.thinking_level.as_deref(), Some("high"));
        assert_eq!(persona.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(persona.sandbox.mode, "read-only");
        assert_eq!(persona.sandbox.approval_policy, "never");
        assert_eq!(persona.agent.as_deref(), Some("reviewer"));
        assert!(persona.codex_agent.is_none());
        assert_eq!(persona.skills, ["review"]);
        assert!(persona.codex_config_overrides().next().is_none());
        let capabilities = persona.capabilities.as_ref().unwrap();
        assert_eq!(capabilities.workspace_access, WorkspaceAccessV2::ReadOnly);
        assert_eq!(capabilities.commands, CommandAccessV2::ReadOnly);

        write(
            &temp.path().join(".codex/config.toml"),
            "a different invalid executable config = [\n",
        );
        let codex_change_ignored = ProfileCompiler::compile(temp.path()).unwrap();
        assert_eq!(original.hash, codex_change_ignored.hash);

        write(
            &profile_root.join("agent-prompts/reviewer.md"),
            "Review with a changed provider-neutral contract.\n",
        );
        let changed_agent = ProfileCompiler::compile(temp.path()).unwrap();
        assert_ne!(original.hash, changed_agent.hash);

        write(
            &temp.path().join(".agents/skills/review/SKILL.md"),
            "---\nname: review\ndescription: Review a change\n---\nRevised skill.\n",
        );
        let changed_skill = ProfileCompiler::compile(temp.path()).unwrap();
        assert_ne!(changed_agent.hash, changed_skill.hash);

        let staging_root = temp.path().join(".koni-migration-test");
        fs::create_dir(&staging_root).unwrap();
        let staged_profile_root = staging_root.join(".koni");
        fs::rename(&profile_root, &staged_profile_root).unwrap();
        let staged =
            ProfileCompiler::compile_with_project_root(&staged_profile_root, temp.path()).unwrap();
        assert!(staged.native_codex.skill("review").is_some());
        assert_eq!(staged.root, staged_profile_root);
    }

    #[test]
    fn schema2_rejects_non_openai_codex_providers_and_mismatched_modules() {
        let persona = r#"personas:
  - id: coder
    agent: reviewer
    model_role: ticket_worker
"#;
        let unsupported = TempDir::new().unwrap();
        write_schema2_fixture(&unsupported, persona, "anthropic");
        let error = ProfileCompiler::compile(unsupported.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("unsupported provider anthropic; expected openai-codex"),
            "{error}"
        );

        let mismatched = TempDir::new().unwrap();
        let root = write_schema2_fixture(&mismatched, persona, "openai-codex");
        let module = schema2_module(persona).replacen(
            "schema_version: \"2.0\"",
            "schema_version: \"1.0\"",
            1,
        );
        write(&root.join("module.yaml"), &module);
        let error = ProfileCompiler::compile(mismatched.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("declares schema 1.0, but the profile declares 2.0"),
            "{error}"
        );
    }

    #[test]
    fn persona_schema_generations_cannot_be_mixed() {
        let cases = [
            (
                r#"personas:
  - id: coder
    agent: reviewer
    codex_agent: legacy-reviewer
    model_role: ticket_worker
"#,
                "conflicting agent and codex_agent",
            ),
            (
                r#"personas:
  - id: coder
    agent: reviewer
    thinking_level: high
    reasoning_effort: low
    model_role: ticket_worker
"#,
                "conflicting thinking_level and reasoning_effort",
            ),
            (
                r#"personas:
  - id: coder
    agent: reviewer
    model_role: ticket_worker
    capabilities:
      workspace_access: read_only
      commands: read_only
    sandbox:
      mode: read-only
      approval_policy: never
"#,
                "conflicting capabilities and sandbox",
            ),
        ];
        for (persona, expected) in cases {
            let temp = TempDir::new().unwrap();
            write_schema2_fixture(&temp, persona, "openai-codex");
            let error = ProfileCompiler::compile(temp.path())
                .unwrap_err()
                .to_string();
            assert!(
                error.contains(expected),
                "expected {expected:?}, got {error}"
            );
        }

        let schema2_legacy_only = TempDir::new().unwrap();
        write_schema2_fixture(
            &schema2_legacy_only,
            r#"personas:
  - id: coder
    codex_agent: legacy-reviewer
    model_role: ticket_worker
"#,
            "openai-codex",
        );
        let error = ProfileCompiler::compile(schema2_legacy_only.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("schema-2 persona coder contains legacy field"),
            "{error}"
        );

        let schema1_current = fixture(&valid_module().replace(
            "    model_role: ticket_worker\n",
            "    model_role: ticket_worker\n    agent: reviewer\n",
        ));
        let error = ProfileCompiler::compile(schema1_current.path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("schema-1 persona coder contains schema-2 field"),
            "{error}"
        );
    }

    #[test]
    fn schema1_profile_manifest_wins_when_project_catalog_is_also_present() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join(".codex/koni");
        write(&root.join("profile.yaml"), yaml_manifest());
        write(&root.join("module.yaml"), valid_module());
        write(
            &root.join("personas/coder.md"),
            "You are a bounded coder.\n",
        );
        write(
            &root.join("project.yaml"),
            r#"schema_version: "1.0"
project:
  id: fixture
  title: Fixture catalog
default_run_type: medium
run_types: []
"#,
        );

        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        assert_eq!(profile.manifest.profile.id, "fixture-yaml");
        assert_eq!(profile.root, root);
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

    fn manifest_with_context(context: &str) -> String {
        manifest().replace(
            "\n[storage]",
            &format!("\n[context]\n{context}\n\n[storage]"),
        )
    }

    fn module_with_planning_seed_operation() -> String {
        valid_module().replace(
            "\nworkflows:\n",
            r#"
  - id: initialization.graph.seed
    operation: seed-graph
    stage: initialization
    target_types: [system]
    allowed_new_node_types: [system]
    allowed_existing_node_types: [system]

workflows:
"#,
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
                && legacy_check.get("dynamic_result").is_none()
                && legacy_check.get("graph_set").is_none(),
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
        assert_eq!(
            profile.workflows["implement-system"].steps[0].graph_mutation,
            GraphMutationPolicyDef::Allowed
        );
        assert!(
            serde_json::to_value(&profile.workflows["implement-system"].steps[0])
                .unwrap()
                .get("graph_mutation")
                .is_none(),
            "the legacy allowed graph policy must not perturb already-pinned profile hashes"
        );
        assert!(
            serde_json::to_value(&profile.workflows["implement-system"].steps[0])
                .unwrap()
                .get("preserve_source_paths_from")
                .is_none(),
            "an absent source-preservation dependency must not perturb pinned profile hashes"
        );
        assert!(
            serde_json::to_value(&profile.operations["architecture.system.implement"])
                .unwrap()
                .get("review_effects")
                .is_none(),
            "omitted review effects must not perturb legacy profile hashes"
        );
        assert!(
            profile.operations["architecture.system.implement"]
                .proof_source_preparation_check
                .is_none()
        );
        assert!(
            serde_json::to_value(&profile.operations["architecture.system.implement"])
                .unwrap()
                .get("proof_source_preparation_check")
                .is_none(),
            "an omitted proof-source preparation declaration must not perturb legacy profile hashes"
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
        assert!(
            profile
                .manifest
                .initialization
                .planning_seed_operation
                .is_none(),
            "legacy profiles default approved-plan graph seeding to disabled"
        );
        assert!(
            serde_json::to_value(&profile.manifest.initialization)
                .unwrap()
                .get("planning_seed_operation")
                .is_none(),
            "a disabled graph seed must not perturb legacy profile hashes"
        );
        assert_eq!(profile.manifest.context, ContextPolicy::default());
        assert!(
            serde_json::to_value(&profile.manifest)
                .unwrap()
                .get("context")
                .is_none(),
            "the default context budget must not perturb legacy profile hashes"
        );
        assert!(profile.hash.starts_with("sha256:"));

        let again = ProfileCompiler::compile(&temp.path().join("koni.toml")).unwrap();
        assert_eq!(profile.hash, again.hash);
    }

    #[test]
    fn nondefault_step_graph_mutation_policy_is_profile_hashed() {
        let baseline = fixture(valid_module());
        let baseline = ProfileCompiler::compile(baseline.path()).unwrap();
        let forbidden_module = valid_module().replace(
            "        expected_output: scoped patch\n",
            "        expected_output: scoped patch\n        graph_mutation: forbidden\n",
        );
        let forbidden = fixture(&forbidden_module);
        let forbidden = ProfileCompiler::compile(forbidden.path()).unwrap();

        assert_eq!(
            forbidden.workflows["implement-system"].steps[0].graph_mutation,
            GraphMutationPolicyDef::Forbidden
        );
        assert_ne!(baseline.hash, forbidden.hash);
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

        let manifest_output = valid
            .replace(
                "    compiler_owned_fields: [readiness, spec.acceptance, spec.accepted_by]\n    fields:\n      name: {type: string}\n",
                r#"    compiler_owned_fields: [readiness, spec.acceptance, spec.accepted_by, asset_manifest]
    filesystem_manifest:
      root_field: spec.implementation_plan.root
      implementation_contract_field: spec.implementation
      implementation_kind_field: spec.implementation.kind
      implementation_entrypoints_field: spec.implementation.entrypoints
      output_field: asset_manifest
      allowed_root_prefixes: [artifacts]
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
"#,
            )
            .replace(
                "          spec.acceptance: accepted\n",
                "          asset_manifest: {}\n",
            );
        let configured = fixture(&manifest_output);
        let error = ProfileCompiler::compile(configured.path())
            .expect_err("review effects must not overwrite compiler-derived manifests")
            .to_string();
        assert!(
            error.contains("overlaps compiler-derived filesystem manifest output"),
            "{error}"
        );

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
    fn graph_check_sets_are_typed_target_anchored_and_profile_hashed() {
        let baseline = ProfileCompiler::compile(fixture(valid_module()).path()).unwrap();
        let configured_module = module_with_graph_check_set();
        let configured = ProfileCompiler::compile(fixture(&configured_module).path()).unwrap();
        let graph_set = configured.checks["proof-set"]
            .graph_set
            .as_ref()
            .expect("composite graph-set contract");
        assert_eq!(configured.checks["proof-set"].kind, CheckKind::Composite);
        assert_eq!(graph_set.member_node_types, vec!["proof"]);
        assert_eq!(graph_set.member_check.as_deref(), Some("unit"));
        assert_eq!(graph_set.min_members, 1);
        assert_eq!(graph_set.max_members, Some(4));
        assert_ne!(baseline.hash, configured.hash);

        let direct_target = configured_module.replace(
            r#"      members:
        traverse:
          from: $target
          relation: verified_by
          min_depth: 1
          max_depth: 1
          node_types: [proof]"#,
            "      members: $target",
        );
        let direct_target = ProfileCompiler::compile(fixture(&direct_target).path()).unwrap();
        assert!(matches!(
            &direct_target.checks["proof-set"]
                .graph_set
                .as_ref()
                .unwrap()
                .members,
            Selector::Named(target) if target == "$target"
        ));

        let field_mapped =
            configured_module.replace("member_check: unit", "member_check_field: spec.check_id");
        let field_mapped = ProfileCompiler::compile(fixture(&field_mapped).path()).unwrap();
        assert_eq!(
            field_mapped.checks["proof-set"]
                .graph_set
                .as_ref()
                .unwrap()
                .member_check_field
                .as_deref(),
            Some("spec.check_id")
        );
        assert_ne!(configured.hash, field_mapped.hash);
    }

    #[test]
    fn proof_source_preparation_declaration_is_typed_serialized_and_profile_hashed() {
        let configured_module = module_with_proof_source_preparation();
        let legacy_shape =
            configured_module.replace("    proof_source_preparation_check: proof-set\n", "");
        let legacy_shape = ProfileCompiler::compile(fixture(&legacy_shape).path()).unwrap();
        let configured = ProfileCompiler::compile(fixture(&configured_module).path()).unwrap();
        let operation = &configured.operations["architecture.system.implement"];
        assert_eq!(
            operation.proof_source_preparation_check.as_deref(),
            Some("proof-set")
        );
        assert_eq!(
            serde_json::to_value(operation).unwrap()["proof_source_preparation_check"],
            "proof-set"
        );
        assert_ne!(legacy_shape.hash, configured.hash);
    }

    #[test]
    fn proof_source_preparation_rejects_incomplete_or_unsafe_workflow_contracts() {
        let valid = module_with_proof_source_preparation();
        let with_other_operation = |module: String| {
            module.replace(
                "operations:\n",
                "operations:\n  - id: architecture.system.other\n    operation: other\n    stage: architecture\n    target_types: [system]\n\n",
            )
        };
        let parent_not_applicable = with_other_operation(
            valid
                .replace(
                    "    kind: composite\n    applies_to: [implement]\n    receipt_type: proof_set",
                    "    kind: composite\n    applies_to: [other]\n    receipt_type: proof_set",
                )
                .replace(
                    "    applies_to: [implement]\n    argv: [cargo, test]",
                    "    applies_to: [implement, other]\n    argv: [cargo, test]",
                ),
        );
        let child_not_applicable = with_other_operation(valid.replace(
            "    applies_to: [implement]\n    argv: [cargo, test]",
            "    applies_to: [other]\n    argv: [cargo, test]",
        ));
        let missing_review = valid.replace(
            "      - id: review\n        kind: review\n        persona: reviewer\n        depends_on: [work]\n        validation_action: review\n",
            "",
        );
        let multiple_reviews = valid.replace(
            "        validation_action: review\n\nactions:",
            "        validation_action: review\n      - id: second-review\n        kind: review\n        persona: reviewer\n        depends_on: [work]\n        validation_action: review\n\nactions:",
        );
        let cases =
            vec![
            (
                valid.replace(
                    "proof_source_preparation_check: proof-set",
                    "proof_source_preparation_check: missing",
                ),
                "references unknown check missing",
            ),
            (
                valid.replace(
                    "proof_source_preparation_check: proof-set",
                    "proof_source_preparation_check: unit",
                ),
                "must be a composite graph-set check",
            ),
            (parent_not_applicable, "does not apply to operation implement"),
            (
                child_not_applicable,
                "proof source preparation child unit does not apply to operation implement",
            ),
            (
                valid.replace("        checks: [proof-set]\n", ""),
                "must be scheduled exactly once",
            ),
            (
                valid.replace(
                    "        validation_action: review\n\nactions:",
                    "        validation_action: review\n        checks: [proof-set]\n\nactions:",
                ),
                "must be scheduled exactly once",
            ),
            (
                valid.replace("    receipt_freshness: historical\n", ""),
                "must declare receipt_freshness: historical",
            ),
            (
                valid.replace(
                    "    receipt_freshness: historical\n",
                    "    receipt_freshness: historical\n    effect: workspace_write\n",
                ),
                "must be a read-only command check",
            ),
            (
                valid.replace("        required_receipts: [proof_set]\n", ""),
                "must require composite receipt type proof_set",
            ),
            (missing_review, "requires exactly one review step"),
            (multiple_reviews, "requires exactly one review step"),
            (
                valid.replacen(
                    "        persona: reviewer\n        depends_on: [work]",
                    "        persona: coder\n        depends_on: [work]",
                    1,
                ),
                "must be required, use a persona independent",
            ),
            (
                valid.replace("        depends_on: [work]\n", "        depends_on: []\n"),
                "must be required, use a persona independent",
            ),
        ];
        for (index, (module, expected)) in cases.into_iter().enumerate() {
            let error = ProfileCompiler::compile(fixture(&module).path())
                .expect_err("invalid proof preparation contract must fail closed")
                .to_string();
            assert!(
                error.contains(expected),
                "case {index} expected {expected:?}, got {error}"
            );
        }
    }

    #[test]
    fn proof_preparation_predicate_must_match_the_typed_operation_declaration() {
        let mismatched = module_with_proof_source_preparation().replace(
            "    when:\n      op: edge_count\n      subject: $target\n      relation: depends_on\n      exact: 0",
            "    when:\n      op: proof_preparation_current\n      subject: $target\n      check: unit\n      preparation_operation: architecture.system.implement\n      preparation_targets: $target",
        );
        let error = ProfileCompiler::compile(fixture(&mismatched).path())
            .expect_err("predicate/declaration disagreement must fail closed")
            .to_string();
        assert!(
            error.contains("declares proof_source_preparation_check") && error.contains("not unit"),
            "{error}"
        );
    }

    #[test]
    fn malformed_check_preparation_predicate_returns_profile_error_without_panicking() {
        let malformed = module_with_proof_source_preparation().replace(
            "checks:\n",
            "checks:\n  - id: malformed-preparation\n    kind: graph\n    receipt_type: malformed\n    predicate:\n      op: proof_preparation_current\n      subject: $target\n      preparation_targets: $target\n\n",
        );
        let result =
            std::panic::catch_unwind(|| ProfileCompiler::compile(fixture(&malformed).path()));
        let error = result
            .expect("malformed preparation predicate must not panic profile compilation")
            .expect_err("missing preparation operation/check must fail closed")
            .to_string();
        assert!(
            error.contains("check malformed-preparation proof_preparation_current requires preparation_operation"),
            "{error}"
        );
    }

    #[test]
    fn graph_check_sets_reject_ambiguous_untyped_or_unbounded_contracts() {
        let valid = module_with_graph_check_set();
        let definition = graph_set_check_definition("proof-set", "member_check: unit");
        let cases = vec![
            (
                valid.replace(
                    &definition,
                    "  - id: proof-set\n    kind: composite\n    applies_to: [implement]\n    receipt_type: proof_set\n",
                ),
                "requires graph_set",
            ),
            (
                valid.replacen("    kind: composite", "    kind: command", 1),
                "non-composite check proof-set may not configure graph_set",
            ),
            (
                valid.replace("          from: $target", "          from: active_systems"),
                "target-anchored",
            ),
            (
                valid.replace("          relation: verified_by", "          relation: missing"),
                "unknown relation missing",
            ),
            (
                valid.replace(
                    "      member_check: unit",
                    "      member_check: unit\n      member_check_field: spec.check_id",
                ),
                "exactly one of member_check or member_check_field",
            ),
            (
                valid.replace(
                    "source_paths: {type: list, required: true, items: {type: path, required: true}}",
                    "source_paths: {type: list, required: true, items: {type: string, required: true}}",
                ),
                "must be a list with path items",
            ),
            (
                valid.replace("      max_members: 4", "      max_members: 0"),
                "max_members must be at least min_members",
            ),
            (
                valid.replace("      statuses: [planned]", "      statuses: [missing]"),
                "unknown member status missing",
            ),
            (
                valid
                    .replace("member_check: unit", "member_check_field: spec.check_id")
                    .replace("enum: [unit]", "enum: [missing]"),
                "unknown child check missing",
            ),
            (
                valid
                    .replace("member_check: unit", "member_check_field: spec.check_id")
                    .replace(", enum: [unit]", ""),
                "must be a string with a nonempty enum",
            ),
        ];

        for (module, expected) in cases {
            let error = ProfileCompiler::compile(fixture(&module).path())
                .expect_err("invalid graph-set contracts must fail closed")
                .to_string();
            assert!(
                error.contains(expected),
                "expected {expected:?}, got {error}"
            );
        }
    }

    #[test]
    fn source_preservation_requires_one_compatible_graph_set_on_an_ancestor() {
        let base = module_with_graph_check_set();
        let original = graph_set_check_definition("proof-set", "member_check: unit");
        let baseline = graph_set_check_definition("baseline-set", "member_check: expected-red");
        let green = graph_set_check_definition("green-set", "member_check: unit");
        let expected_red = r#"  - id: expected-red
    kind: command
    applies_to: [implement]
    argv: [cargo, test]
    cwd: .
    timeout_seconds: 60
    expected_exit_codes: [1]
    receipt_type: expected_red
    receipt_freshness: historical
    composed_replay: never
"#;
        let configured = base
            .replace(&original, &format!("{baseline}{green}"))
            .replace(
                "      - id: work\n        persona: coder\n        expected_output: scoped patch\n        validation_action: compile\n        checks: [proof-set]\n",
                "      - id: baseline\n        persona: coder\n        checks: [baseline-set]\n      - id: work\n        persona: coder\n        depends_on: [baseline]\n        preserve_source_paths_from: baseline\n        expected_output: scoped patch\n        validation_action: compile\n        checks: [green-set]\n",
            )
            .replace("  - id: unit\n", &format!("{expected_red}  - id: unit\n"));
        let profile = ProfileCompiler::compile(fixture(&configured).path()).unwrap();
        assert_eq!(
            profile.workflows["implement-system"].steps[1]
                .preserve_source_paths_from
                .as_deref(),
            Some("baseline")
        );
        let baseline_contract = profile.checks["baseline-set"].graph_set.as_ref().unwrap();
        let mut mismatched_coverage = profile.checks["green-set"].graph_set.clone().unwrap();
        mismatched_coverage.covered_paths_field = "spec.other_covered_paths".to_owned();
        assert!(
            !graph_sets_preserve_compatible(&mismatched_coverage, baseline_contract),
            "red-to-green preservation must not silently change its product subject paths"
        );

        let not_an_ancestor = configured.replace("        depends_on: [baseline]\n", "");
        let error = ProfileCompiler::compile(fixture(&not_an_ancestor).path())
            .expect_err("source preservation must follow workflow causality")
            .to_string();
        assert!(
            error.contains("must name a transitive dependency"),
            "{error}"
        );

        let ambiguous = configured.replace(
            "        checks: [baseline-set]\n",
            "        checks: [baseline-set, green-set]\n",
        );
        let error = ProfileCompiler::compile(fixture(&ambiguous).path())
            .expect_err("source preservation cannot guess among graph sets")
            .to_string();
        assert!(
            error.contains("requires exactly one graph-set check on each step"),
            "{error}"
        );
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
    fn bidirectional_edge_uses_one_canonical_declaration_and_inverse_alias() {
        let module = valid_module().replace(
            "    acyclic: true",
            "    acyclic: true\n    bidirectional: true\n    inverse: required_by",
        );
        let profile = ProfileCompiler::compile(fixture(&module).path()).unwrap();
        let edge = &profile.edge_types[0];
        assert!(edge.bidirectional);
        assert_eq!(edge.relation, "depends_on");
        assert_eq!(edge.inverse.as_deref(), Some("required_by"));

        let redundant = module.replace(
            "queries:",
            "  - source: system\n    relation: required_by\n    targets: [system]\n\nqueries:",
        );
        let error = ProfileCompiler::compile(fixture(&redundant).path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("redundant reciprocal edge declaration"),
            "{error}"
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
    fn context_policy_is_typed_bounded_and_profile_hashed() {
        let baseline = ProfileCompiler::compile(fixture(valid_module()).path()).unwrap();
        let configured = fixture(valid_module());
        write(
            &configured.path().join("koni.toml"),
            &manifest_with_context(
                r#"expansion_max_depth = 3
expansion_max_nodes = 24
expansion_max_calls_per_step = 3
expansion_max_response_bytes = 32768
note_max_bytes = 2048
note_max_calls_per_step = 8
notes_max_bundle_bytes = 16384"#,
            ),
        );
        let configured = ProfileCompiler::compile(configured.path()).unwrap();
        assert_eq!(configured.manifest.context.expansion_max_depth, 3);
        assert_eq!(configured.manifest.context.expansion_max_nodes, 24);
        assert_eq!(configured.manifest.context.note_max_bytes, 2048);
        assert_ne!(baseline.hash, configured.hash);
        assert!(
            serde_json::to_value(&configured.manifest)
                .unwrap()
                .get("context")
                .is_some()
        );

        for (field, value, expected) in [
            ("expansion_max_depth", "0", "must be positive"),
            (
                "expansion_max_nodes",
                "257",
                "must not exceed the compiler hard maximum 256",
            ),
            (
                "note_max_bytes",
                "16385",
                "must not exceed the compiler hard maximum 16384",
            ),
        ] {
            let invalid = fixture(valid_module());
            write(
                &invalid.path().join("koni.toml"),
                &manifest_with_context(&format!("{field} = {value}")),
            );
            let error = ProfileCompiler::compile(invalid.path())
                .expect_err("invalid context policy must fail closed")
                .to_string();
            assert!(error.contains(expected), "{field}: {error}");
        }

        let invalid = fixture(valid_module());
        write(
            &invalid.path().join("koni.toml"),
            &manifest_with_context("note_max_bytes = 4096\nnotes_max_bundle_bytes = 2048"),
        );
        let error = ProfileCompiler::compile(invalid.path())
            .expect_err("a single note must fit its context bundle")
            .to_string();
        assert!(error.contains("note_max_bytes must not exceed"), "{error}");
    }

    #[test]
    fn context_policy_rejects_unknown_fields() {
        let invalid = fixture(valid_module());
        write(
            &invalid.path().join("koni.toml"),
            &manifest_with_context("unbounded_graph_dump = true"),
        );
        let error = ProfileCompiler::compile(invalid.path())
            .expect_err("unknown context policy fields must fail closed")
            .to_string();
        assert!(error.contains("unbounded_graph_dump"), "{error}");
    }

    #[test]
    fn validates_compiler_only_planning_seed_operation() {
        let baseline = ProfileCompiler::compile(fixture(valid_module()).path()).unwrap();
        let configured = fixture(&module_with_planning_seed_operation());
        write(
            &configured.path().join("koni.toml"),
            &manifest_with_initialization(
                r#"root_node_type = "system"
goal_field = "name"
planning_seed_operation = "initialization.graph.seed""#,
            ),
        );
        let configured = ProfileCompiler::compile(configured.path()).unwrap();
        assert_eq!(
            configured
                .manifest
                .initialization
                .planning_seed_operation
                .as_deref(),
            Some("initialization.graph.seed")
        );
        assert_ne!(baseline.hash, configured.hash);
    }

    #[test]
    fn rejects_unsafe_or_unbound_planning_seed_operation() {
        let valid_module = module_with_planning_seed_operation();
        let cases = [
            (
                valid_module.clone(),
                r#"planning_seed_operation = "initialization.graph.seed""#.to_owned(),
                "requires root_node_type",
            ),
            (
                valid_module.clone(),
                r#"root_node_type = "system"
goal_field = "name"
planning_seed_operation = "missing""#
                    .to_owned(),
                "references unknown operation registry entry missing",
            ),
            (
                valid_module.replace(
                    "    stage: initialization\n    target_types: [system]",
                    "    stage: framing\n    target_types: [system]",
                ),
                r#"root_node_type = "system"
goal_field = "name"
planning_seed_operation = "initialization.graph.seed""#
                    .to_owned(),
                "must use stage initialization and target only root node type system",
            ),
            (
                valid_module.replace(
                    "    stage: initialization\n    target_types: [system]",
                    "    stage: initialization\n    target_types: []",
                ),
                r#"root_node_type = "system"
goal_field = "name"
planning_seed_operation = "initialization.graph.seed""#
                    .to_owned(),
                "must use stage initialization and target only root node type system",
            ),
            (
                valid_module.replace(
                    "    allowed_existing_node_types: [system]\n\nworkflows:",
                    "    allowed_existing_node_types: []\n\nworkflows:",
                ),
                r#"root_node_type = "system"
goal_field = "name"
planning_seed_operation = "initialization.graph.seed""#
                    .to_owned(),
                "must permit existing root node type system",
            ),
            (
                valid_module.replace(
                    "    allowed_new_node_types: [system]",
                    "    allowed_new_node_types: []",
                ),
                r#"root_node_type = "system"
goal_field = "name"
planning_seed_operation = "initialization.graph.seed""#
                    .to_owned(),
                "must permit at least one new typed graph node",
            ),
            (
                valid_module.replace(
                    "    allowed_new_node_types: [system]",
                    "    allowed_new_node_types: [system]\n    max_new_nodes: 0",
                ),
                r#"root_node_type = "system"
goal_field = "name"
planning_seed_operation = "initialization.graph.seed""#
                    .to_owned(),
                "must permit at least one new typed graph node",
            ),
            (
                valid_module.replace(
                    "    allowed_existing_node_types: [system]\n\nworkflows:",
                    "    allowed_existing_node_types: [system]\n    existing_node_edge_additions_only:\n      system: [depends_on]\n\nworkflows:",
                ),
                r#"root_node_type = "system"
goal_field = "name"
planning_seed_operation = "initialization.graph.seed""#
                    .to_owned(),
                "must permit semantic root updates",
            ),
            (
                valid_module.replace(
                    "    allowed_existing_node_types: [system]\n\nworkflows:",
                    "    allowed_existing_node_types: [system]\n    workflow: implement-system\n\nworkflows:",
                ),
                r#"root_node_type = "system"
goal_field = "name"
planning_seed_operation = "initialization.graph.seed""#
                    .to_owned(),
                "must be a compiler-only graph authority",
            ),
            (
                valid_module.replace(
                    "\noperations:",
                    r#"
  - id: system.seed-ticket
    phase: architecture
    for_each: active_systems
    when: true
    emit:
      operation: seed-graph
      registry_entry_id: initialization.graph.seed
      source_state: unseeded
      target_state: seeded
      target_nodes: $target
      read_scope: $target
      write_scope: $target

operations:"#,
                ),
                r#"root_node_type = "system"
goal_field = "name"
planning_seed_operation = "initialization.graph.seed""#
                    .to_owned(),
                "is compiler-only and cannot be emitted by rule system.seed-ticket",
            ),
        ];

        for (module, initialization, expected) in cases {
            let invalid = fixture(&module);
            write(
                &invalid.path().join("koni.toml"),
                &manifest_with_initialization(&initialization),
            );
            let error = ProfileCompiler::compile(invalid.path())
                .expect_err("invalid planning seed authority must fail closed")
                .to_string();
            assert!(
                error.contains(expected),
                "expected {expected:?}, got {error}"
            );
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

    fn module_with_nested_subset_constraint() -> String {
        valid_module().replace(
            "    compiler_owned_fields: [readiness]\n",
            r#"    compiler_owned_fields: [readiness]
    fields:
      covered_paths:
        type: list
        items: {type: path}
      source_paths:
        type: list
        items: {type: path}
        disjoint_from: spec.covered_paths
      oracle_cases:
        type: list
        unique_by: id
        items:
          type: object
          additional_properties: false
          properties:
            id: {type: string, required: true}
            seam_paths:
              type: list
              items: {type: path}
              subset_of: spec.covered_paths
"#,
        )
    }

    #[test]
    fn compiles_nested_list_subset_constraint_against_root_node_field() {
        let temp = fixture(&module_with_nested_subset_constraint());
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        let seam_paths = &profile.node_types["system"].fields["oracle_cases"]
            .items
            .as_deref()
            .unwrap()
            .properties["seam_paths"];
        assert_eq!(seam_paths.subset_of.as_deref(), Some("spec.covered_paths"));
        assert_eq!(
            profile.node_types["system"].fields["source_paths"]
                .disjoint_from
                .as_deref(),
            Some("spec.covered_paths")
        );
        assert_eq!(
            profile.node_types["system"].fields["oracle_cases"]
                .unique_by
                .as_deref(),
            Some("id")
        );
        assert_eq!(seam_paths.value_type, FieldType::List);
        assert_eq!(
            seam_paths.items.as_deref().map(|item| item.value_type),
            Some(FieldType::Path)
        );
    }

    #[test]
    fn rejects_invalid_disjoint_and_unique_list_contracts() {
        let valid = module_with_nested_subset_constraint();
        let missing_disjoint_target = valid.replace(
            "disjoint_from: spec.covered_paths",
            "disjoint_from: spec.missing_paths",
        );
        let incompatible_disjoint_target = valid.replace(
            "      source_paths:\n        type: list\n        items: {type: path}\n        disjoint_from: spec.covered_paths",
            "      source_paths:\n        type: list\n        items: {type: string}\n        disjoint_from: spec.covered_paths",
        );
        let unique_non_object = valid_module().replace(
            "    compiler_owned_fields: [readiness]\n",
            r#"    compiler_owned_fields: [readiness]
    fields:
      oracle_cases:
        type: list
        unique_by: id
        items: {type: string}
"#,
        );
        let unique_missing_property = valid.replace("unique_by: id", "unique_by: missing_id");
        let unique_optional_property =
            valid.replace("id: {type: string, required: true}", "id: {type: string}");
        let unique_non_scalar_property = valid.replace(
            "id: {type: string, required: true}",
            "id: {type: object, required: true}",
        );
        let unique_nested_property = valid.replace("unique_by: id", "unique_by: meta.id");

        for (module, expected) in [
            (
                missing_disjoint_target,
                "disjoint_from references undeclared root-node field",
            ),
            (incompatible_disjoint_target, "has incompatible item type"),
            (unique_non_object, "must be a list with object items"),
            (
                unique_missing_property,
                "references undeclared list-item property",
            ),
            (unique_optional_property, "property id must be required"),
            (unique_non_scalar_property, "property id must be a scalar"),
            (
                unique_nested_property,
                "must name one direct list-item property",
            ),
        ] {
            let temp = fixture(&module);
            let error = ProfileCompiler::compile(temp.path())
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "expected {expected:?}: {error}");
        }
    }

    #[test]
    fn rejects_invalid_missing_non_list_and_incompatible_subset_references() {
        let valid = module_with_nested_subset_constraint();
        let invalid_path = valid.replace(
            "subset_of: spec.covered_paths",
            "subset_of: 'spec.covered paths'",
        );
        let missing = valid.replace(
            "subset_of: spec.covered_paths",
            "subset_of: spec.missing_paths",
        );
        let non_list = valid.replace(
            "      covered_paths:\n        type: list\n        items: {type: path}",
            "      covered_paths:\n        type: string",
        );
        let incompatible = valid.replacen("items: {type: path}", "items: {type: string}", 1);
        let constrained_non_list = valid.replace(
            "            seam_paths:\n              type: list\n              items: {type: path}\n              subset_of: spec.covered_paths",
            "            seam_paths:\n              type: string\n              subset_of: spec.covered_paths",
        );

        for (module, expected) in [
            (invalid_path, "invalid subset_of reference"),
            (missing, "references undeclared root-node field"),
            (non_list, "reference spec.covered_paths must be a list"),
            (incompatible, "has incompatible item type"),
            (
                constrained_non_list,
                "configures subset_of but must be a list",
            ),
        ] {
            let temp = fixture(&module);
            let error = ProfileCompiler::compile(temp.path())
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "expected {expected:?}: {error}");
            assert!(error.contains("oracle_cases[].seam_paths"), "{error}");
        }
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
    fn literal_ticket_paths_allow_framework_dynamic_segment_names() {
        let path = "apps/books/src/pages/companies/[companyId]/questionnaire.tsx";
        let module = module_with_path_scopes(&format!("write_paths:\n  - '{path}'"));
        let temp = fixture(&module);
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        let emit = profile.rules["system.path-scope"].emit.as_ref().unwrap();

        assert!(matches!(
            &emit.write_paths[0],
            PathScopeDef::Literal(compiled) if compiled == Path::new(path)
        ));
    }

    #[test]
    fn literal_ticket_paths_still_reject_unambiguous_wildcards() {
        for path in ["apps/*/questionnaire.tsx", "apps/?/questionnaire.tsx"] {
            let module = module_with_path_scopes(&format!("write_paths:\n  - '{path}'"));
            let temp = fixture(&module);
            let error = ProfileCompiler::compile(temp.path())
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("literal path, not a glob"),
                "{path}: {error}"
            );
        }
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
    fn command_checks_can_declare_expected_nonzero_exit_codes() {
        let module = valid_module().replace(
            "    timeout_seconds: 60\n    receipt_type: test",
            "    timeout_seconds: 60\n    expected_exit_codes: [1]\n    receipt_type: test\n    receipt_freshness: historical",
        );
        let temp = fixture(&module);
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        assert_eq!(profile.checks["unit"].expected_exit_codes, vec![1]);
        assert_eq!(
            profile.checks["unit"].receipt_freshness,
            ReceiptFreshness::Historical
        );

        let duplicate = module.replace("expected_exit_codes: [1]", "expected_exit_codes: [1, 1]");
        let temp = fixture(&duplicate);
        let error = ProfileCompiler::compile(temp.path())
            .expect_err("duplicate exit codes make the execution contract ambiguous")
            .to_string();
        assert!(error.contains("must not contain duplicates"), "{error}");

        let overlapping = module.replace(
            "    expected_exit_codes: [1]\n    receipt_type: test",
            "    expected_exit_codes: [1]\n    receipt_type: test\n    retry_policy: {max_attempts: 2, transient_exit_codes: [1]}",
        );
        let temp = fixture(&overlapping);
        let error = ProfileCompiler::compile(temp.path())
            .expect_err("one exit code cannot be both accepted and retried")
            .to_string();
        assert!(error.contains("both expected and transient"), "{error}");

        let workspace_write = module.replace(
            "    receipt_freshness: historical",
            "    receipt_freshness: historical\n    effect: workspace_write",
        );
        let temp = fixture(&workspace_write);
        let error = ProfileCompiler::compile(temp.path())
            .expect_err("historical process evidence must not authorize stale write effects")
            .to_string();
        assert!(error.contains("requires a read_only command"), "{error}");
    }

    #[test]
    fn command_retry_attempts_and_aggregate_wall_time_are_bounded() {
        let too_many_attempts = valid_module().replace(
            "    receipt_type: test",
            "    receipt_type: test\n    retry_policy: {max_attempts: 4, transient_exit_codes: [75]}",
        );
        let error = ProfileCompiler::compile(fixture(&too_many_attempts).path())
            .expect_err("profiles may not create an unbounded retry receipt vector")
            .to_string();
        assert!(error.contains("maximum is 3"), "{error}");

        let excessive_wall = valid_module()
            .replace("    timeout_seconds: 60", "    timeout_seconds: 43201")
            .replace(
                "    receipt_type: test",
                "    receipt_type: test\n    retry_policy: {max_attempts: 2, transient_exit_codes: [75]}",
            );
        let error = ProfileCompiler::compile(fixture(&excessive_wall).path())
            .expect_err("aggregate retry execution must stay within one day")
            .to_string();
        assert!(error.contains("aggregate execution seconds"), "{error}");

        let one_day =
            valid_module().replace("    timeout_seconds: 60", "    timeout_seconds: 86400");
        let profile = ProfileCompiler::compile(fixture(&one_day).path()).unwrap();
        assert_eq!(profile.checks["unit"].timeout_seconds, 86_400);
        assert_eq!(profile.checks["unit"].retry_policy.max_attempts, 0);
    }

    #[test]
    fn command_checks_can_explicitly_opt_out_of_composed_replay() {
        let module = valid_module().replace(
            "    receipt_type: test",
            "    receipt_type: test\n    effect: workspace_write\n    composed_replay: never",
        );
        let temp = fixture(&module);
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        assert_eq!(
            profile.checks["unit"].composed_replay,
            ComposedReplayPolicy::Never
        );
        assert_eq!(
            profile.checks["unit"].receipt_freshness,
            ReceiptFreshness::Current,
            "replay policy must not demote current causal evidence"
        );

        let graph_check = module
            .replace("    kind: command", "    kind: graph")
            .replace("    argv: [cargo, test]\n", "");
        let temp = fixture(&graph_check);
        let error = ProfileCompiler::compile(temp.path())
            .expect_err("only commands have composed replay semantics")
            .to_string();
        assert!(
            error.contains("composed_replay is only meaningful for command checks"),
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
    fn integration_projection_snapshot_declares_its_graph_write() {
        let refresh = ActionStepDef {
            id: None,
            primitive: "snapshot.write".to_owned(),
            when: None,
            args: BTreeMap::from([(
                "recompute_from_integration_projection".to_owned(),
                Value::Bool(true),
            )]),
        };
        let effect = primitive_effect(&refresh).expect("projection snapshot is a known effect");

        assert_eq!(effect.class, EffectClass::ReversibleWrite);
        assert!(effect.writes.contains(&EffectResource::Audit));
        assert!(effect.writes.contains(&EffectResource::Graph));
        assert!(!effect.invalidates_validation);
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
    fn validates_structured_review_failure_routes() {
        let valid = valid_module().replace(
            "    applies_to: [implement]\n    steps:",
            "    applies_to: [implement]\n    review_failure_routes:\n      ticket_rework:\n        disposition: reopen\n        description: The selected work step can correct the finding.\n        reopen_from: work\n      upstream_proof:\n        disposition: block\n        description: The proof or scope must be corrected before product work.\n        recovery: replan_from_clean_integration\n        recovery_instructions: Preserve the rejected candidate and replan against clean integration state.\n    steps:",
        );
        let temp = fixture(&valid);
        let profile = ProfileCompiler::compile(temp.path()).unwrap();
        let workflow = &profile.workflows["implement-system"];
        assert_eq!(
            workflow.review_failure_routes["ticket_rework"]
                .reopen_from
                .as_deref(),
            Some("work")
        );
        assert_eq!(
            workflow.review_failure_routes["upstream_proof"].recovery,
            Some(ReviewFailureRecovery::ReplanFromCleanIntegration)
        );

        let mixed = valid.replace(
            "    review_failure_routes:",
            "    review_failure_reopen_from: work\n    review_failure_routes:",
        );
        let error = ProfileCompiler::compile(fixture(&mixed).path())
            .unwrap_err()
            .to_string();
        assert!(error.contains("cannot configure both"), "{error}");

        let missing_step = valid.replace("reopen_from: work", "reopen_from: missing");
        let error = ProfileCompiler::compile(fixture(&missing_step).path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("unknown reopen_from step missing"),
            "{error}"
        );

        let unsafe_block = valid.replace(
            "        recovery: replan_from_clean_integration\n        recovery_instructions: Preserve the rejected candidate and replan against clean integration state.",
            "        recovery_instructions: Preserve the rejected candidate and replan against clean integration state.",
        );
        let error = ProfileCompiler::compile(fixture(&unsafe_block).path())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("requires replan_from_clean_integration"),
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
    fn unsupported_profile_manifest_field_fails_closed() {
        let temp = fixture(valid_module());
        let manifest = manifest().replace(
            "engine = \">=0.1,<0.2\"",
            "engine = \">=0.1,<0.2\"\nenginee = \">=9\"",
        );
        write(&temp.path().join("koni.toml"), &manifest);

        let error = ProfileCompiler::compile(temp.path())
            .expect_err("an unknown manifest field must not be retained as inert metadata")
            .to_string();
        assert!(
            error.contains("profile manifest contains unsupported field: enginee"),
            "{error}"
        );
    }

    #[test]
    fn unsupported_module_node_and_operation_fields_fail_closed() {
        let cases = [
            (
                "module",
                format!("modulee: true\n{}", valid_module()),
                "profile module module.yaml contains unsupported field: modulee",
            ),
            (
                "node",
                valid_module().replace(
                    "    stage: architecture\n",
                    "    stage: architecture\n    stgae: architecture\n",
                ),
                "node type system contains unsupported field: stgae",
            ),
            (
                "operation",
                valid_module().replace(
                    "    ranking_hints: [stage, target]\n",
                    "    ranking_hints: [stage, target]\n    rankng_hints: [typo]\n",
                ),
                "operation architecture.system.implement contains unsupported field: rankng_hints",
            ),
        ];

        for (label, module, expected) in cases {
            let temp = fixture(&module);
            let error = ProfileCompiler::compile(temp.path())
                .expect_err("an unsupported schema key must fail compilation")
                .to_string();
            assert!(error.contains(expected), "{label}: {error}");
        }
    }

    #[test]
    fn unsupported_nested_profile_fields_fail_closed() {
        let cases = [
            (
                "edge",
                valid_module().replace(
                    "    acyclic: true\n",
                    "    acyclic: true\n    bidirectionl: true\n",
                ),
                "bidirectionl",
            ),
            (
                "workflow step",
                valid_module().replace(
                    "        expected_output: scoped patch\n",
                    "        expected_output: scoped patch\n        write_pathz: []\n",
                ),
                "write_pathz",
            ),
            (
                "check",
                valid_module().replace(
                    "    timeout_seconds: 60\n",
                    "    timeout_seconds: 60\n    expected_exit_code: [1]\n",
                ),
                "expected_exit_code",
            ),
            (
                "query",
                valid_module().replace(
                    "    status_excluding: [satisfied]\n",
                    "    status_excluding: [satisfied]\n    status_exlcuding: [draft]\n",
                ),
                "status_exlcuding",
            ),
        ];

        for (label, module, typo) in cases {
            let error = ProfileCompiler::compile(fixture(&module).path())
                .expect_err("nested schema typos must not fall back to broader defaults")
                .to_string();
            assert!(error.contains(typo), "{label}: {error}");
        }

        let temp = fixture(valid_module());
        let manifest = manifest().replace("[storage]", "[git]\nenabeld = true\n\n[storage]");
        write(&temp.path().join("koni.toml"), &manifest);
        let error = ProfileCompiler::compile(temp.path())
            .expect_err("nested manifest typos must fail before defaults are applied")
            .to_string();
        assert!(error.contains("enabeld"), "{error}");
    }

    #[test]
    fn node_command_sources_resolve_to_typed_argv_fields() {
        let configured = valid_module()
            .replace(
                "    compiler_owned_fields: [readiness]\n",
                "    compiler_owned_fields: [readiness]\n    fields:\n      test_command: {type: list, required: true, items: {type: string, required: true}}\n",
            )
            .replace(
                "    argv: [cargo, test]\n",
                "    command_source:\n      kind: node\n      selection: target\n      node_types: [system]\n      role: implementation\n      field: spec.test_command\n",
            );
        ProfileCompiler::compile(fixture(&configured).path())
            .expect("a declared string argv field is a valid command source");

        let typo = configured.replace("spec.test_command", "spec.test_commnad");
        let error = ProfileCompiler::compile(fixture(&typo).path())
            .expect_err("a command source typo must fail during profile compilation")
            .to_string();
        assert!(
            error.contains("field spec.test_commnad is not declared"),
            "{error}"
        );

        let untyped = configured.replace(
            "items: {type: string, required: true}",
            "items: {type: path, required: true}",
        );
        let error = ProfileCompiler::compile(fixture(&untyped).path())
            .expect_err("command argv items must be typed strings")
            .to_string();
        assert!(
            error.contains("must be a list with string items"),
            "{error}"
        );
    }

    #[test]
    fn portfolio_guidance_is_the_only_validated_operation_extension() {
        let valid = valid_module().replace(
            "    ranking_hints: [stage, target]\n",
            r#"    ranking_hints: [stage, target]
    portfolio_guidance:
      preferred_count: 2
      unit: cohesive program
      group_when: setup and observables are shared
      split_when: interventions differ materially
      avoid: one node per assertion
"#,
        );
        ProfileCompiler::compile(fixture(&valid).path())
            .expect("the explicitly supported guidance contract should compile");

        let invalid = valid.replace(
            "      avoid: one node per assertion\n",
            "      avoid: one node per assertion\n      prefered_count: 3\n",
        );
        let error = ProfileCompiler::compile(fixture(&invalid).path())
            .expect_err("typos inside the guidance contract must fail closed")
            .to_string();
        assert!(
            error.contains("portfolio_guidance contains unsupported field: prefered_count"),
            "{error}"
        );
    }

    #[test]
    fn terminal_resolver_is_typed_and_bound_to_recovery_policy() {
        let terminal_operation = |module: &str| {
            module.replace(
                "    ranking_hints: [stage, target]\n",
                r#"    ranking_hints: [stage, target]
    gate_blocking_exempt: true
    terminal_resolver: true
    single_flight_group: recovery
"#,
            )
        };
        let recovery_compensation = |module: &str| {
            module.replace(
                "    recovery: recover\n",
                r#"    compensation:
      - primitive: recovery.dispatch
        mode: block_and_emit_single_resolver
    recovery: recover
"#,
            )
        };

        let configured = terminal_operation(&recovery_compensation(valid_module()));
        let profile = ProfileCompiler::compile(fixture(&configured).path())
            .expect("one safe typed resolver satisfies terminal recovery dispatch");
        let operation = &profile.operations["architecture.system.implement"];
        assert!(operation.terminal_resolver);
        assert!(!operation.extensions.contains_key("terminal_resolver"));

        let without_resolver = recovery_compensation(valid_module());
        let error = ProfileCompiler::compile(fixture(&without_resolver).path())
            .expect_err("single-resolver recovery must bind exactly one typed operation")
            .to_string();
        assert!(
            error.contains("declares 0 terminal resolver operations; expected exactly one"),
            "{error}"
        );

        let unsafe_resolver =
            terminal_operation(valid_module()).replace("    gate_blocking_exempt: true\n", "");
        let error = ProfileCompiler::compile(fixture(&unsafe_resolver).path())
            .expect_err("a terminal resolver cannot be blocked by the failed ticket's gates")
            .to_string();
        assert!(error.contains("must be gate_blocking_exempt"), "{error}");
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
