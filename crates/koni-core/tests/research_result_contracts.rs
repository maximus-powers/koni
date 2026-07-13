use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use koni_core::ProfileCompiler;
use koni_core::config::CheckDef;
use koni_core::process::{
    CommandRunner, CommandSpec, CommandStatus, EnvironmentPolicy, ResultProtocol,
};
use serde_json::{Value, json};
use tempfile::TempDir;

#[test]
fn command_result_parser_accepts_pretty_json_and_jsonl_noise() -> Result<(), Box<dyn Error>> {
    let profile = ProfileCompiler::compile(&profile_root())?;
    let gate = &profile.checks["gate-verifier"];
    let temp = TempDir::new()?;
    let runner = CommandRunner::new(temp.path().to_path_buf());
    let result = json!({
        "schema_version": "1.0",
        "protocol": "autoresearch.gate-result.v1",
        "gate_id": "gate-1",
        "verdict": "passed",
        "measurements": {"agreement": 1.0}
    });

    assert_eq!(
        run_stdout(&runner, gate, serde_json::to_string_pretty(&result)?)?,
        CommandStatus::Passed
    );
    let noisy_jsonl = format!(
        "starting verifier\n{}\nnot json\n{}\n",
        json!({"protocol": "unrelated.v1", "verdict": "passed"}),
        result
    );
    assert_eq!(
        run_stdout(&runner, gate, noisy_jsonl)?,
        CommandStatus::Passed
    );

    Ok(())
}

#[test]
fn research_result_schemas_reject_malformed_typed_results() -> Result<(), Box<dyn Error>> {
    let profile = ProfileCompiler::compile(&profile_root())?;
    let gate = &profile.checks["gate-verifier"];
    let scientific = &profile.checks["scientific-runtime"];
    let temp = TempDir::new()?;
    let runner = CommandRunner::new(temp.path().to_path_buf());

    assert_eq!(gate.result_identity_field.as_deref(), Some("gate_id"));
    let gate_acceptance = gate
        .result_acceptance
        .as_ref()
        .expect("gate result acceptance is configured");
    assert_eq!(gate_acceptance.field, "verdict");
    assert_eq!(&gate_acceptance.values, &vec![json!("passed")]);
    assert!(gate.allow_nonpassing_receipt);

    assert_eq!(
        run_result(
            &runner,
            gate,
            json!({
                "schema_version": "1.0",
                "protocol": "autoresearch.gate-result.v1",
                "gate_id": "gate-1",
                "verdict": "passed",
                "measurements": {"agreement": 1.0}
            }),
        )?,
        CommandStatus::Passed
    );
    for malformed in [
        json!({
            "schema_version": "1.0",
            "protocol": "autoresearch.gate-result.v1",
            "gate_id": "gate-1",
            "verdict": "passed",
            "measurements": {}
        }),
        json!({
            "schema_version": "1.0",
            "protocol": "autoresearch.gate-result.v1",
            "gate_id": "gate-1",
            "verdict": "unknown",
            "measurements": {"agreement": 1.0}
        }),
        json!({
            "schema_version": "2.0",
            "protocol": "autoresearch.gate-result.v1",
            "gate_id": "gate-1",
            "verdict": "passed",
            "measurements": {"agreement": 1.0}
        }),
        json!({
            "schema_version": "1.0",
            "protocol": "autoresearch.gate-result.v1",
            "gate_id": " ",
            "verdict": "passed",
            "measurements": {"agreement": 1.0}
        }),
    ] {
        assert_eq!(
            run_result(&runner, gate, malformed)?,
            CommandStatus::InvalidResult
        );
    }

    assert_eq!(
        run_result(
            &runner,
            scientific,
            json!({
                "schema_version": "1.0",
                "protocol": "autoresearch.research-result.v1",
                "verdict": "supported",
                "measurements": {"accuracy": 1.0},
                "observations": [],
                "artifacts": []
            }),
        )?,
        CommandStatus::Passed
    );
    for malformed in [
        json!({
            "schema_version": "1.0",
            "protocol": "autoresearch.research-result.v1",
            "verdict": "supported",
            "measurements": {},
            "observations": [],
            "artifacts": []
        }),
        json!({
            "schema_version": "1.0",
            "protocol": "autoresearch.research-result.v1",
            "verdict": "proved",
            "measurements": {"accuracy": 1.0},
            "observations": [],
            "artifacts": []
        }),
        json!({
            "schema_version": "1.0",
            "protocol": "autoresearch.research-result.v1",
            "verdict": "supported",
            "measurements": {"accuracy": 1.0},
            "observations": {},
            "artifacts": []
        }),
        json!({
            "schema_version": "1.0",
            "protocol": "autoresearch.research-result.v1",
            "verdict": "supported",
            "measurements": {"accuracy": 1.0},
            "observations": [],
            "artifacts": {}
        }),
    ] {
        assert_eq!(
            run_result(&runner, scientific, malformed)?,
            CommandStatus::InvalidResult
        );
    }

    Ok(())
}

#[test]
fn installed_research_checks_byte_match_the_source_profile() -> Result<(), Box<dyn Error>> {
    let repository = repository_root();
    let source = repository.join("profiles/research/checks/research.yaml");
    let installed = repository.join("crates/koni-cli/templates/research/checks/research.yaml");

    assert_eq!(fs::read(source)?, fs::read(installed)?);
    Ok(())
}

fn run_result(
    runner: &CommandRunner,
    check: &CheckDef,
    result: Value,
) -> Result<CommandStatus, Box<dyn Error>> {
    run_stdout(runner, check, result.to_string())
}

fn run_stdout(
    runner: &CommandRunner,
    check: &CheckDef,
    stdout: String,
) -> Result<CommandStatus, Box<dyn Error>> {
    let protocol = check
        .result_protocol
        .as_ref()
        .ok_or_else(|| std::io::Error::other("research command check has no result protocol"))?;
    let spec = CommandSpec {
        id: check.id.clone(),
        argv: vec!["printf".to_owned(), "%s".to_owned(), stdout],
        cwd: ".".to_owned(),
        timeout_seconds: 5,
        environment: EnvironmentPolicy::default(),
        expected_exit_codes: BTreeSet::new(),
        transient_exit_codes: BTreeSet::new(),
        max_attempts: 1,
        result_protocol: Some(ResultProtocol {
            protocol: protocol.clone(),
            protocol_field: check.result_protocol_field.clone(),
            schema: check.result_schema.clone(),
            required_fields: check.required_result_fields.clone(),
            line_prefix: check.result_line_prefix.clone(),
            result_path: None,
        }),
        artifact_paths: Vec::new(),
    };

    Ok(runner.run(&spec, &BTreeMap::new(), None)?.status)
}

fn profile_root() -> PathBuf {
    repository_root().join("profiles/research")
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}
