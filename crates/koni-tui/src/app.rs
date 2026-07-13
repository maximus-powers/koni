use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, IsTerminal, stdout};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use koni_core::Engine;
use koni_core::git::GitBackend;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Rect;
use serde_json::Value;

use crate::codex_models::CodexModelCatalog;
use crate::configure::{ConfigDomain, ConfigResource};
use crate::help::{ConfigEditorMode, HelpTopic};
use crate::model::{
    ControlCenterModel, Dialog, Focus, Mode, RunAgentSetting, RunTypeOption,
    configured_orchestration_key_is_protected,
};
use crate::ui;

#[cfg(test)]
use crate::model::PROTECTED_CONFIGURED_ORCHESTRATION_KEYS;

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub root: PathBuf,
    pub refresh_interval: Duration,
    pub force_snapshot: bool,
}

impl Default for RunOptions {
    fn default() -> Self {
        Self {
            root: PathBuf::from("."),
            refresh_interval: Duration::from_secs(2),
            force_snapshot: false,
        }
    }
}

enum WorkerCommand {
    PlanRun {
        intake: crate::model::NewRunDraft,
    },
    ApproveRun {
        run_id: String,
    },
    ResumePlanning {
        run_id: String,
    },
    AnswerQuestion {
        operation_id: String,
        run_id: String,
        question_id: String,
        option_id: Option<String>,
        custom_answer: Option<String>,
    },
    ReviseQuestion {
        operation_id: String,
        run_id: String,
        question_id: String,
        option_id: Option<String>,
        custom_answer: Option<String>,
    },
    ResolveQuestions {
        run_id: String,
    },
    ExecuteAction {
        operation_id: String,
        run_id: String,
        action: String,
        params: BTreeMap<String, String>,
        execution_root: Option<PathBuf>,
        requires_ticket_worktree: bool,
        configured_ticket_review: bool,
    },
    UpdateOrchestration {
        run_id: String,
        running: Option<bool>,
        max_parallel: Option<usize>,
        unchained: Option<bool>,
    },
    SetRunRunning {
        run_id: String,
        running: bool,
    },
    InspectRunDeletion {
        run_id: String,
    },
    DeleteRun {
        run_id: String,
        mode: koni_core::RunDeletionMode,
    },
    StartExternalLoop {
        run_id: String,
        stage_id: String,
    },
    DriveExternalLoop {
        run_id: String,
        loop_id: String,
    },
    DriveStage {
        run_id: String,
        stage_id: String,
    },
    SuperviseRun {
        run_id: String,
    },
    RetrySupervisedStage {
        run_id: String,
        stage_id: String,
    },
    Shutdown,
}

enum RefreshCommand {
    Refresh,
    Shutdown,
}

struct WorkerHandle {
    mutation_tx: Sender<WorkerCommand>,
    refresh_tx: Sender<RefreshCommand>,
}

impl WorkerHandle {
    fn send(&self, command: WorkerCommand) -> anyhow::Result<()> {
        self.mutation_tx
            .send(command)
            .map_err(|_| anyhow::anyhow!("mutation worker stopped"))
    }

    fn refresh(&self) {
        let _ = self.refresh_tx.send(RefreshCommand::Refresh);
    }

    fn shutdown(&self) {
        let _ = self.mutation_tx.send(WorkerCommand::Shutdown);
        let _ = self.refresh_tx.send(RefreshCommand::Shutdown);
    }
}

struct RunPlannedEvent {
    intake: crate::model::NewRunDraft,
    planner: Option<koni_core::PlanningAgentRun>,
}

struct PlanningFinishedEvent {
    run_id: String,
    planner: Option<koni_core::PlanningAgentRun>,
}

struct ActionFinishedEvent {
    operation_id: String,
    run_id: String,
    action: String,
    result: serde_json::Value,
}

struct OrchestrationShortcut {
    running: Option<bool>,
    max_parallel: Option<usize>,
    unchained: Option<bool>,
    label: String,
}

struct QuestionAnsweredEvent {
    operation_id: String,
    run_id: String,
    submitted_question_id: String,
    answered: koni_core::AnsweredQuestion,
}

enum WorkerEvent {
    Snapshots(Vec<serde_json::Value>),
    RunPlanned(Box<RunPlannedEvent>),
    PlanningFinished(Box<PlanningFinishedEvent>),
    RunApproved(String),
    QuestionAnswered(Box<QuestionAnsweredEvent>),
    QuestionSubmissionFailed {
        run_id: String,
        error: String,
    },
    ActionFinished(Box<ActionFinishedEvent>),
    OrchestrationUpdated {
        run_id: String,
        state: koni_core::OrchestrationState,
    },
    RunLifecycleUpdated(koni_core::RunLifecycleUpdate),
    RunDeletionInspected(koni_core::RunDeletionPreview),
    RunDeleted(koni_core::RunDeletionResult),
    ExternalLoopUpdated {
        run_id: String,
        value: serde_json::Value,
    },
    PipelineStageDriven {
        run_id: String,
        stage_id: String,
    },
    QuestionsResolved {
        run_id: String,
        count: usize,
    },
    RunSupervised {
        run_id: String,
        tick: koni_core::RunSupervisionTick,
    },
    SupervisionError {
        run_id: String,
        error: String,
    },
    RefreshError(String),
    Error(String),
}

pub fn run(options: RunOptions) -> anyhow::Result<()> {
    let mut model = ControlCenterModel::load(&options.root)?;
    let snapshot = options.force_snapshot
        || !io::stdin().is_terminal()
        || !io::stdout().is_terminal()
        || std::env::var("TERM").as_deref() == Ok("dumb");
    if snapshot {
        println!("{}", plain_snapshot(&model));
        return Ok(());
    }

    let (workers, event_rx) = spawn_workers(model.root.clone());
    let mut terminal = TerminalSession::enter()?;
    let mut last_refresh = Instant::now();
    let mut refresh_in_flight = false;
    let mut supervision_in_flight = BTreeSet::new();
    let mut supervision_next_poll = BTreeMap::new();
    enqueue_automatic_supervision(
        &model,
        &workers,
        &mut supervision_in_flight,
        &mut supervision_next_poll,
        options.refresh_interval,
    );
    let tick = Duration::from_millis(100);
    loop {
        terminal.terminal.draw(|frame| ui::draw(frame, &model))?;
        while let Ok(update) = event_rx.try_recv() {
            match update {
                WorkerEvent::Snapshots(snapshots) => {
                    refresh_in_flight = false;
                    let selected_id = model.selected_run_id().map(ToOwned::to_owned);
                    let selected_ticket_id = model
                        .selected_ticket_value()
                        .and_then(|ticket| ticket.get("id"))
                        .and_then(serde_json::Value::as_str)
                        .map(ToOwned::to_owned);
                    model.runs = snapshots
                        .into_iter()
                        .map(crate::model::RunData::from_snapshot)
                        .collect();
                    model.selected_run = selected_id
                        .and_then(|selected_id| {
                            model.runs.iter().position(|run| {
                                run.summary.as_ref().map(|summary| summary.id.as_str())
                                    == Some(selected_id.as_str())
                            })
                        })
                        .unwrap_or_else(|| {
                            model.selected_run.min(model.runs.len().saturating_sub(1))
                        });
                    model.selected_ticket = selected_ticket_id
                        .and_then(|selected_ticket_id| {
                            model.visible_tickets().iter().position(|ticket| {
                                ticket.get("id").and_then(serde_json::Value::as_str)
                                    == Some(selected_ticket_id.as_str())
                            })
                        })
                        .unwrap_or_else(|| {
                            model
                                .selected_ticket
                                .min(model.visible_tickets().len().saturating_sub(1))
                        });
                    model.selected_question = model
                        .selected_question
                        .min(model.selected_pending_questions().len().saturating_sub(1));
                    model.normalize_conditional_focus();
                    model.sync_orchestration();
                    if model.status == "refreshing…" {
                        model.status = "refreshed".to_owned();
                    }
                    enqueue_automatic_supervision(
                        &model,
                        &workers,
                        &mut supervision_in_flight,
                        &mut supervision_next_poll,
                        options.refresh_interval,
                    );
                }
                WorkerEvent::RunPlanned(event) => {
                    let RunPlannedEvent { intake, planner } = *event;
                    apply_run_planned_dialog_completion(&mut model, &intake);
                    model.status = planner.as_ref().map_or_else(
                        || "planning initialized · select the run to review progress".to_owned(),
                        |planner| {
                            format!(
                                "planner {} · select the run to review durable output",
                                friendly_key(&planner.status)
                            )
                        },
                    );
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::RunApproved(id) => {
                    apply_approval_dialog_completion(&mut model, &id);
                    model.status = "✓ run approved · integration branch ready".to_owned();
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::PlanningFinished(event) => {
                    let PlanningFinishedEvent { run_id, planner } = *event;
                    apply_approval_dialog_completion(&mut model, &run_id);
                    model.status = planner.as_ref().map_or_else(
                        || "✓ planning updated · reopen review after refresh".to_owned(),
                        |planner| {
                            format!(
                                "✓ planner {} · reopen review after refresh",
                                friendly_key(&planner.status)
                            )
                        },
                    );
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::QuestionAnswered(event) => {
                    apply_question_answered_event(&mut model, &event);
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::QuestionSubmissionFailed { run_id, error } => {
                    apply_question_submission_failed(&mut model, &run_id, &error);
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::ActionFinished(event) => {
                    let ActionFinishedEvent {
                        operation_id,
                        run_id,
                        action,
                        result,
                    } = *event;
                    apply_action_finished_dialog_completion(
                        &mut model,
                        &operation_id,
                        &run_id,
                        &action,
                    );
                    let outcome = result
                        .get("status")
                        .and_then(serde_json::Value::as_str)
                        .map(friendly_key);
                    model.status = format!(
                        "✓ {} completed{}",
                        friendly_key(&action),
                        outcome
                            .map(|status| format!(" · {status}"))
                            .unwrap_or_default()
                    );
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::OrchestrationUpdated { run_id, state } => {
                    if model.selected_run_id() == Some(run_id.as_str()) {
                        model.orchestration_running = state.running;
                        model.max_parallel = state.max_parallel;
                        model.unchained = state.unchained;
                    }
                    model.status = "orchestration updated".to_owned();
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::RunLifecycleUpdated(update) => {
                    let message = update.message.clone();
                    model.apply_run_lifecycle_update(&update);
                    model.status = message;
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::RunDeletionInspected(preview) => {
                    model.open_run_deletion_preview(preview);
                    model.status = "run removal safety check complete".to_owned();
                }
                WorkerEvent::RunDeleted(result) => {
                    let removed_worktrees = result.removed_worktrees.len();
                    let branches = result.deleted_branches.len();
                    model.remove_run_data(&result.run_id);
                    model.status = format!(
                        "✓ run removed · {removed_worktrees} worktree(s) cleaned · {branches} owned branch(es) deleted"
                    );
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::ExternalLoopUpdated { run_id, value } => {
                    let selected = model.selected_run_id() == Some(run_id.as_str());
                    let phase = value
                        .get("phase")
                        .or_else(|| value.get("status"))
                        .and_then(serde_json::Value::as_str)
                        .map(friendly_key);
                    model.status = format!(
                        "✓ external loop advanced{}{}",
                        phase.map(|phase| format!(" · {phase}")).unwrap_or_default(),
                        if selected { "" } else { " · background run" }
                    );
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::PipelineStageDriven { run_id, stage_id } => {
                    model.status = format!(
                        "✓ {} stage completed{}",
                        friendly_key(&stage_id),
                        if model.selected_run_id() == Some(run_id.as_str()) {
                            ""
                        } else {
                            " · background run"
                        }
                    );
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::QuestionsResolved { run_id, count } => {
                    let background = if model.selected_run_id() == Some(run_id.as_str()) {
                        ""
                    } else {
                        " · background run"
                    };
                    model.status = if count == 0 {
                        format!("no automatic answers are due{background}")
                    } else {
                        format!("✓ resolved and resumed {count} question(s){background}")
                    };
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::RunSupervised { run_id, tick } => {
                    supervision_in_flight.remove(&run_id);
                    supervision_next_poll.insert(
                        run_id.clone(),
                        Instant::now() + supervision_poll_interval(options.refresh_interval),
                    );
                    if model.selected_run_id() == Some(run_id.as_str()) {
                        model.status = supervision_status(&tick);
                    }
                    workers.refresh();
                    refresh_in_flight = true;
                }
                WorkerEvent::SupervisionError { run_id, error } => {
                    supervision_in_flight.remove(&run_id);
                    supervision_next_poll.insert(
                        run_id.clone(),
                        Instant::now() + supervision_poll_interval(options.refresh_interval),
                    );
                    if model.selected_run_id() == Some(run_id.as_str()) {
                        model.status = format!("automatic supervision failed: {error}");
                    }
                }
                WorkerEvent::RefreshError(error) => {
                    refresh_in_flight = false;
                    model.status = format!("refresh failed: {error}");
                }
                WorkerEvent::Error(error) => {
                    let lifecycle_refresh = model.selected_run_transition().is_some();
                    if reset_dialog_after_worker_error(&mut model) {
                        workers.refresh();
                        refresh_in_flight = true;
                    }
                    model.status = error;
                    if lifecycle_refresh {
                        workers.refresh();
                        refresh_in_flight = true;
                    }
                }
            }
        }
        if last_refresh.elapsed() >= options.refresh_interval && !refresh_in_flight {
            workers.refresh();
            refresh_in_flight = true;
            last_refresh = Instant::now();
        }
        model.advance_activity_animation();
        if !event::poll(tick)? {
            continue;
        }
        match event::read()? {
            Event::Key(key) => {
                if handle_key(&mut model, key, &workers)? {
                    break;
                }
            }
            Event::Mouse(mouse) => {
                if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                    handle_mouse(
                        &mut model,
                        mouse.column,
                        mouse.row,
                        terminal.terminal.size()?,
                    );
                } else if mouse.kind == MouseEventKind::ScrollDown {
                    scroll_at(
                        &mut model,
                        mouse.column,
                        mouse.row,
                        terminal.terminal.size()?,
                        1,
                    );
                } else if mouse.kind == MouseEventKind::ScrollUp {
                    scroll_at(
                        &mut model,
                        mouse.column,
                        mouse.row,
                        terminal.terminal.size()?,
                        -1,
                    );
                }
            }
            Event::Paste(text) => handle_paste(&mut model, &text),
            Event::Resize(_, _) | Event::FocusGained | Event::FocusLost => {}
        }
    }
    workers.shutdown();
    Ok(())
}

/// Open an interactive, read-only control-center projection without a project engine.
///
/// This is intentionally a developer/showcase surface: it exercises the same renderer and input
/// routing as a live dashboard while keeping every mutation channel disconnected from disk and
/// model execution. It is useful for populated visual regression checks that must not spend
/// tokens or alter a real run.
pub fn run_read_only_snapshot(root: PathBuf, snapshot: Value) -> anyhow::Result<()> {
    let mut model = ControlCenterModel::from_snapshot(root, snapshot);
    model.status = "read-only showcase · no models or project mutations".to_owned();
    if !io::stdin().is_terminal()
        || !io::stdout().is_terminal()
        || std::env::var("TERM").as_deref() == Ok("dumb")
    {
        println!("{}", plain_snapshot(&model));
        return Ok(());
    }

    let (mutation_tx, _mutation_rx) = mpsc::channel();
    let (refresh_tx, _refresh_rx) = mpsc::channel();
    let workers = WorkerHandle {
        mutation_tx,
        refresh_tx,
    };
    let mut terminal = TerminalSession::enter()?;
    let tick = Duration::from_millis(100);
    loop {
        terminal.terminal.draw(|frame| ui::draw(frame, &model))?;
        model.advance_activity_animation();
        if !event::poll(tick)? {
            continue;
        }
        match event::read()? {
            Event::Key(key) => {
                if handle_key(&mut model, key, &workers)? {
                    break;
                }
            }
            Event::Mouse(mouse) => {
                if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                    handle_mouse(
                        &mut model,
                        mouse.column,
                        mouse.row,
                        terminal.terminal.size()?,
                    );
                } else if mouse.kind == MouseEventKind::ScrollDown {
                    scroll_at(
                        &mut model,
                        mouse.column,
                        mouse.row,
                        terminal.terminal.size()?,
                        1,
                    );
                } else if mouse.kind == MouseEventKind::ScrollUp {
                    scroll_at(
                        &mut model,
                        mouse.column,
                        mouse.row,
                        terminal.terminal.size()?,
                        -1,
                    );
                }
            }
            Event::Paste(text) => handle_paste(&mut model, &text),
            Event::Resize(_, _) | Event::FocusGained | Event::FocusLost => {}
        }
    }
    Ok(())
}

fn action_execution_root<'a>(
    project_root: &'a Path,
    configured_root: Option<&'a Path>,
    requires_ticket_worktree: bool,
) -> Result<&'a Path, String> {
    if requires_ticket_worktree {
        return configured_root.ok_or_else(|| {
            "ticket-worktree action refused: the selected ticket has no active worktree".to_owned()
        });
    }
    Ok(configured_root.unwrap_or(project_root))
}

fn open_action_engine(root: &Path, run_id: &str) -> koni_core::Result<Engine> {
    let git = GitBackend::discover(root)?;
    if git.sidecar_root().join("project.yaml").exists() {
        // Once a registry exists, every membership, snapshot, and integrity error from
        // `open_run` is authoritative and must fail closed.
        return Engine::open_run(root, run_id);
    }

    // Compatibility state is eligible only when this repository has never adopted the project
    // registry. Avoid probing `open_run` first because loading an absent registry creates one.
    let engine = Engine::open(root)?;
    if engine.inspect()?.run_id == run_id {
        Ok(engine)
    } else {
        Err(koni_core::KoniError::NotFound(
            "selected compatibility run".to_owned(),
        ))
    }
}

fn spawn_workers(root: PathBuf) -> (WorkerHandle, Receiver<WorkerEvent>) {
    let (mutation_tx, command_rx) = mpsc::channel();
    let (refresh_tx, refresh_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel();
    let mutation_events = event_tx.clone();
    let mutation_root = root.clone();
    thread::spawn(move || {
        while let Ok(command) = command_rx.recv() {
            let result = match command {
                WorkerCommand::PlanRun { intake } => {
                    let root = mutation_root.clone();
                    let events = mutation_events.clone();
                    thread::spawn(move || {
                        let event = planning_intake_value(&intake)
                            .and_then(|intake_value| {
                                Engine::plan_run_with_overrides(
                                    &root,
                                    Some(&intake.run_type),
                                    &intake.goal,
                                    &intake.base_ref,
                                    Some(&intake.question_policy),
                                    &run_plan_overrides(&intake),
                                )
                                .and_then(|planned| {
                                    let planner = Engine::record_planning_intake(
                                        &root,
                                        &planned.run_id,
                                        intake_value,
                                    )?;
                                    Ok(WorkerEvent::RunPlanned(Box::new(RunPlannedEvent {
                                        intake,
                                        planner,
                                    })))
                                })
                            })
                            .unwrap_or_else(|error| WorkerEvent::Error(error.to_string()));
                        let _ = events.send(event);
                    });
                    continue;
                }
                WorkerCommand::ApproveRun { run_id } => {
                    { Engine::approve_run(&mutation_root, &run_id) }
                        .map(|approved| WorkerEvent::RunApproved(approved.run_id))
                        .map_err(|error| error.to_string())
                }
                WorkerCommand::ResumePlanning { run_id } => {
                    let root = mutation_root.clone();
                    let events = mutation_events.clone();
                    thread::spawn(move || {
                        let event = Engine::resume_planning_agent(&root, &run_id)
                            .map(|planner| {
                                WorkerEvent::PlanningFinished(Box::new(PlanningFinishedEvent {
                                    run_id,
                                    planner,
                                }))
                            })
                            .unwrap_or_else(|error| WorkerEvent::Error(error.to_string()));
                        let _ = events.send(event);
                    });
                    continue;
                }
                WorkerCommand::AnswerQuestion {
                    operation_id,
                    run_id,
                    question_id,
                    option_id,
                    custom_answer,
                } => {
                    let root = mutation_root.clone();
                    let events = mutation_events.clone();
                    thread::spawn(move || {
                        let submitted_question_id = question_id.clone();
                        let event = match Engine::answer_question(
                            &root,
                            &run_id,
                            &question_id,
                            option_id.as_deref(),
                            custom_answer.as_deref(),
                        ) {
                            Ok(answered) => {
                                WorkerEvent::QuestionAnswered(Box::new(QuestionAnsweredEvent {
                                    operation_id,
                                    run_id,
                                    submitted_question_id,
                                    answered,
                                }))
                            }
                            Err(error) => WorkerEvent::QuestionSubmissionFailed {
                                run_id,
                                error: error.to_string(),
                            },
                        };
                        let _ = events.send(event);
                    });
                    continue;
                }
                WorkerCommand::ReviseQuestion {
                    operation_id,
                    run_id,
                    question_id,
                    option_id,
                    custom_answer,
                } => {
                    let root = mutation_root.clone();
                    let events = mutation_events.clone();
                    thread::spawn(move || {
                        let submitted_question_id = question_id.clone();
                        let event = match Engine::revise_planning_batch_answer(
                            &root,
                            &run_id,
                            &question_id,
                            option_id.as_deref(),
                            custom_answer.as_deref(),
                        ) {
                            Ok(answered) => {
                                WorkerEvent::QuestionAnswered(Box::new(QuestionAnsweredEvent {
                                    operation_id,
                                    run_id,
                                    submitted_question_id,
                                    answered,
                                }))
                            }
                            Err(error) => WorkerEvent::QuestionSubmissionFailed {
                                run_id,
                                error: error.to_string(),
                            },
                        };
                        let _ = events.send(event);
                    });
                    continue;
                }
                WorkerCommand::ResolveQuestions { run_id } => {
                    let event_run_id = run_id.clone();
                    Engine::resolve_due_questions(&mutation_root, &run_id)
                        .map(|resolved| WorkerEvent::QuestionsResolved {
                            run_id: event_run_id,
                            count: resolved.len(),
                        })
                        .map_err(|error| error.to_string())
                }
                WorkerCommand::ExecuteAction {
                    operation_id,
                    run_id,
                    action,
                    params,
                    execution_root,
                    requires_ticket_worktree,
                    configured_ticket_review,
                } => {
                    let event_run_id = run_id.clone();
                    let event_action = action.clone();
                    action_execution_root(
                        &mutation_root,
                        execution_root.as_deref(),
                        requires_ticket_worktree,
                    )
                    .and_then(|root| {
                        let mut engine =
                            open_action_engine(root, &run_id).map_err(|error| error.to_string())?;
                        if configured_ticket_review {
                            let ticket = params
                                .get("ticket")
                                .or_else(|| params.get("ticket_id"))
                                .ok_or_else(|| {
                                "configured review has no selected ticket".to_owned()
                            })?;
                            engine
                                .review_ticket(ticket)
                                .map_err(|error| error.to_string())
                        } else {
                            engine
                                .execute_action(&action, params)
                                .map_err(|error| error.to_string())
                        }
                    })
                    .map(|result| {
                        WorkerEvent::ActionFinished(Box::new(ActionFinishedEvent {
                            operation_id,
                            run_id: event_run_id,
                            action: event_action,
                            result,
                        }))
                    })
                }
                WorkerCommand::UpdateOrchestration {
                    run_id,
                    running,
                    max_parallel,
                    unchained,
                } => Engine::update_orchestration(
                    &mutation_root,
                    &run_id,
                    running,
                    max_parallel,
                    unchained,
                )
                .map(|state| WorkerEvent::OrchestrationUpdated { run_id, state })
                .map_err(|error| error.to_string()),
                WorkerCommand::SetRunRunning { run_id, running } => {
                    Engine::set_run_running(&mutation_root, &run_id, running)
                        .map(WorkerEvent::RunLifecycleUpdated)
                        .map_err(|error| error.to_string())
                }
                WorkerCommand::InspectRunDeletion { run_id } => {
                    Engine::inspect_run_deletion(&mutation_root, &run_id)
                        .map(WorkerEvent::RunDeletionInspected)
                        .map_err(|error| error.to_string())
                }
                WorkerCommand::DeleteRun { run_id, mode } => {
                    Engine::delete_run(&mutation_root, &run_id, mode)
                        .map(WorkerEvent::RunDeleted)
                        .map_err(|error| error.to_string())
                }
                WorkerCommand::StartExternalLoop { run_id, stage_id } => {
                    let event_run_id = run_id.clone();
                    Engine::start_external_loop(&mutation_root, &run_id, &stage_id)
                        .and_then(|state| {
                            serde_json::to_value(state).map_err(|source| {
                                koni_core::KoniError::Json {
                                    path: PathBuf::from("<external-loop-state>"),
                                    source,
                                }
                            })
                        })
                        .map(|value| WorkerEvent::ExternalLoopUpdated {
                            run_id: event_run_id,
                            value,
                        })
                        .map_err(|error| error.to_string())
                }
                WorkerCommand::DriveExternalLoop { run_id, loop_id } => {
                    let event_run_id = run_id.clone();
                    Engine::drive_external_loop(&mutation_root, &run_id, &loop_id)
                        .and_then(|tick| {
                            serde_json::to_value(tick).map_err(|source| {
                                koni_core::KoniError::Json {
                                    path: PathBuf::from("<external-loop-tick>"),
                                    source,
                                }
                            })
                        })
                        .map(|value| WorkerEvent::ExternalLoopUpdated {
                            run_id: event_run_id,
                            value,
                        })
                        .map_err(|error| error.to_string())
                }
                WorkerCommand::DriveStage { run_id, stage_id } => {
                    let event_run_id = run_id.clone();
                    let event_stage_id = stage_id.clone();
                    Engine::drive_current_stage(&mutation_root, &run_id, &stage_id)
                        .map(|_| WorkerEvent::PipelineStageDriven {
                            run_id: event_run_id,
                            stage_id: event_stage_id,
                        })
                        .map_err(|error| error.to_string())
                }
                WorkerCommand::SuperviseRun { run_id } => {
                    let root = mutation_root.clone();
                    let events = mutation_events.clone();
                    let event_run_id = run_id.clone();
                    thread::spawn(move || {
                        let event = match Engine::supervise_run_once(&root, &run_id) {
                            Ok(tick) => WorkerEvent::RunSupervised {
                                run_id: event_run_id,
                                tick,
                            },
                            Err(error) => WorkerEvent::SupervisionError {
                                run_id: event_run_id,
                                error: error.to_string(),
                            },
                        };
                        let _ = events.send(event);
                    });
                    continue;
                }
                WorkerCommand::RetrySupervisedStage { run_id, stage_id } => {
                    let root = mutation_root.clone();
                    let events = mutation_events.clone();
                    let event_run_id = run_id.clone();
                    thread::spawn(move || {
                        let event = match Engine::retry_supervised_stage(&root, &run_id, &stage_id)
                            .and_then(|()| Engine::supervise_run_once(&root, &run_id))
                        {
                            Ok(tick) => WorkerEvent::RunSupervised {
                                run_id: event_run_id,
                                tick,
                            },
                            Err(error) => WorkerEvent::SupervisionError {
                                run_id: event_run_id,
                                error: error.to_string(),
                            },
                        };
                        let _ = events.send(event);
                    });
                    continue;
                }
                WorkerCommand::Shutdown => break,
            };
            let _ = mutation_events.send(result.unwrap_or_else(WorkerEvent::Error));
        }
    });
    thread::spawn(move || {
        while let Ok(command) = refresh_rx.recv() {
            match command {
                RefreshCommand::Refresh => {
                    let event = load_snapshots(&root)
                        .map(WorkerEvent::Snapshots)
                        .unwrap_or_else(|error| WorkerEvent::RefreshError(error.to_string()));
                    let _ = event_tx.send(event);
                }
                RefreshCommand::Shutdown => break,
            }
        }
    });
    (
        WorkerHandle {
            mutation_tx,
            refresh_tx,
        },
        event_rx,
    )
}

fn apply_run_planned_dialog_completion(
    model: &mut ControlCenterModel,
    intake: &crate::model::NewRunDraft,
) {
    if matches!(
        model.ordinary_dialog(),
        Some(Dialog::NewRun(current)) if current.operation_id == intake.operation_id
    ) {
        model.dismiss_ordinary_dialog();
    }
}

fn apply_approval_dialog_completion(model: &mut ControlCenterModel, run_id: &str) {
    if matches!(
        model.ordinary_dialog(),
        Some(Dialog::Approval(approval)) if approval.run_id == run_id
    ) {
        model.dismiss_ordinary_dialog();
    }
}

fn apply_action_finished_dialog_completion(
    model: &mut ControlCenterModel,
    operation_id: &str,
    run_id: &str,
    action: &str,
) {
    if matches!(
        model.ordinary_dialog(),
        Some(Dialog::ActionForm(form))
            if form.run_id == run_id
                && form.action == action
                && form.operation_id == operation_id
    ) {
        model.dismiss_ordinary_dialog();
    }
}

/// Returns whether a failed new-run submission was dismissed and needs a refresh.
fn reset_dialog_after_worker_error(model: &mut ControlCenterModel) -> bool {
    if matches!(model.ordinary_dialog(), Some(Dialog::NewRun(_))) {
        model.dismiss_ordinary_dialog();
        return true;
    }
    match model.ordinary_dialog_mut() {
        Some(Dialog::Approval(draft)) => draft.submitted = false,
        Some(Dialog::AnswerQuestion(draft)) => draft.submitted = false,
        Some(Dialog::ActionForm(draft)) => draft.submitted = false,
        Some(Dialog::DeleteRun(draft)) => draft.submitted = false,
        _ => {}
    }
    false
}

fn apply_question_answered(
    model: &mut ControlCenterModel,
    operation_id: &str,
    run_id: &str,
    question_id: &str,
    resume_deferred: bool,
    remaining_questions: usize,
    resumed_same_session: bool,
) {
    if matches!(
        model.ordinary_dialog(),
        Some(Dialog::AnswerQuestion(question))
            if question.run_id == run_id
                && question.question_id == question_id
                && question.operation_id == operation_id
    ) {
        model.dismiss_ordinary_dialog();
    }
    model.status = if resume_deferred {
        model.select_next_open_question_after(question_id);
        format!("✓ answer saved · {remaining_questions} remaining")
    } else if resumed_same_session {
        "✓ answer recorded · agent resumed in the same session".to_owned()
    } else {
        "✓ answer recorded · agent resumed".to_owned()
    };
}

fn apply_question_answered_event(model: &mut ControlCenterModel, event: &QuestionAnsweredEvent) {
    apply_question_answered(
        model,
        &event.operation_id,
        &event.run_id,
        &event.submitted_question_id,
        event.answered.resume_deferred,
        event.answered.remaining_questions,
        event.answered.resumed_same_session,
    );
}

fn apply_question_submission_failed(model: &mut ControlCenterModel, run_id: &str, error: &str) {
    if let Some(Dialog::AnswerQuestion(question)) = model.ordinary_dialog_mut()
        && question.run_id == run_id
    {
        question.submitted = false;
    }
    model.status = format!(
        "question update failed: {error} · reopen Pending Questions to retry{}",
        if model.selected_run_id() == Some(run_id) {
            ""
        } else {
            " · background run"
        }
    );
}

fn load_snapshots(root: &Path) -> koni_core::Result<Vec<serde_json::Value>> {
    crate::model::project_snapshots(root)
}

fn run_has_automatic_stage(run: &crate::model::RunData) -> bool {
    let Some(summary) = run.summary.as_ref() else {
        return false;
    };
    if summary.status != "active" {
        return false;
    }
    let Some(stage) = run.stages.iter().find(|stage| {
        !matches!(
            stage.get("status").and_then(serde_json::Value::as_str),
            Some("succeeded" | "skipped")
        )
    }) else {
        // A completed pipeline may still need the idempotent conclusion step
        // after a process restart between its final receipt and registry update.
        return run
            .snapshot
            .get("pipeline")
            .is_some_and(|pipeline| !pipeline.is_null());
    };
    if run
        .orchestration
        .as_ref()
        .and_then(|state| state.get("running"))
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return false;
    }
    if matches!(
        stage.get("status").and_then(serde_json::Value::as_str),
        Some("paused" | "blocked" | "failed")
    ) {
        return false;
    }
    let definition = stage.get("definition").unwrap_or(&serde_json::Value::Null);
    stage_definition_is_automatic(definition)
}

fn stage_definition_is_automatic(definition: &serde_json::Value) -> bool {
    match definition.get("kind").and_then(serde_json::Value::as_str) {
        Some("orchestration" | "agent_review" | "checkpoint") => true,
        Some("action") => {
            definition
                .get("config")
                .and_then(|config| config.get("automatic"))
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        }
        _ => false,
    }
}

fn enqueue_automatic_supervision(
    model: &ControlCenterModel,
    workers: &WorkerHandle,
    in_flight: &mut BTreeSet<String>,
    next_poll: &mut BTreeMap<String, Instant>,
    poll_interval: Duration,
) {
    let now = Instant::now();
    let poll_interval = supervision_poll_interval(poll_interval);
    for run in &model.runs {
        let Some(summary) = run.summary.as_ref() else {
            continue;
        };
        if !run_has_automatic_stage(run)
            || next_poll
                .get(&summary.id)
                .is_some_and(|deadline| *deadline > now)
            || !in_flight.insert(summary.id.clone())
        {
            continue;
        }
        if workers
            .send(WorkerCommand::SuperviseRun {
                run_id: summary.id.clone(),
            })
            .is_err()
        {
            in_flight.remove(&summary.id);
        } else {
            next_poll.insert(summary.id.clone(), now + poll_interval);
        }
    }
}

fn supervision_poll_interval(configured: Duration) -> Duration {
    configured.max(Duration::from_millis(250))
}

fn supervision_status(tick: &koni_core::RunSupervisionTick) -> String {
    let advanced = tick.advanced_stages.len();
    let prefix = match advanced {
        0 => String::new(),
        1 => "✓ advanced one automatic stage · ".to_owned(),
        count => format!("✓ advanced {count} automatic stages · "),
    };
    let state = match &tick.outcome {
        koni_core::RunSupervisionState::Complete => "workflow complete",
        koni_core::RunSupervisionState::Waiting { .. } => "automation is working",
        koni_core::RunSupervisionState::AwaitingOperator { .. } => "waiting for operator input",
        koni_core::RunSupervisionState::Blocked { .. } => {
            "automation blocked · open Stages for recovery"
        }
    };
    format!("{prefix}{state}")
}

fn handle_key(
    model: &mut ControlCenterModel,
    key: KeyEvent,
    worker: &WorkerHandle,
) -> anyhow::Result<bool> {
    if key.code == KeyCode::F(1) && !matches!(model.dialog, Some(Dialog::Help(_))) {
        let topic = contextual_help_topic(model);
        model.open_help(topic);
        return Ok(false);
    }
    if model.dialog.is_some() {
        return handle_dialog_key(model, key, worker);
    }
    if key.code == KeyCode::Char('h')
        && !key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        && !config_source_editor_active(model)
    {
        let topic = contextual_help_topic(model);
        model.open_help(topic);
        return Ok(false);
    }
    if model.mode == Mode::Configure && key.modifiers.contains(KeyModifiers::CONTROL) {
        match key.code {
            KeyCode::Char('s') => {
                match model.save_all_config_drafts() {
                    Ok(0) => model.status = "all configuration drafts are saved".to_owned(),
                    Ok(_) => {}
                    Err(error) => model.status = error.to_string(),
                }
                return Ok(false);
            }
            KeyCode::Char('p') => {
                if let Err(error) = model.publish_config() {
                    model.status = error.to_string();
                }
                return Ok(false);
            }
            _ => {}
        }
    }
    if config_source_editor_active(model) {
        match key.code {
            KeyCode::Esc => {
                model.config.close_linked_document_editor();
                model.focus = Focus::ConfigForm;
            }
            KeyCode::Tab => {
                model.config.close_linked_document_editor();
                model.cycle_focus(false);
            }
            KeyCode::BackTab => {
                model.config.close_linked_document_editor();
                model.cycle_focus(true);
            }
            KeyCode::Left => {
                if let Some(document) = model.config.selected_document_mut() {
                    document.move_cursor(0, -1);
                }
            }
            KeyCode::Right => {
                if let Some(document) = model.config.selected_document_mut() {
                    document.move_cursor(0, 1);
                }
            }
            KeyCode::Up => {
                if let Some(document) = model.config.selected_document_mut() {
                    document.move_cursor(-1, 0);
                }
            }
            KeyCode::Down => {
                if let Some(document) = model.config.selected_document_mut() {
                    document.move_cursor(1, 0);
                }
            }
            KeyCode::Enter => {
                if let Some(document) = model.config.selected_document_mut() {
                    document.newline();
                }
                refresh_config_source_projection(model);
            }
            KeyCode::Backspace => {
                if let Some(document) = model.config.selected_document_mut() {
                    document.backspace();
                }
                refresh_config_source_projection(model);
            }
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                if let Some(document) = model.config.selected_document_mut() {
                    document.insert_char(character);
                }
                refresh_config_source_projection(model);
            }
            _ => {}
        }
        return Ok(false);
    }

    if model.mode == Mode::Operate
        && !(model.focus == Focus::Runs && key.code == KeyCode::Char(' '))
        && let Some(shortcut) = configured_orchestration_shortcut(model, key)
        && let Some(run_id) = model.selected_run_id().map(ToOwned::to_owned)
    {
        worker.send(WorkerCommand::UpdateOrchestration {
            run_id,
            running: shortcut.running,
            max_parallel: shortcut.max_parallel,
            unchained: shortcut.unchained,
        })?;
        model.status = format!("updating orchestration · {}", shortcut.label);
        return Ok(false);
    }

    match key.code {
        KeyCode::Char('q') => match model.save_all_config_drafts() {
            Ok(_) => return Ok(true),
            Err(error) => {
                model.status = format!("quit cancelled; could not autosave drafts: {error}");
                return Ok(false);
            }
        },
        KeyCode::Char('r') => {
            worker.refresh();
            model.status = "refreshing…".to_owned();
        }
        KeyCode::Char('R') if model.mode == Mode::Operate && model.focus == Focus::Questions => {
            if let Some(run_id) = model.selected_run_id().map(ToOwned::to_owned) {
                worker.send(WorkerCommand::ResolveQuestions { run_id })?;
                model.status = "resolving due automatic questions…".to_owned();
            }
        }
        KeyCode::Char('c') => model.toggle_mode(),
        KeyCode::Char('1') if model.mode == Mode::Operate => model.focus_runs(),
        KeyCode::Char('2') if model.mode == Mode::Operate => model.focus_tickets(),
        KeyCode::Char('3') if model.mode == Mode::Operate => model.focus = Focus::Details,
        KeyCode::Char('4') if model.mode == Mode::Operate => model.focus = Focus::Agents,
        KeyCode::Char('5') if model.mode == Mode::Operate => model.focus = Focus::Graph,
        KeyCode::Char('n') if model.mode == Mode::Operate => model.open_new_run(),
        KeyCode::Char('?') if model.mode == Mode::Operate => model.open_selected_question(),
        KeyCode::Char('D') if model.mode == Mode::Operate && model.focus == Focus::Runs => {
            if let Some(run_id) = model.selected_run_id().map(ToOwned::to_owned) {
                worker.send(WorkerCommand::InspectRunDeletion { run_id })?;
                model.status =
                    "checking whether the selected run can be removed safely…".to_owned();
            }
        }
        KeyCode::Char('T') if model.mode == Mode::Configure => {
            model.open_run_type_wizard();
        }
        KeyCode::Char('L') if model.mode == Mode::Configure && model.legacy_migration_available => {
            model.open_legacy_migration();
        }
        KeyCode::Char('N')
            if model.mode == Mode::Configure
                && model.focus == Focus::ConfigForm
                && model.config.selected_domain() == ConfigDomain::Advanced =>
        {
            model.open_new_config_document();
        }
        KeyCode::Char('M')
            if model.mode == Mode::Configure
                && model.focus == Focus::ConfigForm
                && model.config.selected_domain() == ConfigDomain::Advanced =>
        {
            model.open_rename_config_document();
        }
        KeyCode::Char('D')
            if model.mode == Mode::Configure
                && model.focus == Focus::ConfigForm
                && model.config.selected_domain() == ConfigDomain::Advanced =>
        {
            if let Err(error) = model.toggle_delete_config_document() {
                model.status = error.to_string();
            }
        }
        KeyCode::Char('a') if model.mode == Mode::Operate => model.open_action_palette(),
        KeyCode::Enter if model.mode == Mode::Operate && model.focus == Focus::Runs => {
            model.open_selected_run_approval();
        }
        KeyCode::Enter if model.mode == Mode::Operate && model.focus == Focus::Questions => {
            model.open_selected_question();
        }
        KeyCode::Enter
            if model.mode == Mode::Operate
                && model.focus == Focus::Details
                && model.detail_panel == crate::model::Panel::Stages =>
        {
            if let Some(run) = model.selected_run_data()
                && let Some(run_id) = run.summary.as_ref().map(|summary| summary.id.clone())
                && let Some(stage) = run.stages.iter().find(|stage| {
                    !matches!(
                        stage.get("status").and_then(serde_json::Value::as_str),
                        Some("succeeded" | "skipped")
                    )
                })
            {
                let planning_run = run
                    .summary
                    .as_ref()
                    .is_some_and(|summary| summary.status == "planning");
                let definition = stage.get("definition").unwrap_or(&serde_json::Value::Null);
                let stage_id = definition
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let stage_title = definition
                    .get("title")
                    .and_then(serde_json::Value::as_str)
                    .filter(|title| !title.trim().is_empty())
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| friendly_key(&stage_id));
                let kind = definition
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let status = stage
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let automatic = !planning_run && stage_definition_is_automatic(definition);
                if automatic && matches!(status.as_str(), "blocked" | "failed") {
                    worker.send(WorkerCommand::RetrySupervisedStage {
                        run_id,
                        stage_id: stage_id.clone(),
                    })?;
                    model.status = "retrying the recovered automatic stage…".to_owned();
                } else if matches!(status.as_str(), "blocked" | "failed") {
                    model.status =
                        format!("{stage_title} is {status}; inspect its terminal reason");
                } else if automatic {
                    worker.send(WorkerCommand::SuperviseRun { run_id })?;
                    model.status = "advancing automatic workflow…".to_owned();
                } else if kind == "external_loop" {
                    let config = definition
                        .get("config")
                        .and_then(|config| config.get("external_loop").or(Some(config)))
                        .unwrap_or(&serde_json::Value::Null);
                    let loop_id = config
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(stage_id.as_str());
                    if run.external_loops.iter().any(|state| {
                        state.get("id").and_then(serde_json::Value::as_str) == Some(loop_id)
                    }) {
                        worker.send(WorkerCommand::DriveExternalLoop {
                            run_id,
                            loop_id: loop_id.to_owned(),
                        })?;
                        model.status = "advancing external loop…".to_owned();
                    } else {
                        worker.send(WorkerCommand::StartExternalLoop {
                            run_id,
                            stage_id: stage_id.clone(),
                        })?;
                        model.status = "starting external loop…".to_owned();
                    }
                } else if matches!(kind.as_str(), "manual" | "checkpoint") {
                    if planning_run {
                        model.open_selected_run_approval();
                    } else {
                        worker.send(WorkerCommand::DriveStage {
                            run_id,
                            stage_id: stage_id.clone(),
                        })?;
                        model.status = format!("running {stage_title}…");
                    }
                } else if kind == "question" {
                    model.open_first_question();
                    if model.dialog.is_none() {
                        model.status = format!("{stage_title} is waiting for its durable question");
                    }
                } else if kind == "action" {
                    let action_id = definition
                        .get("config")
                        .and_then(|config| config.get("action"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    if action_id.is_empty() {
                        model.open_selected_run_approval();
                    } else if let Some(form) = model.action_form(&action_id) {
                        model.dialog = Some(Dialog::ActionForm(form));
                    } else {
                        model.status = format!("{stage_title} has no configured action form");
                    }
                } else {
                    model.status = format!("{stage_title} uses its planning or approval control");
                }
            }
        }
        KeyCode::Enter if model.mode == Mode::Configure && model.focus == Focus::ConfigForm => {
            if model.config.selected_resource().is_some() {
                model.focus = Focus::Yaml;
            } else {
                model.status = "this section has no configured resources yet".to_owned();
            }
        }
        KeyCode::Enter if model.mode == Mode::Configure && model.focus == Focus::ConfigTree => {
            if model.config.selected_resource().is_some() {
                model.focus = Focus::ConfigForm;
            } else {
                model.status = "this section has no configured resources yet".to_owned();
            }
        }
        KeyCode::Enter if model.mode == Mode::Configure && model.focus == Focus::Yaml => {
            if model.config.selected_resource().is_some() {
                model.open_form_editor();
            } else {
                model.status = "this section has no configured resources yet".to_owned();
            }
        }
        KeyCode::Esc if model.mode == Mode::Configure && model.focus == Focus::Yaml => {
            model.focus = Focus::ConfigForm;
        }
        KeyCode::Tab => model.cycle_focus(false),
        KeyCode::BackTab => model.cycle_focus(true),
        KeyCode::Char('[') => match model.focus {
            Focus::Tickets => model.cycle_ticket_tab(-1),
            Focus::Details => model.cycle_detail_panel(-1),
            Focus::Questions => model.select_next_question(-1),
            _ => {}
        },
        KeyCode::Char(']') => match model.focus {
            Focus::Tickets => model.cycle_ticket_tab(1),
            Focus::Details => model.cycle_detail_panel(1),
            Focus::Questions => model.select_next_question(1),
            _ => {}
        },
        KeyCode::Char(' ') if model.mode == Mode::Operate && model.focus == Focus::Runs => {
            if model.selected_run_transition().is_some() {
                model.status = "the selected run is already changing play/pause state…".to_owned();
            } else if let Some(run_id) = model.selected_run_id().map(ToOwned::to_owned) {
                let running = !model.selected_run_running();
                worker.send(WorkerCommand::SetRunRunning { run_id, running })?;
                model.mark_selected_run_transition(running);
                model.status = if running {
                    "resuming the selected run…".to_owned()
                } else {
                    "pausing the selected run safely…".to_owned()
                };
            }
        }
        KeyCode::Char(' ') if model.mode == Mode::Operate => {
            if !orchestration_available(model) {
                model.status =
                    "orchestration controls become available on approved multi-run projects"
                        .to_owned();
            } else if let Some(run_id) = model.selected_run_id().map(ToOwned::to_owned) {
                worker.send(WorkerCommand::UpdateOrchestration {
                    run_id,
                    running: Some(!model.orchestration_running),
                    max_parallel: None,
                    unchained: None,
                })?;
                model.status = "updating orchestration…".to_owned();
            }
        }
        KeyCode::Char('+') | KeyCode::Char('=') if model.mode == Mode::Operate => {
            if !orchestration_available(model) {
                model.status =
                    "orchestration controls become available on approved multi-run projects"
                        .to_owned();
            } else if let Some(run_id) = model.selected_run_id().map(ToOwned::to_owned) {
                worker.send(WorkerCommand::UpdateOrchestration {
                    run_id,
                    running: None,
                    max_parallel: Some(model.max_parallel.saturating_add(1).min(32)),
                    unchained: Some(false),
                })?;
            }
        }
        KeyCode::Char('-') if model.mode == Mode::Operate => {
            if !orchestration_available(model) {
                model.status =
                    "orchestration controls become available on approved multi-run projects"
                        .to_owned();
            } else if let Some(run_id) = model.selected_run_id().map(ToOwned::to_owned) {
                worker.send(WorkerCommand::UpdateOrchestration {
                    run_id,
                    running: None,
                    max_parallel: Some(model.max_parallel.saturating_sub(1).max(1)),
                    unchained: Some(false),
                })?;
            }
        }
        KeyCode::Char('p') if model.mode == Mode::Operate => {
            if !orchestration_available(model) {
                model.status =
                    "orchestration controls become available on approved multi-run projects"
                        .to_owned();
            } else if let Some(run_id) = model.selected_run_id().map(ToOwned::to_owned) {
                let (parallel, unchained) = if model.unchained {
                    (3, false)
                } else if model.max_parallel <= 3 {
                    (5, false)
                } else {
                    (model.max_parallel, true)
                };
                worker.send(WorkerCommand::UpdateOrchestration {
                    run_id,
                    running: None,
                    max_parallel: Some(parallel),
                    unchained: Some(unchained),
                })?;
            }
        }
        KeyCode::Up | KeyCode::Char('k') => move_focused(model, -1),
        KeyCode::Down | KeyCode::Char('j') => move_focused(model, 1),
        KeyCode::PageUp => scroll_focused(model, -8),
        KeyCode::PageDown => scroll_focused(model, 8),
        KeyCode::Left => {
            if model.focus == Focus::Tickets {
                model.cycle_ticket_tab(-1);
            } else if model.focus == Focus::Details {
                model.cycle_detail_panel(-1);
            } else if model.focus == Focus::Questions {
                model.select_next_question(-1);
            }
        }
        KeyCode::Right | KeyCode::Char('l') => {
            if model.focus == Focus::Tickets {
                model.cycle_ticket_tab(1);
            } else if model.focus == Focus::Details {
                model.cycle_detail_panel(1);
            } else if model.focus == Focus::Questions {
                model.select_next_question(1);
            }
        }
        _ => {}
    }
    Ok(false)
}

fn handle_dialog_key(
    model: &mut ControlCenterModel,
    key: KeyEvent,
    worker: &WorkerHandle,
) -> anyhow::Result<bool> {
    if key.code == KeyCode::Esc {
        model.close_dialog();
        return Ok(false);
    }
    if matches!(model.dialog, Some(Dialog::Help(_))) {
        if matches!(
            key.code,
            KeyCode::Char('h') | KeyCode::Char('q') | KeyCode::Enter | KeyCode::F(1)
        ) {
            model.close_dialog();
        }
        return Ok(false);
    }
    let intake_schemas = model.run_type_intake.clone();
    let run_types = model.run_types.clone();
    let codex_models = model.codex_models.clone();
    let Some(dialog) = model.dialog.as_mut() else {
        return Ok(false);
    };
    let mut close_dialog = false;
    match dialog {
        Dialog::Help(_) => {}
        Dialog::NewRun(draft) => {
            let fields = new_run_field_indices(draft);
            match key.code {
                _ if draft.submitted => {}
                KeyCode::Tab | KeyCode::Down => {
                    draft.active_field = (draft.active_field + 1) % fields.count;
                }
                KeyCode::BackTab | KeyCode::Up => {
                    draft.active_field = (draft.active_field + fields.count - 1) % fields.count;
                }
                KeyCode::Left | KeyCode::Right => {
                    let delta = if key.code == KeyCode::Left { -1 } else { 1 };
                    let active = draft.active_field;
                    if active == fields.run_type {
                        cycle_run_type(draft, &run_types, &intake_schemas, delta);
                    } else if active == fields.questions {
                        cycle_text_choice(
                            &mut draft.question_policy,
                            &[
                                "autonomous".to_owned(),
                                "high_impact_only".to_owned(),
                                "interactive".to_owned(),
                            ],
                            delta,
                        );
                        let inherited = run_types
                            .iter()
                            .find(|run_type| run_type.id == draft.run_type)
                            .map(|run_type| run_type.question_policy.as_str());
                        if inherited == Some(draft.question_policy.as_str()) {
                            draft.overridden_fields.remove("questions");
                        } else {
                            draft.overridden_fields.insert("questions".to_owned());
                        }
                    } else if active == fields.parallel {
                        cycle_parallelism(draft, &run_types, delta);
                    } else if active >= fields.agents && active < fields.submit {
                        let agent_control = active - fields.agents;
                        let field = if agent_control.is_multiple_of(2) {
                            AgentSettingField::Model
                        } else {
                            AgentSettingField::ReasoningEffort
                        };
                        cycle_agent_setting(
                            draft,
                            &run_types,
                            &codex_models,
                            NEW_RUN_AGENT_ROLES[agent_control / 2],
                            field,
                            delta,
                        );
                    } else if active > 0 && active <= draft.intake_fields.len() {
                        let field = &mut draft.intake_fields[active - 1];
                        let choices = if field.field_type == "boolean" {
                            vec!["true".to_owned(), "false".to_owned()]
                        } else {
                            field
                                .options
                                .iter()
                                .map(|option| option.label.clone())
                                .collect()
                        };
                        if !choices.is_empty() && field.field_type != "multi_choice" {
                            cycle_text_choice(&mut field.value, &choices, delta);
                        }
                    }
                }
                KeyCode::Home if draft.active_field == fields.run_type => {
                    if let Some(run_type) = run_types.first() {
                        apply_run_type(draft, run_type, &intake_schemas);
                    }
                }
                KeyCode::End if draft.active_field == fields.run_type => {
                    if let Some(run_type) = run_types.last() {
                        apply_run_type(draft, run_type, &intake_schemas);
                    }
                }
                KeyCode::Enter if draft.active_field == fields.submit => {
                    if let Some(missing) = draft
                        .intake_fields
                        .iter()
                        .find(|field| field.required && field.value.trim().is_empty())
                    {
                        model.status = format!("required intake field missing: {}", missing.label);
                    } else if draft.goal.trim().is_empty() {
                        model.status = "run goal is required".to_owned();
                    } else if let Err(error) = planning_intake_value(draft) {
                        model.status = error.to_string();
                    } else {
                        worker.send(WorkerCommand::PlanRun {
                            intake: draft.clone(),
                        })?;
                        draft.submitted = true;
                        close_dialog = true;
                        model.status = "starting planning…".to_owned();
                    }
                }
                KeyCode::Enter => {
                    draft.active_field = (draft.active_field + 1).min(fields.submit);
                }
                KeyCode::Backspace => {
                    if let Some(field) = active_run_field_mut(draft) {
                        field.pop();
                    }
                }
                KeyCode::Char(character)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    if let Some(field) = active_run_field_mut(draft) {
                        field.push(character);
                    }
                }
                _ => {}
            }
        }
        Dialog::Approval(approval) => match key.code {
            KeyCode::Left if !approval.submitted => approval.cycle_section(-1),
            KeyCode::Right if !approval.submitted => approval.cycle_section(1),
            KeyCode::Up if !approval.submitted => approval.scroll_by(-1),
            KeyCode::Down if !approval.submitted => approval.scroll_by(1),
            KeyCode::PageUp if !approval.submitted => approval.scroll_by(-8),
            KeyCode::PageDown if !approval.submitted => approval.scroll_by(8),
            KeyCode::Tab | KeyCode::BackTab if !approval.submitted => {
                approval.approve_focused = !approval.approve_focused;
            }
            KeyCode::Enter
                if !approval.submitted && approval.approve_focused && approval.approval_enabled =>
            {
                worker.send(WorkerCommand::ApproveRun {
                    run_id: approval.run_id.clone(),
                })?;
                approval.submitted = true;
                model.status = "creating approved run…".to_owned();
            }
            KeyCode::Enter
                if !approval.submitted
                    && approval.approve_focused
                    && !approval.approval_enabled =>
            {
                model.status = format!("approval unavailable · {}", approval.blockers.join(" · "));
            }
            KeyCode::Enter if !approval.submitted => {
                model.status =
                    "review the planning sections, then press Tab to focus Approve run".to_owned();
            }
            KeyCode::Char('r') if !approval.submitted => {
                worker.send(WorkerCommand::ResumePlanning {
                    run_id: approval.run_id.clone(),
                })?;
                approval.submitted = true;
                model.status = "running/resuming planning agent…".to_owned();
            }
            _ => {}
        },
        Dialog::AnswerQuestion(answer) => match key.code {
            KeyCode::Up
                if (!answer.pending_resume || answer.waiting_for_batch) && !answer.submitted =>
            {
                answer.selected = answer.selected.saturating_sub(1)
            }
            KeyCode::Down
                if (!answer.pending_resume || answer.waiting_for_batch) && !answer.submitted =>
            {
                answer.selected = answer
                    .selected
                    .saturating_add(1)
                    .min(answer.options.len().saturating_sub(1));
            }
            KeyCode::Tab
                if answer.allow_custom
                    && (!answer.pending_resume || answer.waiting_for_batch)
                    && !answer.submitted =>
            {
                answer.custom_active = !answer.custom_active;
            }
            KeyCode::Backspace
                if answer.custom_active
                    && (!answer.pending_resume || answer.waiting_for_batch)
                    && !answer.submitted =>
            {
                answer.custom.pop();
            }
            KeyCode::Char(character)
                if answer.custom_active
                    && (!answer.pending_resume || answer.waiting_for_batch)
                    && !answer.submitted =>
            {
                answer.custom.push(character)
            }
            KeyCode::Enter if !answer.submitted => {
                let custom_answer = answer
                    .custom_active
                    .then(|| answer.custom.trim().to_owned())
                    .filter(|answer| !answer.is_empty());
                let option_id = custom_answer.is_none().then(|| {
                    answer
                        .options
                        .get(answer.selected)
                        .map(|(id, _, _, _)| id.clone())
                        .unwrap_or_default()
                });
                let operation_id = answer.operation_id.clone();
                let run_id = answer.run_id.clone();
                let question_id = answer.question_id.clone();
                if answer.pending_resume && answer.waiting_for_batch {
                    worker.send(WorkerCommand::ReviseQuestion {
                        operation_id,
                        run_id,
                        question_id,
                        option_id,
                        custom_answer,
                    })?;
                } else {
                    worker.send(WorkerCommand::AnswerQuestion {
                        operation_id,
                        run_id,
                        question_id,
                        option_id,
                        custom_answer,
                    })?;
                }
                model.status = if answer.pending_resume && answer.waiting_for_batch {
                    "updating saved answer…".to_owned()
                } else if answer.batch_position.is_some() && answer.remaining_batch_questions > 1 {
                    format!(
                        "answer save requested · {} remaining",
                        answer.remaining_batch_questions - 1
                    )
                } else {
                    "planner resume requested · see Agents".to_owned()
                };
                close_dialog = true;
            }
            _ => {}
        },
        Dialog::ActionPalette(palette) => match key.code {
            KeyCode::Up => palette.selected = palette.selected.saturating_sub(1),
            KeyCode::Down => {
                let count = palette.filtered_actions().len();
                palette.selected = palette
                    .selected
                    .saturating_add(1)
                    .min(count.saturating_sub(1));
            }
            KeyCode::Backspace => {
                palette.filter.pop();
                palette.selected = 0;
            }
            KeyCode::Char(character) => {
                palette.filter.push(character);
                palette.selected = 0;
            }
            KeyCode::Enter => {
                if let Some(action) = palette
                    .filtered_actions()
                    .get(palette.selected)
                    .map(|action| (*action).to_owned())
                    && let Some(form) = model.action_form(&action)
                {
                    model.dialog = Some(Dialog::ActionForm(form));
                }
            }
            _ => {}
        },
        Dialog::EditScalar(edit) => match key.code {
            KeyCode::Left => edit.move_cursor_left(),
            KeyCode::Right => edit.move_cursor_right(),
            KeyCode::Home => edit.move_cursor_home(),
            KeyCode::End => edit.move_cursor_end(),
            KeyCode::Backspace => edit.backspace(),
            KeyCode::Delete => edit.delete(),
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                edit.insert_text(&character.to_string());
            }
            KeyCode::Enter => {
                let edit = edit.clone();
                if let Err(error) = model.apply_form_edit(&edit) {
                    model.status = error.to_string();
                } else {
                    model.dialog = None;
                }
            }
            _ => {}
        },
        Dialog::ActionForm(action) => match key.code {
            KeyCode::Tab | KeyCode::Down if !action.submitted => {
                if !action.params.is_empty() {
                    action.selected = (action.selected + 1) % action.params.len();
                }
            }
            KeyCode::BackTab | KeyCode::Up if !action.submitted => {
                if !action.params.is_empty() {
                    action.selected =
                        (action.selected + action.params.len() - 1) % action.params.len();
                }
            }
            KeyCode::Backspace if !action.submitted => {
                if let Some(param) = action.params.get_mut(action.selected)
                    && !param.locked
                {
                    param.value.pop();
                }
            }
            KeyCode::Char(character)
                if !action.submitted
                    && !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                if let Some(param) = action.params.get_mut(action.selected)
                    && !param.locked
                {
                    param.value.push(character);
                }
            }
            code if !action.submitted && matches!(code, KeyCode::Enter | KeyCode::F(5)) => {
                if let Some(missing) = action
                    .params
                    .iter()
                    .find(|param| param.required && param.value.trim().is_empty())
                {
                    model.status = format!("required action parameter missing: {}", missing.id);
                } else if action.requires_ticket_worktree && action.execution_root.is_none() {
                    model.status =
                        "action refused: the selected ticket has no active worktree".to_owned();
                } else {
                    let params = action
                        .params
                        .iter()
                        .filter(|param| !param.value.is_empty())
                        .map(|param| (param.id.clone(), param.value.clone()))
                        .collect();
                    worker.send(WorkerCommand::ExecuteAction {
                        operation_id: action.operation_id.clone(),
                        run_id: action.run_id.clone(),
                        action: action.action.clone(),
                        params,
                        execution_root: action.execution_root.clone(),
                        requires_ticket_worktree: action.requires_ticket_worktree,
                        configured_ticket_review: action.configured_ticket_review,
                    })?;
                    action.submitted = true;
                    model.status = format!("executing {}…", friendly_key(&action.action));
                }
            }
            _ => {}
        },
        Dialog::NewConfigDocument(draft) => match key.code {
            KeyCode::Backspace => {
                draft.relative_path.pop();
            }
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                draft.relative_path.push(character);
            }
            KeyCode::Enter => {
                let relative_path = draft.relative_path.clone();
                if let Err(error) = model.create_config_document(&relative_path) {
                    model.status = error.to_string();
                }
            }
            _ => {}
        },
        Dialog::RenameConfigDocument(draft) => match key.code {
            KeyCode::Backspace => {
                draft.relative_path.pop();
            }
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                draft.relative_path.push(character);
            }
            KeyCode::Enter => {
                let relative_path = draft.relative_path.clone();
                match model.rename_config_document(&relative_path) {
                    Ok(()) => model.dialog = None,
                    Err(error) => model.status = error.to_string(),
                }
            }
            _ => {}
        },
        Dialog::RunTypeWizard(draft) => {
            let mut submit = false;
            match key.code {
                KeyCode::Tab | KeyCode::Down => {
                    draft.active_field = (draft.active_field + 1) % 6;
                }
                KeyCode::BackTab | KeyCode::Up => {
                    draft.active_field = (draft.active_field + 5) % 6;
                }
                KeyCode::Left | KeyCode::Right if draft.active_field == 0 => {
                    let count = draft.templates.len();
                    if count > 0 {
                        let delta = if key.code == KeyCode::Left {
                            count - 1
                        } else {
                            1
                        };
                        draft.selected_template = (draft.selected_template + delta) % count;
                    }
                }
                KeyCode::Home if draft.active_field == 0 => draft.selected_template = 0,
                KeyCode::End if draft.active_field == 0 => {
                    draft.selected_template = draft.templates.len().saturating_sub(1);
                }
                KeyCode::Left | KeyCode::Right | KeyCode::Char(' ') if draft.active_field == 4 => {
                    draft.make_default = !draft.make_default;
                }
                KeyCode::Backspace if draft.active_field == 1 => {
                    draft.title.pop();
                    draft.sync_automatic_slug();
                }
                KeyCode::Backspace if draft.active_field == 2 => {
                    draft.slug.pop();
                    draft.slug_manually_edited = true;
                }
                KeyCode::Backspace if draft.active_field == 3 => {
                    draft.description.pop();
                }
                KeyCode::Char(character)
                    if !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
                {
                    match draft.active_field {
                        1 => {
                            draft.title.push(character);
                            draft.sync_automatic_slug();
                        }
                        2 => {
                            draft.slug.push(character);
                            draft.slug_manually_edited = true;
                        }
                        3 => draft.description.push(character),
                        _ => {}
                    }
                }
                KeyCode::Enter
                    if draft.active_field == 5 || key.modifiers.contains(KeyModifiers::CONTROL) =>
                {
                    submit = true;
                }
                KeyCode::F(5) => submit = true,
                KeyCode::Enter if draft.active_field == 4 => {
                    draft.make_default = !draft.make_default;
                    draft.active_field = 5;
                }
                KeyCode::Enter => draft.active_field = (draft.active_field + 1).min(5),
                _ => {}
            }
            if submit && let Err(error) = model.create_run_type_from_wizard() {
                model.status = error.to_string();
            }
        }
        Dialog::LegacyMigration(_) => {
            if key.code == KeyCode::Enter
                && let Err(error) = model.stage_legacy_migration()
            {
                model.status = error.to_string();
            }
        }
        Dialog::DeleteRun(draft) => match key.code {
            _ if draft.submitted => {}
            KeyCode::Up | KeyCode::BackTab => {
                draft.selected = (draft.selected + 2) % 3;
                draft.confirm_owned_branches = false;
            }
            KeyCode::Down | KeyCode::Tab => {
                draft.selected = (draft.selected + 1) % 3;
                draft.confirm_owned_branches = false;
            }
            KeyCode::Enter if draft.selected == 0 => model.dialog = None,
            KeyCode::Enter if !draft.preview.can_delete => {
                model.status = format!(
                    "run removal blocked by {} safety condition(s); pause live work and resolve dirty worktrees first",
                    draft.preview.blockers.len()
                );
            }
            KeyCode::Enter if draft.selected == 2 && !draft.confirm_owned_branches => {
                draft.confirm_owned_branches = true;
            }
            KeyCode::Enter => {
                let mode = if draft.selected == 2 {
                    koni_core::RunDeletionMode::DeleteOwnedBranches
                } else {
                    koni_core::RunDeletionMode::PreserveBranches
                };
                worker.send(WorkerCommand::DeleteRun {
                    run_id: draft.preview.run_id.clone(),
                    mode,
                })?;
                draft.submitted = true;
                model.status = "removing the selected run through the engine…".to_owned();
            }
            _ => {}
        },
    }
    if close_dialog {
        model.dialog = None;
    }
    Ok(false)
}

fn config_source_editor_active(model: &ControlCenterModel) -> bool {
    model.dialog.is_none()
        && model.mode == Mode::Configure
        && model.focus == Focus::Yaml
        && (model.config.linked_document_editor_active()
            || model
                .config
                .selected_resource()
                .is_some_and(|resource| resource.is_raw_source()))
}

fn refresh_config_source_projection(model: &mut ControlCenterModel) {
    if !model.config.linked_document_editor_active() {
        model.config.rebuild_projection();
    }
}

fn handle_paste(model: &mut ControlCenterModel, pasted: &str) {
    if config_source_editor_active(model) {
        if let Some(document) = model.config.selected_document_mut() {
            document.insert_text(pasted);
        }
        refresh_config_source_projection(model);
        return;
    }

    let normalized = pasted.replace("\r\n", "\n").replace('\r', "\n");
    let Some(dialog) = model.dialog.as_mut() else {
        return;
    };
    match dialog {
        Dialog::NewRun(draft) if !draft.submitted => {
            if let Some(field) = active_run_field_mut(draft) {
                field.push_str(&normalized);
            }
        }
        Dialog::AnswerQuestion(answer)
            if answer.allow_custom
                && answer.custom_active
                && (!answer.pending_resume || answer.waiting_for_batch) =>
        {
            answer.custom.push_str(&normalized);
        }
        Dialog::ActionPalette(palette) => {
            palette.filter.extend(
                normalized
                    .chars()
                    .filter(|character| !character.is_control()),
            );
            palette.selected = 0;
        }
        Dialog::EditScalar(edit) => edit.insert_text(&normalized),
        Dialog::ActionForm(action) => {
            if let Some(param) = action.params.get_mut(action.selected)
                && !param.locked
            {
                param.value.push_str(&normalized);
            }
        }
        Dialog::NewConfigDocument(draft) | Dialog::RenameConfigDocument(draft) => {
            draft.relative_path.extend(
                normalized
                    .chars()
                    .filter(|character| !character.is_control()),
            )
        }
        Dialog::RunTypeWizard(draft) => {
            let pasted = normalized
                .chars()
                .filter(|character| !character.is_control())
                .collect::<String>();
            match draft.active_field {
                1 => {
                    draft.title.push_str(&pasted);
                    draft.sync_automatic_slug();
                }
                2 => {
                    draft.slug.push_str(&pasted);
                    draft.slug_manually_edited = true;
                }
                3 => draft.description.push_str(&pasted),
                _ => {}
            }
        }
        Dialog::NewRun(_)
        | Dialog::Help(_)
        | Dialog::Approval(_)
        | Dialog::AnswerQuestion(_)
        | Dialog::LegacyMigration(_)
        | Dialog::DeleteRun(_) => {}
    }
}

fn contextual_help_topic(model: &ControlCenterModel) -> HelpTopic {
    match (model.mode, model.focus) {
        (Mode::Operate, Focus::Runs) => HelpTopic::Runs,
        (Mode::Operate, Focus::Tickets) => HelpTopic::Tickets,
        (Mode::Operate, Focus::Details) => HelpTopic::Details(model.detail_panel),
        (Mode::Operate, Focus::Questions) => HelpTopic::PendingQuestions,
        (Mode::Operate, Focus::Agents) => HelpTopic::Agents,
        (Mode::Operate, Focus::Graph) => HelpTopic::Graph,
        (Mode::Configure, Focus::ConfigTree) => HelpTopic::ConfigDomains,
        (Mode::Configure, Focus::ConfigForm) => HelpTopic::ConfigResources {
            domain: model.config.selected_domain(),
        },
        (Mode::Configure, Focus::Yaml) => {
            let resource = model.config.selected_resource();
            HelpTopic::ConfigEditor {
                domain: model.config.selected_domain(),
                resource_kind: resource.map(|resource| resource.kind),
                mode: if model.config.linked_document_editor_active() {
                    ConfigEditorMode::LinkedInstructions
                } else if resource.is_some_and(ConfigResource::is_raw_source) {
                    ConfigEditorMode::Source
                } else {
                    ConfigEditorMode::Guided
                },
            }
        }
        // Focus is normalized whenever the mode changes. Enumerating the transiently invalid
        // combinations keeps this match compiler-exhaustive when a new panel is introduced.
        (Mode::Operate, Focus::ConfigTree | Focus::ConfigForm | Focus::Yaml) => HelpTopic::Runs,
        (
            Mode::Configure,
            Focus::Runs
            | Focus::Tickets
            | Focus::Details
            | Focus::Questions
            | Focus::Agents
            | Focus::Graph,
        ) => HelpTopic::ConfigDomains,
    }
}

fn configured_orchestration_shortcut(
    model: &ControlCenterModel,
    key: KeyEvent,
) -> Option<OrchestrationShortcut> {
    if !orchestration_available(model) {
        return None;
    }
    if key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
    {
        return None;
    }
    let pressed = match key.code {
        KeyCode::Char(' ') => "space".to_owned(),
        KeyCode::Char(character) if !configured_orchestration_key_is_protected(character) => {
            character.to_string()
        }
        _ => return None,
    };
    let bindings = model
        .selected_run_data()?
        .snapshot
        .get("views")?
        .as_array()?
        .iter()
        .find(|view| {
            view.get("kind").and_then(serde_json::Value::as_str) == Some("controls")
                || view
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|id| id.contains("orchestration"))
        })?
        .get("options")?
        .get("keybindings")?
        .as_object()?;
    let control = bindings.iter().find_map(|(control, binding)| {
        (binding.as_str() == Some(pressed.as_str())).then_some(control.as_str())
    })?;
    match control {
        "toggle" => Some(OrchestrationShortcut {
            running: Some(!model.orchestration_running),
            max_parallel: None,
            unchained: None,
            label: if model.orchestration_running {
                "pause".to_owned()
            } else {
                "resume".to_owned()
            },
        }),
        "unchained" => Some(OrchestrationShortcut {
            running: None,
            max_parallel: None,
            unchained: Some(true),
            label: "unchained".to_owned(),
        }),
        parallel if parallel.starts_with("parallel_") => {
            let count = parallel.strip_prefix("parallel_")?.parse().ok()?;
            Some(OrchestrationShortcut {
                running: None,
                max_parallel: Some(count),
                unchained: Some(false),
                label: format!("parallel {count}"),
            })
        }
        _ => None,
    }
}

fn orchestration_available(model: &ControlCenterModel) -> bool {
    model.selected_run_data().is_some_and(|run| {
        run.orchestration.is_some()
            && run
                .summary
                .as_ref()
                .is_some_and(|summary| summary.status == "active")
    })
}

const NEW_RUN_AGENT_ROLES: [&str; 4] = ["planner", "lead", "ticket_worker", "reviewer"];

#[derive(Debug, Clone, Copy)]
struct NewRunFieldIndices {
    run_type: usize,
    questions: usize,
    parallel: usize,
    agents: usize,
    submit: usize,
    count: usize,
}

fn new_run_field_indices(draft: &crate::model::NewRunDraft) -> NewRunFieldIndices {
    let run_type = 1 + draft.intake_fields.len();
    let questions = run_type + 1;
    let parallel = questions + 1;
    let agents = parallel + 1;
    let submit = agents + NEW_RUN_AGENT_ROLES.len() * 2;
    NewRunFieldIndices {
        run_type,
        questions,
        parallel,
        agents,
        submit,
        count: submit + 1,
    }
}

fn active_run_field_mut(draft: &mut crate::model::NewRunDraft) -> Option<&mut String> {
    match draft.active_field {
        0 => Some(&mut draft.goal),
        index if index <= draft.intake_fields.len() => draft
            .intake_fields
            .get_mut(index - 1)
            .map(|field| &mut field.value),
        _ => None,
    }
}

fn cycle_parallelism(
    draft: &mut crate::model::NewRunDraft,
    run_types: &[RunTypeOption],
    delta: isize,
) {
    draft.max_parallel = draft.max_parallel.saturating_add_signed(delta).max(1);
    let inherited = run_types
        .iter()
        .find(|run_type| run_type.id == draft.run_type)
        .and_then(|run_type| run_type.max_parallel)
        .unwrap_or(1);
    if draft.max_parallel == inherited {
        draft.overridden_fields.remove("parallel");
    } else {
        draft.overridden_fields.insert("parallel".to_owned());
    }
}

#[derive(Debug, Clone, Copy)]
enum AgentSettingField {
    Model,
    ReasoningEffort,
}

impl AgentSettingField {
    fn marker(self, role: &str) -> String {
        let property = match self {
            Self::Model => "model",
            Self::ReasoningEffort => "reasoning_effort",
        };
        format!("agent:{role}:{property}")
    }

    fn value(self, setting: &RunAgentSetting) -> Option<String> {
        match self {
            Self::Model => setting.model.clone(),
            Self::ReasoningEffort => setting.reasoning_effort.clone(),
        }
    }

    fn set_value(self, setting: &mut RunAgentSetting, value: Option<String>) {
        match self {
            Self::Model => setting.model = value,
            Self::ReasoningEffort => setting.reasoning_effort = value,
        }
    }
}

fn cycle_agent_setting(
    draft: &mut crate::model::NewRunDraft,
    run_types: &[RunTypeOption],
    codex_models: &CodexModelCatalog,
    role: &str,
    field: AgentSettingField,
    delta: isize,
) {
    let current = draft
        .agent_roles
        .get(role)
        .and_then(|setting| field.value(setting));
    let mut choices = vec![None];
    match field {
        AgentSettingField::Model => {
            choices.extend(
                codex_models
                    .model_choices()
                    .map(|model| Some(model.to_owned())),
            );
            choices.extend(run_types.iter().filter_map(|run_type| {
                run_type
                    .agents
                    .get(role)
                    .and_then(|setting| setting.model.clone())
                    .map(Some)
            }));
        }
        AgentSettingField::ReasoningEffort => {
            let selected_model = draft
                .agent_roles
                .get(role)
                .and_then(|setting| setting.model.as_deref());
            choices.extend(
                codex_models
                    .reasoning_choices(selected_model)
                    .into_iter()
                    .map(Some),
            );
        }
    }
    choices.push(current.clone());
    let mut seen = BTreeSet::new();
    choices.retain(|choice| seen.insert(choice.clone()));
    if choices.is_empty() {
        return;
    }
    let index = choices
        .iter()
        .position(|choice| choice == &current)
        .unwrap_or_default();
    let next = (index as isize + delta).rem_euclid(choices.len() as isize) as usize;
    field.set_value(
        draft.agent_roles.entry(role.to_owned()).or_default(),
        choices[next].clone(),
    );
    if matches!(field, AgentSettingField::Model) {
        normalize_reasoning_for_model(draft, codex_models, role);
        sync_agent_override_marker(draft, run_types, role, AgentSettingField::ReasoningEffort);
    }
    sync_agent_override_marker(draft, run_types, role, field);
}

fn normalize_reasoning_for_model(
    draft: &mut crate::model::NewRunDraft,
    codex_models: &CodexModelCatalog,
    role: &str,
) {
    let Some(setting) = draft.agent_roles.get_mut(role) else {
        return;
    };
    let (Some(model), Some(reasoning)) = (&setting.model, &setting.reasoning_effort) else {
        return;
    };
    if !codex_models.supports_reasoning(model, reasoning) {
        setting.reasoning_effort = codex_models.preferred_reasoning(model);
    }
}

fn sync_agent_override_marker(
    draft: &mut crate::model::NewRunDraft,
    run_types: &[RunTypeOption],
    role: &str,
    field: AgentSettingField,
) {
    let inherited = run_types
        .iter()
        .find(|run_type| run_type.id == draft.run_type)
        .and_then(|run_type| run_type.agents.get(role))
        .and_then(|setting| field.value(setting));
    let key = field.marker(role);
    let selected = draft
        .agent_roles
        .get(role)
        .and_then(|setting| field.value(setting));
    if selected == inherited {
        draft.overridden_fields.remove(&key);
    } else {
        draft.overridden_fields.insert(key);
    }
}

fn cycle_run_type(
    draft: &mut crate::model::NewRunDraft,
    run_types: &[RunTypeOption],
    intake_schemas: &BTreeMap<String, Vec<crate::model::IntakeFieldDraft>>,
    delta: isize,
) {
    if run_types.is_empty() {
        return;
    }
    let current = run_types
        .iter()
        .position(|run_type| run_type.id == draft.run_type)
        .unwrap_or(0);
    let selected = (current as isize + delta).rem_euclid(run_types.len() as isize) as usize;
    apply_run_type(draft, &run_types[selected], intake_schemas);
}

fn apply_run_type(
    draft: &mut crate::model::NewRunDraft,
    run_type: &RunTypeOption,
    intake_schemas: &BTreeMap<String, Vec<crate::model::IntakeFieldDraft>>,
) {
    draft.run_type.clone_from(&run_type.id);
    draft.question_policy.clone_from(&run_type.question_policy);
    draft.max_parallel = run_type.max_parallel.unwrap_or(1);
    draft.agent_roles.clone_from(&run_type.agents);
    draft.overridden_fields.clear();
    draft.intake_fields = intake_schemas
        .get(&run_type.id)
        .cloned()
        .unwrap_or_default();
}

fn friendly_key(value: &str) -> String {
    let normalized = value.replace(['_', '-'], " ");
    let mut characters = normalized.chars();
    let Some(first) = characters.next() else {
        return "operation".to_owned();
    };
    first.to_uppercase().chain(characters).collect::<String>()
}

fn cycle_text_choice(value: &mut String, choices: &[String], delta: isize) {
    if choices.is_empty() {
        return;
    }
    let current = choices
        .iter()
        .position(|choice| choice == value)
        .unwrap_or_default();
    let next = (current as isize + delta).rem_euclid(choices.len() as isize) as usize;
    value.clone_from(&choices[next]);
}

fn planning_intake_value(
    draft: &crate::model::NewRunDraft,
) -> koni_core::Result<serde_json::Value> {
    let mut intake = serde_json::Map::from_iter([
        (
            "goal".to_owned(),
            serde_json::Value::String(draft.goal.clone()),
        ),
        (
            "run_type".to_owned(),
            serde_json::Value::String(draft.run_type.clone()),
        ),
        (
            "base_ref".to_owned(),
            serde_json::Value::String(draft.base_ref.clone()),
        ),
        (
            "question_policy".to_owned(),
            serde_json::Value::String(draft.question_policy.clone()),
        ),
    ]);
    for field in &draft.intake_fields {
        let raw = field.value.trim();
        if raw.is_empty() && !field.required {
            continue;
        }
        let value = match field.field_type.as_str() {
            "boolean" => serde_json::Value::Bool(raw.parse().map_err(|_| {
                koni_core::KoniError::Action(format!("{} must be true or false", field.label))
            })?),
            "integer" => {
                let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| {
                    koni_core::KoniError::Action(format!("{} must be an integer", field.label))
                })?;
                if value.as_i64().is_none() && value.as_u64().is_none() {
                    return Err(koni_core::KoniError::Action(format!(
                        "{} must be an integer",
                        field.label
                    )));
                }
                value
            }
            "number" => {
                let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| {
                    koni_core::KoniError::Action(format!("{} must be a number", field.label))
                })?;
                if !value.is_number() {
                    return Err(koni_core::KoniError::Action(format!(
                        "{} must be a number",
                        field.label
                    )));
                }
                value
            }
            "json" => serde_json::from_str(raw).map_err(|error| {
                koni_core::KoniError::Action(format!("{} must be valid JSON: {error}", field.label))
            })?,
            "multi_choice" => {
                let parsed_choices = serde_json::from_str::<serde_json::Value>(raw)
                    .ok()
                    .and_then(|value| value.as_array().cloned());
                let choices = if let Some(choices) = parsed_choices {
                    choices
                } else {
                    let labels = raw
                        .split(',')
                        .map(str::trim)
                        .filter(|choice| !choice.is_empty())
                        .collect::<Vec<_>>();
                    if labels
                        .iter()
                        .any(|choice| !field.options.iter().any(|option| option.label == *choice))
                    {
                        return Err(koni_core::KoniError::Action(format!(
                            "{} must contain only configured choices: {}",
                            field.label,
                            intake_option_labels(field)
                        )));
                    }
                    labels
                        .into_iter()
                        .filter_map(|choice| {
                            field
                                .options
                                .iter()
                                .find(|option| option.label == choice)
                                .map(|option| option.value.clone())
                        })
                        .collect()
                };
                if choices
                    .iter()
                    .any(|choice| !field.options.iter().any(|option| option.value == *choice))
                {
                    return Err(koni_core::KoniError::Action(format!(
                        "{} must contain only configured choices: {}",
                        field.label,
                        intake_option_labels(field)
                    )));
                }
                serde_json::Value::Array(choices)
            }
            "choice" => {
                let parsed = serde_json::from_str::<serde_json::Value>(raw).ok();
                let Some(option) = field
                    .options
                    .iter()
                    .find(|option| option.label == raw || parsed.as_ref() == Some(&option.value))
                else {
                    return Err(koni_core::KoniError::Action(format!(
                        "{} must be one of: {}",
                        field.label,
                        intake_option_labels(field)
                    )));
                };
                option.value.clone()
            }
            _ => serde_json::Value::String(field.value.clone()),
        };
        intake.insert(field.id.clone(), value);
    }
    Ok(serde_json::Value::Object(intake))
}

fn run_plan_overrides(draft: &crate::model::NewRunDraft) -> koni_core::RunPlanOverrides {
    let max_parallel = draft
        .overridden_fields
        .contains("parallel")
        .then_some(draft.max_parallel);
    let agent_roles = NEW_RUN_AGENT_ROLES
        .into_iter()
        .filter_map(|role| {
            let setting = draft.agent_roles.get(role)?;
            let model = draft
                .overridden_fields
                .contains(&AgentSettingField::Model.marker(role))
                .then(|| koni_core::AgentSettingOverride::from_effective(setting.model.clone()));
            let reasoning_effort = draft
                .overridden_fields
                .contains(&AgentSettingField::ReasoningEffort.marker(role))
                .then(|| {
                    koni_core::AgentSettingOverride::from_effective(
                        setting.reasoning_effort.clone(),
                    )
                });
            let settings = koni_core::AgentSettingsOverride {
                model,
                reasoning_effort,
            };
            (!settings.is_empty()).then(|| (role.to_owned(), settings))
        })
        .collect();
    koni_core::RunPlanOverrides {
        workflow_run_type: None,
        max_parallel,
        agent_roles,
    }
}

fn intake_option_labels(field: &crate::model::IntakeFieldDraft) -> String {
    field
        .options
        .iter()
        .map(|option| option.label.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn move_focused(model: &mut ControlCenterModel, delta: isize) {
    match model.focus {
        Focus::Runs => model.select_next_run(delta),
        Focus::Tickets => model.select_next_ticket(delta),
        Focus::Questions => model.select_next_question(delta),
        Focus::Agents => model.select_next_agent(delta),
        Focus::Graph => model.graph_scroll = model.graph_scroll.saturating_add_signed(delta),
        Focus::Details => model.detail_scroll = model.detail_scroll.saturating_add_signed(delta),
        Focus::ConfigTree => model.config.select_domain(delta),
        Focus::ConfigForm => model.config.select_resource(delta),
        Focus::Yaml if model.mode == Mode::Configure => {
            model.config.selected_form_row = model
                .config
                .selected_form_row
                .saturating_add_signed(delta)
                .min(model.config.form_rows.len().saturating_sub(1));
        }
        Focus::Yaml => {}
    }
}

fn scroll_focused(model: &mut ControlCenterModel, delta: isize) {
    match model.focus {
        Focus::Graph => model.graph_scroll = model.graph_scroll.saturating_add_signed(delta),
        Focus::Agents => model.select_next_agent(delta),
        Focus::Questions => model.select_next_question(delta),
        Focus::Details => model.detail_scroll = model.detail_scroll.saturating_add_signed(delta),
        Focus::Runs => model.select_next_run(delta),
        Focus::Tickets => model.select_next_ticket(delta),
        _ => move_focused(model, delta.signum()),
    }
}

fn scroll_at(
    model: &mut ControlCenterModel,
    column: u16,
    row: u16,
    size: ratatui::layout::Size,
    delta: isize,
) {
    // Dialogs are modal. In particular, scrolling over contextual help must not silently move the
    // selection or viewport that the operator will return to when the help closes.
    if model.dialog.is_some() {
        return;
    }
    if model.mode == Mode::Operate && row >= 4 && row < size.height.saturating_sub(1) {
        let layout = ui::operate_layout_with_questions(
            Rect::new(0, 4, size.width, size.height.saturating_sub(5)),
            !model.selected_pending_questions().is_empty(),
        );
        if layout
            .pending_questions
            .is_some_and(|questions| rect_contains(questions, column, row))
        {
            model.focus = Focus::Questions;
            model.select_next_question(delta);
            return;
        }
        if rect_contains(layout.active_agents, column, row) {
            model.focus = Focus::Agents;
            model.select_next_agent(delta);
            return;
        }
    }
    scroll_focused(model, delta);
}

fn handle_mouse(
    model: &mut ControlCenterModel,
    column: u16,
    row: u16,
    size: ratatui::layout::Size,
) {
    if model.dialog.is_some() {
        if let Some(hit) = ui::run_type_wizard_hit_at(model, column, row, size) {
            match hit {
                ui::RunTypeWizardHit::Template(index) => {
                    if let Some(Dialog::RunTypeWizard(draft)) = model.dialog.as_mut() {
                        draft.selected_template = index;
                        draft.active_field = 0;
                    }
                }
                ui::RunTypeWizardHit::Field(field) => {
                    if let Some(Dialog::RunTypeWizard(draft)) = model.dialog.as_mut() {
                        draft.active_field = field;
                        if field == 4 {
                            draft.make_default = !draft.make_default;
                        }
                    }
                }
                ui::RunTypeWizardHit::Create => {
                    if let Err(error) = model.create_run_type_from_wizard() {
                        model.status = error.to_string();
                    }
                }
            }
            return;
        }
        match ui::new_run_hit_at(model, column, row, size) {
            Some(ui::NewRunHit::RunType(id)) => {
                let selected = model
                    .run_types
                    .iter()
                    .find(|run_type| run_type.id == id)
                    .cloned();
                if let Some(selected) = selected {
                    let intake_schemas = model.run_type_intake.clone();
                    if let Some(Dialog::NewRun(draft)) = model.dialog.as_mut()
                        && !draft.submitted
                    {
                        apply_run_type(draft, &selected, &intake_schemas);
                        draft.active_field = new_run_field_indices(draft).run_type;
                    }
                }
            }
            Some(ui::NewRunHit::QuestionPolicy(policy)) => {
                let run_types = model.run_types.clone();
                if let Some(Dialog::NewRun(draft)) = model.dialog.as_mut()
                    && !draft.submitted
                {
                    draft.question_policy = policy;
                    draft.active_field = new_run_field_indices(draft).questions;
                    let inherited = run_types
                        .iter()
                        .find(|run_type| run_type.id == draft.run_type)
                        .map(|run_type| run_type.question_policy.as_str());
                    if inherited == Some(draft.question_policy.as_str()) {
                        draft.overridden_fields.remove("questions");
                    } else {
                        draft.overridden_fields.insert("questions".to_owned());
                    }
                }
            }
            Some(ui::NewRunHit::ParallelDelta(delta)) => {
                let run_types = model.run_types.clone();
                if let Some(Dialog::NewRun(draft)) = model.dialog.as_mut()
                    && !draft.submitted
                {
                    cycle_parallelism(draft, &run_types, delta);
                    draft.active_field = new_run_field_indices(draft).parallel;
                }
            }
            Some(ui::NewRunHit::Field(field)) => {
                if let Some(Dialog::NewRun(draft)) = model.dialog.as_mut()
                    && !draft.submitted
                {
                    draft.active_field = field;
                }
            }
            None => {}
        }
        return;
    }
    if row < 4 || row >= size.height.saturating_sub(1) {
        return;
    }
    if model.mode == Mode::Operate {
        let layout = ui::operate_layout_with_questions(
            Rect::new(0, 4, size.width, size.height.saturating_sub(5)),
            !model.selected_pending_questions().is_empty(),
        );
        if rect_contains(layout.runs, column, row) {
            model.focus_runs();
            let item_y = layout.runs.y.saturating_add(1);
            if row >= item_y && row < layout.runs.bottom().saturating_sub(1) {
                let visible = usize::from(layout.runs.height.saturating_sub(2) / 2);
                let first = model.selected_run.saturating_sub(visible.saturating_sub(1));
                let clicked = first + usize::from(row.saturating_sub(item_y) / 2);
                if clicked < model.runs.len() {
                    model.select_next_run(clicked as isize - model.selected_run as isize);
                }
            }
        } else if rect_contains(layout.tickets, column, row) {
            model.focus_tickets();
            if rect_contains(layout.ticket_switcher, column, row) {
                let midpoint = layout
                    .ticket_switcher
                    .x
                    .saturating_add(layout.ticket_switcher.width / 2);
                model.cycle_ticket_tab(if column < midpoint { -1 } else { 1 });
            } else if rect_contains(layout.ticket_items, column, row) {
                let visible = usize::from(layout.ticket_items.height / 2);
                let first = model
                    .selected_ticket
                    .saturating_sub(visible.saturating_sub(1));
                let clicked = first + usize::from(row.saturating_sub(layout.ticket_items.y) / 2);
                if clicked < model.visible_tickets().len() {
                    model.select_next_ticket(clicked as isize - model.selected_ticket as isize);
                }
            }
        } else if rect_contains(layout.details, column, row) {
            model.focus = Focus::Details;
            if rect_contains(layout.detail_switcher, column, row) {
                let midpoint = layout
                    .detail_switcher
                    .x
                    .saturating_add(layout.detail_switcher.width / 2);
                model.cycle_detail_panel(if column < midpoint { -1 } else { 1 });
            }
        } else if layout
            .pending_questions
            .is_some_and(|questions| rect_contains(questions, column, row))
        {
            model.focus = Focus::Questions;
            if let Some(index) = layout
                .pending_questions
                .and_then(|area| ui::pending_question_at(model, column, row, area))
            {
                model.selected_question = index;
            }
        } else if rect_contains(layout.active_agents, column, row) {
            model.focus = Focus::Agents;
            if let Some(index) = ui::agent_at(model, column, row, layout.active_agents) {
                model.select_next_agent(index as isize - model.selected_agent as isize);
            }
        } else if rect_contains(layout.graph, column, row) {
            model.focus = Focus::Graph;
        }
        return;
    }
    let area = Rect::new(0, 4, size.width, size.height.saturating_sub(5));
    if let Some(index) = ui::configure_domain_at(model, column, row, area) {
        model.config.select_domain_index(index);
        model.focus = Focus::ConfigTree;
    } else if let Some(index) = ui::configure_resource_at(model, column, row, area) {
        model.config.select_resource_index(index);
        model.focus = Focus::ConfigForm;
    } else if let Some(index) = ui::configure_field_at(model, column, row, area) {
        model.config.selected_form_row = index;
        model.focus = Focus::Yaml;
    } else {
        let layout = ui::configure_layout(area);
        if rect_contains(layout.domains, column, row) {
            model.focus = Focus::ConfigTree;
        } else if rect_contains(layout.resources, column, row) {
            model.focus = Focus::ConfigForm;
        } else if rect_contains(layout.editor, column, row) {
            if model.config.selected_resource().is_some() {
                model.focus = Focus::Yaml;
            } else {
                model.status = "this section has no configured resources yet".to_owned();
            }
        }
    }
}

fn rect_contains(area: Rect, column: u16, row: u16) -> bool {
    column >= area.x && column < area.right() && row >= area.y && row < area.bottom()
}

pub fn plain_snapshot(model: &ControlCenterModel) -> String {
    const TITLE: &str = "Koni Control Center";
    let mut lines = vec![
        TITLE.to_owned(),
        "=".repeat(TITLE.chars().count()),
        format!("Initialized from: {}", model.launch_root.display()),
        format!("Project: {}", model.root.display()),
        format!("Runs: {}", model.runs.len()),
    ];
    for (index, run) in model.runs.iter().enumerate() {
        if let Some(summary) = &run.summary {
            lines.push(format!(
                "{} {} [{}] tickets={} questions={} agents={}",
                if index == model.selected_run {
                    ">"
                } else {
                    " "
                },
                summary.goal,
                summary.status,
                summary.ticket_count,
                summary.open_questions,
                summary.active_agents
            ));
        }
    }
    lines.push(String::new());
    lines.push("Tickets [all]".to_owned());
    let tickets = model
        .selected_run_data()
        .map(|run| run.tickets.iter().collect::<Vec<_>>())
        .unwrap_or_default();
    if tickets.is_empty() {
        lines.push("  no tickets".to_owned());
    } else {
        for ticket in tickets {
            let title = ticket
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Untitled");
            let operation = ticket
                .get("operation")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let title = title
                .strip_prefix(operation)
                .and_then(|rest| rest.strip_prefix(':'))
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .unwrap_or(title);
            lines.push(format!(
                "  {} {}",
                match ticket
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown")
                {
                    "closed" | "complete" | "completed" | "done" => "●",
                    "active" | "in_progress" | "review" | "integrating" => "◐",
                    "blocked" | "failed" | "error" => "!",
                    _ => "○",
                },
                title,
            ));
        }
    }
    lines.push(String::new());
    let agents = model
        .selected_run_data()
        .map(crate::model::RunData::agent_summaries)
        .unwrap_or_default();
    let active_agents = agents.iter().filter(|agent| agent.live).count();
    lines.push(format!(
        "Agents · {active_agents} active / {} total",
        agents.len()
    ));
    if agents.is_empty() {
        lines.push("  ○ No agent history".to_owned());
    } else {
        lines.extend(
            agents
                .iter()
                .map(|agent| format!("  {} {}", if agent.live { "⚙" } else { "○" }, agent.title)),
        );
    }
    let pending_questions = model.selected_pending_questions();
    if !pending_questions.is_empty() {
        lines.push(String::new());
        lines.push(format!("Pending questions · {}", pending_questions.len()));
        lines.extend(pending_questions.iter().map(|question| {
            format!(
                "  ? {}",
                question
                    .get("prompt")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("A decision is needed")
            )
        }));
    }
    lines.push(String::new());
    lines.push("Project graph".to_owned());
    let selected = model.selected_run_data();
    let graph = selected.map(|run| run.graph.as_slice()).unwrap_or_default();
    lines.extend(
        ui::graph_renderer_for_options(true, selected.and_then(|run| run.graph_options.as_ref()))
            .render_values(graph, 118)
            .into_iter()
            .map(|line| line.text),
    );
    lines.push(String::new());
    lines.push(format!("Status: {}", model.status));
    lines.join("\n")
}

struct TerminalSession {
    terminal: Terminal<CrosstermBackend<std::io::Stdout>>,
}

impl TerminalSession {
    fn enter() -> anyhow::Result<Self> {
        enable_raw_mode()?;
        let mut output = stdout();
        execute!(
            output,
            EnterAlternateScreen,
            EnableMouseCapture,
            EnableBracketedPaste
        )?;
        let terminal = Terminal::new(CrosstermBackend::new(output))?;
        Ok(Self { terminal })
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            self.terminal.backend_mut(),
            LeaveAlternateScreen,
            DisableMouseCapture,
            DisableBracketedPaste
        );
        let _ = self.terminal.show_cursor();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn snapshot_contains_project_runs_tickets_and_graph() {
        let model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"r1","goal":"Demo","status":"active","profile_id":"default"},
                "tickets":[
                    {"id":"t1","status":"in_progress","title":"Work"},
                    {"id":"t2","status":"quality_gate","title":"Custom state"}
                ],
                "graph":[{"id":"n1","type":"task","title":"Root","edges":{}}]
            }),
        );
        let snapshot = plain_snapshot(&model);
        assert!(snapshot.starts_with("Koni Control Center\n"));
        assert!(snapshot.contains("Koni Control Center"));
        assert!(snapshot.contains("Project: /tmp/demo"));
        assert!(snapshot.contains("Demo [active]"));
        assert!(snapshot.contains("◐ Work"));
        assert!(snapshot.contains("○ Custom state"));
        assert!(!snapshot.contains("t1"));
        assert!(!snapshot.contains("t2"));
        assert!(snapshot.contains("[task]"));
    }

    #[test]
    fn contextual_help_tracks_focus_and_releases_h_from_vim_left_navigation() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.focus = Focus::Details;
        model.detail_panel = crate::model::Panel::Stages;
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        assert!(matches!(
            model.dialog,
            Some(Dialog::Help(HelpTopic::Details(
                crate::model::Panel::Stages
            )))
        ));
        assert_eq!(model.detail_panel, crate::model::Panel::Stages);

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(model.dialog.is_none());

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Left, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert_eq!(model.detail_panel, crate::model::Panel::Planning);
    }

    #[test]
    fn question_actions_belong_to_the_conditional_pending_panel_not_details() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[
                    {
                        "id":"question-secret",
                        "status":"open",
                        "prompt":"Choose a contract",
                        "options":[{"id":"safe","label":"Safe","recommended":true}]
                    },
                    {
                        "id":"question-secret-two",
                        "status":"open",
                        "prompt":"Choose storage",
                        "options":[{"id":"local","label":"Local","recommended":true}]
                    }
                ]
            }),
        );
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        model.focus = Focus::Details;
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('R'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(model.dialog.is_none());
        assert!(mutation_rx.try_recv().is_err());

        model.focus = Focus::Questions;
        for code in [
            KeyCode::Right,
            KeyCode::Char('['),
            KeyCode::Char(']'),
            KeyCode::Left,
        ] {
            handle_key(
                &mut model,
                KeyEvent::new(code, KeyModifiers::NONE),
                &workers,
            )
            .unwrap();
        }
        assert_eq!(model.selected_question, 0);
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(model.dialog, Some(Dialog::AnswerQuestion(_))));

        model.dialog = None;
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('R'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::ResolveQuestions { ref run_id }) if run_id == "run-secret"
        ));
    }

    #[test]
    fn source_editor_keeps_h_literal_and_uses_f1_for_help() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.mode = Mode::Configure;
        model.focus = Focus::Yaml;
        model.config.documents.push(crate::model::ConfigDocument {
            relative_path: "profile.yaml".into(),
            source_path: "/tmp/demo/.codex/koni/profile.yaml".into(),
            draft_path: "/tmp/demo/.git/koni/config-drafts/profile.yaml".into(),
            original: "profile: demo\n".to_owned(),
            text: "profile: demo\n".to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        });
        model.config.rebuild_projection();
        model
            .config
            .select_domain_index(ConfigDomain::Advanced.index());
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(model.dialog.is_none());
        assert_eq!(
            model.config.selected_document().unwrap().text,
            "hprofile: demo\n"
        );

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            model.dialog,
            Some(Dialog::Help(HelpTopic::ConfigEditor {
                mode: ConfigEditorMode::Source,
                ..
            }))
        ));
    }

    #[test]
    fn contextual_help_topics_cover_every_normal_focusable_panel() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        for (focus, expected) in [
            (Focus::Runs, HelpTopic::Runs),
            (Focus::Tickets, HelpTopic::Tickets),
            (Focus::Questions, HelpTopic::PendingQuestions),
            (Focus::Agents, HelpTopic::Agents),
            (Focus::Graph, HelpTopic::Graph),
        ] {
            model.mode = Mode::Operate;
            model.focus = focus;
            assert_eq!(contextual_help_topic(&model), expected);
        }
        model.focus = Focus::Details;
        for panel in crate::model::Panel::ALL {
            model.detail_panel = panel;
            assert_eq!(contextual_help_topic(&model), HelpTopic::Details(panel));
        }
        model.mode = Mode::Configure;
        model.focus = Focus::ConfigTree;
        assert_eq!(contextual_help_topic(&model), HelpTopic::ConfigDomains);
        model.focus = Focus::ConfigForm;
        assert!(matches!(
            contextual_help_topic(&model),
            HelpTopic::ConfigResources { .. }
        ));
        model.focus = Focus::Yaml;
        assert!(matches!(
            contextual_help_topic(&model),
            HelpTopic::ConfigEditor { .. }
        ));
    }

    #[test]
    fn every_advertised_help_close_key_returns_to_the_panel() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        for code in [
            KeyCode::Char('h'),
            KeyCode::Esc,
            KeyCode::Enter,
            KeyCode::Char('q'),
            KeyCode::F(1),
        ] {
            model.dialog = Some(Dialog::Help(HelpTopic::Runs));
            handle_key(
                &mut model,
                KeyEvent::new(code, KeyModifiers::NONE),
                &workers,
            )
            .unwrap();
            assert!(model.dialog.is_none(), "help stayed open after {code:?}");
        }
    }

    #[test]
    fn f1_help_over_a_text_dialog_restores_the_exact_draft_for_every_close_key() {
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        for close_code in [
            KeyCode::Char('h'),
            KeyCode::Esc,
            KeyCode::Enter,
            KeyCode::Char('q'),
            KeyCode::F(1),
        ] {
            let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
            model.open_new_run();

            handle_key(
                &mut model,
                KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE),
                &workers,
            )
            .unwrap();
            let before = match &model.dialog {
                Some(Dialog::NewRun(draft)) => {
                    assert_eq!(draft.goal, "h");
                    format!("{draft:?}")
                }
                other => panic!("h replaced the text-entry dialog: {other:?}"),
            };

            handle_key(
                &mut model,
                KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE),
                &workers,
            )
            .unwrap();
            assert!(matches!(model.dialog, Some(Dialog::Help(HelpTopic::Runs))));

            handle_key(
                &mut model,
                KeyEvent::new(close_code, KeyModifiers::NONE),
                &workers,
            )
            .unwrap();
            let restored = match &model.dialog {
                Some(Dialog::NewRun(draft)) => format!("{draft:?}"),
                other => panic!("help close did not restore the draft: {other:?}"),
            };
            assert_eq!(restored, before, "draft changed after {close_code:?}");

            handle_key(
                &mut model,
                KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                &workers,
            )
            .unwrap();
            assert!(
                model.dialog.is_none(),
                "Esc did not close the restored dialog"
            );
        }
    }

    #[test]
    fn completed_new_run_beneath_help_is_not_resurrected() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.open_new_run();
        let intake = match model.dialog.as_mut() {
            Some(Dialog::NewRun(draft)) => {
                draft.goal = "submitted goal".to_owned();
                draft.submitted = true;
                draft.clone()
            }
            other => panic!("new-run dialog did not open: {other:?}"),
        };
        model.open_help(HelpTopic::Runs);

        apply_run_planned_dialog_completion(&mut model, &intake);

        assert!(matches!(model.dialog, Some(Dialog::Help(HelpTopic::Runs))));
        model.close_dialog();
        assert!(model.dialog.is_none());
    }

    #[test]
    fn completed_question_beneath_help_is_not_resurrected() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[{
                    "id":"question-secret",
                    "status":"open",
                    "prompt":"Choose",
                    "options":[{"id":"safe","label":"Safe","recommended":true}]
                }]
            }),
        );
        model.open_pending_question(0);
        let operation_id = match model.dialog.as_mut() {
            Some(Dialog::AnswerQuestion(question)) => {
                question.submitted = true;
                question.operation_id.clone()
            }
            other => panic!("answer dialog did not open: {other:?}"),
        };
        model.open_help(HelpTopic::PendingQuestions);

        apply_question_answered(
            &mut model,
            &operation_id,
            "run-secret",
            "question-secret",
            false,
            0,
            true,
        );

        assert!(matches!(
            model.dialog,
            Some(Dialog::Help(HelpTopic::PendingQuestions))
        ));
        model.close_dialog();
        assert!(model.dialog.is_none());
    }

    #[test]
    fn completed_action_form_beneath_help_is_not_resurrected() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.dialog = Some(Dialog::ActionForm(crate::model::ActionFormDraft {
            operation_id: "operation-secret".to_owned(),
            run_id: "run-secret".to_owned(),
            action: "review".to_owned(),
            params: Vec::new(),
            selected: 0,
            execution_root: None,
            requires_ticket_worktree: false,
            configured_ticket_review: false,
            submitted: true,
        }));
        model.open_help(HelpTopic::Runs);

        apply_action_finished_dialog_completion(
            &mut model,
            "operation-secret",
            "run-secret",
            "review",
        );

        assert!(matches!(model.dialog, Some(Dialog::Help(HelpTopic::Runs))));
        model.close_dialog();
        assert!(model.dialog.is_none());
    }

    #[test]
    fn worker_error_resets_submitted_action_form_beneath_help() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.dialog = Some(Dialog::ActionForm(crate::model::ActionFormDraft {
            operation_id: "operation-secret".to_owned(),
            run_id: "run-secret".to_owned(),
            action: "review".to_owned(),
            params: Vec::new(),
            selected: 0,
            execution_root: None,
            requires_ticket_worktree: false,
            configured_ticket_review: false,
            submitted: true,
        }));
        model.open_help(HelpTopic::Runs);

        assert!(!reset_dialog_after_worker_error(&mut model));
        assert!(matches!(model.dialog, Some(Dialog::Help(HelpTopic::Runs))));
        assert!(matches!(
            model.ordinary_dialog(),
            Some(Dialog::ActionForm(form)) if !form.submitted
        ));

        model.close_dialog();
        assert!(matches!(
            model.dialog,
            Some(Dialog::ActionForm(form)) if !form.submitted
        ));
    }

    #[test]
    fn question_submission_failure_resets_suspended_answer_draft() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[{
                    "id":"question-secret",
                    "status":"open",
                    "prompt":"Choose",
                    "options":[{"id":"safe","label":"Safe","recommended":true}]
                }]
            }),
        );
        model.open_pending_question(0);
        match model.dialog.as_mut() {
            Some(Dialog::AnswerQuestion(question)) => question.submitted = true,
            other => panic!("answer dialog did not open: {other:?}"),
        }
        model.open_help(HelpTopic::PendingQuestions);

        apply_question_submission_failed(&mut model, "run-secret", "network unavailable");

        assert!(matches!(
            model.dialog,
            Some(Dialog::Help(HelpTopic::PendingQuestions))
        ));
        assert!(matches!(
            model.ordinary_dialog(),
            Some(Dialog::AnswerQuestion(question)) if !question.submitted
        ));
        model.close_dialog();
        assert!(matches!(
            model.dialog,
            Some(Dialog::AnswerQuestion(question)) if !question.submitted
        ));
    }

    fn automatic_stage_model(kind: &str, status: &str, automatic: bool) -> ControlCenterModel {
        ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-private-id","goal":"Demo","status":"active","run_type_id":"medium"},
                "orchestration":{"running":true,"max_parallel":3},
                "stages":[{
                    "status":status,
                    "definition":{
                        "id":"internal-stage-id",
                        "kind":kind,
                        "title":"Friendly stage",
                        "config":{"automatic":automatic}
                    }
                }]
            }),
        )
    }

    #[test]
    fn only_live_automatic_stage_kinds_are_scheduled() {
        for kind in ["orchestration", "agent_review", "checkpoint"] {
            let model = automatic_stage_model(kind, "pending", false);
            assert!(run_has_automatic_stage(&model.runs[0]), "kind {kind}");
        }
        let model = automatic_stage_model("action", "pending", true);
        assert!(run_has_automatic_stage(&model.runs[0]));
        let model = automatic_stage_model("action", "pending", false);
        assert!(!run_has_automatic_stage(&model.runs[0]));
        let model = automatic_stage_model("orchestration", "blocked", false);
        assert!(!run_has_automatic_stage(&model.runs[0]));
        let mut model = automatic_stage_model("orchestration", "waiting", false);
        model.runs[0].orchestration = Some(json!({"running":false,"max_parallel":3}));
        assert!(!run_has_automatic_stage(&model.runs[0]));

        let mut model = automatic_stage_model("orchestration", "waiting", false);
        model.runs[0].summary.as_mut().unwrap().open_questions = 1;
        model.runs[0].questions = vec![json!({
            "status":"open",
            "policy":"autonomous",
            "impact":"routine"
        })];
        assert!(run_has_automatic_stage(&model.runs[0]));

        let mut model = automatic_stage_model("orchestration", "succeeded", false);
        model.runs[0].snapshot["pipeline"] = json!({"status":"complete"});
        model.runs[0].orchestration = Some(json!({"running":false,"max_parallel":3}));
        assert!(run_has_automatic_stage(&model.runs[0]));
        model.runs[0].snapshot["pipeline"] = serde_json::Value::Null;
        assert!(!run_has_automatic_stage(&model.runs[0]));
    }

    #[test]
    fn automatic_supervision_enqueue_is_deduplicated_per_run() {
        let model = automatic_stage_model("orchestration", "waiting", false);
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };
        let mut in_flight = BTreeSet::new();
        let mut next_poll = BTreeMap::new();

        enqueue_automatic_supervision(
            &model,
            &workers,
            &mut in_flight,
            &mut next_poll,
            Duration::from_secs(2),
        );
        enqueue_automatic_supervision(
            &model,
            &workers,
            &mut in_flight,
            &mut next_poll,
            Duration::from_secs(2),
        );

        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::SuperviseRun { ref run_id }) if run_id == "run-private-id"
        ));
        assert!(mutation_rx.try_recv().is_err());
    }

    #[test]
    fn blocked_automatic_stage_enter_dispatches_explicit_retry_without_showing_ids() {
        let mut model = automatic_stage_model("orchestration", "blocked", false);
        model.focus = Focus::Details;
        model.detail_panel = crate::model::Panel::Stages;
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::RetrySupervisedStage { ref run_id, ref stage_id })
                if run_id == "run-private-id" && stage_id == "internal-stage-id"
        ));
        assert!(!model.status.contains("internal-stage-id"));
        assert!(!model.status.contains("run-private-id"));
    }

    #[test]
    fn supervision_status_uses_friendly_state_not_internal_ids() {
        let tick = koni_core::RunSupervisionTick {
            run_id: "run-private-id".to_owned(),
            advanced_stages: vec!["internal-stage-id".to_owned()],
            outcome: koni_core::RunSupervisionState::Waiting {
                stage_id: "other-private-stage".to_owned(),
                agent_id: Some("private-agent-id".to_owned()),
                reason: "private reason".to_owned(),
            },
        };
        let status = supervision_status(&tick);
        assert_eq!(
            status,
            "✓ advanced one automatic stage · automation is working"
        );
        assert!(!status.contains("private"));
    }

    #[test]
    fn planning_approval_alias_opens_approval_instead_of_active_stage_driver() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"r1","goal":"Demo","status":"planning","run_type_id":"default"},
                "stages":[{
                    "status":"pending",
                    "definition":{"id":"approve","kind":"manual","title":"Approve","config":{}}
                }]
            }),
        );
        model.focus = Focus::Details;
        model.detail_panel = crate::model::Panel::Stages;
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        assert!(matches!(model.dialog, Some(Dialog::Approval(_))));
        assert!(mutation_rx.try_recv().is_err());
    }

    #[test]
    fn approval_review_browses_sections_and_scrolls_before_explicit_action_focus() {
        let long_verification = (1..=24)
            .map(|line| format!("Verification line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-private","goal":"Demo","status":"planning","run_type_title":"Large"},
                "stages":[
                    {"status":"succeeded","definition":{"id":"architecture-private","kind":"planning","title":"Plan architecture"},"output":{"output":{"output":"Architecture body"}}},
                    {"status":"succeeded","definition":{"id":"risk-private","kind":"planning","title":"Plan risks"},"output":{"output":{"output":"Risk body"}}},
                    {"status":"succeeded","definition":{"id":"verification-private","kind":"planning","title":"Plan verification"},"output":{"output":{"output":long_verification}}}
                ]
            }),
        );
        model.open_selected_run_approval();
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert!(model.status.contains("press Tab"));

        for _ in 0..3 {
            handle_key(
                &mut model,
                KeyEvent::new(KeyCode::Right, KeyModifiers::NONE),
                &workers,
            )
            .unwrap();
        }
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::PageDown, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        let Some(Dialog::Approval(approval)) = &model.dialog else {
            panic!("approval review closed unexpectedly");
        };
        assert_eq!(
            approval.selected_section().unwrap().title,
            "Verification plan"
        );
        assert_eq!(approval.scroll, 8);
        assert!(!approval.approve_focused);

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::ApproveRun { ref run_id }) if run_id == "run-private"
        ));
    }

    #[test]
    fn incomplete_required_plan_refuses_approval_but_keeps_resume_available() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-private","goal":"Demo","status":"planning"},
                "stages":[{
                    "status":"waiting",
                    "definition":{"id":"risk-private","kind":"planning","title":"Plan risk controls","required":true}
                }]
            }),
        );
        model.open_selected_run_approval();
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert!(model.status.contains("Plan risk controls is incomplete"));
        assert!(!model.status.contains("risk-private"));

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::ResumePlanning { ref run_id }) if run_id == "run-private"
        ));
    }

    #[test]
    fn paste_is_forwarded_to_the_active_dialog_field() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        let draft = crate::model::NewRunDraft {
            active_field: 0,
            ..crate::model::NewRunDraft::default()
        };
        model.dialog = Some(Dialog::NewRun(draft));

        handle_paste(&mut model, "first line\r\nsecond line");

        let Some(Dialog::NewRun(draft)) = model.dialog else {
            panic!("new-run dialog was unexpectedly closed");
        };
        assert_eq!(draft.goal, "first line\nsecond line");
    }

    #[test]
    fn scalar_editor_edits_unicode_and_pastes_at_the_character_cursor() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.dialog = Some(Dialog::EditScalar(crate::model::EditScalarDraft {
            document_path: "private/agent-019f-secret.toml".into(),
            path: "$.agents.reviewer.developer_instructions".to_owned(),
            value: "aé🙂z".to_owned(),
            kind: "string".to_owned(),
            cursor: 3,
            locator: Vec::new(),
        }));
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        for code in [
            KeyCode::Left,
            KeyCode::Delete,
            KeyCode::Home,
            KeyCode::Right,
        ] {
            handle_key(
                &mut model,
                KeyEvent::new(code, KeyModifiers::NONE),
                &workers,
            )
            .unwrap();
        }
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('Ω'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        handle_paste(&mut model, "中\r\nβ");
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::End, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        let Some(Dialog::EditScalar(edit)) = model.dialog else {
            panic!("scalar editor unexpectedly closed");
        };
        assert_eq!(edit.value, "aΩ中\nβé");
        assert_eq!(edit.cursor, edit.value.chars().count());
    }

    #[test]
    fn new_run_type_navigation_uses_visible_catalog_order() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.run_types = vec![
            crate::model::RunTypeOption {
                id: "small-internal".to_owned(),
                title: "Small".to_owned(),
                description: String::new(),
                planning_passes: 0,
                question_policy: "autonomous".to_owned(),
                max_parallel: Some(1),
                model_summary: None,
                stages: Vec::new(),
                agents: BTreeMap::new(),
            },
            crate::model::RunTypeOption {
                id: "medium-internal".to_owned(),
                title: "Medium".to_owned(),
                description: String::new(),
                planning_passes: 1,
                question_policy: "high_impact_only".to_owned(),
                max_parallel: Some(3),
                model_summary: None,
                stages: Vec::new(),
                agents: BTreeMap::new(),
            },
            crate::model::RunTypeOption {
                id: "large-internal".to_owned(),
                title: "Large".to_owned(),
                description: String::new(),
                planning_passes: 3,
                question_policy: "interactive".to_owned(),
                max_parallel: Some(5),
                model_summary: None,
                stages: Vec::new(),
                agents: BTreeMap::new(),
            },
        ];
        model.dialog = Some(Dialog::NewRun(crate::model::NewRunDraft {
            run_type: "small-internal".to_owned(),
            question_policy: "autonomous".to_owned(),
            active_field: 1,
            ..crate::model::NewRunDraft::default()
        }));
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Right, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            model.dialog,
            Some(Dialog::NewRun(ref draft))
                if draft.run_type == "medium-internal"
                    && draft.question_policy == "high_impact_only"
        ));

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::End, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            model.dialog,
            Some(Dialog::NewRun(ref draft)) if draft.run_type == "large-internal"
        ));

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Home, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            model.dialog,
            Some(Dialog::NewRun(ref draft)) if draft.run_type == "small-internal"
        ));
    }

    #[test]
    fn new_run_type_mouse_hit_selects_the_visible_chip() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.run_types = vec![
            crate::model::RunTypeOption {
                id: "small-key".to_owned(),
                title: "Small".to_owned(),
                description: String::new(),
                planning_passes: 0,
                question_policy: "autonomous".to_owned(),
                max_parallel: Some(1),
                model_summary: None,
                stages: Vec::new(),
                agents: BTreeMap::new(),
            },
            crate::model::RunTypeOption {
                id: "large-key".to_owned(),
                title: "Large".to_owned(),
                description: String::new(),
                planning_passes: 3,
                question_policy: "interactive".to_owned(),
                max_parallel: Some(5),
                model_summary: None,
                stages: Vec::new(),
                agents: BTreeMap::new(),
            },
        ];
        model.dialog = Some(Dialog::NewRun(crate::model::NewRunDraft {
            run_type: "small-key".to_owned(),
            question_policy: "autonomous".to_owned(),
            ..crate::model::NewRunDraft::default()
        }));
        let size = ratatui::layout::Size::new(100, 30);
        let hit = (0..size.height).find_map(|row| {
            (0..size.width)
                .find(|column| {
                    ui::new_run_type_at(&model, *column, row, size).as_deref() == Some("large-key")
                })
                .map(|column| (column, row))
        });
        let (column, row) = hit.expect("large run type should have a clickable chip");

        handle_mouse(&mut model, column, row, size);

        assert!(matches!(
            model.dialog,
            Some(Dialog::NewRun(ref draft))
                if draft.run_type == "large-key" && draft.question_policy == "interactive"
        ));
    }

    #[test]
    fn new_run_enter_submits_only_from_the_start_button_and_closes_on_acceptance() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.dialog = Some(Dialog::NewRun(crate::model::NewRunDraft {
            goal: "Build a notes app".to_owned(),
            active_field: 0,
            ..crate::model::NewRunDraft::default()
        }));
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(mutation_rx.try_recv().is_err());
        assert!(matches!(
            model.dialog,
            Some(Dialog::NewRun(ref draft)) if draft.active_field == 1
        ));

        let Some(Dialog::NewRun(draft)) = model.dialog.as_mut() else {
            panic!("new-run dialog disappeared before submission");
        };
        draft.active_field = new_run_field_indices(draft).submit;
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        assert!(model.dialog.is_none());
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::PlanRun { ref intake }) if intake.goal == "Build a notes app"
        ));
        assert_eq!(model.status, "starting planning…");
    }

    #[test]
    fn run_plan_overrides_serialize_only_fields_explicitly_changed_for_this_run() {
        let planner = crate::model::RunAgentSetting {
            model: Some("planner-override".to_owned()),
            reasoning_effort: Some("high".to_owned()),
        };
        let worker = crate::model::RunAgentSetting {
            model: Some("inherited-worker".to_owned()),
            reasoning_effort: Some("medium".to_owned()),
        };
        let draft = crate::model::NewRunDraft {
            max_parallel: 9,
            agent_roles: [
                ("planner".to_owned(), planner),
                ("ticket_worker".to_owned(), worker),
            ]
            .into_iter()
            .collect(),
            overridden_fields: ["agent:planner:model".to_owned()].into_iter().collect(),
            ..crate::model::NewRunDraft::default()
        };

        let overrides = run_plan_overrides(&draft);
        let serialized = serde_json::to_value(&overrides).unwrap();
        assert_eq!(
            overrides.agent_roles["planner"].model,
            Some(koni_core::AgentSettingOverride::Configured(
                "planner-override".to_owned()
            ))
        );
        assert!(overrides.agent_roles["planner"].reasoning_effort.is_none());
        assert!(serialized.get("max_parallel").is_none(), "{serialized}");
        assert!(
            serialized["agent_roles"].get("ticket_worker").is_none(),
            "{serialized}"
        );

        let inherited_values_without_markers = crate::model::NewRunDraft {
            max_parallel: 99,
            ..crate::model::NewRunDraft::default()
        };
        assert!(run_plan_overrides(&inherited_values_without_markers).is_empty());
        assert_eq!(
            serde_json::to_value(run_plan_overrides(&inherited_values_without_markers)).unwrap(),
            json!({})
        );
    }

    #[test]
    fn new_run_agent_model_and_reasoning_cycle_independently() {
        let run_types = vec![
            crate::model::RunTypeOption {
                id: "small".to_owned(),
                title: "Small".to_owned(),
                description: String::new(),
                planning_passes: 0,
                question_policy: "autonomous".to_owned(),
                max_parallel: Some(1),
                model_summary: None,
                stages: Vec::new(),
                agents: [(
                    "planner".to_owned(),
                    crate::model::RunAgentSetting {
                        model: Some("alpha".to_owned()),
                        reasoning_effort: Some("high".to_owned()),
                    },
                )]
                .into_iter()
                .collect(),
            },
            crate::model::RunTypeOption {
                id: "custom".to_owned(),
                title: "Custom".to_owned(),
                description: String::new(),
                planning_passes: 0,
                question_policy: "autonomous".to_owned(),
                max_parallel: Some(1),
                model_summary: None,
                stages: Vec::new(),
                agents: [(
                    "planner".to_owned(),
                    crate::model::RunAgentSetting {
                        model: Some("beta".to_owned()),
                        reasoning_effort: None,
                    },
                )]
                .into_iter()
                .collect(),
            },
        ];
        let mut draft = crate::model::NewRunDraft {
            run_type: "small".to_owned(),
            agent_roles: run_types[0].agents.clone(),
            ..crate::model::NewRunDraft::default()
        };
        let codex_models = CodexModelCatalog {
            models: vec![
                crate::codex_models::CodexModelOption {
                    slug: "alpha".to_owned(),
                    display_name: "Alpha".to_owned(),
                    reasoning_efforts: vec!["low".to_owned(), "high".to_owned()],
                    default_reasoning_effort: Some("low".to_owned()),
                },
                crate::codex_models::CodexModelOption {
                    slug: "beta".to_owned(),
                    display_name: "Beta".to_owned(),
                    reasoning_efforts: vec!["medium".to_owned()],
                    default_reasoning_effort: Some("medium".to_owned()),
                },
            ],
        };

        cycle_agent_setting(
            &mut draft,
            &run_types,
            &codex_models,
            "planner",
            AgentSettingField::ReasoningEffort,
            1,
        );
        assert_eq!(draft.agent_roles["planner"].model.as_deref(), Some("alpha"));
        assert_eq!(draft.agent_roles["planner"].reasoning_effort, None);
        assert!(
            draft
                .overridden_fields
                .contains("agent:planner:reasoning_effort")
        );
        assert!(!draft.overridden_fields.contains("agent:planner:model"));

        cycle_agent_setting(
            &mut draft,
            &run_types,
            &codex_models,
            "planner",
            AgentSettingField::Model,
            1,
        );
        assert_eq!(draft.agent_roles["planner"].model.as_deref(), Some("beta"));
        assert_eq!(draft.agent_roles["planner"].reasoning_effort, None);
        assert!(draft.overridden_fields.contains("agent:planner:model"));

        let overrides = run_plan_overrides(&draft);
        assert_eq!(
            overrides.agent_roles["planner"].reasoning_effort,
            Some(koni_core::AgentSettingOverride::CodexDefault)
        );
    }

    #[test]
    fn changing_model_normalizes_reasoning_to_that_models_default() {
        let run_types = vec![crate::model::RunTypeOption {
            id: "small".to_owned(),
            title: "Small".to_owned(),
            description: String::new(),
            planning_passes: 0,
            question_policy: "autonomous".to_owned(),
            max_parallel: Some(1),
            model_summary: None,
            stages: Vec::new(),
            agents: [(
                "planner".to_owned(),
                crate::model::RunAgentSetting {
                    model: Some("alpha".to_owned()),
                    reasoning_effort: Some("high".to_owned()),
                },
            )]
            .into_iter()
            .collect(),
        }];
        let codex_models = CodexModelCatalog {
            models: vec![
                crate::codex_models::CodexModelOption {
                    slug: "alpha".to_owned(),
                    display_name: "Alpha".to_owned(),
                    reasoning_efforts: vec!["high".to_owned()],
                    default_reasoning_effort: Some("high".to_owned()),
                },
                crate::codex_models::CodexModelOption {
                    slug: "beta".to_owned(),
                    display_name: "Beta".to_owned(),
                    reasoning_efforts: vec!["low".to_owned(), "medium".to_owned()],
                    default_reasoning_effort: Some("medium".to_owned()),
                },
            ],
        };
        let mut draft = crate::model::NewRunDraft {
            run_type: "small".to_owned(),
            agent_roles: run_types[0].agents.clone(),
            ..crate::model::NewRunDraft::default()
        };

        cycle_agent_setting(
            &mut draft,
            &run_types,
            &codex_models,
            "planner",
            AgentSettingField::Model,
            1,
        );

        assert_eq!(draft.agent_roles["planner"].model.as_deref(), Some("beta"));
        assert_eq!(
            draft.agent_roles["planner"].reasoning_effort.as_deref(),
            Some("medium")
        );
        assert!(draft.overridden_fields.contains("agent:planner:model"));
        assert!(
            draft
                .overridden_fields
                .contains("agent:planner:reasoning_effort")
        );
    }

    #[test]
    fn parallelism_stepper_is_unbounded_and_never_drops_below_one() {
        let run_types = vec![crate::model::RunTypeOption {
            id: "small".to_owned(),
            title: "Small".to_owned(),
            description: String::new(),
            planning_passes: 0,
            question_policy: "autonomous".to_owned(),
            max_parallel: Some(3),
            model_summary: None,
            stages: Vec::new(),
            agents: BTreeMap::new(),
        }];
        let mut draft = crate::model::NewRunDraft {
            run_type: "small".to_owned(),
            max_parallel: 1_000,
            ..crate::model::NewRunDraft::default()
        };

        cycle_parallelism(&mut draft, &run_types, 1);
        assert_eq!(draft.max_parallel, 1_001);
        assert!(draft.overridden_fields.contains("parallel"));
        draft.max_parallel = 1;
        cycle_parallelism(&mut draft, &run_types, -1);
        assert_eq!(draft.max_parallel, 1);
    }

    #[test]
    fn new_run_mouse_hit_testing_reaches_every_config_row_and_start_button() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        let agents = NEW_RUN_AGENT_ROLES
            .into_iter()
            .map(|role| {
                (
                    role.to_owned(),
                    crate::model::RunAgentSetting {
                        model: Some(format!("{role}-model")),
                        reasoning_effort: Some("high".to_owned()),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        model.run_types = vec![crate::model::RunTypeOption {
            id: "medium-internal".to_owned(),
            title: "Medium".to_owned(),
            description: String::new(),
            planning_passes: 1,
            question_policy: "high_impact_only".to_owned(),
            max_parallel: Some(3),
            model_summary: None,
            stages: vec![crate::model::RunStageOption {
                id: "plan-internal".to_owned(),
                title: "Plan the change".to_owned(),
                kind: "planning".to_owned(),
            }],
            agents: agents.clone(),
        }];
        model.dialog = Some(Dialog::NewRun(crate::model::NewRunDraft {
            run_type: "medium-internal".to_owned(),
            question_policy: "high_impact_only".to_owned(),
            max_parallel: 3,
            agent_roles: agents,
            ..crate::model::NewRunDraft::default()
        }));
        let size = ratatui::layout::Size::new(82, 24);
        let Some(Dialog::NewRun(draft)) = model.dialog.as_ref() else {
            unreachable!();
        };
        let indices = new_run_field_indices(draft);
        let expected = std::iter::once(indices.questions)
            .chain(std::iter::once(indices.parallel))
            .chain((0..NEW_RUN_AGENT_ROLES.len() * 2).map(|offset| indices.agents + offset))
            .chain(std::iter::once(indices.submit))
            .collect::<Vec<_>>();

        for field in expected {
            let hit = (0..size.height).find_map(|row| {
                (0..size.width)
                    .find(|column| {
                        ui::new_run_hit_at(&model, *column, row, size)
                            == Some(ui::NewRunHit::Field(field))
                    })
                    .map(|column| (column, row))
            });
            let (column, row) = hit.unwrap_or_else(|| panic!("field {field} is not clickable"));
            handle_mouse(&mut model, column, row, size);
            assert!(matches!(
                model.dialog,
                Some(Dialog::NewRun(ref draft)) if draft.active_field == field
            ));
        }
    }

    #[test]
    fn quit_is_refused_when_dirty_drafts_cannot_be_saved() {
        let temp = TempDir::new().unwrap();
        let blocker = temp.path().join("not-a-directory");
        std::fs::write(&blocker, "file").unwrap();
        let mut model = ControlCenterModel::from_snapshot(temp.path().into(), json!(null));
        model.config.documents.push(crate::model::ConfigDocument {
            relative_path: "project.yaml".into(),
            source_path: temp.path().join("project.yaml"),
            draft_path: blocker.join("project.yaml"),
            original: "old: true\n".to_owned(),
            text: "new: true\n".to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        });
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        let should_quit = handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        assert!(!should_quit);
        assert!(model.status.starts_with("quit cancelled"));
    }

    #[test]
    fn configure_save_and_publish_shortcuts_work_outside_the_raw_editor() {
        let temp = TempDir::new().unwrap();
        let draft_path = temp.path().join("drafts/project.yaml");
        let second_draft_path = temp.path().join("drafts/profile.yaml");
        let mut model = ControlCenterModel::from_snapshot(temp.path().into(), json!(null));
        model.mode = Mode::Configure;
        model.focus = Focus::ConfigTree;
        model.config.documents.push(crate::model::ConfigDocument {
            relative_path: "project.yaml".into(),
            source_path: temp.path().join(".codex/koni/project.yaml"),
            draft_path: draft_path.clone(),
            original: "old: true\n".to_owned(),
            text: "new: true\n".to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        });
        model.config.documents.push(crate::model::ConfigDocument {
            relative_path: "profile.yaml".into(),
            source_path: temp.path().join(".codex/koni/profile.yaml"),
            draft_path: second_draft_path.clone(),
            original: "old: profile\n".to_owned(),
            text: "new: profile\n".to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        });
        model.config.rebuild_projection();
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL),
            &workers,
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&draft_path).unwrap(), "new: true\n");
        assert_eq!(
            std::fs::read_to_string(&second_draft_path).unwrap(),
            "new: profile\n"
        );

        model.focus = Focus::ConfigForm;
        model.status.clear();
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
            &workers,
        )
        .unwrap();
        assert!(
            !model.status.is_empty(),
            "Ctrl-P should publish or surface validation from the guided form"
        );
    }

    #[test]
    fn configure_guided_editor_never_treats_navigation_as_source_typing() {
        let temp = TempDir::new().unwrap();
        let mut model = ControlCenterModel::from_snapshot(temp.path().into(), json!(null));
        model.mode = Mode::Configure;
        model.config.documents.push(crate::model::ConfigDocument {
            relative_path: "project.yaml".into(),
            source_path: temp.path().join(".codex/koni/project.yaml"),
            draft_path: temp.path().join("drafts/project.yaml"),
            original: String::new(),
            text: "schema_version: '1.0'\nproject:\n  id: demo\n  title: Demo\ndefault_run_type: small\nrun_types: []\n".to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        });
        model.config.rebuild_projection();
        model.focus = Focus::Yaml;
        let original = model.config.selected_document().unwrap().text.clone();
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert_eq!(model.config.selected_document().unwrap().text, original);

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(model.dialog, Some(Dialog::EditScalar(_))));
        model.close_dialog();

        model
            .config
            .select_domain_index(ConfigDomain::Advanced.index());
        model.focus = Focus::Yaml;
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('#'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(
            model
                .config
                .selected_document()
                .unwrap()
                .text
                .starts_with('#')
        );
    }

    #[test]
    fn linked_persona_instructions_use_the_multiline_source_editor_and_return_to_the_card() {
        let temp = TempDir::new().unwrap();
        let persona_yaml = "personas:\n  - id: writer\n    description: Writes reports\n    prompt: prompts/writer.md\n    model_role: ticket_worker\n    model: gpt-test\n    reasoning_effort: high\n";
        let mut model = ControlCenterModel::from_snapshot(temp.path().into(), json!(null));
        model.mode = Mode::Configure;
        for (path, text) in [
            ("personas.yaml", persona_yaml),
            ("prompts/writer.md", "# Writer\n\nDraft carefully.\n"),
        ] {
            model.config.documents.push(crate::model::ConfigDocument {
                relative_path: path.into(),
                source_path: temp.path().join(".codex/koni").join(path),
                draft_path: temp.path().join("drafts").join(path),
                original: text.to_owned(),
                text: text.to_owned(),
                diagnostics: Vec::new(),
                cursor_line: 0,
                cursor_column: 0,
                is_new: false,
            });
        }
        model.config.rebuild_projection();
        model
            .config
            .select_domain_index(ConfigDomain::Agents.index());
        model.config.selected_form_row = model
            .config
            .form_rows
            .iter()
            .position(|row| row.edit_kind == crate::model::FormRowEditKind::LinkedMarkdown)
            .unwrap();
        model.focus = Focus::Yaml;
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(model.config.linked_document_editor_active());
        handle_paste(&mut model, "Follow the contract.\n");
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(
            model.dialog.is_none(),
            "h types while the source editor is active"
        );
        assert!(
            model
                .config
                .selected_document()
                .unwrap()
                .text
                .starts_with("Follow the contract.\nh# Writer")
        );
        assert_eq!(
            model
                .config
                .documents
                .iter()
                .find(|document| document.relative_path == Path::new("personas.yaml"))
                .unwrap()
                .text,
            persona_yaml
        );

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            model.dialog,
            Some(Dialog::Help(HelpTopic::ConfigEditor {
                mode: ConfigEditorMode::LinkedInstructions,
                ..
            }))
        ));
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(model.config.linked_document_editor_active());

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(!model.config.linked_document_editor_active());
        assert_eq!(model.focus, Focus::ConfigForm);
        assert_eq!(
            model.config.selected_document().unwrap().relative_path,
            Path::new("personas.yaml")
        );
    }

    #[test]
    fn advanced_source_edits_refresh_semantic_resources_without_losing_the_file() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.mode = Mode::Configure;
        for (path, text) in [
            (
                "project.yaml",
                "project: {id: demo, title: Demo}\ndefault_run_type: small\nrun_types: [{id: small, path: run-types/small.yaml}]\n",
            ),
            (
                "run-types/small.yaml",
                "id: small\ntitle: Small\nprofile: {source: .codex/koni/profile.yaml}\npipeline: {stages: {}, order: []}\n",
            ),
            (
                "profile.yaml",
                "profile: {id: demo, version: 1.0.0}\nimports: {actions: [actions.yaml]}\n",
            ),
            ("actions.yaml", "actions: [{id: compile}]\n"),
        ] {
            model.config.documents.push(crate::model::ConfigDocument {
                relative_path: path.into(),
                source_path: PathBuf::from("/tmp/demo/.codex/koni").join(path),
                draft_path: PathBuf::from("/tmp/demo/.git/koni/config-drafts").join(path),
                original: text.to_owned(),
                text: text.to_owned(),
                diagnostics: Vec::new(),
                cursor_line: 0,
                cursor_column: 0,
                is_new: false,
            });
        }
        model.config.rebuild_projection();
        assert!(model.config.resources.iter().any(|resource| {
            resource.domain == ConfigDomain::ActionsChecks
                && resource.document_path == Path::new("actions.yaml")
        }));
        model
            .config
            .select_advanced_document(Path::new("actions.yaml"));
        let line_width = model.config.selected_document().unwrap().lines()[0]
            .chars()
            .count();
        model.config.selected_document_mut().unwrap().cursor_column = line_width;
        model.focus = Focus::Yaml;
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        assert!(!model.config.resources.iter().any(|resource| {
            resource.domain == ConfigDomain::ActionsChecks
                && resource.document_path == Path::new("actions.yaml")
        }));
        assert_eq!(model.config.selected_domain(), ConfigDomain::Advanced);
        assert_eq!(
            model.config.selected_resource().unwrap().document_path,
            Path::new("actions.yaml")
        );
    }

    #[test]
    fn planning_intake_preserves_configured_field_types() {
        let draft = crate::model::NewRunDraft {
            operation_id: "test-planning".to_owned(),
            run_type: "software".to_owned(),
            goal: "Ship it".to_owned(),
            base_ref: "HEAD".to_owned(),
            question_policy: "interactive".to_owned(),
            active_field: 0,
            intake_fields: vec![
                crate::model::IntakeFieldDraft {
                    id: "high_risk".to_owned(),
                    label: "High risk".to_owned(),
                    description: String::new(),
                    field_type: "boolean".to_owned(),
                    required: true,
                    value: "true".to_owned(),
                    options: Vec::new(),
                },
                crate::model::IntakeFieldDraft {
                    id: "attempts".to_owned(),
                    label: "Attempts".to_owned(),
                    description: String::new(),
                    field_type: "integer".to_owned(),
                    required: true,
                    value: "3".to_owned(),
                    options: Vec::new(),
                },
                crate::model::IntakeFieldDraft {
                    id: "areas".to_owned(),
                    label: "Areas".to_owned(),
                    description: String::new(),
                    field_type: "multi_choice".to_owned(),
                    required: true,
                    value: "api, ui".to_owned(),
                    options: vec![
                        crate::model::IntakeOptionDraft {
                            label: "api".to_owned(),
                            value: json!("api"),
                        },
                        crate::model::IntakeOptionDraft {
                            label: "ui".to_owned(),
                            value: json!("ui"),
                        },
                    ],
                },
                crate::model::IntakeFieldDraft {
                    id: "priority".to_owned(),
                    label: "Priority".to_owned(),
                    description: String::new(),
                    field_type: "choice".to_owned(),
                    required: true,
                    value: "2".to_owned(),
                    options: vec![
                        crate::model::IntakeOptionDraft {
                            label: "1".to_owned(),
                            value: json!(1),
                        },
                        crate::model::IntakeOptionDraft {
                            label: "2".to_owned(),
                            value: json!(2),
                        },
                    ],
                },
            ],
            submitted: false,
            ..crate::model::NewRunDraft::default()
        };

        let value = planning_intake_value(&draft).unwrap();
        assert_eq!(value["high_risk"], true);
        assert_eq!(value["attempts"], 3);
        assert_eq!(value["areas"], json!(["api", "ui"]));
        assert_eq!(value["priority"], 2);
    }

    #[test]
    fn ticket_worktree_action_never_falls_back_to_project_root() {
        let project = Path::new("/tmp/project");
        let error = action_execution_root(project, None, true).unwrap_err();

        assert!(error.contains("no active worktree"));
    }

    #[test]
    fn action_dialog_refuses_missing_required_ticket_worktree() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.dialog = Some(Dialog::ActionForm(crate::model::ActionFormDraft {
            operation_id: "op-1".to_owned(),
            run_id: "run-1".to_owned(),
            action: "context".to_owned(),
            params: Vec::new(),
            selected: 0,
            execution_root: None,
            requires_ticket_worktree: true,
            configured_ticket_review: false,
            submitted: false,
        }));
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        assert!(mutation_rx.try_recv().is_err());
        assert!(model.status.contains("no active worktree"));
    }

    #[test]
    fn action_dialog_latches_after_enter_submission() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.dialog = Some(Dialog::ActionForm(crate::model::ActionFormDraft {
            operation_id: "op-1".to_owned(),
            run_id: "run-1".to_owned(),
            action: "compile-full".to_owned(),
            params: vec![crate::model::ActionParamDraft {
                id: "scope".to_owned(),
                description: String::new(),
                value_type: "string".to_owned(),
                required: false,
                value: "project".to_owned(),
                locked: false,
            }],
            selected: 0,
            execution_root: None,
            requires_ticket_worktree: false,
            configured_ticket_review: false,
            submitted: false,
        }));
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        for _ in 0..2 {
            handle_key(
                &mut model,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
                &workers,
            )
            .unwrap();
        }

        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::ExecuteAction { .. })
        ));
        assert!(mutation_rx.try_recv().is_err());
        assert!(matches!(
            model.dialog,
            Some(Dialog::ActionForm(ref draft)) if draft.submitted
        ));
    }

    #[test]
    fn configured_review_dialog_dispatches_compiler_reviewer_without_verdict() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.dialog = Some(Dialog::ActionForm(crate::model::ActionFormDraft {
            operation_id: "op-review".to_owned(),
            run_id: "run-1".to_owned(),
            action: "review".to_owned(),
            params: vec![crate::model::ActionParamDraft {
                id: "ticket".to_owned(),
                description: String::new(),
                value_type: "ticket_id".to_owned(),
                required: true,
                value: "ticket-1".to_owned(),
                locked: true,
            }],
            selected: 0,
            execution_root: Some(PathBuf::from("/tmp/ticket-1")),
            requires_ticket_worktree: true,
            configured_ticket_review: true,
            submitted: false,
        }));
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        let command = mutation_rx.try_recv().expect("review dispatch");
        assert!(matches!(
            command,
            WorkerCommand::ExecuteAction {
                configured_ticket_review: true,
                params,
                ..
            } if params == BTreeMap::from([("ticket".to_owned(), "ticket-1".to_owned())])
        ));
    }

    #[test]
    fn bound_action_parameter_ignores_typing_backspace_and_paste() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        model.dialog = Some(Dialog::ActionForm(crate::model::ActionFormDraft {
            operation_id: "op-1".to_owned(),
            run_id: "run-1".to_owned(),
            action: "start".to_owned(),
            params: vec![crate::model::ActionParamDraft {
                id: "ticket_id".to_owned(),
                description: String::new(),
                value_type: "string".to_owned(),
                required: true,
                value: "bound-ticket".to_owned(),
                locked: true,
            }],
            selected: 0,
            execution_root: Some(PathBuf::from("/tmp/ticket")),
            requires_ticket_worktree: true,
            configured_ticket_review: false,
            submitted: false,
        }));
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        handle_paste(&mut model, "different-ticket");

        assert!(matches!(
            model.dialog,
            Some(Dialog::ActionForm(ref draft)) if draft.params[0].value == "bound-ticket"
        ));
    }

    #[test]
    fn mouse_click_selects_ticket_and_cycles_visible_switchers() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run","goal":"Demo","status":"active","profile_id":"default"},
                "tickets":[
                    {"id":"one","title":"First","status":"in_progress","workflow":[],"outputs":[],"blockers":[]},
                    {"id":"two","title":"Second","status":"in_progress","workflow":[],"outputs":[],"blockers":[]}
                ]
            }),
        );
        let size = ratatui::layout::Size::new(120, 40);
        let layout = ui::operate_layout(Rect::new(0, 4, size.width, size.height.saturating_sub(5)));

        // Each ticket occupies two rows; click the second item in the exact rendered list area.
        handle_mouse(
            &mut model,
            layout.ticket_items.x,
            layout.ticket_items.y + 2,
            size,
        );
        assert_eq!(model.focus, Focus::Tickets);
        assert_eq!(model.selected_ticket, 1);

        // Clicking the left half of the ticket switcher moves Active -> All.
        handle_mouse(
            &mut model,
            layout.ticket_switcher.x,
            layout.ticket_switcher.y,
            size,
        );
        assert_eq!(model.ticket_tab, crate::model::TicketTab::All);

        // Details is the middle panel; clicking its right switcher half advances the view.
        handle_mouse(
            &mut model,
            layout.detail_switcher.x + layout.detail_switcher.width * 3 / 4,
            layout.detail_switcher.y,
            size,
        );
        assert_eq!(model.focus, Focus::Details);
        assert_eq!(model.detail_panel, crate::model::Panel::Planning);

        // The graph is the rightmost panel.
        handle_mouse(&mut model, layout.graph.x, layout.graph.y, size);
        assert_eq!(model.focus, Focus::Graph);
    }

    #[test]
    fn pending_questions_and_agents_receive_standalone_mouse_focus() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[{
                    "id":"question-secret",
                    "status":"open",
                    "prompt":"Choose a storage strategy",
                    "options":[{"id":"local","label":"Local first","recommended":true}]
                }],
                "stages":[{"definition":{"id":"plan","title":"Plan storage"}}],
                "agents":[{"id":"agent-secret","stage_id":"plan","persona":"planner","status":"running"}]
            }),
        );
        let size = ratatui::layout::Size::new(82, 24);
        let area = Rect::new(0, 4, size.width, size.height.saturating_sub(5));
        let layout = ui::operate_layout_with_questions(area, true);
        let questions = layout.pending_questions.unwrap();

        handle_mouse(&mut model, questions.x + 1, questions.y + 1, size);
        assert_eq!(model.focus, Focus::Questions);
        assert_eq!(model.selected_question, 0);
        assert!(model.dialog.is_none());

        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            model.dialog,
            Some(Dialog::AnswerQuestion(ref answer))
                if answer.prompt == "Choose a storage strategy"
        ));

        model.dialog = None;
        handle_mouse(
            &mut model,
            layout.active_agents.x + 1,
            layout.active_agents.y + 1,
            size,
        );
        assert_eq!(model.focus, Focus::Agents);
        assert_eq!(model.selected_agent, 0);
    }

    #[test]
    fn answered_batch_member_can_explicitly_revise_while_a_sibling_is_open() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[
                    {
                        "id":"answered-secret",
                        "status":"answered_pending_resume",
                        "prompt":"Choose rejection behavior",
                        "batch":{"id":"batch-secret","ordinal":1,"size":2},
                        "options":[
                            {"id":"raise","label":"Raise","description":"Raise an error","recommended":true},
                            {"id":"return","label":"Return false","description":"Return a sentinel","recommended":false}
                        ],
                        "answer":{"option_id":"raise"}
                    },
                    {
                        "id":"open-secret",
                        "status":"open",
                        "prompt":"Choose element policy",
                        "batch":{"id":"batch-secret","ordinal":2,"size":2},
                        "options":[{"id":"strict","label":"Strict","description":"Require integers","recommended":true}]
                    }
                ]
            }),
        );
        model.open_pending_question(0);
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Down, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        let command = mutation_rx.try_recv().expect("revision command");
        assert!(matches!(
            command,
            WorkerCommand::ReviseQuestion {
                ref run_id,
                ref question_id,
                option_id: Some(ref option_id),
                custom_answer: None,
                ..
            } if run_id == "run-secret"
                && question_id == "answered-secret"
                && option_id == "return"
        ));
        assert!(model.dialog.is_none());
        assert_eq!(model.status, "updating saved answer…");
    }

    #[test]
    fn final_question_submission_closes_before_the_worker_event_returns() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[{
                    "id":"final-secret",
                    "status":"open",
                    "prompt":"Choose the final contract",
                    "batch":{"id":"batch-secret","ordinal":2,"size":2},
                    "options":[{
                        "id":"safe",
                        "label":"Safe",
                        "description":"Use the safe contract",
                        "recommended":true
                    }]
                }]
            }),
        );
        model.open_pending_question(0);
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::AnswerQuestion {
                ref run_id,
                ref question_id,
                ..
            }) if run_id == "run-secret" && question_id == "final-secret"
        ));
        assert!(model.dialog.is_none());
        assert_eq!(model.status, "planner resume requested · see Agents");
    }

    #[test]
    fn late_question_failure_stays_visible_and_points_to_durable_retry() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[{
                    "id":"question-secret",
                    "status":"open",
                    "prompt":"Choose a contract",
                    "options":[{"id":"safe","label":"Safe"}]
                }]
            }),
        );
        model.dialog = None;

        apply_question_submission_failed(&mut model, "run-secret", "resume transport failed");

        assert_eq!(
            model.status,
            "question update failed: resume transport failed · reopen Pending Questions to retry"
        );
        assert!(!model.status.contains("run-secret"));
        assert!(!model.status.contains("question-secret"));
    }

    #[test]
    fn deferred_batch_answer_closes_modal_and_selects_the_next_open_question() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[
                    {
                        "id":"first-secret",
                        "status":"open",
                        "prompt":"First decision",
                        "batch":{"id":"batch-secret","ordinal":1,"size":2},
                        "options":[{"id":"one","label":"One","description":"First","recommended":true}]
                    },
                    {
                        "id":"second-secret",
                        "status":"open",
                        "prompt":"Second decision",
                        "batch":{"id":"batch-secret","ordinal":2,"size":2},
                        "options":[{"id":"two","label":"Two","description":"Second","recommended":true}]
                    }
                ]
            }),
        );
        model.open_pending_question(0);
        let operation_id = match &model.dialog {
            Some(Dialog::AnswerQuestion(answer)) => answer.operation_id.clone(),
            _ => panic!("question modal did not open"),
        };

        apply_question_answered(
            &mut model,
            &operation_id,
            "run-secret",
            "first-secret",
            true,
            1,
            false,
        );

        assert!(model.dialog.is_none());
        assert_eq!(model.selected_question, 1);
        assert_eq!(model.status, "✓ answer saved · 1 remaining");
    }

    #[test]
    fn final_batch_event_closes_member_modal_even_when_resume_directive_uses_batch_id() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[{
                    "id":"member-secret",
                    "status":"open",
                    "prompt":"Final decision",
                    "batch":{"id":"batch-secret","ordinal":2,"size":2},
                    "options":[{"id":"safe","label":"Safe","description":"Use safe behavior","recommended":true}]
                }]
            }),
        );
        model.open_pending_question(0);
        let operation_id = match &model.dialog {
            Some(Dialog::AnswerQuestion(answer)) => answer.operation_id.clone(),
            _ => panic!("question modal did not open"),
        };
        let event = QuestionAnsweredEvent {
            operation_id,
            run_id: "run-secret".to_owned(),
            submitted_question_id: "member-secret".to_owned(),
            answered: koni_core::AnsweredQuestion {
                directive: koni_core::ResumeDirective {
                    question_id: "batch-secret".to_owned(),
                    session_id: "session-secret".to_owned(),
                    working_directory: None,
                    prompt: "Resume the batch".to_owned(),
                    context_hash: format!("sha256:{}", "0".repeat(64)),
                },
                worker_pid: Some(42),
                resumed_same_session: true,
                resume_deferred: false,
                remaining_questions: 0,
            },
        };

        apply_question_answered_event(&mut model, &event);

        assert!(model.dialog.is_none());
        assert_eq!(
            model.status,
            "✓ answer recorded · agent resumed in the same session"
        );
    }

    #[test]
    fn mouse_wheel_over_agents_routes_scroll_to_agent_history() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"active"},
                "agents":[
                    {"id":"a-secret","persona":"planner","status":"completed"},
                    {"id":"b-secret","persona":"builder","status":"completed"},
                    {"id":"c-secret","persona":"reviewer","status":"completed"}
                ]
            }),
        );
        let size = ratatui::layout::Size::new(82, 24);
        let area = Rect::new(0, 4, size.width, size.height.saturating_sub(5));
        let agents = ui::operate_layout(area).active_agents;

        scroll_at(&mut model, agents.x + 1, agents.y + 1, size, 1);

        assert_eq!(model.focus, Focus::Agents);
        assert_eq!(model.selected_agent, 1);
        scroll_at(&mut model, agents.x + 1, agents.y + 1, size, 8);
        assert_eq!(model.selected_agent, 2);
        scroll_at(&mut model, agents.x + 1, agents.y + 1, size, -1);
        assert_eq!(model.selected_agent, 1);
    }

    #[test]
    fn contextual_help_blocks_mouse_wheel_changes_to_the_underlying_panel() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"active"},
                "agents":[
                    {"id":"a-secret","persona":"planner","status":"completed"},
                    {"id":"b-secret","persona":"builder","status":"completed"}
                ]
            }),
        );
        model.focus = Focus::Agents;
        model.dialog = Some(Dialog::Help(HelpTopic::Agents));
        let size = ratatui::layout::Size::new(82, 24);
        let area = Rect::new(0, 4, size.width, size.height.saturating_sub(5));
        let agents = ui::operate_layout(area).active_agents;

        scroll_at(&mut model, agents.x + 1, agents.y + 1, size, 1);

        assert_eq!(model.focus, Focus::Agents);
        assert_eq!(model.selected_agent, 0);
        assert!(matches!(
            model.dialog,
            Some(Dialog::Help(HelpTopic::Agents))
        ));
    }

    #[test]
    fn runs_space_and_delete_target_only_the_highlighted_run() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"first-private","goal":"First","status":"active"},
                "lifecycle":{"running":true,"draining":false,"active_agents":0}
            }),
        );
        model.runs.push(crate::model::RunData::from_snapshot(json!({
            "run":{"id":"selected-private","goal":"Selected","status":"active"},
            "lifecycle":{"running":true,"draining":false,"active_agents":0}
        })));
        model.selected_run = 1;
        model.focus = Focus::Runs;
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::SetRunRunning { ref run_id, running: false })
                if run_id == "selected-private"
        ));

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('D'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::InspectRunDeletion { ref run_id })
                if run_id == "selected-private"
        ));
    }

    #[test]
    fn operate_mouse_boundaries_use_the_exact_rendered_rectangles() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));

        for width in [82, 83, 119] {
            let size = ratatui::layout::Size::new(width, 24);
            let layout =
                ui::operate_layout(Rect::new(0, 4, size.width, size.height.saturating_sub(5)));
            handle_mouse(&mut model, layout.details.x, layout.details.y, size);
            assert_eq!(model.focus, Focus::Details, "width {width}");
            handle_mouse(&mut model, layout.graph.x, layout.graph.y, size);
            assert_eq!(model.focus, Focus::Graph, "width {width}");
        }
    }

    #[test]
    fn configure_mouse_drills_from_domain_to_resource_to_guided_field() {
        for width in [82, 83, 119] {
            let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
            model.mode = Mode::Configure;
            model.config.documents.push(crate::model::ConfigDocument {
                relative_path: "project.yaml".into(),
                source_path: "/tmp/demo/.codex/koni/project.yaml".into(),
                draft_path: "/tmp/demo/.git/koni/config-drafts/project.yaml".into(),
                original: String::new(),
                text: "schema_version: '1.0'\nproject: {id: demo, title: Demo}\ndefault_run_type: small\nrun_types: [{id: small, path: run-types/small.yaml}]\n"
                    .to_owned(),
                diagnostics: Vec::new(),
                cursor_line: 0,
                cursor_column: 0,
                is_new: false,
            });
            model.config.rebuild_projection();
            let size = ratatui::layout::Size::new(width, 24);
            let area = Rect::new(0, 4, size.width, size.height.saturating_sub(5));
            let layout = ui::configure_layout(area);

            handle_mouse(
                &mut model,
                layout.domains.x.saturating_add(1),
                layout
                    .domains
                    .y
                    .saturating_add(1 + ConfigDomain::RunTypes.index() as u16),
                size,
            );
            assert_eq!(
                model.config.selected_domain(),
                ConfigDomain::RunTypes,
                "width {width}"
            );
            assert_eq!(model.focus, Focus::ConfigTree, "width {width}");

            handle_mouse(
                &mut model,
                layout.resources.x.saturating_add(1),
                layout.resources.y.saturating_add(1),
                size,
            );
            assert_eq!(model.focus, Focus::ConfigForm, "width {width}");

            let field_hit = (layout.editor.y..layout.editor.bottom()).find_map(|row| {
                (layout.editor.x..layout.editor.right())
                    .find(|column| ui::configure_field_at(&model, *column, row, area).is_some())
                    .map(|column| (column, row))
            });
            let (column, row) = field_hit.expect("default run type field should be clickable");
            handle_mouse(&mut model, column, row, size);
            assert_eq!(model.focus, Focus::Yaml, "width {width}");
            assert_eq!(model.config.selected_form_row, 0, "width {width}");
        }
    }

    #[test]
    fn numeric_focus_keys_follow_the_visual_operate_order() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), json!(null));
        let (mutation_tx, _mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('3'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert_eq!(model.focus, Focus::Details);

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('4'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert_eq!(model.focus, Focus::Agents);

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('5'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert_eq!(model.focus, Focus::Graph);
    }

    #[test]
    fn configured_orchestration_keys_take_precedence_over_legacy_focus_keys() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run","goal":"Demo","status":"active","profile_id":"research"},
                "orchestration":{"running":true,"max_parallel":3,"unchained":false},
                "views":[{
                    "id":"orchestration-controls",
                    "kind":"controls",
                    "options":{"keybindings":{"toggle":"space","parallel_3":"3","parallel_5":"5","unchained":"u"}}
                }]
            }),
        );
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('3'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        assert_eq!(model.focus, Focus::Runs);
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::UpdateOrchestration {
                max_parallel: Some(3),
                unchained: Some(false),
                ..
            })
        ));

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('5'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::UpdateOrchestration {
                max_parallel: Some(5),
                unchained: Some(false),
                ..
            })
        ));

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('u'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::UpdateOrchestration {
                max_parallel: None,
                unchained: Some(true),
                ..
            })
        ));
    }

    #[test]
    fn configured_orchestration_cannot_claim_protected_panel_keys() {
        for &character in PROTECTED_CONFIGURED_ORCHESTRATION_KEYS {
            let model = ControlCenterModel::from_snapshot(
                "/tmp/demo".into(),
                json!({
                    "run":{"id":"run","goal":"Demo","status":"active","profile_id":"research"},
                    "orchestration":{"running":true,"max_parallel":3,"unchained":false},
                    "views":[{
                        "id":"orchestration-controls",
                        "kind":"controls",
                        "options":{"keybindings":{"toggle":character.to_string()}}
                    }]
                }),
            );

            assert!(
                configured_orchestration_shortcut(
                    &model,
                    KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE),
                )
                .is_none(),
                "configured orchestration claimed protected key {character:?}"
            );
        }
    }

    #[test]
    fn protected_refresh_binding_dispatches_refresh_instead_of_orchestration() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run","goal":"Demo","status":"active","profile_id":"research"},
                "orchestration":{"running":true,"max_parallel":3,"unchained":false},
                "views":[{
                    "id":"orchestration-controls",
                    "kind":"controls",
                    "options":{"keybindings":{"toggle":"r"}}
                }]
            }),
        );
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();

        assert!(matches!(refresh_rx.try_recv(), Ok(RefreshCommand::Refresh)));
        assert!(mutation_rx.try_recv().is_err());
        assert_eq!(model.status, "refreshing…");
    }

    #[test]
    fn configured_space_preserves_runs_pause_and_toggles_elsewhere() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/demo".into(),
            json!({
                "run":{"id":"run","goal":"Demo","status":"active","profile_id":"research"},
                "lifecycle":{"running":true,"draining":false,"active_agents":0},
                "orchestration":{"running":true,"max_parallel":3,"unchained":false},
                "views":[{
                    "id":"orchestration-controls",
                    "kind":"controls",
                    "options":{"keybindings":{"toggle":"space"}}
                }]
            }),
        );
        let (mutation_tx, mutation_rx) = mpsc::channel();
        let (refresh_tx, _refresh_rx) = mpsc::channel();
        let workers = WorkerHandle {
            mutation_tx,
            refresh_tx,
        };

        model.focus = Focus::Runs;
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::SetRunRunning {
                ref run_id,
                running: false
            }) if run_id == "run"
        ));

        model.focus = Focus::Tickets;
        handle_key(
            &mut model,
            KeyEvent::new(KeyCode::Char(' '), KeyModifiers::NONE),
            &workers,
        )
        .unwrap();
        assert!(matches!(
            mutation_rx.try_recv(),
            Ok(WorkerCommand::UpdateOrchestration {
                ref run_id,
                running: Some(false),
                ..
            }) if run_id == "run"
        ));
    }

    #[test]
    fn action_execution_root_distinguishes_project_and_ticket_actions() {
        let project = Path::new("/tmp/project");
        let ticket = Path::new("/tmp/project-ticket");

        assert_eq!(
            action_execution_root(project, None, false).unwrap(),
            project
        );
        assert_eq!(
            action_execution_root(project, Some(ticket), true).unwrap(),
            ticket
        );
    }

    #[test]
    fn action_engine_accepts_only_the_matching_compatibility_run() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("compat-project");
        let profile = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../profiles/research");
        let mut engine = Engine::open_with_profile(&root, Some(&profile)).unwrap();
        let run_id = engine.initialize_run("Compatibility smoke").unwrap();
        let ticket_id = engine.inspect().unwrap().eligible_tickets[0].clone();

        let mut opened = open_action_engine(&root, &run_id).unwrap();
        assert_eq!(opened.inspect().unwrap().run_id, run_id);
        opened
            .execute_action(
                "start",
                BTreeMap::from([("ticket_id".to_owned(), ticket_id.clone())]),
            )
            .unwrap();
        assert!(
            opened
                .inspect()
                .unwrap()
                .active_tickets
                .contains(&ticket_id)
        );
        assert!(open_action_engine(&root, "different-run").is_err());

        // The presence of a modern project registry turns every `open_run` failure into an
        // authoritative trust failure; matching legacy state may no longer bypass it.
        Engine::project_registry(&root).unwrap();
        assert!(open_action_engine(&root, &run_id).is_err());
    }
}
