//! Durable compiler-owned control-plane state for one run.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use crate::agent::AgentProcessIdentity;
use crate::error::{KoniError, Result, io_error};
use crate::external_loop::{ExternalLoopConfig, ExternalLoopState, ExternalRepairRequest};
use crate::graph::atomic_write_yaml;
use crate::persistent_lock::{LockMode, PersistentFileLock};
use crate::pipeline::RunPipeline;
use crate::questions::{QuestionAnswerSource, QuestionRecord, QuestionStatus};

#[derive(Debug, Clone)]
pub struct RunControlStore {
    root: PathBuf,
}

pub struct RunControlLock {
    _lock: PersistentFileLock,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResumeDirective {
    pub question_id: String,
    pub session_id: String,
    pub working_directory: Option<PathBuf>,
    pub prompt: String,
    pub context_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSessionRecord {
    pub schema_version: String,
    pub id: String,
    pub run_id: String,
    #[serde(default)]
    pub ticket_id: Option<String>,
    #[serde(default)]
    pub stage_id: Option<String>,
    pub persona: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    pub status: String,
    #[serde(default)]
    pub attempt: u32,
    #[serde(default)]
    pub codex_session_id: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub process_identity: Option<AgentProcessIdentity>,
    #[serde(default)]
    pub working_directory: Option<PathBuf>,
    #[serde(default)]
    pub prompt_path: Option<PathBuf>,
    #[serde(default)]
    pub stdout_path: Option<PathBuf>,
    #[serde(default)]
    pub stderr_path: Option<PathBuf>,
    #[serde(default)]
    pub output_path: Option<PathBuf>,
    #[serde(default)]
    pub output_hash: Option<String>,
    #[serde(default)]
    pub input_hash: Option<String>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default)]
    pub started_at: Option<chrono::DateTime<Utc>>,
    #[serde(default)]
    pub finished_at: Option<chrono::DateTime<Utc>>,
    pub updated_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrchestrationState {
    pub schema_version: String,
    pub running: bool,
    pub max_parallel: usize,
    #[serde(default)]
    pub unchained: bool,
    pub updated_at: chrono::DateTime<Utc>,
}

/// The compiler-selected unit of broker work for one fresh Lead process.
/// Ticket identifiers are durable routing keys; process/generation details
/// stay in [`LeadSliceState`] and are never needed by the TUI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LeadSliceBoundary {
    DispatchBatch { tickets: Vec<String> },
    WaitWorkers { tickets: Vec<String> },
    Recover,
    SpawnWorker { ticket: String },
    Review { ticket: String },
    Finish { ticket: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LeadSliceStatus {
    Spawning,
    Active,
    Yielded,
}

/// Compiler-owned lease for a bounded Lead turn. The bearer token itself is
/// injected only into the owned process environment; durable state retains a
/// one-way hash and additionally binds ingress to the process identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeadSliceState {
    pub schema_version: String,
    pub run_id: String,
    pub stage_id: String,
    pub pipeline_attempt: u32,
    pub input_hash: String,
    pub generation: u64,
    pub token_hash: String,
    pub status: LeadSliceStatus,
    pub boundary: LeadSliceBoundary,
    pub max_boundaries: usize,
    #[serde(default)]
    pub boundaries_completed: usize,
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default)]
    pub process_identity: Option<AgentProcessIdentity>,
    #[serde(default)]
    pub raw_agent_id: Option<String>,
    #[serde(default)]
    pub yield_reason: Option<String>,
    pub started_at: chrono::DateTime<Utc>,
    pub updated_at: chrono::DateTime<Utc>,
}

impl LeadSliceState {
    pub fn validate(&self) -> Result<()> {
        validate_id(&self.run_id)?;
        validate_id(&self.stage_id)?;
        if self.schema_version != "1.0"
            || self.pipeline_attempt == 0
            || self.generation == 0
            || self.token_hash.trim().is_empty()
            || self.max_boundaries == 0
            || self.boundaries_completed > self.max_boundaries
            || self.updated_at < self.started_at
        {
            return Err(KoniError::Workflow(
                "invalid compiler-owned Lead slice state".to_owned(),
            ));
        }
        for ticket in self.boundary.tickets() {
            validate_id(ticket)?;
        }
        if let Some(raw_agent_id) = &self.raw_agent_id {
            validate_id(raw_agent_id)?;
        }
        if let Some(identity) = &self.process_identity
            && (identity.pid != identity.process_group_id
                || identity.birth_marker.trim().is_empty())
        {
            return Err(KoniError::Workflow(
                "Lead slice has an invalid owned process identity".to_owned(),
            ));
        }
        Ok(())
    }
}

impl LeadSliceBoundary {
    pub fn tickets(&self) -> Vec<&str> {
        match self {
            Self::DispatchBatch { tickets } | Self::WaitWorkers { tickets } => {
                tickets.iter().map(String::as_str).collect()
            }
            Self::SpawnWorker { ticket } | Self::Review { ticket } | Self::Finish { ticket } => {
                vec![ticket]
            }
            Self::Recover => Vec::new(),
        }
    }
}

/// Operator-owned lifecycle intent for work that exists before orchestration
/// (most importantly the detached planning pass).  This is deliberately kept
/// outside the immutable run manifest so pausing never changes pinned inputs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunLifecycleState {
    pub schema_version: String,
    pub running: bool,
    #[serde(default)]
    pub pause_requested_at: Option<chrono::DateTime<Utc>>,
    pub updated_at: chrono::DateTime<Utc>,
}

impl RunLifecycleState {
    pub fn running() -> Self {
        Self {
            schema_version: "1.0".to_owned(),
            running: true,
            pause_requested_at: None,
            updated_at: Utc::now(),
        }
    }

    pub fn set_running(&mut self, running: bool) {
        let now = Utc::now();
        self.running = running;
        self.pause_requested_at = (!running).then_some(now);
        self.updated_at = now;
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != "1.0" || (self.running && self.pause_requested_at.is_some()) {
            return Err(KoniError::Workflow(
                "invalid run lifecycle state".to_owned(),
            ));
        }
        Ok(())
    }
}

impl OrchestrationState {
    pub fn new(running: bool, max_parallel: usize) -> Result<Self> {
        if max_parallel == 0 {
            return Err(KoniError::Workflow(
                "orchestration max_parallel must be positive".to_owned(),
            ));
        }
        Ok(Self {
            schema_version: "1.0".to_owned(),
            running,
            max_parallel,
            unchained: false,
            updated_at: Utc::now(),
        })
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != "1.0" || self.max_parallel == 0 {
            return Err(KoniError::Workflow(
                "invalid orchestration state".to_owned(),
            ));
        }
        Ok(())
    }
}

impl RunControlStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn lock(&self, name: &str) -> Result<RunControlLock> {
        validate_id(name)?;
        let root_metadata = fs::symlink_metadata(&self.root).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                KoniError::Action(format!(
                    "run control root disappeared before lock acquisition: {}",
                    self.root.display()
                ))
            } else {
                io_error(&self.root, error)
            }
        })?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err(KoniError::Action(format!(
                "run control root is redirected: {}",
                self.root.display()
            )));
        }
        let canonical_root = self
            .root
            .canonicalize()
            .map_err(|error| io_error(&self.root, error))?;
        let run_id = canonical_root
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| KoniError::Action("run control root has no valid run ID".to_owned()))?;
        validate_id(run_id)?;
        let runs = canonical_root.parent().ok_or_else(|| {
            KoniError::Action("run control root has no runs directory".to_owned())
        })?;
        if runs.file_name().and_then(|value| value.to_str()) != Some("runs") {
            return Err(KoniError::Action(format!(
                "run control locks require a Git-common Koni run root: {}",
                self.root.display()
            )));
        }
        let sidecar = runs.parent().ok_or_else(|| {
            KoniError::Action("run control root has no sidecar directory".to_owned())
        })?;
        if sidecar.file_name().and_then(|value| value.to_str()) != Some("koni") {
            return Err(KoniError::Action(format!(
                "run control locks require the exact Koni sidecar: {}",
                self.root.display()
            )));
        }
        let common_dir = sidecar.parent().ok_or_else(|| {
            KoniError::Action("Koni sidecar has no Git common directory".to_owned())
        })?;
        if common_dir
            .canonicalize()
            .map_err(|error| io_error(common_dir, error))?
            != common_dir
        {
            return Err(KoniError::Action(format!(
                "Git common directory is noncanonical: {}",
                common_dir.display()
            )));
        }
        let relative = PathBuf::from("koni/locks/run-control")
            .join(run_id)
            .join(format!("{name}.lock"));
        let path = common_dir.join(&relative);
        let lock = match PersistentFileLock::acquire(common_dir, &relative, LockMode::Try) {
            Ok(lock) => lock,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return Err(KoniError::Action(format!(
                    "run control lock {name} is held: {error}"
                )));
            }
            Err(error) => {
                return Err(KoniError::Action(format!(
                    "run control lock path is redirected or invalid at {}: {error}",
                    path.display()
                )));
            }
        };
        let current_metadata = fs::symlink_metadata(&self.root).map_err(|error| {
            KoniError::Action(format!(
                "run control root disappeared while acquiring {name}: {error}"
            ))
        })?;
        if current_metadata.file_type().is_symlink()
            || !current_metadata.is_dir()
            || self.root.canonicalize().ok().as_deref() != Some(canonical_root.as_path())
            || !same_control_root_identity(&root_metadata, &current_metadata)
        {
            return Err(KoniError::Action(format!(
                "run control root changed while acquiring {name}: {}",
                self.root.display()
            )));
        }
        Ok(RunControlLock { _lock: lock })
    }

    pub fn ensure_layout(&self) -> Result<()> {
        for directory in [
            self.root.join("questions"),
            self.root.join("agents"),
            self.root.join("external-loops"),
            self.root.join("reports"),
            self.root.join("planning"),
            self.root.join("lead-slices"),
        ] {
            fs::create_dir_all(&directory).map_err(|error| io_error(&directory, error))?;
        }
        Ok(())
    }

    pub fn write_pipeline(&self, pipeline: &RunPipeline) -> Result<()> {
        pipeline.validate()?;
        self.ensure_layout()?;
        atomic_write_yaml(&self.root.join("pipeline.yaml"), pipeline)
    }

    pub fn write_orchestration(&self, state: &OrchestrationState) -> Result<()> {
        state.validate()?;
        self.ensure_layout()?;
        atomic_write_yaml(&self.root.join("orchestration.yaml"), state)
    }

    pub fn orchestration(&self) -> Result<Option<OrchestrationState>> {
        let state: Option<OrchestrationState> =
            read_optional_yaml(&self.root.join("orchestration.yaml"))?;
        if let Some(state) = &state {
            state.validate()?;
        }
        Ok(state)
    }

    pub fn write_lead_slice(&self, state: &LeadSliceState) -> Result<()> {
        state.validate()?;
        self.ensure_layout()?;
        atomic_write_yaml(&self.root.join("lead-slice.yaml"), state)?;
        atomic_write_yaml(
            &self
                .root
                .join("lead-slices")
                .join(format!("{:020}.yaml", state.generation)),
            state,
        )
    }

    pub fn lead_slice(&self) -> Result<Option<LeadSliceState>> {
        let state: Option<LeadSliceState> = read_optional_yaml(&self.root.join("lead-slice.yaml"))?;
        if let Some(state) = &state {
            state.validate()?;
        }
        Ok(state)
    }

    pub fn lead_slices(&self) -> Result<Vec<LeadSliceState>> {
        let mut states: Vec<LeadSliceState> = read_yaml_directory(&self.root.join("lead-slices"))?;
        states.sort_by_key(|state| state.generation);
        for state in &states {
            state.validate()?;
        }
        Ok(states)
    }

    pub fn write_lifecycle(&self, state: &RunLifecycleState) -> Result<()> {
        state.validate()?;
        self.ensure_layout()?;
        atomic_write_yaml(&self.root.join("lifecycle.yaml"), state)
    }

    pub fn lifecycle(&self) -> Result<Option<RunLifecycleState>> {
        let state: Option<RunLifecycleState> =
            read_optional_yaml(&self.root.join("lifecycle.yaml"))?;
        if let Some(state) = &state {
            state.validate()?;
        }
        Ok(state)
    }

    pub fn pipeline(&self) -> Result<Option<RunPipeline>> {
        let path = self.root.join("pipeline.yaml");
        if !path.exists() {
            return Ok(None);
        }
        let text = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
        RunPipeline::from_yaml(&text).map(Some)
    }

    pub fn write_question(&self, question: &QuestionRecord) -> Result<()> {
        question.validate()?;
        self.ensure_layout()?;
        atomic_write_yaml(
            &self
                .root
                .join("questions")
                .join(format!("{}.yaml", question.id)),
            question,
        )
    }

    pub fn question(&self, question_id: &str) -> Result<QuestionRecord> {
        validate_id(question_id)?;
        let path = self
            .root
            .join("questions")
            .join(format!("{question_id}.yaml"));
        let text = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
        QuestionRecord::from_yaml(&text)
    }

    pub fn delete_question(&self, question_id: &str) -> Result<()> {
        validate_id(question_id)?;
        let path = self
            .root
            .join("questions")
            .join(format!("{question_id}.yaml"));
        if path.exists() {
            fs::remove_file(&path).map_err(|error| io_error(&path, error))?;
        }
        Ok(())
    }

    pub fn questions(&self) -> Result<Vec<QuestionRecord>> {
        let root = self.root.join("questions");
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut paths = yaml_paths(&root)?;
        paths.sort();
        paths
            .into_iter()
            .map(|path| {
                let text = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
                QuestionRecord::from_yaml(&text)
            })
            .collect()
    }

    pub fn open_questions(&self) -> Result<Vec<QuestionRecord>> {
        Ok(self
            .questions()?
            .into_iter()
            .filter(|question| {
                matches!(
                    question.status,
                    QuestionStatus::Open
                        | QuestionStatus::AnsweredPendingResume
                        | QuestionStatus::AutoResolvedPendingResume
                )
            })
            .collect())
    }

    pub fn answer_question_option(
        &self,
        question_id: &str,
        option_id: &str,
        actor: &str,
    ) -> Result<ResumeDirective> {
        let mut question = self.question(question_id)?;
        question.answer_option(option_id, QuestionAnswerSource::Human, actor, Utc::now())?;
        self.write_question(&question)?;
        resume_directive(&question)
    }

    pub fn answer_question_custom(
        &self,
        question_id: &str,
        answer: &str,
        actor: &str,
    ) -> Result<ResumeDirective> {
        let mut question = self.question(question_id)?;
        question.answer_custom(answer, QuestionAnswerSource::Human, actor, Utc::now())?;
        self.write_question(&question)?;
        resume_directive(&question)
    }

    pub fn write_external_loop(
        &self,
        config: &ExternalLoopConfig,
        state: &ExternalLoopState,
    ) -> Result<()> {
        state.validate(config)?;
        self.ensure_layout()?;
        if state.id != config.id {
            return Err(KoniError::Workflow(format!(
                "external state {} does not match config {}",
                state.id, config.id
            )));
        }
        let root = self.root.join("external-loops").join(&state.id);
        fs::create_dir_all(&root).map_err(|error| io_error(&root, error))?;
        atomic_write_yaml(&root.join("config.yaml"), config)?;
        atomic_write_yaml(&root.join("state.yaml"), state)
    }

    pub fn external_loops(&self) -> Result<Vec<ExternalLoopState>> {
        let root = self.root.join("external-loops");
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut ids = fs::read_dir(&root)
            .map_err(|error| io_error(&root, error))?
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                entry
                    .file_type()
                    .ok()
                    .filter(|kind| kind.is_dir())
                    .map(|_| entry.file_name())
            })
            .collect::<Vec<_>>();
        ids.sort();
        ids.into_iter()
            .map(|id| {
                self.external_loop(&id.to_string_lossy())
                    .map(|(_, state)| state)
            })
            .collect()
    }

    pub fn external_loop(&self, id: &str) -> Result<(ExternalLoopConfig, ExternalLoopState)> {
        validate_id(id)?;
        let root = self.root.join("external-loops").join(id);
        let config_text = fs::read_to_string(root.join("config.yaml"))
            .map_err(|error| io_error(root.join("config.yaml"), error))?;
        let config = ExternalLoopConfig::from_yaml(&config_text)?;
        let state_text = fs::read_to_string(root.join("state.yaml"))
            .map_err(|error| io_error(root.join("state.yaml"), error))?;
        let state = ExternalLoopState::from_yaml(&state_text, &config)?;
        Ok((config, state))
    }

    pub fn write_external_repair_request(&self, request: &ExternalRepairRequest) -> Result<()> {
        request.validate()?;
        self.ensure_layout()?;
        let root = self
            .root
            .join("external-loops")
            .join(&request.loop_id)
            .join("repair-requests");
        fs::create_dir_all(&root).map_err(|error| io_error(&root, error))?;
        let path = root.join(format!("{}.yaml", request.id));
        if path.exists() {
            let existing: ExternalRepairRequest = read_yaml(&path)?;
            if existing.id != request.id
                || existing.run_id != request.run_id
                || existing.loop_id != request.loop_id
                || existing.iteration != request.iteration
                || existing.attempt != request.attempt
                || existing.base_head_sha != request.base_head_sha
                || existing.evidence_hash != request.evidence_hash
                || existing.reasons != request.reasons
                || existing.action != request.action
                || existing.requested_at != request.requested_at
            {
                return Err(KoniError::Workflow(format!(
                    "external repair request {} immutable evidence changed",
                    request.id
                )));
            }
        }
        atomic_write_yaml(&path, request)
    }

    pub fn external_repair_request(
        &self,
        loop_id: &str,
        request_id: &str,
    ) -> Result<ExternalRepairRequest> {
        validate_id(loop_id)?;
        validate_id(request_id)?;
        let path = self
            .root
            .join("external-loops")
            .join(loop_id)
            .join("repair-requests")
            .join(format!("{request_id}.yaml"));
        let request: ExternalRepairRequest = read_yaml(&path)?;
        request.validate()?;
        Ok(request)
    }

    pub fn external_repair_requests(&self, loop_id: &str) -> Result<Vec<ExternalRepairRequest>> {
        validate_id(loop_id)?;
        let requests: Vec<ExternalRepairRequest> = read_yaml_directory(
            &self
                .root
                .join("external-loops")
                .join(loop_id)
                .join("repair-requests"),
        )?;
        for request in &requests {
            request.validate()?;
            if request.loop_id != loop_id {
                return Err(KoniError::Workflow(format!(
                    "external repair request {} belongs to loop {}, not {loop_id}",
                    request.id, request.loop_id
                )));
            }
        }
        Ok(requests)
    }

    pub fn write_agent(&self, agent: &AgentSessionRecord) -> Result<()> {
        validate_id(&agent.id)?;
        validate_id(&agent.run_id)?;
        if let Some(stage_id) = &agent.stage_id {
            validate_id(stage_id)?;
        }
        if agent.persona.trim().is_empty() || agent.status.trim().is_empty() {
            return Err(KoniError::Workflow(
                "agent persona and status must not be empty".to_owned(),
            ));
        }
        if let (Some(started_at), Some(finished_at)) = (agent.started_at, agent.finished_at)
            && finished_at < started_at
        {
            return Err(KoniError::Workflow(format!(
                "agent {} finished before it started",
                agent.id
            )));
        }
        if let Some(identity) = &agent.process_identity
            && (agent.pid != Some(identity.pid)
                || identity.process_group_id != identity.pid
                || identity.birth_marker.trim().is_empty())
        {
            return Err(KoniError::Workflow(format!(
                "agent {} has an invalid owned process identity",
                agent.id
            )));
        }
        self.ensure_layout()?;
        atomic_write_yaml(
            &self.root.join("agents").join(format!("{}.yaml", agent.id)),
            agent,
        )
    }

    pub fn agents(&self) -> Result<Vec<AgentSessionRecord>> {
        read_yaml_directory(&self.root.join("agents"))
    }

    pub fn agent(&self, agent_id: &str) -> Result<Option<AgentSessionRecord>> {
        validate_id(agent_id)?;
        read_optional_yaml(&self.root.join("agents").join(format!("{agent_id}.yaml")))
    }

    pub fn append_planning_message(&self, value: &Value) -> Result<()> {
        self.ensure_layout()?;
        let path = self.root.join("planning/transcript.jsonl");
        let mut line = serde_json::to_vec(value).map_err(|source| KoniError::Json {
            path: path.clone(),
            source,
        })?;
        line.push(b'\n');
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| io_error(&path, error))?;
        file.write_all(&line)
            .map_err(|error| io_error(&path, error))?;
        file.sync_data().map_err(|error| io_error(&path, error))
    }

    pub fn planning_transcript(&self) -> Result<Vec<Value>> {
        let path = self.root.join("planning/transcript.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let text = fs::read_to_string(&path).map_err(|error| io_error(&path, error))?;
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str(line).map_err(|source| KoniError::Json {
                    path: path.clone(),
                    source,
                })
            })
            .collect()
    }
}

#[cfg(unix)]
fn same_control_root_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_control_root_identity(_left: &fs::Metadata, _right: &fs::Metadata) -> bool {
    // PersistentFileLock fails closed before this point on platforms without
    // descriptor-relative no-follow traversal.
    true
}

pub(crate) fn resume_directive(question: &QuestionRecord) -> Result<ResumeDirective> {
    let answer = question
        .answer
        .as_ref()
        .ok_or_else(|| KoniError::Workflow("question answer was not recorded".to_owned()))?;
    let answer_text = answer
        .custom
        .clone()
        .or_else(|| {
            answer.option_id.as_deref().and_then(|id| {
                question
                    .options
                    .iter()
                    .find(|option| option.id == id)
                    .map(|option| option.label.clone())
            })
        })
        .unwrap_or_default();
    Ok(ResumeDirective {
        question_id: question.id.clone(),
        session_id: question.session_resume.session_id.clone(),
        working_directory: question.session_resume.working_directory.clone(),
        prompt: format!(
            "The user answered question {}: {}\nContinue from the safe checkpoint using this decision.",
            question.id, answer_text
        ),
        context_hash: question.session_resume.context_hash.clone(),
    })
}

fn read_yaml_directory<T>(root: &Path) -> Result<Vec<T>>
where
    T: for<'de> Deserialize<'de>,
{
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut paths = yaml_paths(root)?;
    paths.sort();
    paths.into_iter().map(|path| read_yaml(&path)).collect()
}

fn yaml_paths(root: &Path) -> Result<Vec<PathBuf>> {
    Ok(fs::read_dir(root)
        .map_err(|error| io_error(root, error))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            matches!(
                path.extension().and_then(|value| value.to_str()),
                Some("yaml" | "yml")
            )
        })
        .collect())
}

fn read_optional_yaml<T>(path: &Path) -> Result<Option<T>>
where
    T: for<'de> Deserialize<'de>,
{
    path.exists().then(|| read_yaml(path)).transpose()
}

fn read_yaml<T>(path: &Path) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let text = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    serde_yaml::from_str(&text).map_err(|source| KoniError::Yaml {
        path: path.to_path_buf(),
        source,
    })
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(KoniError::Action(format!(
            "invalid control record ID: {id}"
        )));
    }
    Ok(())
}

pub fn new_control_id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::now_v7())
}

#[cfg(test)]
mod tests {
    use chrono::Duration;

    use crate::catalog::QuestionPolicy;
    use crate::graph::normalized_hash;
    use crate::questions::{
        QuestionAutoResolution, QuestionImpact, QuestionOption, QuestionPauseScope,
        QuestionSessionResume,
    };

    use super::*;

    #[test]
    fn control_lock_never_recreates_a_missing_run_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("missing-run");
        let store = RunControlStore::new(root.clone());
        let error = match store.lock("supervisor") {
            Ok(_) => panic!("a missing run must not gain a control lock"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("disappeared"));
        assert!(!root.exists());
    }

    #[cfg(unix)]
    #[test]
    fn control_lock_rejects_redirected_sidecar_lock_directories() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let sidecar = root.join("koni");
        let run_root = sidecar.join("runs/run-test");
        fs::create_dir_all(&run_root).unwrap();
        let external = root.join("external");
        fs::create_dir(&external).unwrap();
        symlink(&external, sidecar.join("locks")).unwrap();

        let store = RunControlStore::new(run_root);
        let error = match store.lock("supervisor") {
            Ok(_) => panic!("a redirected lock directory must fail closed"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("redirected"));
        assert!(external.read_dir().unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn control_lock_serializes_on_one_persistent_inode() {
        use std::os::unix::fs::MetadataExt;

        let temp = tempfile::tempdir().unwrap();
        let common_dir = temp.path().canonicalize().unwrap();
        let run_root = common_dir.join("koni/runs/run-test");
        fs::create_dir_all(&run_root).unwrap();
        let store = RunControlStore::new(run_root);

        let first = store.lock("supervisor").unwrap();
        let lock_path = common_dir.join("koni/locks/run-control/run-test/supervisor.lock");
        let first_inode = fs::metadata(&lock_path).unwrap().ino();
        let error = match store.lock("supervisor") {
            Ok(_) => panic!("the same run-control lock must serialize contenders"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("is held"), "{error}");

        drop(first);
        assert!(lock_path.is_file(), "persistent lock inode was unlinked");
        let second = store.lock("supervisor").unwrap();
        assert_eq!(fs::metadata(&lock_path).unwrap().ino(), first_inode);
        drop(second);
        assert_eq!(fs::metadata(&lock_path).unwrap().ino(), first_inode);
    }

    #[test]
    fn answer_persists_and_builds_same_session_resume_directive() {
        let temp = tempfile::tempdir().unwrap();
        let store = RunControlStore::new(temp.path().to_path_buf());
        let now = Utc::now();
        let question = QuestionRecord::new(
            "q-1",
            "Which approach?",
            "Material choice",
            vec![
                QuestionOption {
                    id: "safe".to_owned(),
                    label: "Safe".to_owned(),
                    description: "Use safe mode".to_owned(),
                    recommended: true,
                },
                QuestionOption {
                    id: "fast".to_owned(),
                    label: "Fast".to_owned(),
                    description: "Use fast mode".to_owned(),
                    recommended: false,
                },
            ],
            true,
            QuestionPauseScope::Ticket {
                run_id: "run-1".to_owned(),
                ticket_id: "ticket-1".to_owned(),
            },
            QuestionPolicy::Interactive,
            QuestionImpact::High,
            Some(QuestionAutoResolution {
                option_id: "safe".to_owned(),
                resolve_at: now + Duration::minutes(5),
            }),
            QuestionSessionResume {
                session_id: "session-1".to_owned(),
                agent_id: None,
                turn_id: None,
                working_directory: Some(PathBuf::from("/tmp/work")),
                context_hash: normalized_hash(&"context"),
                captured_at: now,
            },
            now,
        )
        .unwrap();
        store.write_question(&question).unwrap();
        let directive = store.answer_question_option("q-1", "safe", "user").unwrap();
        assert_eq!(directive.session_id, "session-1");
        assert!(directive.prompt.contains("Safe"));
        assert_eq!(store.open_questions().unwrap().len(), 0);
    }

    #[test]
    fn lifecycle_play_pause_intent_round_trips_independently_of_orchestration() {
        let temp = tempfile::tempdir().unwrap();
        let store = RunControlStore::new(temp.path().to_path_buf());
        let mut lifecycle = RunLifecycleState::running();
        store.write_lifecycle(&lifecycle).unwrap();
        assert!(store.lifecycle().unwrap().unwrap().running);

        lifecycle.set_running(false);
        store.write_lifecycle(&lifecycle).unwrap();
        let paused = store.lifecycle().unwrap().unwrap();
        assert!(!paused.running);
        assert!(paused.pause_requested_at.is_some());

        lifecycle.set_running(true);
        store.write_lifecycle(&lifecycle).unwrap();
        let playing = store.lifecycle().unwrap().unwrap();
        assert!(playing.running);
        assert!(playing.pause_requested_at.is_none());
    }

    #[test]
    fn external_repair_requests_persist_dispatch_and_immutable_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let store = RunControlStore::new(temp.path().to_path_buf());
        let now = Utc::now();
        let base_head_sha = "a".repeat(40);
        let reasons = vec!["test failed".to_owned(), "review confidence 2/5".to_owned()];
        let mut request = ExternalRepairRequest {
            schema_version: crate::external_loop::EXTERNAL_LOOP_SCHEMA_VERSION.to_owned(),
            id: "repair-deadbeef".to_owned(),
            run_id: "run-1".to_owned(),
            loop_id: "review".to_owned(),
            iteration: 1,
            attempt: 1,
            base_head_sha: base_head_sha.clone(),
            evidence_hash: normalized_hash(&(&base_head_sha, &reasons)),
            reasons,
            action: Some("repair-external".to_owned()),
            status: crate::external_loop::ExternalRepairRequestStatus::Requested,
            action_result: None,
            result_head_sha: None,
            error: None,
            requested_at: now,
            updated_at: now,
        };
        store.write_external_repair_request(&request).unwrap();

        request
            .record_dispatch(serde_json::json!({"pid": 42}), now + Duration::seconds(1))
            .unwrap();
        store.write_external_repair_request(&request).unwrap();
        let restored = store
            .external_repair_request("review", "repair-deadbeef")
            .unwrap();
        assert_eq!(restored, request);
        assert_eq!(
            store.external_repair_requests("review").unwrap(),
            [request.clone()]
        );

        request.reasons.push("mutated evidence".to_owned());
        assert!(store.write_external_repair_request(&request).is_err());
    }
}
