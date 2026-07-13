use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use git2::{IndexAddOption, Repository, RepositoryInitOptions, Signature};
use koni_core::graph::{Graph, Node, normalized_hash};
use koni_core::state::{Scope, StateStore, Ticket};
use koni_core::{AgentProcessLauncher, AgentProcessRequest, AgentProcessResult, Engine};
use serde_json::{Map, Value, json};
use tempfile::TempDir;
use walkdir::WalkDir;

const CONCLUDE_OPERATION: &str = "conclude-hypothesis";
const DRAFT_PAPER_OPERATION: &str = "draft-paper-input";

#[test]
fn canonical_conclusion_becomes_the_only_paper_input_without_backlinks()
-> Result<(), Box<dyn Error>> {
    let mut fixture = ConclusionFixture::new()?;

    let candidate = fixture.valid_conclusion_report();
    assert!(!candidate.edges.contains_key("reports"));
    assert_eq!(
        candidate.edges.get("summarizes"),
        Some(&vec![fixture.hypothesis_id.clone()])
    );
    assert!(candidate.spec.get("paper_context_role").is_none());
    assert!(candidate.spec.get("paper_input_status").is_none());
    let canonical_graph = fixture.work_store.graph()?;
    assert!(
        !canonical_graph
            .node(&fixture.hypothesis_id)
            .unwrap()
            .edges
            .contains_key("reports"),
        "report.summarizes is canonical; hypothesis.reports is optional"
    );
    for claim_id in &fixture.claim_ids {
        assert!(
            canonical_graph
                .node(claim_id)
                .is_some_and(|claim| !claim.edges.contains_key("evidence")),
            "canonical evidence direction must not need a claim.evidence backlink"
        );
    }
    for (index, evidence_id) in fixture.evidence_ids.iter().enumerate() {
        let relation = if index == 0 {
            "supports"
        } else {
            "contradicts"
        };
        assert_eq!(
            canonical_graph
                .node(evidence_id)
                .unwrap()
                .edges
                .get(relation),
            Some(&vec![fixture.claim_ids[index].clone()]),
            "evidence must point canonically to its claim"
        );
    }

    fixture.prepare_conclusion(candidate.clone())?;
    fixture.work_engine.review_ticket_with(
        &fixture.conclusion_ticket_id,
        &StaticReviewLauncher::passing(),
    )?;
    let accepted = fixture
        .work_store
        .graph()?
        .node(&candidate.id)
        .cloned()
        .expect("accepted conclusion report");
    assert_eq!(accepted.spec["concluded_by"], "lead");
    assert!(accepted.spec["conclusion_review_id"].is_string());
    assert!(accepted.spec.get("paper_context_role").is_none());
    assert!(accepted.spec.get("paper_input_status").is_none());

    fixture.work_engine.execute_action(
        "finish",
        string_params([("ticket_id", fixture.conclusion_ticket_id.as_str())]),
    )?;
    let mut integrated = Engine::open(&fixture.root)?;
    integrated.compile(None, false)?;
    assert_eq!(
        eligible_operations(&fixture.root, &integrated)?,
        vec![DRAFT_PAPER_OPERATION],
        "a reviewed conclusion cites every current evidence atom, so generic report compilation stays suppressed"
    );
    assert_ne!(
        derived_research_status(&fixture.root)?.as_deref(),
        Some("concluded"),
        "a reviewed scientific conclusion is not yet a paper-ready terminal run"
    );

    let store = research_store(&fixture.root, &integrated)?;
    let mut graph = store.graph()?;
    graph.node_mut(&candidate.id).unwrap().spec["paper_context_role"] = json!("results");
    graph.save_node(&store.graph_dir(), &candidate.id)?;
    integrated.compile(None, false)?;
    assert_ne!(
        derived_research_status(&fixture.root)?.as_deref(),
        Some("concluded"),
        "paper_context_role alone must not satisfy the terminal contract"
    );

    let mut graph = store.graph()?;
    graph.node_mut(&candidate.id).unwrap().spec["paper_input_status"] = json!("ready");
    graph.save_node(&store.graph_dir(), &candidate.id)?;
    integrated.compile(None, false)?;
    assert_eq!(
        derived_research_status(&fixture.root)?.as_deref(),
        Some("concluded"),
        "the terminal derivation requires both configured paper-input fields"
    );
    assert!(eligible_operations(&fixture.root, &integrated)?.is_empty());
    Ok(())
}

#[test]
fn conclusion_review_rejects_every_missing_or_extra_exact_coverage_dimension()
-> Result<(), Box<dyn Error>> {
    for case in [
        InvalidCoverage::MissingClaimDisposition,
        InvalidCoverage::ExtraClaimDisposition,
        InvalidCoverage::MissingCuratedEvidence,
        InvalidCoverage::ExtraCuratedEvidence,
        InvalidCoverage::MissingCitation,
        InvalidCoverage::ExtraCitation,
        InvalidCoverage::WrongHypothesisId,
    ] {
        let mut fixture = ConclusionFixture::new()?;
        let mut report = fixture.valid_conclusion_report();
        case.apply(&fixture, &mut report);
        fixture.prepare_conclusion(report)?;
        let reviewer = StaticReviewLauncher::passing();
        let error = fixture
            .work_engine
            .review_ticket_with(&fixture.conclusion_ticket_id, &reviewer)
            .expect_err(case.label());
        let message = error.to_string();
        assert!(
            message.contains(case.coverage_id()),
            "{} should fail its configured coverage contract: {message}",
            case.label()
        );
        assert!(
            reviewer.requests.borrow().is_empty(),
            "{} is compiler-rejected before reviewer tokens are spent",
            case.label()
        );
        assert!(
            fixture
                .work_store
                .ticket(&fixture.conclusion_ticket_id)?
                .reviews
                .is_empty(),
            "{} must not record a partial acceptance",
            case.label()
        );
    }
    Ok(())
}

#[test]
fn superseded_runtime_receipts_reopen_the_closed_conclusion_ticket() -> Result<(), Box<dyn Error>> {
    let mut fixture = ConclusionFixture::new()?;
    let report = fixture.valid_conclusion_report();
    fixture.prepare_conclusion(report.clone())?;
    fixture.work_engine.review_ticket_with(
        &fixture.conclusion_ticket_id,
        &StaticReviewLauncher::passing(),
    )?;
    fixture.work_engine.execute_action(
        "finish",
        string_params([("ticket_id", fixture.conclusion_ticket_id.as_str())]),
    )?;

    let mut integrated = Engine::open(&fixture.root)?;
    let store = research_store(&fixture.root, &integrated)?;
    install_replacement_current_evidence(
        &mut integrated,
        &store,
        &fixture.claim_ids,
        &fixture.run_ids,
    )?;
    integrated.compile(None, false)?;
    let operations = eligible_operations(&fixture.root, &integrated)?;
    assert!(
        operations
            .iter()
            .any(|operation| operation == CONCLUDE_OPERATION),
        "replacement current evidence must reopen hypothesis adjudication: {operations:?}"
    );
    assert!(
        operations
            .iter()
            .all(|operation| operation != "compile-report"),
        "conclusion precedence must continue suppressing per-evidence report compilation: {operations:?}"
    );
    let reopened = store.ticket(&fixture.conclusion_ticket_id)?;
    assert_eq!(reopened.status, "todo");
    assert!(reopened.outputs.is_empty());
    assert!(reopened.reviews.is_empty());
    assert_eq!(reopened.extensions["reopen_count"], 1);
    assert_eq!(
        reopened.extensions["prior_cycles"].as_array().map(Vec::len),
        Some(1),
        "the closed acceptance remains archived as provenance instead of authorizing the reopened cycle"
    );
    assert_ne!(
        derived_research_status(&fixture.root)?.as_deref(),
        Some("concluded")
    );
    Ok(())
}

#[derive(Clone, Copy)]
enum InvalidCoverage {
    MissingClaimDisposition,
    ExtraClaimDisposition,
    MissingCuratedEvidence,
    ExtraCuratedEvidence,
    MissingCitation,
    ExtraCitation,
    WrongHypothesisId,
}

impl InvalidCoverage {
    fn label(self) -> &'static str {
        match self {
            Self::MissingClaimDisposition => "missing claim disposition",
            Self::ExtraClaimDisposition => "extra claim disposition",
            Self::MissingCuratedEvidence => "missing curated evidence reference",
            Self::ExtraCuratedEvidence => "extra curated evidence reference",
            Self::MissingCitation => "missing evidence citation",
            Self::ExtraCitation => "extra evidence citation",
            Self::WrongHypothesisId => "wrong hypothesis_id",
        }
    }

    fn coverage_id(self) -> &'static str {
        match self {
            Self::MissingClaimDisposition | Self::ExtraClaimDisposition => {
                "exact-claim-dispositions"
            }
            Self::MissingCuratedEvidence | Self::ExtraCuratedEvidence => "exact-curated-evidence",
            Self::MissingCitation | Self::ExtraCitation => "exact-evidence-citations",
            Self::WrongHypothesisId => "exact-hypothesis-reference",
        }
    }

    fn apply(self, fixture: &ConclusionFixture, report: &mut Node) {
        match self {
            Self::MissingClaimDisposition => {
                report.spec["claim_dispositions"]
                    .as_object_mut()
                    .unwrap()
                    .remove(&fixture.claim_ids[1]);
            }
            Self::ExtraClaimDisposition => {
                report.spec["claim_dispositions"]
                    .as_object_mut()
                    .unwrap()
                    .insert(fixture.extra_claim_id.clone(), json!("supported"));
            }
            Self::MissingCuratedEvidence => {
                report.spec["curated_evidence_refs"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            }
            Self::ExtraCuratedEvidence => {
                report.spec["curated_evidence_refs"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(fixture.extra_evidence_id));
            }
            Self::MissingCitation => {
                report.edges.get_mut("cites").unwrap().pop();
            }
            Self::ExtraCitation => {
                report
                    .edges
                    .get_mut("cites")
                    .unwrap()
                    .push(fixture.extra_evidence_id.clone());
            }
            Self::WrongHypothesisId => {
                report.spec["hypothesis_id"] = json!(fixture.extra_hypothesis_id);
            }
        }
    }
}

struct ConclusionFixture {
    _temp: TempDir,
    root: PathBuf,
    conclusion_ticket_id: String,
    hypothesis_id: String,
    extra_hypothesis_id: String,
    claim_ids: Vec<String>,
    extra_claim_id: String,
    evidence_ids: Vec<String>,
    extra_evidence_id: String,
    run_ids: Vec<String>,
    work_engine: Engine,
    work_store: StateStore,
}

impl ConclusionFixture {
    fn new() -> Result<Self, Box<dyn Error>> {
        let temp = TempDir::new()?;
        let root = temp.path().join("conclusion-contract-research");
        let installed = root.join(".codex/koni");
        copy_fixture(&profile_root(), &installed)?;
        minimize_fixture_profile(&installed)?;
        initialize_repository(&root)?;

        let mut main = Engine::open_with_profile(&root, None)?;
        main.initialize_run("Evaluate the bounded conclusion contract.")?;
        let store = research_store(&root, &main)?;
        let mut graph = store.graph()?;
        let hypothesis_id = graph
            .nodes_of_type("hypothesis")
            .next()
            .expect("run initialization creates a hypothesis")
            .id
            .clone();

        let claim_ids = vec!["claim-a".to_owned(), "claim-b".to_owned()];
        let run_ids = vec!["run-a".to_owned(), "run-b".to_owned()];
        let evidence_ids = vec!["evidence-a".to_owned(), "evidence-b".to_owned()];
        let extra_hypothesis_id = "hypothesis-unrelated".to_owned();
        let extra_claim_id = "claim-unrelated".to_owned();
        let extra_evidence_id = "evidence-unrelated".to_owned();

        {
            let hypothesis = graph.node_mut(&hypothesis_id).unwrap();
            hypothesis
                .edges
                .insert("claims".to_owned(), claim_ids.clone());
        }
        graph.insert(fixed_node(
            &extra_hypothesis_id,
            "hypothesis",
            "Unrelated hypothesis",
            json!({"hypothesis": "An unrelated proposition used only as a wrong-reference sentinel."}),
        ))?;
        for (index, claim_id) in claim_ids.iter().enumerate() {
            let experiment_id = format!("experiment-{}", index + 1);
            let mut claim = fixed_node(
                claim_id,
                "claim",
                format!("Bounded claim {}", index + 1),
                empirical_claim_spec(index + 1),
            );
            claim
                .edges
                .insert("tested_by".to_owned(), vec![experiment_id.clone()]);
            graph.insert(claim)?;

            let mut experiment = fixed_node(
                &experiment_id,
                "experiment",
                format!("Empirical experiment {}", index + 1),
                json!({
                    "objective": "Execute a bounded runtime observation for the target claim.",
                    "target_claim_summary": "Distinguish support from contradiction for one bounded claim.",
                    "empirical_mode": "observation",
                    "execution_protocol": "Run the deterministic fixture subject and record its observable value.",
                    "observable_outcome": "A runtime value whose configured branch supports or contradicts the claim."
                }),
            );
            experiment
                .edges
                .insert("target_claims".to_owned(), vec![claim_id.clone()]);
            experiment
                .edges
                .insert("runs".to_owned(), vec![run_ids[index].clone()]);
            graph.insert(experiment)?;
            graph.insert(fixed_node(
                &run_ids[index],
                "run",
                format!("Runtime observation {}", index + 1),
                json!({"intent": "Produce one deterministic bounded observation."}),
            ))?;
        }
        graph.insert(fixed_node(
            &extra_claim_id,
            "claim",
            "Unrelated claim",
            empirical_claim_spec(99),
        ))?;

        for (index, evidence_id) in evidence_ids.iter().enumerate() {
            let relation = if index == 0 {
                "supports"
            } else {
                "contradicts"
            };
            graph.insert(evidence_node(
                evidence_id,
                &claim_ids[index],
                relation,
                &run_ids,
                1,
                true,
            ))?;
        }
        graph.insert(evidence_node(
            &extra_evidence_id,
            &extra_claim_id,
            "informs",
            &run_ids,
            1,
            false,
        ))?;
        configure_runtime_contracts(&mut graph, &run_ids)?;
        for node_id in graph
            .nodes()
            .map(|node| node.id.clone())
            .collect::<Vec<_>>()
        {
            graph.save_node(&store.graph_dir(), &node_id)?;
        }
        write_runtime_receipts(&mut main, &store, &graph, &run_ids, 1)?;

        let board = main.compile(None, false)?;
        let operations = board
            .eligible_tickets
            .iter()
            .map(|id| Ok(store.ticket(id)?.operation))
            .collect::<Result<Vec<_>, koni_core::KoniError>>()?;
        assert_eq!(operations, vec![CONCLUDE_OPERATION]);
        let conclusion_ticket_id = board.eligible_tickets[0].clone();
        main.execute_action(
            "start",
            string_params([("ticket_id", conclusion_ticket_id.as_str())]),
        )?;
        let worktree = store
            .ticket(&conclusion_ticket_id)?
            .lease
            .expect("start creates an isolated conclusion worktree")
            .worktree;
        let work_engine = Engine::open(&worktree)?;
        let work_store = research_store(&worktree, &work_engine)?;
        Ok(Self {
            _temp: temp,
            root,
            conclusion_ticket_id,
            hypothesis_id,
            extra_hypothesis_id,
            claim_ids,
            extra_claim_id,
            evidence_ids,
            extra_evidence_id,
            run_ids,
            work_engine,
            work_store,
        })
    }

    fn valid_conclusion_report(&self) -> Node {
        let dispositions = self
            .claim_ids
            .iter()
            .map(|claim_id| (claim_id.clone(), json!("supported")))
            .collect::<Map<_, _>>();
        let mut report = fixed_node(
            "conclusion-report",
            "report",
            "Bounded reviewed conclusion",
            json!({
                "summary": "The current promoted evidence supports the bounded fixture proposition.",
                "synthesis": "Each claim is dispositioned from exactly the current promoted evidence atoms.",
                "limitations": ["The conclusion remains limited to the deterministic fixture observations."],
                "curated_evidence_refs": self.evidence_ids,
                "claim_dispositions": dispositions,
                "conclusion_rationale": "The exact cited evidence set covers every configured claim within scope.",
                "hypothesis_id": self.hypothesis_id,
                "conclusion": "supported"
            }),
        );
        report
            .edges
            .insert("cites".to_owned(), self.evidence_ids.clone());
        report
            .edges
            .insert("summarizes".to_owned(), vec![self.hypothesis_id.clone()]);
        report
    }

    fn prepare_conclusion(&mut self, report: Node) -> Result<(), Box<dyn Error>> {
        self.work_engine.execute_action(
            "context",
            string_params([
                ("ticket_id", self.conclusion_ticket_id.as_str()),
                ("step", "work"),
            ]),
        )?;
        record_output(
            &mut self.work_engine,
            &self.conclusion_ticket_id,
            "work",
            "report-writer",
            json!({
                "files_read": [],
                "files_written": [],
                "findings": ["Prepared one exact, bounded conclusion report."],
                "risks": ["Paper-input metadata remains intentionally deferred."],
                "graph_delta": {"add_nodes": [agent_new_node_value(&report)?]}
            }),
        )?;
        self.work_engine
            .compile(Some(&self.conclusion_ticket_id), false)?;

        self.work_engine.execute_action(
            "context",
            string_params([
                ("ticket_id", self.conclusion_ticket_id.as_str()),
                ("step", "integrate"),
            ]),
        )?;
        record_output(
            &mut self.work_engine,
            &self.conclusion_ticket_id,
            "integrate",
            "integrator",
            json!({
                "files_read": [],
                "files_written": [],
                "findings": ["The conclusion graph delta is internally consistent."],
                "risks": [],
                "recommended_next_step": "Run the configured independent reviewer."
            }),
        )?;
        self.work_engine
            .compile(Some(&self.conclusion_ticket_id), false)?;
        Ok(())
    }
}

fn install_replacement_current_evidence(
    engine: &mut Engine,
    store: &StateStore,
    claim_ids: &[String],
    run_ids: &[String],
) -> Result<(), Box<dyn Error>> {
    let mut graph = store.graph()?;
    for (index, claim_id) in claim_ids.iter().enumerate() {
        let relation = if index == 0 {
            "supports"
        } else {
            "contradicts"
        };
        let replacement_id = format!("replacement-evidence-{}", index + 1);
        graph.insert(evidence_node(
            &replacement_id,
            claim_id,
            relation,
            run_ids,
            2,
            true,
        ))?;
        graph.save_node(&store.graph_dir(), &replacement_id)?;
    }
    write_runtime_receipts(engine, store, &graph, run_ids, 2)?;
    Ok(())
}

fn minimize_fixture_profile(installed: &Path) -> Result<(), Box<dyn Error>> {
    let rules_path = installed.join("rules/research.yaml");
    let mut rules: serde_yaml::Value = serde_yaml::from_str(&fs::read_to_string(&rules_path)?)?;
    let retained = [
        "ticket.conclude-hypothesis",
        "ticket.compile-report",
        "ticket.draft-paper-input",
        "derive.research-status",
    ];
    rules["rules"]
        .as_sequence_mut()
        .expect("research rules are a sequence")
        .retain(|rule| rule["id"].as_str().is_some_and(|id| retained.contains(&id)));
    fs::write(&rules_path, serde_yaml::to_string(&rules)?)?;

    let actions_path = installed.join("actions/research.yaml");
    let mut actions: serde_yaml::Value = serde_yaml::from_str(&fs::read_to_string(&actions_path)?)?;
    actions["actions"]
        .as_sequence_mut()
        .expect("research actions are a sequence")
        .push(serde_yaml::from_str(
            r#"
id: fixture-run-scientific
params:
  ticket_id: {type: ticket_id, required: true}
requires_main_checkout: true
recipe:
  - {primitive: check.run, check: scientific-runtime, ticket: "${params.ticket_id}"}
"#,
        )?);
    fs::write(&actions_path, serde_yaml::to_string(&actions)?)?;

    let workflows_path = installed.join("workflows/research.yaml");
    let mut workflows: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&workflows_path)?)?;
    let conclusion = workflows["workflows"]
        .as_sequence_mut()
        .expect("research workflows are a sequence")
        .iter_mut()
        .find(|workflow| workflow["id"].as_str() == Some("conclude-hypothesis"))
        .expect("research profile has a conclusion workflow");
    conclusion["review_failure_reopen_from"] = serde_yaml::Value::String("work".to_owned());
    conclusion["steps"] = serde_yaml::from_str(
        r#"
- {id: work, persona: report-writer, depends_on: [], expected_output: exact bounded conclusion report, validation_action: compile-ticket, required_receipts: [context-pack, structured-output, scoped-compile]}
- {id: integrate, kind: integration, persona: integrator, depends_on: [work], expected_output: integrated conclusion graph delta, validation_action: compile-ticket, required_receipts: [context-pack, structured-output, scoped-compile]}
- {id: review, kind: review, persona: reviewer, depends_on: [integrate], expected_output: Lead-bound conclusion acceptance, validation_action: review, required_receipts: [review-receipt]}
"#,
    )?;
    fs::write(&workflows_path, serde_yaml::to_string(&workflows)?)?;
    Ok(())
}

fn evidence_node(
    id: &str,
    claim_id: &str,
    relation: &str,
    run_ids: &[String],
    receipt_version: usize,
    promoted: bool,
) -> Node {
    let receipt_ids = run_ids
        .iter()
        .map(|run_id| format!("receipt-{run_id}-v{receipt_version}"))
        .collect::<Vec<_>>();
    let dispositions = run_ids
        .iter()
        .zip(&receipt_ids)
        .map(|(run_id, receipt_id)| {
            (
                run_id.clone(),
                json!({
                    "disposition": "supports",
                    "receipt_id": receipt_id,
                    "rationale": "The current bounded observation bears on this evidence atom."
                }),
            )
        })
        .collect::<Map<_, _>>();
    let mut spec = json!({
        "summary": "A current bounded runtime observation.",
        "interpretation": "The exact current receipts bear on the target claim within fixture scope.",
        "evidence_basis": "empirical_runtime",
        "inference_scope": "bounded_empirical",
        "polarity": if relation == "contradicts" { "contradicted" } else { "supported" },
        "confidence": "medium",
        "scope": "The deterministic fixture observations only.",
        "limitations": ["The fixture does not establish an unbounded proposition."],
        "receipt_refs": receipt_ids,
        "run_dispositions": dispositions
    });
    if promoted {
        spec["promotion_state"] = json!("lead-promoted");
        spec["promoted_by"] = json!("lead");
        spec["promotion_review_id"] = json!(format!("promotion-{id}-v{receipt_version}"));
    }
    let mut evidence = fixed_node(id, "evidence", format!("Evidence {id}"), spec);
    evidence
        .edges
        .insert("from_runs".to_owned(), run_ids.to_vec());
    evidence
        .edges
        .insert(relation.to_owned(), vec![claim_id.to_owned()]);
    evidence
}

fn configure_runtime_contracts(
    graph: &mut Graph,
    run_ids: &[String],
) -> Result<(), Box<dyn Error>> {
    let asset_id = "fixture-runtime-asset";
    let mut asset = fixed_node(
        asset_id,
        "asset",
        "Fixture runtime asset",
        json!({"capabilities": [{"name": "deterministic fixture runner"}]}),
    );
    asset.status = "archived".to_owned();
    graph.insert(asset)?;
    for run_id in run_ids {
        let run = graph.node_mut(run_id).expect("fixture run exists");
        run.spec["runtime_contract"] = json!({
            "command": [
                "python3",
                "-c",
                "import json; print(json.dumps({'schema_version':'1.0','protocol':'autoresearch.research-result.v1','verdict':'supported','measurements':{'rows':1},'observations':[],'artifacts':[]}))",
                ".codex/koni/profile.yaml"
            ],
            "result_protocol": "autoresearch.research-result.v1",
            "required_measurements": ["rows"],
            "asset_entrypoints": [{
                "asset_id": asset_id,
                "path": ".codex/koni/profile.yaml"
            }],
            "scientific_inputs": [{
                "asset_id": asset_id,
                "role": "fixture",
                "path": ".codex/koni/profile.yaml"
            }]
        });
        run.edges
            .entry("uses".to_owned())
            .or_default()
            .push(asset_id.to_owned());
    }
    Ok(())
}

fn write_runtime_receipts(
    engine: &mut Engine,
    store: &StateStore,
    _graph: &Graph,
    run_ids: &[String],
    version: usize,
) -> Result<(), Box<dyn Error>> {
    for (index, run_id) in run_ids.iter().enumerate() {
        let receipt_id = format!("receipt-{run_id}-v{version}");
        let ticket_id = format!("fixture-runtime-{run_id}");
        store.write_ticket(&Ticket {
            schema_version: "1.0".to_owned(),
            id: ticket_id.clone(),
            operation: "run-experiment".to_owned(),
            status: "closed".to_owned(),
            title: format!("Fixture runtime for {run_id}"),
            target_nodes: vec![run_id.clone()],
            scope: Scope {
                read_nodes: BTreeSet::from([run_id.clone(), "fixture-runtime-asset".to_owned()]),
                write_nodes: BTreeSet::from([run_id.clone()]),
                read_paths: BTreeSet::from([".codex/koni/profile.yaml".to_owned()]),
                write_paths: BTreeSet::new(),
            },
            source_state_key: "fixture-missing-receipt".to_owned(),
            target_state_key: "fixture-current-receipt".to_owned(),
            obligation_keys: vec!["run.receipt".to_owned()],
            profile_hash: engine.profile().hash.clone(),
            rule_id: "fixture.runtime".to_owned(),
            workflow: Vec::new(),
            outputs: Vec::new(),
            reviews: Vec::new(),
            blockers: Vec::new(),
            lease: None,
            change_control: Default::default(),
            extensions: BTreeMap::from([(
                "operation_registry_id".to_owned(),
                json!("execution.run.run-experiment"),
            )]),
        })?;
        let before = fs::read_dir(store.receipts_dir())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<BTreeSet<_>>();
        engine.execute_action(
            "fixture-run-scientific",
            string_params([("ticket_id", ticket_id.as_str())]),
        )?;
        let generated_path = fs::read_dir(store.receipts_dir())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                !before.contains(path)
                    && fs::read_to_string(path)
                        .ok()
                        .and_then(|text| serde_yaml::from_str::<Value>(&text).ok())
                        .is_some_and(|receipt| {
                            receipt.get("check_id").and_then(Value::as_str)
                                == Some("scientific-runtime")
                                && receipt.get("ticket_id").and_then(Value::as_str)
                                    == Some(ticket_id.as_str())
                        })
            })
            .expect("fixture action writes one scientific runtime receipt");
        let mut receipt: Value = serde_yaml::from_str(&fs::read_to_string(&generated_path)?)?;
        receipt["id"] = json!(receipt_id);
        receipt["recorded_at"] = json!(format!("2026-01-{version:02}T00:00:{index:02}Z"));
        receipt["receipt_hash"] = json!("");
        receipt["receipt_hash"] = json!(normalized_hash(&receipt));
        fs::remove_file(generated_path)?;
        fs::write(
            store.receipts_dir().join(format!("{receipt_id}.yaml")),
            serde_yaml::to_string(&receipt)?,
        )?;
    }
    Ok(())
}

fn empirical_claim_spec(index: usize) -> Value {
    json!({
        "claim": format!("The bounded fixture observation resolves claim {index}."),
        "scope": "The deterministic fixture population and interface only.",
        "assumptions": ["The runtime adapter preserves the configured interface."],
        "falsification": "A contradictory current runtime observation falsifies the claim within scope.",
        "evidence_standard": "Only exact current empirical runtime receipts may disposition the claim.",
        "threat_model": ["Stale receipts and incomplete coverage can overstate support."]
    })
}

fn fixed_node(id: &str, node_type: &str, title: impl Into<String>, spec: Value) -> Node {
    let mut node = Node::new(node_type, title, spec);
    node.id = id.to_owned();
    node
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

fn eligible_operations(root: &Path, engine: &Engine) -> Result<Vec<String>, Box<dyn Error>> {
    let store = research_store(root, engine)?;
    let mut operations = engine
        .inspect()?
        .eligible_tickets
        .iter()
        .map(|id| store.ticket(id).map(|ticket| ticket.operation))
        .collect::<Result<Vec<_>, _>>()?;
    operations.sort();
    Ok(operations)
}

fn derived_research_status(root: &Path) -> Result<Option<String>, Box<dyn Error>> {
    let path = root.join("program/derived-state.yaml");
    if !path.exists() {
        return Ok(None);
    }
    let value: Value = serde_yaml::from_str(&fs::read_to_string(path)?)?;
    Ok(value
        .get("research_status")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}

fn research_store(root: &Path, engine: &Engine) -> Result<StateStore, Box<dyn Error>> {
    Ok(StateStore::with_storage(
        root.join("program"),
        &engine.profile().manifest.storage,
    )?)
}

struct StaticReviewLauncher {
    requests: RefCell<Vec<AgentProcessRequest>>,
}

impl StaticReviewLauncher {
    fn passing() -> Self {
        Self {
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
        let pid = 48_101;
        on_started(pid)?;
        fs::write(&request.stdout_path, "{\"type\":\"turn.completed\"}\n")
            .expect("write reviewer events");
        fs::write(&request.stderr_path, "").expect("write reviewer stderr");
        let output_path = request
            .args
            .windows(2)
            .find(|pair| pair[0] == "--output-last-message")
            .map(|pair| PathBuf::from(&pair[1]))
            .expect("review request includes an output path");
        fs::write(
            output_path,
            serde_json::to_string(&json!({
                "schema_version": "1.0",
                "verdict": "passed",
                "summary": "The exact bounded conclusion contract is satisfied.",
                "findings": ["No blocking findings remain at this boundary."],
                "evidence_pointers": ["ticket outputs and compiler coverage checks"]
            }))
            .expect("review result serializes"),
        )
        .expect("write review result");
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

fn string_params<const N: usize>(pairs: [(&str, &str); N]) -> BTreeMap<String, String> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
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
        let signature = Signature::now("Conclusion Fixture", "research@example.local")?;
        repository.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "chore: initialize conclusion fixture",
            &tree,
            &[],
        )?;
    }
    Ok(repository)
}

fn profile_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("profiles/research")
}
