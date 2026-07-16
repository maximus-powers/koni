use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use koni_core::ProfileCompiler;
use koni_core::config::{CheckDef, ComposedReplayPolicy, ProcessEffect, ReceiptFreshness};
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
    let integrity = &profile.checks["scientific-result-integrity"];
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
    assert_eq!(gate.composed_replay, ComposedReplayPolicy::Required);
    assert_eq!(gate.effect, ProcessEffect::ReadOnly);
    assert_eq!(scientific.receipt_freshness, ReceiptFreshness::Current);
    assert_eq!(scientific.composed_replay, ComposedReplayPolicy::Never);
    assert_eq!(scientific.effect, ProcessEffect::WorkspaceWrite);
    assert_eq!(integrity.composed_replay, ComposedReplayPolicy::Required);
    assert_eq!(integrity.effect, ProcessEffect::ReadOnly);
    assert_eq!(integrity.receipt_type, "runtime.integrity-receipt");
    assert_eq!(
        integrity
            .command_source
            .as_ref()
            .map(|source| source.field.as_str()),
        Some("runtime_contract.composed_verification_command")
    );
    let experiment_run_step = profile.workflows["run-experiment-runtime"]
        .steps
        .iter()
        .find(|step| step.id == "run")
        .expect("experiment runtime step");
    assert_eq!(
        experiment_run_step.checks,
        ["scientific-runtime", "scientific-result-integrity"]
    );
    let gate_run_step = profile.workflows["run-gate-runtime"]
        .steps
        .iter()
        .find(|step| step.id == "run")
        .expect("gate runtime step");
    assert_eq!(gate_run_step.checks, ["gate-verifier"]);

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

#[test]
fn research_context_action_includes_every_living_spec_layer() -> Result<(), Box<dyn Error>> {
    let repository = repository_root();
    let source = repository.join("profiles/research/actions/research.yaml");
    let installed = repository.join("crates/koni-cli/templates/research/actions/research.yaml");
    let source_bytes = fs::read(source)?;
    let installed_bytes = fs::read(installed)?;

    assert_eq!(source_bytes, installed_bytes);
    let document: serde_yaml::Value = serde_yaml::from_slice(&source_bytes)?;
    let context = document["actions"]
        .as_sequence()
        .expect("research actions are a sequence")
        .iter()
        .find(|action| action["id"].as_str() == Some("context"))
        .expect("research profile declares the context action");
    let context_compile = context["recipe"]
        .as_sequence()
        .expect("context action recipe is a sequence")
        .iter()
        .find(|step| step["primitive"].as_str() == Some("context.compile"))
        .expect("context action compiles one context pack");
    let included = context_compile["include"]
        .as_sequence()
        .expect("research context declares its included sections")
        .iter()
        .map(|section| section.as_str().expect("context section is a string"))
        .collect::<Vec<_>>();

    assert_eq!(
        included,
        vec![
            "graph_closure",
            "spec_slice",
            "intent_updates",
            "working_memory",
            "ticket",
            "contracts",
            "outputs",
            "review",
            "steering",
        ]
    );
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
