//! Bounded process supervision for compiler-owned Codex sessions.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{KoniError, Result, io_error};

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
/// process birth marker reported by `ps`. Later ownership checks require every
/// field to match the live process.
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

/// Capture a live non-zombie process by PID and kernel-reported start time.
pub fn capture_process_birth_identity(pid: u32) -> Option<ProcessBirthIdentity> {
    let output = Command::new("/bin/ps")
        .args([
            "-o",
            "pid=",
            "-o",
            "lstart=",
            "-o",
            "stat=",
            "-p",
            &pid.to_string(),
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let fields = stdout.split_whitespace().collect::<Vec<_>>();
    // pid, five lstart fields, then stat
    if fields.len() < 7 || fields.last().is_some_and(|state| state.starts_with('Z')) {
        return None;
    }
    let observed_pid = fields[0].parse::<u32>().ok()?;
    if observed_pid != pid {
        return None;
    }
    let birth_marker = fields[1..fields.len() - 1].join(" ");
    (!birth_marker.is_empty()).then_some(ProcessBirthIdentity { pid, birth_marker })
}

pub fn process_birth_identity_is_alive(identity: &ProcessBirthIdentity) -> bool {
    capture_process_birth_identity(identity.pid).as_ref() == Some(identity)
}

/// Resolve the executable image currently running as `pid`. Unsupported
/// platforms fail closed instead of substituting an argv label or PATH lookup.
pub fn process_executable_path(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        return fs::read_link(format!("/proc/{pid}/exe"))
            .ok()?
            .canonicalize()
            .ok();
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
/// from a bare PID.
pub fn capture_owned_agent_process_identity(pid: u32) -> Option<AgentProcessIdentity> {
    let output = Command::new("/bin/ps")
        .args([
            "-o",
            "pid=",
            "-o",
            "pgid=",
            "-o",
            "lstart=",
            "-o",
            "stat=",
            "-p",
            &pid.to_string(),
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let fields = stdout.split_whitespace().collect::<Vec<_>>();
    // pid, pgid, five lstart fields, then stat
    if fields.len() < 8 || fields.last().is_some_and(|state| state.starts_with('Z')) {
        return None;
    }
    let observed_pid = fields[0].parse::<u32>().ok()?;
    let process_group_id = fields[1].parse::<u32>().ok()?;
    if observed_pid != pid || process_group_id != pid {
        return None;
    }
    let birth_marker = fields[2..fields.len() - 1].join(" ");
    if birth_marker.is_empty() {
        return None;
    }
    Some(AgentProcessIdentity {
        pid,
        process_group_id,
        birth_marker,
    })
}

pub fn owned_agent_process_is_alive(identity: &AgentProcessIdentity) -> bool {
    capture_owned_agent_process_identity(identity.pid).as_ref() == Some(identity)
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

#[cfg(unix)]
fn isolate_process_group(command: &mut Command) {
    command.process_group(0);
}

#[cfg(not(unix))]
fn isolate_process_group(_command: &mut Command) {}

/// Stop the complete isolated agent process group. Codex may launch helper
/// processes, so killing only the group leader can leave descendants running
/// after a timeout or failed durable-start callback.
#[cfg(unix)]
fn terminate_agent_process(
    child: &mut std::process::Child,
    process_group_id: u32,
) -> std::io::Result<()> {
    let group = format!("-{process_group_id}");
    let killed_group = Command::new("kill")
        .args(["-KILL", "--", &group])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if killed_group { Ok(()) } else { child.kill() }
}

#[cfg(not(unix))]
fn terminate_agent_process(
    child: &mut std::process::Child,
    _process_group_id: u32,
) -> std::io::Result<()> {
    child.kill()
}

#[cfg(test)]
mod tests {
    use super::*;

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
