//! Project catalog and run-type compilation.
//!
//! A project catalog selects one of several fully resolved run types. Run-type
//! inheritance is deliberately patch-based: derived definitions may only use
//! explicit JSON-Pointer `merge`, `replace`, and `remove` operations. Recursive
//! object merge replaces arrays atomically, so unkeyed lists never acquire
//! surprising implicit concatenation semantics.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{CompiledProfile, ProfileCompiler, ProfileManifest};
use crate::error::{KoniError, Result, io_error};
use crate::graph::normalized_hash;

pub const PROJECT_CATALOG_SCHEMA_VERSION: &str = "1.0";
pub const LEGACY_RUN_TYPE_ID: &str = "legacy";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectCatalogDocument {
    pub schema_version: String,
    pub project: ProjectCatalogMetadata,
    pub default_run_type: String,
    pub run_types: Vec<RunTypeCatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectCatalogMetadata {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunTypeCatalogEntry {
    pub id: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunTypeDocument {
    pub schema_version: String,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub extends: Option<String>,
    #[serde(default)]
    pub profile: Option<ProfileSourceDef>,
    #[serde(default)]
    pub intake: Option<IntakeDef>,
    #[serde(default)]
    pub pipeline: Option<PipelineDef>,
    #[serde(default)]
    pub questions: Option<QuestionDefaults>,
    #[serde(default)]
    pub git: Option<RunGitDefaults>,
    #[serde(default)]
    pub run_card: Option<RunCardDef>,
    #[serde(default)]
    pub agents: Option<RunTypeAgents>,
    #[serde(default)]
    pub orchestration: Option<RunTypeOrchestrationPolicy>,
    #[serde(default, skip_serializing_if = "RunTypeInstructions::is_empty")]
    pub instructions: RunTypeInstructions,
    #[serde(default)]
    pub overrides: Vec<RunTypeOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileSourceDef {
    pub source: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntakeDef {
    pub fields: IndexMap<String, IntakeFieldDef>,
    pub order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntakeFieldDef {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub field_type: IntakeFieldType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub options: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntakeFieldType {
    String,
    Text,
    Boolean,
    Integer,
    Number,
    Choice,
    MultiChoice,
    Path,
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineDef {
    pub stages: IndexMap<String, PipelineStageDef>,
    pub order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineStageDef {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub config: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionDefaults {
    pub policy: QuestionPolicy,
    pub default_scope: QuestionScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionPolicy {
    Interactive,
    HighImpactOnly,
    Autonomous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionScope {
    Ticket,
    Run,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunGitDefaults {
    pub branch_template: String,
    pub ticket_branch_template: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunCardDef {
    pub sections: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunTypeInstructions {
    #[serde(default)]
    pub planning: String,
}

impl RunTypeInstructions {
    fn is_empty(&self) -> bool {
        self.planning.is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunTypeAgents {
    #[serde(default)]
    pub roles: IndexMap<String, AgentSettings>,
    #[serde(default)]
    pub personas: IndexMap<String, AgentSettings>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentSettings {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}

/// A one-run change to an individual agent setting.
///
/// `RunPlanOverrides` needs three states for every property: leave the
/// configured value alone, use a specific value, or explicitly return to the
/// Codex default. A nested `Option<Option<String>>` does not round-trip that
/// distinction through serde, so the two intentional choices are named.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSettingOverride {
    Configured(String),
    CodexDefault,
}

impl AgentSettingOverride {
    pub fn from_effective(value: Option<String>) -> Self {
        value.map_or(Self::CodexDefault, Self::Configured)
    }

    fn effective_value(&self) -> Option<String> {
        match self {
            Self::Configured(value) => Some(value.clone()),
            Self::CodexDefault => None,
        }
    }
}

/// Sparse, per-property agent changes for one run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentSettingsOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<AgentSettingOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<AgentSettingOverride>,
}

impl AgentSettingsOverride {
    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.reasoning_effort.is_none()
    }

    pub fn apply_to(&self, settings: &mut AgentSettings) {
        if let Some(model) = &self.model {
            settings.model = model.effective_value();
        }
        if let Some(reasoning_effort) = &self.reasoning_effort {
            settings.reasoning_effort = reasoning_effort.effective_value();
        }
    }
}

/// Compiler-owned, one-run behavior changes selected during guided intake.
/// The engine resolves these against the live catalog, materializes the
/// resulting standalone run type inside the run's configuration snapshot, and
/// never mutates the reusable project documents.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunPlanOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_run_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_parallel: Option<usize>,
    #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
    pub agent_roles: IndexMap<String, AgentSettingsOverride>,
}

impl RunPlanOverrides {
    pub fn is_empty(&self) -> bool {
        self.workflow_run_type.is_none()
            && self.max_parallel.is_none()
            && self
                .agent_roles
                .values()
                .all(AgentSettingsOverride::is_empty)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunTypeOrchestrationPolicy {
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub max_parallel: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_boundaries_per_lead: Option<usize>,
    #[serde(default = "default_compile_action")]
    pub compile_action: String,
    #[serde(default = "default_lead_action")]
    pub lead_action: String,
    #[serde(default = "default_report_action")]
    pub report_action: String,
}

impl Default for RunTypeOrchestrationPolicy {
    fn default() -> Self {
        Self {
            auto_start: false,
            max_parallel: None,
            max_boundaries_per_lead: None,
            compile_action: default_compile_action(),
            lead_action: default_lead_action(),
            report_action: default_report_action(),
        }
    }
}

fn default_compile_action() -> String {
    "compile".to_owned()
}

fn default_lead_action() -> String {
    "spawn-lead".to_owned()
}

fn default_report_action() -> String {
    "report".to_owned()
}

#[derive(Debug, Clone, Serialize)]
pub struct RunTypeOverride {
    pub op: OverrideOp,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

impl<'de> Deserialize<'de> for RunTypeOverride {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct WireOverride {
            op: OverrideOp,
            path: String,
            #[serde(default)]
            value: PresentValue,
        }

        #[derive(Default)]
        enum PresentValue {
            #[default]
            Missing,
            Present(Value),
        }

        impl<'de> Deserialize<'de> for PresentValue {
            fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                Value::deserialize(deserializer).map(PresentValue::Present)
            }
        }

        let wire = WireOverride::deserialize(deserializer)?;
        let value = match wire.value {
            PresentValue::Missing => None,
            PresentValue::Present(value) => Some(value),
        };
        Ok(Self {
            op: wire.op,
            path: wire.path,
            value,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverrideOp {
    Merge,
    Replace,
    Remove,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunTypeBehavior {
    profile: ProfileSourceDef,
    intake: IntakeDef,
    pipeline: PipelineDef,
    questions: QuestionDefaults,
    git: RunGitDefaults,
    run_card: RunCardDef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agents: Option<RunTypeAgents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    orchestration: Option<RunTypeOrchestrationPolicy>,
    #[serde(default)]
    instructions: RunTypeInstructions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileSourceFormat {
    Yaml,
    LegacyKoniToml,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedProfileSource {
    /// Stable project-relative source used in hashes and persisted run records.
    pub source: PathBuf,
    pub format: ProfileSourceFormat,
    /// Absolute path for the profile compiler/runtime boundary.
    pub resolved_path: PathBuf,
    /// Canonical hash of the entrypoint document (or compiled legacy manifest).
    pub source_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedRunType {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub extends: Option<String>,
    #[serde(default)]
    pub ancestry: Vec<String>,
    pub profile: ResolvedProfileSource,
    pub intake: IntakeDef,
    pub pipeline: PipelineDef,
    pub questions: QuestionDefaults,
    pub git: RunGitDefaults,
    pub run_card: RunCardDef,
    #[serde(default)]
    pub agents: Option<RunTypeAgents>,
    #[serde(default)]
    pub orchestration: Option<RunTypeOrchestrationPolicy>,
    #[serde(default, skip_serializing_if = "RunTypeInstructions::is_empty")]
    pub instructions: RunTypeInstructions,
    pub hash: String,
}

impl ResolvedRunType {
    /// Materialize this fully resolved behavior as one standalone run-type
    /// document. Run-local overrides use this form inside the immutable
    /// configuration snapshot; the reusable project source remains untouched.
    pub fn standalone_document(&self) -> RunTypeDocument {
        RunTypeDocument {
            schema_version: PROJECT_CATALOG_SCHEMA_VERSION.to_owned(),
            id: self.id.clone(),
            title: self.title.clone(),
            description: self.description.clone(),
            extends: None,
            profile: Some(ProfileSourceDef {
                source: self.profile.source.clone(),
            }),
            intake: Some(self.intake.clone()),
            pipeline: Some(self.pipeline.clone()),
            questions: Some(self.questions.clone()),
            git: Some(self.git.clone()),
            run_card: Some(self.run_card.clone()),
            agents: self.agents.clone(),
            orchestration: self.orchestration.clone(),
            instructions: self.instructions.clone(),
            overrides: Vec::new(),
        }
    }

    /// Revalidate behavior changed by a compiler-owned, run-local override and
    /// refresh the hash that will be pinned by the run registry.
    pub(crate) fn validate_and_refresh_hash(&mut self) -> Result<()> {
        validate_behavior(&behavior_from_resolved(self), &self.id)?;
        self.hash = resolved_run_type_hash(self);
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ProjectCatalogSource {
    Canonical {
        project_path: PathBuf,
    },
    LegacyKoniToml {
        manifest_path: PathBuf,
        migration: Box<LegacyCatalogMigration>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyCatalogMigration {
    pub canonical_project_path: PathBuf,
    pub canonical_run_type_path: PathBuf,
    pub suggested_profile_source: PathBuf,
    pub profile_conversion_required: bool,
    pub project: ProjectCatalogDocument,
    pub run_type: RunTypeDocument,
}

#[derive(Debug, Clone)]
pub struct CompiledProjectCatalog {
    pub document: ProjectCatalogDocument,
    pub project_root: PathBuf,
    pub source: ProjectCatalogSource,
    pub run_types: IndexMap<String, ResolvedRunType>,
    pub hash: String,
}

impl CompiledProjectCatalog {
    pub fn default_run_type(&self) -> &ResolvedRunType {
        &self.run_types[&self.document.default_run_type]
    }

    pub fn run_type(&self, id: &str) -> Option<&ResolvedRunType> {
        self.run_types.get(id)
    }
}

pub struct ProjectCatalogCompiler;

impl ProjectCatalogCompiler {
    pub fn compile(input: &Path) -> Result<CompiledProjectCatalog> {
        match locate_project_config(input)? {
            LocatedProjectConfig::Canonical {
                project_root,
                project_path,
            } => compile_canonical(&project_root, &project_path),
            LocatedProjectConfig::Legacy {
                project_root,
                manifest_path,
            } => compile_legacy(&project_root, &manifest_path),
        }
    }
}

enum LocatedProjectConfig {
    Canonical {
        project_root: PathBuf,
        project_path: PathBuf,
    },
    Legacy {
        project_root: PathBuf,
        manifest_path: PathBuf,
    },
}

fn locate_project_config(input: &Path) -> Result<LocatedProjectConfig> {
    if input.is_file() {
        let path = input
            .canonicalize()
            .map_err(|source| io_error(input, source))?;
        let project_root = infer_project_root(&path)?;
        return match path.extension().and_then(|value| value.to_str()) {
            Some("yaml" | "yml") => Ok(LocatedProjectConfig::Canonical {
                project_root,
                project_path: path,
            }),
            Some("toml") => Ok(LocatedProjectConfig::Legacy {
                project_root,
                manifest_path: path,
            }),
            _ => Err(catalog_error(format!(
                "configuration file {} must be YAML or TOML",
                path.display()
            ))),
        };
    }

    if !input.exists() {
        return Err(KoniError::NotFound(format!(
            "project configuration input {}",
            input.display()
        )));
    }
    if !input.is_dir() {
        return Err(catalog_error(format!(
            "project configuration input {} is neither a file nor a directory",
            input.display()
        )));
    }

    let canonical_candidates = [
        input.join(".codex/koni/project.yaml"),
        input.join("project.yaml"),
    ];
    let canonical = unique_existing_candidate(&canonical_candidates, "project catalogs")?;
    if let Some(project_path) = canonical {
        let project_path = project_path
            .canonicalize()
            .map_err(|source| io_error(&project_path, source))?;
        return Ok(LocatedProjectConfig::Canonical {
            project_root: infer_project_root(&project_path)?,
            project_path,
        });
    }

    let legacy_candidates = [input.join(".codex/koni/koni.toml"), input.join("koni.toml")];
    let manifest_path = unique_existing_candidate(&legacy_candidates, "legacy manifests")?
        .ok_or_else(|| {
            KoniError::NotFound(format!(
                "no .codex/koni/project.yaml or koni.toml beneath {}",
                input.display()
            ))
        })?;
    let manifest_path = manifest_path
        .canonicalize()
        .map_err(|source| io_error(&manifest_path, source))?;
    Ok(LocatedProjectConfig::Legacy {
        project_root: infer_project_root(&manifest_path)?,
        manifest_path,
    })
}

fn unique_existing_candidate(candidates: &[PathBuf], label: &str) -> Result<Option<PathBuf>> {
    let existing: Vec<_> = candidates
        .iter()
        .filter(|path| path.is_file())
        .cloned()
        .collect();
    match existing.as_slice() {
        [] => Ok(None),
        [path] => Ok(Some(path.clone())),
        _ => Err(catalog_error(format!(
            "ambiguous {label}: {}",
            existing
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

fn infer_project_root(config_path: &Path) -> Result<PathBuf> {
    let parent = config_path.parent().ok_or_else(|| {
        catalog_error(format!(
            "configuration path {} has no parent",
            config_path.display()
        ))
    })?;
    let root = if parent.file_name().and_then(|value| value.to_str()) == Some("koni")
        && parent
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            == Some(".codex")
    {
        parent
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| catalog_error(".codex/koni has no project parent"))?
    } else {
        parent
    };
    root.canonicalize().map_err(|source| io_error(root, source))
}

fn compile_canonical(project_root: &Path, project_path: &Path) -> Result<CompiledProjectCatalog> {
    let document: ProjectCatalogDocument = load_yaml(project_path)?;
    validate_project_document(&document)?;

    let catalog_dir = project_path.parent().ok_or_else(|| {
        catalog_error(format!("catalog {} has no parent", project_path.display()))
    })?;
    let mut catalog_ids = HashSet::new();
    for entry in &document.run_types {
        validate_id(&entry.id, "run type catalog id")?;
        validate_relative_path(&entry.path, &format!("run type {} path", entry.id))?;
        if !catalog_ids.insert(entry.id.as_str()) {
            return Err(catalog_error(format!(
                "duplicate run type catalog id `{}`",
                entry.id
            )));
        }
    }
    if !catalog_ids.contains(document.default_run_type.as_str()) {
        return Err(catalog_error(format!(
            "default run type `{}` is not present in the catalog",
            document.default_run_type
        )));
    }

    let mut documents = HashMap::new();
    let mut seen_paths = HashSet::new();
    for entry in &document.run_types {
        let run_type_path = resolve_contained_file(
            catalog_dir,
            &entry.path,
            &format!("run type {} path", entry.id),
        )?;
        if !seen_paths.insert(run_type_path.clone()) {
            return Err(catalog_error(format!(
                "ambiguous run type catalog reference: {} is referenced more than once",
                entry.path.display()
            )));
        }
        let run_type: RunTypeDocument = load_yaml(&run_type_path)?;
        validate_run_type_header(&run_type, &run_type_path)?;
        if run_type.id != entry.id {
            return Err(catalog_error(format!(
                "run type catalog id `{}` does not match document id `{}` in {}",
                entry.id,
                run_type.id,
                run_type_path.display()
            )));
        }
        documents.insert(entry.id.clone(), run_type);
    }

    let mut run_types = IndexMap::new();
    let mut visiting = Vec::new();
    for entry in &document.run_types {
        let resolved = resolve_run_type(
            &entry.id,
            &documents,
            project_root,
            &mut run_types,
            &mut visiting,
        )?;
        run_types.insert(entry.id.clone(), resolved);
    }
    validate_profile_cross_references(&run_types)?;

    let hash = catalog_hash(&document, &run_types);
    Ok(CompiledProjectCatalog {
        document,
        project_root: project_root.to_path_buf(),
        source: ProjectCatalogSource::Canonical {
            project_path: project_path.to_path_buf(),
        },
        run_types,
        hash,
    })
}

fn validate_profile_cross_references(run_types: &IndexMap<String, ResolvedRunType>) -> Result<()> {
    let mut profiles = HashMap::<PathBuf, CompiledProfile>::new();
    let project_profile = run_types
        .values()
        .next()
        .map(|run_type| run_type.profile.resolved_path.as_path());
    for run_type in run_types.values() {
        if project_profile
            .is_some_and(|profile| profile != run_type.profile.resolved_path.as_path())
        {
            return Err(catalog_error(format!(
                "run type `{}` selects profile `{}`, but every run type in one project must share the same profile",
                run_type.id,
                run_type.profile.source.display()
            )));
        }
        if !profiles.contains_key(&run_type.profile.resolved_path) {
            let profile =
                ProfileCompiler::compile(&run_type.profile.resolved_path).map_err(|error| {
                    catalog_error(format!(
                        "run type `{}` could not load profile `{}`: {error}",
                        run_type.id,
                        run_type.profile.source.display()
                    ))
                })?;
            profiles.insert(run_type.profile.resolved_path.clone(), profile);
        }
        let profile = &profiles[&run_type.profile.resolved_path];
        validate_run_type_profile_cross_references(run_type, profile)?;
    }
    Ok(())
}

fn validate_run_type_profile_cross_references(
    run_type: &ResolvedRunType,
    profile: &CompiledProfile,
) -> Result<()> {
    for (stage_id, stage) in &run_type.pipeline.stages {
        let persona = match stage.kind.as_str() {
            "planning" | "agent_dialog" => stage_persona(run_type, stage_id, stage, None)?,
            "agent_review" => stage_persona(run_type, stage_id, stage, Some("reviewer"))?,
            _ => None,
        };
        if let Some(persona) = persona
            && !profile.personas.contains_key(persona)
        {
            return Err(catalog_error(format!(
                "run type `{}` pipeline stage `{stage_id}` references unknown persona `{persona}` in profile `{}`",
                run_type.id, profile.manifest.profile.id
            )));
        }
    }

    if let Some(orchestration) = &run_type.orchestration {
        for (field, action) in [
            ("compile_action", &orchestration.compile_action),
            ("lead_action", &orchestration.lead_action),
            ("report_action", &orchestration.report_action),
        ] {
            if profile.action(action).is_none() {
                return Err(catalog_error(format!(
                    "run type `{}` orchestration {field} references unknown action `{action}` in profile `{}`",
                    run_type.id, profile.manifest.profile.id
                )));
            }
        }
    }
    Ok(())
}

fn stage_persona<'a>(
    run_type: &ResolvedRunType,
    stage_id: &str,
    stage: &'a PipelineStageDef,
    default: Option<&'a str>,
) -> Result<Option<&'a str>> {
    let Some(value) = stage
        .config
        .as_ref()
        .and_then(|config| config.get("persona"))
    else {
        return Ok(default);
    };
    let persona = value.as_str().ok_or_else(|| {
        catalog_error(format!(
            "run type `{}` pipeline stage `{stage_id}` persona must be a string",
            run_type.id
        ))
    })?;
    validate_nonempty(
        persona,
        &format!(
            "run type `{}` pipeline stage `{stage_id}` persona",
            run_type.id
        ),
    )?;
    Ok(Some(persona))
}

fn compile_legacy(project_root: &Path, manifest_path: &Path) -> Result<CompiledProjectCatalog> {
    let text =
        fs::read_to_string(manifest_path).map_err(|source| io_error(manifest_path, source))?;
    let manifest: ProfileManifest = toml::from_str(&text).map_err(|source| KoniError::Toml {
        path: manifest_path.to_path_buf(),
        source,
    })?;
    validate_id(&manifest.profile.id, "legacy profile id")?;
    let toml_value: toml::Value = toml::from_str(&text).map_err(|source| KoniError::Toml {
        path: manifest_path.to_path_buf(),
        source,
    })?;
    let canonical_toml = serde_json::to_value(&toml_value).map_err(|source| {
        catalog_error(format!(
            "legacy manifest {} cannot be normalized: {source}",
            manifest_path.display()
        ))
    })?;

    let source = manifest_path
        .strip_prefix(project_root)
        .map(Path::to_path_buf)
        .map_err(|_| {
            catalog_error(format!(
                "legacy manifest {} is outside project root {}",
                manifest_path.display(),
                project_root.display()
            ))
        })?;
    let description = nonempty_option(&manifest.profile.description);
    let document = ProjectCatalogDocument {
        schema_version: PROJECT_CATALOG_SCHEMA_VERSION.to_owned(),
        project: ProjectCatalogMetadata {
            id: manifest.profile.id.clone(),
            title: manifest.profile.id.clone(),
            description: description.clone(),
        },
        default_run_type: LEGACY_RUN_TYPE_ID.to_owned(),
        run_types: vec![RunTypeCatalogEntry {
            id: LEGACY_RUN_TYPE_ID.to_owned(),
            path: source.clone(),
        }],
    };

    let behavior = legacy_behavior(&manifest, source.clone());
    validate_behavior(&behavior, LEGACY_RUN_TYPE_ID)?;
    let profile = ResolvedProfileSource {
        source,
        format: ProfileSourceFormat::LegacyKoniToml,
        resolved_path: manifest_path.to_path_buf(),
        source_hash: normalized_hash(&canonical_toml),
    };
    let mut resolved = ResolvedRunType {
        id: LEGACY_RUN_TYPE_ID.to_owned(),
        title: manifest.profile.id.clone(),
        description,
        extends: None,
        ancestry: Vec::new(),
        profile,
        intake: behavior.intake,
        pipeline: behavior.pipeline,
        questions: behavior.questions,
        git: behavior.git,
        run_card: behavior.run_card,
        agents: behavior.agents,
        orchestration: behavior.orchestration,
        instructions: behavior.instructions,
        hash: String::new(),
    };
    resolved.hash = resolved_run_type_hash(&resolved);

    let migration = legacy_migration(&manifest);
    let mut run_types = IndexMap::new();
    run_types.insert(LEGACY_RUN_TYPE_ID.to_owned(), resolved);
    let hash = catalog_hash(&document, &run_types);
    Ok(CompiledProjectCatalog {
        document,
        project_root: project_root.to_path_buf(),
        source: ProjectCatalogSource::LegacyKoniToml {
            manifest_path: manifest_path.to_path_buf(),
            migration: Box::new(migration),
        },
        run_types,
        hash,
    })
}

fn load_yaml<T>(path: &Path) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let text = fs::read_to_string(path).map_err(|source| io_error(path, source))?;
    serde_yaml::from_str(&text).map_err(|source| KoniError::Yaml {
        path: path.to_path_buf(),
        source,
    })
}

fn validate_project_document(document: &ProjectCatalogDocument) -> Result<()> {
    validate_schema(&document.schema_version, "project catalog")?;
    validate_id(&document.project.id, "project id")?;
    validate_nonempty(&document.project.title, "project title")?;
    validate_id(&document.default_run_type, "default run type")?;
    if document.run_types.is_empty() {
        return Err(catalog_error(
            "project catalog must contain at least one run type",
        ));
    }
    Ok(())
}

fn validate_run_type_header(document: &RunTypeDocument, path: &Path) -> Result<()> {
    validate_schema(
        &document.schema_version,
        &format!("run type document {}", path.display()),
    )?;
    validate_id(&document.id, "run type id")?;
    validate_nonempty(
        &document.title,
        &format!("run type `{}` title", document.id),
    )
}

fn validate_schema(version: &str, context: &str) -> Result<()> {
    if version != PROJECT_CATALOG_SCHEMA_VERSION {
        return Err(catalog_error(format!(
            "{context} schema_version must be `{PROJECT_CATALOG_SCHEMA_VERSION}`, got `{version}`"
        )));
    }
    Ok(())
}

fn validate_id(value: &str, label: &str) -> Result<()> {
    validate_nonempty(value, label)?;
    if value.chars().any(char::is_whitespace) {
        return Err(catalog_error(format!(
            "{label} `{value}` may not contain whitespace"
        )));
    }
    Ok(())
}

fn validate_nonempty(value: &str, label: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(catalog_error(format!("{label} may not be empty")));
    }
    Ok(())
}

fn validate_relative_path(path: &Path, label: &str) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(catalog_error(format!(
            "{label} must be a non-empty relative path"
        )));
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(catalog_error(format!(
            "{label} `{}` may contain only normal path components",
            path.display()
        )));
    }
    Ok(())
}

fn resolve_contained_file(base: &Path, relative: &Path, label: &str) -> Result<PathBuf> {
    validate_relative_path(relative, label)?;
    let base = base
        .canonicalize()
        .map_err(|source| io_error(base, source))?;
    let candidate = base.join(relative);
    let resolved = candidate
        .canonicalize()
        .map_err(|source| io_error(&candidate, source))?;
    if !resolved.starts_with(&base) {
        return Err(catalog_error(format!(
            "{label} `{}` resolves outside {}",
            relative.display(),
            base.display()
        )));
    }
    if !resolved.is_file() {
        return Err(catalog_error(format!(
            "{label} `{}` does not resolve to a file",
            relative.display()
        )));
    }
    Ok(resolved)
}

fn resolve_run_type(
    id: &str,
    documents: &HashMap<String, RunTypeDocument>,
    project_root: &Path,
    resolved: &mut IndexMap<String, ResolvedRunType>,
    visiting: &mut Vec<String>,
) -> Result<ResolvedRunType> {
    if let Some(run_type) = resolved.get(id) {
        return Ok(run_type.clone());
    }
    if let Some(cycle_start) = visiting.iter().position(|candidate| candidate == id) {
        let mut cycle = visiting[cycle_start..].to_vec();
        cycle.push(id.to_owned());
        return Err(catalog_error(format!(
            "run type inheritance cycle: {}",
            cycle.join(" -> ")
        )));
    }
    let document = documents
        .get(id)
        .ok_or_else(|| catalog_error(format!("missing run type `{id}`")))?;
    visiting.push(id.to_owned());

    let (behavior, ancestry, description) = if let Some(parent_id) = &document.extends {
        validate_id(parent_id, &format!("run type `{id}` parent id"))?;
        reject_derived_inline_behavior(document)?;
        let parent = resolve_run_type(parent_id, documents, project_root, resolved, visiting)?;
        let mut behavior = behavior_from_resolved(&parent);
        apply_overrides(&mut behavior, &document.overrides, id)?;
        let mut ancestry = parent.ancestry.clone();
        ancestry.push(parent.id.clone());
        (
            behavior,
            ancestry,
            document
                .description
                .clone()
                .or_else(|| parent.description.clone()),
        )
    } else {
        if !document.overrides.is_empty() {
            return Err(catalog_error(format!(
                "base run type `{id}` may not declare overrides"
            )));
        }
        (
            base_behavior(document)?,
            Vec::new(),
            document.description.clone(),
        )
    };

    validate_behavior(&behavior, id)?;
    let profile = resolve_yaml_profile_source(project_root, &behavior.profile, id)?;
    let mut run_type = ResolvedRunType {
        id: document.id.clone(),
        title: document.title.clone(),
        description,
        extends: document.extends.clone(),
        ancestry,
        profile,
        intake: behavior.intake,
        pipeline: behavior.pipeline,
        questions: behavior.questions,
        git: behavior.git,
        run_card: behavior.run_card,
        agents: behavior.agents,
        orchestration: behavior.orchestration,
        instructions: behavior.instructions,
        hash: String::new(),
    };
    run_type.hash = resolved_run_type_hash(&run_type);
    visiting.pop();
    resolved.insert(id.to_owned(), run_type.clone());
    Ok(run_type)
}

fn reject_derived_inline_behavior(document: &RunTypeDocument) -> Result<()> {
    let mut fields = Vec::new();
    if document.profile.is_some() {
        fields.push("profile");
    }
    if document.intake.is_some() {
        fields.push("intake");
    }
    if document.pipeline.is_some() {
        fields.push("pipeline");
    }
    if document.questions.is_some() {
        fields.push("questions");
    }
    if document.git.is_some() {
        fields.push("git");
    }
    if document.run_card.is_some() {
        fields.push("run_card");
    }
    if document.agents.is_some() {
        fields.push("agents");
    }
    if document.orchestration.is_some() {
        fields.push("orchestration");
    }
    if document.instructions != RunTypeInstructions::default() {
        fields.push("instructions");
    }
    if !fields.is_empty() {
        return Err(catalog_error(format!(
            "derived run type `{}` may alter behavior only through overrides; inline fields: {}",
            document.id,
            fields.join(", ")
        )));
    }
    Ok(())
}

fn base_behavior(document: &RunTypeDocument) -> Result<RunTypeBehavior> {
    let missing = [
        ("profile", document.profile.is_none()),
        ("intake", document.intake.is_none()),
        ("pipeline", document.pipeline.is_none()),
        ("questions", document.questions.is_none()),
        ("git", document.git.is_none()),
        ("run_card", document.run_card.is_none()),
    ]
    .into_iter()
    .filter_map(|(field, absent)| absent.then_some(field))
    .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(catalog_error(format!(
            "base run type `{}` is missing required behavior fields: {}",
            document.id,
            missing.join(", ")
        )));
    }
    Ok(RunTypeBehavior {
        profile: document.profile.clone().expect("validated above"),
        intake: document.intake.clone().expect("validated above"),
        pipeline: document.pipeline.clone().expect("validated above"),
        questions: document.questions.clone().expect("validated above"),
        git: document.git.clone().expect("validated above"),
        run_card: document.run_card.clone().expect("validated above"),
        agents: document.agents.clone(),
        orchestration: document.orchestration.clone(),
        instructions: document.instructions.clone(),
    })
}

fn behavior_from_resolved(run_type: &ResolvedRunType) -> RunTypeBehavior {
    RunTypeBehavior {
        profile: ProfileSourceDef {
            source: run_type.profile.source.clone(),
        },
        intake: run_type.intake.clone(),
        pipeline: run_type.pipeline.clone(),
        questions: run_type.questions.clone(),
        git: run_type.git.clone(),
        run_card: run_type.run_card.clone(),
        agents: run_type.agents.clone(),
        orchestration: run_type.orchestration.clone(),
        instructions: run_type.instructions.clone(),
    }
}

fn apply_overrides(
    behavior: &mut RunTypeBehavior,
    overrides: &[RunTypeOverride],
    run_type_id: &str,
) -> Result<()> {
    let mut value = serde_json::to_value(&*behavior).map_err(|source| {
        catalog_error(format!(
            "failed to serialize inherited behavior for `{run_type_id}`: {source}"
        ))
    })?;
    for (index, operation) in overrides.iter().enumerate() {
        apply_override(&mut value, operation).map_err(|error| {
            catalog_error(format!(
                "run type `{run_type_id}` override {} at `{}` failed: {error}",
                index + 1,
                operation.path
            ))
        })?;
    }
    *behavior = serde_json::from_value(value).map_err(|source| {
        catalog_error(format!(
            "run type `{run_type_id}` overrides produced invalid behavior: {source}"
        ))
    })?;
    Ok(())
}

fn apply_override(
    root: &mut Value,
    operation: &RunTypeOverride,
) -> std::result::Result<(), String> {
    let segments = decode_json_pointer(&operation.path)?;
    const BEHAVIOR_ROOTS: &[&str] = &[
        "profile",
        "intake",
        "pipeline",
        "questions",
        "git",
        "run_card",
        "agents",
        "orchestration",
        "instructions",
    ];
    if !BEHAVIOR_ROOTS.contains(&segments[0].as_str()) {
        return Err(format!(
            "pointer root `{}` is not a run-type behavior field",
            segments[0]
        ));
    }
    let (parent_segments, final_segment) = segments.split_at(segments.len() - 1);
    let parent = navigate_object_mut(root, parent_segments)?;
    let key = &final_segment[0];

    match operation.op {
        OverrideOp::Merge => {
            let incoming = operation
                .value
                .as_ref()
                .ok_or_else(|| "merge requires a value".to_owned())?;
            if !incoming.is_object() {
                return Err("merge value must be an object".to_owned());
            }
            let target = parent
                .get_mut(key)
                .ok_or_else(|| "merge target does not exist".to_owned())?;
            if !target.is_object() {
                return Err("merge target must be an object".to_owned());
            }
            recursive_object_merge(target, incoming.clone());
        }
        OverrideOp::Replace => {
            let replacement = operation
                .value
                .clone()
                .ok_or_else(|| "replace requires a value".to_owned())?;
            let target = parent
                .get_mut(key)
                .ok_or_else(|| "replace target does not exist".to_owned())?;
            *target = replacement;
        }
        OverrideOp::Remove => {
            if operation.value.is_some() {
                return Err("remove must not include a value".to_owned());
            }
            if parent.remove(key).is_none() {
                return Err("remove target does not exist".to_owned());
            }
        }
    }
    Ok(())
}

fn decode_json_pointer(pointer: &str) -> std::result::Result<Vec<String>, String> {
    if pointer.is_empty() || !pointer.starts_with('/') {
        return Err("path must be a non-empty JSON Pointer beginning with `/`".to_owned());
    }
    let mut decoded = Vec::new();
    for raw in pointer[1..].split('/') {
        let mut segment = String::new();
        let mut chars = raw.chars();
        while let Some(character) = chars.next() {
            if character != '~' {
                segment.push(character);
                continue;
            }
            match chars.next() {
                Some('0') => segment.push('~'),
                Some('1') => segment.push('/'),
                Some(other) => return Err(format!("invalid JSON Pointer escape `~{other}`")),
                None => return Err("invalid trailing `~` in JSON Pointer".to_owned()),
            }
        }
        if segment.is_empty() {
            return Err("empty JSON Pointer segments are prohibited".to_owned());
        }
        if segment == "-" || segment.chars().all(|character| character.is_ascii_digit()) {
            return Err(format!(
                "array-style JSON Pointer segment `{segment}` is prohibited"
            ));
        }
        decoded.push(segment);
    }
    Ok(decoded)
}

fn navigate_object_mut<'a>(
    mut value: &'a mut Value,
    segments: &[String],
) -> std::result::Result<&'a mut serde_json::Map<String, Value>, String> {
    for segment in segments {
        let object = value
            .as_object_mut()
            .ok_or_else(|| format!("pointer traverses non-object before `{segment}`"))?;
        value = object
            .get_mut(segment)
            .ok_or_else(|| format!("pointer segment `{segment}` does not exist"))?;
    }
    value
        .as_object_mut()
        .ok_or_else(|| "pointer parent is not an object".to_owned())
}

fn recursive_object_merge(target: &mut Value, incoming: Value) {
    let target = target
        .as_object_mut()
        .expect("merge target was checked as an object");
    let incoming = incoming
        .as_object()
        .expect("merge value was checked as an object");
    for (key, value) in incoming {
        match (target.get_mut(key), value) {
            (Some(existing), Value::Object(_)) if existing.is_object() => {
                recursive_object_merge(existing, value.clone());
            }
            _ => {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

fn validate_behavior(behavior: &RunTypeBehavior, run_type_id: &str) -> Result<()> {
    if !behavior.instructions.planning.is_empty()
        && behavior.instructions.planning.trim().is_empty()
    {
        return Err(catalog_error(format!(
            "run type `{run_type_id}` planning instructions may not be blank"
        )));
    }
    validate_relative_path(
        &behavior.profile.source,
        &format!("run type `{run_type_id}` profile source"),
    )?;
    validate_exact_order(
        behavior.intake.fields.keys(),
        &behavior.intake.order,
        &format!("run type `{run_type_id}` intake"),
    )?;
    for (id, field) in &behavior.intake.fields {
        validate_id(id, &format!("run type `{run_type_id}` intake field id"))?;
        validate_nonempty(
            &field.label,
            &format!("run type `{run_type_id}` intake field `{id}` label"),
        )?;
        validate_intake_field(field, run_type_id, id)?;
    }

    validate_exact_order(
        behavior.pipeline.stages.keys(),
        &behavior.pipeline.order,
        &format!("run type `{run_type_id}` pipeline"),
    )?;
    let mut external_loop_ids = HashMap::<String, String>::new();
    for (id, stage) in &behavior.pipeline.stages {
        validate_id(id, &format!("run type `{run_type_id}` pipeline stage id"))?;
        validate_nonempty(
            &stage.kind,
            &format!("run type `{run_type_id}` pipeline stage `{id}` kind"),
        )?;
        validate_nonempty(
            &stage.title,
            &format!("run type `{run_type_id}` pipeline stage `{id}` title"),
        )?;
        if stage.kind == "external_loop" {
            let config = stage.config.as_ref().ok_or_else(|| {
                catalog_error(format!(
                    "run type `{run_type_id}` external-loop stage `{id}` requires config"
                ))
            })?;
            let config = config.get("external_loop").unwrap_or(config);
            let loop_id = config.get("id").and_then(Value::as_str).ok_or_else(|| {
                catalog_error(format!(
                    "run type `{run_type_id}` external-loop stage `{id}` requires a string config id"
                ))
            })?;
            validate_id(
                loop_id,
                &format!("run type `{run_type_id}` external-loop stage `{id}` config id"),
            )?;
            if let Some(previous) = external_loop_ids.insert(loop_id.to_owned(), id.clone()) {
                return Err(catalog_error(format!(
                    "run type `{run_type_id}` external-loop stages `{previous}` and `{id}` reuse config id `{loop_id}`"
                )));
            }
        }
    }

    validate_nonempty(
        &behavior.git.branch_template,
        &format!("run type `{run_type_id}` git branch_template"),
    )?;
    validate_nonempty(
        &behavior.git.ticket_branch_template,
        &format!("run type `{run_type_id}` git ticket_branch_template"),
    )?;
    let mut sections = HashSet::new();
    for section in &behavior.run_card.sections {
        validate_nonempty(
            section,
            &format!("run type `{run_type_id}` run-card section"),
        )?;
        if !sections.insert(section) {
            return Err(catalog_error(format!(
                "run type `{run_type_id}` run_card contains duplicate section `{section}`"
            )));
        }
    }
    if let Some(agents) = &behavior.agents {
        validate_agent_settings_map(&agents.roles, run_type_id, "role")?;
        validate_agent_settings_map(&agents.personas, run_type_id, "persona")?;
    }
    if let Some(orchestration) = &behavior.orchestration {
        if orchestration.max_parallel == Some(0) {
            return Err(catalog_error(format!(
                "run type `{run_type_id}` orchestration max_parallel must be positive"
            )));
        }
        if orchestration.max_boundaries_per_lead == Some(0) {
            return Err(catalog_error(format!(
                "run type `{run_type_id}` orchestration max_boundaries_per_lead must be positive"
            )));
        }
        for (field, action) in [
            ("compile_action", &orchestration.compile_action),
            ("lead_action", &orchestration.lead_action),
            ("report_action", &orchestration.report_action),
        ] {
            validate_nonempty(
                action,
                &format!("run type `{run_type_id}` orchestration {field}"),
            )?;
        }
    }
    Ok(())
}

fn validate_agent_settings_map(
    settings: &IndexMap<String, AgentSettings>,
    run_type_id: &str,
    kind: &str,
) -> Result<()> {
    for (id, setting) in settings {
        validate_id(id, &format!("run type `{run_type_id}` agent {kind} id"))?;
        if let Some(model) = &setting.model {
            validate_nonempty(
                model,
                &format!("run type `{run_type_id}` agent {kind} `{id}` model"),
            )?;
        }
        if let Some(reasoning_effort) = &setting.reasoning_effort {
            validate_nonempty(
                reasoning_effort,
                &format!("run type `{run_type_id}` agent {kind} `{id}` reasoning_effort"),
            )?;
        }
    }
    Ok(())
}

fn validate_exact_order<'a>(
    keys: impl Iterator<Item = &'a String>,
    order: &[String],
    label: &str,
) -> Result<()> {
    let expected: BTreeSet<_> = keys.cloned().collect();
    let mut actual = BTreeSet::new();
    for id in order {
        if !actual.insert(id.clone()) {
            return Err(catalog_error(format!(
                "{label} order contains duplicate id `{id}`"
            )));
        }
    }
    if expected != actual {
        let missing = expected.difference(&actual).cloned().collect::<Vec<_>>();
        let unknown = actual.difference(&expected).cloned().collect::<Vec<_>>();
        return Err(catalog_error(format!(
            "{label} order must name every definition exactly once (missing: [{}], unknown: [{}])",
            missing.join(", "),
            unknown.join(", ")
        )));
    }
    Ok(())
}

fn validate_intake_field(field: &IntakeFieldDef, run_type_id: &str, field_id: &str) -> Result<()> {
    let label = format!("run type `{run_type_id}` intake field `{field_id}`");
    match field.field_type {
        IntakeFieldType::Choice | IntakeFieldType::MultiChoice => {
            let options = field.options.as_ref().ok_or_else(|| {
                catalog_error(format!("{label} requires a non-empty options list"))
            })?;
            if options.is_empty() {
                return Err(catalog_error(format!(
                    "{label} requires a non-empty options list"
                )));
            }
            for (index, option) in options.iter().enumerate() {
                if options[..index].contains(option) {
                    return Err(catalog_error(format!(
                        "{label} contains duplicate option {}",
                        serde_json::to_string(option).unwrap_or_else(|_| "<value>".to_owned())
                    )));
                }
            }
        }
        _ if field.options.is_some() => {
            return Err(catalog_error(format!(
                "{label} may declare options only for choice and multi_choice types"
            )));
        }
        _ => {}
    }

    if let Some(default) = &field.default {
        let type_matches = match field.field_type {
            IntakeFieldType::String | IntakeFieldType::Text | IntakeFieldType::Path => {
                default.is_string()
            }
            IntakeFieldType::Boolean => default.is_boolean(),
            IntakeFieldType::Integer => default
                .as_number()
                .is_some_and(|number| number.is_i64() || number.is_u64()),
            IntakeFieldType::Number => default.is_number(),
            IntakeFieldType::Choice => field
                .options
                .as_ref()
                .is_some_and(|options| options.contains(default)),
            IntakeFieldType::MultiChoice => default.as_array().is_some_and(|values| {
                field
                    .options
                    .as_ref()
                    .is_some_and(|options| values.iter().all(|value| options.contains(value)))
            }),
            IntakeFieldType::Json => true,
        };
        if !type_matches {
            return Err(catalog_error(format!(
                "{label} default does not match its declared type/options"
            )));
        }
    }
    Ok(())
}

fn resolve_yaml_profile_source(
    project_root: &Path,
    profile: &ProfileSourceDef,
    run_type_id: &str,
) -> Result<ResolvedProfileSource> {
    let extension = profile.source.extension().and_then(|value| value.to_str());
    if !matches!(extension, Some("yaml" | "yml")) {
        return Err(catalog_error(format!(
            "run type `{run_type_id}` profile source `{}` must be YAML",
            profile.source.display()
        )));
    }
    let resolved_path = resolve_contained_file(
        project_root,
        &profile.source,
        &format!("run type `{run_type_id}` profile source"),
    )?;
    let value: Value = load_yaml(&resolved_path)?;
    Ok(ResolvedProfileSource {
        source: profile.source.clone(),
        format: ProfileSourceFormat::Yaml,
        resolved_path,
        source_hash: normalized_hash(&value),
    })
}

#[derive(Serialize)]
struct ResolvedProfileHashView<'a> {
    source: &'a Path,
    format: ProfileSourceFormat,
    source_hash: &'a str,
}

#[derive(Serialize)]
struct ResolvedRunTypeHashView<'a> {
    id: &'a str,
    title: &'a str,
    description: &'a Option<String>,
    extends: &'a Option<String>,
    ancestry: &'a [String],
    profile: ResolvedProfileHashView<'a>,
    intake: &'a IntakeDef,
    pipeline: &'a PipelineDef,
    questions: &'a QuestionDefaults,
    git: &'a RunGitDefaults,
    run_card: &'a RunCardDef,
    #[serde(skip_serializing_if = "Option::is_none")]
    agents: Option<&'a RunTypeAgents>,
    #[serde(skip_serializing_if = "Option::is_none")]
    orchestration: Option<&'a RunTypeOrchestrationPolicy>,
    #[serde(skip_serializing_if = "RunTypeInstructions::is_empty")]
    instructions: &'a RunTypeInstructions,
}

fn resolved_run_type_hash(run_type: &ResolvedRunType) -> String {
    normalized_hash(&ResolvedRunTypeHashView {
        id: &run_type.id,
        title: &run_type.title,
        description: &run_type.description,
        extends: &run_type.extends,
        ancestry: &run_type.ancestry,
        profile: ResolvedProfileHashView {
            source: &run_type.profile.source,
            format: run_type.profile.format,
            source_hash: &run_type.profile.source_hash,
        },
        intake: &run_type.intake,
        pipeline: &run_type.pipeline,
        questions: &run_type.questions,
        git: &run_type.git,
        run_card: &run_type.run_card,
        agents: run_type.agents.as_ref(),
        orchestration: run_type.orchestration.as_ref(),
        instructions: &run_type.instructions,
    })
}

#[derive(Serialize)]
struct CatalogHashView<'a> {
    schema_version: &'a str,
    project: &'a ProjectCatalogMetadata,
    default_run_type: &'a str,
    run_types: BTreeMap<&'a str, &'a str>,
}

fn catalog_hash(
    document: &ProjectCatalogDocument,
    run_types: &IndexMap<String, ResolvedRunType>,
) -> String {
    normalized_hash(&CatalogHashView {
        schema_version: &document.schema_version,
        project: &document.project,
        default_run_type: &document.default_run_type,
        run_types: run_types
            .iter()
            .map(|(id, run_type)| (id.as_str(), run_type.hash.as_str()))
            .collect(),
    })
}

fn legacy_behavior(manifest: &ProfileManifest, source: PathBuf) -> RunTypeBehavior {
    let mut fields = IndexMap::new();
    fields.insert(
        "goal".to_owned(),
        IntakeFieldDef {
            label: "Goal".to_owned(),
            description: Some("The objective for this Koni run.".to_owned()),
            field_type: IntakeFieldType::Text,
            required: true,
            default: None,
            options: None,
        },
    );
    let mut stages = IndexMap::new();
    stages.insert(
        "profile".to_owned(),
        PipelineStageDef {
            kind: "legacy_profile".to_owned(),
            title: "Legacy profile".to_owned(),
            config: Some(serde_json::json!({"profile_id": manifest.profile.id})),
        },
    );
    RunTypeBehavior {
        profile: ProfileSourceDef { source },
        intake: IntakeDef {
            fields,
            order: vec!["goal".to_owned()],
        },
        pipeline: PipelineDef {
            stages,
            order: vec!["profile".to_owned()],
        },
        questions: QuestionDefaults {
            policy: QuestionPolicy::HighImpactOnly,
            default_scope: QuestionScope::Ticket,
        },
        git: RunGitDefaults {
            // A legacy integration branch names the checkout the old singleton
            // runtime expected; it is never safe as a new per-run branch.
            branch_template: "koni/runs/{{ run.slug }}-{{ run.short_id }}".to_owned(),
            ticket_branch_template: "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}".to_owned(),
        },
        run_card: RunCardDef {
            sections: ["goal", "graph", "tickets", "checks"]
                .map(str::to_owned)
                .to_vec(),
        },
        agents: None,
        orchestration: None,
        instructions: RunTypeInstructions::default(),
    }
}

fn legacy_migration(manifest: &ProfileManifest) -> LegacyCatalogMigration {
    let profile_source = PathBuf::from(".codex/koni/profile.yaml");
    let project = ProjectCatalogDocument {
        schema_version: PROJECT_CATALOG_SCHEMA_VERSION.to_owned(),
        project: ProjectCatalogMetadata {
            id: manifest.profile.id.clone(),
            title: manifest.profile.id.clone(),
            description: nonempty_option(&manifest.profile.description),
        },
        default_run_type: LEGACY_RUN_TYPE_ID.to_owned(),
        run_types: vec![RunTypeCatalogEntry {
            id: LEGACY_RUN_TYPE_ID.to_owned(),
            path: PathBuf::from("run-types/legacy.yaml"),
        }],
    };
    let behavior = legacy_behavior(manifest, profile_source.clone());
    let run_type = RunTypeDocument {
        schema_version: PROJECT_CATALOG_SCHEMA_VERSION.to_owned(),
        id: LEGACY_RUN_TYPE_ID.to_owned(),
        title: manifest.profile.id.clone(),
        description: nonempty_option(&manifest.profile.description),
        extends: None,
        profile: Some(behavior.profile),
        intake: Some(behavior.intake),
        pipeline: Some(behavior.pipeline),
        questions: Some(behavior.questions),
        git: Some(behavior.git),
        run_card: Some(behavior.run_card),
        agents: behavior.agents,
        orchestration: behavior.orchestration,
        instructions: behavior.instructions,
        overrides: Vec::new(),
    };
    LegacyCatalogMigration {
        canonical_project_path: PathBuf::from(".codex/koni/project.yaml"),
        canonical_run_type_path: PathBuf::from(".codex/koni/run-types/legacy.yaml"),
        suggested_profile_source: profile_source,
        profile_conversion_required: true,
        project,
        run_type,
    }
}

fn nonempty_option(value: &str) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.to_owned())
}

fn catalog_error(message: impl Into<String>) -> KoniError {
    KoniError::Profile(format!("project catalog: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ProfileCompiler;
    use tempfile::TempDir;

    const PROJECT: &str = r#"
schema_version: "1.0"
project:
  id: demo
  title: Demo project
default_run_type: fast
run_types:
  - id: base
    path: run-types/base.yaml
  - id: fast
    path: run-types/fast.yaml
"#;

    const BASE: &str = r#"
schema_version: "1.0"
id: base
title: Base run
description: Base behavior
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal:
      label: Goal
      type: text
      required: true
    dataset:
      label: Dataset
      type: path
  order: [goal, dataset]
pipeline:
  stages:
    plan:
      kind: planning
      title: Plan work
      config:
        modes: [careful]
  order: [plan]
questions:
  policy: interactive
  default_scope: ticket
git:
  branch_template: koni/run/{{ run.id }}
  ticket_branch_template: koni/ticket/{{ ticket.id }}
run_card:
  sections: [goal, plan]
"#;

    const DERIVED: &str = r#"
schema_version: "1.0"
id: fast
title: Fast run
extends: base
overrides:
  - op: merge
    path: /pipeline/stages
    value:
      execute:
        kind: execution
        title: Execute work
  - op: replace
    path: /pipeline/order
    value: [plan, execute]
  - op: remove
    path: /intake/fields/dataset
  - op: replace
    path: /intake/order
    value: [goal]
  - op: replace
    path: /questions/policy
    value: autonomous
  - op: merge
    path: /run_card
    value:
      sections: [goal, results]
"#;

    struct Fixture {
        temp: TempDir,
    }

    impl Fixture {
        fn canonical() -> Self {
            let fixture = Self {
                temp: TempDir::new().unwrap(),
            };
            fixture.write(".codex/koni/project.yaml", PROJECT);
            fixture.write(".codex/koni/run-types/base.yaml", BASE);
            fixture.write(".codex/koni/run-types/fast.yaml", DERIVED);
            fixture.write(
                ".codex/koni/profile.yaml",
                "schema_version: '1.0'\nprofile:\n  id: demo\n  version: 1.0.0\n",
            );
            fixture
        }

        fn write(&self, path: &str, contents: &str) {
            let path = self.temp.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }

        fn write_profile_definitions(&self, include_reviewer: bool) {
            self.write(
                ".codex/koni/profile.yaml",
                r#"
schema_version: "1.0"
engine: ">=0.1,<0.2"
profile:
  id: demo
  version: 1.0.0
imports:
  actions: [modules/actions.yaml]
  personas: [modules/personas.yaml]
"#,
            );
            let reviewer = if include_reviewer {
                r#"
  - id: reviewer
    prompt: personas/reviewer.md
    model_role: reviewer
"#
            } else {
                ""
            };
            self.write(
                ".codex/koni/modules/personas.yaml",
                &format!(
                    r#"
personas:
  - id: run-planner
    prompt: personas/run-planner.md
    model_role: planner
{reviewer}"#
                ),
            );
            self.write(
                ".codex/koni/modules/actions.yaml",
                r#"
actions:
  - id: compile-command
    aliases: [compile]
    recipe: [{primitive: project.validate}]
  - id: lead-command
    aliases: [spawn-lead]
    recipe: [{primitive: project.validate}]
  - id: report-command
    aliases: [report]
    recipe: [{primitive: project.validate}]
"#,
            );
            self.write(".codex/koni/personas/run-planner.md", "Plan the run.");
            if include_reviewer {
                self.write(".codex/koni/personas/reviewer.md", "Review the run.");
            }
        }

        fn compile(&self) -> Result<CompiledProjectCatalog> {
            ProjectCatalogCompiler::compile(self.temp.path())
        }
    }

    fn assert_error_contains(result: Result<CompiledProjectCatalog>, needle: &str) {
        let error = result.expect_err("compilation should fail").to_string();
        assert!(
            error.contains(needle),
            "expected error containing {needle:?}, got {error:?}"
        );
    }

    #[test]
    fn resolves_explicit_inheritance_and_hashes_full_behavior() {
        let fixture = Fixture::canonical();
        let first = fixture.compile().unwrap();
        let fast = first.default_run_type();

        assert_eq!(fast.id, "fast");
        assert_eq!(fast.extends.as_deref(), Some("base"));
        assert_eq!(fast.ancestry, ["base"]);
        assert_eq!(fast.description.as_deref(), Some("Base behavior"));
        assert_eq!(fast.intake.order, ["goal"]);
        assert!(!fast.intake.fields.contains_key("dataset"));
        assert_eq!(fast.pipeline.order, ["plan", "execute"]);
        assert_eq!(fast.pipeline.stages["execute"].kind, "execution");
        assert_eq!(fast.questions.policy, QuestionPolicy::Autonomous);
        assert_eq!(fast.run_card.sections, ["goal", "results"]);
        assert_eq!(fast.profile.format, ProfileSourceFormat::Yaml);
        assert!(fast.profile.resolved_path.is_absolute());
        assert!(fast.hash.starts_with("sha256:"));
        assert!(first.hash.starts_with("sha256:"));

        let second = fixture.compile().unwrap();
        assert_eq!(first.hash, second.hash);
        assert_eq!(fast.hash, second.default_run_type().hash);

        fixture.write(
            ".codex/koni/profile.yaml",
            "profile:\n  version: 1.0.0\n  id: demo\nschema_version: '1.0'\n",
        );
        let reordered = fixture.compile().unwrap();
        assert_eq!(first.hash, reordered.hash);
    }

    #[test]
    fn omitted_optional_policy_preserves_the_historical_run_type_hash_shape() {
        #[derive(Serialize)]
        struct HistoricalRunTypeHashView<'a> {
            id: &'a str,
            title: &'a str,
            description: &'a Option<String>,
            extends: &'a Option<String>,
            ancestry: &'a [String],
            profile: ResolvedProfileHashView<'a>,
            intake: &'a IntakeDef,
            pipeline: &'a PipelineDef,
            questions: &'a QuestionDefaults,
            git: &'a RunGitDefaults,
            run_card: &'a RunCardDef,
        }

        let fixture = Fixture::canonical();
        let catalog = fixture.compile().unwrap();
        let run_type = catalog.default_run_type();
        assert!(run_type.agents.is_none());
        assert!(run_type.orchestration.is_none());
        let historical = HistoricalRunTypeHashView {
            id: &run_type.id,
            title: &run_type.title,
            description: &run_type.description,
            extends: &run_type.extends,
            ancestry: &run_type.ancestry,
            profile: ResolvedProfileHashView {
                source: &run_type.profile.source,
                format: run_type.profile.format,
                source_hash: &run_type.profile.source_hash,
            },
            intake: &run_type.intake,
            pipeline: &run_type.pipeline,
            questions: &run_type.questions,
            git: &run_type.git,
            run_card: &run_type.run_card,
        };
        assert_eq!(run_type.hash, normalized_hash(&historical));
    }

    #[test]
    fn agent_and_orchestration_policy_inherit_override_and_affect_hashes() {
        let fixture = Fixture::canonical();
        fixture.write_profile_definitions(true);
        let original = fixture.compile().unwrap();
        let original_hash = original.default_run_type().hash.clone();
        fixture.write(
            ".codex/koni/run-types/base.yaml",
            &format!(
                "{BASE}\nagents:\n  roles:\n    planner:\n      model: base-model\n      reasoning_effort: high\n  personas:\n    specialist:\n      model: specialist-model\norchestration:\n  auto_start: true\n  max_parallel: 4\n  max_boundaries_per_lead: 2\n"
            ),
        );
        fixture.write(
            ".codex/koni/run-types/fast.yaml",
            &format!(
                "{DERIVED}\n  - op: replace\n    path: /agents/roles/planner/model\n    value: fast-model\n  - op: replace\n    path: /orchestration/max_parallel\n    value: 2\n"
            ),
        );

        let compiled = fixture.compile().unwrap();
        let run_type = compiled.default_run_type();
        let agents = run_type.agents.as_ref().unwrap();
        assert_eq!(agents.roles["planner"].model.as_deref(), Some("fast-model"));
        assert_eq!(
            agents.roles["planner"].reasoning_effort.as_deref(),
            Some("high")
        );
        assert_eq!(
            agents.personas["specialist"].model.as_deref(),
            Some("specialist-model")
        );
        let orchestration = run_type.orchestration.as_ref().unwrap();
        assert!(orchestration.auto_start);
        assert_eq!(orchestration.max_parallel, Some(2));
        assert_eq!(orchestration.max_boundaries_per_lead, Some(2));
        assert_eq!(orchestration.compile_action, "compile");
        assert_eq!(orchestration.lead_action, "spawn-lead");
        assert_eq!(orchestration.report_action, "report");
        assert_ne!(run_type.hash, original_hash);
    }

    #[test]
    fn planning_instructions_inherit_only_through_overrides_and_affect_hashes() {
        let fixture = Fixture::canonical();
        let original = fixture.compile().unwrap();
        let original_hash = original.default_run_type().hash.clone();
        assert!(original.default_run_type().instructions.planning.is_empty());

        fixture.write(
            ".codex/koni/run-types/base.yaml",
            &format!(
                "{BASE}\ninstructions:\n  planning: Ask two focused questions before finalizing the plan.\n"
            ),
        );
        fixture.write(
            ".codex/koni/run-types/fast.yaml",
            &format!(
                "{DERIVED}\n  - op: replace\n    path: /instructions/planning\n    value: Ask one high-impact question, then state assumptions.\n"
            ),
        );

        let compiled = fixture.compile().unwrap();
        let run_type = compiled.default_run_type();
        assert_eq!(
            run_type.instructions.planning,
            "Ask one high-impact question, then state assumptions."
        );
        assert_ne!(run_type.hash, original_hash);

        fixture.write(
            ".codex/koni/run-types/fast.yaml",
            &format!(
                "{DERIVED}\ninstructions:\n  planning: Inline derived behavior is forbidden.\n"
            ),
        );
        assert_error_contains(fixture.compile(), "inline fields: instructions");
    }

    #[test]
    fn planning_instructions_reject_whitespace_but_allow_the_empty_default() {
        let fixture = Fixture::canonical();
        fixture.compile().unwrap();
        fixture.write(
            ".codex/koni/run-types/base.yaml",
            &format!("{BASE}\ninstructions:\n  planning: '   '\n"),
        );
        assert_error_contains(fixture.compile(), "planning instructions may not be blank");
    }

    #[test]
    fn resolved_run_type_materializes_as_equivalent_standalone_document() {
        let fixture = Fixture::canonical();
        let catalog = fixture.compile().unwrap();
        let resolved = catalog.default_run_type();
        let standalone = resolved.standalone_document();

        assert_eq!(standalone.id, resolved.id);
        assert!(standalone.extends.is_none());
        assert!(standalone.overrides.is_empty());
        assert_eq!(
            standalone.pipeline.as_ref().unwrap().order,
            resolved.pipeline.order
        );
        assert_eq!(
            standalone.profile.as_ref().unwrap().source,
            resolved.profile.source
        );
        assert_eq!(standalone.instructions, resolved.instructions);
    }

    #[test]
    fn run_plan_overrides_serialize_only_explicit_choices() {
        let empty = RunPlanOverrides::default();
        assert!(empty.is_empty());
        assert_eq!(serde_yaml::to_string(&empty).unwrap(), "{}\n");

        let mut override_value = RunPlanOverrides {
            workflow_run_type: Some("large".to_owned()),
            max_parallel: Some(5),
            ..RunPlanOverrides::default()
        };
        override_value.agent_roles.insert(
            "planner".to_owned(),
            AgentSettingsOverride {
                model: Some(AgentSettingOverride::Configured(
                    "configured-model".to_owned(),
                )),
                reasoning_effort: Some(AgentSettingOverride::Configured("high".to_owned())),
            },
        );
        assert!(!override_value.is_empty());
        let round_trip: RunPlanOverrides =
            serde_yaml::from_str(&serde_yaml::to_string(&override_value).unwrap()).unwrap();
        assert_eq!(round_trip, override_value);
    }

    #[test]
    fn agent_settings_override_distinguishes_untouched_from_codex_default() {
        let mut settings = AgentSettings {
            model: Some("inherited-model".to_owned()),
            reasoning_effort: Some("high".to_owned()),
        };
        AgentSettingsOverride {
            model: Some(AgentSettingOverride::Configured("one-run-model".to_owned())),
            reasoning_effort: None,
        }
        .apply_to(&mut settings);
        assert_eq!(settings.model.as_deref(), Some("one-run-model"));
        assert_eq!(settings.reasoning_effort.as_deref(), Some("high"));

        let clear_reasoning = AgentSettingsOverride {
            model: None,
            reasoning_effort: Some(AgentSettingOverride::CodexDefault),
        };
        let encoded = serde_json::to_value(&clear_reasoning).unwrap();
        let decoded: AgentSettingsOverride = serde_json::from_value(encoded).unwrap();
        decoded.apply_to(&mut settings);
        assert_eq!(settings.model.as_deref(), Some("one-run-model"));
        assert_eq!(settings.reasoning_effort, None);
    }

    #[test]
    fn run_type_agent_and_orchestration_settings_are_validated() {
        let fixture = Fixture::canonical();
        fixture.write(
            ".codex/koni/run-types/base.yaml",
            &format!(
                "{BASE}\nagents:\n  roles:\n    'bad role':\n      model: model\norchestration:\n  max_parallel: 0\n"
            ),
        );
        assert_error_contains(fixture.compile(), "may not contain whitespace");

        fixture.write(
            ".codex/koni/run-types/base.yaml",
            &format!("{BASE}\norchestration:\n  max_parallel: 0\n"),
        );
        assert_error_contains(fixture.compile(), "max_parallel must be positive");

        fixture.write(
            ".codex/koni/run-types/base.yaml",
            &format!("{BASE}\norchestration:\n  max_boundaries_per_lead: 0\n"),
        );
        assert_error_contains(
            fixture.compile(),
            "max_boundaries_per_lead must be positive",
        );
    }

    #[test]
    fn rejects_unknown_planning_and_default_review_personas_during_catalog_loading() {
        let planning = Fixture::canonical();
        planning.write_profile_definitions(true);
        planning.write(
            ".codex/koni/run-types/base.yaml",
            &BASE.replace("modes: [careful]", "persona: missing-planner"),
        );
        assert_error_contains(
            planning.compile(),
            "pipeline stage `plan` references unknown persona `missing-planner`",
        );

        let review = Fixture::canonical();
        review.write_profile_definitions(false);
        review.write(
            ".codex/koni/run-types/base.yaml",
            &BASE
                .replace("modes: [careful]", "persona: run-planner")
                .replace(
                    "  order: [plan]",
                    r#"    independent-review:
      kind: agent_review
      title: Independent review
      config: {prompt: Review the completed work}
  order: [plan, independent-review]"#,
                ),
        );
        review.write(
            ".codex/koni/run-types/fast.yaml",
            &DERIVED.replace(
                "value: [plan, execute]",
                "value: [plan, independent-review, execute]",
            ),
        );
        assert_error_contains(
            review.compile(),
            "pipeline stage `independent-review` references unknown persona `reviewer`",
        );
    }

    #[test]
    fn orchestration_actions_are_resolved_by_profile_id_or_alias_during_catalog_loading() {
        let valid = Fixture::canonical();
        valid.write_profile_definitions(true);
        valid.write(
            ".codex/koni/run-types/base.yaml",
            &format!(
                "{BASE}\norchestration:\n  compile_action: compile\n  lead_action: spawn-lead\n  report_action: report\n"
            ),
        );
        valid.compile().unwrap();

        for field in ["compile_action", "lead_action", "report_action"] {
            let fixture = Fixture::canonical();
            fixture.write_profile_definitions(true);
            let compile_action = if field == "compile_action" {
                "missing-action"
            } else {
                "compile"
            };
            let lead_action = if field == "lead_action" {
                "missing-action"
            } else {
                "spawn-lead"
            };
            let report_action = if field == "report_action" {
                "missing-action"
            } else {
                "report"
            };
            fixture.write(
                ".codex/koni/run-types/base.yaml",
                &format!(
                    "{BASE}\norchestration:\n  compile_action: {compile_action}\n  lead_action: {lead_action}\n  report_action: {report_action}\n"
                ),
            );
            assert_error_contains(
                fixture.compile(),
                &format!("orchestration {field} references unknown action `missing-action`"),
            );
        }
    }

    #[test]
    fn every_run_type_in_a_project_must_share_one_profile() {
        let fixture = Fixture::canonical();
        fixture.write(
            ".codex/koni/other-profile.yaml",
            "schema_version: '1.0'\nprofile:\n  id: other\n  version: 1.0.0\n",
        );
        fixture.write(
            ".codex/koni/run-types/fast.yaml",
            &format!(
                "{DERIVED}\n  - op: replace\n    path: /profile/source\n    value: .codex/koni/other-profile.yaml\n"
            ),
        );

        assert_error_contains(
            fixture.compile(),
            "every run type in one project must share the same profile",
        );
    }

    #[test]
    fn external_loop_ids_must_be_unique_within_a_run_type() {
        let document: RunTypeDocument = serde_yaml::from_str(BASE).unwrap();
        let mut behavior = base_behavior(&document).unwrap();
        for stage_id in ["review-one", "review-two"] {
            behavior.pipeline.stages.insert(
                stage_id.to_owned(),
                PipelineStageDef {
                    kind: "external_loop".to_owned(),
                    title: stage_id.to_owned(),
                    config: Some(serde_json::json!({"external_loop": {"id": "review"}})),
                },
            );
            behavior.pipeline.order.push(stage_id.to_owned());
        }
        let error = validate_behavior(&behavior, "base")
            .unwrap_err()
            .to_string();
        assert!(error.contains("reuse config id `review`"), "{error}");
    }

    #[test]
    fn canonical_two_run_type_catalog_compiles_its_yaml_profile_imports() {
        let fixture = Fixture::canonical();
        fixture.write(
            ".codex/koni/profile.yaml",
            r#"
schema_version: "1.0"
engine: ">=0.1,<0.2"
profile:
  id: demo-yaml
  version: 1.0.0
  description: Imported YAML profile
imports:
  graph: [modules/nodes.yaml]
"#,
        );
        fixture.write(
            ".codex/koni/modules/nodes.yaml",
            r#"
node_types:
  - id: task
    description: A bounded unit of execution tracked by the canonical catalog fixture.
    stage: execution
    statuses: [active, complete]
"#,
        );

        let catalog = fixture.compile().unwrap();
        assert_eq!(catalog.run_types.len(), 2);
        assert_eq!(catalog.document.default_run_type, "fast");

        let profiles = catalog
            .run_types
            .values()
            .map(|run_type| ProfileCompiler::compile(&run_type.profile.resolved_path).unwrap())
            .collect::<Vec<_>>();
        let imported = fixture
            .temp
            .path()
            .join(".codex/koni/modules/nodes.yaml")
            .canonicalize()
            .unwrap();
        assert!(profiles.iter().all(|profile| {
            profile.manifest.profile.id == "demo-yaml"
                && profile.node_types.contains_key("task")
                && profile.imported_files == [imported.clone()]
        }));
        assert_eq!(profiles[0].hash, profiles[1].hash);
    }

    #[test]
    fn rejects_cycles_and_missing_parents() {
        let fixture = Fixture::canonical();
        fixture.write(
            ".codex/koni/run-types/base.yaml",
            r#"
schema_version: "1.0"
id: base
title: Base
extends: fast
"#,
        );
        assert_error_contains(fixture.compile(), "inheritance cycle");

        fixture.write(".codex/koni/run-types/base.yaml", BASE);
        fixture.write(
            ".codex/koni/run-types/fast.yaml",
            r#"
schema_version: "1.0"
id: fast
title: Fast
extends: absent
"#,
        );
        assert_error_contains(fixture.compile(), "missing run type `absent`");
    }

    #[test]
    fn rejects_missing_default_and_missing_files() {
        let fixture = Fixture::canonical();
        fixture.write(
            ".codex/koni/project.yaml",
            &PROJECT.replace("default_run_type: fast", "default_run_type: absent"),
        );
        assert_error_contains(fixture.compile(), "default run type `absent`");

        fixture.write(
            ".codex/koni/project.yaml",
            &PROJECT.replace("run-types/fast.yaml", "run-types/missing.yaml"),
        );
        assert_error_contains(fixture.compile(), "I/O error");
    }

    #[test]
    fn rejects_duplicate_and_ambiguous_catalog_references() {
        let fixture = Fixture::canonical();
        fixture.write(
            ".codex/koni/project.yaml",
            r#"
schema_version: "1.0"
project: {id: demo, title: Demo}
default_run_type: base
run_types:
  - {id: base, path: run-types/base.yaml}
  - {id: base, path: run-types/base-copy.yaml}
"#,
        );
        fixture.write(".codex/koni/run-types/base-copy.yaml", BASE);
        assert_error_contains(fixture.compile(), "duplicate run type catalog id `base`");

        fixture.write(
            ".codex/koni/project.yaml",
            r#"
schema_version: "1.0"
project: {id: demo, title: Demo}
default_run_type: base
run_types:
  - {id: base, path: run-types/base.yaml}
  - {id: other, path: run-types/base.yaml}
"#,
        );
        assert_error_contains(fixture.compile(), "ambiguous run type catalog reference");
    }

    #[test]
    fn rejects_catalog_and_document_id_mismatch() {
        let fixture = Fixture::canonical();
        fixture.write(
            ".codex/koni/project.yaml",
            r#"
schema_version: "1.0"
project: {id: demo, title: Demo}
default_run_type: other
run_types:
  - {id: other, path: run-types/base.yaml}
"#,
        );
        assert_error_contains(fixture.compile(), "does not match document id `base`");
    }

    #[test]
    fn rejects_array_pointer_segments_and_missing_targets() {
        let fixture = Fixture::canonical();
        fixture.write(
            ".codex/koni/run-types/fast.yaml",
            &DERIVED.replace("/pipeline/order\n", "/pipeline/order/0\n"),
        );
        assert_error_contains(fixture.compile(), "array-style JSON Pointer segment `0`");

        fixture.write(
            ".codex/koni/run-types/fast.yaml",
            &DERIVED.replace("/pipeline/order\n", "/pipeline/order/-\n"),
        );
        assert_error_contains(fixture.compile(), "array-style JSON Pointer segment `-`");

        fixture.write(
            ".codex/koni/run-types/fast.yaml",
            &DERIVED.replace(
                "path: /intake/fields/dataset\n",
                "path: /intake/fields/dataset\n    value: null\n",
            ),
        );
        assert_error_contains(fixture.compile(), "remove must not include a value");

        fixture.write(
            ".codex/koni/run-types/fast.yaml",
            &DERIVED.replace("path: /pipeline/order", "path: /pipeline/not_present"),
        );
        assert_error_contains(fixture.compile(), "replace target does not exist");
    }

    #[test]
    fn rejects_implicit_inheritance_forms() {
        let fixture = Fixture::canonical();
        fixture.write(
            ".codex/koni/run-types/fast.yaml",
            r#"
schema_version: "1.0"
id: fast
title: Fast
extends: base
questions:
  policy: autonomous
  default_scope: ticket
"#,
        );
        assert_error_contains(fixture.compile(), "inline fields: questions");

        fixture.write(
            ".codex/koni/run-types/base.yaml",
            &BASE.replace(
                "run_card:\n  sections: [goal, plan]",
                "run_card:\n  sections: [goal, plan]\noverrides:\n  - op: replace\n    path: /questions/policy\n    value: autonomous",
            ),
        );
        fixture.write(".codex/koni/run-types/fast.yaml", DERIVED);
        assert_error_contains(
            fixture.compile(),
            "base run type `base` may not declare overrides",
        );
    }

    #[test]
    fn rejects_invalid_definition_order() {
        let fixture = Fixture::canonical();
        fixture.write(
            ".codex/koni/run-types/base.yaml",
            &BASE.replace("order: [goal, dataset]", "order: [goal, goal]"),
        );
        assert_error_contains(
            fixture.compile(),
            "intake order contains duplicate id `goal`",
        );

        fixture.write(
            ".codex/koni/run-types/base.yaml",
            &BASE.replace("order: [plan]", "order: [absent]"),
        );
        assert_error_contains(
            fixture.compile(),
            "pipeline order must name every definition",
        );
    }

    #[test]
    fn adapts_legacy_koni_toml_and_exposes_migration() {
        let fixture = Fixture {
            temp: TempDir::new().unwrap(),
        };
        fixture.write(
            "koni.toml",
            r#"
[profile]
id = "research"
version = "1.0.0"
description = "Research workflow"

[git]
integration_branch = "main"
ticket_branch_template = "koni/ticket/{{ ticket.id }}"
"#,
        );

        let compiled = fixture.compile().unwrap();
        assert_eq!(compiled.document.project.id, "research");
        assert_eq!(compiled.document.default_run_type, LEGACY_RUN_TYPE_ID);
        let run_type = compiled.default_run_type();
        assert_eq!(run_type.profile.format, ProfileSourceFormat::LegacyKoniToml);
        assert_eq!(run_type.profile.source, PathBuf::from("koni.toml"));
        assert_eq!(
            run_type.git.branch_template,
            "koni/runs/{{ run.slug }}-{{ run.short_id }}"
        );
        assert_eq!(
            run_type.git.ticket_branch_template,
            "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}"
        );
        assert_eq!(run_type.intake.order, ["goal"]);

        let ProjectCatalogSource::LegacyKoniToml { migration, .. } = &compiled.source else {
            panic!("expected legacy source");
        };
        assert!(migration.profile_conversion_required);
        assert_eq!(
            migration.canonical_project_path,
            PathBuf::from(".codex/koni/project.yaml")
        );
        assert_eq!(
            migration.run_type.profile.as_ref().unwrap().source,
            PathBuf::from(".codex/koni/profile.yaml")
        );
    }

    #[test]
    fn canonical_catalog_wins_over_legacy_manifest() {
        let fixture = Fixture::canonical();
        fixture.write("koni.toml", "[profile]\nid = 'legacy'\nversion = '1.0.0'\n");
        let compiled = fixture.compile().unwrap();
        assert_eq!(compiled.document.project.id, "demo");
        assert!(matches!(
            compiled.source,
            ProjectCatalogSource::Canonical { .. }
        ));
    }
}
