use std::cell::RefCell;
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use git2::{IndexAddOption, Oid, Repository, Signature, StatusOptions};
use koni_core::git::GitBackend;
use koni_core::graph::Node;
use koni_core::state::StateStore;
use koni_core::{
    AgentProcessLauncher, AgentProcessRequest, AgentProcessResult, Engine, RunControlStore,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use walkdir::WalkDir;

#[test]
fn git_common_dir_planning_run_has_a_clean_cockpit_projection() -> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("updog-planning");
    copy_fixture(&fixture_root(), &root)?;
    initialize_repository(&root)?;

    let planned = Engine::plan_run(&root, None, "Plan a clean software change", "HEAD", None)?;
    let snapshot = Engine::open_run(&root, &planned.run_id)?.cockpit_snapshot()?;

    assert_eq!(snapshot["run"]["status"], "planning");
    assert_eq!(snapshot["tickets"], json!([]));
    assert_eq!(snapshot["graph"], json!([]));
    assert_eq!(snapshot["validation_errors"], json!([]));
    assert_eq!(snapshot["token_usage"]["total_tokens"], 0);
    assert_eq!(snapshot["token_usage"]["completed_turns"], 0);
    Ok(())
}

#[test]
fn no_code_architecture_ticket_closes_without_touching_product_git() -> Result<(), Box<dyn Error>> {
    let temp = TempDir::new()?;
    let root = temp.path().join("updog");
    copy_fixture(&fixture_root(), &root)?;

    let repository = initialize_repository(&root)?;
    let product_head = head_oid(&repository)?;

    let mut engine = Engine::open_with_profile(&root, None)?;
    assert!(
        engine
            .profile()
            .operations
            .values()
            .all(|operation| operation.dispatch_priority == 0),
        "the existing software profile keeps the neutral default when priority is omitted"
    );
    let run_id = engine.initialize_run(
        "Map the fixture monorepo architecture before planning a change to its core package.",
    )?;
    let initial_board = engine.inspect()?;
    assert_eq!(initial_board.eligible_tickets.len(), 1);
    let ticket_id = initial_board.eligible_tickets[0].clone();

    let store = state_store(&root, &run_id, &engine.profile().manifest.storage)?;
    let initialized_objective = store
        .graph()?
        .nodes_of_type("objective")
        .next()
        .cloned()
        .expect("direct initialization creates the objective node");
    assert!(
        initialized_objective
            .field_owned("spec.planning_context")
            .is_none(),
        "legacy direct initialization must not invent an approved planning handoff"
    );
    let ticket = store.ticket(&ticket_id)?;
    assert_eq!(ticket.operation, "map-architecture");
    assert!(
        !ticket.extensions.contains_key("dispatch_priority"),
        "neutral omitted priority does not perturb compiled software tickets"
    );
    assert_eq!(ticket.workflow.len(), 4);
    assert_eq!(
        ticket
            .workflow
            .iter()
            .filter(|step| step.persona != "reviewer")
            .count(),
        3
    );

    engine.execute_action("start", string_params([("ticket", ticket_id.as_str())]))?;
    let started = store.ticket(&ticket_id)?;
    let mut ticket_engine = Engine::open(
        &started
            .lease
            .as_ref()
            .expect("start creates a ticket worktree")
            .worktree,
    )?;

    let escaped_path = ticket_engine_root(&started).join("outside-ticket-scope.txt");
    fs::write(&escaped_path, "must not be checkpointed\n")?;
    let scope_error = record_output(
        &mut ticket_engine,
        &ticket_id,
        "inspect-repository",
        "architecture-mapper",
        json!({
            "files_read": ["package.json"],
            "files_written": ["outside-ticket-scope.txt"],
            "findings": ["This output must be rejected before it mutates sidecar state."],
            "risks": [],
            "patch_proposal": "",
            "recommended_next_step": "Stop."
        }),
    )
    .expect_err("an architecture-only ticket cannot write product files");
    assert!(
        scope_error
            .to_string()
            .contains("outside its configured write scope")
    );
    assert!(store.ticket(&ticket_id)?.outputs.is_empty());
    fs::remove_file(&escaped_path)?;

    record_output(
        &mut ticket_engine,
        &ticket_id,
        "inspect-repository",
        "architecture-mapper",
        json!({
            "files_read": ["package.json", "pnpm-workspace.yaml", "packages/core/package.json"],
            "findings": ["The fixture is a pnpm workspace whose core package owns packages/core."],
            "risks": [],
            "patch_proposal": "",
            "recommended_next_step": "Map the package boundary into the semantic graph."
        }),
    )?;

    record_output(
        &mut ticket_engine,
        &ticket_id,
        "map-boundaries",
        "architecture-mapper",
        json!({
            "files_read": ["packages/core/core.js", "packages/core/core.test.js"],
            "findings": ["packages/core is a bounded package with implementation and focused proof."],
            "risks": [],
            "patch_proposal": "",
            "recommended_next_step": "Integrate the system boundary and objective relationship."
        }),
    )?;

    let graph = store.graph()?;
    let mut objective = graph
        .nodes_of_type("objective")
        .next()
        .cloned()
        .expect("initialization creates the objective node");
    assert_eq!(ticket.target_nodes, vec![objective.id.clone()]);

    let system = Node::new(
        "system",
        "Core package",
        json!({
            "kind": "package",
            "responsibility": "Own the fixture's core library behavior and focused tests.",
            "owned_paths": ["packages/core"],
            "owned_packages": ["@fixture/core"],
            "instructions": ["AGENTS.md"]
        }),
    );
    objective
        .edges
        .insert("systems".to_owned(), vec![system.id.clone()]);

    let integration_output = json!({
        "files_read": ["AGENTS.md", "packages/core/core.js", "packages/core/core.test.js"],
        "files_written": [],
        "findings": ["The objective is now linked to a repository-grounded system boundary."],
        "risks": [],
        "patch_proposal": "",
        "recommended_next_step": "Review the architecture transition.",
        "graph_delta": {
            "upsert": [
                serde_json::to_value(&objective)?,
                serde_json::to_value(&system)?
            ],
            "delete": []
        }
    });
    record_output(
        &mut ticket_engine,
        &ticket_id,
        "integrate",
        "integrator",
        integration_output.clone(),
    )?;

    let self_review = ticket_engine
        .execute_action(
            "review",
            string_params([
                ("ticket", ticket_id.as_str()),
                ("status", "passed"),
                ("notes", "Lead attempted to self-review."),
            ]),
        )
        .expect_err("a configured ticket reviewer cannot be replaced by Lead");
    assert!(self_review.to_string().contains("compiler-owned reviewer"));

    ticket_engine.review_ticket_with(
        &ticket_id,
        &StaticReviewLauncher::failed(
            "The integration summary needs a bounded correction before acceptance.",
        ),
    )?;
    let failed = store.ticket(&ticket_id)?;
    let failed_review = failed.reviews.last().expect("failed review is durable");
    assert_eq!(failed_review.status, "failed");
    assert!(!failed_review.notes.trim().is_empty());
    assert!(failed_review.agent_binding.is_some());
    assert!(
        failed
            .outputs
            .iter()
            .all(|output| output.step_id != "integrate"),
        "failed review reopens the configured integration boundary"
    );

    record_output(
        &mut ticket_engine,
        &ticket_id,
        "integrate",
        "integrator",
        integration_output,
    )?;
    let reviewer = StaticReviewLauncher::passing(
        "Architecture mapping is repository-grounded and internally consistent.",
    );
    ticket_engine.review_ticket_with(&ticket_id, &reviewer)?;
    let requests = reviewer.requests.borrow();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    let argv = &request.args;
    assert!(!argv.iter().any(|argument| argument == "--sandbox"));
    assert!(!argv.iter().any(|argument| argument == "--add-dir"));
    let scratch = request
        .environment_set
        .iter()
        .find(|(name, _)| name == "TMPDIR")
        .map(|(_, value)| PathBuf::from(value))
        .expect("configured reviewer receives TMPDIR");
    assert!(!scratch.starts_with(&request.working_directory));
    assert!(
        !scratch.exists(),
        "completed reviewer scratch is not retained"
    );
    let configs = argv
        .windows(2)
        .filter(|pair| pair[0] == "--config")
        .map(|pair| pair[1].as_str())
        .collect::<Vec<_>>();
    let selected = configs
        .iter()
        .find_map(|assignment| assignment.strip_prefix("default_permissions="))
        .expect("configured reviewer selects its scratch profile");
    let selected: toml::Value = toml::from_str(&format!("value = {selected}"))?;
    let selected = selected["value"].as_str().expect("profile name");
    let filesystem = configs
        .iter()
        .find_map(|assignment| {
            assignment.strip_prefix(&format!("permissions.{selected}.filesystem="))
        })
        .expect("configured reviewer declares an exact filesystem profile");
    let filesystem: toml::Value = toml::from_str(&format!("value = {filesystem}"))?;
    let filesystem = filesystem["value"].as_table().expect("filesystem table");
    assert_eq!(filesystem.len(), 2);
    assert_eq!(filesystem[":root"].as_str(), Some("read"));
    assert_eq!(
        filesystem[scratch.display().to_string().as_str()].as_str(),
        Some("write")
    );
    assert!(
        argv.windows(2)
            .any(|pair| pair == ["--model", "gpt-5.6-terra"])
    );
    assert!(
        argv.iter()
            .any(|argument| argument == "model_reasoning_effort=\"xhigh\"")
    );
    drop(requests);
    let reviewed = store.ticket(&ticket_id)?;
    let binding = reviewed
        .reviews
        .last()
        .and_then(|review| review.agent_binding.as_ref())
        .expect("passed review has compiler-owned provenance")
        .clone();
    let project_git = GitBackend::discover(&root)?;
    let control = RunControlStore::new(project_git.sidecar_path(format!("runs/{run_id}"))?);
    let mut reviewer_record = control
        .agent(&binding.agent_id)?
        .expect("reviewer record is durable");
    let output_path = control.root().join(
        reviewer_record
            .output_path
            .as_ref()
            .expect("reviewer output path is recorded"),
    );
    let original_output = fs::read_to_string(&output_path)?;
    fs::write(&output_path, "{\"forged\":true}\n")?;
    let stale = engine
        .execute_action(
            "finish",
            string_params([
                ("ticket", ticket_id.as_str()),
                ("message", "must not integrate stale review"),
            ]),
        )
        .expect_err("mutated reviewer output must fail closed");
    assert!(stale.to_string().contains("durable reviewer result"));
    fs::write(&output_path, original_output)?;

    reviewer_record.status = "completed".to_owned();
    control.write_agent(&reviewer_record)?;
    let forged = engine
        .execute_action(
            "finish",
            string_params([
                ("ticket", ticket_id.as_str()),
                ("message", "must not integrate forged review state"),
            ]),
        )
        .expect_err("forged reviewer status must fail closed");
    assert!(forged.to_string().contains("durable reviewer result"));
    reviewer_record.status = "accepted".to_owned();
    control.write_agent(&reviewer_record)?;
    let pre_finish_graph = store.graph()?;
    assert!(
        pre_finish_graph.node(&system.id).is_none(),
        "sidecar outputs remain ticket-local proposals until reviewed finish"
    );
    assert!(
        pre_finish_graph
            .node(&objective.id)
            .and_then(|node| node.edges.get("systems"))
            .is_none(),
        "unintegrated graph edges must not leak into canonical sidecar state"
    );
    engine.execute_action(
        "finish",
        string_params([
            ("ticket", ticket_id.as_str()),
            ("message", "docs(architecture): map fixture core package"),
        ]),
    )?;

    let final_board = engine.inspect()?;
    assert!(final_board.incomplete_integrations.is_empty());
    assert!(
        final_board
            .tickets_by_status
            .get("closed")
            .is_some_and(|tickets| tickets.contains(&ticket_id))
    );
    let closed = store.ticket(&ticket_id)?;
    assert_eq!(closed.status, "closed");
    assert!(closed.review_passed());
    assert!(closed.required_steps_complete());

    let final_graph = store.graph()?;
    let stored_objective = final_graph
        .node(&objective.id)
        .expect("objective remains in semantic state");
    assert_eq!(
        stored_objective.edges.get("systems"),
        Some(&vec![system.id.clone()])
    );
    assert!(final_graph.node(&system.id).is_some());

    assert_eq!(head_oid(&repository)?, product_head);
    assert!(product_status(&repository)?.is_empty());
    assert!(repository.commondir().join("koni/runs").is_dir());
    assert!(!root.join("program").exists());
    let boundaries = integration_boundaries(&repository, &run_id)?;
    assert_eq!(boundaries.len(), 1);
    assert_eq!(boundaries[0]["status"], "complete");
    assert_eq!(boundaries[0]["result"]["no_changes"], true);

    Ok(())
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

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/updog-repo")
}

fn ticket_engine_root(ticket: &koni_core::state::Ticket) -> PathBuf {
    PathBuf::from(
        &ticket
            .lease
            .as_ref()
            .expect("started ticket has a lease")
            .worktree,
    )
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
            "chore: initialize updog fixture",
            &tree,
            &[],
        )?;
    }
    Ok(repository)
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

fn head_oid(repository: &Repository) -> Result<Oid, git2::Error> {
    Ok(repository.head()?.peel_to_commit()?.id())
}

fn product_status(repository: &Repository) -> Result<Vec<PathBuf>, git2::Error> {
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
                "evidence_pointers": ["ticket outputs and scoped verification receipts"]
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
                "findings": ["The configured integration output must be revised."],
                "evidence_pointers": ["ticket integrate output"]
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
        if let Some((_, scratch)) = request
            .environment_set
            .iter()
            .find(|(name, _)| name == "TMPDIR")
        {
            assert!(Path::new(scratch).is_dir(), "scratch exists during review");
        }
        self.requests.borrow_mut().push(request.clone());
        let pid = 45_002;
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
            ("ticket", ticket),
            ("step", step),
            ("persona", persona),
            ("payload", payload.as_str()),
        ]),
    )?;
    Ok(())
}
