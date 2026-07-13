//! Git operations used by Koni.
//!
//! This module deliberately uses `git2`/libgit2 instead of shelling out to the
//! Git porcelain.  The important consequence is that commits and checkouts do
//! **not** run repository hooks.  Profiles must model required checks as
//! explicit workflow steps.  libgit2 also does not provide Git LFS's external
//! clean/smudge driver; checkpointing therefore refuses to touch changed paths
//! carrying `filter=lfs` instead of accidentally committing hydrated content.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use git2::build::CheckoutBuilder;
use git2::{
    AttrCheckFlags, ErrorCode, IndexAddOption, IndexEntry, IndexTime, MergeOptions, Oid, Reference,
    Repository, Signature, Status, StatusOptions, WorktreeAddOptions,
};
use serde::{Deserialize, Serialize};

use crate::error::{KoniError, Result, io_error};
use crate::persistent_lock::{LockMode, PersistentFileLock};

const SIDECAR_DIRECTORY: &str = "koni";
const REPOSITORY_LOCK: &str = "locks/repository.lock";
const DEFAULT_IDENTITY_NAME: &str = "Agentic Koni";
const DEFAULT_IDENTITY_EMAIL: &str = "koni@example.local";

/// A discovered repository plus the normalized paths needed to distinguish a
/// linked ticket checkout from the integration checkout.
pub struct GitBackend {
    repository: Repository,
    workdir: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
}

impl fmt::Debug for GitBackend {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GitBackend")
            .field("workdir", &self.workdir)
            .field("git_dir", &self.git_dir)
            .field("common_dir", &self.common_dir)
            .field("is_linked_worktree", &self.repository.is_worktree())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepositoryInfo {
    pub workdir: PathBuf,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
    pub branch_ref: Option<String>,
    pub head: String,
    pub is_linked_worktree: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeChange {
    pub path: PathBuf,
    pub status_bits: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketWorktreeSpec {
    /// A libgit2 worktree administration name. It must be unique in the repo.
    pub name: String,
    /// Full local branch ref, for example `refs/heads/koni/ticket/T-123`.
    pub branch_ref: String,
    pub path: PathBuf,
    pub base: Oid,
    /// Active worktrees should normally be locked against incidental pruning.
    pub lock: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketWorktree {
    pub name: String,
    pub branch_ref: String,
    pub path: PathBuf,
    pub base: String,
}

/// Configurable naming and placement for run-owned Git resources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunGitTemplates {
    /// Supports `{{ run.slug }}`, `{{ run.short_id }}`, and `{{ run.id }}`.
    pub integration_branch: String,
    /// Also supports `{{ ticket.id }}`.
    pub ticket_branch: String,
    /// Relative to `.git/koni`.
    pub worktree_root: PathBuf,
}

impl Default for RunGitTemplates {
    fn default() -> Self {
        Self {
            integration_branch: "koni/runs/{{ run.slug }}-{{ run.short_id }}".to_owned(),
            ticket_branch: "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}".to_owned(),
            worktree_root: PathBuf::from("worktrees"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunGitNamespace {
    pub run_id: String,
    pub run_slug: String,
    pub short_id: String,
    pub integration_branch_ref: String,
    pub planning_worktree_name: String,
    pub planning_worktree: PathBuf,
    pub integration_worktree_name: String,
    pub integration_worktree: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanningWorktree {
    pub name: String,
    pub path: PathBuf,
    pub base: String,
    pub detached: bool,
    /// Policy flag consumed by the workflow/sandbox layer. Filesystem mode bits
    /// are intentionally not changed, so Git can still maintain the checkout.
    pub policy_read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApproveRunWorktreeRequest {
    pub run_id: String,
    pub run_slug: String,
    pub base: Oid,
    pub templates: RunGitTemplates,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovedRunWorktree {
    pub run_id: String,
    pub branch_ref: String,
    pub worktree_name: String,
    pub worktree: PathBuf,
    pub base: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunTicketWorktreeRequest {
    pub run_id: String,
    pub run_slug: String,
    pub ticket_id: String,
    pub base: Oid,
    pub templates: RunGitTemplates,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
}

impl Default for CommitIdentity {
    fn default() -> Self {
        Self {
            name: DEFAULT_IDENTITY_NAME.to_owned(),
            email: DEFAULT_IDENTITY_EMAIL.to_owned(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitTrailer {
    pub token: String,
    pub value: String,
}

impl CommitTrailer {
    pub fn new(token: impl Into<String>, value: impl Into<String>) -> Result<Self> {
        let trailer = Self {
            token: token.into(),
            value: value.into(),
        };
        validate_trailer(&trailer)?;
        Ok(trailer)
    }
}

/// Canonical provenance trailers for an integration commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KoniCommitMetadata {
    pub run_id: String,
    pub ticket_id: String,
    pub profile_hash: String,
    pub review_id: Option<String>,
    pub receipt_ids: Vec<String>,
}

impl KoniCommitMetadata {
    pub fn trailers(&self) -> Result<Vec<CommitTrailer>> {
        let mut trailers = vec![
            CommitTrailer::new("Koni-Run", &self.run_id)?,
            CommitTrailer::new("Koni-Ticket", &self.ticket_id)?,
            CommitTrailer::new("Koni-Profile", &self.profile_hash)?,
        ];
        if let Some(review_id) = &self.review_id {
            trailers.push(CommitTrailer::new("Koni-Review", review_id)?);
        }
        let mut receipts = self.receipt_ids.clone();
        receipts.sort();
        receipts.dedup();
        for receipt in receipts {
            trailers.push(CommitTrailer::new("Koni-Receipt", receipt)?);
        }
        Ok(trailers)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointRequest {
    pub subject: String,
    pub body: Option<String>,
    pub trailers: Vec<CommitTrailer>,
    pub excluded_paths: Vec<PathBuf>,
    /// Paths that are both ignored as live worktree changes and guaranteed to
    /// be absent from the checkpoint tree. Unlike `excluded_paths`, these are
    /// removed even when an older parent accidentally tracked them.
    pub tree_excluded_paths: Vec<PathBuf>,
    pub identity: Option<CommitIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointCommit {
    pub commit: String,
    pub tree: String,
    pub parent: String,
    pub changed_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SquashRequest {
    pub integration_ref: String,
    pub ticket_ref: String,
    /// The immutable integration commit captured when the ticket was leased.
    pub base: Oid,
    pub subject: String,
    pub body: Option<String>,
    pub trailers: Vec<CommitTrailer>,
    pub allowed_dirty_paths: Vec<PathBuf>,
    /// Paths that may exist transiently in a checkout but must never be
    /// published in the composed squash tree.
    pub tree_excluded_paths: Vec<PathBuf>,
    /// JSONL journals that may be resolved when both sides only append valid,
    /// uniquely identified records to the exact leased-base contents.
    pub append_only_paths: Vec<PathBuf>,
    /// Compiler-owned ticket projections whose ticket-branch version is
    /// authoritative at the finish boundary. Paths are exact and opt-in.
    pub ticket_authoritative_paths: Vec<PathBuf>,
    pub identity: Option<CommitIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictSide {
    pub path: PathBuf,
    pub object_id: String,
    pub mode: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeConflict {
    pub path: PathBuf,
    pub ancestor: Option<ConflictSide>,
    pub integration: Option<ConflictSide>,
    pub ticket: Option<ConflictSide>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictReport {
    pub base: String,
    pub integration_head: String,
    pub ticket_head: String,
    pub conflicts: Vec<TreeConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrationCommit {
    pub commit: String,
    pub tree: String,
    pub parent: String,
    pub ticket_head: String,
}

/// Exact, single-step compensation for a squash integration whose subsequent
/// sidecar finalization failed. Both object IDs are required so this cannot be
/// used as a general reset operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollbackIntegrationRequest {
    pub integration_ref: String,
    pub expected_commit: Oid,
    pub expected_parent: Oid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RolledBackIntegration {
    pub reverted_commit: String,
    pub restored_commit: String,
    pub restored_tree: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SquashOutcome {
    Integrated(IntegrationCommit),
    Conflict(ConflictReport),
    NoChanges {
        integration_head: String,
        ticket_head: String,
    },
}

/// An exclusive, cross-process lock shared by every linked checkout.
pub struct RepositoryLock {
    _lock: PersistentFileLock,
    pub path: PathBuf,
}

impl GitBackend {
    pub fn discover(start: impl AsRef<Path>) -> Result<Self> {
        let repository = Repository::discover(start.as_ref())?;
        if repository.is_bare() {
            return Err(action_error("Koni requires a non-bare Git checkout"));
        }
        let workdir =
            canonicalize_existing(repository.workdir().ok_or_else(|| {
                action_error("the discovered repository has no working directory")
            })?)?;
        let git_dir = canonicalize_existing(repository.path())?;
        let common_dir = canonicalize_existing(repository.commondir())?;
        Ok(Self {
            repository,
            workdir,
            git_dir,
            common_dir,
        })
    }

    pub fn info(&self) -> Result<RepositoryInfo> {
        Ok(RepositoryInfo {
            workdir: self.workdir.clone(),
            git_dir: self.git_dir.clone(),
            common_dir: self.common_dir.clone(),
            branch_ref: self.branch_ref().ok(),
            head: self.head_oid()?.to_string(),
            is_linked_worktree: self.repository.is_worktree(),
        })
    }

    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    pub fn git_dir(&self) -> &Path {
        &self.git_dir
    }

    pub fn common_dir(&self) -> &Path {
        &self.common_dir
    }

    /// Operational state belongs here, outside the product tree and shared by
    /// the integration checkout and all linked ticket worktrees.
    pub fn sidecar_root(&self) -> PathBuf {
        self.common_dir.join(SIDECAR_DIRECTORY)
    }

    pub fn sidecar_path(&self, relative: impl AsRef<Path>) -> Result<PathBuf> {
        validate_relative_path(relative.as_ref(), "sidecar path")?;
        Ok(self.sidecar_root().join(relative))
    }

    pub fn worktree_names(&self) -> Result<Vec<String>> {
        let worktrees = self.repository.worktrees()?;
        let mut names = Vec::with_capacity(worktrees.len());
        for name in worktrees.iter() {
            let name =
                name?.ok_or_else(|| action_error("Git returned a non-UTF-8 worktree name"))?;
            names.push(name.to_owned());
        }
        Ok(names)
    }

    pub fn worktree_path(&self, name: &str) -> Result<Option<PathBuf>> {
        validate_worktree_name(name)?;
        match self.repository.find_worktree(name) {
            Ok(worktree) => Ok(Some(worktree.path().to_path_buf())),
            Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn run_namespace(
        &self,
        run_id: &str,
        run_slug: &str,
        templates: &RunGitTemplates,
    ) -> Result<RunGitNamespace> {
        validate_namespace_id(run_id, "run ID")?;
        let run_slug = normalize_run_slug(run_slug)?;
        validate_relative_path(&templates.worktree_root, "run worktree root")?;
        if !templates.integration_branch.contains("{{ run.id }}")
            && !templates.integration_branch.contains("{{ run.short_id }}")
        {
            return Err(action_error(
                "run integration branch template must contain {{ run.id }} or {{ run.short_id }}",
            ));
        }
        let short_id = short_run_id(run_id);
        let integration_branch = render_run_git_template(
            &templates.integration_branch,
            run_id,
            &run_slug,
            &short_id,
            None,
        )?;
        let integration_branch_ref = qualify_local_branch(&integration_branch)?;
        let root = self
            .sidecar_root()
            .join(&templates.worktree_root)
            .join(run_id);
        Ok(RunGitNamespace {
            run_id: run_id.to_owned(),
            run_slug,
            short_id,
            integration_branch_ref,
            planning_worktree_name: format!("koni-{run_id}-planning"),
            planning_worktree: root.join("planning"),
            integration_worktree_name: format!("koni-{run_id}-integration"),
            integration_worktree: root.join("integration"),
        })
    }

    /// Create a detached temporary planning checkout at an immutable base.
    /// No branch or other reference is created, and the returned policy marker
    /// tells the workflow layer to expose it read-only to planning agents.
    pub fn create_planning_worktree(
        &self,
        run_id: &str,
        run_slug: &str,
        base: Oid,
        templates: &RunGitTemplates,
    ) -> Result<PlanningWorktree> {
        let _lock = self.lock()?;
        let namespace = self.run_namespace(run_id, run_slug, templates)?;
        self.create_detached_worktree_unlocked(
            &namespace.planning_worktree_name,
            &namespace.planning_worktree,
            base,
            true,
        )
    }

    /// Approve a planned run by creating its first permanent ref/worktree and
    /// then retiring the detached planning checkout.
    pub fn approve_run_worktree(
        &self,
        request: &ApproveRunWorktreeRequest,
    ) -> Result<ApprovedRunWorktree> {
        let _lock = self.lock()?;
        let namespace =
            self.run_namespace(&request.run_id, &request.run_slug, &request.templates)?;
        let planning = match self
            .repository
            .find_worktree(&namespace.planning_worktree_name)
        {
            Ok(planning) => planning,
            Err(error) if error.code() == ErrorCode::NotFound => {
                return self
                    .existing_approved_run_worktree(&namespace, request.base)?
                    .ok_or_else(|| {
                        action_error(format!(
                            "run {} has neither a planning nor an approved integration worktree",
                            request.run_id
                        ))
                    });
            }
            Err(error) => return Err(error.into()),
        };
        planning.validate()?;
        if canonicalize_existing(planning.path())?
            != canonicalize_existing(&namespace.planning_worktree)?
        {
            return Err(action_error(format!(
                "planning worktree for run {} is outside its Git namespace",
                request.run_id
            )));
        }
        let planning_repository = Repository::open(planning.path())?;
        if !planning_repository.head_detached()?
            || planning_repository.head()?.peel_to_commit()?.id() != request.base
        {
            return Err(action_error(format!(
                "planning worktree for run {} is not detached at {}",
                request.run_id, request.base
            )));
        }
        let planning_backend = Self::discover(planning.path())?;
        if planning_backend.is_dirty(&[])? {
            return Err(action_error(format!(
                "planning worktree for run {} is dirty",
                request.run_id
            )));
        }
        if let Some(existing) = self.existing_approved_run_worktree(&namespace, request.base)? {
            self.remove_worktree_unlocked(&namespace.planning_worktree_name, None)?;
            return Ok(existing);
        }
        let created = self.create_branch_worktree_unlocked(&TicketWorktreeSpec {
            name: namespace.integration_worktree_name.clone(),
            branch_ref: namespace.integration_branch_ref.clone(),
            path: namespace.integration_worktree.clone(),
            base: request.base,
            lock: true,
        })?;
        if let Err(error) = self.remove_worktree_unlocked(&namespace.planning_worktree_name, None) {
            let _ = self.remove_worktree_unlocked(
                &namespace.integration_worktree_name,
                Some(&namespace.integration_branch_ref),
            );
            return Err(error);
        }
        Ok(ApprovedRunWorktree {
            run_id: request.run_id.clone(),
            branch_ref: created.branch_ref,
            worktree_name: created.name,
            worktree: created.path,
            base: created.base,
        })
    }

    fn existing_approved_run_worktree(
        &self,
        namespace: &RunGitNamespace,
        base: Oid,
    ) -> Result<Option<ApprovedRunWorktree>> {
        let worktree = match self
            .repository
            .find_worktree(&namespace.integration_worktree_name)
        {
            Ok(worktree) => worktree,
            Err(error) if error.code() == ErrorCode::NotFound => {
                let branch_exists = match self
                    .repository
                    .find_reference(&namespace.integration_branch_ref)
                {
                    Ok(_) => true,
                    Err(error) if error.code() == ErrorCode::NotFound => false,
                    Err(error) => return Err(error.into()),
                };
                if branch_exists || namespace.integration_worktree.exists() {
                    return Err(action_error(format!(
                        "run {} has an incomplete approved Git namespace",
                        namespace.run_id
                    )));
                }
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        };
        worktree.validate()?;
        let actual_path = canonicalize_existing(worktree.path())?;
        let expected_path = canonicalize_existing(&namespace.integration_worktree)?;
        if actual_path != expected_path {
            return Err(action_error(format!(
                "integration worktree for run {} is outside its Git namespace",
                namespace.run_id
            )));
        }
        let repository = Repository::open(&actual_path)?;
        if repository.head_detached()? {
            return Err(action_error(format!(
                "approved integration worktree for run {} is detached",
                namespace.run_id
            )));
        }
        let head = repository.head()?;
        let head_name = std::str::from_utf8(head.name_bytes())
            .map_err(|_| action_error("integration branch name is not valid UTF-8"))?;
        let head_commit = head.peel_to_commit()?.id();
        let descends_from_base =
            head_commit == base || repository.graph_descendant_of(head_commit, base)?;
        if head_name != namespace.integration_branch_ref || !descends_from_base {
            return Err(action_error(format!(
                "approved integration worktree for run {} does not match {} descending from {}",
                namespace.run_id, namespace.integration_branch_ref, base
            )));
        }
        Ok(Some(ApprovedRunWorktree {
            run_id: namespace.run_id.clone(),
            branch_ref: namespace.integration_branch_ref.clone(),
            worktree_name: namespace.integration_worktree_name.clone(),
            worktree: actual_path,
            base: base.to_string(),
        }))
    }

    pub fn run_ticket_worktree_spec(
        &self,
        request: &RunTicketWorktreeRequest,
    ) -> Result<TicketWorktreeSpec> {
        validate_namespace_id(&request.ticket_id, "ticket ID")?;
        if !request.templates.ticket_branch.contains("{{ ticket.id }}")
            || (!request.templates.ticket_branch.contains("{{ run.id }}")
                && !request
                    .templates
                    .ticket_branch
                    .contains("{{ run.short_id }}"))
        {
            return Err(action_error(
                "ticket branch template must contain {{ ticket.id }} and a run ID placeholder",
            ));
        }
        let namespace =
            self.run_namespace(&request.run_id, &request.run_slug, &request.templates)?;
        let branch = render_run_git_template(
            &request.templates.ticket_branch,
            &request.run_id,
            &namespace.run_slug,
            &namespace.short_id,
            Some(&request.ticket_id),
        )?;
        let branch_ref = qualify_local_branch(&branch)?;
        Ok(TicketWorktreeSpec {
            name: format!("koni-{}-ticket-{}", request.run_id, request.ticket_id),
            branch_ref,
            path: namespace
                .integration_worktree
                .parent()
                .expect("run worktree namespace has a parent")
                .join("tickets")
                .join(&request.ticket_id),
            base: request.base,
            lock: true,
        })
    }

    pub fn create_run_ticket_worktree(
        &self,
        request: &RunTicketWorktreeRequest,
    ) -> Result<TicketWorktree> {
        self.create_ticket_worktree(&self.run_ticket_worktree_spec(request)?)
    }

    pub fn lock(&self) -> Result<RepositoryLock> {
        let path = self.sidecar_path(REPOSITORY_LOCK)?;
        let lock = PersistentFileLock::acquire(
            &self.common_dir,
            Path::new(SIDECAR_DIRECTORY).join(REPOSITORY_LOCK).as_path(),
            LockMode::Blocking,
        )
        .map_err(|source| io_error(&path, source))?;
        debug_assert_eq!(lock.path(), path);
        Ok(RepositoryLock { _lock: lock, path })
    }

    pub fn branch_ref(&self) -> Result<String> {
        if self.repository.head_detached()? {
            return Err(action_error("detached HEAD is not a valid Koni checkout"));
        }
        let head = self.repository.head()?;
        let name = std::str::from_utf8(head.name_bytes())
            .map_err(|_| action_error("HEAD branch name is not valid UTF-8"))?;
        if !name.starts_with("refs/heads/") {
            return Err(action_error(format!(
                "HEAD does not name a local branch: {name}"
            )));
        }
        Ok(name.to_owned())
    }

    pub fn head_oid(&self) -> Result<Oid> {
        Ok(self.repository.head()?.peel_to_commit()?.id())
    }

    pub fn reference_oid(&self, reference: &str) -> Result<Oid> {
        validate_reference(reference)?;
        Ok(self
            .repository
            .find_reference(reference)?
            .peel_to_commit()?
            .id())
    }

    pub fn status(&self, excluded_paths: &[PathBuf]) -> Result<Vec<WorktreeChange>> {
        validate_excluded_paths(excluded_paths)?;
        let mut options = StatusOptions::new();
        options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false)
            .renames_head_to_index(true)
            .renames_index_to_workdir(true);
        let statuses = self.repository.statuses(Some(&mut options))?;
        let mut changes = Vec::new();
        for entry in statuses.iter() {
            if entry.status() == Status::CURRENT {
                continue;
            }
            let path = entry
                .path()
                .map_err(|_| action_error("Git status contains a non-UTF-8 path"))?;
            let path = PathBuf::from(path);
            if path_is_excluded(&path, excluded_paths) {
                continue;
            }
            changes.push(WorktreeChange {
                path,
                status_bits: entry.status().bits(),
            });
        }
        changes.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(changes)
    }

    pub fn is_dirty(&self, excluded_paths: &[PathBuf]) -> Result<bool> {
        Ok(!self.status(excluded_paths)?.is_empty())
    }

    pub fn lfs_tracked_paths<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a Path>,
    ) -> Result<Vec<PathBuf>> {
        let mut lfs_paths = Vec::new();
        for path in paths {
            validate_relative_path(path, "Git path")?;
            let filter = self
                .repository
                .get_attr(path, "filter", AttrCheckFlags::default())?;
            if filter == Some("lfs") {
                lfs_paths.push(path.to_owned());
            }
        }
        lfs_paths.sort();
        lfs_paths.dedup();
        Ok(lfs_paths)
    }

    pub fn create_ticket_worktree(&self, spec: &TicketWorktreeSpec) -> Result<TicketWorktree> {
        let _lock = self.lock()?;
        self.create_branch_worktree_unlocked(spec)
    }

    fn create_branch_worktree_unlocked(&self, spec: &TicketWorktreeSpec) -> Result<TicketWorktree> {
        validate_worktree_name(&spec.name)?;
        validate_reference(&spec.branch_ref)?;
        let branch_name = local_branch_name(&spec.branch_ref)?;
        if !spec.path.is_absolute() {
            return Err(action_error("ticket worktree path must be absolute"));
        }
        if spec.path.exists() {
            return Err(action_error(format!(
                "ticket worktree path already exists: {}",
                spec.path.display()
            )));
        }
        let parent = spec
            .path
            .parent()
            .ok_or_else(|| action_error("ticket worktree path has no parent"))?;
        fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;

        let base = self.repository.find_commit(spec.base)?;
        if self.repository.find_reference(&spec.branch_ref).is_ok() {
            return Err(action_error(format!(
                "ticket branch already exists: {}",
                spec.branch_ref
            )));
        }
        let mut branch = self.repository.branch(branch_name, &base, false)?;
        let branch_reference = branch.get();
        let mut options = WorktreeAddOptions::new();
        options.reference(Some(branch_reference)).lock(spec.lock);
        let created = self
            .repository
            .worktree(&spec.name, &spec.path, Some(&options));
        if let Err(error) = created {
            let _ = branch.delete();
            return Err(error.into());
        }
        drop(created);
        let path = canonicalize_existing(&spec.path)?;
        Ok(TicketWorktree {
            name: spec.name.clone(),
            branch_ref: spec.branch_ref.clone(),
            path,
            base: spec.base.to_string(),
        })
    }

    fn create_detached_worktree_unlocked(
        &self,
        name: &str,
        path: &Path,
        base: Oid,
        lock: bool,
    ) -> Result<PlanningWorktree> {
        validate_worktree_name(name)?;
        if !path.is_absolute() {
            return Err(action_error("planning worktree path must be absolute"));
        }
        if path.exists() {
            return Err(action_error(format!(
                "planning worktree path already exists: {}",
                path.display()
            )));
        }
        let parent = path
            .parent()
            .ok_or_else(|| action_error("planning worktree path has no parent"))?;
        fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
        self.repository.find_commit(base)?;

        let references_before = reference_names(&self.repository)?;
        // libgit2's add API always creates or checks out a branch. The linked
        // worktree control-file format is intentionally simple and stable, so
        // materialize a detached HEAD directly and let libgit2 perform and
        // validate the checkout. No reference exists even at an intermediate
        // crash boundary.
        let administration_parent = self.common_dir.join("worktrees");
        fs::create_dir_all(&administration_parent)
            .map_err(|source| io_error(&administration_parent, source))?;
        let administration = administration_parent.join(name);
        if administration.exists() {
            return Err(action_error(format!(
                "planning worktree administration already exists: {}",
                administration.display()
            )));
        }
        fs::create_dir(&administration).map_err(|source| io_error(&administration, source))?;
        if let Err(source) = fs::create_dir(path) {
            let _ = fs::remove_dir_all(&administration);
            return Err(io_error(path, source));
        }

        let initialize = (|| -> Result<PathBuf> {
            let administration_text = administration.to_str().ok_or_else(|| {
                action_error("planning worktree administration path is not valid UTF-8")
            })?;
            let common_text = self
                .common_dir
                .to_str()
                .ok_or_else(|| action_error("repository common directory is not valid UTF-8"))?;
            let gitlink = path.join(".git");
            let gitlink_text = gitlink.to_str().ok_or_else(|| {
                action_error("planning worktree Git link path is not valid UTF-8")
            })?;
            fs::write(&gitlink, format!("gitdir: {administration_text}\n"))
                .map_err(|source| io_error(&gitlink, source))?;
            fs::write(administration.join("commondir"), format!("{common_text}\n"))
                .map_err(|source| io_error(administration.join("commondir"), source))?;
            fs::write(administration.join("gitdir"), format!("{gitlink_text}\n"))
                .map_err(|source| io_error(administration.join("gitdir"), source))?;
            fs::write(administration.join("HEAD"), format!("{base}\n"))
                .map_err(|source| io_error(administration.join("HEAD"), source))?;
            if lock {
                fs::write(administration.join("locked"), [])
                    .map_err(|source| io_error(administration.join("locked"), source))?;
            }

            let worktree_repository = Repository::open(path)?;
            let mut checkout = CheckoutBuilder::new();
            checkout
                .force()
                .recreate_missing(true)
                .remove_untracked(true)
                .update_index(true);
            worktree_repository.checkout_head(Some(&mut checkout))?;
            if !worktree_repository.head_detached()?
                || worktree_repository.head()?.peel_to_commit()?.id() != base
            {
                return Err(action_error(format!(
                    "planning worktree {name} was not detached at {base}"
                )));
            }
            let worktree = self.repository.find_worktree(name)?;
            worktree.validate()?;
            canonicalize_existing(path)
        })();

        let initialized_path = match initialize {
            Ok(initialized_path) => initialized_path,
            Err(error) => {
                let _ = fs::remove_dir_all(path);
                let _ = fs::remove_dir_all(&administration);
                return Err(error);
            }
        };

        let references_after = reference_names(&self.repository)?;
        if references_after != references_before {
            let _ = self.remove_worktree_unlocked(name, None);
            return Err(action_error(
                "planning worktree did not preserve the repository reference set",
            ));
        }

        Ok(PlanningWorktree {
            name: name.to_owned(),
            path: initialized_path,
            base: base.to_string(),
            detached: true,
            policy_read_only: true,
        })
    }

    /// Remove a compiler-managed worktree and optionally its ticket branch.
    /// Callers should retain the branch first when unfinished work must survive.
    pub fn remove_ticket_worktree(&self, name: &str, delete_branch: Option<&str>) -> Result<()> {
        let _lock = self.lock()?;
        self.remove_worktree_unlocked(name, delete_branch)
    }

    /// Idempotently retire a compiler-owned worktree and, when explicitly
    /// requested, its fully-qualified local branch.  Run deletion is a
    /// resumable transaction, so an already-pruned worktree/reference is a
    /// successful replay rather than an error.
    pub fn remove_managed_worktree_if_exists(
        &self,
        name: &str,
        delete_branch: Option<&str>,
    ) -> Result<bool> {
        validate_worktree_name(name)?;
        if let Some(branch_ref) = delete_branch {
            validate_reference(branch_ref)?;
        }
        let _lock = self.lock()?;
        let removed = match self.repository.find_worktree(name) {
            Ok(_) => {
                self.remove_worktree_unlocked(name, None)?;
                true
            }
            Err(error) if error.code() == ErrorCode::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if let Some(branch_ref) = delete_branch {
            match self.repository.find_reference(branch_ref) {
                Ok(mut reference) => reference.delete()?,
                Err(error) if error.code() == ErrorCode::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(removed)
    }

    fn remove_worktree_unlocked(&self, name: &str, delete_branch: Option<&str>) -> Result<()> {
        validate_worktree_name(name)?;
        let administration = self.common_dir.join("worktrees").join(name);
        let canonical_administration = canonicalize_existing(&administration)?;
        if canonical_administration.parent() != Some(self.common_dir.join("worktrees").as_path()) {
            return Err(action_error(format!(
                "managed worktree administration escaped the common Git directory: {}",
                canonical_administration.display()
            )));
        }
        let gitlink_record = canonical_administration.join("gitdir");
        let gitlink_text = fs::read_to_string(&gitlink_record)
            .map_err(|source| io_error(&gitlink_record, source))?;
        let gitlink = canonicalize_existing(Path::new(gitlink_text.trim()))?;
        if gitlink.file_name().and_then(|name| name.to_str()) != Some(".git") {
            return Err(action_error(format!(
                "managed worktree gitdir record does not name a .git link: {}",
                gitlink.display()
            )));
        }
        let link_text =
            fs::read_to_string(&gitlink).map_err(|source| io_error(&gitlink, source))?;
        let linked_administration = link_text
            .trim()
            .strip_prefix("gitdir: ")
            .ok_or_else(|| action_error("managed worktree .git link is malformed"))?;
        if canonicalize_existing(Path::new(linked_administration))? != canonical_administration {
            return Err(action_error(format!(
                "managed worktree .git link does not point back to {}",
                canonical_administration.display()
            )));
        }
        let working_tree_path =
            canonicalize_existing(gitlink.parent().ok_or_else(|| {
                action_error("managed worktree .git link has no parent directory")
            })?)?;
        if working_tree_path == self.workdir
            || working_tree_path == self.git_dir
            || working_tree_path == self.common_dir
        {
            return Err(action_error(format!(
                "refusing to remove primary repository path as managed worktree: {}",
                working_tree_path.display()
            )));
        }
        // Koni creates and owns both these paths. Removing the checkout
        // before its administrative entry leaves Git able to diagnose/recover
        // a filesystem failure. This avoids libgit2 1.9 following managed
        // worktree metadata into the common repository during prune.
        if working_tree_path.exists() {
            fs::remove_dir_all(&working_tree_path)
                .map_err(|source| io_error(&working_tree_path, source))?;
        }
        fs::remove_dir_all(&canonical_administration)
            .map_err(|source| io_error(&canonical_administration, source))?;
        if let Some(branch_ref) = delete_branch {
            validate_reference(branch_ref)?;
            let mut reference = self.repository.find_reference(branch_ref)?;
            reference.delete()?;
        }
        Ok(())
    }

    /// Snapshot all non-excluded worktree changes onto the currently checked
    /// out branch. Existing staging choices are intentionally ignored: the
    /// Koni owns scratch commits and rebuilds the index from HEAD.
    pub fn checkpoint(&self, request: &CheckpointRequest) -> Result<Option<CheckpointCommit>> {
        let _lock = self.lock()?;
        self.checkpoint_unlocked(request, None)
    }

    /// Publish a checkpoint only when the checked-out branch still has the
    /// exact parent proven by an earlier semantic transaction preflight.
    pub fn checkpoint_from(
        &self,
        request: &CheckpointRequest,
        expected_parent: Oid,
    ) -> Result<Option<CheckpointCommit>> {
        let _lock = self.lock()?;
        self.checkpoint_unlocked(request, Some(expected_parent))
    }

    fn checkpoint_unlocked(
        &self,
        request: &CheckpointRequest,
        expected_parent: Option<Oid>,
    ) -> Result<Option<CheckpointCommit>> {
        validate_excluded_paths(&request.tree_excluded_paths)?;
        let branch_ref = self.branch_ref()?;
        let parent = self.repository.head()?.peel_to_commit()?;
        if let Some(expected_parent) = expected_parent
            && parent.id() != expected_parent
        {
            return Err(action_error(format!(
                "checkpoint parent advanced after transaction preflight: expected {expected_parent}, found {}",
                parent.id()
            )));
        }
        let parent_tree = parent.tree()?;
        let status_exclusions =
            combined_excluded_paths(&request.excluded_paths, &request.tree_excluded_paths);
        let changed = self.status(&status_exclusions)?;
        let lfs_paths =
            self.lfs_tracked_paths(changed.iter().map(|change| change.path.as_path()))?;
        if !lfs_paths.is_empty() {
            return Err(action_error(format!(
                "libgit2 cannot safely checkpoint changed Git LFS paths; run a configured LFS adapter first: {}",
                display_paths(&lfs_paths)
            )));
        }

        let mut index = self.repository.index()?;
        index.read_tree(&parent_tree)?;
        let excluded = &status_exclusions;
        let mut filter =
            |path: &Path, _matched: &[u8]| -> i32 { i32::from(path_is_excluded(path, excluded)) };
        index.update_all(["*"], Some(&mut filter))?;
        index.add_all(["*"], IndexAddOption::DEFAULT, Some(&mut filter))?;
        let removed_tree_paths =
            remove_tree_excluded_entries(&mut index, &request.tree_excluded_paths)?;
        let tree_oid = index.write_tree()?;
        if tree_oid == parent_tree.id() {
            index.write()?;
            return Ok(None);
        }
        let tree = self.repository.find_tree(tree_oid)?;
        let identity = signature(&self.repository, request.identity.as_ref())?;
        let message =
            format_commit_message(&request.subject, request.body.as_deref(), &request.trailers)?;
        let commit_oid =
            self.repository
                .commit(None, &identity, &identity, &message, &tree, &[&parent])?;
        if let Err(error) = self.repository.reference_matching(
            &branch_ref,
            commit_oid,
            true,
            parent.id(),
            &format!("koni checkpoint: {}", request.subject),
        ) {
            index.read_tree(&parent_tree)?;
            index.write()?;
            return Err(error.into());
        }
        index.write()?;
        let mut changed_paths = changed
            .into_iter()
            .map(|change| change.path)
            .chain(removed_tree_paths)
            .collect::<Vec<_>>();
        changed_paths.sort();
        changed_paths.dedup();
        Ok(Some(CheckpointCommit {
            commit: commit_oid.to_string(),
            tree: tree_oid.to_string(),
            parent: parent.id().to_string(),
            changed_paths,
        }))
    }

    /// Integrate the ticket as one single-parent squash commit. The merge is
    /// performed entirely in memory, so a conflict never writes conflict
    /// markers or merge state into the integration checkout.
    pub fn squash_integrate(&self, request: &SquashRequest) -> Result<SquashOutcome> {
        let _lock = self.lock()?;
        validate_reference(&request.integration_ref)?;
        validate_reference(&request.ticket_ref)?;
        validate_excluded_paths(&request.tree_excluded_paths)?;
        if self.branch_ref()? != request.integration_ref {
            return Err(action_error(format!(
                "squash integration must run in the {} checkout",
                request.integration_ref
            )));
        }
        let dirty = self.status(&combined_excluded_paths(
            &request.allowed_dirty_paths,
            &request.tree_excluded_paths,
        ))?;
        if !dirty.is_empty() {
            return Err(action_error(format!(
                "integration checkout is dirty: {}",
                display_paths(
                    &dirty
                        .iter()
                        .map(|change| change.path.clone())
                        .collect::<Vec<_>>()
                )
            )));
        }

        let integration_ref = self.repository.find_reference(&request.integration_ref)?;
        let integration = integration_ref.peel_to_commit()?;
        let ticket = self
            .repository
            .find_reference(&request.ticket_ref)?
            .peel_to_commit()?;
        let base = self.repository.find_commit(request.base)?;
        ensure_ancestor(&self.repository, base.id(), integration.id(), "integration")?;
        ensure_ancestor(&self.repository, base.id(), ticket.id(), "ticket")?;

        let base_tree = base.tree()?;
        let integration_tree = integration.tree()?;
        let ticket_tree = ticket.tree()?;
        if ticket_tree.id() == base_tree.id() {
            return Ok(SquashOutcome::NoChanges {
                integration_head: integration.id().to_string(),
                ticket_head: ticket.id().to_string(),
            });
        }

        let mut merge_options = MergeOptions::new();
        merge_options.find_renames(true);
        let mut index = self.repository.merge_trees(
            &base_tree,
            &integration_tree,
            &ticket_tree,
            Some(&merge_options),
        )?;
        if index.has_conflicts() {
            resolve_append_only_conflicts(
                &self.repository,
                &mut index,
                &request.append_only_paths,
            )?;
        }
        if index.has_conflicts() {
            resolve_ticket_authoritative_conflicts(
                &self.repository,
                &mut index,
                &request.ticket_authoritative_paths,
            )?;
        }
        remove_tree_excluded_entries(&mut index, &request.tree_excluded_paths)?;
        if index.has_conflicts() {
            return Ok(SquashOutcome::Conflict(ConflictReport {
                base: base.id().to_string(),
                integration_head: integration.id().to_string(),
                ticket_head: ticket.id().to_string(),
                conflicts: collect_conflicts(&index)?,
            }));
        }
        let merged_tree_oid = index.write_tree_to(&self.repository)?;
        if merged_tree_oid == integration_tree.id() {
            return Ok(SquashOutcome::NoChanges {
                integration_head: integration.id().to_string(),
                ticket_head: ticket.id().to_string(),
            });
        }

        let merged_tree = self.repository.find_tree(merged_tree_oid)?;
        let identity = signature(&self.repository, request.identity.as_ref())?;
        let message =
            format_commit_message(&request.subject, request.body.as_deref(), &request.trailers)?;
        let commit_oid = self.repository.commit(
            None,
            &identity,
            &identity,
            &message,
            &merged_tree,
            &[&integration],
        )?;
        self.repository.reference_matching(
            &request.integration_ref,
            commit_oid,
            true,
            integration.id(),
            &format!("koni squash: {}", request.subject),
        )?;

        // A branch ref and its checked-out files cannot be changed atomically.
        // Safe checkout plus CAS compensation makes the normal failure path
        // reversible; the sidecar transaction journal records this boundary at
        // the workflow layer for process-crash reconciliation.
        let mut repository_index = self.repository.index()?;
        repository_index.read_tree(&merged_tree)?;
        repository_index.write()?;
        let mut checkout = CheckoutBuilder::new();
        checkout
            .force()
            .recreate_missing(true)
            .remove_untracked(request.allowed_dirty_paths.is_empty())
            .update_index(true);
        if let Err(checkout_error) = self.repository.checkout_head(Some(&mut checkout)) {
            let rollback = self.repository.reference_matching(
                &request.integration_ref,
                integration.id(),
                true,
                commit_oid,
                "koni rollback failed integration checkout",
            );
            if let Ok(mut index) = self.repository.index() {
                let _ = index.read_tree(&integration_tree);
                let _ = index.write();
                let mut restore = CheckoutBuilder::new();
                restore
                    .force()
                    .recreate_missing(true)
                    .remove_untracked(false)
                    .update_index(true);
                let _ = self.repository.checkout_head(Some(&mut restore));
            }
            if let Err(rollback_error) = rollback {
                return Err(action_error(format!(
                    "integration ref advanced to {commit_oid}, checkout failed ({checkout_error}), and ref compensation failed ({rollback_error}); recovery is required"
                )));
            }
            return Err(action_error(format!(
                "integration checkout failed and the ref was restored: {checkout_error}"
            )));
        }

        Ok(SquashOutcome::Integrated(IntegrationCommit {
            commit: commit_oid.to_string(),
            tree: merged_tree_oid.to_string(),
            parent: integration.id().to_string(),
            ticket_head: ticket.id().to_string(),
        }))
    }

    /// Roll back one exact squash commit after a later transaction phase fails.
    ///
    /// The configured integration ref must still point at `expected_commit`,
    /// that commit must have `expected_parent` as its sole parent, and the
    /// integration checkout must be clean. The ref update is compare-and-swap;
    /// concurrent advancement is refused without touching the index or files.
    pub fn rollback_integration(
        &self,
        request: &RollbackIntegrationRequest,
    ) -> Result<RolledBackIntegration> {
        let _lock = self.lock()?;
        validate_reference(&request.integration_ref)?;
        if self.branch_ref()? != request.integration_ref {
            return Err(action_error(format!(
                "integration rollback must run in the {} checkout",
                request.integration_ref
            )));
        }
        let dirty = self.status(&[])?;
        if !dirty.is_empty() {
            return Err(action_error(format!(
                "integration checkout is dirty: {}",
                display_paths(
                    &dirty
                        .iter()
                        .map(|change| change.path.clone())
                        .collect::<Vec<_>>()
                )
            )));
        }

        let integrated = self.repository.find_commit(request.expected_commit)?;
        if integrated.parent_count() != 1 || integrated.parent_id(0)? != request.expected_parent {
            return Err(action_error(format!(
                "commit {} is not a single-parent integration of {}",
                request.expected_commit, request.expected_parent
            )));
        }
        let parent = self.repository.find_commit(request.expected_parent)?;
        let parent_tree = parent.tree()?;
        self.repository.reference_matching(
            &request.integration_ref,
            parent.id(),
            true,
            integrated.id(),
            "koni rollback squash integration",
        )?;

        let mut repository_index = self.repository.index()?;
        repository_index.read_tree(&parent_tree)?;
        repository_index.write()?;
        let mut checkout = CheckoutBuilder::new();
        checkout
            .force()
            .recreate_missing(true)
            .remove_untracked(true)
            .update_index(true);
        if let Err(checkout_error) = self.repository.checkout_head(Some(&mut checkout)) {
            let compensation = self.repository.reference_matching(
                &request.integration_ref,
                integrated.id(),
                true,
                parent.id(),
                "koni restore failed squash rollback",
            );
            if let Ok(mut index) = self.repository.index()
                && let Ok(integrated_tree) = integrated.tree()
            {
                let _ = index.read_tree(&integrated_tree);
                let _ = index.write();
                let mut restore = CheckoutBuilder::new();
                restore
                    .force()
                    .recreate_missing(true)
                    .remove_untracked(true)
                    .update_index(true);
                let _ = self.repository.checkout_head(Some(&mut restore));
            }
            if let Err(compensation_error) = compensation {
                return Err(action_error(format!(
                    "integration ref rolled back to {}, checkout failed ({checkout_error}), and ref compensation failed ({compensation_error}); recovery is required",
                    parent.id()
                )));
            }
            return Err(action_error(format!(
                "integration rollback checkout failed and the ref was restored: {checkout_error}"
            )));
        }

        Ok(RolledBackIntegration {
            reverted_commit: integrated.id().to_string(),
            restored_commit: parent.id().to_string(),
            restored_tree: parent_tree.id().to_string(),
        })
    }
}

pub fn format_commit_message(
    subject: &str,
    body: Option<&str>,
    trailers: &[CommitTrailer],
) -> Result<String> {
    let subject = subject.trim();
    if subject.is_empty() || subject.contains(['\n', '\r', '\0']) {
        return Err(action_error("commit subject must be one non-empty line"));
    }
    for trailer in trailers {
        validate_trailer(trailer)?;
    }
    let mut message = subject.to_owned();
    if let Some(body) = body.map(str::trim).filter(|body| !body.is_empty()) {
        if body.contains('\0') {
            return Err(action_error("commit body contains a NUL byte"));
        }
        message.push_str("\n\n");
        message.push_str(body);
    }
    if !trailers.is_empty() {
        message.push_str("\n\n");
        for (index, trailer) in trailers.iter().enumerate() {
            if index > 0 {
                message.push('\n');
            }
            message.push_str(&trailer.token);
            message.push_str(": ");
            message.push_str(trailer.value.trim());
        }
    }
    message.push('\n');
    Ok(message)
}

fn action_error(message: impl Into<String>) -> KoniError {
    KoniError::Action(message.into())
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf> {
    fs::canonicalize(path).map_err(|source| io_error(path, source))
}

fn validate_relative_path(path: &Path, label: &str) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(action_error(format!(
            "{label} must be a non-empty relative path"
        )));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(action_error(format!(
            "{label} escapes its root: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_excluded_paths(paths: &[PathBuf]) -> Result<()> {
    for path in paths {
        validate_relative_path(path, "excluded Git path")?;
    }
    Ok(())
}

fn combined_excluded_paths(left: &[PathBuf], right: &[PathBuf]) -> Vec<PathBuf> {
    let mut combined = left.iter().chain(right).cloned().collect::<Vec<_>>();
    combined.sort();
    combined.dedup();
    combined
}

fn remove_tree_excluded_entries(
    index: &mut git2::Index,
    excluded: &[PathBuf],
) -> Result<Vec<PathBuf>> {
    let mut removed = index
        .iter()
        .filter_map(|entry| String::from_utf8(entry.path.clone()).ok())
        .map(PathBuf::from)
        .filter(|path| path_is_excluded(path, excluded))
        .collect::<Vec<_>>();
    removed.sort();
    removed.dedup();
    for path in &removed {
        index.remove_path(path)?;
    }
    Ok(removed)
}

fn path_is_excluded(path: &Path, excluded: &[PathBuf]) -> bool {
    excluded
        .iter()
        .any(|candidate| path == candidate || path.starts_with(candidate))
}

fn validate_reference(reference: &str) -> Result<()> {
    if !Reference::is_valid_name(reference) {
        return Err(action_error(format!("invalid Git reference: {reference}")));
    }
    Ok(())
}

fn local_branch_name(reference: &str) -> Result<&str> {
    reference
        .strip_prefix("refs/heads/")
        .filter(|name| !name.is_empty())
        .ok_or_else(|| action_error(format!("not a local branch reference: {reference}")))
}

fn validate_worktree_name(name: &str) -> Result<()> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(action_error(format!("invalid worktree name: {name}")));
    }
    Ok(())
}

fn validate_namespace_id(id: &str, label: &str) -> Result<()> {
    if id.is_empty()
        || matches!(id, "." | "..")
        || !id.bytes().any(|byte| byte.is_ascii_alphanumeric())
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(action_error(format!("invalid {label}: {id}")));
    }
    Ok(())
}

fn normalize_run_slug(value: &str) -> Result<String> {
    let mut slug = String::new();
    let mut separator_pending = false;
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() {
            if separator_pending && !slug.is_empty() && slug.len() < 48 {
                slug.push('-');
            }
            separator_pending = false;
            if slug.len() < 48 {
                slug.push(byte.to_ascii_lowercase() as char);
            }
        } else if !slug.is_empty() {
            separator_pending = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        return Err(action_error(
            "run slug must contain an ASCII letter or digit",
        ));
    }
    Ok(slug)
}

fn short_run_id(run_id: &str) -> String {
    let mut suffix = run_id
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .rev()
        .take(8)
        .map(|byte| byte.to_ascii_lowercase())
        .collect::<Vec<_>>();
    suffix.reverse();
    String::from_utf8(suffix).expect("ASCII run ID suffix is valid UTF-8")
}

fn render_run_git_template(
    template: &str,
    run_id: &str,
    run_slug: &str,
    short_id: &str,
    ticket_id: Option<&str>,
) -> Result<String> {
    let mut rendered = template
        .replace("{{ run.slug }}", run_slug)
        .replace("{{ run.short_id }}", short_id)
        .replace("{{ run.id }}", run_id);
    if let Some(ticket_id) = ticket_id {
        rendered = rendered.replace("{{ ticket.id }}", ticket_id);
    }
    if rendered.contains("{{") || rendered.contains("}}") {
        return Err(action_error(format!(
            "unsupported or unavailable Git template placeholder in {template}"
        )));
    }
    if rendered.trim().is_empty() {
        return Err(action_error("Git branch template rendered an empty name"));
    }
    Ok(rendered)
}

fn qualify_local_branch(branch: &str) -> Result<String> {
    let reference = if branch.starts_with("refs/") {
        branch.to_owned()
    } else {
        format!("refs/heads/{branch}")
    };
    validate_reference(&reference)?;
    local_branch_name(&reference)?;
    Ok(reference)
}

fn reference_names(repository: &Repository) -> Result<BTreeSet<String>> {
    let mut names = BTreeSet::new();
    for reference in repository.references()? {
        let reference = reference?;
        let name = std::str::from_utf8(reference.name_bytes())
            .map_err(|_| action_error("repository contains a non-UTF-8 reference name"))?;
        names.insert(name.to_owned());
    }
    Ok(names)
}

fn validate_trailer(trailer: &CommitTrailer) -> Result<()> {
    if trailer.token.is_empty()
        || !trailer
            .token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(action_error(format!(
            "invalid commit trailer token: {}",
            trailer.token
        )));
    }
    let value = trailer.value.trim();
    if value.is_empty() || value.contains(['\n', '\r', '\0']) {
        return Err(action_error(format!(
            "invalid value for commit trailer {}",
            trailer.token
        )));
    }
    Ok(())
}

fn signature(
    repository: &Repository,
    identity: Option<&CommitIdentity>,
) -> Result<Signature<'static>> {
    if let Some(identity) = identity {
        return Ok(Signature::now(&identity.name, &identity.email)?);
    }
    match repository.signature() {
        Ok(signature) => Ok(signature),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(Signature::now(
            DEFAULT_IDENTITY_NAME,
            DEFAULT_IDENTITY_EMAIL,
        )?),
        Err(error) => Err(error.into()),
    }
}

fn ensure_ancestor(
    repository: &Repository,
    ancestor: Oid,
    descendant: Oid,
    label: &str,
) -> Result<()> {
    if ancestor == descendant || repository.graph_descendant_of(descendant, ancestor)? {
        return Ok(());
    }
    Err(action_error(format!(
        "ticket base {ancestor} is not an ancestor of the {label} head {descendant}"
    )))
}

fn resolve_append_only_conflicts(
    repository: &Repository,
    index: &mut git2::Index,
    append_only_paths: &[PathBuf],
) -> Result<()> {
    if append_only_paths.is_empty() {
        return Ok(());
    }
    let conflicts = collect_conflicts(index)?;
    for conflict in conflicts {
        if !append_only_paths.iter().any(|path| path == &conflict.path) {
            continue;
        }
        let Some(merged) = merge_append_only_jsonl(repository, &conflict)? else {
            continue;
        };
        let mode = conflict
            .integration
            .as_ref()
            .map(|side| side.mode)
            .or_else(|| conflict.ticket.as_ref().map(|side| side.mode))
            .unwrap_or(0o100644);
        let entry = IndexEntry {
            ctime: IndexTime::new(0, 0),
            mtime: IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode,
            uid: 0,
            gid: 0,
            file_size: u32::try_from(merged.len())
                .map_err(|_| action_error("append-only journal is too large for a Git index"))?,
            id: repository.blob(&merged)?,
            flags: 0,
            flags_extended: 0,
            path: conflict.path.to_string_lossy().as_bytes().to_vec(),
        };
        index.conflict_remove(&conflict.path)?;
        index.add(&entry)?;
    }
    Ok(())
}

fn resolve_ticket_authoritative_conflicts(
    repository: &Repository,
    index: &mut git2::Index,
    ticket_authoritative_paths: &[PathBuf],
) -> Result<()> {
    if ticket_authoritative_paths.is_empty() {
        return Ok(());
    }
    let conflicts = collect_conflicts(index)?;
    for conflict in conflicts {
        if !ticket_authoritative_paths
            .iter()
            .any(|path| path == &conflict.path)
        {
            continue;
        }
        let ticket = conflict.ticket.clone();
        index.conflict_remove(&conflict.path)?;
        let Some(ticket) = ticket else {
            // The authoritative ticket projection deleted this status path.
            continue;
        };
        let blob = repository.find_blob(Oid::from_str(&ticket.object_id)?)?;
        let entry = IndexEntry {
            ctime: IndexTime::new(0, 0),
            mtime: IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: ticket.mode,
            uid: 0,
            gid: 0,
            file_size: u32::try_from(blob.content().len())
                .map_err(|_| action_error("ticket projection is too large for a Git index"))?,
            id: blob.id(),
            flags: 0,
            flags_extended: 0,
            path: conflict.path.to_string_lossy().as_bytes().to_vec(),
        };
        index.add(&entry)?;
    }
    Ok(())
}

fn merge_append_only_jsonl(
    repository: &Repository,
    conflict: &TreeConflict,
) -> Result<Option<Vec<u8>>> {
    let (Some(ancestor), Some(integration), Some(ticket)) = (
        conflict.ancestor.as_ref(),
        conflict.integration.as_ref(),
        conflict.ticket.as_ref(),
    ) else {
        return Ok(None);
    };
    if integration.mode != ticket.mode || ancestor.mode != integration.mode {
        return Ok(None);
    }
    let ancestor_blob = repository.find_blob(Oid::from_str(&ancestor.object_id)?)?;
    let integration_blob = repository.find_blob(Oid::from_str(&integration.object_id)?)?;
    let ticket_blob = repository.find_blob(Oid::from_str(&ticket.object_id)?)?;
    let ancestor_bytes = ancestor_blob.content();
    let integration_bytes = integration_blob.content();
    let ticket_bytes = ticket_blob.content();
    if !integration_bytes.starts_with(ancestor_bytes) || !ticket_bytes.starts_with(ancestor_bytes) {
        return Ok(None);
    }

    let ancestor_records = parse_identified_jsonl(ancestor_bytes);
    let integration_records = parse_identified_jsonl(integration_bytes);
    let ticket_records = parse_identified_jsonl(ticket_bytes);
    let (Some(ancestor_records), Some(integration_records), Some(ticket_records)) =
        (ancestor_records, integration_records, ticket_records)
    else {
        return Ok(None);
    };
    if !records_have_prefix(&integration_records, &ancestor_records)
        || !records_have_prefix(&ticket_records, &ancestor_records)
    {
        return Ok(None);
    }

    let mut records_by_id: BTreeMap<String, serde_json::Value> = integration_records
        .iter()
        .map(|record| (record.id.clone(), record.value.clone()))
        .collect();
    let mut merged = integration_bytes.to_vec();
    for record in ticket_records.iter().skip(ancestor_records.len()) {
        if let Some(existing) = records_by_id.get(&record.id) {
            if existing != &record.value {
                return Ok(None);
            }
            continue;
        }
        merged.extend_from_slice(&record.raw);
        merged.push(b'\n');
        records_by_id.insert(record.id.clone(), record.value.clone());
    }
    Ok(Some(merged))
}

#[derive(Debug)]
struct JsonlRecord {
    id: String,
    value: serde_json::Value,
    raw: Vec<u8>,
}

fn parse_identified_jsonl(contents: &[u8]) -> Option<Vec<JsonlRecord>> {
    if contents.is_empty() {
        return Some(Vec::new());
    }
    if !contents.ends_with(b"\n") {
        return None;
    }
    let mut records = Vec::new();
    let mut seen = BTreeSet::new();
    for raw in contents.split(|byte| *byte == b'\n') {
        if raw.is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_slice(raw).ok()?;
        let id = value.get("id")?.as_str()?.to_owned();
        if id.is_empty() || !seen.insert(id.clone()) {
            return None;
        }
        records.push(JsonlRecord {
            id,
            value,
            raw: raw.to_vec(),
        });
    }
    Some(records)
}

fn records_have_prefix(records: &[JsonlRecord], prefix: &[JsonlRecord]) -> bool {
    records.len() >= prefix.len()
        && records
            .iter()
            .zip(prefix)
            .all(|(record, expected)| record.id == expected.id && record.value == expected.value)
}

fn collect_conflicts(index: &git2::Index) -> Result<Vec<TreeConflict>> {
    let mut conflicts = Vec::new();
    for conflict in index.conflicts()? {
        let conflict = conflict?;
        let ancestor = conflict.ancestor.map(conflict_side);
        let integration = conflict.our.map(conflict_side);
        let ticket = conflict.their.map(conflict_side);
        let path = integration
            .as_ref()
            .or(ticket.as_ref())
            .or(ancestor.as_ref())
            .map(|side| side.path.clone())
            .ok_or_else(|| action_error("libgit2 returned an empty conflict record"))?;
        conflicts.push(TreeConflict {
            path,
            ancestor,
            integration,
            ticket,
        });
    }
    conflicts.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(conflicts)
}

fn conflict_side(entry: IndexEntry) -> ConflictSide {
    ConflictSide {
        path: PathBuf::from(String::from_utf8_lossy(&entry.path).into_owned()),
        object_id: entry.id.to_string(),
        mode: entry.mode,
    }
}

fn display_paths(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt, symlink};

    fn init_repository() -> (TempDir, PathBuf, Oid) {
        let temp = tempfile::tempdir().expect("temporary directory");
        let root = temp.path().join("repo");
        fs::create_dir(&root).expect("repository directory");
        let repository = Repository::init(&root).expect("initialize repository");
        repository
            .set_head("refs/heads/main")
            .expect("select main branch");
        {
            let mut config = repository.config().expect("repository config");
            config
                .set_str("user.name", "Koni Test")
                .expect("set user name");
            config
                .set_str("user.email", "koni-test@example.local")
                .expect("set user email");
        }
        fs::write(root.join("shared.txt"), "base\n").expect("write base file");
        fs::write(root.join("README.md"), "initial\n").expect("write readme");
        let mut index = repository.index().expect("open index");
        index
            .add_all(["*"], IndexAddOption::DEFAULT, None)
            .expect("stage initial files");
        let tree_id = index.write_tree().expect("write initial tree");
        index.write().expect("write initial index");
        let tree = repository.find_tree(tree_id).expect("find initial tree");
        let signature =
            Signature::now("Koni Test", "koni-test@example.local").expect("test signature");
        let commit = repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "initial\n",
                &tree,
                &[],
            )
            .expect("initial commit");
        drop(tree);
        drop(repository);
        (temp, root, commit)
    }

    fn checkpoint(backend: &GitBackend, subject: &str) -> CheckpointCommit {
        backend
            .checkpoint(&CheckpointRequest {
                subject: subject.to_owned(),
                body: None,
                trailers: Vec::new(),
                excluded_paths: Vec::new(),
                tree_excluded_paths: Vec::new(),
                identity: None,
            })
            .expect("checkpoint succeeds")
            .expect("checkpoint created")
    }

    #[cfg(unix)]
    #[test]
    fn repository_lock_is_persistent_observable_and_rejects_symlink_sentinels() {
        let (temp, root, _) = init_repository();
        let backend = GitBackend::discover(&root).unwrap();
        let expected = backend.sidecar_path(REPOSITORY_LOCK).unwrap();
        let first = backend.lock().unwrap();
        assert_eq!(first.path, expected);
        let inode = expected.metadata().unwrap().ino();
        drop(first);
        let second = backend.lock().unwrap();
        drop(second);
        assert_eq!(expected.metadata().unwrap().ino(), inode);

        fs::remove_file(&expected).unwrap();
        fs::remove_dir(expected.parent().unwrap()).unwrap();
        fs::remove_dir(backend.sidecar_root()).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir_all(outside.join("locks")).unwrap();
        symlink(&outside, backend.sidecar_root()).unwrap();
        assert!(backend.lock().is_err());
        assert!(!outside.join("locks/repository.lock").exists());

        fs::remove_file(backend.sidecar_root()).unwrap();
        fs::create_dir_all(expected.parent().unwrap()).unwrap();
        let sentinel = outside.join("sentinel");
        fs::write(&sentinel, "unchanged").unwrap();
        symlink(&sentinel, &expected).unwrap();
        assert!(backend.lock().is_err());
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "unchanged");
    }

    fn create_ticket(backend: &GitBackend, parent: &Path, name: &str, base: Oid) -> TicketWorktree {
        backend
            .create_ticket_worktree(&TicketWorktreeSpec {
                name: name.to_owned(),
                branch_ref: format!("refs/heads/koni/ticket/{name}"),
                path: parent.join(name),
                base,
                lock: true,
            })
            .expect("create ticket worktree")
    }

    #[test]
    fn discovers_nested_and_linked_worktrees_with_one_common_dir() {
        let (temp, root, base) = init_repository();
        let nested = root.join("nested");
        fs::create_dir(&nested).expect("nested directory");
        let main = GitBackend::discover(&nested).expect("discover main checkout");
        assert_eq!(main.branch_ref().expect("branch"), "refs/heads/main");
        assert!(!main.info().expect("info").is_linked_worktree);

        let ticket = create_ticket(&main, temp.path(), "T-discovery", base);
        let linked = GitBackend::discover(&ticket.path).expect("discover linked checkout");
        assert!(linked.info().expect("info").is_linked_worktree);
        assert_eq!(main.common_dir(), linked.common_dir());
        assert_ne!(main.git_dir(), linked.git_dir());
        assert_eq!(main.sidecar_root(), linked.sidecar_root());
    }

    #[test]
    fn removing_a_managed_worktree_deletes_its_checkout_admin_and_branch() {
        let (temp, root, base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        let ticket = create_ticket(&backend, temp.path(), "T-retire", base);
        let administration = backend.common_dir().join("worktrees/T-retire");
        assert!(ticket.path.is_dir());
        assert!(administration.is_dir());
        assert!(
            backend
                .repository
                .find_reference(&ticket.branch_ref)
                .is_ok()
        );

        backend
            .remove_ticket_worktree("T-retire", Some(&ticket.branch_ref))
            .expect("retire compiler-owned worktree");

        assert!(!ticket.path.exists());
        assert!(!administration.exists());
        assert!(
            backend
                .repository
                .find_reference(&ticket.branch_ref)
                .is_err()
        );
        assert!(root.join("README.md").is_file());
        assert_eq!(backend.head_oid().expect("main HEAD"), base);
    }

    #[test]
    fn retiring_a_managed_worktree_retains_recoverable_unintegrated_branch() {
        let (temp, root, base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        let ticket = create_ticket(&backend, temp.path(), "T-retain", base);
        fs::write(ticket.path.join("unfinished.txt"), "recover me\n")
            .expect("write unfinished ticket work");
        let ticket_backend =
            GitBackend::discover(&ticket.path).expect("discover ticket repository");
        let unfinished = checkpoint(&ticket_backend, "ticket: retain unfinished work");

        backend
            .remove_managed_worktree_if_exists("T-retain", None)
            .expect("retire checkout while retaining branch");

        assert!(!ticket.path.exists());
        assert!(!backend.common_dir().join("worktrees/T-retain").exists());
        assert_eq!(
            backend
                .reference_oid(&ticket.branch_ref)
                .expect("retained recovery branch")
                .to_string(),
            unfinished.commit,
        );

        let recovery_path = temp.path().join("T-retain-recovery");
        let recovery_reference = backend
            .repository
            .find_reference(&ticket.branch_ref)
            .expect("open retained recovery branch");
        let mut options = WorktreeAddOptions::new();
        options.reference(Some(&recovery_reference)).lock(true);
        backend
            .repository
            .worktree("T-retain-recovery", &recovery_path, Some(&options))
            .expect("restore a checkout from the retained branch");
        assert_eq!(
            fs::read_to_string(recovery_path.join("unfinished.txt"))
                .expect("read recovered unfinished work"),
            "recover me\n",
        );

        backend
            .remove_managed_worktree_if_exists("T-retain-recovery", Some(&ticket.branch_ref))
            .expect("clean up recovery checkout and branch");
        assert!(
            backend
                .repository
                .find_reference(&ticket.branch_ref)
                .is_err()
        );
    }

    #[test]
    fn planning_worktree_is_detached_at_base_without_creating_a_reference() {
        let (_temp, root, base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        let references_before = reference_names(&backend.repository).expect("references before");

        let planning = backend
            .create_planning_worktree(
                "0198abcd-1234",
                "Investigate model drift",
                base,
                &RunGitTemplates::default(),
            )
            .expect("create planning worktree");

        assert!(planning.detached);
        assert!(planning.policy_read_only);
        assert_eq!(planning.base, base.to_string());
        assert_eq!(
            planning.path,
            backend
                .sidecar_root()
                .join("worktrees/0198abcd-1234/planning")
                .canonicalize()
                .expect("canonical planning path")
        );
        let planning_repository = Repository::open(&planning.path).expect("open planning checkout");
        assert!(planning_repository.head_detached().expect("detached HEAD"));
        assert_eq!(
            planning_repository
                .head()
                .expect("planning HEAD")
                .peel_to_commit()
                .expect("planning commit")
                .id(),
            base
        );
        assert_eq!(
            reference_names(&backend.repository).expect("references after"),
            references_before
        );
    }

    #[test]
    fn approval_creates_first_permanent_run_ref_and_removes_planning_checkout() {
        let (_temp, root, base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        let run_id = "0198abcd-1234";
        let templates = RunGitTemplates::default();
        let namespace = backend
            .run_namespace(run_id, "Investigate model drift", &templates)
            .expect("run namespace");
        backend
            .create_planning_worktree(run_id, "Investigate model drift", base, &templates)
            .expect("create planning worktree");

        let approved = backend
            .approve_run_worktree(&ApproveRunWorktreeRequest {
                run_id: run_id.to_owned(),
                run_slug: "Investigate model drift".to_owned(),
                base,
                templates,
            })
            .expect("approve run");

        assert_eq!(
            approved.branch_ref,
            "refs/heads/koni/runs/investigate-model-drift-abcd1234"
        );
        assert_eq!(
            backend
                .reference_oid(&approved.branch_ref)
                .expect("run branch"),
            base
        );
        assert!(!namespace.planning_worktree.exists());
        assert!(
            backend
                .repository
                .find_worktree(&namespace.planning_worktree_name)
                .is_err()
        );
        let integration = GitBackend::discover(&approved.worktree).expect("integration checkout");
        assert_eq!(
            integration.branch_ref().expect("integration branch"),
            approved.branch_ref
        );

        let recovered = backend
            .approve_run_worktree(&ApproveRunWorktreeRequest {
                run_id: run_id.to_owned(),
                run_slug: "Investigate model drift".to_owned(),
                base,
                templates: RunGitTemplates::default(),
            })
            .expect("approval is idempotent after the planning checkout is retired");
        assert_eq!(recovered, approved);
    }

    #[test]
    fn concurrent_runs_and_ticket_templates_have_disjoint_git_namespaces() {
        let (_temp, root, base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        let templates = RunGitTemplates {
            integration_branch: "custom/{{ run.id }}/integration".to_owned(),
            ticket_branch: "custom/{{ run.id }}/work/{{ ticket.id }}".to_owned(),
            worktree_root: PathBuf::from("custom-worktrees"),
        };
        let first = backend
            .run_ticket_worktree_spec(&RunTicketWorktreeRequest {
                run_id: "run-00000001".to_owned(),
                run_slug: "Same goal".to_owned(),
                ticket_id: "TK-shared".to_owned(),
                base,
                templates: templates.clone(),
            })
            .expect("first ticket namespace");
        let second = backend
            .run_ticket_worktree_spec(&RunTicketWorktreeRequest {
                run_id: "run-00000002".to_owned(),
                run_slug: "Same goal".to_owned(),
                ticket_id: "TK-shared".to_owned(),
                base,
                templates: templates.clone(),
            })
            .expect("second ticket namespace");

        assert_eq!(
            first.branch_ref,
            "refs/heads/custom/run-00000001/work/TK-shared"
        );
        assert_eq!(
            second.branch_ref,
            "refs/heads/custom/run-00000002/work/TK-shared"
        );
        assert_ne!(first.name, second.name);
        assert_ne!(first.path, second.path);
        assert!(
            first
                .path
                .starts_with(backend.sidecar_root().join("custom-worktrees"))
        );

        let first_created = backend
            .create_ticket_worktree(&first)
            .expect("create first run ticket");
        let second_created = backend
            .create_ticket_worktree(&second)
            .expect("create second run ticket");
        assert!(first_created.path.is_dir());
        assert!(second_created.path.is_dir());
    }

    #[test]
    fn uuid_v7_run_namespaces_use_the_random_suffix_for_short_ids() {
        let (_temp, root, _base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        let templates = RunGitTemplates::default();
        let first = backend
            .run_namespace(
                "0198abcd-0000-7000-8000-aaaaaaaaaaaa",
                "Repeated goal",
                &templates,
            )
            .expect("first namespace");
        let second = backend
            .run_namespace(
                "0198abcd-0000-7000-8000-bbbbbbbbbbbb",
                "Repeated goal",
                &templates,
            )
            .expect("second namespace");

        assert_eq!(first.short_id, "aaaaaaaa");
        assert_eq!(second.short_id, "bbbbbbbb");
        assert_ne!(first.integration_branch_ref, second.integration_branch_ref);
    }

    #[test]
    fn run_templates_must_namespace_integration_and_ticket_branches() {
        let (_temp, root, base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        let fixed_integration = RunGitTemplates {
            integration_branch: "main".to_owned(),
            ..RunGitTemplates::default()
        };
        assert!(
            backend
                .run_namespace("run-12345678", "Goal", &fixed_integration)
                .is_err()
        );

        let unscoped_ticket = RunGitTemplates {
            ticket_branch: "koni/tickets/{{ ticket.id }}".to_owned(),
            ..RunGitTemplates::default()
        };
        assert!(
            backend
                .run_ticket_worktree_spec(&RunTicketWorktreeRequest {
                    run_id: "run-12345678".to_owned(),
                    run_slug: "Goal".to_owned(),
                    ticket_id: "TK-1".to_owned(),
                    base,
                    templates: unscoped_ticket,
                })
                .is_err()
        );
    }

    #[test]
    fn checkpoints_all_changes_and_writes_provenance_trailers() {
        let (_temp, root, base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        fs::write(root.join("README.md"), "changed\n").expect("modify readme");
        fs::write(root.join("new.txt"), "new\n").expect("write new file");
        let metadata = KoniCommitMetadata {
            run_id: "RUN-1".to_owned(),
            ticket_id: "T-1".to_owned(),
            profile_hash: "sha256:abc".to_owned(),
            review_id: Some("REV-1:passed".to_owned()),
            receipt_ids: vec!["RT-2".to_owned(), "RT-1".to_owned()],
        };
        let created = backend
            .checkpoint(&CheckpointRequest {
                subject: "chore: checkpoint ticket".to_owned(),
                body: Some("Scratch state.".to_owned()),
                trailers: metadata.trailers().expect("trailers"),
                excluded_paths: Vec::new(),
                tree_excluded_paths: Vec::new(),
                identity: None,
            })
            .expect("checkpoint")
            .expect("new commit");
        assert_eq!(created.parent, base.to_string());
        assert_eq!(
            created.changed_paths,
            vec![PathBuf::from("README.md"), PathBuf::from("new.txt")]
        );
        let commit = backend
            .repository
            .find_commit(Oid::from_str(&created.commit).expect("commit oid"))
            .expect("find checkpoint");
        let message = commit.message().expect("UTF-8 commit message");
        assert!(message.contains("Koni-Run: RUN-1"));
        assert!(message.contains("Koni-Ticket: T-1"));
        assert!(message.contains("Koni-Receipt: RT-1\nKoni-Receipt: RT-2"));
        assert!(!backend.is_dirty(&[]).expect("status"));
    }

    #[test]
    fn checkpoint_from_refuses_an_advanced_preflight_parent_without_committing_dirt() {
        let (_temp, root, base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        fs::write(root.join("README.md"), "first\n").expect("modify readme");
        let advanced = checkpoint(&backend, "advance after preflight");
        fs::write(root.join("README.md"), "second\n").expect("modify readme again");
        let request = CheckpointRequest {
            subject: "chore: stale semantic transaction".to_owned(),
            body: None,
            trailers: Vec::new(),
            excluded_paths: Vec::new(),
            tree_excluded_paths: Vec::new(),
            identity: None,
        };

        let error = backend
            .checkpoint_from(&request, base)
            .expect_err("stale preflight parent must fail");

        assert!(
            error
                .to_string()
                .contains("advanced after transaction preflight")
        );
        assert_eq!(
            backend.head_oid().expect("unchanged HEAD").to_string(),
            advanced.commit
        );
        assert!(backend.is_dirty(&[]).expect("caller dirt remains visible"));
    }

    #[test]
    fn checkpoint_tree_exclusions_purge_legacy_entries_without_changing_ordinary_exclusions() {
        let (_temp, root, _base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        let lock = PathBuf::from("program/locks/compiler.lock");
        fs::create_dir_all(root.join("program/locks")).expect("create lock directory");
        fs::write(root.join(&lock), "").expect("write legacy lock");
        fs::write(root.join("scratch.txt"), "committed\n").expect("write scratch baseline");
        checkpoint(&backend, "seed legacy transient path");

        let purged = backend
            .checkpoint(&CheckpointRequest {
                subject: "chore: purge legacy transient path".to_owned(),
                body: None,
                trailers: Vec::new(),
                excluded_paths: Vec::new(),
                tree_excluded_paths: vec![PathBuf::from("program/locks")],
                identity: None,
            })
            .expect("purge checkpoint")
            .expect("a tracked exclusion creates a removal checkpoint");
        assert_eq!(purged.changed_paths, vec![lock.clone()]);
        let purged_tree = backend
            .repository
            .find_commit(Oid::from_str(&purged.commit).expect("purged commit id"))
            .expect("purged commit")
            .tree()
            .expect("purged tree");
        assert!(purged_tree.get_path(&lock).is_err());
        assert!(
            backend
                .status(&[PathBuf::from("program/locks")])
                .expect("status excluding transient path")
                .is_empty()
        );

        fs::remove_file(root.join(&lock)).expect("remove live lock copy");
        fs::write(root.join("scratch.txt"), "live override\n").expect("modify excluded scratch");
        fs::write(root.join("README.md"), "checkpointed\n").expect("modify included path");
        let ordinary = backend
            .checkpoint(&CheckpointRequest {
                subject: "chore: preserve ordinary exclusion".to_owned(),
                body: None,
                trailers: Vec::new(),
                excluded_paths: vec![PathBuf::from("scratch.txt")],
                tree_excluded_paths: vec![PathBuf::from("program/locks")],
                identity: None,
            })
            .expect("ordinary exclusion checkpoint")
            .expect("included change creates checkpoint");
        assert_eq!(ordinary.changed_paths, vec![PathBuf::from("README.md")]);
        let ordinary_tree = backend
            .repository
            .find_commit(Oid::from_str(&ordinary.commit).expect("ordinary commit id"))
            .expect("ordinary commit")
            .tree()
            .expect("ordinary tree");
        let scratch = ordinary_tree
            .get_path(Path::new("scratch.txt"))
            .expect("ordinary exclusion retains parent entry");
        assert_eq!(
            backend
                .repository
                .find_blob(scratch.id())
                .expect("scratch blob")
                .content(),
            b"committed\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("scratch.txt")).expect("live scratch"),
            "live override\n"
        );
    }

    #[test]
    fn squash_integration_composes_parallel_changes_as_one_parent_commit() {
        let (temp, root, base) = init_repository();
        let main = GitBackend::discover(&root).expect("discover main");
        let ticket = create_ticket(&main, temp.path(), "T-clean", base);
        let ticket_backend = GitBackend::discover(&ticket.path).expect("discover ticket");
        fs::write(ticket.path.join("ticket.txt"), "ticket change\n").expect("ticket change");
        fs::create_dir_all(ticket.path.join("program/locks")).expect("create legacy lock dir");
        fs::write(ticket.path.join("program/locks/compiler.lock"), "")
            .expect("write legacy ticket lock");
        let ticket_checkpoint = checkpoint(&ticket_backend, "checkpoint ticket");

        fs::write(root.join("main.txt"), "parallel main change\n").expect("main change");
        let integration_before = checkpoint(&main, "advance integration");
        let metadata = KoniCommitMetadata {
            run_id: "RUN-clean".to_owned(),
            ticket_id: "T-clean".to_owned(),
            profile_hash: "sha256:profile".to_owned(),
            review_id: Some("REV-clean:passed".to_owned()),
            receipt_ids: vec!["RT-clean".to_owned()],
        };
        let outcome = main
            .squash_integrate(&SquashRequest {
                integration_ref: "refs/heads/main".to_owned(),
                ticket_ref: ticket.branch_ref.clone(),
                base,
                subject: "feat(test): integrate clean ticket".to_owned(),
                body: None,
                trailers: metadata.trailers().expect("trailers"),
                allowed_dirty_paths: Vec::new(),
                tree_excluded_paths: vec![PathBuf::from("program/locks")],
                append_only_paths: Vec::new(),
                ticket_authoritative_paths: Vec::new(),
                identity: None,
            })
            .expect("squash integration");
        let integrated = match outcome {
            SquashOutcome::Integrated(integrated) => integrated,
            other => panic!("expected integration, got {other:?}"),
        };
        assert_eq!(integrated.parent, integration_before.commit);
        assert_eq!(integrated.ticket_head, ticket_checkpoint.commit);
        assert_eq!(
            fs::read_to_string(root.join("main.txt")).unwrap(),
            "parallel main change\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("ticket.txt")).unwrap(),
            "ticket change\n"
        );
        assert!(
            !root.join("program/locks/compiler.lock").exists(),
            "tree exclusions remove legacy ticket paths from the squash checkout"
        );
        let commit = main
            .repository
            .find_commit(Oid::from_str(&integrated.commit).expect("integrated oid"))
            .expect("integrated commit");
        assert_eq!(commit.parent_count(), 1);
        assert_eq!(
            commit.parent_id(0).expect("parent"),
            Oid::from_str(&integration_before.commit).unwrap()
        );
        assert!(commit.message().unwrap().contains("Koni-Ticket: T-clean"));
        assert_eq!(
            main.reference_oid(&ticket.branch_ref).unwrap().to_string(),
            ticket_checkpoint.commit
        );
        assert!(!main.is_dirty(&[]).expect("clean integration checkout"));
    }

    #[test]
    fn squash_integration_merges_configured_append_only_jsonl_journals() {
        let (temp, root, _initial) = init_repository();
        let main = GitBackend::discover(&root).expect("discover main");
        let events = PathBuf::from("program/events.jsonl");
        fs::create_dir_all(root.join("program")).expect("create program directory");
        fs::write(root.join(&events), "{\"id\":\"base\",\"type\":\"base\"}\n")
            .expect("write base event");
        let base_commit = checkpoint(&main, "initialize event journal");
        let base = Oid::from_str(&base_commit.commit).expect("base oid");
        let ticket = create_ticket(&main, temp.path(), "T-events", base);
        let ticket_backend = GitBackend::discover(&ticket.path).expect("discover ticket");

        fs::write(
            ticket.path.join(&events),
            "{\"id\":\"base\",\"type\":\"base\"}\n{\"id\":\"ticket\",\"type\":\"ticket\"}\n",
        )
        .expect("append ticket event");
        checkpoint(&ticket_backend, "append ticket event");
        fs::write(
            root.join(&events),
            "{\"id\":\"base\",\"type\":\"base\"}\n{\"id\":\"integration\",\"type\":\"integration\"}\n",
        )
        .expect("append integration event");
        checkpoint(&main, "append integration event");

        let outcome = main
            .squash_integrate(&SquashRequest {
                integration_ref: "refs/heads/main".to_owned(),
                ticket_ref: ticket.branch_ref,
                base,
                subject: "chore: merge event journals".to_owned(),
                body: None,
                trailers: Vec::new(),
                allowed_dirty_paths: Vec::new(),
                tree_excluded_paths: Vec::new(),
                append_only_paths: vec![events.clone()],
                ticket_authoritative_paths: Vec::new(),
                identity: None,
            })
            .expect("append-only integration");
        assert!(matches!(outcome, SquashOutcome::Integrated(_)));
        assert_eq!(
            fs::read_to_string(root.join(events)).expect("read merged journal"),
            "{\"id\":\"base\",\"type\":\"base\"}\n{\"id\":\"integration\",\"type\":\"integration\"}\n{\"id\":\"ticket\",\"type\":\"ticket\"}\n"
        );
    }

    #[test]
    fn squash_integration_prefers_configured_ticket_projection_on_add_add_conflict() {
        let (temp, root, base) = init_repository();
        let main = GitBackend::discover(&root).expect("discover main");
        let ticket = create_ticket(&main, temp.path(), "T-projection", base);
        let ticket_backend = GitBackend::discover(&ticket.path).expect("discover ticket");
        let projection = PathBuf::from("program/tickets/in_progress/T-projection.yaml");

        fs::create_dir_all(ticket.path.join("program/tickets/in_progress"))
            .expect("create ticket state directory");
        fs::write(
            ticket.path.join(&projection),
            "status: integrating\noutputs: [accepted]\n",
        )
        .expect("write ticket projection");
        checkpoint(&ticket_backend, "checkpoint ticket projection");

        fs::create_dir_all(root.join("program/tickets/in_progress"))
            .expect("create integration state directory");
        fs::write(root.join(&projection), "status: in_progress\noutputs: []\n")
            .expect("write integration projection");
        checkpoint(&main, "checkpoint integration projection");

        let outcome = main
            .squash_integrate(&SquashRequest {
                integration_ref: "refs/heads/main".to_owned(),
                ticket_ref: ticket.branch_ref,
                base,
                subject: "chore: merge authoritative ticket projection".to_owned(),
                body: None,
                trailers: Vec::new(),
                allowed_dirty_paths: Vec::new(),
                tree_excluded_paths: Vec::new(),
                append_only_paths: Vec::new(),
                ticket_authoritative_paths: vec![projection.clone()],
                identity: None,
            })
            .expect("ticket projection integration");

        assert!(matches!(outcome, SquashOutcome::Integrated(_)));
        assert_eq!(
            fs::read_to_string(root.join(projection)).expect("read merged projection"),
            "status: integrating\noutputs: [accepted]\n"
        );
    }

    #[test]
    fn conflicting_squash_reports_all_sides_without_touching_integration() {
        let (temp, root, base) = init_repository();
        let main = GitBackend::discover(&root).expect("discover main");
        let ticket = create_ticket(&main, temp.path(), "T-conflict", base);
        let ticket_backend = GitBackend::discover(&ticket.path).expect("discover ticket");
        fs::write(ticket.path.join("shared.txt"), "ticket version\n").expect("ticket edit");
        checkpoint(&ticket_backend, "ticket conflicting edit");

        fs::write(root.join("shared.txt"), "integration version\n").expect("main edit");
        let integration_before = checkpoint(&main, "integration conflicting edit");
        let outcome = main
            .squash_integrate(&SquashRequest {
                integration_ref: "refs/heads/main".to_owned(),
                ticket_ref: ticket.branch_ref,
                base,
                subject: "fix: should conflict".to_owned(),
                body: None,
                trailers: Vec::new(),
                allowed_dirty_paths: Vec::new(),
                tree_excluded_paths: Vec::new(),
                append_only_paths: Vec::new(),
                ticket_authoritative_paths: Vec::new(),
                identity: None,
            })
            .expect("conflict is a normal outcome");
        let report = match outcome {
            SquashOutcome::Conflict(report) => report,
            other => panic!("expected conflict, got {other:?}"),
        };
        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(report.conflicts[0].path, PathBuf::from("shared.txt"));
        assert!(report.conflicts[0].ancestor.is_some());
        assert!(report.conflicts[0].integration.is_some());
        assert!(report.conflicts[0].ticket.is_some());
        assert_eq!(
            main.head_oid().unwrap().to_string(),
            integration_before.commit
        );
        assert_eq!(
            fs::read_to_string(root.join("shared.txt")).unwrap(),
            "integration version\n"
        );
        assert!(!main.is_dirty(&[]).expect("checkout remains clean"));
    }

    #[test]
    fn rolls_back_exact_squash_and_restores_index_and_worktree() {
        let (temp, root, base) = init_repository();
        let main = GitBackend::discover(&root).expect("discover main");
        let ticket = create_ticket(&main, temp.path(), "T-rollback", base);
        let ticket_backend = GitBackend::discover(&ticket.path).expect("discover ticket");
        fs::remove_file(ticket.path.join("README.md")).expect("delete tracked file in ticket");
        fs::write(ticket.path.join("ticket.txt"), "integrated ticket file\n")
            .expect("add ticket file");
        checkpoint(&ticket_backend, "checkpoint rollback ticket");

        let outcome = main
            .squash_integrate(&SquashRequest {
                integration_ref: "refs/heads/main".to_owned(),
                ticket_ref: ticket.branch_ref,
                base,
                subject: "feat(test): integration to roll back".to_owned(),
                body: None,
                trailers: Vec::new(),
                allowed_dirty_paths: Vec::new(),
                tree_excluded_paths: Vec::new(),
                append_only_paths: Vec::new(),
                ticket_authoritative_paths: Vec::new(),
                identity: None,
            })
            .expect("squash integration");
        let integrated = match outcome {
            SquashOutcome::Integrated(integrated) => integrated,
            other => panic!("expected integration, got {other:?}"),
        };
        assert!(!root.join("README.md").exists());
        assert!(root.join("ticket.txt").is_file());
        assert!(!main.is_dirty(&[]).expect("integrated checkout is clean"));

        let rolled_back = main
            .rollback_integration(&RollbackIntegrationRequest {
                integration_ref: "refs/heads/main".to_owned(),
                expected_commit: Oid::from_str(&integrated.commit).expect("integration oid"),
                expected_parent: Oid::from_str(&integrated.parent).expect("parent oid"),
            })
            .expect("exact rollback succeeds");
        assert_eq!(rolled_back.reverted_commit, integrated.commit);
        assert_eq!(rolled_back.restored_commit, integrated.parent);
        assert_eq!(main.head_oid().unwrap().to_string(), integrated.parent);
        assert_eq!(
            fs::read_to_string(root.join("README.md")).expect("README restored"),
            "initial\n"
        );
        assert!(!root.join("ticket.txt").exists());
        assert!(!main.is_dirty(&[]).expect("rolled-back checkout is clean"));
    }

    #[test]
    fn rollback_refuses_stale_expected_commit_without_mutating_checkout() {
        let (_temp, root, base) = init_repository();
        let main = GitBackend::discover(&root).expect("discover main");
        fs::write(root.join("README.md"), "first integration\n").expect("first change");
        let first = checkpoint(&main, "first integration");
        fs::write(root.join("shared.txt"), "newer integration\n").expect("newer change");
        let newer = checkpoint(&main, "newer integration");

        let error = main
            .rollback_integration(&RollbackIntegrationRequest {
                integration_ref: "refs/heads/main".to_owned(),
                expected_commit: Oid::from_str(&first.commit).expect("first oid"),
                expected_parent: base,
            })
            .expect_err("stale CAS must fail");
        match error {
            KoniError::Git(error) => assert_eq!(error.code(), ErrorCode::Modified),
            other => panic!("expected modified-ref Git error, got {other}"),
        }
        assert_eq!(main.head_oid().unwrap().to_string(), newer.commit);
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "first integration\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("shared.txt")).unwrap(),
            "newer integration\n"
        );
        assert!(
            !main
                .is_dirty(&[])
                .expect("stale refusal leaves checkout clean")
        );
    }

    #[test]
    fn sidecar_paths_and_commit_trailers_reject_injection() {
        let (_temp, root, _base) = init_repository();
        let backend = GitBackend::discover(&root).expect("discover repository");
        assert!(backend.sidecar_path("../escape").is_err());
        assert!(CommitTrailer::new("Bad:Token", "value").is_err());
        assert!(CommitTrailer::new("Koni-Run", "RUN-1\nInjected: yes").is_err());
        assert!(format_commit_message("bad\nsubject", None, &[]).is_err());
    }
}
