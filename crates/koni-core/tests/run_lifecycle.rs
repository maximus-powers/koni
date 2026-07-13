use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use std::process::{Command, Stdio};

use chrono::Utc;
use git2::{IndexAddOption, Oid, Repository, Signature};
use koni_core::catalog::{AgentSettingOverride, AgentSettingsOverride};
use koni_core::git::{CheckpointRequest, GitBackend, RunGitTemplates, RunTicketWorktreeRequest};
use koni_core::pipeline::{PipelineStageStatus, RunPipelineStatus};
use koni_core::state::{
    Journal, JournalStatus, Lease, ProjectRegistryStore, RunManifest, RunRegistration,
    RunRegistrationStatus, Scope, StateStore, Ticket,
};
use koni_core::{
    AgentProcessLauncher, AgentProcessRequest, AgentProcessResult, AgentSessionRecord, Engine,
    KoniError, ProjectCatalogCompiler, QuestionAutoResolution, QuestionImpact, QuestionOption,
    QuestionPauseScope, QuestionPolicy, QuestionRecord, QuestionSessionResume, QuestionStatus,
    RunControlStore, RunDeletionMode, RunPlanOverrides, RunSupervisionState, WorkerNextBoundary,
    WorkerWaitState, capture_owned_agent_process_identity,
};
use serde_json::{Value, json};

const PROJECT: &str = r#"
schema_version: "1.0"
project:
  id: canonical-lifecycle
  title: Canonical lifecycle fixture
default_run_type: canonical
run_types:
  - id: canonical
    path: run-types/canonical.yaml
"#;

const RUN_TYPE: &str = r#"
schema_version: "1.0"
id: canonical
title: Canonical coding run
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal:
      label: Goal
      type: text
      required: true
  order: [goal]
pipeline:
  stages:
    plan:
      kind: action
      title: Plan the change
  order: [plan]
questions:
  policy: autonomous
  default_scope: run
git:
  branch_template: koni/runs/{{ run.slug }}-{{ run.short_id }}
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}
run_card:
  sections: [goal, graph]
"#;

const OPAQUE_PROJECT: &str = r#"
schema_version: "1.0"
project:
  id: canonical-lifecycle
  title: Canonical lifecycle fixture
default_run_type: rt-7f3a9
run_types:
  - id: rt-7f3a9
    path: run-types/opaque.yaml
"#;

const OPAQUE_RUN_TYPE: &str = r#"
schema_version: "1.0"
id: rt-7f3a9
title: Human Friendly Delivery
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal:
      label: Goal
      type: text
      required: true
  order: [goal]
pipeline:
  stages:
    plan:
      kind: action
      title: Plan the change
  order: [plan]
questions:
  policy: autonomous
  default_scope: run
git:
  branch_template: koni/runs/{{ run.slug }}-{{ run.short_id }}
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}
run_card:
  sections: [goal, graph]
"#;

const REPLACEMENT_PROJECT: &str = r#"
schema_version: "1.0"
project:
  id: canonical-lifecycle
  title: Canonical lifecycle fixture
default_run_type: replacement
run_types:
  - id: replacement
    path: run-types/replacement.yaml
"#;

const REPLACEMENT_RUN_TYPE: &str = r#"
schema_version: "1.0"
id: replacement
title: Replacement Live Type
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal:
      label: Goal
      type: text
      required: true
  order: [goal]
pipeline:
  stages:
    plan:
      kind: action
      title: Plan the change
  order: [plan]
questions:
  policy: autonomous
  default_scope: run
git:
  branch_template: koni/runs/{{ run.slug }}-{{ run.short_id }}
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}
run_card:
  sections: [goal, graph]
"#;

const PLANNING_AGENT_RUN_TYPE: &str = r#"
schema_version: "1.0"
id: canonical
title: Agent-planned canonical coding run
instructions:
  planning: Ask focused questions before finalizing the implementation plan.
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal:
      label: Goal
      type: text
      required: true
  order: [goal]
pipeline:
  stages:
    planning:
      kind: agent_dialog
      title: Produce the implementation plan
      config:
        persona: planner
        model: stage-model
        reasoning_effort: high
        timeout_seconds: 5
        prompt: Map dependencies and verification before approval.
    approval:
      kind: approval
      title: Explicit human approval
  order: [planning, approval]
questions:
  policy: autonomous
  default_scope: run
git:
  branch_template: koni/runs/{{ run.slug }}-{{ run.short_id }}
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}
run_card:
  sections: [goal, pipeline]
"#;

const MULTI_STAGE_PLANNING_RUN_TYPE: &str = r#"
schema_version: "1.0"
id: canonical
title: Multi-stage agent-planned canonical coding run
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal:
      label: Goal
      type: text
      required: true
  order: [goal]
pipeline:
  stages:
    intake:
      kind: action
      title: Bind validated intake
      config:
        compiler_owned: true
        action: planning.intake
    architecture:
      kind: agent_dialog
      title: Plan architecture
      config:
        persona: planner
        timeout_seconds: 5
        prompt: Produce the architectural plan.
    verification:
      kind: planning
      title: Plan verification
      config:
        persona: planner
        timeout_seconds: 5
        prompt: Produce the verification plan.
    execute:
      kind: action
      title: Execute compiled tickets
      config:
        action: compile
  order: [intake, architecture, verification, execute]
questions:
  policy: autonomous
  default_scope: run
git:
  branch_template: koni/runs/{{ run.slug }}-{{ run.short_id }}
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}
run_card:
  sections: [goal, pipeline]
"#;

const PLANNING_PROMPT_PRIVACY_RUN_TYPE: &str = r#"
schema_version: "1.0"
id: canonical
title: Privacy-bounded multi-stage planning run
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal:
      label: Goal
      type: text
      required: true
  order: [goal]
pipeline:
  stages:
    architecture-private-019f55aa-1111-7111-8111-111111111111:
      kind: agent_dialog
      title: Shape the architecture
      config:
        persona: planner
        timeout_seconds: 5
        prompt: Produce the architectural plan.
    risk-private-019f55aa-2222-7222-8222-222222222222:
      kind: agent_dialog
      title: Assess risk controls
      config:
        persona: planner
        timeout_seconds: 5
        prompt: Produce the risk-control plan.
    verification-private-019f55aa-3333-7333-8333-333333333333:
      kind: planning
      title: Design verification
      config:
        persona: planner
        timeout_seconds: 5
        prompt: Produce the verification plan.
    approval:
      kind: approval
      title: Explicit human approval
  order:
    - architecture-private-019f55aa-1111-7111-8111-111111111111
    - risk-private-019f55aa-2222-7222-8222-222222222222
    - verification-private-019f55aa-3333-7333-8333-333333333333
    - approval
questions:
  policy: interactive
  default_scope: run
git:
  branch_template: koni/runs/{{ run.slug }}-{{ run.short_id }}
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}
run_card:
  sections: [goal, pipeline]
"#;

const AUTOMATIC_ORCHESTRATION_RUN_TYPE: &str = r#"
schema_version: "1.0"
id: canonical
title: Automatically orchestrated canonical run
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal: {label: Goal, type: text, required: true}
  order: [goal]
pipeline:
  stages:
    approval: {kind: approval, title: Explicit human approval}
    initialize: {kind: initialize, title: Initialize the run}
    orchestrate: {kind: orchestration, title: Execute compiled work}
    report:
      kind: action
      title: Render the report
      config: {action: report, automatic: true}
  order: [approval, initialize, orchestrate, report]
questions: {policy: autonomous, default_scope: run}
git:
  branch_template: koni/runs/{{ run.slug }}-{{ run.short_id }}
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}
run_card: {sections: [goal, pipeline]}
orchestration:
  auto_start: true
  max_parallel: 1
  compile_action: compile
  lead_action: spawn-lead
  report_action: custom-report
"#;

const REVIEW_RUN_TYPE: &str = r#"
schema_version: "1.0"
id: canonical
title: Independently reviewed canonical run
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal: {label: Goal, type: text, required: true}
  order: [goal]
pipeline:
  stages:
    approval: {kind: approval, title: Explicit human approval}
    initialize: {kind: initialize, title: Initialize the run}
    review:
      kind: agent_review
      title: Independent review
      config:
        persona: reviewer
        prompt: Review the compiler evidence independently.
        timeout_seconds: 5
    report:
      kind: action
      title: Render the final report
      config: {action: report, automatic: true}
  order: [approval, initialize, review, report]
questions: {policy: autonomous, default_scope: run}
git:
  branch_template: koni/runs/{{ run.slug }}-{{ run.short_id }}
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}
run_card: {sections: [goal, pipeline]}
agents:
  roles:
    reviewer: {model: review-model, reasoning_effort: xhigh}
orchestration: {auto_start: true, max_parallel: 1}
"#;

const PROFILE: &str = r#"
schema_version: "1.0"
engine: ">=0.1,<0.2"
profile:
  id: canonical-yaml
  version: 1.0.0
  description: Canonical all-YAML lifecycle fixture
initialization:
  root_node_type: project
  goal_field: goal
  planning_context_field: planning_context
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
  graph: [graph.yaml]
  actions: [actions.yaml]
  reports: [reports.yaml]
"#;

const GRAPH: &str = r#"
schema_version: "1.0"
node_types:
  - id: project
    description: The root project objective and goal captured by this lifecycle fixture.
    stage: framing
    required_any: [[goal]]
    statuses: [active]
    semantic_fields: [goal]
    compiler_owned_fields: [spec.planning_context]
    fields:
      goal: {type: string, required: true}
      planning_context: {type: object, required: false, description: Bounded approved plan and decisions.}
personas:
  - id: planner
    prompt: personas/planner.md
    model_role: planner
    model: persona-model
    reasoning_effort: low
    sandbox:
      mode: read-only
      approval_policy: never
      network_access: false
  - id: reviewer
    prompt: personas/reviewer.md
    model_role: unrelated-profile-role
    sandbox:
      mode: workspace-write
      approval_policy: on-request
      network_access: true

operations:
  - id: lifecycle.context
    operation: lifecycle-test
    stage: framing
    target_types: [project]
    allowed_existing_node_types: [project]
    review_contract: Read-only context fixture.
    output_contract: Compiler-issued context document.
"#;

const ACTIONS: &str = r#"
schema_version: "1.0"
module: {id: lifecycle.actions, version: 1.0.0}
actions:
  - id: recover
    recipe:
      - {primitive: recovery.dispatch}
  - id: compile
    recipe:
      - {primitive: project.validate}
    recovery: recover
  - id: report
    recipe:
      - {primitive: project.validate}
      - {primitive: report.render}
  - id: context
    params:
      ticket: {type: ticket_id, required: true}
    recipe:
      - {id: context_pack, primitive: context.compile, ticket: "${params.ticket}"}
  - id: custom-report
    recipe:
      - {primitive: project.validate}
      - {primitive: report.render}
  - id: spawn-lead
    recipe:
      - {primitive: project.validate}
"#;

const REPORTS: &str = r#"
schema_version: "1.0"
module: {id: lifecycle.reports, version: 1.0.0}
reports:
  - id: final-summary
    title: Final Summary
    formats: [json, markdown]
    source: graph
    output: program/reports/final-summary
"#;

fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("fixture file has a parent"))
        .expect("create fixture directory");
    fs::write(path, contents).expect("write fixture file");
}

fn canonical_fixture() -> (tempfile::TempDir, PathBuf, Oid) {
    canonical_fixture_with_run_type(RUN_TYPE)
}

fn canonical_fixture_with_run_type(run_type: &str) -> (tempfile::TempDir, PathBuf, Oid) {
    let temp = tempfile::tempdir().expect("temporary project");
    let root = temp.path().join("project");
    fs::create_dir(&root).expect("create project root");
    write(&root, ".codex/koni/project.yaml", PROJECT);
    write(&root, ".codex/koni/run-types/canonical.yaml", run_type);
    write(&root, ".codex/koni/profile.yaml", PROFILE);
    write(&root, ".codex/koni/graph.yaml", GRAPH);
    write(&root, ".codex/koni/actions.yaml", ACTIONS);
    write(&root, ".codex/koni/reports.yaml", REPORTS);
    write(
        &root,
        ".codex/koni/personas/planner.md",
        "You are the compiler-bound planning specialist.\n",
    );
    write(
        &root,
        ".codex/koni/personas/reviewer.md",
        "You are the independent compiler-bound reviewer.\n",
    );
    write(&root, "README.md", "# Canonical lifecycle fixture\n");

    let repository = Repository::init(&root).expect("initialize Git repository");
    repository
        .set_head("refs/heads/main")
        .expect("select main branch");
    let mut index = repository.index().expect("open Git index");
    index
        .add_all(["*"], IndexAddOption::DEFAULT, None)
        .expect("stage canonical fixture");
    let tree_id = index.write_tree().expect("write initial tree");
    index.write().expect("write initial index");
    let tree = repository.find_tree(tree_id).expect("find initial tree");
    let signature = Signature::now("Koni Test", "koni-test@example.local").expect("test signature");
    let base = repository
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            "initial canonical fixture\n",
            &tree,
            &[],
        )
        .expect("commit canonical fixture");
    drop(tree);
    drop(repository);
    (temp, root, base)
}

fn commit_all(root: &Path, message: &str) -> Oid {
    let repository = Repository::open(root).expect("open fixture repository");
    let mut index = repository.index().expect("open fixture index");
    index
        .add_all(["*"], IndexAddOption::DEFAULT, None)
        .expect("stage fixture changes");
    let tree_id = index.write_tree().expect("write fixture tree");
    index.write().expect("write fixture index");
    let tree = repository.find_tree(tree_id).expect("find fixture tree");
    let parent = repository
        .head()
        .expect("fixture HEAD")
        .peel_to_commit()
        .expect("fixture parent");
    let signature = Signature::now("Koni Test", "koni-test@example.local").expect("test signature");
    repository
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &[&parent],
        )
        .expect("commit fixture changes")
}

fn install_blocking_read_only_check(root: &Path) {
    let profile = PROFILE.replace(
        "  reports: [reports.yaml]\n",
        "  reports: [reports.yaml]\n  checks: [checks.yaml]\n",
    );
    let actions = ACTIONS.replace(
        "  - id: spawn-lead\n",
        "  - id: blocking-check\n    recipe:\n      - {primitive: check.run, check: blocking-check}\n  - id: spawn-lead\n",
    );
    let checks = r#"schema_version: "1.0"
module: {id: lifecycle.checks, version: 1.0.0}
checks:
  - id: blocking-check
    kind: command
    applies_to: [lifecycle-test]
    argv: [python3, -c, "import time; time.sleep(1)"]
    cwd: .
    timeout_seconds: 10
    receipt_type: lifecycle.blocking-check
    effect: read_only
    environment:
      inherit: [PATH, HOME, TMPDIR]
    retry_policy: {max_attempts: 1, transient_exit_codes: [], backoff_seconds: []}
"#
    .to_owned();
    write(root, ".codex/koni/profile.yaml", &profile);
    write(root, ".codex/koni/actions.yaml", &actions);
    write(root, ".codex/koni/checks.yaml", &checks);
    commit_all(root, "test: install blocking compiler check");
}

fn wait_for_command_journal(sidecar: &Path, run_id: &str) -> PathBuf {
    let directory = sidecar
        .join("command-authority")
        .join(run_id)
        .join("work/command-journals");
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(entries) = fs::read_dir(&directory)
            && let Some(path) = entries
                .filter_map(std::result::Result::ok)
                .map(|entry| entry.path())
                .find(|path| path.extension().and_then(|value| value.to_str()) == Some("yaml"))
        {
            return path;
        }
        assert!(
            Instant::now() < deadline,
            "blocking command never published its durable pre-spawn journal"
        );
        std::thread::yield_now();
    }
}

#[cfg(unix)]
#[test]
fn worker_wait_is_bounded_pause_and_question_aware_and_fails_closed_on_identity_change() {
    let (_temp, root, _base) = canonical_fixture();
    write(
        &root,
        ".codex/koni/profile.yaml",
        &PROFILE.replace("backend: tracked", "backend: git_common_dir"),
    );
    commit_all(&root, "use sidecar state for worker wait test");
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Exercise the compact worker wait boundary",
        "HEAD",
        None,
    )
    .expect("plan wait-boundary run");
    let approved = Engine::approve_run(&root, &planned.run_id).expect("approve wait-boundary run");
    let engine = Engine::open_run(&root, &planned.run_id).expect("open wait-boundary run");
    let backend = GitBackend::discover(&root).expect("discover wait-boundary repository");
    let run_root = backend
        .sidecar_path(format!("runs/{}", planned.run_id))
        .expect("wait-boundary run root");
    let store = StateStore::with_storage(run_root.clone(), &engine.profile().manifest.storage)
        .expect("open wait-boundary state");
    let control = RunControlStore::new(run_root);

    let mut command = Command::new("sleep");
    command.arg("10").process_group(0).stdin(Stdio::null());
    let mut child = command.spawn().expect("spawn owned wait worker");
    let identity = (0..50)
        .find_map(|_| {
            let identity = capture_owned_agent_process_identity(child.id());
            if identity.is_none() {
                std::thread::sleep(Duration::from_millis(10));
            }
            identity
        })
        .expect("capture durable wait-worker identity");
    let ticket: Ticket = serde_json::from_value(json!({
        "schema_version": "1.0",
        "id": "TK-wait",
        "operation": "wait-test",
        "status": "in_progress",
        "title": "Wait for a detached worker",
        "source_state_key": "before",
        "target_state_key": "after",
        "profile_hash": engine.profile().hash,
        "rule_id": "wait.test",
        "workflow": [{
            "id": "produce",
            "persona": "worker",
            "context_hash": "ctx-produce"
        }],
        "lease": {
            "id": "lease-wait",
            "branch": "koni/ticket/TK-wait",
            "worktree": approved.worktree,
            "base_commit": planned.base_commit,
            "started_at": "2026-07-12T12:00:00Z",
            "heartbeat_at": "2026-07-12T12:00:00Z",
            "worker_pid": identity.pid
        },
        "extensions": {
            "active_worker": {
                "pid": identity.pid,
                "persona": "worker",
                "step": "produce",
                "process_identity": identity
            }
        }
    }))
    .expect("construct wait-boundary ticket");
    store.write_ticket(&ticket).expect("persist wait ticket");
    let before = serde_json::to_value(store.ticket("TK-wait").unwrap()).unwrap();

    let started = Instant::now();
    let timed_out = engine
        .wait_for_workers(&["TK-wait".to_owned()], Duration::from_secs(1))
        .expect("bounded wait succeeds");
    assert_eq!(timed_out.state, WorkerWaitState::TimedOut);
    assert_eq!(timed_out.next, WorkerNextBoundary::Wait);
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(
        before,
        serde_json::to_value(store.ticket("TK-wait").unwrap()).unwrap(),
        "waiting must not mutate compiler state"
    );

    Engine::update_orchestration(&root, &planned.run_id, Some(false), None, None)
        .expect("pause automatic scheduling");
    let paused = engine
        .wait_for_workers(&["TK-wait".to_owned()], Duration::from_secs(5))
        .expect("paused wait succeeds");
    assert_eq!(paused.state, WorkerWaitState::Paused);
    Engine::update_orchestration(&root, &planned.run_id, Some(true), None, None)
        .expect("resume automatic scheduling");

    let now = Utc::now();
    let question = QuestionRecord::new(
        "wait-question",
        "Continue this selected ticket?",
        "The wait boundary must wake for operator input.",
        vec![
            QuestionOption {
                id: "continue".to_owned(),
                label: "Continue".to_owned(),
                description: "Resume the selected ticket.".to_owned(),
                recommended: true,
            },
            QuestionOption {
                id: "stop".to_owned(),
                label: "Stop".to_owned(),
                description: "Keep the selected ticket paused.".to_owned(),
                recommended: false,
            },
        ],
        false,
        QuestionPauseScope::Ticket {
            run_id: planned.run_id.clone(),
            ticket_id: "TK-wait".to_owned(),
        },
        QuestionPolicy::Interactive,
        QuestionImpact::High,
        None,
        QuestionSessionResume {
            session_id: "wait-session".to_owned(),
            agent_id: None,
            turn_id: None,
            working_directory: None,
            context_hash: koni_core::graph::normalized_hash(&"wait-context"),
            captured_at: now,
        },
        now,
    )
    .expect("construct wait question");
    control
        .write_question(&question)
        .expect("persist wait question");
    let awaiting = engine
        .wait_for_workers(&["TK-wait".to_owned()], Duration::from_secs(5))
        .expect("question-aware wait succeeds");
    assert_eq!(awaiting.state, WorkerWaitState::AwaitingOperator);
    control
        .delete_question("wait-question")
        .expect("remove wait question");

    let mut conflicted = ticket.clone();
    conflicted
        .extensions
        .get_mut("active_worker")
        .expect("active worker metadata")["process_identity"]["birth_marker"] =
        Value::String("a different process birth".to_owned());
    store
        .write_ticket(&conflicted)
        .expect("persist conflicting identity");
    let conflict = engine
        .wait_for_workers(&["TK-wait".to_owned()], Duration::from_secs(5))
        .expect("identity conflict is a normal wait boundary");
    assert_eq!(conflict.state, WorkerWaitState::OwnershipConflict);
    assert_eq!(conflict.next, WorkerNextBoundary::Stop);
    let rendered = serde_json::to_string(&conflict).unwrap();
    assert!(!rendered.contains(&identity.pid.to_string()));
    assert!(!rendered.contains(&identity.birth_marker));

    child.kill().expect("stop wait worker");
    child.wait().expect("reap wait worker");
    store
        .write_ticket(&ticket)
        .expect("restore durable worker identity");
    let exited = engine
        .wait_for_workers(&["TK-wait".to_owned()], Duration::from_secs(2))
        .expect("dead worker wait succeeds");
    assert_eq!(exited.state, WorkerWaitState::ExitedBeforeOutput);
    assert_eq!(exited.next, WorkerNextBoundary::RecoverThenRetryWorker);
}

#[test]
fn guided_run_overrides_are_materialized_only_in_the_pinned_snapshot() {
    let (_temp, root, _base) = canonical_fixture();
    write(
        &root,
        ".codex/koni/run-types/canonical.yaml",
        &format!(
            "{RUN_TYPE}\nagents:\n  roles:\n    planner: {{model: inherited-planner, reasoning_effort: high}}\n    reviewer: {{model: inherited-reviewer, reasoning_effort: xhigh}}\n"
        ),
    );
    write(
        &root,
        ".codex/koni/project.yaml",
        r#"
schema_version: "1.0"
project: {id: canonical-lifecycle, title: Canonical lifecycle fixture}
default_run_type: canonical
run_types:
  - {id: canonical, path: run-types/canonical.yaml}
  - {id: expanded, path: run-types/expanded.yaml}
"#,
    );
    write(
        &root,
        ".codex/koni/run-types/expanded.yaml",
        &RUN_TYPE
            .replace("id: canonical", "id: expanded")
            .replace("title: Canonical coding run", "title: Expanded workflow")
            .replace(
                "  order: [plan]",
                r#"    verify:
      kind: checkpoint
      title: Verify the change
  order: [plan, verify]"#,
            ),
    );
    let live_before =
        fs::read_to_string(root.join(".codex/koni/run-types/canonical.yaml")).unwrap();
    let live_catalog = ProjectCatalogCompiler::compile(&root).unwrap();
    let original_hash = live_catalog.run_type("canonical").unwrap().hash.clone();

    let overrides = RunPlanOverrides {
        workflow_run_type: Some("expanded".to_owned()),
        max_parallel: Some(7),
        agent_roles: [
            (
                "planner".to_owned(),
                AgentSettingsOverride {
                    model: Some(AgentSettingOverride::Configured(
                        "one-run-planner".to_owned(),
                    )),
                    reasoning_effort: None,
                },
            ),
            (
                "reviewer".to_owned(),
                AgentSettingsOverride {
                    model: None,
                    reasoning_effort: Some(AgentSettingOverride::CodexDefault),
                },
            ),
        ]
        .into_iter()
        .collect(),
    };
    let planned = Engine::plan_run_with_overrides(
        &root,
        Some("canonical"),
        "Pin guided overrides",
        "HEAD",
        Some("interactive"),
        &overrides,
    )
    .unwrap();

    assert_ne!(planned.run_type_hash, original_hash);
    assert_eq!(
        fs::read_to_string(root.join(".codex/koni/run-types/canonical.yaml")).unwrap(),
        live_before
    );
    let opened = Engine::open_run(&root, &planned.run_id).unwrap();
    let pinned = opened.resolved_run_type().unwrap();
    assert_eq!(pinned.pipeline.order, ["plan", "verify"]);
    assert_eq!(
        pinned
            .orchestration
            .as_ref()
            .and_then(|policy| policy.max_parallel),
        Some(7)
    );
    assert_eq!(
        pinned
            .agents
            .as_ref()
            .and_then(|agents| agents.roles.get("planner"))
            .and_then(|settings| settings.model.as_deref()),
        Some("one-run-planner")
    );
    assert_eq!(
        pinned
            .agents
            .as_ref()
            .and_then(|agents| agents.roles.get("planner"))
            .and_then(|settings| settings.reasoning_effort.as_deref()),
        Some("high"),
        "an untouched property should retain the selected run type's value"
    );
    assert_eq!(
        pinned
            .agents
            .as_ref()
            .and_then(|agents| agents.roles.get("reviewer"))
            .and_then(|settings| settings.model.as_deref()),
        Some("inherited-reviewer")
    );
    assert_eq!(
        pinned
            .agents
            .as_ref()
            .and_then(|agents| agents.roles.get("reviewer"))
            .and_then(|settings| settings.reasoning_effort.as_deref()),
        None,
        "CodexDefault should explicitly clear an inherited property"
    );
    let git = GitBackend::discover(&root).unwrap();
    let run_root = git
        .sidecar_path(format!("runs/{}", planned.run_id))
        .unwrap();
    let control = RunControlStore::new(run_root.clone());
    assert_eq!(control.orchestration().unwrap().unwrap().max_parallel, 7);
    let snapshot = koni_core::state::ConfigSnapshot::load_verified(&run_root).unwrap();
    assert_eq!(
        Engine::project_registry(&root).unwrap().runs[&planned.run_id].config_snapshot_hash,
        snapshot.hash
    );
    let pinned_source =
        fs::read_to_string(run_root.join("config-snapshot/.codex/koni/run-types/canonical.yaml"))
            .unwrap();
    assert!(pinned_source.contains("one-run-planner"), "{pinned_source}");
    assert!(
        pinned_source.contains("Verify the change"),
        "{pinned_source}"
    );
}

#[test]
fn planned_run_pins_friendly_title_when_live_opaque_run_type_is_renamed_or_deleted() {
    let (_temp, root, _base) = canonical_fixture();
    write(&root, ".codex/koni/project.yaml", OPAQUE_PROJECT);
    write(&root, ".codex/koni/run-types/opaque.yaml", OPAQUE_RUN_TYPE);

    let planned = Engine::plan_run(
        &root,
        Some("rt-7f3a9"),
        "Keep the friendly title pinned",
        "HEAD",
        None,
    )
    .expect("plan opaque run type");
    assert_eq!(planned.run_type_id, "rt-7f3a9");
    assert_eq!(planned.run_type_title, "Human Friendly Delivery");

    let git = GitBackend::discover(&root).expect("discover fixture Git repository");
    let run_root = git
        .sidecar_path(format!("runs/{}", planned.run_id))
        .expect("resolve run root");
    let manifest = StateStore::new(run_root.clone())
        .manifest()
        .expect("read pinned manifest");
    assert_eq!(
        manifest.run_type_title.as_deref(),
        Some("Human Friendly Delivery")
    );
    let registry = Engine::project_registry(&root).expect("read project registry");
    let registration = &registry.runs[&planned.run_id];
    assert_eq!(
        registration.run_type_title.as_deref(),
        Some("Human Friendly Delivery")
    );
    let snapshotted_run_type =
        fs::read_to_string(run_root.join("config-snapshot/.codex/koni/run-types/opaque.yaml"))
            .expect("read snapshotted run type");
    assert!(snapshotted_run_type.contains("title: Human Friendly Delivery"));

    let renamed_live_run_type =
        OPAQUE_RUN_TYPE.replace("Human Friendly Delivery", "Renamed Live Delivery");
    write(
        &root,
        ".codex/koni/run-types/opaque.yaml",
        &renamed_live_run_type,
    );
    let live_catalog = ProjectCatalogCompiler::compile(&root).expect("compile renamed live type");
    assert_eq!(
        live_catalog.run_type("rt-7f3a9").unwrap().title,
        "Renamed Live Delivery"
    );
    let reopened = Engine::open_run(&root, &planned.run_id).expect("open run after live rename");
    assert_eq!(
        reopened.resolved_run_type().unwrap().title,
        "Human Friendly Delivery"
    );

    fs::remove_file(root.join(".codex/koni/run-types/opaque.yaml"))
        .expect("delete opaque live run type");
    write(
        &root,
        ".codex/koni/run-types/replacement.yaml",
        REPLACEMENT_RUN_TYPE,
    );
    write(&root, ".codex/koni/project.yaml", REPLACEMENT_PROJECT);
    let live_catalog =
        ProjectCatalogCompiler::compile(&root).expect("compile replacement live catalog");
    assert!(live_catalog.run_type("rt-7f3a9").is_none());
    let reopened = Engine::open_run(&root, &planned.run_id).expect("open run after live deletion");
    assert_eq!(
        reopened.resolved_run_type().unwrap().title,
        "Human Friendly Delivery"
    );
    assert_eq!(
        reopened.cockpit_snapshot().unwrap()["run"]["run_type_title"],
        "Human Friendly Delivery"
    );
    assert_eq!(
        Engine::project_registry(&root).unwrap().runs[&planned.run_id]
            .run_type_title
            .as_deref(),
        Some("Human Friendly Delivery")
    );

    let mut legacy_manifest = serde_json::to_value(&manifest).unwrap();
    legacy_manifest
        .as_object_mut()
        .unwrap()
        .remove("run_type_title");
    let legacy_manifest: RunManifest = serde_json::from_value(legacy_manifest).unwrap();
    assert!(legacy_manifest.run_type_title.is_none());

    let mut legacy_registration = serde_json::to_value(registration).unwrap();
    legacy_registration
        .as_object_mut()
        .unwrap()
        .remove("run_type_title");
    let legacy_registration: RunRegistration = serde_json::from_value(legacy_registration).unwrap();
    assert!(legacy_registration.run_type_title.is_none());

    let manifest_path = run_root.join("run.yaml");
    let mut legacy_manifest_file: serde_json::Value =
        serde_yaml::from_str(&fs::read_to_string(&manifest_path).expect("read run manifest YAML"))
            .expect("parse run manifest YAML");
    legacy_manifest_file
        .as_object_mut()
        .unwrap()
        .remove("run_type_title");
    fs::write(
        &manifest_path,
        serde_yaml::to_string(&legacy_manifest_file).unwrap(),
    )
    .expect("write legacy run manifest YAML");

    let registry_path = git.sidecar_root().join("project.yaml");
    let mut legacy_registry_file: serde_json::Value = serde_yaml::from_str(
        &fs::read_to_string(&registry_path).expect("read project registry YAML"),
    )
    .expect("parse project registry YAML");
    legacy_registry_file["runs"][planned.run_id.as_str()]
        .as_object_mut()
        .unwrap()
        .remove("run_type_title");
    fs::write(
        &registry_path,
        serde_yaml::to_string(&legacy_registry_file).unwrap(),
    )
    .expect("write legacy project registry YAML");

    let legacy_reopened =
        Engine::open_run(&root, &planned.run_id).expect("open legacy run after live deletion");
    assert_eq!(
        legacy_reopened.cockpit_snapshot().unwrap()["run"]["run_type_title"],
        "Human Friendly Delivery"
    );
}

fn local_references(root: &Path) -> BTreeSet<String> {
    let repository = Repository::discover(root).expect("discover repository");
    repository
        .references()
        .expect("list references")
        .map(|reference| {
            reference
                .expect("read reference")
                .name()
                .expect("UTF-8 reference")
                .to_owned()
        })
        .collect()
}

fn expected_branch(goal_slug: &str, run_id: &str) -> String {
    let mut suffix = run_id
        .bytes()
        .filter(u8::is_ascii_alphanumeric)
        .rev()
        .take(8)
        .map(|byte| byte.to_ascii_lowercase())
        .collect::<Vec<_>>();
    suffix.reverse();
    format!(
        "refs/heads/koni/runs/{goal_slug}-{}",
        String::from_utf8(suffix).expect("ASCII run suffix")
    )
}

fn assert_clean_tracked_initialization(worktree: &Path, branch: &str, base: Oid) -> Oid {
    let backend = GitBackend::discover(worktree).expect("discover integration worktree");
    assert_eq!(backend.branch_ref().expect("integration branch"), branch);
    assert!(!backend.is_dirty(&[]).expect("integration status"));
    assert!(worktree.join("program/state.yaml").is_file());
    assert!(worktree.join("program/graph").is_dir());

    let head = backend.head_oid().expect("integration head");
    assert_ne!(head, base, "tracked state must be checkpointed");
    let repository = Repository::open(worktree).expect("open integration repository");
    let commit = repository
        .find_commit(head)
        .expect("find initialization commit");
    assert_eq!(commit.parent_count(), 1);
    assert_eq!(commit.parent_id(0).expect("initialization parent"), base);
    let message = commit.message().expect("UTF-8 initialization message");
    assert!(
        message.starts_with("chore(koni):"),
        "unexpected initialization commit message: {message:?}"
    );
    let tree = commit.tree().expect("initialization tree");
    assert!(tree.get_path(Path::new("program/state.yaml")).is_ok());
    assert!(tree.get_path(Path::new("program/graph")).is_ok());
    head
}

fn lifecycle_ticket(id: &str, profile_hash: &str) -> Ticket {
    Ticket {
        schema_version: "1.0".to_owned(),
        id: id.to_owned(),
        operation: "lifecycle-test".to_owned(),
        status: "ready".to_owned(),
        title: format!("Lifecycle test ticket {id}"),
        target_nodes: Vec::new(),
        scope: Scope::default(),
        source_state_key: "source".to_owned(),
        target_state_key: "target".to_owned(),
        obligation_keys: Vec::new(),
        profile_hash: profile_hash.to_owned(),
        rule_id: "lifecycle-test".to_owned(),
        workflow: Vec::new(),
        outputs: Vec::new(),
        reviews: Vec::new(),
        blockers: Vec::new(),
        lease: None,
        change_control: Default::default(),
        extensions: BTreeMap::new(),
    }
}

fn approved_planning_context(root: &Path, run_id: &str) -> Value {
    let snapshot = Engine::open_run(root, run_id)
        .expect("open approved run")
        .cockpit_snapshot()
        .expect("approved cockpit snapshot");
    snapshot["graph"]
        .as_array()
        .expect("graph rows")
        .iter()
        .find(|node| node["annotations"]["run_root"] == true)
        .and_then(|node| node["spec"].get("planning_context"))
        .cloned()
        .expect("approved root carries planning context")
}

fn assert_planning_context_hash(context: &Value) {
    let mut content = context.clone();
    let context_hash = content
        .get("context_hash")
        .and_then(Value::as_str)
        .expect("planning context hash")
        .to_owned();
    content
        .as_object_mut()
        .expect("planning context object")
        .remove("context_hash");
    assert_eq!(
        context_hash,
        koni_core::graph::normalized_hash(&content),
        "planning context hash binds only the portable semantic handoff"
    );
}

#[derive(Clone)]
struct FakeAgentStep {
    result: AgentProcessResult,
    session_id: String,
    output: Option<String>,
}

#[derive(Default)]
struct FakeAgentLauncher {
    steps: RefCell<VecDeque<FakeAgentStep>>,
    requests: RefCell<Vec<AgentProcessRequest>>,
}

impl FakeAgentLauncher {
    fn new(steps: impl IntoIterator<Item = FakeAgentStep>) -> Self {
        Self {
            steps: RefCell::new(steps.into_iter().collect()),
            requests: RefCell::new(Vec::new()),
        }
    }
}

fn assert_read_only_scratch_launch(request: &AgentProcessRequest) -> PathBuf {
    assert!(!request.args.iter().any(|argument| argument == "--sandbox"));
    assert!(!request.args.iter().any(|argument| argument == "--add-dir"));
    assert_eq!(request.environment_set.len(), 1);
    let (name, scratch) = &request.environment_set[0];
    assert_eq!(name, "TMPDIR");
    let scratch = PathBuf::from(scratch);
    assert!(!scratch.starts_with(&request.working_directory));
    assert!(
        request
            .environment_remove
            .iter()
            .any(|name| name == "KONI_LEAD_SLICE_TOKEN")
    );
    assert!(
        request
            .environment_remove
            .iter()
            .any(|name| name == "KONI_LEAD_SLICE_GENERATION")
    );

    let configs = request
        .args
        .windows(2)
        .filter(|pair| pair[0] == "--config")
        .map(|pair| pair[1].as_str())
        .collect::<Vec<_>>();
    let selected = configs
        .iter()
        .find_map(|assignment| assignment.strip_prefix("default_permissions="))
        .expect("read-only launch selects its ephemeral permission profile");
    let selected: toml::Value = toml::from_str(&format!("value = {selected}"))
        .expect("selected permission profile is valid TOML");
    let selected = selected["value"].as_str().unwrap();
    let filesystem = configs
        .iter()
        .find_map(|assignment| {
            assignment.strip_prefix(&format!("permissions.{selected}.filesystem="))
        })
        .expect("read-only launch declares its exact filesystem profile");
    let filesystem: toml::Value =
        toml::from_str(&format!("value = {filesystem}")).expect("filesystem profile is valid TOML");
    let filesystem = filesystem["value"].as_table().unwrap();
    assert_eq!(filesystem.len(), 2);
    assert_eq!(filesystem[":root"].as_str(), Some("read"));
    assert_eq!(
        filesystem[scratch.display().to_string().as_str()].as_str(),
        Some("write")
    );
    assert!(configs.iter().any(|assignment| {
        *assignment == format!("permissions.{selected}.network.enabled=false")
    }));
    scratch
}

impl AgentProcessLauncher for FakeAgentLauncher {
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
            assert!(Path::new(scratch).is_dir(), "scratch exists during launch");
        }
        self.requests.borrow_mut().push(request.clone());
        let step = self.steps.borrow_mut().pop_front().ok_or_else(|| {
            KoniError::Process("fake planning agent has no queued result".to_owned())
        })?;
        on_started(step.result.pid)?;
        let events = format!(
            "{{\"type\":\"thread.started\",\"thread_id\":\"{}\"}}\n{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"bounded plan\"}}}}\n{{\"type\":\"turn.completed\"}}\n",
            step.session_id
        );
        fs::write(&request.stdout_path, events).expect("write fake Codex JSONL");
        fs::write(&request.stderr_path, "").expect("write fake Codex stderr");
        if let Some(output) = step.output {
            let output_path = request
                .args
                .windows(2)
                .find(|pair| pair[0] == "--output-last-message")
                .map(|pair| PathBuf::from(&pair[1]))
                .expect("planning argv contains output path");
            let structured_planning = request.args.iter().any(|arg| arg == "--output-schema");
            let output = if !structured_planning {
                output
            } else if let Some(raw) = output.strip_prefix("RAW:") {
                raw.to_owned()
            } else if serde_json::from_str::<serde_json::Value>(&output)
                .ok()
                .and_then(|value| value.get("kind").cloned())
                .is_some()
            {
                output
            } else {
                serde_json::to_string(&serde_json::json!({
                    "kind": "plan",
                    "plan": output,
                }))
                .expect("serialize fake planning envelope")
            };
            fs::write(output_path, output).expect("write fake final planning message");
        }
        Ok(step.result)
    }
}

struct BlockingAgentLauncher {
    started: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    output: Option<String>,
}

impl AgentProcessLauncher for BlockingAgentLauncher {
    fn is_alive(&self, _pid: u32) -> bool {
        false
    }

    fn run(
        &self,
        request: &AgentProcessRequest,
        on_started: &mut dyn FnMut(u32) -> koni_core::Result<()>,
    ) -> koni_core::Result<AgentProcessResult> {
        on_started(55001)?;
        self.started
            .send(())
            .map_err(|error| KoniError::Process(error.to_string()))?;
        self.release
            .lock()
            .expect("release lock")
            .recv()
            .map_err(|error| KoniError::Process(error.to_string()))?;
        if let Some(output) = &self.output
            && let Some(path) = request
                .args
                .windows(2)
                .find(|pair| pair[0] == "--output-last-message")
                .map(|pair| PathBuf::from(&pair[1]))
        {
            fs::write(path, output).map_err(|error| KoniError::Process(error.to_string()))?;
        }
        Ok(AgentProcessResult {
            pid: 55001,
            exit_code: Some(0),
            timed_out: false,
        })
    }
}

fn planning_question_output(prompt: &str, impact: &str) -> String {
    serde_json::to_string(&serde_json::json!({
        "kind": "question",
        "prompt": prompt,
        "context": "The answer changes the implementation-ready plan.",
        "impact": impact,
        "options": [
            {
                "label": "Use the recommended boundary",
                "description": "Keep the implementation bounded to the proposed architecture.",
                "recommended": true
            },
            {
                "label": "Expand the boundary",
                "description": "Broaden the architecture and verification scope.",
                "recommended": false
            }
        ]
    }))
    .expect("serialize planning question envelope")
}

fn planning_questions_output(questions: &[(&str, &str)]) -> String {
    let questions = questions
        .iter()
        .map(|(prompt, impact)| {
            serde_json::json!({
                "prompt": prompt,
                "context": "The answer changes the implementation-ready plan.",
                "impact": impact,
                "options": [
                    {
                        "label": format!("Recommended for {prompt}"),
                        "description": "Keep the implementation within the recommended boundary.",
                        "recommended": true
                    },
                    {
                        "label": format!("Alternative for {prompt}"),
                        "description": "Use the alternative planning boundary.",
                        "recommended": false
                    }
                ]
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&serde_json::json!({
        "kind": "questions",
        "plan": null,
        "prompt": null,
        "context": null,
        "impact": null,
        "options": null,
        "questions": questions
    }))
    .expect("serialize planning question batch envelope")
}

#[test]
fn planned_run_pins_run_type_policy_and_initializes_orchestration_from_it() {
    let policy_run_type = format!(
        "{RUN_TYPE}\nagents:\n  roles:\n    planner:\n      model: policy-model\n      reasoning_effort: high\norchestration:\n  auto_start: false\n  max_parallel: 2\n"
    );
    let (_temp, root, _base) = canonical_fixture_with_run_type(&policy_run_type);

    let planned = Engine::plan_run(&root, Some("canonical"), "Pinned run policy", "HEAD", None)
        .expect("plan policy run");
    let control = RunControlStore::new(
        GitBackend::discover(&root)
            .expect("discover policy fixture")
            .sidecar_path(format!("runs/{}", planned.run_id))
            .expect("run sidecar path"),
    );
    let orchestration = control
        .orchestration()
        .expect("load orchestration")
        .expect("planned run orchestration");
    assert!(!orchestration.running);
    assert_eq!(orchestration.max_parallel, 2);

    let engine = Engine::open_run(&root, &planned.run_id).expect("open pinned run");
    let run_type = engine
        .resolved_run_type()
        .expect("pinned run type remains available");
    assert_eq!(run_type.id, "canonical");
    assert_eq!(run_type.hash, planned.run_type_hash);
    assert_eq!(
        run_type
            .agents
            .as_ref()
            .and_then(|agents| agents.roles.get("planner"))
            .and_then(|settings| settings.model.as_deref()),
        Some("policy-model")
    );
    assert_eq!(
        run_type
            .orchestration
            .as_ref()
            .and_then(|policy| policy.max_parallel),
        Some(2)
    );
}

#[test]
fn supervisor_completes_terminal_orchestration_without_spawning_a_lead() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(AUTOMATIC_ORCHESTRATION_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Compile a terminal empty board",
        "HEAD",
        None,
    )
    .expect("plan automatic run");
    let approved = Engine::approve_run(&root, &planned.run_id).expect("approve automatic run");

    let backend = GitBackend::discover(&root).expect("discover project");
    let control = RunControlStore::new(
        backend
            .sidecar_path(format!("runs/{}", planned.run_id))
            .expect("run root"),
    );
    let now = Utc::now();
    let question = QuestionRecord::new(
        "supervisor-question",
        "Continue automatic orchestration?",
        "A high-impact decision needs an operator.",
        vec![
            QuestionOption {
                id: "continue".to_owned(),
                label: "Continue".to_owned(),
                description: "Resume automatic orchestration.".to_owned(),
                recommended: true,
            },
            QuestionOption {
                id: "stop".to_owned(),
                label: "Stop".to_owned(),
                description: "Keep the run paused.".to_owned(),
                recommended: false,
            },
        ],
        false,
        QuestionPauseScope::Run {
            run_id: planned.run_id.clone(),
        },
        QuestionPolicy::Interactive,
        QuestionImpact::High,
        None,
        QuestionSessionResume {
            session_id: "supervisor-session".to_owned(),
            agent_id: None,
            turn_id: None,
            working_directory: None,
            context_hash: koni_core::graph::normalized_hash(&"supervisor-context"),
            captured_at: now,
        },
        now,
    )
    .expect("construct run question");
    let policy_error = Engine::record_question(&root, &planned.run_id, &question)
        .expect_err("autonomous run must reject an interactive question")
        .to_string();
    assert!(policy_error.contains("pins autonomous"), "{policy_error}");
    let mut routine_question = question.clone();
    routine_question.id = "routine-question".to_owned();
    routine_question.policy = QuestionPolicy::HighImpactOnly;
    routine_question.impact = QuestionImpact::Routine;
    routine_question.auto_resolution = Some(QuestionAutoResolution {
        option_id: "continue".to_owned(),
        resolve_at: now + chrono::Duration::minutes(5),
    });
    Engine::update_orchestration(&root, &planned.run_id, Some(false), None, None)
        .expect("pause before routine question test");
    control
        .write_question(&routine_question)
        .expect("persist routine question");
    let routine_tick = Engine::supervise_run_once(&root, &planned.run_id)
        .expect("routine question does not pause the supervisor");
    assert!(matches!(
        routine_tick.outcome,
        RunSupervisionState::AwaitingOperator { ref reason, .. }
            if reason == "automatic orchestration is paused"
    ));
    Engine::update_orchestration(&root, &planned.run_id, Some(true), None, None)
        .expect("resume after routine question test");

    control
        .write_question(&question)
        .expect("persist run question");
    let awaiting_answer = Engine::supervise_run_once(&root, &planned.run_id)
        .expect("open question is a normal supervisor boundary");
    assert!(matches!(
        awaiting_answer.outcome,
        RunSupervisionState::AwaitingOperator { ref stage_id, ref reason }
            if stage_id == "orchestrate" && reason.contains("supervisor-question")
    ));
    control
        .delete_question("supervisor-question")
        .expect("remove test question");

    Engine::update_orchestration(&root, &planned.run_id, Some(false), None, None)
        .expect("pause orchestration");
    let paused = Engine::supervise_run_once(&root, &planned.run_id)
        .expect("paused supervisor is a normal boundary");
    assert!(matches!(
        paused.outcome,
        RunSupervisionState::AwaitingOperator { ref stage_id, .. } if stage_id == "orchestrate"
    ));
    assert!(paused.advanced_stages.is_empty());
    Engine::update_orchestration(&root, &planned.run_id, Some(true), None, None)
        .expect("resume orchestration");

    // Simulate a supervisor crash after the uncorrelated compile action
    // journal committed but before the orchestration agent record advanced.
    let mut crash_engine = Engine::open_run(&root, &planned.run_id).expect("open crash-window run");
    let crash_run_type = crash_engine
        .resolved_run_type()
        .expect("crash-window run type");
    let mut crash_pipeline = control.pipeline().unwrap().unwrap();
    let crash_stage = crash_pipeline.current().unwrap().clone();
    let crash_input_hash = koni_core::graph::normalized_hash(&serde_json::json!({
        "run_id": planned.run_id,
        "stage_definition_hash": crash_stage.definition_hash,
        "run_type_hash": crash_run_type.hash,
        "policy": crash_run_type.orchestration.as_ref().unwrap(),
    }));
    crash_pipeline
        .start_current(crash_input_hash, Utc::now())
        .expect("start orchestration crash window");
    control
        .write_pipeline(&crash_pipeline)
        .expect("persist orchestration start");
    crash_engine
        .execute_action("compile", BTreeMap::new())
        .expect("commit compile journal before supervisor restart");

    let waiting_for_resolution = Engine::supervise_run_once(&root, &planned.run_id)
        .expect("supervise compiler-terminal run");

    assert_eq!(
        waiting_for_resolution.advanced_stages,
        ["orchestrate", "report"]
    );
    assert!(matches!(
        waiting_for_resolution.outcome,
        RunSupervisionState::Waiting { ref reason, .. }
            if reason.contains("scheduled for automatic resolution")
    ));
    assert_eq!(
        Engine::project_registry(&root)
            .expect("waiting registry")
            .runs[&planned.run_id]
            .status,
        RunRegistrationStatus::Active
    );
    control
        .delete_question("routine-question")
        .expect("resolve test's future automatic question");
    let tick = Engine::supervise_run_once(&root, &planned.run_id)
        .expect("conclude after automatic question becomes terminal");
    assert!(tick.advanced_stages.is_empty());
    assert_eq!(tick.outcome, RunSupervisionState::Complete);
    let pipeline = control.pipeline().unwrap().unwrap();
    assert_eq!(pipeline.status, RunPipelineStatus::Complete);
    let agents = control.agents().expect("orchestration records");
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].status, "completed");
    assert!(agents[0].process_identity.is_none());
    assert_eq!(
        Engine::project_registry(&root)
            .expect("completed registry")
            .runs[&planned.run_id]
            .status,
        RunRegistrationStatus::Concluded
    );
    let mut engine = Engine::open_run(&root, &planned.run_id).expect("open completed run");
    assert_eq!(
        engine.inspect().expect("concluded board").run_status,
        "concluded"
    );
    assert!(
        engine.execute_action("compile", BTreeMap::new()).is_err(),
        "concluded runs must reject further lifecycle actions"
    );
    assert!(engine.execute_action("report", BTreeMap::new()).is_err());
    assert!(
        engine
            .execute_action("spawn-lead", BTreeMap::new())
            .is_err()
    );
    assert_eq!(
        Engine::supervise_run_once(&root, &planned.run_id)
            .expect("concluded supervision is idempotent")
            .outcome,
        RunSupervisionState::Complete
    );
    let semantic_store = StateStore::with_storage(
        approved.worktree.join("program"),
        &engine.profile().manifest.storage,
    )
    .expect("open semantic store");
    assert!(
        semantic_store
            .journals()
            .expect("action journals")
            .iter()
            .any(|journal| journal.action == "custom-report"),
        "the pinned report_action must override the generic report placeholder"
    );
    assert_eq!(
        semantic_store
            .journals()
            .expect("compile journals")
            .iter()
            .filter(|journal| journal.action == "compile")
            .count(),
        1,
        "supervisor restart must adopt the completed compile journal"
    );
}

#[test]
fn supervisor_audits_git_common_dir_conclusion_before_registry_transition() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(AUTOMATIC_ORCHESTRATION_RUN_TYPE);
    write(
        &root,
        ".codex/koni/profile.yaml",
        &PROFILE.replace("backend: tracked", "backend: git_common_dir"),
    );
    let repository = Repository::open(&root).expect("open product repository");
    let mut index = repository.index().expect("open product index");
    index
        .add_all(["*"], IndexAddOption::DEFAULT, None)
        .expect("stage git-common profile");
    let tree_id = index.write_tree().expect("write profile tree");
    index.write().expect("write product index");
    let tree = repository.find_tree(tree_id).expect("find profile tree");
    let parent = repository
        .head()
        .expect("product HEAD")
        .peel_to_commit()
        .expect("product parent");
    let signature = Signature::now("Koni Test", "koni-test@example.local").expect("test signature");
    repository
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            "use git-common run state",
            &tree,
            &[&parent],
        )
        .expect("commit git-common profile");
    drop(parent);
    drop(tree);
    drop(repository);

    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Conclude durable git-common state",
        "HEAD",
        None,
    )
    .expect("plan git-common run");
    Engine::approve_run(&root, &planned.run_id).expect("approve git-common run");
    let tick =
        Engine::supervise_run_once(&root, &planned.run_id).expect("supervise git-common run");
    assert_eq!(tick.outcome, RunSupervisionState::Complete);
    assert_eq!(
        Engine::project_registry(&root)
            .expect("git-common registry")
            .runs[&planned.run_id]
            .status,
        RunRegistrationStatus::Concluded
    );

    let backend = GitBackend::discover(&root).expect("discover product repository");
    let run_root = backend
        .sidecar_path(format!("runs/{}", planned.run_id))
        .expect("git-common run root");
    let state_repository = Repository::open(&run_root).expect("open state audit repository");
    let state_statuses = state_repository
        .statuses(None)
        .expect("state repository status");
    let dirty_state_paths = state_statuses
        .iter()
        .map(|entry| {
            (
                entry.path().unwrap_or("<non-utf8>").to_owned(),
                entry.status(),
            )
        })
        .collect::<Vec<_>>();
    assert!(
        state_statuses.is_empty(),
        "conclusion must leave the git-common state repository clean: {dirty_state_paths:?}"
    );
    drop(state_statuses);
    assert!(
        state_repository
            .head()
            .expect("state HEAD")
            .peel_to_commit()
            .expect("state conclusion commit")
            .message()
            .unwrap_or_default()
            .contains("conclude run")
    );

    // Simulate a crash after semantic conclusion/audit but before the final
    // registry transition. Replay must finish the tail without creating an
    // identical extra state commit.
    let state_head_before_replay = state_repository
        .head()
        .expect("state HEAD before replay")
        .target()
        .expect("state replay parent");
    drop(state_repository);
    let registry = ProjectRegistryStore::new(backend.sidecar_root(), root.clone())
        .expect("open registry store");
    let mut partial = registry
        .run(&planned.run_id)
        .expect("concluded registration");
    partial.status = RunRegistrationStatus::Active;
    partial.updated_at = Utc::now();
    registry
        .update_run(partial)
        .expect("simulate pre-registry conclusion crash");

    let replay =
        Engine::supervise_run_once(&root, &planned.run_id).expect("replay partial conclusion");
    assert_eq!(replay.outcome, RunSupervisionState::Complete);
    assert_eq!(
        registry
            .run(&planned.run_id)
            .expect("replayed registry")
            .status,
        RunRegistrationStatus::Concluded
    );
    let replayed_state_repository =
        Repository::open(&run_root).expect("reopen replayed state audit repository");
    assert_eq!(
        replayed_state_repository
            .head()
            .expect("state HEAD after replay")
            .target()
            .expect("state replay head"),
        state_head_before_replay,
        "conclusion replay must not commit an identical Git-common tree"
    );
}

#[test]
fn supervisor_runs_independent_review_read_only_with_reviewer_role_policy() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(REVIEW_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Review a completed run",
        "HEAD",
        None,
    )
    .expect("plan reviewed run");
    let approved = Engine::approve_run(&root, &planned.run_id).expect("approve reviewed run");
    let launcher = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 44001,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "unused-review-session".to_owned(),
        output: Some(
            "All compiler evidence is coherent; the run is complete.\n\nKONI_REVIEW_VERDICT: approved"
                .to_owned(),
        ),
    }]);

    let tick = Engine::supervise_run_once_with(&root, &planned.run_id, &launcher)
        .expect("supervise independent review");

    assert_eq!(tick.advanced_stages, ["review", "report"]);
    assert_eq!(tick.outcome, RunSupervisionState::Complete);
    let requests = launcher.requests.borrow();
    assert_eq!(requests.len(), 1);
    let scratch = assert_read_only_scratch_launch(&requests[0]);
    assert!(
        !scratch.exists(),
        "completed reviewer scratch is not retained"
    );
    assert!(
        requests[0]
            .args
            .windows(2)
            .any(|pair| pair == ["--model", "review-model"])
    );
    assert!(
        requests[0]
            .args
            .iter()
            .any(|argument| argument == "model_reasoning_effort=\"xhigh\"")
    );
    drop(requests);

    let backend = GitBackend::discover(&root).expect("discover project");
    let control = RunControlStore::new(
        backend
            .sidecar_path(format!("runs/{}", planned.run_id))
            .expect("run root"),
    );
    let record = control.agent("review-review").unwrap().unwrap();
    assert_eq!(record.status, "succeeded");
    assert_eq!(record.model.as_deref(), Some("review-model"));
    assert_eq!(record.reasoning_effort.as_deref(), Some("xhigh"));
    assert!(
        record
            .result
            .as_ref()
            .and_then(|result| result.get("review"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|review| !review.trim().is_empty())
    );

    let report_root = approved.worktree.join("program/reports");
    let markdown = fs::read_to_string(report_root.join("final-summary.md"))
        .expect("read final Markdown report");
    assert!(markdown.starts_with("# Final Summary\n\n"), "{markdown}");
    assert!(!markdown.contains("Independent Review"), "{markdown}");
    assert!(!markdown.contains("Verdict:"), "{markdown}");
    assert!(!markdown.contains("completed_at"), "{markdown}");
    assert!(!markdown.contains("review-review"), "{markdown}");
    assert!(!markdown.contains("KONI_REVIEW_VERDICT"), "{markdown}");

    let report_json: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(report_root.join("final-summary.json"))
            .expect("read final JSON report"),
    )
    .expect("parse final JSON report");
    assert!(report_json.get("independent_reviews").is_none());
    assert_eq!(report_json["kind"], "final-summary");
    assert_eq!(
        report_json["row_count"],
        report_json["rows"].as_array().unwrap().len()
    );
    assert_eq!(
        report_json["ledger_hash"],
        koni_core::graph::normalized_hash(report_json["rows"].as_array().unwrap())
    );
    assert!(report_json.to_string().find("review-review").is_none());
    assert!(report_json.to_string().find("completed_at").is_none());

    let report_manifest: serde_yaml::Value = serde_yaml::from_str(
        &fs::read_to_string(report_root.join("report-manifest.yaml"))
            .expect("read report manifest"),
    )
    .expect("parse report manifest");
    assert!(report_manifest.get("independent_reviews").is_none());
    assert_eq!(report_manifest["kind"], "report-bundle");
    assert_eq!(
        report_manifest["outputs"].as_sequence().unwrap(),
        &vec![
            serde_yaml::Value::String("program/reports/final-summary.json".to_owned()),
            serde_yaml::Value::String("program/reports/final-summary.md".to_owned()),
        ]
    );
    for key in [
        "source_graph_hash",
        "source_ticket_board_hash",
        "source_program_state_hash",
        "ledger_hashes",
        "ledger_counts",
        "bundle_hash",
    ] {
        assert!(report_manifest.get(key).is_some(), "manifest omitted {key}");
    }
}

#[test]
fn supervisor_review_releases_run_authority_while_agent_is_active() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(REVIEW_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Pause scheduling while independent review drains",
        "HEAD",
        None,
    )
    .expect("plan reviewed run");
    Engine::approve_run(&root, &planned.run_id).expect("approve reviewed run");
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let launcher = Arc::new(BlockingAgentLauncher {
        started: started_tx,
        release: Mutex::new(release_rx),
        output: Some("The run is complete.\n\nKONI_REVIEW_VERDICT: approved".to_owned()),
    });
    let thread_root = root.clone();
    let thread_run_id = planned.run_id.clone();
    let thread_launcher = launcher.clone();
    let supervision = std::thread::spawn(move || {
        Engine::supervise_run_once_with(&thread_root, &thread_run_id, thread_launcher.as_ref())
    });

    started_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("review crossed durable start boundary");
    let paused = Engine::set_run_running(&root, &planned.run_id, false)
        .expect("pause scheduling while reviewer is active");
    assert!(!paused.running);
    assert!(paused.draining);
    release_tx.send(()).expect("release reviewer");
    let tick = supervision
        .join()
        .expect("join supervisor")
        .expect("review drains to a durable boundary");
    assert!(matches!(
        tick.outcome,
        RunSupervisionState::AwaitingOperator { ref reason, .. }
            if reason == "automatic orchestration is paused"
    ));

    let control = RunControlStore::new(
        GitBackend::discover(&root)
            .expect("discover project")
            .sidecar_path(format!("runs/{}", planned.run_id))
            .expect("run root"),
    );
    assert_eq!(
        control
            .agent("review-review")
            .expect("review agent")
            .expect("review record")
            .status,
        "succeeded"
    );
    let pipeline = control
        .pipeline()
        .expect("pipeline")
        .expect("pipeline state");
    assert_eq!(pipeline.stages[0].status, PipelineStageStatus::Succeeded);
    assert_ne!(pipeline.status, RunPipelineStatus::Complete);
}

#[test]
fn supervisor_blocks_on_changes_requested_by_independent_review() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(REVIEW_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Review a run with unresolved findings",
        "HEAD",
        None,
    )
    .expect("plan reviewed run");
    let approved = Engine::approve_run(&root, &planned.run_id).expect("approve reviewed run");
    let launcher = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 44002,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "unused-negative-review-session".to_owned(),
        output: Some(
            "A required verification receipt is missing.\n\nKONI_REVIEW_VERDICT: changes_requested"
                .to_owned(),
        ),
    }]);

    let tick = Engine::supervise_run_once_with(&root, &planned.run_id, &launcher)
        .expect("negative review is a durable supervisor outcome");

    assert!(matches!(
        tick.outcome,
        RunSupervisionState::Blocked { ref stage_id, ref reason }
            if stage_id == "review" && reason.contains("changes_requested")
    ));
    assert_eq!(
        Engine::project_registry(&root)
            .expect("blocked registry")
            .runs[&planned.run_id]
            .status,
        RunRegistrationStatus::Active
    );
    let backend = GitBackend::discover(&root).expect("discover project");
    let control = RunControlStore::new(
        backend
            .sidecar_path(format!("runs/{}", planned.run_id))
            .expect("run root"),
    );
    assert_eq!(
        control.agent("review-review").unwrap().unwrap().status,
        "changes_requested"
    );
    let mut engine = Engine::open_run(&root, &planned.run_id).expect("open blocked review run");
    let semantic_store = StateStore::with_storage(
        approved.worktree.join("program"),
        &engine.profile().manifest.storage,
    )
    .expect("open blocked semantic store");
    semantic_store
        .write_journal(&Journal {
            id: "incomplete-before-retry".to_owned(),
            action: "compile".to_owned(),
            input_hash: None,
            status: JournalStatus::Failed,
            started_at: Utc::now(),
            profile_hash: engine.profile().hash.clone(),
            completed_steps: Vec::new(),
            outputs: BTreeMap::new(),
            error: Some("simulated recoverable compiler failure".to_owned()),
        })
        .expect("persist incomplete recovery boundary");
    let retry_error = Engine::retry_supervised_stage(&root, &planned.run_id, "review")
        .expect_err("retry must fail closed before recovery")
        .to_string();
    assert!(retry_error.contains("requires recovery"), "{retry_error}");
    engine
        .execute_action("recover", BTreeMap::new())
        .expect("acknowledge failed journal through configured recovery");
    Engine::retry_supervised_stage(&root, &planned.run_id, "review")
        .expect("retry after durable recovery acknowledgement");
    assert_eq!(
        control
            .pipeline()
            .unwrap()
            .unwrap()
            .current()
            .unwrap()
            .status,
        PipelineStageStatus::Running
    );
    assert_eq!(
        semantic_store
            .journals()
            .unwrap()
            .into_iter()
            .find(|journal| journal.id == "incomplete-before-retry")
            .unwrap()
            .status,
        JournalStatus::Recovered
    );
}

#[test]
fn canonical_yaml_runs_plan_open_approve_and_remain_disjoint() {
    let (_temp, root, base) = canonical_fixture();
    let goal = "Canonical lifecycle";
    let repository = GitBackend::discover(&root).expect("discover main checkout");
    let initial_references = local_references(&root);
    assert_eq!(
        initial_references,
        BTreeSet::from(["refs/heads/main".to_owned()])
    );

    let first =
        Engine::plan_run(&root, Some("canonical"), goal, "HEAD", None).expect("plan first run");
    assert_eq!(first.base_commit, base.to_string());
    assert_eq!(first.question_policy, "autonomous");
    assert_eq!(local_references(&root), initial_references);
    let first_planning =
        Repository::open(&first.planning_worktree).expect("open planning worktree");
    assert!(
        first_planning
            .head_detached()
            .expect("detached planning HEAD")
    );
    assert_eq!(
        first_planning
            .head()
            .expect("planning HEAD")
            .peel_to_commit()
            .expect("planning commit")
            .id(),
        base
    );

    let registry = Engine::project_registry(&root).expect("load planning registry");
    let first_registration = &registry.runs[&first.run_id];
    assert_eq!(first_registration.status, RunRegistrationStatus::Planning);
    assert!(first_registration.planning_read_only);
    let planning_snapshot = Engine::open_run(&root, &first.run_id)
        .expect("open planning run")
        .cockpit_snapshot()
        .expect("project planning snapshot");
    assert_eq!(planning_snapshot["run"]["status"], "planning");
    assert_eq!(planning_snapshot["tickets"], serde_json::json!([]));
    assert_eq!(planning_snapshot["graph"], serde_json::json!([]));
    assert_eq!(
        planning_snapshot["validation_errors"],
        serde_json::json!([])
    );
    let first_run_root = repository
        .sidecar_path(format!("runs/{}", first.run_id))
        .expect("first run root");
    assert!(
        first_run_root
            .join("config-snapshot/.codex/koni/project.yaml")
            .is_file()
    );
    assert!(
        first_run_root
            .join("config-snapshot/.codex/koni/profile.yaml")
            .is_file()
    );

    // Opening a planning run must compile its immutable copy, not live files.
    write(
        &root,
        ".codex/koni/profile.yaml",
        "this: is: deliberately invalid YAML\n",
    );
    let snapshot_engine = Engine::open_run(&root, &first.run_id).expect("open pinned snapshot");
    assert_eq!(
        snapshot_engine.profile().manifest.profile.id,
        "canonical-yaml"
    );
    write(&root, ".codex/koni/profile.yaml", PROFILE);

    let approved_first = Engine::approve_run(&root, &first.run_id).expect("approve first run");
    assert_eq!(
        approved_first.branch,
        expected_branch("canonical-lifecycle", &first.run_id)
    );
    assert!(!first.planning_worktree.exists());
    assert_eq!(approved_first.board.run_id, first.run_id);
    assert_eq!(approved_first.board.run_status, "active");
    assert_eq!(approved_first.board.node_count, 1);
    assert_eq!(approved_first.board.ticket_count, 0);
    let first_head =
        assert_clean_tracked_initialization(&approved_first.worktree, &approved_first.branch, base);
    assert_eq!(repository.head_oid().expect("main HEAD"), base);
    assert!(!repository.is_dirty(&[]).expect("main checkout status"));
    let reopened_first = Engine::open_run(&root, &first.run_id).expect("reopen first run");
    assert_eq!(reopened_first.inspect().expect("first board").node_count, 1);

    let references_before_second_plan = local_references(&root);
    let second = Engine::plan_run(&root, Some("canonical"), goal, "HEAD", None)
        .expect("plan second same-goal run");
    assert_ne!(first.run_id, second.run_id);
    assert_ne!(first.planning_worktree, second.planning_worktree);
    assert_eq!(local_references(&root), references_before_second_plan);
    Engine::open_run(&root, &second.run_id).expect("open second pinned snapshot");

    let approved_second =
        Engine::approve_run(&root, &second.run_id).expect("approve second same-goal run");
    assert_eq!(
        approved_second.branch,
        expected_branch("canonical-lifecycle", &second.run_id)
    );
    assert_ne!(approved_first.branch, approved_second.branch);
    assert_ne!(approved_first.worktree, approved_second.worktree);
    assert!(!second.planning_worktree.exists());
    let _second_head = assert_clean_tracked_initialization(
        &approved_second.worktree,
        &approved_second.branch,
        base,
    );
    assert_eq!(
        GitBackend::discover(&approved_first.worktree)
            .expect("rediscover first integration")
            .head_oid()
            .expect("first integration HEAD"),
        first_head,
        "approving a concurrent run must not advance the first run"
    );

    let registry = Engine::project_registry(&root).expect("load final registry");
    assert_eq!(registry.runs.len(), 2);
    assert!(
        registry
            .runs
            .values()
            .all(|run| run.status == RunRegistrationStatus::Active)
    );
    assert_eq!(
        Engine::open_run(&root, &first.run_id)
            .expect("open first active run")
            .inspect()
            .expect("inspect first active run")
            .run_id,
        first.run_id
    );
    assert_eq!(
        Engine::open_run(&root, &second.run_id)
            .expect("open second active run")
            .inspect()
            .expect("inspect second active run")
            .run_id,
        second.run_id
    );
}

#[test]
fn planning_agent_records_output_before_explicit_approval() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
    let references = local_references(&root);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Plan a bounded change",
        "HEAD",
        Some("interactive"),
    )
    .expect("initialize planning run");
    assert_eq!(planned.question_policy, "interactive");
    assert!(Engine::approve_run(&root, &planned.run_id).is_err());
    assert_eq!(local_references(&root), references);

    let launcher = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41001,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "planner-session-1".to_owned(),
        output: Some("Inspect contracts, implement narrowly, and run focused tests.".to_owned()),
    }]);
    let outcome = Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Plan a bounded change", "risk": "compatibility"}),
        &launcher,
    )
    .expect("run fake planning agent")
    .expect("planning stage dispatched");
    assert_eq!(outcome.status, "succeeded");
    assert_eq!(outcome.process_attempt, 1);
    assert!(!outcome.resumed_session);
    assert_eq!(
        outcome.codex_session_id.as_deref(),
        Some("planner-session-1")
    );
    assert!(outcome.planning_output.is_some());

    let requests = launcher.requests.borrow();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.working_directory, planned.planning_worktree);
    let scratch = assert_read_only_scratch_launch(request);
    assert!(
        !scratch.exists(),
        "completed planning scratch is not retained"
    );
    assert!(
        request
            .args
            .windows(2)
            .any(|pair| pair == ["--model", "stage-model"])
    );
    assert!(
        request
            .args
            .iter()
            .any(|arg| arg == "model_reasoning_effort=\"high\"")
    );
    let prompt = request.args.last().expect("planning prompt argument");
    assert!(
        prompt.contains("Effective question policy: interactive"),
        "{prompt}"
    );
    assert!(prompt.contains("Run: the current pinned run"), "{prompt}");
    assert!(
        !prompt.contains(&planned.run_id),
        "the model-facing assignment must not expose the compiler-owned run ID: {prompt}"
    );
    assert!(
        prompt.contains("Do not repeat, quote, or embed compiler-owned run, session"),
        "{prompt}"
    );
    assert!(prompt.contains("do not include absolute paths"), "{prompt}");
    let instruction = prompt
        .find("Ask focused questions before finalizing the implementation plan.")
        .expect("run-type planning instructions");
    let safety = prompt
        .find("The checkout is detached and policy-read-only.")
        .expect("compiler-owned safety constraints");
    assert!(
        instruction < safety,
        "compiler safety must follow custom text"
    );
    drop(requests);

    let backend = GitBackend::discover(&root).expect("discover project");
    let run_root = backend
        .sidecar_path(format!("runs/{}", planned.run_id))
        .expect("run root");
    let control = RunControlStore::new(run_root);
    let agents = control.agents().expect("agent records");
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].status, "succeeded");
    assert_eq!(agents[0].model.as_deref(), Some("stage-model"));
    assert_eq!(agents[0].reasoning_effort.as_deref(), Some("high"));
    assert!(agents[0].prompt_path.is_some());
    assert!(agents[0].stdout_path.is_some());
    let pipeline = control
        .pipeline()
        .expect("pipeline read")
        .expect("pipeline");
    assert_eq!(pipeline.stages[0].status, PipelineStageStatus::Succeeded);
    assert_eq!(pipeline.stages[1].status, PipelineStageStatus::Pending);
    assert_eq!(pipeline.status, RunPipelineStatus::Running);
    let transcript = control.planning_transcript().expect("planning transcript");
    assert!(
        transcript
            .iter()
            .any(|event| event["type"] == "planning.output")
    );
    assert!(
        transcript
            .iter()
            .any(|event| event["type"] == "planning.agent.completed")
    );
    assert_eq!(
        Engine::project_registry(&root).expect("registry").runs[&planned.run_id].status,
        RunRegistrationStatus::Planning,
        "planning output must not auto-approve the run"
    );
    assert!(planned.planning_worktree.exists());
    assert_eq!(local_references(&root), references);

    let approved = Engine::approve_run(&root, &planned.run_id).expect("explicit approval");
    assert_eq!(approved.board.run_status, "active");
    assert!(!planned.planning_worktree.exists());

    let planning_context = approved_planning_context(&root, &planned.run_id);
    assert_eq!(planning_context["schema_version"], "1.0");
    assert_eq!(planning_context["stages"][0]["stage_id"], "planning");
    assert_eq!(
        planning_context["stages"][0]["title"],
        "Produce the implementation plan"
    );
    assert_eq!(
        planning_context["stages"][0]["output"],
        "Inspect contracts, implement narrowly, and run focused tests."
    );
    assert_eq!(planning_context["stages"][0]["truncated"], false);
    assert_eq!(planning_context["decisions"], serde_json::json!([]));
    assert_planning_context_hash(&planning_context);
    let portable_context = serde_json::to_string(&planning_context).unwrap();
    for forbidden in [
        "planner-session-1",
        "session_id",
        "planning_worktree",
        "process_attempt",
        "transcript",
        "stdout",
        "stderr",
    ] {
        assert!(!portable_context.contains(forbidden), "{portable_context}");
    }

    // A first compiler context receives the approved handoff naturally through
    // the root node in its graph closure; it is not copied into an ambient
    // side-channel or a worker-only prompt.
    let context_engine = Engine::open_run(&root, &planned.run_id).expect("open context run");
    let store = StateStore::with_storage(
        approved.worktree.join("program"),
        &context_engine.profile().manifest.storage,
    )
    .expect("open tracked semantic store");
    let root_id = store
        .graph()
        .expect("approved graph")
        .nodes()
        .find(|node| node.annotations.get("run_root").and_then(Value::as_bool) == Some(true))
        .expect("run root")
        .id
        .clone();
    let mut first_ticket = lifecycle_ticket("TK-first-context", &context_engine.profile().hash);
    first_ticket.scope.read_nodes.insert(root_id);
    first_ticket.extensions.insert(
        "operation_registry_id".to_owned(),
        Value::String("lifecycle.context".to_owned()),
    );
    store
        .write_ticket(&first_ticket)
        .expect("materialize first scoped ticket");
    let mut context_engine = context_engine;
    let context_result = context_engine
        .execute_action(
            "context",
            [("ticket".to_owned(), first_ticket.id.clone())]
                .into_iter()
                .collect(),
        )
        .expect("compile first ticket context");
    let document_path = context_result["context_pack"]["document_path"]
        .as_str()
        .expect("context document path");
    let document = fs::read_to_string(approved.worktree.join(document_path))
        .expect("read compiler-issued context");
    assert!(
        document.contains("Inspect contracts, implement narrowly, and run focused tests."),
        "{document}"
    );
    assert!(!document.contains("planner-session-1"), "{document}");
}

#[test]
fn approved_planning_context_is_materialized_for_git_common_state() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
    write(
        &root,
        ".codex/koni/profile.yaml",
        &PROFILE.replace("backend: tracked", "backend: git_common_dir"),
    );
    commit_all(&root, "use git-common state for approved planning context");
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Materialize a git-common planning handoff",
        "HEAD",
        None,
    )
    .expect("initialize git-common planning run");
    let launcher = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41011,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "git-common-planning-session".to_owned(),
        output: Some("Keep git-common semantic state portable and bounded.".to_owned()),
    }]);
    Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Materialize a git-common planning handoff"}),
        &launcher,
    )
    .expect("record git-common plan");
    Engine::approve_run(&root, &planned.run_id).expect("approve git-common plan");

    let context = approved_planning_context(&root, &planned.run_id);
    assert_eq!(
        context["stages"][0]["output"],
        "Keep git-common semantic state portable and bounded."
    );
    assert_planning_context_hash(&context);
    assert!(
        !serde_json::to_string(&context)
            .unwrap()
            .contains("git-common-planning-session")
    );
}

#[test]
fn approval_retry_repairs_a_partially_materialized_planning_context() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Repair an interrupted approval handoff",
        "HEAD",
        None,
    )
    .expect("initialize retryable planning run");
    let launcher = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41021,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "approval-retry-session".to_owned(),
        output: Some("Restore this exact portable plan during approval retry.".to_owned()),
    }]);
    Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Repair an interrupted approval handoff"}),
        &launcher,
    )
    .expect("record retry plan");
    let first_approval =
        Engine::approve_run(&root, &planned.run_id).expect("initial approval succeeds");
    let expected = approved_planning_context(&root, &planned.run_id);

    let engine = Engine::open_run(&root, &planned.run_id).expect("open approved run");
    let store = StateStore::with_storage(
        first_approval.worktree.join("program"),
        &engine.profile().manifest.storage,
    )
    .expect("open approved semantic store");
    let mut graph = store.graph().expect("approved graph");
    let root_id = graph
        .nodes()
        .find(|node| node.annotations.get("run_root").and_then(Value::as_bool) == Some(true))
        .expect("approved root")
        .id
        .clone();
    graph
        .node_mut(&root_id)
        .expect("mutable approved root")
        .spec
        .as_object_mut()
        .expect("root spec")
        .remove("planning_context");
    graph
        .save_node(&store.graph_dir(), &root_id)
        .expect("simulate interrupted context materialization");

    let git = GitBackend::discover(&root).expect("discover project repository");
    let registry = koni_core::state::ProjectRegistryStore::new(git.sidecar_root(), root.clone())
        .expect("open project registry");
    let mut registration = registry
        .run(&planned.run_id)
        .expect("approved registration");
    registration.status = RunRegistrationStatus::Approved;
    registration.updated_at = Utc::now();
    registry
        .update_run(registration)
        .expect("simulate crash before active transition");

    Engine::approve_run(&root, &planned.run_id).expect("retry repairs the semantic handoff");
    assert_eq!(
        approved_planning_context(&root, &planned.run_id),
        expected,
        "approval retry must restore the exact pinned, content-addressed context"
    );
}

#[test]
fn planning_questions_pause_resume_the_same_session_until_a_plan_is_returned() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Resolve planning decisions",
        "HEAD",
        Some("interactive"),
    )
    .expect("initialize interactive planning run");
    let first = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41101,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "question-session".to_owned(),
        output: Some(planning_question_output(
            "Which persistence boundary should the app use?",
            "high",
        )),
    }]);
    let waiting = Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Resolve planning decisions"}),
        &first,
    )
    .expect("record first planning question")
    .expect("planning agent outcome");
    assert_eq!(waiting.status, "awaiting_input");
    assert_eq!(
        waiting.codex_session_id.as_deref(),
        Some("question-session")
    );
    let first_requests = first.requests.borrow();
    let request = &first_requests[0];
    assert!(
        request
            .args
            .windows(2)
            .any(|pair| pair[0] == "--output-schema" && Path::new(&pair[1]).is_file())
    );
    drop(first_requests);

    let backend = GitBackend::discover(&root).expect("discover project");
    let control = RunControlStore::new(
        backend
            .sidecar_path(format!("runs/{}", planned.run_id))
            .expect("run root"),
    );
    let first_question = control.open_questions().unwrap().remove(0);
    assert_eq!(first_question.policy, QuestionPolicy::Interactive);
    assert_eq!(first_question.status, QuestionStatus::Open);
    assert_eq!(
        first_question.session_resume.agent_id.as_deref(),
        Some("planning-planning")
    );
    assert_eq!(first_question.session_resume.session_id, "question-session");
    assert_eq!(first_question.options[0].id, "choice-1");
    assert_eq!(first_question.options[1].id, "choice-2");
    assert_eq!(
        control.pipeline().unwrap().unwrap().stages[0].status,
        PipelineStageStatus::Paused
    );
    let approval_error = Engine::approve_run(&root, &planned.run_id)
        .expect_err("open planning question must block approval")
        .to_string();
    assert!(
        approval_error.contains("planning question"),
        "{approval_error}"
    );

    let second = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41102,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "question-session".to_owned(),
        output: Some(planning_question_output(
            "Should the plan include cross-device synchronization?",
            "high",
        )),
    }]);
    let first_answer = Engine::answer_question_with(
        &root,
        &planned.run_id,
        &first_question.id,
        Some("choice-1"),
        None,
        &second,
    )
    .expect("resume planner with first answer");
    assert_eq!(first_answer.worker_pid, Some(41102));
    assert!(first_answer.resumed_same_session);
    assert_eq!(&second.requests.borrow()[0].args[..2], ["exec", "resume"]);
    assert!(
        second.requests.borrow()[0]
            .args
            .iter()
            .any(|argument| argument == "question-session")
    );
    let resumed_scratch = assert_read_only_scratch_launch(&second.requests.borrow()[0]);
    assert!(
        !resumed_scratch.exists(),
        "question-resume planning scratch is not retained"
    );
    let second_prompt = second.requests.borrow()[0]
        .args
        .last()
        .expect("resumed planning prompt")
        .clone();
    assert!(second_prompt.contains("Use the recommended boundary"));

    let questions = control.questions().unwrap();
    let answered_first = questions
        .iter()
        .find(|question| question.id == first_question.id)
        .unwrap();
    assert_eq!(answered_first.status, QuestionStatus::Answered);
    let second_question = questions
        .iter()
        .find(|question| question.status == QuestionStatus::Open)
        .expect("second planning question")
        .clone();
    assert_eq!(
        second_question.session_resume.session_id,
        first_question.session_resume.session_id
    );
    assert_eq!(
        control.pipeline().unwrap().unwrap().stages[0].status,
        PipelineStageStatus::Paused
    );

    let third = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41103,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "question-session".to_owned(),
        output: Some("Final plan grounded in both recorded decisions.".to_owned()),
    }]);
    let second_answer = Engine::answer_question_with(
        &root,
        &planned.run_id,
        &second_question.id,
        Some("choice-1"),
        None,
        &third,
    )
    .expect("resume planner with second answer");
    assert_eq!(second_answer.worker_pid, Some(41103));
    assert_eq!(&third.requests.borrow()[0].args[..2], ["exec", "resume"]);
    assert!(
        third.requests.borrow()[0]
            .args
            .iter()
            .any(|argument| argument == "question-session")
    );
    let completed = control.pipeline().unwrap().unwrap();
    assert_eq!(completed.stages[0].status, PipelineStageStatus::Succeeded);
    assert_eq!(completed.stages[1].status, PipelineStageStatus::Pending);
    assert!(control.open_questions().unwrap().is_empty());
    assert_eq!(
        control
            .agent("planning-planning")
            .unwrap()
            .unwrap()
            .result
            .unwrap()["output"],
        "Final plan grounded in both recorded decisions."
    );
    Engine::approve_run(&root, &planned.run_id)
        .expect("resolved planning questions permit explicit approval");
    let planning_context = approved_planning_context(&root, &planned.run_id);
    assert_eq!(
        planning_context["stages"][0]["output"],
        "Final plan grounded in both recorded decisions."
    );
    assert_eq!(planning_context["decisions"].as_array().unwrap().len(), 2);
    assert_eq!(
        planning_context["decisions"][0]["prompt"],
        "Which persistence boundary should the app use?"
    );
    assert_eq!(
        planning_context["decisions"][0]["answer"],
        "Use the recommended boundary"
    );
    assert_eq!(
        planning_context["decisions"][1]["prompt"],
        "Should the plan include cross-device synchronization?"
    );
    assert_eq!(planning_context["decisions"][0]["source"], "human");
    assert_planning_context_hash(&planning_context);
}

#[test]
fn interactive_planning_batch_persists_once_and_resumes_after_out_of_order_answers() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Resolve one related decision batch",
        "HEAD",
        Some("interactive"),
    )
    .expect("initialize batched planning run");
    let initial = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41301,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "batch-question-session".to_owned(),
        output: Some(planning_questions_output(&[
            ("Choose storage?", "high"),
            ("Choose synchronization?", "high"),
            ("Choose retention?", "high"),
        ])),
    }]);
    let waiting = Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Resolve one related decision batch"}),
        &initial,
    )
    .expect("persist planning batch")
    .expect("waiting planning outcome");
    assert_eq!(waiting.status, "awaiting_input");
    assert_eq!(initial.requests.borrow().len(), 1);

    let control = RunControlStore::new(
        GitBackend::discover(&root)
            .unwrap()
            .sidecar_path(format!("runs/{}", planned.run_id))
            .unwrap(),
    );
    let mut questions = control.questions().unwrap();
    questions.sort_by_key(|question| question.batch.as_ref().unwrap().ordinal);
    assert_eq!(questions.len(), 3);
    let batch = questions[0].batch.as_ref().unwrap().clone();
    assert_eq!(batch.size, 3);
    assert!(questions.iter().enumerate().all(|(index, question)| {
        question.batch.as_ref().is_some_and(|candidate| {
            candidate.id == batch.id
                && candidate.ordinal == index + 1
                && candidate.size == batch.size
        }) && question.session_resume.captured_at == questions[0].session_resume.captured_at
            && question.session_resume.context_hash == questions[0].session_resume.context_hash
            && question.status == QuestionStatus::Open
    }));
    assert_eq!(
        control.pipeline().unwrap().unwrap().stages[0].status,
        PipelineStageStatus::Paused
    );
    assert_eq!(
        control
            .planning_transcript()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == "planning.question.opened")
            .count(),
        3
    );

    let no_launch = FakeAgentLauncher::default();
    let third = Engine::answer_question_with(
        &root,
        &planned.run_id,
        &questions[2].id,
        Some("choice-1"),
        None,
        &no_launch,
    )
    .expect("answer third question without resuming");
    assert_eq!(third.worker_pid, None);
    assert!(third.resume_deferred);
    assert_eq!(third.remaining_questions, 2);
    assert!(no_launch.requests.borrow().is_empty());

    let first = Engine::answer_question_with(
        &root,
        &planned.run_id,
        &questions[0].id,
        Some("choice-1"),
        None,
        &no_launch,
    )
    .expect("answer first question without resuming");
    assert_eq!(first.worker_pid, None);
    assert!(first.resume_deferred);
    assert_eq!(first.remaining_questions, 1);
    assert!(no_launch.requests.borrow().is_empty());

    let revised = Engine::revise_planning_batch_answer(
        &root,
        &planned.run_id,
        &questions[0].id,
        Some("choice-2"),
        None,
    )
    .expect("revise a saved answer while one sibling remains open");
    assert!(revised.resume_deferred);
    assert_eq!(revised.worker_pid, None);
    assert_eq!(revised.remaining_questions, 1);
    assert!(no_launch.requests.borrow().is_empty());
    assert_eq!(
        control
            .question(&questions[0].id)
            .unwrap()
            .answer
            .unwrap()
            .option_id
            .as_deref(),
        Some("choice-2")
    );
    let pending = control.questions().unwrap();
    assert_eq!(
        pending
            .iter()
            .filter(|question| question.status == QuestionStatus::AnsweredPendingResume)
            .count(),
        2
    );
    let approval_error = Engine::approve_run(&root, &planned.run_id)
        .expect_err("pending and open batch members must block approval")
        .to_string();
    assert!(
        approval_error.contains("planning question"),
        "{approval_error}"
    );

    let final_launcher = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41302,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "batch-question-session".to_owned(),
        output: Some("Plan grounded in all three ordered decisions.".to_owned()),
    }]);
    let second = Engine::answer_question_with(
        &root,
        &planned.run_id,
        &questions[1].id,
        Some("choice-1"),
        None,
        &final_launcher,
    )
    .expect("last answer resumes batch exactly once");
    assert_eq!(second.worker_pid, Some(41302));
    assert!(!second.resume_deferred);
    assert_eq!(second.remaining_questions, 0);
    assert_eq!(final_launcher.requests.borrow().len(), 1);
    let prompt = final_launcher.requests.borrow()[0]
        .args
        .last()
        .unwrap()
        .clone();
    let storage = prompt.find("1. Choose storage?").unwrap();
    let synchronization = prompt.find("2. Choose synchronization?").unwrap();
    let retention = prompt.find("3. Choose retention?").unwrap();
    assert!(
        storage < synchronization && synchronization < retention,
        "{prompt}"
    );
    assert!(
        prompt.contains("Alternative for Choose storage?"),
        "{prompt}"
    );
    assert!(
        !prompt.contains("Compiler-owned planning assignment"),
        "{prompt}"
    );
    assert!(
        control
            .questions()
            .unwrap()
            .iter()
            .all(|question| question.status == QuestionStatus::Answered)
    );
    assert!(control.open_questions().unwrap().is_empty());
}

#[test]
fn planning_batch_launch_failure_keeps_all_answers_pending_for_one_retry() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Retry one failed batch resume",
        "HEAD",
        Some("interactive"),
    )
    .unwrap();
    let initial = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41401,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "retry-batch-session".to_owned(),
        output: Some(planning_questions_output(&[
            ("Choose API?", "high"),
            ("Choose storage?", "high"),
        ])),
    }]);
    Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Retry one failed batch resume"}),
        &initial,
    )
    .unwrap();
    let control = RunControlStore::new(
        GitBackend::discover(&root)
            .unwrap()
            .sidecar_path(format!("runs/{}", planned.run_id))
            .unwrap(),
    );
    let mut questions = control.questions().unwrap();
    questions.sort_by_key(|question| question.batch.as_ref().unwrap().ordinal);
    Engine::answer_question_with(
        &root,
        &planned.run_id,
        &questions[0].id,
        Some("choice-1"),
        None,
        &FakeAgentLauncher::default(),
    )
    .unwrap();
    let error = Engine::answer_question_with(
        &root,
        &planned.run_id,
        &questions[1].id,
        Some("choice-1"),
        None,
        &FakeAgentLauncher::default(),
    )
    .expect_err("missing fake process must fail before launch")
    .to_string();
    assert!(error.contains("no queued result"), "{error}");
    assert!(
        control
            .questions()
            .unwrap()
            .iter()
            .all(|question| { question.status == QuestionStatus::AnsweredPendingResume })
    );

    let revision_error = Engine::revise_planning_batch_answer(
        &root,
        &planned.run_id,
        &questions[0].id,
        Some("choice-2"),
        None,
    )
    .expect_err("a fully answered batch is immutable even after launch failure")
    .to_string();
    assert!(revision_error.contains("another batch question remains open"));

    let retry = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41402,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "retry-batch-session".to_owned(),
        output: Some("Recovered plan.".to_owned()),
    }]);
    let answered = Engine::answer_question_with(
        &root,
        &planned.run_id,
        &questions[1].id,
        Some("choice-1"),
        None,
        &retry,
    )
    .expect("retry the same durable final answer");
    assert_eq!(answered.worker_pid, Some(41402));
    assert_eq!(retry.requests.borrow().len(), 1);
    assert!(
        control
            .questions()
            .unwrap()
            .iter()
            .all(|question| question.status == QuestionStatus::Answered)
    );
}

#[test]
fn mixed_and_autonomous_planning_batches_each_resume_exactly_once() {
    for (policy, questions, expected_statuses) in [
        (
            "high_impact_only",
            vec![
                ("Choose routine layout?", "routine"),
                ("Choose high-impact storage?", "high"),
                ("Choose routine labels?", "routine"),
            ],
            vec![
                QuestionStatus::AutoResolved,
                QuestionStatus::Answered,
                QuestionStatus::AutoResolved,
            ],
        ),
        (
            "autonomous",
            vec![
                ("Choose first default?", "high"),
                ("Choose second default?", "routine"),
                ("Choose third default?", "high"),
            ],
            vec![
                QuestionStatus::AutoResolved,
                QuestionStatus::AutoResolved,
                QuestionStatus::AutoResolved,
            ],
        ),
    ] {
        let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
        let planned = Engine::plan_run(
            &root,
            Some("canonical"),
            "Resolve one policy-aware batch",
            "HEAD",
            Some(policy),
        )
        .unwrap();
        let initial_steps = if policy == "autonomous" {
            vec![
                FakeAgentStep {
                    result: AgentProcessResult {
                        pid: 41501,
                        exit_code: Some(0),
                        timed_out: false,
                    },
                    session_id: format!("{policy}-batch-session"),
                    output: Some(planning_questions_output(&questions)),
                },
                FakeAgentStep {
                    result: AgentProcessResult {
                        pid: 41502,
                        exit_code: Some(0),
                        timed_out: false,
                    },
                    session_id: format!("{policy}-batch-session"),
                    output: Some("Policy-aware final plan.".to_owned()),
                },
            ]
        } else {
            vec![FakeAgentStep {
                result: AgentProcessResult {
                    pid: 41501,
                    exit_code: Some(0),
                    timed_out: false,
                },
                session_id: format!("{policy}-batch-session"),
                output: Some(planning_questions_output(&questions)),
            }]
        };
        let initial = FakeAgentLauncher::new(initial_steps);
        let outcome = Engine::record_planning_intake_with(
            &root,
            &planned.run_id,
            serde_json::json!({"goal": "Resolve one policy-aware batch"}),
            &initial,
        )
        .unwrap()
        .unwrap();
        let control = RunControlStore::new(
            GitBackend::discover(&root)
                .unwrap()
                .sidecar_path(format!("runs/{}", planned.run_id))
                .unwrap(),
        );
        if policy == "high_impact_only" {
            assert_eq!(outcome.status, "awaiting_input");
            assert_eq!(initial.requests.borrow().len(), 1);
            let mut pending = control.questions().unwrap();
            pending.sort_by_key(|question| question.batch.as_ref().unwrap().ordinal);
            assert_eq!(
                pending
                    .iter()
                    .map(|question| question.status)
                    .collect::<Vec<_>>(),
                vec![
                    QuestionStatus::AutoResolvedPendingResume,
                    QuestionStatus::Open,
                    QuestionStatus::AutoResolvedPendingResume,
                ]
            );
            let high = pending
                .into_iter()
                .find(|question| question.impact == QuestionImpact::High)
                .unwrap();
            let resume = FakeAgentLauncher::new([FakeAgentStep {
                result: AgentProcessResult {
                    pid: 41502,
                    exit_code: Some(0),
                    timed_out: false,
                },
                session_id: format!("{policy}-batch-session"),
                output: Some("Policy-aware final plan.".to_owned()),
            }]);
            Engine::answer_question_with(
                &root,
                &planned.run_id,
                &high.id,
                Some("choice-1"),
                None,
                &resume,
            )
            .unwrap();
            assert_eq!(resume.requests.borrow().len(), 1);
        } else {
            assert_eq!(outcome.status, "succeeded");
            assert_eq!(initial.requests.borrow().len(), 2);
        }
        let mut durable = control.questions().unwrap();
        durable.sort_by_key(|question| question.batch.as_ref().unwrap().ordinal);
        assert_eq!(
            durable
                .iter()
                .map(|question| question.status)
                .collect::<Vec<_>>(),
            expected_statuses
        );
        assert!(control.open_questions().unwrap().is_empty());
    }
}

#[test]
fn noninteractive_planning_questions_choose_the_recommendation_and_continue() {
    for (policy, impact) in [("high_impact_only", "routine"), ("autonomous", "high")] {
        let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
        let planned = Engine::plan_run(
            &root,
            Some("canonical"),
            "Resolve an automatic planning decision",
            "HEAD",
            Some(policy),
        )
        .expect("initialize automatic-question planning run");
        let launcher = FakeAgentLauncher::new([
            FakeAgentStep {
                result: AgentProcessResult {
                    pid: 41201,
                    exit_code: Some(0),
                    timed_out: false,
                },
                session_id: "automatic-question-session".to_owned(),
                output: Some(planning_question_output(
                    "Which conservative default should the plan use?",
                    impact,
                )),
            },
            FakeAgentStep {
                result: AgentProcessResult {
                    pid: 41202,
                    exit_code: Some(0),
                    timed_out: false,
                },
                session_id: "automatic-question-session".to_owned(),
                output: Some("Plan using the compiler-selected recommendation.".to_owned()),
            },
        ]);
        let completed = Engine::record_planning_intake_with(
            &root,
            &planned.run_id,
            serde_json::json!({"goal": "Resolve an automatic planning decision"}),
            &launcher,
        )
        .expect("automatic question should resume planning")
        .expect("completed planning result");
        assert_eq!(completed.status, "succeeded");
        assert_eq!(completed.process_attempt, 2);
        assert_eq!(launcher.requests.borrow().len(), 2);
        assert_eq!(&launcher.requests.borrow()[1].args[..2], ["exec", "resume"]);

        let control = RunControlStore::new(
            GitBackend::discover(&root)
                .unwrap()
                .sidecar_path(format!("runs/{}", planned.run_id))
                .unwrap(),
        );
        let questions = control.questions().unwrap();
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].status, QuestionStatus::AutoResolved);
        assert_eq!(
            questions[0]
                .answer
                .as_ref()
                .and_then(|answer| answer.option_id.as_deref()),
            Some("choice-1")
        );
        assert!(control.open_questions().unwrap().is_empty());
    }
}

#[test]
fn malformed_planning_output_fails_closed_without_creating_a_question() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Reject malformed planning output",
        "HEAD",
        Some("interactive"),
    )
    .unwrap();
    let launcher = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 41301,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "malformed-session".to_owned(),
        output: Some("RAW:not valid JSON".to_owned()),
    }]);
    let error = Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Reject malformed planning output"}),
        &launcher,
    )
    .expect_err("malformed structured output must fail closed")
    .to_string();
    assert!(error.contains("invalid structured output"), "{error}");
    let control = RunControlStore::new(
        GitBackend::discover(&root)
            .unwrap()
            .sidecar_path(format!("runs/{}", planned.run_id))
            .unwrap(),
    );
    assert!(control.questions().unwrap().is_empty());
    assert_eq!(
        control.agent("planning-planning").unwrap().unwrap().status,
        "incomplete"
    );
    assert_eq!(
        control.pipeline().unwrap().unwrap().stages[0].status,
        PipelineStageStatus::Waiting
    );
}

#[test]
fn timed_out_planning_agent_resumes_the_same_codex_session() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
    let references = local_references(&root);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Resume bounded planning",
        "HEAD",
        None,
    )
    .expect("initialize planning run");
    let first = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 42001,
            exit_code: None,
            timed_out: true,
        },
        session_id: "planner-resume-session".to_owned(),
        output: None,
    }]);
    let timed_out = Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Resume bounded planning"}),
        &first,
    )
    .expect("bounded timeout is persisted")
    .expect("planning stage dispatched");
    assert_eq!(timed_out.status, "timed_out");
    assert_eq!(timed_out.process_attempt, 1);
    assert_eq!(
        timed_out.codex_session_id.as_deref(),
        Some("planner-resume-session")
    );
    assert!(Engine::approve_run(&root, &planned.run_id).is_err());

    let backend = GitBackend::discover(&root).expect("discover project");
    let control = RunControlStore::new(
        backend
            .sidecar_path(format!("runs/{}", planned.run_id))
            .expect("run root"),
    );
    let waiting = control
        .pipeline()
        .expect("pipeline read")
        .expect("pipeline");
    assert_eq!(waiting.stages[0].status, PipelineStageStatus::Waiting);
    assert_eq!(waiting.status, RunPipelineStatus::Waiting);

    let second = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 42002,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "planner-resume-session".to_owned(),
        output: Some("Recovered session plan with explicit verification.".to_owned()),
    }]);
    let resumed = Engine::resume_planning_agent_with(&root, &planned.run_id, &second)
        .expect("resume fake planning agent")
        .expect("planning stage resumed");
    assert_eq!(resumed.status, "succeeded");
    assert_eq!(resumed.process_attempt, 2);
    assert!(resumed.resumed_session);
    assert_eq!(
        resumed.codex_session_id.as_deref(),
        Some("planner-resume-session")
    );
    let requests = second.requests.borrow();
    assert_eq!(&requests[0].args[..2], ["exec", "resume"]);
    assert!(
        requests[0]
            .args
            .iter()
            .any(|arg| arg == "planner-resume-session")
    );
    assert!(!requests[0].args.iter().any(|arg| arg == "--sandbox"));
    let scratch = assert_read_only_scratch_launch(&requests[0]);
    assert!(!scratch.exists(), "resumed planner scratch is not retained");
    drop(requests);

    let completed = control
        .pipeline()
        .expect("pipeline read")
        .expect("pipeline");
    assert_eq!(completed.stages[0].status, PipelineStageStatus::Succeeded);
    assert_eq!(
        Engine::project_registry(&root).expect("registry").runs[&planned.run_id].status,
        RunRegistrationStatus::Planning
    );
    assert!(planned.planning_worktree.exists());
    assert_eq!(local_references(&root), references);
}

#[test]
fn intake_dispatches_the_complete_compiler_owned_planning_prefix() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(MULTI_STAGE_PLANNING_RUN_TYPE);
    let references = local_references(&root);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Plan architecture and verification",
        "HEAD",
        None,
    )
    .expect("initialize multi-stage planning run");
    let launcher = FakeAgentLauncher::new([
        FakeAgentStep {
            result: AgentProcessResult {
                pid: 43001,
                exit_code: Some(0),
                timed_out: false,
            },
            session_id: "architecture-session".to_owned(),
            output: Some("Architectural plan with bounded seams.".to_owned()),
        },
        FakeAgentStep {
            result: AgentProcessResult {
                pid: 43002,
                exit_code: Some(0),
                timed_out: false,
            },
            session_id: "verification-session".to_owned(),
            output: Some("Verification plan with focused and workspace tests.".to_owned()),
        },
    ]);

    let outcome = Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Plan architecture and verification"}),
        &launcher,
    )
    .expect("dispatch complete planning prefix")
    .expect("last planning stage result");
    assert_eq!(outcome.stage_id, "verification");
    assert_eq!(outcome.status, "succeeded");
    let requests = launcher.requests.borrow();
    assert_eq!(requests.len(), 2);
    let second_prompt = requests[1].args.last().expect("second planning prompt");
    assert!(
        second_prompt.contains("Prior successful planning passes"),
        "{second_prompt}"
    );
    assert!(
        second_prompt.contains("Architectural plan with bounded seams."),
        "{second_prompt}"
    );
    assert!(
        second_prompt.contains("Plan architecture"),
        "{second_prompt}"
    );
    drop(requests);

    let backend = GitBackend::discover(&root).expect("discover project");
    let control = RunControlStore::new(
        backend
            .sidecar_path(format!("runs/{}", planned.run_id))
            .expect("run root"),
    );
    let pipeline = control
        .pipeline()
        .expect("pipeline read")
        .expect("pipeline");
    assert_eq!(pipeline.stages[0].status, PipelineStageStatus::Succeeded);
    assert_eq!(pipeline.stages[1].status, PipelineStageStatus::Succeeded);
    assert_eq!(pipeline.stages[2].status, PipelineStageStatus::Succeeded);
    assert_eq!(pipeline.stages[3].status, PipelineStageStatus::Pending);
    assert_eq!(pipeline.cursor, 3);
    let agents = control.agents().expect("agent records");
    assert_eq!(agents.len(), 2);
    assert!(agents.iter().all(|agent| agent.status == "succeeded"));
    let planning_registry = Engine::project_registry(&root).expect("planning registry");
    let registration = &planning_registry.runs[&planned.run_id];
    let verification_without_prior = koni_core::graph::normalized_hash(&serde_json::json!({
        "run_id": planned.run_id,
        "run_type_hash": planned.run_type_hash,
        "profile_hash": planned.profile_hash,
        "config_snapshot_hash": registration.config_snapshot_hash,
        "base_commit": registration.base_commit,
        "stage_definition_hash": pipeline.stages[2].definition_hash,
        "intake": {"goal": "Plan architecture and verification"},
        "prior_planning_outputs": [],
    }));
    let verification_agent = agents
        .iter()
        .find(|agent| agent.stage_id.as_deref() == Some("verification"))
        .expect("verification agent record");
    assert_ne!(
        verification_agent.input_hash.as_deref(),
        Some(verification_without_prior.as_str()),
        "the second pass input binding must include the first pass output"
    );
    assert_eq!(
        Engine::project_registry(&root).expect("registry").runs[&planned.run_id].status,
        RunRegistrationStatus::Planning,
        "the planning prefix must never cross approval"
    );
    assert_eq!(local_references(&root), references);

    let approved = Engine::approve_run(&root, &planned.run_id).expect("explicit approval");
    assert_eq!(approved.board.run_status, "active");
    let planning_context = approved_planning_context(&root, &planned.run_id);
    assert_eq!(planning_context["stages"].as_array().unwrap().len(), 2);
    assert_eq!(planning_context["stages"][0]["stage_id"], "architecture");
    assert_eq!(
        planning_context["stages"][0]["output"],
        "Architectural plan with bounded seams."
    );
    assert_eq!(planning_context["stages"][1]["stage_id"], "verification");
    assert_eq!(
        planning_context["stages"][1]["output"],
        "Verification plan with focused and workspace tests."
    );
    assert_planning_context_hash(&planning_context);
}

#[test]
fn later_risk_and_verification_prompts_expose_only_semantic_planning_history() {
    const ARCHITECTURE_STAGE_ID: &str = "architecture-private-019f55aa-1111-7111-8111-111111111111";
    const RISK_STAGE_ID: &str = "risk-private-019f55aa-2222-7222-8222-222222222222";
    const VERIFICATION_STAGE_ID: &str = "verification-private-019f55aa-3333-7333-8333-333333333333";
    const ARCHITECTURE_OUTPUT: &str =
        "Keep one semantic service boundary and a repository-relative src/api.rs seam.";
    const RISK_OUTPUT: &str =
        "Bound rollback and escalation behavior before implementation begins.";
    const PLANNER_SESSION: &str = "019f55aa-4444-7444-8444-444444444444";

    let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_PROMPT_PRIVACY_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Plan a privacy-bounded change",
        "HEAD",
        Some("interactive"),
    )
    .expect("initialize privacy-bounded planning run");
    let initial = FakeAgentLauncher::new([
        FakeAgentStep {
            result: AgentProcessResult {
                pid: 43501,
                exit_code: Some(0),
                timed_out: false,
            },
            session_id: "019f55aa-5555-7555-8555-555555555555".to_owned(),
            output: Some(ARCHITECTURE_OUTPUT.to_owned()),
        },
        FakeAgentStep {
            result: AgentProcessResult {
                pid: 43502,
                exit_code: Some(0),
                timed_out: false,
            },
            session_id: PLANNER_SESSION.to_owned(),
            output: Some(planning_questions_output(&[
                ("Choose rollback scope?", "high"),
                ("Choose escalation boundary?", "high"),
            ])),
        },
    ]);

    let waiting = Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        json!({"goal": "Plan a privacy-bounded change"}),
        &initial,
    )
    .expect("dispatch architecture and risk planning")
    .expect("risk planner waits for the question batch");
    assert_eq!(waiting.stage_id, RISK_STAGE_ID);
    assert_eq!(waiting.status, "awaiting_input");

    let initial_requests = initial.requests.borrow();
    assert_eq!(initial_requests.len(), 2);
    let architecture_prompt = initial_requests[0]
        .args
        .last()
        .expect("architecture prompt");
    assert!(
        architecture_prompt.contains("Stage: Shape the architecture"),
        "{architecture_prompt}"
    );
    assert!(!architecture_prompt.contains(ARCHITECTURE_STAGE_ID));
    let risk_prompt = initial_requests[1].args.last().expect("risk prompt");
    assert!(
        risk_prompt.contains("Stage: Assess risk controls"),
        "{risk_prompt}"
    );
    assert!(risk_prompt.contains(ARCHITECTURE_OUTPUT), "{risk_prompt}");
    let architecture_hash = koni_core::graph::normalized_hash(&ARCHITECTURE_OUTPUT);
    for forbidden in [
        ARCHITECTURE_STAGE_ID,
        RISK_STAGE_ID,
        architecture_hash.as_str(),
        "output_hash",
        "stage_id",
    ] {
        assert!(
            !risk_prompt.contains(forbidden),
            "risk prompt exposed `{forbidden}`: {risk_prompt}"
        );
    }
    drop(initial_requests);

    let control = RunControlStore::new(
        GitBackend::discover(&root)
            .unwrap()
            .sidecar_path(format!("runs/{}", planned.run_id))
            .unwrap(),
    );
    let mut questions = control.questions().expect("durable risk questions");
    questions.sort_by_key(|question| question.batch.as_ref().unwrap().ordinal);
    assert_eq!(questions.len(), 2);
    let batch_id = questions[0].batch.as_ref().unwrap().id.clone();
    let question_ids = questions
        .iter()
        .map(|question| question.id.clone())
        .collect::<Vec<_>>();
    let question_context_hash = questions[0].session_resume.context_hash.clone();
    let absolute_worktree = questions[0]
        .session_resume
        .working_directory
        .as_ref()
        .expect("planning question retains its compiler-owned working directory")
        .display()
        .to_string();

    Engine::answer_question_with(
        &root,
        &planned.run_id,
        &questions[0].id,
        Some("choice-1"),
        None,
        &FakeAgentLauncher::default(),
    )
    .expect("record first risk answer without resuming an incomplete batch");
    let continuation = FakeAgentLauncher::new([
        FakeAgentStep {
            result: AgentProcessResult {
                pid: 43503,
                exit_code: Some(0),
                timed_out: false,
            },
            session_id: PLANNER_SESSION.to_owned(),
            output: Some(RISK_OUTPUT.to_owned()),
        },
        FakeAgentStep {
            result: AgentProcessResult {
                pid: 43504,
                exit_code: Some(0),
                timed_out: false,
            },
            session_id: "019f55aa-6666-7666-8666-666666666666".to_owned(),
            output: Some("Verify the semantic architecture and risk controls.".to_owned()),
        },
    ]);
    Engine::answer_question_with(
        &root,
        &planned.run_id,
        &questions[1].id,
        Some("choice-2"),
        None,
        &continuation,
    )
    .expect("resume risk planning and dispatch verification");

    let continuation_requests = continuation.requests.borrow();
    assert_eq!(continuation_requests.len(), 2);
    let resume_prompt = continuation_requests[0]
        .args
        .last()
        .expect("risk question resume prompt");
    assert!(resume_prompt.contains("1. Choose rollback scope?"));
    assert!(resume_prompt.contains("2. Choose escalation boundary?"));

    let verification_prompt = continuation_requests[1]
        .args
        .last()
        .expect("verification prompt");
    assert!(
        verification_prompt.contains("Stage: Design verification"),
        "{verification_prompt}"
    );
    assert!(
        verification_prompt.contains(ARCHITECTURE_OUTPUT),
        "{verification_prompt}"
    );
    assert!(
        verification_prompt.contains(RISK_OUTPUT),
        "{verification_prompt}"
    );
    assert!(
        verification_prompt.contains("\"question\": \"Choose rollback scope?\""),
        "{verification_prompt}"
    );
    assert!(
        verification_prompt.contains("\"source\": \"human\""),
        "{verification_prompt}"
    );
    assert!(
        verification_prompt.contains("\"order\": 1"),
        "{verification_prompt}"
    );
    assert!(
        verification_prompt.contains("\"order\": 2"),
        "{verification_prompt}"
    );
    let risk_hash = koni_core::graph::normalized_hash(&RISK_OUTPUT);
    let mut forbidden = vec![
        planned.run_id.clone(),
        ARCHITECTURE_STAGE_ID.to_owned(),
        RISK_STAGE_ID.to_owned(),
        VERIFICATION_STAGE_ID.to_owned(),
        architecture_hash,
        risk_hash,
        batch_id,
        question_context_hash,
        PLANNER_SESSION.to_owned(),
        absolute_worktree,
        "\"output_hash\"".to_owned(),
        "\"stage_id\"".to_owned(),
        "\"batch\"".to_owned(),
        "\"ordinal\"".to_owned(),
        "\"size\"".to_owned(),
        "\"session_id\"".to_owned(),
        "\"working_directory\"".to_owned(),
    ];
    forbidden.extend(question_ids);
    for sentinel in forbidden {
        assert!(
            !resume_prompt.contains(&sentinel),
            "question resume prompt exposed `{sentinel}`: {resume_prompt}"
        );
        assert!(
            !verification_prompt.contains(&sentinel),
            "verification prompt exposed `{sentinel}`: {verification_prompt}"
        );
    }
}

#[test]
fn approved_planning_context_is_utf8_safe_content_addressed_and_strictly_bounded() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(MULTI_STAGE_PLANNING_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Bound a large Unicode planning handoff",
        "HEAD",
        None,
    )
    .expect("initialize bounded planning run");
    let architecture = "architecture-🧭-".repeat(8_000);
    let verification = "verification-🧪-".repeat(8_000);
    let launcher = FakeAgentLauncher::new([
        FakeAgentStep {
            result: AgentProcessResult {
                pid: 43011,
                exit_code: Some(0),
                timed_out: false,
            },
            session_id: "large-architecture-session".to_owned(),
            output: Some(architecture.clone()),
        },
        FakeAgentStep {
            result: AgentProcessResult {
                pid: 43012,
                exit_code: Some(0),
                timed_out: false,
            },
            session_id: "large-verification-session".to_owned(),
            output: Some(verification.clone()),
        },
    ]);
    Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Bound a large Unicode planning handoff"}),
        &launcher,
    )
    .expect("record large planning passes");
    Engine::approve_run(&root, &planned.run_id).expect("approve bounded planning run");

    let context = approved_planning_context(&root, &planned.run_id);
    let stages = context["stages"].as_array().expect("planning stages");
    assert_eq!(stages.len(), 2);
    let total_bytes = stages
        .iter()
        .map(|stage| stage["output"].as_str().unwrap().len())
        .sum::<usize>();
    assert!(total_bytes <= 64 * 1024, "{total_bytes}");
    assert!(stages.iter().all(|stage| {
        stage["output"].as_str().unwrap().len() <= 32 * 1024 && stage["truncated"] == true
    }));
    assert_eq!(
        stages[0]["original_bytes"].as_u64(),
        Some(architecture.len() as u64)
    );
    assert_eq!(
        stages[0]["output_hash"],
        koni_core::graph::normalized_hash(&architecture)
    );
    assert_eq!(
        stages[1]["output_hash"],
        koni_core::graph::normalized_hash(&verification)
    );
    assert_planning_context_hash(&context);
    let portable_context = serde_json::to_string(&context).unwrap();
    assert!(!portable_context.contains("large-architecture-session"));
    assert!(!portable_context.contains("large-verification-session"));
}

#[test]
fn later_planning_pass_resume_keeps_the_same_cumulative_input_binding() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(MULTI_STAGE_PLANNING_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Resume cumulative verification planning",
        "HEAD",
        None,
    )
    .expect("initialize cumulative planning run");
    let first = FakeAgentLauncher::new([
        FakeAgentStep {
            result: AgentProcessResult {
                pid: 43101,
                exit_code: Some(0),
                timed_out: false,
            },
            session_id: "cumulative-architecture-session".to_owned(),
            output: Some(
                "Keep the API boundary narrow and preserve storage compatibility.".to_owned(),
            ),
        },
        FakeAgentStep {
            result: AgentProcessResult {
                pid: 43102,
                exit_code: None,
                timed_out: true,
            },
            session_id: "cumulative-verification-session".to_owned(),
            output: None,
        },
    ]);
    let timed_out = Engine::record_planning_intake_with(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Resume cumulative verification planning"}),
        &first,
    )
    .expect("dispatch cumulative passes")
    .expect("verification pass dispatched");
    assert_eq!(timed_out.stage_id, "verification");
    assert_eq!(timed_out.status, "timed_out");
    let backend = GitBackend::discover(&root).expect("discover cumulative project");
    let control = RunControlStore::new(
        backend
            .sidecar_path(format!("runs/{}", planned.run_id))
            .expect("cumulative run root"),
    );
    let original_input_hash = control
        .agent("planning-verification")
        .unwrap()
        .unwrap()
        .input_hash
        .expect("verification input binding");
    let original_prompt = first.requests.borrow()[1]
        .args
        .last()
        .expect("original verification prompt")
        .clone();
    assert!(original_prompt.contains("Keep the API boundary narrow"));

    let resumed_launcher = FakeAgentLauncher::new([FakeAgentStep {
        result: AgentProcessResult {
            pid: 43103,
            exit_code: Some(0),
            timed_out: false,
        },
        session_id: "cumulative-verification-session".to_owned(),
        output: Some("Verify the preserved API and storage compatibility constraints.".to_owned()),
    }]);
    let resumed = Engine::resume_planning_agent_with(&root, &planned.run_id, &resumed_launcher)
        .expect("resume cumulative verification pass")
        .expect("resumed verification result");
    assert_eq!(resumed.status, "succeeded");
    assert!(resumed.resumed_session);
    let resumed_prompt = resumed_launcher.requests.borrow()[0]
        .args
        .last()
        .expect("resumed verification prompt")
        .clone();
    assert!(resumed_prompt.contains("Keep the API boundary narrow"));
    assert!(resumed_prompt.contains("bounded resume of the same planning session"));
    assert_eq!(
        control
            .agent("planning-verification")
            .unwrap()
            .unwrap()
            .input_hash
            .as_deref(),
        Some(original_input_hash.as_str())
    );
}

#[test]
fn open_run_preserves_a_registered_ticket_worktree_as_the_execution_checkout() {
    let (_temp, root, _base) = canonical_fixture();
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Ticket checkout resolution",
        "HEAD",
        None,
    )
    .expect("plan run");
    let approved = Engine::approve_run(&root, &planned.run_id).expect("approve run");
    let integration_engine = Engine::open_run(&root, &planned.run_id).expect("open integration");
    let storage = integration_engine.profile().manifest.storage.clone();
    let profile_hash = integration_engine.profile().hash.clone();
    let integration_store = StateStore::with_storage(approved.worktree.join("program"), &storage)
        .expect("open integration state");
    let mut leased = lifecycle_ticket("TK-ticket-checkout", &profile_hash);
    integration_store
        .write_ticket(&leased)
        .expect("seed ticket before branching");
    let integration_git = GitBackend::discover(&approved.worktree).expect("discover integration");
    integration_git
        .checkpoint(&CheckpointRequest {
            subject: "test: seed ticket checkout".to_owned(),
            body: None,
            trailers: Vec::new(),
            excluded_paths: Vec::new(),
            tree_excluded_paths: Vec::new(),
            identity: None,
        })
        .expect("checkpoint seeded ticket");
    let ticket_worktree = integration_git
        .create_run_ticket_worktree(&RunTicketWorktreeRequest {
            run_id: planned.run_id.clone(),
            run_slug: "ticket-checkout-resolution".to_owned(),
            ticket_id: leased.id.clone(),
            base: integration_git.head_oid().expect("integration head"),
            templates: RunGitTemplates::default(),
        })
        .expect("create ticket worktree");
    let now = Utc::now();
    leased.lease = Some(Lease {
        id: "lease-ticket-checkout".to_owned(),
        branch: ticket_worktree
            .branch_ref
            .trim_start_matches("refs/heads/")
            .to_owned(),
        worktree: ticket_worktree.path.clone(),
        base_commit: ticket_worktree.base.clone(),
        started_at: now,
        heartbeat_at: now,
        worker_pid: None,
    });
    integration_store
        .write_ticket(&leased)
        .expect("persist canonical lease");

    let ticket_store = StateStore::with_storage(ticket_worktree.path.join("program"), &storage)
        .expect("open ticket state");
    ticket_store
        .write_ticket(&leased)
        .expect("persist canonical lease in ticket worktree state");
    ticket_store
        .write_ticket(&lifecycle_ticket("TK-ticket-local", &profile_hash))
        .expect("write checkout-local ticket");
    GitBackend::discover(&ticket_worktree.path)
        .expect("discover ticket checkout")
        .checkpoint(&CheckpointRequest {
            subject: "test: persist canonical ticket checkout state".to_owned(),
            body: None,
            trailers: Vec::new(),
            excluded_paths: Vec::new(),
            tree_excluded_paths: Vec::new(),
            identity: None,
        })
        .expect("checkpoint ticket checkout state");
    assert_eq!(
        Engine::open_run(&root, &planned.run_id)
            .expect("reopen from project")
            .inspect()
            .expect("inspect integration state")
            .ticket_count,
        1,
        "the original project checkout resolves to the registered integration checkout"
    );
    assert_eq!(
        Engine::open_run(&ticket_worktree.path, &planned.run_id)
            .expect("open from registered ticket worktree")
            .inspect()
            .expect("inspect ticket state")
            .ticket_count,
        2,
        "the registered ticket caller must remain the execution checkout"
    );
}

#[test]
fn selected_run_play_pause_is_durable_across_planning_and_active_phases() {
    let (_temp, root, _base) = canonical_fixture();
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Exercise selected lifecycle controls",
        "HEAD",
        None,
    )
    .expect("plan lifecycle run");
    Engine::record_planning_intake(
        &root,
        &planned.run_id,
        serde_json::json!({"goal": "Exercise selected lifecycle controls"}),
    )
    .expect("record planning intake");

    let paused =
        Engine::set_run_running(&root, &planned.run_id, false).expect("pause planning run");
    assert!(!paused.running);
    assert!(!paused.draining);
    let planning_snapshot = Engine::open_run(&root, &planned.run_id)
        .expect("open paused planning run")
        .cockpit_snapshot()
        .expect("planning snapshot");
    assert_eq!(planning_snapshot["lifecycle"]["running"], false);

    let playing = Engine::set_run_running(&root, &planned.run_id, true).expect("play planning run");
    assert!(playing.running);
    let approved = Engine::approve_run(&root, &planned.run_id).expect("approve lifecycle run");
    let paused = Engine::set_run_running(&root, &planned.run_id, false).expect("pause active run");
    assert!(!paused.running);
    let active_snapshot = Engine::open_run(&root, &planned.run_id)
        .expect("open paused active run")
        .cockpit_snapshot()
        .expect("active snapshot");
    assert_eq!(active_snapshot["lifecycle"]["running"], false);
    assert_eq!(active_snapshot["orchestration"]["running"], false);
    assert!(approved.worktree.exists());

    let playing =
        Engine::set_run_running(&root, &planned.run_id, true).expect("resume active scheduling");
    assert!(playing.running);
}

#[test]
fn planning_pause_wins_while_launcher_runs_without_semantic_completion() {
    let (_temp, root, _base) = canonical_fixture_with_run_type(PLANNING_AGENT_RUN_TYPE);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Pause while the planner is spending tokens",
        "HEAD",
        None,
    )
    .expect("plan pausable planning run");
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let launcher = Arc::new(BlockingAgentLauncher {
        started: started_tx,
        release: Mutex::new(release_rx),
        output: None,
    });
    let run_root = GitBackend::discover(&root)
        .expect("discover project")
        .sidecar_path(format!("runs/{}", planned.run_id))
        .expect("run root");
    let control = RunControlStore::new(run_root);
    let thread_root = root.clone();
    let thread_run_id = planned.run_id.clone();
    let thread_launcher = launcher.clone();
    let planning = std::thread::spawn(move || {
        Engine::record_planning_intake_with(
            &thread_root,
            &thread_run_id,
            json!({"goal": "Pause while the planner is spending tokens"}),
            thread_launcher.as_ref(),
        )
    });

    started_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("planner crossed durable start boundary");
    let paused = Engine::set_run_running(&root, &planned.run_id, false)
        .expect("pause must acquire authority while launcher is running");
    assert!(!paused.running);
    release_tx.send(()).expect("release fake planner");
    planning
        .join()
        .expect("join planner thread")
        .expect("planner drains into paused state");

    let record = control
        .agent("planning-planning")
        .expect("read planning agent")
        .expect("planning agent record");
    assert_eq!(record.status, "paused");
    assert!(record.result.is_none());
    let pipeline = control
        .pipeline()
        .expect("read pipeline")
        .expect("pipeline");
    assert_ne!(
        pipeline.stages[0].status,
        PipelineStageStatus::Succeeded,
        "paused completion must not publish a semantic planning result"
    );
}

#[cfg(unix)]
#[test]
fn planning_pause_terminates_only_a_durably_owned_process_group() {
    let (_temp, root, _base) = canonical_fixture();
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Pause a live owned planner",
        "HEAD",
        None,
    )
    .expect("plan owned-process run");
    let mut child = Command::new("sh")
        .args(["-c", "sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .expect("spawn isolated fake planner");
    let pid = child.id();
    let identity = (0..50)
        .find_map(|_| {
            let identity = capture_owned_agent_process_identity(pid);
            if identity.is_none() {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            identity
        })
        .unwrap_or_else(|| {
            let _ = child.kill();
            panic!("capture fake planner identity")
        });
    let reaper = std::thread::spawn(move || child.wait());
    let run_root = GitBackend::discover(&root)
        .expect("discover project")
        .sidecar_path(format!("runs/{}", planned.run_id))
        .expect("run root");
    let control = RunControlStore::new(run_root);
    let now = Utc::now();
    control
        .write_agent(&AgentSessionRecord {
            schema_version: "1.0".to_owned(),
            id: "planning-plan".to_owned(),
            run_id: planned.run_id.clone(),
            ticket_id: None,
            stage_id: Some("plan".to_owned()),
            persona: "planner".to_owned(),
            model: None,
            reasoning_effort: None,
            status: "running".to_owned(),
            attempt: 1,
            codex_session_id: None,
            pid: Some(pid),
            process_identity: Some(identity),
            working_directory: Some(planned.planning_worktree.clone()),
            prompt_path: None,
            stdout_path: None,
            stderr_path: None,
            output_path: None,
            output_hash: None,
            input_hash: None,
            result: None,
            exit_code: None,
            timed_out: false,
            started_at: Some(now),
            finished_at: None,
            updated_at: now,
        })
        .expect("persist fake planner ownership");

    let paused =
        Engine::set_run_running(&root, &planned.run_id, false).expect("pause owned planner");
    assert!(!paused.running);
    assert_eq!(paused.active_agents, 0);
    reaper
        .join()
        .expect("join fake planner reaper")
        .expect("reap fake planner");
    assert_eq!(
        control
            .agent("planning-plan")
            .expect("read planner")
            .expect("planner record")
            .status,
        "paused"
    );
}

#[test]
fn deleting_a_clean_run_preserves_branches_and_repairs_registry_selection() {
    let (_temp, root, _base) = canonical_fixture();
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Delete a completed experiment safely",
        "HEAD",
        None,
    )
    .expect("plan deletable run");
    let approved = Engine::approve_run(&root, &planned.run_id).expect("approve deletable run");
    Engine::set_run_running(&root, &planned.run_id, false).expect("pause deletable run");
    let preview = Engine::inspect_run_deletion(&root, &planned.run_id).expect("deletion preview");
    assert!(preview.can_delete, "{:?}", preview.blockers);
    assert!(preview.dirty_worktrees.is_empty());
    assert!(preview.owned_branches.contains(&approved.branch));

    let deleted = Engine::delete_run(&root, &planned.run_id, RunDeletionMode::PreserveBranches)
        .expect("delete run while preserving branches");
    assert!(!deleted.already_deleted);
    assert!(deleted.preserved_branches.contains(&approved.branch));
    assert!(!approved.worktree.exists());
    assert!(
        Repository::discover(&root)
            .expect("open repository")
            .find_reference(&approved.branch)
            .is_ok(),
        "safe deletion must retain the integration branch"
    );
    let registry = Engine::project_registry(&root).expect("registry after deletion");
    assert!(!registry.runs.contains_key(&planned.run_id));
    assert!(registry.selected_run.is_none());
    let sidecar = GitBackend::discover(&root)
        .expect("discover repository")
        .sidecar_root();
    assert!(!sidecar.join("runs/current").exists());

    let replay = Engine::delete_run(&root, &planned.run_id, RunDeletionMode::PreserveBranches)
        .expect("replay completed deletion");
    assert!(replay.already_deleted);
}

#[test]
fn deletion_that_wins_before_dispatch_rejects_a_stale_engine_without_recreating_authority() {
    let (_temp, root, _base) = canonical_fixture();
    let sidecar = GitBackend::discover(&root)
        .expect("discover project")
        .sidecar_root();
    install_blocking_read_only_check(&root);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Delete before a stale compiler can dispatch work",
        "HEAD",
        None,
    )
    .expect("plan delete-first run");
    let approved = Engine::approve_run(&root, &planned.run_id).expect("approve delete-first run");
    let mut stale = Engine::open_run(&root, &planned.run_id).expect("open engine before deletion");
    Engine::set_run_running(&root, &planned.run_id, false).expect("pause delete-first run");
    Engine::delete_run(&root, &planned.run_id, RunDeletionMode::PreserveBranches)
        .expect("delete before dispatch");

    let error = stale
        .execute_action("blocking-check", BTreeMap::new())
        .expect_err("a stale engine must not dispatch after deletion wins");
    assert!(
        error.to_string().contains("disappeared")
            || error.to_string().contains("deleted")
            || error.to_string().contains("No such file"),
        "{error}"
    );
    assert!(!approved.worktree.exists());
    assert!(
        !sidecar
            .join("command-authority")
            .join(&planned.run_id)
            .exists(),
        "post-delete dispatch must not recreate command authority"
    );
    assert!(
        !sidecar.join("runs").join(&planned.run_id).exists(),
        "post-delete dispatch must not recreate run state"
    );
}

#[test]
fn running_read_only_command_and_deletion_serialize_at_durable_boundaries() {
    let (_temp, root, _base) = canonical_fixture();
    let sidecar = GitBackend::discover(&root)
        .expect("discover project")
        .sidecar_root();
    install_blocking_read_only_check(&root);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Finish command authority before deleting its run",
        "HEAD",
        None,
    )
    .expect("plan command-first run");
    Engine::approve_run(&root, &planned.run_id).expect("approve command-first run");

    let action_root = root.clone();
    let action_run_id = planned.run_id.clone();
    let action = std::thread::spawn(move || {
        Engine::open_run(&action_root, &action_run_id)
            .expect("open command-first engine")
            .execute_action("blocking-check", BTreeMap::new())
    });
    let journal = wait_for_command_journal(&sidecar, &planned.run_id);
    let prepared: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(&journal).expect("read prepared command journal"))
            .expect("parse prepared command journal");
    assert_eq!(prepared["status"], "prepared");

    let delete_root = root.clone();
    let delete_run_id = planned.run_id.clone();
    let (delete_attempted_tx, delete_attempted_rx) = mpsc::channel();
    let (delete_done_tx, delete_done_rx) = mpsc::channel();
    let deletion = std::thread::spawn(move || {
        delete_attempted_tx
            .send(())
            .expect("announce deletion attempt");
        let result = Engine::delete_run(
            &delete_root,
            &delete_run_id,
            RunDeletionMode::PreserveBranches,
        );
        delete_done_tx
            .send(result.as_ref().map(|_| ()).map_err(ToString::to_string))
            .expect("publish deletion result");
        result
    });
    delete_attempted_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("deletion thread entered");
    assert!(
        delete_done_rx.try_recv().is_err(),
        "deletion cannot pass a command's held authority barrier"
    );

    action
        .join()
        .expect("join command thread")
        .expect("command action reaches its durable boundary");
    let first_deletion = deletion.join().expect("join deletion thread");
    if first_deletion.is_err() {
        Engine::delete_run(&root, &planned.run_id, RunDeletionMode::PreserveBranches)
            .expect("retry deletion after the completed action journal becomes visible");
    }
    assert!(
        !sidecar
            .join("command-authority")
            .join(&planned.run_id)
            .exists(),
        "completed deletion removes command authority only after the command boundary"
    );
    assert!(!sidecar.join("runs").join(&planned.run_id).exists());
}

#[test]
fn deleting_a_paused_planning_run_removes_its_detached_checkout_without_creating_refs() {
    let (_temp, root, _base) = canonical_fixture();
    let references = local_references(&root);
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Discard an unapproved plan",
        "HEAD",
        None,
    )
    .expect("plan disposable run");
    Engine::set_run_running(&root, &planned.run_id, false).expect("pause disposable planning run");
    let preview =
        Engine::inspect_run_deletion(&root, &planned.run_id).expect("planning deletion preview");
    assert!(preview.can_delete, "{:?}", preview.blockers);
    assert!(preview.owned_branches.is_empty());

    Engine::delete_run(&root, &planned.run_id, RunDeletionMode::PreserveBranches)
        .expect("delete planning run");
    assert!(!planned.planning_worktree.exists());
    assert_eq!(local_references(&root), references);
    assert!(
        !Engine::project_registry(&root)
            .expect("registry after planning deletion")
            .runs
            .contains_key(&planned.run_id)
    );
}

#[test]
fn run_deletion_refuses_dirty_worktrees_before_mutating_registry_state() {
    let (_temp, root, _base) = canonical_fixture();
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Protect uncommitted work",
        "HEAD",
        None,
    )
    .expect("plan protected run");
    let approved = Engine::approve_run(&root, &planned.run_id).expect("approve protected run");
    write(&approved.worktree, "uncommitted.txt", "do not discard\n");

    let preview =
        Engine::inspect_run_deletion(&root, &planned.run_id).expect("dirty deletion preview");
    assert!(!preview.can_delete);
    assert!(preview.dirty_worktrees.contains(&approved.worktree));
    assert!(
        Engine::delete_run(&root, &planned.run_id, RunDeletionMode::PreserveBranches,).is_err()
    );
    assert_eq!(
        Engine::project_registry(&root)
            .expect("registry remains")
            .runs[&planned.run_id]
            .status,
        RunRegistrationStatus::Active
    );
    assert!(approved.worktree.join("uncommitted.txt").exists());
}

#[test]
fn run_deletion_refuses_unproven_paths_in_the_owned_namespace() {
    let (_temp, root, _base) = canonical_fixture();
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Protect unknown namespace artifacts",
        "HEAD",
        None,
    )
    .expect("plan namespace-protection run");
    let approved =
        Engine::approve_run(&root, &planned.run_id).expect("approve namespace-protection run");
    Engine::set_run_running(&root, &planned.run_id, false).expect("pause namespace-protection run");
    let namespace_root = approved
        .worktree
        .parent()
        .expect("integration worktree has namespace root");
    write(namespace_root, "foreign.txt", "not compiler-owned\n");

    let preview =
        Engine::inspect_run_deletion(&root, &planned.run_id).expect("namespace deletion preview");
    assert!(!preview.can_delete);
    assert!(
        preview
            .blockers
            .iter()
            .any(|blocker| blocker.contains("unproven path")),
        "{:?}",
        preview.blockers
    );
    assert!(
        Engine::delete_run(&root, &planned.run_id, RunDeletionMode::PreserveBranches,).is_err()
    );
    assert!(namespace_root.join("foreign.txt").exists());
}

#[test]
fn explicit_owned_branch_deletion_removes_only_the_run_namespace() {
    let (_temp, root, _base) = canonical_fixture();
    let planned = Engine::plan_run(
        &root,
        Some("canonical"),
        "Delete owned refs explicitly",
        "HEAD",
        None,
    )
    .expect("plan branch-deletion run");
    let approved =
        Engine::approve_run(&root, &planned.run_id).expect("approve branch-deletion run");
    Engine::set_run_running(&root, &planned.run_id, false).expect("pause branch-deletion run");
    Engine::delete_run(&root, &planned.run_id, RunDeletionMode::DeleteOwnedBranches)
        .expect("delete proven owned branches");
    let repository = Repository::discover(&root).expect("open repository");
    assert!(repository.find_reference(&approved.branch).is_err());
    assert!(repository.find_reference("refs/heads/main").is_ok());
}
