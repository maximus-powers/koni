use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::{KoniError, Result, io_error};
use crate::graph::normalized_hash;

/// Codex MCP server name reserved for the compiler-injected runtime broker.
///
/// The launcher replaces this complete table at the highest configuration
/// layer for every bounded agent process. Project resources may not define it:
/// accepting a second definition would make the authority boundary depend on
/// Codex's configuration merge behavior instead of Koni's pinned launch.
pub const RUNTIME_MCP_SERVER_ID: &str = "koni_runtime";

/// Project-scoped resources understood natively by Codex.
///
/// Koni deliberately models only the parts it needs to validate and pin.
/// Unknown custom-agent configuration remains available in `config`, which
/// keeps this reader forward-compatible with new Codex configuration keys.
#[derive(Debug, Clone)]
pub struct NativeCodexCatalog {
    pub project_root: PathBuf,
    pub project_config: Option<CodexProjectConfig>,
    pub agents: BTreeMap<String, CodexAgentDef>,
    pub skills: BTreeMap<String, CodexSkillDef>,
    pub files: BTreeMap<PathBuf, String>,
    pub hash: String,
}

#[derive(Debug, Clone)]
pub struct CodexProjectConfig {
    pub path: PathBuf,
    pub value: toml::Value,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexAgentDef {
    pub name: String,
    pub description: String,
    pub developer_instructions: String,
    pub nickname_candidates: Vec<String>,
    pub model: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub sandbox_mode: Option<String>,
    pub config: BTreeMap<String, toml::Value>,
    pub path: PathBuf,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexSkillDef {
    pub name: String,
    pub description: String,
    pub metadata: BTreeMap<String, serde_yaml::Value>,
    pub path: PathBuf,
    pub files: BTreeMap<PathBuf, String>,
    pub hash: String,
}

#[derive(Debug, Deserialize)]
struct RawCodexAgent {
    name: String,
    description: String,
    developer_instructions: String,
    #[serde(default)]
    nickname_candidates: Vec<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    model_reasoning_effort: Option<String>,
    #[serde(default)]
    sandbox_mode: Option<String>,
    #[serde(default, flatten)]
    config: BTreeMap<String, toml::Value>,
}

#[derive(Debug, Deserialize)]
struct SkillFrontmatter {
    name: String,
    description: String,
    #[serde(default, flatten)]
    metadata: BTreeMap<String, serde_yaml::Value>,
}

impl NativeCodexCatalog {
    pub fn discover(project_root: &Path) -> Result<Self> {
        let mut files = BTreeMap::new();
        let project_config = load_project_config(project_root, &mut files)?;
        let agents = load_agents(project_root, &mut files)?;
        let skills = load_skills(project_root, &mut files)?;
        reject_runtime_mcp_server_collisions(project_config.as_ref(), &agents)?;
        let hash = normalized_hash(&files);
        Ok(Self {
            project_root: project_root.to_path_buf(),
            project_config,
            agents,
            skills,
            files,
            hash,
        })
    }

    pub fn agent(&self, name: &str) -> Option<&CodexAgentDef> {
        self.agents.get(name)
    }

    pub fn skill(&self, name: &str) -> Option<&CodexSkillDef> {
        self.skills.get(name)
    }
}

fn reject_runtime_mcp_server_collisions(
    project_config: Option<&CodexProjectConfig>,
    agents: &BTreeMap<String, CodexAgentDef>,
) -> Result<()> {
    if project_config
        .and_then(|config| config.value.get("mcp_servers"))
        .and_then(toml::Value::as_table)
        .is_some_and(|servers| servers.contains_key(RUNTIME_MCP_SERVER_ID))
    {
        return Err(KoniError::Profile(format!(
            "Codex MCP server name {RUNTIME_MCP_SERVER_ID} is reserved for the compiler-injected Koni runtime broker in {}",
            project_config
                .expect("collision requires project config")
                .path
                .display()
        )));
    }
    if let Some(agent) = agents.values().find(|agent| {
        agent
            .config
            .get("mcp_servers")
            .and_then(toml::Value::as_table)
            .is_some_and(|servers| servers.contains_key(RUNTIME_MCP_SERVER_ID))
    }) {
        return Err(KoniError::Profile(format!(
            "Codex MCP server name {RUNTIME_MCP_SERVER_ID} is reserved for the compiler-injected Koni runtime broker in {}",
            agent.path.display()
        )));
    }
    Ok(())
}

/// Locate the repository root from a compiled Koni profile root.
///
/// Installed profiles live at `<project>/.codex/koni`. Profiles used by
/// unit tests and embedders may live elsewhere, in which case that directory is
/// treated as the project root.
pub fn project_root_for_profile(profile_root: &Path) -> PathBuf {
    let is_koni = profile_root.file_name().is_some_and(|name| name == "koni");
    let codex_dir = profile_root.parent().filter(|_| is_koni);
    if codex_dir
        .and_then(Path::file_name)
        .is_some_and(|name| name == ".codex")
    {
        return codex_dir
            .and_then(Path::parent)
            .unwrap_or(profile_root)
            .to_path_buf();
    }
    profile_root.to_path_buf()
}

fn load_project_config(
    project_root: &Path,
    files: &mut BTreeMap<PathBuf, String>,
) -> Result<Option<CodexProjectConfig>> {
    let relative = PathBuf::from(".codex/config.toml");
    let path = project_root.join(&relative);
    if !path.exists() {
        return Ok(None);
    }
    ensure_regular_file(&path, "Codex project configuration")?;
    let text = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
    let value = toml::from_str(&text).map_err(|source| KoniError::Toml {
        path: path.clone(),
        source,
    })?;
    let hash = normalized_hash(&text.as_bytes());
    files.insert(relative.clone(), hash.clone());
    Ok(Some(CodexProjectConfig {
        path: relative,
        value,
        hash,
    }))
}

fn load_agents(
    project_root: &Path,
    files: &mut BTreeMap<PathBuf, String>,
) -> Result<BTreeMap<String, CodexAgentDef>> {
    let root = project_root.join(".codex/agents");
    if !root.exists() {
        return Ok(BTreeMap::new());
    }
    if !root.is_dir() {
        return Err(KoniError::Profile(format!(
            "Codex project agents path is not a directory: {}",
            root.display()
        )));
    }
    let mut paths = fs::read_dir(&root)
        .map_err(|error| io_error(&root, error))?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| io_error(&root, error))
        })
        .collect::<Result<Vec<_>>>()?;
    paths.sort();

    let mut agents = BTreeMap::new();
    for path in paths {
        if path.extension().and_then(|value| value.to_str()) != Some("toml") {
            continue;
        }
        ensure_regular_file(&path, "Codex custom agent")?;
        let text = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
        let raw: RawCodexAgent = toml::from_str(&text).map_err(|source| KoniError::Toml {
            path: path.clone(),
            source,
        })?;
        validate_nonempty(&raw.name, "Codex custom agent name", &path)?;
        validate_nonempty(&raw.description, "Codex custom agent description", &path)?;
        validate_nonempty(
            &raw.developer_instructions,
            "Codex custom agent developer_instructions",
            &path,
        )?;
        validate_nicknames(&raw.nickname_candidates, &path)?;
        validate_optional_nonempty(raw.model.as_deref(), "model", &path)?;
        validate_optional_nonempty(
            raw.model_reasoning_effort.as_deref(),
            "model_reasoning_effort",
            &path,
        )?;
        validate_optional_nonempty(raw.sandbox_mode.as_deref(), "sandbox_mode", &path)?;

        let relative = path
            .strip_prefix(project_root)
            .expect("agent path is under project root")
            .to_path_buf();
        let hash = normalized_hash(&text.as_bytes());
        files.insert(relative.clone(), hash.clone());
        let name = raw.name.clone();
        let agent = CodexAgentDef {
            name: raw.name,
            description: raw.description,
            developer_instructions: raw.developer_instructions,
            nickname_candidates: raw.nickname_candidates,
            model: raw.model,
            model_reasoning_effort: raw.model_reasoning_effort,
            sandbox_mode: raw.sandbox_mode,
            config: raw.config,
            path: relative,
            hash,
        };
        if agents.insert(name.clone(), agent).is_some() {
            return Err(KoniError::Profile(format!(
                "duplicate Codex custom agent name {name}"
            )));
        }
    }
    Ok(agents)
}

fn load_skills(
    project_root: &Path,
    files: &mut BTreeMap<PathBuf, String>,
) -> Result<BTreeMap<String, CodexSkillDef>> {
    let root = project_root.join(".agents/skills");
    if !root.exists() {
        return Ok(BTreeMap::new());
    }
    if !root.is_dir() {
        return Err(KoniError::Profile(format!(
            "Codex repository skills path is not a directory: {}",
            root.display()
        )));
    }
    let mut directories = fs::read_dir(&root)
        .map_err(|error| io_error(&root, error))?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| io_error(&root, error))
        })
        .collect::<Result<Vec<_>>>()?;
    directories.sort();

    let mut skills = BTreeMap::new();
    for directory in directories {
        let metadata =
            fs::symlink_metadata(&directory).map_err(|error| io_error(&directory, error))?;
        let source_directory = if metadata.file_type().is_symlink() {
            let target = directory
                .canonicalize()
                .map_err(|error| io_error(&directory, error))?;
            if !target.is_dir() {
                return Err(KoniError::Profile(format!(
                    "Codex skill symlink does not resolve to a directory: {}",
                    directory.display()
                )));
            }
            target
        } else if metadata.is_dir() {
            directory.clone()
        } else {
            continue;
        };
        let skill_path = source_directory.join("SKILL.md");
        ensure_resolved_regular_file(&skill_path, "Codex skill SKILL.md")?;
        let text = fs::read_to_string(&skill_path).map_err(|error| io_error(&skill_path, error))?;
        let frontmatter = parse_skill_frontmatter(&text, &skill_path)?;
        validate_nonempty(&frontmatter.name, "Codex skill name", &skill_path)?;
        validate_nonempty(
            &frontmatter.description,
            "Codex skill description",
            &skill_path,
        )?;

        let mut bundle_files = BTreeMap::new();
        for entry in WalkDir::new(&source_directory).follow_links(true) {
            let entry = entry.map_err(|error| KoniError::Profile(error.to_string()))?;
            if entry.path() == source_directory || entry.file_type().is_dir() {
                continue;
            }
            if !entry.file_type().is_file() {
                return Err(KoniError::Profile(format!(
                    "Codex skill bundles must contain only regular files: {}",
                    entry.path().display()
                )));
            }
            let bytes = fs::read(entry.path()).map_err(|error| io_error(entry.path(), error))?;
            let bundle_relative = entry
                .path()
                .strip_prefix(&source_directory)
                .expect("skill entry is under its directory")
                .to_path_buf();
            let project_relative = PathBuf::from(".agents/skills")
                .join(directory.file_name().expect("skill directory name"))
                .join(&bundle_relative);
            let file_hash = normalized_hash(&bytes);
            bundle_files.insert(bundle_relative, file_hash.clone());
            files.insert(project_relative, file_hash);
        }
        let relative = directory
            .strip_prefix(project_root)
            .expect("skill directory is under project root")
            .to_path_buf();
        let hash = normalized_hash(&bundle_files);
        let name = frontmatter.name.clone();
        let skill = CodexSkillDef {
            name: frontmatter.name,
            description: frontmatter.description,
            metadata: frontmatter.metadata,
            path: relative,
            files: bundle_files,
            hash,
        };
        if skills.insert(name.clone(), skill).is_some() {
            return Err(KoniError::Profile(format!(
                "duplicate Codex skill name {name}"
            )));
        }
    }
    Ok(skills)
}

fn parse_skill_frontmatter(text: &str, path: &Path) -> Result<SkillFrontmatter> {
    let mut lines = text.lines();
    if lines.next() != Some("---") {
        return Err(KoniError::Profile(format!(
            "Codex skill {} must begin with YAML frontmatter",
            path.display()
        )));
    }
    let mut frontmatter = Vec::new();
    let mut terminated = false;
    for line in lines {
        if line == "---" {
            terminated = true;
            break;
        }
        frontmatter.push(line);
    }
    if !terminated {
        return Err(KoniError::Profile(format!(
            "Codex skill {} has unterminated YAML frontmatter",
            path.display()
        )));
    }
    serde_yaml::from_str(&frontmatter.join("\n")).map_err(|source| KoniError::Yaml {
        path: path.to_path_buf(),
        source,
    })
}

fn validate_nonempty(value: &str, label: &str, path: &Path) -> Result<()> {
    if value.trim().is_empty() {
        return Err(KoniError::Profile(format!(
            "{label} must not be empty in {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_optional_nonempty(value: Option<&str>, label: &str, path: &Path) -> Result<()> {
    if value.is_some_and(|value| value.trim().is_empty()) {
        return Err(KoniError::Profile(format!(
            "Codex custom agent {label} must not be empty in {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_nicknames(nicknames: &[String], path: &Path) -> Result<()> {
    let mut unique = BTreeSet::new();
    for nickname in nicknames {
        if nickname.is_empty()
            || !nickname.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_')
            })
        {
            return Err(KoniError::Profile(format!(
                "Codex custom agent nickname {nickname:?} in {} may contain only ASCII letters, digits, spaces, hyphens, and underscores",
                path.display()
            )));
        }
        if !unique.insert(nickname) {
            return Err(KoniError::Profile(format!(
                "Codex custom agent nicknames must be unique in {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn ensure_regular_file(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(KoniError::Profile(format!(
            "{label} is not a regular file: {}",
            path.display()
        )));
    }
    Ok(())
}

fn ensure_resolved_regular_file(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::metadata(path).map_err(|error| io_error(path, error))?;
    if !metadata.is_file() {
        return Err(KoniError::Profile(format!(
            "{label} is not a regular file: {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().expect("test path parent")).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn discovers_and_hashes_project_agents_and_skill_bundles() {
        let temp = TempDir::new().unwrap();
        write(
            &temp.path().join(".codex/config.toml"),
            "[agents]\nmax_threads = 4\n",
        );
        write(
            &temp.path().join(".codex/agents/reviewer.toml"),
            r#"name = "reviewer"
description = "Reviews changes"
developer_instructions = "Review like an owner."
nickname_candidates = ["Atlas", "Echo-2"]
model = "gpt-test"
model_reasoning_effort = "high"
sandbox_mode = "read-only"

[skills]
config = [{ path = ".agents/skills/review/SKILL.md", enabled = true }]
"#,
        );
        write(
            &temp.path().join(".agents/skills/review/SKILL.md"),
            "---\nname: review\ndescription: Review a change\n---\n\nReview it.\n",
        );
        write(
            &temp.path().join(".agents/skills/review/scripts/check.sh"),
            "#!/bin/sh\nexit 0\n",
        );

        let first = NativeCodexCatalog::discover(temp.path()).unwrap();
        assert_eq!(first.agents["reviewer"].model.as_deref(), Some("gpt-test"));
        assert!(first.agents["reviewer"].config.contains_key("skills"));
        assert_eq!(first.skills["review"].files.len(), 2);
        assert!(first.project_config.is_some());
        assert_eq!(first.files.len(), 4);

        write(
            &temp.path().join(".agents/skills/review/scripts/check.sh"),
            "#!/bin/sh\nexit 1\n",
        );
        let second = NativeCodexCatalog::discover(temp.path()).unwrap();
        assert_ne!(first.skills["review"].hash, second.skills["review"].hash);
        assert_ne!(first.hash, second.hash);
    }

    #[test]
    fn duplicate_agent_names_are_rejected_even_when_filenames_differ() {
        let temp = TempDir::new().unwrap();
        for filename in ["one.toml", "two.toml"] {
            write(
                &temp.path().join(".codex/agents").join(filename),
                "name = \"reviewer\"\ndescription = \"Review\"\ndeveloper_instructions = \"Inspect changes\"\n",
            );
        }
        let error = NativeCodexCatalog::discover(temp.path()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("duplicate Codex custom agent name reviewer")
        );
    }

    #[test]
    fn runtime_mcp_server_name_is_reserved_in_project_and_agent_config() {
        let project = TempDir::new().unwrap();
        write(
            &project.path().join(".codex/config.toml"),
            "[mcp_servers.koni_runtime]\ncommand = \"forged\"\n",
        );
        let error = NativeCodexCatalog::discover(project.path()).unwrap_err();
        assert!(error.to_string().contains("reserved"), "{error}");

        let agent = TempDir::new().unwrap();
        write(
            &agent.path().join(".codex/agents/worker.toml"),
            r#"name = "worker"
description = "Works"
developer_instructions = "Work"

[mcp_servers.koni_runtime]
command = "forged"
"#,
        );
        let error = NativeCodexCatalog::discover(agent.path()).unwrap_err();
        assert!(error.to_string().contains("reserved"), "{error}");
    }

    #[test]
    fn skill_frontmatter_requires_discovery_metadata() {
        let temp = TempDir::new().unwrap();
        write(
            &temp.path().join(".agents/skills/review/SKILL.md"),
            "---\nname: review\n---\nInstructions\n",
        );
        let error = NativeCodexCatalog::discover(temp.path()).unwrap_err();
        assert!(error.to_string().contains("invalid YAML"));
    }

    #[test]
    fn profile_root_maps_to_its_standard_project_root() {
        let root = Path::new("/repo/.codex/koni");
        assert_eq!(project_root_for_profile(root), Path::new("/repo"));
        assert_eq!(
            project_root_for_profile(Path::new("/profile")),
            Path::new("/profile")
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_skill_directories_are_discovered_under_the_standard_path() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let shared = temp.path().join("shared/review");
        write(
            &shared.join("SKILL.md"),
            "---\nname: review\ndescription: Review changes\n---\nInstructions\n",
        );
        let skills = temp.path().join(".agents/skills");
        fs::create_dir_all(&skills).unwrap();
        symlink(&shared, skills.join("review-link")).unwrap();

        let catalog = NativeCodexCatalog::discover(temp.path()).unwrap();
        assert_eq!(
            catalog.skills["review"].path,
            Path::new(".agents/skills/review-link")
        );
        assert!(
            catalog
                .files
                .contains_key(Path::new(".agents/skills/review-link/SKILL.md"))
        );
    }
}
