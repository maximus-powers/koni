//! Transactional migration from the Codex-scoped Koni configuration to schema 2.
//!
//! This module deliberately does not start or stop an agent runtime. The caller
//! must first ask Koni's run authority layer to prove that legacy runs either
//! do not exist or have been archived, then pass its opaque proof to
//! [`Schema2Migrator::apply`]. This keeps config publication separate from
//! runtime/process authority while making the archive boundary impossible to
//! omit or forge accidentally.

use std::any::Any;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::ffi::OsString;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use uuid::Uuid;

use crate::error::{KoniError, Result, io_error};
use crate::git::GitBackend;

pub const LEGACY_CONFIG_ROOT: &str = ".codex/koni";
pub const SCHEMA2_CONFIG_ROOT: &str = ".koni";
pub const LEGACY_RESOURCE_MANIFEST: &str = "native-codex-resources.json";
pub const SCHEMA2_RESOURCE_MANIFEST: &str = "resource-manifest.json";
pub const SCHEMA2_MIGRATION_RECEIPT: &str = "migration-receipt.json";
pub const KONI_SCHEMA2_VERSION: &str = "2.0";

const MIGRATION_KIND: &str = "codex-koni-to-pi-schema2";

/// Provider-neutral agent resource written to `.koni/agents/<id>.yaml`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KoniAgentResourceV2 {
    pub schema_version: String,
    pub id: String,
    pub description: String,
    pub instructions: AgentInstructionSourceV2,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    pub capabilities: CapabilityPolicyV2,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum AgentInstructionSourceV2 {
    Inline { text: String },
    Path { path: PathBuf },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAccessV2 {
    ReadOnly,
    WorkspaceWrite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandAccessV2 {
    Denied,
    ReadOnly,
    WorkspaceWrite,
}

/// Koni-owned authority policy. These fields describe compiler-enforced
/// capabilities; they are not hints forwarded to a provider sandbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityPolicyV2 {
    pub workspace_access: WorkspaceAccessV2,
    pub commands: CommandAccessV2,
    #[serde(default)]
    pub network_access: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub writable_roots: Vec<String>,
}

impl CapabilityPolicyV2 {
    fn from_legacy(
        mode: Option<&str>,
        approval_policy: Option<&str>,
        network_access: bool,
        writable_roots: Vec<String>,
        source: &Path,
    ) -> Result<Self> {
        if approval_policy.is_some_and(|value| value != "never") {
            return Err(migration_error(format!(
                "{} uses Codex approval policy {:?}; schema 2 requires Koni-owned, non-interactive capability enforcement",
                source.display(),
                approval_policy.expect("checked as some")
            )));
        }
        let (workspace_access, commands) = match mode.unwrap_or("workspace-write") {
            "read-only" | "read_only" => (WorkspaceAccessV2::ReadOnly, CommandAccessV2::ReadOnly),
            "workspace-write" | "workspace_write" => (
                WorkspaceAccessV2::WorkspaceWrite,
                CommandAccessV2::WorkspaceWrite,
            ),
            unsupported => {
                return Err(migration_error(format!(
                    "{} uses unsupported Codex sandbox mode {unsupported:?}; unrestricted authority cannot be migrated automatically",
                    source.display()
                )));
            }
        };
        validate_writable_roots(&writable_roots, source)?;
        Ok(Self {
            workspace_access,
            commands,
            network_access,
            writable_roots,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyRunDisposition {
    NoLegacyRuns,
    Archived,
}

/// Opaque, revision-bound evidence issued by the core run authority layer.
///
/// Callers can pass this value to [`Schema2Migrator::apply`] but cannot forge
/// it from a public enum or deserialize it from untrusted CLI input. Apply
/// re-hashes the exact registry and archive receipts at both publication
/// boundaries, so a stale run inspection cannot authorize configuration
/// retirement.
pub struct Schema2RunDispositionProof {
    migration_id: String,
    project_root: PathBuf,
    legacy_runs: LegacyRunDisposition,
    registry_path: PathBuf,
    registry_revision_sha256: Option<String>,
    archive_receipts: Vec<AbsoluteHashedFile>,
    compiler_state_root: PathBuf,
    _authority_guards: Vec<Box<dyn Any>>,
}

impl std::fmt::Debug for Schema2RunDispositionProof {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Schema2RunDispositionProof")
            .field("migration_id", &self.migration_id)
            .field("project_root", &self.project_root)
            .field("legacy_runs", &self.legacy_runs)
            .field("registry_path", &self.registry_path)
            .field("compiler_state_root", &self.compiler_state_root)
            .field("authority_guard_count", &self._authority_guards.len())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AbsoluteHashedFile {
    path: PathBuf,
    sha256: String,
}

/// Compiler-owned state and live authority guards transferred from the run
/// layer into the opaque migration proof. Keeping these values type-erased
/// avoids coupling the schema transaction to Engine lock implementations;
/// dropping the proof is the only way to release them.
pub(crate) struct Schema2PublicationAuthority {
    compiler_state_root: PathBuf,
    guards: Vec<Box<dyn Any>>,
}

impl Schema2PublicationAuthority {
    pub(crate) fn new(compiler_state_root: PathBuf, guards: Vec<Box<dyn Any>>) -> Result<Self> {
        let compiler_state_root =
            canonical_real_directory(&compiler_state_root, "compiler state root")?;
        if guards.is_empty() {
            return Err(migration_error(
                "publication authority must retain at least one compiler-owned guard",
            ));
        }
        Ok(Self {
            compiler_state_root,
            guards,
        })
    }

    #[cfg(test)]
    pub(crate) fn unguarded_for_test(compiler_state_root: PathBuf) -> Result<Self> {
        Ok(Self {
            compiler_state_root: canonical_real_directory(
                &compiler_state_root,
                "test compiler state root",
            )?,
            guards: Vec::new(),
        })
    }
}

impl Schema2RunDispositionProof {
    pub fn legacy_run_disposition(&self) -> LegacyRunDisposition {
        self.legacy_runs.clone()
    }

    /// This constructor is deliberately crate-private: only Koni's run
    /// authority implementation may turn registry inspection into a proof.
    pub(crate) fn issue(
        plan: &Schema2MigrationPlan,
        legacy_runs: LegacyRunDisposition,
        registry_path: PathBuf,
        archive_receipt_paths: Vec<PathBuf>,
        authority: Schema2PublicationAuthority,
    ) -> Result<Self> {
        if !registry_path.is_absolute() {
            return Err(migration_error(
                "run registry evidence path must be absolute",
            ));
        }
        let registry_revision_sha256 = match fs::symlink_metadata(&registry_path) {
            Ok(_) => {
                ensure_real_file(&registry_path, "run registry evidence")?;
                Some(sha256_file(&registry_path)?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error(&registry_path, error)),
        };
        let mut archive_receipts = archive_receipt_paths
            .into_iter()
            .map(|path| {
                if !path.is_absolute() {
                    return Err(migration_error(
                        "run archive receipt evidence path must be absolute",
                    ));
                }
                ensure_real_file(&path, "run archive receipt evidence")?;
                let bytes = read_file(&path)?;
                let receipt: serde_yaml::Value =
                    serde_yaml::from_slice(&bytes).map_err(|source| KoniError::Yaml {
                        path: path.clone(),
                        source,
                    })?;
                if receipt["migration_id"].as_str() != Some(plan.migration_id.as_str())
                    || receipt["resume_allowed"].as_bool() != Some(false)
                    || receipt["run_id"]
                        .as_str()
                        .is_none_or(|run_id| run_id.is_empty())
                {
                    return Err(migration_error(format!(
                        "run archive receipt is not bound to migration {}: {}",
                        plan.migration_id,
                        path.display()
                    )));
                }
                Ok(AbsoluteHashedFile {
                    sha256: hex::encode(Sha256::digest(&bytes)),
                    path,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        archive_receipts.sort_by(|left, right| left.path.cmp(&right.path));
        archive_receipts.dedup_by(|left, right| left.path == right.path);
        let git = GitBackend::discover(&plan.project_root)?;
        if git.common_dir() != authority.compiler_state_root {
            return Err(migration_error(
                "publication authority belongs to a different Git compiler-state root",
            ));
        }
        if registry_path != git.sidecar_root().join("project.yaml") {
            return Err(migration_error(
                "run registry evidence is outside the compiler-owned Git sidecar",
            ));
        }
        let proof = Self {
            migration_id: plan.migration_id.clone(),
            project_root: plan.project_root.clone(),
            legacy_runs,
            registry_path,
            registry_revision_sha256,
            archive_receipts,
            compiler_state_root: authority.compiler_state_root,
            _authority_guards: authority.guards,
        };
        proof.verify(plan)?;
        Ok(proof)
    }

    fn verify(&self, plan: &Schema2MigrationPlan) -> Result<()> {
        if self.migration_id != plan.migration_id || self.project_root != plan.project_root {
            return Err(migration_error(
                "run disposition proof belongs to a different migration or project",
            ));
        }
        let git = GitBackend::discover(&plan.project_root)?;
        if git.common_dir() != self.compiler_state_root
            || self.registry_path != git.sidecar_root().join("project.yaml")
        {
            return Err(migration_error(
                "run disposition proof compiler authority changed after issuance",
            ));
        }
        match &self.registry_revision_sha256 {
            Some(expected) => {
                ensure_real_file(&self.registry_path, "run registry evidence")?;
                if sha256_file(&self.registry_path)? != *expected {
                    return Err(migration_error(
                        "run registry changed after migration disposition was proven",
                    ));
                }
            }
            None => match fs::symlink_metadata(&self.registry_path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Ok(_) => {
                    return Err(migration_error(
                        "run registry appeared after migration disposition was proven",
                    ));
                }
                Err(error) => return Err(io_error(&self.registry_path, error)),
            },
        }
        for receipt in &self.archive_receipts {
            ensure_real_file(&receipt.path, "run archive receipt evidence")?;
            if sha256_file(&receipt.path)? != receipt.sha256 {
                return Err(migration_error(format!(
                    "run archive receipt changed after disposition was proven: {}",
                    receipt.path.display()
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HashedMigrationFile {
    /// Canonical project-relative path using `/` separators.
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConversionPlan {
    pub id: String,
    pub source: HashedMigrationFile,
    pub destination: String,
}

/// Read-only description of the exact legacy inputs. Persisting this value is
/// safe: it contains paths and hashes, never credentials or file contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacySchema1Snapshot {
    pub schema_version: String,
    pub project_root: PathBuf,
    pub config_root: String,
    pub config_files: Vec<HashedMigrationFile>,
    pub owned_resources: Vec<HashedMigrationFile>,
    pub referenced_agents: Vec<String>,
    pub snapshot_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schema2MigrationPlan {
    pub schema_version: String,
    pub migration_id: String,
    pub migration: String,
    pub project_root: PathBuf,
    pub source_root: String,
    pub destination_root: String,
    pub backup_root: String,
    pub legacy: LegacySchema1Snapshot,
    pub agents: Vec<AgentConversionPlan>,
    /// Every manifest-owned legacy agent is retired into the backup. Only
    /// referenced agents appear in `agents` and become schema-2 resources.
    pub retired_legacy_agents: Vec<HashedMigrationFile>,
    /// Owned resources that remain at their current path and are neither
    /// copied nor removed by the transaction (currently `.agents/skills`).
    pub preserved_resources: Vec<HashedMigrationFile>,
    pub required_legacy_run_action: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schema2MigrationResult {
    pub schema_version: String,
    pub migration_id: String,
    pub destination_root: PathBuf,
    pub backup_root: PathBuf,
    pub converted_agents: usize,
    pub retired_legacy_agents: usize,
    pub preserved_resources: usize,
    pub receipt_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyResourceManifest {
    schema_version: String,
    owner: String,
    resources: Vec<LegacyOwnedResource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyOwnedResource {
    path: String,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Schema2ResourceManifest {
    schema_version: String,
    owner: String,
    external_resources: Vec<HashedMigrationFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Schema2MigrationReceipt {
    schema_version: String,
    migration: String,
    migration_id: String,
    source_root: String,
    source_snapshot_sha256: String,
    backup_root: String,
    converted_agents: Vec<String>,
    retired_legacy_agents: Vec<String>,
    preserved_resources: Vec<String>,
    legacy_runs: LegacyRunDisposition,
}

const PUBLICATION_JOURNAL_RELATIVE: &str = "koni/migrations/schema2-publication.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PublicationPhase {
    Prepared,
    SourceMoved,
    AgentsMoved,
    DestinationPublished,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublicationBoundary {
    Prepared,
    SourceRenameBound,
    SourceMoved,
    AgentRenameBound(usize),
    AgentMoved(usize),
    AgentsMoved,
    DestinationRenameBound,
    DestinationPublished,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PublicationJournal {
    schema_version: String,
    migration_id: String,
    plan: Schema2MigrationPlan,
    phase: PublicationPhase,
    moved_agents: usize,
    input_identities: BTreeMap<String, String>,
    staged_tree_sha256: String,
    receipt_sha256: String,
    journal_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyCodexAgent {
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
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacySandbox {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    approval_policy: Option<String>,
    #[serde(default)]
    network_access: bool,
    #[serde(default)]
    writable_roots: Vec<String>,
}

pub struct Schema2Migrator;

impl Schema2Migrator {
    /// Inspect schema-1 configuration and its ownership manifest without
    /// changing the project.
    pub fn inspect(project_root: &Path) -> Result<LegacySchema1Snapshot> {
        let project_root = canonical_real_directory(project_root, "project root")?;
        inspect_at(&project_root)
    }

    /// Build a serializable dry-run plan. The returned plan pins every source
    /// input by path and SHA-256 so a later apply fails on any intervening edit.
    pub fn plan(project_root: &Path) -> Result<Schema2MigrationPlan> {
        let project_root = canonical_real_directory(project_root, "project root")?;
        if let Some(pending) = pending_publication_plan(&project_root)? {
            return Ok(pending);
        }
        Self::plan_with_id(&project_root, &Uuid::now_v7().to_string())
    }

    /// Convert a just-staged schema-1 installation into a schema-2 tree.
    ///
    /// This is intentionally narrower than publication migration: `project_root`
    /// is a private installer staging directory with no run registry or live
    /// configuration consumers. The method reuses the exact schema/resource/
    /// agent transformer used by [`Self::apply`], but leaves publication of the
    /// validated `.koni` tree to the install transaction.
    pub fn convert_fresh_install(project_root: &Path) -> Result<Schema2MigrationResult> {
        let plan = Self::plan(project_root)?;
        let destination = plan.project_root.join(SCHEMA2_CONFIG_ROOT);
        let result = stage_schema2(&plan, LegacyRunDisposition::NoLegacyRuns, &destination)
            .and_then(|()| validate_staged_schema2(&plan, &destination));
        if let Err(error) = result {
            let _ = remove_owned_tree(&destination);
            return Err(error);
        }
        let receipt_sha256 = sha256_file(&destination.join(SCHEMA2_MIGRATION_RECEIPT))?;
        migration_result(&plan, &receipt_sha256)
    }

    fn plan_with_id(project_root: &Path, migration_id: &str) -> Result<Schema2MigrationPlan> {
        validate_migration_id(migration_id)?;
        let project_root = canonical_real_directory(project_root, "project root")?;
        let legacy = inspect_at(&project_root)?;
        ensure_absent_beneath(
            &project_root,
            Path::new(SCHEMA2_CONFIG_ROOT),
            "schema-2 destination",
        )?;

        let backup_root = format!(".koni-migrations/{migration_id}");
        ensure_absent_beneath(&project_root, Path::new(&backup_root), "migration backup")?;
        let staging_relative = PathBuf::from(format!(".koni-migration-{migration_id}"));
        ensure_absent_beneath(&project_root, &staging_relative, "migration staging")?;

        let (agent_resources, retired_legacy_agents, preserved_resources) =
            derive_resource_plan(&project_root, &legacy)?;

        Ok(Schema2MigrationPlan {
            schema_version: KONI_SCHEMA2_VERSION.to_owned(),
            migration_id: migration_id.to_owned(),
            migration: MIGRATION_KIND.to_owned(),
            project_root: project_root.clone(),
            source_root: LEGACY_CONFIG_ROOT.to_owned(),
            destination_root: SCHEMA2_CONFIG_ROOT.to_owned(),
            backup_root,
            legacy,
            agents: agent_resources,
            retired_legacy_agents,
            preserved_resources,
            required_legacy_run_action: "archive_active_codex_runs_before_publish".to_owned(),
        })
    }

    /// Apply a previously inspected plan as one publication transaction.
    /// Source and ownership hashes are rechecked before staging and again
    /// immediately before any legacy path is moved. `validate_compiled_profile`
    /// must compile the complete staged schema-2 catalog/profile; returning an
    /// error removes staging and leaves every legacy path untouched.
    pub fn apply<V>(
        plan: &Schema2MigrationPlan,
        run_proof: Schema2RunDispositionProof,
        validate_compiled_profile: V,
    ) -> Result<Schema2MigrationResult>
    where
        V: FnOnce(&Path) -> Result<()>,
    {
        Self::apply_with_hooks(
            plan,
            run_proof,
            validate_compiled_profile,
            || Ok(()),
            |_| Ok(()),
        )
    }

    #[cfg(test)]
    fn apply_with_hook<V, F>(
        plan: &Schema2MigrationPlan,
        run_proof: Schema2RunDispositionProof,
        validate_compiled_profile: V,
        before_publish: F,
    ) -> Result<Schema2MigrationResult>
    where
        V: FnOnce(&Path) -> Result<()>,
        F: FnOnce() -> Result<()>,
    {
        Self::apply_with_hooks(
            plan,
            run_proof,
            validate_compiled_profile,
            before_publish,
            |_| Ok(()),
        )
    }

    fn apply_with_hooks<V, F, H>(
        plan: &Schema2MigrationPlan,
        run_proof: Schema2RunDispositionProof,
        validate_compiled_profile: V,
        before_publish: F,
        mut after_boundary: H,
    ) -> Result<Schema2MigrationResult>
    where
        V: FnOnce(&Path) -> Result<()>,
        F: FnOnce() -> Result<()>,
        H: FnMut(PublicationBoundary) -> Result<()>,
    {
        run_proof.verify(plan)?;
        if publication_journal_path(&run_proof.compiler_state_root).exists() {
            validate_static_plan_shape(plan)?;
            let journal = read_publication_journal(plan, &run_proof.compiler_state_root)?;
            if journal.plan != *plan {
                return Err(migration_error(
                    "publication journal belongs to a different migration plan",
                ));
            }
            validate_recovery_plan_derivation(plan)?;
            let compiled_root = recovery_compiled_root(plan)?;
            validate_staged_schema2(plan, &compiled_root)?;
            validate_compiled_profile(&compiled_root).map_err(|error| {
                migration_error(format!(
                    "recovered schema-2 catalog/profile compilation failed: {error}"
                ))
            })?;
            recover_publication(plan, &journal, &run_proof.compiler_state_root)?;
            return migration_result(plan, &journal.receipt_sha256);
        }
        let current = inspect_at(&plan.project_root)?;
        if current != plan.legacy {
            return Err(migration_error(
                "schema-1 configuration or an owned resource changed after the migration plan was created",
            ));
        }
        validate_plan_shape(plan)?;
        let staging_root = plan
            .project_root
            .join(format!(".koni-migration-{}", plan.migration_id));
        ensure_absent_beneath(
            &plan.project_root,
            Path::new(&plan.destination_root),
            "schema-2 destination",
        )?;
        ensure_absent_beneath(
            &plan.project_root,
            Path::new(&plan.backup_root),
            "migration backup",
        )?;
        let staging_relative = PathBuf::from(format!(".koni-migration-{}", plan.migration_id));
        ensure_absent_beneath(&plan.project_root, &staging_relative, "migration staging")?;

        fs::create_dir(&staging_root).map_err(|error| io_error(&staging_root, error))?;
        let staged_config = staging_root.join(".koni");
        let stage_result = stage_schema2(plan, run_proof.legacy_runs.clone(), &staged_config);
        if let Err(error) = stage_result {
            let _ = remove_owned_tree(&staging_root);
            return Err(error);
        }
        let ready_to_publish = (|| -> Result<(String, BTreeMap<String, String>)> {
            validate_staged_schema2(plan, &staged_config)?;
            validate_compiled_profile(&staged_config).map_err(|error| {
                migration_error(format!(
                    "staged schema-2 catalog/profile compilation failed: {error}"
                ))
            })?;
            // The integration validator is contractually read-only. Repeat
            // structural checks so an accidental write cannot publish legacy
            // keys or malformed generated agent resources.
            validate_staged_schema2(plan, &staged_config)?;

            // Close the longest race window before moving any source path.
            let current = inspect_at(&plan.project_root)?;
            if current != plan.legacy {
                return Err(migration_error(
                    "schema-1 configuration or an owned resource changed while schema 2 was staged",
                ));
            }
            let input_identities = capture_publication_input_identities(plan)?;
            before_publish()?;
            run_proof.verify(plan)?;
            // The integration hook and any concurrent actor are outside the
            // migration trust boundary. Re-pin the complete source snapshot
            // after that boundary, not merely before it.
            let current = inspect_at(&plan.project_root)?;
            if current != plan.legacy {
                return Err(migration_error(
                    "schema-1 configuration or an owned resource changed at the publication boundary",
                ));
            }
            if capture_publication_input_identities(plan)? != input_identities {
                return Err(migration_error(
                    "a schema-1 publication input was replaced at the publication boundary",
                ));
            }
            Ok((
                sha256_file(&staged_config.join(SCHEMA2_MIGRATION_RECEIPT))?,
                input_identities,
            ))
        })();
        let (receipt_sha256, input_identities) = match ready_to_publish {
            Ok(ready) => ready,
            Err(error) => {
                let _ = remove_owned_tree(&staging_root);
                return Err(error);
            }
        };

        // The hook used by tests can create a destination collision after the
        // final source revalidation; publication must still roll back safely.
        if !plan.project_root.join(LEGACY_CONFIG_ROOT).is_dir() {
            let _ = remove_owned_tree(&staging_root);
            return Err(migration_error(
                "schema-1 configuration disappeared before publication",
            ));
        }
        let staged_tree_sha256 = hashed_tree_digest(&staged_config)?;
        let publication = publish_transaction(
            plan,
            &run_proof.compiler_state_root,
            &staging_root,
            &staged_config,
            &staged_tree_sha256,
            &receipt_sha256,
            &input_identities,
            &mut after_boundary,
        );
        if let Err(error) = publication {
            // Once the fsynced publication journal exists, staging is durable
            // recovery input and must not be cleaned up by an ordinary error.
            if !publication_journal_path(&run_proof.compiler_state_root).exists() {
                let _ = remove_owned_tree(&staging_root);
            }
            return Err(error);
        }
        if staging_root.exists() {
            let _ = remove_owned_tree(&staging_root);
        }

        migration_result(plan, &receipt_sha256)
    }
}

fn migration_result(
    plan: &Schema2MigrationPlan,
    receipt_sha256: &str,
) -> Result<Schema2MigrationResult> {
    Ok(Schema2MigrationResult {
        schema_version: KONI_SCHEMA2_VERSION.to_owned(),
        migration_id: plan.migration_id.clone(),
        destination_root: plan.project_root.join(&plan.destination_root),
        backup_root: plan.project_root.join(&plan.backup_root),
        converted_agents: plan.agents.len(),
        retired_legacy_agents: plan.retired_legacy_agents.len(),
        preserved_resources: plan.preserved_resources.len(),
        receipt_sha256: receipt_sha256.to_owned(),
    })
}

fn inspect_at(project_root: &Path) -> Result<LegacySchema1Snapshot> {
    let source_root = project_root.join(LEGACY_CONFIG_ROOT);
    ensure_real_relative_directory(
        project_root,
        Path::new(LEGACY_CONFIG_ROOT),
        "schema-1 Koni configuration",
    )?;
    let config_files = collect_hashed_files(project_root, &source_root)?;
    if config_files.is_empty() {
        return Err(migration_error("schema-1 Koni configuration is empty"));
    }
    validate_legacy_entrypoint(&source_root)?;

    let manifest_path = source_root.join(LEGACY_RESOURCE_MANIFEST);
    ensure_real_relative_file(
        project_root,
        Path::new(LEGACY_CONFIG_ROOT)
            .join(LEGACY_RESOURCE_MANIFEST)
            .as_path(),
        "legacy Koni resource ownership manifest",
    )?;
    let manifest: LegacyResourceManifest = serde_json::from_slice(&read_file(&manifest_path)?)
        .map_err(|source| KoniError::Json {
            path: manifest_path.clone(),
            source,
        })?;
    if manifest.schema_version != "1.0" || manifest.owner != "koni" {
        return Err(migration_error(format!(
            "unsupported ownership manifest at {}; expected schema 1.0 owned by koni",
            manifest_path.display()
        )));
    }

    let mut owned_resources = Vec::new();
    let mut owned_paths = BTreeSet::new();
    for resource in manifest.resources {
        validate_owned_resource_path(&resource.path)?;
        validate_sha256(&resource.sha256, &resource.path)?;
        if !owned_paths.insert(resource.path.clone()) {
            return Err(migration_error(format!(
                "duplicate owned resource in {}: {}",
                manifest_path.display(),
                resource.path
            )));
        }
        let path = project_root.join(&resource.path);
        ensure_real_relative_file(
            project_root,
            Path::new(&resource.path),
            "manifest-owned legacy resource",
        )?;
        let actual = sha256_file(&path)?;
        if actual != resource.sha256 {
            return Err(migration_error(format!(
                "manifest-owned resource changed after installation: {}",
                path.display()
            )));
        }
        owned_resources.push(HashedMigrationFile {
            path: resource.path,
            sha256: actual,
        });
    }
    owned_resources.sort_by(|left, right| left.path.cmp(&right.path));

    let referenced_agents = collect_legacy_agent_references(&source_root)?;
    let snapshot_sha256 = snapshot_hash(&config_files, &owned_resources);
    Ok(LegacySchema1Snapshot {
        schema_version: "1.0".to_owned(),
        project_root: project_root.to_path_buf(),
        config_root: LEGACY_CONFIG_ROOT.to_owned(),
        config_files,
        owned_resources,
        referenced_agents,
        snapshot_sha256,
    })
}

fn validate_plan_shape(plan: &Schema2MigrationPlan) -> Result<()> {
    validate_static_plan_shape(plan)?;
    let mut destinations = BTreeSet::new();
    for agent in &plan.agents {
        validate_agent_id(&agent.id, Path::new(&agent.source.path))?;
        let expected = format!(".koni/agents/{}.yaml", agent.id);
        if agent.destination != expected || !destinations.insert(agent.destination.as_str()) {
            return Err(migration_error(format!(
                "invalid or duplicate agent migration destination: {}",
                agent.destination
            )));
        }
    }
    let (expected_agents, expected_retired, expected_preserved) =
        derive_resource_plan(&plan.project_root, &plan.legacy)?;
    if plan.agents != expected_agents
        || plan.retired_legacy_agents != expected_retired
        || plan.preserved_resources != expected_preserved
    {
        return Err(migration_error(
            "agent conversions or preserved resources do not match the hash-pinned legacy snapshot",
        ));
    }
    Ok(())
}

fn validate_static_plan_shape(plan: &Schema2MigrationPlan) -> Result<()> {
    validate_migration_id(&plan.migration_id)?;
    if plan.schema_version != KONI_SCHEMA2_VERSION
        || plan.migration != MIGRATION_KIND
        || plan.source_root != LEGACY_CONFIG_ROOT
        || plan.destination_root != SCHEMA2_CONFIG_ROOT
        || plan.backup_root != format!(".koni-migrations/{}", plan.migration_id)
        || plan.legacy.project_root != plan.project_root
        || plan.legacy.config_root != plan.source_root
        || plan.required_legacy_run_action != "archive_active_codex_runs_before_publish"
    {
        return Err(migration_error(
            "invalid or tampered schema-2 migration plan",
        ));
    }
    let canonical = canonical_real_directory(&plan.project_root, "project root")?;
    if canonical != plan.project_root {
        return Err(migration_error(
            "migration plan project root is no longer canonical",
        ));
    }
    let mut destinations = BTreeSet::new();
    for agent in &plan.agents {
        validate_agent_id(&agent.id, Path::new(&agent.source.path))?;
        let expected = format!(".koni/agents/{}.yaml", agent.id);
        if agent.destination != expected || !destinations.insert(agent.destination.as_str()) {
            return Err(migration_error(format!(
                "invalid or duplicate agent migration destination: {}",
                agent.destination
            )));
        }
    }
    Ok(())
}

fn derive_resource_plan(
    project_root: &Path,
    legacy: &LegacySchema1Snapshot,
) -> Result<(
    Vec<AgentConversionPlan>,
    Vec<HashedMigrationFile>,
    Vec<HashedMigrationFile>,
)> {
    derive_resource_plan_with(legacy, |resource| Ok(project_root.join(&resource.path)))
}

fn derive_resource_plan_with<F>(
    legacy: &LegacySchema1Snapshot,
    mut locate_resource: F,
) -> Result<(
    Vec<AgentConversionPlan>,
    Vec<HashedMigrationFile>,
    Vec<HashedMigrationFile>,
)>
where
    F: FnMut(&HashedMigrationFile) -> Result<PathBuf>,
{
    let mut agent_ids = BTreeSet::new();
    let mut source_by_id = BTreeMap::new();
    let mut retired = Vec::new();
    let config_paths = legacy
        .config_files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    for resource in &legacy.owned_resources {
        if !resource.path.starts_with(".codex/agents/") {
            continue;
        }
        let source_path = locate_resource(resource)?;
        let agent = parse_legacy_agent(&source_path)?;
        validate_agent_id(&agent.name, &source_path)?;
        if !agent_ids.insert(agent.name.clone()) {
            return Err(migration_error(format!(
                "duplicate owned Codex agent id {}",
                agent.name
            )));
        }
        source_by_id.insert(agent.name, resource.clone());
        retired.push(resource.clone());
    }
    retired.sort_by(|left, right| left.path.cmp(&right.path));
    let mut agents = Vec::new();
    for reference in &legacy.referenced_agents {
        let source = source_by_id.get(reference).ok_or_else(|| {
            migration_error(format!(
                "profile references Codex agent {reference:?}, but no hash-pinned Koni-owned `.codex/agents` resource defines it"
            ))
        })?;
        let legacy_destination = format!(".codex/koni/agents/{reference}.yaml");
        if config_paths.contains(legacy_destination.as_str()) {
            return Err(migration_error(format!(
                "generated schema-2 agent would overwrite migrated profile resource {legacy_destination}"
            )));
        }
        agents.push(AgentConversionPlan {
            destination: format!(".koni/agents/{reference}.yaml"),
            id: reference.clone(),
            source: source.clone(),
        });
    }
    agents.sort_by(|left, right| left.id.cmp(&right.id));
    let preserved = legacy
        .owned_resources
        .iter()
        .filter(|resource| resource.path.starts_with(".agents/skills/"))
        .cloned()
        .collect();
    Ok((agents, retired, preserved))
}

fn stage_schema2(
    plan: &Schema2MigrationPlan,
    legacy_runs: LegacyRunDisposition,
    staged_config: &Path,
) -> Result<()> {
    fs::create_dir(staged_config).map_err(|error| io_error(staged_config, error))?;
    let source_root = plan.project_root.join(LEGACY_CONFIG_ROOT);
    for file in &plan.legacy.config_files {
        let relative = Path::new(&file.path)
            .strip_prefix(LEGACY_CONFIG_ROOT)
            .map_err(|_| {
                migration_error(format!("legacy config path escaped root: {}", file.path))
            })?;
        if relative == Path::new(LEGACY_RESOURCE_MANIFEST)
            || relative == Path::new(SCHEMA2_MIGRATION_RECEIPT)
        {
            continue;
        }
        let source = source_root.join(relative);
        let destination = staged_config.join(relative);
        create_real_parents(staged_config, &destination)?;
        match source.extension().and_then(|extension| extension.to_str()) {
            Some("yaml" | "yml") => migrate_yaml_file(&source, &destination)?,
            Some("toml") => migrate_toml_file(&source, &destination)?,
            _ => {
                fs::copy(&source, &destination).map_err(|error| io_error(&destination, error))?;
            }
        }
    }

    let agents_root = staged_config.join("agents");
    if !plan.agents.is_empty() {
        fs::create_dir_all(&agents_root).map_err(|error| io_error(&agents_root, error))?;
    }
    for conversion in &plan.agents {
        let source = plan.project_root.join(&conversion.source.path);
        let legacy = parse_legacy_agent(&source)?;
        if legacy.name != conversion.id {
            return Err(migration_error(format!(
                "agent id changed after planning at {}",
                source.display()
            )));
        }
        let resource = convert_legacy_agent(legacy, &source)?;
        let output = staged_config
            .join("agents")
            .join(format!("{}.yaml", resource.id));
        let bytes = serde_yaml::to_string(&resource).map_err(|error| {
            migration_error(format!("could not serialize {}: {error}", output.display()))
        })?;
        fs::write(&output, bytes).map_err(|error| io_error(&output, error))?;
    }

    let resource_manifest = Schema2ResourceManifest {
        schema_version: KONI_SCHEMA2_VERSION.to_owned(),
        owner: "koni".to_owned(),
        external_resources: plan.preserved_resources.clone(),
    };
    write_json(
        &staged_config.join(SCHEMA2_RESOURCE_MANIFEST),
        &resource_manifest,
    )?;
    let receipt = Schema2MigrationReceipt {
        schema_version: KONI_SCHEMA2_VERSION.to_owned(),
        migration: MIGRATION_KIND.to_owned(),
        migration_id: plan.migration_id.clone(),
        source_root: plan.source_root.clone(),
        source_snapshot_sha256: plan.legacy.snapshot_sha256.clone(),
        backup_root: plan.backup_root.clone(),
        converted_agents: plan.agents.iter().map(|agent| agent.id.clone()).collect(),
        retired_legacy_agents: plan
            .retired_legacy_agents
            .iter()
            .map(|resource| resource.path.clone())
            .collect(),
        preserved_resources: plan
            .preserved_resources
            .iter()
            .map(|resource| resource.path.clone())
            .collect(),
        legacy_runs,
    };
    write_json(&staged_config.join(SCHEMA2_MIGRATION_RECEIPT), &receipt)?;
    Ok(())
}

fn validate_staged_schema2(plan: &Schema2MigrationPlan, staged_config: &Path) -> Result<()> {
    ensure_real_directory(staged_config, "staged schema-2 configuration")?;
    let entrypoints = ["project.yaml", "profile.yaml", "koni.yaml", "koni.toml"];
    if !entrypoints
        .iter()
        .any(|entrypoint| staged_config.join(entrypoint).is_file())
    {
        return Err(migration_error(
            "staged schema-2 configuration has no supported entrypoint",
        ));
    }
    let files = collect_hashed_files(staged_config, staged_config)?;
    for file in &files {
        let path = staged_config.join(&file.path);
        if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("yaml" | "yml")
        ) {
            let value: serde_yaml::Value =
                serde_yaml::from_slice(&read_file(&path)?).map_err(|source| KoniError::Yaml {
                    path: path.clone(),
                    source,
                })?;
            reject_legacy_keys_yaml(&value, &path)?;
        }
    }
    for agent in &plan.agents {
        let path = staged_config
            .join("agents")
            .join(format!("{}.yaml", agent.id));
        let resource: KoniAgentResourceV2 =
            serde_yaml::from_slice(&read_file(&path)?).map_err(|source| KoniError::Yaml {
                path: path.clone(),
                source,
            })?;
        if resource.schema_version != KONI_SCHEMA2_VERSION || resource.id != agent.id {
            return Err(migration_error(format!(
                "invalid staged schema-2 agent at {}",
                path.display()
            )));
        }
    }
    Ok(())
}

#[expect(
    clippy::too_many_arguments,
    reason = "publication passes every pinned migration identity and recovery boundary explicitly"
)]
fn publish_transaction<H>(
    plan: &Schema2MigrationPlan,
    compiler_state_root: &Path,
    staging_root: &Path,
    staged_config: &Path,
    staged_tree_sha256: &str,
    receipt_sha256: &str,
    input_identities: &BTreeMap<String, String>,
    after_boundary: &mut H,
) -> Result<()>
where
    H: FnMut(PublicationBoundary) -> Result<()>,
{
    let backup_root = plan.project_root.join(&plan.backup_root);
    ensure_absent_beneath(
        &plan.project_root,
        Path::new(SCHEMA2_CONFIG_ROOT),
        "schema-2 destination",
    )?;
    create_backup_root(&plan.project_root, &backup_root)?;
    sync_tree(staged_config)?;
    sync_directory(&plan.project_root)?;
    let journal = PublicationJournal {
        schema_version: KONI_SCHEMA2_VERSION.to_owned(),
        migration_id: plan.migration_id.clone(),
        plan: plan.clone(),
        phase: PublicationPhase::Prepared,
        moved_agents: 0,
        input_identities: input_identities.clone(),
        staged_tree_sha256: staged_tree_sha256.to_owned(),
        receipt_sha256: receipt_sha256.to_owned(),
        journal_sha256: String::new(),
    };
    write_publication_journal(plan, compiler_state_root, journal)?;
    after_boundary(PublicationBoundary::Prepared)?;
    let journal = read_publication_journal(plan, compiler_state_root)?;
    recover_publication_with_hook(plan, &journal, compiler_state_root, after_boundary)?;

    // `staging_root` now contains no configuration tree. Its removal is a
    // cleanup only; a published migration remains valid if cleanup races.
    if staging_root.exists() {
        let _ = fs::remove_dir(staging_root);
    }
    Ok(())
}

fn recover_publication(
    plan: &Schema2MigrationPlan,
    initial: &PublicationJournal,
    compiler_state_root: &Path,
) -> Result<()> {
    recover_publication_with_hook(plan, initial, compiler_state_root, &mut |_| Ok(()))
}

fn recover_publication_with_hook<H>(
    plan: &Schema2MigrationPlan,
    initial: &PublicationJournal,
    compiler_state_root: &Path,
    after_boundary: &mut H,
) -> Result<()>
where
    H: FnMut(PublicationBoundary) -> Result<()>,
{
    validate_publication_journal(plan, initial)?;
    let mut journal = initial.clone();
    let source_root = plan.project_root.join(LEGACY_CONFIG_ROOT);
    let backup_root = plan.project_root.join(&plan.backup_root);
    let backup_config = backup_root.join("config-v1");
    let staging_root = plan
        .project_root
        .join(format!(".koni-migration-{}", plan.migration_id));
    let staged_config = staging_root.join(".koni");
    let destination = plan.project_root.join(SCHEMA2_CONFIG_ROOT);

    if journal.phase == PublicationPhase::Prepared {
        match (source_root.exists(), backup_config.exists()) {
            (true, false) => {
                verify_journaled_input_identity(&journal, LEGACY_CONFIG_ROOT, &source_root)?;
                let current = inspect_at(&plan.project_root)?;
                if current != plan.legacy {
                    return Err(migration_error(
                        "schema-1 source changed before journaled publication",
                    ));
                }
                let rename = SecureRenameBinding::bind(&source_root, &backup_config)?;
                after_boundary(PublicationBoundary::SourceRenameBound)?;
                rename.commit()?;
                verify_journaled_input_identity(&journal, LEGACY_CONFIG_ROOT, &backup_config)?;
                if let Err(error) = verify_backup_config(plan, &backup_config) {
                    let _ = SecureRenameBinding::bind(&backup_config, &source_root)
                        .and_then(SecureRenameBinding::commit);
                    return Err(error);
                }
            }
            (false, true) => {
                verify_journaled_input_identity(&journal, LEGACY_CONFIG_ROOT, &backup_config)?;
                verify_backup_config(plan, &backup_config)?;
            }
            (true, true) => {
                return Err(migration_error(
                    "both live and backup schema-1 configuration exist during recovery",
                ));
            }
            (false, false) => {
                return Err(migration_error(
                    "schema-1 configuration and its backup are both missing during recovery",
                ));
            }
        }
        journal.phase = PublicationPhase::SourceMoved;
        journal = write_publication_journal(plan, compiler_state_root, journal)?;
        after_boundary(PublicationBoundary::SourceMoved)?;
    }

    if matches!(
        journal.phase,
        PublicationPhase::SourceMoved | PublicationPhase::AgentsMoved
    ) {
        while journal.moved_agents < plan.retired_legacy_agents.len() {
            let resource = &plan.retired_legacy_agents[journal.moved_agents];
            let source = plan.project_root.join(&resource.path);
            let backup = backup_root.join("native-v1").join(&resource.path);
            match (source.exists(), backup.exists()) {
                (true, false) => {
                    verify_journaled_input_identity(&journal, &resource.path, &source)?;
                    ensure_real_relative_file(
                        &plan.project_root,
                        Path::new(&resource.path),
                        "legacy agent publication input",
                    )?;
                    if sha256_file(&source)? != resource.sha256 {
                        return Err(migration_error(format!(
                            "legacy agent changed before publication: {}",
                            source.display()
                        )));
                    }
                    create_real_parents(&backup_root, &backup)?;
                    let rename = SecureRenameBinding::bind(&source, &backup)?;
                    after_boundary(PublicationBoundary::AgentRenameBound(
                        journal.moved_agents + 1,
                    ))?;
                    rename.commit()?;
                    verify_journaled_input_identity(&journal, &resource.path, &backup)?;
                    if sha256_file(&backup)? != resource.sha256 {
                        let _ = SecureRenameBinding::bind(&backup, &source)
                            .and_then(SecureRenameBinding::commit);
                        return Err(migration_error(format!(
                            "legacy agent changed across publication rename: {}",
                            resource.path
                        )));
                    }
                }
                (false, true) => {
                    ensure_real_file(&backup, "journaled legacy agent backup")?;
                    verify_journaled_input_identity(&journal, &resource.path, &backup)?;
                    if sha256_file(&backup)? != resource.sha256 {
                        return Err(migration_error(format!(
                            "journaled legacy agent backup changed: {}",
                            backup.display()
                        )));
                    }
                }
                (true, true) => {
                    return Err(migration_error(format!(
                        "both live and backup copies exist for {}",
                        resource.path
                    )));
                }
                (false, false) => {
                    return Err(migration_error(format!(
                        "both live and backup copies are missing for {}",
                        resource.path
                    )));
                }
            }
            journal.moved_agents += 1;
            journal = write_publication_journal(plan, compiler_state_root, journal)?;
            after_boundary(PublicationBoundary::AgentMoved(journal.moved_agents))?;
        }
        journal.phase = PublicationPhase::AgentsMoved;
        journal = write_publication_journal(plan, compiler_state_root, journal)?;
        after_boundary(PublicationBoundary::AgentsMoved)?;
    }

    if journal.phase == PublicationPhase::AgentsMoved {
        match (staged_config.exists(), destination.exists()) {
            (true, false) => {
                validate_staged_schema2(plan, &staged_config)?;
                if hashed_tree_digest(&staged_config)? != journal.staged_tree_sha256 {
                    return Err(migration_error(
                        "staged schema-2 tree changed after compiler validation",
                    ));
                }
                let rename = SecureRenameBinding::bind(&staged_config, &destination)?;
                after_boundary(PublicationBoundary::DestinationRenameBound)?;
                rename.commit()?;
            }
            (false, true) => {}
            (true, true) => {
                return Err(migration_error(
                    "both staged and published schema-2 trees exist during recovery",
                ));
            }
            (false, false) => {
                return Err(migration_error(
                    "staged and published schema-2 trees are both missing during recovery",
                ));
            }
        }
        validate_staged_schema2(plan, &destination)?;
        if hashed_tree_digest(&destination)? != journal.staged_tree_sha256
            || sha256_file(&destination.join(SCHEMA2_MIGRATION_RECEIPT))? != journal.receipt_sha256
        {
            return Err(migration_error(
                "published schema-2 tree differs from the fsynced publication journal",
            ));
        }
        journal.phase = PublicationPhase::DestinationPublished;
        journal = write_publication_journal(plan, compiler_state_root, journal)?;
        after_boundary(PublicationBoundary::DestinationPublished)?;
    }

    if matches!(
        journal.phase,
        PublicationPhase::DestinationPublished | PublicationPhase::Complete
    ) {
        verify_published_recovery_state(plan, &journal, &destination, &backup_config)?;
    }

    if journal.phase == PublicationPhase::DestinationPublished {
        journal.phase = PublicationPhase::Complete;
        write_publication_journal(plan, compiler_state_root, journal)?;
        after_boundary(PublicationBoundary::Complete)?;
    }
    Ok(())
}

fn verify_published_recovery_state(
    plan: &Schema2MigrationPlan,
    journal: &PublicationJournal,
    destination: &Path,
    backup_config: &Path,
) -> Result<()> {
    if plan.project_root.join(LEGACY_CONFIG_ROOT).exists() {
        return Err(migration_error(
            "live schema-1 configuration reappeared after schema-2 publication",
        ));
    }
    verify_journaled_input_identity(journal, LEGACY_CONFIG_ROOT, backup_config)?;
    verify_backup_config(plan, backup_config)?;
    let backup_root = plan.project_root.join(&plan.backup_root);
    for resource in &plan.retired_legacy_agents {
        if plan.project_root.join(&resource.path).exists() {
            return Err(migration_error(format!(
                "retired legacy agent reappeared after publication: {}",
                resource.path
            )));
        }
        let backup = backup_root.join("native-v1").join(&resource.path);
        ensure_real_file(&backup, "published legacy agent backup")?;
        verify_journaled_input_identity(journal, &resource.path, &backup)?;
        if sha256_file(&backup)? != resource.sha256 {
            return Err(migration_error(format!(
                "published legacy agent backup changed: {}",
                backup.display()
            )));
        }
    }
    validate_staged_schema2(plan, destination)?;
    if hashed_tree_digest(destination)? != journal.staged_tree_sha256
        || sha256_file(&destination.join(SCHEMA2_MIGRATION_RECEIPT))? != journal.receipt_sha256
    {
        return Err(migration_error(
            "published schema-2 tree differs from the fsynced publication journal",
        ));
    }
    Ok(())
}

fn publication_journal_path(compiler_state_root: &Path) -> PathBuf {
    compiler_state_root.join(PUBLICATION_JOURNAL_RELATIVE)
}

fn journal_digest(journal: &PublicationJournal) -> Result<String> {
    let mut unsigned = journal.clone();
    unsigned.journal_sha256.clear();
    let bytes = serde_json::to_vec(&unsigned)
        .map_err(|error| migration_error(format!("could not hash publication journal: {error}")))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn write_publication_journal(
    plan: &Schema2MigrationPlan,
    compiler_state_root: &Path,
    mut journal: PublicationJournal,
) -> Result<PublicationJournal> {
    if journal.plan != *plan {
        return Err(migration_error(
            "refusing to write publication state for a different migration plan",
        ));
    }
    let canonical_state = canonical_real_directory(compiler_state_root, "compiler state root")?;
    if canonical_state != compiler_state_root {
        return Err(migration_error("compiler state root is noncanonical"));
    }
    journal.journal_sha256 = journal_digest(&journal)?;
    let path = publication_journal_path(compiler_state_root);
    let parent = path
        .parent()
        .ok_or_else(|| migration_error("publication journal has no parent"))?;
    let sidecar = compiler_state_root.join("koni");
    match fs::symlink_metadata(&sidecar) {
        Ok(_) => ensure_real_relative_directory(
            compiler_state_root,
            Path::new("koni"),
            "compiler sidecar root",
        )?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&sidecar).map_err(|error| io_error(&sidecar, error))?;
            sync_directory(&sidecar)?;
            sync_directory(compiler_state_root)?;
        }
        Err(error) => return Err(io_error(&sidecar, error)),
    }
    let migrations = sidecar.join("migrations");
    match fs::symlink_metadata(&migrations) {
        Ok(_) => ensure_real_relative_directory(
            compiler_state_root,
            Path::new("koni/migrations"),
            "compiler migration-state directory",
        )?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&migrations).map_err(|error| io_error(&migrations, error))?;
            sync_directory(&migrations)?;
            sync_directory(&sidecar)?;
        }
        Err(error) => return Err(io_error(&migrations, error)),
    }
    let temp = parent.join(format!(".publication-journal-{}.tmp", Uuid::now_v7()));
    let mut bytes = serde_json::to_vec_pretty(&journal).map_err(|error| {
        migration_error(format!("could not serialize {}: {error}", path.display()))
    })?;
    bytes.push(b'\n');
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| io_error(&temp, error))?;
    file.write_all(&bytes)
        .map_err(|error| io_error(&temp, error))?;
    file.sync_all().map_err(|error| io_error(&temp, error))?;
    drop(file);
    fs::rename(&temp, &path).map_err(|error| io_error(&path, error))?;
    sync_directory(parent)?;
    Ok(journal)
}

fn read_publication_journal(
    plan: &Schema2MigrationPlan,
    compiler_state_root: &Path,
) -> Result<PublicationJournal> {
    let path = publication_journal_path(compiler_state_root);
    ensure_real_relative_file(
        compiler_state_root,
        Path::new(PUBLICATION_JOURNAL_RELATIVE),
        "compiler-owned publication journal",
    )?;
    let journal: PublicationJournal =
        serde_json::from_slice(&read_file(&path)?).map_err(|source| KoniError::Json {
            path: path.clone(),
            source,
        })?;
    validate_publication_journal(plan, &journal)?;
    Ok(journal)
}

fn validate_publication_journal(
    plan: &Schema2MigrationPlan,
    journal: &PublicationJournal,
) -> Result<()> {
    let expected_identity_paths = std::iter::once(LEGACY_CONFIG_ROOT.to_owned())
        .chain(
            plan.retired_legacy_agents
                .iter()
                .map(|resource| resource.path.clone()),
        )
        .collect::<BTreeSet<_>>();
    if journal.schema_version != KONI_SCHEMA2_VERSION
        || journal.migration_id != plan.migration_id
        || journal.plan != *plan
        || journal.moved_agents > plan.retired_legacy_agents.len()
        || journal.journal_sha256 != journal_digest(journal)?
        || journal.staged_tree_sha256.len() != 64
        || journal.receipt_sha256.len() != 64
        || journal
            .input_identities
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>()
            != expected_identity_paths
        || journal
            .input_identities
            .values()
            .any(|identity| identity.is_empty())
    {
        return Err(migration_error(
            "publication journal is corrupt or belongs to another migration",
        ));
    }
    Ok(())
}

fn capture_publication_input_identities(
    plan: &Schema2MigrationPlan,
) -> Result<BTreeMap<String, String>> {
    ensure_real_relative_directory(
        &plan.project_root,
        Path::new(LEGACY_CONFIG_ROOT),
        "schema-1 publication input",
    )?;
    let mut identities = BTreeMap::from([(
        LEGACY_CONFIG_ROOT.to_owned(),
        filesystem_object_identity(&plan.project_root.join(LEGACY_CONFIG_ROOT))?,
    )]);
    for resource in &plan.retired_legacy_agents {
        ensure_real_relative_file(
            &plan.project_root,
            Path::new(&resource.path),
            "legacy agent publication input",
        )?;
        identities.insert(
            resource.path.clone(),
            filesystem_object_identity(&plan.project_root.join(&resource.path))?,
        );
    }
    Ok(identities)
}

fn verify_journaled_input_identity(
    journal: &PublicationJournal,
    logical_path: &str,
    actual_path: &Path,
) -> Result<()> {
    let expected = journal.input_identities.get(logical_path).ok_or_else(|| {
        migration_error(format!(
            "publication journal omitted input identity {logical_path}"
        ))
    })?;
    if filesystem_object_identity(actual_path)? != *expected {
        return Err(migration_error(format!(
            "journaled publication input identity changed: {logical_path}"
        )));
    }
    Ok(())
}

fn filesystem_object_identity(path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if metadata.file_type().is_symlink() {
        return Err(migration_error(format!(
            "publication input is a symbolic link: {}",
            path.display()
        )));
    }
    #[cfg(unix)]
    {
        Ok(format!(
            "unix:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.mode()
        ))
    }
    #[cfg(not(unix))]
    {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        Ok(format!(
            "portable:{}:{}:{}:{}",
            metadata.len(),
            modified,
            metadata.is_dir(),
            metadata.permissions().readonly()
        ))
    }
}

/// A rename bound to already-open, no-follow parent directories and the exact
/// source inode. The source name is checked again after the test/concurrency
/// boundary and the destination is checked after `renameat`, closing both
/// ancestor substitution and same-byte leaf replacement races.
#[cfg(unix)]
struct SecureRenameBinding {
    source_parent: rustix::fd::OwnedFd,
    destination_parent: rustix::fd::OwnedFd,
    source_object: rustix::fd::OwnedFd,
    source_name: OsString,
    destination_name: OsString,
    source_path: PathBuf,
    destination_path: PathBuf,
    identity: String,
}

#[cfg(unix)]
impl SecureRenameBinding {
    fn bind(source: &Path, destination: &Path) -> Result<Self> {
        use rustix::fs::{Mode, OFlags, fstat, openat, statat};

        let source_parent_path = source
            .parent()
            .ok_or_else(|| migration_error("publication source has no parent"))?;
        let destination_parent_path = destination
            .parent()
            .ok_or_else(|| migration_error("publication destination has no parent"))?;
        let source_name = source
            .file_name()
            .ok_or_else(|| migration_error("publication source has no leaf name"))?
            .to_os_string();
        let destination_name = destination
            .file_name()
            .ok_or_else(|| migration_error("publication destination has no leaf name"))?
            .to_os_string();
        let source_parent = open_absolute_directory_no_follow(source_parent_path)?;
        let destination_parent = open_absolute_directory_no_follow(destination_parent_path)?;
        ensure_name_absent_at(
            &destination_parent,
            &destination_name,
            destination,
            "publication destination",
        )?;
        let source_object = openat(
            &source_parent,
            &source_name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|error| io_error(source, error.into()))?;
        let identity =
            stat_identity(&fstat(&source_object).map_err(|error| io_error(source, error.into()))?);
        let named = statat(
            &source_parent,
            &source_name,
            rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(|error| io_error(source, error.into()))?;
        if stat_identity(&named) != identity {
            return Err(migration_error(format!(
                "publication source changed while it was bound: {}",
                source.display()
            )));
        }
        Ok(Self {
            source_parent,
            destination_parent,
            source_object,
            source_name,
            destination_name,
            source_path: source.to_path_buf(),
            destination_path: destination.to_path_buf(),
            identity,
        })
    }

    fn commit(self) -> Result<()> {
        use rustix::fs::{AtFlags, fsync, renameat, statat};

        let named = statat(
            &self.source_parent,
            &self.source_name,
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(|error| io_error(&self.source_path, error.into()))?;
        if stat_identity(&named) != self.identity {
            return Err(migration_error(format!(
                "publication source was replaced after validation: {}",
                self.source_path.display()
            )));
        }
        ensure_name_absent_at(
            &self.destination_parent,
            &self.destination_name,
            &self.destination_path,
            "publication destination",
        )?;
        renameat(
            &self.source_parent,
            &self.source_name,
            &self.destination_parent,
            &self.destination_name,
        )
        .map_err(|error| io_error(&self.source_path, error.into()))?;
        fsync(&self.source_parent).map_err(|error| io_error(&self.source_path, error.into()))?;
        fsync(&self.destination_parent)
            .map_err(|error| io_error(&self.destination_path, error.into()))?;
        let moved = statat(
            &self.destination_parent,
            &self.destination_name,
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(|error| io_error(&self.destination_path, error.into()))?;
        if stat_identity(&moved) != self.identity {
            let _ = renameat(
                &self.destination_parent,
                &self.destination_name,
                &self.source_parent,
                &self.source_name,
            );
            let _ = fsync(&self.source_parent);
            let _ = fsync(&self.destination_parent);
            return Err(migration_error(format!(
                "publication rename moved a different filesystem object: {}",
                self.source_path.display()
            )));
        }
        // Keep the source descriptor alive through the post-rename identity
        // check; dropping it here completes the binding lifetime.
        drop(self.source_object);
        Ok(())
    }
}

#[cfg(unix)]
fn open_absolute_directory_no_follow(path: &Path) -> Result<rustix::fd::OwnedFd> {
    use rustix::fs::{Mode, OFlags, open, openat};

    const FLAGS: OFlags = OFlags::RDONLY
        .union(OFlags::DIRECTORY)
        .union(OFlags::NOFOLLOW)
        .union(OFlags::CLOEXEC)
        .union(OFlags::NONBLOCK);
    if !path.is_absolute() {
        return Err(migration_error(format!(
            "publication directory is not absolute: {}",
            path.display()
        )));
    }
    let mut directory = open(Path::new("/"), FLAGS, Mode::empty())
        .map_err(|error| io_error(Path::new("/"), error.into()))?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                directory = openat(&directory, name, FLAGS, Mode::empty())
                    .map_err(|error| io_error(path, error.into()))?;
            }
            _ => {
                return Err(migration_error(format!(
                    "publication directory is noncanonical: {}",
                    path.display()
                )));
            }
        }
    }
    Ok(directory)
}

#[cfg(unix)]
fn ensure_name_absent_at(
    parent: &rustix::fd::OwnedFd,
    name: &std::ffi::OsStr,
    path: &Path,
    label: &str,
) -> Result<()> {
    use rustix::fs::{AtFlags, statat};
    use rustix::io::Errno;

    match statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
        Err(Errno::NOENT) => Ok(()),
        Err(error) => Err(io_error(path, error.into())),
        Ok(_) => Err(migration_error(format!(
            "{label} already exists: {}",
            path.display()
        ))),
    }
}

#[cfg(unix)]
fn stat_identity(stat: &rustix::fs::Stat) -> String {
    format!("unix:{}:{}:{}", stat.st_dev, stat.st_ino, stat.st_mode)
}

#[cfg(not(unix))]
struct SecureRenameBinding;

#[cfg(not(unix))]
impl SecureRenameBinding {
    fn bind(_source: &Path, _destination: &Path) -> Result<Self> {
        Err(migration_error(
            "race-free schema-2 publication is unavailable on this platform",
        ))
    }

    fn commit(self) -> Result<()> {
        unreachable!("unsupported binding cannot be constructed")
    }
}

fn pending_publication_plan(project_root: &Path) -> Result<Option<Schema2MigrationPlan>> {
    let Some(compiler_state_root) = compiler_state_root_for_project(project_root)? else {
        return Ok(None);
    };
    let path = publication_journal_path(&compiler_state_root);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(&path, error)),
        Ok(_) => {}
    }
    let journal = read_publication_journal(
        &journal_plan_hint(&compiler_state_root)?,
        &compiler_state_root,
    )?;
    if journal.plan.project_root != project_root {
        return Err(migration_error(
            "compiler-owned publication journal belongs to a different project",
        ));
    }
    validate_recovery_plan_derivation(&journal.plan)?;
    Ok(Some(journal.plan))
}

fn compiler_state_root_for_project(project_root: &Path) -> Result<Option<PathBuf>> {
    match GitBackend::discover(project_root) {
        Ok(git) => Ok(Some(canonical_real_directory(
            git.common_dir(),
            "Git compiler-state root",
        )?)),
        Err(_) if !project_root.join(".git").exists() => Ok(None),
        Err(error) => Err(error),
    }
}

fn journal_plan_hint(compiler_state_root: &Path) -> Result<Schema2MigrationPlan> {
    let path = publication_journal_path(compiler_state_root);
    ensure_real_relative_file(
        compiler_state_root,
        Path::new(PUBLICATION_JOURNAL_RELATIVE),
        "compiler-owned publication journal",
    )?;
    let journal: PublicationJournal =
        serde_json::from_slice(&read_file(&path)?).map_err(|source| KoniError::Json {
            path: path.to_path_buf(),
            source,
        })?;
    Ok(journal.plan)
}

fn recovery_config_root(plan: &Schema2MigrationPlan) -> Result<PathBuf> {
    let source = plan.project_root.join(LEGACY_CONFIG_ROOT);
    let backup = plan.project_root.join(&plan.backup_root).join("config-v1");
    match (fs::symlink_metadata(&source), fs::symlink_metadata(&backup)) {
        (Ok(_), Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            ensure_real_relative_directory(
                &plan.project_root,
                Path::new(LEGACY_CONFIG_ROOT),
                "recoverable schema-1 source",
            )?;
            Ok(source)
        }
        (Err(error), Ok(_)) if error.kind() == std::io::ErrorKind::NotFound => {
            let relative = Path::new(&plan.backup_root).join("config-v1");
            ensure_real_relative_directory(
                &plan.project_root,
                &relative,
                "recoverable schema-1 backup",
            )?;
            Ok(backup)
        }
        (Ok(_), Ok(_)) => Err(migration_error(
            "both live and backup schema-1 configuration exist during recovery",
        )),
        (Err(left), Err(right))
            if left.kind() == std::io::ErrorKind::NotFound
                && right.kind() == std::io::ErrorKind::NotFound =>
        {
            Err(migration_error(
                "schema-1 configuration and its backup are both missing during recovery",
            ))
        }
        (Err(error), _) => Err(io_error(&source, error)),
        (_, Err(error)) => Err(io_error(&backup, error)),
    }
}

fn recovery_owned_resource_path(
    plan: &Schema2MigrationPlan,
    resource: &HashedMigrationFile,
) -> Result<PathBuf> {
    let live = plan.project_root.join(&resource.path);
    if resource.path.starts_with(".agents/skills/") {
        ensure_real_relative_file(
            &plan.project_root,
            Path::new(&resource.path),
            "preserved recovery resource",
        )?;
        return Ok(live);
    }
    let backup_relative = Path::new(&plan.backup_root)
        .join("native-v1")
        .join(&resource.path);
    let backup = plan.project_root.join(&backup_relative);
    match (fs::symlink_metadata(&live), fs::symlink_metadata(&backup)) {
        (Ok(_), Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            ensure_real_relative_file(
                &plan.project_root,
                Path::new(&resource.path),
                "recoverable live legacy resource",
            )?;
            Ok(live)
        }
        (Err(error), Ok(_)) if error.kind() == std::io::ErrorKind::NotFound => {
            ensure_real_relative_file(
                &plan.project_root,
                &backup_relative,
                "recoverable retired legacy resource",
            )?;
            Ok(backup)
        }
        (Ok(_), Ok(_)) => Err(migration_error(format!(
            "both live and backup copies exist for {}",
            resource.path
        ))),
        (Err(left), Err(right))
            if left.kind() == std::io::ErrorKind::NotFound
                && right.kind() == std::io::ErrorKind::NotFound =>
        {
            Err(migration_error(format!(
                "both live and backup copies are missing for {}",
                resource.path
            )))
        }
        (Err(error), _) => Err(io_error(&live, error)),
        (_, Err(error)) => Err(io_error(&backup, error)),
    }
}

fn validate_recovery_plan_derivation(plan: &Schema2MigrationPlan) -> Result<()> {
    validate_static_plan_shape(plan)?;
    let config_root = recovery_config_root(plan)?;
    validate_legacy_entrypoint(&config_root)?;
    let config_files = collect_hashed_files(&config_root, &config_root)?
        .into_iter()
        .map(|file| HashedMigrationFile {
            path: format!("{LEGACY_CONFIG_ROOT}/{}", file.path),
            sha256: file.sha256,
        })
        .collect::<Vec<_>>();
    let manifest_path = config_root.join(LEGACY_RESOURCE_MANIFEST);
    ensure_real_relative_file(
        &config_root,
        Path::new(LEGACY_RESOURCE_MANIFEST),
        "recoverable ownership manifest",
    )?;
    let manifest: LegacyResourceManifest = serde_json::from_slice(&read_file(&manifest_path)?)
        .map_err(|source| KoniError::Json {
            path: manifest_path.clone(),
            source,
        })?;
    if manifest.schema_version != "1.0" || manifest.owner != "koni" {
        return Err(migration_error("invalid recoverable ownership manifest"));
    }
    let mut owned_resources = Vec::new();
    let mut owned_paths = BTreeSet::new();
    for resource in manifest.resources {
        validate_owned_resource_path(&resource.path)?;
        validate_sha256(&resource.sha256, &resource.path)?;
        if !owned_paths.insert(resource.path.clone()) {
            return Err(migration_error(format!(
                "duplicate recoverable owned resource: {}",
                resource.path
            )));
        }
        let path = recovery_owned_resource_path(
            plan,
            &HashedMigrationFile {
                path: resource.path.clone(),
                sha256: resource.sha256.clone(),
            },
        )?;
        if sha256_file(&path)? != resource.sha256 {
            return Err(migration_error(format!(
                "recoverable owned resource differs from its manifest: {}",
                resource.path
            )));
        }
        owned_resources.push(HashedMigrationFile {
            path: resource.path,
            sha256: resource.sha256,
        });
    }
    owned_resources.sort_by(|left, right| left.path.cmp(&right.path));
    let referenced_agents = collect_legacy_agent_references(&config_root)?;
    let legacy = LegacySchema1Snapshot {
        schema_version: "1.0".to_owned(),
        project_root: plan.project_root.clone(),
        config_root: LEGACY_CONFIG_ROOT.to_owned(),
        snapshot_sha256: snapshot_hash(&config_files, &owned_resources),
        config_files,
        owned_resources,
        referenced_agents,
    };
    if legacy != plan.legacy {
        return Err(migration_error(
            "compiler-owned recovery journal does not match rederived schema-1 inputs",
        ));
    }
    let (agents, retired, preserved) = derive_resource_plan_with(&legacy, |resource| {
        recovery_owned_resource_path(plan, resource)
    })?;
    if agents != plan.agents
        || retired != plan.retired_legacy_agents
        || preserved != plan.preserved_resources
    {
        return Err(migration_error(
            "compiler-owned recovery journal contains non-derived destructive paths",
        ));
    }
    Ok(())
}

fn recovery_compiled_root(plan: &Schema2MigrationPlan) -> Result<PathBuf> {
    let staging_relative =
        PathBuf::from(format!(".koni-migration-{}", plan.migration_id)).join(SCHEMA2_CONFIG_ROOT);
    let staged = plan.project_root.join(&staging_relative);
    let published = plan.project_root.join(SCHEMA2_CONFIG_ROOT);
    match (
        fs::symlink_metadata(&staged),
        fs::symlink_metadata(&published),
    ) {
        (Ok(_), Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            ensure_real_relative_directory(
                &plan.project_root,
                &staging_relative,
                "recoverable staged schema-2 configuration",
            )?;
            Ok(staged)
        }
        (Err(error), Ok(_)) if error.kind() == std::io::ErrorKind::NotFound => {
            ensure_real_relative_directory(
                &plan.project_root,
                Path::new(SCHEMA2_CONFIG_ROOT),
                "recoverable published schema-2 configuration",
            )?;
            Ok(published)
        }
        (Ok(_), Ok(_)) => Err(migration_error(
            "both staged and published schema-2 configuration exist during recovery",
        )),
        (Err(left), Err(right))
            if left.kind() == std::io::ErrorKind::NotFound
                && right.kind() == std::io::ErrorKind::NotFound =>
        {
            Err(migration_error(
                "staged and published schema-2 configuration are both missing during recovery",
            ))
        }
        (Err(error), _) => Err(io_error(&staged, error)),
        (_, Err(error)) => Err(io_error(&published, error)),
    }
}

fn hashed_tree_digest(root: &Path) -> Result<String> {
    let files = collect_hashed_files(root, root)?;
    Ok(snapshot_hash(&files, &[]))
}

fn verify_backup_config(plan: &Schema2MigrationPlan, backup_config: &Path) -> Result<()> {
    ensure_real_directory(backup_config, "journaled schema-1 backup")?;
    let actual = collect_hashed_files(backup_config, backup_config)?
        .into_iter()
        .map(|file| HashedMigrationFile {
            path: format!("{LEGACY_CONFIG_ROOT}/{}", file.path),
            sha256: file.sha256,
        })
        .collect::<Vec<_>>();
    if actual != plan.legacy.config_files {
        return Err(migration_error(
            "schema-1 configuration changed across the publication rename",
        ));
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io_error(path, error))
}

fn sync_tree(root: &Path) -> Result<()> {
    ensure_real_directory(root, "staged schema-2 tree")?;
    let mut directories = vec![root.to_path_buf()];
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| io_error(&directory, error))? {
            let entry = entry.map_err(|error| io_error(&directory, error))?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|error| io_error(&path, error))?;
            if file_type.is_symlink() {
                return Err(migration_error(format!(
                    "staged schema-2 tree contains a symbolic link: {}",
                    path.display()
                )));
            }
            if file_type.is_dir() {
                directories.push(path.clone());
                pending.push(path);
            } else if file_type.is_file() {
                fs::File::open(&path)
                    .and_then(|file| file.sync_all())
                    .map_err(|error| io_error(&path, error))?;
            } else {
                return Err(migration_error(format!(
                    "staged schema-2 tree contains a non-regular entry: {}",
                    path.display()
                )));
            }
        }
    }
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        sync_directory(&directory)?;
    }
    Ok(())
}

fn migrate_yaml_file(source: &Path, destination: &Path) -> Result<()> {
    let mut value: serde_yaml::Value =
        serde_yaml::from_slice(&read_file(source)?).map_err(|source_error| KoniError::Yaml {
            path: source.to_path_buf(),
            source: source_error,
        })?;
    migrate_yaml_value(&mut value, source, true)?;
    let encoded = serde_yaml::to_string(&value).map_err(|error| {
        migration_error(format!(
            "could not serialize migrated YAML {}: {error}",
            destination.display()
        ))
    })?;
    fs::write(destination, encoded).map_err(|error| io_error(destination, error))
}

fn migrate_yaml_value(value: &mut serde_yaml::Value, source: &Path, root: bool) -> Result<()> {
    let serde_yaml::Value::Mapping(mapping) = value else {
        return Ok(());
    };
    if !root {
        return Ok(());
    }

    // Schema migration is intentionally path-scoped. Prompts, metadata and
    // embedded JSON Schema documents are user data, even when they contain a
    // key such as `sandbox` or a string mentioning `.codex/koni`.
    migrate_yaml_schema_version(mapping, source)?;
    if let Some(profile) = yaml_mapping_mut(mapping, "profile")
        && let Some(profile_source) = yaml_string_mut(profile, "source")
    {
        rewrite_config_path(profile_source);
    }
    if let Some(personas) = mapping
        .get_mut(serde_yaml::Value::String("personas".to_owned()))
        .and_then(serde_yaml::Value::as_sequence_mut)
    {
        for persona in personas {
            let persona = persona.as_mapping_mut().ok_or_else(|| {
                migration_error(format!(
                    "personas must contain mappings in {}",
                    source.display()
                ))
            })?;
            migrate_yaml_persona(persona, source)?;
        }
    }
    if let Some(agents) = yaml_mapping_mut(mapping, "agents")
        && let Some(roles) = yaml_mapping_mut(agents, "roles")
    {
        for role in roles.values_mut() {
            if let Some(role) = role.as_mapping_mut() {
                migrate_yaml_thinking_level(role, source)?;
            }
        }
    }
    Ok(())
}

fn yaml_mapping_mut<'a>(
    mapping: &'a mut serde_yaml::Mapping,
    key: &str,
) -> Option<&'a mut serde_yaml::Mapping> {
    mapping
        .get_mut(serde_yaml::Value::String(key.to_owned()))
        .and_then(serde_yaml::Value::as_mapping_mut)
}

fn yaml_string_mut<'a>(mapping: &'a mut serde_yaml::Mapping, key: &str) -> Option<&'a mut String> {
    match mapping.get_mut(serde_yaml::Value::String(key.to_owned())) {
        Some(serde_yaml::Value::String(text)) => Some(text),
        _ => None,
    }
}

fn migrate_yaml_persona(mapping: &mut serde_yaml::Mapping, source: &Path) -> Result<()> {
    rename_yaml_key(mapping, "codex_agent", "agent", source)?;
    migrate_yaml_thinking_level(mapping, source)?;
    if let Some(sandbox) = mapping.remove(serde_yaml::Value::String("sandbox".to_owned())) {
        let capabilities_key = serde_yaml::Value::String("capabilities".to_owned());
        if mapping.contains_key(&capabilities_key) {
            return Err(migration_error(format!(
                "{} defines both sandbox and capabilities",
                source.display()
            )));
        }
        let legacy: LegacySandbox = serde_yaml::from_value(sandbox).map_err(|error| {
            migration_error(format!(
                "invalid legacy sandbox in {}: {error}",
                source.display()
            ))
        })?;
        let capabilities = CapabilityPolicyV2::from_legacy(
            legacy.mode.as_deref(),
            legacy.approval_policy.as_deref(),
            legacy.network_access,
            legacy.writable_roots,
            source,
        )?;
        let encoded = serde_yaml::to_value(capabilities).map_err(|error| {
            migration_error(format!(
                "could not serialize capabilities for {}: {error}",
                source.display()
            ))
        })?;
        mapping.insert(capabilities_key, encoded);
    }
    Ok(())
}

fn migrate_yaml_thinking_level(mapping: &mut serde_yaml::Mapping, source: &Path) -> Result<()> {
    let legacy_key = serde_yaml::Value::String("reasoning_effort".to_owned());
    let current_key = serde_yaml::Value::String("thinking_level".to_owned());
    let Some(value) = mapping.remove(&legacy_key) else {
        return Ok(());
    };
    if mapping.contains_key(&current_key) {
        return Err(migration_error(format!(
            "{} defines both reasoning_effort and thinking_level",
            source.display()
        )));
    }
    let value = value.as_str().ok_or_else(|| {
        migration_error(format!(
            "reasoning_effort must be a string in {}",
            source.display()
        ))
    })?;
    mapping.insert(
        current_key,
        serde_yaml::Value::String(migrate_thinking_level(value, source)?.to_owned()),
    );
    Ok(())
}

fn rename_yaml_key(
    mapping: &mut serde_yaml::Mapping,
    legacy: &str,
    current: &str,
    source: &Path,
) -> Result<()> {
    let legacy_key = serde_yaml::Value::String(legacy.to_owned());
    let current_key = serde_yaml::Value::String(current.to_owned());
    let Some(value) = mapping.remove(&legacy_key) else {
        return Ok(());
    };
    if mapping.contains_key(&current_key) {
        return Err(migration_error(format!(
            "{} defines both {legacy} and {current}",
            source.display()
        )));
    }
    mapping.insert(current_key, value);
    Ok(())
}

fn migrate_yaml_schema_version(mapping: &mut serde_yaml::Mapping, source: &Path) -> Result<()> {
    let key = serde_yaml::Value::String("schema_version".to_owned());
    let Some(version) = mapping.get_mut(&key) else {
        return Ok(());
    };
    match version.as_str() {
        Some("1.0") => *version = serde_yaml::Value::String(KONI_SCHEMA2_VERSION.to_owned()),
        Some(KONI_SCHEMA2_VERSION) => {}
        Some(other) => {
            return Err(migration_error(format!(
                "{} has unsupported schema version {other:?}",
                source.display()
            )));
        }
        None => {
            return Err(migration_error(format!(
                "{} has a non-string schema_version",
                source.display()
            )));
        }
    }
    Ok(())
}

fn migrate_toml_file(source: &Path, destination: &Path) -> Result<()> {
    let text = fs::read_to_string(source).map_err(|error| io_error(source, error))?;
    let mut value: toml::Value = toml::from_str(&text).map_err(|source_error| KoniError::Toml {
        path: source.to_path_buf(),
        source: source_error,
    })?;
    migrate_toml_value(&mut value, source, true)?;
    let encoded = toml::to_string_pretty(&value).map_err(|error| {
        migration_error(format!(
            "could not serialize migrated TOML {}: {error}",
            destination.display()
        ))
    })?;
    fs::write(destination, encoded).map_err(|error| io_error(destination, error))
}

fn migrate_toml_value(value: &mut toml::Value, source: &Path, root: bool) -> Result<()> {
    let toml::Value::Table(table) = value else {
        return Ok(());
    };
    if !root {
        return Ok(());
    }
    if let Some(version) = table.get_mut("schema_version") {
        match version.as_str() {
            Some("1.0") => *version = toml::Value::String(KONI_SCHEMA2_VERSION.to_owned()),
            Some(KONI_SCHEMA2_VERSION) => {}
            Some(other) => {
                return Err(migration_error(format!(
                    "{} has unsupported schema version {other:?}",
                    source.display()
                )));
            }
            None => {
                return Err(migration_error(format!(
                    "{} has a non-string schema_version",
                    source.display()
                )));
            }
        }
    }
    if let Some(profile_source) = table
        .get_mut("profile")
        .and_then(toml::Value::as_table_mut)
        .and_then(|profile| profile.get_mut("source"))
        .and_then(|value| match value {
            toml::Value::String(text) => Some(text),
            _ => None,
        })
    {
        rewrite_config_path(profile_source);
    }
    if let Some(personas) = table
        .get_mut("personas")
        .and_then(toml::Value::as_array_mut)
    {
        for persona in personas {
            let persona = persona.as_table_mut().ok_or_else(|| {
                migration_error(format!(
                    "personas must contain tables in {}",
                    source.display()
                ))
            })?;
            migrate_toml_persona(persona, source)?;
        }
    }
    if let Some(roles) = table
        .get_mut("agents")
        .and_then(toml::Value::as_table_mut)
        .and_then(|agents| agents.get_mut("roles"))
        .and_then(toml::Value::as_table_mut)
    {
        for (_, role) in roles.iter_mut() {
            if let Some(role) = role.as_table_mut() {
                migrate_toml_thinking_level(role, source)?;
            }
        }
    }
    Ok(())
}

fn migrate_toml_persona(table: &mut toml::Table, source: &Path) -> Result<()> {
    rename_toml_key(table, "codex_agent", "agent", source)?;
    migrate_toml_thinking_level(table, source)?;
    if let Some(sandbox) = table.remove("sandbox") {
        if table.contains_key("capabilities") {
            return Err(migration_error(format!(
                "{} defines both sandbox and capabilities",
                source.display()
            )));
        }
        let legacy: LegacySandbox = sandbox.try_into().map_err(|error| {
            migration_error(format!(
                "invalid legacy sandbox in {}: {error}",
                source.display()
            ))
        })?;
        let capabilities = CapabilityPolicyV2::from_legacy(
            legacy.mode.as_deref(),
            legacy.approval_policy.as_deref(),
            legacy.network_access,
            legacy.writable_roots,
            source,
        )?;
        let encoded = toml::Value::try_from(capabilities).map_err(|error| {
            migration_error(format!(
                "could not serialize capabilities for {}: {error}",
                source.display()
            ))
        })?;
        table.insert("capabilities".to_owned(), encoded);
    }
    Ok(())
}

fn migrate_toml_thinking_level(table: &mut toml::Table, source: &Path) -> Result<()> {
    let Some(value) = table.remove("reasoning_effort") else {
        return Ok(());
    };
    if table.contains_key("thinking_level") {
        return Err(migration_error(format!(
            "{} defines both reasoning_effort and thinking_level",
            source.display()
        )));
    }
    let value = value.as_str().ok_or_else(|| {
        migration_error(format!(
            "reasoning_effort must be a string in {}",
            source.display()
        ))
    })?;
    table.insert(
        "thinking_level".to_owned(),
        toml::Value::String(migrate_thinking_level(value, source)?.to_owned()),
    );
    Ok(())
}

fn migrate_thinking_level<'a>(value: &'a str, source: &Path) -> Result<&'a str> {
    let migrated = if value == "ultra" { "max" } else { value };
    if !matches!(
        migrated,
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    ) {
        return Err(migration_error(format!(
            "{} uses unsupported thinking level {value:?}",
            source.display()
        )));
    }
    Ok(migrated)
}

fn rename_toml_key(
    table: &mut toml::Table,
    legacy: &str,
    current: &str,
    source: &Path,
) -> Result<()> {
    let Some(value) = table.remove(legacy) else {
        return Ok(());
    };
    if table.contains_key(current) {
        return Err(migration_error(format!(
            "{} defines both {legacy} and {current}",
            source.display()
        )));
    }
    table.insert(current.to_owned(), value);
    Ok(())
}

fn rewrite_config_path(text: &mut String) {
    if text == LEGACY_CONFIG_ROOT {
        *text = SCHEMA2_CONFIG_ROOT.to_owned();
    } else if let Some(suffix) = text.strip_prefix(".codex/koni/") {
        *text = format!(".koni/{suffix}");
    }
}

fn reject_legacy_keys_yaml(value: &serde_yaml::Value, path: &Path) -> Result<()> {
    let Some(root) = value.as_mapping() else {
        return Ok(());
    };
    if let Some(personas) = root
        .get(serde_yaml::Value::String("personas".to_owned()))
        .and_then(serde_yaml::Value::as_sequence)
    {
        for persona in personas {
            if let Some(persona) = persona.as_mapping() {
                reject_legacy_mapping_keys(
                    persona,
                    path,
                    &["codex_agent", "reasoning_effort", "sandbox"],
                )?;
            }
        }
    }
    if let Some(roles) = root
        .get(serde_yaml::Value::String("agents".to_owned()))
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|agents| agents.get(serde_yaml::Value::String("roles".to_owned())))
        .and_then(serde_yaml::Value::as_mapping)
    {
        for role in roles.values().filter_map(serde_yaml::Value::as_mapping) {
            reject_legacy_mapping_keys(role, path, &["reasoning_effort"])?;
        }
    }
    Ok(())
}

fn reject_legacy_mapping_keys(
    mapping: &serde_yaml::Mapping,
    path: &Path,
    keys: &[&str],
) -> Result<()> {
    for key in keys {
        if mapping.contains_key(serde_yaml::Value::String((*key).to_owned())) {
            return Err(migration_error(format!(
                "staged schema-2 YAML retains legacy key {key:?} in {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn parse_legacy_agent(path: &Path) -> Result<LegacyCodexAgent> {
    ensure_real_file(path, "owned Codex agent")?;
    let text = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    let agent: LegacyCodexAgent = toml::from_str(&text).map_err(|source| KoniError::Toml {
        path: path.to_path_buf(),
        source,
    })?;
    validate_nonempty(&agent.name, "agent name", path)?;
    validate_nonempty(&agent.description, "agent description", path)?;
    validate_nonempty(
        &agent.developer_instructions,
        "agent developer instructions",
        path,
    )?;
    validate_optional_nonempty(agent.model.as_deref(), "model", path)?;
    validate_optional_nonempty(
        agent.model_reasoning_effort.as_deref(),
        "model_reasoning_effort",
        path,
    )?;
    Ok(agent)
}

fn convert_legacy_agent(agent: LegacyCodexAgent, source: &Path) -> Result<KoniAgentResourceV2> {
    let capabilities = CapabilityPolicyV2::from_legacy(
        agent.sandbox_mode.as_deref(),
        Some("never"),
        false,
        Vec::new(),
        source,
    )?;
    let thinking_level = agent
        .model_reasoning_effort
        .as_deref()
        .map(|value| migrate_thinking_level(value, source).map(str::to_owned))
        .transpose()?;
    Ok(KoniAgentResourceV2 {
        schema_version: KONI_SCHEMA2_VERSION.to_owned(),
        id: agent.name,
        description: agent.description,
        instructions: AgentInstructionSourceV2::Inline {
            text: agent.developer_instructions,
        },
        aliases: agent.nickname_candidates,
        provider: "openai-codex".to_owned(),
        model: agent.model,
        thinking_level,
        capabilities,
        skills: Vec::new(),
    })
}

fn collect_legacy_agent_references(source_root: &Path) -> Result<Vec<String>> {
    let mut references = BTreeSet::new();
    collect_agent_references_in_directory(source_root, &mut references)?;
    Ok(references.into_iter().collect())
}

fn collect_agent_references_in_directory(
    directory: &Path,
    references: &mut BTreeSet<String>,
) -> Result<()> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| io_error(directory, error))?
        .map(|entry| entry.map_err(|error| io_error(directory, error)))
        .collect::<Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| io_error(&path, error))?;
        if file_type.is_symlink() {
            return Err(migration_error(format!(
                "schema-1 configuration cannot contain symlinks: {}",
                path.display()
            )));
        }
        if file_type.is_dir() {
            collect_agent_references_in_directory(&path, references)?;
        } else if file_type.is_file()
            && matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("yaml" | "yml")
            )
        {
            let value: serde_yaml::Value =
                serde_yaml::from_slice(&read_file(&path)?).map_err(|source| KoniError::Yaml {
                    path: path.clone(),
                    source,
                })?;
            collect_agent_references_yaml(&value, references, &path)?;
        }
    }
    Ok(())
}

fn collect_agent_references_yaml(
    value: &serde_yaml::Value,
    references: &mut BTreeSet<String>,
    path: &Path,
) -> Result<()> {
    let Some(personas) = value
        .as_mapping()
        .and_then(|mapping| mapping.get(serde_yaml::Value::String("personas".to_owned())))
        .and_then(serde_yaml::Value::as_sequence)
    else {
        return Ok(());
    };
    for persona in personas {
        let Some(persona) = persona.as_mapping() else {
            continue;
        };
        let Some(agent) = persona.get(serde_yaml::Value::String("codex_agent".to_owned())) else {
            continue;
        };
        let agent = agent.as_str().ok_or_else(|| {
            migration_error(format!(
                "codex_agent must be a string in {}",
                path.display()
            ))
        })?;
        validate_agent_id(agent, path)?;
        references.insert(agent.to_owned());
    }
    Ok(())
}

fn validate_legacy_entrypoint(source_root: &Path) -> Result<()> {
    let candidates = ["project.yaml", "profile.yaml", "koni.yaml", "koni.toml"];
    let path = candidates
        .iter()
        .map(|name| source_root.join(name))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            migration_error(format!(
                "schema-1 configuration has no supported entrypoint under {}",
                source_root.display()
            ))
        })?;
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("yaml" | "yml") => {
            let value: serde_yaml::Value =
                serde_yaml::from_slice(&read_file(&path)?).map_err(|source| KoniError::Yaml {
                    path: path.clone(),
                    source,
                })?;
            let version = value
                .as_mapping()
                .and_then(|mapping| mapping.get(serde_yaml::Value::String("schema_version".into())))
                .and_then(serde_yaml::Value::as_str);
            if version != Some("1.0") {
                return Err(migration_error(format!(
                    "legacy entrypoint {} must declare schema_version 1.0",
                    path.display()
                )));
            }
        }
        Some("toml") => {
            let text = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
            let value: toml::Value = toml::from_str(&text).map_err(|source| KoniError::Toml {
                path: path.clone(),
                source,
            })?;
            if value.get("schema_version").and_then(toml::Value::as_str) != Some("1.0") {
                return Err(migration_error(format!(
                    "legacy entrypoint {} must declare schema_version 1.0",
                    path.display()
                )));
            }
        }
        _ => unreachable!("entrypoint names have known extensions"),
    }
    Ok(())
}

fn collect_hashed_files(project_root: &Path, directory: &Path) -> Result<Vec<HashedMigrationFile>> {
    let mut files = Vec::new();
    collect_hashed_files_inner(project_root, directory, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn collect_hashed_files_inner(
    project_root: &Path,
    directory: &Path,
    files: &mut Vec<HashedMigrationFile>,
) -> Result<()> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| io_error(directory, error))?
        .map(|entry| entry.map_err(|error| io_error(directory, error)))
        .collect::<Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| io_error(&path, error))?;
        if file_type.is_symlink() {
            return Err(migration_error(format!(
                "migration input cannot contain symbolic links: {}",
                path.display()
            )));
        }
        if file_type.is_dir() {
            collect_hashed_files_inner(project_root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path.strip_prefix(project_root).map_err(|_| {
                migration_error(format!(
                    "migration input escaped project: {}",
                    path.display()
                ))
            })?;
            files.push(HashedMigrationFile {
                path: portable_relative_path(relative)?,
                sha256: sha256_file(&path)?,
            });
        } else {
            return Err(migration_error(format!(
                "migration input is not a regular file or directory: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn snapshot_hash(config: &[HashedMigrationFile], owned: &[HashedMigrationFile]) -> String {
    let mut hasher = Sha256::new();
    for (kind, files) in [("config", config), ("owned", owned)] {
        hasher.update(kind.as_bytes());
        hasher.update([0]);
        for file in files {
            hasher.update(file.path.as_bytes());
            hasher.update([0]);
            hasher.update(file.sha256.as_bytes());
            hasher.update([0]);
        }
    }
    hex::encode(hasher.finalize())
}

fn validate_owned_resource_path(path: &str) -> Result<()> {
    let relative = Path::new(path);
    if portable_relative_path(relative)? != path {
        return Err(migration_error(format!(
            "owned resource path is not canonical: {path}"
        )));
    }
    if relative.starts_with(".codex/agents") {
        if relative.parent() != Some(Path::new(".codex/agents"))
            || relative
                .extension()
                .and_then(|extension| extension.to_str())
                != Some("toml")
        {
            return Err(migration_error(format!(
                "owned Codex agent must be a direct TOML child of .codex/agents: {path}"
            )));
        }
    } else if !relative.starts_with(".agents/skills/") {
        return Err(migration_error(format!(
            "legacy ownership manifest may contain only .codex/agents/*.toml or .agents/skills/** resources: {path}"
        )));
    }
    Ok(())
}

fn validate_writable_roots(roots: &[String], source: &Path) -> Result<()> {
    for root in roots {
        if root.trim().is_empty() {
            return Err(migration_error(format!(
                "{} contains an empty writable root",
                source.display()
            )));
        }
        let path = Path::new(root);
        if path.is_absolute()
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
        {
            return Err(migration_error(format!(
                "{} contains unsafe writable root {root:?}",
                source.display()
            )));
        }
    }
    Ok(())
}

fn validate_agent_id(id: &str, source: &Path) -> Result<()> {
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        })
    {
        return Err(migration_error(format!(
            "invalid agent id {id:?} in {}",
            source.display()
        )));
    }
    Ok(())
}

fn validate_migration_id(id: &str) -> Result<()> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(migration_error(format!("invalid migration id {id:?}")));
    }
    Ok(())
}

fn validate_nonempty(value: &str, field: &str, path: &Path) -> Result<()> {
    if value.trim().is_empty() {
        return Err(migration_error(format!(
            "{field} must not be empty in {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_optional_nonempty(value: Option<&str>, field: &str, path: &Path) -> Result<()> {
    if value.is_some_and(|value| value.trim().is_empty()) {
        return Err(migration_error(format!(
            "{field} must not be empty in {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(migration_error(format!(
            "invalid SHA-256 for owned resource {label}"
        )));
    }
    Ok(())
}

fn portable_relative_path(path: &Path) -> Result<String> {
    let parts = path
        .components()
        .map(|component| match component {
            Component::Normal(part) => part.to_str().map(str::to_owned),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            migration_error(format!(
                "path is not a portable relative path: {}",
                path.display()
            ))
        })?;
    if parts.is_empty() {
        return Err(migration_error("relative path must not be empty"));
    }
    Ok(parts.join("/"))
}

fn canonical_real_directory(path: &Path, label: &str) -> Result<PathBuf> {
    ensure_real_directory(path, label)?;
    path.canonicalize().map_err(|error| io_error(path, error))
}

fn ensure_real_directory(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(migration_error(format!(
            "{label} must be a real directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn ensure_real_file(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(migration_error(format!(
            "{label} must be a real file: {}",
            path.display()
        )));
    }
    Ok(())
}

fn ensure_real_relative_directory(root: &Path, relative: &Path, label: &str) -> Result<()> {
    ensure_real_relative_path(root, relative, label, true)
}

fn ensure_real_relative_file(root: &Path, relative: &Path, label: &str) -> Result<()> {
    ensure_real_relative_path(root, relative, label, false)
}

/// Resolve a project-relative input one component at a time without following
/// symlinks. Checking only the leaf lets `.codex -> /tmp/attacker` pass as a
/// seemingly regular `.codex/koni` directory after traversal.
fn ensure_real_relative_path(
    root: &Path,
    relative: &Path,
    label: &str,
    final_is_directory: bool,
) -> Result<()> {
    portable_relative_path(relative)?;
    let components = relative.components().collect::<Vec<_>>();
    let mut current = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(part) = component else {
            return Err(migration_error(format!(
                "{label} is not project-relative: {}",
                relative.display()
            )));
        };
        current.push(part);
        let metadata = fs::symlink_metadata(&current).map_err(|error| io_error(&current, error))?;
        if metadata.file_type().is_symlink() {
            return Err(migration_error(format!(
                "{label} has a symbolic-link ancestor: {}",
                current.display()
            )));
        }
        let is_final = index + 1 == components.len();
        if (!is_final || final_is_directory) && !metadata.is_dir() {
            return Err(migration_error(format!(
                "{label} must traverse real directories: {}",
                current.display()
            )));
        }
        if is_final && !final_is_directory && !metadata.is_file() {
            return Err(migration_error(format!(
                "{label} must be a real file: {}",
                current.display()
            )));
        }
    }
    Ok(())
}

fn ensure_absent_beneath(root: &Path, relative: &Path, label: &str) -> Result<()> {
    portable_relative_path(relative)?;
    let components = relative.components().collect::<Vec<_>>();
    let mut current = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(part) = component else {
            return Err(migration_error(format!(
                "{label} is not project-relative: {}",
                relative.display()
            )));
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(migration_error(format!(
                        "{label} has a symbolic-link ancestor: {}",
                        current.display()
                    )));
                }
                if index + 1 == components.len() {
                    return Err(migration_error(format!(
                        "{label} already exists: {}",
                        current.display()
                    )));
                }
                if !metadata.is_dir() {
                    return Err(migration_error(format!(
                        "{label} has a non-directory ancestor: {}",
                        current.display()
                    )));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(&current, error)),
        }
    }
    Ok(())
}

fn create_backup_root(project_root: &Path, backup_root: &Path) -> Result<()> {
    let parent = backup_root
        .parent()
        .ok_or_else(|| migration_error("migration backup has no parent"))?;
    let created_parent = match fs::symlink_metadata(parent) {
        Ok(_) => {
            ensure_real_directory(parent, "migration backup parent")?;
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(parent).map_err(|error| io_error(parent, error))?;
            sync_directory(parent)?;
            sync_directory(project_root)?;
            true
        }
        Err(error) => return Err(io_error(parent, error)),
    };
    if !parent.starts_with(project_root) {
        return Err(migration_error("migration backup escaped the project root"));
    }
    fs::create_dir(backup_root).map_err(|error| io_error(backup_root, error))?;
    sync_directory(backup_root)?;
    sync_directory(parent)?;
    if created_parent {
        sync_directory(project_root)?;
    }
    Ok(())
}

fn create_real_parents(root: &Path, path: &Path) -> Result<()> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| migration_error(format!("output escaped staging root: {}", path.display())))?;
    let mut current = root.to_path_buf();
    for component in relative.parent().into_iter().flat_map(Path::components) {
        let Component::Normal(part) = component else {
            return Err(migration_error(format!(
                "output path is not contained: {}",
                path.display()
            )));
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(_) => ensure_real_directory(&current, "migration output parent")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| io_error(&current, error))?;
                sync_directory(&current)?;
                if let Some(parent) = current.parent() {
                    sync_directory(parent)?;
                }
            }
            Err(error) => return Err(io_error(&current, error)),
        }
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|error| io_error(path, error))
}

fn sha256_file(path: &Path) -> Result<String> {
    Ok(hex::encode(Sha256::digest(read_file(path)?)))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        migration_error(format!("could not serialize {}: {error}", path.display()))
    })?;
    bytes.push(b'\n');
    fs::write(path, bytes).map_err(|error| io_error(path, error))
}

fn remove_owned_tree(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)
        }
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn migration_error(message: impl Into<String>) -> KoniError {
    KoniError::Profile(format!("schema-2 migration: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    struct Fixture {
        temp: TempDir,
        agent_hash: String,
        skill_hash: String,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path();
            git2::Repository::init(root).unwrap();
            fs::create_dir_all(root.join(".codex/koni")).unwrap();
            fs::create_dir_all(root.join(".codex/agents")).unwrap();
            fs::create_dir_all(root.join(".agents/skills/operate-koni")).unwrap();
            fs::write(
                root.join(".codex/koni/project.yaml"),
                r#"schema_version: "1.0"
project: {id: sample, title: Sample}
default_run_type: small
run_types: [{id: small, path: run-types/small.yaml}]
"#,
            )
            .unwrap();
            fs::create_dir_all(root.join(".codex/koni/run-types")).unwrap();
            fs::write(
                root.join(".codex/koni/run-types/small.yaml"),
                r#"schema_version: "1.0"
id: small
title: Small
profile: {source: .codex/koni/profile.yaml}
agents:
  roles:
    planner: {reasoning_effort: ultra}
"#,
            )
            .unwrap();
            fs::write(
                root.join(".codex/koni/profile.yaml"),
                r#"schema_version: "1.0"
engine: ">=0.1,<0.2"
profile: {id: sample, version: "1.0.0"}
imports: {personas: [personas.yaml]}
"#,
            )
            .unwrap();
            fs::write(
                root.join(".codex/koni/personas.yaml"),
                r#"schema_version: "1.0"
personas:
  - id: planner
    codex_agent: planner
    model_role: planner
    sandbox:
      mode: read-only
      approval_policy: never
      network_access: true
      writable_roots: []
"#,
            )
            .unwrap();
            let agent = r#"name = "planner"
description = "Plans work"
developer_instructions = "Inspect the repository and submit a plan."
nickname_candidates = ["Planner"]
model = "gpt-5.6-sol"
model_reasoning_effort = "ultra"
sandbox_mode = "read-only"
"#;
            fs::write(root.join(".codex/agents/planner.toml"), agent).unwrap();
            let skill = "---\nname: operate-koni\ndescription: Operate Koni\n---\nUse Koni.\n";
            fs::write(root.join(".agents/skills/operate-koni/SKILL.md"), skill).unwrap();
            let agent_hash = sha256_file(&root.join(".codex/agents/planner.toml")).unwrap();
            let skill_hash =
                sha256_file(&root.join(".agents/skills/operate-koni/SKILL.md")).unwrap();
            let manifest = json!({
                "schema_version": "1.0",
                "owner": "koni",
                "resources": [
                    {"path": ".codex/agents/planner.toml", "sha256": agent_hash},
                    {"path": ".agents/skills/operate-koni/SKILL.md", "sha256": skill_hash}
                ]
            });
            fs::write(
                root.join(".codex/koni/native-codex-resources.json"),
                serde_json::to_vec_pretty(&manifest).unwrap(),
            )
            .unwrap();
            fs::write(root.join(".codex/unrelated.txt"), "preserve me").unwrap();
            Self {
                temp,
                agent_hash,
                skill_hash,
            }
        }

        fn root(&self) -> &Path {
            self.temp.path()
        }

        fn plan(&self) -> Schema2MigrationPlan {
            Schema2Migrator::plan_with_id(self.root(), "test-migration").unwrap()
        }

        fn compiler_state_root(&self) -> PathBuf {
            GitBackend::discover(self.root())
                .unwrap()
                .common_dir()
                .to_path_buf()
        }

        fn proof(
            &self,
            plan: &Schema2MigrationPlan,
            disposition: LegacyRunDisposition,
        ) -> Schema2RunDispositionProof {
            let git = GitBackend::discover(self.root()).unwrap();
            Schema2RunDispositionProof::issue(
                plan,
                disposition,
                git.sidecar_root().join("project.yaml"),
                Vec::new(),
                Schema2PublicationAuthority::unguarded_for_test(git.common_dir().to_path_buf())
                    .unwrap(),
            )
            .unwrap()
        }
    }

    fn copy_test_tree(source: &Path, destination: &Path) {
        fs::create_dir(destination).unwrap();
        let mut entries = fs::read_dir(source)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        entries.sort();
        for path in entries {
            let output = destination.join(path.file_name().unwrap());
            if path.is_dir() {
                copy_test_tree(&path, &output);
            } else {
                fs::copy(&path, &output).unwrap();
            }
        }
    }

    #[test]
    fn planning_is_read_only_and_pins_only_owned_codex_resources() {
        let fixture = Fixture::new();
        let before = collect_hashed_files(fixture.root(), fixture.root()).unwrap();
        let plan = fixture.plan();
        let after = collect_hashed_files(fixture.root(), fixture.root()).unwrap();

        assert_eq!(before, after);
        assert_eq!(plan.source_root, ".codex/koni");
        assert_eq!(plan.destination_root, ".koni");
        assert_eq!(plan.agents.len(), 1);
        assert_eq!(plan.agents[0].id, "planner");
        assert_eq!(plan.agents[0].source.sha256, fixture.agent_hash);
        assert_eq!(plan.preserved_resources.len(), 1);
        assert_eq!(plan.preserved_resources[0].sha256, fixture.skill_hash);
        assert!(!fixture.root().join(".koni").exists());
        assert!(!fixture.root().join(".koni-migrations").exists());
    }

    #[test]
    fn apply_converts_schema_agents_and_capabilities_without_touching_unrelated_codex() {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        let result = Schema2Migrator::apply(
            &plan,
            fixture.proof(&plan, LegacyRunDisposition::NoLegacyRuns),
            |_| Ok(()),
        )
        .unwrap();

        assert_eq!(result.converted_agents, 1);
        assert!(!fixture.root().join(".codex/koni").exists());
        assert!(fixture.root().join(".koni/project.yaml").is_file());
        assert_eq!(
            fs::read_to_string(fixture.root().join(".codex/unrelated.txt")).unwrap(),
            "preserve me"
        );
        assert!(
            fixture
                .root()
                .join(".agents/skills/operate-koni/SKILL.md")
                .is_file()
        );
        assert!(!fixture.root().join(".codex/agents/planner.toml").exists());
        assert!(
            fixture
                .root()
                .join(".koni-migrations/test-migration/native-v1/.codex/agents/planner.toml")
                .is_file()
        );

        let project: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(fixture.root().join(".koni/project.yaml")).unwrap())
                .unwrap();
        assert_eq!(project["schema_version"].as_str(), Some("2.0"));
        let run_type: serde_yaml::Value = serde_yaml::from_slice(
            &fs::read(fixture.root().join(".koni/run-types/small.yaml")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            run_type["profile"]["source"].as_str(),
            Some(".koni/profile.yaml")
        );
        assert_eq!(
            run_type["agents"]["roles"]["planner"]["thinking_level"].as_str(),
            Some("max")
        );
        assert!(
            run_type["agents"]["roles"]["planner"]
                .get("reasoning_effort")
                .is_none()
        );
        let personas: serde_yaml::Value =
            serde_yaml::from_slice(&fs::read(fixture.root().join(".koni/personas.yaml")).unwrap())
                .unwrap();
        let persona = &personas["personas"][0];
        assert_eq!(persona["agent"].as_str(), Some("planner"));
        assert_eq!(
            persona["capabilities"]["workspace_access"].as_str(),
            Some("read_only")
        );
        assert_eq!(
            persona["capabilities"]["commands"].as_str(),
            Some("read_only")
        );
        assert_eq!(
            persona["capabilities"]["network_access"].as_bool(),
            Some(true)
        );

        let agent: KoniAgentResourceV2 = serde_yaml::from_slice(
            &fs::read(fixture.root().join(".koni/agents/planner.yaml")).unwrap(),
        )
        .unwrap();
        assert_eq!(agent.provider, "openai-codex");
        assert_eq!(agent.thinking_level.as_deref(), Some("max"));
        assert_eq!(
            agent.capabilities.workspace_access,
            WorkspaceAccessV2::ReadOnly
        );
    }

    #[test]
    fn modified_owned_resource_and_destination_collision_fail_before_mutation() {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        fs::write(
            fixture.root().join(".codex/agents/planner.toml"),
            "user edit",
        )
        .unwrap();
        let error = Schema2Migrator::apply(
            &plan,
            fixture.proof(&plan, LegacyRunDisposition::Archived),
            |_| Ok(()),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("changed after installation") || error.contains("changed after"));
        assert!(fixture.root().join(".codex/koni").is_dir());
        assert!(!fixture.root().join(".koni").exists());

        let fixture = Fixture::new();
        fs::create_dir(fixture.root().join(".koni")).unwrap();
        let error = Schema2Migrator::plan_with_id(fixture.root(), "collision")
            .unwrap_err()
            .to_string();
        assert!(error.contains("schema-2 destination already exists"));
        assert!(fixture.root().join(".codex/koni").is_dir());
    }

    #[test]
    fn unowned_or_unsupported_agent_is_rejected() {
        let fixture = Fixture::new();
        let manifest_path = fixture
            .root()
            .join(".codex/koni/native-codex-resources.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["resources"] = json!([
            {"path": ".agents/skills/operate-koni/SKILL.md", "sha256": fixture.skill_hash}
        ]);
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let error = Schema2Migrator::plan_with_id(fixture.root(), "unowned")
            .unwrap_err()
            .to_string();
        assert!(error.contains("no hash-pinned Koni-owned"));

        let fixture = Fixture::new();
        let agent_path = fixture.root().join(".codex/agents/planner.toml");
        fs::write(
            &agent_path,
            format!(
                "{}\nunsupported_provider_option = true\n",
                fs::read_to_string(&agent_path).unwrap()
            ),
        )
        .unwrap();
        let new_hash = sha256_file(&agent_path).unwrap();
        let manifest_path = fixture
            .root()
            .join(".codex/koni/native-codex-resources.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["resources"][0]["sha256"] = json!(new_hash);
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let error = Schema2Migrator::plan_with_id(fixture.root(), "unsupported")
            .unwrap_err()
            .to_string();
        assert!(error.contains("unknown field") || error.contains("invalid TOML"));
    }

    #[test]
    fn generated_agent_collision_and_tampered_plan_are_rejected() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.root().join(".codex/koni/agents")).unwrap();
        fs::write(
            fixture.root().join(".codex/koni/agents/planner.yaml"),
            "schema_version: \"1.0\"\n",
        )
        .unwrap();
        let error = Schema2Migrator::plan_with_id(fixture.root(), "agent-collision")
            .unwrap_err()
            .to_string();
        assert!(error.contains("would overwrite migrated profile resource"));

        let fixture = Fixture::new();
        let mut plan = fixture.plan();
        plan.agents.clear();
        let error = Schema2Migrator::apply(
            &plan,
            fixture.proof(&plan, LegacyRunDisposition::NoLegacyRuns),
            |_| Ok(()),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("do not match the hash-pinned legacy snapshot"));
        assert!(fixture.root().join(".codex/koni").is_dir());
        assert!(fixture.root().join(".codex/agents/planner.toml").is_file());
        assert!(!fixture.root().join(".koni").exists());
    }

    #[test]
    fn only_referenced_agents_are_converted_but_all_owned_agents_are_retired() {
        let fixture = Fixture::new();
        let unused = r#"name = "unused"
description = "Unused legacy agent"
developer_instructions = "This agent is no longer referenced."
sandbox_mode = "read-only"
"#;
        let unused_path = fixture.root().join(".codex/agents/unused.toml");
        fs::write(&unused_path, unused).unwrap();
        let unused_hash = sha256_file(&unused_path).unwrap();
        let manifest_path = fixture
            .root()
            .join(".codex/koni/native-codex-resources.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["resources"]
            .as_array_mut()
            .unwrap()
            .push(json!({"path": ".codex/agents/unused.toml", "sha256": unused_hash}));
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let plan = Schema2Migrator::plan_with_id(fixture.root(), "unused-agent").unwrap();
        assert_eq!(plan.agents.len(), 1);
        assert_eq!(plan.retired_legacy_agents.len(), 2);
        let result = Schema2Migrator::apply(
            &plan,
            fixture.proof(&plan, LegacyRunDisposition::NoLegacyRuns),
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(result.converted_agents, 1);
        assert_eq!(result.retired_legacy_agents, 2);
        assert!(!fixture.root().join(".koni/agents/unused.yaml").exists());
        assert!(
            fixture
                .root()
                .join(".koni-migrations/unused-agent/native-v1/.codex/agents/unused.toml")
                .is_file()
        );
    }

    #[test]
    fn failed_compiled_profile_validation_cleans_staging_without_moving_legacy_state() {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        let error = Schema2Migrator::apply(
            &plan,
            fixture.proof(&plan, LegacyRunDisposition::Archived),
            |_| Err(migration_error("synthetic compiler rejection")),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("catalog/profile compilation failed"));
        assert!(fixture.root().join(".codex/koni").is_dir());
        assert!(fixture.root().join(".codex/agents/planner.toml").is_file());
        assert!(!fixture.root().join(".koni").exists());
        assert!(
            !fixture
                .root()
                .join(".koni-migration-test-migration")
                .exists()
        );
        assert!(!fixture.root().join(".koni-migrations").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_input_is_rejected_and_publish_failure_rolls_back() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        symlink(
            fixture.root().join(".codex/koni/profile.yaml"),
            fixture.root().join(".codex/koni/linked.yaml"),
        )
        .unwrap();
        let error = Schema2Migrator::plan_with_id(fixture.root(), "linked")
            .unwrap_err()
            .to_string();
        assert!(error.contains("symbolic links"));

        let fixture = Fixture::new();
        let plan = fixture.plan();
        let result = Schema2Migrator::apply_with_hook(
            &plan,
            fixture.proof(&plan, LegacyRunDisposition::Archived),
            |_| Ok(()),
            || {
                // This happens after staging/revalidation but before source moves.
                // The transaction's own destination recheck rejects it without
                // losing either legacy config or agents.
                fs::create_dir(fixture.root().join(".koni"))
                    .map_err(|error| io_error(fixture.root().join(".koni"), error))?;
                fs::write(fixture.root().join(".koni/collision"), "occupied")
                    .map_err(|error| io_error(fixture.root().join(".koni/collision"), error))?;
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(fixture.root().join(".codex/koni").is_dir());
        assert!(fixture.root().join(".codex/agents/planner.toml").is_file());
        assert_eq!(
            fs::read_to_string(fixture.root().join(".koni/collision")).unwrap(),
            "occupied"
        );
        assert!(
            !fixture
                .root()
                .join(".koni-migration-test-migration")
                .exists()
        );
        assert!(
            !fixture
                .root()
                .join(".koni-migrations/test-migration")
                .exists()
        );
    }

    #[cfg(unix)]
    #[test]
    fn every_project_relative_ancestor_and_output_boundary_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let real_codex = fixture.root().join("real-codex");
        fs::rename(fixture.root().join(".codex"), &real_codex).unwrap();
        symlink(&real_codex, fixture.root().join(".codex")).unwrap();
        let error = Schema2Migrator::plan_with_id(fixture.root(), "source-ancestor")
            .unwrap_err()
            .to_string();
        assert!(error.contains("symbolic-link ancestor"));

        let fixture = Fixture::new();
        let outside = fixture.root().join("outside-backups");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, fixture.root().join(".koni-migrations")).unwrap();
        let error = Schema2Migrator::plan_with_id(fixture.root(), "backup-ancestor")
            .unwrap_err()
            .to_string();
        assert!(error.contains("symbolic-link ancestor"));
        assert!(fs::read_dir(&outside).unwrap().next().is_none());

        let fixture = Fixture::new();
        let outside = fixture.root().join("outside-destination");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, fixture.root().join(".koni")).unwrap();
        let error = Schema2Migrator::plan_with_id(fixture.root(), "destination-link")
            .unwrap_err()
            .to_string();
        assert!(error.contains("symbolic-link ancestor"));

        let fixture = Fixture::new();
        let outside = fixture.root().join("outside-staging");
        fs::create_dir(&outside).unwrap();
        symlink(
            &outside,
            fixture.root().join(".koni-migration-staging-link"),
        )
        .unwrap();
        let error = Schema2Migrator::plan_with_id(fixture.root(), "staging-link")
            .unwrap_err()
            .to_string();
        assert!(error.contains("symbolic-link ancestor"));

        let fixture = Fixture::new();
        let real_agents = fixture.root().join("real-agents");
        fs::rename(fixture.root().join(".agents"), &real_agents).unwrap();
        symlink(&real_agents, fixture.root().join(".agents")).unwrap();
        let error = Schema2Migrator::plan_with_id(fixture.root(), "resource-ancestor")
            .unwrap_err()
            .to_string();
        assert!(error.contains("symbolic-link ancestor"));
    }

    #[test]
    fn yaml_and_toml_conversion_touch_only_schema_fields_and_map_ultra_to_max() {
        let source = Path::new("semantic-fixture.yaml");
        let mut yaml: serde_yaml::Value = serde_yaml::from_str(
            r#"schema_version: "1.0"
description: "keep .codex/koni and sandbox literally"
profile: {source: .codex/koni/profile.yaml}
metadata:
  codex_agent: literal-metadata
  reasoning_effort: ultra
  sandbox: {mode: unrestricted}
  path: .codex/koni/not-a-config-reference
json_schema:
  properties:
    sandbox: {type: string}
    codex_agent: {type: string}
personas:
  - id: planner
    codex_agent: planner
    reasoning_effort: ultra
    sandbox: {mode: read-only, approval_policy: never}
    metadata:
      reasoning_effort: ultra
      sandbox: literal
      path: .codex/koni/literal
agents:
  roles:
    planner: {reasoning_effort: ultra}
"#,
        )
        .unwrap();
        migrate_yaml_value(&mut yaml, source, true).unwrap();
        assert_eq!(yaml["schema_version"].as_str(), Some("2.0"));
        assert_eq!(
            yaml["profile"]["source"].as_str(),
            Some(".koni/profile.yaml")
        );
        assert_eq!(yaml["personas"][0]["agent"].as_str(), Some("planner"));
        assert_eq!(yaml["personas"][0]["thinking_level"].as_str(), Some("max"));
        assert_eq!(
            yaml["agents"]["roles"]["planner"]["thinking_level"].as_str(),
            Some("max")
        );
        assert_eq!(
            yaml["metadata"]["codex_agent"].as_str(),
            Some("literal-metadata")
        );
        assert_eq!(yaml["metadata"]["reasoning_effort"].as_str(), Some("ultra"));
        assert_eq!(
            yaml["metadata"]["path"].as_str(),
            Some(".codex/koni/not-a-config-reference")
        );
        assert_eq!(
            yaml["json_schema"]["properties"]["sandbox"]["type"].as_str(),
            Some("string")
        );
        assert_eq!(
            yaml["personas"][0]["metadata"]["reasoning_effort"].as_str(),
            Some("ultra")
        );
        assert_eq!(
            yaml["personas"][0]["metadata"]["path"].as_str(),
            Some(".codex/koni/literal")
        );
        let mut references = BTreeSet::new();
        collect_agent_references_yaml(&yaml, &mut references, source).unwrap();
        assert!(
            references.is_empty(),
            "schema-2 `agent` is not a legacy reference"
        );

        let source = Path::new("semantic-fixture.toml");
        let mut toml: toml::Value = toml::from_str(
            r#"schema_version = "1.0"
description = "keep .codex/koni literally"
personas = [{ id = "planner", codex_agent = "planner", reasoning_effort = "ultra", sandbox = { mode = "read-only", approval_policy = "never" }, metadata = { reasoning_effort = "ultra", sandbox = "literal", path = ".codex/koni/literal" } }]

[profile]
source = ".codex/koni/profile.yaml"

[metadata]
codex_agent = "literal-metadata"
reasoning_effort = "ultra"
sandbox = "literal"
path = ".codex/koni/not-a-config-reference"

[json_schema.properties.sandbox]
type = "string"

[agents.roles.planner]
reasoning_effort = "xhigh"
"#,
        )
        .unwrap();
        migrate_toml_value(&mut toml, source, true).unwrap();
        assert_eq!(toml["schema_version"].as_str(), Some("2.0"));
        assert_eq!(
            toml["profile"]["source"].as_str(),
            Some(".koni/profile.yaml")
        );
        assert_eq!(toml["personas"][0]["agent"].as_str(), Some("planner"));
        assert_eq!(toml["personas"][0]["thinking_level"].as_str(), Some("max"));
        assert_eq!(
            toml["agents"]["roles"]["planner"]["thinking_level"].as_str(),
            Some("xhigh")
        );
        assert_eq!(
            toml["metadata"]["codex_agent"].as_str(),
            Some("literal-metadata")
        );
        assert_eq!(toml["metadata"]["reasoning_effort"].as_str(), Some("ultra"));
        assert_eq!(
            toml["metadata"]["path"].as_str(),
            Some(".codex/koni/not-a-config-reference")
        );
        assert_eq!(
            toml["json_schema"]["properties"]["sandbox"]["type"].as_str(),
            Some("string")
        );

        let mut invalid_yaml: serde_yaml::Value =
            serde_yaml::from_str("personas: [{id: bad, reasoning_effort: extreme}]").unwrap();
        assert!(migrate_yaml_value(&mut invalid_yaml, source, true).is_err());
        let mut invalid_toml: toml::Value =
            toml::from_str("personas = [{ id = \"bad\", reasoning_effort = \"extreme\" }]")
                .unwrap();
        assert!(migrate_toml_value(&mut invalid_toml, source, true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn same_byte_source_replacement_after_validation_is_rejected_by_identity() {
        let fixture = Fixture::new();
        let plan = fixture.plan();
        let original = fixture.root().join(".codex/koni");
        let retired = fixture.root().join(".codex/koni-replaced");
        let result = Schema2Migrator::apply_with_hook(
            &plan,
            fixture.proof(&plan, LegacyRunDisposition::NoLegacyRuns),
            |_| Ok(()),
            || {
                fs::rename(&original, &retired).map_err(|error| io_error(&original, error))?;
                copy_test_tree(&retired, &original);
                Ok(())
            },
        );
        let error = result.unwrap_err().to_string();
        assert!(error.contains("replaced at the publication boundary"));
        assert!(original.is_dir());
        assert!(retired.is_dir());
        assert!(!fixture.root().join(".koni").exists());
        assert!(
            !fixture
                .root()
                .join(".koni-migrations/test-migration")
                .exists()
        );
    }

    #[test]
    fn every_fsynced_publication_boundary_recovers_and_retries_idempotently() {
        let boundaries = [
            PublicationBoundary::Prepared,
            PublicationBoundary::SourceMoved,
            PublicationBoundary::AgentMoved(1),
            PublicationBoundary::AgentsMoved,
            PublicationBoundary::DestinationPublished,
            PublicationBoundary::Complete,
        ];
        for boundary in boundaries {
            let fixture = Fixture::new();
            let plan = fixture.plan();
            let mut injected = false;
            let error = Schema2Migrator::apply_with_hooks(
                &plan,
                fixture.proof(&plan, LegacyRunDisposition::Archived),
                |_| Ok(()),
                || Ok(()),
                |observed| {
                    if !injected && observed == boundary {
                        injected = true;
                        return Err(migration_error(format!(
                            "injected crash after {observed:?}"
                        )));
                    }
                    Ok(())
                },
            )
            .unwrap_err()
            .to_string();
            assert!(injected, "boundary {boundary:?} was not reached");
            assert!(error.contains("injected crash"));
            assert!(publication_journal_path(&fixture.compiler_state_root()).is_file());
            assert_eq!(Schema2Migrator::plan(fixture.root()).unwrap(), plan);

            let compiler_calls = std::cell::Cell::new(0usize);
            let recovered = Schema2Migrator::apply(
                &plan,
                fixture.proof(&plan, LegacyRunDisposition::Archived),
                |_| {
                    compiler_calls.set(compiler_calls.get() + 1);
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(
                compiler_calls.get(),
                1,
                "recovery must re-run the compiler over journaled staging"
            );
            assert_eq!(recovered.migration_id, plan.migration_id);
            assert!(fixture.root().join(".koni").is_dir());
            assert!(!fixture.root().join(".codex/koni").exists());

            let retried = Schema2Migrator::apply(
                &plan,
                fixture.proof(&plan, LegacyRunDisposition::Archived),
                |_| {
                    compiler_calls.set(compiler_calls.get() + 1);
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(retried, recovered);
            assert_eq!(compiler_calls.get(), 2);
            assert_eq!(
                read_publication_journal(&plan, &fixture.compiler_state_root())
                    .unwrap()
                    .phase,
                PublicationPhase::Complete
            );
        }
    }

    #[test]
    fn forged_compiler_journal_cannot_add_a_git_sentinel_to_retirement() {
        let fixture = Fixture::new();
        let sentinel = fixture.root().join(".git/do-not-retire");
        fs::write(&sentinel, "compiler sentinel\n").unwrap();
        let plan = fixture.plan();
        let mut stopped = false;
        let error = Schema2Migrator::apply_with_hooks(
            &plan,
            fixture.proof(&plan, LegacyRunDisposition::NoLegacyRuns),
            |_| Ok(()),
            || Ok(()),
            |boundary| {
                if boundary == PublicationBoundary::Prepared {
                    stopped = true;
                    return Err(migration_error("stop with compiler journal prepared"));
                }
                Ok(())
            },
        )
        .unwrap_err()
        .to_string();
        assert!(stopped && error.contains("stop with compiler journal"));

        let compiler_state = fixture.compiler_state_root();
        let journal_path = publication_journal_path(&compiler_state);
        let mut forged = read_publication_journal(&plan, &compiler_state).unwrap();
        let forged_resource = HashedMigrationFile {
            path: ".git/do-not-retire".to_owned(),
            sha256: sha256_file(&sentinel).unwrap(),
        };
        forged
            .plan
            .retired_legacy_agents
            .push(forged_resource.clone());
        forged.input_identities.insert(
            forged_resource.path.clone(),
            filesystem_object_identity(&sentinel).unwrap(),
        );
        forged.journal_sha256 = journal_digest(&forged).unwrap();
        fs::write(&journal_path, serde_json::to_vec_pretty(&forged).unwrap()).unwrap();

        let error = Schema2Migrator::plan(fixture.root())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("non-derived destructive paths")
                || error.contains("does not match rederived"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(&sentinel).unwrap(),
            "compiler sentinel\n"
        );
        assert!(fixture.root().join(".codex/koni").is_dir());
        assert!(!fixture.root().join(".koni").exists());
    }

    #[test]
    fn handle_relative_publication_rejects_leaf_swap_and_contains_ancestor_swap() {
        let leaf_fixture = Fixture::new();
        let leaf_plan = leaf_fixture.plan();
        let original = leaf_fixture.root().join(".codex/koni");
        let displaced = leaf_fixture.root().join(".codex/koni-displaced");
        let mut swapped = false;
        let error = Schema2Migrator::apply_with_hooks(
            &leaf_plan,
            leaf_fixture.proof(&leaf_plan, LegacyRunDisposition::NoLegacyRuns),
            |_| Ok(()),
            || Ok(()),
            |boundary| {
                if !swapped && boundary == PublicationBoundary::SourceRenameBound {
                    fs::rename(&original, &displaced).unwrap();
                    copy_test_tree(&displaced, &original);
                    swapped = true;
                }
                Ok(())
            },
        )
        .unwrap_err()
        .to_string();
        assert!(swapped);
        assert!(error.contains("replaced after validation"), "{error}");
        assert!(!leaf_fixture.root().join(".koni").exists());
        assert!(
            !leaf_fixture
                .root()
                .join(&leaf_plan.backup_root)
                .join("config-v1")
                .exists()
        );

        let ancestor_fixture = Fixture::new();
        let ancestor_plan = ancestor_fixture.plan();
        let codex = ancestor_fixture.root().join(".codex");
        let displaced_codex = ancestor_fixture.root().join(".codex-displaced");
        let original_project =
            fs::read(ancestor_fixture.root().join(".codex/koni/project.yaml")).unwrap();
        let sentinel = ancestor_fixture.root().join(".git/do-not-retire");
        fs::write(&sentinel, "compiler sentinel\n").unwrap();
        let mut ancestor_swapped = false;
        let error = Schema2Migrator::apply_with_hooks(
            &ancestor_plan,
            ancestor_fixture.proof(&ancestor_plan, LegacyRunDisposition::NoLegacyRuns),
            |_| Ok(()),
            || Ok(()),
            |boundary| {
                if !ancestor_swapped && boundary == PublicationBoundary::SourceRenameBound {
                    fs::rename(&codex, &displaced_codex).unwrap();
                    fs::create_dir(&codex).unwrap();
                    copy_test_tree(&displaced_codex.join("koni"), &codex.join("koni"));
                    ancestor_swapped = true;
                }
                Ok(())
            },
        )
        .unwrap_err()
        .to_string();
        assert!(ancestor_swapped);
        assert!(
            error.contains("legacy agent") || error.contains("both live and backup"),
            "{error}"
        );
        assert_eq!(
            fs::read(
                ancestor_fixture
                    .root()
                    .join(&ancestor_plan.backup_root)
                    .join("config-v1/project.yaml")
            )
            .unwrap(),
            original_project,
            "the bound original parent, not the substituted ancestor, is renamed"
        );
        assert_eq!(
            fs::read_to_string(&sentinel).unwrap(),
            "compiler sentinel\n"
        );
        assert!(!ancestor_fixture.root().join(".koni").exists());
    }
}
