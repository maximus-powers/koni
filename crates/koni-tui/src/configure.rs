use std::collections::{BTreeMap, BTreeSet};
use std::path::Component;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::model::{ConfigDocument, FormPathToken};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ConfigDomain {
    Project,
    RunTypes,
    Agents,
    Skills,
    WorkflowsTickets,
    GraphRules,
    ActionsChecks,
    ReportsViews,
    Advanced,
}

impl ConfigDomain {
    pub const ALL: [Self; 9] = [
        Self::Project,
        Self::RunTypes,
        Self::Agents,
        Self::Skills,
        Self::WorkflowsTickets,
        Self::GraphRules,
        Self::ActionsChecks,
        Self::ReportsViews,
        Self::Advanced,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Project => "Project",
            Self::RunTypes => "Run Types",
            Self::Agents => "Agents",
            Self::Skills => "Skills",
            Self::WorkflowsTickets => "Workflows & Tickets",
            Self::GraphRules => "Graph Model & Rules",
            Self::ActionsChecks => "Actions & Checks",
            Self::ReportsViews => "Reports & Views",
            Self::Advanced => "Advanced",
        }
    }

    pub const fn index(self) -> usize {
        match self {
            Self::Project => 0,
            Self::RunTypes => 1,
            Self::Agents => 2,
            Self::Skills => 3,
            Self::WorkflowsTickets => 4,
            Self::GraphRules => 5,
            Self::ActionsChecks => 6,
            Self::ReportsViews => 7,
            Self::Advanced => 8,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigResourceKind {
    Project,
    Profile,
    Initialization,
    Storage,
    Git,
    Orchestration,
    RunTypeCatalog,
    RunType,
    CodexProjectSettings,
    NativeAgent,
    Skill,
    AgentPolicy,
    Persona,
    MarkdownPrompt,
    Pipeline,
    Workflow,
    TicketOperation,
    Lifecycle,
    NodeType,
    EdgeType,
    GatePolicy,
    Query,
    Rule,
    Action,
    Check,
    RunCard,
    Report,
    View,
    RawSource,
}

impl ConfigResourceKind {
    pub const ALL: [Self; 29] = [
        Self::Project,
        Self::Profile,
        Self::Initialization,
        Self::Storage,
        Self::Git,
        Self::Orchestration,
        Self::RunTypeCatalog,
        Self::RunType,
        Self::CodexProjectSettings,
        Self::NativeAgent,
        Self::Skill,
        Self::AgentPolicy,
        Self::Persona,
        Self::MarkdownPrompt,
        Self::Pipeline,
        Self::Workflow,
        Self::TicketOperation,
        Self::Lifecycle,
        Self::NodeType,
        Self::EdgeType,
        Self::GatePolicy,
        Self::Query,
        Self::Rule,
        Self::Action,
        Self::Check,
        Self::RunCard,
        Self::Report,
        Self::View,
        Self::RawSource,
    ];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Project => "Project settings",
            Self::Profile => "Profile",
            Self::Initialization => "Initialization",
            Self::Storage => "Storage",
            Self::Git => "Git and worktrees",
            Self::Orchestration => "Global orchestration",
            Self::RunTypeCatalog => "Project default",
            Self::RunType => "Run type",
            Self::CodexProjectSettings => "Codex project settings",
            Self::NativeAgent => "Codex agent",
            Self::Skill => "Project skill",
            Self::AgentPolicy => "Agent policy",
            Self::Persona => "Persona",
            Self::MarkdownPrompt => "Prompt",
            Self::Pipeline => "Pipeline",
            Self::Workflow => "Workflow",
            Self::TicketOperation => "Ticket type",
            Self::Lifecycle => "Lifecycle",
            Self::NodeType => "Node type",
            Self::EdgeType => "Edge rule",
            Self::GatePolicy => "Gate policy",
            Self::Query => "Graph query",
            Self::Rule => "Compiler rule",
            Self::Action => "Action",
            Self::Check => "Check",
            Self::RunCard => "Run report card",
            Self::Report => "Report",
            Self::View => "Control-center view",
            Self::RawSource => "Raw source",
        }
    }

    pub const fn is_raw_source(self) -> bool {
        matches!(self, Self::RawSource | Self::MarkdownPrompt | Self::Skill)
    }

    pub const fn is_markdown_prompt(self) -> bool {
        matches!(self, Self::MarkdownPrompt)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigResource {
    pub key: String,
    pub title: String,
    pub subtitle: String,
    pub domain: ConfigDomain,
    pub document_path: PathBuf,
    pub kind: ConfigResourceKind,
    pub(crate) locator: Vec<FormPathToken>,
    pub(crate) linked_locators: Vec<ConfigResourceLocator>,
    /// Whole text documents presented as fields of this semantic resource.
    ///
    /// The document remains independently editable in Advanced. This is only
    /// a projection link; it never copies its contents into YAML or TOML.
    pub(crate) linked_documents: Vec<ConfigLinkedDocument>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfigResourceLocator {
    pub(crate) document_path: PathBuf,
    pub(crate) locator: Vec<FormPathToken>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfigLinkedDocument {
    pub(crate) document_path: PathBuf,
    /// A semantic form path used only for friendly field labels.
    pub(crate) semantic_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PersonaPromptMetadata {
    document_path: PathBuf,
    title: String,
}

impl ConfigResource {
    pub const fn is_raw_source(&self) -> bool {
        self.kind.is_raw_source()
    }

    pub const fn is_markdown_prompt(&self) -> bool {
        self.kind.is_markdown_prompt()
    }
}

pub(crate) fn derive_resources(documents: &[ConfigDocument]) -> Vec<ConfigResource> {
    let parsed = documents
        .iter()
        .filter_map(|document| {
            parse_document(document).map(|value| (document.relative_path.clone(), value))
        })
        .collect::<BTreeMap<_, _>>();
    let project_path = canonical_project_path(&parsed);
    let catalog_paths = catalog_run_type_paths(&parsed, project_path.as_deref());
    let profile_path = shared_profile_path(&parsed, &catalog_paths);
    let active_module_paths = profile_path
        .as_ref()
        .map(|path| {
            parsed
                .get(path)
                .filter(|value| is_profile_document(value))
                .map_or_else(BTreeSet::new, |value| profile_import_paths(path, value))
        })
        .or_else(|| (!catalog_paths.is_empty()).then(BTreeSet::new));
    let prompt_metadata = persona_prompt_metadata(
        &parsed,
        profile_path.as_deref(),
        active_module_paths.as_ref(),
    );
    let native_agent_ids = native_agent_ids(&parsed);
    let mut resources = Vec::new();

    for document in documents {
        let path = &document.relative_path;
        let is_markdown = extension(path) == Some("md");
        let linked_source = project_path.is_none()
            || project_path.as_ref() == Some(path)
            || profile_path.as_ref() == Some(path)
            || catalog_paths.contains_key(path)
            || active_module_paths
                .as_ref()
                .is_some_and(|paths| paths.contains(path))
            || prompt_metadata
                .values()
                .any(|prompt| prompt.document_path == *path);
        resources.push(resource(
            ConfigDomain::Advanced,
            ConfigResourceKind::RawSource,
            path.display().to_string(),
            if document.diagnostics.is_empty() {
                if linked_source {
                    "Raw configuration source".to_owned()
                } else {
                    "Raw source · not linked to the active profile".to_owned()
                }
            } else {
                "Raw source · needs repair".to_owned()
            },
            path,
            Vec::new(),
        ));
        if is_markdown && is_project_skill_path(path) {
            let (title, description) = skill_metadata(&document.text);
            resources.push(resource(
                ConfigDomain::Skills,
                ConfigResourceKind::Skill,
                title,
                description,
                path,
                Vec::new(),
            ));
            continue;
        }

        let Some(value) = parsed.get(path) else {
            continue;
        };
        let Some(root) = value.as_object() else {
            continue;
        };

        if is_codex_project_config(path) {
            resources.push(resource(
                ConfigDomain::Project,
                ConfigResourceKind::CodexProjectSettings,
                "Codex project settings".to_owned(),
                "Models, tools, approvals, and project behavior".to_owned(),
                path,
                Vec::new(),
            ));
            continue;
        }
        if is_native_agent_path(path) {
            let title = root
                .get("name")
                .and_then(Value::as_str)
                .map(humanize)
                .or_else(|| {
                    path.file_stem()
                        .and_then(|stem| stem.to_str())
                        .map(humanize)
                })
                .unwrap_or_else(|| "Agent".to_owned());
            let subtitle = root
                .get("description")
                .and_then(Value::as_str)
                .filter(|description| !description.trim().is_empty())
                .unwrap_or("Instructions, model, reasoning, permissions, and skills")
                .to_owned();
            let mut agent = resource(
                ConfigDomain::Agents,
                ConfigResourceKind::NativeAgent,
                title,
                subtitle,
                path,
                Vec::new(),
            );
            agent.linked_locators = persona_assignment_locators(
                &parsed,
                active_module_paths.as_ref(),
                &native_agent_aliases(path, root),
            );
            agent.linked_documents = agent
                .linked_locators
                .iter()
                .filter_map(|linked| {
                    persona_index(&linked.locator).and_then(|index| {
                        prompt_metadata.get(&(linked.document_path.clone(), index))
                    })
                })
                .map(|prompt| ConfigLinkedDocument {
                    document_path: prompt.document_path.clone(),
                    semantic_path: format!("$.{}.instructions", prompt.title),
                })
                .collect();
            resources.push(agent);
            continue;
        }

        let is_project = project_path.as_ref() == Some(path);
        if is_project {
            push_mapping_resource(
                &mut resources,
                value,
                path,
                ConfigDomain::Project,
                ConfigResourceKind::Project,
                "project",
                "Project identity",
            );
            push_value_resource(
                &mut resources,
                value,
                path,
                ConfigDomain::RunTypes,
                ConfigResourceKind::RunTypeCatalog,
                "default_run_type",
                "Default run type",
            );
        }

        let is_profile = profile_path.as_ref() == Some(path) && is_profile_document(value);
        if is_profile {
            push_mapping_resource(
                &mut resources,
                value,
                path,
                ConfigDomain::Project,
                ConfigResourceKind::Profile,
                "profile",
                "Profile identity",
            );
            push_mapping_resource(
                &mut resources,
                value,
                path,
                ConfigDomain::Project,
                ConfigResourceKind::Initialization,
                "initialization",
                "Graph initialization",
            );
            push_mapping_resource(
                &mut resources,
                value,
                path,
                ConfigDomain::Project,
                ConfigResourceKind::Storage,
                "storage",
                "Storage",
            );
            push_mapping_resource(
                &mut resources,
                value,
                path,
                ConfigDomain::Project,
                ConfigResourceKind::Git,
                "git",
                "Git & worktrees",
            );
            push_mapping_resource(
                &mut resources,
                value,
                path,
                ConfigDomain::Project,
                ConfigResourceKind::Orchestration,
                "orchestration",
                "Global orchestration",
            );
        }

        let is_run_type = catalog_paths.contains_key(path)
            || (project_path.is_none()
                && root.contains_key("pipeline")
                && root
                    .get("profile")
                    .and_then(Value::as_object)
                    .is_some_and(|profile| profile.contains_key("source")));
        if is_run_type {
            let title = root
                .get("title")
                .and_then(Value::as_str)
                .or_else(|| root.get("id").and_then(Value::as_str))
                .map(humanize)
                .unwrap_or_else(|| "Run type".to_owned());
            resources.push(resource(
                ConfigDomain::RunTypes,
                ConfigResourceKind::RunType,
                title.clone(),
                "Run behavior and intake".to_owned(),
                path,
                Vec::new(),
            ));
            push_agent_policy_resources(&mut resources, value, path, &title);
            push_mapping_resource(
                &mut resources,
                value,
                path,
                ConfigDomain::WorkflowsTickets,
                ConfigResourceKind::Pipeline,
                "pipeline",
                &format!("{title} pipeline"),
            );
            push_mapping_resource(
                &mut resources,
                value,
                path,
                ConfigDomain::ReportsViews,
                ConfigResourceKind::RunCard,
                "run_card",
                &format!("{title} report card"),
            );
        }

        let is_active_module = active_module_paths
            .as_ref()
            .is_none_or(|paths| paths.contains(path));
        if is_active_module {
            push_persona_resources(
                &mut resources,
                value,
                path,
                &native_agent_ids,
                &prompt_metadata,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "workflows",
                ConfigDomain::WorkflowsTickets,
                ConfigResourceKind::Workflow,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "operations",
                ConfigDomain::WorkflowsTickets,
                ConfigResourceKind::TicketOperation,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "state_machines",
                ConfigDomain::WorkflowsTickets,
                ConfigResourceKind::Lifecycle,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "node_types",
                ConfigDomain::GraphRules,
                ConfigResourceKind::NodeType,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "edge_types",
                ConfigDomain::GraphRules,
                ConfigResourceKind::EdgeType,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "gate_policies",
                ConfigDomain::GraphRules,
                ConfigResourceKind::GatePolicy,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "queries",
                ConfigDomain::GraphRules,
                ConfigResourceKind::Query,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "rules",
                ConfigDomain::GraphRules,
                ConfigResourceKind::Rule,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "actions",
                ConfigDomain::ActionsChecks,
                ConfigResourceKind::Action,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "checks",
                ConfigDomain::ActionsChecks,
                ConfigResourceKind::Check,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "reports",
                ConfigDomain::ReportsViews,
                ConfigResourceKind::Report,
            );
            push_array_resources(
                &mut resources,
                value,
                path,
                "views",
                ConfigDomain::ReportsViews,
                ConfigResourceKind::View,
            );
        }
    }

    resources.sort_by(|left, right| {
        left.domain
            .cmp(&right.domain)
            .then_with(|| {
                config_resource_rank(left, &catalog_paths)
                    .cmp(&config_resource_rank(right, &catalog_paths))
            })
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
            .then_with(|| left.document_path.cmp(&right.document_path))
            .then_with(|| left.key.cmp(&right.key))
    });
    resources
}

fn parse_document(document: &ConfigDocument) -> Option<Value> {
    match extension(&document.relative_path) {
        Some("yaml" | "yml") => serde_yaml::from_str(&document.text).ok(),
        Some("toml") => toml::from_str::<toml::Value>(&document.text)
            .ok()
            .and_then(|value| serde_json::to_value(value).ok()),
        _ => None,
    }
}

fn is_codex_project_config(path: &Path) -> bool {
    path == Path::new(".codex/config.toml")
}

fn is_native_agent_path(path: &Path) -> bool {
    path.starts_with(Path::new(".codex/agents")) && extension(path) == Some("toml")
}

fn is_project_skill_path(path: &Path) -> bool {
    path.starts_with(Path::new(".agents/skills"))
        && path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md")
}

fn skill_metadata(text: &str) -> (String, String) {
    let frontmatter = text
        .strip_prefix("---")
        .and_then(|text| text.split_once("\n---"))
        .and_then(|(frontmatter, _)| serde_yaml::from_str::<Value>(frontmatter).ok());
    let title = frontmatter
        .as_ref()
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .map(humanize)
        .unwrap_or_else(|| "Project skill".to_owned());
    let description = frontmatter
        .as_ref()
        .and_then(|value| value.get("description"))
        .and_then(Value::as_str)
        .filter(|description| !description.trim().is_empty())
        .unwrap_or("Reusable project workflow and instructions")
        .to_owned();
    (title, description)
}

fn canonical_project_path(parsed: &BTreeMap<PathBuf, Value>) -> Option<PathBuf> {
    let path = Path::new("project.yaml");
    parsed
        .get(path)
        .and_then(Value::as_object)
        .filter(|root| root.contains_key("project") && root.contains_key("run_types"))
        .map(|_| path.to_path_buf())
}

fn catalog_run_type_paths(
    parsed: &BTreeMap<PathBuf, Value>,
    project_path: Option<&Path>,
) -> BTreeMap<PathBuf, usize> {
    project_path
        .and_then(|path| parsed.get(path))
        .and_then(Value::as_object)
        .and_then(|root| root.get("run_types"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, entry)| {
            entry
                .get("path")
                .and_then(Value::as_str)
                .map(|path| (PathBuf::from(path), index))
        })
        .collect()
}

fn shared_profile_path(
    parsed: &BTreeMap<PathBuf, Value>,
    catalog_paths: &BTreeMap<PathBuf, usize>,
) -> Option<PathBuf> {
    let mut run_types = catalog_paths.iter().collect::<Vec<_>>();
    run_types.sort_by_key(|(_, index)| **index);
    let configured_source = run_types.into_iter().find_map(|(path, _)| {
        parsed
            .get(path)
            .and_then(|value| value.get("profile"))
            .and_then(Value::as_object)
            .and_then(|profile| profile.get("source"))
            .and_then(Value::as_str)
    });
    if let Some(source) = configured_source {
        return config_relative_profile_path(source);
    }
    parsed
        .get(Path::new("profile.yaml"))
        .filter(|value| is_profile_document(value))
        .map(|_| PathBuf::from("profile.yaml"))
}

fn config_relative_profile_path(source: &str) -> Option<PathBuf> {
    let normalized = normalize_relative_path(Path::new(source))?;
    normalized
        .strip_prefix(Path::new(".codex/koni"))
        .ok()
        .and_then(normalize_relative_path)
}

fn is_profile_document(value: &Value) -> bool {
    value
        .get("profile")
        .and_then(Value::as_object)
        .is_some_and(|profile| profile.contains_key("id") && profile.contains_key("version"))
}

fn profile_import_paths(profile_path: &Path, profile: &Value) -> BTreeSet<PathBuf> {
    let base = profile_path.parent().unwrap_or_else(|| Path::new(""));
    profile
        .get("imports")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|imports| imports.values())
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|path| normalize_relative_path(&base.join(path)))
        .collect()
}

fn normalize_relative_path(path: &Path) -> Option<PathBuf> {
    if path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!normalized.as_os_str().is_empty()).then_some(normalized)
}

fn native_agent_aliases(path: &Path, root: &serde_json::Map<String, Value>) -> BTreeSet<String> {
    root.get("name")
        .and_then(Value::as_str)
        .into_iter()
        .chain(path.file_stem().and_then(|stem| stem.to_str()))
        .map(str::to_lowercase)
        .collect()
}

fn native_agent_ids(parsed: &BTreeMap<PathBuf, Value>) -> BTreeSet<String> {
    parsed
        .iter()
        .filter(|(path, _)| is_native_agent_path(path))
        .filter_map(|(path, value)| {
            value
                .as_object()
                .map(|root| native_agent_aliases(path, root))
        })
        .flatten()
        .collect()
}

fn persona_assignment_locators(
    parsed: &BTreeMap<PathBuf, Value>,
    active_module_paths: Option<&BTreeSet<PathBuf>>,
    agent_aliases: &BTreeSet<String>,
) -> Vec<ConfigResourceLocator> {
    let mut locators = Vec::new();
    for (document_path, value) in parsed {
        if active_module_paths.is_some_and(|paths| !paths.contains(document_path)) {
            continue;
        }
        let Some(personas) = value.get("personas").and_then(Value::as_array) else {
            continue;
        };
        for (index, persona) in personas.iter().enumerate() {
            let matches = persona
                .get("codex_agent")
                .and_then(Value::as_str)
                .map(str::to_lowercase)
                .is_some_and(|agent| agent_aliases.contains(&agent));
            if matches {
                locators.push(ConfigResourceLocator {
                    document_path: document_path.clone(),
                    locator: vec![
                        FormPathToken::Key("personas".to_owned()),
                        FormPathToken::Index(index),
                    ],
                });
            }
        }
    }
    locators
}

fn persona_index(locator: &[FormPathToken]) -> Option<usize> {
    match locator {
        [FormPathToken::Key(key), FormPathToken::Index(index)] if key == "personas" => Some(*index),
        _ => None,
    }
}

fn config_resource_rank(
    resource: &ConfigResource,
    catalog_paths: &BTreeMap<PathBuf, usize>,
) -> usize {
    match resource.domain {
        ConfigDomain::Project => match resource.kind {
            ConfigResourceKind::Project => 0,
            ConfigResourceKind::Profile => 1,
            ConfigResourceKind::CodexProjectSettings => 2,
            ConfigResourceKind::Initialization => 3,
            ConfigResourceKind::Storage => 4,
            ConfigResourceKind::Git => 5,
            ConfigResourceKind::Orchestration => 6,
            _ => usize::MAX,
        },
        ConfigDomain::RunTypes => match resource.kind {
            ConfigResourceKind::RunTypeCatalog => 0,
            ConfigResourceKind::RunType => catalog_paths
                .get(&resource.document_path)
                .copied()
                .unwrap_or(usize::MAX - 1)
                .saturating_add(1),
            _ => usize::MAX,
        },
        ConfigDomain::Agents => {
            let lane = agent_resource_lane_rank(resource);
            let kind = match resource.kind {
                ConfigResourceKind::NativeAgent => 0,
                ConfigResourceKind::Persona => 1,
                ConfigResourceKind::AgentPolicy => 2,
                _ => 3,
            };
            let run_type = if resource.kind == ConfigResourceKind::AgentPolicy {
                catalog_paths
                    .get(&resource.document_path)
                    .copied()
                    .unwrap_or(90)
            } else {
                0
            };
            kind * 10_000 + lane * 100 + run_type
        }
        ConfigDomain::Skills => 0,
        ConfigDomain::WorkflowsTickets => match resource.kind {
            ConfigResourceKind::Pipeline => 0,
            ConfigResourceKind::TicketOperation => 1,
            ConfigResourceKind::Workflow => 2,
            ConfigResourceKind::Lifecycle => 3,
            _ => usize::MAX,
        },
        ConfigDomain::GraphRules => match resource.kind {
            ConfigResourceKind::NodeType => 0,
            ConfigResourceKind::EdgeType => 1,
            ConfigResourceKind::GatePolicy => 2,
            ConfigResourceKind::Query => 3,
            ConfigResourceKind::Rule => 4,
            _ => usize::MAX,
        },
        ConfigDomain::ActionsChecks => match resource.kind {
            ConfigResourceKind::Action => 0,
            ConfigResourceKind::Check => 1,
            _ => usize::MAX,
        },
        ConfigDomain::ReportsViews => match resource.kind {
            ConfigResourceKind::RunCard => 0,
            ConfigResourceKind::Report => 1,
            ConfigResourceKind::View => 2,
            _ => usize::MAX,
        },
        ConfigDomain::Advanced => 0,
    }
}

fn agent_resource_lane_rank(resource: &ConfigResource) -> usize {
    let value = format!("{} {}", resource.title, resource.subtitle).to_lowercase();
    if value.contains("planner") || value.contains("planning") {
        0
    } else if value.contains("lead") {
        1
    } else if value.contains("workers") || value.contains("worker") {
        2
    } else if value.contains("review") {
        3
    } else {
        4
    }
}

fn persona_prompt_metadata(
    parsed: &BTreeMap<PathBuf, Value>,
    profile_path: Option<&Path>,
    active_module_paths: Option<&BTreeSet<PathBuf>>,
) -> BTreeMap<(PathBuf, usize), PersonaPromptMetadata> {
    let mut prompts = BTreeMap::new();
    let profile_root = profile_path
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new(""));
    for (document_path, value) in parsed {
        if active_module_paths.is_some_and(|paths| !paths.contains(document_path)) {
            continue;
        }
        let Some(personas) = value.get("personas").and_then(Value::as_array) else {
            continue;
        };
        for (index, persona) in personas.iter().enumerate() {
            let Some(path) = persona.get("prompt").and_then(Value::as_str) else {
                continue;
            };
            let Some(path) = normalize_relative_path(&profile_root.join(path)) else {
                continue;
            };
            if extension(&path) != Some("md") {
                continue;
            }
            let title = persona
                .get("id")
                .and_then(Value::as_str)
                .map(humanize)
                .unwrap_or_else(|| "Persona".to_owned());
            prompts.insert(
                (document_path.clone(), index),
                PersonaPromptMetadata {
                    document_path: path,
                    title,
                },
            );
        }
    }
    prompts
}

fn push_agent_policy_resources(
    resources: &mut Vec<ConfigResource>,
    root: &Value,
    path: &Path,
    run_type_title: &str,
) {
    let Some(agents) = root.get("agents").and_then(Value::as_object) else {
        return;
    };
    for (group, suffix) in [("roles", "role policy"), ("personas", "persona override")] {
        let Some(settings) = agents.get(group).and_then(Value::as_object) else {
            continue;
        };
        for id in settings.keys() {
            let (title, subtitle) = if group == "roles" {
                (
                    format!("{run_type_title} model"),
                    format!("{} {suffix}", agent_role_label(id)),
                )
            } else {
                (
                    format!("{run_type_title} · {} override", humanize(id)),
                    suffix.to_owned(),
                )
            };
            resources.push(resource(
                ConfigDomain::Agents,
                ConfigResourceKind::AgentPolicy,
                title,
                subtitle,
                path,
                vec![
                    FormPathToken::Key("agents".to_owned()),
                    FormPathToken::Key(group.to_owned()),
                    FormPathToken::Key(id.clone()),
                ],
            ));
        }
    }
}

fn push_persona_resources(
    resources: &mut Vec<ConfigResource>,
    root: &Value,
    path: &Path,
    native_agent_ids: &BTreeSet<String>,
    prompt_metadata: &BTreeMap<(PathBuf, usize), PersonaPromptMetadata>,
) {
    let Some(personas) = root.get("personas").and_then(Value::as_array) else {
        return;
    };
    for (index, persona) in personas.iter().enumerate() {
        let codex_agent = persona
            .get("codex_agent")
            .and_then(Value::as_str)
            .filter(|agent| !agent.trim().is_empty());
        if codex_agent.is_some_and(|agent| native_agent_ids.contains(&agent.to_lowercase())) {
            continue;
        }
        let id = persona
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("persona");
        let role = persona
            .get("model_role")
            .and_then(Value::as_str)
            .filter(|role| !role.trim().is_empty())
            .map(agent_role_label)
            .unwrap_or_else(|| "Custom role".to_owned());
        let title = if codex_agent.is_some() {
            format!("{} execution policy", humanize(id))
        } else {
            humanize(id)
        };
        let subtitle = if codex_agent.is_some() {
            format!("{role} · Native agent unavailable; role and sandbox remain editable")
        } else {
            format!("{role} · Instructions, model, reasoning, permissions, and skills")
        };
        let mut persona_resource = resource(
            ConfigDomain::Agents,
            ConfigResourceKind::Persona,
            title,
            subtitle,
            path,
            vec![
                FormPathToken::Key("personas".to_owned()),
                FormPathToken::Index(index),
            ],
        );
        if let Some(prompt) = prompt_metadata.get(&(path.to_path_buf(), index)) {
            persona_resource
                .linked_documents
                .push(ConfigLinkedDocument {
                    document_path: prompt.document_path.clone(),
                    semantic_path: "$.instructions".to_owned(),
                });
        }
        resources.push(persona_resource);
    }
}

fn agent_role_label(role: &str) -> String {
    match role {
        "planner" => "Planner".to_owned(),
        "lead" => "Lead".to_owned(),
        "ticket_worker" | "worker" => "Workers".to_owned(),
        "reviewer" => "Reviewer".to_owned(),
        other => humanize(other),
    }
}

fn push_mapping_resource(
    resources: &mut Vec<ConfigResource>,
    root: &Value,
    path: &Path,
    domain: ConfigDomain,
    kind: ConfigResourceKind,
    key: &str,
    title: &str,
) {
    if root.get(key).is_some_and(Value::is_object) {
        resources.push(resource(
            domain,
            kind,
            title.to_owned(),
            kind.label().to_owned(),
            path,
            vec![FormPathToken::Key(key.to_owned())],
        ));
    }
}

fn push_value_resource(
    resources: &mut Vec<ConfigResource>,
    root: &Value,
    path: &Path,
    domain: ConfigDomain,
    kind: ConfigResourceKind,
    key: &str,
    title: &str,
) {
    if root.get(key).is_some() {
        resources.push(resource(
            domain,
            kind,
            title.to_owned(),
            kind.label().to_owned(),
            path,
            vec![FormPathToken::Key(key.to_owned())],
        ));
    }
}

fn push_array_resources(
    resources: &mut Vec<ConfigResource>,
    root: &Value,
    path: &Path,
    key: &str,
    domain: ConfigDomain,
    kind: ConfigResourceKind,
) {
    let Some(items) = root.get(key).and_then(Value::as_array) else {
        return;
    };
    for (index, item) in items.iter().enumerate() {
        let title = resource_title(item, kind, index);
        let subtitle = item
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|description| !description.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| kind.label().to_owned());
        resources.push(resource(
            domain,
            kind,
            title,
            subtitle,
            path,
            vec![
                FormPathToken::Key(key.to_owned()),
                FormPathToken::Index(index),
            ],
        ));
    }
}

fn resource_title(item: &Value, kind: ConfigResourceKind, index: usize) -> String {
    if kind == ConfigResourceKind::EdgeType {
        let source = item.get("source").and_then(Value::as_str).unwrap_or("Node");
        let relation = item
            .get("relation")
            .and_then(Value::as_str)
            .unwrap_or("relationship");
        return format!("{} → {}", humanize(source), humanize(relation));
    }
    let title = item.get("title").or_else(|| {
        if kind == ConfigResourceKind::TicketOperation {
            item.get("operation").or_else(|| item.get("id"))
        } else {
            item.get("id").or_else(|| item.get("operation"))
        }
    });
    title
        .and_then(Value::as_str)
        .map(humanize)
        .unwrap_or_else(|| format!("{} {}", kind.label(), index + 1))
}

fn resource(
    domain: ConfigDomain,
    kind: ConfigResourceKind,
    title: String,
    subtitle: String,
    document_path: &Path,
    locator: Vec<FormPathToken>,
) -> ConfigResource {
    let pointer = locator
        .iter()
        .map(FormPathToken::stable_key)
        .collect::<Vec<_>>()
        .join("/");
    ConfigResource {
        key: format!("{}:{}:{pointer}", domain.index(), document_path.display()),
        title,
        subtitle,
        domain,
        document_path: document_path.to_path_buf(),
        kind,
        locator,
        linked_locators: Vec::new(),
        linked_documents: Vec::new(),
    }
}

fn extension(path: &Path) -> Option<&str> {
    path.extension().and_then(|value| value.to_str())
}

fn humanize(value: &str) -> String {
    let normalized = value.replace(['_', '-'], " ");
    let mut characters = normalized.chars();
    let Some(first) = characters.next() else {
        return "Untitled".to_owned();
    };
    first.to_uppercase().chain(characters).collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    fn document(path: &str, text: &str) -> ConfigDocument {
        ConfigDocument {
            relative_path: path.into(),
            source_path: path.into(),
            draft_path: PathBuf::from("drafts").join(path),
            original: text.to_owned(),
            text: text.to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        }
    }

    #[test]
    fn semantic_projection_spans_all_domains_and_keeps_invalid_sources_advanced() {
        let mut invalid = document("broken.yaml", "node_types: [unterminated");
        assert!(!invalid.validate());
        let documents = vec![
            document(
                "project.yaml",
                r#"
project: {id: demo, title: Demo}
default_run_type: medium
run_types:
  - {id: medium, path: run-types/medium.yaml}
"#,
            ),
            document(
                "profile.yaml",
                r#"
profile: {id: demo, version: 1.0.0}
initialization: {root_node_type: task}
storage: {backend: tracked, graph_dir: program/graph}
git: {enabled: true, integration_strategy: squash}
orchestration: {running: true, max_parallel: 3}
imports: {graph: [modules/mixed.yaml], personas: [personas.yaml]}
"#,
            ),
            document(
                "run-types/medium.yaml",
                r#"
id: medium
title: Medium
profile: {source: .codex/koni/profile.yaml}
pipeline: {stages: {}, order: []}
agents:
  roles:
    planner: {model: planner-model, reasoning_effort: xhigh}
    lead: {model: lead-model, reasoning_effort: high}
    ticket_worker: {model: worker-model, reasoning_effort: high}
    reviewer: {model: review-model, reasoning_effort: xhigh}
run_card: {sections: [goal, report]}
"#,
            ),
            document(
                "personas.yaml",
                r#"
personas:
  - id: lead
    prompt: personas/prompts/lead.md
    model_role: lead
"#,
            ),
            document("personas/prompts/lead.md", "# Lead\n"),
            document(
                ".agents/skills/demo/SKILL.md",
                "---\nname: demo-skill\ndescription: A reusable demo workflow.\n---\n# Demo\n",
            ),
            document(
                "modules/mixed.yaml",
                r#"
node_types: [{id: task}]
edge_types: [{source: task, relation: children, targets: [task]}]
gate_policies: [{id: task-readiness, description: "Choose a compatible provider and bind inherited readiness context."}]
queries: [{id: open_tasks}]
rules: [{id: emit_task}]
workflows: [{id: build, steps: []}]
operations: [{id: build-task, stage: work}]
state_machines: [{id: ticket, initial: todo, states: [todo]}]
actions: [{id: compile}]
checks: [{id: test, kind: command, receipt_type: test}]
reports: [{id: result, title: Result, output: result.md}]
views: [{id: board, title: Board}]
"#,
            ),
            invalid,
        ];

        let resources = derive_resources(&documents);

        for domain in ConfigDomain::ALL {
            assert!(
                resources.iter().any(|resource| resource.domain == domain),
                "missing {}",
                domain.label()
            );
        }
        for kind in [
            ConfigResourceKind::Storage,
            ConfigResourceKind::Git,
            ConfigResourceKind::Orchestration,
        ] {
            assert!(resources.iter().any(|resource| {
                resource.domain == ConfigDomain::Project && resource.kind == kind
            }));
        }
        let mixed_domains = resources
            .iter()
            .filter(|resource| resource.document_path == Path::new("modules/mixed.yaml"))
            .map(|resource| resource.domain)
            .collect::<BTreeSet<_>>();
        assert!(mixed_domains.contains(&ConfigDomain::GraphRules));
        assert!(mixed_domains.contains(&ConfigDomain::WorkflowsTickets));
        assert!(mixed_domains.contains(&ConfigDomain::ActionsChecks));
        assert!(mixed_domains.contains(&ConfigDomain::ReportsViews));
        assert!(resources.iter().any(|resource| {
            resource.kind == ConfigResourceKind::GatePolicy
                && resource.title == "Task readiness"
                && resource.subtitle
                    == "Choose a compatible provider and bind inherited readiness context."
        }));
        let broken = resources
            .iter()
            .filter(|resource| resource.document_path == Path::new("broken.yaml"))
            .collect::<Vec<_>>();
        assert_eq!(broken.len(), 1);
        assert_eq!(broken[0].domain, ConfigDomain::Advanced);
        assert!(broken[0].is_raw_source());
        assert!(resources.iter().any(|resource| {
            resource.kind == ConfigResourceKind::Skill
                && resource.domain == ConfigDomain::Skills
                && resource.title == "Demo skill"
        }));
        assert!(resources.iter().any(|resource| {
            resource.kind == ConfigResourceKind::RawSource
                && resource.document_path == Path::new("personas/prompts/lead.md")
        }));
    }

    #[test]
    fn agents_project_friendly_role_policies_personas_and_prompts() {
        let documents = vec![
            document(
                "run-types/custom.yaml",
                r#"
id: custom
title: Custom
profile: {source: .codex/koni/profile.yaml}
pipeline: {stages: {}, order: []}
agents:
  roles:
    planner: {model: p}
    lead: {model: l}
    ticket_worker: {model: w}
    reviewer: {model: r}
    specialist: {model: s}
"#,
            ),
            document(
                "personas.yaml",
                r#"
personas:
  - {id: lead, prompt: prompts/lead.md, model_role: lead}
  - {id: implementer, prompt: prompts/implementer.md, model_role: ticket_worker}
"#,
            ),
            document("prompts/lead.md", "Lead"),
            document("prompts/implementer.md", "Implement"),
        ];

        let resources = derive_resources(&documents);
        let agent_resources = resources
            .iter()
            .filter(|resource| resource.domain == ConfigDomain::Agents)
            .collect::<Vec<_>>();

        for title in ["Planner", "Lead", "Workers", "Reviewer", "Specialist"] {
            assert!(
                agent_resources.iter().any(|resource| {
                    resource.kind == ConfigResourceKind::AgentPolicy
                        && resource.title == "Custom model"
                        && resource.subtitle.starts_with(title)
                }),
                "missing {title} policy"
            );
        }
        assert!(agent_resources.iter().any(|resource| {
            resource.kind == ConfigResourceKind::Persona
                && resource.title == "Lead"
                && resource.subtitle.starts_with("Lead · Instructions")
                && resource
                    .linked_documents
                    .iter()
                    .any(|document| document.document_path == Path::new("prompts/lead.md"))
        }));
        assert!(agent_resources.iter().any(|resource| {
            resource.kind == ConfigResourceKind::Persona
                && resource.title == "Implementer"
                && resource.subtitle.starts_with("Workers · Instructions")
        }));
        assert_eq!(
            agent_resources
                .iter()
                .filter(|resource| resource.is_markdown_prompt())
                .count(),
            0
        );
    }

    #[test]
    fn native_codex_agents_and_skills_are_semantic_resources_without_duplicate_personas() {
        let documents = vec![
            document(
                ".codex/config.toml",
                "model = \"gpt-5.6-sol\"\nmodel_reasoning_effort = \"high\"\n",
            ),
            document(
                ".codex/agents/shared.toml",
                "name = \"shared\"\ndescription = \"Shared project agent\"\ndeveloper_instructions = \"Build carefully.\"\nmodel = \"gpt-5.6-terra\"\nmodel_reasoning_effort = \"xhigh\"\nsandbox_mode = \"workspace-write\"\n",
            ),
            document(
                ".agents/skills/review/SKILL.md",
                "---\nname: review\ndescription: Review finished changes.\n---\n# Review\n",
            ),
            document(
                "personas.yaml",
                "personas:\n  - {id: shared, codex_agent: shared, prompt: prompts/shared.md, model_role: lead, sandbox: {mode: workspace-write}}\n  - {id: missing, codex_agent: missing, model_role: reviewer, sandbox: {mode: read-only}}\n",
            ),
            document("prompts/shared.md", "# Shared instructions\n"),
        ];

        let resources = derive_resources(&documents);
        assert!(resources.iter().any(|resource| {
            resource.kind == ConfigResourceKind::CodexProjectSettings
                && resource.domain == ConfigDomain::Project
        }));
        let agent = resources
            .iter()
            .find(|resource| {
                resource.kind == ConfigResourceKind::NativeAgent
                    && resource.domain == ConfigDomain::Agents
                    && resource.title == "Shared"
            })
            .unwrap();
        assert_eq!(agent.linked_locators.len(), 1);
        assert_eq!(agent.linked_documents.len(), 1);
        assert_eq!(
            agent.linked_documents[0].document_path,
            Path::new("prompts/shared.md")
        );
        assert_eq!(
            agent.linked_locators[0].document_path,
            Path::new("personas.yaml")
        );
        assert!(!resources.iter().any(|resource| {
            resource.kind == ConfigResourceKind::Persona && resource.title == "Shared"
        }));
        assert!(resources.iter().any(|resource| {
            resource.kind == ConfigResourceKind::Skill
                && resource.domain == ConfigDomain::Skills
                && resource.title == "Review"
        }));
        assert!(resources.iter().any(|resource| {
            resource.kind == ConfigResourceKind::Persona
                && resource.title == "Missing execution policy"
                && resource.subtitle.contains("Native agent unavailable")
        }));
    }

    #[test]
    fn semantic_projection_includes_only_modules_imported_by_the_shared_profile() {
        let documents = vec![
            document(
                "project.yaml",
                r#"
project: {id: demo, title: Demo}
default_run_type: small
run_types:
  - {id: small, path: run-types/small.yaml}
"#,
            ),
            document(
                "run-types/small.yaml",
                r#"
id: small
title: Small
profile: {source: .codex/koni/profile.yaml}
pipeline: {stages: {}, order: []}
"#,
            ),
            document(
                "profile.yaml",
                r#"
profile: {id: demo, version: 1.0.0}
imports:
  actions: [modules/linked-actions.yaml]
"#,
            ),
            document(
                "modules/linked-actions.yaml",
                "actions: [{id: linked-action}]\n",
            ),
            document(
                "modules/unlinked-actions.yaml",
                "actions: [{id: unlinked-action}]\n",
            ),
        ];

        let resources = derive_resources(&documents);
        let action_sources = resources
            .iter()
            .filter(|resource| resource.domain == ConfigDomain::ActionsChecks)
            .map(|resource| resource.document_path.as_path())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            action_sources,
            BTreeSet::from([Path::new("modules/linked-actions.yaml")])
        );
        assert!(resources.iter().any(|resource| {
            resource.domain == ConfigDomain::Advanced
                && resource.document_path == Path::new("modules/unlinked-actions.yaml")
                && resource.subtitle.contains("not linked")
        }));
    }

    #[test]
    fn shared_profile_without_an_imports_block_remains_a_project_resource() {
        let documents = vec![
            document(
                "project.yaml",
                r#"
project: {id: demo, title: Demo}
default_run_type: small
run_types:
  - {id: small, path: run-types/small.yaml}
"#,
            ),
            document(
                "run-types/small.yaml",
                r#"
id: small
title: Small
profile: {source: .codex/koni/profile.yaml}
pipeline: {stages: {}, order: []}
"#,
            ),
            document("profile.yaml", "profile: {id: demo, version: 1.0.0}\n"),
            document(
                "modules/unlinked-actions.yaml",
                "actions: [{id: unlinked-action}]\n",
            ),
        ];

        let resources = derive_resources(&documents);
        assert!(resources.iter().any(|resource| {
            resource.domain == ConfigDomain::Project
                && resource.kind == ConfigResourceKind::Profile
                && resource.document_path == Path::new("profile.yaml")
        }));
        assert!(
            !resources
                .iter()
                .any(|resource| resource.domain == ConfigDomain::ActionsChecks)
        );
    }
}
