use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
use std::time::Duration;

use git2::{IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature, StatusOptions};
use koni_core::config::{ChangeControlDispositionKind, OperationChangeControlDef};
use koni_core::git::GitBackend;
use koni_core::graph::{Graph, Node, normalized_hash};
use koni_core::state::{Event, Scope, StateStore, Ticket};
use koni_core::{
    AgentProcessLauncher, AgentProcessRequest, AgentProcessResult, AgentSessionRecord, Engine,
    ProfileCompiler, RunControlStore, capture_owned_agent_process_identity,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use walkdir::WalkDir;

#[test]
fn research_profile_owns_the_complete_typed_change_control_route() -> Result<(), Box<dyn Error>> {
    let profile = ProfileCompiler::compile(&profile_root())?;

    let ordinary = &profile.operations["formulation.hypothesis.drill-hypothesis"];
    assert_eq!(
        ordinary.change_control,
        OperationChangeControlDef::Ordinary {
            allow_upstream_requests: true,
            proposal_operation: Some("change-request".to_owned()),
        }
    );
    assert!(matches!(
        profile.operations["lifecycle.change-request"].change_control,
        OperationChangeControlDef::Proposal {
            ref proposal_step,
            ref application_operations,
        } if proposal_step == "propose-graph-delta"
            && application_operations == &["apply-change-request", "no-op"]
    ));
    assert_eq!(
        profile.operations["lifecycle.apply-change-request"].change_control,
        OperationChangeControlDef::Application
    );
    assert_eq!(
        profile.operations["lifecycle.no-op"].change_control,
        OperationChangeControlDef::Disposition {
            outcome: ChangeControlDispositionKind::NoOp,
        }
    );
    Ok(())
}

#[test]
fn gate_policy_rank_relations_must_connect_candidate_types_to_gate_types()
-> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let installed = temp.path().join(".codex/koni");
    copy_fixture(&profile_root(), &installed)?;
    let edges_path = installed.join("graph/edges.yaml");
    let edges = fs::read_to_string(&edges_path)?;
    fs::write(
        &edges_path,
        edges.replacen(
            "kind: edge_contains_gate, relations: [validates]",
            "kind: edge_contains_gate, relations: [supports]",
            1,
        ),
    )?;

    let error = ProfileCompiler::compile(&installed)
        .expect_err("a globally known but candidate-incompatible rank relation must fail closed");

    assert!(
        error
            .to_string()
            .contains("is not an edge from a candidate node type to a gate node type"),
        "{error}"
    );
    Ok(())
}

#[test]
fn research_experiment_ontology_is_owned_by_compiled_profile_contracts()
-> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;
    initialize_repository(&root)?;

    let engine = Engine::open_with_profile(&root, None)?;
    let experiment = &engine.profile().node_types["experiment"];
    assert!(
        experiment
            .effective_description()
            .contains("executable empirical intervention or observation")
    );
    assert_eq!(
        experiment.annotations["ontology_contract"]["category"],
        "empirical_execution"
    );
    assert!(
        experiment.annotations["ontology_contract"]["excluded_work"]
            .as_array()
            .expect("excluded work is a configured list")
            .iter()
            .any(|value| value == "static reasoning or proof")
    );
    for field in [
        "objective",
        "target_claim_summary",
        "empirical_mode",
        "execution_protocol",
        "observable_outcome",
    ] {
        assert!(
            experiment.fields[field].required,
            "experiment ontology marker {field} must be structurally required by config"
        );
    }
    assert_eq!(
        experiment.fields["empirical_mode"].enum_values,
        vec![json!("intervention"), json!("observation")]
    );

    let designer = engine.profile().resolve_persona("experiment-designer")?;
    assert!(
        designer
            .instructions
            .contains("prospective empirical execution")
    );
    assert!(designer.instructions.contains("traceability mapping"));
    assert!(
        designer
            .instructions
            .contains("instead of fabricating an experiment")
    );
    let reviewer = engine.profile().resolve_persona("reviewer")?;
    assert!(
        reviewer
            .instructions
            .contains("enforce the configured experiment ontology")
    );
    assert!(
        reviewer
            .instructions
            .contains("Reject placeholder empirical fields")
    );
    assert!(reviewer.instructions.contains("one-node-per-check"));
    let lead = engine.profile().resolve_persona("lead")?;
    assert!(
        lead.instructions
            .contains("also enforce its configured ontology contract")
    );
    assert!(lead.instructions.contains("Fail review"));

    let portfolio = &engine.profile().workflows["design-experiment-portfolio"];
    let design = portfolio
        .steps
        .iter()
        .find(|step| step.id == "design-experiment-portfolio")
        .expect("portfolio workflow has a design step");
    assert!(design.expected_output.contains("empirical_mode"));
    assert!(design.expected_output.contains("observable_outcome"));
    assert!(
        design
            .stop_conditions
            .contains(&"non-empirical-experiment".to_owned())
    );
    let review = portfolio
        .steps
        .iter()
        .find(|step| step.id == "review")
        .expect("portfolio workflow has a review step");
    assert!(
        review
            .expected_output
            .contains("non-empirical experiment nodes")
    );
    assert!(
        review
            .stop_conditions
            .contains(&"experiment-ontology-failed".to_owned())
    );

    let operation = &engine.profile().operations["experiment-design.hypothesis.design-experiment"];
    assert!(operation.output_contract.contains("execution_protocol"));
    assert!(operation.review_contract.contains("traceability audit"));
    assert_eq!(operation.max_new_nodes, Some(3));
    assert_eq!(
        operation.existing_node_edge_additions_only["hypothesis"],
        vec!["experiments"]
    );
    assert_eq!(
        operation.existing_node_edge_additions_only["claim"],
        vec!["tested_by"]
    );
    assert_eq!(
        operation.extensions["portfolio_guidance"]["preferred_count"],
        2
    );
    assert_eq!(
        operation.extensions["portfolio_guidance"]["unit"],
        "cohesive empirical program"
    );
    assert!(
        designer
            .instructions
            .contains("follow the compiled operation's")
    );
    let priority = |id: &str| engine.profile().operations[id].dispatch_priority;
    assert!(
        priority("formulation.hypothesis.drill-hypothesis")
            > priority("experiment-design.hypothesis.design-experiment")
    );
    assert!(
        priority("experiment-design.hypothesis.design-experiment")
            > priority("preparation.experiment.design-experiment")
    );
    assert!(
        priority("preparation.experiment.design-experiment")
            > priority("graph-compilation.node.define-gates")
    );
    assert!(
        priority("graph-compilation.node.define-gates")
            > priority("asset-resolution.prerequisite.resolve-assets")
    );
    assert!(
        priority("asset-resolution.prerequisite.resolve-assets") > priority("gates.gate.run-gate")
    );
    assert!(priority("gates.gate.run-gate") > priority("execution.node.compile-run-plan"));
    assert!(
        priority("execution.node.compile-run-plan")
            > priority("evidence-reports.node.synthesize-evidence")
    );
    let evidence_operation =
        &engine.profile().operations["evidence-reports.node.synthesize-evidence"];
    let receipt_coverage = evidence_operation
        .receipt_coverage
        .as_ref()
        .expect("evidence synthesis owns exact receipt coverage");
    assert_eq!(receipt_coverage.candidate_node_types, vec!["evidence"]);
    assert_eq!(receipt_coverage.candidate_link_relation, "from_runs");
    assert_eq!(receipt_coverage.receipt_type, "runtime.receipt");
    assert_eq!(
        receipt_coverage.disposition.allowed_values,
        vec!["supports", "contradicts", "neutral", "out_of_scope"]
    );
    let claim_tested_by = engine
        .profile()
        .edge_types
        .iter()
        .find(|edge| edge.source == "claim" && edge.relation == "tested_by")
        .expect("claim tested_by edge exists");
    assert_eq!(claim_tested_by.inverse.as_deref(), Some("target_claims"));
    let experiment_target_claims = engine
        .profile()
        .edge_types
        .iter()
        .find(|edge| edge.source == "experiment" && edge.relation == "target_claims")
        .expect("experiment target_claims edge exists");
    assert_eq!(
        experiment_target_claims.inverse.as_deref(),
        Some("tested_by")
    );

    let evidence = &engine.profile().node_types["evidence"];
    for field in [
        "spec.promotion_state",
        "spec.promoted_by",
        "spec.promotion_review_id",
    ] {
        assert!(evidence.compiler_owned_fields.contains(&field.to_owned()));
    }
    let promotion =
        &engine.profile().operations["evidence-reports.node.synthesize-evidence"].review_effects[0];
    assert_eq!(promotion.count.exact, Some(1));
    assert_eq!(promotion.set["spec.promotion_state"], "lead-promoted");
    assert_eq!(promotion.set["spec.promoted_by"], "lead");
    assert_eq!(promotion.set["spec.promotion_review_id"], "$review.id");

    let report = &engine.profile().node_types["report"];
    for field in ["spec.concluded_by", "spec.conclusion_review_id"] {
        assert!(report.compiler_owned_fields.contains(&field.to_owned()));
    }
    for field in [
        "claim_dispositions",
        "curated_evidence_refs",
        "conclusion_rationale",
        "hypothesis_id",
        "paper_context_role",
        "paper_input_role",
        "paper_section",
        "paper_input_status",
    ] {
        assert!(report.fields.contains_key(field));
    }
    let conclusion_operation =
        &engine.profile().operations["evidence-reports.hypothesis.conclude-hypothesis"];
    assert_eq!(
        conclusion_operation.allowed_existing_node_types,
        vec!["report"]
    );
    let conclusion = &conclusion_operation.review_effects[0];
    assert_eq!(conclusion.count.exact, Some(1));
    assert_eq!(conclusion.coverage.len(), 5);
    assert!(conclusion.coverage.iter().any(|coverage| {
        coverage.id == "exact-hypothesis-reference"
            && coverage.actual.kind == koni_core::config::ReviewEffectCoverageActualKind::FieldValue
    }));
    assert_eq!(conclusion.set["spec.concluded_by"], "lead");
    assert_eq!(conclusion.set["spec.conclusion_review_id"], "$review.id");
    let paper_operation = &engine.profile().operations["evidence-reports.report.draft-paper-input"];
    assert!(paper_operation.allowed_new_node_types.is_empty());
    assert!(
        paper_operation
            .output_contract
            .contains("paper_input_status ready")
    );

    let gate = &engine.profile().node_types["gate"];
    let capability = &gate.fields["capability"];
    assert_eq!(capability.additional_properties, Some(false));
    assert_eq!(
        capability
            .properties
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["name", "protocol_range"]
    );
    let range_pattern = regex::Regex::new(
        capability.properties["protocol_range"]
            .pattern
            .as_deref()
            .expect("protocol range has a configured pattern"),
    )?;
    assert!(range_pattern.is_match(">=1.0,<2.0"));
    assert!(range_pattern.is_match(">=1.0.0 <2.0.0"));
    assert!(!range_pattern.is_match("autoresearch.gate-result.v1"));
    let oracle_semantics = &gate.fields["oracle_semantics"];
    assert_eq!(oracle_semantics.additional_properties, Some(false));
    assert_eq!(
        oracle_semantics
            .properties
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["contract_error", "fail", "inconclusive", "pass"]
    );
    assert!(oracle_semantics.properties.values().all(|field| {
        field.required && field.value_type == koni_core::config::FieldType::String
    }));
    Ok(())
}

#[test]
fn context_contract_selection_is_stable_under_unrelated_profile_additions()
-> Result<(), Box<dyn Error>> {
    fn capture(with_unrelated_contract: bool) -> Result<(String, String, Value), Box<dyn Error>> {
        let temp = TempDir::new()?;
        let root = temp.path().join("research-project");
        let installed = root.join(".codex/koni");
        copy_fixture(&profile_root(), &installed)?;
        if with_unrelated_contract {
            let nodes_path = installed.join("graph/nodes.yaml");
            let mut nodes = fs::read_to_string(&nodes_path)?;
            nodes.push_str(
                "\n  - id: unrelated_context_fixture\n    description: A test-only node that no selected ticket can see or create.\n    stage: archived\n    statuses: [draft]\n    initial_status: draft\n",
            );
            fs::write(nodes_path, nodes)?;
            let edges_path = installed.join("graph/edges.yaml");
            let mut edges = fs::read_to_string(&edges_path)?;
            edges.push_str(
                "\n  - {source: unrelated_context_fixture, relation: unrelated, targets: [unrelated_context_fixture]}\n",
            );
            fs::write(edges_path, edges)?;
        }
        initialize_repository(&root)?;
        let goal = "Compile a scoped formulation context.";
        let planned = Engine::plan_run(&root, Some("small"), goal, "HEAD", None)?;
        Engine::record_planning_intake(&root, &planned.run_id, json!({"goal": goal}))?;
        let approved = Engine::approve_run(&root, &planned.run_id)?;
        let mut engine = Engine::open_run(&root, &planned.run_id)?;
        let ticket_id = engine.inspect()?.eligible_tickets[0].clone();
        let store = StateStore::with_storage(
            approved.worktree.join("program"),
            &engine.profile().manifest.storage,
        )?;
        engine.execute_action("start", string_params([("ticket_id", ticket_id.as_str())]))?;
        let worktree = store
            .ticket(&ticket_id)?
            .lease
            .expect("formulation ticket lease")
            .worktree;
        let mut ticket_engine = Engine::open_run(&worktree, &planned.run_id)?;
        let result = ticket_engine.execute_action(
            "context",
            string_params([("ticket_id", ticket_id.as_str()), ("step", "drill-claims")]),
        )?;
        let pack = &result["context_pack"];
        let context_hash = pack["context_hash"]
            .as_str()
            .expect("full context hash")
            .to_owned();
        let selection_hash = pack["manifest"]["size_stats"]["contracts"]["selection_hash"]
            .as_str()
            .expect("selected contract hash")
            .to_owned();
        let document = fs::read_to_string(
            worktree.join(
                pack["document_path"]
                    .as_str()
                    .expect("compiled context path"),
            ),
        )?;
        Ok((
            context_hash,
            selection_hash,
            compiled_context_json(&document)?,
        ))
    }

    let (baseline_context_hash, baseline_selection_hash, baseline) = capture(false)?;
    let (extended_context_hash, extended_selection_hash, extended) = capture(true)?;
    assert_ne!(
        baseline_context_hash, extended_context_hash,
        "the complete context remains bound to its immutable profile and ticket provenance"
    );
    assert_eq!(
        baseline_selection_hash, extended_selection_hash,
        "irrelevant ontology additions must not perturb the usable graph-contract selection"
    );
    for field in ["operation", "scope", "node_types", "edge_types"] {
        assert_eq!(
            baseline["contracts"][field], extended["contracts"][field],
            "selected {field} contract changed after an irrelevant profile addition"
        );
    }
    assert!(!serde_json::to_string(&extended["contracts"])?.contains("unrelated_context_fixture"));
    Ok(())
}

#[test]
fn representative_gate_context_is_compact_and_keeps_reciprocal_relations()
-> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;
    initialize_repository(&root)?;

    let mut engine = Engine::open_with_profile(&root, None)?;
    engine.initialize_run("Compile a representative claim gate contract.")?;
    let store = StateStore::with_storage(root.join("program"), &engine.profile().manifest.storage)?;
    let mut graph = store.graph()?;
    let mut hypothesis = graph
        .nodes_of_type("hypothesis")
        .next()
        .cloned()
        .expect("initialized hypothesis");
    let claim = Node::new(
        "claim",
        "Representative scoped claim",
        empirical_claim_spec("The configured context compiler keeps reciprocal gate semantics."),
    );
    hypothesis
        .edges
        .entry("claims".to_owned())
        .or_default()
        .push(claim.id.clone());
    graph.upsert(hypothesis.clone());
    graph.upsert(claim.clone());
    graph.save_node(&store.graph_dir(), &hypothesis.id)?;
    graph.save_node(&store.graph_dir(), &claim.id)?;
    engine.compile(None, false)?;

    let gate_ticket = store
        .tickets()?
        .into_iter()
        .find(|ticket| {
            ticket.target_nodes == [claim.id.clone()]
                && ticket
                    .extensions
                    .get("operation_registry_id")
                    .and_then(Value::as_str)
                    == Some("graph-compilation.node.define-gates")
        })
        .expect("claim emits configured define-gates work");
    engine.execute_action(
        "start",
        string_params([("ticket_id", gate_ticket.id.as_str())]),
    )?;
    let worktree = store
        .ticket(&gate_ticket.id)?
        .lease
        .expect("gate ticket lease")
        .worktree;
    let mut ticket_engine = Engine::open(&worktree)?;
    let context = ticket_engine.execute_action(
        "context",
        string_params([
            ("ticket_id", gate_ticket.id.as_str()),
            ("step", "compile-gate-stack"),
            ("persona", "gate-designer"),
        ]),
    )?;
    let pack = &context["context_pack"];
    let document = fs::read_to_string(
        worktree.join(
            pack["document_path"]
                .as_str()
                .expect("gate context document path"),
        ),
    )?;
    let compiled = compiled_context_json(&document)?;
    let edge_contracts = compiled["contracts"]["edge_types"]
        .as_array()
        .expect("gate edge contracts");
    let gate_policies = compiled["contracts"]["gate_policies"]
        .as_array()
        .expect("gate policy contracts");
    assert_eq!(gate_policies.len(), 1);
    assert_eq!(gate_policies[0]["id"], "research-capability-gates");
    assert_eq!(
        gate_policies[0]["capability"]["provider_version_fields"],
        json!(["protocol_version", "protocol", "version"])
    );
    let policy_queries = compiled["contracts"]["queries"]
        .as_array()
        .expect("gate policy query contracts");
    let gate_subjects = policy_queries
        .iter()
        .find(|query| query["id"] == "gate-evaluation-subjects")
        .expect("the policy's named gate-subject query is part of the context closure");
    assert_eq!(gate_subjects["node_types"], json!(["gate"]));
    assert_eq!(
        gate_subjects["status_excluding"],
        json!(["archived", "superseded"])
    );
    assert!(edge_contracts.iter().any(|edge| {
        edge["source"] == "claim"
            && edge["relation"] == "gates"
            && edge["targets"]
                .as_array()
                .is_some_and(|targets| targets.iter().any(|target| target == "gate"))
    }));
    assert!(edge_contracts.iter().any(|edge| {
        edge["source"] == "gate"
            && edge["relation"] == "applies_to"
            && edge["targets"]
                .as_array()
                .is_some_and(|targets| targets.iter().any(|target| target == "claim"))
    }));
    assert!(
        !edge_contracts
            .iter()
            .any(|edge| edge["source"] == "evidence"),
        "unrelated edge-source contracts must be omitted"
    );
    let stats = &pack["manifest"]["size_stats"]["contracts"];
    let selected_bytes = stats["selected_bytes"]
        .as_u64()
        .expect("selected contract bytes");
    let unpruned_bytes = stats["unpruned_bytes"]
        .as_u64()
        .expect("unpruned contract bytes");
    assert!(
        selected_bytes * 2 < unpruned_bytes,
        "the representative gate ticket should remove more than half of its generic contract bytes: {stats}"
    );
    assert!(
        document.len() < 32_000,
        "the representative gate context, including its self-contained policy/query contract, must stay suitable for one-shot reading: {} bytes",
        document.len()
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn catalog_forward_rollback_archives_causal_work_and_preserves_later_unrelated_state()
-> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("rollback-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;
    let main_repository = initialize_repository(&root)?;
    let main_head = head_oid(&main_repository)?;
    let goal = "Test safe semantic forward reversal.";
    let planned = Engine::plan_run(&root, Some("small"), goal, "HEAD", None)?;
    Engine::record_planning_intake(&root, &planned.run_id, json!({"goal": goal}))?;
    let approved = Engine::approve_run(&root, &planned.run_id)?;
    let integration_repository = Repository::open(&approved.worktree)?;
    let mut engine = Engine::open_run(&root, &planned.run_id)?;
    let store = StateStore::with_storage(
        approved.worktree.join("program"),
        &engine.profile().manifest.storage,
    )?;
    let board = engine.inspect()?;
    let target_ticket_id = board.eligible_tickets[0].clone();

    // An unrelated node predates the target and therefore must survive every
    // causal reversal that follows.
    let unrelated = Node::new(
        "literature",
        "Unrelated baseline source",
        json!({
            "summary": "This source belongs to an independent line of work.",
            "citation": "Independent Author (2026)",
            "source_locator": "fixture://unrelated"
        }),
    );
    let mut baseline_graph = store.graph()?;
    baseline_graph.insert(unrelated.clone())?;
    baseline_graph.save_node(&store.graph_dir(), &unrelated.id)?;
    commit_all_changes(&integration_repository, "test: add unrelated baseline node")?;

    // Retain a real compiler-created worktree on the eventual target ticket.
    // The rollback must archive its ref and state before retiring it.
    engine.execute_action(
        "start",
        string_params([("ticket_id", target_ticket_id.as_str())]),
    )?;
    let retained_worktree = store
        .ticket(&target_ticket_id)?
        .lease
        .as_ref()
        .expect("target start creates a retained lease")
        .worktree
        .clone();

    let mut graph = store.graph()?;
    let hypothesis_id = graph
        .nodes_of_type("hypothesis")
        .next()
        .expect("research run has a root hypothesis")
        .id
        .clone();
    let claim = Node::new(
        "claim",
        "Rollback target claim",
        empirical_claim_spec("The target transition should be reversible."),
    );
    let mut literature = Node::new(
        "literature",
        "Rollback target source",
        json!({
            "summary": "A source used only by the target transition.",
            "citation": "Target Author (2026)",
            "source_locator": "fixture://target"
        }),
    );
    literature
        .edges
        .insert("informs".to_owned(), vec![hypothesis_id.clone()]);
    graph.insert(claim.clone())?;
    graph.insert(literature.clone())?;
    let hypothesis = graph
        .node_mut(&hypothesis_id)
        .expect("root hypothesis remains present");
    hypothesis
        .edges
        .insert("claims".to_owned(), vec![claim.id.clone()]);
    hypothesis
        .edges
        .insert("literature".to_owned(), vec![literature.id.clone()]);
    for node in graph.nodes() {
        graph.save_node(&store.graph_dir(), &node.id)?;
    }
    let mut target_ticket = store.ticket(&target_ticket_id)?;
    target_ticket.status = "closed".to_owned();
    store.write_ticket(&target_ticket)?;
    let target_audit_receipt = store.receipts_dir().join("target-audit.yaml");
    fs::write(
        &target_audit_receipt,
        serde_yaml::to_string(&json!({
            "schema_version": "1.0",
            "id": "target-audit",
            "receipt_type": "test.target.audit",
            "status": "passed"
        }))?,
    )?;
    store.append_event(&Event::new(
        &planned.run_id,
        "test.target.audit",
        Some(target_ticket_id.clone()),
        json!({"must_survive": true}),
    ))?;
    let target_commit = commit_all_changes(
        &integration_repository,
        &format!(
            "test: integrate reversible formulation\n\nKoni-Run: {}\nKoni-Ticket: {}\nKoni-Profile: {}",
            planned.run_id,
            target_ticket_id,
            engine.profile().hash
        ),
    )?;

    // A normal compile emits causal descendant tickets. One hand-authored
    // unrelated ticket is then added later and must remain active.
    engine.compile(None, false)?;
    let descendant_ids = store
        .tickets()?
        .into_iter()
        .filter(|ticket| ticket.id != target_ticket_id)
        .map(|ticket| ticket.id)
        .collect::<BTreeSet<_>>();
    assert!(!descendant_ids.is_empty());
    let mut survivor = target_ticket.clone();
    survivor.id = "TK-unrelated-survivor".to_owned();
    survivor.status = "todo".to_owned();
    survivor.title = "Preserve unrelated later work".to_owned();
    survivor.target_nodes = vec![unrelated.id.clone()];
    survivor.scope = Scope {
        read_nodes: BTreeSet::from([unrelated.id.clone()]),
        write_nodes: BTreeSet::from([unrelated.id.clone()]),
        read_paths: BTreeSet::new(),
        write_paths: BTreeSet::new(),
    };
    survivor.outputs.clear();
    survivor.reviews.clear();
    survivor.blockers.clear();
    survivor.lease = None;
    store.write_ticket(&survivor)?;
    commit_all_changes(
        &integration_repository,
        "test: add unrelated survivor ticket",
    )?;

    let before_running_refusal = head_oid(&integration_repository)?;
    assert!(
        engine
            .preview_forward_rollback(&target_ticket_id, "undo the target transition")
            .is_err(),
        "a running run must refuse rollback even in preview mode"
    );
    assert_eq!(head_oid(&integration_repository)?, before_running_refusal);
    assert!(repository_status(&integration_repository)?.is_empty());
    Engine::set_run_running(&root, &planned.run_id, false)?;

    // Verified live agents, dirt, and a later edit to the same semantic field
    // are all rejected before any tracked state or ref changes.
    let mut child = Command::new("sleep").arg("10").process_group(0).spawn()?;
    let identity = (0..50)
        .find_map(|_| {
            let identity = capture_owned_agent_process_identity(child.id());
            if identity.is_none() {
                std::thread::sleep(Duration::from_millis(10));
            }
            identity
        })
        .expect("capture live rollback-test process identity");
    let backend = GitBackend::discover(&root)?;
    let control = RunControlStore::new(backend.sidecar_path(format!("runs/{}", planned.run_id))?);
    let mut agent: AgentSessionRecord = serde_json::from_value(json!({
        "schema_version": "1.0",
        "id": "rollback-live-probe",
        "run_id": planned.run_id,
        "persona": "lead",
        "status": "running",
        "pid": child.id(),
        "process_identity": identity,
        "updated_at": chrono::Utc::now()
    }))?;
    control.write_agent(&agent)?;
    let refusal_head = head_oid(&integration_repository)?;
    assert!(
        engine
            .preview_forward_rollback(&target_ticket_id, "undo the target transition")
            .unwrap_err()
            .to_string()
            .contains("zero verified live agents")
    );
    assert_eq!(head_oid(&integration_repository)?, refusal_head);
    child.kill()?;
    child.wait()?;
    agent.status = "completed".to_owned();
    agent.pid = None;
    agent.process_identity = None;
    agent.finished_at = Some(chrono::Utc::now());
    agent.updated_at = chrono::Utc::now();
    control.write_agent(&agent)?;

    fs::write(approved.worktree.join("dirty.tmp"), "unsafe")?;
    assert!(
        engine
            .preview_forward_rollback(&target_ticket_id, "undo the target transition")
            .unwrap_err()
            .to_string()
            .contains("clean integration checkout")
    );
    fs::remove_file(approved.worktree.join("dirty.tmp"))?;
    assert_eq!(head_oid(&integration_repository)?, refusal_head);

    let mut overlap_graph = store.graph()?;
    overlap_graph
        .node_mut(&hypothesis_id)
        .expect("overlap target exists")
        .edges
        .insert("claims".to_owned(), Vec::new());
    overlap_graph.save_node(&store.graph_dir(), &hypothesis_id)?;
    commit_all_changes(
        &integration_repository,
        "test: later overlapping semantic edit",
    )?;
    let overlap_head = head_oid(&integration_repository)?;
    assert!(
        engine
            .preview_forward_rollback(&target_ticket_id, "undo the target transition")
            .unwrap_err()
            .to_string()
            .contains("later semantic edit overlaps")
    );
    assert_eq!(head_oid(&integration_repository)?, overlap_head);
    assert!(repository_status(&integration_repository)?.is_empty());
    overlap_graph
        .node_mut(&hypothesis_id)
        .expect("overlap target exists")
        .edges
        .insert("claims".to_owned(), vec![claim.id.clone()]);
    overlap_graph.save_node(&store.graph_dir(), &hypothesis_id)?;
    commit_all_changes(&integration_repository, "test: explicitly resolve overlap")?;

    let dry_head = head_oid(&integration_repository)?;
    let event_count = store.events()?.len();
    let preview = engine
        .preview_forward_rollback(&target_ticket_id, "the formulation transition was invalid")?;
    assert_eq!(preview.target_commit, target_commit.to_string());
    assert_eq!(preview.target_ticket, target_ticket_id);
    assert!(preview.affected_node_ids.contains(&claim.id));
    assert!(preview.archived_ticket_ids.contains(&target_ticket_id));
    assert!(
        preview
            .archived_ticket_ids
            .iter()
            .any(|id| descendant_ids.contains(id))
    );
    assert!(!preview.archived_ticket_ids.contains(&survivor.id));
    let commit_preview = engine.preview_forward_rollback(
        &target_commit.to_string(),
        "the formulation transition was invalid",
    )?;
    assert_eq!(commit_preview.target_ticket, target_ticket_id);
    assert_eq!(commit_preview.final_graph_hash, preview.final_graph_hash);
    assert_eq!(head_oid(&integration_repository)?, dry_head);
    assert_eq!(store.events()?.len(), event_count);
    assert!(repository_status(&integration_repository)?.is_empty());

    let before_actual = head_oid(&integration_repository)?;
    engine.execute_action(
        "rollback",
        string_params([
            ("target", target_ticket_id.as_str()),
            ("reason", "the formulation transition was invalid"),
        ]),
    )?;
    let rollback_head = head_oid(&integration_repository)?;
    assert_ne!(rollback_head, before_actual);
    assert_eq!(
        integration_repository
            .find_commit(rollback_head)?
            .parent_id(0)?,
        before_actual,
        "rollback publishes exactly one new CAS forward commit"
    );
    assert!(integration_repository.graph_descendant_of(rollback_head, target_commit)?);
    assert!(repository_status(&integration_repository)?.is_empty());
    assert_eq!(head_oid(&main_repository)?, main_head);
    assert!(repository_status(&main_repository)?.is_empty());

    let final_graph = store.graph()?;
    assert!(final_graph.node(&claim.id).is_none());
    assert!(final_graph.node(&literature.id).is_none());
    assert!(final_graph.node(&unrelated.id).is_some());
    let final_hypothesis = final_graph.node(&hypothesis_id).expect("root survives");
    assert!(
        final_hypothesis
            .edges
            .get("claims")
            .is_none_or(Vec::is_empty)
    );
    let final_target = store.ticket(&target_ticket_id)?;
    assert_eq!(final_target.status, "todo");
    assert!(final_target.outputs.is_empty());
    assert!(final_target.reviews.is_empty());
    assert!(final_target.lease.is_none());
    assert_eq!(store.ticket(&survivor.id)?.id, survivor.id);
    for descendant in descendant_ids {
        assert!(
            store.ticket(&descendant).is_err(),
            "causal descendant {descendant} is absent from the active board"
        );
    }
    assert!(!retained_worktree.exists());
    let records = WalkDir::new(store.root().join("recovery/forward-rollbacks"))
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name() == "record.yaml")
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 1);
    let record: Value = serde_yaml::from_str(&fs::read_to_string(records[0].path())?)?;
    assert_eq!(
        record["preview"]["target_commit"],
        target_commit.to_string()
    );
    assert!(
        record["archive_refs"]
            .get(&target_ticket_id)
            .and_then(Value::as_str)
            .is_some_and(|reference| integration_repository.find_reference(reference).is_ok())
    );
    assert!(store.events()?.len() > event_count);
    assert!(target_audit_receipt.is_file());
    assert!(
        store
            .events()?
            .iter()
            .any(|event| event.event_type == "test.target.audit")
    );
    Ok(())
}

#[test]
fn catalog_formulation_ticket_squash_integrates_from_ticket_worktree() -> Result<(), Box<dyn Error>>
{
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;

    let repository = initialize_repository(&root)?;
    let main_head_before = head_oid(&repository)?;
    let goal = "Test whether compiler-checked research graphs support reproducible formulation.";
    let planned = Engine::plan_run(&root, Some("small"), goal, "HEAD", None)?;
    Engine::record_planning_intake(&root, &planned.run_id, json!({"goal": goal}))?;
    let approved = Engine::approve_run(&root, &planned.run_id)?;
    assert_eq!(repository.head()?.name()?, "refs/heads/main");
    assert_eq!(head_oid(&repository)?, main_head_before);
    assert!(repository_status(&repository)?.is_empty());

    let integration_repository = Repository::open(&approved.worktree)?;
    let mut main_engine = Engine::open_run(&root, &planned.run_id)?;
    let profile_hash = main_engine.profile().hash.clone();
    let run_id = planned.run_id;

    let initial_board = main_engine.inspect()?;
    assert_eq!(initial_board.profile_id, "research");
    assert_eq!(initial_board.node_count, 1);
    assert_eq!(initial_board.ticket_count, 1);
    assert_eq!(initial_board.eligible_tickets.len(), 1);
    let ticket_id = initial_board.eligible_tickets[0].clone();

    let main_store = StateStore::with_storage(
        approved.worktree.join("program"),
        &main_engine.profile().manifest.storage,
    )?;
    let initial_ticket = main_store.ticket(&ticket_id)?;
    assert_eq!(initial_ticket.operation, "drill-hypothesis");
    assert_eq!(initial_ticket.workflow.len(), 4);
    assert_eq!(
        initial_ticket
            .extensions
            .get("operation_registry_id")
            .and_then(Value::as_str),
        Some("formulation.hypothesis.drill-hypothesis")
    );
    assert_eq!(
        initial_ticket
            .extensions
            .get("workflow_id")
            .and_then(Value::as_str),
        Some("drill-hypothesis")
    );
    assert_eq!(
        initial_ticket
            .extensions
            .get("dispatch_priority")
            .and_then(Value::as_i64),
        Some(830)
    );
    assert!(
        initial_ticket
            .extensions
            .get("ranking_hints")
            .and_then(Value::as_array)
            .is_some_and(|hints| hints.contains(&json!("missing-obligations")))
    );

    main_engine.execute_action("start", string_params([("ticket_id", ticket_id.as_str())]))?;
    let started_ticket = main_store.ticket(&ticket_id)?;
    assert_eq!(started_ticket.status, "in_progress");
    let ticket_worktree = PathBuf::from(
        &started_ticket
            .lease
            .as_ref()
            .expect("start creates a ticket lease")
            .worktree,
    );
    assert!(ticket_worktree.is_dir());

    let integration_before = head_oid(&integration_repository)?;
    let mut ticket_engine = Engine::open_run(&ticket_worktree, &run_id)?;
    let first_context = ticket_engine.execute_action(
        "context",
        string_params([("ticket_id", ticket_id.as_str()), ("step", "drill-claims")]),
    )?;
    let context_pack = first_context
        .get("context_pack")
        .expect("the configured context step exposes its typed result");
    let context_hash = context_pack
        .get("context_hash")
        .and_then(Value::as_str)
        .expect("context result exposes its stable hash");
    let document_path = context_pack
        .get("document_path")
        .and_then(Value::as_str)
        .expect("context result exposes its document path");
    let context_document = fs::read_to_string(ticket_worktree.join(document_path))?;
    assert!(context_document.contains("Compiler-issued ticket context"));
    assert!(context_document.contains("drill-claims"));
    assert!(context_document.contains("allowed_new_node_types"));
    assert!(
        context_document.contains("A precise scientific statement whose support or refutation"),
        "node descriptions must be present in the agent-facing contract pack"
    );
    let repeated_context = ticket_engine.execute_action(
        "context",
        string_params([("ticket_id", ticket_id.as_str()), ("step", "drill-claims")]),
    )?;
    assert_eq!(
        repeated_context["context_pack"]["context_hash"], context_hash,
        "reissuing unchanged context is content-addressed and idempotent"
    );
    let ticket_store = StateStore::with_storage(
        ticket_worktree.join("program"),
        &ticket_engine.profile().manifest.storage,
    )?;
    let graph = ticket_store.graph()?;
    let mut hypothesis = graph
        .nodes_of_type("hypothesis")
        .next()
        .cloned()
        .expect("initialization creates one hypothesis");
    assert_eq!(initial_ticket.target_nodes, vec![hypothesis.id.clone()]);

    let claim = Node::new(
        "claim",
        "Compiler-checked graphs improve reproducibility",
        empirical_claim_spec(
            "A compiler-checked research graph makes formulation decisions reproducible.",
        ),
    );
    hypothesis
        .edges
        .insert("claims".to_owned(), vec![claim.id.clone()]);
    record_output(
        &mut ticket_engine,
        &ticket_id,
        "drill-claims",
        "hypothesis-planner",
        json!({
            "files_read": [],
            "files_written": [],
            "findings": ["The hypothesis is represented by one falsifiable claim."],
            "risks": [],
            "patch_proposal": "",
            "recommended_next_step": "Map related work for the claim.",
            "graph_delta": {
                "upsert": [
                    serde_json::to_value(&hypothesis)?,
                    agent_new_node_value(&claim)?
                ],
                "delete": []
            }
        }),
    )?;

    let before_claim_compile = ticket_engine.inspect()?;
    let claim_progress = &before_claim_compile.ticket_workflows[&ticket_id];
    assert!(claim_progress.completed_steps.is_empty());
    assert!(
        claim_progress
            .ready_steps
            .contains(&"drill-claims".to_owned())
    );
    ticket_engine.compile(Some(&ticket_id), false)?;
    let after_claim_compile = ticket_engine.inspect()?;
    assert!(
        after_claim_compile.ticket_workflows[&ticket_id]
            .completed_steps
            .contains(&"drill-claims".to_owned()),
        "a structured output becomes complete only after its required scoped compile receipt"
    );

    // The next compiler action checkpoints the direct compile receipt. Stable
    // inspection can then retain that committed evidence while also accepting
    // newly-created live receipts before their next checkpoint.
    ticket_engine.execute_action(
        "context",
        string_params([
            ("ticket_id", ticket_id.as_str()),
            ("step", "map-related-work"),
        ]),
    )?;

    let ticket_path = ticket_worktree
        .join("program/tickets/in_progress")
        .join(format!("{ticket_id}.yaml"));
    let committed_ticket_text = fs::read_to_string(&ticket_path)?;
    let committed_receipts = WalkDir::new(ticket_worktree.join("program/receipts"))
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let text = fs::read_to_string(entry.path()).ok()?;
            text.contains(&ticket_id).then(|| (entry.into_path(), text))
        })
        .collect::<Vec<_>>();
    assert!(!committed_receipts.is_empty());
    let mut transient_ticket = ticket_store.ticket(&ticket_id)?;
    transient_ticket.outputs.clear();
    fs::write(&ticket_path, serde_yaml::to_string(&transient_ticket)?)?;
    for (path, _) in &committed_receipts {
        fs::remove_file(path)?;
    }
    let stable_board = main_engine.inspect()?;
    assert!(
        stable_board.ticket_workflows[&ticket_id]
            .completed_steps
            .contains(&"drill-claims".to_owned()),
        "inspection reads ticket, receipt, and graph evidence from one atomic branch tip"
    );
    fs::write(&ticket_path, committed_ticket_text)?;
    for (path, text) in committed_receipts {
        fs::write(path, text)?;
    }

    let claim_path = WalkDir::new(ticket_worktree.join("program/graph/claim"))
        .into_iter()
        .filter_map(|entry| entry.ok())
        .find(|entry| {
            entry.file_type().is_file()
                && fs::read_to_string(entry.path()).is_ok_and(|text| text.contains(&claim.id))
        })
        .expect("the claim graph file is materialized")
        .into_path();
    let committed_claim_text = fs::read_to_string(&claim_path)?;
    let mut transient_claim: Value = serde_yaml::from_str(&committed_claim_text)?;
    transient_claim["title"] = Value::String("TRANSIENT WORKTREE TITLE".to_owned());
    fs::write(&claim_path, serde_yaml::to_string(&transient_claim)?)?;
    let stable_cockpit = main_engine.cockpit_snapshot()?;
    assert_eq!(stable_cockpit["token_usage"]["total_tokens"], 0);
    assert_eq!(stable_cockpit["token_usage"]["completed_turns"], 0);
    let projected_claim = stable_cockpit["ticket_graphs"][&ticket_id]["graph"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|node| node.get("id").and_then(Value::as_str) == Some(claim.id.as_str()))
        .expect("the ticket graph projection contains the committed claim");
    assert_ne!(
        projected_claim.get("title").and_then(Value::as_str),
        Some("TRANSIENT WORKTREE TITLE"),
        "cockpit graph projection reads the atomic branch tip"
    );
    fs::write(&claim_path, committed_claim_text)?;

    let graph = ticket_store.graph()?;
    let hypothesis = graph
        .node(&hypothesis.id)
        .cloned()
        .expect("claim output preserves the hypothesis");
    let literature = Node::new(
        "literature",
        "Research workflow provenance",
        json!({
            "summary": "Prior work motivates explicit provenance and executable workflow checks.",
            "citation": "Fixture Author (2026)",
            "source_locator": "fixture://research-workflow-provenance"
        }),
    );
    let literature_delta = agent_new_node_value(&literature)?;
    record_output(
        &mut ticket_engine,
        &ticket_id,
        "map-related-work",
        "research-scout",
        json!({
            "files_read": [],
            "files_written": [],
            "findings": ["One provenance-bearing literature node grounds the formulation."],
            "risks": [],
            "patch_proposal": "",
            "recommended_next_step": "Integrate the claim and related-work transition.",
            "graph_delta": {
                "add_nodes": [literature_delta],
                "add_edges": [{
                    "source": hypothesis.id,
                    "relation": "literature",
                    "target": literature.id
                }, {
                    "source": literature.id,
                    "relation": "informs",
                    "target": hypothesis.id
                }]
            }
        }),
    )?;

    // Scoped compilation replays every recorded graph delta against the
    // already-materialized ticket graph. Compiler-supplied defaults must make
    // that replay idempotent rather than look like an out-of-scope edit.
    ticket_engine.compile(Some(&ticket_id), false)?;
    assert_eq!(
        ticket_store
            .graph()?
            .node(&literature.id)
            .expect("scoped compile preserves the defaulted literature node")
            .status,
        "draft"
    );
    assert_eq!(
        ticket_store
            .graph()?
            .node(&literature.id)
            .and_then(|node| node.edges.get("informs")),
        Some(&vec![hypothesis.id.clone()]),
        "replaying add_nodes plus same-delta outgoing edges is idempotent"
    );

    let correction_message =
        "Preserve the claim and literature edge while applying the bounded formulation delta.";
    let steering_event = Event::new(
        &run_id,
        "compiler.steering.recorded",
        Some(ticket_id.clone()),
        json!({
            "kind": "correction",
            "message": correction_message,
            "priority": "high",
            "target_nodes": [hypothesis.id]
        }),
    );
    ticket_store.append_event(&steering_event)?;

    let dependency_output_ids = ticket_store
        .ticket(&ticket_id)?
        .outputs
        .into_iter()
        .map(|output| output.id)
        .collect::<Vec<_>>();
    let integration_context = ticket_engine.execute_action(
        "context",
        string_params([("ticket_id", ticket_id.as_str()), ("step", "integrate")]),
    )?;
    let integration_document = fs::read_to_string(
        ticket_worktree.join(
            integration_context["context_pack"]["document_path"]
                .as_str()
                .expect("integration context exposes its document"),
        ),
    )?;
    assert!(integration_document.contains("dependency_outputs"));
    assert!(integration_document.contains(&claim.id));
    assert!(integration_document.contains(&literature.id));
    for output_id in dependency_output_ids {
        assert_eq!(
            integration_document.matches(&output_id).count(),
            1,
            "dependency output {output_id} appears once in the compiled context"
        );
    }
    assert!(
        integration_document.contains(correction_message),
        "ticket-worktree context includes ticket-local steering"
    );
    record_output(
        &mut ticket_engine,
        &ticket_id,
        "integrate",
        "integrator",
        json!({
            "files_read": [],
            "files_written": [],
            "findings": ["The hypothesis now links one valid claim and one literature source."],
            "risks": [],
            "patch_proposal": "",
            "recommended_next_step": "Review the completed formulation transition."
        }),
    )?;

    ticket_engine.compile(Some(&ticket_id), false)?;

    // A Lead/TUI observer pack must not invalidate step-specific outputs that
    // were already accepted by the compiler.
    ticket_engine.execute_action(
        "context",
        string_params([("ticket_id", ticket_id.as_str())]),
    )?;
    let observed_ticket = ticket_store.ticket(&ticket_id)?;
    for output in &observed_ticket.outputs {
        let step = observed_ticket
            .workflow
            .iter()
            .find(|step| step.id == output.step_id)
            .expect("every output belongs to a configured step");
        assert_eq!(
            step.context_hash, output.context_hash,
            "unscoped observer context preserves completed step binding"
        );
    }

    ticket_engine.review_ticket_with(
        &ticket_id,
        &StaticReviewLauncher::passing(
            "The claim and literature nodes are valid, linked, and within formulation scope.",
        ),
    )?;
    let reviewed_ticket = ticket_store.ticket(&ticket_id)?;
    assert_eq!(
        reviewed_ticket
            .extensions
            .get("issued_context_hashes")
            .and_then(Value::as_object)
            .map(|contexts| contexts.len()),
        // Start issues the initial worker pack for all four steps; the three
        // production steps are then independently reissued above.
        Some(4)
    );
    assert!(reviewed_ticket.required_steps_complete());
    assert!(reviewed_ticket.review_passed());
    let review_id = reviewed_ticket
        .reviews
        .last()
        .expect("passed review is persisted")
        .id
        .clone();

    // A failed or rejected Lead action can append valid compiler control state
    // in the integration checkout while ticket work remains isolated. Finish
    // must preserve that state in a checkpoint before composing the squash.
    let observer_event = Event::new(
        &run_id,
        "test.observer-note",
        Some(ticket_id.clone()),
        json!({"note": "control state written outside the ticket worktree"}),
    );
    main_store.append_event(&observer_event)?;
    assert_eq!(
        repository_status(&integration_repository)?,
        vec![PathBuf::from("program/events.jsonl")]
    );
    assert!(repository_status(&repository)?.is_empty());

    // Recovery can replay finish after its durable transition step completed
    // but a later primitive failed. Re-entering the requested state is an
    // idempotent no-op, allowing the remaining finish recipe to resume.
    let mut retrying_ticket = ticket_store.ticket(&ticket_id)?;
    retrying_ticket.status = "integrating".to_owned();
    ticket_store.write_ticket(&retrying_ticket)?;

    ticket_engine.execute_action("finish", string_params([("ticket_id", ticket_id.as_str())]))?;

    let final_engine = Engine::open_run(&root, &run_id)?;
    let final_board = final_engine.inspect()?;
    assert!(final_board.incomplete_integrations.is_empty());
    assert_eq!(final_board.ticket_count, 1);
    assert_eq!(
        final_board.tickets_by_status,
        BTreeMap::from([("closed".to_owned(), vec![ticket_id.clone()])])
    );

    let final_tickets = main_store.tickets()?;
    assert_eq!(final_tickets.len(), 1);
    let closed_ticket = &final_tickets[0];
    assert_eq!(closed_ticket.id, ticket_id);
    assert_eq!(closed_ticket.operation, "drill-hypothesis");
    assert_eq!(closed_ticket.status, "closed");
    assert!(closed_ticket.required_steps_complete());
    assert!(closed_ticket.review_passed());
    assert_eq!(
        closed_ticket
            .extensions
            .get("operation_registry_id")
            .and_then(Value::as_str),
        Some("formulation.hypothesis.drill-hypothesis")
    );

    let final_graph = main_store.graph()?;
    assert_eq!(final_graph.nodes().count(), 3);
    assert_eq!(final_graph.nodes_of_type("hypothesis").count(), 1);
    assert_eq!(final_graph.nodes_of_type("claim").count(), 1);
    assert_eq!(final_graph.nodes_of_type("literature").count(), 1);
    assert_eq!(
        final_graph
            .node(&literature.id)
            .expect("literature node is materialized")
            .status,
        "draft",
        "the compiler assigns a configured initial status when a new-node delta omits it"
    );
    let stored_hypothesis = final_graph
        .node(&hypothesis.id)
        .expect("the integrated graph retains the hypothesis");
    assert_eq!(
        stored_hypothesis.edges.get("claims"),
        Some(&vec![claim.id.clone()])
    );
    assert_eq!(
        stored_hypothesis.edges.get("literature"),
        Some(&vec![literature.id.clone()])
    );

    assert_eq!(repository.head()?.name()?, "refs/heads/main");
    assert!(repository_status(&repository)?.is_empty());
    assert_eq!(head_oid(&repository)?, main_head_before);
    assert_eq!(
        integration_repository.head()?.name()?,
        approved.branch.as_str()
    );
    assert!(repository_status(&integration_repository)?.is_empty());
    let integration_head = head_oid(&integration_repository)?;
    assert_ne!(integration_head, integration_before);
    let integration_commit = integration_repository.find_commit(integration_head)?;
    assert_eq!(integration_commit.parent_count(), 1);
    assert!(
        integration_commit
            .tree()?
            .get_path(Path::new("program/locks"))
            .is_err(),
        "the integration squash tree must never publish StateStore locks"
    );
    let retained_ticket_repository = Repository::open(&ticket_worktree)?;
    let retained_ticket_head = retained_ticket_repository.head()?.peel_to_commit()?;
    assert!(
        retained_ticket_head
            .tree()?
            .get_path(Path::new("program/locks"))
            .is_err(),
        "the ticket finish checkpoint must never publish StateStore locks"
    );
    assert!(
        repository_status(&retained_ticket_repository)?.is_empty(),
        "dropping the finish action lock must leave the retained ticket worktree clean"
    );
    let control_checkpoint =
        integration_repository.find_commit(integration_commit.parent_id(0)?)?;
    assert_eq!(control_checkpoint.parent_count(), 1);
    assert_eq!(control_checkpoint.parent_id(0)?, integration_before);
    assert_eq!(
        control_checkpoint.message()?.trim(),
        "chore(koni): checkpoint integration control state"
    );

    let koni_commits = koni_trailer_commits(&integration_repository)?;
    assert_eq!(koni_commits, vec![integration_head]);
    let message = integration_commit
        .message()
        .expect("integration commit is UTF-8");
    assert!(message.contains(&format!("Koni-Run: {run_id}")));
    assert!(message.contains(&format!("Koni-Ticket: {ticket_id}")));
    assert!(message.contains(&format!("Koni-Profile: {profile_hash}")));
    assert!(message.contains(&format!("Koni-Review: {review_id}")));

    let boundaries = integration_boundaries(&repository, &run_id)?;
    assert_eq!(boundaries.len(), 1);
    assert_eq!(boundaries[0]["status"], "complete");
    assert_eq!(
        boundaries[0]["result"]["commit"],
        integration_head.to_string()
    );

    // Recovery for trees created by older versions is part of the ordinary
    // compiler checkpoint. Recreate that legacy shape on both retained
    // branches, then prove one full compile removes the tracked locks without
    // manual Git surgery.
    commit_file(
        &integration_repository,
        Path::new("program/locks/compiler.lock"),
        "",
        "test: seed legacy integration lock",
    )?;
    commit_file(
        &retained_ticket_repository,
        Path::new("program/locks/compiler.lock"),
        "",
        "test: seed legacy ticket lock",
    )?;
    fs::remove_file(approved.worktree.join("program/locks/compiler.lock"))?;
    fs::remove_file(ticket_worktree.join("program/locks/compiler.lock"))?;
    assert_eq!(
        repository_status(&retained_ticket_repository)?,
        vec![PathBuf::from("program/locks/compiler.lock")]
    );

    let mut next_stage_engine = Engine::open_run(&root, &run_id)?;
    next_stage_engine.compile(None, false)?;
    let repaired_integration_head = integration_repository.head()?.peel_to_commit()?;
    assert!(
        repaired_integration_head
            .tree()?
            .get_path(Path::new("program/locks"))
            .is_err(),
        "the next compiler checkpoint removes a legacy integration lock"
    );
    let repaired_ticket_head = retained_ticket_repository.head()?.peel_to_commit()?;
    assert!(
        repaired_ticket_head
            .tree()?
            .get_path(Path::new("program/locks"))
            .is_err(),
        "the next compiler checkpoint repairs retained closed ticket trees"
    );
    assert!(repository_status(&integration_repository)?.is_empty());
    assert!(repository_status(&retained_ticket_repository)?.is_empty());
    let next_stage_tickets = main_store.tickets()?;
    assert!(
        next_stage_tickets
            .iter()
            .any(|ticket| ticket.operation == "design-experiment"),
        "formulation completion emits experiment-design work"
    );
    assert!(
        next_stage_tickets
            .iter()
            .all(|ticket| ticket.operation != "conclude-hypothesis"),
        "a formulation review is not evidence and cannot unlock hypothesis conclusion"
    );

    let experiment_ticket = next_stage_tickets
        .iter()
        .find(|ticket| {
            ticket
                .extensions
                .get("operation_registry_id")
                .and_then(Value::as_str)
                == Some("experiment-design.hypothesis.design-experiment")
        })
        .expect("formulation completion emits the configured portfolio ticket");
    assert_eq!(
        experiment_ticket.scope.read_nodes,
        experiment_ticket.target_nodes.iter().cloned().collect(),
        "the portfolio ticket's static scope is only its hypothesis target"
    );
    let expected_portfolio_write_scope = experiment_ticket
        .target_nodes
        .iter()
        .cloned()
        .chain([claim.id.clone()])
        .collect();
    assert_eq!(
        experiment_ticket.scope.write_nodes, expected_portfolio_write_scope,
        "portfolio work may address claim reciprocity as well as the hypothesis portfolio edge"
    );
    let portfolio_operation =
        &next_stage_engine.profile().operations["experiment-design.hypothesis.design-experiment"];
    assert_eq!(
        portfolio_operation.existing_node_edge_additions_only["claim"],
        vec!["tested_by"],
        "writable claim scope grants only reciprocal coverage-edge additions, never claim semantic rewrites"
    );
    let experiment_ticket_id = experiment_ticket.id.clone();
    next_stage_engine.execute_action(
        "start",
        string_params([("ticket_id", experiment_ticket_id.as_str())]),
    )?;
    let experiment_worktree = main_store
        .ticket(&experiment_ticket_id)?
        .lease
        .expect("starting experiment design creates a lease")
        .worktree;
    let mut experiment_engine = Engine::open_run(&experiment_worktree, &run_id)?;
    experiment_engine.execute_action(
        "context",
        string_params([
            ("ticket_id", experiment_ticket_id.as_str()),
            ("step", "map-claim-portfolio"),
        ]),
    )?;
    record_output(
        &mut experiment_engine,
        &experiment_ticket_id,
        "map-claim-portfolio",
        "research-scout",
        json!({
            "files_read": [],
            "files_written": [],
            "findings": ["The configured claim portfolio is ready for empirical experiment design."],
            "risks": [],
            "graph_delta": {"upsert": [], "delete": []}
        }),
    )?;
    let experiment_context = experiment_engine.execute_action(
        "context",
        string_params([
            ("ticket_id", experiment_ticket_id.as_str()),
            ("step", "design-experiment-portfolio"),
        ]),
    )?;
    let experiment_context_path = experiment_context["context_pack"]["document_path"]
        .as_str()
        .expect("experiment context exposes its document path");
    let experiment_context_document =
        fs::read_to_string(Path::new(&experiment_worktree).join(experiment_context_path))?;
    let experiment_context_json = compiled_context_json(&experiment_context_document)?;
    for configured_constraint in [
        "empirical_execution",
        "static reasoning or proof",
        "empirical_mode",
        "execution_protocol",
        "observable_outcome",
        "non-empirical-experiment",
        "max_new_nodes",
        "portfolio_guidance",
        "cohesive empirical program",
    ] {
        assert!(
            experiment_context_document.contains(configured_constraint),
            "compiler-issued context must expose configured experiment constraint {configured_constraint}"
        );
    }
    let node_contract_ids = experiment_context_json["contracts"]["node_types"]
        .as_array()
        .expect("context node contracts are an array")
        .iter()
        .filter_map(|contract| contract["id"].as_str())
        .collect::<BTreeSet<_>>();
    assert!(node_contract_ids.contains("hypothesis"));
    assert!(node_contract_ids.contains("claim"));
    assert!(node_contract_ids.contains("experiment"));
    assert!(
        !node_contract_ids.contains("evidence"),
        "an unrelated edge target type must not pull its full node contract into this context"
    );
    let edge_contracts = experiment_context_json["contracts"]["edge_types"]
        .as_array()
        .expect("context edge contracts are an array");
    assert!(edge_contracts.iter().any(|edge| {
        edge["source"] == "experiment"
            && edge["relation"] == "target_claims"
            && edge["targets"]
                .as_array()
                .is_some_and(|targets| targets.iter().any(|target| target == "claim"))
    }));
    assert!(edge_contracts.iter().any(|edge| {
        edge["source"] == "hypothesis"
            && edge["relation"] == "experiments"
            && edge["targets"]
                .as_array()
                .is_some_and(|targets| targets.iter().any(|target| target == "experiment"))
    }));
    assert!(
        !edge_contracts
            .iter()
            .any(|edge| edge["source"] == "evidence"),
        "an unrelated writable-source contract must stay out of the portfolio context"
    );

    let experiment_store = StateStore::with_storage(
        Path::new(&experiment_worktree).join("program"),
        &experiment_engine.profile().manifest.storage,
    )?;
    let target_claim = experiment_store
        .graph()?
        .nodes_of_type("claim")
        .next()
        .cloned()
        .expect("experiment portfolio context contains the formulated claim");
    let mut rewritten_claim = target_claim.clone();
    rewritten_claim.title = "Unauthorized portfolio-time claim rewrite".to_owned();
    let rewrite_payload = serde_json::to_string(&json!({
        "files_read": [],
        "files_written": [],
        "findings": [],
        "risks": [],
        "graph_delta": {"upsert": [rewritten_claim]}
    }))?;
    let error = experiment_engine
        .execute_action(
            "output",
            string_params([
                ("ticket_id", experiment_ticket_id.as_str()),
                ("step", "design-experiment-portfolio"),
                ("persona", "experiment-designer"),
                ("payload", rewrite_payload.as_str()),
            ]),
        )
        .expect_err("portfolio claim authority is edge-addition-only");
    assert!(
        error
            .to_string()
            .contains("may only add configured edges on existing claim nodes"),
        "{error}"
    );
    assert_eq!(
        experiment_store.graph()?.node(&target_claim.id).cloned(),
        Some(target_claim.clone()),
        "a rejected claim semantic rewrite must not materialize"
    );
    let mut mislabeled_review = Node::new(
        "experiment",
        "Static traceability review mislabeled as an experiment",
        json!({
            "objective": "Inspect existing records without executing an empirical procedure.",
            "target_claim_summary": "Review traceability for the target claim."
        }),
    );
    mislabeled_review
        .edges
        .insert("target_claims".to_owned(), vec![target_claim.id.clone()]);
    let malformed_payload = serde_json::to_string(&json!({
        "files_read": [],
        "files_written": [],
        "findings": [],
        "risks": [],
        "graph_delta": {"add_nodes": [agent_new_node_value(&mislabeled_review)?]}
    }))?;
    let error = experiment_engine
        .execute_action(
            "output",
            string_params([
                ("ticket_id", experiment_ticket_id.as_str()),
                ("step", "design-experiment-portfolio"),
                ("persona", "experiment-designer"),
                ("payload", malformed_payload.as_str()),
            ]),
        )
        .expect_err("generic configured fields reject an experiment without empirical markers");
    for required_field in ["empirical_mode", "execution_protocol", "observable_outcome"] {
        assert!(
            error
                .to_string()
                .contains(&format!("requires field {required_field}")),
            "{error}"
        );
    }
    assert_eq!(
        experiment_store
            .graph()?
            .nodes_of_type("experiment")
            .count(),
        0,
        "rejected ontology drift must not materialize"
    );

    let oversized_portfolio = (0..4)
        .map(|index| {
            let mut experiment = Node::new(
                "experiment",
                format!("Empirical portfolio fragment {index}"),
                json!({
                    "objective": format!("Execute empirical fragment {index}."),
                    "target_claim_summary": "Observe the formulated claim under executable inputs.",
                    "empirical_mode": "intervention",
                    "execution_protocol": format!("Run deterministic input batch {index} against the subject."),
                    "observable_outcome": "Record runtime outputs and compare them with the declared claim outcome."
                }),
            );
            experiment.edges.insert(
                "target_claims".to_owned(),
                vec![target_claim.id.clone()],
            );
            experiment
        })
        .collect::<Vec<_>>();
    let oversized_payload = serde_json::to_string(&json!({
        "files_read": [],
        "files_written": [],
        "findings": [],
        "risks": [],
        "graph_delta": {"add_nodes": oversized_portfolio}
    }))?;
    let error = experiment_engine
        .execute_action(
            "output",
            string_params([
                ("ticket_id", experiment_ticket_id.as_str()),
                ("step", "design-experiment-portfolio"),
                ("persona", "experiment-designer"),
                ("payload", oversized_payload.as_str()),
            ]),
        )
        .expect_err("the configured portfolio budget rejects four new experiment nodes");
    assert!(
        error
            .to_string()
            .contains("exceeding configured max_new_nodes 3"),
        "{error}"
    );
    assert_eq!(
        experiment_store
            .graph()?
            .nodes_of_type("experiment")
            .count(),
        0,
        "an over-budget graph delta must be rejected atomically"
    );
    assert!(
        experiment_store
            .ticket(&experiment_ticket_id)?
            .outputs
            .iter()
            .all(|output| output.step_id != "design-experiment-portfolio"),
        "a rejected over-budget payload must not record a partial step output"
    );

    Ok(())
}

#[test]
fn compatible_additions_are_idempotent_but_cannot_update_existing_nodes()
-> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;
    initialize_repository(&root)?;

    let mut main_engine = Engine::open_with_profile(&root, None)?;
    main_engine.initialize_run("Reject an add-only delta that mutates an existing node.")?;
    let ticket_id = main_engine.inspect()?.eligible_tickets[0].clone();
    main_engine.execute_action("start", string_params([("ticket_id", ticket_id.as_str())]))?;
    let main_store = StateStore::with_storage(
        root.join("program"),
        &main_engine.profile().manifest.storage,
    )?;
    let worktree = main_store
        .ticket(&ticket_id)?
        .lease
        .expect("start creates a lease")
        .worktree;
    let mut ticket_engine = Engine::open(&worktree)?;
    ticket_engine.execute_action(
        "context",
        string_params([("ticket_id", ticket_id.as_str()), ("step", "drill-claims")]),
    )?;
    let malformed_payload = serde_json::to_string(&json!({
        "files_read": [],
        "files_written": [],
        "findings": [],
        "risks": [],
        "graph_delta": {"upsert": {"node-a": {"id": "node-a"}}}
    }))?;
    let error = ticket_engine
        .execute_action(
            "output",
            string_params([
                ("ticket_id", ticket_id.as_str()),
                ("step", "drill-claims"),
                ("persona", "hypothesis-planner"),
                ("payload", malformed_payload.as_str()),
            ]),
        )
        .expect_err("known graph-delta fields must reject the wrong container type");
    assert!(
        error
            .to_string()
            .contains("graph_delta.upsert must be an array of objects"),
        "{error}"
    );
    let ticket_store = StateStore::with_storage(
        worktree.join("program"),
        &ticket_engine.profile().manifest.storage,
    )?;
    let mut existing = ticket_store
        .graph()?
        .nodes_of_type("hypothesis")
        .next()
        .cloned()
        .expect("initial graph contains a hypothesis");
    existing.title.push_str(" conflicting replacement");
    let payload = serde_json::to_string(&json!({
        "files_read": [],
        "files_written": [],
        "findings": ["This payload must be rejected before materialization."],
        "risks": [],
        "graph_delta": {"add_nodes": [existing]}
    }))?;
    let error = ticket_engine
        .execute_action(
            "output",
            string_params([
                ("ticket_id", ticket_id.as_str()),
                ("step", "drill-claims"),
                ("persona", "hypothesis-planner"),
                ("payload", payload.as_str()),
            ]),
        )
        .expect_err("add_nodes must not behave like an update dialect");
    assert!(
        error
            .to_string()
            .contains("graph_delta.add_nodes cannot modify existing node")
    );

    let parent_claim = Node::new(
        "claim",
        "Parent claim",
        empirical_claim_spec("The parent claim decomposes into one bounded child claim."),
    );
    let child_claim = Node::new(
        "claim",
        "Child claim",
        empirical_claim_spec("The child claim is created by the same atomic delta."),
    );
    record_output(
        &mut ticket_engine,
        &ticket_id,
        "drill-claims",
        "hypothesis-planner",
        json!({
            "files_read": [],
            "files_written": [],
            "findings": ["Created and linked two claims atomically."],
            "risks": [],
            "graph_delta": {
                "add_nodes": [
                    agent_new_node_value(&parent_claim)?,
                    agent_new_node_value(&child_claim)?
                ],
                "add_edges": [
                    {
                        "source": existing.id,
                        "relation": "claims",
                        "target": parent_claim.id
                    },
                    {
                        "source": parent_claim.id,
                        "relation": "decomposes_to",
                        "target": child_claim.id
                    }
                ]
            }
        }),
    )?;
    assert_eq!(
        ticket_store
            .graph()?
            .node(&parent_claim.id)
            .and_then(|node| node.edges.get("decomposes_to")),
        Some(&vec![child_claim.id.clone()])
    );
    let owned_ticket = ticket_store.ticket(&ticket_id)?;
    assert!(owned_ticket.scope.write_nodes.contains(&parent_claim.id));
    assert!(owned_ticket.scope.write_nodes.contains(&child_claim.id));

    // Loading context also repairs legacy tickets whose accepted outputs
    // predate durable scope growth.
    let mut legacy_ticket = owned_ticket;
    legacy_ticket.scope.read_nodes.remove(&parent_claim.id);
    legacy_ticket.scope.read_nodes.remove(&child_claim.id);
    legacy_ticket.scope.write_nodes.remove(&parent_claim.id);
    legacy_ticket.scope.write_nodes.remove(&child_claim.id);
    ticket_store.write_ticket(&legacy_ticket)?;

    ticket_engine.execute_action(
        "context",
        string_params([
            ("ticket_id", ticket_id.as_str()),
            ("step", "map-related-work"),
        ]),
    )?;
    let repaired_ticket = ticket_store.ticket(&ticket_id)?;
    assert!(repaired_ticket.scope.write_nodes.contains(&parent_claim.id));
    assert!(repaired_ticket.scope.write_nodes.contains(&child_claim.id));

    let mut destructive_hypothesis = ticket_store
        .graph()?
        .nodes_of_type("hypothesis")
        .next()
        .cloned()
        .expect("the hypothesis remains materialized");
    destructive_hypothesis.edges.remove("claims");
    let destructive_payload = serde_json::to_string(&json!({
        "files_read": [],
        "files_written": [],
        "findings": ["This update must not discard a relationship owned by a prior step."],
        "risks": [],
        "graph_delta": {"upsert": [serde_json::to_value(&destructive_hypothesis)?]}
    }))?;
    let error = ticket_engine
        .execute_action(
            "output",
            string_params([
                ("ticket_id", ticket_id.as_str()),
                ("step", "map-related-work"),
                ("persona", "research-scout"),
                ("payload", destructive_payload.as_str()),
            ]),
        )
        .expect_err("ordinary upserts must preserve existing relationships");
    assert!(error.to_string().contains("cannot remove existing edge"));
    assert_eq!(
        ticket_store
            .graph()?
            .nodes_of_type("hypothesis")
            .next()
            .and_then(|node| node.edges.get("claims")),
        Some(&vec![parent_claim.id.clone()])
    );

    let mut refined_claim = ticket_store
        .graph()?
        .node(&parent_claim.id)
        .cloned()
        .expect("the first step materializes its owned claim");
    refined_claim
        .spec
        .as_object_mut()
        .expect("claim spec is an object")
        .insert("refined_by_later_step".to_owned(), Value::Bool(true));
    record_output(
        &mut ticket_engine,
        &ticket_id,
        "map-related-work",
        "research-scout",
        json!({
            "files_read": [],
            "files_written": [],
            "findings": ["Refined a node created by the prior step."],
            "risks": [],
            "graph_delta": {"upsert": [serde_json::to_value(&refined_claim)?]}
        }),
    )?;
    ticket_engine.compile(Some(&ticket_id), false)?;
    assert_eq!(
        ticket_store
            .graph()?
            .node(&parent_claim.id)
            .and_then(|node| node.spec.get("refined_by_later_step"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        main_engine.inspect()?.failed_journals.len(),
        3,
        "the integration-checkout board includes failed ticket-worktree journals"
    );
    Ok(())
}

#[test]
fn output_rejects_compiler_internal_typed_wrapper_before_materialization()
-> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;
    initialize_repository(&root)?;

    let mut main_engine = Engine::open_with_profile(&root, None)?;
    main_engine.initialize_run("Reject a nested graph delta payload.")?;
    let ticket_id = main_engine.inspect()?.eligible_tickets[0].clone();
    main_engine.execute_action("start", string_params([("ticket_id", ticket_id.as_str())]))?;
    let main_store = StateStore::with_storage(
        root.join("program"),
        &main_engine.profile().manifest.storage,
    )?;
    let worktree = main_store
        .ticket(&ticket_id)?
        .lease
        .expect("start creates a lease")
        .worktree;
    let mut ticket_engine = Engine::open(&worktree)?;
    ticket_engine.execute_action(
        "context",
        string_params([("ticket_id", ticket_id.as_str()), ("step", "drill-claims")]),
    )?;
    let ticket_store = StateStore::with_storage(
        worktree.join("program"),
        &ticket_engine.profile().manifest.storage,
    )?;
    let claim = Node::new(
        "claim",
        "Nested claim must not materialize",
        json!({"claim": "This node is hidden inside an invalid typed wrapper."}),
    );
    let payload = serde_json::to_string(&json!({
        "files_read": [],
        "files_written": [],
        "findings": ["The graph delta is incorrectly nested."],
        "risks": [],
        "typed": {
            "graph_delta": {
                "add_nodes": [serde_json::to_value(&claim)?]
            }
        }
    }))?;
    let error = ticket_engine
        .execute_action(
            "output",
            string_params([
                ("ticket_id", ticket_id.as_str()),
                ("step", "drill-claims"),
                ("persona", "hypothesis-planner"),
                ("payload", payload.as_str()),
            ]),
        )
        .expect_err("compiler-internal payload wrappers must fail closed");
    assert!(
        error
            .to_string()
            .contains("field `typed` is compiler-reserved")
    );
    assert!(ticket_store.graph()?.node(&claim.id).is_none());
    assert!(ticket_store.ticket(&ticket_id)?.outputs.is_empty());
    Ok(())
}

#[test]
fn output_transactions_require_truthful_product_change_declarations() -> Result<(), Box<dyn Error>>
{
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;
    initialize_repository(&root)?;

    let mut main_engine = Engine::open_with_profile(&root, None)?;
    main_engine.initialize_run("Reject product files outside the recorded output boundary.")?;
    let ticket_id = main_engine.inspect()?.eligible_tickets[0].clone();
    main_engine.execute_action("start", string_params([("ticket_id", ticket_id.as_str())]))?;
    let main_store = StateStore::with_storage(
        root.join("program"),
        &main_engine.profile().manifest.storage,
    )?;
    let worktree = main_store
        .ticket(&ticket_id)?
        .lease
        .expect("start creates a lease")
        .worktree;
    let mut ticket_engine = Engine::open(&worktree)?;
    ticket_engine.execute_action(
        "context",
        string_params([("ticket_id", ticket_id.as_str()), ("step", "drill-claims")]),
    )?;
    let ticket_store = StateStore::with_storage(
        worktree.join("program"),
        &ticket_engine.profile().manifest.storage,
    )?;
    let mut ticket = ticket_store.ticket(&ticket_id)?;
    ticket.scope.write_paths.insert("scratch".to_owned());
    ticket_store.write_ticket(&ticket)?;

    let declared_path = worktree.join("scratch/declared.txt");
    fs::create_dir_all(declared_path.parent().expect("fixture file has a parent"))?;
    fs::write(&declared_path, "durable product output\n")?;
    let error = record_output(
        &mut ticket_engine,
        &ticket_id,
        "drill-claims",
        "hypothesis-planner",
        json!({
            "files_read": [],
            "files_written": [],
            "findings": ["The file exists but was omitted from the output declaration."],
            "risks": []
        }),
    )
    .expect_err("dirty product files must be declared by the output transaction");
    assert!(
        error
            .to_string()
            .contains("omitted changed product paths from files_written/files_deleted")
    );

    record_output(
        &mut ticket_engine,
        &ticket_id,
        "drill-claims",
        "hypothesis-planner",
        json!({
            "files_read": [],
            "files_written": ["scratch/declared.txt"],
            "findings": ["The durable product file is now declared."],
            "risks": []
        }),
    )?;
    assert_eq!(
        ticket_store.ticket(&ticket_id)?.outputs[0].files_written,
        vec!["scratch/declared.txt"]
    );

    fs::remove_file(&declared_path)?;
    record_output(
        &mut ticket_engine,
        &ticket_id,
        "drill-claims",
        "hypothesis-planner",
        json!({
            "files_read": [],
            "files_written": [],
            "files_deleted": ["scratch/declared.txt"],
            "findings": ["The product file was intentionally removed."],
            "risks": []
        }),
    )?;
    assert_eq!(
        ticket_store.ticket(&ticket_id)?.outputs[0].files_deleted,
        vec!["scratch/declared.txt"]
    );

    fs::write(worktree.join("scratch/late.txt"), "created after output\n")?;
    let error = ticket_engine
        .execute_action(
            "context",
            string_params([("ticket_id", ticket_id.as_str()), ("step", "drill-claims")]),
        )
        .expect_err("a later action must not checkpoint post-output product changes");
    assert!(
        error
            .to_string()
            .contains("cannot absorb product changes that were not recorded")
    );
    assert!(error.to_string().contains("scratch/late.txt"));
    Ok(())
}

#[test]
fn gate_nested_contract_rejects_adapter_protocol_and_misspelled_contract_error_key()
-> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;
    initialize_repository(&root)?;

    let mut engine = Engine::open_with_profile(&root, None)?;
    engine.initialize_run("Validate nested gate contracts from configuration.")?;
    let store = StateStore::with_storage(root.join("program"), &engine.profile().manifest.storage)?;
    let mut gate = Node::new(
        "gate",
        "Nested contract fixture",
        json!({
            "assertion": "The deterministic adapter satisfies its declared gate contract.",
            "applicability": "The local configured adapter fixture.",
            "capability": {
                "name": "research.test_adapter",
                "protocol_range": "autoresearch.gate-result.v1"
            },
            "command_result_contract": {"result_protocol": "autoresearch.gate-result.v1"},
            "oracle_semantics": {
                "pass": "The result passes.",
                "fail": "The result fails.",
                "inconclusive": "The result is inconclusive.",
                "contract_error": "The result violates the adapter contract."
            },
            "failure_meaning": "The adapter is not ready for this assertion.",
            "expected_red": true
        }),
    );
    gate.status = "draft".to_owned();
    let mut graph = store.graph()?;
    let hypothesis_id = graph
        .nodes_of_type("hypothesis")
        .next()
        .expect("run initialization creates the gate evaluation target")
        .id
        .clone();
    gate.edges
        .insert("applies_to".to_owned(), vec![hypothesis_id]);
    graph.upsert(gate.clone());
    graph.save_node(&store.graph_dir(), &gate.id)?;

    let error = engine
        .compile(None, false)
        .expect_err("an adapter result protocol is not a semantic-version capability range");
    assert!(
        error
            .to_string()
            .contains("field capability.protocol_range does not match configured pattern"),
        "{error}"
    );

    gate.spec["capability"]["protocol_range"] = json!(">=1.0.0 <2.0.0");
    gate.spec["oracle_semantics"] = json!({
        "pass": "The result passes.",
        "fail": "The result fails.",
        "inconclusive": "The result is inconclusive.",
        "contract-error": "The result violates the adapter contract."
    });
    graph.upsert(gate.clone());
    graph.save_node(&store.graph_dir(), &gate.id)?;
    let error = engine
        .compile(None, false)
        .expect_err("contract-error must not substitute for the configured contract_error key");
    assert!(
        error
            .to_string()
            .contains("requires field oracle_semantics.contract_error"),
        "{error}"
    );
    assert!(
        error
            .to_string()
            .contains("field oracle_semantics contains unknown property contract-error"),
        "{error}"
    );

    gate.spec["oracle_semantics"]["contract_error"] =
        gate.spec["oracle_semantics"]["contract-error"].clone();
    gate.spec["oracle_semantics"]
        .as_object_mut()
        .expect("oracle semantics is an object")
        .remove("contract-error");
    graph.upsert(gate.clone());
    graph.save_node(&store.graph_dir(), &gate.id)?;
    engine.compile(None, false)?;
    Ok(())
}

#[test]
fn compiler_filesystem_manifest_scopes_acceptance_and_reopens_on_vendor_or_file_staleness()
-> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;
    initialize_repository(&root)?;
    let mut engine = Engine::open_with_profile(&root, None)?;
    engine.initialize_run("Exercise compiler-owned filesystem manifests.")?;
    let store = StateStore::with_storage(root.join("program"), &engine.profile().manifest.storage)?;
    let mut graph = store.graph()?;

    let mut gate = Node::new(
        "gate",
        "Filesystem-backed gate",
        json!({
            "assertion": "The configured entrypoint exists and is current.",
            "applicability": "The local filesystem manifest fixture.",
            "capability": {"name": "research.filesystem_fixture", "protocol_range": ">=1.0,<2.0"},
            "command_result_contract": {"result_protocol": "autoresearch.gate-result.v1"},
            "oracle_semantics": {
                "pass": "The entrypoint is current.",
                "fail": "The entrypoint is not current.",
                "inconclusive": "The entrypoint could not be evaluated.",
                "contract_error": "The verifier output is malformed."
            },
            "failure_meaning": "The filesystem-backed tool cannot be used.",
            "expected_red": true
        }),
    );
    gate.status = "draft".to_owned();
    let mut asset = Node::new("asset", "Filesystem-backed asset", json!({}));
    asset.status = "draft".to_owned();
    let asset_root = format!("program/assets/{}", asset.id);
    let entrypoint = format!("{asset_root}/main.py");
    let supporting = format!("{asset_root}/nested/data.txt");
    let gate_result = format!(
        "{{\"schema_version\":\"1.0\",\"protocol\":\"autoresearch.gate-result.v1\",\"gate_id\":\"{}\",\"verdict\":\"passed\",\"measurements\":{{\"ready\":true}}}}\n",
        gate.id
    );
    asset.spec = json!({
        "capabilities": [{"name": "research.filesystem_fixture", "version": "1.0.0"}],
        "implementation_plan": {"root": asset_root, "files": [entrypoint, supporting]},
        "implementation": {"kind": "script", "entrypoints": [entrypoint]},
        "source_strategy": "internal",
        "gate_contracts": {
            gate.id.clone(): {
                "protocol": "autoresearch.gate-result.v1",
                "command": ["/usr/bin/printf", gate_result]
            }
        }
    });
    asset
        .edges
        .insert("validates".to_owned(), vec![gate.id.clone()]);
    gate.edges
        .insert("applies_to".to_owned(), vec![asset.id.clone()]);

    let mut read_only_asset = Node::new("asset", "Read-only sibling asset", json!({}));
    read_only_asset.status = "draft".to_owned();
    let read_only_root = format!("program/assets/{}", read_only_asset.id);
    let read_only_entrypoint = format!("{read_only_root}/main.py");
    read_only_asset.spec = json!({
        "capabilities": [{"name": "research.read_only_fixture", "version": "1.0.0"}],
        "implementation_plan": {"root": read_only_root, "files": [read_only_entrypoint]},
        "implementation": {"kind": "script", "entrypoints": [read_only_entrypoint]},
        "source_strategy": "internal"
    });
    for node in [&gate, &asset, &read_only_asset] {
        graph.upsert(node.clone());
        graph.save_node(&store.graph_dir(), &node.id)?;
    }
    fs::create_dir_all(root.join(&asset_root).join("nested"))?;
    fs::write(root.join(&entrypoint), "print('ready')\n")?;
    fs::write(root.join(&supporting), "supporting payload\n")?;
    fs::create_dir_all(root.join(&read_only_root))?;
    fs::write(root.join(&read_only_entrypoint), "print('read only')\n")?;

    engine.compile(None, false)?;
    let ticket = store
        .tickets()?
        .into_iter()
        .find(|ticket| {
            ticket.operation == "implement-asset" && ticket.target_nodes == [asset.id.clone()]
        })
        .expect("incomplete asset emits implementation work");
    assert!(ticket.scope.write_nodes.contains(&asset.id));
    assert!(ticket.scope.write_paths.contains(&asset_root));
    let first = store.graph()?;
    assert_eq!(
        first.node(&asset.id).unwrap().extensions["asset_manifest"]["implementation_status"],
        "incomplete"
    );
    assert_eq!(
        first.node(&asset.id).unwrap().extensions["readiness"]["state"],
        "blocked"
    );
    assert!(
        first.node(&asset.id).unwrap().extensions["obligations"]["unmet"]
            .as_array()
            .unwrap()
            .iter()
            .any(|obligation| obligation["key"] == "asset.implementation")
    );

    engine.compile(Some(&ticket.id), false)?;
    let scoped = store.graph()?;
    assert_eq!(
        scoped.node(&asset.id).unwrap().extensions["asset_manifest"]["implementation_status"],
        "ready"
    );
    assert!(
        scoped.node(&read_only_asset.id).unwrap().extensions["asset_manifest"]
            ["accepted_content_hash"]
            .is_null(),
        "one scoped compile cannot bless a read-only sibling"
    );
    engine.compile(None, false)?;
    assert_eq!(store.ticket(&ticket.id)?.status, "closed");
    assert_eq!(
        store.graph()?.node(&asset.id).unwrap().extensions["readiness"]["state"],
        "ready"
    );
    assert!(
        store
            .graph()?
            .node(&asset.id)
            .unwrap()
            .field_owned("obligations.unmet")
            .and_then(|value| value.as_array().cloned())
            .is_none_or(|values| values.is_empty()),
        "compiler acceptance must clear the blocking implementation/vendor obligations"
    );

    let mut graph = store.graph()?;
    graph.node_mut(&asset.id).unwrap().spec["source_strategy"] = json!("external");
    graph.node_mut(&asset.id).unwrap().spec["vendor"] =
        json!({"blocked_reason": "License approval is pending."});
    graph.save_node(&store.graph_dir(), &asset.id)?;
    engine.compile(None, false)?;
    let blocked = store.graph()?;
    assert_eq!(
        blocked.node(&asset.id).unwrap().extensions["asset_manifest"]["vendor_status"],
        "blocked"
    );
    assert_eq!(
        blocked.node(&asset.id).unwrap().extensions["asset_manifest"]["implementation_status"],
        "incomplete"
    );
    assert_eq!(store.ticket(&ticket.id)?.status, "todo");

    let mut graph = store.graph()?;
    graph.node_mut(&asset.id).unwrap().spec["source_strategy"] = json!("internal");
    graph
        .node_mut(&asset.id)
        .unwrap()
        .spec
        .as_object_mut()
        .unwrap()
        .remove("vendor");
    graph.save_node(&store.graph_dir(), &asset.id)?;
    engine.compile(Some(&ticket.id), false)?;
    engine.compile(None, false)?;
    assert_eq!(store.ticket(&ticket.id)?.status, "closed");

    fs::write(root.join(&supporting), "mutated payload\n")?;
    engine.compile(None, false)?;
    let mutated = store.graph()?;
    assert_eq!(
        mutated.node(&asset.id).unwrap().extensions["asset_manifest"]["implementation_status"],
        "incomplete"
    );
    assert_eq!(store.ticket(&ticket.id)?.status, "todo");
    assert_eq!(store.ticket(&ticket.id)?.extensions["reopen_count"], 2);

    engine.compile(Some(&ticket.id), false)?;
    engine.compile(None, false)?;
    fs::remove_file(root.join(&entrypoint))?;
    engine.compile(None, false)?;
    assert_eq!(
        store.graph()?.node(&asset.id).unwrap().extensions["asset_manifest"]["implementation_status"],
        "incomplete"
    );
    assert_eq!(store.ticket(&ticket.id)?.status, "todo");
    Ok(())
}

#[test]
fn compile_ticket_action_reaccepts_filesystem_changes_for_tracked_and_git_common_storage()
-> Result<(), Box<dyn Error>> {
    for backend in ["tracked", "git_common_dir"] {
        let temp = TempDir::new()?;
        let root = temp.path().join(format!("research-{backend}"));
        let installed = root.join(".codex/koni");
        copy_fixture(&profile_root(), &installed)?;
        if backend == "git_common_dir" {
            let profile_path = installed.join("profile.yaml");
            let profile = fs::read_to_string(&profile_path)?
                .replace("backend: tracked", "backend: git_common_dir");
            fs::write(profile_path, profile)?;
            let actions_path = installed.join("actions/research.yaml");
            let actions = fs::read_to_string(&actions_path)?.replace(
                "      - {primitive: git.integrate_squash, ticket: \"${params.ticket_id}\", preserve_other_leases: true, retain_closed_worktree: true}\n      - {primitive: event.append, type: compiler.finish.closed, ticket: \"${params.ticket_id}\"}",
                "      - {primitive: event.append, type: compiler.finish.closed, ticket: \"${params.ticket_id}\"}\n      - {primitive: git.integrate_squash, ticket: \"${params.ticket_id}\", preserve_other_leases: true, retain_closed_worktree: true}",
            );
            fs::write(actions_path, actions)?;
        }
        let repository = initialize_repository(&root)?;
        let mut engine = Engine::open_with_profile(&root, None)?;
        let run_id = engine.initialize_run(&format!(
            "Exercise {backend} action-owned filesystem acceptance."
        ))?;
        let state_root = if backend == "tracked" {
            root.join("program")
        } else {
            GitBackend::discover(&root)?.sidecar_path(format!("runs/{run_id}"))?
        };
        let store =
            StateStore::with_storage(state_root.clone(), &engine.profile().manifest.storage)?;
        let mut graph = store.graph()?;
        let mut gate = Node::new(
            "gate",
            format!("{backend} filesystem gate"),
            json!({
                "assertion": "The configured filesystem entrypoint is current.",
                "applicability": "The action-level filesystem fixture.",
                "capability": {"name": "research.action_filesystem", "protocol_range": ">=1.0,<2.0"},
                "command_result_contract": {"result_protocol": "autoresearch.gate-result.v1"},
                "oracle_semantics": {
                    "pass": "The entrypoint is current.",
                    "fail": "The entrypoint is stale.",
                    "inconclusive": "The entrypoint could not be inspected.",
                    "contract_error": "The result contract is malformed."
                },
                "failure_meaning": "The filesystem implementation is not usable.",
                "expected_red": true
            }),
        );
        gate.status = "draft".to_owned();
        let mut asset = Node::new("asset", format!("{backend} filesystem asset"), json!({}));
        asset.status = "draft".to_owned();
        let asset_root = format!("program/assets/{}", asset.id);
        let entrypoint = format!("{asset_root}/main.py");
        let gate_result = format!(
            "{{\"schema_version\":\"1.0\",\"protocol\":\"autoresearch.gate-result.v1\",\"gate_id\":\"{}\",\"verdict\":\"passed\",\"measurements\":{{\"ready\":true}}}}\n",
            gate.id
        );
        asset.spec = json!({
            "capabilities": [{"name": "research.action_filesystem", "version": "1.0.0"}],
            "implementation_plan": {"root": asset_root, "files": [entrypoint]},
            "implementation": {"kind": "script", "entrypoints": [entrypoint]},
            "source_strategy": "internal",
            "gate_contracts": {
                gate.id.clone(): {
                    "protocol": "autoresearch.gate-result.v1",
                    "command": ["/usr/bin/printf", gate_result]
                }
            }
        });
        asset
            .edges
            .insert("validates".to_owned(), vec![gate.id.clone()]);
        gate.edges
            .insert("applies_to".to_owned(), vec![asset.id.clone()]);
        graph.upsert(gate.clone());
        graph.upsert(asset.clone());
        graph.save_node(&store.graph_dir(), &gate.id)?;
        graph.save_node(&store.graph_dir(), &asset.id)?;
        fs::create_dir_all(root.join(&asset_root))?;
        fs::write(root.join(&entrypoint), "print('version one')\n")?;
        engine.compile(None, false)?;
        let mut ticket = store
            .tickets()?
            .into_iter()
            .find(|ticket| {
                ticket.operation == "implement-asset" && ticket.target_nodes == [asset.id.clone()]
            })
            .expect("filesystem fixture emits implement-asset work");
        // Isolate the action/receipt contract from persona-output mechanics;
        // broader research lifecycle tests cover the production workflow.
        ticket.workflow.clear();
        store.write_ticket(&ticket)?;

        commit_all_changes(
            &repository,
            &format!("test: checkpoint {backend} asset fixture"),
        )?;
        engine.execute_action("start", string_params([("ticket_id", ticket.id.as_str())]))?;
        let ticket_worktree = store
            .ticket(&ticket.id)?
            .lease
            .expect("started filesystem ticket has a worktree")
            .worktree;
        let mut ticket_engine = Engine::open(&ticket_worktree)?;
        let ticket_store = StateStore::with_storage(
            if backend == "tracked" {
                ticket_worktree.join("program")
            } else {
                state_root.clone()
            },
            &ticket_engine.profile().manifest.storage,
        )?;
        ticket_engine.execute_action(
            "compile-ticket",
            string_params([("ticket_id", ticket.id.as_str())]),
        )?;
        let scoped_receipts = fs::read_dir(ticket_store.receipts_dir())?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| fs::read_to_string(entry.path()).ok())
            .filter_map(|text| serde_yaml::from_str::<Value>(&text).ok())
            .filter(|receipt| {
                receipt.get("receipt_type").and_then(Value::as_str) == Some("scoped-compile")
                    && receipt.get("ticket_id").and_then(Value::as_str) == Some(ticket.id.as_str())
            })
            .collect::<Vec<_>>();
        assert!(scoped_receipts.iter().any(|receipt| {
            receipt["filesystem_manifests"][&asset.id]["manifest"]["implementation_status"]
                == "ready"
        }));

        let worktree_repository = Repository::open(&ticket_worktree)?;
        commit_file(
            &worktree_repository,
            Path::new(&entrypoint),
            "print('version two')\n",
            "test: mutate accepted filesystem input",
        )?;
        let review_error = ticket_engine
            .execute_action(
                "review",
                string_params([("ticket_id", ticket.id.as_str()), ("status", "passed")]),
            )
            .expect_err("file mutation must stale review acceptance")
            .to_string();
        assert!(
            review_error.contains("not review-ready") && review_error.contains("target state"),
            "{backend} review rejection should identify stale target state: {review_error}"
        );

        ticket_engine.execute_action(
            "compile-ticket",
            string_params([("ticket_id", ticket.id.as_str())]),
        )?;
        ticket_engine.execute_action(
            "review",
            string_params([("ticket_id", ticket.id.as_str()), ("status", "passed")]),
        )?;
        commit_file(
            &worktree_repository,
            Path::new(&entrypoint),
            "print('version three')\n",
            "test: stale reviewed filesystem input",
        )?;
        let finish_error = ticket_engine
            .execute_action("finish", string_params([("ticket_id", ticket.id.as_str())]))
            .expect_err("file mutation must stale finish acceptance")
            .to_string();
        assert!(
            finish_error.contains("target state") || finish_error.contains("review-ready"),
            "{backend} finish rejection should identify stale acceptance: {finish_error}"
        );
        ticket_engine.execute_action(
            "compile-ticket",
            string_params([("ticket_id", ticket.id.as_str())]),
        )?;
    }
    Ok(())
}

#[test]
#[cfg(target_os = "macos")]
fn oracle_edge_vocabulary_and_compatible_asset_relationship_advance_gate()
-> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;
    initialize_repository(&root)?;

    let mut engine = Engine::open_with_profile(&root, None)?;
    assert!(engine.profile().edge_types.iter().any(|edge| {
        edge.source == "gate"
            && edge.relation == "applies_to"
            && edge.targets.contains(&"claim".to_owned())
    }));
    assert!(engine.profile().edge_types.iter().any(|edge| {
        edge.source == "claim"
            && edge.relation == "gates"
            && edge.targets.contains(&"gate".to_owned())
    }));
    for source in [
        "hypothesis",
        "claim",
        "experiment",
        "prerequisite",
        "metric",
        "method",
        "ablation",
    ] {
        assert!(
            engine.profile().edge_types.iter().any(|edge| {
                edge.source == source
                    && edge.relation == "gates"
                    && edge.targets == vec!["gate".to_owned()]
            }),
            "missing oracle-compatible {source}.gates relation"
        );
    }
    assert_eq!(engine.profile().edge_types.len(), 66);
    assert_eq!(
        engine
            .profile()
            .edge_types
            .iter()
            .map(|edge| edge.targets.len())
            .sum::<usize>(),
        158
    );
    assert!(
        !engine
            .profile()
            .edge_types
            .iter()
            .any(|edge| edge.source == "asset" && edge.relation == "executable_for"),
        "the configured research graph must retain the oracle edge vocabulary"
    );
    let run_id = engine.initialize_run("Exercise generic gate-to-asset derivation rules.")?;
    let store = StateStore::with_storage(root.join("program"), &engine.profile().manifest.storage)?;
    let mut graph = store.graph()?;

    let mut gate = Node::new(
        "gate",
        "Deterministic adapter gate",
        json!({
            "assertion": "The deterministic adapter returns a passing result.",
            "applicability": "The local adapter fixture.",
            "capability": {"name": "research.test_adapter", "protocol_range": ">=1.0,<2.0"},
            "command_result_contract": {"result_protocol": "autoresearch.gate-result.v1"},
            "oracle_semantics": {
                "pass": "The adapter verdict is passing.",
                "fail": "The adapter verdict is failing.",
                "inconclusive": "The adapter could not discriminate the outcome.",
                "contract_error": "The adapter output violates its deterministic result contract."
            },
            "failure_meaning": "The fixture adapter has not satisfied its deterministic contract.",
            "expected_red": true
        }),
    );
    gate.status = "draft".to_owned();
    let hypothesis_id = graph
        .nodes_of_type("hypothesis")
        .next()
        .expect("initialized research graph has a hypothesis")
        .id
        .clone();
    gate.edges
        .insert("applies_to".to_owned(), vec![hypothesis_id]);
    let mut asset = Node::new(
        "asset",
        "Compatible local adapter",
        json!({"capabilities": [{"name": "research.test_adapter", "version": "1.0.0"}]}),
    );
    asset.status = "draft".to_owned();
    asset
        .edges
        .insert("validates".to_owned(), vec![gate.id.clone()]);
    graph.upsert(gate.clone());
    graph.upsert(asset.clone());
    graph.save_node(&store.graph_dir(), &gate.id)?;
    let asset_id = asset.id.clone();
    graph.save_node(&store.graph_dir(), &asset_id)?;

    engine.compile(None, false)?;
    let gate_operations = store
        .tickets()?
        .into_iter()
        .filter(|ticket| ticket.target_nodes == vec![gate.id.clone()])
        .map(|ticket| ticket.operation)
        .collect::<Vec<_>>();
    assert!(!gate_operations.contains(&"run-gate".to_owned()));
    assert!(!gate_operations.contains(&"plan-build-asset".to_owned()));
    assert!(store.tickets()?.iter().any(|ticket| {
        ticket.target_nodes == vec![asset.id.clone()] && ticket.operation == "plan-build-asset"
    }));

    asset
        .spec
        .as_object_mut()
        .expect("asset spec is an object")
        .insert(
            "implementation_plan".to_owned(),
            json!({
                "root": "program/assets/test-adapter",
                "files": ["program/assets/test-adapter/adapter.py"]
            }),
        );
    graph.upsert(asset.clone());
    graph.save_node(&store.graph_dir(), &asset.id)?;
    engine.compile(None, false)?;
    let implementation_ticket = store
        .tickets()?
        .into_iter()
        .find(|ticket| {
            ticket.target_nodes == vec![asset.id.clone()] && ticket.operation == "implement-asset"
        })
        .expect("a standardized plan emits an implementation ticket");
    assert_eq!(
        implementation_ticket.scope.write_paths,
        BTreeSet::from(["program/assets/test-adapter".to_owned()])
    );
    assert!(!store.tickets()?.iter().any(|ticket| {
        ticket.target_nodes == vec![gate.id.clone()] && ticket.operation == "run-gate"
    }));

    asset
        .spec
        .as_object_mut()
        .expect("asset spec is an object")
        .insert(
            "implementation".to_owned(),
            json!({
                "kind": "script",
                "entrypoints": ["program/assets/test-adapter/adapter.py"]
            }),
        );
    fs::create_dir_all(root.join("program/assets/test-adapter"))?;
    fs::write(
        root.join("program/assets/test-adapter/adapter.py"),
        "print('adapter fixture')\n",
    )?;
    let gate_result = serde_json::to_string(&json!({
        "schema_version": "1.0",
        "protocol": "autoresearch.gate-result.v1",
        "gate_id": gate.id,
        "verdict": "passed",
        "measurements": {"fixture": 1}
    }))?;
    let mut gate_contracts = serde_json::Map::new();
    gate_contracts.insert(
        gate.id.clone(),
        json!({
            "protocol": "autoresearch.gate-result.v1",
            "command": ["python3", "-c", format!("print({gate_result:?})")]
        }),
    );
    asset
        .spec
        .as_object_mut()
        .expect("asset spec is an object")
        .insert("gate_contracts".to_owned(), Value::Object(gate_contracts));
    graph.upsert(asset.clone());
    graph.save_node(&store.graph_dir(), &asset.id)?;
    engine.compile(Some(&implementation_ticket.id), false)?;
    engine.compile(None, false)?;
    assert!(!store.tickets()?.iter().any(|ticket| {
        ticket.target_nodes == vec![gate.id.clone()] && ticket.operation == "run-gate"
    }));
    let gate_receipts = fs::read_dir(store.receipts_dir())?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .filter_map(|text| serde_yaml::from_str::<Value>(&text).ok())
        .filter(|receipt| {
            receipt.get("receipt_type").and_then(Value::as_str) == Some("gate.receipt")
        })
        .collect::<Vec<_>>();
    assert_eq!(gate_receipts.len(), 1);
    assert_eq!(
        gate_receipts[0].get("status").and_then(Value::as_str),
        Some("passed")
    );
    assert_eq!(
        gate_receipts[0]
            .get("result")
            .and_then(|result| result.get("gate_id"))
            .and_then(Value::as_str),
        Some(gate.id.as_str())
    );
    assert!(gate_receipts[0].get("ticket_id").is_none());
    assert_eq!(gate_receipts[0]["origin"]["kind"], "automatic_compile");
    assert_eq!(gate_receipts[0]["subject_node_ids"], json!([gate.id]));

    engine.compile(None, false)?;
    let receipt_count = fs::read_dir(store.receipts_dir())?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .filter_map(|text| serde_yaml::from_str::<Value>(&text).ok())
        .filter(|receipt| {
            receipt.get("receipt_type").and_then(Value::as_str) == Some("gate.receipt")
        })
        .count();
    assert_eq!(receipt_count, 1, "current terminal evidence is reused");
    let compiled_graph = store.graph()?;
    assert_eq!(
        compiled_graph.node(&gate.id).unwrap().extensions["gate_state"]["research-capability-gates"]
            ["satisfied"],
        true
    );
    assert_eq!(
        compiled_graph.node(&asset.id).unwrap().extensions["compiler"]["gate_results"]["research-capability-gates"]
            [&gate.id],
        "passed"
    );

    let manifest = store.manifest()?;
    assert_eq!(manifest.id, run_id);
    Ok(())
}

#[test]
#[cfg(target_os = "macos")]
fn automatic_gate_terminal_matrix_respects_scoped_impact_and_full_catchup()
-> Result<(), Box<dyn Error>> {
    let mut fixture = automatic_gate_fixture("Exercise automatic gate terminal outcomes.")?;
    let mut graph = fixture.store.graph()?;
    let cases = [
        install_automatic_gate_case(
            &mut graph,
            &fixture.store,
            &fixture.root,
            &fixture.hypothesis_id,
            "passing",
            AutomaticGateCommand::Verdict {
                verdict: "passed",
                wrong_identity: false,
            },
        )?,
        install_automatic_gate_case(
            &mut graph,
            &fixture.store,
            &fixture.root,
            &fixture.hypothesis_id,
            "failing",
            AutomaticGateCommand::Verdict {
                verdict: "failed",
                wrong_identity: false,
            },
        )?,
        install_automatic_gate_case(
            &mut graph,
            &fixture.store,
            &fixture.root,
            &fixture.hypothesis_id,
            "invalid-result",
            AutomaticGateCommand::Verdict {
                verdict: "passed",
                wrong_identity: true,
            },
        )?,
    ];

    fixture.engine.compile(None, false)?;
    let implementation_tickets = cases
        .iter()
        .map(|case| automatic_gate_ticket(&fixture.store, "implement-asset", &case.asset_id))
        .collect::<Result<Vec<_>, _>>()?;
    assert!(cases.iter().all(|case| {
        automatic_gate_receipts(&fixture.store, &case.gate_id)
            .is_ok_and(|receipts| receipts.is_empty())
    }));

    for ticket in &implementation_tickets {
        fixture.engine.compile(Some(&ticket.id), false)?;
    }

    let expected_statuses = ["passed", "failed", "invalid_result"];
    let mut initial_binding_hashes = BTreeMap::new();
    for ((case, ticket), expected_status) in cases
        .iter()
        .zip(&implementation_tickets)
        .zip(expected_statuses)
    {
        let receipts = automatic_gate_receipts(&fixture.store, &case.gate_id)?;
        assert_eq!(
            receipts.len(),
            1,
            "{} should execute exactly once",
            case.key
        );
        let receipt = &receipts[0];
        assert_eq!(receipt["status"], expected_status, "{}", case.key);
        assert_eq!(receipt["origin"]["kind"], "automatic_compile");
        assert_eq!(receipt["origin"]["boundary"], "scoped");
        assert_eq!(receipt["origin"]["trigger_ticket_id"], ticket.id);
        assert!(receipt.get("ticket_id").is_none());
        assert_eq!(receipt["gate_policy_id"], "research-capability-gates");
        assert_eq!(receipt["subject_node_ids"], json!([case.gate_id]));
        assert_eq!(receipt["execution_binding"]["source_id"], case.asset_id);
        assert_eq!(
            receipt["execution_binding"]["gate_policy_binding"]["selection"]["winner_id"],
            case.asset_id
        );
        initial_binding_hashes.insert(
            case.gate_id.clone(),
            receipt["execution_binding_hash"]
                .as_str()
                .expect("automatic receipt binds its execution")
                .to_owned(),
        );
    }
    assert_ne!(
        automatic_gate_receipts(&fixture.store, &cases[2].gate_id)?[0]["result"]["gate_id"],
        cases[2].gate_id,
        "the invalid-result case must exercise identity rejection, not a failed verdict"
    );

    let projected = fixture.store.graph()?;
    for (case, expected_status) in cases.iter().zip(expected_statuses) {
        let gate = projected.node(&case.gate_id).expect("fixture gate exists");
        assert_eq!(
            gate.extensions["gate_state"]["research-capability-gates"]["status"],
            expected_status
        );
        assert_eq!(
            gate.extensions["gate_state"]["research-capability-gates"]["satisfied"],
            expected_status == "passed"
        );
        assert_eq!(
            projected
                .node(&case.asset_id)
                .expect("fixture asset exists")
                .extensions["compiler"]["gate_results"]["research-capability-gates"][&case.gate_id],
            expected_status
        );
    }

    let mut graph = fixture.store.graph()?;
    for case in &cases {
        graph
            .node_mut(&case.gate_id)
            .expect("fixture gate exists")
            .spec["assertion"] = json!(format!("{} assertion changed", case.key));
        graph.save_node(&fixture.store.graph_dir(), &case.gate_id)?;
    }

    fixture
        .engine
        .compile(Some(&implementation_tickets[0].id), false)?;
    let after_scoped_counts = cases
        .iter()
        .map(|case| automatic_gate_receipts(&fixture.store, &case.gate_id).map(|rows| rows.len()))
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(
        after_scoped_counts,
        vec![2, 1, 1],
        "a scoped boundary may rerun only the gate impacted by its ticket footprint"
    );
    let passing_after_scoped = automatic_gate_receipts(&fixture.store, &cases[0].gate_id)?;
    let passing_latest = passing_after_scoped.last().expect("new passing receipt");
    assert_eq!(passing_latest["origin"]["boundary"], "scoped");
    assert_eq!(
        passing_latest["origin"]["trigger_ticket_id"],
        implementation_tickets[0].id
    );
    assert_ne!(
        passing_latest["execution_binding_hash"],
        initial_binding_hashes[&cases[0].gate_id]
    );

    fixture.engine.compile(None, false)?;
    let after_full_counts = cases
        .iter()
        .map(|case| automatic_gate_receipts(&fixture.store, &case.gate_id).map(|rows| rows.len()))
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(
        after_full_counts,
        vec![2, 2, 2],
        "the next full boundary must catch every stale binding while reusing the current one"
    );
    for (index, case) in cases.iter().enumerate() {
        let receipts = automatic_gate_receipts(&fixture.store, &case.gate_id)?;
        let latest = receipts.last().expect("terminal receipt exists");
        if index == 0 {
            assert_eq!(latest["origin"]["boundary"], "scoped");
        } else {
            assert_eq!(latest["origin"]["boundary"], "full");
            assert!(latest["origin"]["trigger_ticket_id"].is_null());
        }
        assert_ne!(
            latest["execution_binding_hash"], initial_binding_hashes[&case.gate_id],
            "{} semantic mutation must produce a new bound execution",
            case.key
        );
    }

    let tickets = fixture.store.tickets()?;
    for (index, (case, ticket)) in cases.iter().zip(&implementation_tickets).enumerate() {
        assert_eq!(
            fixture.store.ticket(&ticket.id)?.status,
            if index == 0 { "closed" } else { "todo" },
            "passing work closes while terminal nonpassing work remains routed to remediation"
        );
        assert!(!tickets.iter().any(|candidate| {
            candidate.operation == "run-gate"
                && candidate.target_nodes == vec![case.gate_id.clone()]
        }));
    }

    let stable_receipt_ids = cases
        .iter()
        .map(|case| automatic_gate_receipt_ids(&fixture.store, &case.gate_id))
        .collect::<Result<Vec<_>, _>>()?;
    fixture.engine.compile(None, false)?;
    let reused_receipt_ids = cases
        .iter()
        .map(|case| automatic_gate_receipt_ids(&fixture.store, &case.gate_id))
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(
        reused_receipt_ids, stable_receipt_ids,
        "all current terminal statuses, including nonpassing ones, are reused"
    );
    Ok(())
}

#[test]
#[cfg(target_os = "macos")]
fn automatic_gate_preflight_skips_gaps_and_honors_legacy_run_gate_owner()
-> Result<(), Box<dyn Error>> {
    let mut fixture = automatic_gate_fixture("Exercise automatic gate preflight ownership.")?;
    let mut graph = fixture.store.graph()?;
    let missing_winner_gate = automatic_gate_node(
        "missing-winner",
        &fixture.hypothesis_id,
        "research.automatic_missing_winner",
    );
    graph.upsert(missing_winner_gate.clone());
    graph.save_node(&fixture.store.graph_dir(), &missing_winner_gate.id)?;
    let missing_command = install_automatic_gate_case(
        &mut graph,
        &fixture.store,
        &fixture.root,
        &fixture.hypothesis_id,
        "missing-command",
        AutomaticGateCommand::Missing,
    )?;
    let legacy_owned = install_automatic_gate_case(
        &mut graph,
        &fixture.store,
        &fixture.root,
        &fixture.hypothesis_id,
        "legacy-owned",
        AutomaticGateCommand::Verdict {
            verdict: "passed",
            wrong_identity: false,
        },
    )?;

    fixture.engine.compile(None, false)?;
    let missing_command_ticket =
        automatic_gate_ticket(&fixture.store, "implement-asset", &missing_command.asset_id)?;
    let legacy_asset_ticket =
        automatic_gate_ticket(&fixture.store, "implement-asset", &legacy_owned.asset_id)?;
    assert!(fixture.store.tickets()?.iter().any(|ticket| {
        ticket.operation == "plan-build-asset"
            && ticket.target_nodes == vec![missing_winner_gate.id.clone()]
    }));

    let legacy_ticket = legacy_run_gate_ticket(
        fixture.engine.profile().hash.as_str(),
        &legacy_owned,
        &fixture.hypothesis_id,
    );
    fixture.store.write_ticket(&legacy_ticket)?;
    fixture
        .engine
        .compile(Some(&missing_command_ticket.id), false)?;
    fixture
        .engine
        .compile(Some(&legacy_asset_ticket.id), false)?;
    fixture.engine.compile(None, false)?;

    let compiled = fixture.store.graph()?;
    for case in [&missing_command, &legacy_owned] {
        let manifest = &compiled
            .node(&case.asset_id)
            .expect("fixture asset exists")
            .extensions["asset_manifest"];
        assert_eq!(manifest["implementation_status"], "ready");
        assert_eq!(manifest["vendor_status"], "vendored");
        assert!(manifest["accepted_content_hash"].is_string());
    }
    for gate_id in [
        missing_winner_gate.id.as_str(),
        missing_command.gate_id.as_str(),
        legacy_owned.gate_id.as_str(),
    ] {
        assert!(
            automatic_gate_receipts(&fixture.store, gate_id)?.is_empty(),
            "preflight and legacy ownership must skip execution before spawn"
        );
    }
    assert_eq!(
        fixture.store.ticket(&legacy_ticket.id)?.status,
        "in_progress"
    );
    assert_eq!(
        fixture
            .store
            .tickets()?
            .iter()
            .filter(|ticket| {
                ticket.operation == "run-gate"
                    && ticket.target_nodes == vec![legacy_owned.gate_id.clone()]
            })
            .count(),
        1,
        "the compiler must preserve exactly the legacy ticket that owns execution"
    );
    assert_eq!(
        fixture.store.ticket(&missing_command_ticket.id)?.status,
        "todo",
        "a ready asset with no exact command remains bounded implementation work"
    );
    assert!(!fixture.store.tickets()?.iter().any(|ticket| {
        ticket.operation == "run-gate"
            && (ticket.target_nodes == vec![missing_winner_gate.id.clone()]
                || ticket.target_nodes == vec![missing_command.gate_id.clone()])
    }));

    let mut released = fixture.store.ticket(&legacy_ticket.id)?;
    released.status = "closed".to_owned();
    fixture.store.write_ticket(&released)?;
    fixture.engine.compile(None, false)?;

    let legacy_receipts = automatic_gate_receipts(&fixture.store, &legacy_owned.gate_id)?;
    assert_eq!(legacy_receipts.len(), 1);
    assert_eq!(legacy_receipts[0]["status"], "passed");
    assert_eq!(legacy_receipts[0]["origin"]["kind"], "automatic_compile");
    assert_eq!(legacy_receipts[0]["origin"]["boundary"], "full");
    assert!(legacy_receipts[0]["origin"]["trigger_ticket_id"].is_null());
    assert!(legacy_receipts[0].get("ticket_id").is_none());
    assert!(automatic_gate_receipts(&fixture.store, &missing_winner_gate.id)?.is_empty());
    assert!(automatic_gate_receipts(&fixture.store, &missing_command.gate_id)?.is_empty());
    assert_eq!(
        fixture
            .store
            .tickets()?
            .iter()
            .filter(|ticket| {
                ticket.operation == "run-gate"
                    && ticket.target_nodes == vec![legacy_owned.gate_id.clone()]
            })
            .count(),
        1,
        "release must not replace the historical ticket after automatic execution"
    );
    assert_eq!(fixture.store.ticket(&legacy_ticket.id)?.status, "closed");

    fixture.engine.compile(None, false)?;
    assert_eq!(
        automatic_gate_receipts(&fixture.store, &legacy_owned.gate_id)?.len(),
        1,
        "the current terminal receipt is reused after legacy ownership is released"
    );
    Ok(())
}

#[test]
#[cfg(not(target_os = "macos"))]
fn automatic_gate_compile_fails_closed_without_supported_os_sandbox() -> Result<(), Box<dyn Error>>
{
    let mut fixture = automatic_gate_fixture("Exercise unsupported gate sandbox failure.")?;
    let mut graph = fixture.store.graph()?;
    let case = install_automatic_gate_case(
        &mut graph,
        &fixture.store,
        &fixture.root,
        &fixture.hypothesis_id,
        "unsupported-sandbox",
        AutomaticGateCommand::Verdict {
            verdict: "passed",
            wrong_identity: false,
        },
    )?;
    fixture.engine.compile(None, false)?;
    let ticket = automatic_gate_ticket(&fixture.store, "implement-asset", &case.asset_id)?;

    let error = fixture
        .engine
        .compile(Some(&ticket.id), false)
        .expect_err("automatic gate execution must fail closed without an OS sandbox")
        .to_string();
    assert!(
        error.contains("automatic read-only gate execution has no supported OS sandbox"),
        "{error}"
    );
    assert!(automatic_gate_receipts(&fixture.store, &case.gate_id)?.is_empty());
    Ok(())
}

#[test]
fn configured_review_effects_own_promotion_and_bind_it_to_the_exact_pass()
-> Result<(), Box<dyn Error>> {
    let mut fixture = review_effect_fixture()?;
    let mut forged = review_effect_evidence("Forged self-promotion", &fixture.hypothesis_id);
    forged.spec["promotion_state"] = json!("lead-promoted");
    forged.spec["promoted_by"] = json!("lead");
    forged.spec["promotion_review_id"] = json!("worker-forged-review");
    let payload = serde_json::to_string(&json!({
        "files_read": [],
        "files_written": [],
        "findings": ["This worker-authored promotion must be rejected."],
        "risks": [],
        "graph_delta": {"add_nodes": [forged]}
    }))?;
    let error = fixture
        .engine
        .execute_action(
            "output",
            string_params([
                ("ticket_id", fixture.ticket_id.as_str()),
                ("step", "work"),
                ("persona", "experiment-designer"),
                ("payload", payload.as_str()),
            ]),
        )
        .expect_err("an agent cannot self-promote evidence");
    assert!(
        error
            .to_string()
            .contains("cannot author compiler-owned field"),
        "{error}"
    );
    assert_eq!(fixture.store.graph()?.nodes_of_type("evidence").count(), 0);

    let candidate = review_effect_evidence("Reviewed evidence", &fixture.hypothesis_id);
    prepare_review_effect_candidate(&mut fixture, std::slice::from_ref(&candidate))?;
    fixture.engine.review_ticket_with(
        &fixture.ticket_id,
        &StaticReviewLauncher::failed("The candidate still needs a bounded correction."),
    )?;
    let after_failure = fixture
        .store
        .graph()?
        .node(&candidate.id)
        .cloned()
        .expect("failed review preserves the unpromoted candidate for rework");
    for field in ["promotion_state", "promoted_by", "promotion_review_id"] {
        assert!(
            after_failure.spec.get(field).is_none(),
            "failed review must not apply compiler effect field {field}"
        );
    }

    fixture.engine.execute_action(
        "context",
        string_params([("ticket_id", fixture.ticket_id.as_str()), ("step", "work")]),
    )?;
    prepare_review_effect_candidate(&mut fixture, std::slice::from_ref(&candidate))?;
    fixture.engine.review_ticket_with(
        &fixture.ticket_id,
        &StaticReviewLauncher::passing(
            "The candidate is bounded, receipt-grounded, and ready for promotion.",
        ),
    )?;
    let reviewed = fixture.store.ticket(&fixture.ticket_id)?;
    let review = reviewed.reviews.last().expect("passed review is durable");
    assert_eq!(review.status, "passed");
    let review_id = review.id.clone();
    let binding = review
        .agent_binding
        .as_ref()
        .expect("passed review has compiler provenance");
    assert!(binding.review_effects_hash.is_some());
    assert!(binding.post_effect_graph_hash.is_some());
    let promoted = fixture
        .store
        .graph()?
        .node(&candidate.id)
        .cloned()
        .expect("promotion is atomically materialized with the review");
    assert_eq!(promoted.spec["promotion_state"], "lead-promoted");
    assert_eq!(promoted.spec["promoted_by"], "lead");
    assert_eq!(promoted.spec["promotion_review_id"], review_id);

    let original = reviewed.clone();
    let mut tampered = reviewed;
    let tampered_binding = tampered
        .reviews
        .last_mut()
        .unwrap()
        .agent_binding
        .as_mut()
        .unwrap();
    tampered_binding.review_effects.as_mut().unwrap()["effects"][0]["set"]["spec.promoted_by"] =
        json!("worker");
    tampered_binding.review_effects_hash = Some(normalized_hash(
        tampered_binding.review_effects.as_ref().unwrap(),
    ));
    fixture.store.write_ticket(&tampered)?;
    let stale = fixture
        .engine
        .execute_action(
            "finish",
            string_params([("ticket_id", fixture.ticket_id.as_str())]),
        )
        .expect_err("tampered effect provenance must fail closed");
    assert!(
        stale.to_string().contains("stale or incomplete provenance"),
        "{stale}"
    );
    assert_eq!(
        fixture.store.graph()?.node(&candidate.id).unwrap().spec["promoted_by"],
        "lead",
        "a forged effect binding cannot mutate the compiler-owned graph field"
    );

    fixture.store.write_ticket(&original)?;
    fixture.engine.execute_action(
        "finish",
        string_params([("ticket_id", fixture.ticket_id.as_str())]),
    )?;
    let integrated = Engine::open(&fixture.root)?;
    let board = integrated.inspect()?;
    assert!(board.eligible_tickets.is_empty());
    assert_eq!(
        StateStore::with_storage(
            fixture.root.join("program"),
            &integrated.profile().manifest.storage,
        )?
        .graph()?
        .node(&candidate.id)
        .unwrap()
        .spec["promotion_review_id"],
        review_id,
        "the terminal graph query can see only the compiler-stamped reviewed candidate"
    );
    Ok(())
}

#[test]
fn configured_review_effect_exact_count_fails_without_partial_promotion()
-> Result<(), Box<dyn Error>> {
    let mut fixture = review_effect_fixture()?;
    let first = review_effect_evidence("First ambiguous candidate", &fixture.hypothesis_id);
    let second = review_effect_evidence("Second ambiguous candidate", &fixture.hypothesis_id);
    prepare_review_effect_candidate(&mut fixture, &[first.clone(), second.clone()])?;
    let reviewer = StaticReviewLauncher::passing("Both candidates look plausible.");
    let error = fixture
        .engine
        .review_ticket_with(&fixture.ticket_id, &reviewer)
        .expect_err("an exact-one effect cannot ambiguously select two candidates");
    assert!(error.to_string().contains("expected exactly 1"), "{error}");
    assert!(
        reviewer.requests.borrow().is_empty(),
        "count/precondition readiness is compiler-validated before spending reviewer tokens"
    );
    let graph = fixture.store.graph()?;
    for node_id in [&first.id, &second.id] {
        let evidence = graph.node(node_id).expect("candidate remains present");
        assert!(evidence.spec.get("promotion_state").is_none());
        assert!(evidence.spec.get("promoted_by").is_none());
        assert!(evidence.spec.get("promotion_review_id").is_none());
    }
    assert!(fixture.store.ticket(&fixture.ticket_id)?.reviews.is_empty());
    Ok(())
}

struct ReviewEffectFixture {
    _temp: TempDir,
    root: PathBuf,
    ticket_id: String,
    hypothesis_id: String,
    engine: Engine,
    store: StateStore,
}

fn review_effect_fixture() -> Result<ReviewEffectFixture, Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("review-effect-research-project");
    let installed = root.join(".codex/koni");
    copy_fixture(&profile_root(), &installed)?;

    let operations_path = installed.join("operations/research.yaml");
    let mut operations: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&operations_path)?)?;
    let synthesize = operations["operations"]
        .as_sequence_mut()
        .expect("operations is a sequence")
        .iter_mut()
        .find(|operation| {
            operation["id"].as_str() == Some("evidence-reports.node.synthesize-evidence")
        })
        .expect("research profile has synthesize-evidence operation")
        .as_mapping_mut()
        .expect("operation is a mapping");
    synthesize.remove(serde_yaml::Value::String("receipt_coverage".to_owned()));
    fs::write(&operations_path, serde_yaml::to_string(&operations)?)?;

    let rules_path = installed.join("rules/research.yaml");
    let mut rules: serde_yaml::Value = serde_yaml::from_str(&fs::read_to_string(&rules_path)?)?;
    let promoted = rules["queries"]
        .as_sequence_mut()
        .expect("queries is a sequence")
        .iter_mut()
        .find(|query| query["id"].as_str() == Some("promoted-current-evidence"))
        .expect("research profile has promoted evidence query")
        .as_mapping_mut()
        .expect("query is a mapping");
    promoted.insert(
        serde_yaml::Value::String("where".to_owned()),
        serde_yaml::from_str(
            r#"
all:
  - {op: field_equals, subject: $node, field: spec.promotion_state, value: lead-promoted}
  - {op: field_equals, subject: $node, field: spec.promoted_by, value: lead}
  - {op: field_present, subject: $node, field: spec.promotion_review_id}
"#,
        )?,
    );
    rules["rules"] = serde_yaml::from_str(
        r#"
- id: ticket.review-effect-fixture
  phase: ticket_emission
  priority: 1
  for_each: active-hypotheses
  when:
    not:
      exists: promoted-current-evidence
  emit:
    operation: synthesize-evidence
    registry_entry_id: evidence-reports.node.synthesize-evidence
    source_state: evidence-candidate-unreviewed
    target_state: evidence-candidate-compiler-promoted
    obligations: [hypothesis.evidence]
    target_nodes: $target
    read_scope: $target
    write_scope: $target
"#,
    )?;
    fs::write(&rules_path, serde_yaml::to_string(&rules)?)?;

    initialize_repository(&root)?;
    let mut main = Engine::open_with_profile(&root, None)?;
    main.initialize_run("Exercise compiler-owned evidence promotion.")?;
    let ticket_id = main.inspect()?.eligible_tickets[0].clone();
    let main_store =
        StateStore::with_storage(root.join("program"), &main.profile().manifest.storage)?;
    let hypothesis_id = main_store
        .graph()?
        .nodes_of_type("hypothesis")
        .next()
        .expect("fixture initializes a hypothesis")
        .id
        .clone();
    main.execute_action("start", string_params([("ticket_id", ticket_id.as_str())]))?;
    let worktree = main_store
        .ticket(&ticket_id)?
        .lease
        .expect("start creates a worktree")
        .worktree;
    let mut engine = Engine::open(&worktree)?;
    engine.execute_action(
        "context",
        string_params([("ticket_id", ticket_id.as_str()), ("step", "work")]),
    )?;
    let store =
        StateStore::with_storage(worktree.join("program"), &engine.profile().manifest.storage)?;
    Ok(ReviewEffectFixture {
        _temp: temp,
        root,
        ticket_id,
        hypothesis_id,
        engine,
        store,
    })
}

fn review_effect_evidence(title: &str, hypothesis: &str) -> Node {
    let mut evidence = Node::new(
        "evidence",
        title,
        json!({
            "summary": "A bounded runtime observation supports the fixture proposition.",
            "interpretation": "The observation is supportive only within the fixture scope.",
            "evidence_basis": "empirical_runtime",
            "inference_scope": "bounded_empirical",
            "polarity": "supported",
            "confidence": "medium",
            "scope": "The deterministic fixture execution only.",
            "limitations": ["This fixture is not a universal proof."],
            "receipt_refs": ["runtime-receipt-fixture"],
            "run_dispositions": {
                "run-fixture": {
                    "disposition": "supports",
                    "receipt_id": "runtime-receipt-fixture",
                    "rationale": "The bounded fixture observation matched the expected result."
                }
            }
        }),
    );
    evidence
        .edges
        .insert("supports".to_owned(), vec![hypothesis.to_owned()]);
    evidence
}

fn prepare_review_effect_candidate(
    fixture: &mut ReviewEffectFixture,
    candidates: &[Node],
) -> Result<(), Box<dyn Error>> {
    let graph = fixture.store.graph()?;
    let mut add_nodes = Vec::new();
    let mut update_nodes = Vec::new();
    for candidate in candidates {
        if let Some(current) = graph.node(&candidate.id) {
            // Rework owns the candidate it previously materialized, but an
            // existing-node update must preserve the compiler projections
            // added since that first output.
            update_nodes.push(serde_json::to_value(current)?);
        } else {
            add_nodes.push(agent_new_node_value(candidate)?);
        }
    }
    record_output(
        &mut fixture.engine,
        &fixture.ticket_id,
        "work",
        "experiment-designer",
        json!({
            "files_read": [],
            "files_written": [],
            "findings": ["Prepared bounded unpromoted evidence candidates."],
            "risks": ["Acceptance remains compiler-owned until review passes."],
            "graph_delta": {
                "add_nodes": add_nodes,
                "update_nodes": update_nodes
            }
        }),
    )?;
    fixture.engine.compile(Some(&fixture.ticket_id), false)?;
    fixture.engine.execute_action(
        "context",
        string_params([
            ("ticket_id", fixture.ticket_id.as_str()),
            ("step", "integrate"),
        ]),
    )?;
    record_output(
        &mut fixture.engine,
        &fixture.ticket_id,
        "integrate",
        "integrator",
        json!({
            "files_read": [],
            "files_written": [],
            "findings": ["The evidence candidate graph delta is internally consistent."],
            "risks": [],
            "recommended_next_step": "Run the configured independent reviewer."
        }),
    )?;
    fixture.engine.compile(Some(&fixture.ticket_id), false)?;
    Ok(())
}

struct AutomaticGateFixture {
    _temp: TempDir,
    root: PathBuf,
    engine: Engine,
    store: StateStore,
    hypothesis_id: String,
}

#[derive(Clone, Copy)]
enum AutomaticGateCommand {
    Verdict {
        verdict: &'static str,
        wrong_identity: bool,
    },
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Missing,
}

struct AutomaticGateCase {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    key: String,
    gate_id: String,
    asset_id: String,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    asset_root: String,
}

fn automatic_gate_fixture(goal: &str) -> Result<AutomaticGateFixture, Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("research-project");
    copy_fixture(&profile_root(), &root.join(".codex/koni"))?;
    initialize_repository(&root)?;
    let mut engine = Engine::open_with_profile(&root, None)?;
    engine.initialize_run(goal)?;
    let store = StateStore::with_storage(root.join("program"), &engine.profile().manifest.storage)?;
    let hypothesis_id = store
        .graph()?
        .nodes_of_type("hypothesis")
        .next()
        .expect("initialized research graph has a hypothesis")
        .id
        .clone();
    Ok(AutomaticGateFixture {
        _temp: temp,
        root,
        engine,
        store,
        hypothesis_id,
    })
}

fn automatic_gate_node(key: &str, hypothesis_id: &str, capability: &str) -> Node {
    let mut gate = Node::new(
        "gate",
        format!("Automatic {key} gate"),
        json!({
            "assertion": format!("The {key} adapter returns its configured terminal result."),
            "applicability": format!("The local {key} automatic gate fixture."),
            "capability": {"name": capability, "protocol_range": ">=1.0,<2.0"},
            "command_result_contract": {"result_protocol": "autoresearch.gate-result.v1"},
            "oracle_semantics": {
                "pass": "The adapter verdict is passing.",
                "fail": "The adapter verdict is failing.",
                "inconclusive": "The adapter could not discriminate the outcome.",
                "contract_error": "The adapter output violates its deterministic result contract."
            },
            "failure_meaning": format!("The {key} fixture has not satisfied its deterministic contract."),
            "expected_red": true
        }),
    );
    gate.status = "draft".to_owned();
    gate.edges
        .insert("applies_to".to_owned(), vec![hypothesis_id.to_owned()]);
    gate
}

fn install_automatic_gate_case(
    graph: &mut Graph,
    store: &StateStore,
    project_root: &Path,
    hypothesis_id: &str,
    key: &str,
    command: AutomaticGateCommand,
) -> Result<AutomaticGateCase, Box<dyn Error>> {
    let capability = format!("research.automatic_{}", key.replace('-', "_"));
    let gate = automatic_gate_node(key, hypothesis_id, &capability);
    let mut asset = Node::new(
        "asset",
        format!("Automatic {key} asset"),
        json!({"capabilities": [{"name": capability, "version": "1.0.0"}]}),
    );
    asset.status = "draft".to_owned();
    let asset_root = format!("program/assets/automatic-{key}");
    let entrypoint = format!("{asset_root}/main.py");
    asset.spec = json!({
        "capabilities": [{"name": capability, "version": "1.0.0"}],
        "implementation_plan": {"root": asset_root, "files": [entrypoint]},
        "implementation": {"kind": "script", "entrypoints": [entrypoint]},
        "source_strategy": "internal"
    });
    if let AutomaticGateCommand::Verdict {
        verdict,
        wrong_identity,
    } = command
    {
        let reported_gate_id = if wrong_identity {
            format!("wrong-{}", gate.id)
        } else {
            gate.id.clone()
        };
        let gate_result = serde_json::to_string(&json!({
            "schema_version": "1.0",
            "protocol": "autoresearch.gate-result.v1",
            "gate_id": reported_gate_id,
            "verdict": verdict,
            "measurements": {"fixture": key}
        }))?;
        let mut gate_contracts = serde_json::Map::new();
        gate_contracts.insert(
            gate.id.clone(),
            json!({
                "protocol": "autoresearch.gate-result.v1",
                "command": ["python3", "-c", format!("print({gate_result:?})")]
            }),
        );
        asset
            .spec
            .as_object_mut()
            .expect("asset spec is an object")
            .insert("gate_contracts".to_owned(), Value::Object(gate_contracts));
    }
    asset
        .edges
        .insert("validates".to_owned(), vec![gate.id.clone()]);

    fs::create_dir_all(project_root.join(&asset_root))?;
    fs::write(project_root.join(&entrypoint), format!("print({key:?})\n"))?;
    let gate_id = gate.id.clone();
    let asset_id = asset.id.clone();
    graph.upsert(gate);
    graph.upsert(asset);
    graph.save_node(&store.graph_dir(), &gate_id)?;
    graph.save_node(&store.graph_dir(), &asset_id)?;
    Ok(AutomaticGateCase {
        key: key.to_owned(),
        gate_id,
        asset_id,
        asset_root,
    })
}

fn automatic_gate_ticket(
    store: &StateStore,
    operation: &str,
    target_id: &str,
) -> Result<Ticket, Box<dyn Error>> {
    store
        .tickets()?
        .into_iter()
        .find(|ticket| {
            ticket.operation == operation && ticket.target_nodes == vec![target_id.to_owned()]
        })
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("missing {operation} ticket for {target_id}"),
            )
            .into()
        })
}

fn automatic_gate_receipts(
    store: &StateStore,
    gate_id: &str,
) -> Result<Vec<Value>, Box<dyn Error>> {
    let mut receipts = Vec::new();
    for entry in fs::read_dir(store.receipts_dir())? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("yaml") {
            continue;
        }
        let receipt: Value = serde_yaml::from_str(&fs::read_to_string(path)?)?;
        if receipt.get("receipt_type").and_then(Value::as_str) == Some("gate.receipt")
            && receipt.get("gate_policy_id").and_then(Value::as_str)
                == Some("research-capability-gates")
            && receipt.get("subject_node_ids") == Some(&json!([gate_id]))
        {
            receipts.push(receipt);
        }
    }
    receipts.sort_by_key(|receipt| {
        (
            receipt
                .get("command_attempt_sequence")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            receipt
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        )
    });
    Ok(receipts)
}

#[cfg(target_os = "macos")]
fn automatic_gate_receipt_ids(
    store: &StateStore,
    gate_id: &str,
) -> Result<Vec<String>, Box<dyn Error>> {
    Ok(automatic_gate_receipts(store, gate_id)?
        .into_iter()
        .map(|receipt| {
            receipt["id"]
                .as_str()
                .expect("gate receipt has an id")
                .to_owned()
        })
        .collect())
}

#[cfg(target_os = "macos")]
fn legacy_run_gate_ticket(
    profile_hash: &str,
    case: &AutomaticGateCase,
    hypothesis_id: &str,
) -> Ticket {
    let target_nodes = vec![case.gate_id.clone()];
    let source_state_key = "gate-missing-current-terminal-verdict".to_owned();
    Ticket {
        schema_version: "1.0".to_owned(),
        id: Ticket::deterministic_id(
            "ticket.run-gate",
            &target_nodes,
            &source_state_key,
            profile_hash,
        ),
        operation: "run-gate".to_owned(),
        status: "in_progress".to_owned(),
        title: format!("Run automatic {} gate", case.key),
        target_nodes,
        scope: Scope {
            read_nodes: BTreeSet::from([
                case.gate_id.clone(),
                case.asset_id.clone(),
                hypothesis_id.to_owned(),
            ]),
            write_nodes: BTreeSet::from([case.gate_id.clone()]),
            read_paths: BTreeSet::from([case.asset_root.clone()]),
            ..Scope::default()
        },
        source_state_key,
        target_state_key: "gate-has-current-terminal-verdict".to_owned(),
        obligation_keys: vec!["gate.verdict".to_owned()],
        profile_hash: profile_hash.to_owned(),
        rule_id: "ticket.run-gate".to_owned(),
        workflow: Vec::new(),
        outputs: Vec::new(),
        reviews: Vec::new(),
        blockers: Vec::new(),
        lease: None,
        change_control: Default::default(),
        extensions: BTreeMap::new(),
    }
}

fn agent_new_node_value(node: &Node) -> Result<Value, serde_json::Error> {
    let mut value = serde_json::to_value(node)?;
    if let Some(object) = value.as_object_mut() {
        for field in [
            "status",
            "readiness",
            "obligations",
            "tickets",
            "gates",
            "receipts",
            "evidence",
            "reports",
            "compiler",
            "asset_manifest",
        ] {
            object.remove(field);
        }
    }
    Ok(value)
}

fn integration_boundaries(
    repository: &Repository,
    run_id: &str,
) -> Result<Vec<Value>, Box<dyn Error>> {
    let directory = repository
        .commondir()
        .join("koni/transactions")
        .join(run_id);
    let mut values = Vec::new();
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) == Some("yaml") {
            values.push(serde_yaml::from_str(&fs::read_to_string(path)?)?);
        }
    }
    Ok(values)
}

fn profile_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("profiles/research")
}

fn compiled_context_json(document: &str) -> Result<Value, Box<dyn Error>> {
    let json = document
        .split_once("```json\n")
        .and_then(|(_, remainder)| remainder.rsplit_once("\n```"))
        .map(|(json, _)| json)
        .ok_or("compiler context document has no JSON fence")?;
    Ok(serde_json::from_str(json)?)
}

fn copy_fixture(source: &Path, destination: &Path) -> Result<(), Box<dyn Error>> {
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
    let mut options = RepositoryInitOptions::new();
    options.initial_head("main");
    let repository = Repository::init_opts(root, &options)?;
    let mut index = repository.index()?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    {
        let tree = repository.find_tree(tree_id)?;
        let signature = Signature::now("Research Fixture", "research@example.local")?;
        repository.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "chore: initialize research fixture",
            &tree,
            &[],
        )?;
    }
    Ok(repository)
}

fn head_oid(repository: &Repository) -> Result<Oid, git2::Error> {
    Ok(repository.head()?.peel_to_commit()?.id())
}

fn commit_file(
    repository: &Repository,
    path: &Path,
    contents: &str,
    message: &str,
) -> Result<Oid, Box<dyn Error>> {
    let workdir = repository
        .workdir()
        .expect("fixture repository has a workdir");
    let destination = workdir.join(path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&destination, contents)?;
    let mut index = repository.index()?;
    index.add_path(path)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    let tree = repository.find_tree(tree_id)?;
    let parent = repository.head()?.peel_to_commit()?;
    let signature = Signature::now("Research Fixture", "research@example.local")?;
    Ok(repository.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &[&parent],
    )?)
}

fn commit_all_changes(repository: &Repository, message: &str) -> Result<Oid, Box<dyn Error>> {
    let mut index = repository.index()?;
    index.update_all(["*"], None)?;
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.write()?;
    let tree_id = index.write_tree()?;
    let tree = repository.find_tree(tree_id)?;
    let parent = repository.head()?.peel_to_commit()?;
    let signature = Signature::now("Research Fixture", "research@example.local")?;
    Ok(repository.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &[&parent],
    )?)
}

fn repository_status(repository: &Repository) -> Result<Vec<PathBuf>, git2::Error> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repository.statuses(Some(&mut options))?;
    let mut paths = Vec::new();
    for entry in statuses.iter() {
        paths.push(PathBuf::from(entry.path()?));
    }
    Ok(paths)
}

fn koni_trailer_commits(repository: &Repository) -> Result<Vec<Oid>, git2::Error> {
    let mut walk = repository.revwalk()?;
    walk.push_head()?;
    let mut commits = Vec::new();
    for oid in walk {
        let oid = oid?;
        let commit = repository.find_commit(oid)?;
        if commit
            .message()
            .is_ok_and(|message| message.contains("Koni-Ticket:"))
        {
            commits.push(oid);
        }
    }
    Ok(commits)
}

fn empirical_claim_spec(statement: &str) -> Value {
    json!({
        "claim": statement,
        "scope": "The bounded fixture project and configured transition under test.",
        "assumptions": ["The fixture graph and compiler inputs are valid before this transition."],
        "falsification": "A current compiler receipt or graph observation that contradicts the statement falsifies it within scope.",
        "evidence_standard": "Only current empirical runtime receipts support or contradict the claim, and conclusions remain bounded to the observed fixture scope.",
        "threat_model": ["Stale receipts, incomplete graph coverage, and fixture-only observations can otherwise overstate support."]
    })
}

fn string_params<const N: usize>(pairs: [(&str, &str); N]) -> BTreeMap<String, String> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

struct StaticReviewLauncher {
    output: String,
    requests: RefCell<Vec<AgentProcessRequest>>,
}

impl StaticReviewLauncher {
    fn passing(summary: &str) -> Self {
        Self {
            output: serde_json::to_string(&json!({
                "schema_version": "1.0",
                "verdict": "passed",
                "summary": summary,
                "findings": ["No blocking findings remain at the configured boundary."],
                "evidence_pointers": ["ticket outputs and scoped compile receipts"]
            }))
            .expect("review result serializes"),
            requests: RefCell::new(Vec::new()),
        }
    }

    fn failed(summary: &str) -> Self {
        Self {
            output: serde_json::to_string(&json!({
                "schema_version": "1.0",
                "verdict": "failed",
                "summary": summary,
                "findings": ["The configured acceptance boundary is not yet satisfied."],
                "evidence_pointers": ["ticket outputs and scoped compile receipts"]
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
        let pid = 45_001;
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
            ("ticket_id", ticket),
            ("step", step),
            ("persona", persona),
            ("payload", payload.as_str()),
        ]),
    )?;
    Ok(())
}
