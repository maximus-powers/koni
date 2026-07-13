use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{KoniError, Result, io_error};
use crate::graph::normalized_hash;

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
        let max_attempts = spec.max_attempts.max(1);
        let mut attempts = Vec::new();
        let mut parsed_result = None;
        let mut result_source = None;
        let mut result_error = None;
        let mut final_status = CommandStatus::Failed;

        for attempt in 1..=max_attempts {
            if stop_file.is_some_and(Path::exists) {
                final_status = CommandStatus::Interrupted;
                break;
            }
            let receipt = run_attempt(
                &argv,
                &cwd,
                &environment,
                Duration::from_secs(spec.timeout_seconds.max(1)),
                stop_file,
                attempt,
            )?;
            let exit_code = receipt.exit_code;
            let retry = exit_code.is_some_and(|code| spec.transient_exit_codes.contains(&code))
                && attempt < max_attempts;
            if receipt.interrupted {
                final_status = CommandStatus::Interrupted;
            } else if receipt.timed_out {
                final_status = CommandStatus::TimedOut;
            } else if exit_code.is_some_and(|code| expected.contains(&code)) {
                if let Some(protocol) = &spec.result_protocol {
                    match self.result_document(&receipt.stdout, protocol, variables) {
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
        stdout: &str,
        protocol: &ResultProtocol,
        variables: &BTreeMap<String, String>,
    ) -> Result<(String, ResultSourceReceipt)> {
        if let Some(configured) = &protocol.result_path {
            let configured = interpolate(configured, variables)?;
            let path = normalized_relative_path(&configured)?;
            let mut component_path = self.root.clone();
            for component in Path::new(&path).components() {
                component_path.push(component.as_os_str());
                if fs::symlink_metadata(&component_path)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    return Err(KoniError::Process(format!(
                        "configured result path may not traverse a symlink: {path}"
                    )));
                }
            }
            let resolved = contained_path(&self.root, &path)?;
            if !resolved.is_file() {
                return Err(KoniError::Process(format!(
                    "configured result path is not an existing regular file: {path}"
                )));
            }
            let bytes = fs::read(&resolved).map_err(|error| io_error(&resolved, error))?;
            if bytes.is_empty() {
                return Err(KoniError::Process(format!(
                    "configured result path is empty: {path}"
                )));
            }
            let document = String::from_utf8(bytes.clone()).map_err(|_| {
                KoniError::Process(format!(
                    "configured result path is not UTF-8 JSON or JSONL: {path}"
                ))
            })?;
            return Ok((
                document,
                ResultSourceReceipt {
                    kind: "file".to_owned(),
                    path: Some(path),
                    size_bytes: bytes.len() as u64,
                    sha256: raw_sha256(&bytes),
                },
            ));
        }
        let bytes = stdout.as_bytes();
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

fn run_attempt(
    argv: &[String],
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    timeout: Duration,
    stop_file: Option<&Path>,
    attempt: u32,
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
    let mut child = command
        .spawn()
        .map_err(|error| KoniError::Process(format!("failed to spawn {}: {error}", argv[0])))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| KoniError::Process("missing stdout pipe".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| KoniError::Process("missing stderr pipe".to_owned()))?;
    let stdout_reader = thread::spawn(move || read_all(stdout));
    let stderr_reader = thread::spawn(move || read_all(stderr));
    let mut timed_out = false;
    let mut interrupted = false;
    let exit_code = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| KoniError::Process(error.to_string()))?
        {
            break status.code();
        }
        if stop_file.is_some_and(Path::exists) {
            interrupted = true;
            child.kill().map_err(|error| {
                KoniError::Process(format!("failed to interrupt process: {error}"))
            })?;
            break child
                .wait()
                .map_err(|error| KoniError::Process(error.to_string()))?
                .code();
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            child.kill().map_err(|error| {
                KoniError::Process(format!("failed to time out process: {error}"))
            })?;
            break child
                .wait()
                .map_err(|error| KoniError::Process(error.to_string()))?
                .code();
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| KoniError::Process("stdout reader panicked".to_owned()))?
        .map_err(|error| KoniError::Process(format!("could not read stdout: {error}")))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| KoniError::Process("stderr reader panicked".to_owned()))?
        .map_err(|error| KoniError::Process(format!("could not read stderr: {error}")))?;
    Ok(AttemptReceipt {
        attempt,
        exit_code,
        timed_out,
        interrupted,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        stdout_hash: raw_sha256(&stdout),
        stderr_hash: raw_sha256(&stderr),
        duration_ms: started.elapsed().as_millis(),
    })
}

fn read_all(mut reader: impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;
    Ok(bytes)
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
    let mut candidates = Vec::new();
    let document = stdout.trim();
    let document_value = protocol
        .line_prefix
        .is_none()
        .then(|| serde_json::from_str::<Value>(document).ok())
        .flatten();
    if let Some(value) = document_value {
        candidates.push(value);
    } else {
        for line in stdout.lines() {
            let line = if let Some(prefix) = &protocol.line_prefix {
                let Some(line) = line.strip_prefix(prefix) else {
                    continue;
                };
                line.trim()
            } else {
                line.trim()
            };
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                candidates.push(value);
            }
        }
    }
    let value = candidates
        .into_iter()
        .rev()
        .find(|value| {
            value.get(&protocol.protocol_field).and_then(Value::as_str) == Some(&protocol.protocol)
        })
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

pub(crate) fn artifact_receipt(root: &Path, path: &str) -> Result<ArtifactReceipt> {
    let path = normalized_relative_path(path)?;
    let mut component_path = root.to_path_buf();
    for component in Path::new(&path).components() {
        component_path.push(component.as_os_str());
        if fs::symlink_metadata(&component_path)
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Ok(ArtifactReceipt {
                path,
                exists: component_path.exists(),
                size_bytes: None,
                hash: None,
                error: Some("artifact path may not traverse a symlink".to_owned()),
            });
        }
    }
    let resolved = contained_path(root, &path)?;
    if !resolved.exists() {
        return Ok(ArtifactReceipt {
            path,
            exists: false,
            size_bytes: None,
            hash: None,
            error: Some("artifact does not exist".to_owned()),
        });
    }
    if !resolved.is_file() {
        return Ok(ArtifactReceipt {
            path,
            exists: true,
            size_bytes: None,
            hash: None,
            error: Some("artifact is not a regular file".to_owned()),
        });
    }
    let bytes = fs::read(&resolved).map_err(|error| io_error(&resolved, error))?;
    if bytes.is_empty() {
        return Ok(ArtifactReceipt {
            path,
            exists: true,
            size_bytes: Some(0),
            hash: Some(raw_sha256(&bytes)),
            error: Some("artifact is empty".to_owned()),
        });
    }
    Ok(ArtifactReceipt {
        path,
        exists: true,
        size_bytes: Some(bytes.len() as u64),
        hash: Some(raw_sha256(&bytes)),
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
            .result_document("", &protocol, &BTreeMap::new())
            .expect_err("result paths may not traverse a symlink");
        assert!(error.to_string().contains("symlink"));
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
