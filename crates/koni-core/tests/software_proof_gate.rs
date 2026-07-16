use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use git2::{IndexAddOption, Repository, Signature};
use koni_core::git::GitBackend;
use koni_core::graph::Node;
use koni_core::state::{StateStore, Ticket};
use koni_core::{
    AgentProcessLauncher, AgentProcessRequest, AgentProcessResult, Engine, ProjectCatalogCompiler,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use walkdir::WalkDir;

#[test]
fn software_architecture_contract_and_work_classification_are_conditional()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Make one bounded fixture change")?;
    let mut objective = fixture.objective()?;

    fixture.compile("objective without an affected system")?;
    assert_eq!(
        fixture.open_ticket_count("map-architecture")?,
        1,
        "an objective with no affected repository boundary needs architecture discovery"
    );

    let mut system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    fixture.save_nodes([objective.clone(), system.clone()])?;
    fixture.compile("objective with a contract-free system")?;
    assert_eq!(fixture.open_ticket_count("map-architecture")?, 0);
    assert_eq!(
        fixture.open_ticket_count("specify-contracts")?,
        0,
        "a local boundary that explicitly needs no contract must not create ceremony"
    );

    system
        .spec_object_mut()
        .insert("contract_required".to_owned(), Value::Bool(true));
    system.spec_object_mut().insert(
        "contract_reason".to_owned(),
        Value::String("A public compatibility promise now constrains the boundary.".to_owned()),
    );
    fixture.save_nodes([system.clone()])?;
    fixture.compile("system newly marked contract-requiring")?;
    assert_eq!(fixture.open_ticket_count("specify-contracts")?, 1);

    let contract = contract_for(&system.id);
    fixture.save_nodes([contract])?;
    fixture.compile("system with its material contract")?;
    assert_eq!(
        fixture.open_ticket_count("specify-contracts")?,
        0,
        "a current material contract closes the conditional contract gap"
    );

    let change = material_change(
        "Bounded routine change",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    let mut proof = semantic_proof("Focused routine proof", "focused", "planned", [&change.id]);
    fixture.save_nodes([change.clone(), proof.clone()])?;
    fixture.compile("unclassified routine change")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0
    );
    assert_eq!(
        fixture.open_ticket_count("plan-change")?,
        1,
        "legacy initialization remains valid, but missing work_kind routes back to planning"
    );

    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    fixture.save_nodes([objective])?;
    fixture.compile("classified routine change")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        1,
        "a classified routine change with one active focused proof is implementation-ready"
    );

    proof.status = "superseded".to_owned();
    fixture.save_nodes([proof])?;
    fixture.compile("routine change after its only proof is superseded")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0,
        "a historical proof must not satisfy active design readiness"
    );
    assert_eq!(fixture.open_ticket_count("plan-change")?, 1);

    Ok(())
}

#[test]
fn software_proof_oracle_seams_are_explicit_read_only_ticket_scope() -> Result<(), Box<dyn Error>> {
    let profile_root = software_profile_root();
    let graph_contract = fs::read_to_string(profile_root.join("graph.yaml"))?;
    assert!(fs::read_to_string(profile_root.join("profile.yaml"))?.contains("version: \"0.6.0\""));
    assert!(
        graph_contract.contains("disjoint_from: spec.covered_paths"),
        "proof source paths must be authority-disjoint from covered product paths"
    );
    assert!(
        graph_contract.contains("unique_by: id"),
        "oracle case IDs must be compiler-enforced unique"
    );
    assert!(
        graph_contract.contains("same normalized project-relative path identity"),
        "the authored contract must describe normalized path identity"
    );
    for module in [
        "graph.yaml",
        "rules.yaml",
        "operations.yaml",
        "workflows.yaml",
    ] {
        assert!(
            fs::read_to_string(profile_root.join(module))?.contains("version: 0.6.0"),
            "{module} must identify the breaking Software-0.6 preparation gate"
        );
    }
    assert!(
        fs::read_to_string(profile_root.join("checks.yaml"))?.contains("version: 0.4.0"),
        "unchanged checks must retain their independent module version"
    );
    for persona in [
        "run-planner.toml",
        "change-designer.toml",
        "risk-analyst.toml",
        "reviewer.toml",
        "implementer.toml",
    ] {
        let instructions = fs::read_to_string(software_codex_agents_root().join(persona))?;
        assert!(instructions.contains("oracle_cases"), "{persona}");
        assert!(instructions.contains("seam_paths"), "{persona}");
        assert!(instructions.contains("covered_paths"), "{persona}");
        assert!(
            instructions.contains("normalized") && instructions.contains("project-relative"),
            "{persona} must teach the compiler's normalized path identity"
        );
    }
    for run_type in [
        "small.yaml",
        "medium.yaml",
        "large.yaml",
        "new-feature.yaml",
        "bug-fix.yaml",
    ] {
        let instructions = fs::read_to_string(profile_root.join("run-types").join(run_type))?;
        assert!(instructions.contains("oracle_cases"), "{run_type}");
        assert!(instructions.contains("seam_paths"), "{run_type}");
        assert!(instructions.contains("covered_paths"), "{run_type}");
        assert!(
            instructions.contains("normalized") && instructions.contains("project-relative"),
            "{run_type} must teach the compiler's normalized path identity"
        );
    }

    let mut fixture = SoftwareFixture::new("Diagnose one bounded production seam")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("bug_fix".to_owned()));

    let mut system = fixture_system(false);
    system.spec_object_mut().insert(
        "owned_paths".to_owned(),
        json!(["src/seam.rs", "src/unrelated.rs"]),
    );
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);

    let defect = defect(&objective.id, &system.id, "unresolved");
    let mut proof = semantic_proof(
        "Exact production-seam diagnostic",
        "focused",
        "planned",
        [&defect.id],
    );
    proof
        .edges
        .insert("uses".to_owned(), vec![system.id.clone()]);
    proof.spec_object_mut().insert(
        "oracle_cases".to_owned(),
        json!([{
            "id": "production-seam",
            "condition": "The bounded fixture condition is false.",
            "claim": "The production seam returns the bounded false signal.",
            "production_seam": "src/seam.rs::seam",
            "seam_paths": ["src/seam.rs"],
            "action": "Invoke seam() through the repository-owned proof source.",
            "assertions": [
                "The returned signal is false.",
                "The unrelated production boundary is not invoked."
            ],
            "environment": "The isolated Software fixture.",
            "recipe": ["Load the callable production seam.", "Invoke seam()."]
        }]),
    );

    fixture.save_nodes([objective, system, defect, proof.clone()])?;
    let error = fixture
        .compile("proof whose production seam is absent from covered paths")
        .expect_err("an unbound oracle seam must fail before ticket dispatch");
    let error = error.to_string();
    assert!(
        error.contains("oracle_cases[0].seam_paths")
            && error.contains("covered_paths")
            && error.contains("src/seam.rs"),
        "unexpected oracle coverage diagnostic: {error}"
    );
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &proof.id)?,
        0,
        "invalid seam coverage must not emit a proof-preparation ticket"
    );

    proof.spec_object_mut().insert(
        "covered_paths".to_owned(),
        json!(["src/lib.rs", "src/seam.rs", "tests"]),
    );
    fixture.save_nodes([proof.clone()])?;
    let error = fixture
        .compile("proof whose source and covered authority overlap")
        .expect_err("overlapping source and product authority must fail before dispatch")
        .to_string();
    assert!(
        error.contains("source_paths")
            && error.contains("must be disjoint")
            && error.contains("covered_paths"),
        "unexpected proof authority diagnostic: {error}"
    );
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &proof.id)?,
        0,
        "overlapping proof authority must not emit a preparation ticket"
    );

    proof.spec_object_mut().insert(
        "covered_paths".to_owned(),
        json!(["src/lib.rs", "src/seam.rs"]),
    );
    let duplicate_case = proof
        .spec
        .get("oracle_cases")
        .and_then(Value::as_array)
        .and_then(|cases| cases.first())
        .cloned()
        .expect("fixture proof has one oracle case");
    proof
        .spec_object_mut()
        .get_mut("oracle_cases")
        .and_then(Value::as_array_mut)
        .expect("fixture proof oracle cases remain a list")
        .push(duplicate_case);
    fixture.save_nodes([proof.clone()])?;
    let error = fixture
        .compile("proof with duplicate oracle case identity")
        .expect_err("duplicate oracle identity must fail before dispatch")
        .to_string();
    assert!(
        error.contains("oracle_cases")
            && error.contains("unique_by id")
            && error.contains("1 duplicate value(s)"),
        "unexpected oracle identity diagnostic: {error}"
    );
    assert!(
        !error.contains("production-seam"),
        "duplicate diagnostics must report shape and count without raw identity: {error}"
    );
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &proof.id)?,
        0,
        "duplicate oracle identity must not emit a preparation ticket"
    );
    proof
        .spec_object_mut()
        .get_mut("oracle_cases")
        .and_then(Value::as_array_mut)
        .expect("fixture proof oracle cases remain a list")
        .truncate(1);

    proof.spec_object_mut().insert(
        "covered_paths".to_owned(),
        json!(["src/lib.rs", "src/seam.rs"]),
    );
    fixture.save_nodes([proof.clone()])?;
    fixture.compile("proof with an explicitly covered production seam")?;

    let ticket = fixture.only_open_ticket_for("prepare-proof", &proof.id)?;
    let author = ticket
        .workflow
        .iter()
        .find(|step| step.id == "author-historical-baseline")
        .expect("proof preparation has a source-authoring step");
    let reads = author
        .read_paths
        .as_ref()
        .expect("proof preparation freezes exact read paths");
    assert!(reads.contains("src/seam.rs"));
    assert!(reads.contains("src/lib.rs"));
    assert!(reads.contains("tests/proof-source.txt"));
    assert!(
        !reads.contains("src/unrelated.rs"),
        "a uses-linked system's unrelated owned path must not become proof capability"
    );
    let baseline_set = author
        .compiled_check_sets
        .iter()
        .find(|set| set.parent_check_id == "baseline-proof-set")
        .expect("proof preparation freezes its compiler-selected baseline set");
    let member = baseline_set
        .members
        .iter()
        .find(|member| member.source_node_id == proof.id)
        .expect("the explicit proof is a baseline-set member");
    assert!(
        member.covered_paths.contains("src/seam.rs"),
        "the production seam must be receipt-bound as covered evidence"
    );
    assert!(
        !member.covered_paths.contains("src/unrelated.rs"),
        "unrelated system ownership must not enter the receipt-bound proof member"
    );
    assert_eq!(
        author.write_paths.as_ref(),
        Some(&BTreeSet::from(["tests/proof-source.txt".to_owned()])),
        "source_paths remain the only proof-preparation write authority"
    );
    assert!(
        !ticket.scope.write_paths.contains("src/seam.rs"),
        "an explicitly covered production seam remains read-only"
    );

    Ok(())
}

#[test]
fn software_proof_authority_rejects_distinct_paths_for_the_same_existing_file()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Reject an aliased proof authority seam")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("bug_fix".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let defect = defect(&objective.id, &system.id, "unresolved");
    let mut proof = semantic_proof(
        "Aliased production-seam diagnostic",
        "focused",
        "planned",
        [&defect.id],
    );
    proof
        .edges
        .insert("uses".to_owned(), vec![system.id.clone()]);
    proof.spec_object_mut().insert(
        "source_paths".to_owned(),
        json!(["tests/seam-hard-link.rs"]),
    );
    proof
        .spec_object_mut()
        .insert("covered_paths".to_owned(), json!(["src/seam.rs"]));
    let oracle = proof
        .spec_object_mut()
        .get_mut("oracle_cases")
        .and_then(Value::as_array_mut)
        .and_then(|cases| cases.first_mut())
        .and_then(Value::as_object_mut)
        .expect("fixture oracle is an object");
    oracle.insert("seam_paths".to_owned(), json!(["src/seam.rs"]));
    oracle.insert(
        "production_seam".to_owned(),
        Value::String("src/seam.rs::seam".to_owned()),
    );
    fs::hard_link(
        fixture.root().join("src/seam.rs"),
        fixture.root().join("tests/seam-hard-link.rs"),
    )?;

    fixture.save_nodes([objective, system, defect, proof.clone()])?;
    let error = fixture
        .compile("proof source is a hard-link alias of covered production")
        .expect_err("same-file aliases must fail before ticket emission")
        .to_string();
    assert!(
        error.contains("source_paths")
            && error.contains("must be disjoint")
            && error.contains("covered_paths"),
        "unexpected filesystem-identity diagnostic: {error}"
    );
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &proof.id)?,
        0,
        "same-file aliases must not receive proof-source write authority"
    );
    Ok(())
}

#[test]
fn software_lease_revalidates_path_identity_after_ticket_emission() -> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Revalidate stale proof authority at lease time")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("bug_fix".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let defect = defect(&objective.id, &system.id, "unresolved");
    let mut proof = semantic_proof(
        "Initially disjoint diagnostic source",
        "focused",
        "planned",
        [&defect.id],
    );
    proof
        .edges
        .insert("uses".to_owned(), vec![system.id.clone()]);
    proof
        .spec_object_mut()
        .insert("covered_paths".to_owned(), json!(["src/seam.rs"]));
    let oracle = proof
        .spec_object_mut()
        .get_mut("oracle_cases")
        .and_then(Value::as_array_mut)
        .and_then(|cases| cases.first_mut())
        .and_then(Value::as_object_mut)
        .expect("fixture oracle is an object");
    oracle.insert("seam_paths".to_owned(), json!(["src/seam.rs"]));
    oracle.insert(
        "production_seam".to_owned(),
        Value::String("src/seam.rs::seam".to_owned()),
    );
    fixture.save_nodes([objective, system, defect, proof.clone()])?;
    fixture.compile("initially disjoint proof authority")?;
    let ticket = fixture.only_open_ticket_for("prepare-proof", &proof.id)?;

    fs::remove_file(fixture.root().join("tests/proof-source.txt"))?;
    fs::hard_link(
        fixture.root().join("src/seam.rs"),
        fixture.root().join("tests/proof-source.txt"),
    )?;
    let error = fixture
        .engine
        .execute_action("start", string_params([("ticket", ticket.id.as_str())]))
        .expect_err("materialized aliases must revoke stale emitted authority")
        .to_string();
    assert!(
        error.contains("graph error") && error.contains("must be disjoint"),
        "unexpected lease-time graph diagnostic: {error}"
    );
    assert!(
        fixture.store.ticket(&ticket.id)?.lease.is_none(),
        "lease admission must fail before creating a worktree lease"
    );
    Ok(())
}

#[test]
fn software_bug_fix_requires_causal_diagnosis_and_an_addressing_change()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Correct the reported fixture defect")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("bug_fix".to_owned()));
    let system = fixture_system(false);
    let system_id = system.id.clone();
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);

    let mut defect = defect(&objective.id, &system.id, "unresolved");
    let mut change = material_change(
        "Correct the causal boundary",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    let mut proof = semantic_proof(
        "Defect regression proof",
        "focused",
        "planned",
        [&change.id, &defect.id],
    );
    set_proof_source_path(&mut proof, "tests/proof-source-secondary.txt");
    let diagnostic = semantic_proof(
        "Causal diagnostic proof",
        "focused",
        "planned",
        [&defect.id],
    );
    fixture.save_nodes([
        objective.clone(),
        system,
        defect.clone(),
        change.clone(),
        proof,
        diagnostic.clone(),
    ])?;
    fixture.compile("bug fix awaiting a reviewed diagnostic preparation")?;
    assert_eq!(
        fixture.open_ticket_count_for("diagnose-defect", &defect.id)?,
        0,
        "authored prepared status cannot substitute for a current reviewed source binding"
    );
    fixture.complete_preparation_ticket(&diagnostic.id, None)?;
    let mut unrelated = Node::new(
        "data_model",
        "Unrelated later graph growth",
        json!({
            "owner": "an unrelated subsystem",
            "shape": "A disconnected semantic node added after the diagnostic review."
        }),
    );
    unrelated.id = "unrelated-data-model-after-preparation".to_owned();
    unrelated
        .edges
        .insert("owned_by".to_owned(), vec![system_id]);
    fixture.save_nodes([unrelated])?;
    fixture.compile("bug fix with unresolved diagnosis")?;
    assert_eq!(
        fixture.open_ticket_count_for("diagnose-defect", &defect.id)?,
        1
    );
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0
    );

    defect.status = "diagnosed".to_owned();
    defect.spec_object_mut().insert(
        "root_cause".to_owned(),
        Value::String("The fixture returns before applying its bounded condition.".to_owned()),
    );
    defect.spec_object_mut().insert(
        "causal_chain".to_owned(),
        json!([
            "input reaches the fixture",
            "the early return skips the condition"
        ]),
    );
    defect.spec_object_mut().insert(
        "ruled_out_alternatives".to_owned(),
        json!(["caller supplied the expected input"]),
    );
    fixture.save_nodes([defect.clone()])?;
    fixture.compile("diagnosed bug fix without an addressing edge")?;
    assert_eq!(
        fixture.open_ticket_count_for("diagnose-defect", &defect.id)?,
        0
    );
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0,
        "diagnosis alone is insufficient until the planned change structurally addresses it"
    );
    assert_eq!(fixture.open_ticket_count("plan-change")?, 1);

    change
        .edges
        .insert("addresses".to_owned(), vec![defect.id.clone()]);
    fixture.save_nodes([change.clone()])?;
    fixture.compile("diagnosed bug fix with an addressing edge")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        1,
        "the diagnosed defect and its causal addressing edge unlock the bounded fix"
    );

    Ok(())
}

#[test]
fn software_bug_fix_bootstraps_prepares_diagnoses_then_plans_the_causal_change()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Ground and repair a previously unmodeled defect")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("bug_fix".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    fixture.save_nodes([objective.clone(), system.clone()])?;
    fixture.compile("bug fix before any defect has been grounded")?;
    assert_eq!(fixture.open_ticket_count("ground-defect")?, 1);
    assert_eq!(fixture.open_ticket_count("plan-change")?, 0);
    assert_eq!(fixture.open_ticket_count("implement-change")?, 0);

    let mut causal_defect = defect(&objective.id, &system.id, "unresolved");
    let mut diagnostic = semantic_proof(
        "Focused diagnostic reproduction",
        "focused",
        "planned",
        [&causal_defect.id],
    );
    configure_expected_red_proof(&mut diagnostic, "tests/diagnostic-proof.txt", "corrected");
    fixture.complete_graph_ticket(
        "ground-defect",
        &objective.id,
        "ground-diagnostic-seam",
        "change-designer",
        [causal_defect.clone(), diagnostic.clone()],
        "The unresolved defect and its one diagnostic seam are honest and contain no speculative change.",
    )?;
    fixture.compile("grounded unresolved defect before source preparation")?;
    assert_eq!(fixture.open_ticket_count("ground-defect")?, 0);
    assert_eq!(fixture.open_ticket_count("diagnose-defect")?, 0);
    assert_eq!(fixture.open_ticket_count("plan-change")?, 0);
    assert_eq!(
        fixture.store.graph()?.nodes_of_type("change").count(),
        0,
        "grounding must not speculate about an addressing change before root cause"
    );

    let preparation = fixture.only_open_ticket_for("prepare-proof", &diagnostic.id)?;
    let preparation_step = preparation
        .workflow
        .iter()
        .find(|step| step.id == "author-historical-baseline")
        .expect("proof preparation has its source-authoring step");
    assert_eq!(
        preparation_step.write_paths.as_ref(),
        Some(&BTreeSet::from(["tests/diagnostic-proof.txt".to_owned()])),
        "preparation writes only the compiler-selected diagnostic proof source"
    );
    assert!(
        !preparation.scope.write_paths.contains("src/lib.rs"),
        "covered production code is never preparation write authority"
    );
    let prepared_members = preparation_step
        .compiled_check_sets
        .iter()
        .find(|set| set.parent_check_id == "baseline-proof-set")
        .expect("preparation pins its historical baseline set");
    assert_eq!(prepared_members.members.len(), 1);
    assert_eq!(prepared_members.members[0].source_node_id, diagnostic.id);
    assert_eq!(
        prepared_members.members[0].child_check_id,
        "proof-expected-red"
    );
    fixture.complete_preparation_ticket(
        &diagnostic.id,
        Some(("tests/diagnostic-proof.txt", "diagnostic proof source\n")),
    )?;
    assert_eq!(
        fixture
            .store
            .graph()?
            .node(&diagnostic.id)
            .map(|proof| proof.status.as_str()),
        Some("prepared")
    );

    fixture.compile("prepared diagnostic before causal diagnosis")?;
    let diagnosis = fixture.only_open_ticket_for("diagnose-defect", &causal_defect.id)?;
    let diagnosis_step = diagnosis
        .workflow
        .iter()
        .find(|step| step.id == "diagnose-cause")
        .expect("diagnosis has its causal graph step");
    assert_eq!(diagnosis_step.write_paths.as_ref(), Some(&BTreeSet::new()));
    assert!(
        diagnosis.scope.write_paths.is_empty(),
        "source authoring is complete before diagnosis and production remains read-only"
    );
    add_causal_diagnosis(&mut causal_defect);
    fixture.complete_graph_ticket(
        "diagnose-defect",
        &causal_defect.id,
        "diagnose-cause",
        "change-designer",
        [causal_defect.clone()],
        "The prepared reproduction supports the first invalid state and reviewed causal chain.",
    )?;
    let graph = fixture.store.graph()?;
    assert_eq!(
        graph
            .node(&causal_defect.id)
            .map(|defect| defect.status.as_str()),
        Some("diagnosed")
    );
    assert_eq!(
        graph
            .node(&diagnostic.id)
            .map(|proof| proof.status.as_str()),
        Some("prepared"),
        "diagnosis review stamps only the defect"
    );

    fixture.compile("diagnosed defect before its causal change is planned")?;
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &diagnostic.id)?,
        0,
        "reviewed causal diagnosis may refine defect fields without revoking the proof-only preparation binding"
    );
    assert_eq!(fixture.open_ticket_count("plan-change")?, 1);
    assert_eq!(fixture.open_ticket_count("implement-change")?, 0);

    let mut change = material_change(
        "Repair the confirmed early return",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    change
        .edges
        .insert("addresses".to_owned(), vec![causal_defect.id.clone()]);
    let focused = semantic_proof(
        "Focused causal repair proof",
        "focused",
        "planned",
        [&change.id, &causal_defect.id],
    );
    fixture.save_nodes([change.clone(), focused])?;
    fixture.compile("diagnosed defect with an exact addressing plan")?;
    assert_eq!(fixture.open_ticket_count("plan-change")?, 0);
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        1
    );
    fixture.complete_implementation_ticket_with_product_change(
        &change.id,
        "src/lib.rs",
        "pub fn value() -> u8 { 2 } // corrected\n",
    )?;
    fixture.compile("implemented repair after historical diagnostic preparation")?;
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &diagnostic.id)?,
        0,
        "covered-product mutation must not re-open the historical expected-red preparation"
    );
    assert_eq!(
        fixture.open_ticket_count_for("establish-proof", &diagnostic.id)?,
        1,
        "the prepared diagnostic proof now advances through current green promotion"
    );
    fixture.complete_proof_ticket(&diagnostic.id)?;
    assert_eq!(
        fixture
            .store
            .graph()?
            .node(&diagnostic.id)
            .map(|proof| proof.status.as_str()),
        Some("passing")
    );
    fixture.compile("reviewed green diagnostic proof after authenticated promotion")?;
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &diagnostic.id)?,
        0,
        "the durable passing successor must retain the historical preparation instead of reopening source authoring"
    );
    assert_eq!(
        fixture.open_ticket_count_for("diagnose-defect", &causal_defect.id)?,
        0,
        "promotion must not reopen the already reviewed causal diagnosis"
    );
    assert_eq!(
        fixture.open_ticket_count_for("establish-proof", &diagnostic.id)?,
        0,
        "the current promotion receipt and authenticated successor must not emit a duplicate proof ticket"
    );

    let mut overlapping_change = material_change(
        "Attempt to overwrite the reviewed diagnostic oracle",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    overlapping_change.spec_object_mut().insert(
        "owned_paths".to_owned(),
        json!(["tests/diagnostic-proof.txt"]),
    );
    overlapping_change
        .edges
        .insert("addresses".to_owned(), vec![causal_defect.id.clone()]);
    let mut overlap_proof = semantic_proof(
        "Disjoint proof for the forbidden oracle overwrite",
        "focused",
        "planned",
        [&overlapping_change.id],
    );
    overlap_proof.spec_object_mut().insert(
        "covered_paths".to_owned(),
        json!(["tests/diagnostic-proof.txt", "src/lib.rs"]),
    );
    fixture.save_nodes([overlapping_change, overlap_proof])?;
    let overlap = fixture
        .compile("planned product authority overlapping a promoted prepared source")
        .expect_err("promotion must retain the global prepared-source lock");
    let overlap = overlap.to_string();
    assert!(
        overlap.contains("overlaps current prepared proof source")
            && overlap.contains("tests/diagnostic-proof.txt"),
        "unexpected retained-source diagnostic: {overlap}"
    );

    Ok(())
}

#[test]
fn software_prompt_conforming_unresolved_bug_fix_seed_compiles_without_a_speculative_change()
-> Result<(), Box<dyn Error>> {
    let raw_bug_fix = fs::read_to_string(software_profile_root().join("run-types/bug-fix.yaml"))?;
    assert!(raw_bug_fix.contains("Add exactly one focused diagnostic proof"));
    assert!(raw_bug_fix.contains("Do not seed a speculative change"));
    assert!(raw_bug_fix.contains("An unresolved defect compiles bounded diagnosis"));

    let mut fixture = SoftwareFixture::new("Repair one reported fixture defect")?;
    let catalog = ProjectCatalogCompiler::compile(fixture.root())?;
    let resolved_bug_fix = catalog
        .run_type("bug-fix")
        .expect("the installed Software catalog resolves Bug Fix");
    let resolved_contract = serde_json::to_string(resolved_bug_fix)?;
    assert!(resolved_contract.contains("Add exactly one focused diagnostic proof"));
    assert!(resolved_contract.contains("Do not seed a speculative change"));

    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("bug_fix".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let unresolved = defect(&objective.id, &system.id, "unresolved");
    let mut diagnostic = semantic_proof(
        "Prompt-conforming diagnostic reproduction",
        "focused",
        "planned",
        [&unresolved.id],
    );
    configure_expected_red_proof(&mut diagnostic, "tests/prompt-diagnostic.txt", "corrected");
    fixture.save_nodes([objective, system, unresolved.clone(), diagnostic.clone()])?;
    fixture.compile("prompt-conforming unresolved Bug Fix seed")?;

    assert_eq!(fixture.open_ticket_count("ground-defect")?, 0);
    assert_eq!(fixture.open_ticket_count("diagnose-defect")?, 0);
    assert_eq!(fixture.open_ticket_count("plan-change")?, 0);
    assert_eq!(fixture.open_ticket_count("implement-change")?, 0);
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &diagnostic.id)?,
        1,
        "the resolved seed begins with source-only diagnostic preparation"
    );
    let graph = fixture.store.graph()?;
    assert_eq!(
        graph.nodes_of_type("change").count(),
        0,
        "an unresolved prompt seed contains no speculative repair"
    );
    assert_eq!(
        graph
            .node(&diagnostic.id)
            .and_then(|proof| proof.edges.get("verifies")),
        Some(&vec![unresolved.id]),
        "the one diagnostic proof verifies only the unresolved defect"
    );

    Ok(())
}

#[test]
fn software_duplicate_diagnostic_oracles_fail_closed_without_preparation_fanout()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Reject duplicate causal oracles")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("bug_fix".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let defect = defect(&objective.id, &system.id, "unresolved");
    let first = semantic_proof(
        "Primary diagnostic oracle",
        "focused",
        "planned",
        [&defect.id],
    );
    let second = semantic_proof(
        "Redundant diagnostic oracle",
        "focused",
        "planned",
        [&defect.id],
    );
    let first_id = first.id.clone();
    let second_id = second.id.clone();
    fixture.save_nodes([objective, system, defect, first, second])?;
    let error = fixture
        .compile("duplicate diagnostic proof seed")
        .expect_err("independent diagnostic lifecycles cannot share proof-source authority")
        .to_string();
    assert!(
        error.contains("preparation-proof-source-paths-pairwise-disjoint")
            && error.contains("tests/proof-source.txt")
            && error.contains(&first_id)
            && error.contains(&second_id),
        "unexpected duplicate diagnostic boundary: {error}"
    );

    assert_eq!(fixture.open_ticket_count("ground-defect")?, 0);
    assert_eq!(
        fixture.open_ticket_count("prepare-proof")?,
        0,
        "a malformed duplicate causal seam must not spend two preparation/review lanes"
    );
    assert_eq!(fixture.open_ticket_count("diagnose-defect")?, 0);
    assert_eq!(fixture.open_ticket_count("plan-change")?, 0);
    Ok(())
}

#[test]
fn software_bug_fix_planning_exact_covers_every_active_diagnosed_defect()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Repair two independent confirmed defects")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("bug_fix".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let mut first_defect = defect(&objective.id, &system.id, "diagnosed");
    let mut second_defect = defect(&objective.id, &system.id, "diagnosed");
    add_causal_diagnosis(&mut first_defect);
    add_causal_diagnosis(&mut second_defect);
    let first_diagnostic =
        semantic_proof("First diagnostic", "focused", "planned", [&first_defect.id]);
    let mut second_diagnostic = semantic_proof(
        "Second diagnostic",
        "focused",
        "planned",
        [&second_defect.id],
    );
    second_diagnostic.spec_object_mut().insert(
        "source_paths".to_owned(),
        json!(["tests/proof-source-secondary.txt"]),
    );
    let mut first_change = material_change(
        "Repair only the first cause",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    first_change
        .edges
        .insert("addresses".to_owned(), vec![first_defect.id.clone()]);
    let mut first_proof = semantic_proof(
        "First repair proof",
        "focused",
        "planned",
        [&first_change.id, &first_defect.id],
    );
    set_proof_source_path(&mut first_proof, "tests/first-repair-proof.txt");
    fixture.save_nodes([
        objective,
        system.clone(),
        first_defect,
        second_defect.clone(),
        first_diagnostic.clone(),
        second_diagnostic.clone(),
        first_change.clone(),
        first_proof,
    ])?;
    fixture.compile("two diagnosed defects awaiting real diagnostic preparation")?;
    fixture.complete_preparation_ticket(&first_diagnostic.id, None)?;
    fixture.complete_preparation_ticket(&second_diagnostic.id, None)?;
    fixture.compile("two diagnosed defects with only one addressing change")?;
    assert_eq!(
        fixture.open_ticket_count("plan-change")?,
        1,
        "one addressed defect cannot existentially hide its uncovered sibling"
    );

    let mut second_change = material_change(
        "Repair the second confirmed cause",
        &first_change.edges["realizes"][0],
        &system.id,
        "routine",
        "planned",
    );
    second_change
        .edges
        .insert("addresses".to_owned(), vec![second_defect.id.clone()]);
    let mut second_proof = semantic_proof(
        "Second repair proof",
        "focused",
        "planned",
        [&second_change.id, &second_defect.id],
    );
    set_proof_source_path(&mut second_proof, "tests/second-repair-proof.txt");
    fixture.save_nodes([second_change.clone(), second_proof])?;
    fixture.compile("every diagnosed defect has an objective-local addressing change")?;
    assert_eq!(fixture.open_ticket_count("plan-change")?, 0);
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &first_change.id)?,
        1
    );
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &second_change.id)?,
        1
    );

    Ok(())
}

#[test]
fn software_approved_decisions_skip_revalidation_but_legacy_open_decisions_route()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Preserve approved decision compatibility")?;
    assert_eq!(
        fixture
            .engine
            .profile()
            .node_types
            .get("decision")
            .and_then(|definition| definition.initial_status.as_deref()),
        Some("accepted"),
        "new human-approved seed decisions initialize directly at accepted"
    );
    let objective = fixture.objective()?;
    let mut decision = Node::new(
        "decision",
        "Use the bounded fixture design",
        json!({
            "kind": "design",
            "question": "Which bounded fixture design should this objective use?",
            "options": ["bounded fixture", "broader redesign"],
            "choice": "bounded fixture",
            "rationale": "The approved outcome needs no broader redesign.",
            "reversibility": "Return to human planning before changing the choice."
        }),
    );
    decision.status = "accepted".to_owned();
    decision
        .edges
        .insert("concerns".to_owned(), vec![objective.id]);
    fixture.save_nodes([decision.clone()])?;
    fixture.compile("new accepted seed decision")?;
    assert_eq!(fixture.open_ticket_count("resolve-decision")?, 0);

    decision.status = "open".to_owned();
    fixture.save_nodes([decision.clone()])?;
    fixture.compile("compatibility-era open decision")?;
    assert_eq!(
        fixture.open_ticket_count_for("resolve-decision", &decision.id)?,
        1,
        "legacy open decisions retain the bounded validation route"
    );

    Ok(())
}

#[test]
fn software_assurance_scales_and_risk_treatment_has_disjoint_routing() -> Result<(), Box<dyn Error>>
{
    let mut fixture = SoftwareFixture::new("Change an elevated fixture boundary")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let mut change = material_change(
        "Elevated boundary change",
        &objective.id,
        &system.id,
        "elevated",
        "planned",
    );
    let focused = semantic_proof("Focused elevated proof", "focused", "planned", [&change.id]);
    fixture.save_nodes([objective, system.clone(), change.clone(), focused])?;
    fixture.compile("elevated change with focused proof only")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0,
        "elevated work cannot relabel its focused check as a second proof layer"
    );

    let mut risk = material_risk("mitigate", &system.id);
    change
        .edges
        .insert("introduces".to_owned(), vec![risk.id.clone()]);
    let mut boundary = semantic_proof(
        "Boundary and control proof",
        "boundary",
        "planned",
        [&risk.id],
    );
    set_proof_source_path(&mut boundary, "tests/proof-source-secondary.txt");
    fixture.save_nodes([change.clone(), risk.clone(), boundary.clone()])?;
    fixture.compile("elevated change with boundary proof and zero-target risk")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0
    );
    assert_eq!(
        fixture.open_ticket_count_for("plan-risk-treatment", &risk.id)?,
        0,
        "a mitigation with no product/control target is an upstream plan gap, not narrow risk repair"
    );
    assert_eq!(fixture.open_ticket_count("plan-change")?, 1);

    let mitigation = material_change(
        "Bounded mitigation control",
        &change.edges["realizes"][0],
        &system.id,
        "routine",
        "planned",
    );
    let mitigation_proof = semantic_proof(
        "Focused mitigation proof",
        "focused",
        "planned",
        [&mitigation.id],
    );
    risk.edges
        .insert("mitigated_by".to_owned(), vec![mitigation.id.clone()]);
    fixture.save_nodes([risk.clone(), mitigation, mitigation_proof])?;
    fixture.compile(
        "elevated change with an objective-local mitigation awaiting current risk evidence",
    )?;
    assert_eq!(
        fixture.open_ticket_count_for("plan-risk-treatment", &risk.id)?,
        0
    );
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0,
        "changing risk-treatment topology must keep implementation closed until its boundary proof is current"
    );
    fixture.complete_preparation_ticket(&boundary.id, None)?;
    fixture.compile("elevated change with current objective-local mitigation evidence")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        1,
        "a same-objective mitigation target plus distinct boundary proof is structurally ready"
    );

    change
        .spec_object_mut()
        .insert("risk_tier".to_owned(), Value::String("critical".to_owned()));
    change.spec_object_mut().remove("recovery_plan");
    fixture.save_nodes([change.clone()])?;
    fixture.compile("critical change without recovery")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0
    );
    change.spec_object_mut().insert(
        "recovery_plan".to_owned(),
        json!(["Roll back the bounded change if the boundary proof regresses."]),
    );
    fixture.save_nodes([change.clone()])?;
    fixture.compile("critical change with recovery but no qualified authority")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0,
        "critical recovery does not substitute for an approved qualified review authority"
    );
    let authority = accepted_review_authority_decision(&change.id);
    change
        .edges
        .insert("requires".to_owned(), vec![authority.id.clone()]);
    fixture.save_nodes([change.clone(), authority])?;
    fixture.compile("critical change with recovery and qualified authority")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        1,
        "critical work mechanically requires both recovery and approved review authority"
    );

    let mut decision = accepted_risk_decision(&risk.id);
    risk.spec_object_mut()
        .insert("treatment".to_owned(), Value::String("accept".to_owned()));
    risk.spec_object_mut().insert(
        "treatment_rationale".to_owned(),
        Value::String(
            "The approved bounded exposure is preferable to added complexity.".to_owned(),
        ),
    );
    risk.edges.remove("mitigated_by");
    risk.edges
        .insert("accepted_by".to_owned(), vec![decision.id.clone()]);
    decision.status = "accepted".to_owned();
    fixture.save_nodes([risk, decision])?;
    fixture.compile(
        "critical change with seed-bound risk acceptance awaiting current boundary evidence",
    )?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0,
        "an accepted risk still needs boundary evidence current with the accepted treatment"
    );
    fixture.complete_preparation_ticket(&boundary.id, None)?;
    fixture
        .compile("critical change with seed-bound risk acceptance and current boundary evidence")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        1
    );
    assert_eq!(
        fixture.open_ticket_count("plan-change")?,
        0,
        "an accepted seed-bound decision closes the acceptance path instead of remaining an upstream gap"
    );
    assert_eq!(fixture.open_ticket_count("plan-risk-treatment")?, 0);

    let profile = fixture.engine.profile();
    let initialization = profile
        .operations
        .values()
        .find(|operation| operation.stage == "initialization")
        .expect("Software profile has an initialization seed operation");
    assert!(
        initialization
            .allowed_new_node_types
            .iter()
            .any(|node_type| node_type == "decision")
    );
    assert!(
        profile
            .operations
            .values()
            .filter(|operation| operation.stage != "initialization")
            .all(|operation| !operation
                .allowed_new_node_types
                .iter()
                .any(|node_type| node_type == "decision")),
        "without typed per-node seed provenance, post-approval operations must not invent risk acceptance authority"
    );

    Ok(())
}

#[test]
fn software_prepared_risk_boundary_waits_for_introducer_and_control_then_runs_green()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Prove an elevated change and its mitigation")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let mut introducing_change = material_change(
        "Elevated introducing change",
        &objective.id,
        &system.id,
        "elevated",
        "planned",
    );
    let focused = semantic_proof(
        "Focused introducing proof",
        "focused",
        "planned",
        [&introducing_change.id],
    );
    let mitigation = material_change(
        "Independent mitigation control",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    let mitigation_proof = semantic_proof(
        "Focused mitigation proof",
        "focused",
        "planned",
        [&mitigation.id],
    );
    let mut risk = material_risk("mitigate", &system.id);
    risk.edges
        .insert("mitigated_by".to_owned(), vec![mitigation.id.clone()]);
    introducing_change
        .edges
        .insert("introduces".to_owned(), vec![risk.id.clone()]);
    let mut boundary = semantic_proof(
        "Prepared risk boundary proof",
        "boundary",
        "planned",
        [&risk.id],
    );
    configure_expected_red_proof(&mut boundary, "tests/risk-boundary.txt", "corrected");
    fixture.save_nodes([
        objective,
        system,
        introducing_change.clone(),
        focused.clone(),
        mitigation.clone(),
        mitigation_proof.clone(),
        risk.clone(),
        boundary.clone(),
    ])?;
    fixture.compile("elevated work before its boundary seam is prepared")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &introducing_change.id)?,
        0,
        "elevated implementation waits for reviewed historical boundary preparation"
    );
    let preparation = fixture.only_open_ticket_for("prepare-proof", &boundary.id)?;
    let preparation_step = preparation
        .workflow
        .iter()
        .find(|step| step.id == "author-historical-baseline")
        .expect("boundary preparation has a source-authoring step");
    assert_eq!(
        preparation_step.write_paths.as_ref(),
        Some(&BTreeSet::from(["tests/risk-boundary.txt".to_owned()])),
    );
    assert!(!preparation.scope.write_paths.contains("src/lib.rs"));
    fixture.complete_preparation_ticket(
        &boundary.id,
        Some(("tests/risk-boundary.txt", "risk boundary source\n")),
    )?;

    risk.spec_object_mut().insert(
        "scenario".to_owned(),
        Value::String("The reviewed material boundary scenario changed".to_owned()),
    );
    fixture.save_nodes([risk.clone()])?;
    fixture.compile("risk semantic drift invalidates boundary preparation")?;
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &boundary.id)?,
        1,
        "risk-boundary preparation binds the stable risk subject and must reopen when that subject changes"
    );
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &introducing_change.id)?,
        0,
        "elevated implementation remains blocked until the changed risk boundary is reviewed again"
    );
    fixture.complete_preparation_ticket(&boundary.id, None)?;

    fixture.compile("prepared boundary before product implementation")?;
    let introducing_ticket =
        fixture.only_open_ticket_for("implement-change", &introducing_change.id)?;
    assert_eq!(
        introducing_ticket
            .target_nodes
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([introducing_change.id.clone(), focused.id.clone()]),
        "implementation pins only its direct focused proof, never the risk boundary proof"
    );
    let mitigation_ticket = fixture.only_open_ticket_for("implement-change", &mitigation.id)?;
    assert_eq!(
        mitigation_ticket
            .target_nodes
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([mitigation.id.clone(), mitigation_proof.id.clone()]),
    );
    assert_eq!(
        fixture.open_ticket_count_for("establish-proof", &boundary.id)?,
        0,
        "a prepared historical baseline is not current green assurance"
    );

    fixture.complete_implementation_ticket_with_product_change(
        &introducing_change.id,
        "src/lib.rs",
        "pub fn value() -> u8 { 2 } // corrected\n",
    )?;
    fixture.compile("introducer terminal while mitigation remains planned")?;
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &boundary.id)?,
        0,
        "covered-product mutation must not recreate historical preparation"
    );
    assert_eq!(
        fixture.open_ticket_count_for("establish-proof", &boundary.id)?,
        0,
        "boundary promotion waits for every mitigation control to become terminal"
    );
    assert_eq!(
        fixture
            .store
            .graph()?
            .node(&boundary.id)
            .map(|proof| proof.status.as_str()),
        Some("prepared")
    );

    fixture.complete_implementation_ticket(&mitigation.id)?;
    fixture.compile("introducer and mitigation terminal")?;
    assert_eq!(
        fixture.open_ticket_count_for("establish-proof", &boundary.id)?,
        1
    );
    fixture.complete_proof_ticket(&boundary.id)?;
    assert_eq!(
        fixture
            .store
            .graph()?
            .node(&boundary.id)
            .map(|proof| proof.status.as_str()),
        Some("passing")
    );

    Ok(())
}

#[test]
fn software_cross_objective_mitigation_routes_to_upstream_planning() -> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Reject a foreign mitigation control")?;
    let mut primary_objective = fixture.objective()?;
    primary_objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    primary_objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let foreign_objective =
        additional_objective("Independent foreign objective", "general", &system.id);
    let mut introducing_change = material_change(
        "Elevated primary change",
        &primary_objective.id,
        &system.id,
        "elevated",
        "planned",
    );
    let focused = semantic_proof(
        "Focused primary proof",
        "focused",
        "planned",
        [&introducing_change.id],
    );
    let foreign_control = material_change(
        "Foreign objective control",
        &foreign_objective.id,
        &system.id,
        "routine",
        "planned",
    );
    let foreign_proof = semantic_proof(
        "Foreign control proof",
        "focused",
        "planned",
        [&foreign_control.id],
    );
    let mut risk = material_risk("mitigate", &system.id);
    risk.edges
        .insert("mitigated_by".to_owned(), vec![foreign_control.id.clone()]);
    introducing_change
        .edges
        .insert("introduces".to_owned(), vec![risk.id.clone()]);
    let mut boundary = semantic_proof("Primary boundary", "boundary", "planned", [&risk.id]);
    set_proof_source_path(&mut boundary, "tests/proof-source-secondary.txt");
    fixture.save_nodes([
        primary_objective.clone(),
        foreign_objective,
        system,
        introducing_change.clone(),
        focused,
        foreign_control,
        foreign_proof,
        risk.clone(),
        boundary,
    ])?;
    fixture.compile("risk points at a foreign objective control")?;
    assert_eq!(
        fixture.open_ticket_count_for("plan-risk-treatment", &risk.id)?,
        0,
        "a narrow risk ticket cannot invent or import objective-local product scope"
    );
    assert_eq!(
        fixture.open_ticket_count_for("plan-change", &primary_objective.id)?,
        1,
        "the introducing objective must repair the upstream mitigation topology"
    );
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &introducing_change.id)?,
        0
    );

    Ok(())
}

#[test]
fn software_each_proof_strategy_runs_baseline_product_promotion_review_and_finish()
-> Result<(), Box<dyn Error>> {
    for (
        strategy,
        expected_rule,
        expected_baseline_check,
        expected_baseline_persona,
        requires_independent_preparation,
        product_contents,
    ) in [
        (
            "red_green",
            "change.implement-red-green",
            "proof-expected-red",
            "implementer",
            true,
            "pub fn value() -> u8 { 2 } // red-green-complete\n",
        ),
        (
            "characterization",
            "change.implement-characterization",
            "proof-current-baseline",
            "implementer",
            true,
            "pub fn value() -> u8 { 2 } // characterization-complete\n",
        ),
        (
            "current_verification",
            "change.implement-current-verification",
            "proof-current-baseline",
            "verifier",
            false,
            "pub fn value() -> u8 { 2 } // current-verification-complete\n",
        ),
    ] {
        let mut fixture = SoftwareFixture::new(&format!(
            "Complete one {strategy} implementation through exact evidence"
        ))?;
        let mut objective = fixture.objective()?;
        objective
            .spec_object_mut()
            .insert("work_kind".to_owned(), Value::String("general".to_owned()));
        let system = fixture_system(false);
        objective
            .edges
            .insert("systems".to_owned(), vec![system.id.clone()]);
        let mut change = material_change(
            &format!("Implement the {strategy} bounded outcome"),
            &objective.id,
            &system.id,
            "routine",
            "planned",
        );
        change.spec_object_mut().insert(
            "proof_strategy".to_owned(),
            Value::String(strategy.to_owned()),
        );
        let mut proof = semantic_proof(
            &format!("{strategy} focused proof"),
            "focused",
            "planned",
            [&change.id],
        );
        if strategy == "red_green" {
            configure_expected_red_proof(
                &mut proof,
                "tests/proof-source.txt",
                "red-green-complete",
            );
        }
        fixture.save_nodes([objective, system, change.clone(), proof.clone()])?;
        fixture.compile(&format!("{strategy} proof strategy planned"))?;

        if requires_independent_preparation {
            assert_eq!(
                fixture.open_ticket_count_for("implement-change", &change.id)?,
                0,
                "{strategy} product work must wait for independent oracle preparation"
            );
            assert_eq!(
                fixture.open_ticket_count("plan-change")?,
                0,
                "{strategy} is design-complete; preparation is an assurance gate, not replanning"
            );
            let preparation = fixture.only_open_ticket_for("prepare-proof", &proof.id)?;
            let author = preparation
                .workflow
                .iter()
                .find(|step| step.id == "author-historical-baseline")
                .expect("preparation has its source-only authoring step");
            assert_eq!(
                author.write_paths.as_ref(),
                Some(&BTreeSet::from(["tests/proof-source.txt".to_owned()])),
                "{strategy} proof source is writable only before independent review"
            );
            let preparation_set = author
                .compiled_check_sets
                .iter()
                .find(|set| set.parent_check_id == "baseline-proof-set")
                .expect("preparation pins its historical baseline set");
            assert_eq!(preparation_set.members.len(), 1, "{strategy}");
            assert_eq!(
                preparation_set.members[0].child_check_id, expected_baseline_check,
                "{strategy} preparation records its honest historical signal"
            );
            fixture.complete_preparation_ticket(&proof.id, None)?;
            fixture.compile(&format!("{strategy} oracle independently prepared"))?;
        } else {
            assert_eq!(
                fixture.open_ticket_count_for("prepare-proof", &proof.id)?,
                0,
                "current verification uses its existing proof read-only without a source-authoring ticket"
            );
        }

        let ticket = fixture.only_open_ticket_for("implement-change", &change.id)?;
        assert_eq!(ticket.rule_id, expected_rule, "{strategy} rule identity");
        assert_eq!(
            ticket
                .workflow
                .iter()
                .map(|step| step.id.as_str())
                .collect::<Vec<_>>(),
            ["establish-baseline", "implement", "review"],
            "{strategy} retains the lean baseline -> product -> review workflow"
        );
        let baseline = ticket
            .workflow
            .iter()
            .find(|step| step.id == "establish-baseline")
            .expect("strategy workflow has a baseline step");
        assert_eq!(baseline.persona, expected_baseline_persona, "{strategy}");
        assert_eq!(
            baseline.write_paths.as_ref(),
            Some(&BTreeSet::new()),
            "{strategy} implementation baseline can re-run but never rewrite proof source"
        );
        assert_eq!(
            ticket.scope.write_paths,
            BTreeSet::from(["src/lib.rs".to_owned()]),
            "{strategy} implementation ticket has product authority only"
        );
        let baseline_set = baseline
            .compiled_check_sets
            .iter()
            .find(|set| set.parent_check_id == "baseline-proof-set")
            .expect("strategy baseline pins its composite proof set");
        assert_eq!(baseline_set.members.len(), 1, "{strategy}");
        assert_eq!(
            baseline_set.members[0].source_node_id, proof.id,
            "{strategy}"
        );
        assert_eq!(
            baseline_set.members[0].child_check_id, expected_baseline_check,
            "{strategy} selects its honest baseline signal"
        );
        let implementation = ticket
            .workflow
            .iter()
            .find(|step| step.id == "implement")
            .expect("strategy workflow has a product implementation step");
        assert_eq!(
            implementation.write_paths.as_ref(),
            Some(&BTreeSet::from(["src/lib.rs".to_owned()])),
            "{strategy} product authority stays inside the selected implementation scope"
        );
        assert_eq!(
            implementation.preserve_source_paths_from.as_deref(),
            Some("establish-baseline"),
            "{strategy} promotion is causally bound to unchanged proof source bytes"
        );

        fixture.complete_implementation_ticket_with_product_change(
            &change.id,
            "src/lib.rs",
            product_contents,
        )?;
        fixture.compile(&format!("{strategy} implementation finished"))?;
        let graph = fixture.store.graph()?;
        assert_eq!(
            graph.node(&change.id).map(|node| node.status.as_str()),
            Some("implemented"),
            "{strategy} independent review applies the exact change effect"
        );
        assert_eq!(
            graph.node(&proof.id).map(|node| node.status.as_str()),
            Some("passing"),
            "{strategy} independent review applies the exact focused-proof effect"
        );
        assert_eq!(
            fixture.open_ticket_count_for("implement-change", &change.id)?,
            0,
            "{strategy} reaches its compiler-defined target state after finish"
        );
        for parent_check in ["baseline-proof-set", "promotion-proof-set"] {
            let receipts = composite_member_receipts(&fixture.store, parent_check)?;
            assert!(
                receipts.iter().any(|receipt| {
                    receipt
                        .pointer("/execution_binding/compiled_member_binding/source_node_id")
                        .and_then(Value::as_str)
                        == Some(proof.id.as_str())
                        && receipt.get("status").and_then(Value::as_str) == Some("passed")
                }),
                "{strategy} records a passing compiler receipt for {parent_check}"
            );
        }
    }

    Ok(())
}

#[test]
fn software_migration_preparation_gate_routes_authoring_strategies_only()
-> Result<(), Box<dyn Error>> {
    for (strategy, expected_rule, requires_preparation) in [
        ("red_green", "migration.implement-red-green", true),
        (
            "characterization",
            "migration.implement-characterization",
            true,
        ),
        (
            "current_verification",
            "migration.implement-current-verification",
            false,
        ),
    ] {
        let mut fixture =
            SoftwareFixture::new(&format!("Route one {strategy} migration through assurance"))?;
        let mut objective = fixture.objective()?;
        objective.spec_object_mut().insert(
            "work_kind".to_owned(),
            Value::String("migration".to_owned()),
        );
        let system = fixture_system(false);
        objective
            .edges
            .insert("systems".to_owned(), vec![system.id.clone()]);
        let migration = material_migration(
            &format!("Apply the {strategy} compatibility transition"),
            &system.id,
            strategy,
        );
        let mut proof = semantic_proof(
            &format!("{strategy} migration proof"),
            "focused",
            "planned",
            [&migration.id],
        );
        if strategy == "red_green" {
            configure_expected_red_proof(
                &mut proof,
                "tests/proof-source.txt",
                "migration-complete",
            );
        }
        fixture.save_nodes([objective, system, migration.clone(), proof.clone()])?;
        fixture.compile(&format!("{strategy} migration planned"))?;

        if requires_preparation {
            assert_eq!(
                fixture.open_ticket_count_for("implement-migration", &migration.id)?,
                0,
                "{strategy} migration waits for independent proof preparation"
            );
            fixture.complete_preparation_ticket(&proof.id, None)?;
            fixture.compile(&format!("{strategy} migration proof prepared"))?;
        } else {
            assert_eq!(
                fixture.open_ticket_count_for("prepare-proof", &proof.id)?,
                0,
                "current-verification migration has no source-authoring preparation"
            );
        }

        let ticket = fixture.only_open_ticket_for("implement-migration", &migration.id)?;
        assert_eq!(ticket.rule_id, expected_rule);
        assert_eq!(
            ticket.scope.write_paths,
            BTreeSet::from(["src/lib.rs".to_owned()]),
            "{strategy} migration never receives proof-source write authority"
        );
        assert_eq!(
            ticket
                .workflow
                .iter()
                .find(|step| step.id == "establish-baseline")
                .and_then(|step| step.write_paths.as_ref()),
            Some(&BTreeSet::new()),
            "{strategy} migration baseline is read-only"
        );
    }

    Ok(())
}

#[test]
fn software_failed_implementation_proof_preparation_blocks_product_authority()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Reject an incomplete red-green oracle before code")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let mut change = material_change(
        "Implement only after the focused oracle is complete",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    change.spec_object_mut().insert(
        "proof_strategy".to_owned(),
        Value::String("red_green".to_owned()),
    );
    let mut proof = semantic_proof(
        "Focused consumer-routing proof",
        "focused",
        "planned",
        [&change.id],
    );
    configure_expected_red_proof(&mut proof, "tests/proof-source.txt", "oracle-complete");
    fixture.save_nodes([objective, system, change.clone(), proof.clone()])?;
    fixture.compile("red-green proof awaiting independent preparation")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0
    );

    let preparation = fixture.only_open_ticket_for("prepare-proof", &proof.id)?;
    fixture.engine.execute_action(
        "start",
        string_params([("ticket", preparation.id.as_str())]),
    )?;
    let started = fixture.store.ticket(&preparation.id)?;
    let mut ticket_engine = Engine::open(&ticket_engine_root(&started))?;
    record_output(
        &mut ticket_engine,
        &preparation.id,
        "author-historical-baseline",
        "implementer",
        evidence_output(
            "The candidate source records an expected-red signal but its consumer routing is incomplete.",
        ),
    )?;
    ticket_engine.execute_action(
        "compile-ticket",
        string_params([("ticket", preparation.id.as_str())]),
    )?;
    ticket_engine.review_ticket_with(
        &preparation.id,
        &StaticReviewLauncher::failed(
            "The focused oracle does not yet exercise every declared production consumer route.",
        ),
    )?;

    let failed = fixture.store.ticket(&preparation.id)?;
    assert_eq!(
        failed.reviews.last().map(|review| review.status.as_str()),
        Some("failed")
    );
    assert_eq!(
        fixture
            .store
            .graph()?
            .node(&proof.id)
            .map(|node| node.status.as_str()),
        Some("planned"),
        "failed preparation review cannot stamp the oracle prepared"
    );
    fixture.compile("failed preparation remains an upstream blocker")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0,
        "a failed source-only review must not leak product-write eligibility"
    );

    Ok(())
}

#[test]
fn software_review_rework_keeps_prepared_oracle_immutable_and_reopens_product_only()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Rework product code without reopening its oracle")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let mut change = material_change(
        "Implement against one independently reviewed red oracle",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    change.spec_object_mut().insert(
        "proof_strategy".to_owned(),
        Value::String("red_green".to_owned()),
    );
    let mut proof = semantic_proof(
        "Immutable focused implementation oracle",
        "focused",
        "planned",
        [&change.id],
    );
    configure_expected_red_proof(
        &mut proof,
        "tests/proof-source.txt",
        "review-rework-complete",
    );
    fixture.save_nodes([objective, system, change.clone(), proof.clone()])?;
    fixture.compile("red oracle awaiting preparation")?;
    fixture.complete_preparation_ticket(&proof.id, None)?;
    fixture.compile("red oracle prepared before product dispatch")?;

    let ticket = fixture.only_open_ticket_for("implement-change", &change.id)?;
    assert_eq!(
        ticket.scope.write_paths,
        BTreeSet::from(["src/lib.rs".to_owned()]),
        "the reviewed proof source is absent from implementation write authority"
    );
    let baseline = ticket
        .workflow
        .iter()
        .find(|step| step.id == "establish-baseline")
        .expect("red-green implementation retains a baseline confirmation");
    assert_eq!(baseline.write_paths.as_ref(), Some(&BTreeSet::new()));
    let implementation = ticket
        .workflow
        .iter()
        .find(|step| step.id == "implement")
        .expect("red-green implementation has a product step");
    assert_eq!(
        implementation.write_paths.as_ref(),
        Some(&BTreeSet::from(["src/lib.rs".to_owned()]))
    );

    fixture
        .engine
        .execute_action("start", string_params([("ticket", ticket.id.as_str())]))?;
    let started = fixture.store.ticket(&ticket.id)?;
    let worktree = ticket_engine_root(&started);
    let mut ticket_engine = Engine::open(&worktree)?;
    record_output(
        &mut ticket_engine,
        &ticket.id,
        "establish-baseline",
        "implementer",
        evidence_output("The independently prepared oracle still fails for the intended reason."),
    )?;
    ticket_engine.execute_action(
        "compile-ticket",
        string_params([("ticket", ticket.id.as_str())]),
    )?;
    fs::write(
        worktree.join("src/lib.rs"),
        "pub fn value() -> u8 { 2 } // review-rework-complete\n",
    )?;
    record_output(
        &mut ticket_engine,
        &ticket.id,
        "implement",
        "implementer",
        evidence_output_with_written(
            "The first product candidate makes the immutable oracle pass.",
            &["src/lib.rs"],
        ),
    )?;
    ticket_engine.execute_action(
        "compile-ticket",
        string_params([("ticket", ticket.id.as_str())]),
    )?;
    ticket_engine.review_ticket_with(
        &ticket.id,
        &StaticReviewLauncher::failed(
            "The product candidate needs one bounded correction; the reviewed oracle remains valid.",
        ),
    )?;

    let reopened = fixture.store.ticket(&ticket.id)?;
    assert!(
        reopened
            .outputs
            .iter()
            .any(|output| output.step_id == "establish-baseline"),
        "review rework preserves the independently prepared baseline checkpoint"
    );
    assert!(
        reopened
            .outputs
            .iter()
            .all(|output| output.step_id != "implement"),
        "review_failure_reopen_from keeps rework at the product step"
    );
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &proof.id)?,
        0,
        "ordinary product review failure does not reopen immutable oracle authoring"
    );

    record_output(
        &mut ticket_engine,
        &ticket.id,
        "implement",
        "implementer",
        evidence_output_with_written(
            "The bounded product correction is complete and the unchanged oracle passes.",
            &["src/lib.rs"],
        ),
    )?;
    ticket_engine.execute_action(
        "compile-ticket",
        string_params([("ticket", ticket.id.as_str())]),
    )?;
    ticket_engine.review_ticket_with(
        &ticket.id,
        &StaticReviewLauncher::passing(
            "The corrected product candidate satisfies the independently reviewed oracle.",
        ),
    )?;
    fixture.engine.execute_action(
        "finish",
        string_params([
            ("ticket", ticket.id.as_str()),
            (
                "message",
                "feat: finish product rework against immutable oracle",
            ),
        ]),
    )?;
    assert_eq!(
        fixture
            .store
            .graph()?
            .node(&change.id)
            .map(|node| node.status.as_str()),
        Some("implemented")
    );

    Ok(())
}

#[test]
fn software_upstream_oracle_review_failure_holds_change_migration_and_multi_proof_candidates()
-> Result<(), Box<dyn Error>> {
    // One ordinary change: the final Reviewer may invalidate proof
    // completeness, but the product-only Implementer must never receive that
    // upstream defect as a futile retry.
    let mut change_fixture =
        SoftwareFixture::new("Hold a change whose prepared oracle proves incomplete")?;
    let mut objective = change_fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let mut change = material_change(
        "Implement only behind a complete consumer oracle",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    change.spec_object_mut().insert(
        "proof_strategy".to_owned(),
        Value::String("red_green".to_owned()),
    );
    let mut proof = semantic_proof("Change consumer oracle", "focused", "planned", [&change.id]);
    configure_expected_red_proof(&mut proof, "tests/proof-source.txt", "change-green");
    change_fixture.save_nodes([objective, system, change.clone(), proof.clone()])?;
    change_fixture.compile("change awaiting source-only preparation")?;
    change_fixture.complete_preparation_ticket(&proof.id, None)?;
    change_fixture.compile("change preparation accepted")?;
    fail_implementation_review_as_upstream(
        &mut change_fixture,
        "implement-change",
        &change.id,
        "pub fn value() -> u8 { 2 } // change-green\n",
    )?;

    // A migration consumes the same generic workflow route. This proves the
    // domain is not accidentally attached only to `change` nodes.
    let mut migration_fixture =
        SoftwareFixture::new("Hold a migration whose prepared oracle proves incomplete")?;
    let mut objective = migration_fixture.objective()?;
    objective.spec_object_mut().insert(
        "work_kind".to_owned(),
        Value::String("migration".to_owned()),
    );
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let migration = material_migration(
        "Apply a proof-gated compatibility migration",
        &system.id,
        "red_green",
    );
    let mut proof = semantic_proof(
        "Migration consumer oracle",
        "focused",
        "planned",
        [&migration.id],
    );
    configure_expected_red_proof(&mut proof, "tests/proof-source.txt", "migration-green");
    migration_fixture.save_nodes([objective, system, migration.clone(), proof.clone()])?;
    migration_fixture.compile("migration awaiting source-only preparation")?;
    migration_fixture.complete_preparation_ticket(&proof.id, None)?;
    migration_fixture.compile("migration preparation accepted")?;
    fail_implementation_review_as_upstream(
        &mut migration_fixture,
        "implement-migration",
        &migration.id,
        "pub fn value() -> u8 { 3 } // migration-green\n",
    )?;

    // Multiple focused proofs remain one exact implementation boundary. One
    // upstream failure holds the complete candidate; it cannot reopen product
    // work merely because the sibling proof remained valid.
    let mut multi_fixture =
        SoftwareFixture::new("Hold a multi-proof change when one oracle proves incomplete")?;
    let mut objective = multi_fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let mut change = material_change(
        "Implement behind two independently prepared oracles",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    change.spec_object_mut().insert(
        "proof_strategy".to_owned(),
        Value::String("red_green".to_owned()),
    );
    let mut first = semantic_proof(
        "First multi-proof consumer oracle",
        "focused",
        "planned",
        [&change.id],
    );
    configure_expected_red_proof(&mut first, "tests/proof-source.txt", "first-green");
    let mut second = semantic_proof(
        "Second multi-proof consumer oracle",
        "focused",
        "planned",
        [&change.id],
    );
    configure_expected_red_proof(
        &mut second,
        "tests/proof-source-secondary.txt",
        "second-green",
    );
    multi_fixture.save_nodes([
        objective,
        system,
        change.clone(),
        first.clone(),
        second.clone(),
    ])?;
    multi_fixture.compile("multi-proof change awaiting both preparations")?;
    multi_fixture.complete_preparation_ticket(&first.id, None)?;
    multi_fixture.complete_preparation_ticket(&second.id, None)?;
    multi_fixture.compile("multi-proof preparations accepted")?;
    let held = fail_implementation_review_as_upstream(
        &mut multi_fixture,
        "implement-change",
        &change.id,
        "pub fn value() -> u8 { 4 } // first-green second-green\n",
    )?;
    let focused_members = held
        .workflow
        .iter()
        .find(|step| step.id == "implement")
        .into_iter()
        .flat_map(|step| &step.compiled_check_sets)
        .flat_map(|set| &set.members)
        .map(|member| member.source_node_id.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        focused_members,
        BTreeSet::from([first.id.as_str(), second.id.as_str()]),
        "the held candidate retains the exact complete multi-proof boundary"
    );

    Ok(())
}

#[test]
fn software_rejects_same_ticket_proof_source_and_product_write_overlap_before_emission()
-> Result<(), Box<dyn Error>> {
    for (shape, production_path, proof_source_path) in [
        ("equal paths", "src/lib.rs", "src/lib.rs"),
        ("proof source contains product", "src/lib.rs", "src"),
        ("product contains proof source", "src", "src/lib.rs"),
    ] {
        let mut fixture = SoftwareFixture::new(&format!(
            "Reject {shape} between proof source and product authority"
        ))?;
        let mut objective = fixture.objective()?;
        objective
            .spec_object_mut()
            .insert("work_kind".to_owned(), Value::String("general".to_owned()));
        let system = fixture_system(false);
        objective
            .edges
            .insert("systems".to_owned(), vec![system.id.clone()]);
        let mut change = material_change(
            "Unsafe red-green source boundary",
            &objective.id,
            &system.id,
            "routine",
            "planned",
        );
        change.spec_object_mut().insert(
            "proof_strategy".to_owned(),
            Value::String("red_green".to_owned()),
        );
        change
            .spec_object_mut()
            .insert("owned_paths".to_owned(), json!([production_path]));
        let mut proof = semantic_proof(
            "Overlapping red-green proof",
            "focused",
            "planned",
            [&change.id],
        );
        configure_expected_red_proof(&mut proof, proof_source_path, "never-present");
        fixture.save_nodes([objective, system, change.clone(), proof])?;

        let error = fixture
            .engine
            .compile(None, false)
            .expect_err("overlapping source/product authority must fail before ticket emission");
        let message = error.to_string();
        assert!(
            message
                .contains("field source_paths must be disjoint from root field spec.covered_paths")
                && message.contains("overlapping normalized paths"),
            "{shape} returns the bounded authority diagnostic: {message}"
        );
        assert_eq!(
            fixture.open_ticket_count_for("implement-change", &change.id)?,
            0,
            "{shape} never reaches an executable implementation ticket"
        );
    }

    Ok(())
}

#[test]
fn software_implementation_review_stamps_only_its_pinned_active_proofs()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Implement one of two independently proved changes")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);

    let primary_change = material_change(
        "Primary bounded implementation",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    let primary_proof = semantic_proof(
        "Primary focused implementation proof",
        "focused",
        "planned",
        [&primary_change.id],
    );
    let sibling_change = material_change(
        "Independent sibling implementation",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    let sibling_proof = semantic_proof(
        "Independent sibling proof",
        "focused",
        "planned",
        [&sibling_change.id],
    );
    fixture.save_nodes([
        objective,
        system,
        primary_change.clone(),
        primary_proof.clone(),
        sibling_change.clone(),
        sibling_proof.clone(),
    ])?;
    fixture.compile("two independently implementable changes")?;

    let primary_ticket = fixture.only_open_ticket_for("implement-change", &primary_change.id)?;
    assert_eq!(
        primary_ticket
            .target_nodes
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([primary_change.id.clone(), primary_proof.id.clone()]),
        "implementation pins its one subject and exact active proof closure"
    );

    fixture.complete_implementation_ticket(&primary_change.id)?;
    let graph = fixture.store.graph()?;
    assert_eq!(
        graph
            .node(&primary_change.id)
            .map(|node| node.status.as_str()),
        Some("implemented")
    );
    assert_eq!(
        graph
            .node(&primary_proof.id)
            .map(|node| node.status.as_str()),
        Some("passing"),
        "the implementation review semantically accepts its compiler-pinned current proof"
    );
    assert_eq!(
        graph
            .node(&sibling_change.id)
            .map(|node| node.status.as_str()),
        Some("planned")
    );
    assert_eq!(
        graph
            .node(&sibling_proof.id)
            .map(|node| node.status.as_str()),
        Some("planned"),
        "a passing review cannot stamp a proof outside its exact ticket targets"
    );

    fixture.compile("reconcile proof work after one implementation review")?;
    assert_eq!(
        fixture.open_ticket_count_for("establish-proof", &primary_proof.id)?,
        0,
        "the implementation verifier and review remove the routine duplicate proof boundary"
    );
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &sibling_change.id)?,
        1,
        "the sibling's independent implementation work remains open instead of being globally stamped"
    );

    Ok(())
}

#[test]
fn software_one_change_accepts_multiple_nonredundant_focused_proofs_in_one_ticket()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Prove one slice at two distinct evidence seams")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let mut change = material_change(
        "One behavior slice with unit and integration evidence",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    change.spec_object_mut().insert(
        "proof_strategy".to_owned(),
        Value::String("red_green".to_owned()),
    );
    let mut unit = semantic_proof("Focused unit proof", "focused", "planned", [&change.id]);
    configure_expected_red_proof(&mut unit, "tests/proof-source.txt", "mixed-ready");
    unit.spec_object_mut()
        .insert("layer".to_owned(), Value::String("unit".to_owned()));
    let mut integration = semantic_proof(
        "Focused integration proof for remaining wiring",
        "focused",
        "planned",
        [&change.id],
    );
    set_proof_source_path(&mut integration, "tests/proof-source-secondary.txt");
    integration
        .spec_object_mut()
        .insert("layer".to_owned(), Value::String("integration".to_owned()));
    fixture.save_nodes([
        objective,
        system,
        change.clone(),
        unit.clone(),
        integration.clone(),
    ])?;
    fixture.compile("one change with two distinct focused seams")?;
    assert_eq!(
        fixture.open_ticket_count_for("implement-change", &change.id)?,
        0,
        "every linked red-green proof must be independently prepared before product dispatch"
    );
    assert_eq!(fixture.open_ticket_count("prepare-proof")?, 2);
    fixture.complete_preparation_ticket(&unit.id, None)?;
    fixture.complete_preparation_ticket(&integration.id, None)?;
    fixture.compile("both nonredundant focused seams independently prepared")?;

    let ticket = fixture.only_open_ticket_for("implement-change", &change.id)?;
    assert_eq!(
        ticket.target_nodes.iter().cloned().collect::<BTreeSet<_>>(),
        BTreeSet::from([change.id.clone(), unit.id.clone(), integration.id.clone()])
    );
    for step_id in ["establish-baseline", "implement"] {
        let set = ticket
            .workflow
            .iter()
            .find(|step| step.id == step_id)
            .and_then(|step| step.compiled_check_sets.first())
            .expect("both implementation evidence boundaries compile the focused set");
        assert_eq!(set.members.len(), 2, "{step_id} preserves both exact seams");
    }

    fixture.complete_implementation_ticket_with_product_change(
        &change.id,
        "src/lib.rs",
        "pub fn value() -> u8 { 2 } // mixed-ready\n",
    )?;
    let graph = fixture.store.graph()?;
    assert_eq!(
        graph.node(&change.id).map(|node| node.status.as_str()),
        Some("implemented")
    );
    assert_eq!(
        graph.node(&unit.id).map(|node| node.status.as_str()),
        Some("passing")
    );
    assert_eq!(
        graph.node(&integration.id).map(|node| node.status.as_str()),
        Some("passing")
    );
    Ok(())
}

#[test]
fn software_sibling_proof_tickets_select_and_stamp_exactly_one_shared_subject_member()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Independently establish two risk boundary claims")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let mut introducer = material_change(
        "Boundary introducer",
        &objective.id,
        &system.id,
        "elevated",
        "planned",
    );
    let control = material_change(
        "Boundary control",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    let mut risk = material_risk("mitigate", &system.id);
    risk.edges
        .insert("mitigated_by".to_owned(), vec![control.id.clone()]);
    introducer
        .edges
        .insert("introduces".to_owned(), vec![risk.id.clone()]);
    let first = semantic_proof(
        "First independent risk boundary",
        "boundary",
        "planned",
        [&risk.id],
    );
    let mut second = semantic_proof(
        "Second independent risk boundary",
        "boundary",
        "planned",
        [&risk.id],
    );
    second.spec_object_mut().insert(
        "source_paths".to_owned(),
        json!(["tests/proof-source-secondary.txt"]),
    );
    fixture.save_nodes([
        objective,
        system,
        introducer.clone(),
        control.clone(),
        risk,
        first.clone(),
        second.clone(),
    ])?;
    fixture.compile("two planned boundary proofs share one risk subject")?;

    for proof in [&first, &second] {
        let ticket = fixture.only_open_ticket_for("prepare-proof", &proof.id)?;
        assert_eq!(
            ticket.target_nodes.iter().cloned().collect::<BTreeSet<_>>(),
            BTreeSet::from([proof.id.clone(), proof.edges["verifies"][0].clone()]),
        );
        let step = ticket
            .workflow
            .iter()
            .find(|step| step.id == "author-historical-baseline")
            .expect("preparation has a baseline step");
        let set = step
            .compiled_check_sets
            .iter()
            .find(|set| set.parent_check_id == "baseline-proof-set")
            .expect("preparation pins a baseline graph set");
        assert_eq!(set.members.len(), 1);
        assert_eq!(set.members[0].source_node_id, proof.id);
    }

    fixture.complete_preparation_ticket(&first.id, None)?;
    assert_eq!(
        fixture
            .store
            .graph()?
            .node(&second.id)
            .map(|proof| proof.status.as_str()),
        Some("planned"),
        "one preparation review cannot stamp its sibling"
    );
    fixture.complete_preparation_ticket(&second.id, None)?;
    introducer.status = "implemented".to_owned();
    let mut terminal_control = control;
    terminal_control.status = "implemented".to_owned();
    fixture.save_nodes([introducer, terminal_control])?;
    fixture.compile("both risk controls terminal after independent preparation")?;

    for proof in [&first, &second] {
        let ticket = fixture.only_open_ticket_for("establish-proof", &proof.id)?;
        let step = ticket
            .workflow
            .iter()
            .find(|step| step.id == "execute-proof")
            .expect("standalone proof has an execution step");
        let set = step
            .compiled_check_sets
            .iter()
            .find(|set| set.parent_check_id == "promotion-proof-set")
            .expect("standalone proof pins a promotion graph set");
        assert_eq!(set.members.len(), 1);
        assert_eq!(set.members[0].source_node_id, proof.id);
    }

    fixture.complete_proof_ticket(&first.id)?;
    assert_eq!(
        fixture
            .store
            .graph()?
            .node(&second.id)
            .map(|proof| proof.status.as_str()),
        Some("prepared"),
        "one establishment review cannot stamp its sibling"
    );
    fixture.compile("second sibling remains independently executable")?;
    fixture.complete_proof_ticket(&second.id)?;
    let graph = fixture.store.graph()?;
    assert_eq!(
        graph.node(&first.id).map(|proof| proof.status.as_str()),
        Some("passing")
    );
    assert_eq!(
        graph.node(&second.id).map(|proof| proof.status.as_str()),
        Some("passing")
    );

    Ok(())
}

#[test]
fn software_delivery_requires_current_proof_and_exact_nonvacuous_coverage()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Deliver one independently proven material change")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    fixture.save_nodes([objective.clone(), system.clone()])?;
    fixture.compile("classified objective with no material changes")?;
    assert_eq!(
        fixture.open_ticket_count("prepare-delivery")?,
        0,
        "universal predicates over an empty objective change set must not unlock delivery"
    );

    let change = material_change(
        "Implemented material change",
        &objective.id,
        &system.id,
        "routine",
        "implemented",
    );
    let mut proof = semantic_proof("Current focused proof", "focused", "passing", [&change.id]);
    fixture.save_nodes([change.clone(), proof.clone()])?;
    fixture.compile("passing proof status without a current receipt")?;
    assert_eq!(fixture.open_ticket_count("prepare-delivery")?, 0);
    assert_eq!(
        fixture.open_ticket_count_for("establish-proof", &proof.id)?,
        1,
        "status passing without a current compiler-bound receipt must reopen proof work"
    );

    proof.status = "planned".to_owned();
    fixture.save_nodes([proof.clone()])?;
    fixture.compile("planned proof before execution")?;
    assert_eq!(fixture.open_ticket_count("prepare-delivery")?, 0);
    proof.status = "superseded".to_owned();
    fixture.save_nodes([proof.clone()])?;
    fixture.compile("superseded proof excluded from delivery")?;
    assert_eq!(fixture.open_ticket_count("prepare-delivery")?, 0);
    assert_eq!(
        fixture.open_ticket_count_for("establish-proof", &proof.id)?,
        0
    );

    proof.status = "planned".to_owned();
    fixture.save_nodes([proof.clone()])?;
    fixture.compile("planned proof selected for current execution")?;
    fixture.complete_proof_ticket(&proof.id)?;
    fixture.compile("reviewed proof with its current receipt")?;
    assert_eq!(
        fixture.open_ticket_count_for("establish-proof", &proof.id)?,
        0,
        "reviewed semantic status plus the exact current receipt closes proof execution"
    );
    let delivery_ticket = fixture.only_open_ticket("prepare-delivery")?;

    fixture.engine.execute_action(
        "start",
        string_params([("ticket", delivery_ticket.id.as_str())]),
    )?;
    let mut ticket_engine = Engine::open(&ticket_engine_root(
        &fixture.store.ticket(&delivery_ticket.id)?,
    ))?;

    let incomplete = delivery_node(&objective.id, [&change.id], std::iter::empty::<&String>());
    let error = record_output(
        &mut ticket_engine,
        &delivery_ticket.id,
        "assemble-candidate",
        "integrator",
        graph_output(&incomplete, "Assemble the exact delivery candidate."),
    )
    .expect_err("a candidate that omits its active proof must fail closed");
    let message = error.to_string();
    assert!(
        message.contains(&proof.id),
        "coverage error identifies the omitted proof: {message}"
    );
    assert!(
        fixture
            .store
            .ticket(&delivery_ticket.id)?
            .outputs
            .iter()
            .all(|output| output.step_id != "assemble-candidate")
    );

    let complete = delivery_node(
        &objective.id,
        [&change.id, &proof.id],
        std::iter::empty::<&String>(),
    );
    record_output(
        &mut ticket_engine,
        &delivery_ticket.id,
        "assemble-candidate",
        "integrator",
        graph_output(&complete, "Review the exact delivery candidate."),
    )?;
    ticket_engine
        .review_ticket_with(
            &delivery_ticket.id,
            &StaticReviewLauncher::passing(
                "The exact candidate is ready for target synchronization.",
            ),
        )
        .map_err(|error| format!("delivery candidate review failed: {error}"))?;
    fixture.engine.execute_action(
        "finish",
        string_params([
            ("ticket", delivery_ticket.id.as_str()),
            ("message", "chore: assemble exact software candidate"),
        ]),
    )?;

    let graph = fixture.store.graph()?;
    assert_eq!(
        graph
            .node(&complete.id)
            .map(|delivery| delivery.status.as_str()),
        Some("candidate_ready"),
        "review prepares a candidate; target sync, composed verification, and promotion remain later boundaries"
    );

    Ok(())
}

#[test]
fn software_stale_candidate_delivery_revises_the_same_exact_scoped_node()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Revise a candidate after its active closure grows")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let first_change = material_change(
        "First delivered change",
        &objective.id,
        &system.id,
        "routine",
        "implemented",
    );
    let first_proof = semantic_proof(
        "First current delivery proof",
        "focused",
        "planned",
        [&first_change.id],
    );
    fixture.save_nodes([
        objective.clone(),
        system.clone(),
        first_change.clone(),
        first_proof.clone(),
    ])?;
    fixture.compile("first implemented closure before proof establishment")?;
    fixture.complete_proof_ticket(&first_proof.id)?;
    fixture.compile("first exact closure ready for delivery")?;
    let candidate = delivery_node(
        &objective.id,
        [&first_change.id, &first_proof.id],
        std::iter::empty::<&String>(),
    );
    fixture.complete_delivery_ticket(&objective.id, &candidate)?;
    assert_eq!(
        fixture
            .store
            .graph()?
            .node(&candidate.id)
            .map(|delivery| delivery.status.as_str()),
        Some("candidate_ready")
    );

    let second_change = material_change(
        "Second delivered change",
        &objective.id,
        &system.id,
        "routine",
        "implemented",
    );
    let second_proof = semantic_proof(
        "Second current delivery proof",
        "focused",
        "planned",
        [&second_change.id],
    );
    fixture.save_nodes([second_change.clone(), second_proof.clone()])?;
    fixture.compile("closure grows but its second proof is not current")?;
    assert_eq!(
        fixture.open_ticket_count_for("prepare-delivery", &objective.id)?,
        0,
        "delivery revision waits until the newly active closure is itself ready"
    );
    fixture.complete_proof_ticket(&second_proof.id)?;
    fixture.compile("expanded exact closure invalidates the reviewed candidate")?;
    let revision = fixture.only_open_ticket_for("prepare-delivery", &objective.id)?;
    assert!(
        revision.scope.read_nodes.contains(&candidate.id),
        "the stale delivery is in the revision ticket's compiler-pinned read scope"
    );
    assert!(
        revision.scope.write_nodes.contains(&candidate.id),
        "the stale delivery is in the revision ticket's compiler-pinned write scope"
    );

    let mut revised_candidate = candidate.clone();
    revised_candidate.edges.insert(
        "includes".to_owned(),
        vec![
            first_change.id.clone(),
            first_proof.id.clone(),
            second_change.id.clone(),
            second_proof.id.clone(),
        ],
    );
    fixture.complete_delivery_ticket(&objective.id, &revised_candidate)?;
    let graph = fixture.store.graph()?;
    let deliveries = graph.nodes_of_type("delivery").collect::<Vec<_>>();
    assert_eq!(
        deliveries.len(),
        1,
        "revision must not create a second delivery"
    );
    assert_eq!(deliveries[0].id, candidate.id);
    assert_eq!(deliveries[0].status, "candidate_ready");
    assert_eq!(
        deliveries[0]
            .edges
            .get("includes")
            .into_iter()
            .flatten()
            .cloned()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            first_change.id,
            first_proof.id,
            second_change.id,
            second_proof.id,
        ])
    );
    assert!(
        deliveries[0]
            .edges
            .get("acknowledges")
            .is_none_or(Vec::is_empty)
    );

    Ok(())
}

#[test]
fn software_adverse_proof_receipt_fails_closed_without_fabricating_semantic_status()
-> Result<(), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new("Reject an adverse proof signal")?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("general".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let change = material_change(
        "Implemented but unproven change",
        &objective.id,
        &system.id,
        "routine",
        "implemented",
    );
    let mut proof = semantic_proof("Adverse focused proof", "focused", "planned", [&change.id]);
    proof
        .spec_object_mut()
        .insert("command".to_owned(), json!(["false"]));
    fixture.save_nodes([objective, system, change, proof.clone()])?;
    fixture.compile("adverse proof selected for execution")?;

    let ticket = fixture.only_open_ticket_for("establish-proof", &proof.id)?;
    fixture
        .engine
        .execute_action("start", string_params([("ticket", ticket.id.as_str())]))?;
    let started = fixture.store.ticket(&ticket.id)?;
    let mut ticket_engine = Engine::open(&ticket_engine_root(&started))?;
    record_output(
        &mut ticket_engine,
        &ticket.id,
        "execute-proof",
        "verifier",
        evidence_output("The exact targeted proof was executed and produced an adverse signal."),
    )?;
    let error = ticket_engine
        .execute_action(
            "compile-ticket",
            string_params([("ticket", ticket.id.as_str())]),
        )
        .expect_err("the adverse proof command must not be accepted");
    assert!(
        error.to_string().contains("proof-command")
            || error.to_string().contains("promotion-proof-set")
            || error.to_string().contains("expected exit"),
        "the failure remains tied to the configured proof boundary: {error}"
    );
    let adverse_receipts = composite_member_receipts(&fixture.store, "promotion-proof-set")?;
    assert!(
        adverse_receipts.iter().any(|receipt| {
            receipt
                .pointer("/execution_binding/compiled_member_binding/source_node_id")
                .and_then(Value::as_str)
                == Some(proof.id.as_str())
                && receipt.get("status").and_then(Value::as_str) == Some("failed")
        }),
        "the compiler keeps the current adverse terminal receipt instead of erasing the failed attempt"
    );

    let graph = fixture.store.graph()?;
    assert_eq!(
        graph.node(&proof.id).map(|node| node.status.as_str()),
        Some("planned")
    );
    assert_eq!(
        fixture.open_ticket_count("prepare-delivery")?,
        0,
        "the generic compiler preserves adverse evidence but deliberately does not project a model-authored failed/blocked proof status"
    );

    Ok(())
}

#[test]
fn software_preparation_current_rejects_effect_destination_and_historical_receipt_drift()
-> Result<(), Box<dyn Error>> {
    let (mut destination_fixture, diagnostic) =
        reviewed_diagnostic_fixture("Reject prepared-status destination drift")?;
    let mut drifted = destination_fixture
        .store
        .graph()?
        .node(&diagnostic.id)
        .expect("reviewed diagnostic remains in the graph")
        .clone();
    drifted.status = "planned".to_owned();
    destination_fixture.save_nodes([drifted])?;
    destination_fixture.compile("reviewed diagnostic with a drifted effect destination")?;
    assert_eq!(
        destination_fixture
            .open_ticket_count_for("diagnose-defect", &diagnostic.edges["verifies"][0])?,
        0,
        "a live subject that no longer has the compiler-recorded review effect cannot reuse preparation"
    );

    let (mut receipt_fixture, receipt_diagnostic) =
        reviewed_diagnostic_fixture("Reject backdated reviewed-receipt substitution")?;
    let preparation_ticket = receipt_fixture
        .store
        .tickets()?
        .into_iter()
        .find(|ticket| {
            ticket.operation == "prepare-proof"
                && ticket
                    .target_nodes
                    .iter()
                    .any(|target| target == &receipt_diagnostic.id)
        })
        .expect("the reviewed preparation ticket is durable");
    let substituted_receipt = json!({
        "schema_version": "1.0",
        "id": "backdated-receipt-substitution",
        "ticket_id": preparation_ticket.id,
        "receipt_type": "historical-substitution",
        "recorded_at": "2020-01-01T00:00:00Z",
        "receipt_hash": "sha256:coherently-rebound"
    });
    fs::write(
        receipt_fixture
            .store
            .receipts_dir()
            .join("backdated-receipt-substitution.yaml"),
        serde_yaml::to_string(&substituted_receipt)?,
    )?;
    receipt_fixture.compile("reviewed diagnostic with a substituted historical receipt")?;
    assert_eq!(
        receipt_fixture
            .open_ticket_count_for("diagnose-defect", &receipt_diagnostic.edges["verifies"][0],)?,
        0,
        "the reviewer input hash authenticates the exact historical raw receipt set"
    );
    Ok(())
}

#[test]
fn software_git_common_preparation_integrates_at_its_exact_ticket_materialization_boundary()
-> Result<(), Box<dyn Error>> {
    let (mut fixture, diagnostic) =
        reviewed_diagnostic_fixture("Integrate one Git-common proof preparation")?;
    let preparation = fixture
        .store
        .tickets()?
        .into_iter()
        .find(|ticket| {
            ticket.operation == "prepare-proof"
                && ticket
                    .target_nodes
                    .iter()
                    .any(|target| target == &diagnostic.id)
        })
        .expect("the integrated preparation ticket remains durable");
    assert_eq!(
        preparation.status, "closed",
        "the active Git-common review is visible while integration validates its own projected ticket, then becomes globally visible only after terminal publication"
    );
    assert_eq!(
        fixture
            .store
            .graph()?
            .node(&diagnostic.id)
            .map(|proof| proof.status.as_str()),
        Some("prepared")
    );

    fixture.compile("terminal Git-common preparation consumed by the global predicate")?;
    assert_eq!(
        fixture.open_ticket_count_for("prepare-proof", &diagnostic.id)?,
        0
    );
    assert_eq!(
        fixture.open_ticket_count_for("diagnose-defect", &diagnostic.edges["verifies"][0])?,
        1,
        "the same reviewed binding must survive the materialization-to-global authority transition"
    );
    Ok(())
}

fn reviewed_diagnostic_fixture(goal: &str) -> Result<(SoftwareFixture, Node), Box<dyn Error>> {
    let mut fixture = SoftwareFixture::new(goal)?;
    let mut objective = fixture.objective()?;
    objective
        .spec_object_mut()
        .insert("work_kind".to_owned(), Value::String("bug_fix".to_owned()));
    let system = fixture_system(false);
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);
    let defect = defect(&objective.id, &system.id, "unresolved");
    let change = material_change(
        "Deferred causal repair",
        &objective.id,
        &system.id,
        "routine",
        "planned",
    );
    let mut focused = semantic_proof(
        "Deferred repair proof",
        "focused",
        "planned",
        [&change.id, &defect.id],
    );
    set_proof_source_path(&mut focused, "tests/proof-source-secondary.txt");
    let diagnostic = semantic_proof(
        "Reviewed diagnostic preparation",
        "focused",
        "planned",
        [&defect.id],
    );
    fixture.save_nodes([
        objective,
        system,
        defect,
        change,
        focused,
        diagnostic.clone(),
    ])?;
    fixture.compile("diagnostic awaiting source-only preparation")?;
    fixture.complete_preparation_ticket(&diagnostic.id, None)?;
    Ok((fixture, diagnostic))
}

struct SoftwareFixture {
    _temp: TempDir,
    root: PathBuf,
    engine: Engine,
    store: StateStore,
}

impl SoftwareFixture {
    fn new(goal: &str) -> Result<Self, Box<dyn Error>> {
        let temp = TempDir::new()?;
        let root = temp.path().join("software-proof-gate");
        fs::create_dir_all(root.join("src"))?;
        fs::create_dir_all(root.join("tests"))?;
        fs::write(root.join("src/lib.rs"), "pub fn value() -> u8 { 1 }\n")?;
        fs::write(
            root.join("src/seam.rs"),
            "pub fn seam() -> bool { false }\n",
        )?;
        fs::write(
            root.join("src/unrelated.rs"),
            "pub fn unrelated() -> bool { true }\n",
        )?;
        fs::write(
            root.join("tests/proof-source.txt"),
            "fixture proof source\n",
        )?;
        fs::write(
            root.join("tests/proof-source-secondary.txt"),
            "secondary fixture proof source\n",
        )?;
        fs::write(
            root.join("tests/first-repair-proof.txt"),
            "first repair fixture proof source\n",
        )?;
        fs::write(
            root.join("tests/second-repair-proof.txt"),
            "second repair fixture proof source\n",
        )?;
        copy_tree(&software_profile_root(), &root.join(".codex/koni"))?;
        copy_tree(&software_codex_agents_root(), &root.join(".codex/agents"))?;
        initialize_repository(&root)?;

        let mut engine = Engine::open_with_profile(&root, None)?;
        let run_id = engine.initialize_run(goal)?;
        let store = state_store(&root, &run_id, &engine.profile().manifest.storage)?;
        Ok(Self {
            _temp: temp,
            root,
            engine,
            store,
        })
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn objective(&self) -> Result<Node, Box<dyn Error>> {
        self.store
            .graph()?
            .nodes_of_type("objective")
            .next()
            .cloned()
            .ok_or_else(|| "software initialization did not create an objective".into())
    }

    fn compile(&mut self, phase: &str) -> Result<(), Box<dyn Error>> {
        self.engine
            .compile(None, false)
            .map(|_| ())
            .map_err(|error| format!("{phase}: {error}").into())
    }

    fn save_nodes<const N: usize>(&self, nodes: [Node; N]) -> Result<(), Box<dyn Error>> {
        let mut graph = self.store.graph()?;
        let node_ids = nodes.iter().map(|node| node.id.clone()).collect::<Vec<_>>();
        for node in nodes {
            graph.upsert(node);
        }
        for node_id in node_ids {
            graph.save_node(&self.store.graph_dir(), &node_id)?;
        }
        Ok(())
    }

    fn open_tickets(&self, operation: &str) -> Result<Vec<Ticket>, Box<dyn Error>> {
        Ok(self
            .store
            .tickets()?
            .into_iter()
            .filter(|ticket| ticket.operation == operation)
            .filter(|ticket| !matches!(ticket.status.as_str(), "closed" | "retired"))
            .collect())
    }

    fn open_ticket_count(&self, operation: &str) -> Result<usize, Box<dyn Error>> {
        Ok(self.open_tickets(operation)?.len())
    }

    fn open_ticket_count_for(
        &self,
        operation: &str,
        target: &str,
    ) -> Result<usize, Box<dyn Error>> {
        Ok(self
            .open_tickets(operation)?
            .iter()
            .filter(|ticket| ticket.target_nodes.iter().any(|node_id| node_id == target))
            .count())
    }

    fn only_open_ticket(&self, operation: &str) -> Result<Ticket, Box<dyn Error>> {
        let tickets = self.open_tickets(operation)?;
        match tickets.as_slice() {
            [ticket] => Ok(ticket.clone()),
            _ => Err(format!(
                "expected one open {operation} ticket, found {}",
                tickets.len()
            )
            .into()),
        }
    }

    fn only_open_ticket_for(
        &self,
        operation: &str,
        target: &str,
    ) -> Result<Ticket, Box<dyn Error>> {
        let tickets = self
            .open_tickets(operation)?
            .into_iter()
            .filter(|ticket| ticket.target_nodes.iter().any(|node_id| node_id == target))
            .collect::<Vec<_>>();
        match tickets.as_slice() {
            [ticket] => Ok(ticket.clone()),
            _ => Err(format!(
                "expected one open {operation} ticket for {target}, found {}",
                tickets.len()
            )
            .into()),
        }
    }

    fn complete_proof_ticket(&mut self, proof_id: &str) -> Result<(), Box<dyn Error>> {
        let ticket = self.only_open_ticket_for("establish-proof", proof_id)?;
        self.engine
            .execute_action("start", string_params([("ticket", ticket.id.as_str())]))?;
        let started = self.store.ticket(&ticket.id)?;
        let mut ticket_engine = Engine::open(&ticket_engine_root(&started))?;
        record_output(
            &mut ticket_engine,
            &ticket.id,
            "execute-proof",
            "verifier",
            evidence_output("The exact compiler-bound proof command passed with current inputs."),
        )?;
        ticket_engine.execute_action(
            "compile-ticket",
            string_params([("ticket", ticket.id.as_str())]),
        )?;
        ticket_engine
            .review_ticket_with(
                &ticket.id,
                &StaticReviewLauncher::passing(
                    "The current command receipt establishes the bounded semantic claim.",
                ),
            )
            .map_err(|error| format!("proof semantic review failed: {error}"))?;
        self.engine.execute_action(
            "finish",
            string_params([
                ("ticket", ticket.id.as_str()),
                ("message", "test: establish current software proof"),
            ]),
        )?;
        Ok(())
    }

    fn complete_implementation_ticket(&mut self, change_id: &str) -> Result<(), Box<dyn Error>> {
        self.complete_implementation_ticket_with_change(change_id, None)
    }

    fn complete_implementation_ticket_with_product_change(
        &mut self,
        change_id: &str,
        path: &str,
        contents: &str,
    ) -> Result<(), Box<dyn Error>> {
        self.complete_implementation_ticket_with_change(change_id, Some((path, contents)))
    }

    fn complete_implementation_ticket_with_change(
        &mut self,
        change_id: &str,
        product_change: Option<(&str, &str)>,
    ) -> Result<(), Box<dyn Error>> {
        let ticket = self.only_open_ticket_for("implement-change", change_id)?;
        self.engine
            .execute_action("start", string_params([("ticket", ticket.id.as_str())]))?;
        let started = self.store.ticket(&ticket.id)?;
        let mut ticket_engine = Engine::open(&ticket_engine_root(&started))?;
        for (step, finding) in [
            (
                "establish-baseline",
                "The exact graph-selected proof set already exercises the bounded outcome.",
            ),
            (
                "implement",
                "The smallest cohesive bounded production change is complete and its preserved promotion set passes.",
            ),
        ] {
            let persona = ticket
                .workflow
                .iter()
                .find(|candidate| candidate.id == step)
                .map(|candidate| candidate.persona.as_str())
                .ok_or_else(|| format!("implementation ticket has no {step} step"))?;
            let payload = if step == "implement"
                && let Some((path, contents)) = product_change
            {
                let absolute = ticket_engine_root(&started).join(path);
                if let Some(parent) = absolute.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(absolute, contents)?;
                evidence_output_with_written(finding, &[path])
            } else {
                evidence_output(finding)
            };
            record_output(&mut ticket_engine, &ticket.id, step, persona, payload)?;
            ticket_engine.execute_action(
                "compile-ticket",
                string_params([("ticket", ticket.id.as_str())]),
            )?;
        }
        ticket_engine
            .review_ticket_with(
                &ticket.id,
                &StaticReviewLauncher::passing(
                    "The implementation claim and its exact proof set satisfy the review boundary.",
                ),
            )
            .map_err(|error| format!("implementation review failed: {error}"))?;
        self.engine.execute_action(
            "finish",
            string_params([
                ("ticket", ticket.id.as_str()),
                ("message", "feat: implement bounded software change"),
            ]),
        )?;
        Ok(())
    }

    fn complete_preparation_ticket(
        &mut self,
        proof_id: &str,
        source_write: Option<(&str, &str)>,
    ) -> Result<(), Box<dyn Error>> {
        let ticket = self.only_open_ticket_for("prepare-proof", proof_id)?;
        self.engine
            .execute_action("start", string_params([("ticket", ticket.id.as_str())]))?;
        let started = self.store.ticket(&ticket.id)?;
        let mut ticket_engine = Engine::open(&ticket_engine_root(&started))?;
        let files_written = if let Some((path, contents)) = source_write {
            let absolute = ticket_engine_root(&started).join(path);
            if let Some(parent) = absolute.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(absolute, contents)?;
            vec![path]
        } else {
            Vec::new()
        };
        record_output(
            &mut ticket_engine,
            &ticket.id,
            "author-historical-baseline",
            "implementer",
            evidence_output_with_written(
                "The proof-only source seam now records its honest historical baseline.",
                &files_written,
            ),
        )?;
        ticket_engine.execute_action(
            "compile-ticket",
            string_params([("ticket", ticket.id.as_str())]),
        )?;
        ticket_engine
            .review_ticket_with(
                &ticket.id,
                &StaticReviewLauncher::passing(
                    "The historical proof seam is relevant, bounded, and free of production edits.",
                ),
            )
            .map_err(|error| format!("proof preparation review failed: {error}"))?;
        self.engine.execute_action(
            "finish",
            string_params([
                ("ticket", ticket.id.as_str()),
                ("message", "test: prepare bounded proof source"),
            ]),
        )?;
        Ok(())
    }

    fn complete_graph_ticket<const N: usize>(
        &mut self,
        operation: &str,
        target_id: &str,
        step: &str,
        persona: &str,
        nodes: [Node; N],
        review_summary: &str,
    ) -> Result<(), Box<dyn Error>> {
        let ticket = self.only_open_ticket_for(operation, target_id)?;
        self.engine
            .execute_action("start", string_params([("ticket", ticket.id.as_str())]))?;
        let started = self.store.ticket(&ticket.id)?;
        let mut ticket_engine = Engine::open(&ticket_engine_root(&started))?;
        record_output(
            &mut ticket_engine,
            &ticket.id,
            step,
            persona,
            graph_output_many(&nodes, "Continue through independent semantic review."),
        )?;
        ticket_engine
            .review_ticket_with(&ticket.id, &StaticReviewLauncher::passing(review_summary))
            .map_err(|error| format!("{operation} review failed: {error}"))?;
        self.engine.execute_action(
            "finish",
            string_params([
                ("ticket", ticket.id.as_str()),
                ("message", "test: advance bounded software graph"),
            ]),
        )?;
        Ok(())
    }

    fn complete_delivery_ticket(
        &mut self,
        objective_id: &str,
        delivery: &Node,
    ) -> Result<(), Box<dyn Error>> {
        let ticket = self.only_open_ticket_for("prepare-delivery", objective_id)?;
        self.engine
            .execute_action("start", string_params([("ticket", ticket.id.as_str())]))?;
        let started = self.store.ticket(&ticket.id)?;
        let mut ticket_engine = Engine::open(&ticket_engine_root(&started))?;
        record_output(
            &mut ticket_engine,
            &ticket.id,
            "assemble-candidate",
            "integrator",
            graph_output(delivery, "Review the exact delivery candidate."),
        )?;
        ticket_engine
            .review_ticket_with(
                &ticket.id,
                &StaticReviewLauncher::passing(
                    "The candidate exact-covers the current objective closure.",
                ),
            )
            .map_err(|error| format!("delivery review failed: {error}"))?;
        self.engine.execute_action(
            "finish",
            string_params([
                ("ticket", ticket.id.as_str()),
                ("message", "test: assemble exact software delivery"),
            ]),
        )?;
        Ok(())
    }
}

trait NodeSpecExt {
    fn spec_object_mut(&mut self) -> &mut serde_json::Map<String, Value>;
}

impl NodeSpecExt for Node {
    fn spec_object_mut(&mut self) -> &mut serde_json::Map<String, Value> {
        self.spec
            .as_object_mut()
            .expect("fixture node spec is an object")
    }
}

fn additional_objective(title: &str, work_kind: &str, system_id: &str) -> Node {
    let mut node = Node::new(
        "objective",
        title,
        json!({
            "outcome": title,
            "work_kind": work_kind,
            "motivation": "Exercise an independent objective boundary."
        }),
    );
    node.status = "active".to_owned();
    node.edges
        .insert("systems".to_owned(), vec![system_id.to_owned()]);
    node
}

fn fixture_system(contract_required: bool) -> Node {
    let mut node = Node::new(
        "system",
        "Proof gate fixture",
        json!({
            "kind": "package",
            "responsibility": "Provide the bounded fixture behavior.",
            "contract_required": contract_required,
            "contract_reason": if contract_required {
                "A compatibility promise constrains the fixture."
            } else {
                "Ordinary repository behavior is sufficient for this local fixture."
            },
            "owned_paths": ["src"]
        }),
    );
    node.status = "active".to_owned();
    node
}

fn contract_for(system_id: &str) -> Node {
    let mut node = Node::new(
        "contract",
        "Fixture compatibility contract",
        json!({
            "invariant": "The public fixture behavior remains compatible.",
            "enforcement_point": "The focused repository check.",
            "failure_meaning": "The material compatibility promise regressed.",
            "observability": "The command exits nonzero."
        }),
    );
    node.status = "active".to_owned();
    node.edges
        .insert("applies_to".to_owned(), vec![system_id.to_owned()]);
    node
}

fn material_change(
    title: &str,
    objective_id: &str,
    system_id: &str,
    risk_tier: &str,
    status: &str,
) -> Node {
    let mut node = Node::new(
        "change",
        title,
        json!({
            "approval_claim": format!("Approve the bounded outcome: {title}."),
            "current_state": "The bounded fixture behavior is unchanged.",
            "target_state": title,
            "owned_paths": ["src/lib.rs"],
            "blast_radius": "The fixture library only.",
            "commit_type": "feat",
            "risk_tier": risk_tier,
            "risk_factors": [format!("{risk_tier} fixture boundary")],
            "proof_strategy": "current_verification"
        }),
    );
    node.status = status.to_owned();
    node.edges
        .insert("realizes".to_owned(), vec![objective_id.to_owned()]);
    node.edges
        .insert("affects".to_owned(), vec![system_id.to_owned()]);
    node
}

fn material_migration(title: &str, system_id: &str, proof_strategy: &str) -> Node {
    let mut node = Node::new(
        "migration",
        title,
        json!({
            "forward_plan": ["Apply the bounded compatibility transition."],
            "owned_paths": ["src/lib.rs"],
            "compatibility_window": "The old and new fixture values are accepted during this bounded run.",
            "rollback_plan": ["Restore the prior fixture value."],
            "data_safety": "The fixture contains no durable data mutation.",
            "proof_strategy": proof_strategy
        }),
    );
    node.status = "planned".to_owned();
    node.edges
        .insert("changes".to_owned(), vec![system_id.to_owned()]);
    node
}

fn semantic_proof<'a>(
    title: &str,
    purpose: &str,
    status: &str,
    verifies: impl IntoIterator<Item = &'a String>,
) -> Node {
    let mut node = Node::new(
        "proof",
        title,
        json!({
            "purpose": purpose,
            "baseline_check_id": "proof-current-baseline",
            "claim": format!("{title} establishes its bounded semantic claim."),
            "method": "Run the smallest repository-owned command.",
            "command": ["true"],
            "source_paths": ["tests/proof-source.txt"],
            "covered_paths": ["src/lib.rs"],
            "oracle_cases": [{
                "id": "bounded-behavior",
                "condition": "Execute the current composed fixture behavior.",
                "claim": format!("{title} establishes its bounded semantic claim."),
                "production_seam": "src/lib.rs::value",
                "seam_paths": ["src/lib.rs"],
                "action": "Invoke value() through the repository-owned proof source.",
                "assertions": [
                    "The bounded return value matches the expected signal.",
                    "Behavior outside the bounded fixture is not modified."
                ],
                "environment": "The isolated Software proof fixture.",
                "recipe": ["Load the callable production seam.", "Invoke the bounded behavior."]
            }],
            "working_directory": ".",
            "layer": if purpose == "focused" { "unit" } else { "integration" },
            "conditions": ["Execute against the current composed source tree."],
            "expected_signal": "The command exits successfully.",
            "why": "The command directly exercises the bounded fixture claim.",
            "not_proven": ["Repository behavior outside this bounded fixture."]
        }),
    );
    node.status = status.to_owned();
    node.edges.insert(
        "verifies".to_owned(),
        verifies.into_iter().cloned().collect(),
    );
    node
}

fn defect(objective_id: &str, system_id: &str, status: &str) -> Node {
    let mut node = Node::new(
        "defect",
        "Fixture returns the wrong value",
        json!({
            "expected_behavior": "The fixture returns the requested bounded value.",
            "observed_behavior": "The fixture returns its old value.",
            "reproduction_signal": "Run the focused repository check and observe the mismatch.",
            "impact": "The bounded caller observes the wrong value.",
            "environment": "The isolated repository fixture."
        }),
    );
    node.status = status.to_owned();
    node.edges
        .insert("concerns".to_owned(), vec![objective_id.to_owned()]);
    node.edges
        .insert("manifests_in".to_owned(), vec![system_id.to_owned()]);
    node
}

fn add_causal_diagnosis(node: &mut Node) {
    node.spec_object_mut().insert(
        "root_cause".to_owned(),
        Value::String("The fixture returns before applying its bounded condition.".to_owned()),
    );
    node.spec_object_mut().insert(
        "causal_chain".to_owned(),
        json!([
            "input reaches the fixture",
            "the early return skips the condition"
        ]),
    );
    node.spec_object_mut().insert(
        "ruled_out_alternatives".to_owned(),
        json!(["caller supplied the expected input"]),
    );
}

fn set_proof_source_path(node: &mut Node, source_path: &str) {
    node.spec_object_mut()
        .insert("source_paths".to_owned(), json!([source_path]));
}

fn configure_expected_red_proof(node: &mut Node, source_path: &str, needle: &str) {
    node.spec_object_mut().insert(
        "baseline_check_id".to_owned(),
        Value::String("proof-expected-red".to_owned()),
    );
    node.spec_object_mut().insert(
        "command".to_owned(),
        json!(["grep", "-q", needle, "src/lib.rs"]),
    );
    set_proof_source_path(node, source_path);
}

fn material_risk(treatment: &str, system_id: &str) -> Node {
    let mut node = Node::new(
        "risk",
        "Fixture boundary regression",
        json!({
            "scenario": "The changed boundary returns an incompatible result.",
            "impact": "The bounded caller observes a regression.",
            "likelihood": "possible",
            "detection": "The boundary proof exits nonzero.",
            "treatment": treatment,
            "treatment_rationale": "Keep the response proportional to the bounded exposure.",
            "residual_risk": "An unrelated caller remains outside this fixture."
        }),
    );
    node.status = "active".to_owned();
    node.edges
        .insert("threatens".to_owned(), vec![system_id.to_owned()]);
    node
}

fn accepted_risk_decision(risk_id: &str) -> Node {
    let mut node = Node::new(
        "decision",
        "Accept the bounded residual fixture exposure",
        json!({
            "kind": "risk_acceptance",
            "question": "May this explicitly bounded residual exposure be accepted?",
            "options": ["accept the bounded exposure", "add another control"],
            "choice": "accept the bounded exposure",
            "rationale": "The approved exposure is reversible and explicitly observed.",
            "reversibility": "Reopen planning and add the control."
        }),
    );
    node.status = "accepted".to_owned();
    node.edges
        .insert("concerns".to_owned(), vec![risk_id.to_owned()]);
    node
}

fn accepted_review_authority_decision(change_id: &str) -> Node {
    let mut node = Node::new(
        "decision",
        "Require qualified review for the critical fixture change",
        json!({
            "kind": "review_authority",
            "question": "Who may approve this critical bounded change?",
            "options": ["qualified independent reviewer", "return to planning"],
            "choice": "qualified independent reviewer",
            "rationale": "Critical work needs explicit domain-qualified review authority.",
            "reversibility": "Return the change to planning before implementation."
        }),
    );
    node.status = "accepted".to_owned();
    node.edges
        .insert("concerns".to_owned(), vec![change_id.to_owned()]);
    node
}

fn delivery_node<'a>(
    objective_id: &str,
    includes: impl IntoIterator<Item = &'a String>,
    acknowledges: impl IntoIterator<Item = &'a String>,
) -> Node {
    let mut node = Node::new(
        "delivery",
        "Exact proof-gated delivery",
        json!({
            "target_branch": "main",
            "summary": "Deliver the exact objective closure with current evidence."
        }),
    );
    node.status = "assembling".to_owned();
    node.edges
        .insert("fulfills".to_owned(), vec![objective_id.to_owned()]);
    node.edges.insert(
        "includes".to_owned(),
        includes.into_iter().cloned().collect(),
    );
    node.edges.insert(
        "acknowledges".to_owned(),
        acknowledges.into_iter().cloned().collect(),
    );
    node
}

fn evidence_output(finding: &str) -> Value {
    evidence_output_with_written(finding, &[])
}

fn evidence_output_with_written(finding: &str, files_written: &[&str]) -> Value {
    json!({
        "files_read": [],
        "files_written": files_written,
        "findings": [finding],
        "risks": [],
        "patch_proposal": "",
        "recommended_next_step": "Continue through the configured trust boundary."
    })
}

fn graph_output(node: &Node, next_step: &str) -> Value {
    graph_output_many(std::slice::from_ref(node), next_step)
}

fn graph_output_many(nodes: &[Node], next_step: &str) -> Value {
    let nodes = nodes
        .iter()
        .map(|node| {
            let mut node = serde_json::to_value(node).expect("graph node serializes");
            node.as_object_mut()
                .expect("graph node is an object")
                .remove("status");
            node
        })
        .collect::<Vec<_>>();
    json!({
        "files_read": [],
        "files_written": [],
        "findings": ["The graph delta records its exact bounded semantic closure."],
        "risks": [],
        "patch_proposal": "",
        "recommended_next_step": next_step,
        "graph_delta": {"upsert": nodes, "delete": []}
    })
}

struct StaticReviewLauncher {
    output: String,
    requests: RefCell<Vec<AgentProcessRequest>>,
}

impl StaticReviewLauncher {
    fn passing(summary: &str) -> Self {
        Self {
            output: serde_json::to_string(&json!({
                "schema_version": "1.1",
                "verdict": "passed",
                "failure_domain": "none",
                "summary": summary,
                "findings": ["No blocking findings remain at the configured boundary."],
                "evidence_pointers": ["packet://review/acceptance"]
            }))
            .expect("review result serializes"),
            requests: RefCell::new(Vec::new()),
        }
    }

    fn failed(summary: &str) -> Self {
        Self::failed_with_domain(summary, "ticket_rework")
    }

    fn failed_with_domain(summary: &str, failure_domain: &str) -> Self {
        Self {
            output: serde_json::to_string(&json!({
                "schema_version": "1.1",
                "verdict": "failed",
                "failure_domain": failure_domain,
                "summary": summary,
                "findings": ["The configured proof-oracle boundary is not yet satisfied."],
                "evidence_pointers": ["packet://review/acceptance"]
            }))
            .expect("review result serializes"),
            requests: RefCell::new(Vec::new()),
        }
    }
}

impl AgentProcessLauncher for StaticReviewLauncher {
    fn is_alive(&self, _pid: u32) -> bool {
        false
    }

    fn run(
        &self,
        request: &AgentProcessRequest,
        on_started: &mut dyn FnMut(u32) -> koni_core::Result<()>,
    ) -> koni_core::Result<AgentProcessResult> {
        self.requests.borrow_mut().push(request.clone());
        let pid = 45_003;
        on_started(pid)?;
        fs::write(&request.stdout_path, "{\"type\":\"turn.completed\"}\n")
            .expect("write review events");
        fs::write(&request.stderr_path, "").expect("write review stderr");
        let output_path = request
            .args
            .windows(2)
            .find(|pair| pair[0] == "--output-last-message")
            .map(|pair| PathBuf::from(&pair[1]))
            .expect("review request includes output path");
        fs::write(output_path, &self.output).expect("write review result");
        Ok(AgentProcessResult {
            pid,
            exit_code: Some(0),
            timed_out: false,
        })
    }
}

fn ticket_engine_root(ticket: &Ticket) -> PathBuf {
    ticket
        .lease
        .as_ref()
        .expect("started ticket has a lease")
        .worktree
        .clone()
}

fn record_output(
    engine: &mut Engine,
    ticket: &str,
    step: &str,
    persona: &str,
    payload: Value,
) -> Result<(), Box<dyn Error>> {
    let payload = serde_json::to_string(&payload)?;
    engine.execute_action(
        "output",
        string_params([
            ("ticket", ticket),
            ("step", step),
            ("persona", persona),
            ("payload", payload.as_str()),
        ]),
    )?;
    Ok(())
}

fn fail_implementation_review_as_upstream(
    fixture: &mut SoftwareFixture,
    operation: &str,
    subject_id: &str,
    product_contents: &str,
) -> Result<Ticket, Box<dyn Error>> {
    let ticket = fixture.only_open_ticket_for(operation, subject_id)?;
    assert_eq!(
        ticket.extensions["review_failure_routes"]["ticket_rework"]["disposition"],
        json!("reopen")
    );
    assert_eq!(
        ticket.extensions["review_failure_routes"]["upstream_proof"]["disposition"],
        json!("block")
    );
    fixture
        .engine
        .execute_action("start", string_params([("ticket", ticket.id.as_str())]))?;
    let started = fixture.store.ticket(&ticket.id)?;
    let worktree = ticket_engine_root(&started);
    let mut ticket_engine = Engine::open(&worktree)?;
    record_output(
        &mut ticket_engine,
        &ticket.id,
        "establish-baseline",
        "implementer",
        evidence_output(
            "Every prepared proof still produces its compiler-bound historical signal.",
        ),
    )?;
    ticket_engine.execute_action(
        "compile-ticket",
        string_params([("ticket", ticket.id.as_str())]),
    )?;
    fs::write(worktree.join("src/lib.rs"), product_contents)?;
    record_output(
        &mut ticket_engine,
        &ticket.id,
        "implement",
        "implementer",
        evidence_output_with_written(
            "The candidate passes the frozen proof source, but final review identifies that source as incomplete.",
            &["src/lib.rs"],
        ),
    )?;
    ticket_engine.execute_action(
        "compile-ticket",
        string_params([("ticket", ticket.id.as_str())]),
    )?;
    ticket_engine.review_ticket_with(
        &ticket.id,
        &StaticReviewLauncher::failed_with_domain(
            "The prepared oracle misses a declared production consumer and cannot be repaired with product-only authority.",
            "upstream_proof",
        ),
    )?;

    let held = fixture.store.ticket(&ticket.id)?;
    assert_eq!(held.status, "blocked");
    assert!(
        held.outputs
            .iter()
            .any(|output| output.step_id == "establish-baseline")
    );
    assert!(
        held.outputs
            .iter()
            .any(|output| output.step_id == "implement"),
        "the rejected candidate stays durable rather than becoming a rework input"
    );
    assert!(
        held.extensions
            .get("superseded_outputs")
            .and_then(Value::as_array)
            .is_none_or(|outputs| outputs.is_empty()),
        "an upstream hold does not supersede only product output"
    );
    assert_eq!(
        held.reviews
            .last()
            .and_then(|review| review.agent_binding.as_ref())
            .and_then(|binding| binding.failure_domain.as_deref()),
        Some("upstream_proof")
    );
    assert_eq!(
        held.extensions["review_failure_hold"]["recovery"],
        json!("replan_from_clean_integration")
    );
    assert_eq!(
        held.extensions["review_failure_hold"]["clean_integration_required"],
        json!(true)
    );
    assert_eq!(
        held.extensions["review_failure_hold"]["rejected_candidate_preserved"],
        json!(true)
    );
    assert!(
        held.lease
            .as_ref()
            .and_then(|lease| lease.worker_pid)
            .is_none()
    );
    assert!(!held.extensions.contains_key("active_worker"));
    assert!(worktree.join("src/lib.rs").is_file());
    let board = fixture.engine.inspect()?;
    assert!(
        !board.eligible_tickets.contains(&ticket.id),
        "no replacement Implementer is dispatchable from an upstream failure"
    );
    Ok(held)
}

fn composite_member_receipts(
    store: &StateStore,
    parent_check_id: &str,
) -> Result<Vec<Value>, Box<dyn Error>> {
    let mut receipts = Vec::new();
    for entry in fs::read_dir(store.receipts_dir())? {
        let path = entry?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("yaml") {
            continue;
        }
        let receipt: Value = serde_yaml::from_str(&fs::read_to_string(path)?)?;
        if receipt
            .pointer("/execution_binding/compiled_member_binding/parent_check_id")
            .and_then(Value::as_str)
            == Some(parent_check_id)
        {
            receipts.push(receipt);
        }
    }
    Ok(receipts)
}

fn state_store(
    root: &Path,
    run_id: &str,
    storage: &koni_core::config::StorageConfig,
) -> Result<StateStore, Box<dyn Error>> {
    let backend = GitBackend::discover(root)?;
    Ok(StateStore::with_storage(
        backend.sidecar_path(format!("runs/{run_id}"))?,
        storage,
    )?)
}

fn software_profile_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../koni-cli/templates/software")
}

fn software_codex_agents_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../koni-cli/templates/codex/software/agents")
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), Box<dyn Error>> {
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry?;
        let relative = entry.path().strip_prefix(source)?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn initialize_repository(root: &Path) -> Result<Repository, Box<dyn Error>> {
    let repository = Repository::init(root)?;
    let mut index = repository.index()?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    {
        let tree = repository.find_tree(tree_id)?;
        let signature = Signature::now("Fixture Author", "fixture@example.local")?;
        repository.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "chore: initialize software proof fixture",
            &tree,
            &[],
        )?;
    }
    Ok(repository)
}

fn string_params<const N: usize>(pairs: [(&str, &str); N]) -> BTreeMap<String, String> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}
