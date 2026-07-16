use std::collections::{BTreeMap, BTreeSet};
#[cfg(unix)]
use std::ffi::{CString, OsStr, OsString};
use std::fs;
use std::io::{BufRead, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::sync::Mutex;
use std::time::Duration;

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use anyhow::Context;
use clap::{Parser, Subcommand, ValueEnum};
use koni_core::parity::ParityComparator;
use koni_core::{
    Engine, HashedMigrationFile, KONI_SCHEMA2_VERSION, PiMigrationRunArchiveResult,
    PiMigrationRunPlan, ProfileCompiler, ProjectCatalogCompiler, QuestionRecord, RunDeletionMode,
    SCHEMA2_RESOURCE_MANIFEST, Schema2MigrationPlan, Schema2MigrationResult, Schema2Migrator,
    wait_for_spawned_agent_reapers,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use walkdir::WalkDir;

mod agent_mcp;
mod pi_control;
mod templates;

const NATIVE_RESOURCE_MANIFEST: &str = "native-codex-resources.json";
const LEGACY_PROFILE_DIRECTORY: &str = "pythagoras";

#[derive(Debug, Parser)]
#[command(
    name = "koni",
    version,
    about = "Configuration-driven agentic coding control center"
)]
struct Cli {
    /// Select a durable run for automation-oriented commands.
    #[arg(long, global = true)]
    run: Option<String>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Install a validated Koni profile into an existing project.
    Install {
        /// A profile bundled with this executable.
        #[arg(
            value_enum,
            required_unless_present = "source",
            conflicts_with = "source"
        )]
        profile: Option<BuiltinProfile>,
        /// Install a custom profile directory instead of a bundled profile.
        #[arg(long = "from", value_name = "PATH", conflicts_with = "profile")]
        source: Option<PathBuf>,
        /// Existing project directory that receives `.koni`.
        #[arg(long, default_value = ".")]
        target: PathBuf,
        /// Replace an existing `.koni` after validation succeeds.
        #[arg(long)]
        replace: bool,
        /// Open the control center after installation.
        #[arg(long)]
        open: bool,
    },
    /// List all durable runs registered for a project.
    Runs {
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Gracefully pause one run. Active agents drain at their durable boundary.
    PauseRun {
        id: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Play one paused run, resuming planning or automatic scheduling.
    PlayRun {
        id: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Preview or safely delete one compiler-owned run namespace.
    DeleteRun {
        id: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        /// Inspect blockers and owned artifacts without changing anything.
        #[arg(long)]
        preview: bool,
        /// Delete proven run/ticket branches as well as runtime state and worktrees.
        #[arg(long)]
        delete_owned_branches: bool,
    },
    /// Pin a run and create its detached planning checkout.
    PlanRun {
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long)]
        run_type: Option<String>,
        /// User-owned local branch that will receive the finished run.
        #[arg(long, value_name = "BRANCH", conflicts_with = "base")]
        target_branch: Option<String>,
        /// Legacy target-less mode pinned to an arbitrary revision.
        #[arg(long, value_name = "REF", conflicts_with = "target_branch")]
        base: Option<String>,
        #[arg(long)]
        question_policy: Option<String>,
        #[arg(long)]
        goal: String,
    },
    /// Approve a plan and create the permanent run branch/worktree.
    ApproveRun {
        id: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Preview or authorize promotion of a ready run into its selected target branch.
    MergeRun {
        id: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        /// Show target drift, checkout cleanliness, tickets, and blockers only.
        #[arg(long)]
        preview: bool,
    },
    /// Advance the automatic stages of one approved run by one durable tick.
    SuperviseRun {
        id: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Re-open a failed automatic stage after its recovery guidance is addressed.
    RetrySupervisedStage {
        id: String,
        stage: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Retry or resume the current durable planning-agent stage.
    ResumePlanning {
        id: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Answer a structured agent question and resume its bound Pi session.
    AnswerQuestion {
        id: String,
        #[arg(long)]
        option: Option<String>,
        #[arg(long)]
        custom: Option<String>,
        /// Optional context to attach to a selected option.
        #[arg(long)]
        notes: Option<String>,
        /// Revise a saved planning-batch answer before its remaining questions are resolved.
        #[arg(long)]
        revise: bool,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Resolve due configured automatic answers and resume their sessions.
    ResolveQuestions {
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Internal agent/integration ingress for one structured Koni question.
    RecordAgentQuestion {
        #[arg(long, default_value = ".")]
        root: PathBuf,
        /// Read the question from this JSON/YAML file; omit to read stdin.
        #[arg(long, value_name = "FILE")]
        input: Option<PathBuf>,
        /// Override input detection (normally inferred from the file extension/content).
        #[arg(long, value_enum, default_value_t = QuestionInputFormat::Auto)]
        format: QuestionInputFormat,
    },
    /// Initialize a configured external-loop pipeline stage for a run.
    StartExternalLoop {
        stage: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Advance one durable GitHub/CI/Greptile loop phase without sleeping.
    DriveExternalLoop {
        id: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Confirm a manual/handoff stage or execute a compiler-owned checkpoint.
    DriveStage {
        stage: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Validate and compile a project profile.
    ValidateProfile { path: PathBuf },
    /// Validate the current graph, tickets, and profile without deriving work.
    Validate {
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Generate UUIDv7 graph identifiers.
    NewId {
        #[arg(long, default_value_t = 1)]
        count: usize,
    },
    /// Install Koni into the current project.
    Init {
        /// A profile bundled with this executable. Interactive fresh installs prompt when omitted.
        #[arg(long, value_enum, conflicts_with = "source")]
        profile: Option<BuiltinProfile>,
        /// Install a custom profile directory instead of a bundled profile.
        #[arg(long = "from", value_name = "PATH", conflicts_with = "profile")]
        source: Option<PathBuf>,
        /// Initialize this exact directory instead of discovering the project root.
        #[arg(long, value_name = "PATH")]
        target: Option<PathBuf>,
        /// Replace resources owned by an existing Koni installation.
        #[arg(long)]
        replace: bool,
        /// Open the control center after initialization.
        #[arg(long)]
        open: bool,
        /// Describe the initialization or migration without changing files.
        #[arg(long)]
        dry_run: bool,
    },
    /// Initialize a run in an already configured repository.
    InitRun {
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long)]
        profile: Option<PathBuf>,
        #[arg(long)]
        goal: String,
    },
    /// Create a new repository and initialize its first run.
    InitProject {
        path: PathBuf,
        #[arg(long)]
        profile: PathBuf,
        #[arg(long, alias = "hypothesis")]
        goal: String,
        /// Deprecated compatibility flag. Existing project files are never removed.
        #[arg(long)]
        force: bool,
    },
    /// Compile graph state and emit/update eligible tickets.
    Compile {
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long)]
        full: bool,
        ticket: Option<String>,
        #[arg(long, default_value = "")]
        summary: String,
    },
    Start {
        ticket: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    SpawnLead {
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Print the compact compiler-issued packet for the current fresh Lead slice.
    LeadNext {
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Securely hand a completed Lead boundary back to the supervisor.
    YieldLead {
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long)]
        reason: String,
    },
    SpawnWorker {
        ticket: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(
            long,
            default_value = "Continue the next dependency-ready ticket step from the compiled context."
        )]
        prompt: String,
    },
    /// Wait for the first durable boundary among selected detached workers.
    WaitWorker {
        /// One or more caller-known live ticket IDs; returns when any is actionable.
        #[arg(required = true, num_args = 1..)]
        tickets: Vec<String>,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        /// Bounded wait duration; rerun the command after an ordinary timeout.
        #[arg(
            long,
            default_value_t = 300,
            value_parser = clap::value_parser!(u64).range(1..=900)
        )]
        timeout_seconds: u64,
    },
    Context {
        ticket: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long)]
        step: Option<String>,
        #[arg(long)]
        persona: Option<String>,
        /// Print the complete compiled document instead of its path result.
        #[arg(long)]
        print: bool,
    },
    /// Read a bounded graph neighborhood within one compiler-issued ticket scope.
    GraphContext {
        ticket: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long = "anchor")]
        anchors: Vec<String>,
        #[arg(long = "relation")]
        relations: Vec<String>,
        #[arg(
            long,
            default_value = "both",
            value_parser = ["outgoing", "incoming", "both"]
        )]
        direction: String,
        #[arg(long, default_value_t = 1)]
        max_depth: usize,
        #[arg(long = "node-type")]
        node_types: Vec<String>,
    },
    /// Append a non-authoritative working note to a graph node in ticket scope.
    RecordNote {
        ticket: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long)]
        step: String,
        #[arg(long, default_value = "operator")]
        persona: String,
        #[arg(long)]
        node_id: String,
        #[arg(
            long,
            value_parser = [
                "observation",
                "implementation_detail",
                "rationale",
                "nit",
                "open_question"
            ]
        )]
        kind: String,
        #[arg(long)]
        body: String,
        #[arg(long)]
        supersedes: Option<String>,
    },
    Output {
        ticket: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long)]
        step: String,
        #[arg(long)]
        persona: String,
        #[arg(long = "finding")]
        findings: Vec<String>,
        #[arg(long = "risk")]
        risks: Vec<String>,
        #[arg(long = "file-read")]
        files_read: Vec<String>,
        #[arg(long = "file-written")]
        files_written: Vec<String>,
        #[arg(long = "file-deleted")]
        files_deleted: Vec<String>,
        #[arg(long = "receipt")]
        receipts: Vec<String>,
        #[arg(long, default_value = "")]
        patch_proposal: String,
        #[arg(long, default_value = "")]
        recommended_next_step: String,
        /// Optional JSON object merged into the structured payload.
        #[arg(long, conflicts_with = "payload_stdin")]
        payload: Option<String>,
        /// Read the JSON payload object from stdin; preferred for nontrivial payloads.
        #[arg(long, conflicts_with = "payload")]
        payload_stdin: bool,
    },
    Review {
        ticket: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    Finish {
        ticket: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long, default_value = "")]
        message: String,
    },
    Steer {
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long)]
        kind: String,
        #[arg(long)]
        message: String,
        #[arg(long)]
        ticket: Option<String>,
        #[arg(long = "target-node")]
        target_nodes: Vec<String>,
        #[arg(long)]
        priority: Option<String>,
    },
    Report {
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Manage the ChatGPT subscription OAuth credential used by the Pi runtime.
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    /// List the OpenAI models exposed by Koni's pinned Pi provider registry.
    Models {
        /// Print runtime metadata and model descriptors as JSON.
        #[arg(long)]
        json: bool,
    },
    Migrate {
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Transactionally migrate `.codex/koni` and its Codex-backed runs to schema 2 for Pi.
    MigratePi {
        #[arg(long, default_value = ".")]
        root: PathBuf,
        /// Print the hash-pinned configuration and run-disposition plan without writing.
        #[arg(long, conflicts_with = "apply", required_unless_present = "apply")]
        dry_run: bool,
        /// Archive eligible Codex-backed runs, validate staging, and publish `.koni`.
        #[arg(long, conflicts_with = "dry_run", required_unless_present = "dry_run")]
        apply: bool,
    },
    Recover {
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    Rollback {
        target: String,
        #[arg(long)]
        reason: String,
        /// Prove and print the exact semantic reversal without writing state or Git refs.
        #[arg(long)]
        dry_run: bool,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    Cockpit {
        #[arg(default_value = ".")]
        root: PathBuf,
        /// Print the deterministic machine-readable cockpit projection.
        #[arg(long)]
        json: bool,
    },
    /// Execute any configured lifecycle action directly.
    Action {
        action: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long = "param", value_parser = parse_key_value)]
        params: Vec<(String, String)>,
    },
    /// Print the deterministic board as JSON.
    Inspect {
        #[arg(long, default_value = ".")]
        root: PathBuf,
        /// Return one live projected ticket card instead of the board summary.
        #[arg(long)]
        ticket: Option<String>,
    },
    /// Normalize and structurally compare two oracle/runtime capture files.
    CompareCaptures {
        #[arg(long)]
        policy: PathBuf,
        left: PathBuf,
        right: PathBuf,
        #[arg(long, default_value_t = 100)]
        max_diffs: usize,
    },
    /// Internal stdio MCP broker for one compiler-owned Codex process.
    #[command(hide = true)]
    AgentMcp {
        #[arg(long)]
        grant: String,
        #[arg(long)]
        agent_id: String,
        #[arg(long)]
        attempt: u32,
    },
}

#[derive(Debug, Subcommand)]
enum AuthCommand {
    /// Show token-free subscription sign-in status.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Sign in with ChatGPT through Pi's standard browser OAuth flow.
    Login {
        #[arg(long)]
        json: bool,
    },
    /// Delete Koni's stored OpenAI subscription credential.
    Logout {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum BuiltinProfile {
    /// Evidence-guided vertical software delivery.
    Software,
    /// Graph-first academic research.
    Research,
}

impl BuiltinProfile {
    fn label(self) -> &'static str {
        match self {
            Self::Software => "software",
            Self::Research => "research",
        }
    }

    fn files(self) -> &'static [templates::EmbeddedFile] {
        match self {
            Self::Software => templates::SOFTWARE,
            Self::Research => templates::RESEARCH,
        }
    }

    fn codex_files(self) -> &'static [templates::EmbeddedFile] {
        match self {
            Self::Software => templates::SOFTWARE_CODEX,
            Self::Research => templates::RESEARCH_CODEX,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum QuestionInputFormat {
    Auto,
    Json,
    Yaml,
}

fn parse_key_value(raw: &str) -> std::result::Result<(String, String), String> {
    let (key, value) = raw
        .split_once('=')
        .ok_or_else(|| "parameters must use key=value".to_owned())?;
    if key.trim().is_empty() {
        return Err("parameter key must not be empty".to_owned());
    }
    Ok((key.to_owned(), value.to_owned()))
}

fn main() -> anyhow::Result<()> {
    dispatch(Cli::parse())
}

fn dispatch(cli: Cli) -> anyhow::Result<()> {
    let selected_run = cli.run.clone();
    let command = match cli.command {
        Some(command) => command,
        None => Command::Cockpit {
            root: discover_project_root(None)?,
            json: false,
        },
    };
    match command {
        Command::Install {
            profile,
            source,
            target,
            replace,
            open,
        } => {
            let installed = install_schema2_profile(&target, profile, source.as_deref(), replace)?;
            println!(
                "Installed Koni {} profile at {}\nValidated {} {}",
                installed.source,
                installed.destination.display(),
                installed.profile_id,
                installed.profile_version
            );
            if open {
                let project_root = installed.destination.parent().ok_or_else(|| {
                    anyhow::anyhow!("installed configuration has no project root")
                })?;
                koni_tui::run(koni_tui::RunOptions {
                    root: project_root.to_path_buf(),
                    ..koni_tui::RunOptions::default()
                })?;
            }
        }
        Command::Runs { root } => print_json(&Engine::project_registry(&root)?)?,
        Command::PauseRun { id, root } => print_json(&Engine::set_run_running(&root, &id, false)?)?,
        Command::PlayRun { id, root } => print_json(&Engine::set_run_running(&root, &id, true)?)?,
        Command::DeleteRun {
            id,
            root,
            preview,
            delete_owned_branches,
        } => {
            if preview {
                print_json(&Engine::inspect_run_deletion(&root, &id)?)?;
            } else {
                let mode = if delete_owned_branches {
                    RunDeletionMode::DeleteOwnedBranches
                } else {
                    RunDeletionMode::PreserveBranches
                };
                print_json(&Engine::delete_run(&root, &id, mode)?)?;
            }
        }
        Command::PlanRun {
            root,
            run_type,
            target_branch,
            base,
            question_policy,
            goal,
        } => {
            let planned = if let Some(base) = base.as_deref() {
                Engine::plan_run(
                    &root,
                    run_type.as_deref(),
                    &goal,
                    base,
                    question_policy.as_deref(),
                )?
            } else {
                Engine::plan_run_on_target(
                    &root,
                    run_type.as_deref(),
                    &goal,
                    target_branch.as_deref().unwrap_or("HEAD"),
                    question_policy.as_deref(),
                )?
            };
            let planning_agent = Engine::record_planning_intake(
                &root,
                &planned.run_id,
                json!({
                    "goal": goal,
                    "run_type": planned.run_type_id,
                    "target_branch": planned.target_branch.clone(),
                    "base_ref": base,
                    "question_policy": planned.question_policy,
                }),
            )?;
            let mut response = serde_json::to_value(&planned)?;
            response["planning_agent"] = serde_json::to_value(planning_agent)?;
            print_json(&response)?;
        }
        Command::ApproveRun { id, root } => {
            let approved = Engine::approve_run(&root, &id)?;
            if let Err(error) = Engine::supervise_run_once(&root, &id) {
                eprintln!(
                    "Warning: run approval succeeded, but automatic supervision could not start: {error}"
                );
            }
            print_json(&approved)?;
        }
        Command::MergeRun { id, root, preview } => {
            if preview {
                print_json(&Engine::preview_run_promotion(&root, &id)?)?;
            } else {
                let authorization = Engine::authorize_run_promotion(&root, &id)?;
                let supervision = Engine::supervise_run_once(&root, &id)?;
                print_json(&json!({
                    "authorization": authorization,
                    "supervision": supervision,
                }))?;
            }
        }
        Command::SuperviseRun { id, root } => print_json(&Engine::supervise_run_once(&root, &id)?)?,
        Command::RetrySupervisedStage { id, stage, root } => {
            Engine::retry_supervised_stage(&root, &id, &stage)?;
            print_json(&Engine::supervise_run_once(&root, &id)?)?;
        }
        Command::ResumePlanning { id, root } => {
            print_json(&Engine::resume_planning_agent(&root, &id)?)?
        }
        Command::AnswerQuestion {
            id,
            option,
            custom,
            notes,
            revise,
            root,
        } => {
            let run_id = selected_run.as_deref().ok_or_else(|| {
                anyhow::anyhow!("answer-question requires the global --run <run-id> option")
            })?;
            let answered = if revise {
                Engine::revise_planning_batch_answer_with_notes(
                    &root,
                    run_id,
                    &id,
                    option.as_deref(),
                    custom.as_deref(),
                    notes.as_deref(),
                )
            } else {
                Engine::answer_question_with_notes(
                    &root,
                    run_id,
                    &id,
                    option.as_deref(),
                    custom.as_deref(),
                    notes.as_deref(),
                )
            }?;
            print_json(&answered)?;
        }
        Command::ResolveQuestions { root } => {
            let run_id = selected_run.as_deref().ok_or_else(|| {
                anyhow::anyhow!("resolve-questions requires the global --run <run-id> option")
            })?;
            print_json(&Engine::resolve_due_questions(&root, run_id)?)?;
        }
        Command::RecordAgentQuestion {
            root,
            input,
            format,
        } => {
            let run_id = selected_run.as_deref().ok_or_else(|| {
                anyhow::anyhow!("record-agent-question requires the global --run <run-id> option")
            })?;
            let source = read_question_input(input.as_deref())?;
            let question = record_agent_question(
                &root,
                run_id,
                &source.contents,
                infer_question_format(format, input.as_deref()),
                &source.label,
            )?;
            print_json(&question)?;
        }
        Command::StartExternalLoop { stage, root } => {
            let run_id = selected_run.as_deref().ok_or_else(|| {
                anyhow::anyhow!("start-external-loop requires global --run <run-id>")
            })?;
            print_json(&Engine::start_external_loop(&root, run_id, &stage)?)?;
        }
        Command::DriveExternalLoop { id, root } => {
            let run_id = selected_run.as_deref().ok_or_else(|| {
                anyhow::anyhow!("drive-external-loop requires global --run <run-id>")
            })?;
            print_json(&Engine::drive_external_loop(&root, run_id, &id)?)?;
        }
        Command::DriveStage { stage, root } => {
            let run_id = selected_run
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("drive-stage requires global --run <run-id>"))?;
            print_json(&Engine::drive_current_stage(&root, run_id, &stage)?)?;
        }
        Command::ValidateProfile { path } => {
            let profile = ProfileCompiler::compile(&path)?;
            println!(
                "{} {} {}",
                profile.manifest.profile.id, profile.manifest.profile.version, profile.hash
            );
        }
        Command::Validate { root } => {
            let engine = open_engine(&root, selected_run.as_deref())?;
            let errors = engine.validate()?;
            if errors.is_empty() {
                println!("Valid");
            } else {
                anyhow::bail!(errors.join("\n"));
            }
        }
        Command::NewId { count } => {
            anyhow::ensure!(count > 0, "--count must be at least one");
            for _ in 0..count {
                println!("{}", Uuid::now_v7());
            }
        }
        Command::Init {
            profile,
            source,
            target,
            replace,
            open,
            dry_run,
        } => initialize_project(
            profile,
            source.as_deref(),
            target.as_deref(),
            replace,
            open,
            dry_run,
        )?,
        Command::InitRun {
            root,
            profile,
            goal,
        } => initialize(root, profile, goal)?,
        Command::InitProject {
            path,
            profile,
            goal,
            force,
        } => initialize_legacy_project_run(path, profile, goal, force)?,
        Command::Compile {
            root,
            full,
            ticket,
            summary,
        } => {
            if let Some(ticket) = ticket {
                let mut params = BTreeMap::new();
                if !summary.trim().is_empty() {
                    params.insert("summary".to_owned(), summary);
                }
                execute_ticket_action(
                    &root,
                    selected_run.as_deref(),
                    "compile-ticket",
                    &ticket,
                    params,
                )?;
            } else {
                let mut engine = open_engine(&root, selected_run.as_deref())?;
                if engine.profile().action("compile").is_some() {
                    let mut params = BTreeMap::new();
                    if !summary.trim().is_empty() {
                        params.insert("summary".to_owned(), summary);
                    }
                    let result = engine.execute_action("compile", params)?;
                    print_json(&result)?;
                } else {
                    // Compatibility for profiles predating configured actions.
                    // Ticket-scoped compilation never takes this path because
                    // it could bypass configured validation checks.
                    print_json(&engine.compile(None, full)?)?;
                }
            }
        }
        Command::Start { ticket, root } => {
            execute_ticket_action(
                &root,
                selected_run.as_deref(),
                "start",
                &ticket,
                BTreeMap::new(),
            )?;
        }
        Command::SpawnLead { root } => execute_named_action(
            &root,
            selected_run.as_deref(),
            "spawn-lead",
            BTreeMap::new(),
        )?,
        Command::LeadNext { root } => {
            let engine = open_engine(&root, selected_run.as_deref())?;
            print_json(&engine.lead_next()?)?;
        }
        Command::YieldLead { root, reason } => {
            let engine = open_engine(&root, selected_run.as_deref())?;
            print_json(&engine.yield_lead(&reason)?)?;
        }
        Command::SpawnWorker {
            ticket,
            root,
            prompt,
        } => {
            execute_ticket_action(
                &root,
                selected_run.as_deref(),
                "spawn-worker",
                &ticket,
                BTreeMap::from([("prompt".to_owned(), prompt)]),
            )?;
        }
        Command::WaitWorker {
            tickets,
            root,
            timeout_seconds,
        } => {
            let engine = open_engine(&root, selected_run.as_deref())?;
            print_json(&engine.wait_for_workers(&tickets, Duration::from_secs(timeout_seconds))?)?;
        }
        Command::Context {
            ticket,
            root,
            step,
            persona,
            print,
        } => {
            let mut params = BTreeMap::new();
            if let Some(step) = step {
                params.insert("step".to_owned(), step);
            }
            if let Some(persona) = persona {
                params.insert("persona".to_owned(), persona);
            }
            let (engine, result) = execute_ticket_action_value(
                &root,
                selected_run.as_deref(),
                "context",
                &ticket,
                params,
            )?;
            if print {
                let document_path = context_document_path(&result)?;
                print!(
                    "{}",
                    engine.read_compiled_context_document(Path::new(document_path))?
                );
            } else {
                print_json(&result)?;
            }
        }
        Command::GraphContext {
            ticket,
            root,
            anchors,
            relations,
            direction,
            max_depth,
            node_types,
        } => {
            let engine = open_engine(&root, selected_run.as_deref())?;
            print_json(&engine.graph_context(
                &ticket,
                json!({
                    "anchors": anchors,
                    "relations": relations,
                    "direction": direction,
                    "max_depth": max_depth,
                    "node_types": node_types,
                }),
            )?)?;
        }
        Command::RecordNote {
            ticket,
            root,
            step,
            persona,
            node_id,
            kind,
            body,
            supersedes,
        } => {
            let engine = open_engine(&root, selected_run.as_deref())?;
            print_json(&engine.record_graph_note(
                &ticket,
                &step,
                &persona,
                json!({
                    "node_id": node_id,
                    "kind": kind,
                    "body": body,
                    "supersedes": supersedes,
                }),
            )?)?;
        }
        Command::Output {
            ticket,
            root,
            step,
            persona,
            findings,
            risks,
            files_read,
            files_written,
            files_deleted,
            receipts,
            patch_proposal,
            recommended_next_step,
            payload,
            payload_stdin,
        } => {
            let payload = if payload_stdin {
                let mut input = String::new();
                std::io::stdin().read_to_string(&mut input)?;
                Some(input)
            } else {
                payload
            };
            let mut payload_value = payload
                .as_deref()
                .map(serde_json::from_str::<Value>)
                .transpose()?
                .unwrap_or_else(|| json!({}));
            let object = payload_value
                .as_object_mut()
                .ok_or_else(|| anyhow::anyhow!("output payload must be a JSON object"))?;
            for (key, values) in [
                ("findings", findings),
                ("risks", risks),
                ("files_read", files_read),
                ("files_written", files_written),
                ("files_deleted", files_deleted),
                ("receipts", receipts),
            ] {
                if !values.is_empty() || !object.contains_key(key) {
                    object.insert(key.to_owned(), json!(values));
                }
            }
            for (key, value) in [
                ("patch_proposal", patch_proposal),
                ("recommended_next_step", recommended_next_step),
            ] {
                if !value.is_empty() || !object.contains_key(key) {
                    object.insert(key.to_owned(), json!(value));
                }
            }
            execute_ticket_action(
                &root,
                selected_run.as_deref(),
                "output",
                &ticket,
                BTreeMap::from([
                    ("step".to_owned(), step),
                    ("persona".to_owned(), persona),
                    ("payload".to_owned(), serde_json::to_string(&payload_value)?),
                ]),
            )?;
        }
        Command::Review { ticket, root } => {
            let mut engine = open_engine(&root, selected_run.as_deref())?;
            print_json(&engine.review_ticket(&ticket)?)?;
        }
        Command::Finish {
            ticket,
            root,
            message,
        } => {
            execute_ticket_action(
                &root,
                selected_run.as_deref(),
                "finish",
                &ticket,
                BTreeMap::from([("message".to_owned(), message)]),
            )?;
        }
        Command::Steer {
            root,
            kind,
            message,
            ticket,
            target_nodes,
            priority,
        } => {
            let mut params = BTreeMap::from([
                ("kind".to_owned(), kind),
                ("message".to_owned(), message),
                (
                    "target_nodes".to_owned(),
                    serde_json::to_string(&target_nodes)?,
                ),
            ]);
            if let Some(ticket) = ticket {
                params.insert("ticket".to_owned(), ticket);
            }
            if let Some(priority) = priority {
                params.insert("priority".to_owned(), priority);
            }
            execute_named_action(&root, selected_run.as_deref(), "steer", params)?;
        }
        Command::Report { root } => {
            execute_named_action(&root, selected_run.as_deref(), "report", BTreeMap::new())?
        }
        Command::Auth { command } => match command {
            AuthCommand::Status { json } => {
                pi_control::run_auth(pi_control::AuthOperation::Status, json)?
            }
            AuthCommand::Login { json } => {
                pi_control::run_auth(pi_control::AuthOperation::Login, json)?
            }
            AuthCommand::Logout { json } => {
                pi_control::run_auth(pi_control::AuthOperation::Logout, json)?
            }
        },
        Command::Models { json } => pi_control::run_models(json)?,
        Command::Migrate { root } => {
            execute_named_action(&root, selected_run.as_deref(), "migrate", BTreeMap::new())?
        }
        Command::MigratePi {
            root,
            dry_run,
            apply,
        } => {
            debug_assert_ne!(dry_run, apply);
            print_json(&execute_pi_migration(&root, apply)?)?;
        }
        Command::Recover { root } => {
            execute_named_action(&root, selected_run.as_deref(), "recover", BTreeMap::new())?
        }
        Command::Rollback {
            target,
            reason,
            dry_run,
            root,
        } => {
            if dry_run {
                let engine = open_engine(&root, selected_run.as_deref())?;
                print_json(&engine.preview_forward_rollback(&target, &reason)?)?;
            } else {
                execute_named_action(
                    &root,
                    selected_run.as_deref(),
                    "rollback",
                    BTreeMap::from([("target".to_owned(), target), ("reason".to_owned(), reason)]),
                )?;
            }
        }
        Command::Cockpit { root, json } => {
            if json {
                let engine = open_engine(&root, selected_run.as_deref())?;
                print_json(&engine.cockpit_snapshot()?)?;
            } else {
                koni_tui::run(koni_tui::RunOptions {
                    root,
                    ..koni_tui::RunOptions::default()
                })?;
            }
        }
        Command::Action {
            action,
            root,
            params,
        } => execute_named_action(
            &root,
            selected_run.as_deref(),
            &action,
            params.into_iter().collect(),
        )?,
        Command::Inspect { root, ticket } => {
            anyhow::ensure!(
                std::env::var_os("KONI_LEAD_SLICE_TOKEN").is_none(),
                "full inspect is disabled inside a bounded Lead slice; use `koni lead-next --root .`"
            );
            let engine = open_engine(&root, selected_run.as_deref())?;
            if let Some(ticket_id) = ticket {
                let snapshot = engine.cockpit_snapshot()?;
                let ticket = snapshot
                    .get("tickets")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|ticket| ticket.get("id").and_then(Value::as_str) == Some(&ticket_id))
                    .ok_or_else(|| anyhow::anyhow!("ticket {ticket_id} was not found"))?;
                print_json(ticket)?;
            } else {
                print_json(&engine.inspect()?)?;
            }
        }
        Command::CompareCaptures {
            policy,
            left,
            right,
            max_diffs,
        } => {
            let comparison = ParityComparator::from_policy_path(&policy)?
                .with_max_diffs(max_diffs)
                .compare_files(&left, &right)?;
            print_json(&comparison)?;
            anyhow::ensure!(comparison.equal, "normalized captures differ");
        }
        Command::AgentMcp {
            grant,
            agent_id,
            attempt,
        } => {
            agent_mcp::run(agent_mcp::AgentMcpOptions {
                grant,
                agent_id,
                attempt,
            })?;
        }
    }
    wait_for_spawned_agent_reapers();
    Ok(())
}

#[derive(Debug, Serialize)]
struct InitPreview {
    project_root: PathBuf,
    profile: String,
    creates_koni_directory: bool,
    existing_installation: bool,
    schema1_migration: bool,
    replace: bool,
}

fn initialize_project(
    builtin: Option<BuiltinProfile>,
    source: Option<&Path>,
    target: Option<&Path>,
    replace: bool,
    open: bool,
    dry_run: bool,
) -> anyhow::Result<()> {
    let stdin = std::io::stdin();
    let interactive = stdin.is_terminal();
    initialize_project_with_profile_selector(
        builtin,
        source,
        target,
        replace,
        open,
        dry_run,
        interactive,
        || {
            let mut input = stdin.lock();
            let stderr = std::io::stderr();
            let mut output = stderr.lock();
            prompt_for_builtin_profile(&mut input, &mut output)
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn initialize_project_with_profile_selector<F>(
    builtin: Option<BuiltinProfile>,
    source: Option<&Path>,
    target: Option<&Path>,
    replace: bool,
    open: bool,
    dry_run: bool,
    interactive: bool,
    select_profile: F,
) -> anyhow::Result<()>
where
    F: FnOnce() -> anyhow::Result<BuiltinProfile>,
{
    let target = discover_project_root(target)?;
    let codex_dir = target.join(".codex");
    let schema1_destination = codex_dir.join("koni");
    let destination = target.join(".koni");
    let legacy = codex_dir.join(LEGACY_PROFILE_DIRECTORY);
    anyhow::ensure!(
        !(schema1_destination.exists() && legacy.exists()),
        "both {} and {} exist; reconcile the two configurations before running `koni init`",
        schema1_destination.display(),
        legacy.display()
    );

    if destination.exists() && !replace {
        ensure_real_directory(&destination, "existing schema-2 Koni configuration")?;
        anyhow::ensure!(
            builtin.is_none() && source.is_none(),
            "Köni is already initialized; use --replace to select a different profile"
        );
    } else if schema1_destination.exists() || legacy.exists() {
        anyhow::ensure!(
            builtin.is_none() && source.is_none() && !replace,
            "schema migration preserves the installed profile; rerun `koni init` without --profile, --from, or --replace"
        );
    }

    let schema1_exists = schema1_destination.exists() || legacy.exists();
    let requires_install_source = !schema1_exists && (replace || !destination.exists());
    let selected_builtin = if requires_install_source {
        select_profile_for_install(builtin, source, interactive, select_profile)?
    } else {
        None
    };
    let selected = if let Some(path) = source {
        format!("custom ({})", path.display())
    } else if let Some(profile) = selected_builtin {
        profile.label().to_owned()
    } else if schema1_exists {
        "migrated schema 1".to_owned()
    } else {
        "existing".to_owned()
    };
    if dry_run {
        print_json(&InitPreview {
            project_root: target,
            profile: selected,
            creates_koni_directory: !destination.exists(),
            existing_installation: destination.exists(),
            schema1_migration: schema1_exists,
            replace,
        })?;
        return Ok(());
    }

    let installed = if legacy.exists() {
        migrate_legacy_installation(&target)?;
        execute_pi_migration(&target, true)?;
        verify_existing_schema2_installation(&target, &destination)?
    } else if schema1_destination.exists() {
        execute_pi_migration(&target, true)?;
        verify_existing_schema2_installation(&target, &destination)?
    } else if destination.is_dir() && !replace {
        verify_existing_schema2_installation(&target, &destination)?
    } else if destination.exists() && !replace {
        ensure_real_directory(&destination, "existing Koni configuration")?;
        unreachable!("a real existing Koni configuration is a directory")
    } else {
        install_schema2_profile(&target, selected_builtin, source, replace)?
    };
    println!(
        "Initialized Köni {} profile at {}\nValidated {} {}",
        installed.source,
        installed.destination.display(),
        installed.profile_id,
        installed.profile_version
    );
    if open {
        koni_tui::run(koni_tui::RunOptions {
            root: target,
            ..koni_tui::RunOptions::default()
        })?;
    }
    Ok(())
}

fn select_profile_for_install<F>(
    builtin: Option<BuiltinProfile>,
    source: Option<&Path>,
    interactive: bool,
    select_profile: F,
) -> anyhow::Result<Option<BuiltinProfile>>
where
    F: FnOnce() -> anyhow::Result<BuiltinProfile>,
{
    if source.is_some() {
        return Ok(None);
    }
    if let Some(profile) = builtin {
        return Ok(Some(profile));
    }
    anyhow::ensure!(
        interactive,
        "`koni init` needs an explicit profile when creating or replacing a configuration without an interactive terminal; rerun with `koni init --profile software`, `koni init --profile research`, or `koni init --from <PATH>`"
    );
    select_profile().map(Some)
}

fn prompt_for_builtin_profile(
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> anyhow::Result<BuiltinProfile> {
    writeln!(output, "Select the project profile Köni should initialize:")?;
    writeln!(output, "  1) Software  Evidence-guided vertical delivery")?;
    writeln!(output, "  2) Research  Empirical, receipt-backed research")?;
    loop {
        write!(output, "Profile [1/2]: ")?;
        output.flush()?;
        let mut answer = String::new();
        anyhow::ensure!(
            input.read_line(&mut answer)? != 0,
            "profile selection ended before a choice was made; rerun with `koni init --profile software`, `koni init --profile research`, or `koni init --from <PATH>`"
        );
        match answer.trim().to_ascii_lowercase().as_str() {
            "1" | "software" => return Ok(BuiltinProfile::Software),
            "2" | "research" => return Ok(BuiltinProfile::Research),
            _ => writeln!(output, "Enter 1 or software, or 2 or research.")?,
        }
    }
}

fn discover_project_root(explicit: Option<&Path>) -> anyhow::Result<PathBuf> {
    let start = explicit
        .map(Path::to_path_buf)
        .unwrap_or(std::env::current_dir().context("could not resolve the current directory")?);
    let metadata = fs::symlink_metadata(&start)
        .with_context(|| format!("project directory does not exist: {}", start.display()))?;
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "project directory must be a real directory: {}",
        start.display()
    );
    let start = start
        .canonicalize()
        .with_context(|| format!("could not resolve project directory {}", start.display()))?;
    if explicit.is_some() {
        return Ok(start);
    }
    find_project_root_from(&start)
}

fn find_project_root_from(start: &Path) -> anyhow::Result<PathBuf> {
    let git_marker = start
        .ancestors()
        .map(|ancestor| ancestor.join(".git"))
        .find(|candidate| fs::symlink_metadata(candidate).is_ok());
    match git2::Repository::discover(start) {
        Ok(repository) => {
            let workdir = repository.workdir().ok_or_else(|| {
                anyhow::anyhow!(
                    "Köni cannot initialize a bare Git repository: {}",
                    repository.path().display()
                )
            })?;
            workdir.canonicalize().with_context(|| {
                format!("could not resolve Git worktree root {}", workdir.display())
            })
        }
        Err(error) if error.code() == git2::ErrorCode::NotFound && git_marker.is_none() => {
            Ok(start.to_path_buf())
        }
        Err(error) if error.code() == git2::ErrorCode::NotFound => Err(error).with_context(|| {
            format!(
                "invalid Git metadata at {}",
                git_marker.expect("guarded by is_none").display()
            )
        }),
        Err(error) => Err(error).context("could not discover the Git project root"),
    }
}

fn verify_existing_schema2_installation(
    project_root: &Path,
    destination: &Path,
) -> anyhow::Result<InstalledProfile> {
    ensure_real_directory(destination, "existing schema-2 Koni configuration")?;
    for (path, expected_hash) in read_schema2_owned_resources(destination)? {
        let relative = manifest_resource_path(&path)?;
        let installed = project_root.join(relative);
        let metadata = fs::symlink_metadata(&installed)
            .with_context(|| format!("owned Koni resource is missing: {}", installed.display()))?;
        anyhow::ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "owned Koni resource must be a real file: {}",
            installed.display()
        );
        anyhow::ensure!(
            sha256_hex(&fs::read(&installed)?) == expected_hash,
            "owned Koni resource was modified: {}; reconcile it before replacing the profile",
            installed.display()
        );
    }
    let catalog = ProjectCatalogCompiler::compile(project_root)
        .context("the existing schema-2 Koni installation is not valid")?;
    anyhow::ensure!(
        catalog.document.schema_version == KONI_SCHEMA2_VERSION,
        "the live .koni catalog is not schema 2"
    );
    let compiled = ProfileCompiler::compile(&catalog.default_run_type().profile.resolved_path)?;
    for run_type in catalog.run_types.values() {
        ProfileCompiler::compile(&run_type.profile.resolved_path)
            .with_context(|| format!("run type {} has an invalid profile", run_type.id))?;
    }
    Ok(InstalledProfile {
        source: "existing".to_owned(),
        destination: destination.to_path_buf(),
        profile_id: compiled.manifest.profile.id,
        profile_version: compiled.manifest.profile.version,
    })
}

fn initialize(root: PathBuf, profile: Option<PathBuf>, goal: String) -> anyhow::Result<()> {
    let mut engine = Engine::open_with_profile(&root, profile.as_deref())?;
    println!("{}", engine.initialize_run(&goal)?);
    Ok(())
}

#[cfg(unix)]
static INIT_PROJECT_CWD_LOCK: Mutex<()> = Mutex::new(());

#[cfg(any(target_os = "linux", target_os = "android"))]
const INIT_OPEN_DIRECTORY_FLAGS: i32 = 0o200000 | 0o400000 | 0o2000000;
#[cfg(any(target_os = "macos", target_os = "ios"))]
const INIT_OPEN_DIRECTORY_FLAGS: i32 = 0x100000 | 0x100 | 0x1000000;
#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))
))]
const INIT_OPEN_DIRECTORY_FLAGS: i32 = 0;

#[cfg(unix)]
unsafe extern "C" {
    fn openat(directory: i32, path: *const std::ffi::c_char, flags: i32, ...) -> i32;
    fn mkdirat(directory: i32, path: *const std::ffi::c_char, mode: u32) -> i32;
    fn fchdir(directory: i32) -> i32;
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InitDirectoryIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
impl InitDirectoryIdentity {
    fn from_file(file: &fs::File) -> anyhow::Result<Self> {
        let metadata = file
            .metadata()
            .context("could not inspect held directory")?;
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct PreparedInitProjectTarget {
    requested_path: PathBuf,
    directory: fs::File,
    identity: InitDirectoryIdentity,
}

#[cfg(unix)]
impl PreparedInitProjectTarget {
    fn ensure_requested_path_still_matches(&self) -> anyhow::Result<()> {
        let matches = open_existing_init_directory(&self.requested_path)
            .and_then(|directory| InitDirectoryIdentity::from_file(&directory))
            .is_ok_and(|identity| identity == self.identity);
        anyhow::ensure!(
            matches,
            "init-project target path changed during initialization: {}; initialization stayed on the original held directory inode {}:{} and did not follow or write through the replacement path",
            self.requested_path.display(),
            self.identity.device,
            self.identity.inode
        );
        Ok(())
    }
}

#[cfg(unix)]
struct InitWorkingDirectoryGuard {
    original: fs::File,
    original_identity: InitDirectoryIdentity,
    restored: bool,
}

#[cfg(unix)]
impl InitWorkingDirectoryGuard {
    fn enter(directory: &fs::File) -> anyhow::Result<Self> {
        let original = fs::File::open(".").context("could not retain the current directory")?;
        let original_identity = InitDirectoryIdentity::from_file(&original)?;
        fchdir_to(directory).context("could not enter the held init-project target")?;
        Ok(Self {
            original,
            original_identity,
            restored: false,
        })
    }

    fn restore(mut self) -> anyhow::Result<(InitDirectoryIdentity, InitDirectoryIdentity)> {
        fchdir_to(&self.original).context("could not restore the current directory")?;
        let restored = fs::File::open(".").context("could not verify the restored directory")?;
        let restored_identity = InitDirectoryIdentity::from_file(&restored)?;
        anyhow::ensure!(
            restored_identity == self.original_identity,
            "current directory identity changed while restoring init-project"
        );
        self.restored = true;
        Ok((self.original_identity, restored_identity))
    }
}

#[cfg(unix)]
impl Drop for InitWorkingDirectoryGuard {
    fn drop(&mut self) {
        if !self.restored {
            let _ = fchdir_to(&self.original);
        }
    }
}

fn initialize_legacy_project_run(
    path: PathBuf,
    profile: PathBuf,
    goal: String,
    force: bool,
) -> anyhow::Result<()> {
    initialize_legacy_project_run_with_hook(path, profile, goal, force, || {})
}

#[cfg(unix)]
fn initialize_legacy_project_run_with_hook<F>(
    path: PathBuf,
    profile: PathBuf,
    goal: String,
    force: bool,
    after_entering_target: F,
) -> anyhow::Result<()>
where
    F: FnOnce(),
{
    initialize_legacy_project_run_with_hooks(
        path,
        profile,
        goal,
        force,
        after_entering_target,
        |_, _| {},
    )
}

#[cfg(unix)]
fn initialize_legacy_project_run_with_hooks<F, R>(
    path: PathBuf,
    profile: PathBuf,
    goal: String,
    force: bool,
    after_entering_target: F,
    after_restoring_cwd: R,
) -> anyhow::Result<()>
where
    F: FnOnce(),
    R: FnOnce(InitDirectoryIdentity, InitDirectoryIdentity),
{
    let _cwd_lock = INIT_PROJECT_CWD_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("init-project current-directory lock was poisoned"))?;
    let invocation_directory =
        std::env::current_dir().context("could not resolve current directory")?;
    let profile = if profile.is_absolute() {
        profile
    } else {
        invocation_directory.join(profile)
    };
    let prepared = prepare_init_project_target_locked(&path, force)?;
    let cwd_guard = InitWorkingDirectoryGuard::enter(&prepared.directory)?;
    let result: anyhow::Result<String> = (|| {
        ensure_held_init_project_target_is_empty(&prepared.requested_path)?;
        prepared.ensure_requested_path_still_matches()?;
        after_entering_target();
        let mut engine = Engine::open_with_profile(Path::new("."), Some(&profile))?;
        let run_id = engine.initialize_run(&goal)?;
        prepared.ensure_requested_path_still_matches()?;
        Ok(run_id)
    })();
    let (original_cwd, restored_cwd) = cwd_guard.restore()?;
    after_restoring_cwd(original_cwd, restored_cwd);
    println!("{}", result?);
    Ok(())
}

#[cfg(not(unix))]
fn initialize_legacy_project_run_with_hook<F>(
    _path: PathBuf,
    _profile: PathBuf,
    _goal: String,
    _force: bool,
    _after_entering_target: F,
) -> anyhow::Result<()>
where
    F: FnOnce(),
{
    anyhow::bail!(
        "init-project requires Unix descriptor-relative directory safety; run `koni init` from an existing project directory on this platform"
    )
}

/// Prepare the destination used by the legacy `init-project` command without
/// ever replacing caller-owned contents. Every component is opened relative
/// to a held parent descriptor with symlink following disabled. The `force`
/// argument remains only so older invocations keep parsing; it deliberately
/// grants no deletion power.
#[cfg(all(unix, test))]
fn prepare_init_project_target(
    path: &Path,
    force: bool,
) -> anyhow::Result<PreparedInitProjectTarget> {
    let _cwd_lock = INIT_PROJECT_CWD_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("init-project current-directory lock was poisoned"))?;
    let prepared = prepare_init_project_target_locked(path, force)?;
    let cwd_guard = InitWorkingDirectoryGuard::enter(&prepared.directory)?;
    let result = ensure_held_init_project_target_is_empty(&prepared.requested_path);
    let _ = cwd_guard.restore()?;
    result?;
    Ok(prepared)
}

#[cfg(unix)]
fn prepare_init_project_target_locked(
    path: &Path,
    _force: bool,
) -> anyhow::Result<PreparedInitProjectTarget> {
    let requested_path = absolute_init_project_path(path)?;
    let mut components = requested_path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(component) => Some(component.to_os_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let leaf = components.pop().ok_or_else(|| {
        anyhow::anyhow!(
            "init-project target must name a directory beneath the filesystem root: {}",
            requested_path.display()
        )
    })?;
    let parent = open_init_directory_chain(&components, true).with_context(|| {
        format!(
            "init-project target ancestors must be real directories and may not be symlinks: {}",
            requested_path.display()
        )
    })?;
    let directory = match open_init_directory_at(&parent, &leaf) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_init_directory_at(&parent, &leaf).with_context(|| {
                format!(
                    "could not create init-project target directory {}",
                    requested_path.display()
                )
            })?;
            open_init_directory_at(&parent, &leaf).with_context(|| {
                format!(
                    "could not retain newly created init-project target directory {}",
                    requested_path.display()
                )
            })?
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "init-project target must be a real directory, not a file or symlink: {}",
                    requested_path.display()
                )
            });
        }
    };
    let identity = InitDirectoryIdentity::from_file(&directory)?;
    Ok(PreparedInitProjectTarget {
        requested_path,
        directory,
        identity,
    })
}

#[cfg(unix)]
fn ensure_held_init_project_target_is_empty(requested_path: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(
        fs::read_dir(".")?.next().transpose()?.is_none(),
        "target is not empty: {}; Koni never deletes existing project files, including with --force; run `koni init` from that directory instead",
        requested_path.display()
    );
    Ok(())
}

#[cfg(all(not(unix), test))]
fn prepare_init_project_target(_path: &Path, _force: bool) -> anyhow::Result<()> {
    anyhow::bail!(
        "init-project requires Unix descriptor-relative directory safety; run `koni init` from an existing project directory on this platform"
    )
}

#[cfg(unix)]
fn absolute_init_project_path(path: &Path) -> anyhow::Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .context("could not resolve current directory")?
            .join(path)
    };
    let mut normalized = PathBuf::from("/");
    for component in path.components() {
        match component {
            std::path::Component::Prefix(_) => {
                anyhow::bail!("unsupported init-project target prefix: {}", path.display())
            }
            std::path::Component::RootDir | std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(component) => normalized.push(component),
        }
    }
    Ok(normalized)
}

#[cfg(unix)]
fn open_existing_init_directory(path: &Path) -> anyhow::Result<fs::File> {
    let path = absolute_init_project_path(path)?;
    let components = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(component) => Some(component.to_os_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    open_init_directory_chain(&components, false)
}

#[cfg(unix)]
fn open_init_directory_chain(
    components: &[OsString],
    create_missing: bool,
) -> anyhow::Result<fs::File> {
    let mut directory = fs::File::open("/").context("could not open filesystem root")?;
    for component in components {
        match open_init_directory_at(&directory, component) {
            Ok(child) => directory = child,
            Err(error) if create_missing && error.kind() == std::io::ErrorKind::NotFound => {
                match create_init_directory_at(&directory, component) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
                directory = open_init_directory_at(&directory, component)?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(directory)
}

#[cfg(unix)]
fn init_component_cstring(component: &OsStr) -> anyhow::Result<CString> {
    CString::new(component.as_bytes()).map_err(|_| {
        anyhow::anyhow!(
            "init-project target contains an embedded NUL byte: {}",
            component.to_string_lossy()
        )
    })
}

#[cfg(unix)]
fn open_init_directory_at(parent: &fs::File, component: &OsStr) -> std::io::Result<fs::File> {
    if INIT_OPEN_DIRECTORY_FLAGS == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "descriptor-relative no-follow directory opens are unsupported on this Unix platform",
        ));
    }
    let component = init_component_cstring(component)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // SAFETY: `component` is NUL-terminated for the duration of the call, the
    // held parent descriptor is live, and no creation mode is required.
    let descriptor = unsafe {
        openat(
            parent.as_raw_fd(),
            component.as_ptr(),
            INIT_OPEN_DIRECTORY_FLAGS,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: a successful `openat` returned one newly owned descriptor.
    Ok(unsafe { fs::File::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn create_init_directory_at(parent: &fs::File, component: &OsStr) -> std::io::Result<()> {
    let component = init_component_cstring(component)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // SAFETY: `component` is NUL-terminated, the parent descriptor is live,
    // and mode 0700 grants access only to the invoking user before umask.
    let result = unsafe { mkdirat(parent.as_raw_fd(), component.as_ptr(), 0o700) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn fchdir_to(directory: &fs::File) -> std::io::Result<()> {
    // SAFETY: the descriptor remains live throughout this call and was opened
    // as a directory with symlink following disabled.
    if unsafe { fchdir(directory.as_raw_fd()) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[derive(Debug)]
struct InstalledProfile {
    source: String,
    destination: PathBuf,
    profile_id: String,
    profile_version: String,
}

struct RemoveOnDrop {
    path: PathBuf,
    armed: bool,
}

impl RemoveOnDrop {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn preserve(&mut self) {
        self.armed = false;
    }
}

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_path(&self.path);
        }
    }
}

fn install_profile(
    target: &Path,
    builtin: Option<BuiltinProfile>,
    custom_source: Option<&Path>,
    replace: bool,
) -> anyhow::Result<InstalledProfile> {
    let target_metadata = fs::symlink_metadata(target)
        .with_context(|| format!("installation target does not exist: {}", target.display()))?;
    anyhow::ensure!(
        target_metadata.is_dir() && !target_metadata.file_type().is_symlink(),
        "installation target is not an existing directory: {}",
        target.display()
    );
    let target = target
        .canonicalize()
        .with_context(|| format!("could not resolve target {}", target.display()))?;
    anyhow::ensure!(
        builtin.is_some() ^ custom_source.is_some(),
        "choose either a bundled profile or --from <path>"
    );

    let codex_dir = target.join(".codex");
    let destination = codex_dir.join("koni");
    let codex_dir_existed = optional_real_directory(&codex_dir, "existing .codex path")?;
    let destination_exists = optional_real_directory(&destination, "existing Koni configuration")?;
    anyhow::ensure!(
        replace || !destination_exists,
        "Koni is already installed at {}; use --replace to replace its configuration",
        destination.display()
    );

    fs::create_dir_all(&codex_dir)
        .with_context(|| format!("could not create {}", codex_dir.display()))?;
    let staging = codex_dir.join(format!(".koni-install-{}", Uuid::now_v7()));
    let staged_profile = staging.join("koni");
    let staged_native = staging.join("native");
    let staged_codex = staged_native.join(".codex");
    fs::create_dir(&staging)
        .with_context(|| format!("could not create staging directory {}", staging.display()))?;
    fs::create_dir(&staged_profile).with_context(|| {
        format!(
            "could not create profile staging directory {}",
            staged_profile.display()
        )
    })?;

    let result = (|| {
        let source = if let Some(profile) = builtin {
            write_embedded_profile(&staged_profile, profile)?;
            write_embedded_files(&staged_codex, profile.codex_files())?;
            profile.label().to_owned()
        } else {
            let source = resolve_custom_profile_root(custom_source.expect("source checked above"))?;
            let source = source.canonicalize().with_context(|| {
                format!("could not resolve profile source {}", source.display())
            })?;
            if destination_exists {
                anyhow::ensure!(
                    source != destination.canonicalize()?,
                    "custom profile source is already the installation destination: {}",
                    destination.display()
                );
            }
            let staging_absolute = staged_profile.canonicalize().with_context(|| {
                format!(
                    "could not resolve profile staging directory {}",
                    staged_profile.display()
                )
            })?;
            anyhow::ensure!(
                !staging_absolute.starts_with(&source),
                "custom profile source cannot contain the target project: {}",
                source.display()
            );
            copy_profile_tree(&source, &staged_profile)?;
            if let Some(source_codex) =
                custom_source_codex_root(custom_source.expect("source checked above"), &source)?
            {
                copy_referenced_custom_agents(&staged_profile, &source_codex, &staged_codex)?;
            }
            format!("custom ({})", source.display())
        };

        write_embedded_files(
            &staged_native.join(".agents/skills"),
            templates::SHARED_SKILLS,
        )?;

        write_native_resource_manifest(&staged_profile, &staged_native)?;
        let compiled = compile_staged_install(&staged_profile, &staged_native, Some(&target))
            .with_context(|| {
                format!(
                    "profile validation failed; no configuration was installed in {}",
                    destination.display()
                )
            })?;
        publish_staged_install(
            &staging,
            &staged_profile,
            &staged_native,
            &target,
            &destination,
            replace,
            None,
        )?;

        Ok(InstalledProfile {
            source,
            destination: destination.clone(),
            profile_id: compiled.manifest.profile.id,
            profile_version: compiled.manifest.profile.version,
        })
    })();

    if result.is_err() {
        if !staging.join("backup").exists() {
            let _ = remove_path(&staging);
        }
        if !codex_dir_existed {
            let _ = fs::remove_dir(&codex_dir);
        }
    }
    result
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Schema2ResourceManifest {
    schema_version: String,
    owner: String,
    external_resources: Vec<HashedMigrationFile>,
}

/// Build a complete provider-neutral installation in private staging, then
/// publish `.koni` and its repository skills with the existing rollback-safe
/// resource transaction. Bundled schema-1 templates pass through the exact
/// migration transformer; no executable Codex config or custom-agent TOML is
/// ever copied into the destination project.
fn install_schema2_profile(
    target: &Path,
    builtin: Option<BuiltinProfile>,
    custom_source: Option<&Path>,
    replace: bool,
) -> anyhow::Result<InstalledProfile> {
    let target_metadata = fs::symlink_metadata(target)
        .with_context(|| format!("installation target does not exist: {}", target.display()))?;
    anyhow::ensure!(
        target_metadata.is_dir() && !target_metadata.file_type().is_symlink(),
        "installation target is not an existing real directory: {}",
        target.display()
    );
    let target = target.canonicalize()?;
    anyhow::ensure!(
        builtin.is_some() ^ custom_source.is_some(),
        "choose either a bundled profile or --from <path>"
    );
    let destination = target.join(".koni");
    let destination_exists =
        optional_real_directory(&destination, "existing schema-2 Koni configuration")?;
    anyhow::ensure!(
        replace || !destination_exists,
        "Koni is already installed at {}; use --replace to replace its configuration",
        destination.display()
    );
    if !destination_exists && target.join(".codex/koni").exists() {
        anyhow::bail!(
            "a schema-1 Koni configuration exists at {}; run `koni migrate-pi --apply` instead of installing over it",
            target.join(".codex/koni").display()
        );
    }

    let staging = target.join(format!(".koni-install-v2-{}", Uuid::now_v7()));
    fs::create_dir(&staging)?;
    let mut cleanup = RemoveOnDrop::new(staging.clone());

    let source_profile = custom_source
        .map(resolve_custom_profile_root)
        .transpose()?
        .map(|source| {
            let source = source.canonicalize()?;
            let profile = ProfileCompiler::compile(&source)?;
            Ok::<_, anyhow::Error>((source, profile.manifest.schema_version))
        })
        .transpose()?;

    let source_label = if source_profile
        .as_ref()
        .is_some_and(|(_, schema)| schema == KONI_SCHEMA2_VERSION)
    {
        let (source, _) = source_profile.as_ref().expect("guarded as schema 2");
        anyhow::ensure!(
            source != &destination,
            "custom profile source is already the installation destination: {}",
            destination.display()
        );
        let staged_profile = staging.join(".koni");
        fs::create_dir(&staged_profile)?;
        copy_profile_tree(source, &staged_profile)?;
        format!("custom ({})", source.display())
    } else {
        let installed = install_profile(&staging, builtin, custom_source, false)
            .context("could not stage the schema-1 source for schema-2 conversion")?;
        Schema2Migrator::convert_fresh_install(&staging)
            .context("could not convert the staged installation to schema 2")?;
        installed.source
    };

    let preserved_root = staging.join("preserved");
    fs::create_dir(&preserved_root)?;
    let staged_skills = staging.join(".agents/skills");
    let preserved_skills = preserved_root.join(".agents/skills");
    if staged_skills.exists() {
        fs::create_dir_all(preserved_skills.parent().expect("skills have parent"))?;
        fs::rename(&staged_skills, &preserved_skills)?;
    } else {
        write_embedded_files(&preserved_skills, templates::SHARED_SKILLS)?;
    }
    write_schema2_resource_manifest(&staging.join(".koni"), &preserved_root)?;

    let catalog = ProjectCatalogCompiler::compile(&staging)
        .context("staged schema-2 project catalog is invalid")?;
    let compiled = ProfileCompiler::compile(&catalog.default_run_type().profile.resolved_path)?;
    for run_type in catalog.run_types.values() {
        ProfileCompiler::compile(&run_type.profile.resolved_path)
            .with_context(|| format!("run type {} has an invalid schema-2 profile", run_type.id))?;
    }
    let prior_owned = if replace {
        read_schema2_owned_resources(&destination)?
    } else {
        BTreeMap::new()
    };
    publish_staged_install(
        &staging,
        &staging.join(".koni"),
        &preserved_root,
        &target,
        &destination,
        replace,
        Some(prior_owned),
    )?;
    cleanup.preserve();
    Ok(InstalledProfile {
        source: source_label,
        destination,
        profile_id: compiled.manifest.profile.id,
        profile_version: compiled.manifest.profile.version,
    })
}

fn write_schema2_resource_manifest(
    staged_profile: &Path,
    staged_external: &Path,
) -> anyhow::Result<()> {
    let mut paths = Vec::new();
    collect_staged_files(staged_external, staged_external, &mut paths)?;
    let external_resources = paths
        .into_iter()
        .map(|relative| {
            Ok(HashedMigrationFile {
                path: path_to_portable_string(&relative)?,
                sha256: sha256_hex(&fs::read(staged_external.join(relative))?),
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let manifest = Schema2ResourceManifest {
        schema_version: KONI_SCHEMA2_VERSION.to_owned(),
        owner: "koni".to_owned(),
        external_resources,
    };
    fs::write(
        staged_profile.join(SCHEMA2_RESOURCE_MANIFEST),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(())
}

fn read_schema2_owned_resources(
    existing_profile: &Path,
) -> anyhow::Result<BTreeMap<String, String>> {
    if !existing_profile.is_dir() {
        return Ok(BTreeMap::new());
    }
    let manifest_path = existing_profile.join(SCHEMA2_RESOURCE_MANIFEST);
    let manifest: Schema2ResourceManifest = serde_json::from_slice(&fs::read(&manifest_path)?)
        .with_context(|| format!("could not read {}", manifest_path.display()))?;
    anyhow::ensure!(
        manifest.schema_version == KONI_SCHEMA2_VERSION && manifest.owner == "koni",
        "unsupported schema-2 ownership manifest at {}",
        manifest_path.display()
    );
    let mut resources = BTreeMap::new();
    for resource in manifest.external_resources {
        let path = manifest_resource_path(&resource.path)?;
        anyhow::ensure!(
            path.starts_with(".agents/skills"),
            "schema-2 installation may own only repository skills: {}",
            resource.path
        );
        anyhow::ensure!(
            resources
                .insert(resource.path.clone(), resource.sha256)
                .is_none(),
            "duplicate schema-2 owned resource: {}",
            resource.path
        );
    }
    Ok(resources)
}

fn migrate_legacy_installation(target: &Path) -> anyhow::Result<InstalledProfile> {
    let codex_dir = target.join(".codex");
    let legacy = codex_dir.join(LEGACY_PROFILE_DIRECTORY);
    let destination = codex_dir.join("koni");
    ensure_real_directory(&legacy, "legacy Koni configuration")?;
    anyhow::ensure!(
        !destination.exists(),
        "cannot migrate while {} already exists",
        destination.display()
    );

    let prior_owned = read_legacy_owned_resources(&legacy)?;
    let migration_id = Uuid::now_v7().to_string();
    let staging = codex_dir.join(format!(".koni-migration-{migration_id}"));
    let _staging_cleanup = RemoveOnDrop::new(staging.clone());
    let staged_profile = staging.join("koni");
    let staged_native = staging.join("native");
    let backup_root = codex_dir.join(".koni-migrations").join(&migration_id);
    let mut backup_cleanup = RemoveOnDrop::new(backup_root.clone());
    fs::create_dir_all(&staged_profile)?;
    copy_profile_tree(&legacy, &staged_profile)?;
    rewrite_legacy_tree(&staged_profile)?;

    for relative in prior_owned.keys() {
        let relative = manifest_resource_path(relative)?;
        let source = target.join(&relative);
        let metadata = fs::symlink_metadata(&source)
            .with_context(|| format!("legacy owned resource is missing: {}", source.display()))?;
        anyhow::ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "legacy owned resource must be a real file: {}",
            source.display()
        );
        let output = staged_native.join(&relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&source, &output)?;
    }
    rewrite_legacy_tree(&staged_native)?;
    write_embedded_files(
        &staged_native.join(".agents/skills"),
        templates::SHARED_SKILLS,
    )?;

    let receipt = json!({
        "schema_version": "1.0",
        "migration": "pythagoras-to-koni",
        "backup": backup_root.strip_prefix(target).unwrap_or(&backup_root),
    });
    fs::write(
        staged_profile.join("migration-receipt.json"),
        serde_json::to_vec_pretty(&receipt)?,
    )?;
    write_native_resource_manifest(&staged_profile, &staged_native)?;
    let compiled = compile_staged_install(&staged_profile, &staged_native, Some(target))
        .context("legacy configuration migration failed validation")?;

    fs::create_dir_all(backup_root.join("native"))?;
    for relative in prior_owned.keys() {
        let source = target.join(relative);
        let output = backup_root.join("native").join(relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, output)?;
    }
    fs::rename(&legacy, backup_root.join("profile")).with_context(|| {
        format!(
            "could not preserve legacy configuration at {}",
            backup_root.display()
        )
    })?;

    if let Err(error) = publish_staged_install(
        &staging,
        &staged_profile,
        &staged_native,
        target,
        &destination,
        false,
        Some(prior_owned),
    ) {
        let restore = fs::rename(backup_root.join("profile"), &legacy);
        return match restore {
            Ok(()) => Err(error).context("legacy migration was rolled back"),
            Err(restore_error) => {
                backup_cleanup.preserve();
                Err(anyhow::anyhow!(
                    "legacy migration failed ({error}) and the original profile could not be restored ({restore_error}); recovery data remains at {}",
                    backup_root.display()
                ))
            }
        };
    }

    backup_cleanup.preserve();

    Ok(InstalledProfile {
        source: "migrated legacy".to_owned(),
        destination,
        profile_id: compiled.manifest.profile.id,
        profile_version: compiled.manifest.profile.version,
    })
}

fn read_legacy_owned_resources(profile: &Path) -> anyhow::Result<BTreeMap<String, String>> {
    let manifest_path = profile.join(NATIVE_RESOURCE_MANIFEST);
    if !manifest_path.exists() {
        return Ok(BTreeMap::new());
    }
    let manifest: NativeResourceManifest = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    anyhow::ensure!(
        manifest.schema_version == "1.0"
            && (manifest.owner == LEGACY_PROFILE_DIRECTORY || manifest.owner == "koni"),
        "unsupported legacy ownership manifest at {}",
        manifest_path.display()
    );
    let mut resources = BTreeMap::new();
    for resource in manifest.resources {
        let path = if resource.path.starts_with("agents/") {
            format!(".codex/{}", resource.path)
        } else {
            resource.path
        };
        manifest_resource_path(&path)?;
        anyhow::ensure!(
            resources.insert(path.clone(), resource.sha256).is_none(),
            "duplicate legacy owned resource: {path}"
        );
    }
    Ok(resources)
}

fn rewrite_legacy_tree(root: &Path) -> anyhow::Result<()> {
    if !root.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(root)?.collect::<Result<Vec<_>, _>>()?;
    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type()?;
        anyhow::ensure!(
            !file_type.is_symlink(),
            "legacy configuration cannot contain symbolic links: {}",
            path.display()
        );
        if file_type.is_dir() {
            rewrite_legacy_tree(&path)?;
        } else if file_type.is_file() {
            let bytes = fs::read(&path)?;
            if let Ok(source) = String::from_utf8(bytes) {
                let rewritten = source
                    .replace("PYTHAGORAS", "KONI")
                    .replace("Pythagoras", "Koni")
                    .replace(LEGACY_PROFILE_DIRECTORY, "koni");
                fs::write(&path, rewritten)?;
            }
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.contains(LEGACY_PROFILE_DIRECTORY) {
            let renamed = path.with_file_name(name.replace(LEGACY_PROFILE_DIRECTORY, "koni"));
            anyhow::ensure!(
                !renamed.exists(),
                "migration path collision at {}",
                renamed.display()
            );
            fs::rename(&path, renamed)?;
        }
    }
    Ok(())
}

fn write_embedded_profile(destination: &Path, profile: BuiltinProfile) -> anyhow::Result<()> {
    write_embedded_files(destination, profile.files())
}

fn write_embedded_files(
    destination: &Path,
    files: &[templates::EmbeddedFile],
) -> anyhow::Result<()> {
    for file in files {
        let relative = Path::new(file.path);
        let output = destination.join(relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&output, file.contents)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeResourceManifest {
    schema_version: String,
    owner: String,
    resources: Vec<OwnedNativeResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnedNativeResource {
    path: String,
    sha256: String,
}

fn write_native_resource_manifest(
    staged_profile: &Path,
    staged_codex: &Path,
) -> anyhow::Result<()> {
    let mut paths = Vec::new();
    collect_staged_files(staged_codex, staged_codex, &mut paths)?;
    let resources = paths
        .into_iter()
        .map(|relative| {
            let bytes = fs::read(staged_codex.join(&relative))?;
            Ok(OwnedNativeResource {
                path: path_to_portable_string(&relative)?,
                sha256: sha256_hex(&bytes),
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let manifest = NativeResourceManifest {
        schema_version: "1.0".to_owned(),
        owner: "koni".to_owned(),
        resources,
    };
    fs::write(
        staged_profile.join(NATIVE_RESOURCE_MANIFEST),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(())
}

fn path_to_portable_string(path: &Path) -> anyhow::Result<String> {
    let parts = path
        .components()
        .map(|component| match component {
            std::path::Component::Normal(part) => part.to_str().map(str::to_owned),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| anyhow::anyhow!("resource path is not a portable relative path"))?;
    anyhow::ensure!(!parts.is_empty(), "resource path must not be empty");
    Ok(parts.join("/"))
}

fn manifest_resource_path(path: &str) -> anyhow::Result<PathBuf> {
    let relative = PathBuf::from(path);
    let portable = path_to_portable_string(&relative)?;
    anyhow::ensure!(
        portable == path,
        "native resource manifest path is not canonical: {path}"
    );
    anyhow::ensure!(
        relative.starts_with(".codex/agents") || relative.starts_with(".agents/skills"),
        "native resource manifest may own only .codex/agents or .agents/skills resources: {path}"
    );
    Ok(relative)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn resolve_custom_profile_root(source: &Path) -> anyhow::Result<PathBuf> {
    let metadata = fs::symlink_metadata(source)
        .with_context(|| format!("custom profile source does not exist: {}", source.display()))?;
    anyhow::ensure!(
        !metadata.file_type().is_symlink(),
        "custom profile source cannot be a symbolic link: {}",
        source.display()
    );
    if source.is_file() {
        return source.parent().map(Path::to_path_buf).ok_or_else(|| {
            anyhow::anyhow!("profile manifest has no parent: {}", source.display())
        });
    }
    anyhow::ensure!(
        source.is_dir(),
        "custom profile source is not a directory: {}",
        source.display()
    );

    let schema2 = source.join(".koni");
    if profile_manifest_exists(&schema2) {
        ensure_real_directory(&schema2, "custom schema-2 Koni configuration")?;
        return Ok(schema2);
    }
    let nested = source.join(".codex/koni");
    if profile_manifest_exists(&nested) {
        ensure_real_directory(&nested, "custom Koni configuration")?;
        return Ok(nested);
    }
    let from_codex_directory = source.join("koni");
    if profile_manifest_exists(&from_codex_directory) {
        ensure_real_directory(&from_codex_directory, "custom Koni configuration")?;
        return Ok(from_codex_directory);
    }
    Ok(source.to_path_buf())
}

fn custom_source_codex_root(
    requested_source: &Path,
    resolved_profile: &Path,
) -> anyhow::Result<Option<PathBuf>> {
    let requested = requested_source.canonicalize().with_context(|| {
        format!(
            "could not resolve custom profile source {}",
            requested_source.display()
        )
    })?;
    let requested_dir = if requested.is_file() {
        requested
            .parent()
            .ok_or_else(|| anyhow::anyhow!("custom profile file has no parent"))?
            .to_path_buf()
    } else {
        requested
    };
    let candidates = [
        requested_dir.join(".codex"),
        requested_dir.clone(),
        resolved_profile
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default(),
    ];
    for candidate in candidates {
        if candidate.file_name().and_then(|name| name.to_str()) != Some(".codex") {
            continue;
        }
        let profile = candidate.join("koni");
        if profile.is_dir()
            && profile.canonicalize()? == resolved_profile
            && optional_real_directory(&candidate, "custom source .codex directory")?
        {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn copy_referenced_custom_agents(
    staged_profile: &Path,
    source_codex: &Path,
    staged_codex: &Path,
) -> anyhow::Result<()> {
    let mut references = BTreeSet::new();
    collect_codex_agent_references(staged_profile, &mut references)?;
    if references.is_empty() {
        return Ok(());
    }
    let source_agents = source_codex.join("agents");
    ensure_real_directory(&source_agents, "custom source native Codex agents")?;
    let mut available = BTreeMap::new();
    for entry in fs::read_dir(&source_agents)? {
        let entry = entry?;
        let source = entry.path();
        if source.extension().and_then(|value| value.to_str()) != Some("toml") {
            continue;
        }
        let metadata = entry.file_type()?;
        anyhow::ensure!(
            metadata.is_file() && !metadata.is_symlink(),
            "custom Codex agent must be a real file: {}",
            source.display()
        );
        let document = fs::read_to_string(&source)?
            .parse::<toml::Table>()
            .with_context(|| format!("invalid Codex custom-agent TOML at {}", source.display()))?;
        let name = document
            .get("name")
            .and_then(toml::Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("Codex custom agent has no name: {}", source.display()))?
            .to_owned();
        anyhow::ensure!(
            available.insert(name.clone(), source.clone()).is_none(),
            "duplicate Codex custom agent name {name} in {}",
            source_agents.display()
        );
    }
    let staged_agents = staged_codex.join("agents");
    fs::create_dir_all(&staged_agents)?;
    for agent in references {
        anyhow::ensure!(
            agent.chars().all(
                |character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            ),
            "invalid codex_agent reference: {agent}"
        );
        let source = available.get(&agent).ok_or_else(|| {
            anyhow::anyhow!("referenced Codex custom agent does not exist: {agent}")
        })?;
        fs::copy(
            source,
            staged_agents.join(source.file_name().expect("agent file name")),
        )?;
    }
    Ok(())
}

fn collect_codex_agent_references(
    current: &Path,
    references: &mut BTreeSet<String>,
) -> anyhow::Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_codex_agent_references(&path, references)?;
        } else if file_type.is_file()
            && matches!(
                path.extension().and_then(|extension| extension.to_str()),
                Some("yaml" | "yml")
            )
        {
            let document: serde_yaml::Value = serde_yaml::from_slice(&fs::read(&path)?)
                .with_context(|| format!("invalid YAML in custom profile at {}", path.display()))?;
            collect_codex_agent_values(&document, references);
        }
    }
    Ok(())
}

fn collect_codex_agent_values(value: &serde_yaml::Value, references: &mut BTreeSet<String>) {
    match value {
        serde_yaml::Value::Mapping(mapping) => {
            for (key, value) in mapping {
                if key.as_str() == Some("codex_agent")
                    && let Some(agent) = value.as_str()
                {
                    references.insert(agent.to_owned());
                }
                collect_codex_agent_values(value, references);
            }
        }
        serde_yaml::Value::Sequence(sequence) => {
            for value in sequence {
                collect_codex_agent_values(value, references);
            }
        }
        _ => {}
    }
}

fn profile_manifest_exists(directory: &Path) -> bool {
    ["project.yaml", "koni.toml", "profile.yaml", "koni.yaml"]
        .iter()
        .any(|name| directory.join(name).is_file())
}

fn copy_profile_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
    for entry in fs::read_dir(source)
        .with_context(|| format!("could not read profile source {}", source.display()))?
    {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let input = entry.path();
        let output = destination.join(entry.file_name());
        if file_type.is_symlink() {
            anyhow::bail!(
                "custom profiles cannot contain symbolic links: {}",
                input.display()
            );
        } else if file_type.is_dir() {
            fs::create_dir(&output)?;
            copy_profile_tree(&input, &output)?;
        } else if file_type.is_file() {
            fs::copy(&input, &output).with_context(|| {
                format!(
                    "could not copy profile file {} to {}",
                    input.display(),
                    output.display()
                )
            })?;
        } else {
            anyhow::bail!("unsupported profile entry: {}", input.display());
        }
    }
    Ok(())
}

#[cfg(test)]
fn compile_staged_profile(staging: &Path) -> anyhow::Result<koni_core::CompiledProfile> {
    let existing_project = staging
        .parent()
        .filter(|parent| parent.file_name().and_then(|name| name.to_str()) == Some(".codex"))
        .and_then(Path::parent);
    let empty_native = staging.join(".no-native-codex-resources");
    compile_staged_install(staging, &empty_native, existing_project)
}

fn compile_staged_install(
    staged_profile: &Path,
    staged_native: &Path,
    existing_project: Option<&Path>,
) -> anyhow::Result<koni_core::CompiledProfile> {
    let has_catalog = staged_profile.join("project.yaml").is_file();
    let has_legacy_manifest = staged_profile.join("koni.toml").is_file();

    let validation_root = staged_profile
        .parent()
        .ok_or_else(|| anyhow::anyhow!("staging directory has no parent"))?
        .join(format!(".koni-validation-{}", Uuid::now_v7()));
    let validation_config = validation_root.join(".codex/koni");
    fs::create_dir_all(&validation_config)?;
    let result = (|| {
        if let Some(project) = existing_project {
            let config = project.join(".codex/config.toml");
            if config.exists() {
                let metadata = fs::symlink_metadata(&config)?;
                anyhow::ensure!(
                    metadata.is_file() && !metadata.file_type().is_symlink(),
                    "Codex project config must be a real file: {}",
                    config.display()
                );
                let output = validation_root.join(".codex/config.toml");
                fs::create_dir_all(output.parent().expect("config has parent"))?;
                fs::copy(config, output)?;
            }
            let source_agents = project.join(".codex/agents");
            if source_agents.exists() {
                ensure_real_directory(&source_agents, "existing native Codex agents")?;
                let output = validation_root.join(".codex/agents");
                fs::create_dir_all(&output)?;
                copy_profile_tree(&source_agents, &output)?;
            }
            let source_skills = project.join(".agents/skills");
            if source_skills.exists() {
                let output = validation_root.join(".agents/skills");
                copy_resolved_tree(&source_skills, &output)?;
            }
        }
        copy_profile_tree(staged_profile, &validation_config)?;
        let mut native_files = Vec::new();
        collect_staged_files(staged_native, staged_native, &mut native_files)?;
        for relative in native_files {
            let source = staged_native.join(&relative);
            let output = validation_root.join(&relative);
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(source, output)?;
        }
        if !has_catalog && !has_legacy_manifest {
            return ProfileCompiler::compile(&validation_config).map_err(Into::into);
        }
        let catalog = ProjectCatalogCompiler::compile(&validation_root)?;
        let default = catalog.default_run_type();
        let compiled_default = ProfileCompiler::compile(&default.profile.resolved_path)?;
        for run_type in catalog.run_types.values() {
            ProfileCompiler::compile(&run_type.profile.resolved_path)
                .with_context(|| format!("run type {} has an invalid profile", run_type.id))?;
        }
        Ok(compiled_default)
    })();
    let cleanup = remove_path(&validation_root);
    match (result, cleanup) {
        (Ok(profile), Ok(())) => Ok(profile),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error).context("could not remove validation staging"),
    }
}

fn copy_resolved_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(
        source.is_dir(),
        "existing repository skills path is not a directory: {}",
        source.display()
    );
    for entry in WalkDir::new(source).follow_links(true) {
        let entry = entry.with_context(|| {
            format!(
                "could not resolve existing repository skill beneath {}",
                source.display()
            )
        })?;
        let relative = entry.path().strip_prefix(source)?;
        if relative.as_os_str().is_empty() {
            fs::create_dir_all(destination)?;
            continue;
        }
        let output = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&output)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), output)?;
        } else {
            anyhow::bail!(
                "existing repository skill contains an unsupported entry: {}",
                entry.path().display()
            );
        }
    }
    Ok(())
}

fn ensure_real_directory(path: &Path, label: &str) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("could not inspect {label} at {}", path.display()))?;
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "{label} must be a real directory: {}",
        path.display()
    );
    Ok(())
}

fn optional_real_directory(path: &Path, label: &str) -> anyhow::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            ensure_real_directory(path, label)?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("could not inspect {label}")),
    }
}

#[derive(Debug)]
struct PublishEntry {
    staged: Option<PathBuf>,
    destination: PathBuf,
    backup: PathBuf,
    existed: bool,
    published: bool,
}

fn read_owned_native_resources(
    existing_profile: &Path,
) -> anyhow::Result<BTreeMap<String, String>> {
    if !existing_profile.is_dir() {
        return Ok(BTreeMap::new());
    }
    let manifest_path = existing_profile.join(NATIVE_RESOURCE_MANIFEST);
    if !manifest_path.is_file() {
        return Ok(BTreeMap::new());
    }
    let manifest: NativeResourceManifest = serde_json::from_slice(&fs::read(&manifest_path)?)
        .with_context(|| {
            format!(
                "could not read prior native-resource ownership from {}",
                manifest_path.display()
            )
        })?;
    anyhow::ensure!(
        manifest.schema_version == "1.0" && manifest.owner == "koni",
        "unsupported native-resource ownership manifest at {}",
        manifest_path.display()
    );
    let mut resources = BTreeMap::new();
    for resource in manifest.resources {
        manifest_resource_path(&resource.path)?;
        anyhow::ensure!(
            resources
                .insert(resource.path.clone(), resource.sha256)
                .is_none(),
            "duplicate owned native resource in {}: {}",
            manifest_path.display(),
            resource.path
        );
    }
    Ok(resources)
}

fn append_owned_retirements(
    prior_owned: &BTreeMap<String, String>,
    staged_native: &Path,
    project_root: &Path,
    backup_root: &Path,
    entries: &mut Vec<PublishEntry>,
) -> anyhow::Result<()> {
    let mut staged_paths = Vec::new();
    collect_staged_files(staged_native, staged_native, &mut staged_paths)?;
    let staged_paths = staged_paths
        .iter()
        .map(|path| path_to_portable_string(path))
        .collect::<anyhow::Result<BTreeSet<_>>>()?;
    for (path, installed_hash) in prior_owned {
        if staged_paths.contains(path) {
            continue;
        }
        let relative = manifest_resource_path(path)?;
        let current = project_root.join(&relative);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            eprintln!(
                "Warning: preserving modified former Koni resource at {}",
                current.display()
            );
            continue;
        }
        let current_hash = sha256_hex(&fs::read(&current)?);
        if current_hash != *installed_hash {
            eprintln!(
                "Warning: preserving user-modified former Koni agent at {}",
                current.display()
            );
            continue;
        }
        entries.push(PublishEntry {
            staged: None,
            destination: current,
            backup: backup_root.join("codex").join(relative),
            existed: true,
            published: false,
        });
    }
    Ok(())
}

fn publish_staged_install(
    staging_root: &Path,
    staged_profile: &Path,
    staged_native: &Path,
    project_root: &Path,
    destination: &Path,
    replace: bool,
    prior_owned_override: Option<BTreeMap<String, String>>,
) -> anyhow::Result<()> {
    validate_native_codex_resources(staged_native)?;
    let backup_root = staging_root.join("backup");
    let prior_owned = if let Some(prior_owned) = prior_owned_override {
        prior_owned
    } else if replace {
        read_owned_native_resources(destination)?
    } else {
        BTreeMap::new()
    };
    let mut entries = vec![PublishEntry {
        staged: Some(staged_profile.to_path_buf()),
        destination: destination.to_path_buf(),
        backup: backup_root.join("koni"),
        existed: destination.exists(),
        published: false,
    }];
    let mut native_paths = Vec::new();
    collect_staged_files(staged_native, staged_native, &mut native_paths)?;
    for relative in native_paths {
        entries.push(PublishEntry {
            staged: Some(staged_native.join(&relative)),
            destination: project_root.join(&relative),
            backup: backup_root.join("native").join(&relative),
            existed: project_root.join(&relative).exists(),
            published: false,
        });
    }
    append_owned_retirements(
        &prior_owned,
        staged_native,
        project_root,
        &backup_root,
        &mut entries,
    )?;

    for entry in &entries {
        if entry.existed {
            let metadata = fs::symlink_metadata(&entry.destination).with_context(|| {
                format!(
                    "could not inspect installation destination {}",
                    entry.destination.display()
                )
            })?;
            anyhow::ensure!(
                !metadata.file_type().is_symlink()
                    && (entry.destination == destination && metadata.is_dir()
                        || entry.destination != destination && metadata.is_file()),
                "installation destination must be a real {}: {}",
                if entry.destination == destination {
                    "directory"
                } else {
                    "file"
                },
                entry.destination.display()
            );
            if entry.destination == destination {
                anyhow::ensure!(
                    replace,
                    "Koni is already installed at {}; use --replace to replace its configuration",
                    entry.destination.display()
                );
            } else if entry.staged.is_some() {
                let relative = entry.destination.strip_prefix(project_root)?;
                let path = path_to_portable_string(relative)?;
                let installed_hash = prior_owned.get(&path).ok_or_else(|| {
                    anyhow::anyhow!(
                        "project Codex resource already exists at {} and is not owned by this Koni installation; move or rename it before installing",
                        entry.destination.display()
                    )
                })?;
                let current_hash = sha256_hex(&fs::read(&entry.destination)?);
                anyhow::ensure!(
                    current_hash == *installed_hash,
                    "project Codex resource at {} was modified after Koni installed it; preserve or reconcile that edit before replacing the profile",
                    entry.destination.display()
                );
            }
        }
    }
    let created_directories = ensure_native_destination_parents(project_root, &entries)?;

    let publication = (|| -> anyhow::Result<()> {
        for entry in &entries {
            if !entry.existed {
                continue;
            }
            if let Some(parent) = entry.backup.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&entry.destination, &entry.backup).with_context(|| {
                format!(
                    "could not stage existing resource {} for replacement",
                    entry.destination.display()
                )
            })?;
        }
        for entry in &mut entries {
            let Some(staged) = entry.staged.as_ref() else {
                continue;
            };
            if let Some(parent) = entry.destination.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(staged, &entry.destination).with_context(|| {
                format!(
                    "could not publish validated resource to {}",
                    entry.destination.display()
                )
            })?;
            entry.published = true;
        }
        Ok(())
    })();

    if let Err(error) = publication {
        let rollback = rollback_install(&entries);
        for directory in created_directories.iter().rev() {
            let _ = fs::remove_dir(directory);
        }
        return match rollback {
            Ok(()) => {
                let _ = remove_path(&backup_root);
                Err(error).context(
                    "could not publish the validated Koni installation; existing resources were restored",
                )
            }
            Err(rollback_error) => Err(anyhow::anyhow!(
                "could not publish the validated Koni installation ({error}) and rollback was incomplete ({rollback_error}); recovery data remains at {}",
                backup_root.display()
            )),
        };
    }
    if let Err(error) = remove_path(staging_root) {
        eprintln!(
            "Warning: Koni was installed, but install staging could not be removed from {}: {error}",
            staging_root.display()
        );
    }
    Ok(())
}

fn rollback_install(entries: &[PublishEntry]) -> anyhow::Result<()> {
    let mut failures = Vec::new();
    for entry in entries.iter().rev() {
        if entry.published
            && let Err(error) = remove_path(&entry.destination)
        {
            failures.push(format!("remove {}: {error}", entry.destination.display()));
        }
        if entry.existed && entry.backup.exists() {
            if let Some(parent) = entry.destination.parent()
                && let Err(error) = fs::create_dir_all(parent)
            {
                failures.push(format!("create {}: {error}", parent.display()));
                continue;
            }
            if let Err(error) = fs::rename(&entry.backup, &entry.destination) {
                failures.push(format!("restore {}: {error}", entry.destination.display()));
            }
        }
    }
    anyhow::ensure!(failures.is_empty(), failures.join("; "));
    Ok(())
}

fn collect_staged_files(
    root: &Path,
    current: &Path,
    output: &mut Vec<PathBuf>,
) -> anyhow::Result<()> {
    if !current.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(current).with_context(|| {
        format!(
            "could not inspect staged resources in {}",
            current.display()
        )
    })? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        anyhow::ensure!(
            !file_type.is_symlink(),
            "staged Codex resources cannot contain symbolic links: {}",
            path.display()
        );
        if file_type.is_dir() {
            collect_staged_files(root, &path, output)?;
        } else if file_type.is_file() {
            output.push(path.strip_prefix(root)?.to_path_buf());
        } else {
            anyhow::bail!("unsupported staged Codex resource: {}", path.display());
        }
    }
    output.sort();
    Ok(())
}

fn ensure_native_destination_parents(
    project_root: &Path,
    entries: &[PublishEntry],
) -> anyhow::Result<Vec<PathBuf>> {
    let mut created = Vec::new();
    let result = (|| -> anyhow::Result<()> {
        for entry in entries.iter().skip(1) {
            let relative = entry
                .destination
                .strip_prefix(project_root)
                .context("native Codex destination escaped the project")?;
            let mut parent = project_root.to_path_buf();
            for component in relative.parent().into_iter().flat_map(Path::components) {
                parent.push(component.as_os_str());
                match fs::symlink_metadata(&parent) {
                    Ok(metadata) => anyhow::ensure!(
                        metadata.is_dir() && !metadata.file_type().is_symlink(),
                        "native Codex resource parent must be a real directory: {}",
                        parent.display()
                    ),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        fs::create_dir(&parent)?;
                        created.push(parent.clone());
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        for directory in created.iter().rev() {
            let _ = fs::remove_dir(directory);
        }
        return Err(error);
    }
    Ok(created)
}

fn validate_native_codex_resources(staged_root: &Path) -> anyhow::Result<()> {
    let agents = staged_root.join(".codex/agents");
    if agents.exists() {
        ensure_real_directory(&agents, "staged native Codex agents")?;
        let mut files = Vec::new();
        collect_staged_files(&agents, &agents, &mut files)?;
        for relative in files {
            anyhow::ensure!(
                relative.extension().and_then(|value| value.to_str()) == Some("toml"),
                "native Codex agent resources must be TOML files: {}",
                relative.display()
            );
            let path = agents.join(&relative);
            let source = fs::read_to_string(&path)?;
            let document = source.parse::<toml::Table>().with_context(|| {
                format!("invalid Codex custom-agent TOML at {}", path.display())
            })?;
            for field in ["name", "description", "developer_instructions"] {
                anyhow::ensure!(
                    document
                        .get(field)
                        .and_then(toml::Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty()),
                    "Codex custom agent {} requires a non-empty {field}",
                    path.display()
                );
            }
            for field in ["model", "model_reasoning_effort", "sandbox_mode"] {
                if let Some(value) = document.get(field) {
                    anyhow::ensure!(
                        value.as_str().is_some_and(|value| !value.trim().is_empty()),
                        "Codex custom agent {} has an invalid optional {field}",
                        path.display()
                    );
                }
            }
        }
    }

    let skills = staged_root.join(".agents/skills");
    if !skills.exists() {
        return Ok(());
    }
    ensure_real_directory(&skills, "staged repository skills")?;
    for entry in fs::read_dir(&skills)? {
        let entry = entry?;
        let skill_dir = entry.path();
        let metadata = entry.file_type()?;
        anyhow::ensure!(
            metadata.is_dir() && !metadata.is_symlink(),
            "repository skill must be a real directory: {}",
            skill_dir.display()
        );
        let folder_name = entry.file_name().to_string_lossy().into_owned();
        let source = fs::read_to_string(skill_dir.join("SKILL.md"))
            .with_context(|| format!("repository skill {folder_name} has no readable SKILL.md"))?;
        let rest = source
            .strip_prefix("---\n")
            .ok_or_else(|| anyhow::anyhow!("skill {folder_name} has no YAML frontmatter"))?;
        let (frontmatter, _) = rest
            .split_once("\n---\n")
            .ok_or_else(|| anyhow::anyhow!("skill {folder_name} has unterminated frontmatter"))?;
        let metadata: serde_yaml::Mapping = serde_yaml::from_str(frontmatter)
            .with_context(|| format!("skill {folder_name} has invalid frontmatter"))?;
        let name_key = serde_yaml::Value::String("name".to_owned());
        let description_key = serde_yaml::Value::String("description".to_owned());
        anyhow::ensure!(
            metadata.get(&name_key).and_then(serde_yaml::Value::as_str)
                == Some(folder_name.as_str()),
            "skill folder {folder_name} must match its frontmatter name"
        );
        anyhow::ensure!(
            metadata
                .get(&description_key)
                .and_then(serde_yaml::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty()),
            "skill {folder_name} must have a description"
        );
        let mut files = Vec::new();
        collect_staged_files(&skill_dir, &skill_dir, &mut files)?;
        for relative in files {
            if matches!(
                relative.extension().and_then(|value| value.to_str()),
                Some("yaml" | "yml")
            ) {
                let contents = fs::read(skill_dir.join(relative))?;
                serde_yaml::from_slice::<serde_yaml::Value>(&contents)
                    .with_context(|| format!("skill {folder_name} contains invalid YAML"))?;
            }
        }
    }
    Ok(())
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn execute_ticket_action(
    root: &Path,
    run_id: Option<&str>,
    action: &str,
    ticket: &str,
    params: BTreeMap<String, String>,
) -> anyhow::Result<()> {
    let (_, result) = execute_ticket_action_value(root, run_id, action, ticket, params)?;
    print_json(&result)
}

fn execute_ticket_action_value(
    root: &Path,
    run_id: Option<&str>,
    action: &str,
    ticket: &str,
    mut params: BTreeMap<String, String>,
) -> anyhow::Result<(Engine, Value)> {
    let mut engine = open_engine(root, run_id)?;
    let definition = engine
        .profile()
        .action(action)
        .ok_or_else(|| anyhow::anyhow!("profile does not define action {action}"))?;
    let ticket_key = if definition.params.contains_key("ticket") {
        "ticket"
    } else {
        "ticket_id"
    };
    params.insert(ticket_key.to_owned(), ticket.to_owned());
    params.retain(|key, _| definition.params.contains_key(key));
    let result = engine.execute_action(action, params)?;
    Ok((engine, result))
}

fn context_document_path(result: &Value) -> anyhow::Result<&str> {
    let mut paths = result
        .as_object()
        .into_iter()
        .flat_map(|object| {
            object
                .values()
                .filter_map(|value| value.get("document_path").and_then(Value::as_str))
        })
        .collect::<BTreeSet<_>>();
    if let Some(path) = result.get("document_path").and_then(Value::as_str) {
        paths.insert(path);
    }
    anyhow::ensure!(
        paths.len() == 1,
        "context action must return exactly one compiler-issued document path"
    );
    Ok(paths.into_iter().next().expect("one context path"))
}

fn execute_named_action(
    root: &Path,
    run_id: Option<&str>,
    action: &str,
    params: BTreeMap<String, String>,
) -> anyhow::Result<()> {
    let mut engine = open_engine(root, run_id)?;
    let result = engine.execute_action(action, params)?;
    print_json(&result)
}

fn open_engine(root: &Path, run_id: Option<&str>) -> anyhow::Result<Engine> {
    Ok(match run_id {
        Some(run_id) => Engine::open_run(root, run_id)?,
        None => Engine::open(root)?,
    })
}

#[derive(Debug)]
struct QuestionInput {
    contents: String,
    label: String,
}

fn read_question_input(path: Option<&Path>) -> anyhow::Result<QuestionInput> {
    match path {
        Some(path) if path != Path::new("-") => Ok(QuestionInput {
            contents: fs::read_to_string(path).with_context(|| {
                format!("could not read structured question from {}", path.display())
            })?,
            label: path.display().to_string(),
        }),
        _ => {
            let mut contents = String::new();
            std::io::stdin()
                .read_to_string(&mut contents)
                .context("could not read structured question from stdin")?;
            Ok(QuestionInput {
                contents,
                label: "stdin".to_owned(),
            })
        }
    }
}

fn infer_question_format(format: QuestionInputFormat, path: Option<&Path>) -> QuestionInputFormat {
    if format != QuestionInputFormat::Auto {
        return format;
    }
    match path
        .and_then(Path::extension)
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("json") => QuestionInputFormat::Json,
        Some("yaml" | "yml") => QuestionInputFormat::Yaml,
        _ => QuestionInputFormat::Auto,
    }
}

fn parse_question_record(
    input: &str,
    format: QuestionInputFormat,
    source: &str,
) -> anyhow::Result<QuestionRecord> {
    anyhow::ensure!(
        !input.trim().is_empty(),
        "{source} contains no question record"
    );
    match format {
        QuestionInputFormat::Json => QuestionRecord::from_json(input)
            .with_context(|| format!("invalid JSON question record from {source}")),
        QuestionInputFormat::Yaml => QuestionRecord::from_yaml(input)
            .with_context(|| format!("invalid YAML question record from {source}")),
        QuestionInputFormat::Auto => match QuestionRecord::from_json(input) {
            Ok(question) => Ok(question),
            Err(json_error) => QuestionRecord::from_yaml(input).with_context(|| {
                format!(
                    "structured question from {source} is neither valid JSON ({json_error}) nor valid YAML"
                )
            }),
        },
    }
}

fn record_agent_question(
    root: &Path,
    run_id: &str,
    input: &str,
    format: QuestionInputFormat,
    source: &str,
) -> anyhow::Result<QuestionRecord> {
    let question = parse_question_record(input, format, source)?;
    Engine::record_question(root, run_id, &question)?;
    Ok(question)
}

#[derive(Debug, Serialize)]
struct PiMigrationCommandOutput {
    mode: &'static str,
    config_plan: Schema2MigrationPlan,
    run_plan: PiMigrationRunPlan,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive: Option<PiMigrationRunArchiveResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Schema2MigrationResult>,
}

fn execute_pi_migration(root: &Path, apply: bool) -> anyhow::Result<PiMigrationCommandOutput> {
    let config_plan = Schema2Migrator::plan(root)?;
    let run_plan = Engine::inspect_pi_migration_runs(&config_plan.project_root, &config_plan)?;
    if !apply {
        return Ok(PiMigrationCommandOutput {
            mode: "dry_run",
            config_plan,
            run_plan,
            archive: None,
            result: None,
        });
    }

    let archived = Engine::archive_pi_migration_runs(&config_plan, &run_plan)?;
    let project_root = config_plan.project_root.clone();
    let result = Schema2Migrator::apply(&config_plan, archived.proof, |staged| {
        ProfileCompiler::compile_with_project_root(staged, &project_root).map(|_| ())
    })?;
    Ok(PiMigrationCommandOutput {
        mode: "apply",
        config_plan,
        run_plan,
        archive: Some(archived.result),
        result: Some(result),
    })
}

fn print_json(value: &impl serde::Serialize) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::{BTreeMap, BTreeSet};
    use std::ffi::OsString;

    use git2::{IndexAddOption, Repository, Signature};

    #[test]
    fn init_cli_leaves_profile_selection_to_initialization_and_exposes_explicit_controls() {
        let defaults = Cli::try_parse_from(["koni", "init"]).expect("default init parses");
        assert!(matches!(
            defaults.command,
            Some(Command::Init {
                profile: None,
                source: None,
                target: None,
                replace: false,
                open: false,
                dry_run: false,
            })
        ));

        let configured = Cli::try_parse_from([
            "koni",
            "init",
            "--profile",
            "research",
            "--target",
            "/tmp/project",
            "--replace",
            "--open",
            "--dry-run",
        ])
        .expect("configured init parses");
        assert!(matches!(
            configured.command,
            Some(Command::Init {
                profile: Some(BuiltinProfile::Research),
                target: Some(target),
                replace: true,
                open: true,
                dry_run: true,
                ..
            }) if target == Path::new("/tmp/project")
        ));
        assert!(
            Cli::try_parse_from([
                "koni",
                "init",
                "--profile",
                "software",
                "--from",
                "/tmp/profile",
            ])
            .is_err()
        );
    }

    #[test]
    fn init_project_target_preparation_accepts_missing_and_empty_directories() {
        let temporary = tempfile::tempdir().expect("temporary target parent");
        let temporary_root = temporary.path().canonicalize().unwrap();
        let missing = temporary_root.join("missing-project");
        prepare_init_project_target(&missing, false).expect("missing target should be created");
        assert!(missing.is_dir());
        assert!(fs::read_dir(&missing).unwrap().next().is_none());

        let empty = temporary_root.join("empty-project");
        fs::create_dir(&empty).unwrap();
        prepare_init_project_target(&empty, true)
            .expect("deprecated --force remains harmless for an empty target");
        assert!(fs::read_dir(&empty).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn init_project_initializes_missing_and_empty_targets_and_restores_cwd() {
        let temporary = tempfile::tempdir().expect("temporary initialized targets");
        let temporary_root = temporary.path().canonicalize().unwrap();
        let profile = temporary_root.join("test-profile");
        write_init_project_test_profile(&profile);

        for (target, create_first) in [
            (temporary_root.join("missing-project"), false),
            (temporary_root.join("empty-project"), true),
        ] {
            if create_first {
                fs::create_dir(&target).unwrap();
            }
            let cwd_restored = Cell::new(false);
            initialize_legacy_project_run_with_hooks(
                target.clone(),
                profile.clone(),
                "exercise anchored initialization".to_owned(),
                false,
                || {},
                |original, restored| {
                    assert_eq!(restored, original);
                    cwd_restored.set(true);
                },
            )
            .expect("a real missing or empty target should initialize");
            assert!(target.join(".codex/koni/profile.yaml").is_file());
            assert!(target.join(".git").is_dir());
            assert!(target.join("program/state.yaml").is_file());
            assert!(cwd_restored.get(), "success must cross cwd restoration");
        }
    }

    #[test]
    fn init_project_force_preserves_every_nonempty_target_shape() {
        let temporary = tempfile::tempdir().expect("temporary filesystem fixture");
        let temporary_root = temporary.path().canonicalize().unwrap();
        let filesystem_root = temporary_root.join("filesystem-root");
        let home = filesystem_root.join("home");
        let ancestor = home.join("workspace");
        let repository = ancestor.join("repository");
        let cwd = repository.join("packages/app");
        let ordinary = filesystem_root.join("ordinary-project");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir(&ordinary).unwrap();
        Repository::init(&repository).expect("repository-root fixture");

        for (path, contents) in [
            (&filesystem_root, b"filesystem root bytes".as_slice()),
            (&home, b"home bytes".as_slice()),
            (&ancestor, b"ancestor bytes".as_slice()),
            (&repository, b"repository bytes".as_slice()),
            (&cwd, b"cwd bytes".as_slice()),
            (&ordinary, b"ordinary target bytes".as_slice()),
        ] {
            fs::write(path.join("koni-safety-marker"), contents).unwrap();
        }

        for (label, target) in [
            ("filesystem root", &filesystem_root),
            ("home", &home),
            ("ancestor", &ancestor),
            ("repository root", &repository),
            ("cwd", &cwd),
            ("ordinary target", &ordinary),
        ] {
            let before = snapshot_test_tree(target);
            let error = prepare_init_project_target(target, true)
                .expect_err("--force must never replace a nonempty target");
            let message = error.to_string();
            assert!(
                message.contains("target is not empty"),
                "{label}: {message}"
            );
            assert!(message.contains("`koni init`"), "{label}: {message}");
            assert_eq!(
                snapshot_test_tree(target),
                before,
                "{label} changed after rejected init-project --force"
            );
        }
    }

    #[test]
    fn init_project_cli_force_rejects_before_opening_the_profile() {
        let temporary = tempfile::tempdir().expect("temporary CLI target");
        let temporary_root = temporary.path().canonicalize().unwrap();
        let target = temporary_root.join("existing-project");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("important.txt"), b"preserve this project").unwrap();
        let before = snapshot_test_tree(&target);
        let missing_profile = temporary_root.join("missing-profile.yaml");
        let cli = Cli::try_parse_from(vec![
            OsString::from("koni"),
            OsString::from("init-project"),
            target.as_os_str().to_owned(),
            OsString::from("--profile"),
            missing_profile.as_os_str().to_owned(),
            OsString::from("--goal"),
            OsString::from("exercise safe initialization"),
            OsString::from("--force"),
        ])
        .expect("legacy --force invocation still parses");

        let error = dispatch(cli).expect_err("a nonempty CLI target must fail before profile open");
        let message = error.to_string();
        assert!(message.contains("target is not empty"), "{message}");
        assert!(message.contains("`koni init`"), "{message}");
        assert_eq!(snapshot_test_tree(&target), before);
    }

    #[cfg(unix)]
    #[test]
    fn init_project_rejects_target_symlinks_without_touching_the_referent() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().expect("temporary symlink fixture");
        let temporary_root = temporary.path().canonicalize().unwrap();
        let referent = temporary_root.join("existing-project");
        let target = temporary_root.join("linked-project");
        fs::create_dir(&referent).unwrap();
        fs::write(referent.join("important.txt"), b"keep these bytes").unwrap();
        symlink(&referent, &target).unwrap();
        let before = snapshot_test_tree(&referent);

        let error = prepare_init_project_target(&target, true)
            .expect_err("a target symlink must fail closed");
        assert!(error.to_string().contains("file or symlink"), "{error:#}");
        assert!(
            fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(snapshot_test_tree(&referent), before);

        let mut trailing_target = target.as_os_str().to_os_string();
        trailing_target.push("/");
        let trailing_error = prepare_init_project_target(Path::new(&trailing_target), true)
            .expect_err("a trailing-separator target symlink must fail closed");
        assert!(
            trailing_error.to_string().contains("file or symlink"),
            "{trailing_error:#}"
        );
        assert_eq!(snapshot_test_tree(&referent), before);
    }

    #[cfg(unix)]
    #[test]
    fn init_project_rejects_file_and_symlink_ancestor_without_writing_referents() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().expect("temporary ancestor fixture");
        let temporary_root = temporary.path().canonicalize().unwrap();
        let file_target = temporary_root.join("project-file");
        fs::write(&file_target, b"preserve file bytes").unwrap();
        let file_error = prepare_init_project_target(&file_target, true)
            .expect_err("an ordinary file target must fail closed");
        assert!(file_error.to_string().contains("file or symlink"));
        assert_eq!(fs::read(&file_target).unwrap(), b"preserve file bytes");

        let referent = temporary_root.join("referent");
        let linked_parent = temporary_root.join("linked-parent");
        fs::create_dir(&referent).unwrap();
        fs::write(referent.join("important.txt"), b"preserve referent bytes").unwrap();
        symlink(&referent, &linked_parent).unwrap();
        let before = snapshot_test_tree(&referent);
        let error = prepare_init_project_target(&linked_parent.join("new-project"), true)
            .expect_err("a missing child below a symlink ancestor must fail closed");
        assert!(
            error
                .to_string()
                .contains("ancestors must be real directories"),
            "{error:#}"
        );
        assert_eq!(snapshot_test_tree(&referent), before);
        assert!(!referent.join("new-project").exists());
    }

    #[cfg(unix)]
    #[test]
    fn init_project_keeps_writes_on_held_inode_when_target_is_replaced() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().expect("temporary target-race fixture");
        let temporary_root = temporary.path().canonicalize().unwrap();
        let target = temporary_root.join("project");
        let original = temporary_root.join("original-project");
        let victim = temporary_root.join("victim");
        fs::create_dir(&target).unwrap();
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("important.txt"), b"victim bytes").unwrap();
        let victim_before = snapshot_test_tree(&victim);
        let profile = temporary_root.join("test-profile");
        write_init_project_test_profile(&profile);
        let cwd_restored = Cell::new(false);

        let error = initialize_legacy_project_run_with_hooks(
            target.clone(),
            profile,
            "exercise target replacement safety".to_owned(),
            true,
            || {
                fs::rename(&target, &original).unwrap();
                symlink(&victim, &target).unwrap();
            },
            |original, restored| {
                assert_eq!(restored, original);
                cwd_restored.set(true);
            },
        )
        .expect_err("a replaced target path must fail after anchored initialization");

        let message = error.to_string();
        assert!(message.contains("target path changed"), "{error:#}");
        assert!(message.contains("original held directory inode"));
        assert_eq!(snapshot_test_tree(&victim), victim_before);
        assert!(original.join(".codex/koni/profile.yaml").is_file());
        assert!(original.join("program/state.yaml").is_file());
        assert!(cwd_restored.get(), "target-race error must restore cwd");
    }

    #[cfg(unix)]
    #[test]
    fn init_project_keeps_writes_on_held_inode_when_ancestor_is_replaced() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().expect("temporary ancestor-race fixture");
        let temporary_root = temporary.path().canonicalize().unwrap();
        let parent = temporary_root.join("parent");
        let original_parent = temporary_root.join("original-parent");
        let target = parent.join("project");
        let victim = temporary_root.join("victim");
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&victim).unwrap();
        fs::write(victim.join("important.txt"), b"victim bytes").unwrap();
        let victim_before = snapshot_test_tree(&victim);
        let profile = temporary_root.join("test-profile");
        write_init_project_test_profile(&profile);
        let cwd_restored = Cell::new(false);

        let error = initialize_legacy_project_run_with_hooks(
            target.clone(),
            profile,
            "exercise ancestor replacement safety".to_owned(),
            false,
            || {
                fs::rename(&parent, &original_parent).unwrap();
                fs::create_dir(&parent).unwrap();
                symlink(&victim, &target).unwrap();
            },
            |original, restored| {
                assert_eq!(restored, original);
                cwd_restored.set(true);
            },
        )
        .expect_err("a replaced ancestor path must fail after anchored initialization");

        let message = error.to_string();
        assert!(message.contains("target path changed"), "{error:#}");
        assert!(message.contains("original held directory inode"));
        assert_eq!(snapshot_test_tree(&victim), victim_before);
        assert!(
            original_parent
                .join("project/.codex/koni/profile.yaml")
                .is_file()
        );
        assert!(original_parent.join("project/program/state.yaml").is_file());
        assert!(cwd_restored.get(), "ancestor-race error must restore cwd");
    }

    #[test]
    fn non_interactive_init_requires_an_explicit_profile_source_before_writing() {
        let temporary = tempfile::tempdir().unwrap();
        let error = initialize_project_with_profile_selector(
            None,
            None,
            Some(temporary.path()),
            false,
            false,
            false,
            false,
            || -> anyhow::Result<BuiltinProfile> {
                panic!("a non-interactive init must never invoke the picker")
            },
        )
        .expect_err("fresh non-interactive init must require an explicit source");
        let message = error.to_string();
        assert!(message.contains("--profile software"), "{message}");
        assert!(message.contains("--profile research"), "{message}");
        assert!(message.contains("--from <PATH>"), "{message}");
        assert!(!temporary.path().join(".codex").exists());
        assert!(!temporary.path().join(".agents").exists());
    }

    #[test]
    fn interactive_profile_picker_reprompts_and_accepts_names_or_numbers() {
        let mut input = std::io::Cursor::new(b"unknown\nresearch\n");
        let mut output = Vec::new();
        assert_eq!(
            prompt_for_builtin_profile(&mut input, &mut output).unwrap(),
            BuiltinProfile::Research
        );
        let transcript = String::from_utf8(output).unwrap();
        assert!(transcript.contains("1) Software"));
        assert!(transcript.contains("2) Research"));
        assert!(transcript.contains("Enter 1 or software"));

        let mut input = std::io::Cursor::new(b"1\n");
        assert_eq!(
            prompt_for_builtin_profile(&mut input, &mut Vec::new()).unwrap(),
            BuiltinProfile::Software
        );
    }

    #[test]
    fn fresh_and_replacement_dry_runs_use_selection_but_existing_and_legacy_do_not() {
        let fresh = tempfile::tempdir().unwrap();
        initialize_project_with_profile_selector(
            None,
            None,
            Some(fresh.path()),
            false,
            false,
            true,
            true,
            || Ok(BuiltinProfile::Research),
        )
        .expect("interactive dry run should use the selected profile");
        assert!(!fresh.path().join(".codex").exists());

        let existing = tempfile::tempdir().unwrap();
        install_schema2_profile(existing.path(), Some(BuiltinProfile::Software), None, false)
            .unwrap();
        initialize_project_with_profile_selector(
            None,
            None,
            Some(existing.path()),
            false,
            false,
            true,
            false,
            || -> anyhow::Result<BuiltinProfile> {
                panic!("an existing installation must not invoke the picker")
            },
        )
        .expect("existing dry run should preserve its installed profile");
        initialize_project_with_profile_selector(
            None,
            None,
            Some(existing.path()),
            true,
            false,
            true,
            true,
            || Ok(BuiltinProfile::Research),
        )
        .expect("replacement dry run should use the selected profile");

        let legacy = tempfile::tempdir().unwrap();
        fs::create_dir_all(legacy.path().join(".codex").join(LEGACY_PROFILE_DIRECTORY)).unwrap();
        initialize_project_with_profile_selector(
            None,
            None,
            Some(legacy.path()),
            false,
            false,
            true,
            false,
            || -> anyhow::Result<BuiltinProfile> {
                panic!("a legacy migration must not invoke the picker")
            },
        )
        .expect("legacy dry run should preserve its installed profile");
    }

    #[test]
    fn project_discovery_uses_the_nearest_git_root_and_non_git_fallback() {
        let temporary = tempfile::tempdir().unwrap();
        let repository = temporary.path().join("repository");
        let nested = repository.join("packages/app/src");
        fs::create_dir_all(&nested).unwrap();
        Repository::init(&repository).unwrap();
        assert_eq!(
            find_project_root_from(&nested).unwrap(),
            repository.canonicalize().unwrap()
        );

        let standalone = temporary.path().join("standalone/nested");
        fs::create_dir_all(&standalone).unwrap();
        assert_eq!(find_project_root_from(&standalone).unwrap(), standalone);

        let bogus = temporary.path().join("bogus/nested");
        fs::create_dir_all(&bogus).unwrap();
        fs::create_dir(temporary.path().join("bogus/.git")).unwrap();
        assert!(find_project_root_from(&bogus).is_err());
    }

    #[test]
    fn selected_run_lifecycle_commands_expose_safe_delete_defaults() {
        let pause = Cli::try_parse_from(["koni", "pause-run", "run-1", "--root", "/tmp/project"])
            .expect("pause command should parse");
        assert!(matches!(
            pause.command,
            Some(Command::PauseRun { id, root })
                if id == "run-1" && root == Path::new("/tmp/project")
        ));

        let delete = Cli::try_parse_from(["koni", "delete-run", "run-1", "--preview"])
            .expect("delete preview should parse");
        assert!(matches!(
            delete.command,
            Some(Command::DeleteRun {
                id,
                preview: true,
                delete_owned_branches: false,
                ..
            }) if id == "run-1"
        ));
    }

    #[test]
    fn wait_worker_cli_accepts_a_bounded_variadic_ticket_set() {
        let cli = Cli::try_parse_from([
            "koni",
            "wait-worker",
            "TK-first",
            "TK-second",
            "--root",
            "/tmp/project",
            "--timeout-seconds",
            "42",
        ])
        .expect("wait-worker command should parse");
        assert!(matches!(
            cli.command,
            Some(Command::WaitWorker {
                tickets,
                root,
                timeout_seconds: 42,
            }) if tickets == ["TK-first", "TK-second"]
                && root == Path::new("/tmp/project")
        ));

        assert!(Cli::try_parse_from(["koni", "wait-worker"]).is_err());
        assert!(
            Cli::try_parse_from(["koni", "wait-worker", "TK-first", "--timeout-seconds", "0",])
                .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "koni",
                "wait-worker",
                "TK-first",
                "--timeout-seconds",
                "901",
            ])
            .is_err()
        );
    }

    #[test]
    fn context_cli_exposes_one_shot_document_output_without_changing_the_default() {
        let printed = Cli::try_parse_from([
            "koni",
            "context",
            "TK-one",
            "--step",
            "implement",
            "--persona",
            "builder",
            "--print",
        ])
        .expect("one-shot context command should parse");
        assert!(matches!(
            printed.command,
            Some(Command::Context {
                ticket,
                step: Some(step),
                persona: Some(persona),
                print: true,
                ..
            }) if ticket == "TK-one" && step == "implement" && persona == "builder"
        ));

        let default = Cli::try_parse_from(["koni", "context", "TK-one"])
            .expect("legacy path-result context command should still parse");
        assert!(matches!(
            default.command,
            Some(Command::Context { print: false, .. })
        ));

        let result = json!({
            "context_pack": {
                "document_path": "program/work/tickets/TK-one/context/hash/context.md",
                "manifest": {
                    "document_path": "program/work/tickets/TK-one/context/hash/context.md"
                }
            }
        });
        assert_eq!(
            context_document_path(&result).expect("configured context step path"),
            "program/work/tickets/TK-one/context/hash/context.md"
        );
        assert!(context_document_path(&json!({"context_pack": {}})).is_err());
    }

    #[test]
    fn graph_resource_cli_exposes_bounded_queries_and_advisory_notes() {
        let context = Cli::try_parse_from([
            "koni",
            "graph-context",
            "TK-one",
            "--root",
            "/tmp/project",
            "--anchor",
            "objective-one",
            "--anchor",
            "system-one",
            "--relation",
            "systems",
            "--direction",
            "outgoing",
            "--max-depth",
            "2",
            "--node-type",
            "system",
        ])
        .expect("bounded graph context command should parse");
        assert!(matches!(
            context.command,
            Some(Command::GraphContext {
                ticket,
                root,
                anchors,
                relations,
                direction,
                max_depth: 2,
                node_types,
            }) if ticket == "TK-one"
                && root == Path::new("/tmp/project")
                && anchors == ["objective-one", "system-one"]
                && relations == ["systems"]
                && direction == "outgoing"
                && node_types == ["system"]
        ));
        assert!(
            Cli::try_parse_from(["koni", "graph-context", "TK-one", "--direction", "sideways",])
                .is_err()
        );

        let note = Cli::try_parse_from([
            "koni",
            "record-note",
            "TK-one",
            "--step",
            "implement",
            "--persona",
            "implementer",
            "--node-id",
            "system-one",
            "--kind",
            "rationale",
            "--body",
            "Keep this boundary narrow.",
            "--supersedes",
            "NT-prior",
        ])
        .expect("advisory graph note command should parse");
        assert!(matches!(
            note.command,
            Some(Command::RecordNote {
                ticket,
                step,
                persona,
                node_id,
                kind,
                body,
                supersedes: Some(supersedes),
                ..
            }) if ticket == "TK-one"
                && step == "implement"
                && persona == "implementer"
                && node_id == "system-one"
                && kind == "rationale"
                && body == "Keep this boundary narrow."
                && supersedes == "NT-prior"
        ));
    }

    #[test]
    fn rollback_cli_exposes_a_read_only_dry_run() {
        let cli = Cli::try_parse_from([
            "koni",
            "rollback",
            "TK-target",
            "--reason",
            "invalid evidence",
            "--dry-run",
            "--root",
            "/tmp/project",
        ])
        .expect("rollback dry-run should parse");
        assert!(matches!(
            cli.command,
            Some(Command::Rollback {
                target,
                reason,
                dry_run: true,
                root,
            }) if target == "TK-target"
                && reason == "invalid evidence"
                && root == Path::new("/tmp/project")
        ));
        assert!(
            Cli::try_parse_from(["koni", "rollback", "TK-target", "--dry-run"]).is_err(),
            "an operator reason remains mandatory even for preview"
        );
    }

    #[test]
    fn migrate_pi_cli_requires_exactly_one_explicit_mode() {
        let dry_run =
            Cli::try_parse_from(["koni", "migrate-pi", "--dry-run", "--root", "/tmp/project"])
                .expect("Pi migration dry-run should parse");
        assert!(matches!(
            dry_run.command,
            Some(Command::MigratePi {
                root,
                dry_run: true,
                apply: false,
            }) if root == Path::new("/tmp/project")
        ));

        let apply = Cli::try_parse_from(["koni", "migrate-pi", "--apply"])
            .expect("Pi migration apply should parse");
        assert!(matches!(
            apply.command,
            Some(Command::MigratePi {
                dry_run: false,
                apply: true,
                ..
            })
        ));
        assert!(Cli::try_parse_from(["koni", "migrate-pi"]).is_err());
        assert!(Cli::try_parse_from(["koni", "migrate-pi", "--dry-run", "--apply"]).is_err());
    }

    #[test]
    fn pi_auth_and_model_commands_expose_only_the_subscription_control_surface() {
        for (operation, expected_json) in [("status", false), ("login", true), ("logout", false)] {
            let mut arguments = vec!["koni", "auth", operation];
            if expected_json {
                arguments.push("--json");
            }
            let parsed = Cli::try_parse_from(arguments).expect("Pi auth command should parse");
            assert!(matches!(
                (&parsed.command, operation),
                (
                    Some(Command::Auth {
                        command: AuthCommand::Status { json: false }
                    }),
                    "status"
                ) | (
                    Some(Command::Auth {
                        command: AuthCommand::Login { json: true }
                    }),
                    "login"
                ) | (
                    Some(Command::Auth {
                        command: AuthCommand::Logout { json: false }
                    }),
                    "logout"
                )
            ));
        }

        let models = Cli::try_parse_from(["koni", "models", "--json"])
            .expect("Pi model catalog command should parse");
        assert!(matches!(
            models.command,
            Some(Command::Models { json: true })
        ));
        assert!(
            Cli::try_parse_from(["koni", "auth", "api-key"]).is_err(),
            "the CLI must not grow an API-key authentication path"
        );
    }

    #[test]
    fn migrate_pi_dry_run_is_read_only_and_apply_uses_engine_archive_proof() {
        let temporary = tempfile::tempdir().expect("temporary project");
        let root = temporary.path();
        install_profile(root, Some(BuiltinProfile::Research), None, false)
            .expect("install bundled schema-1 profile");
        fs::write(root.join(".codex/unrelated.txt"), "operator-owned\n")
            .expect("write unrelated Codex file");
        initialize_test_repository(root);

        let legacy_project =
            fs::read(root.join(".codex/koni/project.yaml")).expect("read legacy project manifest");
        let dry_run = execute_pi_migration(root, false).expect("inspect Pi migration");
        assert_eq!(dry_run.mode, "dry_run");
        assert!(dry_run.run_plan.can_apply);
        assert!(dry_run.run_plan.runs.is_empty());
        assert!(dry_run.archive.is_none());
        assert!(dry_run.result.is_none());
        assert_eq!(
            fs::read(root.join(".codex/koni/project.yaml")).unwrap(),
            legacy_project
        );
        assert!(!root.join(".koni").exists());
        assert!(!root.join(".koni-migrations").exists());
        assert!(!root.join(".git/koni").exists());
        assert!(
            serde_json::to_value(&dry_run)
                .unwrap()
                .get("proof")
                .is_none(),
            "the opaque run proof must never cross the CLI serialization boundary"
        );

        let applied = execute_pi_migration(root, true).expect("apply Pi migration");
        assert_eq!(applied.mode, "apply");
        let archive = applied.archive.expect("Engine archive result");
        assert!(archive.archived_runs.is_empty());
        assert!(archive.archive_receipts.is_empty());
        assert!(!archive.resume_allowed);
        let result = applied.result.expect("schema-2 migration result");
        assert_eq!(result.migration_id, applied.config_plan.migration_id);
        assert!(root.join(".koni/project.yaml").is_file());
        assert!(!root.join(".codex/koni").exists());
        assert_eq!(
            fs::read_to_string(root.join(".codex/unrelated.txt")).unwrap(),
            "operator-owned\n"
        );
        assert!(root.join(&applied.config_plan.backup_root).is_dir());
        assert!(
            root.join(".git/koni/migrations/schema2-publication.json")
                .is_file(),
            "apply keeps authenticated recovery state in the compiler-owned Git sidecar"
        );

        let catalog = ProjectCatalogCompiler::compile(root)
            .expect("the published schema-2 catalog becomes the live compiler input");
        assert_eq!(catalog.document.schema_version, KONI_SCHEMA2_VERSION);
        let planned = Engine::plan_run(root, None, "Verify the Pi cutover", "HEAD", None)
            .expect("a migrated project can create a new run without Codex configuration");
        let run_root = root.join(".git/koni/runs").join(&planned.run_id);
        let snapshot = koni_core::state::ConfigSnapshot::load_verified(&run_root)
            .expect("the new run has an immutable schema-2 snapshot");
        assert!(
            snapshot
                .files
                .keys()
                .any(|path| path.starts_with(Path::new(".koni")))
        );
        assert!(
            snapshot
                .files
                .keys()
                .all(|path| !path.starts_with(Path::new(".codex"))),
            "post-migration runs must not recapture Codex runtime resources"
        );
    }

    #[test]
    fn ticket_review_cli_accepts_no_caller_supplied_verdict() {
        assert!(Cli::try_parse_from(["koni", "review", "TK-one"]).is_ok());
        assert!(Cli::try_parse_from(["koni", "review", "TK-one", "--status", "passed",]).is_err());
        assert!(
            Cli::try_parse_from(["koni", "review", "TK-one", "--notes", "self review",]).is_err()
        );
    }

    #[test]
    fn lead_slice_cli_exposes_packet_and_explicit_yield_reason() {
        let next = Cli::try_parse_from(["koni", "lead-next", "--root", "/tmp/run"])
            .expect("lead-next command should parse");
        assert!(matches!(
            next.command,
            Some(Command::LeadNext { root }) if root == Path::new("/tmp/run")
        ));

        let yielded = Cli::try_parse_from([
            "koni",
            "yield-lead",
            "--root",
            "/tmp/run",
            "--reason",
            "boundary-complete",
        ])
        .expect("yield-lead command should parse");
        assert!(matches!(
            yielded.command,
            Some(Command::YieldLead { root, reason })
                if root == Path::new("/tmp/run") && reason == "boundary-complete"
        ));
        assert!(Cli::try_parse_from(["koni", "yield-lead"]).is_err());
    }

    #[test]
    fn every_lead_prompt_uses_exact_compact_lifecycle_commands() {
        for inventory in [templates::SOFTWARE_CODEX, templates::RESEARCH_CODEX] {
            let lead = inventory
                .iter()
                .find(|file| file.path == "agents/lead.toml")
                .expect("bundled Lead prompt");
            let prompt = std::str::from_utf8(lead.contents).expect("UTF-8 Lead prompt");
            let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
            assert!(normalized.contains("one fresh, compiler-leased Lead slice"));
            assert!(
                normalized.contains("do not run `inspect`")
                    || normalized.contains("do not run `inspect`,")
            );
            assert!(normalized.contains("koni_runtime.review"));
            assert!(
                normalized.contains("without a verdict or notes")
                    || normalized.contains("without supplying a verdict or notes")
                    || (normalized.contains("without")
                        && normalized.contains("verdict")
                        && normalized.contains("notes"))
            );
            assert!(!normalized.contains("review --status"));
            assert!(normalized.contains("koni_runtime.yield_lead"));
            assert!(!normalized.contains("koni review --root"));
        }

        for prompt in [
            include_str!("../../../profiles/research/personas/prompts/lead.md"),
            include_str!("../../../fixtures/updog-repo/.codex/agents/lead.toml"),
        ] {
            let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
            assert!(normalized.contains("koni_runtime.review"));
            assert!(!normalized.contains("review --status"));
            assert!(normalized.contains("configured read-only reviewer"));
            assert!(normalized.contains("fresh") && normalized.contains("Lead slice"));
            assert!(normalized.contains("koni_runtime.yield_lead"));
            assert!(!normalized.contains("koni review --root"));
            assert!(!normalized.contains("wait for that worker to exit, inspect again"));
        }
    }

    #[test]
    fn bundled_research_inventory_enforces_empirical_experiment_ontology() {
        let embedded = |inventory: &'static [templates::EmbeddedFile], path: &str| {
            inventory
                .iter()
                .find(|file| file.path == path)
                .map(|file| std::str::from_utf8(file.contents).expect("UTF-8 embedded resource"))
                .unwrap_or_else(|| panic!("missing embedded research resource {path}"))
        };

        let nodes = embedded(templates::RESEARCH, "graph/nodes.yaml");
        for contract in [
            "category: empirical_execution",
            "empirical_mode",
            "execution_protocol",
            "observable_outcome",
            "static reasoning or proof",
        ] {
            assert!(
                nodes.contains(contract),
                "missing node ontology contract {contract}"
            );
        }

        let workflows = embedded(templates::RESEARCH, "workflows/research.yaml");
        assert!(workflows.contains("non-empirical-experiment"));
        assert!(workflows.contains("experiment-ontology-failed"));
        assert!(workflows.contains("placeholder empirical fields"));

        let designer = embedded(templates::RESEARCH_CODEX, "agents/experiment-designer.toml");
        assert!(designer.contains("prospective empirical execution"));
        assert!(designer.contains("traceability mapping"));
        assert!(designer.contains("instead of fabricating an experiment"));

        let reviewer = embedded(templates::RESEARCH_CODEX, "agents/reviewer.toml");
        assert!(reviewer.contains("enforce the configured experiment ontology"));
        assert!(reviewer.contains("Reject placeholder empirical fields"));

        let lead = embedded(templates::RESEARCH_CODEX, "agents/lead.toml");
        assert!(lead.contains("also enforce its configured ontology contract"));
        assert!(lead.contains("Fail review"));
        assert!(lead.contains("placeholder empirical fields"));

        for authored_prompt in [
            include_str!("../../../profiles/research/personas/prompts/experiment-designer.md"),
            include_str!("../../../profiles/research/personas/prompts/reviewer.md"),
        ] {
            assert!(
                authored_prompt.contains("experiment ontology")
                    || authored_prompt.contains("prospective empirical execution")
            );
            assert!(authored_prompt.contains("traceability mapping"));
            assert!(authored_prompt.contains("observable"));
        }
    }

    fn recursive_file_inventory(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn collect(root: &Path, directory: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
            let mut entries = fs::read_dir(directory)
                .unwrap_or_else(|error| panic!("could not read {}: {error}", directory.display()))
                .map(|entry| entry.expect("research inventory directory entry"))
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                let path = entry.path();
                let metadata = entry.file_type().unwrap_or_else(|error| {
                    panic!("could not inspect {}: {error}", path.display())
                });
                assert!(
                    !metadata.is_symlink(),
                    "inventory rejects symlink {}",
                    path.display()
                );
                if metadata.is_dir() {
                    collect(root, &path, files);
                } else if metadata.is_file() {
                    let relative = path
                        .strip_prefix(root)
                        .expect("inventory entry remains beneath root")
                        .to_path_buf();
                    files.insert(
                        relative,
                        fs::read(&path).unwrap_or_else(|error| {
                            panic!("could not read {}: {error}", path.display())
                        }),
                    );
                }
            }
        }

        let mut files = BTreeMap::new();
        collect(root, root, &mut files);
        files
    }

    fn research_source_and_install_template_roots() -> (PathBuf, PathBuf, PathBuf) {
        let crate_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        (
            crate_root.join("../../profiles/research"),
            crate_root.join("templates/research"),
            crate_root.join("templates/codex/research/agents"),
        )
    }

    #[test]
    fn research_source_and_install_template_are_recursively_in_sync() {
        let (source_root, template_root, _) = research_source_and_install_template_roots();
        let mut source = recursive_file_inventory(&source_root);
        let mut template = recursive_file_inventory(&template_root);
        let embedded = templates::RESEARCH
            .iter()
            .map(|file| (PathBuf::from(file.path), file.contents.to_vec()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            template.keys().collect::<Vec<_>>(),
            embedded.keys().collect::<Vec<_>>(),
            "installed research files drifted from the binary inventory"
        );
        for (path, bytes) in &template {
            assert_eq!(
                Some(bytes),
                embedded.get(path),
                "embedded research bytes drifted at {}",
                path.display()
            );
        }

        let source_personas = source
            .remove(Path::new("personas/research.yaml"))
            .expect("authored research personas");
        let template_personas = template
            .remove(Path::new("personas/research.yaml"))
            .expect("installed research personas");
        source.retain(|path, _| !path.starts_with("personas/prompts"));

        assert_eq!(
            source.keys().collect::<Vec<_>>(),
            template.keys().collect::<Vec<_>>(),
            "research source/template file inventory drifted"
        );
        for (path, source_bytes) in source {
            assert_eq!(
                Some(&source_bytes),
                template.get(&path),
                "research source/template bytes drifted at {}",
                path.display()
            );
        }

        let normalize_personas = |bytes: &[u8], installed: bool| {
            let mut value: serde_json::Value =
                serde_yaml::from_slice(bytes).expect("valid research personas YAML");
            let rows = value
                .get_mut("personas")
                .and_then(serde_json::Value::as_array_mut)
                .expect("research personas array");
            for row in rows {
                let object = row.as_object_mut().expect("research persona object");
                let id = object
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .expect("research persona id")
                    .to_owned();
                if installed {
                    assert_eq!(
                        object
                            .remove("codex_agent")
                            .and_then(|value| value.as_str().map(ToOwned::to_owned)),
                        Some(id)
                    );
                } else {
                    assert_eq!(
                        object
                            .remove("prompt")
                            .and_then(|value| value.as_str().map(ToOwned::to_owned)),
                        Some(format!("personas/prompts/{id}.md"))
                    );
                }
            }
            value
        };
        assert_eq!(
            normalize_personas(&source_personas, false),
            normalize_personas(&template_personas, true),
            "authored and installed persona mappings drifted outside their intentional locator difference"
        );
    }

    #[test]
    fn research_native_agents_embed_exact_authored_persona_instructions() {
        let (source_root, _, native_root) = research_source_and_install_template_roots();
        let persona_document: serde_json::Value = serde_yaml::from_slice(
            &fs::read(source_root.join("personas/research.yaml"))
                .expect("authored research personas"),
        )
        .expect("valid authored research personas");
        let personas = persona_document["personas"]
            .as_array()
            .expect("research personas array");
        let expected_ids = personas
            .iter()
            .map(|persona| {
                persona["id"]
                    .as_str()
                    .expect("research persona id")
                    .to_owned()
            })
            .collect::<BTreeSet<_>>();
        let native = recursive_file_inventory(&native_root);
        let embedded_native = templates::RESEARCH_CODEX
            .iter()
            .map(|file| {
                let path = Path::new(file.path)
                    .strip_prefix("agents")
                    .expect("native research inventory path")
                    .to_path_buf();
                (path, file.contents.to_vec())
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            native.keys().collect::<Vec<_>>(),
            embedded_native.keys().collect::<Vec<_>>(),
            "native research files drifted from the binary inventory"
        );
        for (path, bytes) in &native {
            assert_eq!(
                Some(bytes),
                embedded_native.get(path),
                "embedded native research bytes drifted at {}",
                path.display()
            );
        }
        let native_ids = native
            .keys()
            .map(|path| {
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .expect("UTF-8 native agent filename")
                    .to_owned()
            })
            .collect::<BTreeSet<_>>();
        assert_eq!(
            native_ids, expected_ids,
            "native research agent inventory drifted"
        );

        for persona in personas {
            let id = persona["id"].as_str().expect("research persona id");
            let prompt_path = persona["prompt"]
                .as_str()
                .expect("authored persona prompt path");
            let prompt = fs::read_to_string(source_root.join(prompt_path))
                .unwrap_or_else(|error| panic!("could not read persona {id} prompt: {error}"));
            let mut prompt_lines = prompt.lines();
            if prompt_lines
                .next()
                .is_some_and(|line| line.starts_with("# "))
            {
                while prompt_lines.clone().next().is_some_and(str::is_empty) {
                    prompt_lines.next();
                }
            } else {
                prompt_lines = prompt.lines();
            }
            let instruction_body = prompt_lines.collect::<Vec<_>>().join("\n");

            let native_path = PathBuf::from(format!("{id}.toml"));
            let native_text = std::str::from_utf8(
                native
                    .get(&native_path)
                    .unwrap_or_else(|| panic!("missing native agent {}", native_path.display())),
            )
            .expect("UTF-8 native agent");
            let native_agent: toml::Value =
                toml::from_str(native_text).expect("valid native research agent TOML");
            assert_eq!(native_agent["name"].as_str(), Some(id));
            assert_eq!(
                native_agent["developer_instructions"]
                    .as_str()
                    .map(str::trim),
                Some(instruction_body.trim()),
                "native agent {id} instructions drifted from the authored persona"
            );
            for setting in ["model", "model_reasoning_effort", "sandbox_mode"] {
                assert!(
                    native_agent[setting]
                        .as_str()
                        .is_some_and(|value| !value.trim().is_empty()),
                    "native agent {id} is missing {setting}"
                );
            }
        }
    }

    #[test]
    fn agent_question_command_exposes_file_and_format_inputs() {
        let cli = Cli::try_parse_from([
            "koni",
            "--run",
            "run-1",
            "record-agent-question",
            "--root",
            "/tmp/project",
            "--input",
            "question.yaml",
            "--format",
            "yaml",
        ])
        .expect("agent question command should parse");
        assert_eq!(cli.run.as_deref(), Some("run-1"));
        let Some(Command::RecordAgentQuestion {
            root,
            input: Some(input),
            format,
        }) = cli.command
        else {
            panic!("unexpected parsed command: {:?}", cli.command);
        };
        assert_eq!(root, PathBuf::from("/tmp/project"));
        assert_eq!(input, PathBuf::from("question.yaml"));
        assert_eq!(format, QuestionInputFormat::Yaml);
    }

    #[test]
    fn agent_question_dispatch_requires_the_global_run_before_reading_stdin() {
        let cli = Cli::try_parse_from(["koni", "record-agent-question"])
            .expect("command shape should parse before dispatch validation");
        let error = dispatch(cli)
            .expect_err("agent ingress must require a selected run")
            .to_string();
        assert!(error.contains("global --run <run-id>"), "{error}");
    }

    #[test]
    fn question_parser_supports_json_yaml_and_extension_inference() {
        let json = agent_question_json("run-1", "interactive");
        let parsed = parse_question_record(&json, QuestionInputFormat::Json, "question.json")
            .expect("valid JSON question");
        assert_eq!(parsed.id, "agent-question");

        let yaml = agent_question_yaml("run-1", "interactive");
        let parsed = parse_question_record(&yaml, QuestionInputFormat::Yaml, "question.yaml")
            .expect("valid YAML question");
        assert_eq!(parsed.pause_scope.run_id(), "run-1");

        assert_eq!(
            infer_question_format(QuestionInputFormat::Auto, Some(Path::new("question.JSON"))),
            QuestionInputFormat::Json
        );
        assert_eq!(
            infer_question_format(QuestionInputFormat::Auto, Some(Path::new("question.yml"))),
            QuestionInputFormat::Yaml
        );
        assert!(
            parse_question_record("  ", QuestionInputFormat::Auto, "stdin")
                .expect_err("empty input must fail")
                .to_string()
                .contains("contains no question record")
        );
    }

    #[test]
    fn agent_question_dispatch_defers_policy_authority_to_the_pinned_run() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join("project");
        fs::create_dir(&root).expect("project directory");
        install_profile(&root, Some(BuiltinProfile::Software), None, false)
            .expect("software profile should install");
        initialize_test_repository(&root);
        let planned = Engine::plan_run(
            &root,
            Some("small"),
            "Exercise configured agent question ingress",
            "HEAD",
            None,
        )
        .expect("small run should plan");
        let pinned_policy = serde_json::to_value(planned.question_policy)
            .expect("pinned question policy serializes")
            .as_str()
            .expect("question policy serializes as a string")
            .to_owned();
        let question_path = temporary.path().join("question.json");
        fs::write(
            &question_path,
            agent_question_json(&planned.run_id, "interactive"),
        )
        .expect("question fixture");

        let cli = Cli::try_parse_from([
            OsString::from("koni"),
            OsString::from("--run"),
            OsString::from(&planned.run_id),
            OsString::from("record-agent-question"),
            OsString::from("--root"),
            root.as_os_str().to_owned(),
            OsString::from("--input"),
            question_path.as_os_str().to_owned(),
        ])
        .expect("agent ingress invocation should parse");
        let error = dispatch(cli)
            .expect_err("interactive question must not override Small's pinned policy")
            .to_string();
        assert!(
            error.contains(&format!("pins {pinned_policy}")),
            "the diagnostic must report the immutable run-pinned policy: {error}"
        );
    }

    #[test]
    fn exact_install_software_command_defaults_to_current_directory() {
        let cli = Cli::try_parse_from(["koni", "install", "software"])
            .expect("install command should parse");
        let Some(Command::Install {
            profile: Some(BuiltinProfile::Software),
            source: None,
            target,
            replace: false,
            open: false,
        }) = cli.command
        else {
            panic!("unexpected parsed command: {:?}", cli.command);
        };
        assert_eq!(target, PathBuf::from("."));
    }

    #[test]
    fn installer_requires_one_profile_source() {
        let missing = Cli::try_parse_from(["koni", "install"]);
        assert!(missing.is_err());

        let conflicting = Cli::try_parse_from(["koni", "install", "software", "--from", "custom"]);
        assert!(conflicting.is_err());
    }

    #[test]
    fn embedded_profile_inventory_matches_package_templates() {
        for profile in [BuiltinProfile::Software, BuiltinProfile::Research] {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("templates")
                .join(profile.label());
            let mut packaged = Vec::new();
            collect_relative_files(&root, &root, &mut packaged);
            packaged.sort();

            let mut embedded = profile
                .files()
                .iter()
                .map(|file| file.path.to_owned())
                .collect::<Vec<_>>();
            embedded.sort();

            assert_eq!(
                embedded,
                packaged,
                "{} template inventory drifted",
                profile.label()
            );

            let native_root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("templates/codex")
                .join(profile.label());
            let mut packaged_native = Vec::new();
            collect_relative_files(&native_root, &native_root, &mut packaged_native);
            packaged_native.sort();
            let mut embedded_native = profile
                .codex_files()
                .iter()
                .map(|file| file.path.to_owned())
                .collect::<Vec<_>>();
            embedded_native.sort();
            assert_eq!(
                embedded_native,
                packaged_native,
                "{} native Codex template inventory drifted",
                profile.label()
            );
        }

        let skills_root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("templates/codex/shared/skills");
        let mut packaged_skills = Vec::new();
        collect_relative_files(&skills_root, &skills_root, &mut packaged_skills);
        packaged_skills.sort();
        let mut embedded_skills = templates::SHARED_SKILLS
            .iter()
            .map(|file| file.path.to_owned())
            .collect::<Vec<_>>();
        embedded_skills.sort();
        assert_eq!(
            embedded_skills, packaged_skills,
            "repository skill template inventory drifted"
        );
    }

    #[test]
    fn installs_bundled_profiles_without_touching_product_state() {
        for (builtin, expected_id) in [
            (BuiltinProfile::Software, "software"),
            (BuiltinProfile::Research, "research"),
        ] {
            let temporary = tempfile::tempdir().expect("temporary directory");
            let target = temporary.path().join(expected_id);
            fs::create_dir(&target).expect("project directory");
            fs::write(target.join("PRODUCT.md"), "keep me").expect("product file");
            fs::create_dir(target.join(".codex")).expect("codex directory");
            fs::write(target.join(".codex/preferences.toml"), "theme = 'dark'")
                .expect("unrelated Codex settings");

            let installed = install_profile(&target, Some(builtin), None, false)
                .expect("bundled profile should install");

            assert_eq!(installed.profile_id, expected_id);
            assert_eq!(
                installed.destination,
                target.canonicalize().unwrap().join(".codex/koni")
            );
            assert!(installed.destination.join("project.yaml").is_file());
            assert!(installed.destination.join("profile.yaml").is_file());
            assert!(
                installed
                    .destination
                    .join(NATIVE_RESOURCE_MANIFEST)
                    .is_file()
            );
            assert!(target.join(".codex/agents/run-planner.toml").is_file());
            assert!(target.join(".codex/agents/lead.toml").is_file());
            assert!(target.join(".codex/agents/reviewer.toml").is_file());
            for skill in ["configure-koni", "model-koni-work", "operate-koni"] {
                assert!(
                    target
                        .join(".agents/skills")
                        .join(skill)
                        .join("SKILL.md")
                        .is_file(),
                    "bundled project skill {skill} should be installed"
                );
            }
            assert!(!installed.destination.join("koni.toml").exists());
            let catalog = ProjectCatalogCompiler::compile(&target)
                .expect("installed project catalog should compile");
            assert_eq!(catalog.document.default_run_type, "medium");
            let run_type_ids = catalog
                .run_types
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>();
            if expected_id == "software" {
                assert_eq!(
                    run_type_ids,
                    vec!["small", "medium", "large", "new-feature", "bug-fix"]
                );
            } else {
                assert_eq!(run_type_ids, vec!["small", "medium", "large"]);
            }
            assert_bundled_run_type_contract(&catalog, expected_id);
            assert_eq!(
                fs::read_to_string(target.join("PRODUCT.md")).expect("product file survives"),
                "keep me"
            );
            assert!(target.join(".codex/preferences.toml").is_file());
            assert!(!target.join(".git").exists());
            assert!(!target.join("program").exists());
            assert_no_install_scratch(&target.join(".codex"));

            let compiled = compile_staged_profile(&installed.destination)
                .expect("published profile should still compile");
            assert_eq!(compiled.manifest.profile.id, expected_id);
            if expected_id == "software" {
                for (workflow_id, baseline_persona, expected_writes) in [
                    ("red-green-implementation", "implementer", 0),
                    ("characterization-implementation", "implementer", 0),
                    ("current-verification-implementation", "verifier", 0),
                ] {
                    let implementation = compiled
                        .workflows
                        .get(workflow_id)
                        .expect("software profile has every proof-strategy workflow");
                    assert_eq!(
                        implementation
                            .steps
                            .iter()
                            .map(|step| step.id.as_str())
                            .collect::<Vec<_>>(),
                        ["establish-baseline", "implement", "review"],
                        "implementation stays baseline -> compiler-proved implementation -> independent review without a transcription or duplicate verification hop"
                    );
                    let baseline = implementation
                        .steps
                        .iter()
                        .find(|step| step.id == "establish-baseline")
                        .expect("proof strategy has a compiler-bound baseline step");
                    assert_eq!(baseline.persona, baseline_persona);
                    assert_eq!(baseline.read_paths.as_ref().map(Vec::len), Some(3));
                    assert_eq!(
                        baseline.write_paths.as_ref().map(Vec::len),
                        Some(expected_writes)
                    );
                    assert_eq!(baseline.checks, ["baseline-proof-set"]);
                    assert_eq!(baseline.required_receipts, ["proof_baseline_set"]);
                    let implement_step = implementation
                        .steps
                        .iter()
                        .find(|step| step.id == "implement")
                        .expect(
                            "software implementation has a compiler-proved implementation step",
                        );
                    assert_eq!(
                        implement_step.preserve_source_paths_from.as_deref(),
                        Some("establish-baseline")
                    );
                    assert_eq!(implement_step.checks, ["promotion-proof-set"]);
                    assert_eq!(implement_step.required_receipts, ["proof_set"]);
                }
                for (workflow_id, step_id, expected_fragment) in [
                    (
                        "architecture-map",
                        "map-affected-boundary",
                        "Smallest repository-grounded affected system",
                    ),
                    (
                        "change-design",
                        "plan-vertical-change",
                        "Fewest one-sentence vertical change claims",
                    ),
                    (
                        "decision-resolution",
                        "validate-approved-choice",
                        "already populated approved-seed choice",
                    ),
                    (
                        "red-green-implementation",
                        "review",
                        "Acceptance alignment, correctness, regression",
                    ),
                    (
                        "proof-execution",
                        "review",
                        "Independent proof relevance, oracle quality, freshness",
                    ),
                    (
                        "delivery-review",
                        "assemble-candidate",
                        "exact-covering the objective-local active closure",
                    ),
                ] {
                    let workflow = compiled
                        .workflows
                        .get(workflow_id)
                        .expect("bundled software workflow");
                    let step = workflow
                        .steps
                        .iter()
                        .find(|step| step.id == step_id)
                        .expect("bundled software workflow step");
                    assert!(
                        step.expected_output.contains(expected_fragment),
                        "{workflow_id}.{step_id} must contain {expected_fragment:?}, got {:?}",
                        step.expected_output
                    );
                }
                assert!(
                    compiled
                        .operations
                        .get("architecture.objective.map")
                        .expect("bundled architecture operation")
                        .output_contract
                        .contains("Do not create speculative layers")
                );
            }
            let compile_ticket = compiled
                .action("compile-ticket")
                .expect("every bundled profile routes ticket compilation through configuration");
            let check_index = compile_ticket
                .recipe
                .iter()
                .position(|step| {
                    step.primitive == "check.run"
                        && step
                            .args
                            .get("checks_from_current_step")
                            .and_then(Value::as_bool)
                            == Some(true)
                })
                .expect("compile-ticket runs the current step's configured checks");
            let compile_index = compile_ticket
                .recipe
                .iter()
                .position(|step| {
                    step.primitive == "rules.evaluate"
                        && step.args.get("mode").and_then(Value::as_str) == Some("scoped")
                })
                .expect("compile-ticket performs scoped compilation");
            assert!(
                check_index < compile_index,
                "configured runtime/static checks must run before scoped acceptance"
            );
        }
    }

    #[test]
    fn legacy_installation_migrates_with_backup_and_owned_resources() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path();
        install_profile(target, Some(BuiltinProfile::Software), None, false).unwrap();
        let current = target.join(".codex/koni");
        let legacy = target.join(".codex").join(LEGACY_PROFILE_DIRECTORY);
        fs::rename(&current, &legacy).unwrap();
        let manifest_path = legacy.join(NATIVE_RESOURCE_MANIFEST);
        let mut manifest: NativeResourceManifest =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest.owner = LEGACY_PROFILE_DIRECTORY.to_owned();
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let migrated = migrate_legacy_installation(target).expect("legacy migration succeeds");
        assert_eq!(migrated.profile_id, "software");
        assert!(!legacy.exists());
        assert!(current.join("migration-receipt.json").is_file());
        assert!(
            target
                .join(".agents/skills/configure-koni/SKILL.md")
                .is_file()
        );
        let backup_profiles = fs::read_dir(target.join(".codex/.koni-migrations"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().join("profile").is_dir())
            .count();
        assert_eq!(backup_profiles, 1);
    }

    #[test]
    fn legacy_installation_without_manifest_preserves_agents_and_adds_skills() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path();
        install_profile(target, Some(BuiltinProfile::Software), None, false).unwrap();
        let current = target.join(".codex/koni");
        fs::remove_file(current.join(NATIVE_RESOURCE_MANIFEST)).unwrap();
        fs::remove_dir_all(target.join(".agents")).unwrap();
        let legacy = target.join(".codex").join(LEGACY_PROFILE_DIRECTORY);
        fs::rename(&current, &legacy).unwrap();

        migrate_legacy_installation(target).expect("pre-manifest migration succeeds");
        assert!(target.join(".codex/agents/lead.toml").is_file());
        assert!(
            target
                .join(".agents/skills/configure-koni/SKILL.md")
                .is_file()
        );
    }

    #[test]
    fn invalid_legacy_migration_cleans_staging_and_preserves_source() {
        let temporary = tempfile::tempdir().unwrap();
        let legacy = temporary
            .path()
            .join(".codex")
            .join(LEGACY_PROFILE_DIRECTORY);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("profile.yaml"), "not: [valid").unwrap();

        migrate_legacy_installation(temporary.path())
            .expect_err("invalid legacy configuration must fail");
        assert!(legacy.join("profile.yaml").is_file());
        assert_no_install_scratch(&temporary.path().join(".codex"));
    }

    #[test]
    fn idempotent_init_verifies_owned_resources_and_rejects_profile_switches() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path();
        install_schema2_profile(target, Some(BuiltinProfile::Software), None, false).unwrap();
        initialize_project(None, None, Some(target), false, false, false)
            .expect("complete existing installation is idempotent");

        let explicit = initialize_project(
            Some(BuiltinProfile::Research),
            None,
            Some(target),
            false,
            false,
            false,
        )
        .expect_err("profile switch requires replacement");
        assert!(explicit.to_string().contains("--replace"));

        fs::remove_file(target.join(".agents/skills/configure-koni/SKILL.md")).unwrap();
        let incomplete = initialize_project(None, None, Some(target), false, false, false)
            .expect_err("missing owned skill must fail verification");
        assert!(incomplete.to_string().contains("missing"), "{incomplete:#}");
    }

    #[test]
    fn fresh_init_publishes_schema2_and_can_plan_a_new_run() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path();
        initialize_project(
            Some(BuiltinProfile::Software),
            None,
            Some(target),
            false,
            false,
            false,
        )
        .expect("fresh initialization converts the bundled profile to schema 2");

        assert!(target.join(".koni/project.yaml").is_file());
        assert!(!target.join(".codex/koni").exists());
        assert!(!target.join(".codex/agents").exists());
        let configure_skill =
            fs::read_to_string(target.join(".agents/skills/configure-koni/SKILL.md"))
                .expect("fresh schema-2 installation includes configuration guidance");
        assert!(configure_skill.contains("Prefer current schema 2 at `.koni/project.yaml`"));
        assert!(configure_skill.contains("use `.codex/koni/project.yaml` only when no `.koni`"));
        let operate_skill = fs::read_to_string(target.join(".agents/skills/operate-koni/SKILL.md"))
            .expect("fresh schema-2 installation includes operation guidance");
        assert!(operate_skill.contains("Treat current `.koni/project.yaml` as initialized"));
        assert!(operate_skill.contains("the normal schema-2 path is `.koni/profile.yaml`"));
        let catalog =
            ProjectCatalogCompiler::compile(target).expect("fresh schema-2 installation compiles");
        assert_eq!(catalog.document.schema_version, KONI_SCHEMA2_VERSION);
        assert!(
            catalog
                .run_types
                .values()
                .all(|run_type| run_type.schema_version == KONI_SCHEMA2_VERSION)
        );

        initialize_test_repository(target);
        let planned = Engine::plan_run(target, Some("small"), "Exercise direct Pi", "HEAD", None)
            .expect("a fresh schema-2 project can create a new run");
        let snapshot = koni_core::state::ConfigSnapshot::load_verified(
            &target.join(".git/koni/runs").join(&planned.run_id),
        )
        .expect("fresh run snapshot remains readable");
        assert!(snapshot.files.contains_key(Path::new(".koni/project.yaml")));
        assert!(
            snapshot
                .files
                .keys()
                .all(|path| !path.starts_with(Path::new(".codex")))
        );
    }

    #[test]
    fn init_dry_run_never_creates_project_resources() {
        let temporary = tempfile::tempdir().unwrap();
        initialize_project(
            Some(BuiltinProfile::Software),
            None,
            Some(temporary.path()),
            false,
            false,
            true,
        )
        .unwrap();
        assert!(!temporary.path().join(".codex").exists());
        assert!(!temporary.path().join(".agents").exists());
    }

    fn assert_bundled_run_type_contract(
        catalog: &koni_core::CompiledProjectCatalog,
        profile_id: &str,
    ) {
        let expectations = [
            (
                "small",
                "Small",
                0,
                1,
                "autonomous",
                vec!["intake", "approval", "initialize", "orchestrate", "report"],
            ),
            (
                "medium",
                "Medium",
                1,
                3,
                "high_impact_only",
                vec![
                    "intake",
                    "combined-plan",
                    "approval",
                    "initialize",
                    "orchestrate",
                    "verification",
                    "report",
                ],
            ),
            (
                "large",
                "Large",
                3,
                5,
                "interactive",
                vec![
                    "intake",
                    "architecture-plan",
                    "risk-plan",
                    "verification-plan",
                    "approval",
                    "initialize",
                    "orchestrate",
                    "independent-review",
                    "verification",
                    "report",
                ],
            ),
        ];
        for (id, title, planning_passes, parallelism, question_policy, order) in expectations {
            let (
                planner_model,
                planner_effort,
                lead_model,
                lead_effort,
                worker_model,
                worker_effort,
                reviewer_model,
                reviewer_effort,
            ) = match (profile_id, id) {
                ("software", "small") => (
                    "gpt-5.6-terra",
                    "xhigh",
                    "gpt-5.6-terra",
                    "high",
                    "gpt-5.6-luna",
                    "medium",
                    "gpt-5.6-terra",
                    "max",
                ),
                ("software", "medium") => (
                    "gpt-5.6-sol",
                    "max",
                    "gpt-5.6-sol",
                    "xhigh",
                    "gpt-5.6-terra",
                    "high",
                    "gpt-5.6-sol",
                    "max",
                ),
                ("software", "large") => (
                    "gpt-5.6-sol",
                    "ultra",
                    "gpt-5.6-sol",
                    "ultra",
                    "gpt-5.6-sol",
                    "xhigh",
                    "gpt-5.6-sol",
                    "ultra",
                ),
                ("research", "small") => (
                    "gpt-5.6-terra",
                    "high",
                    "gpt-5.4-mini",
                    "low",
                    "gpt-5.6-terra",
                    "high",
                    "gpt-5.6-terra",
                    "high",
                ),
                ("research", "medium") => (
                    "gpt-5.6-sol",
                    "xhigh",
                    "gpt-5.4-mini",
                    "low",
                    "gpt-5.6-terra",
                    "high",
                    "gpt-5.6-terra",
                    "xhigh",
                ),
                ("research", "large") => (
                    "gpt-5.6-sol",
                    "ultra",
                    "gpt-5.4-mini",
                    "low",
                    "gpt-5.6-terra",
                    "xhigh",
                    "gpt-5.6-sol",
                    "ultra",
                ),
                _ => panic!("unexpected bundled profile/run type {profile_id}/{id}"),
            };
            let run_type = catalog.run_type(id).expect("bundled run type");
            assert_eq!(run_type.title, title);
            let expected_question_policy = if profile_id == "software" && id == "small" {
                "high_impact_only"
            } else {
                question_policy
            };
            assert_eq!(
                serde_json::to_value(run_type.questions.policy)
                    .expect("question policy serializes")
                    .as_str(),
                Some(expected_question_policy)
            );
            let expected_planning_passes = if profile_id == "software" && id == "small" {
                1
            } else {
                planning_passes
            };
            assert_eq!(
                run_type
                    .pipeline
                    .stages
                    .values()
                    .filter(|stage| stage.kind == "planning")
                    .count(),
                expected_planning_passes
            );
            let mut expected_order = order.into_iter().map(str::to_owned).collect::<Vec<_>>();
            if profile_id == "software" && id == "small" {
                expected_order.insert(1, "focused-plan".to_owned());
            }
            if profile_id == "software" && id == "large" {
                let review = expected_order
                    .iter()
                    .position(|stage| stage == "independent-review")
                    .expect("large Software run has an independent review");
                let verification = expected_order
                    .iter()
                    .position(|stage| stage == "verification")
                    .expect("large Software run has a composed verification");
                expected_order.swap(review, verification);
            }
            let target_sync_index = expected_order
                .iter()
                .position(|stage| stage == "orchestrate")
                .expect("bundled workflow orchestrates before target sync")
                + 1;
            expected_order.insert(target_sync_index, "target-sync".to_owned());
            if id == "small" {
                expected_order.insert(target_sync_index + 1, "verification".to_owned());
            }
            expected_order.push("promotion".to_owned());
            assert_eq!(run_type.pipeline.order, expected_order);
            let boundary_positions =
                ["target-sync", "verification", "promotion"].map(|boundary_id| {
                    let matching = run_type
                        .pipeline
                        .order
                        .iter()
                        .enumerate()
                        .filter(|(_, stage)| stage.as_str() == boundary_id)
                        .map(|(index, _)| index)
                        .collect::<Vec<_>>();
                    assert_eq!(
                        matching.len(),
                        1,
                        "{profile_id}/{id} must contain one {boundary_id}"
                    );
                    matching[0]
                });
            assert!(
                boundary_positions[0] < boundary_positions[1]
                    && boundary_positions[1] < boundary_positions[2],
                "{profile_id}/{id} must order target sync before verification before promotion"
            );
            let orchestration = run_type
                .orchestration
                .as_ref()
                .expect("bundled orchestration policy");
            assert!(orchestration.auto_start);
            assert_eq!(orchestration.max_parallel, Some(parallelism));
            for (role, model, effort) in [
                ("planner", planner_model, planner_effort),
                ("lead", lead_model, lead_effort),
            ] {
                let policy = run_type
                    .agents
                    .as_ref()
                    .and_then(|agents| agents.roles.get(role))
                    .expect("bundled planning/lead policy");
                assert_eq!(policy.model.as_deref(), Some(model));
                assert_eq!(policy.reasoning_effort.as_deref(), Some(effort));
            }
            for (role, model, effort) in [
                ("ticket_worker", worker_model, worker_effort),
                ("reviewer", reviewer_model, reviewer_effort),
            ] {
                let policy = run_type
                    .agents
                    .as_ref()
                    .and_then(|agents| agents.roles.get(role))
                    .expect("bundled role policy");
                assert_eq!(policy.model.as_deref(), Some(model));
                assert_eq!(policy.reasoning_effort.as_deref(), Some(effort));
            }
        }

        if profile_id == "software" {
            for (id, limit, reserve) in [
                ("small", 120_000, 30_000),
                ("medium", 240_000, 60_000),
                ("large", 480_000, 120_000),
            ] {
                let budget = &catalog
                    .run_type(id)
                    .expect("Software complexity run type")
                    .planning
                    .as_ref()
                    .expect("Software planning policy")
                    .token_budget;
                assert_eq!(budget.limit, limit, "{id} planning ceiling");
                assert_eq!(budget.synthesis_reserve, reserve, "{id} synthesis reserve");
            }
            let medium = catalog
                .run_type("medium")
                .expect("Software Medium run type");
            for (id, title, expected_intake, max_parallel, intent_marker) in [
                (
                    "new-feature",
                    "New Feature",
                    vec!["goal", "acceptance_examples", "non_goals"],
                    3,
                    "new_feature",
                ),
                (
                    "bug-fix",
                    "Bug Fix",
                    vec![
                        "goal",
                        "expected_behavior",
                        "observed_behavior",
                        "reproduction_signal",
                    ],
                    1,
                    "bug_fix",
                ),
            ] {
                let run_type = catalog.run_type(id).expect("Software intent run type");
                assert_eq!(run_type.title, title);
                assert_eq!(run_type.extends.as_deref(), Some("medium"));
                assert_eq!(run_type.ancestry, ["medium"]);
                assert_eq!(run_type.pipeline.order, medium.pipeline.order);
                assert_eq!(
                    run_type
                        .planning
                        .as_ref()
                        .map(|planning| &planning.token_budget),
                    medium
                        .planning
                        .as_ref()
                        .map(|planning| &planning.token_budget),
                    "{id} inherits Medium's planning ceiling"
                );
                assert_eq!(
                    run_type
                        .planning
                        .as_ref()
                        .and_then(|planning| planning.graph_seed_stage.as_deref()),
                    Some("combined-plan")
                );
                assert_eq!(
                    run_type
                        .intake
                        .order
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>(),
                    expected_intake
                );
                assert!(run_type.instructions.planning.contains(intent_marker));
                assert_eq!(
                    run_type
                        .orchestration
                        .as_ref()
                        .and_then(|policy| policy.max_parallel),
                    Some(max_parallel)
                );
                if id == "bug-fix" {
                    assert!(
                        run_type
                            .instructions
                            .planning
                            .contains("exactly one focused diagnostic proof")
                    );
                    assert!(
                        run_type
                            .instructions
                            .planning
                            .contains("do not speculate a repair")
                    );
                    assert!(
                        !run_type
                            .instructions
                            .planning
                            .contains("localization_status")
                    );
                    let combined_prompt = run_type
                        .pipeline
                        .stages
                        .get("combined-plan")
                        .and_then(|stage| stage.config.as_ref())
                        .and_then(|config| config.get("prompt"))
                        .and_then(serde_json::Value::as_str)
                        .expect("resolved Bug Fix keeps its causal combined-plan prompt");
                    assert!(combined_prompt.contains("exactly one focused diagnostic proof"));
                    assert!(combined_prompt.contains("Do not seed a speculative change"));
                    assert!(!combined_prompt.contains("localization_status"));
                }
                for boundary in ["target-sync", "verification", "promotion"] {
                    assert_eq!(
                        run_type
                            .pipeline
                            .order
                            .iter()
                            .filter(|stage| stage.as_str() == boundary)
                            .count(),
                        1,
                        "{id} must inherit exactly one {boundary} stage"
                    );
                }
            }
        }
    }

    #[test]
    fn collision_refuses_by_default_and_replace_preserves_other_codex_files() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let target = temporary.path();
        fs::create_dir(target.join(".codex")).expect("codex directory");
        fs::write(target.join(".codex/AGENTS.md"), "project instructions")
            .expect("unrelated Codex file");
        install_profile(target, Some(BuiltinProfile::Software), None, false)
            .expect("initial install");
        let original =
            fs::read_to_string(target.join(".codex/koni/project.yaml")).expect("installed catalog");

        let error = install_profile(target, Some(BuiltinProfile::Research), None, false)
            .expect_err("collision should be refused");
        assert!(error.to_string().contains("--replace"));
        assert_eq!(
            fs::read_to_string(target.join(".codex/koni/project.yaml"))
                .expect("original catalog survives"),
            original
        );

        let replaced = install_profile(target, Some(BuiltinProfile::Research), None, true)
            .expect("explicit replacement");
        assert_eq!(replaced.profile_id, "research");
        assert_eq!(
            fs::read_to_string(target.join(".codex/AGENTS.md"))
                .expect("unrelated Codex file survives"),
            "project instructions"
        );
        assert_no_install_scratch(&target.join(".codex"));
    }

    #[test]
    fn installer_never_overwrites_an_unowned_or_modified_native_agent() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let unowned = temporary.path().join("unowned");
        fs::create_dir_all(unowned.join(".codex/agents")).unwrap();
        let unowned_agent = unowned.join(".codex/agents/run-planner.toml");
        fs::write(&unowned_agent, "name = 'my-run-planner'\n").unwrap();
        let error = install_profile(&unowned, Some(BuiltinProfile::Software), None, true)
            .expect_err("--replace must not claim an unrelated agent");
        assert!(error.to_string().contains("is not owned"), "{error:#}");
        assert_eq!(
            fs::read_to_string(&unowned_agent).unwrap(),
            "name = 'my-run-planner'\n"
        );
        assert!(!unowned.join(".codex/koni").exists());
        assert_no_install_scratch(&unowned.join(".codex"));

        let modified = temporary.path().join("modified");
        fs::create_dir(&modified).unwrap();
        install_profile(&modified, Some(BuiltinProfile::Software), None, false).unwrap();
        let lead = modified.join(".codex/agents/lead.toml");
        fs::write(&lead, "name = 'locally-customized-lead'\n").unwrap();
        let original_catalog =
            fs::read_to_string(modified.join(".codex/koni/project.yaml")).unwrap();
        let error = install_profile(&modified, Some(BuiltinProfile::Research), None, true)
            .expect_err("modified owned agent must not be overwritten");
        assert!(error.to_string().contains("was modified"), "{error:#}");
        assert_eq!(
            fs::read_to_string(&lead).unwrap(),
            "name = 'locally-customized-lead'\n"
        );
        assert_eq!(
            fs::read_to_string(modified.join(".codex/koni/project.yaml")).unwrap(),
            original_catalog
        );
        assert_no_install_scratch(&modified.join(".codex"));
    }

    #[test]
    fn replace_retires_only_unchanged_agents_owned_by_the_prior_install() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let target = temporary.path();
        install_profile(target, Some(BuiltinProfile::Software), None, false).unwrap();
        let preserved_modified = target.join(".codex/agents/architecture-mapper.toml");
        let customized_agent = format!(
            "{}\ncustom_marker = \"preserve-me\"\n",
            fs::read_to_string(&preserved_modified).unwrap()
        );
        fs::write(&preserved_modified, &customized_agent).unwrap();
        let unrelated = target.join(".codex/agents/my-company-agent.toml");
        fs::write(
            &unrelated,
            r#"name = "my-company-agent"
description = "A valid project-local agent that is not managed by Koni."
developer_instructions = "Follow the project owner's instructions."
sandbox_mode = "read-only"
"#,
        )
        .unwrap();

        install_profile(target, Some(BuiltinProfile::Research), None, true).unwrap();

        assert!(preserved_modified.is_file());
        assert_eq!(
            fs::read_to_string(&preserved_modified).unwrap(),
            customized_agent
        );
        assert!(unrelated.is_file());
        assert!(!target.join(".codex/agents/change-designer.toml").exists());
        assert!(!target.join(".codex/agents/contract-designer.toml").exists());
        assert!(target.join(".codex/agents/research-scout.toml").is_file());
        let manifest: NativeResourceManifest = serde_json::from_slice(
            &fs::read(target.join(".codex/koni").join(NATIVE_RESOURCE_MANIFEST)).unwrap(),
        )
        .unwrap();
        assert!(
            manifest
                .resources
                .iter()
                .all(|resource| resource.path != ".codex/agents/change-designer.toml")
        );
        assert_no_install_scratch(&target.join(".codex"));
    }

    #[test]
    fn invalid_custom_profile_is_never_published() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let target = temporary.path().join("project");
        let source = temporary.path().join("broken-profile");
        fs::create_dir(&target).expect("project directory");
        fs::create_dir(&source).expect("profile source");
        fs::write(source.join("koni.toml"), "this is not toml = [").expect("invalid profile");

        let error = install_profile(&target, None, Some(&source), false)
            .expect_err("invalid custom profile should fail");
        assert!(error.to_string().contains("profile validation failed"));
        assert!(!target.join(".codex/koni").exists());
        if target.join(".codex").exists() {
            assert_no_install_scratch(&target.join(".codex"));
        }
    }

    #[test]
    fn installer_validates_the_final_merge_with_existing_codex_resources() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path();
        fs::create_dir(target.join(".codex")).unwrap();
        fs::write(
            target.join(".codex/config.toml"),
            "[mcp_servers.koni_runtime]\ncommand = 'untrusted'\n",
        )
        .unwrap();

        let error = install_profile(target, Some(BuiltinProfile::Software), None, false)
            .expect_err("reserved MCP collision must fail staged validation");
        assert!(
            error.to_string().contains("profile validation failed"),
            "{error:#}"
        );
        assert!(!target.join(".codex/koni").exists());
        assert!(!target.join(".agents").exists());
    }

    #[test]
    fn installs_custom_profile_from_a_project_shaped_source() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let source = temporary.path().join("source-project");
        let target = temporary.path().join("target-project");
        fs::create_dir_all(source.join(".codex/koni")).expect("source profile directory");
        fs::create_dir(&target).expect("target project");
        write_embedded_profile(&source.join(".codex/koni"), BuiltinProfile::Research)
            .expect("source profile");
        write_embedded_files(
            &source.join(".codex"),
            BuiltinProfile::Research.codex_files(),
        )
        .expect("source native agents");

        let installed = install_profile(&target, None, Some(&source), false)
            .expect("custom profile should install");

        assert_eq!(installed.profile_id, "research");
        assert!(target.join(".codex/agents/lead.toml").is_file());
        assert_no_install_scratch(&target.join(".codex"));

        let codex_target = temporary.path().join("target-from-codex");
        fs::create_dir(&codex_target).expect("second target project");
        let installed = install_profile(&codex_target, None, Some(&source.join(".codex")), false)
            .expect("a .codex source should resolve its koni child");
        assert_eq!(installed.profile_id, "research");
        assert!(codex_target.join(".codex/koni/project.yaml").is_file());
    }

    #[test]
    fn custom_agent_resolution_uses_internal_name_and_allows_optional_policy_fields() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source");
        let target = temporary.path().join("target");
        fs::create_dir_all(source.join(".codex/koni")).unwrap();
        fs::create_dir(&target).unwrap();
        write_embedded_profile(&source.join(".codex/koni"), BuiltinProfile::Software).unwrap();
        write_embedded_files(
            &source.join(".codex"),
            BuiltinProfile::Software.codex_files(),
        )
        .unwrap();
        let original = source.join(".codex/agents/lead.toml");
        let renamed = source.join(".codex/agents/team-captain.toml");
        let contents = fs::read_to_string(&original)
            .unwrap()
            .lines()
            .filter(|line| {
                !line.starts_with("model =")
                    && !line.starts_with("model_reasoning_effort =")
                    && !line.starts_with("sandbox_mode =")
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&renamed, format!("{contents}\n")).unwrap();
        fs::remove_file(original).unwrap();

        install_profile(&target, None, Some(&source), false)
            .expect("agent should resolve by internal name");
        assert!(target.join(".codex/agents/team-captain.toml").is_file());
        assert!(!target.join(".codex/agents/lead.toml").exists());
    }

    #[test]
    fn canonical_custom_install_validates_every_run_type_before_publish() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let source = temporary.path().join("source-project");
        let config = source.join(".codex/koni");
        let target = temporary.path().join("target-project");
        fs::create_dir_all(config.join("run-types")).unwrap();
        fs::create_dir_all(config.join("profiles")).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(
            config.join("project.yaml"),
            r#"schema_version: "1.0"
project: {id: install-catalog, title: Install catalog}
default_run_type: good
run_types:
  - {id: good, path: run-types/good.yaml}
  - {id: bad, path: run-types/bad.yaml}
"#,
        )
        .unwrap();
        fs::write(
            config.join("run-types/good.yaml"),
            canonical_run_type("good"),
        )
        .unwrap();
        fs::write(
            config.join("run-types/bad.yaml"),
            canonical_run_type("bad").replace(
                "plan: {kind: planning, title: Plan}",
                "plan: {kind: planning, title: Plan, config: {persona: missing}}",
            ),
        )
        .unwrap();
        fs::write(
            config.join("profiles/nodes.yaml"),
            "node_types:\n  - id: task\n    stage: work\n    statuses: [active, complete]\n",
        )
        .unwrap();
        fs::write(
            config.join("profile.yaml"),
            canonical_profile("good", "profiles/nodes.yaml"),
        )
        .unwrap();

        let error = install_profile(&target, None, Some(&source), false)
            .expect_err("an invalid secondary run type must block publication");
        assert!(error.to_string().contains("profile validation failed"));
        assert!(!target.join(".codex/koni").exists());

        fs::write(config.join("run-types/bad.yaml"), canonical_run_type("bad")).unwrap();
        let installed = install_profile(&target, None, Some(&source), false)
            .expect("the complete catalog should install");
        assert_eq!(installed.profile_id, "good");
    }

    #[cfg(unix)]
    #[test]
    fn installer_rejects_symlink_targets_destinations_and_source_entries() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let real_target = temporary.path().join("real-target");
        let linked_target = temporary.path().join("linked-target");
        fs::create_dir(&real_target).unwrap();
        symlink(&real_target, &linked_target).unwrap();
        assert!(
            install_profile(&linked_target, Some(BuiltinProfile::Software), None, false).is_err()
        );

        fs::create_dir(real_target.join(".codex")).unwrap();
        let outside = temporary.path().join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, real_target.join(".codex/koni")).unwrap();
        assert!(install_profile(&real_target, Some(BuiltinProfile::Software), None, true).is_err());
        fs::remove_file(real_target.join(".codex/koni")).unwrap();

        let source = temporary.path().join("source");
        fs::create_dir(&source).unwrap();
        write_embedded_profile(&source, BuiltinProfile::Software).unwrap();
        fs::write(temporary.path().join("outside-file"), "outside").unwrap();
        symlink(
            temporary.path().join("outside-file"),
            source.join("linked-file"),
        )
        .unwrap();
        assert!(install_profile(&real_target, None, Some(&source), false).is_err());
        assert!(!real_target.join(".codex/koni").exists());
    }

    fn write_init_project_test_profile(root: &Path) {
        fs::create_dir_all(root).unwrap();
        fs::write(
            root.join("profile.yaml"),
            r#"schema_version: "1.0"
engine: ">=0.1,<0.2"
profile:
  id: init-project-test
  version: 1.0.0
  description: Self-contained init-project safety fixture
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
git:
  enabled: true
  integration_branch: current
imports:
  graph: [graph.yaml]
"#,
        )
        .unwrap();
        fs::write(
            root.join("graph.yaml"),
            r#"schema_version: "1.0"
node_types:
  - id: objective
    description: Root objective for the init-project safety fixture.
    stage: framing
    required_any: [[goal]]
    statuses: [active]
    semantic_fields: [goal]
    fields:
      goal: {type: string, required: true}
"#,
        )
        .unwrap();
    }

    fn snapshot_test_tree(root: &Path) -> Vec<(PathBuf, &'static str, Vec<u8>)> {
        let mut snapshot = WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .map(|entry| {
                let entry = entry.expect("snapshot entry");
                let path = entry.path();
                let relative = path.strip_prefix(root).unwrap().to_path_buf();
                let file_type = entry.file_type();
                if file_type.is_file() {
                    (relative, "file", fs::read(path).expect("snapshot file"))
                } else if file_type.is_symlink() {
                    (
                        relative,
                        "symlink",
                        fs::read_link(path)
                            .expect("snapshot symlink")
                            .to_string_lossy()
                            .into_owned()
                            .into_bytes(),
                    )
                } else {
                    (relative, "directory", Vec::new())
                }
            })
            .collect::<Vec<_>>();
        snapshot.sort_by(|left, right| left.0.cmp(&right.0));
        snapshot
    }

    fn assert_no_install_scratch(codex_dir: &Path) {
        let scratch = fs::read_dir(codex_dir)
            .expect("Codex directory")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| {
                name.starts_with(".koni-install-")
                    || name.starts_with(".koni-backup-")
                    || name.starts_with(".koni-migration-")
            })
            .collect::<Vec<_>>();
        assert!(
            scratch.is_empty(),
            "installer left scratch entries: {scratch:?}"
        );
    }

    fn collect_relative_files(root: &Path, current: &Path, output: &mut Vec<String>) {
        for entry in fs::read_dir(current).expect("template directory") {
            let entry = entry.expect("template entry");
            let path = entry.path();
            if entry.file_type().expect("template file type").is_dir() {
                collect_relative_files(root, &path, output);
            } else {
                output.push(
                    path.strip_prefix(root)
                        .expect("contained template path")
                        .to_string_lossy()
                        .replace(std::path::MAIN_SEPARATOR, "/"),
                );
            }
        }
    }

    fn canonical_run_type(id: &str) -> String {
        format!(
            r#"schema_version: "1.0"
id: {id}
title: {id} run
profile:
  source: .codex/koni/profile.yaml
intake:
  fields:
    goal: {{label: Goal, type: text, required: true}}
  order: [goal]
pipeline:
  stages:
    plan: {{kind: planning, title: Plan}}
  order: [plan]
questions: {{policy: interactive, default_scope: run}}
git:
  branch_template: koni/runs/{{{{ run.id }}}}
  ticket_branch_template: koni/runs/{{{{ run.id }}}}/tickets/{{{{ ticket.id }}}}
run_card: {{sections: [goal, plan]}}
"#
        )
    }

    fn canonical_profile(id: &str, graph: &str) -> String {
        format!(
            r#"schema_version: "1.0"
engine: ">=0.1,<0.2"
profile: {{id: {id}, version: 1.0.0, description: {id} profile}}
imports:
  graph: [{graph}]
"#
        )
    }

    fn initialize_test_repository(root: &Path) {
        let repository = Repository::init(root).expect("initialize test repository");
        repository
            .set_head("refs/heads/main")
            .expect("select test main branch");
        let mut index = repository.index().expect("open test index");
        index
            .add_all(["*"], IndexAddOption::DEFAULT, None)
            .expect("stage test project");
        let tree_id = index.write_tree().expect("write test tree");
        index.write().expect("write test index");
        let tree = repository.find_tree(tree_id).expect("find test tree");
        let signature =
            Signature::now("Koni Test", "koni-test@example.local").expect("test signature");
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "initial Koni test project\n",
                &tree,
                &[],
            )
            .expect("commit test project");
    }

    fn agent_question_json(run_id: &str, policy: &str) -> String {
        serde_json::to_string_pretty(&json!({
            "schema_version": "1.0",
            "id": "agent-question",
            "prompt": "Should Koni continue with the proposed implementation?",
            "context": "The configured agent reached a decision boundary.",
            "options": [
                {
                    "id": "continue",
                    "label": "Continue",
                    "description": "Proceed with the bounded implementation.",
                    "recommended": true
                },
                {
                    "id": "stop",
                    "label": "Stop",
                    "description": "Keep the run paused for operator review.",
                    "recommended": false
                }
            ],
            "allow_custom_answer": false,
            "pause_scope": {"kind": "run", "run_id": run_id},
            "policy": policy,
            "impact": "high",
            "auto_resolution": null,
            "session_resume": {
                "session_id": "agent-session-1",
                "agent_id": "configured-agent",
                "turn_id": "turn-1",
                "working_directory": null,
                "context_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                "captured_at": "2026-01-01T00:00:00Z"
            },
            "status": "open",
            "answer": null,
            "cancellation_reason": null,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }))
        .expect("question JSON")
    }

    fn agent_question_yaml(run_id: &str, policy: &str) -> String {
        format!(
            r#"schema_version: "1.0"
id: agent-question
prompt: Should Koni continue with the proposed implementation?
context: The configured agent reached a decision boundary.
options:
  - id: continue
    label: Continue
    description: Proceed with the bounded implementation.
    recommended: true
  - id: stop
    label: Stop
    description: Keep the run paused for operator review.
    recommended: false
allow_custom_answer: false
pause_scope:
  kind: run
  run_id: {run_id}
policy: {policy}
impact: high
auto_resolution: null
session_resume:
  session_id: agent-session-1
  agent_id: configured-agent
  turn_id: turn-1
  working_directory: null
  context_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  captured_at: 2026-01-01T00:00:00Z
status: open
answer: null
cancellation_reason: null
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
"#
        )
    }
}
