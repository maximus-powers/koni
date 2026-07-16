//! Bounded process supervision for compiler-owned Codex sessions.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::agent_runtime::{
    RuntimeEvent, RuntimeInput, RuntimeModelRef, RuntimeSessionStart, RuntimeThinkingLevel,
    RuntimeToolDefinition, RuntimeTurnRequest,
};
use crate::agent_tool_broker::{
    AgentToolBroker, AgentToolCall, AgentToolContext, AgentToolOutcome,
};
use crate::error::{KoniError, Result, io_error};
use crate::graph::normalized_hash;
use crate::pi_auth::CredentialLeaseId;
use crate::pi_runtime_process::{
    PI_RUNTIME_PROVIDER_ID, PiRuntimeArtifact, PiRuntimeBootstrapRequest, PiRuntimeProcess,
};

const MAX_READ_TOOL_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_READ_SEARCH_BYTES: u64 = 16 * 1024 * 1024;
const MAX_READ_WALK_ENTRIES: usize = 10_000;
pub(crate) const MAX_READ_ONLY_PROJECT_FILE_BYTES: u64 = 96 * 1024;

#[derive(Debug, Clone)]
pub struct AgentProcessRequest {
    pub executable: String,
    pub args: Vec<String>,
    pub working_directory: PathBuf,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub timeout: Duration,
    /// Exact environment values injected at this capability boundary.
    /// `environment_remove` is applied afterwards and therefore always wins
    /// when the same name appears in both collections.
    pub environment_set: Vec<(String, String)>,
    /// Environment capabilities that must not cross this agent boundary.
    pub environment_remove: Vec<String>,
    /// Typed provider-neutral request consumed only by the direct Pi launcher.
    /// Codex argv remains a legacy/test compatibility artifact and is never
    /// reparsed to infer Pi authority.
    pub direct_pi: Option<DirectPiAgentRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentReadPolicy {
    None,
    Project,
    ExactFiles(Vec<PathBuf>),
}

#[derive(Debug, Clone)]
pub struct DirectPiAgentRequest {
    pub logical_session_id: Option<String>,
    pub run_id: String,
    pub agent_id: String,
    pub attempt: u32,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub prompt: String,
    pub output_path: PathBuf,
    pub output_schema: Option<Value>,
    pub read_policy: AgentReadPolicy,
    /// Maximum compiler-brokered repository reads before the same live Pi
    /// session is steered into tool-free synthesis. `None` leaves non-planning
    /// review turns unchanged.
    pub max_read_tool_calls: Option<u32>,
    pub output_token_budget: Option<u64>,
    pub token_budget: Option<DirectPiTokenBudget>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectPiTokenMetric {
    NewTokens,
    ProcessedTokens,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirectPiTokenBudget {
    pub metric: DirectPiTokenMetric,
    pub remaining: u64,
}

/// One process-attempt-scoped writable directory for an otherwise read-only
/// Codex session.
///
/// The directory is created atomically beneath a canonical OS temp root, with
/// owner-only permissions on Unix, and is deliberately outside every supplied
/// product/control root. Its unique permission-profile name prevents a lower
/// Codex configuration layer from widening this attempt's filesystem policy.
/// Ordinary exits remove the directory through `Drop`; an abrupt host crash
/// leaves only an OS-temp artifact, never project or run state.
#[derive(Debug)]
pub(crate) struct ReadOnlyCodexScratch {
    path: PathBuf,
    profile_name: String,
}

impl ReadOnlyCodexScratch {
    pub(crate) fn create(forbidden_roots: &[&Path]) -> Result<Self> {
        let forbidden_roots = forbidden_roots
            .iter()
            .map(|root| {
                fs::canonicalize(root).map_err(|error| {
                    KoniError::Process(format!(
                        "cannot prove read-only agent scratch isolation from {}: {error}",
                        root.display()
                    ))
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let temp_root = canonical_scratch_temp_root(&forbidden_roots)?;

        for _ in 0..16 {
            let nonce = Uuid::now_v7().simple().to_string();
            let path = temp_root.join(format!("koni-codex-scratch-{nonce}"));
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            builder.mode(0o700);
            match builder.create(&path) {
                Ok(()) => {
                    let canonical =
                        match validate_created_scratch(&path, &temp_root, &forbidden_roots) {
                            Ok(canonical) => canonical,
                            Err(error) => {
                                let _ = fs::remove_dir_all(&path);
                                return Err(error);
                            }
                        };
                    return Ok(Self {
                        path: canonical,
                        profile_name: format!("koni_scratch_{nonce}"),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error(&path, error)),
            }
        }
        Err(KoniError::Process(
            "could not allocate a unique read-only agent scratch directory".to_owned(),
        ))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn profile_name(&self) -> &str {
        &self.profile_name
    }

    pub(crate) fn environment(&self) -> Vec<(String, String)> {
        vec![(
            "TMPDIR".to_owned(),
            self.path
                .to_str()
                .expect("scratch creation validates Unicode")
                .to_owned(),
        )]
    }

    /// Highest-precedence Codex configuration for a split filesystem policy:
    /// the machine remains readable, only this scratch directory is writable,
    /// and network access remains disabled. Permission profiles are used
    /// because Codex intentionally ignores `--add-dir` under `read-only`.
    pub(crate) fn codex_config_assignments(&self) -> Vec<String> {
        let scratch = self
            .path
            .to_str()
            .expect("scratch creation validates Unicode");
        let mut filesystem = toml::map::Map::new();
        filesystem.insert(":root".to_owned(), toml::Value::String("read".to_owned()));
        filesystem.insert(scratch.to_owned(), toml::Value::String("write".to_owned()));
        let filesystem = toml::Value::Table(filesystem);
        let selected = toml::Value::String(self.profile_name.clone());
        vec![
            format!(
                "permissions.{}.description={}",
                self.profile_name,
                toml::Value::String("Ephemeral Koni read-only agent scratch".to_owned())
            ),
            format!("permissions.{}.filesystem={filesystem}", self.profile_name),
            format!("permissions.{}.network.enabled=false", self.profile_name),
            format!("default_permissions={selected}"),
        ]
    }
}

impl Drop for ReadOnlyCodexScratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn canonical_scratch_temp_root(forbidden_roots: &[PathBuf]) -> Result<PathBuf> {
    let mut candidates = vec![std::env::temp_dir()];
    #[cfg(unix)]
    candidates.push(PathBuf::from("/tmp"));
    candidates.sort();
    candidates.dedup();

    for candidate in candidates {
        let Ok(canonical) = fs::canonicalize(&candidate) else {
            continue;
        };
        if !canonical.is_dir()
            || forbidden_roots
                .iter()
                .any(|forbidden| canonical.starts_with(forbidden))
        {
            continue;
        }
        return Ok(canonical);
    }
    Err(KoniError::Process(
        "no canonical OS temp directory exists outside product and control state".to_owned(),
    ))
}

fn validate_created_scratch(
    path: &Path,
    temp_root: &Path,
    forbidden_roots: &[PathBuf],
) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(KoniError::Process(format!(
            "read-only agent scratch is not a real directory: {}",
            path.display()
        )));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o777 != 0o700 {
        return Err(KoniError::Process(format!(
            "read-only agent scratch permissions are not owner-only: {}",
            path.display()
        )));
    }
    let canonical = fs::canonicalize(path).map_err(|error| io_error(path, error))?;
    if canonical.to_str().is_none() {
        return Err(KoniError::Process(
            "read-only agent scratch path is not valid Unicode".to_owned(),
        ));
    }
    if canonical.parent() != Some(temp_root)
        || forbidden_roots
            .iter()
            .any(|forbidden| canonical.starts_with(forbidden))
    {
        return Err(KoniError::Process(format!(
            "read-only agent scratch escaped its compiler-owned temp boundary: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentProcessResult {
    pub pid: u32,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

/// Durable operating-system identity for a compiler-owned agent process.
///
/// A PID is not an identity: the operating system may recycle it after the
/// original process exits. Production launchers isolate agents into a process
/// group whose leader is the agent PID, then persist both that PGID and the
/// versioned high-resolution birth marker reported by the kernel. Later
/// ownership checks require every field to match the live process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentProcessIdentity {
    pub pid: u32,
    pub process_group_id: u32,
    pub birth_marker: String,
}

/// Durable birth identity for a process that is not required to lead its own
/// process group. Runtime MCP brokers are ordinary direct children of Codex,
/// so using [`AgentProcessIdentity`] for them would incorrectly reject every
/// legitimate broker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessBirthIdentity {
    pub pid: u32,
    pub birth_marker: String,
}

const KERNEL_PROCESS_BIRTH_MARKER_PREFIX: &str = "kernel-start-v2:";
const LEGACY_PROCESS_BIRTH_MARKER_PREFIX: &str = "ps-lstart-utc-v1:";
#[cfg(any(target_os = "macos", test))]
const MACOS_ZOMBIE_PROCESS_STATUS: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
struct KernelProcessObservation {
    pid: u32,
    process_group_id: u32,
    birth_marker: String,
}

fn strong_process_birth_marker(marker: &str) -> bool {
    if marker.starts_with(LEGACY_PROCESS_BIRTH_MARKER_PREFIX) {
        return false;
    }
    let Some(marker) = marker.strip_prefix(KERNEL_PROCESS_BIRTH_MARKER_PREFIX) else {
        return false;
    };
    if let Some(fields) = marker.strip_prefix("linux:") {
        let Some((boot_id, ticks)) = fields.rsplit_once(':') else {
            return false;
        };
        return Uuid::parse_str(boot_id).is_ok_and(|parsed| {
            parsed.hyphenated().to_string() == boot_id && ticks.parse::<u64>().is_ok()
        });
    }
    if let Some(fields) = marker.strip_prefix("macos:") {
        let Some((seconds, microseconds)) = fields.split_once(':') else {
            return false;
        };
        return seconds.parse::<u64>().is_ok_and(|seconds| seconds > 0)
            && microseconds
                .parse::<u64>()
                .is_ok_and(|microseconds| microseconds < 1_000_000);
    }
    false
}

pub(crate) fn agent_process_identity_has_strong_birth_marker(
    identity: &AgentProcessIdentity,
) -> bool {
    strong_process_birth_marker(&identity.birth_marker)
}

#[cfg(any(target_os = "linux", test))]
fn linux_kernel_process_observation(
    expected_pid: u32,
    stat: &str,
    boot_id: &str,
) -> Option<KernelProcessObservation> {
    let prefix = format!("{expected_pid} (");
    if !stat.starts_with(&prefix) {
        return None;
    }
    // `comm` may itself contain spaces or `)`, so the final `) ` is the only
    // safe boundary before the fixed-position fields in proc_pid_stat(5).
    let fields = stat.get(stat.rfind(") ")? + 2..)?;
    let fields = fields.split_whitespace().collect::<Vec<_>>();
    // The tail begins at field 3 (`state`); pgrp is field 5 and starttime is
    // field 22, therefore indices 2 and 19 respectively.
    if fields.len() <= 19 || fields[0] == "Z" {
        return None;
    }
    let process_group_id = fields[2].parse::<u32>().ok()?;
    let start_ticks = fields[19].parse::<u64>().ok()?;
    let boot_id = boot_id.trim();
    let parsed_boot_id = Uuid::parse_str(boot_id).ok()?;
    if parsed_boot_id.hyphenated().to_string() != boot_id {
        return None;
    }
    Some(KernelProcessObservation {
        pid: expected_pid,
        process_group_id,
        birth_marker: format!("{KERNEL_PROCESS_BIRTH_MARKER_PREFIX}linux:{boot_id}:{start_ticks}"),
    })
}

#[cfg(any(target_os = "macos", test))]
fn macos_kernel_process_observation(
    expected_pid: u32,
    observed_pid: u32,
    process_group_id: u32,
    status: u32,
    start_seconds: u64,
    start_microseconds: u64,
) -> Option<KernelProcessObservation> {
    if observed_pid != expected_pid
        || process_group_id == 0
        || status == MACOS_ZOMBIE_PROCESS_STATUS
        || start_seconds == 0
        || start_microseconds >= 1_000_000
    {
        return None;
    }
    Some(KernelProcessObservation {
        pid: expected_pid,
        process_group_id,
        birth_marker: format!(
            "{KERNEL_PROCESS_BIRTH_MARKER_PREFIX}macos:{start_seconds}:{start_microseconds}"
        ),
    })
}

#[cfg(target_os = "linux")]
fn capture_kernel_process_observation(pid: u32) -> Option<KernelProcessObservation> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    linux_kernel_process_observation(pid, &stat, &boot_id)
}

#[cfg(target_os = "macos")]
fn capture_kernel_process_observation(pid: u32) -> Option<KernelProcessObservation> {
    let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
    let buffer_size = std::mem::size_of::<libc::proc_bsdinfo>();
    let written = unsafe {
        libc::proc_pidinfo(
            i32::try_from(pid).ok()?,
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast(),
            i32::try_from(buffer_size).ok()?,
        )
    };
    if usize::try_from(written).ok()? != buffer_size {
        return None;
    }
    macos_kernel_process_observation(
        pid,
        info.pbi_pid,
        info.pbi_pgid,
        info.pbi_status,
        info.pbi_start_tvsec,
        info.pbi_start_tvusec,
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn capture_kernel_process_observation(_pid: u32) -> Option<KernelProcessObservation> {
    None
}

fn process_birth_identity_matches_observation(
    identity: &ProcessBirthIdentity,
    observation: Option<&KernelProcessObservation>,
) -> bool {
    strong_process_birth_marker(&identity.birth_marker)
        && observation.is_some_and(|observation| {
            observation.pid == identity.pid && observation.birth_marker == identity.birth_marker
        })
}

fn owned_agent_process_identity_matches_observation(
    identity: &AgentProcessIdentity,
    observation: Option<&KernelProcessObservation>,
) -> bool {
    agent_process_identity_has_strong_birth_marker(identity)
        && observation.is_some_and(|observation| {
            observation.pid == identity.pid
                && observation.process_group_id == identity.process_group_id
                && observation.process_group_id == observation.pid
                && observation.birth_marker == identity.birth_marker
        })
}

/// Capture a live non-zombie process by PID and a versioned kernel-native
/// start identity. Weak `ps lstart` markers remain deserializable history, but
/// new process records never issue them.
pub fn capture_process_birth_identity(pid: u32) -> Option<ProcessBirthIdentity> {
    let observation = capture_kernel_process_observation(pid)?;
    Some(ProcessBirthIdentity {
        pid: observation.pid,
        birth_marker: observation.birth_marker,
    })
}

pub fn process_birth_identity_is_alive(identity: &ProcessBirthIdentity) -> bool {
    let observation = capture_kernel_process_observation(identity.pid);
    process_birth_identity_matches_observation(identity, observation.as_ref())
}

/// Resolve the executable image currently running as `pid`. Unsupported
/// platforms fail closed instead of substituting an argv label or PATH lookup.
pub fn process_executable_path(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        fs::read_link(format!("/proc/{pid}/exe"))
            .ok()?
            .canonicalize()
            .ok()
    }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::{CStr, c_char, c_int};

        #[link(name = "proc")]
        unsafe extern "C" {
            fn proc_pidpath(pid: c_int, buffer: *mut c_char, buffersize: u32) -> c_int;
        }

        let mut buffer = vec![0_u8; 4096];
        // SAFETY: `buffer` is writable for its supplied length and remains
        // alive for the duration of the system call.
        let written = unsafe {
            proc_pidpath(
                pid.try_into().ok()?,
                buffer.as_mut_ptr().cast(),
                buffer.len().try_into().ok()?,
            )
        };
        if written <= 0 {
            return None;
        }
        let path = CStr::from_bytes_until_nul(&buffer).ok()?.to_str().ok()?;
        PathBuf::from(path).canonicalize().ok()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

/// Capture an identity only when `pid` is a live, non-zombie process-group
/// leader. Returning `None` is fail-closed: callers must not infer ownership
/// from a bare PID. New birth markers come directly from the platform kernel
/// at sub-second or boot-relative tick precision.
pub fn capture_owned_agent_process_identity(pid: u32) -> Option<AgentProcessIdentity> {
    let observation = capture_kernel_process_observation(pid)?;
    if observation.process_group_id != pid {
        return None;
    }
    Some(AgentProcessIdentity {
        pid: observation.pid,
        process_group_id: observation.process_group_id,
        birth_marker: observation.birth_marker,
    })
}

pub fn owned_agent_process_is_alive(identity: &AgentProcessIdentity) -> bool {
    let observation = capture_kernel_process_observation(identity.pid);
    owned_agent_process_identity_matches_observation(identity, observation.as_ref())
}

/// Injectable seam around process creation and supervision. `on_started` must
/// return before the child is allowed to continue unsupervised; the standard
/// implementation kills and reaps the child if durable PID recording fails.
pub trait AgentProcessLauncher {
    fn is_alive(&self, pid: u32) -> bool;

    /// Return a durable identity when the launcher can prove ownership. Test
    /// launchers may retain the default because their synthetic PIDs never
    /// survive the synchronous test call.
    fn process_identity(&self, _pid: u32) -> Option<AgentProcessIdentity> {
        None
    }

    fn requires_process_identity(&self) -> bool {
        false
    }

    fn is_direct_pi_runtime(&self) -> bool {
        false
    }

    fn run(
        &self,
        request: &AgentProcessRequest,
        on_started: &mut dyn FnMut(u32) -> Result<()>,
    ) -> Result<AgentProcessResult>;
}

#[derive(Debug, Clone)]
pub struct CodexAgentProcessLauncher {
    executable: String,
    poll_interval: Duration,
}

impl Default for CodexAgentProcessLauncher {
    fn default() -> Self {
        Self {
            executable: "codex".to_owned(),
            poll_interval: Duration::from_millis(25),
        }
    }
}

impl CodexAgentProcessLauncher {
    pub fn new(executable: impl Into<String>) -> Self {
        Self {
            executable: executable.into(),
            ..Self::default()
        }
    }

    pub fn executable(&self) -> &str {
        &self.executable
    }
}

impl AgentProcessLauncher for CodexAgentProcessLauncher {
    fn is_alive(&self, pid: u32) -> bool {
        capture_owned_agent_process_identity(pid).is_some()
    }

    fn process_identity(&self, pid: u32) -> Option<AgentProcessIdentity> {
        capture_owned_agent_process_identity(pid)
    }

    fn requires_process_identity(&self) -> bool {
        true
    }

    fn run(
        &self,
        request: &AgentProcessRequest,
        on_started: &mut dyn FnMut(u32) -> Result<()>,
    ) -> Result<AgentProcessResult> {
        if request.timeout.is_zero() {
            return Err(KoniError::Process(
                "agent process timeout must be positive".to_owned(),
            ));
        }
        if !request.working_directory.is_dir() {
            return Err(KoniError::Process(format!(
                "agent working directory does not exist: {}",
                request.working_directory.display()
            )));
        }
        for path in [&request.stdout_path, &request.stderr_path] {
            let parent = path.parent().ok_or_else(|| {
                KoniError::Process(format!("agent log has no parent: {}", path.display()))
            })?;
            fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
        }
        let stdout = fs::File::create(&request.stdout_path)
            .map_err(|error| io_error(&request.stdout_path, error))?;
        let stderr = fs::File::create(&request.stderr_path)
            .map_err(|error| io_error(&request.stderr_path, error))?;
        let executable = if request.executable.trim().is_empty() {
            &self.executable
        } else {
            &request.executable
        };
        let mut command = Command::new(executable);
        for (name, value) in &request.environment_set {
            command.env(name, value);
        }
        // Removal is deliberately last so a generic caller cannot re-add a
        // compiler bearer through `environment_set`.
        for name in &request.environment_remove {
            command.env_remove(name);
        }
        command
            .args(&request.args)
            .current_dir(&request.working_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        isolate_process_group(&mut command);
        let mut child = command.spawn().map_err(|error| {
            KoniError::Process(format!("failed to spawn planning agent: {error}"))
        })?;
        let pid = child.id();
        if let Err(error) = on_started(pid) {
            let _ = terminate_agent_process(&mut child, pid);
            let _ = child.wait();
            return Err(error);
        }

        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Ok(AgentProcessResult {
                        pid,
                        exit_code: status.code(),
                        timed_out: false,
                    });
                }
                Ok(None) if started.elapsed() >= request.timeout => {
                    terminate_agent_process(&mut child, pid).map_err(|error| {
                        KoniError::Process(format!(
                            "planning agent group {pid} timed out and could not be killed: {error}"
                        ))
                    })?;
                    let status = child.wait().map_err(|error| {
                        KoniError::Process(format!(
                            "planning agent {pid} was killed but could not be reaped: {error}"
                        ))
                    })?;
                    return Ok(AgentProcessResult {
                        pid,
                        exit_code: status.code(),
                        timed_out: true,
                    });
                }
                Ok(None) => thread::sleep(self.poll_interval.min(request.timeout)),
                Err(error) => {
                    let _ = terminate_agent_process(&mut child, pid);
                    let _ = child.wait();
                    return Err(KoniError::Process(format!(
                        "failed to supervise planning agent {pid}: {error}"
                    )));
                }
            }
        }
    }
}

/// Production one-shot launcher for planning and independent review turns.
///
/// The request shape remains the established engine seam so deterministic
/// test launchers do not need to change. This implementation accepts only the
/// typed compiler request; it never executes or reparses the Codex CLI.
#[derive(Debug, Default)]
pub struct PiAgentProcessLauncher {
    identities: Mutex<BTreeMap<u32, AgentProcessIdentity>>,
}

impl PiAgentProcessLauncher {
    pub fn new() -> Self {
        Self::default()
    }
}

impl AgentProcessLauncher for PiAgentProcessLauncher {
    fn is_alive(&self, pid: u32) -> bool {
        self.identities
            .lock()
            .ok()
            .and_then(|identities| identities.get(&pid).cloned())
            .is_some_and(|identity| owned_agent_process_is_alive(&identity))
    }

    fn process_identity(&self, pid: u32) -> Option<AgentProcessIdentity> {
        self.identities
            .lock()
            .ok()
            .and_then(|identities| identities.get(&pid).cloned())
    }

    fn is_direct_pi_runtime(&self) -> bool {
        true
    }

    fn run(
        &self,
        request: &AgentProcessRequest,
        on_started: &mut dyn FnMut(u32) -> Result<()>,
    ) -> Result<AgentProcessResult> {
        validate_pi_agent_process_request(request)?;
        let direct = request.direct_pi.as_ref().ok_or_else(|| {
            KoniError::Process("direct Pi launch is missing its typed compiler request".to_owned())
        })?;
        let artifact = PiRuntimeArtifact::discover(&[&request.working_directory])?;
        let session_id = direct
            .logical_session_id
            .clone()
            .unwrap_or_else(|| format!("pi-session-{}", Uuid::now_v7()));
        let credential_lease = CredentialLeaseId(format!("pi-lease-{}", Uuid::now_v7()));
        let mut recorded_pid = None;
        let mut process = PiRuntimeProcess::bootstrap(
            PiRuntimeBootstrapRequest {
                artifact,
                transport_session_id: session_id.clone(),
                credential_lease: credential_lease.clone(),
                timeout: request.timeout,
                network_access: true,
                oauth_callback_access: false,
            },
            &mut |identity| {
                self.identities
                    .lock()
                    .map_err(|_| {
                        KoniError::Process("Pi launcher identity lock was poisoned".to_owned())
                    })?
                    .insert(identity.pid, identity.clone());
                recorded_pid = Some(identity.pid);
                if let Err(error) = on_started(identity.pid) {
                    if let Ok(mut identities) = self.identities.lock() {
                        identities.remove(&identity.pid);
                    }
                    return Err(error);
                }
                Ok(())
            },
        )?;
        let pid = recorded_pid.ok_or_else(|| {
            KoniError::Process("direct Pi host started without a durable identity".to_owned())
        })?;
        let _identity_guard = PiLauncherIdentityGuard {
            identities: &self.identities,
            pid,
        };
        let models = process.list_models()?;
        let requested_model = direct.model.as_deref().unwrap_or("gpt-5.6-terra");
        let model = models
            .into_iter()
            .find(|candidate| {
                candidate.provider == PI_RUNTIME_PROVIDER_ID && candidate.id == requested_model
            })
            .ok_or_else(|| {
                KoniError::Process(format!(
                    "configured model {requested_model} is absent from the pinned Pi registry"
                ))
            })?;
        let thinking = parse_pi_launcher_thinking(direct.thinking_level.as_deref())?;
        if !model.thinking_levels.is_empty() && !model.thinking_levels.contains(&thinking) {
            return Err(KoniError::Process(format!(
                "model {} does not support requested Pi thinking level",
                model.id
            )));
        }
        let output_token_budget = direct
            .output_token_budget
            .unwrap_or(model.max_tokens)
            .min(model.max_tokens);
        if output_token_budget < 16 {
            return Err(KoniError::Process(
                "direct Pi output-token budget must leave at least 16 tokens".to_owned(),
            ));
        }
        if let Some(budget) = direct.token_budget
            && budget.remaining < 16
        {
            return Err(KoniError::Process(
                "direct Pi turn has fewer than 16 charged tokens remaining".to_owned(),
            ));
        }
        let identity = process.process_identity()?.clone();
        let context = AgentToolContext {
            session_id: session_id.clone(),
            run_id: direct.run_id.clone(),
            agent_id: direct.agent_id.clone(),
            attempt: direct.attempt,
            runtime_process: identity,
        };
        let broker = ReadOnlyProjectToolBroker::new(
            &request.working_directory,
            context.clone(),
            direct.read_policy.clone(),
        )?;
        process.start_session(RuntimeSessionStart {
            session_id: session_id.clone(),
            run_id: direct.run_id.clone(),
            agent_id: direct.agent_id.clone(),
            attempt: direct.attempt,
            model: RuntimeModelRef {
                provider: model.provider.clone(),
                model: model.id.clone(),
                thinking_level: thinking,
                input_capabilities: model.input.clone(),
                context_window: Some(model.context_window),
            },
            instructions: "You are a Koni compiler-owned read-only planning or review agent. Use only the bounded Rust read tools when repository evidence is needed. Return exactly the requested final artifact; never request shell, filesystem, network, lifecycle, or credential authority."
                .to_owned(),
            tools: read_only_project_tool_definitions(&direct.read_policy),
            terminal_boundary_tools: Vec::new(),
            context_completion_required: false,
            credential_lease,
        })?;

        let mut stdout = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&request.stdout_path)
            .map_err(|error| io_error(&request.stdout_path, error))?;
        write_json_line(
            &mut stdout,
            &json!({"type": "thread.started", "thread_id": session_id, "runtime": "pi-sdk"}),
        )?;
        let turn_request = RuntimeTurnRequest {
            turn_id: format!("turn-{}", Uuid::now_v7()),
            input: vec![RuntimeInput::Text {
                text: direct.prompt.clone(),
            }],
            output_schema: direct.output_schema.clone(),
            output_token_budget: Some(direct.token_budget.map_or(output_token_budget, |budget| {
                output_token_budget.min(budget.remaining)
            })),
        };
        let (turn, charged_tokens) = if let Some(limit) = direct.max_read_tool_calls {
            let broker = PlanningReadToolBroker::new(broker, limit)?;
            let mut exploration_request = turn_request;
            exploration_request.output_schema = None;
            let exploration = process.run_turn(exploration_request, &broker, &mut |event| {
                write_pi_compat_event(&mut stdout, event)
            })?;
            let exploration_charge = direct.token_budget.map_or(0, |budget| {
                direct_pi_charged_tokens(budget.metric, &exploration.usage)
            });
            if broker.synthesis_requested() {
                let synthesis_budget = direct.token_budget.map_or(output_token_budget, |budget| {
                    budget.remaining.saturating_sub(exploration_charge)
                });
                if synthesis_budget < 16 {
                    return Err(KoniError::Process(format!(
                        "planning exploration left {synthesis_budget} charged tokens, fewer than the minimum 16-token synthesis turn"
                    )));
                }
                let synthesis = process.run_turn(
                    RuntimeTurnRequest {
                        turn_id: format!("turn-{}", Uuid::now_v7()),
                        input: vec![RuntimeInput::Text {
                            text: PLANNING_SYNTHESIS_INSTRUCTION.to_owned(),
                        }],
                        output_schema: direct.output_schema.clone(),
                        output_token_budget: Some(
                            synthesis_budget
                                .min(output_token_budget)
                                .min(model.max_tokens),
                        ),
                    },
                    &broker,
                    &mut |event| write_pi_compat_event(&mut stdout, event),
                )?;
                let synthesis_charge = direct.token_budget.map_or(0, |budget| {
                    direct_pi_charged_tokens(budget.metric, &synthesis.usage)
                });
                (
                    synthesis,
                    exploration_charge.saturating_add(synthesis_charge),
                )
            } else {
                (exploration, exploration_charge)
            }
        } else {
            let turn = process.run_turn(turn_request, &broker, &mut |event| {
                write_pi_compat_event(&mut stdout, event)
            })?;
            let charged = direct.token_budget.map_or(0, |budget| {
                direct_pi_charged_tokens(budget.metric, &turn.usage)
            });
            (turn, charged)
        };
        let shutdown = process.terminate();
        let turn = match shutdown {
            Ok(()) => turn,
            Err(error) => {
                let _ = fs::write(&request.stderr_path, format!("{error}\n"));
                return Err(error);
            }
        };
        if let Some(budget) = direct.token_budget
            && charged_tokens > budget.remaining
        {
            // The provider has already spent these tokens. Commit that
            // terminal usage before refusing to publish the artifact so
            // a retry cannot regain the exhausted allowance.
            write_pi_completed_event(&mut stdout, &turn)?;
            return Err(KoniError::Process(format!(
                "direct Pi turn exceeded its compiler-owned token budget: charged {charged_tokens}, remaining {}",
                budget.remaining
            )));
        }
        let output = assistant_output_text(&turn.assistant_messages).ok_or_else(|| {
            KoniError::Process("Pi agent completed without a final assistant message".to_owned())
        })?;
        let output = if direct.output_schema.is_some() {
            canonical_structured_output(&output)?
        } else {
            output
        };
        write_durable_agent_output(&direct.output_path, output.as_bytes())?;
        write_pi_completed_event(&mut stdout, &turn)?;
        Ok(AgentProcessResult {
            pid,
            exit_code: Some(0),
            timed_out: false,
        })
    }
}

struct PiLauncherIdentityGuard<'a> {
    identities: &'a Mutex<BTreeMap<u32, AgentProcessIdentity>>,
    pid: u32,
}

impl Drop for PiLauncherIdentityGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut identities) = self.identities.lock() {
            identities.remove(&self.pid);
        }
    }
}

fn validate_pi_agent_process_request(request: &AgentProcessRequest) -> Result<()> {
    if request.timeout.is_zero() {
        return Err(KoniError::Process(
            "agent process timeout must be positive".to_owned(),
        ));
    }
    if !request.working_directory.is_dir() {
        return Err(KoniError::Process(format!(
            "agent working directory does not exist: {}",
            request.working_directory.display()
        )));
    }
    for path in [&request.stdout_path, &request.stderr_path] {
        let parent = path.parent().ok_or_else(|| {
            KoniError::Process(format!("agent log has no parent: {}", path.display()))
        })?;
        fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }
    Ok(())
}

fn parse_pi_launcher_thinking(value: Option<&str>) -> Result<RuntimeThinkingLevel> {
    match value.unwrap_or("high") {
        "off" => Ok(RuntimeThinkingLevel::Off),
        "minimal" => Ok(RuntimeThinkingLevel::Minimal),
        "low" => Ok(RuntimeThinkingLevel::Low),
        "medium" => Ok(RuntimeThinkingLevel::Medium),
        "high" => Ok(RuntimeThinkingLevel::High),
        "xhigh" => Ok(RuntimeThinkingLevel::Xhigh),
        "max" | "ultra" => Ok(RuntimeThinkingLevel::Max),
        other => Err(KoniError::Process(format!(
            "unsupported Pi thinking level {other}"
        ))),
    }
}

fn write_json_line(writer: &mut fs::File, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, value).map_err(|error| {
        KoniError::Process(format!(
            "could not serialize Pi compatibility event: {error}"
        ))
    })?;
    writer
        .write_all(b"\n")
        .map_err(|error| KoniError::Process(format!("could not write Pi event: {error}")))?;
    writer
        .flush()
        .map_err(|error| KoniError::Process(format!("could not flush Pi event: {error}")))
}

fn write_pi_compat_event(writer: &mut fs::File, event: &RuntimeEvent) -> Result<()> {
    let Some(record) = durable_pi_transcript_record(event) else {
        return Ok(());
    };
    write_json_line(writer, &record)?;
    if matches!(event, RuntimeEvent::TurnCompleted { .. }) {
        // This is an accounting checkpoint, not a terminal compatibility
        // event. Completion is committed only after the structured output
        // artifact is durable, while failed/schema-invalid turns still leave
        // an exact provider-usage record for retry budgeting.
        writer.sync_data().map_err(|error| {
            KoniError::Process(format!("could not sync Pi usage checkpoint: {error}"))
        })?;
    }
    Ok(())
}

/// One canonical, compiler-owned transcript record for every Pi agent path.
///
/// Planning used this envelope first; direct Lead and ticket-worker logs now
/// use it too so the cockpit does not need to guess which runtime path wrote a
/// transcript. Raw deltas remain private to the contained host.
pub(crate) fn durable_pi_transcript_record(event: &RuntimeEvent) -> Option<Value> {
    match event {
        RuntimeEvent::TurnCompleted { turn_id, usage, .. } => Some(json!({
            "type": "pi.turn_usage",
            "runtime": "pi-sdk",
            "turn_id": turn_id,
            "usage": usage,
        })),
        RuntimeEvent::RuntimeError { message, .. } => Some(json!({
            "type": "turn.failed",
            "runtime": "pi-sdk",
            "message": message,
            "event": compact_pi_runtime_event(event),
        })),
        RuntimeEvent::MessageDelta { .. } | RuntimeEvent::ToolUpdated { .. } => None,
        _ => Some(json!({
            "type": "pi.event",
            "runtime": "pi-sdk",
            // The Pi wire boundary is already credential-isolated and
            // bounded before an event reaches this process. Keep its
            // complete, user-visible conversation payload in the local
            // compiler-owned artifact so the cockpit can render an actual
            // transcript. Hashes remain beside the payload for audit/identity
            // checks; transport deltas are still omitted.
            "event": durable_pi_transcript_event(event),
        })),
    }
}

pub(crate) fn durable_pi_transcript_event(event: &RuntimeEvent) -> Value {
    let mut value = compact_pi_runtime_event(event);
    let Some(object) = value.as_object_mut() else {
        return value;
    };
    match event {
        RuntimeEvent::MessageCompleted { content, .. } => {
            object.insert("content".to_owned(), content.clone());
        }
        RuntimeEvent::ToolCompleted { outcome, .. } => {
            object.insert(
                "outcome".to_owned(),
                serde_json::to_value(outcome).unwrap_or(Value::Null),
            );
        }
        RuntimeEvent::ToolRejected { message, .. } => {
            object.insert("message".to_owned(), Value::String(message.clone()));
        }
        RuntimeEvent::Retry { reason, .. } => {
            object.insert("reason".to_owned(), Value::String(reason.clone()));
        }
        _ => {}
    }
    value
}

pub(crate) fn compact_pi_runtime_event(event: &RuntimeEvent) -> Value {
    match event {
        RuntimeEvent::TurnStarted { turn_id } => {
            json!({"event": "turn_started", "turn_id": turn_id})
        }
        RuntimeEvent::MessageDelta {
            turn_id,
            message_id,
            text,
        } => json!({
            "event": "message_delta",
            "turn_id": turn_id,
            "message_id": message_id,
            "text_bytes": text.len(),
        }),
        RuntimeEvent::MessageCompleted {
            turn_id,
            message_id,
            role,
            content,
        } => json!({
            "event": "message_completed",
            "turn_id": turn_id,
            "message_id": message_id,
            "role": role,
            "content_hash": normalized_hash(content),
            "content_bytes": serde_json::to_vec(content).map_or(0, |bytes| bytes.len()),
        }),
        RuntimeEvent::ToolStarted {
            turn_id,
            call_id,
            name,
        } => json!({
            "event": "tool_started",
            "turn_id": turn_id,
            "call_id": call_id,
            "name": name,
        }),
        RuntimeEvent::ToolUpdated {
            turn_id,
            call_id,
            update,
        } => json!({
            "event": "tool_updated",
            "turn_id": turn_id,
            "call_id": call_id,
            "update_hash": normalized_hash(update),
        }),
        RuntimeEvent::ToolCompleted {
            turn_id,
            call_id,
            outcome,
        } => json!({
            "event": "tool_completed",
            "turn_id": turn_id,
            "call_id": call_id,
            "terminal": outcome.is_terminal(),
            "outcome_hash": normalized_hash(outcome),
            "outcome_bytes": serde_json::to_vec(outcome).map_or(0, |bytes| bytes.len()),
        }),
        RuntimeEvent::ToolRejected {
            turn_id,
            call_id,
            name,
            code,
            ..
        } => json!({
            "event": "tool_rejected",
            "turn_id": turn_id,
            "call_id": call_id,
            "name": name,
            "code": code,
        }),
        RuntimeEvent::Usage { turn_id, usage } => {
            json!({"event": "usage", "turn_id": turn_id, "usage": usage})
        }
        RuntimeEvent::Retry {
            turn_id,
            attempt,
            delay_ms,
            ..
        } => json!({
            "event": "retry",
            "turn_id": turn_id,
            "attempt": attempt,
            "delay_ms": delay_ms,
        }),
        RuntimeEvent::Compaction {
            turn_id,
            source_message_ids,
            summary_sha256,
        } => json!({
            "event": "compaction",
            "turn_id": turn_id,
            "source_message_count": source_message_ids.len(),
            "summary_sha256": summary_sha256,
        }),
        RuntimeEvent::TurnCompleted {
            turn_id,
            stop_reason,
            usage,
        } => json!({
            "event": "turn_completed",
            "turn_id": turn_id,
            "stop_reason": stop_reason,
            "usage": usage,
        }),
        RuntimeEvent::RuntimeError {
            turn_id,
            code,
            message,
            retryable,
        } => json!({
            "event": "runtime_error",
            "turn_id": turn_id,
            "code": code,
            "message": message,
            "retryable": retryable,
        }),
        RuntimeEvent::Authentication { .. } => json!({"event": "authentication"}),
    }
}

fn write_pi_completed_event(
    writer: &mut fs::File,
    turn: &crate::pi_runtime_process::PiTurnResult,
) -> Result<()> {
    let legacy_input_tokens = turn
        .usage
        .total_tokens
        .saturating_sub(turn.usage.output_tokens);
    write_json_line(
        writer,
        &json!({
            "type": "turn.completed",
            "runtime": "pi-sdk",
            "usage": {
                "input_tokens": legacy_input_tokens,
                "cached_input_tokens": turn.usage.cached_input_tokens,
                "output_tokens": turn.usage.output_tokens,
                "reasoning_output_tokens": turn.usage.reasoning_tokens,
                "total_tokens": turn.usage.total_tokens,
            },
            "event": {
                "event": "turn_completed",
                "turn_id": turn.turn_id,
                "stop_reason": turn.stop_reason,
                "usage": turn.usage,
            },
        }),
    )?;
    writer
        .sync_data()
        .map_err(|error| KoniError::Process(format!("could not sync Pi usage event: {error}")))
}

fn direct_pi_charged_tokens(
    metric: DirectPiTokenMetric,
    usage: &crate::agent_runtime::RuntimeUsage,
) -> u64 {
    match metric {
        DirectPiTokenMetric::NewTokens => {
            usage.total_tokens.saturating_sub(usage.cached_input_tokens)
        }
        DirectPiTokenMetric::ProcessedTokens => usage.total_tokens,
    }
}

fn assistant_output_text(messages: &[Value]) -> Option<String> {
    let value = messages.last()?;
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        }
        other => serde_json::to_string_pretty(other).ok(),
    }
}

fn canonical_structured_output(text: &str) -> Result<String> {
    let trimmed = text.trim();
    let json_text = if trimmed.starts_with("```") && trimmed.ends_with("```") {
        let after_open = trimmed.split_once('\n').map_or(trimmed, |(_, rest)| rest);
        after_open.strip_suffix("```").unwrap_or(after_open).trim()
    } else {
        trimmed
    };
    let value: Value = serde_json::from_str(json_text).map_err(|error| {
        KoniError::Process(format!(
            "Pi agent returned a non-JSON structured output after validation: {error}"
        ))
    })?;
    serde_json::to_string(&value).map_err(|error| {
        KoniError::Process(format!(
            "could not serialize validated Pi structured output: {error}"
        ))
    })
}

fn write_durable_agent_output(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| {
        KoniError::Process(format!("Pi agent output has no parent: {}", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("pi-output"),
        Uuid::now_v7()
    ));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options
        .open(&temporary)
        .map_err(|error| io_error(&temporary, error))?;
    if let Err(error) = output
        .write_all(bytes)
        .and_then(|()| output.sync_all())
        .and_then(|()| fs::rename(&temporary, path))
        .and_then(|()| fs::File::open(parent)?.sync_all())
    {
        let _ = fs::remove_file(&temporary);
        return Err(io_error(path, error));
    }
    Ok(())
}

struct ReadOnlyProjectToolBroker {
    root: PathBuf,
    expected_context: AgentToolContext,
    read_policy: ResolvedAgentReadPolicy,
}

enum ResolvedAgentReadPolicy {
    None,
    Project,
    ExactFiles(BTreeSet<PathBuf>),
}

impl ReadOnlyProjectToolBroker {
    fn new(
        root: &Path,
        expected_context: AgentToolContext,
        read_policy: AgentReadPolicy,
    ) -> Result<Self> {
        let root = root.canonicalize().map_err(|error| io_error(root, error))?;
        let read_policy = match read_policy {
            AgentReadPolicy::None => ResolvedAgentReadPolicy::None,
            AgentReadPolicy::Project => ResolvedAgentReadPolicy::Project,
            AgentReadPolicy::ExactFiles(paths) => {
                let mut exact = BTreeSet::new();
                for path in paths {
                    let path_text = path.to_str().ok_or_else(|| {
                        KoniError::Process("exact Pi read path is not valid Unicode".to_owned())
                    })?;
                    let canonical = contained_read_path(&root, path_text)?;
                    if !canonical.is_file() {
                        return Err(KoniError::Process(format!(
                            "exact Pi read scope is not a regular file: {}",
                            path.display()
                        )));
                    }
                    exact.insert(
                        canonical
                            .strip_prefix(&root)
                            .expect("contained path is beneath root")
                            .to_path_buf(),
                    );
                }
                if exact.is_empty() {
                    ResolvedAgentReadPolicy::None
                } else {
                    ResolvedAgentReadPolicy::ExactFiles(exact)
                }
            }
        };
        Ok(Self {
            root,
            expected_context,
            read_policy,
        })
    }

    fn ensure_allowed_file(&self, path: &Path) -> Result<PathBuf> {
        let relative = path.strip_prefix(&self.root).map_err(|_| {
            KoniError::Process("project read target escaped its pinned root".to_owned())
        })?;
        match &self.read_policy {
            ResolvedAgentReadPolicy::None => Err(KoniError::Process(
                "this read-only turn has no product-file capability".to_owned(),
            )),
            ResolvedAgentReadPolicy::Project => Ok(relative.to_path_buf()),
            ResolvedAgentReadPolicy::ExactFiles(paths) if paths.contains(relative) => {
                Ok(relative.to_path_buf())
            }
            ResolvedAgentReadPolicy::ExactFiles(_) => Err(KoniError::Process(
                "project file is outside the compiler-issued exact read scope".to_owned(),
            )),
        }
    }

    fn execute_inner(&self, call: &AgentToolCall) -> Result<Value> {
        match call.name.as_str() {
            "read_project_file" => {
                let relative = required_tool_string(&call.arguments, "path")?;
                let path = contained_read_path(&self.root, relative)?;
                self.ensure_allowed_file(&path)?;
                let metadata = fs::metadata(&path).map_err(|error| io_error(&path, error))?;
                if !metadata.is_file() || metadata.len() > MAX_READ_ONLY_PROJECT_FILE_BYTES {
                    return Err(KoniError::Process(
                        "requested file is not a bounded regular project file".to_owned(),
                    ));
                }
                let content = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
                Ok(json!({"path": relative, "content": content}))
            }
            "list_project_files" => {
                let prefix = call
                    .arguments
                    .get("prefix")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let start = contained_read_path(&self.root, prefix)?;
                if let ResolvedAgentReadPolicy::ExactFiles(paths) = &self.read_policy {
                    let prefix = start.strip_prefix(&self.root).map_err(|_| {
                        KoniError::Process("project listing escaped its root".to_owned())
                    })?;
                    let mut files = paths
                        .iter()
                        .filter(|path| path.starts_with(prefix))
                        .map(|path| path.to_string_lossy().into_owned())
                        .take(501)
                        .collect::<Vec<_>>();
                    let mut truncated = files.len() > 500;
                    files.truncate(500);
                    bound_file_list_response(&mut files, &mut truncated)?;
                    return Ok(json!({"files": files, "truncated": truncated}));
                }
                if matches!(self.read_policy, ResolvedAgentReadPolicy::None) {
                    return Err(KoniError::Process(
                        "this read-only turn has no product-file capability".to_owned(),
                    ));
                }
                let mut files = Vec::new();
                let mut visited_entries = 0_usize;
                let mut traversal_truncated = false;
                for entry in WalkDir::new(start)
                    .follow_links(false)
                    .into_iter()
                    .filter_entry(|entry| {
                        entry.depth() == 0
                            || (!entry.file_type().is_symlink()
                                && entry
                                    .path()
                                    .strip_prefix(&self.root)
                                    .is_ok_and(|path| !path_has_denied_component(path)))
                    })
                    .filter_map(|entry| entry.ok())
                {
                    visited_entries = visited_entries.saturating_add(1);
                    if visited_entries > MAX_READ_WALK_ENTRIES {
                        traversal_truncated = true;
                        break;
                    }
                    if entry.file_type().is_symlink() {
                        continue;
                    }
                    if entry.file_type().is_file() {
                        let relative = entry.path().strip_prefix(&self.root).map_err(|_| {
                            KoniError::Process("project listing escaped its root".to_owned())
                        })?;
                        files.push(relative.to_string_lossy().into_owned());
                        if files.len() >= 500 {
                            traversal_truncated = true;
                            break;
                        }
                    }
                }
                files.sort();
                let mut truncated = traversal_truncated;
                bound_file_list_response(&mut files, &mut truncated)?;
                Ok(json!({"files": files, "truncated": truncated}))
            }
            "search_project" => {
                let query = required_tool_string(&call.arguments, "query")?;
                if query.len() > 256 {
                    return Err(KoniError::Process("search query is too long".to_owned()));
                }
                let matcher = regex::Regex::new(query).map_err(|_| {
                    KoniError::Process("search query is not a valid bounded regex".to_owned())
                })?;
                let prefix = call
                    .arguments
                    .get("prefix")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let start = contained_read_path(&self.root, prefix)?;
                let mut matches = Vec::new();
                let mut inspected = 0_usize;
                let mut scanned_bytes = 0_u64;
                let mut scan_truncated = false;
                if let ResolvedAgentReadPolicy::ExactFiles(paths) = &self.read_policy {
                    let prefix = start.strip_prefix(&self.root).map_err(|_| {
                        KoniError::Process("project search escaped its root".to_owned())
                    })?;
                    'exact: for relative in paths.iter().filter(|path| path.starts_with(prefix)) {
                        if inspected >= 5_000 || matches.len() >= 100 {
                            break;
                        }
                        let path = self.root.join(relative);
                        inspected += 1;
                        let Ok(metadata) = fs::metadata(&path) else {
                            continue;
                        };
                        if metadata.len() > 256 * 1024 {
                            continue;
                        }
                        if scanned_bytes.saturating_add(metadata.len()) > MAX_READ_SEARCH_BYTES {
                            scan_truncated = true;
                            break;
                        }
                        scanned_bytes = scanned_bytes.saturating_add(metadata.len());
                        let Ok(content) = fs::read_to_string(&path) else {
                            continue;
                        };
                        for (index, line) in content.lines().enumerate() {
                            if matcher.is_match(line) {
                                matches.push(json!({
                                    "path": relative.to_string_lossy(),
                                    "line": index + 1,
                                    "text": line.chars().take(500).collect::<String>(),
                                }));
                                if matches.len() >= 100 {
                                    break 'exact;
                                }
                            }
                        }
                    }
                    let mut truncated =
                        scan_truncated || inspected >= 5_000 || matches.len() >= 100;
                    bound_search_response(&mut matches, inspected, &mut truncated)?;
                    return Ok(json!({
                        "matches": matches,
                        "inspected_files": inspected,
                        "truncated": truncated,
                    }));
                }
                if matches!(self.read_policy, ResolvedAgentReadPolicy::None) {
                    return Err(KoniError::Process(
                        "this read-only turn has no product-file capability".to_owned(),
                    ));
                }
                let mut visited_entries = 0_usize;
                'files: for entry in WalkDir::new(start)
                    .follow_links(false)
                    .into_iter()
                    .filter_entry(|entry| {
                        entry.depth() == 0
                            || (!entry.file_type().is_symlink()
                                && entry
                                    .path()
                                    .strip_prefix(&self.root)
                                    .is_ok_and(|path| !path_has_denied_component(path)))
                    })
                    .filter_map(|entry| entry.ok())
                {
                    visited_entries = visited_entries.saturating_add(1);
                    if visited_entries > MAX_READ_WALK_ENTRIES {
                        scan_truncated = true;
                        break;
                    }
                    if inspected >= 5_000 || matches.len() >= 100 {
                        break;
                    }
                    if !entry.file_type().is_file() || entry.file_type().is_symlink() {
                        continue;
                    }
                    inspected += 1;
                    let Ok(metadata) = entry.metadata() else {
                        continue;
                    };
                    if metadata.len() > 256 * 1024 {
                        continue;
                    }
                    if scanned_bytes.saturating_add(metadata.len()) > MAX_READ_SEARCH_BYTES {
                        scan_truncated = true;
                        break;
                    }
                    scanned_bytes = scanned_bytes.saturating_add(metadata.len());
                    let Ok(content) = fs::read_to_string(entry.path()) else {
                        continue;
                    };
                    for (index, line) in content.lines().enumerate() {
                        if matcher.is_match(line) {
                            matches.push(json!({
                                "path": entry.path().strip_prefix(&self.root).unwrap_or(entry.path()).to_string_lossy(),
                                "line": index + 1,
                                "text": line.chars().take(500).collect::<String>(),
                            }));
                            if matches.len() >= 100 {
                                break 'files;
                            }
                        }
                    }
                }
                let mut truncated = scan_truncated
                    || visited_entries > MAX_READ_WALK_ENTRIES
                    || inspected >= 5_000
                    || matches.len() >= 100;
                bound_search_response(&mut matches, inspected, &mut truncated)?;
                Ok(json!({
                    "matches": matches,
                    "inspected_files": inspected,
                    "truncated": truncated,
                }))
            }
            _ => Err(KoniError::Process(
                "tool is outside the compiler-owned read-only catalog".to_owned(),
            )),
        }
    }
}

fn bound_file_list_response(files: &mut Vec<String>, truncated: &mut bool) -> Result<()> {
    while serde_json::to_vec(&json!({"files": files, "truncated": *truncated}))
        .map_err(|error| KoniError::Process(format!("could not size Pi file list: {error}")))?
        .len()
        > MAX_READ_TOOL_RESPONSE_BYTES
    {
        if files.pop().is_none() {
            return Err(KoniError::Process(
                "Pi file-list envelope exceeds its transport budget".to_owned(),
            ));
        }
        *truncated = true;
    }
    Ok(())
}

fn bound_search_response(
    matches: &mut Vec<Value>,
    inspected_files: usize,
    truncated: &mut bool,
) -> Result<()> {
    while serde_json::to_vec(&json!({
        "matches": matches,
        "inspected_files": inspected_files,
        "truncated": *truncated,
    }))
    .map_err(|error| KoniError::Process(format!("could not size Pi search result: {error}")))?
    .len()
        > MAX_READ_TOOL_RESPONSE_BYTES
    {
        if matches.pop().is_none() {
            return Err(KoniError::Process(
                "Pi search envelope exceeds its transport budget".to_owned(),
            ));
        }
        *truncated = true;
    }
    Ok(())
}

impl AgentToolBroker for ReadOnlyProjectToolBroker {
    fn execute(
        &self,
        context: &AgentToolContext,
        call: &AgentToolCall,
    ) -> Result<AgentToolOutcome> {
        if context != &self.expected_context {
            return Err(KoniError::Process(
                "read-only tool call crossed its Pi session identity".to_owned(),
            ));
        }
        Ok(match self.execute_inner(call) {
            Ok(value) => AgentToolOutcome::Success { value },
            Err(_) => AgentToolOutcome::Error {
                code: "read_denied".to_owned(),
                message: "The bounded project read could not be completed.".to_owned(),
                retryable: false,
            },
        })
    }
}

const PLANNING_SYNTHESIS_INSTRUCTION: &str = "Repository investigation is complete. Tools are now closed. Using the evidence already in this live thread, return the required structured planning response now. Keep the plan under 24,000 characters and the complete visible JSON under 96 KiB; the larger runtime allowance exists only to leave room for hidden reasoning. State each decision, path, risk, and proof once; do not repeat the goal, supplied source material, question banks, repository excerpts, or schema. Do not request or attempt further investigation.";

/// A compiler-owned exploration boundary for planning turns. The final
/// allowed read is preserved in a terminal tool result, ending only that Pi
/// turn. The launcher then synthesizes in the same in-memory session. Any
/// later read is denied without gaining more repository context.
struct PlanningReadToolBroker {
    inner: ReadOnlyProjectToolBroker,
    limit: u32,
    calls: AtomicU32,
    synthesis_requested: AtomicBool,
}

impl PlanningReadToolBroker {
    fn new(inner: ReadOnlyProjectToolBroker, limit: u32) -> Result<Self> {
        if limit == 0 {
            return Err(KoniError::Process(
                "planning repository-read budget must be positive".to_owned(),
            ));
        }
        Ok(Self {
            inner,
            limit,
            calls: AtomicU32::new(0),
            synthesis_requested: AtomicBool::new(false),
        })
    }

    fn synthesis_requested(&self) -> bool {
        self.synthesis_requested.load(Ordering::Acquire)
    }
}

impl AgentToolBroker for PlanningReadToolBroker {
    fn execute(
        &self,
        context: &AgentToolContext,
        call: &AgentToolCall,
    ) -> Result<AgentToolOutcome> {
        if context != &self.inner.expected_context {
            return Err(KoniError::Process(
                "planning read tool call crossed its Pi session identity".to_owned(),
            ));
        }
        if self.synthesis_requested.load(Ordering::Acquire) {
            return Ok(AgentToolOutcome::Error {
                code: "planning_exploration_complete".to_owned(),
                message: "Repository investigation is complete; return the required planning artifact now."
                    .to_owned(),
                retryable: false,
            });
        }

        let call_number = self.calls.fetch_add(1, Ordering::AcqRel).saturating_add(1);
        if call_number > self.limit {
            self.synthesis_requested.store(true, Ordering::Release);
            return Ok(AgentToolOutcome::Error {
                code: "planning_exploration_complete".to_owned(),
                message: "Repository investigation is complete; return the required planning artifact now."
                    .to_owned(),
                retryable: false,
            });
        }

        let outcome = self.inner.execute(context, call)?;
        if call_number == self.limit {
            self.synthesis_requested.store(true, Ordering::Release);
            let final_repository_result = serde_json::to_value(&outcome).map_err(|error| {
                KoniError::Process(format!(
                    "could not preserve the final planning repository result: {error}"
                ))
            })?;
            return Ok(AgentToolOutcome::Terminate {
                value: json!({
                    "compiler_instruction": PLANNING_SYNTHESIS_INSTRUCTION,
                    "final_repository_result": final_repository_result,
                }),
            });
        }
        Ok(outcome)
    }
}

fn read_only_project_tool_definitions(policy: &AgentReadPolicy) -> Vec<RuntimeToolDefinition> {
    if matches!(policy, AgentReadPolicy::None) {
        return Vec::new();
    }
    vec![
        RuntimeToolDefinition {
            name: "read_project_file".to_owned(),
            description: "Read one UTF-8 regular product file beneath the pinned project root (maximum 96 KiB; use search for larger files).".to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": false
            }),
        },
        RuntimeToolDefinition {
            name: "list_project_files".to_owned(),
            description: "List at most 500 product files beneath an optional project-relative prefix.".to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {"prefix": {"type": "string"}},
                "additionalProperties": false
            }),
        },
        RuntimeToolDefinition {
            name: "search_project".to_owned(),
            description: "Regex-search bounded UTF-8 product files and return at most 100 matching lines.".to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "prefix": {"type": "string"}
                },
                "required": ["query"],
                "additionalProperties": false
            }),
        },
    ]
}

fn required_tool_string<'a>(arguments: &'a Value, field: &str) -> Result<&'a str> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 4096)
        .ok_or_else(|| KoniError::Process("read-only tool argument is invalid".to_owned()))
}

fn contained_read_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        || path_has_denied_component(relative)
    {
        return Err(KoniError::Process(
            "project read path is outside the allowed product tree".to_owned(),
        ));
    }
    let mut component_path = root.to_path_buf();
    for component in relative.components() {
        match component {
            std::path::Component::CurDir => continue,
            std::path::Component::Normal(component) => component_path.push(component),
            _ => {
                return Err(KoniError::Process(
                    "project read path contains an unsupported component".to_owned(),
                ));
            }
        }
        let metadata = fs::symlink_metadata(&component_path)
            .map_err(|_| KoniError::Process("project read target is unavailable".to_owned()))?;
        if metadata.file_type().is_symlink() {
            return Err(KoniError::Process(
                "project read paths may not cross symbolic links".to_owned(),
            ));
        }
    }
    let joined = root.join(relative);
    let canonical = joined
        .canonicalize()
        .map_err(|_| KoniError::Process("project read target is unavailable".to_owned()))?;
    let canonical_relative = canonical.strip_prefix(root).map_err(|_| {
        KoniError::Process("project read target escaped its pinned root".to_owned())
    })?;
    if path_has_denied_component(canonical_relative) {
        return Err(KoniError::Process(
            "project read target escaped its pinned root".to_owned(),
        ));
    }
    Ok(canonical)
}

fn path_has_denied_component(path: &Path) -> bool {
    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        matches!(
            value.as_ref(),
            ".git" | ".codex" | ".koni" | ".agents" | "target" | "node_modules"
        )
    })
}

#[cfg(unix)]
pub(crate) fn isolate_process_group(command: &mut Command) {
    command.process_group(0);
}

#[cfg(not(unix))]
pub(crate) fn isolate_process_group(_command: &mut Command) {}

/// Stop the complete isolated agent process group. Codex may launch helper
/// processes, so killing only the group leader can leave descendants running
/// after a timeout or failed durable-start callback.
#[cfg(unix)]
pub(crate) fn terminate_agent_process(
    child: &mut std::process::Child,
    process_group_id: u32,
) -> std::io::Result<()> {
    let raw_pid = i32::try_from(process_group_id)
        .map_err(|_| std::io::Error::other("agent process-group id exceeds platform range"))?;
    let group = rustix::process::Pid::from_raw(raw_pid)
        .ok_or_else(|| std::io::Error::other("agent process-group id must be positive"))?;
    match rustix::process::kill_process_group(group, rustix::process::Signal::KILL) {
        Ok(()) => Ok(()),
        Err(rustix::io::Errno::SRCH) => {
            // A still-running direct child cannot have left its compiler-
            // created group legitimately. Kill that exact Child handle as a
            // final bounded fallback; an already exited leader needs no work.
            if child.try_wait()?.is_none() {
                child.kill()
            } else {
                Ok(())
            }
        }
        Err(error) => Err(std::io::Error::from(error)),
    }
}

#[cfg(not(unix))]
pub(crate) fn terminate_agent_process(
    child: &mut std::process::Child,
    _process_group_id: u32,
) -> std::io::Result<()> {
    child.kill()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planning_read_budget_ends_exploration_then_closes_reads() {
        let temp = tempfile::TempDir::new().unwrap();
        fs::write(temp.path().join("evidence.txt"), "grounded evidence\n").unwrap();
        let context = AgentToolContext {
            session_id: "session-1".to_owned(),
            run_id: "run-1".to_owned(),
            agent_id: "planning-plan".to_owned(),
            attempt: 1,
            runtime_process: AgentProcessIdentity {
                pid: 42,
                process_group_id: 42,
                birth_marker: "test-process".to_owned(),
            },
        };
        let inner =
            ReadOnlyProjectToolBroker::new(temp.path(), context.clone(), AgentReadPolicy::Project)
                .unwrap();
        let broker = PlanningReadToolBroker::new(inner, 1).unwrap();
        let call = AgentToolCall {
            call_id: "call-1".to_owned(),
            name: "read_project_file".to_owned(),
            arguments: json!({"path": "evidence.txt"}),
        };

        assert!(matches!(
            broker.execute(&context, &call).unwrap(),
            AgentToolOutcome::Terminate { ref value }
                if value["compiler_instruction"] == PLANNING_SYNTHESIS_INSTRUCTION
                    && value["final_repository_result"]["status"] == "success"
        ));
        assert!(broker.synthesis_requested());

        let denied = broker
            .execute(
                &context,
                &AgentToolCall {
                    call_id: "call-2".to_owned(),
                    ..call
                },
            )
            .unwrap();
        assert!(matches!(
            denied,
            AgentToolOutcome::Error { ref code, retryable: false, .. }
                if code == "planning_exploration_complete"
        ));
    }

    #[test]
    fn direct_pi_budget_charges_cache_reads_once() {
        let usage = crate::agent_runtime::RuntimeUsage {
            input_tokens: 120,
            cached_input_tokens: 80,
            output_tokens: 30,
            reasoning_tokens: 10,
            total_tokens: 230,
        };
        assert_eq!(
            direct_pi_charged_tokens(DirectPiTokenMetric::NewTokens, &usage),
            150
        );
        assert_eq!(
            direct_pi_charged_tokens(DirectPiTokenMetric::ProcessedTokens, &usage),
            230
        );
    }

    #[test]
    fn pi_terminal_event_is_a_durable_usage_checkpoint_not_completion() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("stdout.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        write_pi_compat_event(
            &mut file,
            &RuntimeEvent::TurnCompleted {
                turn_id: "turn-1".to_owned(),
                stop_reason: "error".to_owned(),
                usage: crate::agent_runtime::RuntimeUsage {
                    total_tokens: 42,
                    ..Default::default()
                },
            },
        )
        .unwrap();
        drop(file);
        let event: Value = serde_json::from_str(fs::read_to_string(path).unwrap().trim()).unwrap();
        assert_eq!(event["type"], "pi.turn_usage");
        assert_eq!(event["usage"]["total_tokens"], 42);
    }

    #[test]
    fn pi_local_transcript_keeps_complete_messages_without_streaming_deltas() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("stdout.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        write_pi_compat_event(
            &mut file,
            &RuntimeEvent::MessageCompleted {
                turn_id: "turn-1".to_owned(),
                message_id: "message-1".to_owned(),
                role: "assistant".to_owned(),
                content: json!([
                    {"type":"text","text":"Mapped the shared contract."},
                    {"type":"toolCall","id":"call-1","name":"read_project_file","arguments":{"path":"src/contracts.ts"}}
                ]),
            },
        )
        .unwrap();
        write_pi_compat_event(
            &mut file,
            &RuntimeEvent::MessageDelta {
                turn_id: "turn-1".to_owned(),
                message_id: "message-1".to_owned(),
                text: "fragment that must stay inside the host".to_owned(),
            },
        )
        .unwrap();
        write_pi_compat_event(
            &mut file,
            &RuntimeEvent::ToolCompleted {
                turn_id: "turn-1".to_owned(),
                call_id: "call-1".to_owned(),
                outcome: AgentToolOutcome::Success {
                    value: json!({"content":"export const sections = []"}),
                },
            },
        )
        .unwrap();
        drop(file);

        let events = fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(events.len(), 2, "raw message deltas remain non-durable");
        assert_eq!(
            events[0]["event"]["content"][0]["text"],
            "Mapped the shared contract."
        );
        assert_eq!(
            events[0]["event"]["content_hash"],
            normalized_hash(&events[0]["event"]["content"])
        );
        assert_eq!(
            events[1]["event"]["outcome"]["value"]["content"],
            "export const sections = []"
        );
    }

    #[test]
    fn validated_pi_failure_exposes_its_canonical_action_to_chat() {
        let temp = tempfile::TempDir::new().unwrap();
        let path = temp.path().join("stdout.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        let message = "OpenAI Codex is temporarily unavailable. Retry this turn.".to_owned();
        write_pi_compat_event(
            &mut file,
            &RuntimeEvent::RuntimeError {
                turn_id: Some("turn-1".to_owned()),
                code: "provider_unavailable".to_owned(),
                message: message.clone(),
                retryable: true,
            },
        )
        .unwrap();
        drop(file);
        let event: Value = serde_json::from_str(fs::read_to_string(path).unwrap().trim()).unwrap();
        assert_eq!(event["type"], "turn.failed");
        assert_eq!(event["message"], message);
        assert_eq!(event["event"]["message"], message);
        assert_eq!(event["event"]["retryable"], true);
    }

    #[test]
    fn read_tool_collections_are_trimmed_below_the_public_frame_budget() {
        let mut files = (0..500)
            .map(|index| format!("{index:04}-{}", "\\\"".repeat(3_000)))
            .collect::<Vec<_>>();
        let mut truncated = false;
        bound_file_list_response(&mut files, &mut truncated).unwrap();
        let encoded = serde_json::to_vec(&json!({
            "files": files,
            "truncated": truncated,
        }))
        .unwrap();
        assert!(truncated);
        assert!(encoded.len() <= MAX_READ_TOOL_RESPONSE_BYTES);
    }

    #[test]
    fn direct_pi_launcher_rejects_untyped_requests_before_artifact_discovery() {
        let temp = tempfile::TempDir::new().unwrap();
        let request = AgentProcessRequest {
            executable: String::new(),
            args: Vec::new(),
            working_directory: temp.path().to_path_buf(),
            stdout_path: temp.path().join("stdout.jsonl"),
            stderr_path: temp.path().join("stderr.log"),
            timeout: Duration::from_secs(1),
            environment_set: Vec::new(),
            environment_remove: Vec::new(),
            direct_pi: None,
        };
        let error = PiAgentProcessLauncher::new()
            .run(&request, &mut |_| Ok(()))
            .unwrap_err();
        assert!(error.to_string().contains("typed compiler request"));
    }

    #[test]
    fn read_only_scratch_is_private_contained_ephemeral_and_exactly_scoped() {
        let product = tempfile::TempDir::new().unwrap();
        let scratch = ReadOnlyCodexScratch::create(&[product.path()]).unwrap();
        let scratch_path = scratch.path().to_path_buf();
        assert!(scratch_path.is_dir());
        assert!(!scratch_path.starts_with(fs::canonicalize(product.path()).unwrap()));
        assert_eq!(
            scratch.environment(),
            vec![("TMPDIR".to_owned(), scratch_path.display().to_string())]
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&scratch_path).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let assignments = scratch.codex_config_assignments();
        let filesystem = assignments
            .iter()
            .find_map(|assignment| {
                assignment.strip_prefix(&format!(
                    "permissions.{}.filesystem=",
                    scratch.profile_name()
                ))
            })
            .expect("scratch filesystem profile assignment");
        let parsed: toml::Value = toml::from_str(&format!("value = {filesystem}"))
            .expect("filesystem assignment is valid TOML");
        let filesystem = parsed["value"].as_table().unwrap();
        assert_eq!(filesystem.len(), 2, "only one write exception is declared");
        assert_eq!(filesystem[":root"].as_str(), Some("read"));
        assert_eq!(
            filesystem[scratch_path.display().to_string().as_str()].as_str(),
            Some("write")
        );
        assert!(assignments.iter().any(|assignment| assignment
            == &format!(
                "permissions.{}.network.enabled=false",
                scratch.profile_name()
            )));
        assert!(assignments.iter().any(|assignment| assignment
            == &format!(
                "default_permissions={}",
                toml::Value::String(scratch.profile_name().to_owned())
            )));

        drop(scratch);
        assert!(!scratch_path.exists(), "ordinary exit removes scratch");
    }

    #[cfg(unix)]
    #[test]
    fn scratch_validation_rejects_symlinks_nested_paths_and_forbidden_roots() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::TempDir::new().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        let linked = root.join("linked");
        symlink(outside.path(), &linked).unwrap();
        assert!(validate_created_scratch(&linked, &root, &[]).is_err());

        let nested_parent = root.join("nested");
        let nested = nested_parent.join("scratch");
        fs::create_dir(&nested_parent).unwrap();
        fs::create_dir(&nested).unwrap();
        fs::set_permissions(&nested, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(validate_created_scratch(&nested, &root, &[]).is_err());

        let forbidden = root.join("forbidden");
        fs::create_dir(&forbidden).unwrap();
        fs::set_permissions(&forbidden, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            validate_created_scratch(&forbidden, &root, std::slice::from_ref(&forbidden)).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn launcher_temp_write_succeeds_project_write_fails_and_env_removal_wins() {
        let base = tempfile::TempDir::new().unwrap();
        let project = base.path().join("project");
        fs::create_dir(&project).unwrap();
        fs::set_permissions(&project, fs::Permissions::from_mode(0o555)).unwrap();
        let scratch = ReadOnlyCodexScratch::create(&[base.path()]).unwrap();
        let mut environment_set = scratch.environment();
        environment_set.push((
            "PROJECT_UNDER_TEST".to_owned(),
            project.display().to_string(),
        ));
        // Removal must dominate even a mistakenly injected bearer value.
        environment_set.push((
            "KONI_LEAD_SLICE_TOKEN".to_owned(),
            "must-not-cross".to_owned(),
        ));
        let request = AgentProcessRequest {
            executable: String::new(),
            args: vec![
                "-c".to_owned(),
                concat!(
                    "set -eu; ",
                    "touch \"$TMPDIR/tool-cache\"; ",
                    "if touch \"$PROJECT_UNDER_TEST/forbidden\" 2>/dev/null; then exit 42; fi; ",
                    "test -z \"${KONI_LEAD_SLICE_TOKEN+x}\""
                )
                .to_owned(),
            ],
            working_directory: base.path().to_path_buf(),
            stdout_path: base.path().join("stdout.log"),
            stderr_path: base.path().join("stderr.log"),
            timeout: Duration::from_secs(5),
            environment_set,
            environment_remove: vec!["KONI_LEAD_SLICE_TOKEN".to_owned()],
            direct_pi: None,
        };
        let result = CodexAgentProcessLauncher::new("sh")
            .run(&request, &mut |_| Ok(()))
            .unwrap();
        fs::set_permissions(&project, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(result.exit_code, Some(0));
        assert!(scratch.path().join("tool-cache").is_file());
        assert!(!project.join("forbidden").exists());
    }

    /// Process-level coverage for the exact Codex permission-profile boundary
    /// used in production. This command does not contact a model or require
    /// authentication; it asks the installed Codex sandbox helper to execute
    /// one injected shell command.
    #[cfg(target_os = "macos")]
    #[test]
    fn codex_permission_profile_writes_scratch_but_denies_project() {
        if !Command::new("codex")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
        {
            return;
        }

        let base = tempfile::TempDir::new().unwrap();
        let project = base.path().join("project");
        let codex_home = base.path().join("codex-home");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&codex_home).unwrap();
        let initialized = Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&project)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("Git is available beside Codex");
        assert!(initialized.success());
        let scratch = ReadOnlyCodexScratch::create(&[base.path()]).unwrap();
        let mut args = vec![
            "sandbox".to_owned(),
            "--permission-profile".to_owned(),
            scratch.profile_name().to_owned(),
            "--cd".to_owned(),
            project.display().to_string(),
        ];
        for assignment in scratch.codex_config_assignments() {
            args.extend(["--config".to_owned(), assignment]);
        }
        args.extend([
            "--".to_owned(),
            "sh".to_owned(),
            "-c".to_owned(),
            concat!(
                "set -eu; ",
                "git --no-optional-locks status --short >/dev/null; ",
                "touch \"$TMPDIR/xcrun-compatible-cache\"; ",
                "if touch \"$PWD/project-write\" 2>/dev/null; then exit 43; fi"
            )
            .to_owned(),
        ]);
        let mut environment_set = scratch.environment();
        environment_set.push(("CODEX_HOME".to_owned(), codex_home.display().to_string()));
        environment_set.push((
            "KONI_LEAD_SLICE_GENERATION".to_owned(),
            "must-not-cross".to_owned(),
        ));
        let request = AgentProcessRequest {
            executable: String::new(),
            args,
            working_directory: project.clone(),
            stdout_path: base.path().join("codex-sandbox.stdout"),
            stderr_path: base.path().join("codex-sandbox.stderr"),
            timeout: Duration::from_secs(10),
            environment_set,
            environment_remove: vec!["KONI_LEAD_SLICE_GENERATION".to_owned()],
            direct_pi: None,
        };
        let result = CodexAgentProcessLauncher::new("codex")
            .run(&request, &mut |_| Ok(()))
            .unwrap();
        assert_eq!(
            result.exit_code,
            Some(0),
            "{}",
            fs::read_to_string(&request.stderr_path).unwrap_or_default()
        );
        assert!(scratch.path().join("xcrun-compatible-cache").is_file());
        assert!(!project.join("project-write").exists());
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_the_complete_agent_process_group() {
        let temp = tempfile::TempDir::new().unwrap();
        let descendant_pid_path = temp.path().join("descendant.pid");
        let launcher = CodexAgentProcessLauncher::new("sh");
        let request = AgentProcessRequest {
            executable: String::new(),
            args: vec![
                "-c".to_owned(),
                format!(
                    "sleep 30 & echo $! > '{}'; wait",
                    descendant_pid_path.display()
                ),
            ],
            working_directory: temp.path().to_path_buf(),
            stdout_path: temp.path().join("stdout.log"),
            stderr_path: temp.path().join("stderr.log"),
            timeout: Duration::from_millis(100),
            environment_set: Vec::new(),
            environment_remove: Vec::new(),
            direct_pi: None,
        };

        let result = launcher.run(&request, &mut |_| Ok(())).unwrap();
        assert!(result.timed_out);
        let descendant_pid = fs::read_to_string(&descendant_pid_path)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let output = Command::new("ps")
                .args(["-o", "stat=", "-p", &descendant_pid.to_string()])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            if !output.status.success()
                || state.trim().is_empty()
                || state.trim_start().starts_with('Z')
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "descendant process {descendant_pid} survived agent timeout in state {state:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    #[test]
    fn owned_identity_rejects_a_changed_birth_marker() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5"]);
        isolate_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let identity = capture_owned_agent_process_identity(child.id()).unwrap();
        assert!(owned_agent_process_is_alive(&identity));

        let mut recycled = identity.clone();
        recycled.birth_marker.push_str(" recycled");
        assert!(!owned_agent_process_is_alive(&recycled));

        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn process_identities_issue_only_strong_kernel_markers() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5"]);
        isolate_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let pid = child.id();

        let owned = capture_owned_agent_process_identity(pid).unwrap();
        let birth = capture_process_birth_identity(pid).unwrap();
        assert!(
            owned
                .birth_marker
                .starts_with(KERNEL_PROCESS_BIRTH_MARKER_PREFIX)
        );
        assert!(
            birth
                .birth_marker
                .starts_with(KERNEL_PROCESS_BIRTH_MARKER_PREFIX)
        );
        assert!(agent_process_identity_has_strong_birth_marker(&owned));
        assert!(strong_process_birth_marker(&birth.birth_marker));
        assert!(owned_agent_process_is_alive(&owned));
        assert!(process_birth_identity_is_alive(&birth));

        let mut legacy_owned = owned.clone();
        legacy_owned.birth_marker =
            format!("{LEGACY_PROCESS_BIRTH_MARKER_PREFIX}Thu Jul 16 12:30:00 2026");
        let legacy_birth = ProcessBirthIdentity {
            pid,
            birth_marker: "Thu Jul 16 05:30:00 2026".to_owned(),
        };
        assert!(!agent_process_identity_has_strong_birth_marker(
            &legacy_owned
        ));
        assert!(!owned_agent_process_is_alive(&legacy_owned));
        assert!(!process_birth_identity_is_alive(&legacy_birth));

        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn kernel_identity_matching_rejects_same_second_reuse_pgid_change_and_disappearance() {
        let original = macos_kernel_process_observation(42, 42, 42, 2, 1_752_688_200, 100).unwrap();
        let identity = AgentProcessIdentity {
            pid: original.pid,
            process_group_id: original.process_group_id,
            birth_marker: original.birth_marker.clone(),
        };
        assert!(owned_agent_process_identity_matches_observation(
            &identity,
            Some(&original)
        ));

        let same_second_reuse =
            macos_kernel_process_observation(42, 42, 42, 2, 1_752_688_200, 101).unwrap();
        assert!(!owned_agent_process_identity_matches_observation(
            &identity,
            Some(&same_second_reuse)
        ));
        let changed_group =
            macos_kernel_process_observation(42, 42, 41, 2, 1_752_688_200, 100).unwrap();
        assert!(!owned_agent_process_identity_matches_observation(
            &identity,
            Some(&changed_group)
        ));
        assert!(!owned_agent_process_identity_matches_observation(
            &identity, None
        ));

        let birth = ProcessBirthIdentity {
            pid: original.pid,
            birth_marker: original.birth_marker.clone(),
        };
        assert!(process_birth_identity_matches_observation(
            &birth,
            Some(&original)
        ));
        assert!(!process_birth_identity_matches_observation(
            &birth,
            Some(&same_second_reuse)
        ));
    }

    #[test]
    fn linux_proc_stat_parser_binds_boot_start_ticks_group_and_zombie_state() {
        const BOOT_ID: &str = "d76083f7-476f-4f8f-b28d-db1dc746a6e2";
        let stat = "42 (worker name) S 1 42 42 0 -1 4194304 10 0 0 0 1 2 0 0 20 0 1 0 987654 4096";
        let observation = linux_kernel_process_observation(42, stat, BOOT_ID).unwrap();
        assert_eq!(observation.pid, 42);
        assert_eq!(observation.process_group_id, 42);
        assert_eq!(
            observation.birth_marker,
            format!("{KERNEL_PROCESS_BIRTH_MARKER_PREFIX}linux:{BOOT_ID}:987654")
        );

        let embedded_parenthesis = stat.replace("worker name", "worker ) name");
        assert!(linux_kernel_process_observation(42, &embedded_parenthesis, BOOT_ID).is_some());
        let zombie = stat.replacen(") S ", ") Z ", 1);
        assert!(linux_kernel_process_observation(42, &zombie, BOOT_ID).is_none());
        assert!(linux_kernel_process_observation(41, stat, BOOT_ID).is_none());
        assert!(linux_kernel_process_observation(42, stat, "not-a-boot-id").is_none());
    }

    #[test]
    fn macos_process_info_parser_requires_exact_pid_live_status_and_microseconds() {
        let observation =
            macos_kernel_process_observation(7, 7, 7, 2, 1_752_688_200, 999_999).unwrap();
        assert_eq!(
            observation.birth_marker,
            format!(
                "{KERNEL_PROCESS_BIRTH_MARKER_PREFIX}macos:{}:{}",
                1_752_688_200, 999_999
            )
        );
        assert!(macos_kernel_process_observation(7, 8, 7, 2, 1, 0).is_none());
        assert!(macos_kernel_process_observation(7, 7, 0, 2, 1, 0).is_none());
        assert!(
            macos_kernel_process_observation(7, 7, 7, MACOS_ZOMBIE_PROCESS_STATUS, 1, 0).is_none()
        );
        assert!(macos_kernel_process_observation(7, 7, 7, 2, 0, 0).is_none());
        assert!(macos_kernel_process_observation(7, 7, 7, 2, 1, 1_000_000).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn zombie_is_not_an_owned_live_process() {
        let mut command = Command::new("sh");
        command.args(["-c", "exit 0"]);
        isolate_process_group(&mut command);
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while capture_owned_agent_process_identity(child.id()).is_some() {
            assert!(Instant::now() < deadline, "child never became a zombie");
            thread::sleep(Duration::from_millis(10));
        }
        child.wait().unwrap();
    }
}
