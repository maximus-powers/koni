use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::config::StorageConfig;
use crate::error::{KoniError, Result, io_error};
use crate::git::GitBackend;
use crate::graph::{Graph, NodeId, atomic_write_yaml, normalized_hash};
use crate::persistent_lock::{LockMode, PersistentFileLock, exact_path_identity};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunManifest {
    pub schema_version: String,
    pub id: String,
    pub profile_id: String,
    pub profile_version: String,
    pub profile_hash: String,
    /// Project-local reusable run type that resolved to the pinned profile.
    #[serde(default)]
    pub run_type_id: Option<String>,
    /// Human-facing run type title resolved at planning time.
    #[serde(default)]
    pub run_type_title: Option<String>,
    /// Hash of the fully resolved run type, including pipeline and intake.
    #[serde(default)]
    pub run_type_hash: Option<String>,
    /// Effective run-local question policy.
    #[serde(default)]
    pub question_policy: Option<String>,
    pub goal: String,
    pub repository_root: PathBuf,
    pub integration_branch: Option<String>,
    pub integration_base: Option<String>,
    /// Immutable product commit selected before planning begins.
    #[serde(default)]
    pub base_commit: Option<String>,
    /// Immutable digest of the copied project/profile configuration.
    #[serde(default)]
    pub config_snapshot_hash: Option<String>,
    /// Run-root-relative location of the immutable configuration copy.
    #[serde(default)]
    pub config_snapshot_path: Option<PathBuf>,
    /// Detached and temporary; Koni policy treats this checkout as read-only.
    #[serde(default)]
    pub planning_worktree: Option<PathBuf>,
    /// Machine-readable policy marker for the temporary planning checkout.
    #[serde(default)]
    pub planning_read_only: bool,
    /// Populated once, when the run is approved for implementation.
    #[serde(default)]
    pub integration_worktree: Option<PathBuf>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub status: String,
}

impl RunManifest {
    pub fn new(
        profile_id: impl Into<String>,
        profile_version: impl Into<String>,
        profile_hash: impl Into<String>,
        goal: impl Into<String>,
        repository_root: PathBuf,
    ) -> Self {
        let now = Utc::now();
        Self {
            schema_version: "1.0".to_owned(),
            id: Uuid::now_v7().to_string(),
            profile_id: profile_id.into(),
            profile_version: profile_version.into(),
            profile_hash: profile_hash.into(),
            run_type_id: None,
            run_type_title: None,
            run_type_hash: None,
            question_policy: None,
            goal: goal.into(),
            repository_root,
            integration_branch: None,
            integration_base: None,
            base_commit: None,
            config_snapshot_hash: None,
            config_snapshot_path: None,
            planning_worktree: None,
            planning_read_only: false,
            integration_worktree: None,
            created_at: now,
            updated_at: now,
            status: "active".to_owned(),
        }
    }

    pub fn pin_inputs(&mut self, base_commit: impl Into<String>, config_snapshot: &ConfigSnapshot) {
        let base_commit = base_commit.into();
        self.integration_base = Some(base_commit.clone());
        self.base_commit = Some(base_commit);
        self.config_snapshot_hash = Some(config_snapshot.hash.clone());
        self.config_snapshot_path = Some(config_snapshot.path.clone());
    }

    pub fn attach_planning_worktree(&mut self, path: PathBuf) {
        self.planning_worktree = Some(path);
        self.planning_read_only = true;
        self.updated_at = Utc::now();
    }

    pub fn record_approval(&mut self, branch: String, worktree: PathBuf) {
        self.integration_branch = Some(branch);
        self.integration_worktree = Some(worktree);
        self.planning_worktree = None;
        self.planning_read_only = false;
        self.updated_at = Utc::now();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfigSnapshot {
    pub schema_version: String,
    /// Relative to the run state root.
    pub path: PathBuf,
    pub hash: String,
    pub files: BTreeMap<PathBuf, String>,
    pub captured_at: DateTime<Utc>,
}

impl ConfigSnapshot {
    pub fn load(run_root: &Path) -> Result<Self> {
        read_yaml(&run_root.join("config-snapshot.yaml"))
    }

    pub fn load_verified(run_root: &Path) -> Result<Self> {
        let snapshot = Self::load(run_root)?;
        snapshot.verify(run_root)?;
        Ok(snapshot)
    }

    /// Copy a configuration tree into the durable run root and hash every file.
    pub fn capture(source: &Path, run_root: &Path) -> Result<Self> {
        let source = source
            .canonicalize()
            .map_err(|error| io_error(source, error))?;
        if !source.is_dir() {
            return Err(KoniError::Action(format!(
                "configuration snapshot source is not a directory: {}",
                source.display()
            )));
        }
        let relative_root = PathBuf::from("config-snapshot");
        let destination = run_root.join(&relative_root);
        if destination.exists() {
            return Err(KoniError::Action(format!(
                "configuration snapshot already exists: {}",
                destination.display()
            )));
        }
        fs::create_dir_all(&destination).map_err(|error| io_error(&destination, error))?;
        let mut files = BTreeMap::new();
        for entry in WalkDir::new(&source).follow_links(false) {
            let entry = entry.map_err(|error| KoniError::Action(error.to_string()))?;
            let relative = entry
                .path()
                .strip_prefix(&source)
                .map_err(|error| KoniError::Action(error.to_string()))?;
            if relative.as_os_str().is_empty() {
                continue;
            }
            let target = destination.join(relative);
            if entry.file_type().is_dir() {
                fs::create_dir_all(&target).map_err(|error| io_error(&target, error))?;
            } else if entry.file_type().is_file() {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
                }
                fs::copy(entry.path(), &target).map_err(|error| io_error(&target, error))?;
                let bytes = fs::read(&target).map_err(|error| io_error(&target, error))?;
                files.insert(relative.to_path_buf(), normalized_hash(&bytes));
            } else {
                return Err(KoniError::Action(format!(
                    "configuration snapshots do not follow special files or symlinks: {}",
                    entry.path().display()
                )));
            }
        }
        let hash = normalized_hash(&files);
        let snapshot = Self {
            schema_version: "1.0".to_owned(),
            path: relative_root,
            hash,
            files,
            captured_at: Utc::now(),
        };
        atomic_write_yaml(&run_root.join("config-snapshot.yaml"), &snapshot)?;
        Ok(snapshot)
    }

    /// Capture the project-local Koni tree and the native Codex resources
    /// that can affect its agents while preserving their standard paths.
    ///
    /// The snapshot intentionally excludes user-level Codex state. It includes
    /// only `.codex/koni`, project `.codex/config.toml`, project custom
    /// agents, and repository skills. Symlinked skill directories are resolved
    /// into regular snapshot files because Codex supports shared skills while a
    /// run still needs immutable, independently verifiable inputs.
    pub fn capture_project_configuration(project_root: &Path, run_root: &Path) -> Result<Self> {
        let project_root = project_root
            .canonicalize()
            .map_err(|error| io_error(project_root, error))?;
        let source = project_root.join(".codex/koni");
        if !source.is_dir() {
            return Err(KoniError::NotFound(format!(
                "project Koni configuration {}",
                source.display()
            )));
        }
        let relative_root = PathBuf::from("config-snapshot");
        let snapshot_root = run_root.join(&relative_root);
        let destination = snapshot_root.join(".codex/koni");
        if run_root.join(&relative_root).exists() {
            return Err(KoniError::Action(format!(
                "configuration snapshot already exists: {}",
                run_root.join(&relative_root).display()
            )));
        }
        fs::create_dir_all(&destination).map_err(|error| io_error(&destination, error))?;
        let mut files = BTreeMap::new();
        copy_snapshot_directory(
            &source,
            &destination,
            Path::new(".codex/koni"),
            false,
            &mut files,
        )?;

        let project_config = project_root.join(".codex/config.toml");
        if project_config.exists() {
            copy_snapshot_file(
                &project_config,
                &snapshot_root.join(".codex/config.toml"),
                Path::new(".codex/config.toml"),
                &mut files,
            )?;
        }
        let project_agents = project_root.join(".codex/agents");
        if project_agents.exists() {
            copy_snapshot_directory(
                &project_agents,
                &snapshot_root.join(".codex/agents"),
                Path::new(".codex/agents"),
                false,
                &mut files,
            )?;
        }
        copy_snapshot_skills(&project_root, &snapshot_root, &mut files)?;
        let hash = normalized_hash(&files);
        let snapshot = Self {
            schema_version: "1.0".to_owned(),
            path: relative_root,
            hash,
            files,
            captured_at: Utc::now(),
        };
        atomic_write_yaml(&run_root.join("config-snapshot.yaml"), &snapshot)?;
        Ok(snapshot)
    }

    /// Re-hash the copied tree before compilation or execution. This detects
    /// edits, additions, removals, and replacement by a symlink.
    pub fn verify(&self, run_root: &Path) -> Result<()> {
        let root = run_root.join(&self.path);
        let mut actual = BTreeMap::new();
        for entry in WalkDir::new(&root).follow_links(false) {
            let entry = entry.map_err(|error| KoniError::Action(error.to_string()))?;
            let relative = entry
                .path()
                .strip_prefix(&root)
                .map_err(|error| KoniError::Action(error.to_string()))?;
            if relative.as_os_str().is_empty() || entry.file_type().is_dir() {
                continue;
            }
            if !entry.file_type().is_file() {
                return Err(KoniError::Action(format!(
                    "configuration snapshot contains a special file or symlink: {}",
                    entry.path().display()
                )));
            }
            let bytes = fs::read(entry.path()).map_err(|error| io_error(entry.path(), error))?;
            actual.insert(relative.to_path_buf(), normalized_hash(&bytes));
        }
        let actual_hash = normalized_hash(&actual);
        if actual != self.files || actual_hash != self.hash {
            return Err(KoniError::Action(format!(
                "configuration snapshot {} no longer matches {}",
                root.display(),
                self.hash
            )));
        }
        Ok(())
    }

    /// Replace one already-captured project configuration document while a
    /// run is still being constructed, then refresh the snapshot manifest.
    /// This is intentionally crate-private: once registration succeeds, the
    /// snapshot is immutable and all readers use `load_verified`.
    pub(crate) fn finalize_project_yaml_override<T: Serialize>(
        &mut self,
        run_root: &Path,
        relative: &Path,
        value: &T,
    ) -> Result<()> {
        if relative.is_absolute()
            || relative.as_os_str().is_empty()
            || relative.components().any(|component| {
                !matches!(component, Component::Normal(_))
                    && !matches!(component, Component::CurDir)
            })
            || !relative.starts_with(Path::new(".codex/koni"))
        {
            return Err(KoniError::Action(format!(
                "run-local configuration override path is invalid: {}",
                relative.display()
            )));
        }
        if !self.files.contains_key(relative) {
            return Err(KoniError::NotFound(format!(
                "captured configuration file {}",
                relative.display()
            )));
        }
        self.verify(run_root)?;
        let target = run_root.join(&self.path).join(relative);
        atomic_write_yaml(&target, value)?;
        let bytes = fs::read(&target).map_err(|error| io_error(&target, error))?;
        self.files
            .insert(relative.to_path_buf(), normalized_hash(&bytes));
        self.hash = normalized_hash(&self.files);
        atomic_write_yaml(&run_root.join("config-snapshot.yaml"), self)?;
        self.verify(run_root)
    }
}

fn copy_snapshot_skills(
    project_root: &Path,
    snapshot_root: &Path,
    files: &mut BTreeMap<PathBuf, String>,
) -> Result<()> {
    let skills_root = project_root.join(".agents/skills");
    if !skills_root.exists() {
        return Ok(());
    }
    let metadata =
        fs::symlink_metadata(&skills_root).map_err(|error| io_error(&skills_root, error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(KoniError::Action(format!(
            "repository skills root is not a regular directory: {}",
            skills_root.display()
        )));
    }
    let mut entries = fs::read_dir(&skills_root)
        .map_err(|error| io_error(&skills_root, error))?
        .map(|entry| {
            entry
                .map(|entry| entry.path())
                .map_err(|error| io_error(&skills_root, error))
        })
        .collect::<Result<Vec<_>>>()?;
    entries.sort();
    for path in entries {
        let metadata = fs::symlink_metadata(&path).map_err(|error| io_error(&path, error))?;
        let source = if metadata.file_type().is_symlink() {
            let target = path
                .canonicalize()
                .map_err(|error| io_error(&path, error))?;
            if !target.is_dir() {
                return Err(KoniError::Action(format!(
                    "skill symlink does not resolve to a directory: {}",
                    path.display()
                )));
            }
            target
        } else if metadata.is_dir() {
            path.clone()
        } else {
            continue;
        };
        let name = path
            .file_name()
            .ok_or_else(|| KoniError::Action("skill path has no name".to_owned()))?;
        let relative = PathBuf::from(".agents/skills").join(name);
        copy_snapshot_directory(
            &source,
            &snapshot_root.join(&relative),
            &relative,
            true,
            files,
        )?;
    }
    Ok(())
}

fn copy_snapshot_directory(
    source: &Path,
    destination: &Path,
    snapshot_relative: &Path,
    follow_links: bool,
    files: &mut BTreeMap<PathBuf, String>,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source).map_err(|error| io_error(source, error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(KoniError::Action(format!(
            "configuration snapshot source is not a regular directory: {}",
            source.display()
        )));
    }
    fs::create_dir_all(destination).map_err(|error| io_error(destination, error))?;
    for entry in WalkDir::new(source).follow_links(follow_links) {
        let entry = entry.map_err(|error| KoniError::Action(error.to_string()))?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| KoniError::Action(error.to_string()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(|error| io_error(&target, error))?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
            }
            fs::copy(entry.path(), &target).map_err(|error| io_error(&target, error))?;
            let bytes = fs::read(&target).map_err(|error| io_error(&target, error))?;
            files.insert(snapshot_relative.join(relative), normalized_hash(&bytes));
        } else {
            return Err(KoniError::Action(format!(
                "configuration snapshots do not copy special files: {}",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

fn copy_snapshot_file(
    source: &Path,
    destination: &Path,
    snapshot_relative: &Path,
    files: &mut BTreeMap<PathBuf, String>,
) -> Result<()> {
    let metadata = fs::symlink_metadata(source).map_err(|error| io_error(source, error))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(KoniError::Action(format!(
            "configuration snapshot source is not a regular file: {}",
            source.display()
        )));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }
    fs::copy(source, destination).map_err(|error| io_error(destination, error))?;
    let bytes = fs::read(destination).map_err(|error| io_error(destination, error))?;
    files.insert(snapshot_relative.to_path_buf(), normalized_hash(&bytes));
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunRegistrationStatus {
    Planning,
    Approved,
    Active,
    Paused,
    Concluded,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunRegistration {
    pub id: String,
    pub slug: String,
    pub goal: String,
    pub profile_id: String,
    pub profile_version: String,
    pub profile_hash: String,
    #[serde(default)]
    pub run_type_id: Option<String>,
    #[serde(default)]
    pub run_type_title: Option<String>,
    #[serde(default)]
    pub run_type_hash: Option<String>,
    #[serde(default)]
    pub question_policy: Option<String>,
    pub base_commit: String,
    pub config_snapshot_hash: String,
    pub config_snapshot_path: PathBuf,
    pub status: RunRegistrationStatus,
    #[serde(default)]
    pub planning_worktree: Option<PathBuf>,
    #[serde(default)]
    pub planning_read_only: bool,
    #[serde(default)]
    pub integration_branch: Option<String>,
    #[serde(default)]
    pub integration_worktree: Option<PathBuf>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

type ImmutableRunKey<'a> = (
    &'a str,
    &'a str,
    &'a str,
    Option<&'a str>,
    Option<&'a str>,
    Option<&'a str>,
    Option<&'a str>,
    &'a str,
    &'a str,
    &'a Path,
);

impl RunRegistration {
    pub fn planning(
        manifest: &RunManifest,
        snapshot: &ConfigSnapshot,
        slug: String,
    ) -> Result<Self> {
        let base_commit = manifest
            .base_commit
            .clone()
            .or_else(|| manifest.integration_base.clone())
            .ok_or_else(|| KoniError::Action("run has no immutable base commit".to_owned()))?;
        if manifest.config_snapshot_hash.as_ref() != Some(&snapshot.hash)
            || manifest.config_snapshot_path.as_ref() != Some(&snapshot.path)
        {
            return Err(KoniError::Action(
                "run manifest does not pin the supplied configuration snapshot".to_owned(),
            ));
        }
        Ok(Self {
            id: manifest.id.clone(),
            slug,
            goal: manifest.goal.clone(),
            profile_id: manifest.profile_id.clone(),
            profile_version: manifest.profile_version.clone(),
            profile_hash: manifest.profile_hash.clone(),
            run_type_id: manifest.run_type_id.clone(),
            run_type_title: manifest.run_type_title.clone(),
            run_type_hash: manifest.run_type_hash.clone(),
            question_policy: manifest.question_policy.clone(),
            base_commit,
            config_snapshot_hash: snapshot.hash.clone(),
            config_snapshot_path: snapshot.path.clone(),
            status: RunRegistrationStatus::Planning,
            planning_worktree: manifest.planning_worktree.clone(),
            planning_read_only: manifest.planning_read_only,
            integration_branch: None,
            integration_worktree: None,
            created_at: manifest.created_at,
            updated_at: manifest.updated_at,
        })
    }

    fn immutable_key(&self) -> ImmutableRunKey<'_> {
        (
            &self.profile_id,
            &self.profile_version,
            &self.profile_hash,
            self.run_type_id.as_deref(),
            self.run_type_title.as_deref(),
            self.run_type_hash.as_deref(),
            self.question_policy.as_deref(),
            &self.base_commit,
            &self.config_snapshot_hash,
            &self.config_snapshot_path,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectRegistry {
    pub schema_version: String,
    pub project_id: String,
    pub repository_root: PathBuf,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub selected_run: Option<String>,
    #[serde(default)]
    pub runs: BTreeMap<String, RunRegistration>,
}

impl ProjectRegistry {
    fn new(repository_root: PathBuf) -> Self {
        let now = Utc::now();
        Self {
            schema_version: "1.0".to_owned(),
            project_id: Uuid::now_v7().to_string(),
            repository_root,
            created_at: now,
            updated_at: now,
            selected_run: None,
            runs: BTreeMap::new(),
        }
    }
}

/// Concurrent-safe registry rooted at `.git/koni`.
#[derive(Debug, Clone)]
pub struct ProjectRegistryStore {
    root: PathBuf,
    repository_root: PathBuf,
    registry_path: PathBuf,
    lock_path: PathBuf,
}

impl ProjectRegistryStore {
    pub fn new(sidecar_root: PathBuf, repository_root: PathBuf) -> Result<Self> {
        let repository_root = repository_root
            .canonicalize()
            .map_err(|error| io_error(&repository_root, error))?;
        let sidecar_name = sidecar_root
            .file_name()
            .map(ToOwned::to_owned)
            .ok_or_else(|| {
                KoniError::Action("project registry sidecar has no directory name".to_owned())
            })?;
        let sidecar_parent = sidecar_root.parent().ok_or_else(|| {
            KoniError::Action("project registry sidecar has no parent".to_owned())
        })?;
        let sidecar_root = sidecar_parent
            .canonicalize()
            .map_err(|error| io_error(sidecar_parent, error))?
            .join(sidecar_name);
        Ok(Self {
            registry_path: sidecar_root.join("project.yaml"),
            lock_path: sidecar_root.join("locks/project-registry.lock"),
            root: sidecar_root,
            repository_root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn run_root(&self, run_id: &str) -> Result<PathBuf> {
        validate_registry_id(run_id, "run ID")?;
        Ok(self.root.join("runs").join(run_id))
    }

    pub fn load_or_create(&self) -> Result<ProjectRegistry> {
        let _lock = self.lock()?;
        self.load_or_create_unlocked()
    }

    pub fn register_run(&self, registration: RunRegistration) -> Result<ProjectRegistry> {
        validate_run_registration(&registration)?;
        let _lock = self.lock()?;
        let mut registry = self.load_or_create_unlocked()?;
        if registry.runs.contains_key(&registration.id) {
            return Err(KoniError::Action(format!(
                "run {} is already registered",
                registration.id
            )));
        }
        let run_root = self.run_root(&registration.id)?;
        fs::create_dir_all(&run_root).map_err(|error| io_error(&run_root, error))?;
        registry.runs.insert(registration.id.clone(), registration);
        registry.updated_at = Utc::now();
        self.write_unlocked(&registry)?;
        Ok(registry)
    }

    pub fn approve_run(
        &self,
        run_id: &str,
        integration_branch: String,
        integration_worktree: PathBuf,
    ) -> Result<RunRegistration> {
        validate_registry_id(run_id, "run ID")?;
        let _lock = self.lock()?;
        let mut registry = self.load_or_create_unlocked()?;
        let run = registry
            .runs
            .get_mut(run_id)
            .ok_or_else(|| KoniError::NotFound(format!("run {run_id}")))?;
        if run.status != RunRegistrationStatus::Planning {
            let same_approval = run.integration_branch.as_deref() == Some(&integration_branch)
                && run.integration_worktree.as_ref() == Some(&integration_worktree);
            if same_approval {
                return Ok(run.clone());
            }
            return Err(KoniError::Action(format!(
                "run {run_id} is not awaiting approval"
            )));
        }
        run.status = RunRegistrationStatus::Approved;
        run.integration_branch = Some(integration_branch);
        run.integration_worktree = Some(integration_worktree);
        run.planning_worktree = None;
        run.planning_read_only = false;
        run.updated_at = Utc::now();
        let output = run.clone();
        registry.updated_at = Utc::now();
        self.write_unlocked(&registry)?;
        Ok(output)
    }

    pub fn update_run(&self, registration: RunRegistration) -> Result<RunRegistration> {
        validate_run_registration(&registration)?;
        let _lock = self.lock()?;
        let mut registry = self.load_or_create_unlocked()?;
        let existing = registry
            .runs
            .get(&registration.id)
            .ok_or_else(|| KoniError::NotFound(format!("run {}", registration.id)))?;
        let pinned_branch_changed = existing.integration_branch.is_some()
            && existing.integration_branch != registration.integration_branch;
        let pinned_worktree_changed = existing.integration_worktree.is_some()
            && existing.integration_worktree != registration.integration_worktree;
        if existing.immutable_key() != registration.immutable_key()
            || existing.created_at != registration.created_at
            || pinned_branch_changed
            || pinned_worktree_changed
        {
            return Err(KoniError::Action(format!(
                "run {} immutable base/configuration inputs cannot change",
                registration.id
            )));
        }
        registry
            .runs
            .insert(registration.id.clone(), registration.clone());
        registry.updated_at = Utc::now();
        self.write_unlocked(&registry)?;
        Ok(registration)
    }

    /// Remove one run from the project registry and repair compatibility
    /// selection without touching the run's worktrees, branches, or sidecar
    /// directory.  Destructive artifact cleanup belongs to the engine's
    /// deletion transaction and must happen before this registry commit.
    pub fn unregister_run(&self, run_id: &str) -> Result<Option<RunRegistration>> {
        validate_registry_id(run_id, "run ID")?;
        let _lock = self.lock()?;
        let mut registry = self.load_or_create_unlocked()?;
        let removed = registry.runs.remove(run_id);
        if registry.selected_run.as_deref() == Some(run_id)
            || registry
                .selected_run
                .as_ref()
                .is_some_and(|selected| !registry.runs.contains_key(selected))
        {
            registry.selected_run = registry.runs.keys().next_back().cloned();
        }
        registry.updated_at = Utc::now();
        self.write_unlocked(&registry)?;

        let current = self.root.join("runs/current");
        if let Some(selected) = &registry.selected_run {
            atomic_write_text(&current, &format!("{selected}\n"))?;
        } else {
            match fs::remove_file(&current) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(io_error(&current, error)),
            }
        }
        Ok(removed)
    }

    /// Compatibility selection for APIs that do not yet accept an explicit run ID.
    /// Selecting one run never pauses or replaces any other run.
    pub fn select_run(&self, run_id: &str) -> Result<()> {
        validate_registry_id(run_id, "run ID")?;
        let _lock = self.lock()?;
        let mut registry = self.load_or_create_unlocked()?;
        if !registry.runs.contains_key(run_id) {
            return Err(KoniError::NotFound(format!("run {run_id}")));
        }
        registry.selected_run = Some(run_id.to_owned());
        registry.updated_at = Utc::now();
        self.write_unlocked(&registry)?;
        atomic_write_text(&self.root.join("runs/current"), &format!("{run_id}\n"))
    }

    pub fn run(&self, run_id: &str) -> Result<RunRegistration> {
        validate_registry_id(run_id, "run ID")?;
        let registry = self.load_or_create()?;
        registry
            .runs
            .get(run_id)
            .cloned()
            .ok_or_else(|| KoniError::NotFound(format!("run {run_id}")))
    }

    pub fn run_store(&self, run_id: &str, storage: &StorageConfig) -> Result<StateStore> {
        StateStore::with_storage(self.run_root(run_id)?, storage)
    }

    fn lock(&self) -> Result<ProjectRegistryLock> {
        let sidecar_parent = self.root.parent().ok_or_else(|| {
            KoniError::Action("project registry sidecar has no parent".to_owned())
        })?;
        let trusted_root = sidecar_parent
            .canonicalize()
            .map_err(|error| io_error(sidecar_parent, error))?;
        if trusted_root != sidecar_parent {
            return Err(KoniError::Action(format!(
                "project registry sidecar parent is noncanonical: {}",
                sidecar_parent.display()
            )));
        }
        let relative = self.lock_path.strip_prefix(&trusted_root).map_err(|_| {
            KoniError::Action(format!(
                "project registry lock escapes its trusted root: {}",
                self.lock_path.display()
            ))
        })?;
        let lock = PersistentFileLock::acquire(&trusted_root, relative, LockMode::Blocking)
            .map_err(|error| io_error(&self.lock_path, error))?;
        debug_assert_eq!(lock.path(), self.lock_path);
        Ok(ProjectRegistryLock { _lock: lock })
    }

    fn load_or_create_unlocked(&self) -> Result<ProjectRegistry> {
        if self.registry_path.exists() {
            let registry: ProjectRegistry = read_yaml(&self.registry_path)?;
            if registry.repository_root != self.repository_root {
                return Err(KoniError::Action(format!(
                    "project registry belongs to {}, not {}",
                    registry.repository_root.display(),
                    self.repository_root.display()
                )));
            }
            validate_project_registry(&registry)?;
            return Ok(registry);
        }
        fs::create_dir_all(&self.root).map_err(|error| io_error(&self.root, error))?;
        let registry = ProjectRegistry::new(self.repository_root.clone());
        self.write_unlocked(&registry)?;
        Ok(registry)
    }

    fn write_unlocked(&self, registry: &ProjectRegistry) -> Result<()> {
        atomic_write_yaml(&self.registry_path, registry)
    }
}

struct ProjectRegistryLock {
    _lock: PersistentFileLock,
}

fn validate_registry_id(id: &str, label: &str) -> Result<()> {
    if id.is_empty()
        || matches!(id, "." | "..")
        || !id.bytes().any(|byte| byte.is_ascii_alphanumeric())
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(KoniError::Action(format!("invalid {label}: {id}")));
    }
    Ok(())
}

fn validate_registry_relative_path(path: &Path, label: &str) -> Result<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(KoniError::Action(format!(
            "invalid {label}: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_run_registration(run: &RunRegistration) -> Result<()> {
    validate_registry_id(&run.id, "run ID")?;
    if run
        .run_type_title
        .as_ref()
        .is_some_and(|title| title.trim().is_empty())
    {
        return Err(KoniError::Action(format!(
            "run {} has an empty pinned run type title",
            run.id
        )));
    }
    validate_registry_relative_path(&run.config_snapshot_path, "configuration snapshot path")?;
    for (label, path) in [
        ("planning worktree", run.planning_worktree.as_ref()),
        ("integration worktree", run.integration_worktree.as_ref()),
    ] {
        if path.is_some_and(|path| !path.is_absolute()) {
            return Err(KoniError::Action(format!(
                "{label} must be an absolute path"
            )));
        }
    }
    if run.planning_read_only && run.planning_worktree.is_none() {
        return Err(KoniError::Action(format!(
            "run {} marks a missing planning worktree read-only",
            run.id
        )));
    }
    Ok(())
}

fn validate_project_registry(registry: &ProjectRegistry) -> Result<()> {
    for (run_id, run) in &registry.runs {
        if run_id != &run.id {
            return Err(KoniError::Action(format!(
                "project registry key {run_id} does not match run {}",
                run.id
            )));
        }
        validate_run_registration(run)?;
    }
    if registry
        .selected_run
        .as_ref()
        .is_some_and(|run_id| !registry.runs.contains_key(run_id))
    {
        return Err(KoniError::Action(
            "project registry selects an unknown run".to_owned(),
        ));
    }
    Ok(())
}

fn atomic_write_text(path: &Path, value: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, value).map_err(|error| io_error(&temporary, error))?;
    fs::rename(&temporary, path).map_err(|error| io_error(path, error))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Scope {
    #[serde(default)]
    pub read_nodes: BTreeSet<NodeId>,
    #[serde(default)]
    pub write_nodes: BTreeSet<NodeId>,
    #[serde(default)]
    pub read_paths: BTreeSet<String>,
    #[serde(default)]
    pub write_paths: BTreeSet<String>,
}

impl Scope {
    pub fn write_conflicts(&self, other: &Self) -> bool {
        !self.write_nodes.is_disjoint(&other.write_nodes)
            || !self.write_nodes.is_disjoint(&other.read_nodes)
            || !self.read_nodes.is_disjoint(&other.write_nodes)
            || self.write_paths.iter().any(|left| {
                other
                    .write_paths
                    .iter()
                    .any(|right| paths_overlap(left, right))
                    || other
                        .read_paths
                        .iter()
                        .any(|right| paths_overlap(left, right))
            })
            || self.read_paths.iter().any(|left| {
                other
                    .write_paths
                    .iter()
                    .any(|right| paths_overlap(left, right))
            })
    }
}

fn paths_overlap(left: &str, right: &str) -> bool {
    let left = left.trim_end_matches('/');
    let right = right.trim_end_matches('/');
    left == right
        || left
            .strip_prefix(right)
            .is_some_and(|rest| rest.starts_with('/'))
        || right
            .strip_prefix(left)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TicketChangeControl {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ticket_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_change_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_request: Option<UpstreamChangeRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<UpstreamChangeRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<ChangeControlBlocker>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolved: Vec<ChangeControlResolution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub barriers: Vec<ChangeControlBarrier>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal_approval: Option<ChangeControlApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_change: Option<ApprovedChange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_ticket_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disposition: Option<ChangeControlDisposition>,
}

impl TicketChangeControl {
    pub fn is_empty(&self) -> bool {
        self.source_ticket_id.is_none()
            && self.source_change_request_id.is_none()
            && self.pending_request.is_none()
            && self.request.is_none()
            && self.blocker.is_none()
            && self.resolved.is_empty()
            && self.barriers.is_empty()
            && self.proposal_approval.is_none()
            && self.approved_change.is_none()
            && self.application_ticket_id.is_none()
            && self.disposition.is_none()
    }

    pub fn is_held_source(&self) -> bool {
        self.pending_request.is_some() && self.blocker.is_some()
    }

    /// True when no current change-control authority remains. Append-only
    /// resolutions intentionally do not make an otherwise-obsolete ordinary
    /// ticket live forever after its deriving rule is satisfied.
    pub fn is_inactive_history_only(&self) -> bool {
        self.source_ticket_id.is_none()
            && self.source_change_request_id.is_none()
            && self.pending_request.is_none()
            && self.request.is_none()
            && self.blocker.is_none()
            && self.barriers.is_empty()
            && self.proposal_approval.is_none()
            && self.approved_change.is_none()
            && self.application_ticket_id.is_none()
            && self.disposition.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UpstreamChangeIntent {
    pub target_nodes: Vec<NodeId>,
    pub summary: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpstreamChangeRequest {
    pub schema_version: String,
    pub request_id: String,
    pub request_hash: String,
    pub source_ticket_id: String,
    pub source_step_id: String,
    pub source_context_hash: String,
    pub source_output_id: String,
    pub source_output_hash: String,
    pub source_output_audit_path: PathBuf,
    pub target_nodes: Vec<NodeId>,
    pub summary: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChangeApplicationContract {
    pub schema_version: String,
    pub operation: String,
    pub summary: String,
    pub target_nodes: Vec<NodeId>,
    pub scope: Scope,
    pub source_change_request_id: String,
    pub contract_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChangeControlApproval {
    pub steering_event_id: String,
    pub steering_event_hash: String,
    pub actor: String,
    pub approved_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApprovedChange {
    #[serde(flatten)]
    pub contract: ChangeApplicationContract,
    pub proposal_output_id: String,
    pub proposal_output_hash: String,
    pub review_id: String,
    pub steering_approval: ChangeControlApproval,
    pub approval_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeControlBlocker {
    pub change_request_ticket_id: String,
    pub request_id: String,
    pub source_output_id: String,
    pub source_output_hash: String,
    pub target_nodes: Vec<NodeId>,
    pub reason: String,
    pub recorded_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeControlResolution {
    pub resolved_at: DateTime<Utc>,
    pub blocker: ChangeControlBlocker,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale_lease: Option<Lease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_archive: Option<ChangeControlAuthorityArchive>,
    pub disposition: ChangeControlDisposition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChangeControlAuthorityArchive {
    pub reference: String,
    pub commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ChangeControlDisposition {
    Rejected {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        steering_event_id: Option<String>,
        at: DateTime<Utc>,
    },
    NoOp {
        approval_hash: String,
        at: DateTime<Utc>,
    },
    Applied {
        application_ticket_id: String,
        approval_hash: String,
        at: DateTime<Utc>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChangeControlBarrier {
    pub ticket_id: String,
    pub source_change_request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_hash: Option<String>,
    pub operation: String,
    pub status: String,
    pub overlap_node_ids: Vec<NodeId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticket {
    pub schema_version: String,
    pub id: String,
    pub operation: String,
    pub status: String,
    pub title: String,
    #[serde(default)]
    pub target_nodes: Vec<NodeId>,
    #[serde(default)]
    pub scope: Scope,
    pub source_state_key: String,
    pub target_state_key: String,
    #[serde(default)]
    pub obligation_keys: Vec<String>,
    pub profile_hash: String,
    pub rule_id: String,
    #[serde(default)]
    pub workflow: Vec<Step>,
    #[serde(default)]
    pub outputs: Vec<StepOutput>,
    #[serde(default)]
    pub reviews: Vec<Review>,
    #[serde(default)]
    pub blockers: Vec<Blocker>,
    #[serde(default)]
    pub lease: Option<Lease>,
    #[serde(default, skip_serializing_if = "TicketChangeControl::is_empty")]
    pub change_control: TicketChangeControl,
    #[serde(default)]
    pub extensions: BTreeMap<String, Value>,
}

impl Ticket {
    pub fn deterministic_id(
        rule_id: &str,
        targets: &[NodeId],
        source_state_key: &str,
        profile_hash: &str,
    ) -> String {
        let hash = normalized_hash(&(rule_id, targets, source_state_key, profile_hash));
        format!("TK-{}", &hash["sha256:".len()..][..16])
    }

    pub fn required_steps_complete(&self) -> bool {
        self.workflow
            .iter()
            .filter(|step| step.required && step.kind != StepKind::Review)
            .all(|step| {
                self.outputs.iter().any(|output| {
                    output.step_id == step.id && output.context_hash == step.context_hash
                })
            })
    }

    pub fn review_passed(&self) -> bool {
        let required_review_steps = self
            .workflow
            .iter()
            .filter(|step| step.required && step.kind == StepKind::Review)
            .collect::<Vec<_>>();
        if required_review_steps.is_empty() {
            return self.reviews.last().is_some_and(|review| {
                review.status == "passed" && review.output_hash == normalized_hash(&self.outputs)
            });
        }
        let current_output_hash = normalized_hash(&self.outputs);
        required_review_steps.iter().all(|step| {
            self.reviews.iter().rev().any(|review| {
                review.status == "passed"
                    && review.output_hash == current_output_hash
                    && review
                        .agent_binding
                        .as_ref()
                        .is_some_and(|binding| binding.step_id == step.id)
            })
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    pub persona: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default = "default_true")]
    pub required: bool,
    #[serde(default)]
    pub kind: StepKind,
    #[serde(default)]
    pub expected_outputs: Vec<String>,
    #[serde(default)]
    pub required_receipts: Vec<String>,
    #[serde(default)]
    pub validation_checks: Vec<String>,
    #[serde(default)]
    pub escalation_triggers: Vec<String>,
    #[serde(default)]
    pub stop_conditions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_action: Option<String>,
    #[serde(default)]
    pub context_hash: String,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    #[default]
    Production,
    Integration,
    Review,
    Agent,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepOutput {
    pub id: String,
    pub step_id: String,
    pub persona: String,
    pub context_hash: String,
    pub recorded_at: DateTime<Utc>,
    #[serde(default)]
    pub files_read: Vec<String>,
    #[serde(default)]
    pub files_written: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files_deleted: Vec<String>,
    #[serde(default)]
    pub findings: Vec<String>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub receipts: Vec<String>,
    #[serde(default)]
    pub patch_proposal: String,
    #[serde(default)]
    pub recommended_next_step: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_change: Option<UpstreamChangeIntent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_application: Option<ChangeApplicationContract>,
    #[serde(default)]
    pub typed: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Review {
    pub id: String,
    pub status: String,
    pub notes: String,
    pub reviewed_at: DateTime<Utc>,
    pub ticket_hash: String,
    pub output_hash: String,
    /// Compiler-owned provenance for a configured review-step agent. Legacy
    /// workflows without a review step may omit this, but a configured review
    /// can only pass integration when this binding is present and revalidates
    /// against the durable control-plane agent record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_binding: Option<ReviewAgentBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewAgentBinding {
    pub agent_id: String,
    pub step_id: String,
    pub persona: String,
    pub input_hash: String,
    pub output_hash: String,
    #[serde(default)]
    pub findings: Vec<String>,
    #[serde(default)]
    pub evidence_pointers: Vec<String>,
    /// Hash of the compiler-owned review-effect application, when configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_effects_hash: Option<String>,
    /// Exact compiler-authored effect application. The hash above binds this
    /// payload; git-common-dir backends replay it into the integration
    /// projection without granting an agent authority over the fields.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_effects: Option<Value>,
    /// Semantic graph hash after the compiler atomically applied the effects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_effect_graph_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Blocker {
    pub kind: String,
    pub message: String,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub related_ticket: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lease {
    pub id: String,
    pub branch: String,
    pub worktree: PathBuf,
    pub base_commit: String,
    pub started_at: DateTime<Utc>,
    pub heartbeat_at: DateTime<Utc>,
    #[serde(default)]
    pub worker_pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub schema_version: String,
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub at: DateTime<Utc>,
    pub run_id: String,
    #[serde(default)]
    pub ticket_id: Option<String>,
    #[serde(default)]
    pub actor: String,
    #[serde(default)]
    pub data: Value,
}

impl Event {
    pub fn new(
        run_id: &str,
        event_type: impl Into<String>,
        ticket_id: Option<String>,
        data: Value,
    ) -> Self {
        Self {
            schema_version: "1.0".to_owned(),
            id: Uuid::now_v7().to_string(),
            event_type: event_type.into(),
            at: Utc::now(),
            run_id: run_id.to_owned(),
            ticket_id,
            actor: "compiler".to_owned(),
            data,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Journal {
    pub id: String,
    pub action: String,
    /// Stable action or pipeline-stage input binding used to reconcile a
    /// completed journal without repeating side effects.
    #[serde(default)]
    pub input_hash: Option<String>,
    pub status: JournalStatus,
    pub started_at: DateTime<Utc>,
    pub profile_hash: String,
    pub completed_steps: Vec<usize>,
    #[serde(default)]
    pub outputs: BTreeMap<String, Value>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JournalStatus {
    Running,
    Compensating,
    Failed,
    /// An explicit configured recovery action acknowledged and reconciled the
    /// failed attempt. The historical error is retained, but it no longer
    /// blocks a fresh correlated attempt.
    Recovered,
    Complete,
}

#[derive(Debug, Clone)]
pub struct StateStore {
    root: PathBuf,
    graph_dir: PathBuf,
    tickets_dir: PathBuf,
    state_path: PathBuf,
    work_dir: PathBuf,
    receipts_dir: PathBuf,
    reports_dir: PathBuf,
}

impl StateStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            graph_dir: root.join("graph"),
            tickets_dir: root.join("tickets"),
            state_path: root.join("run.yaml"),
            work_dir: root.join("work"),
            receipts_dir: root.join("receipts"),
            reports_dir: root.join("reports"),
            root,
        }
    }

    pub fn with_storage(root: PathBuf, storage: &StorageConfig) -> Result<Self> {
        let prefix = storage
            .state_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let relative = |path: &Path| {
            if prefix == Path::new(".") {
                Ok(path.to_path_buf())
            } else {
                path.strip_prefix(prefix)
                    .map(Path::to_path_buf)
                    .map_err(|_| {
                        KoniError::Profile(format!(
                            "configured state path {} is outside state root {}",
                            path.display(),
                            prefix.display()
                        ))
                    })
            }
        };
        Ok(Self {
            graph_dir: root.join(relative(&storage.graph_dir)?),
            tickets_dir: root.join(relative(&storage.tickets_dir)?),
            state_path: root.join(relative(&storage.state_path)?),
            work_dir: root.join(relative(&storage.work_dir)?),
            receipts_dir: root.join(relative(&storage.receipts_dir)?),
            reports_dir: root.join(relative(&storage.reports_dir)?),
            root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Files used only to coordinate live StateStore processes.
    ///
    /// These paths are intentionally absolute because the store can be backed
    /// by either a tracked checkout or a Git-common-dir sidecar. Callers that
    /// publish a Git tree must prove the paths belong to that checkout before
    /// converting them to repository-relative tree exclusions.
    pub fn transient_paths(&self) -> Vec<PathBuf> {
        vec![self.root.join("locks")]
    }

    pub fn ensure_layout(&self) -> Result<()> {
        for directory in [
            self.graph_dir(),
            self.tickets_dir.clone(),
            self.work_dir.join("tickets"),
            self.receipts_dir.clone(),
            self.reports_dir.clone(),
            self.root.join("snapshots"),
            self.root.join("journals"),
        ] {
            fs::create_dir_all(&directory).map_err(|error| io_error(&directory, error))?;
        }
        Ok(())
    }

    pub fn graph_dir(&self) -> PathBuf {
        self.graph_dir.clone()
    }

    pub fn tickets_dir(&self) -> &Path {
        &self.tickets_dir
    }

    pub(crate) fn ticket_path(&self, ticket: &Ticket) -> PathBuf {
        self.tickets_dir
            .join(&ticket.status)
            .join(format!("{}.yaml", ticket.id))
    }

    pub fn work_dir(&self) -> &Path {
        &self.work_dir
    }

    pub fn receipts_dir(&self) -> &Path {
        &self.receipts_dir
    }

    pub fn reports_dir(&self) -> &Path {
        &self.reports_dir
    }

    pub fn manifest_path(&self) -> &Path {
        &self.state_path
    }

    pub fn graph(&self) -> Result<Graph> {
        Graph::load(&self.graph_dir())
    }

    pub fn write_manifest(&self, manifest: &RunManifest) -> Result<()> {
        validate_manifest_pins(manifest)?;
        if self.state_path.exists() {
            let existing: RunManifest = read_yaml(&self.state_path)?;
            validate_manifest_immutable_inputs(&existing, manifest)?;
        }
        atomic_write_yaml(&self.state_path, manifest)
    }

    pub fn manifest(&self) -> Result<RunManifest> {
        read_yaml(&self.state_path)
    }

    pub fn write_ticket(&self, ticket: &Ticket) -> Result<()> {
        let directory = self.tickets_dir.join(&ticket.status);
        fs::create_dir_all(&directory).map_err(|error| io_error(&directory, error))?;
        for entry in
            fs::read_dir(&self.tickets_dir).map_err(|error| io_error(&self.tickets_dir, error))?
        {
            let entry = entry.map_err(|error| io_error(&self.tickets_dir, error))?;
            if entry
                .file_type()
                .map_err(|error| io_error(entry.path(), error))?
                .is_dir()
            {
                let old = entry.path().join(format!("{}.yaml", ticket.id));
                if old.exists() && old.parent() != Some(directory.as_path()) {
                    fs::remove_file(&old).map_err(|error| io_error(&old, error))?;
                }
            }
        }
        atomic_write_yaml(&directory.join(format!("{}.yaml", ticket.id)), ticket)
    }

    pub fn tickets(&self) -> Result<Vec<Ticket>> {
        let root = self.tickets_dir.clone();
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut tickets: Vec<Ticket> = Vec::new();
        for status in fs::read_dir(&root).map_err(|error| io_error(&root, error))? {
            let status = status.map_err(|error| io_error(&root, error))?;
            if !status
                .file_type()
                .map_err(|error| io_error(status.path(), error))?
                .is_dir()
            {
                continue;
            }
            for path in
                fs::read_dir(status.path()).map_err(|error| io_error(status.path(), error))?
            {
                let path = path.map_err(|error| io_error(status.path(), error))?.path();
                if path.extension().and_then(|value| value.to_str()) == Some("yaml") {
                    tickets.push(read_yaml(&path)?);
                }
            }
        }
        tickets.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(tickets)
    }

    pub fn ticket(&self, ticket_id: &str) -> Result<Ticket> {
        self.tickets()?
            .into_iter()
            .find(|ticket| ticket.id == ticket_id)
            .ok_or_else(|| KoniError::NotFound(format!("ticket {ticket_id}")))
    }

    /// Remove one materialized ticket from every configured lifecycle lane.
    /// Historical copies should be persisted by the caller before invoking
    /// this compiler-owned destructive primitive.
    pub fn remove_ticket(&self, ticket_id: &str) -> Result<bool> {
        let mut removed = false;
        if !self.tickets_dir.exists() {
            return Ok(false);
        }
        for entry in
            fs::read_dir(&self.tickets_dir).map_err(|error| io_error(&self.tickets_dir, error))?
        {
            let entry = entry.map_err(|error| io_error(&self.tickets_dir, error))?;
            if !entry
                .file_type()
                .map_err(|error| io_error(entry.path(), error))?
                .is_dir()
            {
                continue;
            }
            let path = entry.path().join(format!("{ticket_id}.yaml"));
            if path.exists() {
                fs::remove_file(&path).map_err(|error| io_error(&path, error))?;
                removed = true;
            }
        }
        Ok(removed)
    }

    pub fn append_event(&self, event: &Event) -> Result<()> {
        let path = self.root.join("events.jsonl");
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| io_error(&path, error))?;
        serde_json::to_writer(&mut file, event).map_err(|source| KoniError::Json {
            path: path.clone(),
            source,
        })?;
        writeln!(file).map_err(|error| io_error(&path, error))?;
        file.sync_data().map_err(|error| io_error(&path, error))?;
        Ok(())
    }

    pub fn events(&self) -> Result<Vec<Event>> {
        let path = self.root.join("events.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let file = File::open(&path).map_err(|error| io_error(&path, error))?;
        BufReader::new(file)
            .lines()
            .filter(|line| line.as_ref().map_or(true, |line| !line.trim().is_empty()))
            .map(|line| {
                let line = line.map_err(|error| io_error(&path, error))?;
                serde_json::from_str(&line).map_err(|source| KoniError::Json {
                    path: path.clone(),
                    source,
                })
            })
            .collect()
    }

    pub fn write_journal(&self, journal: &Journal) -> Result<()> {
        atomic_write_yaml(
            &self
                .root
                .join("journals")
                .join(format!("{}.yaml", journal.id)),
            journal,
        )
    }

    pub fn incomplete_journals(&self) -> Result<Vec<Journal>> {
        Ok(self
            .journals()?
            .into_iter()
            .filter(|journal| {
                matches!(
                    journal.status,
                    JournalStatus::Running | JournalStatus::Compensating
                )
            })
            .collect())
    }

    pub fn failed_journals(&self) -> Result<Vec<Journal>> {
        Ok(self
            .journals()?
            .into_iter()
            .filter(|journal| journal.status == JournalStatus::Failed)
            .collect())
    }

    pub fn journals(&self) -> Result<Vec<Journal>> {
        let directory = self.root.join("journals");
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut output = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|error| io_error(&directory, error))? {
            let path = entry.map_err(|error| io_error(&directory, error))?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("yaml") {
                continue;
            }
            let journal: Journal = read_yaml(&path)?;
            output.push(journal);
        }
        output.sort_by_key(|journal| journal.started_at);
        Ok(output)
    }

    pub fn lock(&self, name: &str) -> Result<StateLock> {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(KoniError::Action(format!(
                "invalid state lock name: {name}"
            )));
        }
        if !self.root.is_dir() {
            return Err(KoniError::Action(format!(
                "state store disappeared before lock acquisition: {}",
                self.root.display()
            )));
        }
        let canonical_root = self
            .root
            .canonicalize()
            .map_err(|error| io_error(&self.root, error))?;
        let identity = exact_path_identity(&canonical_root);
        let git_common_run_sidecar = canonical_root
            .parent()
            .filter(|parent| parent.file_name().and_then(|name| name.to_str()) == Some("runs"))
            .and_then(Path::parent)
            .filter(|sidecar| sidecar.file_name().and_then(|name| name.to_str()) == Some("koni"))
            .filter(|sidecar| {
                sidecar.parent().is_some_and(|common| {
                    common.join("HEAD").is_file()
                        && common.join("objects").is_dir()
                        && common.join("refs").is_dir()
                })
            });
        let (trusted_root, relative_directory) = if let Some(sidecar) = git_common_run_sidecar {
            let trusted_root = sidecar.parent().ok_or_else(|| {
                KoniError::Action("Git-common state sidecar has no parent".to_owned())
            })?;
            (
                trusted_root.to_path_buf(),
                PathBuf::from("koni").join("state-locks").join(&identity),
            )
        } else {
            match GitBackend::discover(&canonical_root) {
                Ok(git) => (
                    git.common_dir().to_path_buf(),
                    PathBuf::from("koni").join("state-locks").join(&identity),
                ),
                Err(KoniError::Git(error)) if error.code() == git2::ErrorCode::NotFound => {
                    (canonical_root.clone(), PathBuf::from("locks"))
                }
                Err(error) => return Err(error),
            }
        };
        let relative = relative_directory.join(format!("{name}.lock"));
        let path = trusted_root.join(&relative);
        let lock = match PersistentFileLock::acquire(&trusted_root, &relative, LockMode::Try) {
            Ok(lock) => lock,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return Err(KoniError::Action(format!("lock {name} is held: {error}")));
            }
            Err(error) => return Err(io_error(&path, error)),
        };
        Ok(StateLock { _lock: lock })
    }
}

pub struct StateLock {
    _lock: PersistentFileLock,
}

fn validate_manifest_pins(manifest: &RunManifest) -> Result<()> {
    if manifest
        .run_type_title
        .as_ref()
        .is_some_and(|title| title.trim().is_empty())
    {
        return Err(KoniError::Action(format!(
            "run {} has an empty pinned run type title",
            manifest.id
        )));
    }
    if let (Some(base_commit), Some(integration_base)) =
        (&manifest.base_commit, &manifest.integration_base)
        && base_commit != integration_base
    {
        return Err(KoniError::Action(format!(
            "run {} has inconsistent immutable base commits",
            manifest.id
        )));
    }
    if manifest.config_snapshot_hash.is_some() != manifest.config_snapshot_path.is_some() {
        return Err(KoniError::Action(format!(
            "run {} must pin both configuration snapshot hash and path",
            manifest.id
        )));
    }
    Ok(())
}

fn validate_manifest_immutable_inputs(existing: &RunManifest, next: &RunManifest) -> Result<()> {
    let stable_identity = existing.id == next.id
        && existing.profile_id == next.profile_id
        && existing.profile_version == next.profile_version
        && existing.profile_hash == next.profile_hash
        && existing.repository_root == next.repository_root
        && existing.created_at == next.created_at;
    let pinned_field_unchanged = |old: &Option<String>, new: &Option<String>| {
        old.as_ref().is_none_or(|old| new.as_ref() == Some(old))
    };
    let pinned_path_unchanged = |old: &Option<PathBuf>, new: &Option<PathBuf>| {
        old.as_ref().is_none_or(|old| new.as_ref() == Some(old))
    };
    if !stable_identity
        || !pinned_field_unchanged(&existing.run_type_id, &next.run_type_id)
        || !pinned_field_unchanged(&existing.run_type_title, &next.run_type_title)
        || !pinned_field_unchanged(&existing.run_type_hash, &next.run_type_hash)
        || !pinned_field_unchanged(&existing.question_policy, &next.question_policy)
        || !pinned_field_unchanged(&existing.integration_branch, &next.integration_branch)
        || !pinned_field_unchanged(&existing.integration_base, &next.integration_base)
        || !pinned_field_unchanged(&existing.base_commit, &next.base_commit)
        || !pinned_field_unchanged(&existing.config_snapshot_hash, &next.config_snapshot_hash)
        || !pinned_path_unchanged(&existing.config_snapshot_path, &next.config_snapshot_path)
        || !pinned_path_unchanged(&existing.integration_worktree, &next.integration_worktree)
    {
        return Err(KoniError::Action(format!(
            "run {} immutable identity/base/configuration inputs cannot change",
            existing.id
        )));
    }
    Ok(())
}

fn read_yaml<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let text = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    serde_yaml::from_str(&text).map_err(|source| KoniError::Yaml {
        path: path.to_path_buf(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt, symlink};

    #[test]
    fn scope_conflicts_are_symmetric() {
        let first = Scope {
            write_paths: BTreeSet::from(["packages/core".to_owned()]),
            ..Scope::default()
        };
        let second = Scope {
            read_paths: BTreeSet::from(["packages/core/src/index.ts".to_owned()]),
            ..Scope::default()
        };
        assert!(first.write_conflicts(&second));
        assert!(second.write_conflicts(&first));
    }

    #[test]
    fn ticket_ids_are_deterministic() {
        let targets = vec!["node-a".to_owned()];
        assert_eq!(
            Ticket::deterministic_id("rule", &targets, "missing", "profile"),
            Ticket::deterministic_id("rule", &targets, "missing", "profile")
        );
    }

    #[test]
    fn state_round_trips_ticket_lanes() {
        let temp = tempfile::tempdir().unwrap();
        let store = StateStore::new(temp.path().to_path_buf());
        store.ensure_layout().unwrap();
        let mut ticket = Ticket {
            schema_version: "1.0".to_owned(),
            id: "TK-test".to_owned(),
            operation: "test".to_owned(),
            status: "todo".to_owned(),
            title: "Test".to_owned(),
            target_nodes: Vec::new(),
            scope: Scope::default(),
            source_state_key: "missing".to_owned(),
            target_state_key: "present".to_owned(),
            obligation_keys: Vec::new(),
            profile_hash: "hash".to_owned(),
            rule_id: "rule".to_owned(),
            workflow: Vec::new(),
            outputs: Vec::new(),
            reviews: Vec::new(),
            blockers: Vec::new(),
            lease: None,
            change_control: TicketChangeControl::default(),
            extensions: BTreeMap::new(),
        };
        store.write_ticket(&ticket).unwrap();
        ticket.status = "in_progress".to_owned();
        store.write_ticket(&ticket).unwrap();
        let tickets = store.tickets().unwrap();
        assert_eq!(tickets.len(), 1);
        assert_eq!(tickets[0].status, "in_progress");
    }

    #[test]
    fn state_round_trips_typed_change_request_and_approval_bindings() {
        let request = UpstreamChangeRequest {
            schema_version: "1.0".to_owned(),
            request_id: "UCR-request".to_owned(),
            request_hash: "sha256:request".to_owned(),
            source_ticket_id: "TK-source".to_owned(),
            source_step_id: "discover".to_owned(),
            source_context_hash: "sha256:context".to_owned(),
            source_output_id: "OUT-source".to_owned(),
            source_output_hash: "sha256:output".to_owned(),
            source_output_audit_path: PathBuf::from(
                "work/tickets/TK-source/audit/upstream-change-requests/OUT-source.yaml",
            ),
            target_nodes: vec!["claim-a".to_owned(), "hypothesis-a".to_owned()],
            summary: "Repair upstream semantics".to_owned(),
            reason: "Downstream work exposed a bounded contradiction".to_owned(),
        };
        let approved = ApprovedChange {
            contract: ChangeApplicationContract {
                schema_version: "1.0".to_owned(),
                operation: "apply-change-request".to_owned(),
                summary: "Apply the approved semantic repair".to_owned(),
                target_nodes: vec!["claim-a".to_owned()],
                scope: Scope {
                    write_nodes: BTreeSet::from(["claim-a".to_owned()]),
                    ..Scope::default()
                },
                source_change_request_id: request.request_id.clone(),
                contract_hash: "sha256:contract".to_owned(),
            },
            proposal_output_id: "OUT-proposal".to_owned(),
            proposal_output_hash: "sha256:proposal".to_owned(),
            review_id: "REV-lead".to_owned(),
            steering_approval: ChangeControlApproval {
                steering_event_id: "EV-approve".to_owned(),
                steering_event_hash: "sha256:steering".to_owned(),
                actor: "lead".to_owned(),
                approved_at: Utc::now(),
            },
            approval_hash: "sha256:approval".to_owned(),
        };
        let mut ticket: Ticket = serde_json::from_value(serde_json::json!({
            "schema_version": "1.0",
            "id": "TK-change-request",
            "operation": "change-request",
            "status": "todo",
            "title": "Change request",
            "source_state_key": "proposed",
            "target_state_key": "closed",
            "profile_hash": "sha256:profile",
            "rule_id": "change-control"
        }))
        .unwrap();
        ticket.change_control.request = Some(request.clone());
        ticket.change_control.approved_change = Some(approved.clone());

        let yaml = serde_yaml::to_string(&ticket).unwrap();
        let restored: Ticket = serde_yaml::from_str(&yaml).unwrap();

        assert_eq!(restored.change_control.request, Some(request));
        assert_eq!(restored.change_control.approved_change, Some(approved));
        assert!(yaml.contains("source_output_audit_path:"));
        assert!(yaml.contains("proposal_output_hash: sha256:proposal"));
    }

    #[cfg(unix)]
    #[test]
    fn state_lock_is_one_persistent_sidecar_inode_without_product_dirt() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir(&project).unwrap();
        let repository = git2::Repository::init(&project).unwrap();
        let state_root = project.join("program");
        fs::create_dir(&state_root).unwrap();
        fs::write(project.join("baseline.txt"), "baseline\n").unwrap();
        let mut index = repository.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        let tree_id = index.write_tree().unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Koni", "test@example.local").unwrap();
        repository
            .commit(Some("HEAD"), &signature, &signature, "baseline", &tree, &[])
            .unwrap();
        drop(tree);

        let backend = GitBackend::discover(&project).unwrap();
        let before = backend.status(&[]).unwrap();
        let canonical_state = state_root.canonicalize().unwrap();
        let lock_path = backend
            .sidecar_root()
            .join("state-locks")
            .join(exact_path_identity(&canonical_state))
            .join("compiler.lock");
        let store = StateStore::new(state_root.clone());
        let first = store.lock("compiler").unwrap();
        let inode = lock_path.metadata().unwrap().ino();
        assert!(store.lock("compiler").is_err());
        drop(first);
        assert_eq!(lock_path.metadata().unwrap().ino(), inode);
        let second = store.lock("compiler").unwrap();
        drop(second);
        assert_eq!(lock_path.metadata().unwrap().ino(), inode);
        assert!(!state_root.join("locks").exists());
        assert_eq!(backend.status(&[]).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn state_lock_rejects_precreated_parent_and_final_symlink_sentinels() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let state_root = project.join("program");
        fs::create_dir_all(&state_root).unwrap();
        git2::Repository::init(&project).unwrap();
        let backend = GitBackend::discover(&project).unwrap();
        let identity = exact_path_identity(&state_root.canonicalize().unwrap());
        let outside = temp.path().join("outside");
        fs::create_dir_all(outside.join("state-locks").join(&identity)).unwrap();
        symlink(&outside, backend.sidecar_root()).unwrap();
        let store = StateStore::new(state_root);
        assert!(store.lock("compiler").is_err());
        assert!(
            !outside
                .join("state-locks")
                .join(&identity)
                .join("compiler.lock")
                .exists()
        );

        fs::remove_file(backend.sidecar_root()).unwrap();
        let lock_directory = backend.sidecar_root().join("state-locks").join(&identity);
        fs::create_dir_all(&lock_directory).unwrap();
        let sentinel = outside.join("sentinel");
        fs::write(&sentinel, "unchanged").unwrap();
        symlink(&sentinel, lock_directory.join("compiler.lock")).unwrap();
        assert!(store.lock("compiler").is_err());
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "unchanged");
    }

    #[cfg(unix)]
    #[test]
    fn non_git_state_lock_fallback_is_persistent_and_never_creates_a_missing_store() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("store");
        fs::create_dir(&root).unwrap();
        let store = StateStore::new(root.clone());
        let first = store.lock("compiler").unwrap();
        let path = root.join("locks/compiler.lock");
        let inode = path.metadata().unwrap().ino();
        drop(first);
        let second = store.lock("compiler").unwrap();
        drop(second);
        assert_eq!(path.metadata().unwrap().ino(), inode);

        let missing = temp.path().join("missing");
        assert!(StateStore::new(missing.clone()).lock("compiler").is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn manifest_pins_base_and_configuration_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        fs::create_dir(&config).unwrap();
        fs::write(config.join("koni.toml"), "schema_version = '1.0'\n").unwrap();
        let run_root = temp.path().join("run");
        fs::create_dir(&run_root).unwrap();
        let snapshot = ConfigSnapshot::capture(&config, &run_root).unwrap();
        assert!(run_root.join("config-snapshot/koni.toml").is_file());
        snapshot.verify(&run_root).unwrap();
        assert_eq!(ConfigSnapshot::load_verified(&run_root).unwrap(), snapshot);

        let store = StateStore::new(run_root);
        let mut manifest = RunManifest::new(
            "profile",
            "1.0.0",
            "sha256:profile",
            "Pinned run",
            temp.path().to_path_buf(),
        );
        manifest.pin_inputs("0123456789abcdef", &snapshot);
        manifest.attach_planning_worktree(temp.path().join("planning"));
        let registration =
            RunRegistration::planning(&manifest, &snapshot, "pinned-run".to_owned()).unwrap();
        assert!(registration.planning_read_only);
        store.write_manifest(&manifest).unwrap();
        manifest.status = "paused".to_owned();
        store.write_manifest(&manifest).unwrap();
        manifest.record_approval(
            "refs/heads/koni/runs/pinned-run-abcdef01".to_owned(),
            temp.path().join("integration"),
        );
        store.write_manifest(&manifest).unwrap();

        manifest.base_commit = Some("different".to_owned());
        assert!(store.write_manifest(&manifest).is_err());
        let persisted = store.manifest().unwrap();
        assert_eq!(persisted.base_commit.as_deref(), Some("0123456789abcdef"));
        assert_eq!(persisted.config_snapshot_hash, Some(snapshot.hash.clone()));
        assert!(persisted.planning_worktree.is_none());
        assert!(!persisted.planning_read_only);

        fs::write(
            store.root().join("config-snapshot/koni.toml"),
            "changed = true\n",
        )
        .unwrap();
        assert!(snapshot.verify(store.root()).is_err());
    }

    #[test]
    fn run_construction_can_finalize_one_captured_yaml_override() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let source = project.join(".codex/koni/run-types");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("medium.yaml"),
            "schema_version: '1.0'\nid: medium\ntitle: Before\n",
        )
        .unwrap();
        let run_root = temp.path().join("run");
        fs::create_dir(&run_root).unwrap();
        let mut snapshot =
            ConfigSnapshot::capture_project_configuration(&project, &run_root).unwrap();
        let original_hash = snapshot.hash.clone();

        snapshot
            .finalize_project_yaml_override(
                &run_root,
                Path::new(".codex/koni/run-types/medium.yaml"),
                &serde_json::json!({
                    "schema_version": "1.0",
                    "id": "medium",
                    "title": "After",
                }),
            )
            .unwrap();

        assert_ne!(snapshot.hash, original_hash);
        assert_eq!(ConfigSnapshot::load_verified(&run_root).unwrap(), snapshot);
        let updated =
            fs::read_to_string(run_root.join("config-snapshot/.codex/koni/run-types/medium.yaml"))
                .unwrap();
        assert!(updated.contains("title: After"), "{updated}");
    }

    #[cfg(unix)]
    #[test]
    fn project_snapshot_pins_native_codex_resources_and_resolves_skill_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir_all(project.join(".codex/koni")).unwrap();
        fs::write(
            project.join(".codex/koni/profile.yaml"),
            "schema_version: '1.0'\n",
        )
        .unwrap();
        fs::write(
            project.join(".codex/config.toml"),
            "[agents]\nmax_threads = 4\n",
        )
        .unwrap();
        fs::create_dir_all(project.join(".codex/agents")).unwrap();
        fs::write(
            project.join(".codex/agents/reviewer.toml"),
            "name = 'reviewer'\ndescription = 'Review'\ndeveloper_instructions = 'Inspect'\n",
        )
        .unwrap();
        fs::write(project.join(".codex/unrelated.txt"), "not snapshotted\n").unwrap();

        let shared = temp.path().join("shared/review");
        fs::create_dir_all(&shared).unwrap();
        fs::write(
            shared.join("SKILL.md"),
            "---\nname: review\ndescription: Review\n---\nInspect\n",
        )
        .unwrap();
        fs::create_dir_all(project.join(".agents/skills")).unwrap();
        symlink(&shared, project.join(".agents/skills/review")).unwrap();

        let run_root = temp.path().join("run");
        fs::create_dir(&run_root).unwrap();
        let snapshot = ConfigSnapshot::capture_project_configuration(&project, &run_root).unwrap();
        let snapshot_root = run_root.join("config-snapshot");
        assert!(snapshot_root.join(".codex/config.toml").is_file());
        assert!(snapshot_root.join(".codex/agents/reviewer.toml").is_file());
        assert!(
            snapshot_root
                .join(".agents/skills/review/SKILL.md")
                .is_file()
        );
        assert!(!snapshot_root.join(".agents/skills/review").is_symlink());
        assert!(!snapshot_root.join(".codex/unrelated.txt").exists());
        snapshot.verify(&run_root).unwrap();

        fs::write(shared.join("SKILL.md"), "changed outside the snapshot\n").unwrap();
        snapshot.verify(&run_root).unwrap();
    }

    #[test]
    fn project_registry_persists_concurrent_runs_without_singleton_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let repository_root = temp.path().join("project");
        fs::create_dir(&repository_root).unwrap();
        fs::create_dir(temp.path().join("git-common")).unwrap();
        let registry = Arc::new(
            ProjectRegistryStore::new(temp.path().join("git-common/koni"), repository_root)
                .unwrap(),
        );
        assert!(registry.run_root("..").is_err());
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for index in 0..2 {
            let registry = Arc::clone(&registry);
            let barrier = Arc::clone(&barrier);
            threads.push(std::thread::spawn(move || {
                let id = format!("run-{index}");
                barrier.wait();
                registry
                    .register_run(RunRegistration {
                        id: id.clone(),
                        slug: format!("goal-{index}"),
                        goal: format!("Goal {index}"),
                        profile_id: "profile".to_owned(),
                        profile_version: "1.0.0".to_owned(),
                        profile_hash: "sha256:profile".to_owned(),
                        run_type_id: None,
                        run_type_title: None,
                        run_type_hash: None,
                        question_policy: None,
                        base_commit: "base".to_owned(),
                        config_snapshot_hash: "sha256:config".to_owned(),
                        config_snapshot_path: PathBuf::from("config-snapshot"),
                        status: RunRegistrationStatus::Planning,
                        planning_worktree: None,
                        planning_read_only: false,
                        integration_branch: None,
                        integration_worktree: None,
                        created_at: Utc::now(),
                        updated_at: Utc::now(),
                    })
                    .unwrap();
                id
            }));
        }
        barrier.wait();
        let ids: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        let persisted = registry.load_or_create().unwrap();
        assert_eq!(persisted.runs.len(), 2);
        assert!(ids.iter().all(|id| persisted.runs.contains_key(id)));

        registry.select_run(&ids[0]).unwrap();
        let after_selection = registry.load_or_create().unwrap();
        assert_eq!(
            after_selection.selected_run.as_deref(),
            Some(ids[0].as_str())
        );
        assert_eq!(after_selection.runs.len(), 2);
        assert_eq!(
            fs::read_to_string(registry.root().join("runs/current")).unwrap(),
            format!("{}\n", ids[0])
        );
        let approved = registry
            .approve_run(
                &ids[1],
                "refs/heads/koni/runs/goal-1-short".to_owned(),
                registry.run_root(&ids[1]).unwrap().join("integration"),
            )
            .unwrap();
        assert_eq!(approved.status, RunRegistrationStatus::Approved);
        assert!(approved.planning_worktree.is_none());
        assert!(!approved.planning_read_only);
        let mut changed_approval = approved.clone();
        changed_approval.integration_branch = Some("refs/heads/other".to_owned());
        assert!(registry.update_run(changed_approval).is_err());
        assert_eq!(
            registry.run(&ids[0]).unwrap().status,
            RunRegistrationStatus::Planning
        );

        let removed = registry.unregister_run(&ids[0]).unwrap().unwrap();
        assert_eq!(removed.id, ids[0]);
        let after_unregister = registry.load_or_create().unwrap();
        assert_eq!(after_unregister.runs.len(), 1);
        assert_eq!(
            after_unregister.selected_run.as_deref(),
            Some(ids[1].as_str())
        );
        assert_eq!(
            fs::read_to_string(registry.root().join("runs/current")).unwrap(),
            format!("{}\n", ids[1])
        );
        assert!(registry.unregister_run(&ids[0]).unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn project_registry_lock_rejects_parent_and_final_symlink_sentinels() {
        let temp = tempfile::tempdir().unwrap();
        let repository_root = temp.path().join("project");
        let common = temp.path().join("git-common");
        let sidecar = common.join("koni");
        let outside = temp.path().join("outside");
        fs::create_dir(&repository_root).unwrap();
        fs::create_dir(&common).unwrap();
        fs::create_dir_all(outside.join("locks")).unwrap();
        symlink(&outside, &sidecar).unwrap();
        let registry = ProjectRegistryStore::new(sidecar.clone(), repository_root.clone()).unwrap();
        assert!(registry.load_or_create().is_err());
        assert!(!outside.join("locks/project-registry.lock").exists());

        fs::remove_file(&sidecar).unwrap();
        fs::create_dir_all(sidecar.join("locks")).unwrap();
        let sentinel = outside.join("sentinel");
        fs::write(&sentinel, "unchanged").unwrap();
        symlink(&sentinel, sidecar.join("locks/project-registry.lock")).unwrap();
        let registry = ProjectRegistryStore::new(sidecar, repository_root).unwrap();
        assert!(registry.load_or_create().is_err());
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "unchanged");
    }
}
