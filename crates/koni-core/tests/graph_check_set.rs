use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use git2::{IndexAddOption, Repository, Signature};
use koni_core::Engine;
use koni_core::git::GitBackend;
use koni_core::graph::Node;
use koni_core::state::{StateStore, Step};
use serde_json::{Value, json};
use tempfile::TempDir;

const PROFILE: &str = r#"
schema_version: "1.0"
engine: ">=0.1,<0.2"
profile:
  id: graph-check-set-fixture
  version: 1.0.0
  description: Generic graph-selected command-set integration fixture
initialization:
  root_node_type: objective
  goal_field: goal
  root_status: active
storage:
  backend: tracked
  graph_dir: program/graph
  tickets_dir: program/tickets
  state_path: program/state.yaml
  work_dir: program/work
  receipts_dir: program/receipts
  reports_dir: program/reports
imports:
  graph: [module.yaml]
"#;

const MODULE: &str = r#"
schema_version: "1.0"
module: {id: graph-check-set.fixture, version: 1.0.0}

node_types:
  - id: objective
    description: Root objective used only to initialize the fixture run.
    stage: framing
    required_any: [[goal]]
    statuses: [active]
    semantic_fields: [goal]
    fields:
      goal: {type: string, required: true}
  - id: target
    description: Product change whose semantic proof neighborhood is compiled.
    stage: implementation
    required_any: [[name]]
    statuses: [pending, done]
    semantic_fields: [name]
    fields:
      name: {type: string, required: true}
  - id: proof
    description: Repository-owned executable proof of one target.
    stage: verification
    required_any: [[command], [source_paths], [covered_paths], [working_directory]]
    statuses: [active, superseded]
    semantic_fields: [purpose, command, source_paths, covered_paths, working_directory]
    fields:
      purpose: {type: string, required: true}
      command: {type: list, required: true, items: {type: string}}
      source_paths: {type: list, required: true, items: {type: path}}
      covered_paths: {type: list, required: true, items: {type: path}}
      working_directory: {type: path, required: true}

edge_types:
  - source: proof
    relation: verifies
    inverse: verified_by
    bidirectional: true
    targets: [target]
    min: 1
    max: 1

queries:
  - id: pending_targets
    node_types: [target]
    status_excluding: [done]

rules:
  - id: target.implement
    phase: implementation
    for_each: pending_targets
    bind: target
    when: {op: status_is, subject: $target, statuses: [pending]}
    emit:
      operation: implement
      registry_entry_id: target.implement
      source_state: target-pending
      target_state: target-done
      target_nodes: $target
      read_scope:
        union:
          - $target
          - traverse: {from: $target, relation: verified_by, min_depth: 1, max_depth: 1, node_types: [proof]}
      write_scope: $target
      read_paths:
        - select: {traverse: {from: $target, relation: verified_by, min_depth: 1, max_depth: 1, node_types: [proof]}}
          field: spec.source_paths
        - select: {traverse: {from: $target, relation: verified_by, min_depth: 1, max_depth: 1, node_types: [proof]}}
          field: spec.covered_paths
      write_paths: [src/value.txt]
      workflow: proof-workflow

operations:
  - id: target.implement
    operation: implement
    stage: implementation
    target_types: [target]
    workflow: proof-workflow
    allowed_existing_node_types: [target, proof]
    review_contract: The selected proof commands are current and exact.
    output_contract: The target is implemented without weakening its proof sources.
    checks: [promotion-proof-set, baseline-proof-set, green-proof-set]

workflows:
  - id: proof-workflow
    applies_to: [implement]
    steps:
      - id: verify
        persona: verifier
        required: false
        graph_mutation: forbidden
        expected_output: Exact graph-selected verification receipts
        checks: [promotion-proof-set]
      - id: baseline
        persona: verifier
        graph_mutation: forbidden
        expected_output: Expected-red graph-selected receipt
        checks: [baseline-proof-set]
        required_receipts: [fixture.baseline-set]
      - id: green
        persona: verifier
        graph_mutation: forbidden
        depends_on: [baseline]
        preserve_source_paths_from: baseline
        expected_output: Green receipt with unchanged proof sources
        checks: [green-proof-set]

actions:
  - id: start
    params:
      ticket: {type: ticket_id, required: true}
    allowed_ticket_states: [todo]
    recipe:
      - {primitive: ticket.transition, ticket: "${params.ticket}", to: in_progress}
  - id: run-current-checks
    params:
      ticket: {type: ticket_id, required: true}
    allowed_ticket_states: [in_progress]
    recipe:
      - {primitive: check.run, checks_from_current_step: true, ticket: "${params.ticket}"}
  - id: output
    params:
      ticket: {type: ticket_id, required: true}
      step: {type: string, required: true}
      persona: {type: string, required: true}
      payload: {type: json, required: true}
    allowed_ticket_states: [in_progress]
    recipe:
      - {primitive: output.record, ticket: "${params.ticket}", step: "${params.step}", persona: "${params.persona}", payload: "${params.payload}"}
  - id: review
    params:
      ticket: {type: ticket_id, required: true}
      status: {type: string, required: true}
      notes: {type: string, default: ""}
    allowed_ticket_states: [in_progress]
    recipe:
      - {primitive: review.validate, ticket: "${params.ticket}"}
      - {primitive: review.record, ticket: "${params.ticket}", status: "${params.status}", notes: "${params.notes}"}
  - id: validate-integration
    params:
      ticket: {type: ticket_id, required: true}
    allowed_ticket_states: [in_progress]
    recipe:
      - {primitive: integration.validate, ticket: "${params.ticket}"}

checks:
  - id: proof-command
    kind: command
    applies_to: [implement]
    command_source:
      kind: node
      selection: read_scope
      node_types: [proof]
      role: proof
      field: spec.command
    cwd: .
    timeout_seconds: 10
    receipt_type: fixture.proof
    effect: read_only
    environment: {inherit: []}
    retry_policy: {max_attempts: 1, transient_exit_codes: [], backoff_seconds: []}
  - id: proof-expected-red
    kind: command
    applies_to: [implement]
    command_source:
      kind: node
      selection: read_scope
      node_types: [proof]
      role: proof
      field: spec.command
    cwd: .
    timeout_seconds: 10
    expected_exit_codes: [1]
    receipt_type: fixture.expected-red
    receipt_freshness: historical
    composed_replay: never
    effect: read_only
    environment: {inherit: []}
    retry_policy: {max_attempts: 1, transient_exit_codes: [], backoff_seconds: []}
  - id: promotion-proof-set
    kind: composite
    applies_to: [implement]
    receipt_type: fixture.proof-set
    graph_set:
      members:
        traverse: {from: $target, relation: verified_by, min_depth: 1, max_depth: 1, node_types: [proof]}
      member_node_types: [proof]
      member_check: proof-command
      source_paths_field: spec.source_paths
      covered_paths_field: spec.covered_paths
      working_directory_field: spec.working_directory
      status_excluding: [superseded]
      min_members: 1
  - id: baseline-proof-set
    kind: composite
    applies_to: [implement]
    receipt_type: fixture.baseline-set
    graph_set:
      members:
        traverse: {from: $target, relation: verified_by, min_depth: 1, max_depth: 1, node_types: [proof]}
      member_node_types: [proof]
      member_check: proof-expected-red
      source_paths_field: spec.source_paths
      covered_paths_field: spec.covered_paths
      working_directory_field: spec.working_directory
      status_excluding: [superseded]
      min_members: 1
  - id: green-proof-set
    kind: composite
    applies_to: [implement]
    receipt_type: fixture.green-set
    graph_set:
      members:
        traverse: {from: $target, relation: verified_by, min_depth: 1, max_depth: 1, node_types: [proof]}
      member_node_types: [proof]
      member_check: proof-command
      source_paths_field: spec.source_paths
      covered_paths_field: spec.covered_paths
      working_directory_field: spec.working_directory
      status_excluding: [superseded]
      min_members: 1

personas:
  - id: verifier
    prompt: personas/verifier.md
    model_role: verifier
    sandbox:
      mode: read-only
      approval_policy: never
      network_access: false

state_machines:
  - id: ticket
    initial: todo
    states: [todo, in_progress, closed]
    terminal_states: [closed]
    transitions:
      - {id: start, from: [todo], to: in_progress, actors: [compiler]}
      - {id: finish, from: [in_progress], to: closed, actors: [compiler]}
"#;

#[derive(Clone, Copy)]
struct ProofSpec<'a> {
    id: &'a str,
    source_path: &'a str,
    script: &'a str,
}

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    engine: Engine,
    store: StateStore,
    target_id: String,
}

#[test]
fn inverse_selected_members_are_stable_exact_and_fail_closed_on_topology_drift()
-> Result<(), Box<dyn Error>> {
    let proofs = [
        ProofSpec {
            id: "proof-z",
            source_path: "tests/proof-z.sh",
            script: "#!/bin/sh\nexit 0\n",
        },
        ProofSpec {
            id: "proof-a",
            source_path: "tests/proof-a.sh",
            script: "#!/bin/sh\nexit 0\n",
        },
    ];
    let mut fixture = fixture(&proofs, "green\n")?;
    let ticket = implementation_ticket(&fixture.store)?;
    let original = step(&ticket, "verify")?
        .compiled_check_sets
        .first()
        .cloned()
        .ok_or("verify step has no compiled graph check set")?;

    assert_eq!(original.parent_check_id, "promotion-proof-set");
    assert_eq!(original.anchor_nodes, vec![fixture.target_id.clone()]);
    assert_eq!(
        original
            .members
            .iter()
            .map(|member| member.source_node_id.as_str())
            .collect::<Vec<_>>(),
        ["proof-a", "proof-z"],
        "members are sorted by stable semantic source identity, not insertion order"
    );
    for (member, source) in original
        .members
        .iter()
        .zip(["tests/proof-a.sh", "tests/proof-z.sh"])
    {
        assert_eq!(member.child_check_id, "proof-command");
        assert_eq!(member.argv, ["/bin/sh", source]);
        assert_eq!(member.working_directory, ".");
        assert_eq!(member.source_paths, BTreeSet::from([source.to_owned()]));
        assert_eq!(
            member.covered_paths,
            BTreeSet::from(["src/value.txt".to_owned()])
        );
    }
    let graph = fixture.store.graph()?;
    assert!(
        graph
            .node(&fixture.target_id)
            .is_some_and(|target| !target.edges.contains_key("verified_by")),
        "the reciprocal edge is virtual; successful selection proves inverse-aware traversal"
    );

    fixture.engine.compile(None, false)?;
    let recompiled = implementation_ticket(&fixture.store)?;
    assert_eq!(
        step(&recompiled, "verify")?.compiled_check_sets,
        vec![original.clone()],
        "an unchanged graph recompiles to the identical persisted set contract"
    );

    start_ticket(&mut fixture, &ticket.id)?;
    select_current_step(&fixture.store, &ticket.id, "verify")?;
    run_current_checks(&mut fixture.engine, &ticket.id)?;
    let receipts = member_receipts(&fixture.store, "promotion-proof-set")?;
    assert_eq!(receipts.len(), 2);
    assert_eq!(
        receipts
            .iter()
            .filter_map(compiled_member_source)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["proof-a".to_owned(), "proof-z".to_owned()])
    );
    assert!(receipts.iter().all(|receipt| {
        receipt
            .pointer("/execution_binding/compiled_member_binding/set_contract_hash")
            .and_then(Value::as_str)
            == Some(original.contract_hash.as_str())
    }));

    let before_ids = receipt_ids(&receipts);
    let mut graph = fixture.store.graph()?;
    graph
        .node_mut("proof-z")
        .ok_or("fixture proof-z disappeared")?
        .status = "superseded".to_owned();
    graph.save_node(&fixture.store.graph_dir(), "proof-z")?;
    let error = run_current_checks(&mut fixture.engine, &ticket.id)
        .expect_err("an active ticket must not silently drop a graph-set member")
        .to_string();
    assert!(
        error.contains("graph-selected check set drifted after compilation"),
        "topology drift should be diagnosed as graph-set contract drift: {error}"
    );
    let after = member_receipts(&fixture.store, "promotion-proof-set")?;
    assert_eq!(
        receipt_ids(&after),
        before_ids,
        "set drift is rejected before any newly selected member executes"
    );

    Ok(())
}

#[test]
fn selected_proof_that_is_also_a_ticket_target_compiles_once_deterministically()
-> Result<(), Box<dyn Error>> {
    let proof_id = "proof-also-target";
    let module = MODULE
        .replacen(
            "      target_nodes: $target\n",
            "      target_nodes:\n        union:\n          - $target\n          - traverse: {from: $target, relation: verified_by, min_depth: 1, max_depth: 1, node_types: [proof]}\n",
            1,
        )
        .replacen("    target_types: [target]\n", "    target_types: [target, proof]\n", 1);
    let mut fixture = fixture_with_module(
        &[ProofSpec {
            id: proof_id,
            source_path: "tests/proof-also-target.sh",
            script: "#!/bin/sh\nexit 0\n",
        }],
        "green\n",
        &module,
    )?;
    let ticket = implementation_ticket(&fixture.store)?;
    assert_eq!(
        ticket.target_nodes,
        vec![proof_id.to_owned(), fixture.target_id.clone()],
        "the ticket is anchored by both the subject and its canonically linked proof"
    );
    let original = step(&ticket, "verify")?
        .compiled_check_sets
        .first()
        .cloned()
        .ok_or("verify step has no compiled graph check set")?;
    assert_eq!(original.anchor_nodes, ticket.target_nodes);
    assert_eq!(original.members.len(), 1);
    assert_eq!(original.members[0].source_node_id, proof_id);

    fixture.engine.compile(None, false)?;
    let recompiled = implementation_ticket(&fixture.store)?;
    assert_eq!(
        step(&recompiled, "verify")?.compiled_check_sets,
        vec![original],
        "per-anchor selection unions by semantic member identity and remains stable"
    );

    Ok(())
}

#[test]
fn historical_baseline_aggregate_binds_output_recorded_before_receipt() -> Result<(), Box<dyn Error>>
{
    let script = "#!/bin/sh\nif grep -q '^green$' src/value.txt; then exit 0; else exit 1; fi\n";
    let mut fixture = fixture(
        &[ProofSpec {
            id: "proof-output-first",
            source_path: "tests/output-first.sh",
            script,
        }],
        "red\n",
    )?;
    let ticket = implementation_ticket(&fixture.store)?;
    assert_eq!(
        step(&ticket, "baseline")?.required_receipts,
        ["fixture.baseline-set"]
    );

    start_ticket(&mut fixture, &ticket.id)?;
    select_current_step(&fixture.store, &ticket.id, "baseline")?;
    record_step_output(
        &mut fixture.engine,
        &ticket.id,
        "baseline",
        &[],
        &["tests/output-first.sh", "src/value.txt"],
        &[],
    )?;
    let output_ticket = fixture.store.ticket(&ticket.id)?;
    let output = output_ticket
        .outputs
        .iter()
        .find(|output| output.step_id == "baseline")
        .cloned()
        .ok_or("baseline output was not recorded")?;
    assert!(output.receipts.is_empty());

    let before = fixture.engine.compile(Some(&ticket.id), false)?;
    let before_progress = before
        .ticket_workflows
        .get(&ticket.id)
        .ok_or("compiled board omitted fixture workflow progress")?;
    assert!(
        !before_progress
            .completed_steps
            .iter()
            .any(|step| step == "baseline"),
        "an output alone must not satisfy the composite aggregate requirement"
    );

    run_current_checks(&mut fixture.engine, &ticket.id)?;
    let receipts = member_receipts(&fixture.store, "baseline-proof-set")?;
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["status"], "passed");
    assert_eq!(receipts[0]["receipt_freshness"], "historical");
    assert_eq!(receipts[0]["expected_exit_codes"], json!([1]));
    assert_eq!(receipts[0]["origin"]["step_output_id"], output.id);
    assert_eq!(
        receipts[0]["origin"]["step_output_hash"],
        koni_core::graph::normalized_hash(&output)
    );

    fs::write(fixture.root.join("src/value.txt"), "green\n")?;
    let after = fixture.engine.compile(Some(&ticket.id), false)?;
    let after_progress = after
        .ticket_workflows
        .get(&ticket.id)
        .ok_or("compiled board omitted fixture workflow progress")?;
    assert!(
        after_progress
            .completed_steps
            .iter()
            .any(|step| step == "baseline"),
        "historical aggregate evidence should complete the exact pre-bound output"
    );
    assert!(
        after_progress
            .ready_steps
            .iter()
            .any(|step| step == "green"),
        "completing the baseline aggregate should make its dependent green step ready"
    );

    Ok(())
}

#[test]
fn graph_set_selection_cannot_traverse_an_intermediate_outside_step_read_scope()
-> Result<(), Box<dyn Error>> {
    let proof_id = "proof-behind-bridge";
    let bridge_id = "bridge-outside-read-scope";
    let module = MODULE
        .replacen(
            "edge_types:\n",
            r#"  - id: bridge
    description: Semantic routing node used to exercise selector authority.
    stage: implementation
    required_any: [[name]]
    statuses: [active]
    semantic_fields: [name]
    fields:
      name: {type: string, required: true}

edge_types:
  - source: target
    relation: routes
    targets: [bridge]
  - source: bridge
    relation: routes
    targets: [proof]
  - source: target
    relation: authorizes
    targets: [proof]
"#,
            1,
        )
        .replacen(
            "      read_scope:\n        union:\n          - $target\n          - traverse: {from: $target, relation: verified_by, min_depth: 1, max_depth: 1, node_types: [proof]}\n",
            "      read_scope:\n        union:\n          - $target\n          - traverse: {from: $target, relation: authorizes, min_depth: 1, max_depth: 1, node_types: [proof]}\n",
            1,
        )
        .replace(
            "      members:\n        traverse: {from: $target, relation: verified_by, min_depth: 1, max_depth: 1, node_types: [proof]}\n",
            "      members:\n        traverse: {from: $target, relations: [routes], min_depth: 2, max_depth: 2, node_types: [proof]}\n",
        );
    let mut fixture = uncompiled_fixture_with_module(
        &[ProofSpec {
            id: proof_id,
            source_path: "tests/behind-bridge.sh",
            script: "#!/bin/sh\nexit 0\n",
        }],
        "green\n",
        &module,
    )?;
    let mut graph = fixture.store.graph()?;
    graph
        .node_mut(&fixture.target_id)
        .ok_or("fixture target disappeared")?
        .edges
        .extend([
            ("routes".to_owned(), vec![bridge_id.to_owned()]),
            ("authorizes".to_owned(), vec![proof_id.to_owned()]),
        ]);
    let mut bridge = Node::new("bridge", "Out-of-scope bridge", json!({"name": "bridge"}));
    bridge.id = bridge_id.to_owned();
    bridge.status = "active".to_owned();
    bridge
        .edges
        .insert("routes".to_owned(), vec![proof_id.to_owned()]);
    graph.upsert(bridge.clone());
    graph.save_node(&fixture.store.graph_dir(), &fixture.target_id)?;
    graph.save_node(&fixture.store.graph_dir(), &bridge.id)?;

    let error = fixture
        .engine
        .compile(None, false)
        .expect_err("graph-set selection must not cross a node outside step read authority")
        .to_string();
    assert!(
        error.contains("composite check promotion-proof-set selected 0 eligible members")
            && error.contains("cardinality 1..unbounded"),
        "the in-scope proof must be unreachable when its only selector path crosses the excluded bridge: {error}"
    );

    Ok(())
}

#[test]
fn red_to_green_freezes_only_source_bytes_across_distinct_child_checks()
-> Result<(), Box<dyn Error>> {
    let script = "if grep -q '^green$' src/value.txt; then exit 0; else exit 1; fi\n";
    let mut fixture = fixture(
        &[ProofSpec {
            id: "proof-red-green",
            source_path: "tests/red-green.sh",
            script,
        }],
        "red\n",
    )?;
    let ticket = implementation_ticket(&fixture.store)?;
    let baseline = step(&ticket, "baseline")?;
    let green = step(&ticket, "green")?;
    assert_eq!(
        green.preserve_source_paths_from.as_deref(),
        Some("baseline")
    );
    assert_eq!(
        baseline.compiled_check_sets[0].members[0].child_check_id,
        "proof-expected-red"
    );
    assert_eq!(
        green.compiled_check_sets[0].members[0].child_check_id,
        "proof-command"
    );
    assert_eq!(
        baseline.compiled_check_sets[0].members[0].argv,
        green.compiled_check_sets[0].members[0].argv,
        "preservation joins on the concrete execution basis, not child check identity"
    );

    start_ticket(&mut fixture, &ticket.id)?;
    select_current_step(&fixture.store, &ticket.id, "baseline")?;
    run_current_checks(&mut fixture.engine, &ticket.id)?;
    let baseline_receipts = member_receipts(&fixture.store, "baseline-proof-set")?;
    assert_eq!(baseline_receipts.len(), 1);
    assert_eq!(baseline_receipts[0]["status"], "passed");
    assert_eq!(baseline_receipts[0]["expected_exit_codes"], json!([1]));
    record_step_output(
        &mut fixture.engine,
        &ticket.id,
        "baseline",
        &[receipt_id(&baseline_receipts[0])?],
        &["tests/red-green.sh", "src/value.txt"],
        &[],
    )?;

    fs::write(fixture.root.join("src/value.txt"), "green\n")?;
    select_current_step(&fixture.store, &ticket.id, "green")?;
    run_current_checks(&mut fixture.engine, &ticket.id)?;
    let green_receipts = member_receipts(&fixture.store, "green-proof-set")?;
    assert_eq!(green_receipts.len(), 1);
    assert_eq!(green_receipts[0]["status"], "passed");
    assert_eq!(green_receipts[0]["expected_exit_codes"], json!([0]));
    record_step_output(
        &mut fixture.engine,
        &ticket.id,
        "green",
        &[receipt_id(&green_receipts[0])?],
        &["tests/red-green.sh", "src/value.txt"],
        &["src/value.txt"],
    )?;

    mark_target_done(&fixture.store, &fixture.target_id)?;
    pass_review(&mut fixture.engine, &ticket.id)?;
    validate_integration(&mut fixture.engine, &ticket.id)?;

    fs::write(fixture.root.join("src/value.txt"), "changed-after-green\n")?;
    let error = validate_integration(&mut fixture.engine, &ticket.id)
        .expect_err("final acceptance must require current green evidence")
        .to_string();
    assert!(
        error.contains("required validation check green-proof-set has not passed"),
        "covered-product drift should stale green while historical baseline remains admissible: {error}"
    );
    assert!(
        !error.contains("baseline-proof-set"),
        "historical expected-red evidence must survive further covered-product drift: {error}"
    );
    fs::write(fixture.root.join("src/value.txt"), "green\n")?;

    fs::write(
        fixture.root.join("tests/red-green.sh"),
        format!("{script}# weakened after baseline\n"),
    )?;
    let error = run_current_checks(&mut fixture.engine, &ticket.id)
        .expect_err("green execution must reject proof-source mutation after expected red")
        .to_string();
    assert!(
        error.contains("source") && (error.contains("changed") || error.contains("preserv")),
        "source-byte drift should name the preservation failure: {error}"
    );
    assert_eq!(
        member_receipts(&fixture.store, "green-proof-set")?.len(),
        1,
        "source drift is rejected before a second green command is spawned"
    );

    Ok(())
}

#[test]
fn legacy_steps_default_new_graph_tdd_fields_and_omit_them_when_serialized()
-> Result<(), Box<dyn Error>> {
    let legacy: Step = serde_yaml::from_str(
        r#"
id: work
persona: coder
validation_checks: [unit]
context_hash: sha256:legacy
"#,
    )?;
    assert!(legacy.compiled_check_sets.is_empty());
    assert!(legacy.preserve_source_paths_from.is_none());

    let serialized = serde_json::to_value(&legacy)?;
    assert!(serialized.get("compiled_check_sets").is_none());
    assert!(serialized.get("preserve_source_paths_from").is_none());
    assert_eq!(serialized["validation_checks"], json!(["unit"]));

    Ok(())
}

fn fixture(proofs: &[ProofSpec<'_>], product: &str) -> Result<Fixture, Box<dyn Error>> {
    fixture_with_module(proofs, product, MODULE)
}

fn fixture_with_module(
    proofs: &[ProofSpec<'_>],
    product: &str,
    module: &str,
) -> Result<Fixture, Box<dyn Error>> {
    let mut fixture = uncompiled_fixture_with_module(proofs, product, module)?;
    fixture.engine.compile(None, false)?;
    Ok(fixture)
}

fn uncompiled_fixture_with_module(
    proofs: &[ProofSpec<'_>],
    product: &str,
    module: &str,
) -> Result<Fixture, Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("project");
    fs::create_dir_all(&root)?;
    write(&root, ".codex/koni/profile.yaml", PROFILE)?;
    write(&root, ".codex/koni/module.yaml", module)?;
    write(
        &root,
        ".codex/koni/personas/verifier.md",
        "Execute only compiler-selected repository proof commands.\n",
    )?;
    write(&root, "src/value.txt", product)?;
    for proof in proofs {
        write(&root, proof.source_path, proof.script)?;
    }
    initialize_repository(&root)?;

    let mut engine = Engine::open_with_profile(&root, None)?;
    let run_id = engine.initialize_run("Exercise deterministic graph-native proof compilation")?;
    let store = state_store(&root, &run_id, &engine.profile().manifest.storage)?;
    let target_id = "target-main".to_owned();
    let mut graph = store.graph()?;
    let mut target = Node::new(
        "target",
        "Deterministic target",
        json!({"name": "deterministic target"}),
    );
    target.id = target_id.clone();
    target.status = "pending".to_owned();
    graph.upsert(target.clone());
    graph.save_node(&store.graph_dir(), &target.id)?;
    for proof in proofs {
        let proof = proof_node(proof.id, proof.source_path, &target_id);
        graph.upsert(proof.clone());
        graph.save_node(&store.graph_dir(), &proof.id)?;
    }
    Ok(Fixture {
        _temp: temp,
        root,
        engine,
        store,
        target_id,
    })
}

fn proof_node(id: &str, source_path: &str, target_id: &str) -> Node {
    let mut proof = Node::new(
        "proof",
        format!("Proof {id}"),
        json!({
            "purpose": "focused",
            "command": ["/bin/sh", source_path],
            "source_paths": [source_path],
            "covered_paths": ["src/value.txt"],
            "working_directory": "."
        }),
    );
    proof.id = id.to_owned();
    proof.status = "active".to_owned();
    proof
        .edges
        .insert("verifies".to_owned(), vec![target_id.to_owned()]);
    proof
}

fn implementation_ticket(store: &StateStore) -> Result<koni_core::state::Ticket, Box<dyn Error>> {
    let tickets = store.tickets()?;
    tickets
        .iter()
        .find(|ticket| ticket.operation == "implement")
        .cloned()
        .ok_or_else(|| {
            let nodes = store
                .graph()
                .map(|graph| {
                    graph
                        .nodes()
                        .map(|node| format!("{}:{}:{}", node.id, node.node_type, node.status))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            format!(
                "fixture emitted no implementation ticket; tickets={:?}; nodes={nodes:?}",
                tickets
                    .iter()
                    .map(|ticket| (&ticket.id, &ticket.operation, &ticket.status))
                    .collect::<Vec<_>>()
            )
            .into()
        })
}

fn step<'a>(ticket: &'a koni_core::state::Ticket, id: &str) -> Result<&'a Step, Box<dyn Error>> {
    ticket
        .workflow
        .iter()
        .find(|step| step.id == id)
        .ok_or_else(|| format!("ticket has no {id} step").into())
}

fn start_ticket(fixture: &mut Fixture, ticket_id: &str) -> Result<(), Box<dyn Error>> {
    fixture.engine.execute_action(
        "start",
        BTreeMap::from([("ticket".to_owned(), ticket_id.to_owned())]),
    )?;
    Ok(())
}

fn select_current_step(
    store: &StateStore,
    ticket_id: &str,
    step_id: &str,
) -> Result<(), Box<dyn Error>> {
    let mut ticket = store.ticket(ticket_id)?;
    ticket.extensions.insert(
        "active_worker".to_owned(),
        json!({"step": step_id, "persona": "verifier"}),
    );
    store.write_ticket(&ticket)?;
    Ok(())
}

fn run_current_checks(engine: &mut Engine, ticket_id: &str) -> Result<Value, koni_core::KoniError> {
    engine.execute_action(
        "run-current-checks",
        BTreeMap::from([("ticket".to_owned(), ticket_id.to_owned())]),
    )
}

fn record_step_output(
    engine: &mut Engine,
    ticket_id: &str,
    step_id: &str,
    receipt_ids: &[&str],
    files_read: &[&str],
    files_written: &[&str],
) -> Result<(), Box<dyn Error>> {
    let payload = json!({
        "files_read": files_read,
        "files_written": files_written,
        "findings": [],
        "risks": [],
        "receipts": receipt_ids,
        "patch_proposal": "",
        "recommended_next_step": "continue deterministic proof workflow"
    });
    engine.execute_action(
        "output",
        BTreeMap::from([
            ("ticket".to_owned(), ticket_id.to_owned()),
            ("step".to_owned(), step_id.to_owned()),
            ("persona".to_owned(), "verifier".to_owned()),
            ("payload".to_owned(), serde_json::to_string(&payload)?),
        ]),
    )?;
    Ok(())
}

fn mark_target_done(store: &StateStore, target_id: &str) -> Result<(), Box<dyn Error>> {
    let mut graph = store.graph()?;
    graph
        .node_mut(target_id)
        .ok_or_else(|| format!("fixture target {target_id} disappeared"))?
        .status = "done".to_owned();
    graph.save_node(&store.graph_dir(), target_id)?;
    Ok(())
}

fn pass_review(engine: &mut Engine, ticket_id: &str) -> Result<(), Box<dyn Error>> {
    engine.execute_action(
        "review",
        BTreeMap::from([
            ("ticket".to_owned(), ticket_id.to_owned()),
            ("status".to_owned(), "passed".to_owned()),
            (
                "notes".to_owned(),
                "graph-selected red-green evidence is exact".to_owned(),
            ),
        ]),
    )?;
    Ok(())
}

fn validate_integration(
    engine: &mut Engine,
    ticket_id: &str,
) -> Result<Value, koni_core::KoniError> {
    engine.execute_action(
        "validate-integration",
        BTreeMap::from([("ticket".to_owned(), ticket_id.to_owned())]),
    )
}

fn member_receipts(
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
    receipts.sort_by_key(|receipt| {
        (
            compiled_member_source(receipt).unwrap_or_default(),
            receipt["id"].as_str().unwrap_or_default().to_owned(),
        )
    });
    Ok(receipts)
}

fn compiled_member_source(receipt: &Value) -> Option<String> {
    receipt
        .pointer("/execution_binding/compiled_member_binding/source_node_id")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn receipt_ids(receipts: &[Value]) -> BTreeSet<String> {
    receipts
        .iter()
        .filter_map(|receipt| receipt["id"].as_str().map(ToOwned::to_owned))
        .collect()
}

fn receipt_id(receipt: &Value) -> Result<&str, Box<dyn Error>> {
    receipt["id"]
        .as_str()
        .ok_or_else(|| "command receipt has no string id".into())
}

fn state_store(
    root: &Path,
    run_id: &str,
    storage: &koni_core::config::StorageConfig,
) -> Result<StateStore, Box<dyn Error>> {
    let state_root = match storage.backend {
        koni_core::config::StorageBackend::Tracked => root.join(
            storage
                .state_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        ),
        koni_core::config::StorageBackend::GitCommonDir => {
            GitBackend::discover(root)?.sidecar_path(format!("runs/{run_id}"))?
        }
    };
    Ok(StateStore::with_storage(state_root, storage)?)
}

fn write(root: &Path, relative: &str, contents: &str) -> Result<(), Box<dyn Error>> {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().ok_or("fixture path has no parent")?)?;
    fs::write(path, contents)?;
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
        let signature = Signature::now("Graph Set Fixture", "fixture@example.local")?;
        repository.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "test: initialize graph check set fixture",
            &tree,
            &[],
        )?;
    }
    Ok(repository)
}
