use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::fd::AsFd;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{KoniError, Result, io_error};
use crate::graph::normalized_hash;

const MAX_CHECK_STREAM_CAPTURE_BYTES: usize = 1024 * 1024;
const MAX_CHECK_ATTEMPT_CAPTURE_BYTES: usize = 1536 * 1024;
const MAX_CHECK_RUN_CAPTURE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CHECK_RESULT_DOCUMENT_BYTES: usize = 1024 * 1024;
const MAX_CHECK_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_CHECK_EVIDENCE_FILES: usize = 64;
pub(crate) const MAX_CHECK_ATTEMPTS: u32 = 3;
pub(crate) const MAX_CHECK_TOTAL_EXECUTION_SECONDS: u64 = 24 * 60 * 60;
const MAX_CHECK_POSTPROCESSING: Duration = Duration::from_secs(30);
const CHECK_POLL_INTERVAL: Duration = Duration::from_millis(10);
const CHECK_NATURAL_DESCENDANT_GRACE: Duration = Duration::from_millis(250);
const CHECK_TERM_GRACE: Duration = Duration::from_millis(500);
const CHECK_KILL_GRACE: Duration = Duration::from_secs(2);
const CHECK_PIPE_DRAIN_GRACE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandSpec {
    pub id: String,
    pub argv: Vec<String>,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    #[serde(default)]
    pub environment: EnvironmentPolicy,
    #[serde(default)]
    pub expected_exit_codes: BTreeSet<i32>,
    #[serde(default)]
    pub transient_exit_codes: BTreeSet<i32>,
    #[serde(default)]
    pub max_attempts: u32,
    #[serde(default)]
    pub result_protocol: Option<ResultProtocol>,
    #[serde(default)]
    pub artifact_paths: Vec<String>,
}

fn default_cwd() -> String {
    ".".to_owned()
}

fn default_timeout() -> u64 {
    600
}

fn validate_command_spec_limits(spec: &CommandSpec) -> Result<(u32, Duration)> {
    if spec.artifact_paths.len() > MAX_CHECK_EVIDENCE_FILES {
        return Err(KoniError::Process(format!(
            "check {} configures {} artifact paths; the maximum is {MAX_CHECK_EVIDENCE_FILES}",
            spec.id,
            spec.artifact_paths.len()
        )));
    }
    let max_attempts = spec.max_attempts.max(1);
    if max_attempts > MAX_CHECK_ATTEMPTS {
        return Err(KoniError::Process(format!(
            "check {} requests {max_attempts} attempts; the maximum is {MAX_CHECK_ATTEMPTS}",
            spec.id
        )));
    }
    let timeout_seconds = spec.timeout_seconds.max(1);
    let aggregate_seconds = timeout_seconds
        .checked_mul(u64::from(max_attempts))
        .ok_or_else(|| {
            KoniError::Process(format!("check {} aggregate timeout overflowed", spec.id))
        })?;
    if aggregate_seconds > MAX_CHECK_TOTAL_EXECUTION_SECONDS {
        return Err(KoniError::Process(format!(
            "check {} requests {aggregate_seconds} aggregate execution seconds; the maximum is {MAX_CHECK_TOTAL_EXECUTION_SECONDS}",
            spec.id
        )));
    }
    Ok((max_attempts, Duration::from_secs(timeout_seconds)))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EnvironmentPolicy {
    #[serde(default = "default_true")]
    pub inherit: bool,
    #[serde(default)]
    pub allow: BTreeSet<String>,
    #[serde(default)]
    pub deny: BTreeSet<String>,
    #[serde(default)]
    pub set: BTreeMap<String, String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultProtocol {
    pub protocol: String,
    #[serde(default = "default_protocol_field")]
    pub protocol_field: String,
    #[serde(default)]
    pub schema: Option<Value>,
    #[serde(default)]
    pub required_fields: Vec<String>,
    #[serde(default)]
    pub line_prefix: Option<String>,
    /// Optional project-relative result document. When configured, this file
    /// is the sole typed-result source; stdout is never used as a fallback.
    #[serde(default)]
    pub result_path: Option<String>,
}

fn default_protocol_field() -> String {
    "protocol".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandReceipt {
    pub schema_version: String,
    pub id: String,
    pub check_id: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
    pub duration_ms: u128,
    pub cwd: PathBuf,
    pub argv: Vec<String>,
    pub environment_keys: Vec<String>,
    pub attempts: Vec<AttemptReceipt>,
    pub status: CommandStatus,
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_source: Option<ResultSourceReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_error: Option<String>,
    pub artifacts: Vec<ArtifactReceipt>,
    pub input_hash: String,
    pub receipt_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptReceipt {
    pub attempt: u32,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub interrupted: bool,
    pub stdout: String,
    pub stderr: String,
    pub stdout_hash: String,
    pub stderr_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_observed_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_observed_hash: Option<String>,
    #[serde(default)]
    pub stdout_observed_bytes: u64,
    #[serde(default)]
    pub stdout_retained_bytes: u64,
    #[serde(default)]
    pub stdout_truncated: bool,
    #[serde(default)]
    pub stderr_observed_bytes: u64,
    #[serde(default)]
    pub stderr_retained_bytes: u64,
    #[serde(default)]
    pub stderr_truncated: bool,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandStatus {
    Passed,
    Failed,
    TimedOut,
    Interrupted,
    InvalidResult,
    InvalidContract,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactReceipt {
    pub path: String,
    pub exists: bool,
    pub size_bytes: Option<u64>,
    pub hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResultSourceReceipt {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct CommandRunner {
    root: PathBuf,
}

impl CommandRunner {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn run(
        &self,
        spec: &CommandSpec,
        variables: &BTreeMap<String, String>,
        stop_file: Option<&Path>,
    ) -> Result<CommandReceipt> {
        let started_at = Utc::now();
        let started = Instant::now();
        let (max_attempts, configured_attempt_timeout) = validate_command_spec_limits(spec)?;
        let execution_deadline = started
            .checked_add(Duration::from_secs(MAX_CHECK_TOTAL_EXECUTION_SECONDS))
            .ok_or_else(|| KoniError::Process("check execution deadline overflowed".to_owned()))?;
        let argv: Vec<_> = spec
            .argv
            .iter()
            .map(|argument| interpolate(argument, variables))
            .collect::<Result<_>>()?;
        if argv.is_empty() || argv[0].trim().is_empty() {
            return Err(KoniError::Process(format!(
                "check {} has an empty argv",
                spec.id
            )));
        }
        let cwd_text = interpolate(&spec.cwd, variables)?;
        let cwd = contained_path(&self.root, &cwd_text)?;
        if !cwd.is_dir() {
            return Err(KoniError::Process(format!(
                "check {} cwd does not exist: {}",
                spec.id,
                cwd.display()
            )));
        }
        let environment = resolved_environment(&spec.environment, variables)?;
        let expected = if spec.expected_exit_codes.is_empty() {
            BTreeSet::from([0])
        } else {
            spec.expected_exit_codes.clone()
        };
        let mut attempts = Vec::new();
        let mut parsed_result = None;
        let mut result_source = None;
        let mut result_error = None;
        let mut final_status = CommandStatus::Failed;
        let mut remaining_capture_bytes = MAX_CHECK_RUN_CAPTURE_BYTES;

        for attempt in 1..=max_attempts {
            if stop_file.is_some_and(Path::exists) {
                final_status = CommandStatus::Interrupted;
                break;
            }
            let remaining_execution = execution_deadline
                .checked_duration_since(Instant::now())
                .unwrap_or(Duration::ZERO);
            if remaining_execution.is_zero() {
                final_status = CommandStatus::TimedOut;
                result_error = Some(
                    "check exhausted its aggregate execution wall budget before the next attempt"
                        .to_owned(),
                );
                break;
            }
            let receipt = run_attempt(
                &argv,
                &cwd,
                &environment,
                configured_attempt_timeout.min(remaining_execution),
                stop_file,
                attempt,
                remaining_capture_bytes,
            )?;
            let retained = receipt
                .stdout_retained_bytes
                .saturating_add(receipt.stderr_retained_bytes);
            remaining_capture_bytes = remaining_capture_bytes
                .saturating_sub(usize::try_from(retained).unwrap_or(usize::MAX));
            let exit_code = receipt.exit_code;
            let retry = exit_code.is_some_and(|code| spec.transient_exit_codes.contains(&code))
                && attempt < max_attempts;
            if receipt.interrupted {
                final_status = CommandStatus::Interrupted;
            } else if receipt.timed_out {
                final_status = CommandStatus::TimedOut;
            } else if let Some(failure) = exit_code
                .filter(|code| *code != 0 && expected.contains(code))
                .and_then(|_| command_infrastructure_failure(&receipt.stdout, &receipt.stderr))
            {
                result_error = Some(failure);
                final_status = CommandStatus::InvalidResult;
            } else if exit_code.is_some_and(|code| code != 0 && expected.contains(&code))
                && (receipt.stdout_truncated || receipt.stderr_truncated)
            {
                result_error = Some(
                    "an expected nonzero command emitted truncated output, so Koni cannot classify it as admissible evidence"
                        .to_owned(),
                );
                final_status = CommandStatus::InvalidResult;
            } else if exit_code.is_some_and(|code| expected.contains(&code)) {
                if let Some(protocol) = &spec.result_protocol {
                    match self.result_document(&receipt, protocol, variables) {
                        Ok((document, source)) => {
                            result_source = Some(source);
                            match parse_protocol_result(&document, protocol) {
                                Ok(value) => {
                                    parsed_result = Some(value);
                                    final_status = CommandStatus::Passed;
                                }
                                Err(error) => {
                                    result_error = Some(error.to_string());
                                    final_status = CommandStatus::InvalidResult;
                                }
                            }
                        }
                        Err(error) => {
                            result_error = Some(error.to_string());
                            final_status = CommandStatus::InvalidResult;
                        }
                    }
                } else {
                    final_status = CommandStatus::Passed;
                }
            } else {
                final_status = CommandStatus::Failed;
            }
            attempts.push(receipt);
            if !retry {
                break;
            }
        }

        let mut artifact_paths = BTreeSet::new();
        let mut artifacts = Vec::new();
        for path in &spec.artifact_paths {
            let path = interpolate(path, variables)?;
            let normalized = normalized_relative_path(&path)?;
            if !artifact_paths.insert(normalized.clone()) {
                final_status = CommandStatus::InvalidResult;
                result_error.get_or_insert_with(|| {
                    format!("configured artifact path resolves more than once: {normalized}")
                });
                continue;
            }
            let artifact = artifact_receipt(&self.root, &normalized)?;
            if !artifact.exists || artifact.error.is_some() {
                final_status = CommandStatus::InvalidResult;
                result_error.get_or_insert_with(|| {
                    artifact
                        .error
                        .clone()
                        .unwrap_or_else(|| format!("artifact is missing: {normalized}"))
                });
            }
            artifacts.push(artifact);
        }
        let input_hash = normalized_hash(&(spec, variables));
        let mut receipt = CommandReceipt {
            schema_version: "1.0".to_owned(),
            id: Uuid::now_v7().to_string(),
            check_id: spec.id.clone(),
            started_at,
            finished_at: Utc::now(),
            duration_ms: started.elapsed().as_millis(),
            cwd,
            argv,
            environment_keys: environment.keys().cloned().collect(),
            attempts,
            status: final_status,
            result: parsed_result,
            result_source,
            result_error,
            artifacts,
            input_hash,
            receipt_hash: String::new(),
        };
        receipt.receipt_hash = normalized_hash(&receipt);
        Ok(receipt)
    }

    fn result_document(
        &self,
        attempt: &AttemptReceipt,
        protocol: &ResultProtocol,
        variables: &BTreeMap<String, String>,
    ) -> Result<(String, ResultSourceReceipt)> {
        let deadline = Instant::now()
            .checked_add(MAX_CHECK_POSTPROCESSING)
            .ok_or_else(|| KoniError::Process("result-document deadline overflowed".to_owned()))?;
        self.result_document_with_deadline(attempt, protocol, variables, deadline)
    }

    fn result_document_with_deadline(
        &self,
        attempt: &AttemptReceipt,
        protocol: &ResultProtocol,
        variables: &BTreeMap<String, String>,
        deadline: Instant,
    ) -> Result<(String, ResultSourceReceipt)> {
        if let Some(configured) = &protocol.result_path {
            let configured = interpolate(configured, variables)?;
            let path = normalized_relative_path(&configured)?;
            let opened = securely_open_project_regular_file(&self.root, &path, deadline, || {})
                .map_err(|error| {
                    KoniError::Process(format!(
                        "configured result path could not be opened safely: {path}: {error}"
                    ))
                })?;
            let streamed = stream_opened_regular_file(
                opened,
                MAX_CHECK_RESULT_DOCUMENT_BYTES as u64,
                deadline,
                true,
                |_| Ok(()),
            )
            .map_err(|error| {
                KoniError::Process(format!(
                    "configured result path violated the {} byte result-document limit or stability contract: {path}: {error}",
                    MAX_CHECK_RESULT_DOCUMENT_BYTES
                ))
            })?;
            let bytes = streamed.bytes;
            if bytes.is_empty() {
                return Err(KoniError::Process(format!(
                    "configured result path is empty: {path}"
                )));
            }
            let size_bytes = streamed.size_bytes;
            let sha256 = streamed.sha256;
            let document = String::from_utf8(bytes).map_err(|_| {
                KoniError::Process(format!(
                    "configured result path is not UTF-8 JSON or JSONL: {path}"
                ))
            })?;
            return Ok((
                document,
                ResultSourceReceipt {
                    kind: "file".to_owned(),
                    path: Some(path),
                    size_bytes,
                    sha256,
                },
            ));
        }
        if attempt.stdout_truncated {
            return Err(KoniError::Process(format!(
                "stdout result exceeded the bounded capture contract: observed {} bytes, retained {} bytes",
                attempt.stdout_observed_bytes, attempt.stdout_retained_bytes
            )));
        }
        if Instant::now() >= deadline {
            return Err(KoniError::Process(
                "stdout result postprocessing deadline elapsed".to_owned(),
            ));
        }
        let stdout = &attempt.stdout;
        let bytes = stdout.as_bytes();
        if bytes.len() > MAX_CHECK_RESULT_DOCUMENT_BYTES {
            return Err(KoniError::Process(format!(
                "stdout result exceeds the {} byte result-document limit",
                MAX_CHECK_RESULT_DOCUMENT_BYTES
            )));
        }
        Ok((
            stdout.to_owned(),
            ResultSourceReceipt {
                kind: "stdout".to_owned(),
                path: None,
                size_bytes: bytes.len() as u64,
                sha256: raw_sha256(bytes),
            },
        ))
    }
}

/// A configured non-zero exit is evidence only when the command reached the
/// subject it was meant to evaluate. These signatures are emitted before a
/// test runner or verifier can start, so treating them as an expected red
/// would turn a sandbox/toolchain defect into false historical evidence.
pub(crate) fn command_infrastructure_failure(stdout: &str, stderr: &str) -> Option<String> {
    let contains = |needle| {
        contains_ascii_case_insensitive(stdout, needle)
            || contains_ascii_case_insensitive(stderr, needle)
    };
    let cause = if contains("process.cwd failed") || contains("uv_cwd") {
        "the runtime could not resolve its working directory"
    } else if contains("error: eperm:") && contains("operation not permitted") {
        "the runtime was denied a required sandbox resource"
    } else if contains("startup error")
        || contains("getaddrinfo enotfound")
        || contains("getaddrinfo eai_")
    {
        "the configured runtime failed during startup"
    } else if contains("invalid environment variables") {
        "the configured test environment was invalid"
    } else if contains("tests  no tests") || contains("no test files found") {
        "the configured test runner did not execute a test"
    } else if contains("bad interpreter: no such file or directory")
        || (contains("/usr/bin/env:") && contains("no such file or directory"))
        || (contains("env:") && contains("no such file or directory"))
    {
        "the configured command interpreter was unavailable"
    } else {
        return None;
    };
    Some(format!(
        "command infrastructure failed before producing an admissible expected result: {cause}"
    ))
}

fn contains_ascii_case_insensitive(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack
        .as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

#[cfg(unix)]
fn run_attempt(
    argv: &[String],
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    timeout: Duration,
    stop_file: Option<&Path>,
    attempt: u32,
    capture_budget: usize,
) -> Result<AttemptReceipt> {
    let started = Instant::now();
    let mut command = Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| KoniError::Process(format!("failed to spawn {}: {error}", argv[0])))?;
    let process_group_id = child.id();
    let Some(mut stdout) = child.stdout.take() else {
        terminate_check_after_setup_error(&mut child, process_group_id);
        return Err(KoniError::Process("missing stdout pipe".to_owned()));
    };
    let Some(mut stderr) = child.stderr.take() else {
        terminate_check_after_setup_error(&mut child, process_group_id);
        return Err(KoniError::Process("missing stderr pipe".to_owned()));
    };
    if let Err(error) = set_nonblocking(&stdout).and_then(|()| set_nonblocking(&stderr)) {
        terminate_check_after_setup_error(&mut child, process_group_id);
        return Err(KoniError::Process(format!(
            "could not configure bounded check output pipes: {error}"
        )));
    }

    let mut stdout_capture = BoundedOutputCapture::new();
    let mut stderr_capture = BoundedOutputCapture::new();
    let attempt_capture_budget = capture_budget.min(MAX_CHECK_ATTEMPT_CAPTURE_BYTES);
    let mut retained_total = MAX_CHECK_ATTEMPT_CAPTURE_BYTES.saturating_sub(attempt_capture_budget);
    let mut stdout_eof = false;
    let mut stderr_eof = false;
    let mut read_error = None;
    let mut status = None;
    let mut natural_exit_at = None;
    let mut timed_out = false;
    let mut interrupted = false;

    loop {
        drain_check_pipes(
            &mut stdout,
            &mut stdout_capture,
            &mut stdout_eof,
            &mut stderr,
            &mut stderr_capture,
            &mut stderr_eof,
            &mut retained_total,
            &mut read_error,
        );
        if let Some(error) = read_error.clone() {
            let cleanup = terminate_owned_check_group(
                &mut child,
                process_group_id,
                &mut status,
                &mut stdout,
                &mut stdout_capture,
                &mut stdout_eof,
                &mut stderr,
                &mut stderr_capture,
                &mut stderr_eof,
                &mut retained_total,
                &mut read_error,
            );
            return Err(KoniError::Process(match cleanup {
                Ok(()) => error,
                Err(cleanup) => format!("{error}; check cleanup also failed: {cleanup}"),
            }));
        }

        if status.is_none() {
            status = child.try_wait().map_err(|error| {
                terminate_check_after_setup_error(&mut child, process_group_id);
                KoniError::Process(format!("failed waiting for check process: {error}"))
            })?;
        }

        if status.is_some() {
            let exit_observed = natural_exit_at.get_or_insert_with(Instant::now);
            if !process_group_is_alive(process_group_id).map_err(|error| {
                terminate_check_after_setup_error(&mut child, process_group_id);
                KoniError::Process(format!(
                    "failed inspecting check process group {process_group_id}: {error}"
                ))
            })? {
                finish_check_pipe_drain(
                    &mut stdout,
                    &mut stdout_capture,
                    &mut stdout_eof,
                    &mut stderr,
                    &mut stderr_capture,
                    &mut stderr_eof,
                    &mut retained_total,
                    &mut read_error,
                )?;
                break;
            }
            if exit_observed.elapsed() >= CHECK_NATURAL_DESCENDANT_GRACE {
                terminate_owned_check_group(
                    &mut child,
                    process_group_id,
                    &mut status,
                    &mut stdout,
                    &mut stdout_capture,
                    &mut stdout_eof,
                    &mut stderr,
                    &mut stderr_capture,
                    &mut stderr_eof,
                    &mut retained_total,
                    &mut read_error,
                )?;
                break;
            }
        } else if stop_file.is_some_and(Path::exists) {
            interrupted = true;
            terminate_owned_check_group(
                &mut child,
                process_group_id,
                &mut status,
                &mut stdout,
                &mut stdout_capture,
                &mut stdout_eof,
                &mut stderr,
                &mut stderr_capture,
                &mut stderr_eof,
                &mut retained_total,
                &mut read_error,
            )?;
            break;
        } else if started.elapsed() >= timeout {
            timed_out = true;
            terminate_owned_check_group(
                &mut child,
                process_group_id,
                &mut status,
                &mut stdout,
                &mut stdout_capture,
                &mut stdout_eof,
                &mut stderr,
                &mut stderr_capture,
                &mut stderr_eof,
                &mut retained_total,
                &mut read_error,
            )?;
            break;
        }
        thread::sleep(CHECK_POLL_INTERVAL);
    }

    if let Some(error) = read_error {
        return Err(KoniError::Process(error));
    }
    let exit_code = status.and_then(|status| status.code());
    let stdout = stdout_capture.finish();
    let stderr = stderr_capture.finish();
    Ok(AttemptReceipt {
        attempt,
        exit_code,
        timed_out,
        interrupted,
        stdout: stdout.text,
        stderr: stderr.text,
        stdout_hash: stdout.retained_sha256,
        stderr_hash: stderr.retained_sha256,
        stdout_observed_hash: Some(stdout.observed_sha256),
        stderr_observed_hash: Some(stderr.observed_sha256),
        stdout_observed_bytes: stdout.observed_bytes,
        stdout_retained_bytes: stdout.retained_bytes,
        stdout_truncated: stdout.truncated,
        stderr_observed_bytes: stderr.observed_bytes,
        stderr_retained_bytes: stderr.retained_bytes,
        stderr_truncated: stderr.truncated,
        duration_ms: started.elapsed().as_millis(),
    })
}

#[cfg(not(unix))]
fn run_attempt(
    _argv: &[String],
    _cwd: &Path,
    _environment: &BTreeMap<String, String>,
    _timeout: Duration,
    _stop_file: Option<&Path>,
    _attempt: u32,
    _capture_budget: usize,
) -> Result<AttemptReceipt> {
    Err(KoniError::Process(
        "configured checks require Unix process-group containment".to_owned(),
    ))
}

#[cfg(unix)]
struct BoundedOutputCapture {
    retained: Vec<u8>,
    observed_bytes: u64,
    truncated: bool,
    hasher: Sha256,
}

#[cfg(unix)]
impl BoundedOutputCapture {
    fn new() -> Self {
        Self {
            retained: Vec::new(),
            observed_bytes: 0,
            truncated: false,
            hasher: Sha256::new(),
        }
    }

    fn record(&mut self, bytes: &[u8], retained_total: &mut usize) {
        self.observed_bytes = self.observed_bytes.saturating_add(bytes.len() as u64);
        self.hasher.update(bytes);
        let stream_remaining = MAX_CHECK_STREAM_CAPTURE_BYTES.saturating_sub(self.retained.len());
        let attempt_remaining = MAX_CHECK_ATTEMPT_CAPTURE_BYTES.saturating_sub(*retained_total);
        let retain = bytes.len().min(stream_remaining).min(attempt_remaining);
        self.retained.extend_from_slice(&bytes[..retain]);
        *retained_total = (*retained_total).saturating_add(retain);
        self.truncated |= retain != bytes.len();
    }

    fn finish(self) -> FinishedOutputCapture {
        let text = String::from_utf8_lossy(&self.retained).into_owned();
        FinishedOutputCapture {
            retained_sha256: raw_sha256(text.as_bytes()),
            text,
            observed_sha256: format!("sha256:{}", hex::encode(self.hasher.finalize())),
            observed_bytes: self.observed_bytes,
            retained_bytes: self.retained.len() as u64,
            truncated: self.truncated,
        }
    }
}

#[cfg(unix)]
struct FinishedOutputCapture {
    text: String,
    retained_sha256: String,
    observed_sha256: String,
    observed_bytes: u64,
    retained_bytes: u64,
    truncated: bool,
}

#[cfg(unix)]
fn set_nonblocking(pipe: &impl AsFd) -> std::io::Result<()> {
    let flags = rustix::fs::fcntl_getfl(pipe).map_err(std::io::Error::from)?;
    rustix::fs::fcntl_setfl(pipe, flags | rustix::fs::OFlags::NONBLOCK)
        .map_err(std::io::Error::from)
}

#[cfg(unix)]
fn drain_pipe(
    pipe: &mut impl Read,
    capture: &mut BoundedOutputCapture,
    retained_total: &mut usize,
) -> std::io::Result<bool> {
    let mut buffer = [0_u8; 16 * 1024];
    for _ in 0..8 {
        match pipe.read(&mut buffer) {
            Ok(0) => return Ok(true),
            Ok(read) => capture.record(&buffer[..read], retained_total),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(false)
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn drain_check_pipes(
    stdout: &mut ChildStdout,
    stdout_capture: &mut BoundedOutputCapture,
    stdout_eof: &mut bool,
    stderr: &mut ChildStderr,
    stderr_capture: &mut BoundedOutputCapture,
    stderr_eof: &mut bool,
    retained_total: &mut usize,
    read_error: &mut Option<String>,
) {
    if !*stdout_eof {
        match drain_pipe(stdout, stdout_capture, retained_total) {
            Ok(eof) => *stdout_eof = eof,
            Err(error) => {
                *stdout_eof = true;
                read_error.get_or_insert_with(|| format!("could not read stdout: {error}"));
            }
        }
    }
    if !*stderr_eof {
        match drain_pipe(stderr, stderr_capture, retained_total) {
            Ok(eof) => *stderr_eof = eof,
            Err(error) => {
                *stderr_eof = true;
                read_error.get_or_insert_with(|| format!("could not read stderr: {error}"));
            }
        }
    }
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn finish_check_pipe_drain(
    stdout: &mut ChildStdout,
    stdout_capture: &mut BoundedOutputCapture,
    stdout_eof: &mut bool,
    stderr: &mut ChildStderr,
    stderr_capture: &mut BoundedOutputCapture,
    stderr_eof: &mut bool,
    retained_total: &mut usize,
    read_error: &mut Option<String>,
) -> Result<()> {
    let started = Instant::now();
    loop {
        drain_check_pipes(
            stdout,
            stdout_capture,
            stdout_eof,
            stderr,
            stderr_capture,
            stderr_eof,
            retained_total,
            read_error,
        );
        if let Some(error) = read_error {
            return Err(KoniError::Process(error.clone()));
        }
        if *stdout_eof && *stderr_eof {
            return Ok(());
        }
        if started.elapsed() >= CHECK_PIPE_DRAIN_GRACE {
            return Err(KoniError::Process(
                "check output pipes remained open after the owned process group exited".to_owned(),
            ));
        }
        thread::sleep(CHECK_POLL_INTERVAL);
    }
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn terminate_owned_check_group(
    child: &mut Child,
    process_group_id: u32,
    status: &mut Option<ExitStatus>,
    stdout: &mut ChildStdout,
    stdout_capture: &mut BoundedOutputCapture,
    stdout_eof: &mut bool,
    stderr: &mut ChildStderr,
    stderr_capture: &mut BoundedOutputCapture,
    stderr_eof: &mut bool,
    retained_total: &mut usize,
    read_error: &mut Option<String>,
) -> Result<()> {
    let term_error = signal_check_process_group(process_group_id, libc::SIGTERM).err();
    let term_gone = wait_for_check_group_exit(
        child,
        process_group_id,
        status,
        stdout,
        stdout_capture,
        stdout_eof,
        stderr,
        stderr_capture,
        stderr_eof,
        retained_total,
        read_error,
        CHECK_TERM_GRACE,
    )
    .unwrap_or(false);

    if !term_gone {
        let kill_error = signal_check_process_group(process_group_id, libc::SIGKILL).err();
        let kill_gone = wait_for_check_group_exit(
            child,
            process_group_id,
            status,
            stdout,
            stdout_capture,
            stdout_eof,
            stderr,
            stderr_capture,
            stderr_eof,
            retained_total,
            read_error,
            CHECK_KILL_GRACE,
        )
        .unwrap_or(false);
        if !kill_gone {
            let _ = child.kill();
            return Err(KoniError::Process(format!(
                "check process group {process_group_id} survived SIGKILL{}{}",
                term_error
                    .as_ref()
                    .map(|error| format!("; SIGTERM failed: {error}"))
                    .unwrap_or_default(),
                kill_error
                    .as_ref()
                    .map(|error| format!("; SIGKILL failed: {error}"))
                    .unwrap_or_default()
            )));
        }
    }

    reap_check_leader_bounded(child, status)?;
    finish_check_pipe_drain(
        stdout,
        stdout_capture,
        stdout_eof,
        stderr,
        stderr_capture,
        stderr_eof,
        retained_total,
        read_error,
    )
}

#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
fn wait_for_check_group_exit(
    child: &mut Child,
    process_group_id: u32,
    status: &mut Option<ExitStatus>,
    stdout: &mut ChildStdout,
    stdout_capture: &mut BoundedOutputCapture,
    stdout_eof: &mut bool,
    stderr: &mut ChildStderr,
    stderr_capture: &mut BoundedOutputCapture,
    stderr_eof: &mut bool,
    retained_total: &mut usize,
    read_error: &mut Option<String>,
    grace: Duration,
) -> std::io::Result<bool> {
    let started = Instant::now();
    loop {
        drain_check_pipes(
            stdout,
            stdout_capture,
            stdout_eof,
            stderr,
            stderr_capture,
            stderr_eof,
            retained_total,
            read_error,
        );
        if status.is_none() {
            *status = child.try_wait()?;
        }
        if !process_group_is_alive(process_group_id)? {
            return Ok(true);
        }
        if started.elapsed() >= grace {
            return Ok(false);
        }
        thread::sleep(CHECK_POLL_INTERVAL);
    }
}

#[cfg(unix)]
fn reap_check_leader_bounded(child: &mut Child, status: &mut Option<ExitStatus>) -> Result<()> {
    let started = Instant::now();
    loop {
        if status.is_none() {
            *status = child.try_wait().map_err(|error| {
                KoniError::Process(format!("failed reaping check process: {error}"))
            })?;
        }
        if status.is_some() {
            return Ok(());
        }
        if started.elapsed() >= CHECK_KILL_GRACE {
            let _ = child.kill();
            return Err(KoniError::Process(
                "check process-group leader did not become reapable after cleanup".to_owned(),
            ));
        }
        thread::sleep(CHECK_POLL_INTERVAL);
    }
}

#[cfg(unix)]
fn signal_check_process_group(process_group_id: u32, signal: i32) -> std::io::Result<()> {
    let process_group_id = i32::try_from(process_group_id)
        .map_err(|_| std::io::Error::other("check process-group id exceeds platform range"))?;
    // SAFETY: a negative, validated process-group id targets only the fresh
    // group created on this exact Child before exec.
    if unsafe { libc::kill(-process_group_id, signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(unix)]
fn process_group_is_alive(process_group_id: u32) -> std::io::Result<bool> {
    let process_group_id = i32::try_from(process_group_id)
        .map_err(|_| std::io::Error::other("check process-group id exceeds platform range"))?;
    // SAFETY: signal 0 performs no mutation and the negative id is the exact
    // fresh process group owned by this attempt.
    if unsafe { libc::kill(-process_group_id, 0) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(error),
    }
}

#[cfg(unix)]
fn terminate_check_after_setup_error(child: &mut Child, process_group_id: u32) {
    let _ = signal_check_process_group(process_group_id, libc::SIGTERM);
    let started = Instant::now();
    while started.elapsed() < CHECK_TERM_GRACE {
        if child.try_wait().ok().flatten().is_some()
            && process_group_is_alive(process_group_id).ok() == Some(false)
        {
            return;
        }
        thread::sleep(CHECK_POLL_INTERVAL);
    }
    let _ = signal_check_process_group(process_group_id, libc::SIGKILL);
    let started = Instant::now();
    while started.elapsed() < CHECK_KILL_GRACE {
        if child.try_wait().ok().flatten().is_some()
            && process_group_is_alive(process_group_id).ok() == Some(false)
        {
            return;
        }
        thread::sleep(CHECK_POLL_INTERVAL);
    }
    let _ = child.kill();
    let _ = child.try_wait();
}

pub(crate) fn resolved_environment(
    policy: &EnvironmentPolicy,
    variables: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>> {
    let mut environment: BTreeMap<String, String> = if policy.inherit {
        std::env::vars()
            .filter(|(key, _)| policy.allow.is_empty() || policy.allow.contains(key))
            .filter(|(key, _)| !policy.deny.contains(key))
            .collect()
    } else {
        BTreeMap::new()
    };
    for (key, value) in &policy.set {
        environment.insert(key.clone(), interpolate(value, variables)?);
    }
    Ok(environment)
}

fn parse_protocol_result(stdout: &str, protocol: &ResultProtocol) -> Result<Value> {
    let document = stdout.trim();
    let document_value = protocol
        .line_prefix
        .is_none()
        .then(|| serde_json::from_str::<Value>(document).ok())
        .flatten();
    let value = if let Some(value) = document_value {
        (value.get(&protocol.protocol_field).and_then(Value::as_str) == Some(&protocol.protocol))
            .then_some(value)
    } else {
        let mut matching = None;
        for line in stdout.lines() {
            let line = if let Some(prefix) = &protocol.line_prefix {
                let Some(line) = line.strip_prefix(prefix) else {
                    continue;
                };
                line.trim()
            } else {
                line.trim()
            };
            if let Ok(value) = serde_json::from_str::<Value>(line)
                && value.get(&protocol.protocol_field).and_then(Value::as_str)
                    == Some(&protocol.protocol)
            {
                matching = Some(value);
            }
        }
        matching
    }
    .ok_or_else(|| {
        KoniError::Process(format!(
            "stdout did not emit protocol {}",
            protocol.protocol
        ))
    })?;
    for field in &protocol.required_fields {
        if value
            .pointer(&format!("/{}", field.replace('.', "/")))
            .is_none()
        {
            return Err(KoniError::Process(format!(
                "protocol {} is missing {field}",
                protocol.protocol
            )));
        }
    }
    if let Some(schema) = &protocol.schema {
        let validator = jsonschema::validator_for(schema).map_err(|error| {
            KoniError::Process(format!("invalid configured result schema: {error}"))
        })?;
        let errors: Vec<_> = validator
            .iter_errors(&value)
            .map(|error| error.to_string())
            .collect();
        if !errors.is_empty() {
            return Err(KoniError::Process(format!(
                "protocol result failed schema: {}",
                errors.join("; ")
            )));
        }
    }
    Ok(value)
}

pub(crate) fn interpolate(input: &str, variables: &BTreeMap<String, String>) -> Result<String> {
    let pattern = Regex::new(r"\$\{([A-Za-z0-9_.-]+)\}").expect("static interpolation regex");
    let mut missing = None;
    let output = pattern
        .replace_all(input, |captures: &regex::Captures<'_>| {
            let key = &captures[1];
            variables.get(key).cloned().unwrap_or_else(|| {
                missing = Some(key.to_owned());
                String::new()
            })
        })
        .into_owned();
    if let Some(key) = missing {
        return Err(KoniError::Process(format!(
            "missing command variable {key}"
        )));
    }
    Ok(output)
}

pub(crate) fn contained_path(root: &Path, path: &str) -> Result<PathBuf> {
    let requested = Path::new(path);
    if requested.is_absolute()
        || requested.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(KoniError::Process(format!(
            "command path must be project-relative and may not contain '..': {path}"
        )));
    }
    let root = root.canonicalize().map_err(|error| io_error(root, error))?;
    let joined = root.join(path);
    let resolved = if joined.exists() {
        joined
            .canonicalize()
            .map_err(|error| io_error(&joined, error))?
    } else {
        let mut existing = joined.as_path();
        let mut trailing = Vec::new();
        while !existing.exists() {
            let name = existing.file_name().ok_or_else(|| {
                KoniError::Process(format!("invalid project-relative path {path}"))
            })?;
            trailing.push(name.to_os_string());
            existing = existing.parent().ok_or_else(|| {
                KoniError::Process(format!("invalid project-relative path {path}"))
            })?;
        }
        let mut resolved = existing
            .canonicalize()
            .map_err(|error| io_error(existing, error))?;
        for component in trailing.into_iter().rev() {
            resolved.push(component);
        }
        resolved
    };
    if !resolved.starts_with(&root) {
        return Err(KoniError::Process(format!(
            "path escapes project root: {path}"
        )));
    }
    Ok(resolved)
}

#[derive(Debug)]
struct OpenedProjectFile {
    file: fs::File,
    initial_size: u64,
    initial_snapshot: EvidenceFileSnapshot,
}

#[derive(Debug)]
struct StreamedProjectFile {
    bytes: Vec<u8>,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EvidenceFileSnapshot {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

#[cfg(unix)]
fn evidence_file_snapshot(file: &fs::File) -> std::io::Result<EvidenceFileSnapshot> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(EvidenceFileSnapshot {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanoseconds: metadata.ctime_nsec(),
    })
}

#[cfg(not(unix))]
fn evidence_file_snapshot(file: &fs::File) -> std::io::Result<EvidenceFileSnapshot> {
    let metadata = file.metadata()?;
    Ok(EvidenceFileSnapshot {
        device: 0,
        inode: 0,
        size: metadata.len(),
        modified_seconds: 0,
        modified_nanoseconds: 0,
        changed_seconds: 0,
        changed_nanoseconds: 0,
    })
}

#[cfg(unix)]
fn securely_open_project_regular_file<F>(
    root: &Path,
    path: &str,
    deadline: Instant,
    before_final_open: F,
) -> std::io::Result<OpenedProjectFile>
where
    F: FnOnce(),
{
    use rustix::fd::OwnedFd;
    use rustix::fs::{FileType, Mode, OFlags, fstat, open, openat};

    const DIRECTORY_FLAGS: OFlags = OFlags::RDONLY
        .union(OFlags::DIRECTORY)
        .union(OFlags::NOFOLLOW)
        .union(OFlags::CLOEXEC)
        .union(OFlags::NONBLOCK);
    const FILE_FLAGS: OFlags = OFlags::RDONLY
        .union(OFlags::NOFOLLOW)
        .union(OFlags::CLOEXEC)
        .union(OFlags::NONBLOCK);

    fn deadline_check(deadline: Instant) -> std::io::Result<()> {
        if Instant::now() >= deadline {
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "evidence-file open deadline elapsed",
            ))
        } else {
            Ok(())
        }
    }

    fn contextual_error(error: rustix::io::Errno, context: &str) -> std::io::Error {
        let error = std::io::Error::from(error);
        std::io::Error::new(error.kind(), format!("{context}: {error}"))
    }

    let path = normalized_relative_path(path).map_err(|error| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, error.to_string())
    })?;
    let components = Path::new(&path)
        .components()
        .map(|component| component.as_os_str().to_os_string())
        .collect::<Vec<_>>();
    let (final_component, parent_components) = components
        .split_last()
        .ok_or_else(|| std::io::Error::other("evidence path has no final component"))?;

    deadline_check(deadline)?;
    let mut directory: OwnedFd = open(root, DIRECTORY_FLAGS, Mode::empty()).map_err(|error| {
        contextual_error(
            error,
            "project root must be a real no-follow directory for evidence access",
        )
    })?;
    let root_stat = fstat(&directory).map_err(std::io::Error::from)?;
    if FileType::from_raw_mode(root_stat.st_mode) != FileType::Directory {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "project root is not a directory",
        ));
    }
    for component in parent_components {
        deadline_check(deadline)?;
        directory =
            openat(&directory, component, DIRECTORY_FLAGS, Mode::empty()).map_err(|error| {
                contextual_error(
                    error,
                    "evidence path may not traverse a symlink or non-directory component",
                )
            })?;
    }

    before_final_open();
    deadline_check(deadline)?;
    let file = openat(&directory, final_component, FILE_FLAGS, Mode::empty()).map_err(|error| {
        contextual_error(
            error,
            "evidence path final component must not be a symlink, FIFO, or non-regular file",
        )
    })?;
    let stat = fstat(&file).map_err(std::io::Error::from)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "evidence path final component is not a regular file",
        ));
    }
    let file: fs::File = file.into();
    let initial_snapshot = evidence_file_snapshot(&file)?;
    let initial_size = initial_snapshot.size;
    Ok(OpenedProjectFile {
        file,
        initial_size,
        initial_snapshot,
    })
}

#[cfg(not(unix))]
fn securely_open_project_regular_file<F>(
    _root: &Path,
    _path: &str,
    _deadline: Instant,
    _before_final_open: F,
) -> std::io::Result<OpenedProjectFile>
where
    F: FnOnce(),
{
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "descriptor-rooted evidence access requires Unix openat",
    ))
}

fn stream_opened_regular_file<F>(
    mut opened: OpenedProjectFile,
    max_bytes: u64,
    deadline: Instant,
    retain_bytes: bool,
    before_read: F,
) -> std::io::Result<StreamedProjectFile>
where
    F: FnOnce(&fs::File) -> std::io::Result<()>,
{
    if opened.initial_size > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "evidence file is {} bytes; the maximum is {max_bytes}",
                opened.initial_size
            ),
        ));
    }
    if Instant::now() >= deadline {
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "evidence-file postprocessing deadline elapsed",
        ));
    }
    before_read(&opened.file)?;

    let mut bytes = if retain_bytes {
        Vec::with_capacity(
            usize::try_from(opened.initial_size)
                .unwrap_or(usize::MAX)
                .min(usize::try_from(max_bytes).unwrap_or(usize::MAX)),
        )
    } else {
        Vec::new()
    };
    let mut hasher = Sha256::new();
    let mut size_bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "evidence-file postprocessing deadline elapsed",
            ));
        }
        match opened.file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                size_bytes = size_bytes.checked_add(read as u64).ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "evidence-file byte count overflowed",
                    )
                })?;
                if size_bytes > max_bytes {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("evidence file grew beyond the {max_bytes} byte maximum"),
                    ));
                }
                if size_bytes > opened.initial_size {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "evidence file grew while it was being read",
                    ));
                }
                hasher.update(&buffer[..read]);
                if retain_bytes {
                    bytes.extend_from_slice(&buffer[..read]);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(CHECK_POLL_INTERVAL);
            }
            Err(error) => return Err(error),
        }
    }

    let final_snapshot = evidence_file_snapshot(&opened.file)?;
    if final_snapshot != opened.initial_snapshot || size_bytes != opened.initial_size {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "evidence file identity, size, or timestamps changed while it was being read",
        ));
    }

    Ok(StreamedProjectFile {
        bytes,
        size_bytes,
        sha256: format!("sha256:{}", hex::encode(hasher.finalize())),
    })
}

pub(crate) fn artifact_receipt(root: &Path, path: &str) -> Result<ArtifactReceipt> {
    let deadline = Instant::now()
        .checked_add(MAX_CHECK_POSTPROCESSING)
        .ok_or_else(|| KoniError::Process("artifact deadline overflowed".to_owned()))?;
    artifact_receipt_with_deadline(root, path, deadline)
}

fn artifact_receipt_with_deadline(
    root: &Path,
    path: &str,
    deadline: Instant,
) -> Result<ArtifactReceipt> {
    let path = normalized_relative_path(path)?;
    let opened = match securely_open_project_regular_file(root, &path, deadline, || {}) {
        Ok(opened) => opened,
        Err(error) => {
            return Ok(ArtifactReceipt {
                path,
                exists: error.kind() != std::io::ErrorKind::NotFound,
                size_bytes: None,
                hash: None,
                error: Some(format!("artifact could not be opened safely: {error}")),
            });
        }
    };
    let initial_size = opened.initial_size;
    let streamed =
        match stream_opened_regular_file(opened, MAX_CHECK_ARTIFACT_BYTES, deadline, false, |_| {
            Ok(())
        }) {
            Ok(streamed) => streamed,
            Err(error) => {
                return Ok(ArtifactReceipt {
                    path,
                    exists: true,
                    size_bytes: Some(initial_size),
                    hash: None,
                    error: Some(format!("artifact could not be hashed safely: {error}")),
                });
            }
        };
    if streamed.size_bytes == 0 {
        return Ok(ArtifactReceipt {
            path,
            exists: true,
            size_bytes: Some(0),
            hash: Some(streamed.sha256),
            error: Some("artifact is empty".to_owned()),
        });
    }
    Ok(ArtifactReceipt {
        path,
        exists: true,
        size_bytes: Some(streamed.size_bytes),
        hash: Some(streamed.sha256),
        error: None,
    })
}

pub(crate) fn raw_sha256(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

pub(crate) fn normalized_relative_path(path: &str) -> Result<String> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Err(KoniError::Process(format!(
            "path must be project-relative: {}",
            path.display()
        )));
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| KoniError::Process("path is not valid UTF-8".to_owned()))?;
                parts.push(value.to_owned());
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(KoniError::Process(format!(
                    "path must be project-relative and may not contain '..': {}",
                    path.display()
                )));
            }
        }
    }
    if parts.is_empty() {
        return Err(KoniError::Process(
            "path must be a nonempty project-relative path".to_owned(),
        ));
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runner() -> (tempfile::TempDir, CommandRunner) {
        let temp = tempfile::tempdir().unwrap();
        let runner = CommandRunner::new(temp.path().to_path_buf());
        (temp, runner)
    }

    fn attempt_with_stdout(stdout: &str) -> AttemptReceipt {
        AttemptReceipt {
            attempt: 1,
            exit_code: Some(0),
            timed_out: false,
            interrupted: false,
            stdout: stdout.to_owned(),
            stderr: String::new(),
            stdout_hash: raw_sha256(stdout.as_bytes()),
            stderr_hash: raw_sha256(b""),
            stdout_observed_hash: Some(raw_sha256(stdout.as_bytes())),
            stderr_observed_hash: Some(raw_sha256(b"")),
            stdout_observed_bytes: stdout.len() as u64,
            stdout_retained_bytes: stdout.len() as u64,
            stdout_truncated: false,
            stderr_observed_bytes: 0,
            stderr_retained_bytes: 0,
            stderr_truncated: false,
            duration_ms: 0,
        }
    }

    fn simple_command_spec(id: &str, argv: Vec<String>) -> CommandSpec {
        CommandSpec {
            id: id.to_owned(),
            argv,
            cwd: ".".to_owned(),
            timeout_seconds: 5,
            environment: EnvironmentPolicy::default(),
            expected_exit_codes: BTreeSet::new(),
            transient_exit_codes: BTreeSet::new(),
            max_attempts: 1,
            result_protocol: None,
            artifact_paths: Vec::new(),
        }
    }

    #[cfg(unix)]
    fn create_fifo(path: &Path) {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let path = CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: the CString is NUL-terminated and names a test-owned path.
        let result = unsafe { libc::mkfifo(path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );
    }

    #[test]
    fn legacy_attempt_receipts_deserialize_without_observed_stream_hashes() {
        let stdout = "legacy output";
        let value = serde_json::json!({
            "attempt": 1,
            "exit_code": 0,
            "timed_out": false,
            "interrupted": false,
            "stdout": stdout,
            "stderr": "",
            "stdout_hash": raw_sha256(stdout.as_bytes()),
            "stderr_hash": raw_sha256(b""),
            "duration_ms": 7
        });

        let receipt: AttemptReceipt = serde_json::from_value(value).unwrap();

        assert_eq!(receipt.stdout_hash, raw_sha256(receipt.stdout.as_bytes()));
        assert_eq!(receipt.stderr_hash, raw_sha256(receipt.stderr.as_bytes()));
        assert!(receipt.stdout_observed_hash.is_none());
        assert!(receipt.stderr_observed_hash.is_none());
        assert_eq!(receipt.stdout_observed_bytes, 0);
        assert_eq!(receipt.stdout_retained_bytes, 0);
    }

    #[cfg(unix)]
    #[test]
    fn retained_text_and_complete_raw_stream_hashes_have_stable_distinct_semantics() {
        let (_temp, runner) = runner();
        let spec = simple_command_spec(
            "non-utf8-output",
            vec![
                "python3".to_owned(),
                "-c".to_owned(),
                "import os; os.write(1, b'\\xff')".to_owned(),
            ],
        );

        let receipt = runner.run(&spec, &BTreeMap::new(), None).unwrap();
        let attempt = &receipt.attempts[0];

        assert_eq!(receipt.status, CommandStatus::Passed);
        assert_eq!(attempt.stdout, "\u{fffd}");
        assert_eq!(attempt.stdout_hash, raw_sha256(attempt.stdout.as_bytes()));
        assert_eq!(
            attempt.stdout_observed_hash.as_deref(),
            Some(raw_sha256(&[0xff]).as_str())
        );
        assert_ne!(
            attempt.stdout_observed_hash.as_ref(),
            Some(&attempt.stdout_hash)
        );
        assert_eq!(attempt.stdout_observed_bytes, 1);
        assert_eq!(attempt.stdout_retained_bytes, 1);
    }

    #[test]
    fn executes_argv_without_a_shell() {
        let (_temp, runner) = runner();
        let spec = CommandSpec {
            id: "printf".to_owned(),
            argv: vec![
                "printf".to_owned(),
                "%s".to_owned(),
                "$(touch nope)".to_owned(),
            ],
            cwd: ".".to_owned(),
            timeout_seconds: 5,
            environment: EnvironmentPolicy::default(),
            expected_exit_codes: BTreeSet::new(),
            transient_exit_codes: BTreeSet::new(),
            max_attempts: 1,
            result_protocol: None,
            artifact_paths: Vec::new(),
        };
        let receipt = runner.run(&spec, &BTreeMap::new(), None).unwrap();
        assert_eq!(receipt.status, CommandStatus::Passed);
        assert_eq!(receipt.attempts[0].stdout, "$(touch nope)");
    }

    #[test]
    fn runner_rejects_extreme_retry_and_wall_budgets_before_spawn() {
        let (temp, runner) = runner();
        let sentinel = temp.path().join("spawned");
        let command = format!("printf spawned > {}", sentinel.display());
        let mut spec = simple_command_spec(
            "too-many-attempts",
            vec!["/bin/sh".to_owned(), "-c".to_owned(), command.clone()],
        );
        spec.max_attempts = MAX_CHECK_ATTEMPTS + 1;

        let error = runner
            .run(&spec, &BTreeMap::new(), None)
            .expect_err("attempt vectors must be statically bounded");
        assert!(error.to_string().contains("maximum is 3"), "{error}");
        assert!(!sentinel.exists(), "invalid retry policy spawned a command");

        spec.id = "too-much-wall-time".to_owned();
        spec.max_attempts = 2;
        spec.timeout_seconds = MAX_CHECK_TOTAL_EXECUTION_SECONDS / 2 + 1;
        let error = runner
            .run(&spec, &BTreeMap::new(), None)
            .expect_err("aggregate wall time must be statically bounded");
        assert!(
            error.to_string().contains("aggregate execution seconds"),
            "{error}"
        );
        assert!(!sentinel.exists(), "invalid wall policy spawned a command");

        spec.id = "one-day-compatible".to_owned();
        spec.argv = vec!["true".to_owned()];
        spec.max_attempts = 1;
        spec.timeout_seconds = MAX_CHECK_TOTAL_EXECUTION_SECONDS;
        let receipt = runner.run(&spec, &BTreeMap::new(), None).unwrap();
        assert_eq!(receipt.status, CommandStatus::Passed);
    }

    #[cfg(unix)]
    #[test]
    fn retries_share_one_retained_output_budget_and_keep_complete_stream_hashes() {
        let (temp, runner) = runner();
        let bytes_per_attempt = 1_200_000_usize;
        let script = format!(
            concat!(
                "import os, pathlib; ",
                "p=pathlib.Path('attempt-count'); ",
                "n=int(p.read_text())+1 if p.exists() else 1; ",
                "p.write_text(str(n)); ",
                "os.write(1, b'x' * {bytes_per_attempt}); ",
                "raise SystemExit(75 if n < 3 else 0)"
            ),
            bytes_per_attempt = bytes_per_attempt
        );
        let mut spec = simple_command_spec(
            "aggregate-capture",
            vec!["python3".to_owned(), "-c".to_owned(), script],
        );
        spec.transient_exit_codes = BTreeSet::from([75]);
        spec.max_attempts = 3;

        let receipt = runner.run(&spec, &BTreeMap::new(), None).unwrap();

        assert_eq!(receipt.status, CommandStatus::Passed);
        assert_eq!(receipt.attempts.len(), 3);
        let retained: u64 = receipt
            .attempts
            .iter()
            .map(|attempt| attempt.stdout_retained_bytes + attempt.stderr_retained_bytes)
            .sum();
        assert_eq!(retained, MAX_CHECK_RUN_CAPTURE_BYTES as u64);
        assert_eq!(receipt.attempts[2].stdout_retained_bytes, 0);
        let complete_hash = raw_sha256(&vec![b'x'; bytes_per_attempt]);
        for attempt in &receipt.attempts {
            assert_eq!(attempt.stdout_hash, raw_sha256(attempt.stdout.as_bytes()));
            assert_eq!(attempt.stderr_hash, raw_sha256(attempt.stderr.as_bytes()));
            assert_eq!(
                attempt.stdout_observed_hash.as_deref(),
                Some(complete_hash.as_str())
            );
            assert_eq!(attempt.stdout_observed_bytes, bytes_per_attempt as u64);
            assert!(attempt.stdout_truncated);
        }
        assert_eq!(
            fs::read_to_string(temp.path().join("attempt-count")).unwrap(),
            "3"
        );
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_term_ignoring_descendant_and_returns_without_pipe_join_hang() {
        let (temp, _) = runner();
        let script = concat!(
            "trap '' TERM; ",
            "(trap '' TERM; while :; do /bin/sleep 1; done) & ",
            "printf '%s' \"$!\" > descendant.pid; ",
            "while :; do /bin/sleep 1; done",
        );
        let environment =
            resolved_environment(&EnvironmentPolicy::default(), &BTreeMap::new()).unwrap();
        let started = Instant::now();

        let receipt = run_attempt(
            &["/bin/sh".to_owned(), "-c".to_owned(), script.to_owned()],
            temp.path(),
            &environment,
            Duration::from_millis(350),
            None,
            1,
            MAX_CHECK_RUN_CAPTURE_BYTES,
        )
        .unwrap();

        assert!(receipt.timed_out);
        assert!(!receipt.interrupted);
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "timeout cleanup exceeded its TERM/KILL/drain bound: {:?}",
            started.elapsed()
        );
        let descendant = fs::read_to_string(temp.path().join("descendant.pid"))
            .unwrap()
            .parse::<u32>()
            .unwrap();
        assert!(wait_for_pid_exit(descendant, Duration::from_secs(2)));
    }

    #[cfg(unix)]
    #[test]
    fn stop_file_kills_the_complete_term_ignoring_process_group() {
        let (temp, _) = runner();
        let script = concat!(
            "trap '' TERM; ",
            "(trap '' TERM; while :; do /bin/sleep 1; done) & ",
            "printf '%s' \"$!\" > descendant.pid; ",
            "while :; do /bin/sleep 1; done",
        );
        let environment =
            resolved_environment(&EnvironmentPolicy::default(), &BTreeMap::new()).unwrap();
        let stop_file = temp.path().join("stop");
        let stop_writer = stop_file.clone();
        let writer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            fs::write(stop_writer, b"stop").unwrap();
        });
        let started = Instant::now();

        let receipt = run_attempt(
            &["/bin/sh".to_owned(), "-c".to_owned(), script.to_owned()],
            temp.path(),
            &environment,
            Duration::from_secs(5),
            Some(&stop_file),
            1,
            MAX_CHECK_RUN_CAPTURE_BYTES,
        )
        .unwrap();
        writer.join().unwrap();

        assert!(receipt.interrupted);
        assert!(!receipt.timed_out);
        assert!(started.elapsed() < Duration::from_secs(4));
        let descendant = fs::read_to_string(temp.path().join("descendant.pid"))
            .unwrap()
            .parse::<u32>()
            .unwrap();
        assert!(wait_for_pid_exit(descendant, Duration::from_secs(2)));
    }

    #[cfg(unix)]
    #[test]
    fn successful_leader_does_not_leave_same_group_helper_running() {
        let (temp, _) = runner();
        let script = concat!(
            "(trap '' TERM; while :; do /bin/sleep 1; done) & ",
            "printf '%s' \"$!\" > descendant.pid; ",
            "exit 0",
        );
        let environment =
            resolved_environment(&EnvironmentPolicy::default(), &BTreeMap::new()).unwrap();

        let receipt = run_attempt(
            &["/bin/sh".to_owned(), "-c".to_owned(), script.to_owned()],
            temp.path(),
            &environment,
            Duration::from_secs(5),
            None,
            1,
            MAX_CHECK_RUN_CAPTURE_BYTES,
        )
        .unwrap();

        assert_eq!(receipt.exit_code, Some(0));
        assert!(!receipt.timed_out);
        assert!(!receipt.interrupted);
        let descendant = fs::read_to_string(temp.path().join("descendant.pid"))
            .unwrap()
            .parse::<u32>()
            .unwrap();
        assert!(wait_for_pid_exit(descendant, Duration::from_secs(2)));
    }

    #[cfg(unix)]
    #[test]
    fn noisy_streams_and_result_documents_obey_owned_memory_limits() {
        let (_temp, runner) = runner();
        let stream_bytes = MAX_CHECK_STREAM_CAPTURE_BYTES + 256 * 1024;
        let noisy_script = format!(
            "import os; os.write(1, b'o' * {stream_bytes} + b'Startup Error\\n'); os.write(2, b'e' * {stream_bytes}); raise SystemExit(1)"
        );
        let noisy = CommandSpec {
            id: "bounded-noise".to_owned(),
            argv: vec!["python3".to_owned(), "-c".to_owned(), noisy_script],
            cwd: ".".to_owned(),
            timeout_seconds: 5,
            environment: EnvironmentPolicy::default(),
            expected_exit_codes: BTreeSet::from([1]),
            transient_exit_codes: BTreeSet::new(),
            max_attempts: 1,
            result_protocol: None,
            artifact_paths: Vec::new(),
        };

        let receipt = runner.run(&noisy, &BTreeMap::new(), None).unwrap();
        assert_eq!(receipt.status, CommandStatus::InvalidResult);
        assert!(
            receipt
                .result_error
                .as_deref()
                .is_some_and(|error| error.contains("truncated output"))
        );
        let attempt = &receipt.attempts[0];
        assert!(attempt.stdout_truncated);
        assert!(attempt.stderr_truncated);
        assert!(attempt.stdout_observed_bytes > attempt.stdout_retained_bytes);
        assert!(attempt.stderr_observed_bytes > attempt.stderr_retained_bytes);
        assert!(attempt.stdout_retained_bytes <= MAX_CHECK_STREAM_CAPTURE_BYTES as u64);
        assert!(attempt.stderr_retained_bytes <= MAX_CHECK_STREAM_CAPTURE_BYTES as u64);
        assert!(
            attempt.stdout_retained_bytes + attempt.stderr_retained_bytes
                <= MAX_CHECK_ATTEMPT_CAPTURE_BYTES as u64
        );
        assert_eq!(attempt.stdout_hash, raw_sha256(attempt.stdout.as_bytes()));
        assert_eq!(attempt.stderr_hash, raw_sha256(attempt.stderr.as_bytes()));
        let mut complete_stdout = vec![b'o'; stream_bytes];
        complete_stdout.extend_from_slice(b"Startup Error\n");
        assert_eq!(
            attempt.stdout_observed_hash.as_deref(),
            Some(raw_sha256(&complete_stdout).as_str())
        );
        assert_eq!(
            attempt.stderr_observed_hash.as_deref(),
            Some(raw_sha256(&vec![b'e'; stream_bytes]).as_str())
        );

        let protocol = ResultProtocol {
            protocol: "test.v1".to_owned(),
            protocol_field: "protocol".to_owned(),
            schema: None,
            required_fields: vec!["verdict".to_owned()],
            line_prefix: None,
            result_path: None,
        };
        let valid = r#"{"protocol":"test.v1","verdict":"passed"}"#;
        let truncated_script = format!(
            "import os; os.write(1, {valid:?}.encode() + b'x' * {})",
            MAX_CHECK_STREAM_CAPTURE_BYTES
        );
        let truncated_result = CommandSpec {
            id: "truncated-stdout-result".to_owned(),
            argv: vec!["python3".to_owned(), "-c".to_owned(), truncated_script],
            cwd: ".".to_owned(),
            timeout_seconds: 5,
            environment: EnvironmentPolicy::default(),
            expected_exit_codes: BTreeSet::new(),
            transient_exit_codes: BTreeSet::new(),
            max_attempts: 1,
            result_protocol: Some(protocol.clone()),
            artifact_paths: Vec::new(),
        };
        let receipt = runner
            .run(&truncated_result, &BTreeMap::new(), None)
            .unwrap();
        assert_eq!(receipt.status, CommandStatus::InvalidResult);
        assert!(
            receipt
                .result_error
                .as_deref()
                .is_some_and(|error| error.contains("bounded capture contract"))
        );

        let oversized_file_script = format!(
            "from pathlib import Path; Path('result.json').write_bytes({valid:?}.encode() + b' ' * {})",
            MAX_CHECK_RESULT_DOCUMENT_BYTES
        );
        let oversized_file = CommandSpec {
            id: "oversized-result-file".to_owned(),
            argv: vec!["python3".to_owned(), "-c".to_owned(), oversized_file_script],
            cwd: ".".to_owned(),
            timeout_seconds: 5,
            environment: EnvironmentPolicy::default(),
            expected_exit_codes: BTreeSet::new(),
            transient_exit_codes: BTreeSet::new(),
            max_attempts: 1,
            result_protocol: Some(ResultProtocol {
                result_path: Some("result.json".to_owned()),
                ..protocol
            }),
            artifact_paths: Vec::new(),
        };
        let receipt = runner.run(&oversized_file, &BTreeMap::new(), None).unwrap();
        assert_eq!(receipt.status, CommandStatus::InvalidResult);
        assert!(
            receipt
                .result_error
                .as_deref()
                .is_some_and(|error| error.contains("result-document limit"))
        );
    }

    #[cfg(unix)]
    fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        let started = Instant::now();
        loop {
            // SAFETY: signal 0 only inspects the test-owned PID recorded by
            // the descendant before the runner starts cleanup.
            if unsafe { libc::kill(pid, 0) } != 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return true;
            }
            if started.elapsed() >= timeout {
                return false;
            }
            thread::sleep(CHECK_POLL_INTERVAL);
        }
    }

    #[test]
    fn expected_nonzero_exit_rejects_runtime_bootstrap_failure() {
        let (_temp, runner) = runner();
        let mut spec = CommandSpec {
            id: "expected-red".to_owned(),
            argv: vec![
                "/bin/sh".to_owned(),
                "-c".to_owned(),
                "printf '%s\\n' 'Error: EPERM: process.cwd failed, uv_cwd' >&2; exit 1".to_owned(),
            ],
            cwd: ".".to_owned(),
            timeout_seconds: 5,
            environment: EnvironmentPolicy::default(),
            expected_exit_codes: BTreeSet::from([1]),
            transient_exit_codes: BTreeSet::new(),
            max_attempts: 1,
            result_protocol: None,
            artifact_paths: Vec::new(),
        };

        let infrastructure = runner.run(&spec, &BTreeMap::new(), None).unwrap();
        assert_eq!(infrastructure.status, CommandStatus::InvalidResult);
        assert!(
            infrastructure
                .result_error
                .as_deref()
                .is_some_and(|error| error.contains("working directory"))
        );

        spec.argv[2] =
            "printf '%s\\n' 'Error: EPERM: operation not permitted, open package.json' >&2; exit 1"
                .to_owned();
        let denied_resource = runner.run(&spec, &BTreeMap::new(), None).unwrap();
        assert_eq!(denied_resource.status, CommandStatus::InvalidResult);
        assert!(
            denied_resource
                .result_error
                .as_deref()
                .is_some_and(|error| error.contains("sandbox resource"))
        );

        spec.argv[2] =
            "printf '%s\n' 'Tests  no tests' 'Error: Invalid environment variables' >&2; exit 1"
                .to_owned();
        let uncollected_test = runner.run(&spec, &BTreeMap::new(), None).unwrap();
        assert_eq!(uncollected_test.status, CommandStatus::InvalidResult);
        assert!(
            uncollected_test
                .result_error
                .as_deref()
                .is_some_and(|error| error.contains("test environment"))
        );

        spec.argv[2] =
            "printf '%s\n' 'Startup Error' 'Error: getaddrinfo ENOTFOUND localhost' >&2; exit 1"
                .to_owned();
        let startup_failure = runner.run(&spec, &BTreeMap::new(), None).unwrap();
        assert_eq!(startup_failure.status, CommandStatus::InvalidResult);
        assert!(
            startup_failure
                .result_error
                .as_deref()
                .is_some_and(|error| error.contains("runtime failed during startup"))
        );

        spec.argv[2] = "printf '%s\\n' 'FAIL named behavior assertion'; exit 1".to_owned();
        let honest_red = runner.run(&spec, &BTreeMap::new(), None).unwrap();
        assert_eq!(honest_red.status, CommandStatus::Passed);
        assert!(honest_red.result_error.is_none());
    }

    #[test]
    fn validates_structured_protocol() {
        let (_temp, runner) = runner();
        let spec = CommandSpec {
            id: "protocol".to_owned(),
            argv: vec![
                "printf".to_owned(),
                "%s\\n".to_owned(),
                r#"{"protocol":"test.v1","verdict":"passed"}"#.to_owned(),
            ],
            cwd: ".".to_owned(),
            timeout_seconds: 5,
            environment: EnvironmentPolicy::default(),
            expected_exit_codes: BTreeSet::new(),
            transient_exit_codes: BTreeSet::new(),
            max_attempts: 1,
            result_protocol: Some(ResultProtocol {
                protocol: "test.v1".to_owned(),
                protocol_field: "protocol".to_owned(),
                schema: None,
                required_fields: vec!["verdict".to_owned()],
                line_prefix: None,
                result_path: None,
            }),
            artifact_paths: Vec::new(),
        };
        let receipt = runner.run(&spec, &BTreeMap::new(), None).unwrap();
        assert_eq!(receipt.status, CommandStatus::Passed);
    }

    #[test]
    fn parses_pretty_multiline_protocol_document() {
        let protocol = ResultProtocol {
            protocol: "test.v1".to_owned(),
            protocol_field: "protocol".to_owned(),
            schema: None,
            required_fields: vec!["verdict".to_owned()],
            line_prefix: None,
            result_path: None,
        };
        let stdout = r#"
{
  "protocol": "test.v1",
  "verdict": "passed"
}
"#;

        let result = parse_protocol_result(stdout, &protocol).unwrap();

        assert_eq!(result["verdict"], "passed");
    }

    #[test]
    fn falls_back_to_protocol_matching_json_line_amid_noise() {
        let protocol = ResultProtocol {
            protocol: "test.v1".to_owned(),
            protocol_field: "protocol".to_owned(),
            schema: None,
            required_fields: vec!["verdict".to_owned()],
            line_prefix: None,
            result_path: None,
        };
        let stdout = concat!(
            "starting verifier\n",
            "{\"protocol\":\"other.v1\",\"verdict\":\"passed\"}\n",
            "not json\n",
            "{\"protocol\":\"test.v1\",\"verdict\":\"failed\"}\n",
        );

        let result = parse_protocol_result(stdout, &protocol).unwrap();

        assert_eq!(result["verdict"], "failed");
    }

    #[test]
    fn rejects_protocol_objects_that_fail_the_configured_schema() {
        let protocol = ResultProtocol {
            protocol: "test.v1".to_owned(),
            protocol_field: "protocol".to_owned(),
            schema: Some(serde_json::json!({
                "type": "object",
                "required": ["protocol", "verdict", "measurements"],
                "properties": {
                    "protocol": {"const": "test.v1"},
                    "verdict": {"enum": ["passed", "failed"]},
                    "measurements": {"type": "object", "minProperties": 1}
                }
            })),
            required_fields: vec!["verdict".to_owned(), "measurements".to_owned()],
            line_prefix: None,
            result_path: None,
        };

        let empty_measurements = r#"{"protocol":"test.v1","verdict":"passed","measurements":{}}"#;
        let unknown_verdict =
            r#"{"protocol":"test.v1","verdict":"unknown","measurements":{"n":1}}"#;

        assert!(parse_protocol_result(empty_measurements, &protocol).is_err());
        assert!(parse_protocol_result(unknown_verdict, &protocol).is_err());
    }

    #[test]
    fn configured_result_file_may_create_parent_and_never_falls_back_to_stdout() {
        let (temp, runner) = runner();
        let valid = r#"{"protocol":"test.v1","verdict":"passed"}"#;
        let script = format!(
            "import pathlib; p=pathlib.Path('results/result.json'); p.parent.mkdir(parents=True, exist_ok=True); p.write_text({valid:?})"
        );
        let spec = CommandSpec {
            id: "result-file".to_owned(),
            argv: vec!["python3".to_owned(), "-c".to_owned(), script],
            cwd: ".".to_owned(),
            timeout_seconds: 5,
            environment: EnvironmentPolicy::default(),
            expected_exit_codes: BTreeSet::new(),
            transient_exit_codes: BTreeSet::new(),
            max_attempts: 1,
            result_protocol: Some(ResultProtocol {
                protocol: "test.v1".to_owned(),
                protocol_field: "protocol".to_owned(),
                schema: None,
                required_fields: vec!["verdict".to_owned()],
                line_prefix: None,
                result_path: Some("results/result.json".to_owned()),
            }),
            artifact_paths: Vec::new(),
        };
        let receipt = runner.run(&spec, &BTreeMap::new(), None).unwrap();
        assert_eq!(receipt.status, CommandStatus::Passed);
        assert_eq!(receipt.result_source.as_ref().unwrap().kind, "file");
        assert_eq!(
            receipt.result_source.as_ref().unwrap().path.as_deref(),
            Some("results/result.json")
        );
        assert!(temp.path().join("results/result.json").is_file());

        let mut missing = spec;
        missing.id = "missing-result-file".to_owned();
        missing.argv = vec!["printf".to_owned(), "%s".to_owned(), valid.to_owned()];
        missing.result_protocol.as_mut().unwrap().result_path =
            Some("results/missing.json".to_owned());
        let receipt = runner.run(&missing, &BTreeMap::new(), None).unwrap();
        assert_eq!(receipt.status, CommandStatus::InvalidResult);
        assert!(receipt.result.is_none());
    }

    #[test]
    fn static_artifacts_are_nonempty_regular_files_with_raw_sha256() {
        let (temp, runner) = runner();
        fs::write(temp.path().join("artifact.txt"), b"payload").unwrap();
        let base = CommandSpec {
            id: "artifact".to_owned(),
            argv: vec!["true".to_owned()],
            cwd: ".".to_owned(),
            timeout_seconds: 5,
            environment: EnvironmentPolicy::default(),
            expected_exit_codes: BTreeSet::new(),
            transient_exit_codes: BTreeSet::new(),
            max_attempts: 1,
            result_protocol: None,
            artifact_paths: vec!["artifact.txt".to_owned()],
        };
        let receipt = runner.run(&base, &BTreeMap::new(), None).unwrap();
        assert_eq!(receipt.status, CommandStatus::Passed);
        let expected_hash = raw_sha256(b"payload");
        assert_eq!(
            receipt.artifacts[0].hash.as_deref(),
            Some(expected_hash.as_str())
        );

        for path in ["missing.txt", "empty.txt", "directory"] {
            if path == "empty.txt" {
                fs::write(temp.path().join(path), b"").unwrap();
            } else if path == "directory" {
                fs::create_dir(temp.path().join(path)).unwrap();
            }
            let mut invalid = base.clone();
            invalid.artifact_paths = vec![path.to_owned()];
            let receipt = runner.run(&invalid, &BTreeMap::new(), None).unwrap();
            assert_eq!(receipt.status, CommandStatus::InvalidResult, "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn artifacts_reject_symlink_aliases() {
        use std::os::unix::fs::symlink;

        let (temp, runner) = runner();
        fs::write(temp.path().join("real.txt"), b"payload").unwrap();
        symlink("real.txt", temp.path().join("alias.txt")).unwrap();
        let receipt = artifact_receipt(temp.path(), "alias.txt").unwrap();
        assert!(receipt.error.unwrap().contains("symlink"));

        fs::create_dir(temp.path().join("real-results")).unwrap();
        fs::write(
            temp.path().join("real-results/result.json"),
            r#"{"protocol":"test.v1","verdict":"passed"}"#,
        )
        .unwrap();
        symlink("real-results", temp.path().join("linked-results")).unwrap();
        let protocol = ResultProtocol {
            protocol: "test.v1".to_owned(),
            protocol_field: "protocol".to_owned(),
            schema: None,
            required_fields: vec!["verdict".to_owned()],
            line_prefix: None,
            result_path: Some("linked-results/result.json".to_owned()),
        };
        let error = runner
            .result_document(&attempt_with_stdout(""), &protocol, &BTreeMap::new())
            .expect_err("result paths may not traverse a symlink");
        assert!(error.to_string().contains("symlink"));
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_rooted_open_pins_parent_and_rejects_final_component_swaps() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let scope = temp.path().join("scope");
        let pinned = temp.path().join("pinned-scope");
        let outside = temp.path().join("outside");
        fs::create_dir(&scope).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(scope.join("result.txt"), b"inside").unwrap();
        fs::write(outside.join("result.txt"), b"outside").unwrap();
        let deadline = Instant::now().checked_add(Duration::from_secs(5)).unwrap();

        let opened =
            securely_open_project_regular_file(temp.path(), "scope/result.txt", deadline, || {
                fs::rename(&scope, &pinned).unwrap();
                symlink(&outside, &scope).unwrap();
            })
            .expect("the opened parent descriptor must remain pinned after a path swap");
        let streamed = stream_opened_regular_file(opened, 64, deadline, true, |_| Ok(()))
            .expect("the pinned descriptor must read the original file");
        assert_eq!(streamed.bytes, b"inside");

        fs::remove_file(&scope).unwrap();
        fs::rename(&pinned, &scope).unwrap();
        fs::write(temp.path().join("outside.txt"), b"outside").unwrap();
        let error =
            securely_open_project_regular_file(temp.path(), "scope/result.txt", deadline, || {
                fs::remove_file(scope.join("result.txt")).unwrap();
                symlink("../outside.txt", scope.join("result.txt")).unwrap();
            })
            .expect_err("a final-component symlink swap must not be followed");
        assert!(error.to_string().contains("symlink"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn fifo_evidence_is_rejected_without_waiting_for_a_writer() {
        let (temp, runner) = runner();
        create_fifo(&temp.path().join("artifact.pipe"));
        create_fifo(&temp.path().join("result.pipe"));
        let started = Instant::now();

        let artifact = artifact_receipt(temp.path(), "artifact.pipe").unwrap();
        assert!(artifact.exists);
        assert!(artifact.hash.is_none());
        assert!(
            artifact
                .error
                .as_deref()
                .is_some_and(|error| error.contains("regular file")),
            "{artifact:?}"
        );

        let protocol = ResultProtocol {
            protocol: "test.v1".to_owned(),
            protocol_field: "protocol".to_owned(),
            schema: None,
            required_fields: vec!["verdict".to_owned()],
            line_prefix: None,
            result_path: Some("result.pipe".to_owned()),
        };
        let error = runner
            .result_document(&attempt_with_stdout(""), &protocol, &BTreeMap::new())
            .expect_err("a FIFO may not supply a result document");
        assert!(error.to_string().contains("regular file"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "nonblocking FIFO rejection took {:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn artifact_hashing_is_fixed_buffer_bounded_and_rejects_growth() {
        let temp = tempfile::tempdir().unwrap();
        let oversized = temp.path().join("oversized.bin");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_CHECK_ARTIFACT_BYTES + 1)
            .unwrap();
        let receipt = artifact_receipt(temp.path(), "oversized.bin").unwrap();
        assert_eq!(receipt.size_bytes, Some(MAX_CHECK_ARTIFACT_BYTES + 1));
        assert!(receipt.hash.is_none());
        assert!(
            receipt
                .error
                .as_deref()
                .is_some_and(|error| error.contains("maximum")),
            "{receipt:?}"
        );

        let sparse_size = 3 * 1024 * 1024 + 17;
        fs::File::create(temp.path().join("sparse.bin"))
            .unwrap()
            .set_len(sparse_size)
            .unwrap();
        let receipt = artifact_receipt(temp.path(), "sparse.bin").unwrap();
        let block = [0_u8; 64 * 1024];
        let mut remaining = sparse_size;
        let mut hasher = Sha256::new();
        while remaining > 0 {
            let count = usize::try_from(remaining.min(block.len() as u64)).unwrap();
            hasher.update(&block[..count]);
            remaining -= count as u64;
        }
        let expected_hash = format!("sha256:{}", hex::encode(hasher.finalize()));
        assert_eq!(receipt.size_bytes, Some(sparse_size));
        assert_eq!(receipt.hash.as_deref(), Some(expected_hash.as_str()));
        assert!(receipt.error.is_none());

        let growing_path = temp.path().join("growing.bin");
        fs::write(&growing_path, b"payload").unwrap();
        let deadline = Instant::now().checked_add(Duration::from_secs(5)).unwrap();
        let opened =
            securely_open_project_regular_file(temp.path(), "growing.bin", deadline, || {})
                .unwrap();
        let error =
            stream_opened_regular_file(opened, MAX_CHECK_ARTIFACT_BYTES, deadline, false, |_| {
                fs::OpenOptions::new()
                    .write(true)
                    .open(&growing_path)?
                    .set_len(8)
            })
            .expect_err("a file that grows after fstat must fail closed");
        assert!(
            error.to_string().contains("grew") || error.to_string().contains("size changed"),
            "{error}"
        );

        let same_size_path = temp.path().join("same-size.bin");
        fs::write(&same_size_path, b"payload").unwrap();
        let opened =
            securely_open_project_regular_file(temp.path(), "same-size.bin", deadline, || {})
                .unwrap();
        let error =
            stream_opened_regular_file(opened, MAX_CHECK_ARTIFACT_BYTES, deadline, false, |_| {
                thread::sleep(Duration::from_millis(2));
                fs::write(&same_size_path, b"changed")
            })
            .expect_err("a same-size concurrent rewrite must fail closed");
        assert!(error.to_string().contains("timestamps changed"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn artifact_postprocessing_deadline_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("artifact.bin"), b"payload").unwrap();
        let started = Instant::now();

        let receipt =
            artifact_receipt_with_deadline(temp.path(), "artifact.bin", Instant::now()).unwrap();

        assert!(receipt.exists);
        assert!(receipt.hash.is_none());
        assert!(
            receipt
                .error
                .as_deref()
                .is_some_and(|error| error.contains("deadline")),
            "{receipt:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn rejects_path_escape() {
        let (_temp, runner) = runner();
        let spec = CommandSpec {
            id: "escape".to_owned(),
            argv: vec!["true".to_owned()],
            cwd: "..".to_owned(),
            timeout_seconds: 5,
            environment: EnvironmentPolicy::default(),
            expected_exit_codes: BTreeSet::new(),
            transient_exit_codes: BTreeSet::new(),
            max_attempts: 1,
            result_protocol: None,
            artifact_paths: Vec::new(),
        };
        assert!(runner.run(&spec, &BTreeMap::new(), None).is_err());
    }
}
