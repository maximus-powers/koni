use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use anyhow::Context;
use koni_core::catalog::{
    LEGACY_RUN_TYPE_ID, ProfileSourceDef, ProjectCatalogDocument, ProjectCatalogSource,
    ResolvedRunType, RunTypeCatalogEntry, RunTypeDocument,
};
use koni_core::config::{ProfileManifest, StorageBackend};
use koni_core::git::GitBackend;
use koni_core::state::{ProjectRegistry, RunRegistration, RunRegistrationStatus};
use koni_core::{
    CompiledProjectCatalog, Engine, KoniError, LocalBranchCandidate, ProfileCompiler,
    ProjectCatalogCompiler, RunDeletionPreview, RunLifecycleUpdate, RunPromotionPreview,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_chat::{AgentChatCache, AgentChatRender, AgentChatRequest};
use crate::codex_models::CodexModelCatalog;
use crate::configure::{ConfigDomain, ConfigResource, ConfigResourceKind, derive_resources};
use crate::help::HelpTopic;

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

/// Keys whose panel-level meaning must not be shadowed by profile-defined orchestration
/// shortcuts. Both dispatch and contextual help use this single runtime protection list.
pub(crate) const PROTECTED_CONFIGURED_ORCHESTRATION_KEYS: &[char] = &[
    'h', 'q', 'r', 'c', '1', '2', '4', '6', 'n', '?', 'a', 'd', 'j', 'k', 'l', 'm', '[', ']',
];

pub(crate) fn configured_orchestration_key_is_protected(character: char) -> bool {
    PROTECTED_CONFIGURED_ORCHESTRATION_KEYS.contains(&character)
}

fn new_operation_id() -> String {
    format!(
        "ui-{}-{}",
        std::process::id(),
        NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Operate,
    Configure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Focus {
    Runs,
    Tickets,
    Details,
    Questions,
    Agents,
    Activity,
    Graph,
    ConfigTree,
    ConfigForm,
    Yaml,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Panel {
    Overview,
    Planning,
    Stages,
}

impl Panel {
    pub const ALL: [Self; 3] = [Self::Overview, Self::Planning, Self::Stages];

    pub fn label(self) -> &'static str {
        match self {
            Self::Overview => "overview",
            Self::Planning => "plan",
            Self::Stages => "stages",
        }
    }
}

/// The semantic object currently projected into the Overview details panel.
///
/// This is intentionally independent of keyboard focus: after selecting a run
/// or ticket, moving into Details should preserve the object the operator was
/// just examining.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverviewSubject {
    Run,
    Ticket,
}

/// Preserve the historical run-overview cursor while the current Overview is
/// rendered as one vertically composed Objective / Run / Evidence document.
const DEFAULT_RUN_OVERVIEW_SECTION: usize = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TicketTab {
    All,
    Active,
    Todo,
    Blocked,
    Proposed,
    Closed,
    Other,
}

impl TicketTab {
    pub const ALL: [Self; 7] = [
        Self::All,
        Self::Active,
        Self::Todo,
        Self::Blocked,
        Self::Proposed,
        Self::Closed,
        Self::Other,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Active => "active",
            Self::Todo => "todo",
            Self::Blocked => "blocked",
            Self::Proposed => "proposed",
            Self::Closed => "closed",
            Self::Other => "other",
        }
    }

    pub fn includes(self, ticket: &Value) -> bool {
        let status = ticket
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let blocked = ticket
            .get("blockers")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
        match self {
            Self::All => true,
            Self::Active => matches!(
                status,
                "active" | "in_progress" | "leased" | "review" | "integrating" | "awaiting_input"
            ),
            Self::Todo => matches!(status, "todo" | "ready" | "queued") && !blocked,
            Self::Blocked => blocked || status == "blocked",
            Self::Proposed => matches!(status, "proposed" | "draft"),
            Self::Closed => matches!(
                status,
                "closed" | "complete" | "completed" | "done" | "cancelled" | "superseded"
            ),
            Self::Other => ![
                Self::Active,
                Self::Todo,
                Self::Blocked,
                Self::Proposed,
                Self::Closed,
            ]
            .into_iter()
            .any(|tab| tab.includes(ticket)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    pub id: String,
    pub goal: String,
    pub status: String,
    pub run_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_type_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promotion_status: Option<String>,
    #[serde(default)]
    pub merge_ready: bool,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub ticket_count: usize,
    pub open_questions: usize,
    pub active_agents: usize,
    pub validation_errors: usize,
    #[serde(default)]
    pub total_tokens: u64,
    #[serde(default)]
    pub new_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveAgentSummary {
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSummary {
    /// Stable internal selection identity. This is never rendered.
    pub key: String,
    pub title: String,
    pub ticket_id: Option<String>,
    pub ticket_title: Option<String>,
    pub persona: String,
    pub status: String,
    pub live: bool,
    pub transcript: Option<AgentTranscriptSource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentTranscriptSource {
    pub path: PathBuf,
    pub prompt_path: Option<PathBuf>,
    pub output_path: Option<PathBuf>,
    pub codex_session_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct RunData {
    /// Present only for an optimistic row inserted before the compiler has
    /// returned the durable run record. Never serialized or rendered.
    pub provisional_operation_id: Option<String>,
    pub summary: Option<RunSummary>,
    pub snapshot: Value,
    pub graph: Vec<Value>,
    pub ticket_graphs: BTreeMap<String, Vec<Value>>,
    pub tickets: Vec<Value>,
    pub questions: Vec<Value>,
    pub stages: Vec<Value>,
    pub agents: Vec<Value>,
    pub events: Vec<Value>,
    pub report: Option<Value>,
    pub actions: Vec<Value>,
    pub orchestration: Option<Value>,
    pub graph_options: Option<Value>,
    pub external_loops: Vec<Value>,
    pub external_repairs: Vec<Value>,
    pub planning_transcript: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunTokenBreakdown {
    pub input: u64,
    pub cached_input: u64,
    pub output: u64,
    pub reasoning_output: u64,
    pub total: u64,
    pub new: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanningBudgetProgress {
    pub used: u64,
    pub limit: u64,
    pub synthesis_reserve: u64,
    pub synthesis_forced: bool,
    pub metric: PlanningBudgetMetric,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanningBudgetMetric {
    New,
    Processed,
}

impl PlanningBudgetMetric {
    pub fn label(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Processed => "processed",
        }
    }
}

fn token_breakdown_from_snapshot(snapshot: &Value) -> RunTokenBreakdown {
    let usage = snapshot.get("token_usage").unwrap_or(&Value::Null);
    let input = usage
        .get("input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cached_input = usage
        .get("cached_input_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let output = usage
        .get("output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let has_input_output_breakdown = ["input_tokens", "output_tokens"]
        .into_iter()
        .any(|field| usage.get(field).and_then(Value::as_u64).is_some());
    let total = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| input.saturating_add(output));
    let new = usage
        .get("new_tokens")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| {
            if has_input_output_breakdown {
                input.saturating_sub(cached_input).saturating_add(output)
            } else {
                total.saturating_sub(cached_input)
            }
        });
    RunTokenBreakdown {
        input,
        cached_input,
        output,
        reasoning_output: usage
            .get("reasoning_output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        total,
        new,
    }
}

impl RunData {
    pub fn from_snapshot(snapshot: Value) -> Self {
        let run = snapshot.get("run").cloned().unwrap_or(Value::Null);
        let board = snapshot.get("board").cloned().unwrap_or(Value::Null);
        let graph = array_at(&snapshot, "graph");
        let ticket_graphs = snapshot
            .get("ticket_graphs")
            .and_then(Value::as_object)
            .map(|projections| {
                projections
                    .iter()
                    .filter_map(|(ticket_id, projection)| {
                        projection
                            .get("graph")
                            .and_then(Value::as_array)
                            .cloned()
                            .map(|graph| (ticket_id.clone(), graph))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let tickets = array_at(&snapshot, "tickets");
        let questions = array_at(&snapshot, "questions");
        let stages = array_at(&snapshot, "stages");
        let agents = array_at(&snapshot, "agents");
        let events = array_at(&snapshot, "events");
        let actions = array_at(&snapshot, "actions");
        let orchestration = snapshot
            .get("orchestration")
            .cloned()
            .filter(|value| !value.is_null());
        let graph_options = snapshot
            .get("views")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|view| {
                matches!(
                    view.get("kind").and_then(Value::as_str),
                    Some("graph" | "typed_tree")
                )
            })
            .and_then(|view| view.get("options"))
            .cloned();
        let external_loops = array_at(&snapshot, "external_loops");
        let external_repairs = array_at(&snapshot, "external_repairs");
        let planning_transcript = array_at(&snapshot, "planning_transcript");
        let report = snapshot
            .get("views")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|view| {
                matches!(
                    view.get("kind").and_then(Value::as_str),
                    Some("report" | "summary")
                ) || view
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.contains("report"))
            })
            .cloned();
        let token_breakdown = token_breakdown_from_snapshot(&snapshot);
        let summary = run
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| board.get("run_id").and_then(Value::as_str))
            .map(|id| RunSummary {
                id: id.to_owned(),
                goal: run
                    .get("goal")
                    .and_then(Value::as_str)
                    .or_else(|| board.get("goal").and_then(Value::as_str))
                    .unwrap_or("Untitled run")
                    .to_owned(),
                status: run
                    .get("status")
                    .and_then(Value::as_str)
                    .or_else(|| board.get("run_status").and_then(Value::as_str))
                    .unwrap_or("unknown")
                    .to_owned(),
                run_type: run
                    .get("run_type_id")
                    .and_then(Value::as_str)
                    .or_else(|| run.get("profile_id").and_then(Value::as_str))
                    .or_else(|| board.get("profile_id").and_then(Value::as_str))
                    .unwrap_or("default")
                    .to_owned(),
                run_type_title: run
                    .get("run_type_title")
                    .and_then(Value::as_str)
                    .filter(|title| !title.trim().is_empty())
                    .map(ToOwned::to_owned),
                target_branch: run
                    .get("target_branch")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                promotion_status: snapshot
                    .get("promotion")
                    .and_then(|promotion| promotion.get("status"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                merge_ready: snapshot
                    .get("promotion")
                    .and_then(|promotion| promotion.get("status"))
                    .and_then(Value::as_str)
                    .is_some_and(|status| status == "awaiting_authorization"),
                branch: run
                    .get("integration_branch")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                base: run
                    .get("base_commit")
                    .or_else(|| run.get("integration_base"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                ticket_count: tickets.len(),
                open_questions: questions
                    .iter()
                    .filter(|question| question_needs_attention(question))
                    .count(),
                active_agents: 0,
                validation_errors: snapshot
                    .get("validation_errors")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len),
                total_tokens: token_breakdown.total,
                new_tokens: token_breakdown.new,
            });
        let mut data = Self {
            provisional_operation_id: None,
            summary,
            snapshot,
            graph,
            ticket_graphs,
            tickets,
            questions,
            stages,
            agents,
            events,
            report,
            actions,
            orchestration,
            graph_options,
            external_loops,
            external_repairs,
            planning_transcript,
        };
        let active_agents = data.live_agent_summaries().len();
        if let Some(summary) = data.summary.as_mut() {
            summary.active_agents = active_agents;
            let lifecycle_running = data
                .snapshot
                .get("lifecycle")
                .and_then(|lifecycle| lifecycle.get("running"))
                .and_then(Value::as_bool)
                .or_else(|| {
                    data.orchestration
                        .as_ref()
                        .and_then(|orchestration| orchestration.get("running"))
                        .and_then(Value::as_bool)
                });
            let lifecycle_draining = data
                .snapshot
                .get("lifecycle")
                .and_then(|lifecycle| lifecycle.get("draining"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if lifecycle_running == Some(false)
                && !matches!(summary.status.as_str(), "concluded" | "stopped" | "failed")
            {
                summary.status = if lifecycle_draining {
                    "pausing".to_owned()
                } else {
                    "paused".to_owned()
                };
            }
        }
        data
    }

    pub fn provisional(intake: &NewRunDraft, run_type: Option<&RunTypeOption>) -> Self {
        let run_type_title = run_type
            .map(|run_type| run_type.title.as_str())
            .unwrap_or(intake.run_type.as_str());
        let stages = run_type
            .map(|run_type| {
                run_type
                    .stages
                    .iter()
                    .map(|stage| {
                        serde_json::json!({
                            "status":"pending",
                            "definition":{
                                "id":stage.id,
                                "title":stage.title,
                                "kind":stage.kind
                            }
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let snapshot = serde_json::json!({
            "run":{
                "id":format!("pending:{}", intake.operation_id),
                "goal":intake.goal.trim(),
                "status":"planning",
                "run_type_id":intake.run_type,
                "run_type_title":run_type_title,
                "target_branch":intake.target_branch
            },
            "stages":stages,
            "token_usage":{"total_tokens":0},
            "lifecycle":{"running":true,"active_runtime_milliseconds":0}
        });
        let mut run = Self::from_snapshot(snapshot);
        run.provisional_operation_id = Some(intake.operation_id.clone());
        run
    }

    pub fn is_provisional(&self) -> bool {
        self.provisional_operation_id.is_some()
    }

    pub fn token_breakdown(&self) -> RunTokenBreakdown {
        token_breakdown_from_snapshot(&self.snapshot)
    }

    pub fn planning_budget_progress(&self) -> Option<PlanningBudgetProgress> {
        let session = self.snapshot.get("planning_session")?.as_object()?;
        let usage = session.get("usage")?;
        let baseline = session.get("accounted_baseline").unwrap_or(&Value::Null);
        let metric = session
            .get("budget_metric")
            .and_then(Value::as_str)
            .unwrap_or("new_tokens");
        let (field, metric) = if metric == "processed_tokens" {
            ("total_tokens", PlanningBudgetMetric::Processed)
        } else {
            ("new_tokens", PlanningBudgetMetric::New)
        };
        Some(PlanningBudgetProgress {
            used: usage
                .get(field)
                .and_then(Value::as_u64)
                .unwrap_or_default()
                .saturating_sub(
                    baseline
                        .get(field)
                        .and_then(Value::as_u64)
                        .unwrap_or_default(),
                ),
            limit: session.get("budget_limit")?.as_u64()?,
            synthesis_reserve: session
                .get("synthesis_reserve")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            synthesis_forced: session
                .get("synthesis_forced")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            metric,
        })
    }

    pub fn pending_questions(&self) -> Vec<&Value> {
        let mut questions = self
            .questions
            .iter()
            .enumerate()
            .filter(|(_, question)| question_needs_attention(question))
            .collect::<Vec<_>>();
        let mut batch_first = BTreeMap::new();
        for (index, question) in &questions {
            if let Some(batch_id) = question_batch_id(question) {
                batch_first.entry(batch_id).or_insert(*index);
            }
        }
        questions.sort_by_key(|(index, question)| {
            question_batch_position(question).map_or((*index, 0, *index), |(ordinal, _)| {
                let group = question_batch_id(question)
                    .and_then(|batch_id| batch_first.get(batch_id).copied())
                    .unwrap_or(*index);
                (group, ordinal, *index)
            })
        });
        questions
            .into_iter()
            .map(|(_, question)| question)
            .collect()
    }

    pub fn stage_has_live_agent(&self, stage_id: &str) -> bool {
        self.agents.iter().any(|agent| {
            agent.get("stage_id").and_then(Value::as_str) == Some(stage_id)
                && matches!(
                    agent
                        .get("status")
                        .or_else(|| agent.get("state"))
                        .and_then(Value::as_str),
                    Some("starting" | "running" | "active" | "waiting" | "resuming")
                )
        })
    }

    pub fn agent_summaries(&self) -> Vec<AgentSummary> {
        #[derive(Debug)]
        struct Candidate {
            key: String,
            group: usize,
            order: usize,
            title: String,
            ticket_id: Option<String>,
            ticket_title: Option<String>,
            persona: String,
            status: String,
            live: bool,
            updated_at: String,
            transcript: Option<AgentTranscriptSource>,
        }

        let stage_metadata = self
            .stages
            .iter()
            .enumerate()
            .filter_map(|(index, stage)| {
                let definition = stage.get("definition").unwrap_or(stage);
                let id = definition.get("id").and_then(Value::as_str)?;
                let title = definition
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|title| !title.trim().is_empty())
                    .map(ToOwned::to_owned);
                Some((id.to_owned(), (index, title)))
            })
            .collect::<BTreeMap<_, _>>();
        let ticket_metadata = self
            .tickets
            .iter()
            .enumerate()
            .filter_map(|(index, ticket)| {
                ticket
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_owned(), (index, ticket)))
            })
            .collect::<BTreeMap<_, _>>();
        let mut candidates = Vec::new();
        let mut live_ticket_ids = BTreeSet::new();
        let mut recorded_ticket_steps = BTreeSet::new();
        let has_semantic_lead = self.agents.iter().any(|agent| {
            agent.get("persona").and_then(Value::as_str) == Some("lead")
                && agent.get("ticket_id").is_none_or(Value::is_null)
                && agent
                    .get("stage_id")
                    .and_then(Value::as_str)
                    .is_some_and(|stage| !stage.is_empty())
        });

        for (agent_index, agent) in self.agents.iter().enumerate() {
            let status = agent
                .get("status")
                .or_else(|| agent.get("state"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let stage_id = agent.get("stage_id").and_then(Value::as_str);
            let ticket_id = agent.get("ticket_id").and_then(Value::as_str);
            let persona_id = agent.get("persona").and_then(Value::as_str);
            let semantic_lead = persona_id == Some("lead")
                && ticket_id.is_none()
                && stage_id.is_some_and(|stage| !stage.is_empty());
            // Every fresh Lead slice has a raw process record, while the
            // orchestration stage owns one stable semantic record. Project
            // only that stable row so it keeps the same identity between
            // slices instead of disappearing into raw Lead process history.
            if has_semantic_lead
                && persona_id == Some("lead")
                && ticket_id.is_none()
                && stage_id.is_none()
            {
                continue;
            }
            if let (Some(ticket_id), Some(stage_id), Some(persona)) = (
                ticket_id,
                stage_id,
                agent.get("persona").and_then(Value::as_str),
            ) {
                recorded_ticket_steps.insert(format!("{ticket_id}\0{stage_id}\0{persona}"));
            }
            let closed_ticket = ticket_id
                .and_then(|id| ticket_metadata.get(id))
                .is_some_and(|(_, ticket)| model_ticket_is_closed(ticket));
            let live = matches!(status, "starting" | "running" | "resuming") && !closed_ticket;
            if live && let Some(ticket_id) = ticket_id {
                live_ticket_ids.insert(ticket_id.to_owned());
            }
            let stage = stage_id.and_then(|id| stage_metadata.get(id));
            let ticket = ticket_id.and_then(|id| ticket_metadata.get(id));
            let fallback = agent
                .get("active_step")
                .and_then(Value::as_str)
                .or_else(|| agent.get("persona").and_then(Value::as_str))
                .map(humanize_identifier);
            let title = stage
                .and_then(|(_, title)| title.clone())
                .or_else(|| ticket.and_then(|(_, ticket)| friendly_ticket_title(ticket)))
                .or(fallback)
                .unwrap_or_else(|| "Current run work".to_owned());
            let (group, order) = stage.map_or_else(
                || ticket.map_or((2, agent_index), |(index, _)| (1, *index)),
                |(index, _)| (0, *index),
            );
            let stable_key = || {
                agent.get("id").and_then(Value::as_str).map_or_else(
                    || format!("stage:{}:{agent_index}", stage_id.unwrap_or_default()),
                    |id| format!("agent:{id}"),
                )
            };
            let key = if semantic_lead {
                stable_key()
            } else {
                agent
                    .get("process_identity")
                    .and_then(|identity| identity.get("pid"))
                    .or_else(|| agent.get("pid"))
                    .and_then(Value::as_u64)
                    .map_or_else(stable_key, |pid| format!("process:{pid}"))
            };
            candidates.push(Candidate {
                key,
                group,
                order,
                title: concise_work_title(&title),
                ticket_id: ticket_id.map(ToOwned::to_owned),
                ticket_title: ticket
                    .and_then(|(_, ticket)| friendly_ticket_title(ticket))
                    .map(|title| concise_work_title(&title)),
                persona: persona_id
                    .map(humanize_identifier)
                    .unwrap_or_else(|| "Agent".to_owned()),
                status: if status.is_empty() {
                    "recorded".to_owned()
                } else {
                    status.to_owned()
                },
                live,
                updated_at: agent
                    .get("updated_at")
                    .or_else(|| agent.get("finished_at"))
                    .or_else(|| agent.get("started_at"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                transcript: agent
                    .get("stdout_path")
                    .and_then(Value::as_str)
                    .filter(|path| !path.trim().is_empty())
                    .map(|path| AgentTranscriptSource {
                        path: PathBuf::from(path),
                        prompt_path: agent
                            .get("prompt_path")
                            .and_then(Value::as_str)
                            .filter(|path| !path.trim().is_empty())
                            .map(PathBuf::from),
                        output_path: agent
                            .get("output_path")
                            .and_then(Value::as_str)
                            .filter(|path| !path.trim().is_empty())
                            .map(PathBuf::from),
                        codex_session_id: agent
                            .get("codex_session_id")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned),
                    }),
            });
        }

        let workflows = self
            .snapshot
            .get("board")
            .and_then(|board| board.get("ticket_workflows"))
            .and_then(Value::as_object);
        for (ticket_index, ticket) in self.tickets.iter().enumerate() {
            if model_ticket_is_closed(ticket) {
                continue;
            }
            let Some(ticket_id) = ticket.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(progress) = workflows.and_then(|workflows| workflows.get(ticket_id)) else {
                continue;
            };
            if progress.get("worker_state").and_then(Value::as_str) != Some("running") {
                continue;
            }
            if live_ticket_ids.contains(ticket_id) {
                continue;
            }
            let active_step = progress.get("active_worker_step").and_then(Value::as_str);
            let step = active_step.and_then(|active_step| {
                ticket
                    .get("workflow")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|step| step.get("id").and_then(Value::as_str) == Some(active_step))
            });
            let fallback = step
                .and_then(|step| {
                    step.get("title")
                        .or_else(|| step.get("persona"))
                        .and_then(Value::as_str)
                })
                .map(humanize_identifier);
            let title = friendly_ticket_title(ticket)
                .or(fallback)
                .unwrap_or_else(|| "Current run work".to_owned());
            candidates.push(Candidate {
                key: format!("ticket:{ticket_id}"),
                group: 1,
                order: ticket_index,
                title: concise_work_title(&title),
                ticket_id: Some(ticket_id.to_owned()),
                ticket_title: friendly_ticket_title(ticket).map(|title| concise_work_title(&title)),
                persona: step
                    .and_then(|step| step.get("persona"))
                    .and_then(Value::as_str)
                    .map(humanize_identifier)
                    .unwrap_or_else(|| "Agent".to_owned()),
                status: "running".to_owned(),
                live: true,
                updated_at: String::new(),
                transcript: None,
            });
        }

        for (ticket_index, ticket) in self.tickets.iter().enumerate() {
            let Some(ticket_id) = ticket.get("id").and_then(Value::as_str) else {
                continue;
            };
            let workflow = ticket
                .get("workflow")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            for (output_index, output) in ticket
                .get("outputs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                let step_id = output.get("step_id").and_then(Value::as_str);
                let output_persona = output.get("persona").and_then(Value::as_str);
                if let (Some(step_id), Some(persona)) = (step_id, output_persona)
                    && recorded_ticket_steps.contains(&format!("{ticket_id}\0{step_id}\0{persona}"))
                {
                    continue;
                }
                let step = step_id.and_then(|step_id| {
                    workflow
                        .iter()
                        .find(|step| step.get("id").and_then(Value::as_str) == Some(step_id))
                });
                let fallback = step
                    .and_then(|step| {
                        step.get("title")
                            .or_else(|| step.get("persona"))
                            .and_then(Value::as_str)
                    })
                    .or(output_persona)
                    .map(humanize_identifier);
                let title = friendly_ticket_title(ticket)
                    .or(fallback)
                    .unwrap_or_else(|| "Completed ticket work".to_owned());
                let output_key = output
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("{}:{output_index}", step_id.unwrap_or("output")));
                candidates.push(Candidate {
                    key: format!("output:{ticket_id}:{output_key}"),
                    group: 3,
                    order: ticket_index
                        .saturating_mul(1_000)
                        .saturating_add(output_index),
                    title: concise_work_title(&title),
                    ticket_id: Some(ticket_id.to_owned()),
                    ticket_title: friendly_ticket_title(ticket)
                        .map(|title| concise_work_title(&title)),
                    persona: output_persona
                        .or_else(|| {
                            step.and_then(|step| step.get("persona").and_then(Value::as_str))
                        })
                        .map(humanize_identifier)
                        .unwrap_or_else(|| "Agent".to_owned()),
                    status: "completed".to_owned(),
                    live: false,
                    updated_at: output
                        .get("recorded_at")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    transcript: None,
                });
            }
        }

        candidates.sort_by(|left, right| {
            right.live.cmp(&left.live).then_with(|| {
                if left.live && right.live {
                    (left.group, left.order, &left.key).cmp(&(right.group, right.order, &right.key))
                } else {
                    right.updated_at.cmp(&left.updated_at).then_with(|| {
                        (left.group, left.order, &left.key).cmp(&(
                            right.group,
                            right.order,
                            &right.key,
                        ))
                    })
                }
            })
        });
        let mut seen = BTreeSet::new();
        candidates
            .into_iter()
            .filter(|candidate| seen.insert(candidate.key.clone()))
            .map(|candidate| AgentSummary {
                key: candidate.key,
                title: candidate.title,
                ticket_id: candidate.ticket_id,
                ticket_title: candidate.ticket_title,
                persona: candidate.persona,
                status: candidate.status,
                live: candidate.live,
                transcript: candidate.transcript,
            })
            .collect()
    }

    pub fn live_agent_summaries(&self) -> Vec<LiveAgentSummary> {
        self.agent_summaries()
            .into_iter()
            .filter(|agent| agent.live)
            .map(|agent| LiveAgentSummary { title: agent.title })
            .collect()
    }

    /// Whether durable planning output is complete enough for approval to be
    /// the operator's next action. This deliberately says nothing about live
    /// process state: callers must keep verified runtime activity separate
    /// from persisted planning progress.
    pub fn planning_is_ready_for_approval(&self) -> bool {
        let passes = approval_planning_passes(self);
        passes
            .iter()
            .any(|pass| pass.succeeded && pass.body.is_some())
            && passes
                .iter()
                .all(|pass| !pass.required || (pass.succeeded && pass.body.is_some()))
            && !self.questions.iter().any(question_needs_attention)
    }
}

#[derive(Debug, Clone)]
pub struct ConfigDocument {
    pub relative_path: PathBuf,
    pub source_path: PathBuf,
    pub draft_path: PathBuf,
    pub original: String,
    pub text: String,
    pub diagnostics: Vec<String>,
    pub cursor_line: usize,
    pub cursor_column: usize,
    pub is_new: bool,
}

impl ConfigDocument {
    pub fn dirty(&self) -> bool {
        self.text != self.original
    }

    pub(crate) fn dirty_at(&self, locator: &[FormPathToken]) -> bool {
        if self.is_new {
            return true;
        }
        if !self.dirty() {
            return false;
        }
        if locator.is_empty() {
            return true;
        }
        let Some(current) = config_document_text_value(self, &self.text) else {
            return true;
        };
        let Some(published) = config_document_text_value(self, &self.original) else {
            return true;
        };
        value_at_locator(&current, locator) != value_at_locator(&published, locator)
    }

    pub fn validate(&mut self) -> bool {
        self.diagnostics.clear();
        match self
            .source_path
            .extension()
            .and_then(|extension| extension.to_str())
        {
            Some("md") => {}
            Some("toml") => {
                if let Err(error) = toml::from_str::<toml::Value>(&self.text) {
                    self.diagnostics.push(error.to_string());
                }
            }
            _ => {
                if let Err(error) = serde_yaml::from_str::<Value>(&self.text) {
                    self.diagnostics.push(error.to_string());
                }
            }
        }
        self.diagnostics.is_empty()
    }

    pub fn lines(&self) -> Vec<&str> {
        if self.text.is_empty() {
            vec![""]
        } else {
            self.text.split('\n').collect()
        }
    }

    pub fn insert_char(&mut self, character: char) {
        let offset = text_offset(&self.text, self.cursor_line, self.cursor_column);
        self.text.insert(offset, character);
        self.cursor_column += 1;
        let _ = self.validate();
    }

    pub fn insert_text(&mut self, text: &str) {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        let offset = text_offset(&self.text, self.cursor_line, self.cursor_column);
        self.text.insert_str(offset, &text);
        for character in text.chars() {
            if character == '\n' {
                self.cursor_line += 1;
                self.cursor_column = 0;
            } else {
                self.cursor_column += 1;
            }
        }
        let _ = self.validate();
    }

    pub fn newline(&mut self) {
        let offset = text_offset(&self.text, self.cursor_line, self.cursor_column);
        let indent: String = self
            .lines()
            .get(self.cursor_line)
            .into_iter()
            .flat_map(|line| line.chars())
            .take_while(|character| character.is_whitespace())
            .collect();
        self.text.insert_str(offset, &format!("\n{indent}"));
        self.cursor_line += 1;
        self.cursor_column = indent.chars().count();
        let _ = self.validate();
    }

    pub fn backspace(&mut self) {
        if self.cursor_column > 0 {
            let end = text_offset(&self.text, self.cursor_line, self.cursor_column);
            let start = text_offset(&self.text, self.cursor_line, self.cursor_column - 1);
            self.text.replace_range(start..end, "");
            self.cursor_column -= 1;
        } else if self.cursor_line > 0 {
            let previous_len = self.lines()[self.cursor_line - 1].chars().count();
            let offset = text_offset(&self.text, self.cursor_line, 0);
            let start = self.text[..offset]
                .char_indices()
                .next_back()
                .map_or(0, |(index, _)| index);
            self.text.replace_range(start..offset, "");
            self.cursor_line -= 1;
            self.cursor_column = previous_len;
        }
        let _ = self.validate();
    }

    pub fn move_cursor(&mut self, line_delta: isize, column_delta: isize) {
        let line_count = self.lines().len();
        self.cursor_line = self
            .cursor_line
            .saturating_add_signed(line_delta)
            .min(line_count.saturating_sub(1));
        let width = self.lines()[self.cursor_line].chars().count();
        self.cursor_column = self
            .cursor_column
            .saturating_add_signed(column_delta)
            .min(width);
    }
}

#[derive(Debug, Clone, Default)]
pub struct ConfigState {
    pub documents: Vec<ConfigDocument>,
    /// Index into `ConfigDomain::ALL`.
    pub selected_domain: usize,
    /// Index within the resources projected for the selected domain.
    pub selected_resource: usize,
    /// Derived semantic views over `documents`; never an independent draft store.
    pub resources: Vec<ConfigResource>,
    pub selected: usize,
    pub scroll: usize,
    pub form_rows: Vec<FormRow>,
    pub selected_form_row: usize,
    /// A whole Markdown document currently being edited through the semantic
    /// resource that references it.
    pub(crate) linked_document_editor: Option<PathBuf>,
    pub pending_deletes: BTreeSet<PathBuf>,
    pub pending_renames: BTreeMap<PathBuf, PathBuf>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ConfigDraftOperations {
    #[serde(default)]
    deletes: BTreeSet<PathBuf>,
    #[serde(default)]
    renames: BTreeMap<PathBuf, PathBuf>,
}

#[derive(Debug, Clone)]
pub struct FormRow {
    pub document_path: PathBuf,
    pub path: String,
    pub value: String,
    pub kind: String,
    pub(crate) locator: Vec<FormPathToken>,
    pub(crate) edit_kind: FormRowEditKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FormRowEditKind {
    Scalar,
    LinkedMarkdown,
}

impl ConfigState {
    pub fn selected_document(&self) -> Option<&ConfigDocument> {
        self.documents.get(self.selected)
    }

    pub fn selected_document_mut(&mut self) -> Option<&mut ConfigDocument> {
        self.documents.get_mut(self.selected)
    }

    pub fn selected_domain(&self) -> ConfigDomain {
        ConfigDomain::ALL
            .get(self.selected_domain)
            .copied()
            .unwrap_or(ConfigDomain::Project)
    }

    pub fn domain_resources(&self) -> impl Iterator<Item = &ConfigResource> {
        let domain = self.selected_domain();
        self.resources
            .iter()
            .filter(move |resource| resource.domain == domain)
    }

    pub fn domain_resource_count(&self) -> usize {
        self.domain_resources().count()
    }

    pub fn selected_resource(&self) -> Option<&ConfigResource> {
        self.domain_resources().nth(self.selected_resource)
    }

    pub fn select_domain(&mut self, delta: isize) {
        let selected = self
            .selected_domain
            .saturating_add_signed(delta)
            .min(ConfigDomain::ALL.len().saturating_sub(1));
        self.select_domain_index(selected);
    }

    pub fn select_domain_index(&mut self, index: usize) {
        self.linked_document_editor = None;
        self.selected_domain = index.min(ConfigDomain::ALL.len().saturating_sub(1));
        self.selected_resource = 0;
        self.sync_resource_selection();
    }

    pub fn select_resource(&mut self, delta: isize) {
        let selected = self
            .selected_resource
            .saturating_add_signed(delta)
            .min(self.domain_resource_count().saturating_sub(1));
        self.select_resource_index(selected);
    }

    pub fn select_resource_index(&mut self, index: usize) {
        self.linked_document_editor = None;
        self.selected_resource = index.min(self.domain_resource_count().saturating_sub(1));
        self.sync_resource_selection();
    }

    pub fn rebuild_projection(&mut self) {
        let selected_key = self
            .selected_resource()
            .map(|resource| resource.key.clone());
        self.resources = derive_resources(&self.documents);
        self.selected_domain = self
            .selected_domain
            .min(ConfigDomain::ALL.len().saturating_sub(1));
        let domain = self.selected_domain();
        self.selected_resource = selected_key
            .as_ref()
            .and_then(|key| {
                self.resources
                    .iter()
                    .filter(|resource| resource.domain == domain)
                    .position(|resource| &resource.key == key)
            })
            .unwrap_or_else(|| {
                self.selected_resource
                    .min(self.domain_resource_count().saturating_sub(1))
            });
        self.sync_resource_selection();
    }

    pub fn select_advanced_document(&mut self, path: &Path) {
        self.select_resource_for(ConfigDomain::Advanced, path, ConfigResourceKind::RawSource);
    }

    pub fn select_resource_for(
        &mut self,
        domain: ConfigDomain,
        path: &Path,
        kind: ConfigResourceKind,
    ) {
        self.linked_document_editor = None;
        self.selected_domain = domain.index();
        self.selected_resource = self
            .resources
            .iter()
            .filter(|resource| resource.domain == domain)
            .position(|resource| resource.document_path == path && resource.kind == kind)
            .unwrap_or_default();
        self.sync_resource_selection();
    }

    fn sync_resource_selection(&mut self) {
        let resource = self.selected_resource().cloned();
        if let Some(resource) = resource
            && let Some(index) = self
                .documents
                .iter()
                .position(|document| document.relative_path == resource.document_path)
        {
            self.selected = index;
        }
        self.rebuild_form();
    }

    pub(crate) fn linked_document_editor_active(&self) -> bool {
        self.linked_document_editor.is_some()
    }

    fn open_linked_document_editor(&mut self, document_path: &Path) -> anyhow::Result<()> {
        let linked = self.selected_resource().is_some_and(|resource| {
            resource
                .linked_documents
                .iter()
                .any(|document| document.document_path == document_path)
        });
        anyhow::ensure!(
            linked,
            "the selected resource does not own these instructions"
        );
        let index = self
            .documents
            .iter()
            .position(|document| document.relative_path == document_path)
            .ok_or_else(|| {
                anyhow::anyhow!("the referenced instructions document is unavailable")
            })?;
        anyhow::ensure!(
            self.documents[index]
                .relative_path
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("md"),
            "linked instructions must be a Markdown document"
        );
        self.selected = index;
        self.linked_document_editor = Some(document_path.to_path_buf());
        Ok(())
    }

    pub(crate) fn close_linked_document_editor(&mut self) {
        if self.linked_document_editor.take().is_some() {
            self.sync_resource_selection();
        }
    }

    pub fn rebuild_form(&mut self) {
        let selected_document_path = self
            .selected_document()
            .map(|document| document.relative_path.clone());
        let selected_resource = self
            .selected_resource()
            .filter(|resource| selected_document_path.as_ref() == Some(&resource.document_path))
            .cloned();
        self.form_rows = if let Some(resource) = selected_resource {
            if resource.is_raw_source() {
                Vec::new()
            } else {
                let mut rows =
                    guided_form_rows(&self.documents, &resource.document_path, &resource.locator);
                for linked in &resource.linked_locators {
                    rows.extend(guided_form_rows(
                        &self.documents,
                        &linked.document_path,
                        &linked.locator,
                    ));
                }
                if resource.kind == ConfigResourceKind::NativeAgent
                    && resource.linked_documents.len() == 1
                {
                    // One explicit persona prompt completely shadows the
                    // native developer-instruction fallback. Keep that raw
                    // TOML field in Advanced, while the semantic card shows
                    // the effective instruction body once.
                    rows.retain(|row| !row.path.ends_with(".developer_instructions"));
                }
                for linked in &resource.linked_documents {
                    if let Some(document) = self
                        .documents
                        .iter()
                        .find(|document| document.relative_path == linked.document_path)
                    {
                        rows.push(FormRow {
                            document_path: linked.document_path.clone(),
                            path: linked.semantic_path.clone(),
                            value: markdown_summary(&document.text),
                            kind: "markdown".to_owned(),
                            locator: Vec::new(),
                            edit_kind: FormRowEditKind::LinkedMarkdown,
                        });
                    }
                }
                if resource.domain == ConfigDomain::Agents {
                    rows.sort_by_key(agent_form_row_rank);
                } else if resource.kind == ConfigResourceKind::GatePolicy {
                    // Gate policies are authored as one strict compiler contract, but operators
                    // reason about them as a sequence: coverage, provider selection, readiness,
                    // then automatic evaluation. Keep the guided editor in that semantic order
                    // even when the source document uses a different serialization order.
                    rows.sort_by_key(gate_policy_form_row_rank);
                }
                rows
            }
        } else if self.resources.is_empty() {
            self.selected_document()
                .and_then(config_document_value)
                .map(|value| {
                    let mut rows = Vec::new();
                    let document_path = self
                        .selected_document()
                        .map(|document| document.relative_path.clone())
                        .unwrap_or_default();
                    flatten_yaml(&document_path, "$", &mut Vec::new(), &value, &mut rows);
                    rows
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        self.selected_form_row = self
            .selected_form_row
            .min(self.form_rows.len().saturating_sub(1));
    }
}

fn markdown_summary(text: &str) -> String {
    let lines = text.lines().count().max(1);
    let characters = text.chars().count();
    format!(
        "{lines} line{} · {characters} chars",
        if lines == 1 { "" } else { "s" }
    )
}

fn agent_form_row_rank(row: &FormRow) -> usize {
    let path = row.path.to_lowercase();
    if path.ends_with(".description") {
        0
    } else if row.edit_kind == FormRowEditKind::LinkedMarkdown
        || path.ends_with(".developer_instructions")
        || path.ends_with(".instructions")
    {
        1
    } else if path.ends_with(".model") {
        2
    } else if path.ends_with(".model_reasoning_effort") || path.ends_with(".reasoning_effort") {
        3
    } else if path.ends_with(".model_role") {
        4
    } else {
        5
    }
}

fn gate_policy_form_row_rank(row: &FormRow) -> usize {
    let path = row.path.to_lowercase();
    if path.ends_with(".description")
        || path.contains(".gate_node_types")
        || path.contains(".gate_subjects")
    {
        0
    } else if path.contains(".applicability.subject_node_types") {
        10
    } else if path.contains(".applicability.required_subject_node_types") {
        11
    } else if path.contains(".missing_gate_obligation_key_template") {
        12
    } else if path.contains(".obligation_key_template") {
        13
    } else if path.contains(".capability") {
        20
    } else if path.contains(".candidate")
        || path.contains(".selection")
        || path.contains(".rank")
        || path.contains(".tie_break")
    {
        30
    } else if path.contains(".applicability") {
        40
    } else if path.contains(".evaluation_targets") || path.contains(".context") {
        50
    } else if path.contains(".passing_receipt") || path.contains(".execution_ready") {
        60
    } else if path.contains(".auto_evaluate") {
        70
    } else {
        80
    }
}

fn guided_form_rows(
    documents: &[ConfigDocument],
    document_path: &Path,
    resource_locator: &[FormPathToken],
) -> Vec<FormRow> {
    documents
        .iter()
        .find(|document| document.relative_path == document_path)
        .and_then(config_document_value)
        .and_then(|value| {
            let selected = value_at_locator(&value, resource_locator)?;
            let mut rows = Vec::new();
            let mut locator = resource_locator.to_vec();
            flatten_yaml(
                document_path,
                &form_locator_path(resource_locator),
                &mut locator,
                selected,
                &mut rows,
            );
            rows.retain(|row| !guided_internal_locator(&row.locator));
            Some(rows)
        })
        .unwrap_or_default()
}

fn config_document_value(document: &ConfigDocument) -> Option<Value> {
    config_document_text_value(document, &document.text)
}

fn config_document_text_value(document: &ConfigDocument, text: &str) -> Option<Value> {
    let extension = document
        .source_path
        .extension()
        .and_then(|extension| extension.to_str());
    match extension {
        Some("md") => None,
        Some("toml") => toml::from_str::<toml::Value>(text)
            .ok()
            .and_then(|value| serde_json::to_value(value).ok()),
        _ => serde_yaml::from_str::<Value>(text).ok(),
    }
}

fn published_graph_options(config: &ConfigState) -> Option<Value> {
    config.documents.iter().find_map(|document| {
        if document.original.trim().is_empty() {
            return None;
        }
        let path = document.relative_path.to_string_lossy();
        if !path.starts_with("cockpit/") && !path.ends_with("cockpit.yaml") {
            return None;
        }
        let value = serde_yaml::from_str::<Value>(&document.original).ok()?;
        value
            .get("views")?
            .as_array()?
            .iter()
            .find(|view| {
                matches!(
                    view.get("kind").and_then(Value::as_str),
                    Some("graph" | "typed_tree")
                )
            })?
            .get("options")
            .cloned()
            .filter(|options| options.is_object())
    })
}

#[derive(Debug)]
pub struct ControlCenterModel {
    /// Directory supplied when the control center was launched.
    pub launch_root: PathBuf,
    /// Canonical repository root used for all Koni operations.
    pub root: PathBuf,
    pub mode: Mode,
    pub focus: Focus,
    pub detail_panel: Panel,
    pub overview_subject: OverviewSubject,
    pub ticket_tab: TicketTab,
    pub runs: Vec<RunData>,
    pub selected_run: usize,
    pub selected_ticket: usize,
    pub selected_question: usize,
    /// Choice highlighted inside the currently selected pending question.
    /// This cursor is shared with the answer modal.
    pub selected_question_option: usize,
    pub selected_agent: usize,
    /// Whether the Details panel is currently projecting the selected agent transcript.
    pub agent_chat_open: bool,
    /// Lines held above the live tail. Zero means follow new output automatically.
    pub agent_chat_scroll_from_bottom: usize,
    /// When present, history navigation is anchored to the start of the rendered
    /// conversation. Keeping this separate from the live-tail distance avoids an
    /// `usize::MAX` sentinel that could jump to the beginning but could not page
    /// forward again.
    pub agent_chat_scroll_from_top: Option<usize>,
    pub activity_scroll: usize,
    pub run_scroll: usize,
    pub ticket_scroll: usize,
    pub graph_scroll: usize,
    pub detail_scroll: usize,
    /// Compatibility cursor retained for older input/state projections. The
    /// current run Overview is one vertically scrollable composed document.
    pub detail_section: usize,
    pub activity_tick: u64,
    pub config: ConfigState,
    pub status: String,
    pub orchestration_running: bool,
    pub max_parallel: usize,
    pub unchained: bool,
    pub dialog: Option<Dialog>,
    suspended_dialog: Option<Dialog>,
    pub run_types: Vec<RunTypeOption>,
    /// Published project-level graph presentation. This is intentionally
    /// independent from a run's pinned compiler profile: changing the
    /// cockpit layout may redraw old runs, but can never change their graph,
    /// tickets, agents, or compiler behavior.
    project_graph_options: Option<Value>,
    /// Models and model-specific reasoning levels exposed by the installed Codex CLI.
    pub(crate) codex_models: CodexModelCatalog,
    pub default_run_type: String,
    pub run_type_intake: BTreeMap<String, Vec<IntakeFieldDraft>>,
    pub catalog_error: Option<String>,
    /// The compatibility catalog is readable, but conversion is always an explicit staged edit.
    pub legacy_migration_available: bool,
    agent_chat_cache: RefCell<AgentChatCache>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunTypeOption {
    /// Stable catalog key used when planning the run. Never render this as the label.
    pub id: String,
    pub title: String,
    pub description: String,
    pub planning_passes: usize,
    pub question_policy: String,
    pub max_parallel: Option<usize>,
    pub model_summary: Option<String>,
    pub stages: Vec<RunStageOption>,
    pub agents: BTreeMap<String, RunAgentSetting>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStageOption {
    pub id: String,
    pub title: String,
    pub kind: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunAgentSetting {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone)]
pub enum Dialog {
    Help(HelpTopic),
    NewRun(NewRunDraft),
    Approval(ApprovalDraft),
    AnswerQuestion(AnswerDraft),
    ActionPalette(ActionPalette),
    EditScalar(EditScalarDraft),
    ActionForm(ActionFormDraft),
    NewConfigDocument(NewConfigDocumentDraft),
    RenameConfigDocument(NewConfigDocumentDraft),
    RunTypeWizard(RunTypeWizardDraft),
    LegacyMigration(LegacyMigrationDraft),
    DeleteRun(DeleteRunDraft),
    MergeRun(MergeRunDraft),
}

#[derive(Debug, Clone)]
pub struct DeleteRunDraft {
    pub preview: RunDeletionPreview,
    /// Cancel, preserve branches, delete owned branches.
    pub selected: usize,
    pub confirm_owned_branches: bool,
    pub submitted: bool,
}

#[derive(Debug, Clone)]
pub struct MergeRunDraft {
    pub preview: RunPromotionPreview,
    pub submitted: bool,
}

#[derive(Debug, Clone)]
pub struct RunTypeTemplateDraft {
    pub label: String,
    pub description: String,
    pub(crate) document: RunTypeDocument,
}

#[derive(Debug, Clone)]
pub struct RunTypeWizardDraft {
    pub templates: Vec<RunTypeTemplateDraft>,
    pub selected_template: usize,
    pub title: String,
    pub slug: String,
    pub description: String,
    pub make_default: bool,
    /// 0 template, 1 title, 2 slug, 3 description, 4 default, 5 create.
    pub active_field: usize,
    pub slug_manually_edited: bool,
}

#[derive(Debug, Clone)]
pub struct LegacyMigrationDraft {
    pub profile_title: String,
}

impl RunTypeWizardDraft {
    pub fn sync_automatic_slug(&mut self) {
        if !self.slug_manually_edited {
            self.slug = slugify_run_type_title(&self.title);
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct NewConfigDocumentDraft {
    pub relative_path: String,
}

#[derive(Debug, Clone)]
pub struct NewRunDraft {
    pub operation_id: String,
    pub run_type: String,
    pub goal: String,
    /// Character offset within `goal`, never a byte offset.
    pub objective_cursor: usize,
    pub target_branch: String,
    pub target_branches: Vec<LocalBranchCandidate>,
    pub question_policy: String,
    pub max_parallel: usize,
    pub agent_roles: BTreeMap<String, RunAgentSetting>,
    pub overridden_fields: BTreeSet<String>,
    pub active_field: usize,
    /// First rendered pipeline row shown in the bounded New Run preview.
    ///
    /// The stage list is informational rather than another form control, so
    /// PageUp/PageDown move this viewport without disturbing `active_field`.
    /// Rows, rather than stage indices, keep every continuation of a wrapped
    /// custom stage title reachable at compact terminal sizes.
    pub stage_scroll: usize,
    pub intake_fields: Vec<IntakeFieldDraft>,
    pub submitted: bool,
}

impl NewRunDraft {
    pub fn move_objective_cursor_left(&mut self) {
        self.clamp_objective_cursor();
        self.objective_cursor = self.objective_cursor.saturating_sub(1);
    }

    pub fn move_objective_cursor_right(&mut self) {
        self.clamp_objective_cursor();
        self.objective_cursor = self
            .objective_cursor
            .saturating_add(1)
            .min(self.goal.chars().count());
    }

    pub fn move_objective_cursor_home(&mut self) {
        self.clamp_objective_cursor();
        let characters = self.goal.chars().collect::<Vec<_>>();
        self.objective_cursor = characters[..self.objective_cursor]
            .iter()
            .rposition(|character| *character == '\n')
            .map_or(0, |newline| newline + 1);
    }

    pub fn move_objective_cursor_end(&mut self) {
        self.clamp_objective_cursor();
        let characters = self.goal.chars().collect::<Vec<_>>();
        self.objective_cursor = characters[self.objective_cursor..]
            .iter()
            .position(|character| *character == '\n')
            .map_or(characters.len(), |newline| self.objective_cursor + newline);
    }

    pub fn move_objective_cursor_up(&mut self) {
        self.clamp_objective_cursor();
        let characters = self.goal.chars().collect::<Vec<_>>();
        let current_start = characters[..self.objective_cursor]
            .iter()
            .rposition(|character| *character == '\n')
            .map_or(0, |newline| newline + 1);
        if current_start == 0 {
            return;
        }
        let column = self.objective_cursor - current_start;
        let previous_end = current_start - 1;
        let previous_start = characters[..previous_end]
            .iter()
            .rposition(|character| *character == '\n')
            .map_or(0, |newline| newline + 1);
        self.objective_cursor = previous_start + column.min(previous_end - previous_start);
    }

    pub fn move_objective_cursor_down(&mut self) {
        self.clamp_objective_cursor();
        let characters = self.goal.chars().collect::<Vec<_>>();
        let current_start = characters[..self.objective_cursor]
            .iter()
            .rposition(|character| *character == '\n')
            .map_or(0, |newline| newline + 1);
        let current_end = characters[self.objective_cursor..]
            .iter()
            .position(|character| *character == '\n')
            .map_or(characters.len(), |newline| self.objective_cursor + newline);
        if current_end == characters.len() {
            return;
        }
        let column = self.objective_cursor - current_start;
        let next_start = current_end + 1;
        let next_end = characters[next_start..]
            .iter()
            .position(|character| *character == '\n')
            .map_or(characters.len(), |newline| next_start + newline);
        self.objective_cursor = next_start + column.min(next_end - next_start);
    }

    pub fn insert_objective_text(&mut self, text: &str) {
        self.clamp_objective_cursor();
        let byte_offset = char_offset_to_byte(&self.goal, self.objective_cursor);
        self.goal.insert_str(byte_offset, text);
        self.objective_cursor += text.chars().count();
    }

    pub fn backspace_objective(&mut self) {
        self.clamp_objective_cursor();
        if self.objective_cursor == 0 {
            return;
        }
        let start = char_offset_to_byte(&self.goal, self.objective_cursor - 1);
        let end = char_offset_to_byte(&self.goal, self.objective_cursor);
        self.goal.replace_range(start..end, "");
        self.objective_cursor -= 1;
    }

    pub fn delete_objective(&mut self) {
        self.clamp_objective_cursor();
        if self.objective_cursor == self.goal.chars().count() {
            return;
        }
        let start = char_offset_to_byte(&self.goal, self.objective_cursor);
        let end = char_offset_to_byte(&self.goal, self.objective_cursor + 1);
        self.goal.replace_range(start..end, "");
    }

    fn clamp_objective_cursor(&mut self) {
        self.objective_cursor = self.objective_cursor.min(self.goal.chars().count());
    }
}

#[derive(Debug, Clone)]
pub struct IntakeFieldDraft {
    pub id: String,
    pub label: String,
    pub description: String,
    pub field_type: String,
    pub required: bool,
    pub value: String,
    pub options: Vec<IntakeOptionDraft>,
}

#[derive(Debug, Clone)]
pub struct IntakeOptionDraft {
    pub label: String,
    pub value: Value,
}

impl Default for NewRunDraft {
    fn default() -> Self {
        Self {
            operation_id: new_operation_id(),
            run_type: "default".to_owned(),
            goal: String::new(),
            objective_cursor: 0,
            target_branch: "HEAD".to_owned(),
            target_branches: Vec::new(),
            question_policy: "interactive".to_owned(),
            max_parallel: 1,
            agent_roles: BTreeMap::new(),
            overridden_fields: BTreeSet::new(),
            active_field: 0,
            stage_scroll: 0,
            intake_fields: Vec::new(),
            submitted: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ApprovalDraft {
    pub run_id: String,
    pub goal: String,
    pub run_type_title: String,
    pub sections: Vec<ApprovalSection>,
    pub selected_section: usize,
    pub scroll: usize,
    /// The one primary action owns Enter. Its label and command are derived
    /// from whether the steering editor contains instructions.
    pub action_focused: bool,
    /// The multiline steering editor owns keyboard input.
    pub revision_focused: bool,
    pub revision: String,
    /// Character offset within `revision`, never a byte offset.
    pub revision_cursor: usize,
    pub approval_enabled: bool,
    pub blockers: Vec<String>,
    pub submitted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalSection {
    pub title: String,
    pub body: String,
}

impl ApprovalDraft {
    pub fn selected_section(&self) -> Option<&ApprovalSection> {
        self.sections.get(self.selected_section)
    }

    pub fn cycle_section(&mut self, delta: isize) {
        if self.sections.is_empty() {
            self.selected_section = 0;
            self.scroll = 0;
            return;
        }
        self.selected_section = (self.selected_section as isize + delta)
            .rem_euclid(self.sections.len() as isize) as usize;
        self.scroll = 0;
        self.action_focused = false;
        self.revision_focused = false;
    }

    pub fn scroll_by(&mut self, delta: isize) {
        self.scroll = self.scroll.saturating_add_signed(delta);
        self.action_focused = false;
        self.revision_focused = false;
    }

    pub fn move_revision_cursor_left(&mut self) {
        self.clamp_revision_cursor();
        self.revision_cursor = self.revision_cursor.saturating_sub(1);
    }

    pub fn move_revision_cursor_right(&mut self) {
        self.clamp_revision_cursor();
        self.revision_cursor = self
            .revision_cursor
            .saturating_add(1)
            .min(self.revision.chars().count());
    }

    pub fn move_revision_cursor_home(&mut self) {
        self.clamp_revision_cursor();
        let characters = self.revision.chars().collect::<Vec<_>>();
        self.revision_cursor = characters[..self.revision_cursor]
            .iter()
            .rposition(|character| *character == '\n')
            .map_or(0, |newline| newline + 1);
    }

    pub fn move_revision_cursor_end(&mut self) {
        self.clamp_revision_cursor();
        let characters = self.revision.chars().collect::<Vec<_>>();
        self.revision_cursor = characters[self.revision_cursor..]
            .iter()
            .position(|character| *character == '\n')
            .map_or(characters.len(), |newline| self.revision_cursor + newline);
    }

    pub fn move_revision_cursor_up(&mut self) {
        self.clamp_revision_cursor();
        let characters = self.revision.chars().collect::<Vec<_>>();
        let current_start = characters[..self.revision_cursor]
            .iter()
            .rposition(|character| *character == '\n')
            .map_or(0, |newline| newline + 1);
        if current_start == 0 {
            return;
        }
        let column = self.revision_cursor - current_start;
        let previous_end = current_start - 1;
        let previous_start = characters[..previous_end]
            .iter()
            .rposition(|character| *character == '\n')
            .map_or(0, |newline| newline + 1);
        self.revision_cursor = previous_start + column.min(previous_end - previous_start);
    }

    pub fn move_revision_cursor_down(&mut self) {
        self.clamp_revision_cursor();
        let characters = self.revision.chars().collect::<Vec<_>>();
        let current_start = characters[..self.revision_cursor]
            .iter()
            .rposition(|character| *character == '\n')
            .map_or(0, |newline| newline + 1);
        let current_end = characters[self.revision_cursor..]
            .iter()
            .position(|character| *character == '\n')
            .map_or(characters.len(), |newline| self.revision_cursor + newline);
        if current_end == characters.len() {
            return;
        }
        let column = self.revision_cursor - current_start;
        let next_start = current_end + 1;
        let next_end = characters[next_start..]
            .iter()
            .position(|character| *character == '\n')
            .map_or(characters.len(), |newline| next_start + newline);
        self.revision_cursor = next_start + column.min(next_end - next_start);
    }

    pub fn insert_revision_text(&mut self, text: &str) {
        self.clamp_revision_cursor();
        let byte_offset = char_offset_to_byte(&self.revision, self.revision_cursor);
        self.revision.insert_str(byte_offset, text);
        self.revision_cursor += text.chars().count();
    }

    pub fn backspace_revision(&mut self) {
        self.clamp_revision_cursor();
        if self.revision_cursor == 0 {
            return;
        }
        let start = char_offset_to_byte(&self.revision, self.revision_cursor - 1);
        let end = char_offset_to_byte(&self.revision, self.revision_cursor);
        self.revision.replace_range(start..end, "");
        self.revision_cursor -= 1;
    }

    pub fn delete_revision(&mut self) {
        self.clamp_revision_cursor();
        if self.revision_cursor == self.revision.chars().count() {
            return;
        }
        let start = char_offset_to_byte(&self.revision, self.revision_cursor);
        let end = char_offset_to_byte(&self.revision, self.revision_cursor + 1);
        self.revision.replace_range(start..end, "");
    }

    fn clamp_revision_cursor(&mut self) {
        self.revision_cursor = self.revision_cursor.min(self.revision.chars().count());
    }
}

#[derive(Debug, Clone)]
pub struct AnswerDraft {
    pub operation_id: String,
    pub run_id: String,
    pub question_id: String,
    pub prompt: String,
    pub context: String,
    pub options: Vec<(String, String, String, bool)>,
    pub selected: usize,
    pub custom: String,
    pub custom_active: bool,
    pub allow_custom: bool,
    pub pending_resume: bool,
    /// The answer is durable, but another member of the same planning batch
    /// still needs an answer before the bound session may resume.
    pub waiting_for_batch: bool,
    pub remaining_batch_questions: usize,
    pub batch_position: Option<(usize, usize)>,
    pub submitted: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ActionPalette {
    pub actions: Vec<String>,
    pub selected: usize,
    pub filter: String,
}

impl ActionPalette {
    pub fn filtered_actions(&self) -> Vec<&str> {
        let needle = self.filter.to_lowercase();
        self.actions
            .iter()
            .filter(|action| {
                needle.is_empty()
                    || action.to_lowercase().contains(&needle)
                    || action_search_terms(action).contains(&needle)
            })
            .map(String::as_str)
            .collect()
    }
}

fn action_search_terms(action: &str) -> &'static str {
    match action {
        "compile-full" => "compile project validate",
        "compile-ticket" => "compile selected ticket validate",
        "spawn-lead" => "start planning lead launch",
        "spawn-worker" => "start next worker launch",
        "context" => "prepare agent context materialize",
        "output" => "record step output results receipts",
        "review" => "review selected ticket gate evidence",
        "finish" => "finish selected ticket integrate",
        "steer" => "add steering guidance",
        "start" => "start selected ticket checkout",
        "report" => "build run report summary",
        "recover" => "recover runtime state stale worker lease repair",
        _ => "",
    }
}

#[derive(Debug, Clone)]
pub struct EditScalarDraft {
    pub document_path: PathBuf,
    pub path: String,
    pub value: String,
    pub kind: String,
    /// Character offset within `value`, never a byte offset.
    pub cursor: usize,
    pub(crate) locator: Vec<FormPathToken>,
}

impl EditScalarDraft {
    pub fn move_cursor_left(&mut self) {
        self.cursor = self
            .cursor
            .min(self.value.chars().count())
            .saturating_sub(1);
    }

    pub fn move_cursor_right(&mut self) {
        self.cursor = self
            .cursor
            .saturating_add(1)
            .min(self.value.chars().count());
    }

    pub fn move_cursor_home(&mut self) {
        self.cursor = 0;
    }

    pub fn move_cursor_end(&mut self) {
        self.cursor = self.value.chars().count();
    }

    pub fn insert_text(&mut self, text: &str) {
        self.clamp_cursor();
        let byte_offset = char_offset_to_byte(&self.value, self.cursor);
        self.value.insert_str(byte_offset, text);
        self.cursor += text.chars().count();
    }

    pub fn backspace(&mut self) {
        self.clamp_cursor();
        if self.cursor == 0 {
            return;
        }
        let start = char_offset_to_byte(&self.value, self.cursor - 1);
        let end = char_offset_to_byte(&self.value, self.cursor);
        self.value.replace_range(start..end, "");
        self.cursor -= 1;
    }

    pub fn delete(&mut self) {
        self.clamp_cursor();
        if self.cursor == self.value.chars().count() {
            return;
        }
        let start = char_offset_to_byte(&self.value, self.cursor);
        let end = char_offset_to_byte(&self.value, self.cursor + 1);
        self.value.replace_range(start..end, "");
    }

    fn clamp_cursor(&mut self) {
        self.cursor = self.cursor.min(self.value.chars().count());
    }
}

fn char_offset_to_byte(value: &str, offset: usize) -> usize {
    value
        .char_indices()
        .nth(offset)
        .map_or(value.len(), |(byte_offset, _)| byte_offset)
}

#[derive(Debug, Clone)]
pub struct ActionFormDraft {
    pub operation_id: String,
    pub run_id: String,
    pub action: String,
    pub params: Vec<ActionParamDraft>,
    pub selected: usize,
    pub execution_root: Option<PathBuf>,
    pub requires_ticket_worktree: bool,
    /// This action's configured recipe contains review.record, so the UI must
    /// launch the compiler-owned reviewer instead of collecting a verdict.
    pub configured_ticket_review: bool,
    pub submitted: bool,
}

impl ActionFormDraft {
    pub fn is_agent_guidance(&self) -> bool {
        self.action == "steer"
            && self
                .params
                .iter()
                .any(|param| param.id == "kind" && param.locked && param.value == "agent_chat")
    }

    pub fn select_agent_guidance_message(&mut self) {
        if let Some(index) = self.params.iter().position(|param| param.id == "message") {
            self.selected = index;
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActionParamDraft {
    pub id: String,
    pub description: String,
    pub value_type: String,
    pub required: bool,
    pub value: String,
    /// Context parameters are bound by the control center and must not drift from the checkout
    /// selected for execution.
    pub locked: bool,
}

fn provisional_matches_durable(provisional: &RunData, durable: &RunData) -> bool {
    let Some(provisional) = provisional.summary.as_ref() else {
        return false;
    };
    let Some(durable) = durable.summary.as_ref() else {
        return false;
    };
    provisional.goal == durable.goal
        && provisional.run_type == durable.run_type
        && provisional.target_branch == durable.target_branch
}

impl ControlCenterModel {
    pub fn load(root: &Path) -> anyhow::Result<Self> {
        let launch_root = root.canonicalize()?;
        let root = canonical_project_root(&launch_root)?;
        let config = load_config_state(&root)?;
        let project_graph_options = published_graph_options(&config);
        let (
            run_types,
            default_run_type,
            run_type_intake,
            catalog_error,
            legacy_migration_available,
        ) = match ProjectCatalogCompiler::compile(&root) {
            Ok(catalog) => {
                let legacy = matches!(catalog.source, ProjectCatalogSource::LegacyKoniToml { .. });
                (
                    run_type_options(&catalog),
                    catalog.document.default_run_type.clone(),
                    run_type_intake_schemas(&catalog),
                    None,
                    legacy,
                )
            }
            Err(error) => (
                Vec::new(),
                String::new(),
                BTreeMap::new(),
                Some(error.to_string()),
                false,
            ),
        };
        let mut model = Self {
            launch_root,
            root: root.clone(),
            mode: Mode::Operate,
            focus: Focus::Runs,
            detail_panel: Panel::Overview,
            overview_subject: OverviewSubject::Run,
            ticket_tab: TicketTab::Active,
            runs: Vec::new(),
            selected_run: 0,
            selected_ticket: 0,
            selected_question: 0,
            selected_question_option: 0,
            selected_agent: 0,
            agent_chat_open: false,
            agent_chat_scroll_from_bottom: 0,
            agent_chat_scroll_from_top: None,
            activity_scroll: 0,
            run_scroll: 0,
            ticket_scroll: 0,
            graph_scroll: 0,
            detail_scroll: 0,
            detail_section: DEFAULT_RUN_OVERVIEW_SECTION,
            activity_tick: 0,
            config,
            status: String::new(),
            orchestration_running: true,
            max_parallel: 3,
            unchained: false,
            dialog: None,
            suspended_dialog: None,
            run_types,
            project_graph_options,
            codex_models: CodexModelCatalog::available(),
            default_run_type,
            run_type_intake,
            catalog_error,
            legacy_migration_available,
            agent_chat_cache: RefCell::new(AgentChatCache::default()),
        };
        model.reload();
        model.reset_selected_question_option();
        if let Some(error) = &model.catalog_error {
            model.status =
                format!("catalog compilation failed: {error} · configuration remains editable");
        }
        Ok(model)
    }

    pub fn from_snapshot(root: PathBuf, snapshot: Value) -> Self {
        let mut model = Self {
            launch_root: root.clone(),
            root,
            mode: Mode::Operate,
            focus: Focus::Runs,
            detail_panel: Panel::Overview,
            overview_subject: OverviewSubject::Run,
            ticket_tab: TicketTab::Active,
            runs: vec![RunData::from_snapshot(snapshot)],
            selected_run: 0,
            selected_ticket: 0,
            selected_question: 0,
            selected_question_option: 0,
            selected_agent: 0,
            agent_chat_open: false,
            agent_chat_scroll_from_bottom: 0,
            agent_chat_scroll_from_top: None,
            activity_scroll: 0,
            run_scroll: 0,
            ticket_scroll: 0,
            graph_scroll: 0,
            detail_scroll: 0,
            detail_section: DEFAULT_RUN_OVERVIEW_SECTION,
            activity_tick: 0,
            config: ConfigState::default(),
            status: String::new(),
            orchestration_running: true,
            max_parallel: 3,
            unchained: false,
            dialog: None,
            suspended_dialog: None,
            run_types: vec![RunTypeOption {
                id: "default".to_owned(),
                title: "Legacy".to_owned(),
                description: "Compatibility workflow for this project.".to_owned(),
                planning_passes: 0,
                question_policy: "interactive".to_owned(),
                max_parallel: None,
                model_summary: None,
                stages: Vec::new(),
                agents: BTreeMap::new(),
            }],
            project_graph_options: None,
            codex_models: CodexModelCatalog::fallback(),
            default_run_type: "default".to_owned(),
            run_type_intake: BTreeMap::new(),
            catalog_error: None,
            legacy_migration_available: false,
            agent_chat_cache: RefCell::new(AgentChatCache::default()),
        };
        model.normalize_selection();
        model.reset_selected_question_option();
        model.sync_orchestration();
        model
    }

    pub fn reload(&mut self) {
        let selected_id = self
            .selected_run_data()
            .and_then(|data| data.summary.as_ref())
            .map(|summary| summary.id.clone());
        let snapshots = match project_snapshots(&self.root) {
            Ok(snapshots) => snapshots,
            Err(error) => {
                self.status = format!("refresh failed: {error}");
                return;
            }
        };
        self.runs = snapshots.into_iter().map(RunData::from_snapshot).collect();
        if let Some(selected_id) = selected_id {
            self.selected_run = self
                .runs
                .iter()
                .position(|run| {
                    run.summary.as_ref().map(|summary| &summary.id) == Some(&selected_id)
                })
                .unwrap_or(0);
        }
        self.status = if self.runs.is_empty() {
            "No runs yet — press n to start planning".to_owned()
        } else {
            "refreshed".to_owned()
        };
        self.normalize_selection();
        self.sync_orchestration();
    }

    pub fn insert_provisional_run(&mut self, intake: &NewRunDraft) {
        if self.runs.iter().any(|run| {
            run.provisional_operation_id.as_deref() == Some(intake.operation_id.as_str())
        }) {
            return;
        }
        let run_type = self
            .run_types
            .iter()
            .find(|run_type| run_type.id == intake.run_type);
        self.runs.push(RunData::provisional(intake, run_type));
        self.selected_run = self.runs.len().saturating_sub(1);
        self.selected_ticket = 0;
        self.selected_question = 0;
        self.selected_agent = 0;
        self.overview_subject = OverviewSubject::Run;
        self.focus = Focus::Runs;
        self.detail_scroll = 0;
    }

    pub fn remove_provisional_run(&mut self, operation_id: &str) {
        self.runs
            .retain(|run| run.provisional_operation_id.as_deref() != Some(operation_id));
        self.normalize_selection();
    }

    pub fn replace_runs_preserving_provisional(&mut self, snapshots: Vec<Value>) {
        let provisional = self
            .runs
            .iter()
            .filter(|run| run.is_provisional())
            .cloned()
            .collect::<Vec<_>>();
        let mut durable = snapshots
            .into_iter()
            .map(RunData::from_snapshot)
            .collect::<Vec<_>>();
        for pending in provisional {
            if !durable
                .iter()
                .any(|candidate| provisional_matches_durable(&pending, candidate))
            {
                durable.push(pending);
            }
        }
        self.runs = durable;
    }

    pub fn selected_run_data(&self) -> Option<&RunData> {
        self.runs.get(self.selected_run)
    }

    /// Resolve presentation separately from the immutable run snapshot.
    ///
    /// Compiler inputs remain pinned per run, while a project owner can tune
    /// graph layers, hierarchy, labels, and title visibility once and see the
    /// same visual language across historical and current runs.
    pub(crate) fn selected_graph_options(&self) -> Option<&Value> {
        self.project_graph_options.as_ref().or_else(|| {
            self.selected_run_data()
                .and_then(|run| run.graph_options.as_ref())
        })
    }

    pub fn selected_run_running(&self) -> bool {
        self.selected_run_data()
            .and_then(|run| run.snapshot.get("lifecycle"))
            .and_then(|lifecycle| lifecycle.get("running"))
            .and_then(Value::as_bool)
            .or_else(|| {
                self.selected_run_data()
                    .and_then(|run| run.orchestration.as_ref())
                    .and_then(|orchestration| orchestration.get("running"))
                    .and_then(Value::as_bool)
            })
            .unwrap_or(true)
    }

    pub fn selected_run_transition(&self) -> Option<&str> {
        self.selected_run_data()
            .and_then(|run| run.snapshot.get("lifecycle"))
            .and_then(|lifecycle| lifecycle.get("transition"))
            .and_then(Value::as_str)
    }

    pub fn mark_selected_run_transition(&mut self, running: bool) {
        let Some(run) = self.runs.get_mut(self.selected_run) else {
            return;
        };
        let mut lifecycle = run
            .snapshot
            .get("lifecycle")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        lifecycle["transition"] =
            Value::String(if running { "resuming" } else { "pausing" }.to_owned());
        run.snapshot["lifecycle"] = lifecycle;
    }

    pub fn apply_run_lifecycle_update(&mut self, update: &RunLifecycleUpdate) {
        let Some(run) = self.runs.iter_mut().find(|run| {
            run.summary.as_ref().map(|summary| summary.id.as_str()) == Some(update.run_id.as_str())
        }) else {
            return;
        };
        run.snapshot["lifecycle"] = serde_json::json!({
            "running": update.running,
            "draining": update.draining,
            "active_agents": update.active_agents,
            "run_status": update.run_status,
            "transition": if update.draining { Some("pausing") } else { None },
        });
        if let Some(summary) = run.summary.as_mut() {
            summary.active_agents = update.active_agents;
            summary.status = if update.draining {
                "pausing".to_owned()
            } else if update.running {
                update.run_status.clone()
            } else {
                "paused".to_owned()
            };
        }
    }

    pub fn open_run_deletion_preview(&mut self, preview: RunDeletionPreview) {
        self.dialog = Some(Dialog::DeleteRun(DeleteRunDraft {
            preview,
            selected: 0,
            confirm_owned_branches: false,
            submitted: false,
        }));
    }

    pub fn remove_run_data(&mut self, run_id: &str) {
        let Some(index) = self.runs.iter().position(|run| {
            run.summary.as_ref().map(|summary| summary.id.as_str()) == Some(run_id)
        }) else {
            return;
        };
        self.runs.remove(index);
        self.dialog = None;
        self.selected_run = self.selected_run.min(self.runs.len().saturating_sub(1));
        self.selected_ticket = 0;
        self.selected_question = 0;
        self.selected_question_option = 0;
        self.selected_agent = 0;
        self.close_agent_chat();
        self.activity_scroll = 0;
        self.graph_scroll = 0;
        self.detail_scroll = 0;
        self.detail_section = DEFAULT_RUN_OVERVIEW_SECTION;
        self.normalize_selection();
        self.sync_orchestration();
    }

    pub fn selected_pending_questions(&self) -> Vec<&Value> {
        self.selected_run_data()
            .map(RunData::pending_questions)
            .unwrap_or_default()
    }

    pub fn select_next_question(&mut self, delta: isize) {
        let count = self.selected_pending_questions().len();
        if count == 0 {
            self.selected_question = 0;
            self.selected_question_option = 0;
            return;
        }
        let previous = self.selected_question;
        self.selected_question = self
            .selected_question
            .saturating_add_signed(delta)
            .min(count - 1);
        if self.selected_question != previous {
            self.reset_selected_question_option();
        }
    }

    pub fn select_next_question_option(&mut self, delta: isize) {
        let questions = self.selected_pending_questions();
        let Some(question) = questions.get(self.selected_question).copied() else {
            self.selected_question_option = 0;
            return;
        };
        let can_revise = question_answer_is_revisable_pending(question)
            && question_batch_id(question).is_some_and(|batch_id| {
                questions.iter().any(|candidate| {
                    candidate.get("id") != question.get("id")
                        && question_batch_id(candidate) == Some(batch_id)
                        && question_accepts_answer(candidate)
                })
            });
        if !question_accepts_answer(question) && !can_revise {
            return;
        }
        let count = question_choice_count(question);
        if count == 0 {
            self.selected_question_option = 0;
            return;
        }
        self.selected_question_option = self
            .selected_question_option
            .saturating_add_signed(delta)
            .min(count - 1);
    }

    fn reset_selected_question_option(&mut self) {
        self.selected_question_option = self
            .selected_pending_questions()
            .get(self.selected_question)
            .map_or(0, |question| question_initial_choice(question));
    }

    pub fn select_next_open_question_after(&mut self, answered_question_id: &str) {
        let questions = self.selected_pending_questions();
        let Some(answered_index) = questions.iter().position(|question| {
            question.get("id").and_then(Value::as_str) == Some(answered_question_id)
        }) else {
            return;
        };
        let count = questions.len();
        if let Some(next) = (1..count).find_map(|offset| {
            let index = (answered_index + offset) % count;
            question_accepts_answer(questions[index]).then_some(index)
        }) {
            self.selected_question = next;
            self.reset_selected_question_option();
        }
    }

    pub fn select_next_agent(&mut self, delta: isize) {
        let count = self.selected_agent_summaries().len();
        if count == 0 {
            self.selected_agent = 0;
            self.close_agent_chat();
            return;
        }
        let selected = self
            .selected_agent
            .saturating_add_signed(delta)
            .min(count - 1);
        if selected != self.selected_agent {
            self.agent_chat_scroll_from_bottom = 0;
            self.agent_chat_scroll_from_top = None;
        }
        self.selected_agent = selected;
        self.agent_chat_open = true;
    }

    pub fn selected_agent_summaries(&self) -> Vec<AgentSummary> {
        let Some(run) = self.selected_run_data() else {
            return Vec::new();
        };
        let summaries = run.agent_summaries();
        if self.overview_subject == OverviewSubject::Run {
            return summaries;
        }
        let ticket_id = self
            .selected_ticket_value()
            .and_then(|ticket| ticket.get("id"))
            .and_then(Value::as_str);
        summaries
            .into_iter()
            .filter(|agent| agent.ticket_id.as_deref() == ticket_id)
            .collect()
    }

    pub fn selected_agent_key(&self) -> Option<String> {
        self.selected_agent_summaries()
            .get(self.selected_agent)
            .map(|agent| agent.key.clone())
    }

    pub fn restore_selected_agent(&mut self, key: Option<&str>) {
        let agents = self.selected_agent_summaries();
        if let Some(index) = key.and_then(|key| agents.iter().position(|agent| agent.key == key)) {
            self.selected_agent = index;
            return;
        }
        self.selected_agent = self.selected_agent.min(agents.len().saturating_sub(1));
        if agents.is_empty() {
            self.close_agent_chat();
        }
    }

    pub fn focus_agents(&mut self) {
        self.focus = Focus::Agents;
        if self.selected_agent_summaries().is_empty() {
            self.close_agent_chat();
        } else {
            self.agent_chat_open = true;
            self.agent_chat_scroll_from_bottom = 0;
            self.agent_chat_scroll_from_top = None;
        }
    }

    pub fn close_agent_chat(&mut self) {
        self.agent_chat_open = false;
        self.agent_chat_scroll_from_bottom = 0;
        self.agent_chat_scroll_from_top = None;
    }

    pub fn agent_chat_is_open(&self) -> bool {
        self.agent_chat_open
            && self
                .selected_agent_summaries()
                .get(self.selected_agent)
                .is_some()
    }

    pub fn scroll_agent_chat(&mut self, delta: isize) {
        if let Some(from_top) = self.agent_chat_scroll_from_top.as_mut() {
            *from_top = from_top.saturating_add_signed(delta);
            return;
        }
        if delta < 0 {
            self.agent_chat_scroll_from_bottom = self
                .agent_chat_scroll_from_bottom
                .saturating_add(delta.unsigned_abs());
        } else {
            self.agent_chat_scroll_from_bottom = self
                .agent_chat_scroll_from_bottom
                .saturating_sub(delta.unsigned_abs());
        }
    }

    pub fn scroll_agent_chat_to_start(&mut self) {
        self.agent_chat_scroll_from_top = Some(0);
        self.agent_chat_scroll_from_bottom = 0;
    }

    pub fn scroll_agent_chat_to_end(&mut self) {
        self.agent_chat_scroll_from_top = None;
        self.agent_chat_scroll_from_bottom = 0;
    }

    pub(crate) fn selected_agent_chat_render(&self, width: u16) -> Option<AgentChatRender> {
        let agent = self
            .selected_agent_summaries()
            .get(self.selected_agent)
            .cloned()?;
        let guidance = self
            .selected_run_data()
            .into_iter()
            .flat_map(|run| run.events.iter())
            .filter(|event| {
                event.get("type").and_then(Value::as_str) == Some("compiler.steering.recorded")
                    && event
                        .get("data")
                        .and_then(|data| data.get("kind"))
                        .and_then(Value::as_str)
                        == Some("agent_chat")
            })
            .filter(|event| {
                let ticket = event
                    .get("ticket_id")
                    .or_else(|| event.get("data").and_then(|data| data.get("ticket_id")))
                    .and_then(Value::as_str)
                    .filter(|ticket| !ticket.trim().is_empty());
                ticket == agent.ticket_id.as_deref()
            })
            .filter_map(|event| {
                event
                    .get("data")
                    .and_then(|data| data.get("message"))
                    .and_then(Value::as_str)
                    .filter(|message| !message.trim().is_empty())
                    .map(ToOwned::to_owned)
            })
            .collect::<Vec<_>>();
        let request = AgentChatRequest {
            key: agent.key,
            // Agent records intentionally keep artifact paths relative to the compiler-owned run
            // root (`.git/koni/runs/<run>`), not the product checkout. Resolve that ownership
            // boundary before the renderer performs its canonical containment check.
            root: self.selected_agent_artifact_root(),
            transcript_path: agent.transcript.as_ref().map(|source| source.path.clone()),
            prompt_path: agent
                .transcript
                .as_ref()
                .and_then(|source| source.prompt_path.clone()),
            output_path: agent
                .transcript
                .as_ref()
                .and_then(|source| source.output_path.clone()),
            codex_session_id: agent
                .transcript
                .as_ref()
                .and_then(|source| source.codex_session_id.clone()),
            guidance,
            live: agent.live,
        };
        Some(self.agent_chat_cache.borrow_mut().render(&request, width))
    }

    fn selected_agent_artifact_root(&self) -> PathBuf {
        let Some(run_id) = self.selected_run_id() else {
            return self.root.clone();
        };
        GitBackend::discover(&self.root)
            .and_then(|git| git.sidecar_path(PathBuf::from("runs").join(run_id)))
            .ok()
            .filter(|root| root.is_dir())
            .unwrap_or_else(|| self.root.clone())
    }

    /// Build the friendly Agent-chat composer on top of the configured
    /// compiler-mediated steering action. A one-shot Codex worker cannot be
    /// mutated behind the broker's back, so this records durable guidance for
    /// the selected ticket (or run-level Lead) and the compiler projects it
    /// into the next authorized context boundary.
    pub fn agent_guidance_form(&self) -> Option<ActionFormDraft> {
        let agent = self
            .selected_agent_summaries()
            .get(self.selected_agent)
            .filter(|agent| agent.live)?
            .clone();
        let mut form = self.action_form("steer")?;
        for param in &mut form.params {
            match param.id.as_str() {
                "kind" => {
                    param.value = "agent_chat".to_owned();
                    param.locked = true;
                }
                "message" => {
                    param.value.clear();
                    param.locked = false;
                }
                "ticket" | "ticket_id" => {
                    param.value = agent.ticket_id.clone().unwrap_or_default();
                    param.locked = true;
                }
                "target_nodes" => {
                    param.value = "[]".to_owned();
                    param.locked = true;
                }
                "priority" => {
                    param.value = "normal".to_owned();
                    param.locked = true;
                }
                _ => param.locked = true,
            }
        }
        form.select_agent_guidance_message();
        Some(form)
    }

    pub fn advance_activity_animation(&mut self) {
        self.activity_tick = self.activity_tick.wrapping_add(1);
    }

    /// Whether the current projection contains a cue that represents active
    /// model work. Generic run status and pending tickets are deliberately not
    /// enough: animating those would imply token spend while a run is merely
    /// waiting or paused.
    pub fn has_live_activity_cue(&self) -> bool {
        self.runs.iter().any(|run| {
            run.provisional_operation_id.is_some()
                || run
                    .summary
                    .as_ref()
                    .is_some_and(|summary| summary.active_agents > 0)
        })
    }

    pub fn visible_tickets(&self) -> Vec<&Value> {
        self.selected_run_data()
            .map(|run| {
                run.tickets
                    .iter()
                    .filter(|ticket| self.ticket_tab.includes(ticket))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn selected_ticket_value(&self) -> Option<&Value> {
        self.visible_tickets().get(self.selected_ticket).copied()
    }

    pub fn selected_graph_values(&self) -> &[Value] {
        let Some(run) = self.selected_run_data() else {
            return &[];
        };
        if self.overview_subject == OverviewSubject::Run {
            return run.graph.as_slice();
        }
        let projected = self
            .selected_ticket_value()
            .and_then(|ticket| ticket.get("id"))
            .and_then(Value::as_str)
            .and_then(|ticket_id| run.ticket_graphs.get(ticket_id));
        projected.map_or(run.graph.as_slice(), Vec::as_slice)
    }

    pub fn selected_graph_is_ticket_projection(&self) -> bool {
        let Some(run) = self.selected_run_data() else {
            return false;
        };
        if self.overview_subject == OverviewSubject::Run {
            return false;
        }
        self.selected_ticket_value()
            .and_then(|ticket| ticket.get("id"))
            .and_then(Value::as_str)
            .is_some_and(|ticket_id| run.ticket_graphs.contains_key(ticket_id))
    }

    pub fn select_next_run(&mut self, delta: isize) {
        self.overview_subject = OverviewSubject::Run;
        self.close_agent_chat();
        if self.runs.is_empty() {
            return;
        }
        self.selected_run = self
            .selected_run
            .saturating_add_signed(delta)
            .min(self.runs.len() - 1);
        self.selected_ticket = 0;
        self.selected_question = 0;
        self.reset_selected_question_option();
        self.selected_agent = 0;
        self.activity_scroll = 0;
        self.graph_scroll = 0;
        self.detail_scroll = 0;
        self.detail_section = DEFAULT_RUN_OVERVIEW_SECTION;
        self.normalize_conditional_focus();
        self.sync_orchestration();
    }

    pub fn select_next_ticket(&mut self, delta: isize) {
        self.overview_subject = OverviewSubject::Ticket;
        self.selected_agent = 0;
        self.close_agent_chat();
        let count = self.visible_tickets().len();
        if count == 0 {
            self.selected_ticket = 0;
            return;
        }
        self.selected_ticket = self
            .selected_ticket
            .saturating_add_signed(delta)
            .min(count - 1);
        self.graph_scroll = 0;
        self.detail_scroll = 0;
    }

    pub fn cycle_ticket_tab(&mut self, delta: isize) {
        self.overview_subject = OverviewSubject::Ticket;
        self.selected_agent = 0;
        self.close_agent_chat();
        let current = TicketTab::ALL
            .iter()
            .position(|candidate| *candidate == self.ticket_tab)
            .unwrap_or(0);
        let next = wrap_index(current, delta, TicketTab::ALL.len());
        self.ticket_tab = TicketTab::ALL[next];
        self.selected_ticket = 0;
        self.ticket_scroll = 0;
    }

    pub fn cycle_detail_panel(&mut self, delta: isize) {
        if self.agent_chat_is_open() {
            return;
        }
        let current = Panel::ALL
            .iter()
            .position(|candidate| *candidate == self.detail_panel)
            .unwrap_or(0);
        self.select_detail_panel(Panel::ALL[wrap_index(current, delta, Panel::ALL.len())]);
    }

    pub fn select_detail_panel(&mut self, panel: Panel) {
        if self.agent_chat_is_open() {
            return;
        }
        self.detail_panel = panel;
        self.detail_scroll = 0;
        self.detail_section =
            if panel == Panel::Overview && self.overview_subject == OverviewSubject::Run {
                DEFAULT_RUN_OVERVIEW_SECTION
            } else {
                0
            };
    }

    pub fn run_overview_section_navigation(&self) -> bool {
        self.mode == Mode::Operate
            && self.focus == Focus::Details
            && !self.agent_chat_is_open()
            && self.detail_panel == Panel::Overview
            && self.overview_subject == OverviewSubject::Run
    }

    pub fn select_next_detail_section(&mut self, delta: isize) {
        const SECTION_COUNT: usize = 3;
        self.detail_section = self
            .detail_section
            .saturating_add_signed(delta)
            .min(SECTION_COUNT - 1);
        self.detail_scroll = 0;
    }

    pub fn cycle_focus(&mut self, backwards: bool) {
        let operate = [
            Focus::Runs,
            Focus::Tickets,
            Focus::Agents,
            Focus::Details,
            Focus::Activity,
            Focus::Graph,
        ];
        let operate_with_questions = [
            Focus::Runs,
            Focus::Tickets,
            Focus::Agents,
            Focus::Details,
            Focus::Questions,
            Focus::Activity,
            Focus::Graph,
        ];
        let configure = [Focus::ConfigTree, Focus::ConfigForm, Focus::Yaml];
        let configure_empty = [Focus::ConfigTree, Focus::ConfigForm];
        let choices = if self.mode == Mode::Operate {
            if self.selected_pending_questions().is_empty() {
                operate.as_slice()
            } else {
                operate_with_questions.as_slice()
            }
        } else if self.config.selected_resource().is_none() {
            configure_empty.as_slice()
        } else {
            configure.as_slice()
        };
        let current = choices
            .iter()
            .position(|candidate| *candidate == self.focus)
            .unwrap_or_else(|| {
                choices
                    .iter()
                    .position(|candidate| *candidate == Focus::Details)
                    .unwrap_or(0)
            });
        self.focus = choices[wrap_index(current, if backwards { -1 } else { 1 }, choices.len())];
        self.sync_overview_subject_to_focus();
        if self.focus == Focus::Agents {
            self.focus_agents();
        }
    }

    pub fn focus_runs(&mut self) {
        self.focus = Focus::Runs;
        self.overview_subject = OverviewSubject::Run;
        self.detail_section = DEFAULT_RUN_OVERVIEW_SECTION;
        self.selected_agent = 0;
        self.close_agent_chat();
    }

    pub fn focus_tickets(&mut self) {
        self.focus = Focus::Tickets;
        self.overview_subject = OverviewSubject::Ticket;
        self.detail_section = 0;
        self.selected_agent = 0;
        self.close_agent_chat();
    }

    fn sync_overview_subject_to_focus(&mut self) {
        match self.focus {
            Focus::Runs => {
                if self.overview_subject != OverviewSubject::Run {
                    self.selected_agent = 0;
                    self.detail_section = DEFAULT_RUN_OVERVIEW_SECTION;
                }
                self.overview_subject = OverviewSubject::Run;
                self.close_agent_chat();
            }
            Focus::Tickets => {
                if self.overview_subject != OverviewSubject::Ticket {
                    self.selected_agent = 0;
                    self.detail_section = 0;
                }
                self.overview_subject = OverviewSubject::Ticket;
                self.close_agent_chat();
            }
            _ => {}
        }
    }

    pub fn toggle_mode(&mut self) {
        self.config.close_linked_document_editor();
        self.mode = match self.mode {
            Mode::Operate => Mode::Configure,
            Mode::Configure => Mode::Operate,
        };
        self.focus = match self.mode {
            Mode::Operate => Focus::Runs,
            Mode::Configure => Focus::ConfigTree,
        };
        self.close_agent_chat();
        self.sync_overview_subject_to_focus();
    }

    pub fn open_new_run(&mut self) {
        if self.run_types.is_empty() {
            self.status = self.catalog_error.as_ref().map_or_else(
                || "no configured run types are available".to_owned(),
                |error| format!("cannot start a run until the catalog is valid: {error}"),
            );
            return;
        }
        let mut draft = NewRunDraft::default();
        draft.target_branches = match Engine::recent_target_branches(&self.root) {
            Ok(branches) if !branches.is_empty() => branches,
            Ok(_) => {
                self.status =
                    "no user-owned local branches are available for a run target".to_owned();
                return;
            }
            Err(error) => {
                self.status = format!("cannot discover run target branches: {error}");
                return;
            }
        };
        draft.target_branch = draft.target_branches[0].reference.clone();
        draft.run_type.clone_from(&self.default_run_type);
        if let Some(run_type) = self
            .run_types
            .iter()
            .find(|run_type| run_type.id == draft.run_type)
        {
            draft.question_policy.clone_from(&run_type.question_policy);
            draft.max_parallel = run_type.max_parallel.unwrap_or(1);
            draft.agent_roles.clone_from(&run_type.agents);
        }
        draft.intake_fields = self
            .run_type_intake
            .get(&draft.run_type)
            .cloned()
            .unwrap_or_default();
        self.dialog = Some(Dialog::NewRun(draft));
    }

    pub fn open_help(&mut self, topic: HelpTopic) {
        if matches!(self.dialog, Some(Dialog::Help(_))) {
            self.dialog = Some(Dialog::Help(topic));
            return;
        }
        self.suspended_dialog = self.dialog.take();
        self.dialog = Some(Dialog::Help(topic));
    }

    pub(crate) fn ordinary_dialog(&self) -> Option<&Dialog> {
        match &self.dialog {
            Some(Dialog::Help(_)) => self.suspended_dialog.as_ref(),
            dialog => dialog.as_ref(),
        }
    }

    pub(crate) fn ordinary_dialog_mut(&mut self) -> Option<&mut Dialog> {
        match &mut self.dialog {
            Some(Dialog::Help(_)) => self.suspended_dialog.as_mut(),
            dialog => dialog.as_mut(),
        }
    }

    pub(crate) fn dismiss_ordinary_dialog(&mut self) {
        if matches!(self.dialog, Some(Dialog::Help(_))) {
            self.suspended_dialog = None;
        } else {
            self.dialog = None;
            self.suspended_dialog = None;
        }
    }

    pub fn close_dialog(&mut self) {
        if matches!(self.dialog, Some(Dialog::Help(_))) {
            self.dialog = self.suspended_dialog.take();
        } else {
            if let Some(Dialog::AnswerQuestion(answer)) = &self.dialog {
                self.selected_question_option = answer.selected;
            }
            self.dialog = None;
            self.suspended_dialog = None;
        }
    }

    pub fn open_selected_run_approval(&mut self) {
        let Some(run) = self.selected_run_data() else {
            self.status = "no run selected".to_owned();
            return;
        };
        let Some(summary) = &run.summary else {
            self.status = "selected run has no manifest".to_owned();
            return;
        };
        if summary.status != "planning" {
            self.status = "only a planning run is awaiting approval".to_owned();
            return;
        }
        let run_type_title = self.display_run_type_title(summary);
        self.dialog = Some(Dialog::Approval(approval_draft(
            run,
            summary,
            run_type_title,
        )));
    }

    pub fn open_selected_run_merge(&mut self) {
        let Some(run_id) = self.selected_run_id().map(ToOwned::to_owned) else {
            self.status = "no run selected".to_owned();
            return;
        };
        match Engine::preview_run_promotion(&self.root, &run_id) {
            Ok(preview) => {
                self.dialog = Some(Dialog::MergeRun(MergeRunDraft {
                    preview,
                    submitted: false,
                }));
            }
            Err(error) => self.status = format!("merge unavailable: {error}"),
        }
    }

    pub fn open_form_editor(&mut self) {
        let Some(row) = self
            .config
            .form_rows
            .get(self.config.selected_form_row)
            .cloned()
        else {
            self.status = "no scalar field selected".to_owned();
            return;
        };
        if row.edit_kind == FormRowEditKind::LinkedMarkdown {
            match self.config.open_linked_document_editor(&row.document_path) {
                Ok(()) => {
                    self.status =
                        "editing agent instructions · Esc returns to the agent resource".to_owned();
                }
                Err(error) => self.status = error.to_string(),
            }
            return;
        }
        let cursor = row.value.chars().count();
        self.dialog = Some(Dialog::EditScalar(EditScalarDraft {
            document_path: row.document_path,
            path: row.path,
            value: row.value,
            kind: row.kind,
            cursor,
            locator: row.locator,
        }));
    }

    pub fn open_new_config_document(&mut self) {
        self.dialog = Some(Dialog::NewConfigDocument(NewConfigDocumentDraft::default()));
    }

    pub fn open_run_type_wizard(&mut self) {
        if self.legacy_migration_available {
            self.status =
                "convert the Legacy configuration first · press l in Configure".to_owned();
            return;
        }
        let catalog = match self.compile_draft_catalog_preview() {
            Ok(catalog) => catalog,
            Err(error) => {
                self.status =
                    format!("cannot create a run type until the catalog is valid: {error}");
                return;
            }
        };
        let templates = run_type_templates(&catalog);
        if templates.is_empty() {
            self.status = "no valid run-type template is available".to_owned();
            return;
        }
        self.dialog = Some(Dialog::RunTypeWizard(RunTypeWizardDraft {
            templates,
            selected_template: 0,
            title: String::new(),
            slug: String::new(),
            description: String::new(),
            make_default: false,
            active_field: 0,
            slug_manually_edited: false,
        }));
    }

    pub fn create_run_type_from_wizard(&mut self) -> anyhow::Result<()> {
        let draft = match self.dialog.as_ref() {
            Some(Dialog::RunTypeWizard(draft)) => draft.clone(),
            _ => anyhow::bail!("the run-type wizard is not open"),
        };
        let title = draft.title.trim();
        anyhow::ensure!(!title.is_empty(), "run-type title is required");
        validate_run_type_slug(&draft.slug)?;
        let slug = draft.slug.trim();
        let relative_path = PathBuf::from(format!("run-types/{slug}.yaml"));
        self.ensure_new_config_path_available(&relative_path)?;

        let project_index = self
            .config
            .documents
            .iter()
            .position(|document| document.relative_path == Path::new("project.yaml"))
            .ok_or_else(|| anyhow::anyhow!("project.yaml is not available in the draft set"))?;
        anyhow::ensure!(
            !self.config_document_deleted(&self.config.documents[project_index]),
            "project.yaml is staged for deletion"
        );
        let mut project: ProjectCatalogDocument =
            serde_yaml::from_str(&self.config.documents[project_index].text).map_err(|error| {
                anyhow::anyhow!("project.yaml is not structurally valid: {error}")
            })?;
        anyhow::ensure!(
            !project.run_types.iter().any(|entry| entry.id == slug),
            "a run type with this slug already exists"
        );
        anyhow::ensure!(
            !project
                .run_types
                .iter()
                .any(|entry| entry.path == relative_path),
            "a run type already uses {}",
            relative_path.display()
        );

        let template = draft
            .templates
            .get(draft.selected_template)
            .ok_or_else(|| anyhow::anyhow!("selected run-type template is unavailable"))?;
        let mut run_type = template.document.clone();
        run_type.id = slug.to_owned();
        run_type.title = title.to_owned();
        run_type.description =
            (!draft.description.trim().is_empty()).then(|| draft.description.trim().to_owned());
        run_type.extends = None;
        run_type.overrides.clear();

        project.run_types.push(RunTypeCatalogEntry {
            id: slug.to_owned(),
            path: relative_path.clone(),
        });
        if draft.make_default {
            project.default_run_type = slug.to_owned();
        }
        let project_text = serde_yaml::to_string(&project)?;
        let run_type_text = serde_yaml::to_string(&run_type)?;
        let new_document = self.prepared_new_config_document(&relative_path, run_type_text)?;
        let mut prepared_project = self.config.documents[project_index].clone();
        prepared_project.text = project_text;
        anyhow::ensure!(
            prepared_project.validate(),
            "generated project.yaml is invalid: {}",
            prepared_project.diagnostics.join("; ")
        );

        self.config.documents[project_index] = prepared_project;
        self.config.documents.push(new_document);
        self.config
            .documents
            .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        self.config.selected = self
            .config
            .documents
            .iter()
            .position(|document| document.relative_path == relative_path)
            .unwrap_or_default();
        self.config.rebuild_projection();
        self.config.select_resource_for(
            ConfigDomain::RunTypes,
            &relative_path,
            ConfigResourceKind::RunType,
        );
        self.focus = Focus::ConfigForm;
        self.dialog = None;
        self.status = format!(
            "{} run type staged · edit its policies, then Ctrl-P to validate and publish",
            title
        );
        Ok(())
    }

    pub fn open_legacy_migration(&mut self) {
        if !self.legacy_migration_available {
            self.status = "this project already uses the canonical YAML catalog".to_owned();
            return;
        }
        let title = ProjectCatalogCompiler::compile(&self.root)
            .map(|catalog| catalog.document.project.title)
            .unwrap_or_else(|_| "this project".to_owned());
        self.dialog = Some(Dialog::LegacyMigration(LegacyMigrationDraft {
            profile_title: title,
        }));
    }

    /// Convert the compiler's compatibility descriptor into coordinated drafts.
    /// Nothing in the live configuration is changed until the user publishes.
    pub fn stage_legacy_migration(&mut self) -> anyhow::Result<()> {
        let catalog = ProjectCatalogCompiler::compile(&self.root)?;
        let ProjectCatalogSource::LegacyKoniToml {
            manifest_path,
            migration,
        } = &catalog.source
        else {
            anyhow::bail!("this project already uses the canonical YAML catalog");
        };
        let config_root = self.root.join(".codex/koni");
        let legacy_relative = manifest_path
            .strip_prefix(&config_root)
            .map(Path::to_path_buf)
            .map_err(|_| anyhow::anyhow!("the Legacy manifest is outside .codex/koni"))?;
        let legacy_document = self
            .config
            .documents
            .iter()
            .find(|document| document.relative_path == legacy_relative)
            .ok_or_else(|| anyhow::anyhow!("the Legacy manifest is not available in Configure"))?;
        anyhow::ensure!(
            !legacy_document.dirty(),
            "save or discard edits to the Legacy manifest before converting it"
        );
        anyhow::ensure!(
            !self.config.pending_deletes.contains(&legacy_relative)
                && !self.config.pending_renames.contains_key(&legacy_relative),
            "restore the staged Legacy file operation before converting it"
        );

        let project_relative = migration_config_relative(&migration.canonical_project_path)?;
        let profile_relative = migration_config_relative(&migration.suggested_profile_source)?;
        let run_type_relative = migration_config_relative(&migration.canonical_run_type_path)?;
        for path in [&project_relative, &profile_relative, &run_type_relative] {
            self.ensure_new_config_path_available(path)?;
        }

        let legacy_text = fs::read_to_string(manifest_path)?;
        let profile: ProfileManifest = toml::from_str(&legacy_text)?;
        let staged = [
            (project_relative, serde_yaml::to_string(&migration.project)?),
            (profile_relative, serde_yaml::to_string(&profile)?),
            (
                run_type_relative,
                serde_yaml::to_string(&migration.run_type)?,
            ),
        ]
        .into_iter()
        .map(|(path, text)| self.prepared_new_config_document(&path, text))
        .collect::<anyhow::Result<Vec<_>>>()?;

        self.config.documents.extend(staged);
        self.config.pending_deletes.insert(legacy_relative);
        self.config
            .documents
            .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        self.config.selected = self
            .config
            .documents
            .iter()
            .position(|document| document.relative_path == Path::new("run-types/legacy.yaml"))
            .unwrap_or_default();
        self.config.rebuild_projection();
        self.config.select_resource_for(
            ConfigDomain::RunTypes,
            Path::new("run-types/legacy.yaml"),
            ConfigResourceKind::RunType,
        );
        self.focus = Focus::ConfigForm;
        self.dialog = None;
        self.status =
            "Legacy conversion staged · review the YAML, then Ctrl-P to validate and publish"
                .to_owned();
        Ok(())
    }

    fn ensure_new_config_path_available(&self, relative_path: &Path) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self
                .config
                .documents
                .iter()
                .any(|document| document.relative_path == relative_path),
            "configuration document already exists: {}",
            relative_path.display()
        );
        anyhow::ensure!(
            !active_config_root(&self.root).join(relative_path).exists(),
            "configuration document already exists: {}",
            relative_path.display()
        );
        Ok(())
    }

    fn prepared_new_config_document(
        &self,
        relative_path: &Path,
        text: String,
    ) -> anyhow::Result<ConfigDocument> {
        let source_path = active_config_root(&self.root).join(relative_path);
        let draft_path = config_draft_root(&self.root).join(relative_path);
        let mut document = ConfigDocument {
            relative_path: relative_path.to_path_buf(),
            source_path,
            draft_path,
            original: String::new(),
            text,
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: true,
        };
        anyhow::ensure!(
            document.validate(),
            "generated {} is invalid: {}",
            relative_path.display(),
            document.diagnostics.join("; ")
        );
        Ok(document)
    }

    pub fn open_rename_config_document(&mut self) {
        let Some(document) = self.config.selected_document() else {
            self.status = "no configuration document selected".to_owned();
            return;
        };
        self.dialog = Some(Dialog::RenameConfigDocument(NewConfigDocumentDraft {
            relative_path: document.relative_path.display().to_string(),
        }));
    }

    pub fn rename_config_document(&mut self, raw_path: &str) -> anyhow::Result<()> {
        let next = validated_config_relative_path(raw_path)?;
        let selected = self.config.selected;
        let current = self
            .config
            .documents
            .get(selected)
            .map(|document| document.relative_path.clone())
            .ok_or_else(|| anyhow::anyhow!("no configuration document selected"))?;
        anyhow::ensure!(
            current == next
                || !self
                    .config
                    .documents
                    .iter()
                    .any(|document| document.relative_path == next),
            "configuration document already exists: {}",
            next.display()
        );
        if current == next {
            return Ok(());
        }
        let draft_root = config_draft_root(&self.root);
        let original = self
            .config
            .pending_renames
            .iter()
            .find_map(|(from, to)| (to == &current).then(|| from.clone()))
            .unwrap_or_else(|| current.clone());
        self.config.pending_renames.remove(&original);
        if !self.config.documents[selected].is_new {
            self.config
                .pending_renames
                .insert(original.clone(), next.clone());
        }
        if self.config.pending_deletes.remove(&original) {
            self.config.pending_deletes.insert(original);
        }
        let document = &mut self.config.documents[selected];
        if document.draft_path.exists() {
            let next_draft = draft_root.join(&next);
            if let Some(parent) = next_draft.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&document.draft_path, &next_draft)?;
        }
        document.relative_path = next.clone();
        document.source_path = config_document_source_path(&self.root, &next);
        document.draft_path = draft_root.join(&next);
        self.config.rebuild_projection();
        self.config.select_advanced_document(&next);
        self.status = format!(
            "rename staged: {} → {} (Ctrl-P to validate/publish)",
            current.display(),
            next.display()
        );
        Ok(())
    }

    pub fn toggle_delete_config_document(&mut self) -> anyhow::Result<()> {
        let selected = self.config.selected;
        let Some(document) = self.config.documents.get(selected) else {
            anyhow::bail!("no configuration document selected");
        };
        if document.is_new {
            let draft = document.draft_path.clone();
            self.config.documents.remove(selected);
            if draft.exists() {
                fs::remove_file(draft)?;
            }
            self.config.selected = self
                .config
                .selected
                .min(self.config.documents.len().saturating_sub(1));
            self.config.rebuild_projection();
            self.status = "discarded unpublished configuration document".to_owned();
            return Ok(());
        }
        let current = document.relative_path.clone();
        let original = self
            .config
            .pending_renames
            .iter()
            .find_map(|(from, to)| (to == &current).then(|| from.clone()))
            .unwrap_or(current);
        if !self.config.pending_deletes.remove(&original) {
            self.config.pending_deletes.insert(original.clone());
            self.status = format!(
                "deletion staged for {} (press d to undo, Ctrl-P to publish)",
                original.display()
            );
        } else {
            self.status = format!("staged deletion restored: {}", original.display());
        }
        Ok(())
    }

    pub fn config_document_deleted(&self, document: &ConfigDocument) -> bool {
        let original = self
            .config
            .pending_renames
            .iter()
            .find_map(|(from, to)| (to == &document.relative_path).then_some(from))
            .unwrap_or(&document.relative_path);
        self.config.pending_deletes.contains(original)
    }

    pub fn create_config_document(&mut self, raw_path: &str) -> anyhow::Result<()> {
        let relative_path = PathBuf::from(raw_path.trim());
        let schema2 = active_config_root_relative(&self.root) == Path::new(".koni");
        anyhow::ensure!(
            !relative_path.as_os_str().is_empty()
                && !relative_path.is_absolute()
                && !relative_path
                    .components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
                && (!(relative_path.starts_with(Path::new(".codex"))
                    || relative_path.starts_with(Path::new(".agents")))
                    || native_config_relative_path(&relative_path)),
            "configuration path must be a contained relative path"
        );
        anyhow::ensure!(
            !schema2 || !codex_native_config_relative_path(&relative_path),
            "schema-2 Configure does not edit project Codex configuration or custom agents"
        );
        anyhow::ensure!(
            matches!(
                relative_path
                    .extension()
                    .and_then(|extension| extension.to_str()),
                Some("yaml" | "yml" | "md" | "toml")
            ),
            "new configuration documents must use .yaml, .yml, .md, or .toml"
        );
        anyhow::ensure!(
            !self
                .config
                .documents
                .iter()
                .any(|document| document.relative_path == relative_path),
            "configuration document already exists: {}",
            relative_path.display()
        );
        let source_path = config_document_source_path(&self.root, &relative_path);
        anyhow::ensure!(
            !source_path.exists(),
            "configuration document already exists: {}",
            relative_path.display()
        );
        let draft_root = git_common_dir(&self.root)
            .unwrap_or_else(|| self.root.join(".git"))
            .join("koni/config-drafts");
        let text = match relative_path.extension().and_then(|value| value.to_str()) {
            Some("md") => "# New instructions\n".to_owned(),
            Some("toml") => "# New configuration resource\n".to_owned(),
            _ if schema2 => "schema_version: \"2.0\"\n".to_owned(),
            _ => "schema_version: \"1.0\"\n".to_owned(),
        };
        let mut document = ConfigDocument {
            relative_path: relative_path.clone(),
            source_path,
            draft_path: draft_root.join(&relative_path),
            original: String::new(),
            text,
            diagnostics: Vec::new(),
            cursor_line: 1,
            cursor_column: 0,
            is_new: true,
        };
        let _ = document.validate();
        self.config.documents.push(document);
        self.config
            .documents
            .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        self.config.selected = self
            .config
            .documents
            .iter()
            .position(|document| document.relative_path == relative_path)
            .unwrap_or_default();
        self.config.rebuild_projection();
        self.config.select_advanced_document(&relative_path);
        self.focus = Focus::Yaml;
        self.dialog = None;
        self.status = format!(
            "created unpublished configuration draft: {}",
            relative_path.display()
        );
        Ok(())
    }

    pub fn open_action_palette(&mut self) {
        let actions = self.contextual_action_ids();
        if actions.is_empty() {
            self.status =
                "this cockpit view has no actions available for the current selection".to_owned();
            return;
        }
        self.dialog = Some(Dialog::ActionPalette(ActionPalette {
            actions,
            selected: 0,
            filter: String::new(),
        }));
    }

    pub fn action_form(&self, action_id: &str) -> Option<ActionFormDraft> {
        let run = self.selected_run_data()?;
        let action = run
            .actions
            .iter()
            .find(|action| action_matches_name(action, action_id))?;
        if !self.action_is_available(action) {
            return None;
        }
        let configured_ticket_review = action_is_configured_ticket_review(action);
        let selected_ticket = self
            .selected_ticket_value()
            .and_then(|ticket| ticket.get("id"))
            .and_then(Value::as_str);
        let requires_ticket_worktree = configured_ticket_review
            || action
                .get("requires_ticket_worktree")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        let params = action
            .get("params")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(id, _)| {
                !configured_ticket_review || matches!(id.as_str(), "ticket" | "ticket_id")
            })
            .map(|(id, definition)| {
                let locked =
                    matches!(id.as_str(), "ticket" | "ticket_id") && selected_ticket.is_some();
                let default = if locked {
                    selected_ticket.unwrap_or_default().to_owned()
                } else {
                    definition
                        .get("default")
                        .filter(|value| !value.is_null())
                        .map(scalar_text)
                        .unwrap_or_default()
                };
                ActionParamDraft {
                    id: id.clone(),
                    description: definition
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    value_type: definition
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("string")
                        .to_owned(),
                    required: definition
                        .get("required")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    value: default,
                    locked,
                }
            })
            .collect();
        Some(ActionFormDraft {
            operation_id: new_operation_id(),
            run_id: run.summary.as_ref()?.id.clone(),
            action: action_id.to_owned(),
            params,
            selected: 0,
            execution_root: requires_ticket_worktree
                .then(|| {
                    self.selected_ticket_value()?
                        .get("lease")?
                        .get("worktree")?
                        .as_str()
                        .map(PathBuf::from)
                })
                .flatten(),
            requires_ticket_worktree,
            configured_ticket_review,
            submitted: false,
        })
    }

    /// Actions shown in the palette come from the configured cockpit view under focus, not from
    /// the profile's complete low-level action catalog. Ticket-scoped actions are also withheld
    /// until the selected ticket satisfies their state and worktree requirements.
    fn contextual_action_ids(&self) -> Vec<String> {
        let Some(run) = self.selected_run_data() else {
            return Vec::new();
        };
        let configured = run
            .snapshot
            .get("views")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|view| cockpit_view_matches(view, self.focus, self.detail_panel))
            .flat_map(|view| {
                view.get("actions")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .filter_map(Value::as_str);
        let mut seen = BTreeSet::new();
        configured
            .filter_map(|id| {
                let action = run
                    .actions
                    .iter()
                    .find(|action| action_matches_name(action, id))?;
                let canonical_id = action.get("id").and_then(Value::as_str).unwrap_or(id);
                (seen.insert(canonical_id.to_owned()) && self.action_is_available(action))
                    .then_some(id.to_owned())
            })
            .collect()
    }

    fn action_is_available(&self, action: &Value) -> bool {
        let selected_ticket = self.selected_ticket_value();
        let requires_ticket_worktree = action_is_configured_ticket_review(action)
            || action
                .get("requires_ticket_worktree")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        let requires_ticket_parameter = action
            .get("params")
            .and_then(Value::as_object)
            .is_some_and(|params| {
                params.iter().any(|(id, definition)| {
                    matches!(id.as_str(), "ticket" | "ticket_id")
                        && definition
                            .get("required")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                })
            });
        let allowed_ticket_states = action
            .get("allowed_ticket_states")
            .and_then(Value::as_array);
        if (requires_ticket_worktree
            || requires_ticket_parameter
            || allowed_ticket_states.is_some_and(|states| !states.is_empty()))
            && selected_ticket.is_none()
        {
            return false;
        }
        if let Some(states) = allowed_ticket_states.filter(|states| !states.is_empty()) {
            let status = selected_ticket
                .and_then(|ticket| ticket.get("status"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !states.iter().any(|state| state.as_str() == Some(status)) {
                return false;
            }
        }
        !requires_ticket_worktree
            || selected_ticket
                .and_then(|ticket| ticket.get("lease"))
                .and_then(|lease| lease.get("worktree"))
                .and_then(Value::as_str)
                .is_some_and(|path| !path.trim().is_empty())
    }

    pub fn apply_form_edit(&mut self, edit: &EditScalarDraft) -> anyhow::Result<()> {
        let document_index = self
            .config
            .documents
            .iter()
            .position(|document| document.relative_path == edit.document_path)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "configuration document is no longer available: {}",
                    edit.document_path.display()
                )
            })?;
        let document = &mut self.config.documents[document_index];
        let is_toml = document
            .source_path
            .extension()
            .and_then(|extension| extension.to_str())
            == Some("toml");
        let mut value = config_document_value(document)
            .ok_or_else(|| anyhow::anyhow!("configuration document is not structurally valid"))?;
        let replacement = parse_scalar(&edit.value, &edit.kind)?;
        set_form_value(&mut value, &edit.locator, replacement)?;
        document.text = if is_toml {
            toml::to_string_pretty(&value)?
        } else {
            serde_yaml::to_string(&value)?
        };
        document.cursor_line = 0;
        document.cursor_column = 0;
        let _ = document.validate();
        self.config.selected = document_index;
        self.config.rebuild_projection();
        self.status =
            "updated setting · the touched configuration document was normalized".to_owned();
        Ok(())
    }

    pub fn open_first_question(&mut self) {
        self.open_pending_question(0);
    }

    pub fn open_selected_question(&mut self) {
        self.open_pending_question(self.selected_question);
    }

    pub fn open_pending_question(&mut self, index: usize) {
        let panel_selected =
            (self.selected_question == index).then_some(self.selected_question_option);
        let Some(question) = self
            .selected_run_data()
            .and_then(|run| run.pending_questions().get(index).copied())
            .cloned()
        else {
            self.status = "no open question for this run".to_owned();
            return;
        };
        self.selected_question = index;
        let options = question_options(&question);
        let allow_custom = question_allows_custom(&question);
        let batch_position = question_batch_position(&question);
        let unanswered_batch_members = question_batch_id(&question).map_or(0, |batch_id| {
            self.selected_run_data().map_or(0, |run| {
                run.questions
                    .iter()
                    .filter(|candidate| {
                        question_batch_id(candidate) == Some(batch_id)
                            && question_accepts_answer(candidate)
                    })
                    .count()
            })
        });
        let pending_resume = question_answer_is_pending_resume(&question);
        let stored_option = question
            .get("answer")
            .and_then(|answer| answer.get("option_id"))
            .and_then(Value::as_str);
        let stored_custom = question
            .get("answer")
            .and_then(|answer| answer.get("custom"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let stored_notes = question
            .get("answer")
            .and_then(|answer| answer.get("notes"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let choice_count = options.len() + usize::from(allow_custom);
        let selected = panel_selected
            .filter(|selected| *selected < choice_count)
            .or_else(|| {
                stored_option
                    .and_then(|stored| options.iter().position(|(id, _, _, _)| id == stored))
            })
            .or_else(|| {
                stored_custom
                    .as_ref()
                    .filter(|_| allow_custom)
                    .map(|_| options.len())
            })
            .unwrap_or_else(|| question_initial_choice(&question));
        self.selected_question_option = selected;
        let custom_active = stored_custom.is_some() && selected == options.len();
        let custom = stored_custom.or(stored_notes).unwrap_or_default();
        self.dialog = Some(Dialog::AnswerQuestion(AnswerDraft {
            operation_id: new_operation_id(),
            run_id: self
                .selected_run_data()
                .and_then(|run| run.summary.as_ref())
                .map(|summary| summary.id.clone())
                .unwrap_or_default(),
            question_id: question
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            prompt: question
                .get("prompt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            context: question
                .get("context")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            options,
            selected,
            custom_active,
            custom,
            allow_custom,
            pending_resume,
            waiting_for_batch: question_answer_is_revisable_pending(&question)
                && batch_position.is_some()
                && unanswered_batch_members > 0,
            remaining_batch_questions: unanswered_batch_members,
            batch_position,
            submitted: false,
        }));
    }

    pub fn select_config_document(&mut self, delta: isize) {
        if self.config.documents.is_empty() {
            return;
        }
        self.config.selected = self
            .config
            .selected
            .saturating_add_signed(delta)
            .min(self.config.documents.len() - 1);
        let path = self.config.documents[self.config.selected]
            .relative_path
            .clone();
        if self.config.resources.is_empty() {
            self.config.rebuild_form();
        } else {
            self.config.select_advanced_document(&path);
        }
    }

    pub fn save_config_draft(&mut self) -> anyhow::Result<()> {
        let label = {
            let Some(document) = self.config.selected_document_mut() else {
                return Ok(());
            };
            if let Some(parent) = document.draft_path.parent() {
                fs::create_dir_all(parent)?;
            }
            atomic_write(&document.draft_path, document.text.as_bytes())?;
            document.relative_path.display().to_string()
        };
        self.save_config_operations()?;
        self.status = format!("draft saved: {label}");
        Ok(())
    }

    /// Persist every in-memory configuration edit without publishing it.
    ///
    /// This is used during shutdown so a draft can be recovered on the next
    /// launch even when it is not yet valid enough to publish.
    pub fn save_all_config_drafts(&mut self) -> anyhow::Result<usize> {
        let pending = self
            .config
            .documents
            .iter()
            .enumerate()
            .filter(|(_, document)| document.dirty() || document.is_new)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        for index in &pending {
            let document = &self.config.documents[*index];
            if let Some(parent) = document.draft_path.parent() {
                fs::create_dir_all(parent)?;
            }
            atomic_write(&document.draft_path, document.text.as_bytes())?;
        }
        self.save_config_operations()?;
        let operation_count = self.config.pending_deletes.len() + self.config.pending_renames.len();
        if !pending.is_empty() || operation_count > 0 {
            self.status = format!(
                "autosaved {} configuration draft(s) and {} file operation(s)",
                pending.len(),
                operation_count
            );
        }
        Ok(pending.len())
    }

    pub fn unpublished_config_change_count(&self) -> usize {
        self.config
            .documents
            .iter()
            .filter(|document| document.dirty() || document.is_new)
            .count()
            + self.config.pending_deletes.len()
            + self.config.pending_renames.len()
    }

    /// Discard the complete project draft set and reload only published configuration.
    ///
    /// Publication is project-wide because files and semantic resources can reference one
    /// another. Discard follows the same boundary: reverting one projected card could otherwise
    /// erase unrelated edits in a shared YAML document or leave a linked persona prompt dangling.
    pub fn discard_all_config_drafts(&mut self) -> anyhow::Result<usize> {
        let changes = self.unpublished_config_change_count();
        if changes == 0 {
            self.status = "no unpublished configuration changes to discard".to_owned();
            return Ok(0);
        }

        let selected = self.config.selected_resource().cloned();
        let selected_domain = self.config.selected_domain();
        let draft_root = config_draft_root(&self.root);
        let backup_root = draft_root.with_file_name(format!(
            "config-drafts-discard-{}-{}",
            std::process::id(),
            NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed)
        ));
        if backup_root.exists() {
            fs::remove_dir_all(&backup_root)?;
        }
        if draft_root.exists() {
            fs::rename(&draft_root, &backup_root)?;
        }

        let reload = (|| -> anyhow::Result<_> {
            let mut config = load_config_state(&self.root)?;
            if let Some(resource) = &selected {
                config.select_resource_for(resource.domain, &resource.document_path, resource.kind);
            } else {
                config.select_domain_index(selected_domain.index());
            }
            let project_graph_options = published_graph_options(&config);
            let catalog_state = match ProjectCatalogCompiler::compile(&self.root) {
                Ok(catalog) => {
                    let legacy =
                        matches!(catalog.source, ProjectCatalogSource::LegacyKoniToml { .. });
                    (
                        run_type_options(&catalog),
                        catalog.document.default_run_type.clone(),
                        run_type_intake_schemas(&catalog),
                        None,
                        legacy,
                    )
                }
                Err(error) => (
                    Vec::new(),
                    String::new(),
                    BTreeMap::new(),
                    Some(error.to_string()),
                    false,
                ),
            };
            Ok((config, project_graph_options, catalog_state))
        })();

        let (config, project_graph_options, catalog_state) = match reload {
            Ok(reloaded) => reloaded,
            Err(error) => {
                if backup_root.exists() {
                    if draft_root.exists() {
                        let _ = fs::remove_dir_all(&draft_root);
                    }
                    let _ = fs::rename(&backup_root, &draft_root);
                }
                return Err(error).context("could not reload published configuration");
            }
        };

        self.config = config;
        self.project_graph_options = project_graph_options;
        self.run_types = catalog_state.0;
        self.default_run_type = catalog_state.1;
        self.run_type_intake = catalog_state.2;
        self.catalog_error = catalog_state.3;
        self.legacy_migration_available = catalog_state.4;
        let _ = fs::remove_dir_all(&backup_root);
        self.status = format!(
            "discarded {changes} unpublished configuration change{}",
            if changes == 1 { "" } else { "s" }
        );
        Ok(changes)
    }

    fn save_config_operations(&self) -> anyhow::Result<()> {
        let path = config_draft_root(&self.root).join(".operations.json");
        if self.config.pending_deletes.is_empty() && self.config.pending_renames.is_empty() {
            if path.exists() {
                fs::remove_file(path)?;
            }
            return Ok(());
        }
        let operations = ConfigDraftOperations {
            deletes: self.config.pending_deletes.clone(),
            renames: self.config.pending_renames.clone(),
        };
        atomic_write(&path, &serde_json::to_vec_pretty(&operations)?)
    }

    fn stage_config_candidate(&self, validation_root: &Path) -> anyhow::Result<()> {
        let deletes = &self.config.pending_deletes;
        let renames = &self.config.pending_renames;
        if validation_root.exists() {
            fs::remove_dir_all(validation_root)?;
        }
        let config_relative = active_config_root_relative(&self.root);
        let config_root = self.root.join(config_relative);
        let staged_config_root = validation_root.join(config_relative);
        copy_tree(&config_root, &staged_config_root)?;
        if config_relative != Path::new(".koni") {
            copy_tree(
                &self.root.join(".codex/agents"),
                &validation_root.join(".codex/agents"),
            )?;
        }
        copy_tree(
            &self.root.join(".agents/skills"),
            &validation_root.join(".agents/skills"),
        )?;
        for original in renames.keys().chain(deletes.iter()) {
            remove_optional_file(&staged_config_document_path(validation_root, original))?;
        }
        for document in &self.config.documents {
            if config_document_is_deleted(deletes, renames, document) {
                continue;
            }
            atomic_write(
                &staged_config_document_path(validation_root, &document.relative_path),
                document.text.as_bytes(),
            )?;
        }
        Ok(())
    }

    fn compile_draft_catalog_preview(&self) -> anyhow::Result<CompiledProjectCatalog> {
        let validation_root = config_draft_root(&self.root).join(format!(
            "preview-{}-{}",
            std::process::id(),
            NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let result = self
            .stage_config_candidate(&validation_root)
            .and_then(|()| ProjectCatalogCompiler::compile(&validation_root).map_err(Into::into));
        let _ = fs::remove_dir_all(&validation_root);
        result
    }

    pub fn publish_config(&mut self) -> anyhow::Result<()> {
        let deletes = self.config.pending_deletes.clone();
        let renames = self.config.pending_renames.clone();
        for document in &mut self.config.documents {
            if config_document_is_deleted(&deletes, &renames, document) {
                continue;
            }
            if !document.validate() {
                anyhow::bail!(
                    "{} has invalid configuration text: {}",
                    document.relative_path.display(),
                    document.diagnostics.join("; ")
                );
            }
        }
        let config_root = active_config_root(&self.root);
        let draft_root = config_draft_root(&self.root);
        let validation_root = draft_root.join(format!("validation-{}", std::process::id()));
        self.stage_config_candidate(&validation_root)?;
        let catalog = match ProjectCatalogCompiler::compile(&validation_root) {
            Ok(catalog) => catalog,
            Err(error) => {
                self.catalog_error = Some(error.to_string());
                let _ = fs::remove_dir_all(&validation_root);
                return Err(error.into());
            }
        };
        let mut validated_run_types = 0;
        for run_type in catalog.run_types.values() {
            if let Err(error) = ProfileCompiler::compile(&run_type.profile.resolved_path) {
                let _ = fs::remove_dir_all(&validation_root);
                return Err(error.into());
            }
            validated_run_types += 1;
        }

        let backup_root = draft_root.join(format!("publish-backup-{}", std::process::id()));
        if backup_root.exists() {
            fs::remove_dir_all(&backup_root)?;
        }
        copy_tree(&config_root, &backup_root)?;
        let native_backups =
            native_publish_backups(&self.root, &self.config.documents, &deletes, &renames)?;
        let publish = (|| -> anyhow::Result<()> {
            for original in renames.keys().chain(deletes.iter()) {
                remove_optional_file(&config_document_source_path(&self.root, original))?;
            }
            for document in &self.config.documents {
                if config_document_is_deleted(&deletes, &renames, document) {
                    continue;
                }
                atomic_write(
                    &config_document_source_path(&self.root, &document.relative_path),
                    document.text.as_bytes(),
                )?;
            }
            for original in &deletes {
                remove_optional_file(&draft_root.join(original))?;
                if let Some(renamed) = renames.get(original) {
                    remove_optional_file(&draft_root.join(renamed))?;
                }
            }
            Ok(())
        })();
        if let Err(error) = publish {
            let _ = fs::remove_dir_all(&config_root);
            let _ = copy_tree(&backup_root, &config_root);
            let _ = restore_native_publish_backups(&native_backups);
            return Err(error);
        }
        self.config
            .documents
            .retain(|document| !config_document_is_deleted(&deletes, &renames, document));
        for document in &mut self.config.documents {
            document.original.clone_from(&document.text);
            document.is_new = false;
            if document.draft_path.exists() {
                let _ = fs::remove_file(&document.draft_path);
            }
            document.source_path = config_document_source_path(&self.root, &document.relative_path);
            document.draft_path = draft_root.join(&document.relative_path);
        }
        self.config.pending_deletes.clear();
        self.config.pending_renames.clear();
        let _ = remove_optional_file(&draft_root.join(".operations.json"));
        let _ = fs::remove_dir_all(&validation_root);
        let _ = fs::remove_dir_all(&backup_root);
        self.run_types = run_type_options(&catalog);
        self.default_run_type = catalog.document.default_run_type.clone();
        self.run_type_intake = run_type_intake_schemas(&catalog);
        self.project_graph_options = published_graph_options(&self.config);
        self.catalog_error = None;
        self.legacy_migration_available = false;
        self.config.linked_document_editor = None;
        self.config.rebuild_projection();
        self.status = format!(
            "published configuration for future runs · {validated_run_types} run type{} validated",
            if validated_run_types == 1 { "" } else { "s" }
        );
        Ok(())
    }

    fn normalize_selection(&mut self) {
        self.selected_run = self.selected_run.min(self.runs.len().saturating_sub(1));
        self.selected_ticket = self
            .selected_ticket
            .min(self.visible_tickets().len().saturating_sub(1));
        self.selected_question = self
            .selected_question
            .min(self.selected_pending_questions().len().saturating_sub(1));
        self.selected_question_option = self.selected_question_option.min(
            self.selected_pending_questions()
                .get(self.selected_question)
                .map_or(0, |question| question_choice_count(question))
                .saturating_sub(1),
        );
        let agent_count = self.selected_agent_summaries().len();
        self.selected_agent = self.selected_agent.min(agent_count.saturating_sub(1));
        if agent_count == 0 {
            self.close_agent_chat();
        }
        self.normalize_conditional_focus();
    }

    /// Keep keyboard focus on a panel that is actually rendered. Pending Questions is conditional,
    /// so a refresh, run switch, or final answer may remove it while it owns focus.
    pub(crate) fn normalize_conditional_focus(&mut self) {
        if self.mode == Mode::Operate
            && self.focus == Focus::Questions
            && self.selected_pending_questions().is_empty()
        {
            self.focus = Focus::Details;
        }
    }

    pub fn selected_run_id(&self) -> Option<&str> {
        self.selected_run_data()
            .and_then(|run| run.summary.as_ref())
            .map(|summary| summary.id.as_str())
    }

    pub fn run_type_title(&self, id: &str) -> Option<&str> {
        self.run_types
            .iter()
            .find(|run_type| run_type.id == id)
            .map(|run_type| run_type.title.as_str())
    }

    pub fn display_run_type_title(&self, summary: &RunSummary) -> String {
        summary
            .run_type_title
            .as_deref()
            .filter(|title| !title.trim().is_empty())
            .or_else(|| {
                self.run_type_title(&summary.run_type)
                    .filter(|title| !title.trim().is_empty())
            })
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| humanize_identifier(&summary.run_type))
    }

    pub fn sync_orchestration(&mut self) {
        let state = self
            .selected_run_data()
            .and_then(|run| run.orchestration.as_ref())
            .cloned();
        if let Some(state) = state {
            self.orchestration_running = state
                .get("running")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            self.max_parallel = state
                .get("max_parallel")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(3);
            self.unchained = state
                .get("unchained")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        }
    }
}

fn cockpit_view_matches(view: &Value, focus: Focus, detail_panel: Panel) -> bool {
    let kind = view.get("kind").and_then(Value::as_str).unwrap_or_default();
    let id = view.get("id").and_then(Value::as_str).unwrap_or_default();
    match focus {
        Focus::Runs => matches!(kind, "summary" | "controls"),
        Focus::Tickets => {
            matches!(kind, "tabbed_table" | "kanban") || (kind == "table" && id.contains("ticket"))
        }
        Focus::Graph => matches!(kind, "graph" | "typed_tree"),
        Focus::Agents => kind == "status_overlay" || id.contains("agent"),
        Focus::Activity => matches!(kind, "summary" | "nested_detail") || id.contains("status"),
        Focus::Questions => kind == "nested_detail" || id.contains("question"),
        Focus::Details => match detail_panel {
            Panel::Overview => {
                matches!(kind, "nested_detail" | "report" | "summary")
                    || id.contains("detail")
                    || id.contains("report")
            }
            Panel::Planning | Panel::Stages => kind == "nested_detail" || id.contains("detail"),
        },
        Focus::ConfigTree | Focus::ConfigForm | Focus::Yaml => false,
    }
}

fn action_matches_name(action: &Value, name: &str) -> bool {
    action.get("id").and_then(Value::as_str) == Some(name)
        || action
            .get("aliases")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|alias| alias.as_str() == Some(name))
}

fn action_is_configured_ticket_review(action: &Value) -> bool {
    action
        .get("recipe")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|step| step.get("primitive").and_then(Value::as_str) == Some("review.record"))
}

fn run_type_intake_schemas(
    catalog: &CompiledProjectCatalog,
) -> BTreeMap<String, Vec<IntakeFieldDraft>> {
    catalog
        .run_types
        .iter()
        .map(|(id, run_type)| {
            let fields = run_type
                .intake
                .order
                .iter()
                .filter(|field_id| field_id.as_str() != "goal")
                .filter_map(|field_id| {
                    let field = run_type.intake.fields.get(field_id)?;
                    Some(IntakeFieldDraft {
                        id: field_id.clone(),
                        label: field.label.clone(),
                        description: field.description.clone().unwrap_or_default(),
                        field_type: serde_json::to_value(field.field_type)
                            .ok()
                            .and_then(|value| value.as_str().map(ToOwned::to_owned))
                            .unwrap_or_else(|| "string".to_owned()),
                        required: field.required,
                        value: field
                            .default
                            .as_ref()
                            .filter(|value| !value.is_null())
                            .map(scalar_text)
                            .unwrap_or_default(),
                        options: field
                            .options
                            .as_ref()
                            .into_iter()
                            .flatten()
                            .map(|value| IntakeOptionDraft {
                                label: scalar_text(value),
                                value: value.clone(),
                            })
                            .collect(),
                    })
                })
                .collect();
            (id.clone(), fields)
        })
        .collect()
}

fn run_type_templates(catalog: &CompiledProjectCatalog) -> Vec<RunTypeTemplateDraft> {
    let mut templates = Vec::new();
    let mut included = BTreeSet::new();
    for expected in ["Small", "Medium", "Large"] {
        if let Some(run_type) = catalog.run_types.values().find(|run_type| {
            run_type.title.eq_ignore_ascii_case(expected)
                || run_type.id.eq_ignore_ascii_case(expected)
        }) {
            included.insert(run_type.id.clone());
            templates.push(template_from_resolved(run_type));
        }
    }
    for run_type in catalog.run_types.values() {
        if included.insert(run_type.id.clone()) {
            templates.push(template_from_resolved(run_type));
        }
    }
    let blank_source = catalog
        .run_types
        .values()
        .find(|run_type| {
            run_type.title.eq_ignore_ascii_case("Small")
                || run_type.id.eq_ignore_ascii_case("Small")
        })
        .or_else(|| catalog.run_types.get(&catalog.document.default_run_type));
    if let Some(blank_source) = blank_source {
        templates.push(RunTypeTemplateDraft {
            label: "Blank".to_owned(),
            description:
                "A minimal working shell using this project's intake and lifecycle defaults."
                    .to_owned(),
            document: standalone_run_type_document(blank_source),
        });
    }
    templates
}

fn template_from_resolved(run_type: &ResolvedRunType) -> RunTypeTemplateDraft {
    RunTypeTemplateDraft {
        label: run_type.title.clone(),
        description: run_type.description.clone().unwrap_or_else(|| {
            "A standalone copy of this configured workflow and all of its policies.".to_owned()
        }),
        document: standalone_run_type_document(run_type),
    }
}

fn standalone_run_type_document(run_type: &ResolvedRunType) -> RunTypeDocument {
    RunTypeDocument {
        schema_version: run_type.schema_version.clone(),
        id: run_type.id.clone(),
        title: run_type.title.clone(),
        description: run_type.description.clone(),
        extends: None,
        profile: Some(ProfileSourceDef {
            source: run_type.profile.source.clone(),
        }),
        intake: Some(run_type.intake.clone()),
        pipeline: Some(run_type.pipeline.clone()),
        questions: Some(run_type.questions.clone()),
        git: Some(run_type.git.clone()),
        run_card: Some(run_type.run_card.clone()),
        agents: run_type.agents.clone(),
        orchestration: run_type.orchestration.clone(),
        promotion: run_type.promotion.clone(),
        planning: run_type.planning.clone(),
        instructions: run_type.instructions.clone(),
        overrides: Vec::new(),
    }
}

fn migration_config_relative(path: &Path) -> anyhow::Result<PathBuf> {
    path.strip_prefix(Path::new(".codex/koni"))
        .map(Path::to_path_buf)
        .map_err(|_| {
            anyhow::anyhow!(
                "compiler migration path is outside .codex/koni: {}",
                path.display()
            )
        })
}

pub(crate) fn slugify_run_type_title(title: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in title.trim().chars() {
        if character.is_ascii_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(character.to_ascii_lowercase());
            separator = false;
        } else {
            separator = true;
        }
    }
    slug.truncate(64);
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

fn validate_run_type_slug(slug: &str) -> anyhow::Result<()> {
    let slug = slug.trim();
    anyhow::ensure!(!slug.is_empty(), "run-type slug is required");
    anyhow::ensure!(
        slug.len() <= 64,
        "run-type slug may not exceed 64 characters"
    );
    anyhow::ensure!(
        slug.bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        "run-type slug may contain only lowercase letters, numbers, and hyphens"
    );
    anyhow::ensure!(
        !slug.starts_with('-') && !slug.ends_with('-') && !slug.contains("--"),
        "run-type slug must use single hyphens between words"
    );
    anyhow::ensure!(slug != LEGACY_RUN_TYPE_ID, "the slug `legacy` is reserved");
    Ok(())
}

fn run_type_options(catalog: &CompiledProjectCatalog) -> Vec<RunTypeOption> {
    catalog
        .run_types
        .values()
        .map(|run_type| {
            let compiled_profile = ProfileCompiler::compile(&run_type.profile.resolved_path).ok();
            let planning_passes = run_type
                .pipeline
                .stages
                .iter()
                .filter(|(id, stage)| {
                    id.to_ascii_lowercase().contains("plan")
                        || stage.kind.to_ascii_lowercase().contains("plan")
                })
                .count();
            let question_policy = serde_json::to_value(run_type.questions.policy)
                .ok()
                .and_then(|value| value.as_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| "interactive".to_owned());
            let profile_parallelism = compiled_profile
                .as_ref()
                .map(|profile| profile.manifest.orchestration.max_parallel);
            let max_parallel = run_type
                .orchestration
                .as_ref()
                .and_then(|orchestration| orchestration.max_parallel)
                .or(profile_parallelism);
            let model_summary = run_type.agents.as_ref().and_then(|agents| {
                let mut groups: Vec<(String, Vec<String>)> = Vec::new();
                for (role, settings) in &agents.roles {
                    let Some(model) = settings.model.as_deref() else {
                        continue;
                    };
                    let setting = settings
                        .effective_thinking_level()
                        .map_or_else(|| model.to_owned(), |level| format!("{model}/{level}"));
                    let role = run_type_role_label(role);
                    if let Some((_, roles)) = groups
                        .iter_mut()
                        .find(|(candidate, _)| candidate == &setting)
                    {
                        roles.push(role);
                    } else {
                        groups.push((setting, vec![role]));
                    }
                }
                (!groups.is_empty()).then(|| {
                    groups
                        .into_iter()
                        .map(|(setting, roles)| format!("{}: {setting}", roles.join(" + ")))
                        .collect::<Vec<_>>()
                        .join(" · ")
                })
            });
            let stages = run_type
                .pipeline
                .order
                .iter()
                .filter_map(|id| {
                    run_type
                        .pipeline
                        .stages
                        .get(id)
                        .map(|stage| RunStageOption {
                            id: id.clone(),
                            title: stage.title.clone(),
                            kind: stage.kind.clone(),
                        })
                })
                .collect();
            let agents = ["planner", "lead", "ticket_worker", "reviewer"]
                .into_iter()
                .map(|role| {
                    let run_setting = run_type
                        .agents
                        .as_ref()
                        .and_then(|agents| agents.roles.get(role));
                    let profile_setting = compiled_profile.as_ref().and_then(|profile| {
                        profile
                            .personas
                            .values()
                            .find(|persona| persona.model_role == role)
                    });
                    (
                        role.to_owned(),
                        RunAgentSetting {
                            model: run_setting
                                .and_then(|setting| setting.model.clone())
                                .or_else(|| {
                                    profile_setting.and_then(|persona| persona.model.clone())
                                }),
                            reasoning_effort: run_setting
                                .and_then(|setting| {
                                    setting.effective_thinking_level().map(str::to_owned)
                                })
                                .or_else(|| {
                                    profile_setting
                                        .and_then(|persona| persona.reasoning_effort.clone())
                                }),
                        },
                    )
                })
                .collect();
            RunTypeOption {
                id: run_type.id.clone(),
                title: run_type.title.clone(),
                description: run_type.description.clone().unwrap_or_default(),
                planning_passes,
                question_policy,
                max_parallel,
                model_summary,
                stages,
                agents,
            }
        })
        .collect()
}

fn run_type_role_label(role: &str) -> String {
    let role = role
        .replace("ticket_worker", "worker")
        .replace(['_', '-'], " ");
    let mut characters = role.chars();
    characters.next().map_or(role.clone(), |first| {
        first.to_uppercase().collect::<String>() + characters.as_str()
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DurableEntryKind {
    Missing,
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableEntryFingerprint {
    root_index: usize,
    relative_path: PathBuf,
    kind: DurableEntryKind,
    len: u64,
    readonly: bool,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    mode: u32,
    #[cfg(unix)]
    modified_seconds: i64,
    #[cfg(unix)]
    modified_nanoseconds: i64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DurableRunFingerprint(Vec<DurableEntryFingerprint>);

impl DurableRunFingerprint {
    /// Capture every durable compiler input beneath the supplied roots without parsing it.
    ///
    /// Koni publishes semantic state with atomic replacement or append+sync. Path identity,
    /// type, size, mtime, and (on Unix) inode/ctime therefore form a conservative generation
    /// boundary that is much cheaper than rebuilding graphs, tickets, receipts, reports, and
    /// transcripts. Only the top-level `locks` directory is omitted: it is transient process
    /// coordination state and is not consumed by `cockpit_snapshot`.
    fn capture(roots: &[PathBuf]) -> Option<Self> {
        let mut entries = Vec::new();
        for (root_index, root) in roots.iter().enumerate() {
            capture_durable_tree(root, root, root_index, &mut entries)?;
        }
        Some(Self(entries))
    }
}

fn capture_durable_tree(
    root: &Path,
    path: &Path,
    root_index: usize,
    output: &mut Vec<DurableEntryFingerprint>,
) -> Option<()> {
    let relative_path = path.strip_prefix(root).ok()?.to_path_buf();
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && relative_path.as_os_str().is_empty() =>
        {
            output.push(missing_durable_entry(root_index));
            return Some(());
        }
        Err(_) => return None,
    };
    let kind = if metadata.file_type().is_symlink() {
        DurableEntryKind::Symlink
    } else if metadata.is_file() {
        DurableEntryKind::File
    } else if metadata.is_dir() {
        DurableEntryKind::Directory
    } else {
        DurableEntryKind::Other
    };
    output.push(durable_entry_fingerprint(
        root_index,
        relative_path.clone(),
        kind,
        &metadata,
    ));
    if kind != DurableEntryKind::Directory {
        return Some(());
    }

    let mut children = fs::read_dir(path)
        .ok()?
        .map(|entry| entry.ok().map(|entry| entry.path()))
        .collect::<Option<Vec<_>>>()?;
    children.sort();
    for child in children {
        let child_relative = child.strip_prefix(root).ok()?;
        if child_relative.components().count() == 1
            && child.file_name().is_some_and(|name| name == "locks")
            && fs::symlink_metadata(&child).ok()?.is_dir()
        {
            continue;
        }
        capture_durable_tree(root, &child, root_index, output)?;
    }
    Some(())
}

fn missing_durable_entry(root_index: usize) -> DurableEntryFingerprint {
    DurableEntryFingerprint {
        root_index,
        relative_path: PathBuf::new(),
        kind: DurableEntryKind::Missing,
        len: 0,
        readonly: false,
        modified: None,
        created: None,
        #[cfg(unix)]
        device: 0,
        #[cfg(unix)]
        inode: 0,
        #[cfg(unix)]
        mode: 0,
        #[cfg(unix)]
        modified_seconds: 0,
        #[cfg(unix)]
        modified_nanoseconds: 0,
        #[cfg(unix)]
        changed_seconds: 0,
        #[cfg(unix)]
        changed_nanoseconds: 0,
    }
}

fn durable_entry_fingerprint(
    root_index: usize,
    relative_path: PathBuf,
    kind: DurableEntryKind,
    metadata: &fs::Metadata,
) -> DurableEntryFingerprint {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;

    DurableEntryFingerprint {
        root_index,
        relative_path,
        kind,
        len: metadata.len(),
        readonly: metadata.permissions().readonly(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(unix)]
        mode: metadata.mode(),
        #[cfg(unix)]
        modified_seconds: metadata.mtime(),
        #[cfg(unix)]
        modified_nanoseconds: metadata.mtime_nsec(),
        #[cfg(unix)]
        changed_seconds: metadata.ctime(),
        #[cfg(unix)]
        changed_nanoseconds: metadata.ctime_nsec(),
    }
}

#[derive(Debug, Clone)]
struct CachedProjectSnapshot {
    registration: RunRegistration,
    watch_roots: Vec<PathBuf>,
    fingerprint: DurableRunFingerprint,
    snapshot: Value,
}

#[derive(Debug, Default)]
pub(crate) struct ProjectSnapshotCache {
    entries: BTreeMap<String, CachedProjectSnapshot>,
}

#[derive(Debug)]
struct RegisteredSnapshotLoad {
    snapshot: Value,
    cacheable: bool,
}

impl RegisteredSnapshotLoad {
    fn valid(snapshot: Value) -> Self {
        Self {
            snapshot,
            cacheable: true,
        }
    }

    fn invalid(snapshot: Value) -> Self {
        Self {
            snapshot,
            cacheable: false,
        }
    }
}

pub(crate) fn project_snapshots(root: &Path) -> koni_core::Result<Vec<Value>> {
    project_snapshots_internal(root, None, None)
}

pub(crate) fn project_snapshots_cached(
    root: &Path,
    selected_run_id: Option<&str>,
    cache: &mut ProjectSnapshotCache,
) -> koni_core::Result<Vec<Value>> {
    project_snapshots_internal(root, selected_run_id, Some(cache))
}

fn project_snapshots_internal(
    root: &Path,
    selected_run_id: Option<&str>,
    mut cache: Option<&mut ProjectSnapshotCache>,
) -> koni_core::Result<Vec<Value>> {
    let Some(common_dir) = git_common_dir(root) else {
        if let Some(cache) = cache.as_deref_mut() {
            cache.entries.clear();
        }
        // Installation is intentionally configuration-only. A brand-new directory therefore
        // has no Git repository until the user submits the first run, at which point the engine
        // creates the baseline commit. Opening the control center before that remains read-only.
        return Ok(Vec::new());
    };
    let registry_exists = common_dir.join("koni/project.yaml").exists();
    if !registry_exists {
        if let Some(cache) = cache.as_deref_mut() {
            cache.entries.clear();
        }
        return match Engine::open(root) {
            Ok(engine) => engine.cockpit_snapshot().map(|snapshot| vec![snapshot]),
            Err(KoniError::NotFound(missing)) if missing == "active Koni run" => {
                // A configured project does not acquire runtime state merely because somebody
                // opens the control center. The first run is created explicitly from the TUI.
                Ok(Vec::new())
            }
            Err(error) => Err(error),
        };
    }

    let registry = Engine::project_registry(root)?;
    let mut snapshots = if let Some(cache) = cache {
        cached_registered_snapshots(
            root,
            &common_dir,
            &registry,
            selected_run_id,
            cache,
            |run_id, registration| load_registered_snapshot(root, run_id, registration),
        )
    } else {
        registry
            .runs
            .iter()
            .map(|(run_id, registration)| {
                load_registered_snapshot(root, run_id, registration).snapshot
            })
            .collect::<Vec<_>>()
    };
    sort_project_snapshots(&mut snapshots);
    Ok(snapshots)
}

fn cached_registered_snapshots<F>(
    _root: &Path,
    common_dir: &Path,
    registry: &ProjectRegistry,
    selected_run_id: Option<&str>,
    cache: &mut ProjectSnapshotCache,
    mut load: F,
) -> Vec<Value>
where
    F: FnMut(&str, &RunRegistration) -> RegisteredSnapshotLoad,
{
    cache
        .entries
        .retain(|run_id, _| registry.runs.contains_key(run_id));
    registry
        .runs
        .iter()
        .map(|(run_id, registration)| {
            let live = registration_status_is_live(&registration.status);
            let selected = selected_run_id == Some(run_id.as_str());
            if live {
                cache.entries.remove(run_id);
                return load(run_id, registration).snapshot;
            }

            let watch_roots = cache
                .entries
                .get(run_id)
                .filter(|entry| entry.registration == *registration)
                .map(|entry| entry.watch_roots.clone())
                .unwrap_or_else(|| {
                    registered_snapshot_watch_roots(common_dir, run_id, registration)
                });
            let before = DurableRunFingerprint::capture(&watch_roots);
            if !selected
                && let (Some(before), Some(entry)) = (before.as_ref(), cache.entries.get(run_id))
                && entry.registration == *registration
                && entry.watch_roots == watch_roots
                && &entry.fingerprint == before
            {
                return entry.snapshot.clone();
            }

            let loaded = load(run_id, registration);
            let after = DurableRunFingerprint::capture(&watch_roots);
            if loaded.cacheable
                && !snapshot_has_live_activity(&loaded.snapshot)
                && before.is_some()
                && before == after
                && let Some(fingerprint) = after
            {
                cache.entries.insert(
                    run_id.clone(),
                    CachedProjectSnapshot {
                        registration: registration.clone(),
                        watch_roots,
                        fingerprint,
                        snapshot: loaded.snapshot.clone(),
                    },
                );
            } else {
                cache.entries.remove(run_id);
            }
            loaded.snapshot
        })
        .collect()
}

fn snapshot_has_live_activity(snapshot: &Value) -> bool {
    snapshot
        .get("lifecycle")
        .and_then(|lifecycle| lifecycle.get("running"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || snapshot
            .get("lifecycle")
            .and_then(|lifecycle| lifecycle.get("active_agents"))
            .and_then(Value::as_u64)
            .is_some_and(|count| count > 0)
        || snapshot
            .get("lifecycle")
            .and_then(|lifecycle| lifecycle.get("draining"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || snapshot
            .get("agents")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|agent| {
                matches!(
                    agent
                        .get("status")
                        .or_else(|| agent.get("state"))
                        .and_then(Value::as_str),
                    Some("starting" | "running" | "resuming")
                )
            })
}

fn registration_status_is_live(status: &RunRegistrationStatus) -> bool {
    matches!(
        status,
        RunRegistrationStatus::Planning
            | RunRegistrationStatus::Approved
            | RunRegistrationStatus::Active
            | RunRegistrationStatus::Paused
    )
}

fn registered_snapshot_watch_roots(
    common_dir: &Path,
    run_id: &str,
    registration: &RunRegistration,
) -> Vec<PathBuf> {
    let run_root = common_dir.join("koni/runs").join(run_id);
    let mut roots = vec![run_root.clone()];
    let Some(integration_worktree) = registration.integration_worktree.as_ref() else {
        return roots;
    };
    let snapshot_root = run_root.join(&registration.config_snapshot_path);
    let Ok(catalog) = ProjectCatalogCompiler::compile(&snapshot_root) else {
        return roots;
    };
    let run_type = registration
        .run_type_id
        .as_deref()
        .and_then(|id| catalog.run_type(id))
        .unwrap_or_else(|| catalog.default_run_type());
    let Ok(profile) = ProfileCompiler::compile(&run_type.profile.resolved_path) else {
        return roots;
    };
    if profile.manifest.storage.backend == StorageBackend::Tracked {
        let state_parent = profile
            .manifest
            .storage
            .state_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        roots.push(integration_worktree.join(state_parent));
    }
    roots.sort();
    roots.dedup();
    roots
}

fn load_registered_snapshot(
    root: &Path,
    run_id: &str,
    registration: &RunRegistration,
) -> RegisteredSnapshotLoad {
    match Engine::open_run(root, run_id).and_then(|engine| engine.cockpit_snapshot()) {
        Ok(snapshot) => RegisteredSnapshotLoad::valid(snapshot),
        Err(error) => {
            RegisteredSnapshotLoad::invalid(invalid_registered_snapshot(root, registration, &error))
        }
    }
}

fn invalid_registered_snapshot(
    root: &Path,
    registration: &RunRegistration,
    error: &KoniError,
) -> Value {
    let run = serde_json::to_value(registration).unwrap_or(Value::Null);
    serde_json::json!({
        "schema_version": "1.0",
        "project_root": root,
        "run": run,
        "graph": [],
        "tickets": [],
        "questions": [],
        "stages": [],
        "agents": [],
        "external_loops": [],
        "external_repairs": [],
        "planning_transcript": [],
        "validation_errors": [error.to_string()],
    })
}

fn sort_project_snapshots(snapshots: &mut [Value]) {
    snapshots.sort_by(|left, right| {
        let left = left
            .get("run")
            .and_then(|run| run.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let right = right
            .get("run")
            .and_then(|run| run.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        right.cmp(left)
    });
}

fn canonical_project_root(root: &Path) -> anyhow::Result<PathBuf> {
    let root = root.canonicalize()?;
    let repository = git2_discover_root(&root).unwrap_or(root);
    if repository.join(".koni/project.yaml").is_file()
        || repository.join(".codex/koni/project.yaml").is_file()
        || repository.join("koni.toml").is_file()
    {
        return Ok(repository);
    }
    if let Some(common) = git_common_dir(&repository) {
        let registry = common.join("koni/project.yaml");
        if registry.exists() {
            let value: Value = serde_yaml::from_str(&fs::read_to_string(&registry)?)?;
            if let Some(project_root) = value.get("repository_root").and_then(Value::as_str) {
                return Ok(PathBuf::from(project_root).canonicalize()?);
            }
        }
    }
    Ok(repository)
}

fn git2_discover_root(root: &Path) -> Option<PathBuf> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(root)
        .output()
        .ok()?;
    output.status.success().then(|| {
        PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
            .canonicalize()
            .unwrap_or_else(|_| root.to_path_buf())
    })
}

fn load_config_state(root: &Path) -> anyhow::Result<ConfigState> {
    let config_root = active_config_root(root);
    let schema2 = config_root.ends_with(".koni");
    let draft_root = config_draft_root(root);
    let operations_path = draft_root.join(".operations.json");
    let operations = fs::read_to_string(&operations_path)
        .ok()
        .and_then(|text| serde_json::from_str::<ConfigDraftOperations>(&text).ok())
        .unwrap_or_default();
    let mut paths = Vec::new();
    collect_config_files(&config_root, &mut paths)?;
    let legacy = config_root.join("koni.toml");
    if legacy.exists() {
        paths.push(legacy);
    }
    if !schema2 {
        let codex_project_config = root.join(".codex/config.toml");
        if codex_project_config.exists() {
            paths.push(codex_project_config);
        }
        collect_config_files(&root.join(".codex/agents"), &mut paths)?;
    }
    collect_config_files(&root.join(".agents/skills"), &mut paths)?;
    let mut draft_paths = Vec::new();
    collect_config_files(&draft_root, &mut draft_paths)?;
    for draft_path in draft_paths {
        let Ok(relative_path) = draft_path.strip_prefix(&draft_root) else {
            continue;
        };
        if schema2 && codex_native_config_relative_path(relative_path) {
            continue;
        }
        if relative_path
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str())
            .is_some_and(|component| component.starts_with("validation-"))
        {
            continue;
        }
        let source_path = config_document_source_path(root, relative_path);
        if !source_path.exists()
            && !operations
                .renames
                .values()
                .any(|target| target == relative_path)
        {
            paths.push(source_path);
        }
    }
    paths.sort();
    paths.dedup();
    paths.retain(|source_path| {
        source_path.starts_with(&config_root)
            || source_path.strip_prefix(root).is_ok_and(|relative| {
                repository_skill_relative_path(relative)
                    || (!schema2 && codex_native_config_relative_path(relative))
            })
    });
    let mut documents = paths
        .into_iter()
        .map(|source_path| {
            let relative_path = source_path
                .strip_prefix(&config_root)
                .or_else(|_| source_path.strip_prefix(root))
                .unwrap_or(&source_path)
                .to_path_buf();
            let draft_path = draft_root.join(&relative_path);
            let is_new = !source_path.exists();
            let original = if is_new {
                String::new()
            } else {
                fs::read_to_string(&source_path)?
            };
            let text = fs::read_to_string(&draft_path).unwrap_or_else(|_| original.clone());
            let mut document = ConfigDocument {
                relative_path,
                source_path,
                draft_path,
                original,
                text,
                diagnostics: Vec::new(),
                cursor_line: 0,
                cursor_column: 0,
                is_new,
            };
            let _ = document.validate();
            Ok(document)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    for (from, to) in &operations.renames {
        if let Some(document) = documents
            .iter_mut()
            .find(|document| document.relative_path == *from)
        {
            document.relative_path = to.clone();
            document.source_path = config_document_source_path(root, to);
            document.draft_path = draft_root.join(to);
            if let Ok(text) = fs::read_to_string(&document.draft_path) {
                document.text = text;
                let _ = document.validate();
            }
        }
    }
    let selected = documents
        .iter()
        .position(|document| document.relative_path == Path::new("koni.toml"))
        .unwrap_or_default();
    let mut state = ConfigState {
        documents,
        selected,
        pending_deletes: operations.deletes,
        pending_renames: operations.renames,
        ..ConfigState::default()
    };
    state.rebuild_projection();
    Ok(state)
}

fn config_draft_root(root: &Path) -> PathBuf {
    git_common_dir(root)
        .unwrap_or_else(|| root.join(".git"))
        .join(if active_config_root_relative(root) == Path::new(".koni") {
            "koni/config-drafts-v2"
        } else {
            "koni/config-drafts"
        })
}

fn native_config_relative_path(path: &Path) -> bool {
    codex_native_config_relative_path(path) || repository_skill_relative_path(path)
}

fn codex_native_config_relative_path(path: &Path) -> bool {
    path == Path::new(".codex/config.toml")
        || (path.parent() == Some(Path::new(".codex/agents"))
            && path.extension().and_then(|extension| extension.to_str()) == Some("toml"))
}

fn repository_skill_relative_path(path: &Path) -> bool {
    path.strip_prefix(Path::new(".agents/skills"))
        .is_ok_and(|relative| relative.components().count() >= 2)
}

fn active_config_root_relative(root: &Path) -> &'static Path {
    if root.join(".koni").exists() {
        Path::new(".koni")
    } else {
        Path::new(".codex/koni")
    }
}

fn active_config_root(root: &Path) -> PathBuf {
    root.join(active_config_root_relative(root))
}

fn config_document_source_path(root: &Path, relative_path: &Path) -> PathBuf {
    if native_config_relative_path(relative_path) {
        root.join(relative_path)
    } else {
        active_config_root(root).join(relative_path)
    }
}

fn staged_config_document_path(validation_root: &Path, relative_path: &Path) -> PathBuf {
    if native_config_relative_path(relative_path) {
        validation_root.join(relative_path)
    } else {
        active_config_root(validation_root).join(relative_path)
    }
}

fn native_publish_backups(
    root: &Path,
    documents: &[ConfigDocument],
    deletes: &BTreeSet<PathBuf>,
    renames: &BTreeMap<PathBuf, PathBuf>,
) -> anyhow::Result<BTreeMap<PathBuf, Option<Vec<u8>>>> {
    let relative_paths = documents
        .iter()
        .map(|document| document.relative_path.clone())
        .chain(deletes.iter().cloned())
        .chain(renames.keys().cloned())
        .chain(renames.values().cloned())
        .filter(|path| native_config_relative_path(path))
        .collect::<BTreeSet<_>>();
    let mut backups = BTreeMap::new();
    for relative_path in &relative_paths {
        let path = root.join(relative_path);
        let content = if path.exists() {
            Some(fs::read(&path)?)
        } else {
            None
        };
        backups.insert(path, content);
    }
    Ok(backups)
}

fn restore_native_publish_backups(
    backups: &BTreeMap<PathBuf, Option<Vec<u8>>>,
) -> anyhow::Result<()> {
    for (path, content) in backups {
        if let Some(content) = content {
            atomic_write(path, content)?;
        } else {
            remove_optional_file(path)?;
        }
    }
    Ok(())
}

fn validated_config_relative_path(raw_path: &str) -> anyhow::Result<PathBuf> {
    let relative_path = PathBuf::from(raw_path.trim());
    anyhow::ensure!(
        !relative_path.as_os_str().is_empty()
            && !relative_path.is_absolute()
            && !relative_path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
            && (!(relative_path.starts_with(Path::new(".codex"))
                || relative_path.starts_with(Path::new(".agents")))
                || native_config_relative_path(&relative_path)),
        "configuration path must be a contained relative path"
    );
    anyhow::ensure!(
        matches!(
            relative_path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("yaml" | "yml" | "md" | "toml")
        ),
        "configuration documents must use .yaml, .yml, .md, or .toml"
    );
    Ok(relative_path)
}

fn git_common_dir(root: &Path) -> Option<PathBuf> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(root)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
}

fn collect_config_files(root: &Path, output: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_config_files(&path, output)?;
        } else if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("yaml" | "yml" | "md" | "toml")
        ) {
            output.push(path);
        }
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
    if !source.exists() {
        return Ok(());
    }
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if entry.file_type()?.is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn remove_optional_file(path: &Path) -> anyhow::Result<()> {
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn config_document_is_deleted(
    deletes: &BTreeSet<PathBuf>,
    renames: &BTreeMap<PathBuf, PathBuf>,
    document: &ConfigDocument,
) -> bool {
    let original = renames
        .iter()
        .find_map(|(from, to)| (to == &document.relative_path).then_some(from))
        .unwrap_or(&document.relative_path);
    deletes.contains(original)
}

fn flatten_yaml(
    document_path: &Path,
    path: &str,
    locator: &mut Vec<FormPathToken>,
    value: &Value,
    output: &mut Vec<FormRow>,
) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                locator.push(FormPathToken::Key(key.clone()));
                flatten_yaml(
                    document_path,
                    &format!("{path}.{key}"),
                    locator,
                    value,
                    output,
                );
                locator.pop();
            }
        }
        Value::Array(items) => {
            for (index, value) in items.iter().enumerate() {
                locator.push(FormPathToken::Index(index));
                flatten_yaml(
                    document_path,
                    &format!("{path}[{index}]"),
                    locator,
                    value,
                    output,
                );
                locator.pop();
            }
        }
        value => output.push(FormRow {
            document_path: document_path.to_path_buf(),
            path: path.to_owned(),
            value: scalar_text(value),
            kind: value_kind(value).to_owned(),
            locator: locator.clone(),
            edit_kind: FormRowEditKind::Scalar,
        }),
    }
}

fn value_at_locator<'a>(root: &'a Value, locator: &[FormPathToken]) -> Option<&'a Value> {
    locator.iter().try_fold(root, |value, token| match token {
        FormPathToken::Key(key) => value.as_object()?.get(key),
        FormPathToken::Index(index) => value.as_array()?.get(*index),
    })
}

fn form_locator_path(locator: &[FormPathToken]) -> String {
    let mut path = "$".to_owned();
    for token in locator {
        match token {
            FormPathToken::Key(key) => {
                path.push('.');
                path.push_str(key);
            }
            FormPathToken::Index(index) => path.push_str(&format!("[{index}]")),
        }
    }
    path
}

fn guided_internal_locator(locator: &[FormPathToken]) -> bool {
    let keys = locator
        .iter()
        .filter_map(|token| match token {
            FormPathToken::Key(key) => Some(key.as_str()),
            FormPathToken::Index(_) => None,
        })
        .collect::<Vec<_>>();
    let Some(last) = keys.last().copied() else {
        return false;
    };
    last == "schema_version"
        || last == "id"
        || last == "codex_agent"
        || last == "agent"
        || keys.first().copied() == Some("module")
        || (last == "prompt" && keys.first().copied() == Some("personas"))
        || (last == "path" && keys.first().copied() == Some("run_types"))
        || (last == "source" && keys.windows(2).any(|pair| pair == ["profile", "source"]))
}

fn scalar_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn parse_scalar(text: &str, kind: &str) -> anyhow::Result<Value> {
    Ok(match kind {
        "null" => {
            anyhow::ensure!(text.trim() == "null", "null fields must contain `null`");
            Value::Null
        }
        "boolean" => Value::Bool(text.trim().parse()?),
        "number" => serde_json::from_str::<Value>(text.trim()).and_then(|value| {
            if value.is_number() {
                Ok(value)
            } else {
                Err(serde_json::Error::io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "not a number",
                )))
            }
        })?,
        _ => Value::String(text.to_owned()),
    })
}

fn set_form_value(
    root: &mut Value,
    tokens: &[FormPathToken],
    replacement: Value,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !tokens.is_empty(),
        "cannot replace the configuration document root"
    );
    let mut current = root;
    for token in &tokens[..tokens.len() - 1] {
        current = match token {
            FormPathToken::Key(key) => current
                .as_object_mut()
                .and_then(|object| object.get_mut(key))
                .ok_or_else(|| anyhow::anyhow!("form path segment {key} does not exist"))?,
            FormPathToken::Index(index) => current
                .as_array_mut()
                .and_then(|array| array.get_mut(*index))
                .ok_or_else(|| anyhow::anyhow!("form array index {index} does not exist"))?,
        };
    }
    match tokens.last().expect("checked nonempty") {
        FormPathToken::Key(key) => {
            let target = current
                .as_object_mut()
                .and_then(|object| object.get_mut(key))
                .ok_or_else(|| anyhow::anyhow!("form path target {key} does not exist"))?;
            *target = replacement;
        }
        FormPathToken::Index(index) => {
            let target = current
                .as_array_mut()
                .and_then(|array| array.get_mut(*index))
                .ok_or_else(|| anyhow::anyhow!("form array target {index} does not exist"))?;
            *target = replacement;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FormPathToken {
    Key(String),
    Index(usize),
}

impl FormPathToken {
    pub(crate) fn stable_key(&self) -> String {
        match self {
            Self::Key(key) => format!("k:{key}"),
            Self::Index(index) => format!("i:{index}"),
        }
    }
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn text_offset(text: &str, line: usize, column: usize) -> usize {
    let mut offset = 0;
    for (index, current) in text.split_inclusive('\n').enumerate() {
        if index == line {
            return offset
                + current.char_indices().nth(column).map_or_else(
                    || current.trim_end_matches('\n').len(),
                    |(offset, _)| offset,
                );
        }
        offset += current.len();
    }
    text.len()
}

fn atomic_write(path: &Path, contents: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
    ));
    fs::write(&temp, contents)?;
    fs::rename(&temp, path)?;
    Ok(())
}

fn array_at(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn question_needs_attention(question: &Value) -> bool {
    matches!(
        question.get("status").and_then(Value::as_str),
        Some(
            "pending"
                | "open"
                | "resume_pending"
                | "answered_pending_resume"
                | "auto_resolved_pending_resume"
        )
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApprovalPlanKind {
    Architecture,
    Risk,
    Verification,
    Combined,
    Other,
}

struct ApprovalPlanningPass {
    title: String,
    kind: ApprovalPlanKind,
    body: Option<String>,
    review: Option<ApprovalPlanningReview>,
    required: bool,
    succeeded: bool,
}

#[derive(Default)]
struct ApprovalPlanningReview {
    architecture: Option<Vec<ApprovalReviewItem>>,
    risk: Option<Vec<ApprovalReviewItem>>,
    verification: Option<Vec<ApprovalReviewItem>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ApprovalReviewItem {
    heading: String,
    description: String,
}

impl ApprovalPlanningReview {
    fn for_kind(&self, kind: ApprovalPlanKind) -> Option<&[ApprovalReviewItem]> {
        match kind {
            ApprovalPlanKind::Architecture => self.architecture.as_deref(),
            ApprovalPlanKind::Risk => self.risk.as_deref(),
            ApprovalPlanKind::Verification => self.verification.as_deref(),
            ApprovalPlanKind::Combined | ApprovalPlanKind::Other => None,
        }
        .filter(|items| !items.is_empty())
    }
}

#[derive(Default)]
struct ApprovalBodyRedactions {
    literals: BTreeMap<String, &'static str>,
    pids: BTreeSet<String>,
}

impl ApprovalBodyRedactions {
    fn literal(&mut self, value: Option<&str>, replacement: &'static str) {
        let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
            return;
        };
        self.literals.entry(value.to_owned()).or_insert(replacement);
    }

    fn pid(&mut self, value: &Value) {
        let pid = value
            .as_u64()
            .filter(|pid| *pid > 0)
            .map(|pid| pid.to_string())
            .or_else(|| {
                value
                    .as_str()
                    .map(str::trim)
                    .filter(|pid| !pid.is_empty() && pid.chars().all(|char| char.is_ascii_digit()))
                    .map(ToOwned::to_owned)
            });
        if let Some(pid) = pid {
            self.pids.insert(pid);
        }
    }

    fn apply(&self, body: &str) -> String {
        let mut rendered = body.to_owned();
        let mut literals = self.literals.iter().collect::<Vec<_>>();
        literals.sort_by_key(|(value, _)| std::cmp::Reverse(value.len()));
        for (value, replacement) in literals {
            rendered = rendered.replace(value, replacement);
        }
        for pid in &self.pids {
            rendered = replace_ascii_token(&rendered, pid, "the planner process");
        }
        rendered
    }
}

pub(crate) fn approval_draft(
    run: &RunData,
    summary: &RunSummary,
    run_type_title: String,
) -> ApprovalDraft {
    let passes = approval_planning_passes(run);
    // Approval is a deliberately small operator projection. The complete
    // durable planning artifact remains untouched for compilation and agent
    // execution; older runs without a dedicated review field are condensed
    // deterministically below.
    let redactions = approval_body_redactions(run, summary);
    let mut blockers = passes
        .iter()
        .filter(|pass| pass.required && (!pass.succeeded || pass.body.is_none()))
        .map(|pass| format!("{} is incomplete", pass.title))
        .collect::<Vec<_>>();
    if run.questions.iter().any(question_needs_attention) {
        blockers.push("Planning decisions still need attention".to_owned());
    }

    let mut sections = Vec::new();
    for (title, kind, empty_copy) in [
        (
            "Architecture",
            ApprovalPlanKind::Architecture,
            "No separate architecture planning pass is required for this run type.",
        ),
        (
            "Risk",
            ApprovalPlanKind::Risk,
            "No separate risk planning pass is required for this run type.",
        ),
        (
            "Verification",
            ApprovalPlanKind::Verification,
            "No separate verification planning pass is required for this run type.",
        ),
    ] {
        let review_body = approval_plan_body(&passes, kind, empty_copy, &redactions);
        sections.push(ApprovalSection {
            title: title.to_owned(),
            body: review_body,
        });
    }
    let additional = passes
        .iter()
        .filter(|pass| pass.kind == ApprovalPlanKind::Other)
        .filter_map(|pass| pass.body.as_deref())
        .map(|body| concise_approval_plan(&redactions.apply(body), ApprovalPlanKind::Other))
        .collect::<Vec<_>>();
    if !additional.is_empty()
        && let Some(architecture) = sections.first_mut()
    {
        architecture.body.push_str("\n\nAdditional planning\n");
        architecture.body.push_str(&additional.join("\n"));
    }
    if let Some(graph_seed) = graph_seed_approval_section(run) {
        sections.push(graph_seed);
    }
    // Keep a final defense in depth for headings or fallback copy assembled
    // after the individual plan bodies were projected.
    for section in &mut sections {
        section.body = redactions.apply(&section.body);
    }

    ApprovalDraft {
        run_id: summary.id.clone(),
        goal: summary.goal.clone(),
        run_type_title,
        sections,
        selected_section: 0,
        scroll: 0,
        action_focused: false,
        revision_focused: false,
        revision: String::new(),
        revision_cursor: 0,
        approval_enabled: blockers.is_empty(),
        blockers,
        submitted: false,
    }
}

/// Return the durable, unabridged planning artifacts for the post-approval
/// Plan panel. This is intentionally separate from `approval_draft`: approval
/// uses the planner-authored concise review, while the permanent run record
/// preserves the full human-readable plan that execution consumes.
pub(crate) fn durable_approved_plan_sections(
    run: &RunData,
    summary: &RunSummary,
) -> Vec<ApprovalSection> {
    let redactions = approval_body_redactions(run, summary);
    let mut sections = approval_planning_passes(run)
        .into_iter()
        .filter(|pass| pass.succeeded)
        .filter_map(|pass| {
            pass.body.map(|body| ApprovalSection {
                title: pass.title,
                body: redactions.apply(&body),
            })
        })
        .collect::<Vec<_>>();
    if let Some(graph_seed) = graph_seed_approval_section(run) {
        sections.push(graph_seed);
    }
    sections
}

fn approval_body_redactions(run: &RunData, summary: &RunSummary) -> ApprovalBodyRedactions {
    let mut redactions = ApprovalBodyRedactions::default();
    redactions.literal(Some(&summary.id), "the current run");
    for question in &run.questions {
        redactions.literal(
            question.get("id").and_then(Value::as_str),
            "the planning question",
        );
        redactions.literal(
            question
                .get("batch")
                .and_then(|batch| batch.get("id"))
                .and_then(Value::as_str),
            "the question batch",
        );
    }
    for agent in &run.agents {
        redactions.literal(
            agent.get("id").and_then(Value::as_str),
            "the planning agent",
        );
    }
    collect_approval_control_metadata(&run.snapshot, &mut redactions);
    redactions
}

fn collect_approval_control_metadata(value: &Value, redactions: &mut ApprovalBodyRedactions) {
    let Value::Object(fields) = value else {
        if let Value::Array(values) = value {
            for value in values {
                collect_approval_control_metadata(value, redactions);
            }
        }
        return;
    };
    if let Some(batch_id) = fields
        .get("batch")
        .and_then(|batch| batch.get("id"))
        .and_then(Value::as_str)
    {
        redactions.literal(Some(batch_id), "the question batch");
    }
    for (field, value) in fields {
        let replacement = match field.as_str() {
            "run_id" => Some("the current run"),
            "base_commit" => Some("the pinned base commit"),
            "question_id" => Some("the planning question"),
            "batch_id" => Some("the question batch"),
            "session_id" | "codex_session_id" => Some("the Codex session"),
            "agent_id" => Some("the planning agent"),
            "project_root" | "repository_root" => Some("the project checkout"),
            "planning_worktree" | "integration_worktree" | "working_directory" | "worktree" => {
                Some("the planning checkout")
            }
            "prompt_path" => Some("the planner prompt"),
            "stdout_path" | "stderr_path" | "output_path" => Some("the planner output"),
            "process_path" => Some("the planner process"),
            "pid" | "process_group_id" => {
                redactions.pid(value);
                None
            }
            _ => None,
        };
        if let Some(replacement) = replacement {
            redactions.literal(value.as_str(), replacement);
        }
        collect_approval_control_metadata(value, redactions);
    }
}

fn replace_ascii_token(text: &str, token: &str, replacement: &str) -> String {
    let mut rendered = String::with_capacity(text.len());
    let mut cursor = 0;
    for (start, _) in text.match_indices(token) {
        let end = start + token.len();
        let starts_at_boundary = text[..start]
            .chars()
            .next_back()
            .is_none_or(|char| !char.is_ascii_alphanumeric() && char != '_');
        let ends_at_boundary = text[end..]
            .chars()
            .next()
            .is_none_or(|char| !char.is_ascii_alphanumeric() && char != '_');
        if starts_at_boundary && ends_at_boundary {
            rendered.push_str(&text[cursor..start]);
            rendered.push_str(replacement);
            cursor = end;
        }
    }
    if cursor == 0 {
        return text.to_owned();
    }
    rendered.push_str(&text[cursor..]);
    rendered
}

fn approval_planning_passes(run: &RunData) -> Vec<ApprovalPlanningPass> {
    run.stages
        .iter()
        .enumerate()
        .filter_map(|(index, stage)| {
            let definition = stage.get("definition").unwrap_or(stage);
            let stage_id = definition
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            approval_stage_is_planning(definition, stage_id, &run.agents).then(|| {
                let title = definition
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|title| !title.trim().is_empty())
                    .map(str::trim)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("Planning pass {}", index + 1));
                let status = stage
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending");
                let succeeded = status == "succeeded";
                let body =
                    planning_stage_output(stage, stage_id, &run.agents, &run.planning_transcript);
                let review =
                    planning_stage_review(stage, stage_id, &run.agents, &run.planning_transcript);
                let identity_classifier = format!("{} {}", stage_id, title).to_lowercase();
                let mut kind = classify_approval_plan(&identity_classifier);
                if kind == ApprovalPlanKind::Other {
                    let prompt_classifier = definition
                        .get("config")
                        .and_then(|config| config.get("prompt"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_lowercase();
                    kind = classify_approval_plan(&prompt_classifier);
                }
                ApprovalPlanningPass {
                    title,
                    kind,
                    body,
                    review,
                    required: definition
                        .get("required")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    succeeded,
                }
            })
        })
        .collect()
}

fn approval_stage_is_planning(definition: &Value, stage_id: &str, agents: &[Value]) -> bool {
    let kind = definition.get("kind").and_then(Value::as_str);
    if matches!(kind, Some("planning" | "agent_dialog")) {
        return true;
    }
    if kind != Some("action") {
        return false;
    }

    // Durable pipelines normalize catalog `planning` and `agent_dialog` kinds
    // to `action`. Their required planner persona remains pinned in the stage
    // config; an already-created compiler planning session is the fallback for
    // older projections that omitted that config.
    let has_planner_persona = definition
        .get("config")
        .and_then(|config| config.get("persona"))
        .and_then(Value::as_str)
        .is_some_and(|persona| !persona.trim().is_empty());
    has_planner_persona
        || (!stage_id.is_empty()
            && agents.iter().any(|agent| {
                agent.get("stage_id").and_then(Value::as_str) == Some(stage_id)
                    && agent
                        .get("id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| id.starts_with("planning-"))
            }))
}

fn classify_approval_plan(value: &str) -> ApprovalPlanKind {
    if value.contains("combined") {
        ApprovalPlanKind::Combined
    } else if value.contains("risk") || value.contains("hazard") || value.contains("safety") {
        ApprovalPlanKind::Risk
    } else if value.contains("verification")
        || value.contains("test")
        || value.contains("evidence")
        || value.contains("acceptance")
    {
        ApprovalPlanKind::Verification
    } else if value.contains("architecture")
        || value.contains("design")
        || value.contains("implementation")
    {
        ApprovalPlanKind::Architecture
    } else {
        ApprovalPlanKind::Other
    }
}

fn planning_stage_output(
    stage: &Value,
    stage_id: &str,
    agents: &[Value],
    transcript: &[Value],
) -> Option<String> {
    if let Some(body) = stage.get("output").and_then(planning_payload_text) {
        return Some(body.trim().to_owned());
    }
    let linked_agents = agents
        .iter()
        .filter(|agent| agent.get("stage_id").and_then(Value::as_str) == Some(stage_id))
        .collect::<Vec<_>>();
    if let Some(body) = linked_agents
        .iter()
        .rev()
        .find_map(|agent| agent.get("result").and_then(planning_payload_text))
    {
        return Some(body.trim().to_owned());
    }
    let linked_agent_ids = linked_agents
        .iter()
        .filter_map(|agent| agent.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    transcript
        .iter()
        .rev()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("planning.output"))
        .find(|event| {
            event.get("stage_id").and_then(Value::as_str) == Some(stage_id)
                || event
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .is_some_and(|agent_id| linked_agent_ids.contains(&agent_id))
        })
        .and_then(|event| event.get("output"))
        .and_then(planning_payload_text)
        .map(str::trim)
        .filter(|body| !body.is_empty())
        .map(ToOwned::to_owned)
}

fn planning_stage_review(
    stage: &Value,
    stage_id: &str,
    agents: &[Value],
    transcript: &[Value],
) -> Option<ApprovalPlanningReview> {
    if let Some(review) = stage.get("output").and_then(planning_payload_review) {
        return Some(review);
    }
    let linked_agents = agents
        .iter()
        .filter(|agent| agent.get("stage_id").and_then(Value::as_str) == Some(stage_id))
        .collect::<Vec<_>>();
    if let Some(review) = linked_agents
        .iter()
        .rev()
        .find_map(|agent| agent.get("result").and_then(planning_payload_review))
    {
        return Some(review);
    }
    let linked_agent_ids = linked_agents
        .iter()
        .filter_map(|agent| agent.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    transcript
        .iter()
        .rev()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("planning.output"))
        .find(|event| {
            event.get("stage_id").and_then(Value::as_str) == Some(stage_id)
                || event
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .is_some_and(|agent_id| linked_agent_ids.contains(&agent_id))
        })
        .and_then(|event| event.get("output"))
        .and_then(planning_payload_review)
}

fn planning_payload_review(value: &Value) -> Option<ApprovalPlanningReview> {
    if let Some(review) = value.get("review").and_then(Value::as_object) {
        let review = ApprovalPlanningReview {
            architecture: review.get("architecture").and_then(approval_review_items),
            risk: review.get("risk").and_then(approval_review_items),
            verification: review.get("verification").and_then(approval_review_items),
        };
        if review.architecture.is_some() || review.risk.is_some() || review.verification.is_some() {
            return Some(review);
        }
    }
    for field in ["output", "result", "payload"] {
        if let Some(review) = value.get(field).and_then(planning_payload_review) {
            return Some(review);
        }
    }
    None
}

const GRAPH_SEED_ROOT_FACT_LIMIT: usize = 6;
const GRAPH_SEED_NODE_LIMIT: usize = 12;
const GRAPH_SEED_RELATIONSHIP_LIMIT: usize = 16;
const GRAPH_SEED_TEXT_LIMIT: usize = 160;
const GRAPH_SEED_PURPOSE_KEYS: [&str; 7] = [
    "purpose",
    "summary",
    "intent",
    "goal",
    "description",
    "rationale",
    "question",
];

fn graph_seed_approval_section(run: &RunData) -> Option<ApprovalSection> {
    let seed = planning_graph_seed(run)?;
    Some(ApprovalSection {
        title: "Graph Seed".to_owned(),
        body: graph_seed_approval_body(seed),
    })
}

fn planning_graph_seed(run: &RunData) -> Option<&Value> {
    for stage in run
        .stages
        .iter()
        .rev()
        .filter(|stage| stage.get("status").and_then(Value::as_str) == Some("succeeded"))
        .filter(|stage| {
            let definition = stage.get("definition").unwrap_or(stage);
            let stage_id = definition
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            approval_stage_is_planning(definition, stage_id, &run.agents)
        })
    {
        let definition = stage.get("definition").unwrap_or(stage);
        let stage_id = definition
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(seed) = stage.get("output").and_then(planning_payload_graph_seed) {
            return Some(seed);
        }
        let linked_agents = run
            .agents
            .iter()
            .filter(|agent| agent.get("stage_id").and_then(Value::as_str) == Some(stage_id))
            .collect::<Vec<_>>();
        if let Some(seed) = linked_agents
            .iter()
            .rev()
            .find_map(|agent| agent.get("result").and_then(planning_payload_graph_seed))
        {
            return Some(seed);
        }
        let linked_agent_ids = linked_agents
            .iter()
            .filter_map(|agent| agent.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        if let Some(seed) = run
            .planning_transcript
            .iter()
            .rev()
            .filter(|event| {
                matches!(
                    event.get("type").and_then(Value::as_str),
                    Some("planning.output" | "planning.output.recovered")
                )
            })
            .find(|event| {
                event.get("stage_id").and_then(Value::as_str) == Some(stage_id)
                    || event
                        .get("agent_id")
                        .and_then(Value::as_str)
                        .is_some_and(|agent_id| linked_agent_ids.contains(&agent_id))
            })
            .and_then(|event| event.get("output"))
            .and_then(planning_payload_graph_seed)
        {
            return Some(seed);
        }
    }
    None
}

fn planning_payload_graph_seed(value: &Value) -> Option<&Value> {
    if let Some(seed) = value.get("graph_seed").filter(|seed| {
        seed.get("root_spec").is_some_and(Value::is_object)
            && seed.get("nodes").is_some_and(Value::is_array)
            && seed.get("edges").is_some_and(Value::is_array)
    }) {
        return Some(seed);
    }
    for field in ["output", "result", "payload"] {
        if let Some(seed) = value.get(field).and_then(planning_payload_graph_seed) {
            return Some(seed);
        }
    }
    None
}

fn graph_seed_approval_body(seed: &Value) -> String {
    let root_spec = seed
        .get("root_spec")
        .and_then(Value::as_object)
        .expect("planning graph seed root_spec was checked above");
    let nodes = seed
        .get("nodes")
        .and_then(Value::as_array)
        .expect("planning graph seed nodes were checked above");
    let edges = seed
        .get("edges")
        .and_then(Value::as_array)
        .expect("planning graph seed edges were checked above");
    let mut local_keys = nodes
        .iter()
        .filter_map(|node| node.get("key").and_then(Value::as_str))
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    local_keys.sort_by_key(|key| std::cmp::Reverse(key.len()));
    let mut lines = vec![format!(
        "{} root fact{} · {} semantic node{} · {} relationship{}",
        root_spec.len(),
        graph_seed_plural(root_spec.len()),
        nodes.len(),
        graph_seed_plural(nodes.len()),
        edges.len(),
        graph_seed_plural(edges.len()),
    )];

    let root_facts = root_spec
        .iter()
        .filter_map(|(key, value)| graph_seed_root_fact(key, value, &local_keys))
        .take(GRAPH_SEED_ROOT_FACT_LIMIT)
        .collect::<Vec<_>>();
    if !root_facts.is_empty() {
        lines.push(String::new());
        lines.push("### Root enrichment".to_owned());
        lines.extend(root_facts.iter().map(|fact| format!("- {fact}")));
    }

    let projected_nodes = nodes
        .iter()
        .enumerate()
        .filter_map(|(index, node)| {
            let key = node.get("key").and_then(Value::as_str)?;
            let title = node
                .get("title")
                .and_then(Value::as_str)
                .and_then(|title| graph_seed_safe_text(title, &local_keys))
                .unwrap_or_else(|| format!("Semantic node {}", index + 1));
            let node_type = node
                .get("type")
                .and_then(Value::as_str)
                .and_then(|node_type| graph_seed_safe_identifier(node_type, &local_keys))
                .map(|value| humanize_identifier(&value))
                .unwrap_or_else(|| "Node".to_owned());
            let purpose =
                graph_seed_node_purpose(node, &local_keys).filter(|purpose| purpose != &title);
            Some((key.to_owned(), node_type, title, purpose))
        })
        .collect::<Vec<_>>();
    let titles_by_key = projected_nodes
        .iter()
        .take(GRAPH_SEED_NODE_LIMIT)
        .map(|(key, _, title, _)| (key.clone(), title.clone()))
        .collect::<BTreeMap<_, _>>();
    if !projected_nodes.is_empty() {
        lines.push(String::new());
        lines.push("### Semantic nodes".to_owned());
        for (_, node_type, title, purpose) in projected_nodes.iter().take(GRAPH_SEED_NODE_LIMIT) {
            lines.push(format!("- {node_type} · {title}"));
            if let Some(purpose) = purpose {
                lines.push(format!("  {purpose}"));
            }
        }
    }

    let projected_relationships = edges
        .iter()
        .filter_map(|edge| {
            let source = graph_seed_endpoint_title(edge.get("source")?, &titles_by_key)?;
            let target = graph_seed_endpoint_title(edge.get("target")?, &titles_by_key)?;
            let relation = edge
                .get("relation")
                .and_then(Value::as_str)
                .and_then(|relation| graph_seed_safe_identifier(relation, &local_keys))
                .map(|value| humanize_identifier(&value).to_lowercase())?;
            Some(format!("{source} → {relation} → {target}"))
        })
        .collect::<Vec<_>>();
    if !projected_relationships.is_empty() {
        lines.push(String::new());
        lines.push("### Relationships".to_owned());
        lines.extend(
            projected_relationships
                .iter()
                .take(GRAPH_SEED_RELATIONSHIP_LIMIT)
                .map(|relationship| format!("- {relationship}")),
        );
    }

    let omitted_root_facts = root_spec.len().saturating_sub(root_facts.len());
    let omitted_nodes = nodes
        .len()
        .saturating_sub(projected_nodes.len().min(GRAPH_SEED_NODE_LIMIT));
    let omitted_relationships = edges.len().saturating_sub(
        projected_relationships
            .len()
            .min(GRAPH_SEED_RELATIONSHIP_LIMIT),
    );
    lines.push(String::new());
    lines.push("### Omitted from this view".to_owned());
    lines.push(format!(
        "- {omitted_root_facts} root fact{} · {omitted_nodes} node{} · {omitted_relationships} relationship{}",
        graph_seed_plural(omitted_root_facts),
        graph_seed_plural(omitted_nodes),
        graph_seed_plural(omitted_relationships),
    ));
    lines.join("\n")
}

fn graph_seed_root_fact(key: &str, value: &Value, local_keys: &[&str]) -> Option<String> {
    if graph_seed_metadata_key(key) || local_keys.contains(&key) {
        return None;
    }
    let value = graph_seed_scalar_summary(value, local_keys)?;
    Some(format!("{}: {value}", humanize_identifier(key)))
}

fn graph_seed_node_purpose(node: &Value, local_keys: &[&str]) -> Option<String> {
    let spec = node.get("spec").and_then(Value::as_object)?;
    GRAPH_SEED_PURPOSE_KEYS.iter().find_map(|key| {
        spec.get(*key)
            .and_then(|value| graph_seed_direct_scalar(value, local_keys))
    })
}

fn graph_seed_endpoint_title(
    value: &Value,
    titles_by_key: &BTreeMap<String, String>,
) -> Option<String> {
    let key = value.as_str()?;
    if key == "$root" {
        return Some("Objective".to_owned());
    }
    titles_by_key.get(key).cloned()
}

fn graph_seed_scalar_summary(value: &Value, local_keys: &[&str]) -> Option<String> {
    match value {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => {
            graph_seed_direct_scalar(value, local_keys)
        }
        Value::Array(values) => {
            let items = values
                .iter()
                .filter_map(|value| graph_seed_direct_scalar(value, local_keys))
                .take(3)
                .collect::<Vec<_>>();
            (!items.is_empty()).then(|| bounded_graph_seed_text(&items.join("; ")))
        }
        Value::Object(_) | Value::Null => None,
    }
}

fn graph_seed_direct_scalar(value: &Value, local_keys: &[&str]) -> Option<String> {
    match value {
        Value::String(value) => graph_seed_safe_text(value, local_keys),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(if *value { "Yes" } else { "No" }.to_owned()),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

fn graph_seed_safe_identifier(value: &str, local_keys: &[&str]) -> Option<String> {
    if local_keys.contains(&value) {
        return None;
    }
    let value = graph_seed_safe_text(value, local_keys)?;
    value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
        .then_some(value)
}

fn graph_seed_safe_text(value: &str, local_keys: &[&str]) -> Option<String> {
    let value = value.trim();
    let normalized = value.to_ascii_lowercase();
    if local_keys
        .iter()
        .any(|key| !key.is_empty() && normalized.contains(key.to_ascii_lowercase().as_str()))
    {
        return None;
    }
    let value = value.replace("$root", "Objective");
    if value.is_empty()
        || graph_seed_contains_machine_identifier(&value)
        || value.split_whitespace().any(graph_seed_sensitive_token)
    {
        return None;
    }
    Some(bounded_graph_seed_text(&value))
}

fn bounded_graph_seed_text(value: &str) -> String {
    let mut characters = value.chars();
    let visible = characters
        .by_ref()
        .take(GRAPH_SEED_TEXT_LIMIT)
        .collect::<String>();
    if characters.next().is_some() {
        format!("{visible}…")
    } else {
        visible
    }
}

fn graph_seed_metadata_key(key: &str) -> bool {
    let camel_case_metadata = ["Id", "Ids", "ID", "IDs", "Key", "Keys"]
        .iter()
        .any(|suffix| key.ends_with(suffix));
    let normalized = key.to_ascii_lowercase();
    let sensitive_fragments = [
        "hash",
        "digest",
        "checksum",
        "path",
        "storage",
        "worktree",
        "directory",
        "commit",
        "schema",
        "spec",
    ];
    camel_case_metadata
        || sensitive_fragments
            .iter()
            .any(|fragment| normalized.contains(fragment))
        || normalized.starts_with("sha")
        || normalized.ends_with("sha")
        || key
            .split(|character: char| !character.is_ascii_alphanumeric())
            .any(|token| {
                matches!(
                    token.to_ascii_lowercase().as_str(),
                    "id" | "ids"
                        | "hash"
                        | "hashes"
                        | "digest"
                        | "checksum"
                        | "path"
                        | "paths"
                        | "storage"
                        | "worktree"
                        | "directory"
                        | "directories"
                        | "commit"
                        | "sha"
                        | "key"
                        | "keys"
                        | "schema"
                        | "schemas"
                        | "spec"
                        | "specs"
                )
            })
}

fn graph_seed_contains_machine_identifier(value: &str) -> bool {
    let mut hexadecimal_run = 0usize;
    for byte in value.bytes() {
        if byte.is_ascii_hexdigit() {
            hexadecimal_run += 1;
            if hexadecimal_run >= 24 {
                return true;
            }
        } else {
            hexadecimal_run = 0;
        }
    }
    value.as_bytes().windows(36).any(|candidate| {
        candidate.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    })
}

fn graph_seed_sensitive_token(token: &str) -> bool {
    let token = token.trim_matches(|character: char| {
        matches!(
            character,
            ',' | '.' | ';' | ':' | '(' | ')' | '[' | ']' | '{' | '}'
        )
    });
    token.starts_with('/')
        || token.starts_with("./")
        || token.starts_with("../")
        || token.starts_with("~/")
        || token.contains('\\')
        || (token.contains('/') && !token.contains(char::is_whitespace))
        || (token.len() >= 24 && token.chars().all(|character| character.is_ascii_hexdigit()))
        || (token.len() == 36
            && token.chars().enumerate().all(|(index, character)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    character == '-'
                } else {
                    character.is_ascii_hexdigit()
                }
            }))
}

fn graph_seed_plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

fn approval_review_items(value: &Value) -> Option<Vec<ApprovalReviewItem>> {
    if let Some(items) = value.as_array() {
        let items = items
            .iter()
            .filter_map(|item| {
                let heading = item
                    .get("heading")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|heading| !heading.is_empty())?;
                let description = item
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|description| !description.is_empty())?;
                Some(ApprovalReviewItem {
                    heading: heading.to_owned(),
                    description: description.to_owned(),
                })
            })
            .collect::<Vec<_>>();
        return (!items.is_empty()).then_some(items);
    }
    value
        .as_str()
        .map(legacy_review_items)
        .filter(|items| !items.is_empty())
}

fn legacy_review_items(summary: &str) -> Vec<ApprovalReviewItem> {
    let descriptions = summary
        .lines()
        .filter_map(|line| approval_brief_item(line.trim()))
        .take(APPROVAL_BRIEF_MAX_ITEMS)
        .collect::<Vec<_>>();
    if descriptions.is_empty() {
        return Vec::new();
    }
    vec![ApprovalReviewItem {
        heading: "Legacy planner summary".to_owned(),
        description: descriptions.join("\n"),
    }]
}

fn planning_payload_text(value: &Value) -> Option<&str> {
    if let Some(text) = value.as_str().filter(|text| !text.trim().is_empty()) {
        return Some(text);
    }
    for field in ["output", "plan", "content", "brief", "summary", "message"] {
        if let Some(text) = value.get(field).and_then(planning_payload_text) {
            return Some(text);
        }
    }
    None
}

fn approval_plan_body(
    passes: &[ApprovalPlanningPass],
    kind: ApprovalPlanKind,
    empty_copy: &str,
    redactions: &ApprovalBodyRedactions,
) -> String {
    // A planner-authored structured review is already classified by domain.
    // Prefer that explicit contract over inference from the stage id/title so
    // focused or combined planning passes can populate every review tab.
    let reviewed = passes
        .iter()
        .filter(|pass| {
            pass.review
                .as_ref()
                .and_then(|review| review.for_kind(kind))
                .is_some()
        })
        .collect::<Vec<_>>();
    let direct = passes
        .iter()
        .filter(|pass| pass.kind == kind)
        .collect::<Vec<_>>();
    let selected = if !reviewed.is_empty() {
        reviewed
    } else if direct.is_empty() {
        passes
            .iter()
            .filter(|pass| pass.kind == ApprovalPlanKind::Combined)
            .collect::<Vec<_>>()
    } else {
        direct
    };
    if selected.is_empty() {
        return empty_copy.to_owned();
    }
    selected
        .into_iter()
        .map(|pass| {
            if let Some(review) = pass
                .review
                .as_ref()
                .and_then(|review| review.for_kind(kind))
            {
                return approval_review_items_markdown(review, redactions);
            }
            pass.body.as_ref().map_or_else(
                || format!("{} has not produced durable review text yet.", pass.title),
                |body| concise_approval_plan(&redactions.apply(body), kind),
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn approval_review_items_markdown(
    items: &[ApprovalReviewItem],
    redactions: &ApprovalBodyRedactions,
) -> String {
    items
        .iter()
        .map(|item| {
            let heading = redactions.apply(&item.heading);
            let description = redactions.apply(&item.description);
            format!("### {heading}\n\n{description}")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

const APPROVAL_BRIEF_MAX_ITEMS: usize = 7;
const APPROVAL_BRIEF_ITEM_CHARS: usize = 180;

/// Build a bounded operator summary for planning artifacts created before the
/// structured `review` projection existed. This never replaces or mutates the
/// complete durable artifact.
fn concise_approval_plan(body: &str, kind: ApprovalPlanKind) -> String {
    let mut all = Vec::new();
    let mut matching = Vec::new();
    let mut seen_all = BTreeSet::new();
    let mut seen_matching = BTreeSet::new();
    let mut matching_heading = kind == ApprovalPlanKind::Other;
    let mut in_code = false;

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code || trimmed.is_empty() {
            continue;
        }
        if let Some(heading) = trimmed.strip_prefix('#').map(str::trim) {
            matching_heading = approval_heading_matches_kind(heading, kind);
            continue;
        }
        let Some(item) = approval_brief_item(trimmed) else {
            continue;
        };
        if seen_all.insert(item.clone()) {
            all.push(item.clone());
        }
        if matching_heading && seen_matching.insert(item.clone()) {
            matching.push(item);
        }
    }

    let candidates = if matching.is_empty() { all } else { matching };
    if candidates.is_empty() {
        return "The completed plan has no concise review text.".to_owned();
    }
    let descriptions = candidates
        .into_iter()
        .take(APPROVAL_BRIEF_MAX_ITEMS)
        .collect::<Vec<_>>();
    let label = match kind {
        ApprovalPlanKind::Architecture => "Legacy architecture excerpt",
        ApprovalPlanKind::Risk => "Legacy risk excerpt",
        ApprovalPlanKind::Verification => "Legacy verification excerpt",
        ApprovalPlanKind::Combined | ApprovalPlanKind::Other => "Legacy plan excerpt",
    };
    format!("### {label}\n\n{}", descriptions.join("\n"))
}

fn approval_heading_matches_kind(heading: &str, kind: ApprovalPlanKind) -> bool {
    let heading = heading.to_lowercase();
    let contains_any = |needles: &[&str]| needles.iter().any(|needle| heading.contains(needle));
    match kind {
        ApprovalPlanKind::Architecture => contains_any(&[
            "architecture",
            "implementation",
            "design",
            "resolved behavior",
            "scope",
            "dependency",
            "migration",
            "contract",
        ]),
        ApprovalPlanKind::Risk => contains_any(&[
            "risk",
            "hazard",
            "failure",
            "mitigation",
            "rollback",
            "safety",
        ]),
        ApprovalPlanKind::Verification => contains_any(&[
            "verification",
            "validation",
            "test",
            "evidence",
            "acceptance",
            "quality",
            "type 3",
        ]),
        ApprovalPlanKind::Combined | ApprovalPlanKind::Other => true,
    }
}

fn approval_brief_item(line: &str) -> Option<String> {
    let compact = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let lowercase = compact.to_lowercase();
    if compact.is_empty()
        || (compact.starts_with('|') && compact.ends_with('|'))
        || compact.ends_with(':')
        || lowercase.starts_with("no approval decisions remain")
        || compact
            .chars()
            .all(|character| matches!(character, '-' | '|' | ':' | ' '))
    {
        return None;
    }
    let compact = compact
        .strip_prefix("- ")
        .or_else(|| compact.strip_prefix("* "))
        .or_else(|| compact.strip_prefix("+ "))
        .unwrap_or(&compact);
    let compact = strip_ordered_approval_prefix(compact);
    let mut shortened = compact
        .chars()
        .take(APPROVAL_BRIEF_ITEM_CHARS)
        .collect::<String>();
    if compact.chars().count() > APPROVAL_BRIEF_ITEM_CHARS {
        shortened.pop();
        shortened.push('…');
    }
    (!shortened.trim().is_empty()).then(|| shortened.trim().to_owned())
}

fn strip_ordered_approval_prefix(value: &str) -> &str {
    let Some((prefix, remainder)) = value.split_once(' ') else {
        return value;
    };
    let number = prefix.trim_end_matches(['.', ')']);
    if number.len() < prefix.len() && number.chars().all(|character| character.is_ascii_digit()) {
        remainder
    } else {
        value
    }
}

#[allow(dead_code)]
fn resolved_decisions_body(questions: &[Value]) -> String {
    let decisions = questions
        .iter()
        .enumerate()
        .filter(|(_, question)| question.get("answer").is_some_and(Value::is_object))
        .collect::<Vec<_>>();
    let decisions = decisions
        .into_iter()
        .filter_map(|(_, question)| {
            let prompt = question
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|prompt| !prompt.is_empty())?;
            let answer = question.get("answer")?;
            let option_id = answer.get("option_id").and_then(Value::as_str);
            let option_label = option_id.and_then(|option_id| {
                question
                    .get("options")
                    .and_then(Value::as_array)?
                    .iter()
                    .find(|option| option.get("id").and_then(Value::as_str) == Some(option_id))?
                    .get("label")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|label| !label.is_empty())
                    .map(ToOwned::to_owned)
            });
            let custom = answer
                .get("custom")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|answer| !answer.is_empty())
                .map(ToOwned::to_owned);
            let selected = option_label
                .clone()
                .or_else(|| custom.clone())
                .unwrap_or_else(|| "Recorded response".to_owned());
            let notes = answer
                .get("notes")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|notes| !notes.is_empty())
                .map(ToOwned::to_owned)
                // Compatibility for early option-plus-note answers that used
                // `custom` before the dedicated notes field existed.
                .or_else(|| option_label.is_some().then_some(custom).flatten());
            Some((prompt.to_owned(), selected, notes))
        })
        .collect::<Vec<_>>();
    if decisions.is_empty() {
        return "No planning questions were required for this run.".to_owned();
    }
    decisions
        .into_iter()
        .enumerate()
        .map(|(index, (prompt, answer, notes))| {
            let notes = notes.map_or_else(String::new, |notes| format!("\n\nNotes: {notes}"));
            format!(
                "## Question {}\n\n{prompt}\n\nDecision: {answer}{notes}",
                index + 1
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[allow(dead_code)]
fn sort_question_rows(rows: &mut [(usize, &Value)]) {
    let mut batch_first = BTreeMap::new();
    for (index, question) in rows.iter() {
        if let Some(batch_id) = question_batch_id(question) {
            batch_first.entry(batch_id).or_insert(*index);
        }
    }
    rows.sort_by_key(|(index, question)| {
        question_batch_position(question).map_or((*index, 0, *index), |(ordinal, _)| {
            let group = question_batch_id(question)
                .and_then(|batch_id| batch_first.get(batch_id).copied())
                .unwrap_or(*index);
            (group, ordinal, *index)
        })
    });
}

pub(crate) fn question_accepts_answer(question: &Value) -> bool {
    matches!(
        question.get("status").and_then(Value::as_str),
        Some("pending" | "open")
    )
}

pub(crate) fn question_options(question: &Value) -> Vec<(String, String, String, bool)> {
    question
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|option| {
            (
                option
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                option
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or("Option")
                    .to_owned(),
                option
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                option
                    .get("recommended")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
        })
        .collect()
}

pub(crate) fn question_allows_custom(question: &Value) -> bool {
    question
        .get("allow_custom_answer")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub(crate) fn question_choice_count(question: &Value) -> usize {
    question_options(question).len() + usize::from(question_allows_custom(question))
}

pub(crate) fn question_initial_choice(question: &Value) -> usize {
    let options = question_options(question);
    let answer = question.get("answer");
    if let Some(option_id) = answer
        .and_then(|answer| answer.get("option_id"))
        .and_then(Value::as_str)
        && let Some(index) = options.iter().position(|(id, _, _, _)| id == option_id)
    {
        return index;
    }
    if answer
        .and_then(|answer| answer.get("custom"))
        .and_then(Value::as_str)
        .is_some_and(|custom| !custom.trim().is_empty())
        && question_allows_custom(question)
    {
        return options.len();
    }
    options
        .iter()
        .position(|(_, _, _, recommended)| *recommended)
        .unwrap_or(0)
}

pub(crate) fn question_answer_is_pending_resume(question: &Value) -> bool {
    matches!(
        question.get("status").and_then(Value::as_str),
        Some("resume_pending" | "answered_pending_resume" | "auto_resolved_pending_resume")
    )
}

fn question_answer_is_revisable_pending(question: &Value) -> bool {
    matches!(
        question.get("status").and_then(Value::as_str),
        Some("resume_pending" | "answered_pending_resume")
    )
}

pub(crate) fn question_batch_id(question: &Value) -> Option<&str> {
    let batch = question.get("batch")?;
    let id = batch.get("id")?.as_str()?.trim();
    let (ordinal, size) = question_batch_position(question)?;
    (ordinal <= size && !id.is_empty()).then_some(id)
}

pub(crate) fn question_batch_position(question: &Value) -> Option<(usize, usize)> {
    let batch = question.get("batch")?;
    let ordinal = usize::try_from(batch.get("ordinal")?.as_u64()?).ok()?;
    let size = usize::try_from(batch.get("size")?.as_u64()?).ok()?;
    (size > 1 && ordinal > 0 && ordinal <= size).then_some((ordinal, size))
}

fn model_ticket_is_closed(ticket: &Value) -> bool {
    matches!(
        ticket.get("status").and_then(Value::as_str),
        Some("closed" | "complete" | "completed" | "done" | "cancelled" | "superseded")
    )
}

fn friendly_ticket_title(ticket: &Value) -> Option<String> {
    let title = ticket
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())?;
    let operation = ticket.get("operation").and_then(Value::as_str);
    Some(
        operation
            .and_then(|operation| title.strip_prefix(operation))
            .and_then(|rest| rest.strip_prefix(':'))
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or(title)
            .to_owned(),
    )
}

fn concise_work_title(title: &str) -> String {
    let words = title.split_whitespace().collect::<Vec<_>>();
    if words.is_empty() {
        return "Current run work".to_owned();
    }
    let mut concise = words.iter().take(3).copied().collect::<Vec<_>>().join(" ");
    if words.len() > 3 {
        concise.push('…');
    }
    concise
}

fn humanize_identifier(value: &str) -> String {
    let normalized = value
        .trim()
        .replace(['_', '-', '.'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut characters = normalized.chars();
    let Some(first) = characters.next() else {
        return "—".to_owned();
    };
    first.to_uppercase().chain(characters).collect()
}

fn wrap_index(current: usize, delta: isize, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    (current as isize + delta).rem_euclid(len as isize) as usize
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use koni_core::state::ConfigSnapshot;
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn run_summary_keeps_provider_total_separate_from_cache_excluding_usage() {
        let summary = |token_usage: Value| {
            RunData::from_snapshot(json!({
                "run": {"id": "run-1", "goal": "Test", "status": "active"},
                "token_usage": token_usage
            }))
            .summary
            .unwrap()
        };

        let explicit = summary(json!({
            "input_tokens": 1_000,
            "cached_input_tokens": 800,
            "output_tokens": 100,
            "total_tokens": 1_100,
            "new_tokens": 300
        }));
        assert_eq!(explicit.total_tokens, 1_100);
        assert_eq!(explicit.new_tokens, 300);

        let derived = summary(json!({
            "input_tokens": 20,
            "cached_input_tokens": 12,
            "output_tokens": 10
        }));
        assert_eq!(derived.total_tokens, 30);
        assert_eq!(derived.new_tokens, 18);

        let legacy_total_only = summary(json!({"total_tokens": 123}));
        assert_eq!(legacy_total_only.total_tokens, 123);
        assert_eq!(legacy_total_only.new_tokens, 123);

        let provider_total_with_cache = summary(json!({
            "total_tokens": 123,
            "cached_input_tokens": 23
        }));
        assert_eq!(provider_total_with_cache.total_tokens, 123);
        assert_eq!(provider_total_with_cache.new_tokens, 100);

        let missing = summary(Value::Null);
        assert_eq!(missing.total_tokens, 0);
        assert_eq!(missing.new_tokens, 0);
    }

    #[test]
    fn planning_budget_progress_preserves_its_configured_metric() {
        let progress = |metric: &str| {
            RunData::from_snapshot(json!({
                "run": {"id": "run-1", "goal": "Test", "status": "planning"},
                "planning_session": {
                    "budget_metric": metric,
                    "budget_limit": 2_000,
                    "synthesis_reserve": 500,
                    "usage": {"total_tokens": 1_100, "new_tokens": 300},
                    "accounted_baseline": {"total_tokens": 100, "new_tokens": 50}
                }
            }))
            .planning_budget_progress()
            .unwrap()
        };

        let new = progress("new_tokens");
        assert_eq!(new.used, 250);
        assert_eq!(new.metric, PlanningBudgetMetric::New);
        assert_eq!(new.metric.label(), "new");

        let processed = progress("processed_tokens");
        assert_eq!(processed.used, 1_000);
        assert_eq!(processed.metric, PlanningBudgetMetric::Processed);
        assert_eq!(processed.metric.label(), "processed");
    }

    #[test]
    fn refreshed_run_status_respects_durable_pause_intent() {
        let paused = RunData::from_snapshot(json!({
            "run": {"id": "run-1", "goal": "Test", "status": "active"},
            "lifecycle": {"running": false, "draining": false},
            "orchestration": {"running": false, "max_parallel": 3}
        }));
        assert_eq!(paused.summary.as_ref().unwrap().status, "paused");

        let draining = RunData::from_snapshot(json!({
            "run": {"id": "run-2", "goal": "Test", "status": "active"},
            "lifecycle": {"running": false, "draining": true},
            "orchestration": {"running": false, "max_parallel": 3}
        }));
        assert_eq!(draining.summary.as_ref().unwrap().status, "pausing");

        let running = RunData::from_snapshot(json!({
            "run": {"id": "run-3", "goal": "Test", "status": "active"},
            "lifecycle": {"running": true, "draining": false},
            "orchestration": {"running": true, "max_parallel": 3}
        }));
        assert_eq!(running.summary.as_ref().unwrap().status, "active");
    }

    #[test]
    fn agent_chat_resolves_relative_artifacts_from_the_compiler_run_root() {
        let fixture = TempDir::new().unwrap();
        let status = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(fixture.path())
            .status()
            .unwrap();
        assert!(status.success());
        let run_id = "run-artifact-root";
        let attempt = fixture
            .path()
            .join(".git/koni/runs")
            .join(run_id)
            .join("agents/planner/attempt-1");
        fs::create_dir_all(&attempt).unwrap();
        fs::write(attempt.join("prompt.md"), "Inspect the project boundary.").unwrap();
        fs::write(
            attempt.join("stdout.jsonl"),
            concat!(
                "{\"type\":\"thread.started\",\"thread_id\":\"session-one\"}\n",
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"message\",\"type\":\"agent_message\",\"text\":\"Artifact transcript loaded.\"}}\n"
            ),
        )
        .unwrap();
        let mut model = ControlCenterModel::from_snapshot(
            fixture.path().to_path_buf(),
            json!({
                "run":{"id":run_id,"goal":"Verify transcript","status":"planning"},
                "agents":[{
                    "id":"planner",
                    "persona":"planner",
                    "status":"completed",
                    "stdout_path":"agents/planner/attempt-1/stdout.jsonl",
                    "prompt_path":"agents/planner/attempt-1/prompt.md",
                    "codex_session_id":"session-one"
                }]
            }),
        );
        model.focus_agents();

        let rendered = model.selected_agent_chat_render(80).unwrap();
        let text = rendered
            .lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<Vec<_>>()
            .join("\n");

        assert!(text.contains("Inspect the project boundary."), "{text}");
        assert!(text.contains("Artifact transcript loaded."), "{text}");
        assert!(!text.contains("unavailable"), "{text}");
        assert!(!text.contains("No such file"), "{text}");
    }

    #[test]
    fn gate_policy_guided_order_follows_the_operator_workflow() {
        let row = |path: &str| FormRow {
            document_path: "graph.yaml".into(),
            path: path.to_owned(),
            value: String::new(),
            kind: "string".to_owned(),
            locator: Vec::new(),
            edit_kind: FormRowEditKind::Scalar,
        };
        let mut rows = [
            row("$.auto_evaluate.check"),
            row("$.execution_ready.all[0].op"),
            row("$.selection.mode"),
            row("$.missing_gate_obligation_key_template"),
            row("$.applicability.required_subject_node_types[0]"),
        ];

        rows.sort_by_key(gate_policy_form_row_rank);

        assert_eq!(
            rows.iter().map(|row| row.path.as_str()).collect::<Vec<_>>(),
            vec![
                "$.applicability.required_subject_node_types[0]",
                "$.missing_gate_obligation_key_template",
                "$.selection.mode",
                "$.execution_ready.all[0].op",
                "$.auto_evaluate.check",
            ]
        );
    }

    const PROJECT_CATALOG: &str = r#"
schema_version: "1.0"
project:
  id: publication-fixture
  title: Publication fixture
default_run_type: base
run_types:
  - id: base
    path: run-types/base.yaml
  - id: fast
    path: run-types/fast.yaml
"#;

    const BASE_RUN_TYPE: &str = r#"
schema_version: "1.0"
id: base
title: Base run
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
      kind: planning
      title: Plan
  order: [plan]
questions:
  policy: interactive
  default_scope: ticket
git:
  branch_template: koni/runs/{{ run.id }}
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}
run_card:
  sections: [goal, plan]
"#;

    const FAST_RUN_TYPE: &str = r#"
schema_version: "1.0"
id: fast
title: Fast run
extends: base
overrides:
  - op: replace
    path: /questions/policy
    value: autonomous
"#;

    const YAML_PROFILE: &str = r#"
schema_version: "1.0"
engine: ">=0.1,<0.2"
profile:
  id: publication-profile
  version: 1.0.0
  description: Original profile
imports:
  graph: [modules/nodes.yaml]
"#;

    const NODE_MODULE: &str = r#"
node_types:
  - id: task
    stage: execution
    statuses: [active, complete]
"#;

    fn write_fixture_file(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn publication_fixture() -> TempDir {
        let temp = TempDir::new().unwrap();
        write_fixture_file(temp.path(), ".codex/koni/project.yaml", PROJECT_CATALOG);
        write_fixture_file(
            temp.path(),
            ".codex/koni/run-types/base.yaml",
            BASE_RUN_TYPE,
        );
        write_fixture_file(
            temp.path(),
            ".codex/koni/run-types/fast.yaml",
            FAST_RUN_TYPE,
        );
        write_fixture_file(temp.path(), ".codex/koni/profile.yaml", YAML_PROFILE);
        write_fixture_file(temp.path(), ".codex/koni/modules/nodes.yaml", NODE_MODULE);
        temp
    }

    fn publication_model(root: &Path) -> ControlCenterModel {
        let root = root.canonicalize().unwrap();
        let mut model = ControlCenterModel::from_snapshot(root.clone(), Value::Null);
        model.config = load_config_state(&root).unwrap();
        model
    }

    fn config_document_index(model: &ControlCenterModel, relative: &str) -> usize {
        model
            .config
            .documents
            .iter()
            .position(|document| document.relative_path == Path::new(relative))
            .unwrap_or_else(|| panic!("missing configuration document {relative}"))
    }

    fn configuration_document(relative: &str, text: &str) -> ConfigDocument {
        ConfigDocument {
            relative_path: relative.into(),
            source_path: relative.into(),
            draft_path: PathBuf::from("drafts").join(relative),
            original: text.to_owned(),
            text: text.to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        }
    }

    fn replace_and_save(model: &mut ControlCenterModel, relative: &str, from: &str, to: &str) {
        let index = config_document_index(model, relative);
        let document = &mut model.config.documents[index];
        assert!(document.text.contains(from));
        document.text = document.text.replacen(from, to, 1);
        assert!(document.validate());
        model.config.selected = index;
        model.save_config_draft().unwrap();
        assert!(model.config.documents[index].draft_path.is_file());
    }

    fn open_run_type_wizard(model: &mut ControlCenterModel) -> RunTypeWizardDraft {
        model.open_run_type_wizard();
        let Some(Dialog::RunTypeWizard(draft)) = &model.dialog else {
            panic!("run-type wizard did not open: {}", model.status);
        };
        draft.clone()
    }

    #[test]
    fn discard_all_config_drafts_restores_the_published_project_atomically() {
        let fixture = publication_fixture();
        let mut model = publication_model(fixture.path());
        let published_profile =
            fs::read_to_string(fixture.path().join(".codex/koni/profile.yaml")).unwrap();

        replace_and_save(
            &mut model,
            "profile.yaml",
            "description: Original profile",
            "description: Unpublished profile",
        );
        model
            .create_config_document("modules/unpublished.yaml")
            .unwrap();
        model.save_config_draft().unwrap();
        model.config.selected = config_document_index(&model, "modules/nodes.yaml");
        model
            .rename_config_document("modules/entities.yaml")
            .unwrap();
        model.config.selected = config_document_index(&model, "run-types/fast.yaml");
        model.toggle_delete_config_document().unwrap();
        model.save_all_config_drafts().unwrap();

        assert_eq!(model.unpublished_config_change_count(), 4);
        assert!(config_draft_root(fixture.path()).exists());

        let discarded = model.discard_all_config_drafts().unwrap();

        assert_eq!(discarded, 4);
        assert_eq!(model.unpublished_config_change_count(), 0);
        assert!(model.config.pending_deletes.is_empty());
        assert!(model.config.pending_renames.is_empty());
        assert!(!model.config.documents.iter().any(|document| {
            document.relative_path == Path::new("modules/unpublished.yaml")
                || document.relative_path == Path::new("modules/entities.yaml")
        }));
        assert!(
            model
                .config
                .documents
                .iter()
                .any(|document| { document.relative_path == Path::new("modules/nodes.yaml") })
        );
        assert_eq!(
            fs::read_to_string(fixture.path().join(".codex/koni/profile.yaml")).unwrap(),
            published_profile
        );
        assert!(!config_draft_root(fixture.path()).exists());
        assert_eq!(model.run_types.len(), 2);
        assert!(model.catalog_error.is_none());
        assert_eq!(
            model.status,
            "discarded 4 unpublished configuration changes"
        );
    }

    #[test]
    fn guided_run_type_clone_is_complete_standalone_and_updates_catalog() {
        let fixture = publication_fixture();
        let mut model = publication_model(fixture.path());
        let mut wizard = open_run_type_wizard(&mut model);
        wizard.selected_template = wizard
            .templates
            .iter()
            .position(|template| template.label == "Fast run")
            .unwrap();
        wizard.title = "UI Feature".to_owned();
        wizard.sync_automatic_slug();
        wizard.description = "A focused interface workflow.".to_owned();
        wizard.make_default = true;
        model.dialog = Some(Dialog::RunTypeWizard(wizard));

        model.create_run_type_from_wizard().unwrap();

        let run_type_index = config_document_index(&model, "run-types/ui-feature.yaml");
        let run_type: RunTypeDocument =
            serde_yaml::from_str(&model.config.documents[run_type_index].text).unwrap();
        assert_eq!(run_type.id, "ui-feature");
        assert_eq!(run_type.title, "UI Feature");
        assert_eq!(
            run_type.description.as_deref(),
            Some("A focused interface workflow.")
        );
        assert!(run_type.extends.is_none());
        assert!(run_type.overrides.is_empty());
        assert!(run_type.profile.is_some());
        assert!(run_type.intake.is_some());
        assert!(run_type.pipeline.is_some());
        assert!(run_type.questions.is_some());
        assert!(run_type.git.is_some());
        assert!(run_type.run_card.is_some());
        assert_eq!(
            serde_json::to_value(run_type.questions.unwrap().policy).unwrap(),
            json!("autonomous"),
            "the resolved derived behavior should be copied, not its inheritance pointer"
        );

        let project_index = config_document_index(&model, "project.yaml");
        let project: ProjectCatalogDocument =
            serde_yaml::from_str(&model.config.documents[project_index].text).unwrap();
        assert_eq!(project.default_run_type, "ui-feature");
        assert!(project.run_types.iter().any(|entry| {
            entry.id == "ui-feature" && entry.path == Path::new("run-types/ui-feature.yaml")
        }));
        assert_eq!(model.focus, Focus::ConfigForm);
        assert!(model.config.documents[run_type_index].is_new);
        assert!(
            !fixture
                .path()
                .join(".codex/koni/run-types/ui-feature.yaml")
                .exists(),
            "the wizard must not publish automatically"
        );
    }

    #[test]
    fn run_type_wizard_templates_use_the_visible_coordinated_draft() {
        let fixture = publication_fixture();
        let mut model = publication_model(fixture.path());
        replace_and_save(
            &mut model,
            "run-types/base.yaml",
            "title: Plan",
            "title: Draft-aware plan",
        );
        replace_and_save(
            &mut model,
            "run-types/base.yaml",
            "title: Base run",
            "title: Base run\ninstructions:\n  planning: Ask one focused planning question.",
        );

        let wizard = open_run_type_wizard(&mut model);
        let fast = wizard
            .templates
            .iter()
            .find(|template| template.label == "Fast run")
            .expect("Fast run template");
        let pipeline = fast.document.pipeline.as_ref().expect("resolved pipeline");
        assert_eq!(pipeline.stages["plan"].title, "Draft-aware plan");
        assert_eq!(
            fast.document.instructions.planning,
            "Ask one focused planning question."
        );
        assert_eq!(
            fs::read_to_string(fixture.path().join(".codex/koni/run-types/base.yaml")).unwrap(),
            BASE_RUN_TYPE,
            "opening the wizard must not publish the draft"
        );
    }

    #[test]
    fn guided_run_type_rejects_unsafe_duplicate_and_colliding_slugs_transactionally() {
        let fixture = publication_fixture();
        let mut model = publication_model(fixture.path());
        let original_project = model.config.documents
            [config_document_index(&model, "project.yaml")]
        .text
        .clone();
        let original_count = model.config.documents.len();

        for slug in ["../escape", "base", "two--words", "UPPER"] {
            let mut wizard = open_run_type_wizard(&mut model);
            wizard.title = "Unsafe".to_owned();
            wizard.slug = slug.to_owned();
            wizard.slug_manually_edited = true;
            model.dialog = Some(Dialog::RunTypeWizard(wizard));
            assert!(
                model.create_run_type_from_wizard().is_err(),
                "accepted {slug}"
            );
            assert_eq!(model.config.documents.len(), original_count);
            assert_eq!(
                model.config.documents[config_document_index(&model, "project.yaml")].text,
                original_project
            );
        }
    }

    #[test]
    fn title_drives_slug_only_until_the_slug_is_edited() {
        let fixture = publication_fixture();
        let mut model = publication_model(fixture.path());
        let mut wizard = open_run_type_wizard(&mut model);
        wizard.title = "UI Feature: Polish".to_owned();
        wizard.sync_automatic_slug();
        assert_eq!(wizard.slug, "ui-feature-polish");
        wizard.slug = "interface-work".to_owned();
        wizard.slug_manually_edited = true;
        wizard.title = "Renamed feature".to_owned();
        wizard.sync_automatic_slug();
        assert_eq!(wizard.slug, "interface-work");
    }

    #[test]
    fn live_agent_projection_uses_verified_runtime_truth_and_friendly_metadata() {
        let data = RunData::from_snapshot(json!({
            "run":{"id":"run-secret","goal":"Build notes","status":"planning"},
            "stages":[
                {"definition":{"id":"risk-plan-019f","title":"Plan risk controls"}},
                {"definition":{"id":"waiting-stage-019f","title":"Waiting stage"}}
            ],
            "board":{"ticket_workflows":{
                "ticket-live-019f":{
                    "worker_state":"running",
                    "active_worker_step":"build"
                },
                "ticket-closed-019f":{
                    "worker_state":"running",
                    "active_worker_step":"build"
                }
            }},
            "tickets":[
                {
                    "id":"ticket-live-019f",
                    "operation":"build",
                    "title":"build: Notes editor",
                    "status":"in_progress",
                    "workflow":[{"id":"build","persona":"implementer"}],
                    "outputs":[{
                        "id":"output-secret-019f",
                        "step_id":"build",
                        "persona":"implementer",
                        "recorded_at":"2026-07-10T12:00:00Z"
                    }]
                },
                {
                    "id":"ticket-closed-019f",
                    "title":"Closed work",
                    "status":"closed",
                    "workflow":[{"id":"build","persona":"implementer"}]
                },
                {
                    "id":"ticket-history-019f",
                    "title":"Research outline",
                    "status":"closed",
                    "workflow":[{"id":"summarize","persona":"writer"}],
                    "outputs":[{
                        "id":"history-output-secret-019f",
                        "step_id":"summarize",
                        "persona":"writer",
                        "recorded_at":"2026-07-10T12:05:00Z"
                    }]
                }
            ],
            "agents":[
                {
                    "id":"planner-secret",
                    "stage_id":"risk-plan-019f",
                    "persona":"planner",
                    "status":"running"
                },
                {
                    "id":"waiting-secret",
                    "stage_id":"waiting-stage-019f",
                    "persona":"planner",
                    "status":"waiting"
                },
                {
                    "id":"worker-secret",
                    "ticket_id":"ticket-live-019f",
                    "persona":"implementer",
                    "status":"starting"
                },
                {
                    "id":"broad-active-secret",
                    "persona":"reviewer",
                    "status":"active"
                },
                {
                    "id":"closed-worker-secret",
                    "ticket_id":"ticket-closed-019f",
                    "persona":"implementer",
                    "status":"running"
                }
            ]
        }));

        assert_eq!(
            data.live_agent_summaries(),
            vec![
                LiveAgentSummary {
                    title: "Plan risk controls".to_owned()
                },
                LiveAgentSummary {
                    title: "Notes editor".to_owned()
                }
            ]
        );
        assert_eq!(data.summary.as_ref().unwrap().active_agents, 2);
        assert_eq!(
            data.agent_summaries(),
            vec![
                AgentSummary {
                    key: "agent:planner-secret".to_owned(),
                    title: "Plan risk controls".to_owned(),
                    ticket_id: None,
                    ticket_title: None,
                    persona: "Planner".to_owned(),
                    status: "running".to_owned(),
                    live: true,
                    transcript: None,
                },
                AgentSummary {
                    key: "agent:worker-secret".to_owned(),
                    title: "Notes editor".to_owned(),
                    ticket_id: Some("ticket-live-019f".to_owned()),
                    ticket_title: Some("Notes editor".to_owned()),
                    persona: "Implementer".to_owned(),
                    status: "starting".to_owned(),
                    live: true,
                    transcript: None,
                },
                AgentSummary {
                    key: "output:ticket-history-019f:history-output-secret-019f".to_owned(),
                    title: "Research outline".to_owned(),
                    ticket_id: Some("ticket-history-019f".to_owned()),
                    ticket_title: Some("Research outline".to_owned()),
                    persona: "Writer".to_owned(),
                    status: "completed".to_owned(),
                    live: false,
                    transcript: None,
                },
                AgentSummary {
                    key: "output:ticket-live-019f:output-secret-019f".to_owned(),
                    title: "Notes editor".to_owned(),
                    ticket_id: Some("ticket-live-019f".to_owned()),
                    ticket_title: Some("Notes editor".to_owned()),
                    persona: "Implementer".to_owned(),
                    status: "completed".to_owned(),
                    live: false,
                    transcript: None,
                },
                AgentSummary {
                    key: "agent:waiting-secret".to_owned(),
                    title: "Waiting stage".to_owned(),
                    ticket_id: None,
                    ticket_title: None,
                    persona: "Planner".to_owned(),
                    status: "waiting".to_owned(),
                    live: false,
                    transcript: None,
                },
                AgentSummary {
                    key: "agent:closed-worker-secret".to_owned(),
                    title: "Closed work".to_owned(),
                    ticket_id: Some("ticket-closed-019f".to_owned()),
                    ticket_title: Some("Closed work".to_owned()),
                    persona: "Implementer".to_owned(),
                    status: "running".to_owned(),
                    live: false,
                    transcript: None,
                },
                AgentSummary {
                    key: "agent:broad-active-secret".to_owned(),
                    title: "Reviewer".to_owned(),
                    ticket_id: None,
                    ticket_title: None,
                    persona: "Reviewer".to_owned(),
                    status: "active".to_owned(),
                    live: false,
                    transcript: None,
                },
            ]
        );
    }

    #[test]
    fn semantic_lead_row_survives_between_slices_without_raw_lead_duplicates() {
        let mut data = RunData::from_snapshot(json!({
            "run":{"id":"run-secret","goal":"Build safely","status":"active"},
            "stages":[{
                "status":"working",
                "definition":{"id":"orchestrate","title":"Execute compiled work","kind":"orchestration"}
            }],
            "agents":[
                {
                    "id":"orchestration-orchestrate",
                    "stage_id":"orchestrate",
                    "persona":"lead",
                    "status":"between_slices",
                    "stdout_path":"/tmp/latest-lead.jsonl",
                    "updated_at":"2026-07-14T12:03:00Z"
                },
                {
                    "id":"raw-lead-slice-one",
                    "persona":"lead",
                    "status":"completed",
                    "pid":41,
                    "stdout_path":"/tmp/old-lead.jsonl",
                    "updated_at":"2026-07-14T12:02:00Z"
                },
                {
                    "id":"ticket-integrator",
                    "ticket_id":"ticket-one",
                    "stage_id":"integrate",
                    "persona":"integrator",
                    "status":"completed",
                    "updated_at":"2026-07-14T12:01:00Z"
                }
            ]
        }));

        let inactive = data.agent_summaries();
        let leads = inactive
            .iter()
            .filter(|agent| agent.persona == "Lead")
            .collect::<Vec<_>>();
        assert_eq!(leads.len(), 1, "{inactive:#?}");
        assert_eq!(leads[0].key, "agent:orchestration-orchestrate");
        assert!(!leads[0].live);
        assert_eq!(
            leads[0]
                .transcript
                .as_ref()
                .map(|source| source.path.as_path()),
            Some(Path::new("/tmp/latest-lead.jsonl"))
        );
        assert!(inactive.iter().any(|agent| agent.persona == "Integrator"));

        data.agents[0]["status"] = Value::String("running".to_owned());
        data.agents[0]["pid"] = Value::from(42);
        let active = data.agent_summaries();
        let leads = active
            .iter()
            .filter(|agent| agent.persona == "Lead")
            .collect::<Vec<_>>();
        assert_eq!(leads.len(), 1, "{active:#?}");
        assert_eq!(leads[0].key, "agent:orchestration-orchestrate");
        assert!(leads[0].live);
    }

    #[test]
    fn pending_question_selection_includes_open_pending_and_resume_states() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-secret","goal":"Decide","status":"planning"},
                "questions":[
                    {"id":"closed-secret","status":"answered","prompt":"Already done"},
                    {"id":"pending-secret","status":"pending","prompt":"Choose scope"},
                    {
                        "id":"resume-secret",
                        "status":"answered_pending_resume",
                        "prompt":"Resume planning",
                        "answer":{"custom":"Use the safe path"}
                    }
                ]
            }),
        );

        assert_eq!(model.selected_pending_questions().len(), 2);
        assert_eq!(model.runs[0].summary.as_ref().unwrap().open_questions, 2);
        model.select_next_question(1);
        model.open_selected_question();
        assert!(matches!(
            model.dialog,
            Some(Dialog::AnswerQuestion(ref answer))
                if answer.prompt == "Resume planning" && answer.pending_resume
        ));
    }

    #[test]
    fn pending_question_batches_follow_ordinal_and_preserve_group_order() {
        let model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-secret","goal":"Decide","status":"planning"},
                "questions":[
                    {"id":"a-2","status":"open","prompt":"Batch A second","batch":{"id":"batch-a-secret","ordinal":2,"size":3}},
                    {"id":"solo","status":"open","prompt":"Standalone"},
                    {"id":"a-1","status":"open","prompt":"Batch A first","batch":{"id":"batch-a-secret","ordinal":1,"size":3}},
                    {"id":"b-2","status":"open","prompt":"Batch B second","batch":{"id":"batch-b-secret","ordinal":2,"size":2}},
                    {"id":"a-3","status":"open","prompt":"Batch A third","batch":{"id":"batch-a-secret","ordinal":3,"size":3}},
                    {"id":"b-1","status":"open","prompt":"Batch B first","batch":{"id":"batch-b-secret","ordinal":1,"size":2}}
                ]
            }),
        );

        assert_eq!(
            model
                .selected_pending_questions()
                .iter()
                .filter_map(|question| question.get("prompt").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            [
                "Batch A first",
                "Batch A second",
                "Batch A third",
                "Standalone",
                "Batch B first",
                "Batch B second",
            ]
        );
    }

    #[test]
    fn answered_batch_member_waits_for_open_siblings_but_singleton_retry_stays_available() {
        let mut model = ControlCenterModel::from_snapshot(
            "/tmp/project".into(),
            json!({
                "run":{"id":"run-1","goal":"Decide","status":"planning"},
                "questions":[
                    {
                        "id":"batch-answered",
                        "status":"answered_pending_resume",
                        "prompt":"Choose rejection behavior",
                        "batch":{"id":"batch-secret","ordinal":1,"size":2},
                        "options":[{"id":"one","label":"One","description":"First","recommended":true}],
                        "answer":{"option_id":"one"}
                    },
                    {
                        "id":"batch-open",
                        "status":"open",
                        "prompt":"Choose element policy",
                        "batch":{"id":"batch-secret","ordinal":2,"size":2},
                        "options":[{"id":"two","label":"Two","description":"Second","recommended":true}]
                    },
                    {
                        "id":"legacy-retry",
                        "status":"answered_pending_resume",
                        "prompt":"Retry legacy resume",
                        "options":[{"id":"safe","label":"Safe","description":"Retry","recommended":true}],
                        "answer":{"option_id":"safe"}
                    }
                ]
            }),
        );

        model.open_pending_question(0);
        assert!(matches!(
            model.dialog,
            Some(Dialog::AnswerQuestion(ref answer))
                if answer.pending_resume && answer.waiting_for_batch
                    && answer.batch_position == Some((1, 2))
        ));

        model.dialog = None;
        model.open_pending_question(2);
        assert!(matches!(
            model.dialog,
            Some(Dialog::AnswerQuestion(ref answer))
                if answer.pending_resume && !answer.waiting_for_batch
                    && answer.batch_position.is_none()
        ));
    }

    #[test]
    fn persona_card_edits_linked_markdown_without_reserializing_its_yaml() {
        let fixture = publication_fixture();
        let profile_path = fixture.path().join(".codex/koni/profile.yaml");
        fs::write(
            &profile_path,
            fs::read_to_string(&profile_path).unwrap().replace(
                "  graph: [modules/nodes.yaml]",
                "  graph: [modules/nodes.yaml]\n  personas: [personas.yaml]",
            ),
        )
        .unwrap();
        write_fixture_file(
            fixture.path(),
            ".codex/koni/personas.yaml",
            "personas:\n  - id: implementer\n    description: Implements bounded work\n    prompt: personas/implementer.md\n    model_role: ticket_worker\n    model: gpt-test\n    reasoning_effort: high\n    sandbox: {mode: workspace-write, approval_policy: never}\n",
        );
        write_fixture_file(
            fixture.path(),
            ".codex/koni/personas/implementer.md",
            "# Implementer\n\nWork carefully.\n",
        );
        let profile_root = fixture.path().join(".codex/koni");
        let original_hash = ProfileCompiler::compile(&profile_root).unwrap().hash;
        let persona_yaml = fs::read_to_string(profile_root.join("personas.yaml")).unwrap();
        let mut model = publication_model(fixture.path());
        model.config.select_resource_for(
            ConfigDomain::Agents,
            Path::new("personas.yaml"),
            ConfigResourceKind::Persona,
        );
        for suffix in [
            ".description",
            ".instructions",
            ".model",
            ".reasoning_effort",
        ] {
            assert!(
                model
                    .config
                    .form_rows
                    .iter()
                    .any(|row| row.path.ends_with(suffix)),
                "missing cohesive persona field {suffix}"
            );
        }
        assert!(
            !model
                .config
                .form_rows
                .iter()
                .any(|row| row.path.ends_with(".prompt"))
        );
        model.config.selected_form_row = model
            .config
            .form_rows
            .iter()
            .position(|row| row.edit_kind == FormRowEditKind::LinkedMarkdown)
            .unwrap();
        model.open_form_editor();
        assert!(model.config.linked_document_editor_active());
        assert_eq!(
            model.config.selected_document().unwrap().relative_path,
            Path::new("personas/implementer.md")
        );
        let document = model.config.selected_document_mut().unwrap();
        document.cursor_line = document.lines().len() - 1;
        document.cursor_column = document.lines().last().unwrap().chars().count();
        document.insert_text("Verify the result.\n");

        model.publish_config().unwrap();

        assert_eq!(
            fs::read_to_string(fixture.path().join(".codex/koni/personas/implementer.md")).unwrap(),
            "# Implementer\n\nWork carefully.\nVerify the result.\n"
        );
        assert_eq!(
            fs::read_to_string(profile_root.join("personas.yaml")).unwrap(),
            persona_yaml,
            "editing the prompt body must not serialize its YAML reference"
        );
        let revised = ProfileCompiler::compile(&profile_root).unwrap();
        assert_ne!(revised.hash, original_hash);
        assert_eq!(
            revised.resolve_persona("implementer").unwrap().instructions,
            "# Implementer\n\nWork carefully.\nVerify the result.\n"
        );
    }

    fn legacy_fixture(with_profile_collision: bool) -> TempDir {
        let temp = TempDir::new().unwrap();
        write_fixture_file(
            temp.path(),
            ".codex/koni/koni.toml",
            r#"
schema_version = "1.0"
engine = ">=0.1,<0.2"

[profile]
id = "legacy-research"
version = "1.0.0"
description = "Legacy research profile"

[git]
enabled = false
"#,
        );
        if with_profile_collision {
            write_fixture_file(
                temp.path(),
                ".codex/koni/profile.yaml",
                "do_not_replace: true\n",
            );
        }
        temp
    }

    #[test]
    fn legacy_migration_stages_valid_canonical_files_without_touching_live_config() {
        let fixture = legacy_fixture(false);
        let mut model = ControlCenterModel::load(fixture.path()).unwrap();
        assert!(model.legacy_migration_available);
        model.open_run_type_wizard();
        assert!(
            model.status.contains("press l in Configure"),
            "{}",
            model.status
        );
        assert!(!model.status.contains("press L"), "{}", model.status);
        model.open_legacy_migration();
        assert!(matches!(model.dialog, Some(Dialog::LegacyMigration(_))));

        model.stage_legacy_migration().unwrap();

        for relative in ["project.yaml", "profile.yaml", "run-types/legacy.yaml"] {
            let document = &model.config.documents[config_document_index(&model, relative)];
            assert!(document.is_new);
            assert!(document.diagnostics.is_empty());
        }
        assert!(
            model
                .config
                .pending_deletes
                .contains(Path::new("koni.toml"))
        );
        let legacy_path = fixture.path().join(".codex/koni/koni.toml");
        assert!(
            legacy_path.is_file(),
            "staging must not remove the Legacy source"
        );
        assert!(
            !fixture.path().join(".codex/koni/project.yaml").exists(),
            "staging must not publish canonical files"
        );

        model.publish_config().unwrap();
        assert!(!legacy_path.exists());
        let catalog = ProjectCatalogCompiler::compile(fixture.path()).unwrap();
        assert!(matches!(
            catalog.source,
            ProjectCatalogSource::Canonical { .. }
        ));
        assert_eq!(catalog.document.default_run_type, LEGACY_RUN_TYPE_ID);
    }

    #[test]
    fn legacy_migration_collision_rolls_back_without_staging_anything() {
        let fixture = legacy_fixture(true);
        let mut model = ControlCenterModel::load(fixture.path()).unwrap();
        let before = model
            .config
            .documents
            .iter()
            .map(|document| (document.relative_path.clone(), document.text.clone()))
            .collect::<Vec<_>>();

        let error = model.stage_legacy_migration().unwrap_err().to_string();

        assert!(error.contains("profile.yaml"));
        assert!(model.config.pending_deletes.is_empty());
        assert_eq!(
            model
                .config
                .documents
                .iter()
                .map(|document| (document.relative_path.clone(), document.text.clone()))
                .collect::<Vec<_>>(),
            before
        );
        assert_eq!(
            fs::read_to_string(fixture.path().join(".codex/koni/profile.yaml")).unwrap(),
            "do_not_replace: true\n"
        );
    }

    #[test]
    fn operate_focus_cycle_follows_the_visual_panel_order() {
        let mut model =
            ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), Value::Null);

        for (expected_focus, expected_subject) in [
            (Focus::Tickets, OverviewSubject::Ticket),
            (Focus::Agents, OverviewSubject::Ticket),
            (Focus::Details, OverviewSubject::Ticket),
            (Focus::Activity, OverviewSubject::Ticket),
            (Focus::Graph, OverviewSubject::Ticket),
            (Focus::Runs, OverviewSubject::Run),
        ] {
            model.cycle_focus(false);
            assert_eq!(model.focus, expected_focus);
            assert_eq!(model.overview_subject, expected_subject);
        }
        model.cycle_focus(true);
        assert_eq!(model.focus, Focus::Graph);
        assert_eq!(model.overview_subject, OverviewSubject::Run);
    }

    #[test]
    fn pending_questions_join_the_focus_cycle_only_while_their_panel_exists() {
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{"id":"run-secret","goal":"Demo","status":"planning"},
                "questions":[{
                    "id":"question-secret",
                    "status":"open",
                    "prompt":"Choose a contract",
                    "options":[{"id":"strict","label":"Strict"}]
                }]
            }),
        );
        model.focus = Focus::Details;

        model.cycle_focus(false);
        assert_eq!(model.focus, Focus::Questions);
        model.cycle_focus(false);
        assert_eq!(model.focus, Focus::Activity);
        model.cycle_focus(true);
        assert_eq!(model.focus, Focus::Questions);

        model.runs[model.selected_run].questions.clear();
        model.normalize_conditional_focus();
        assert_eq!(model.focus, Focus::Details);
        model.cycle_focus(false);
        assert_eq!(model.focus, Focus::Activity);
        model.cycle_focus(true);
        assert_eq!(model.focus, Focus::Details);
        model.cycle_focus(true);
        assert_eq!(model.focus, Focus::Agents);
    }

    #[test]
    fn details_cycle_contains_only_overview_planning_and_stages() {
        let mut model =
            ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), Value::Null);
        assert_eq!(Panel::ALL.map(Panel::label), ["overview", "plan", "stages"]);

        for expected in [Panel::Planning, Panel::Stages, Panel::Overview] {
            model.cycle_detail_panel(1);
            assert_eq!(model.detail_panel, expected);
        }
    }

    #[test]
    fn configure_focus_cycle_never_enters_the_operate_graph() {
        let mut model =
            ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), Value::Null);
        model.mode = Mode::Configure;
        model.focus = Focus::ConfigTree;
        model.config.documents.push(configuration_document(
            "project.yaml",
            "project: {id: demo, title: Demo}\ndefault_run_type: medium\nrun_types: []\n",
        ));
        model.config.rebuild_projection();

        for expected in [Focus::ConfigForm, Focus::Yaml, Focus::ConfigTree] {
            model.cycle_focus(false);
            assert_eq!(model.focus, expected);
        }
        model.cycle_focus(true);
        assert_eq!(model.focus, Focus::Yaml);

        model
            .config
            .select_domain_index(ConfigDomain::ActionsChecks.index());
        model.focus = Focus::ConfigTree;
        assert!(model.config.form_rows.is_empty());
        for expected in [Focus::ConfigForm, Focus::ConfigTree] {
            model.cycle_focus(false);
            assert_eq!(model.focus, expected);
        }
    }

    #[test]
    fn switching_runs_replaces_selected_run_projection() {
        let first = RunData::from_snapshot(json!({
            "run":{"id":"one","goal":"First","status":"active","profile_id":"a"},
            "graph":[{"id":"n1","type":"task","title":"One"}],
            "tickets":[]
        }));
        let second = RunData::from_snapshot(json!({
            "run":{"id":"two","goal":"Second","status":"active","profile_id":"b"},
            "graph":[{"id":"n2","type":"task","title":"Two"}],
            "tickets":[]
        }));
        let mut model =
            ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), Value::Null);
        model.runs = vec![first, second];
        model.selected_agent = 9;
        model.select_next_run(1);
        assert_eq!(
            model
                .selected_run_data()
                .unwrap()
                .summary
                .as_ref()
                .unwrap()
                .id,
            "two"
        );
        assert_eq!(model.selected_run_data().unwrap().graph[0]["id"], "n2");
        assert_eq!(model.selected_agent, 0);
    }

    #[test]
    fn graph_scope_follows_the_last_run_or_ticket_selection() {
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{"id":"run","goal":"Demo","status":"active"},
                "graph":[{"id":"integration-node","type":"task","title":"Integrated"}],
                "tickets":[{"id":"ticket","title":"Scoped work","status":"in_progress"}],
                "ticket_graphs":{"ticket":{"graph":[
                    {"id":"checkout-node","type":"task","title":"Checkout"}
                ]}}
            }),
        );

        model.focus_runs();
        assert_eq!(model.selected_graph_values()[0]["id"], "integration-node");
        assert!(!model.selected_graph_is_ticket_projection());

        model.focus_tickets();
        assert_eq!(model.selected_graph_values()[0]["id"], "checkout-node");
        assert!(model.selected_graph_is_ticket_projection());

        model.focus = Focus::Graph;
        assert_eq!(model.selected_graph_values()[0]["id"], "checkout-node");
        model.focus_runs();
        assert_eq!(model.selected_graph_values()[0]["id"], "integration-node");
    }

    #[test]
    fn approval_review_projects_live_durable_action_planning_stages() {
        let run_id = "019f551e-7fb4-7862-889a-890af6d0314e";
        let question_id = "019f5520-24fd-7fe1-bad9-96debec277b3";
        let batch_id = "019f5520-24fd-7fe1-bad9-96c4aa404275";
        let session_id = "019f551e-816b-7623-9058-9cc8b5861113";
        let agent_id = "planning-architecture-plan";
        let worktree =
            "/tmp/project/.git/koni/worktrees/019f551e-7fb4-7862-889a-890af6d0314e/planning";
        let prompt_path = "agents/planning-architecture-plan/attempt-2/prompt.md";
        let stdout_path = "agents/planning-architecture-plan/attempt-2/stdout.jsonl";
        let stderr_path = "agents/planning-architecture-plan/attempt-2/stderr.log";
        let output_path = "agents/planning-architecture-plan/attempt-2/last-message.md";
        let base_commit = "e04c4ad0400f7c677e741abf4b11878d19534b89";
        let pid = 40_350_u64;
        let architecture_body = format!(
            "Architecture research plan body\nRun {run_id}; question {question_id}; batch {batch_id}; session {session_id}; agent {agent_id}; checkout {worktree}; prompt {prompt_path}; stdout {stdout_path}; stderr {stderr_path}; output {output_path}; PID {pid}. Keep base {base_commit}, C1, and G2 visible."
        );
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "project_root":"/tmp/project",
                "run":{
                    "id":run_id,
                    "goal":"Prove sortedness behavior",
                    "status":"planning",
                    "run_type_title":"Large",
                    "base_commit":base_commit,
                    "repository_root":"/tmp/project",
                    "planning_worktree":worktree
                },
                "questions":[{
                    "id":question_id,
                    "status":"answered",
                    "prompt":"Choose the contract",
                    "context":"Resolve the scientific boundary.",
                    "batch":{"id":batch_id,"ordinal":1,"size":1},
                    "options":[{"id":"choice-1","label":"Strict","recommended":true}],
                    "answer":{"option_id":"choice-1","source":"human"},
                    "session_resume":{
                        "agent_id":agent_id,
                        "session_id":session_id,
                        "working_directory":worktree
                    }
                }],
                "stages":[
                    {
                        "status":"succeeded",
                        "definition":{
                            "id":"intake",
                            "title":"Validate intake",
                            "kind":"action",
                            "required":true,
                            "config":{"action":"planning.intake","compiler_owned":true}
                        },
                        "output":{"output":{"operation":"planning.intake"}}
                    },
                    {
                        "status":"succeeded",
                        "definition":{
                            "id":"architecture-plan",
                            "title":"Plan research architecture",
                            "kind":"action",
                            "required":true,
                            "config":{"persona":"run-planner","prompt":"Map the claim and evidence architecture."}
                        },
                        "output":{"output":{
                            "agent_id":agent_id,
                            "session_id":session_id,
                            "planning_worktree":worktree,
                            "output":architecture_body,
                            "review":{
                                "architecture":"- Architecture research plan body\n- Keep C1 and G2 visible.",
                                "risk":null,
                                "verification":null
                            }
                        }}
                    },
                    {
                        "status":"succeeded",
                        "definition":{
                            "id":"risk-plan",
                            "title":"Plan research risks",
                            "kind":"action",
                            "required":true,
                            "config":{"persona":"run-planner","prompt":"Identify validity threats and hazards."}
                        },
                        "output":{"output":{
                            "agent_id":"planning-risk-plan",
                            "output":"Risk full agent plan body",
                            "review":{"architecture":null,"risk":"- Risk research plan body","verification":null}
                        }}
                    },
                    {
                        "status":"succeeded",
                        "definition":{
                            "id":"verification-plan",
                            "title":"Plan verification",
                            "kind":"action",
                            "required":true,
                            "config":{"persona":"run-planner","prompt":"Define receipts, evidence, and acceptance criteria."}
                        },
                        "output":{"output":{
                            "agent_id":"planning-verification-plan",
                            "output":"Verification full agent plan body",
                            "review":{"architecture":null,"risk":null,"verification":"- Verification research plan body"}
                        }}
                    }
                ],
                "agents":[{
                    "id":agent_id,
                    "stage_id":"architecture-plan",
                    "codex_session_id":session_id,
                    "pid":pid,
                    "process_identity":{"pid":pid,"process_group_id":pid},
                    "working_directory":worktree,
                    "prompt_path":prompt_path,
                    "stdout_path":stdout_path,
                    "stderr_path":stderr_path,
                    "output_path":output_path
                }]
            }),
        );

        model.open_selected_run_approval();
        let Some(Dialog::Approval(approval)) = &model.dialog else {
            panic!("approval review did not open");
        };
        for (title, body) in [
            ("Architecture", "Architecture research plan body"),
            ("Risk", "Risk research plan body"),
            ("Verification", "Verification research plan body"),
        ] {
            let section = approval
                .sections
                .iter()
                .find(|section| section.title == title)
                .expect("approval section should exist");
            assert_eq!(section.title, title);
            assert!(section.body.contains(body), "{}", section.body);
            assert!(
                section.body.contains("### Legacy planner summary"),
                "{}",
                section.body
            );
            assert!(
                !section.body.contains(&format!("### {body}")),
                "legacy text must not be promoted into a fabricated heading: {}",
                section.body
            );
            assert!(!section.body.contains("No separate"), "{}", section.body);
        }
        assert!(
            approval
                .sections
                .iter()
                .all(|section| section.title != "Decisions")
        );
        assert!(approval.approval_enabled);
        assert!(approval.blockers.is_empty());
        let rendered = approval
            .sections
            .iter()
            .map(|section| section.body.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        for secret in [
            run_id,
            question_id,
            batch_id,
            session_id,
            agent_id,
            worktree,
            prompt_path,
            stdout_path,
            stderr_path,
            output_path,
            base_commit,
        ] {
            assert!(!rendered.contains(secret), "approval leaked {secret}");
        }
        assert!(!rendered.contains(&format!("PID {pid}")), "{rendered}");
        assert!(rendered.contains("C1"), "{rendered}");
        assert!(rendered.contains("G2"), "{rendered}");
        assert_eq!(
            model.runs[model.selected_run].stages[1]["output"]["output"]["output"],
            architecture_body,
            "approval redaction must never mutate durable planning output"
        );
    }

    #[test]
    fn approval_pid_redaction_requires_human_token_boundaries() {
        assert_eq!(
            replace_ascii_token(
                "PID 40350, scientific C40350, sample_40350, and count 1403507",
                "40350",
                "the planner process",
            ),
            "PID the planner process, scientific C40350, sample_40350, and count 1403507"
        );
    }

    #[test]
    fn approval_review_recognizes_linked_compiler_planner_when_persona_is_absent() {
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{"id":"run-legacy-shape","goal":"Plan safely","status":"planning"},
                "stages":[{
                    "status":"succeeded",
                    "definition":{
                        "id":"architecture-plan",
                        "title":"Plan architecture",
                        "kind":"action",
                        "required":true,
                        "config":{"prompt":"Map the architecture."}
                    }
                }],
                "agents":[{
                    "id":"planning-architecture-plan",
                    "stage_id":"architecture-plan",
                    "result":{"output":"Legacy planning body"}
                }]
            }),
        );

        model.open_selected_run_approval();
        let Some(Dialog::Approval(approval)) = &model.dialog else {
            panic!("approval review did not open");
        };
        assert!(approval.sections[0].body.contains("Legacy planning body"));
        assert!(approval.approval_enabled);
    }

    #[test]
    fn approval_review_prefers_the_human_summary_without_mutating_the_complete_plan() {
        let full_plan = (1..=18)
            .map(|index| {
                format!(
                    "- Implementation detail {index}: update src/feature_{index}.rs with the complete acceptance contract and verification notes."
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{"id":"run-full-plan","goal":"Review everything","status":"planning"},
                "stages":[{
                    "status":"succeeded",
                    "definition":{
                        "id":"architecture-plan",
                        "title":"Plan architecture",
                        "kind":"planning",
                        "required":true
                    },
                    "output":{"output":{
                        "output":full_plan,
                        "review":{
                            "architecture":[
                                {"heading":"Shared feature contract","description":"Update the shared feature contract."},
                                {"heading":"Regression coverage","description":"Preserve focused regression coverage."}
                            ],
                            "risk":null,
                            "verification":null
                        }
                    }}
                }]
            }),
        );

        model.open_selected_run_approval();
        let Some(Dialog::Approval(approval)) = &model.dialog else {
            panic!("approval review did not open");
        };
        let body = &approval.sections[0].body;
        assert!(body.contains("### Shared feature contract"), "{body}");
        assert!(
            body.contains("Update the shared feature contract."),
            "{body}"
        );
        assert!(body.contains("### Regression coverage"), "{body}");
        assert!(
            body.contains("Preserve focused regression coverage."),
            "{body}"
        );
        assert!(!body.contains("Implementation detail 1:"), "{body}");
        assert!(!body.contains("src/feature_18.rs"), "{body}");
        assert_eq!(
            model.runs[model.selected_run].stages[0]["output"]["output"]["output"], full_plan,
            "the operator projection must never replace the execution artifact"
        );
    }

    #[test]
    fn approval_graph_seed_is_bounded_semantic_and_hides_compiler_metadata() {
        let nodes = (1..=14)
            .map(|index| {
                json!({
                    "key":format!("seed-key-secret-{index}"),
                    "type":if index == 1 { "change" } else { "proof" },
                    "title":format!("Semantic plan node {index}"),
                    "spec":{
                        "purpose":format!("Explain approved semantic purpose {index}"),
                        "path":format!("src/private-{index}.rs"),
                        "unprojected_detail":format!("Raw spec detail {index}")
                    }
                })
            })
            .collect::<Vec<_>>();
        let edges = (1..=18)
            .map(|index| {
                json!({
                    "source":"$root",
                    "relation":format!("approved_relation_{index}"),
                    "target":"seed-key-secret-1"
                })
            })
            .collect::<Vec<_>>();
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{"id":"run-private","goal":"Review semantic authority","status":"planning"},
                "stages":[{
                    "status":"succeeded",
                    "definition":{"id":"final-plan","title":"Finalize plan","kind":"planning","required":true},
                    "output":{"output":{
                        "output":"Complete compiler plan",
                        "review":{"architecture":[{
                            "heading":"Shared contract",
                            "description":"Keep the approved behavior coherent."
                        }]},
                        "graph_seed":{
                            "root_spec":{
                                "acceptance_intent":"Acceptance intent is explicit",
                                "compatibility":"seed-key-secret-1 remains connected to $root",
                                "evidence":"Focused proof is required",
                                "operator_authority":"Approval remains human-owned",
                                "requested_scope":"Requested scope is bounded",
                                "rollout":"Delivery remains reversible",
                                "source_path":"/tmp/private-root-path",
                                "graph_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                            },
                            "nodes":nodes,
                            "edges":edges
                        }
                    }}
                }]
            }),
        );

        model.open_selected_run_approval();
        let Some(Dialog::Approval(approval)) = &model.dialog else {
            panic!("approval review did not open");
        };
        let graph_seed = approval
            .sections
            .iter()
            .find(|section| section.title == "Graph Seed")
            .expect("the approved semantic seed must be inspectable before approval");
        let body = &graph_seed.body;

        for expected in [
            "8 root facts · 14 semantic nodes · 18 relationships",
            "### Root enrichment",
            "Acceptance intent: Acceptance intent is explicit",
            "### Semantic nodes",
            "Change · Semantic plan node 1",
            "Explain approved semantic purpose 1",
            "### Relationships",
            "Objective → approved relation 1 → Semantic plan node 1",
            "### Omitted from this view",
            "3 root facts · 2 nodes · 2 relationships",
        ] {
            assert!(body.contains(expected), "missing {expected}: {body}");
        }
        for hidden in [
            "seed-key-secret",
            "$root",
            "private-root-path",
            "private-1.rs",
            "0123456789abcdef",
            "Raw spec detail",
            "Semantic plan node 13",
            "approved relation 17",
        ] {
            assert!(!body.contains(hidden), "Graph Seed leaked {hidden}: {body}");
        }
        assert_eq!(
            model.runs[model.selected_run].stages[0]["output"]["output"]["graph_seed"]["nodes"][0]
                ["key"],
            "seed-key-secret-1",
            "the display projection must not mutate the compiler-owned seed"
        );
    }

    #[test]
    fn graph_seed_relationships_never_reveal_nodes_outside_projection_limit() {
        let nodes = (1..=14)
            .map(|index| {
                json!({
                    "key":format!("bounded-node-{index}"),
                    "type":"change",
                    "title":format!("Bounded semantic node {index}"),
                    "spec":{"purpose":format!("Describe bounded node {index}")}
                })
            })
            .collect::<Vec<_>>();
        let body = graph_seed_approval_body(&json!({
            "root_spec":{"intent":"Keep the operator projection bounded"},
            "nodes":nodes,
            "edges":[{
                "source":"$root",
                "relation":"includes",
                "target":"bounded-node-13"
            }]
        }));

        assert!(body.contains("Bounded semantic node 12"), "{body}");
        assert!(!body.contains("Bounded semantic node 13"), "{body}");
        assert!(!body.contains("Bounded semantic node 14"), "{body}");
        assert!(
            body.contains("0 root facts · 2 nodes · 1 relationship"),
            "{body}"
        );
    }

    #[test]
    fn graph_seed_projection_rejects_scalar_raw_spec_and_schema_fields() {
        let body = graph_seed_approval_body(&json!({
            "root_spec":{
                "semantic_intent":"Keep one safe semantic fact",
                "spec":"raw-spec-sentinel",
                "raw_spec":"raw-specification-sentinel",
                "schema":"schema-sentinel",
                "node_key":"private-local-key"
            },
            "nodes":[{
                "key":"private-local-key",
                "type":"change",
                "title":"Visible semantic change",
                "spec":{"purpose":"Explain the visible semantic change"}
            }],
            "edges":[]
        }));

        assert!(
            body.contains("Semantic intent: Keep one safe semantic fact"),
            "{body}"
        );
        for hidden in [
            "raw-spec-sentinel",
            "raw-specification-sentinel",
            "schema-sentinel",
            "private-local-key",
            "Raw spec:",
            "Schema:",
            "Node key:",
        ] {
            assert!(!body.contains(hidden), "Graph Seed leaked {hidden}: {body}");
        }
        assert!(
            body.contains("4 root facts · 0 nodes · 0 relationships"),
            "{body}"
        );
    }

    #[test]
    fn graph_seed_projection_rejects_markdown_wrapped_and_prefixed_identifiers() {
        let hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let uuid = "550e8400-e29b-41d4-a716-446655440000";
        let body = graph_seed_approval_body(&json!({
            "root_spec":{
                "semantic_intent":"Keep safe surrounding meaning",
                "risk_summary":format!("`{hash}`"),
                "rollout_summary":format!("sha256:{hash}"),
                "verification_summary":format!("**{uuid}**")
            },
            "nodes":[{
                "key":"identifier-test-node",
                "type":"proof",
                "title":format!("Identifier id:{uuid}"),
                "spec":{"purpose":format!("Never expose __{hash}__")}
            }],
            "edges":[]
        }));

        assert!(
            body.contains("Semantic intent: Keep safe surrounding meaning"),
            "{body}"
        );
        assert!(body.contains("Proof · Semantic node 1"), "{body}");
        assert!(!body.contains(hash), "{body}");
        assert!(!body.contains(uuid), "{body}");
    }

    #[test]
    fn graph_seed_projection_never_exposes_embedded_local_key_substrings() {
        let local_key = "seed-key-secret";
        let body = graph_seed_approval_body(&json!({
            "root_spec":{
                "intent":format!("prefix{local_key}_suffix")
            },
            "nodes":[{
                "key":local_key,
                "type":format!("change_{local_key}_suffix"),
                "title":format!("prefix{local_key}"),
                "spec":{"purpose":format!("Keep {local_key}Suffix private")}
            }],
            "edges":[{
                "source":"$root",
                "relation":format!("connects_{local_key}_suffix"),
                "target":local_key
            }]
        }));

        assert!(!body.contains(local_key), "{body}");
        assert!(body.contains("Node · Semantic node 1"), "{body}");
        assert!(
            body.contains("1 root fact · 0 nodes · 1 relationship"),
            "{body}"
        );
    }

    #[test]
    fn approval_graph_seed_prefers_the_durable_stage_then_agent_then_transcript() {
        let seed = |title: &str| {
            json!({
                "root_spec":{"intent":"Keep approval inspectable"},
                "nodes":[{
                    "key":"local-secret-key",
                    "type":"change",
                    "title":title,
                    "spec":{"purpose":"Explain the semantic change"}
                }],
                "edges":[{
                    "source":"$root",
                    "relation":"decomposes_into",
                    "target":"local-secret-key"
                }]
            })
        };
        let mut run = RunData::from_snapshot(json!({
            "run":{"id":"run","goal":"Review the seed","status":"planning"},
            "stages":[
                {
                    "status":"succeeded",
                    "definition":{"id":"seed-plan","kind":"planning","title":"Seed plan"},
                    "output":{"output":{"output":"Complete plan","graph_seed":seed("Stage seed")}}
                },
                {
                    "status":"failed",
                    "definition":{"id":"failed-plan","kind":"planning","title":"Failed plan"},
                    "output":{"output":{"graph_seed":seed("Failed stale seed")}}
                }
            ],
            "agents":[{
                "id":"planning-seed-plan",
                "stage_id":"seed-plan",
                "result":{"graph_seed":seed("Agent seed")}
            }],
            "planning_transcript":[{
                "type":"planning.output",
                "stage_id":"seed-plan",
                "agent_id":"planning-seed-plan",
                "output":{"graph_seed":seed("Transcript seed")}
            }]
        }));
        let title = |run: &RunData| {
            planning_graph_seed(run)
                .and_then(|seed| seed.get("nodes"))
                .and_then(Value::as_array)
                .and_then(|nodes| nodes.first())
                .and_then(|node| node.get("title"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        };

        assert_eq!(title(&run).as_deref(), Some("Stage seed"));
        run.stages[0]["output"]["output"]
            .as_object_mut()
            .unwrap()
            .remove("graph_seed");
        assert_eq!(title(&run).as_deref(), Some("Agent seed"));
        run.agents[0]["result"]
            .as_object_mut()
            .unwrap()
            .remove("graph_seed");
        assert_eq!(title(&run).as_deref(), Some("Transcript seed"));
    }

    #[test]
    fn approved_plan_ignores_graph_seed_shaped_outputs_from_post_approval_stages() {
        let seed = |title: &str| {
            json!({
                "root_spec":{"intent":"Keep the approved seed immutable"},
                "nodes":[{
                    "key":"approved-seed-node",
                    "type":"change",
                    "title":title,
                    "spec":{"purpose":"Describe the approved semantic change"}
                }],
                "edges":[]
            })
        };
        let run = RunData::from_snapshot(json!({
            "run":{"id":"run","goal":"Keep approval authoritative","status":"active"},
            "stages":[
                {
                    "status":"succeeded",
                    "definition":{"id":"seed-plan","kind":"planning","title":"Seed plan"},
                    "output":{"output":{"graph_seed":seed("Approved planning seed")}}
                },
                {
                    "status":"succeeded",
                    "definition":{"id":"explicit-approval","kind":"approval","title":"Approve"}
                },
                {
                    "status":"succeeded",
                    "definition":{"id":"compile-report","kind":"report","title":"Compile report"},
                    "output":{"output":{"graph_seed":seed("Unreviewed later seed")}}
                }
            ]
        }));

        let selected =
            planning_graph_seed(&run).expect("the approved planning seed remains visible");
        assert_eq!(selected["nodes"][0]["title"], "Approved planning seed");
        assert_ne!(selected["nodes"][0]["title"], "Unreviewed later seed");
    }

    #[test]
    fn approval_review_uses_authored_domains_from_one_focused_planning_pass() {
        let full_plan = "Complete focused execution plan retained for the compiler.";
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{"id":"run-focused-plan","goal":"Plan a focused change","status":"planning"},
                "stages":[{
                    "status":"succeeded",
                    "definition":{
                        "id":"focused-plan",
                        "title":"Focused plan",
                        "kind":"action",
                        "required":true,
                        "config":{"persona":"run-planner","prompt":"Produce one focused implementation plan."}
                    },
                    "output":{"output":{
                        "output":full_plan,
                        "review":{
                            "architecture":[{
                                "heading":"Thread-backed SPICED cards",
                                "description":"Use five independent thread-backed inputs."
                            }],
                            "risk":[{
                                "heading":"Legacy data preserved",
                                "description":"Keep the existing Sales Notes thread intact."
                            }],
                            "verification":[{
                                "heading":"Red-to-green contract",
                                "description":"Prove the definition with a focused test."
                            }]
                        }
                    }}
                }]
            }),
        );

        model.open_selected_run_approval();
        let Some(Dialog::Approval(approval)) = &model.dialog else {
            panic!("approval review did not open");
        };
        for (section_title, heading, description) in [
            (
                "Architecture",
                "Thread-backed SPICED cards",
                "Use five independent thread-backed inputs.",
            ),
            (
                "Risk",
                "Legacy data preserved",
                "Keep the existing Sales Notes thread intact.",
            ),
            (
                "Verification",
                "Red-to-green contract",
                "Prove the definition with a focused test.",
            ),
        ] {
            let section = approval
                .sections
                .iter()
                .find(|section| section.title == section_title)
                .expect("review section should exist");
            assert!(
                section.body.contains(&format!("### {heading}")),
                "{}",
                section.body
            );
            assert!(section.body.contains(description), "{}", section.body);
            assert!(!section.body.contains("No separate"), "{}", section.body);
            assert!(
                !section.body.contains(full_plan),
                "the approval modal must show the authored concise review, not the durable compiler plan: {}",
                section.body
            );
        }
        assert_eq!(
            model.runs[model.selected_run].stages[0]["output"]["output"]["output"], full_plan,
            "the structured review must not replace the full compiler plan"
        );
    }

    #[test]
    fn approval_decisions_render_questions_answers_and_notes_as_separate_scan_lines() {
        let body = resolved_decisions_body(&[
            json!({
                "prompt":"Should the proposal page change too?",
                "options":[{"id":"both","label":"Update both surfaces"}],
                "answer":{
                    "option_id":"both",
                    "notes":"Keep legacy Sales Notes data under General."
                }
            }),
            json!({
                "prompt":"How strict should the migration be?",
                "answer":{"custom":"Keep every SPICED field optional"}
            }),
        ]);

        assert!(body.contains("## Question 1"), "{body}");
        assert!(
            body.contains("Should the proposal page change too?"),
            "{body}"
        );
        assert!(body.contains("Decision: Update both surfaces"), "{body}");
        assert!(
            body.contains("Notes: Keep legacy Sales Notes data under General."),
            "{body}"
        );
        assert!(body.contains("## Question 2"), "{body}");
        assert!(
            body.contains("Decision: Keep every SPICED field optional"),
            "{body}"
        );
        assert!(!body.contains("   - Decision"), "{body}");
    }

    #[test]
    fn approval_review_condenses_legacy_combined_plans_by_operator_domain() {
        let full_plan = "## Resolved behavior\n- Preserve existing notes.\n\n| UI field | Stored key |\n| --- | --- |\n| General | salesNotes |\n\n## Implementation architecture\n1. Add the shared storage contract.\n2. Wire both application surfaces.\n\n## Principal risks\n- Existing notes could become detached from their legacy key.\n- Roll back if compatibility checks fail.\n\nNo approval decisions remain.\n\n## Deterministic verification\n- Run focused storage and rendering tests.\n- Reload both surfaces and compare persisted values.";
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{"id":"run-legacy-combined","goal":"Review briefly","status":"planning"},
                "stages":[{
                    "status":"succeeded",
                    "definition":{
                        "id":"combined-plan",
                        "title":"Plan implementation, architecture, and risk",
                        "kind":"planning",
                        "required":true
                    },
                    "output":{"output":full_plan}
                }]
            }),
        );

        model.open_selected_run_approval();
        let Some(Dialog::Approval(approval)) = &model.dialog else {
            panic!("approval review did not open");
        };
        let architecture = &approval.sections[0].body;
        let risk = &approval.sections[1].body;
        let verification = &approval.sections[2].body;
        assert!(
            architecture.contains("### Legacy architecture excerpt"),
            "{architecture}"
        );
        assert!(
            !architecture.contains("### Preserve existing notes"),
            "legacy content must not be converted into inferred headings: {architecture}"
        );
        assert!(risk.contains("### Legacy risk excerpt"), "{risk}");
        assert!(
            verification.contains("### Legacy verification excerpt"),
            "{verification}"
        );
        assert!(
            architecture.contains("Preserve existing notes"),
            "{architecture}"
        );
        assert!(
            architecture.contains("shared storage contract"),
            "{architecture}"
        );
        assert!(
            !architecture.contains("compatibility checks fail"),
            "{architecture}"
        );
        assert!(!architecture.contains("UI field"), "{architecture}");
        assert!(risk.contains("legacy key"), "{risk}");
        assert!(risk.contains("Roll back"), "{risk}");
        assert!(!risk.contains("shared storage contract"), "{risk}");
        assert!(!risk.contains("approval decisions"), "{risk}");
        assert!(verification.contains("focused storage"), "{verification}");
        assert!(
            verification.contains("compare persisted values"),
            "{verification}"
        );
        assert!(!verification.contains("legacy key"), "{verification}");
        assert_eq!(
            model.runs[model.selected_run].stages[0]["output"]["output"], full_plan,
            "legacy condensation must remain a read-only projection"
        );
    }

    #[test]
    fn approval_review_projects_only_semantic_plans_without_ids() {
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project-secret"),
            json!({
                "run":{
                    "id":"run-secret-019f",
                    "goal":"Prove sortedness behavior",
                    "status":"planning",
                    "run_type_title":"Large Research"
                },
                "questions":[{
                    "id":"question-secret-019f",
                    "status":"answered",
                    "prompt":"How should invalid inputs be rejected?",
                    "options":[
                        {"id":"choice-secret-1","label":"Raise TypeError","recommended":true},
                        {"id":"choice-secret-2","label":"Return false","recommended":false}
                    ],
                    "answer":{"option_id":"choice-secret-1"},
                    "session_resume":{"session_id":"session-secret"}
                }],
                "stages":[
                    {
                        "status":"succeeded",
                        "definition":{"id":"architecture-secret","title":"Plan architecture","kind":"action","required":true,"config":{"persona":"run-planner","prompt":"Map the architecture."}},
                        "output":{"output":{"agent_id":"agent-architecture-secret","output":"Architecture full text"}}
                    },
                    {
                        "status":"succeeded",
                        "definition":{"id":"risk-secret","title":"Plan risk controls","kind":"action","required":true,"config":{"persona":"run-planner","prompt":"Identify the risks."}}
                    },
                    {
                        "status":"succeeded",
                        "definition":{"id":"verification-secret","title":"Plan verification","kind":"action","required":true,"config":{"persona":"run-planner","prompt":"Define verification."}}
                    },
                    {"status":"pending","definition":{"id":"approval-secret","title":"Approve","kind":"manual"}}
                ],
                "agents":[
                    {
                        "id":"agent-risk-secret",
                        "stage_id":"risk-secret",
                        "pid":91919,
                        "working_directory":"/tmp/private-path-secret",
                        "result":{"output":"Risk full text"}
                    },
                    {
                        "id":"agent-verification-secret",
                        "stage_id":"verification-secret",
                        "pid":81818
                    }
                ],
                "planning_transcript":[{
                    "type":"planning.output",
                    "agent_id":"agent-verification-secret",
                    "session_id":"session-secret",
                    "output":{"output":"Verification full text"}
                }]
            }),
        );

        model.open_selected_run_approval();
        let Some(Dialog::Approval(approval)) = &model.dialog else {
            panic!("approval review did not open");
        };
        assert_eq!(
            approval
                .sections
                .iter()
                .map(|section| section.title.as_str())
                .collect::<Vec<_>>(),
            ["Architecture", "Risk", "Verification"]
        );
        assert!(
            approval
                .sections
                .iter()
                .all(|section| !section.body.contains("Decision: Raise TypeError"))
        );
        assert!(approval.sections[0].body.contains("Architecture full text"));
        assert!(approval.sections[1].body.contains("Risk full text"));
        assert!(approval.sections[2].body.contains("Verification full text"));
        assert!(approval.approval_enabled);
        let rendered_source = approval
            .sections
            .iter()
            .map(|section| section.body.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        for secret in [
            "run-secret",
            "question-secret",
            "choice-secret",
            "agent-risk-secret",
            "session-secret",
            "private-path-secret",
            "91919",
        ] {
            assert!(!rendered_source.contains(secret), "leaked {secret}");
        }
    }

    #[test]
    fn approval_review_fails_closed_when_a_required_planning_pass_has_no_durable_body() {
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{"id":"run-secret","goal":"Build safely","status":"planning"},
                "stages":[{
                    "status":"waiting",
                    "definition":{"id":"risk-secret","title":"Plan risk controls","kind":"action","required":true,"config":{"persona":"run-planner","prompt":"Identify the risks."}}
                }]
            }),
        );

        model.open_selected_run_approval();
        let Some(Dialog::Approval(approval)) = &model.dialog else {
            panic!("approval review did not open");
        };
        assert!(!approval.approval_enabled);
        assert_eq!(approval.blockers, ["Plan risk controls is incomplete"]);
        assert!(
            approval.sections[1]
                .body
                .contains("has not produced durable review text")
        );
    }

    #[test]
    fn pinned_run_type_title_survives_current_catalog_rename_and_deletion() {
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{
                    "id":"one",
                    "goal":"First",
                    "status":"planning",
                    "run_type_id":"rt_7f3a9c",
                    "run_type_title":"Original Research Sprint",
                    "question_policy":"interactive"
                }
            }),
        );
        model.run_types = vec![RunTypeOption {
            id: "rt_7f3a9c".to_owned(),
            title: "Renamed Catalog Entry".to_owned(),
            description: String::new(),
            planning_passes: 0,
            question_policy: "interactive".to_owned(),
            max_parallel: None,
            model_summary: None,
            stages: Vec::new(),
            agents: BTreeMap::new(),
        }];

        let summary = model.runs[0].summary.as_ref().unwrap();
        assert_eq!(
            summary.run_type_title.as_deref(),
            Some("Original Research Sprint")
        );
        assert_eq!(
            model.display_run_type_title(summary),
            "Original Research Sprint"
        );

        model.run_types.clear();
        assert_eq!(
            model.display_run_type_title(model.runs[0].summary.as_ref().unwrap()),
            "Original Research Sprint"
        );

        model.open_selected_run_approval();
        let Some(Dialog::Approval(approval)) = &model.dialog else {
            panic!("planning run did not open its approval dialog");
        };
        assert_eq!(approval.run_type_title, "Original Research Sprint");
        assert!(
            approval
                .sections
                .iter()
                .all(|section| !section.body.contains("rt_7f3a9c"))
        );
    }

    #[test]
    fn legacy_run_type_title_falls_back_to_catalog_then_humanized_id() {
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{
                    "id":"one",
                    "goal":"First",
                    "status":"active",
                    "run_type_id":"opaque.workflow-id"
                }
            }),
        );
        model.run_types = vec![RunTypeOption {
            id: "opaque.workflow-id".to_owned(),
            title: "Current Catalog Title".to_owned(),
            description: String::new(),
            planning_passes: 0,
            question_policy: "interactive".to_owned(),
            max_parallel: None,
            model_summary: None,
            stages: Vec::new(),
            agents: BTreeMap::new(),
        }];

        let summary = model.runs[0].summary.as_ref().unwrap();
        assert_eq!(summary.run_type_title, None);
        assert_eq!(
            model.display_run_type_title(summary),
            "Current Catalog Title"
        );

        model.run_types.clear();
        assert_eq!(
            model.display_run_type_title(model.runs[0].summary.as_ref().unwrap()),
            "Opaque workflow id"
        );
    }

    #[test]
    fn active_tab_never_falls_back_to_all_tickets() {
        let snapshot = json!({
            "run":{"id":"one","goal":"First","status":"active","profile_id":"a"},
            "tickets":[{"id":"closed","status":"closed","blockers":[]}]
        });
        let model = ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), snapshot);
        assert!(model.visible_tickets().is_empty());
    }

    #[test]
    fn published_project_graph_presentation_overrides_a_pinned_run_layout() {
        let snapshot = json!({
            "run":{"id":"one","goal":"First","status":"active","profile_id":"a"},
            "views":[{
                "id":"graph",
                "kind":"typed_tree",
                "options":{"layout":"nested","show_titles":false}
            }]
        });
        let mut model = ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), snapshot);
        let published = r#"views:
  - id: graph
    kind: typed_tree
    options:
      layout: layered
      layers:
        - [hypothesis]
        - [literature, claim]
      repeat_semantic_types: [gate]
      show_titles: true
"#;
        let config = ConfigState {
            documents: vec![ConfigDocument {
                relative_path: PathBuf::from("cockpit/research.yaml"),
                source_path: PathBuf::from("/tmp/project/.codex/koni/cockpit/research.yaml"),
                draft_path: PathBuf::from(
                    "/tmp/project/.git/koni/config-drafts/cockpit/research.yaml",
                ),
                original: published.to_owned(),
                text: published.to_owned(),
                diagnostics: Vec::new(),
                cursor_line: 0,
                cursor_column: 0,
                is_new: false,
            }],
            ..ConfigState::default()
        };
        model.project_graph_options = published_graph_options(&config);

        let options = model.selected_graph_options().unwrap();
        assert_eq!(options["layout"], "layered");
        assert_eq!(options["layers"][1], json!(["literature", "claim"]));
        assert_eq!(options["repeat_semantic_types"], json!(["gate"]));
        assert_eq!(options["show_titles"], true);
    }

    #[test]
    fn ticket_worktree_action_uses_the_selected_ticket_checkout() {
        let snapshot = json!({
            "run":{"id":"one","goal":"First","status":"active","profile_id":"a"},
            "tickets":[{
                "id":"ticket-1",
                "status":"in_progress",
                "blockers":[],
                "lease":{"worktree":"/tmp/project-ticket"}
            }],
            "actions":[{
                "id":"context",
                "requires_ticket_worktree":true,
                "params":{"ticket":{"type":"ticket_id","required":true}}
            }]
        });
        let model = ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), snapshot);
        let form = model.action_form("context").unwrap();
        assert_eq!(
            form.execution_root.as_deref(),
            Some(Path::new("/tmp/project-ticket"))
        );
        assert_eq!(form.params[0].value, "ticket-1");
        assert!(form.params[0].locked);
        assert!(form.requires_ticket_worktree);
    }

    #[test]
    fn configured_review_form_hides_caller_verdict_and_uses_ticket_checkout() {
        let snapshot = json!({
            "run":{"id":"one","goal":"First","status":"active","profile_id":"a"},
            "tickets":[{
                "id":"ticket-1",
                "status":"in_progress",
                "blockers":[],
                "lease":{"worktree":"/tmp/project-ticket"}
            }],
            "actions":[{
                "id":"review",
                "params":{
                    "ticket":{"type":"ticket_id","required":true},
                    "status":{"type":"string","required":true},
                    "notes":{"type":"string","required":false}
                },
                "recipe":[
                    {"primitive":"review.validate"},
                    {"primitive":"review.record"}
                ]
            }]
        });
        let model = ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), snapshot);
        let form = model.action_form("review").expect("configured review form");

        assert!(form.configured_ticket_review);
        assert!(form.requires_ticket_worktree);
        assert_eq!(
            form.execution_root.as_deref(),
            Some(Path::new("/tmp/project-ticket"))
        );
        assert_eq!(form.params.len(), 1);
        assert_eq!(form.params[0].id, "ticket");
        assert_eq!(form.params[0].value, "ticket-1");
        assert!(form.params[0].locked);
        assert!(
            form.params
                .iter()
                .all(|param| param.id != "status" && param.id != "notes")
        );
    }

    #[test]
    fn configured_review_is_hidden_until_the_ticket_has_a_lease_checkout() {
        let snapshot = json!({
            "run":{"id":"one","goal":"First","status":"active","profile_id":"a"},
            "tickets":[{"id":"ticket-1","status":"in_progress","blockers":[]}],
            "actions":[{
                "id":"review",
                "params":{"ticket":{"type":"ticket_id","required":true}},
                "recipe":[{"primitive":"review.record"}]
            }],
            "views":[{"id":"tickets","kind":"tabbed_table","actions":["review"]}]
        });
        let mut model = ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), snapshot);
        model.focus = Focus::Tickets;

        assert!(model.action_form("review").is_none());
        model.open_action_palette();
        assert!(model.dialog.is_none());
    }

    #[test]
    fn action_palette_uses_focused_view_and_ticket_context() {
        let snapshot = json!({
            "run":{"id":"one","goal":"First","status":"active","profile_id":"a"},
            "tickets":[{
                "id":"ticket-1",
                "status":"in_progress",
                "blockers":[],
                "lease":{"worktree":"/tmp/project-ticket"}
            }],
            "actions":[
                {
                    "id":"compile-full",
                    "aliases":["compile"],
                    "allowed_ticket_states":[]
                },
                {
                    "id":"start",
                    "allowed_ticket_states":["todo"],
                    "params":{"ticket_id":{"type":"ticket_id","required":true}}
                },
                {
                    "id":"context",
                    "allowed_ticket_states":["in_progress"],
                    "requires_ticket_worktree":true,
                    "params":{"ticket_id":{"type":"ticket_id","required":true}}
                },
                {"id":"output"},
                {"id":"rollback"},
                {"id":"recover"}
            ],
            "views":[
                {"id":"status","kind":"summary","actions":["compile"]},
                {
                    "id":"tickets",
                    "kind":"tabbed_table",
                    "actions":["start","context"]
                },
                {"id":"agents","kind":"status_overlay","actions":["recover"]},
                {"id":"graph","kind":"typed_tree","actions":[]}
            ]
        });
        let mut model = ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), snapshot);

        model.focus = Focus::Tickets;
        model.open_action_palette();
        let Some(Dialog::ActionPalette(palette)) = &model.dialog else {
            panic!("ticket action palette did not open");
        };
        assert_eq!(palette.actions, vec!["context"]);
        assert!(!palette.actions.iter().any(|id| id == "output"));
        assert!(!palette.actions.iter().any(|id| id == "rollback"));

        model.dialog = None;
        model.focus = Focus::Runs;
        model.open_action_palette();
        let Some(Dialog::ActionPalette(palette)) = &model.dialog else {
            panic!("run action palette did not open");
        };
        assert_eq!(palette.actions, vec!["compile"]);
        assert_eq!(model.action_form("compile").unwrap().action, "compile");

        model.dialog = None;
        model.focus = Focus::Agents;
        model.open_action_palette();
        let Some(Dialog::ActionPalette(palette)) = &model.dialog else {
            panic!("agent action palette did not open");
        };
        assert_eq!(palette.actions, vec!["recover"]);
    }

    #[test]
    fn action_palette_filters_by_the_labels_users_can_see() {
        let palette = ActionPalette {
            actions: vec!["spawn-worker".to_owned(), "context".to_owned()],
            selected: 0,
            filter: "start".to_owned(),
        };

        assert_eq!(palette.filtered_actions(), vec!["spawn-worker"]);
    }

    #[test]
    fn ticket_worktree_action_is_unavailable_without_a_lease_checkout() {
        let snapshot = json!({
            "run":{"id":"one","goal":"First","status":"active","profile_id":"a"},
            "tickets":[{"id":"ticket-1","status":"in_progress","blockers":[]}],
            "actions":[{
                "id":"context",
                "allowed_ticket_states":["in_progress"],
                "requires_ticket_worktree":true,
                "params":{"ticket_id":{"type":"ticket_id","required":true}}
            }],
            "views":[{
                "id":"tickets",
                "kind":"tabbed_table",
                "actions":["context"]
            }]
        });
        let mut model = ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), snapshot);
        model.focus = Focus::Tickets;

        assert!(model.action_form("context").is_none());
        model.open_action_palette();
        assert!(model.dialog.is_none());
        assert!(model.status.contains("no actions available"));
    }

    #[test]
    fn yaml_editor_preserves_draft_and_reports_invalid_input() {
        let mut document = ConfigDocument {
            relative_path: "project.yaml".into(),
            source_path: "project.yaml".into(),
            draft_path: "draft.yaml".into(),
            original: "a: 1\n".to_owned(),
            text: "a: 1\n".to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 4,
            is_new: false,
        };
        document.text = "a: [unterminated".to_owned();
        assert!(!document.validate());
        assert!(document.dirty());
    }

    #[test]
    fn guided_form_reads_and_preserves_toml_documents() {
        let text = "[orchestration]\nrunning = true\nmax_parallel = 3\n";
        let document = ConfigDocument {
            relative_path: "koni.toml".into(),
            source_path: "koni.toml".into(),
            draft_path: "drafts/koni.toml".into(),
            original: text.to_owned(),
            text: text.to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        };
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), Value::Null);
        model.config = ConfigState {
            documents: vec![document],
            ..ConfigState::default()
        };
        model.config.rebuild_form();

        assert!(
            model
                .config
                .form_rows
                .iter()
                .any(|row| { row.path == "$.orchestration.max_parallel" && row.value == "3" })
        );
        let running = model
            .config
            .form_rows
            .iter()
            .find(|row| row.path == "$.orchestration.running")
            .unwrap()
            .clone();
        model
            .apply_form_edit(&EditScalarDraft {
                document_path: running.document_path,
                path: running.path,
                value: "false".to_owned(),
                kind: running.kind,
                cursor: 0,
                locator: running.locator,
            })
            .unwrap();
        let parsed: toml::Value = toml::from_str(&model.config.documents[0].text).unwrap();
        assert_eq!(parsed["orchestration"]["running"].as_bool(), Some(false));
    }

    #[test]
    fn guided_form_edits_literal_keys_containing_path_syntax() {
        let text = concat!(
            "reverse_display_edges:\n",
            "  experiment.tests: tested-by\n",
            "  'metric[primary]/$name': score\n",
        );
        let document = ConfigDocument {
            relative_path: "cockpit/research.yaml".into(),
            source_path: "cockpit/research.yaml".into(),
            draft_path: "drafts/cockpit/research.yaml".into(),
            original: text.to_owned(),
            text: text.to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 0,
            cursor_column: 0,
            is_new: false,
        };
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), Value::Null);
        model.config = ConfigState {
            documents: vec![document],
            ..ConfigState::default()
        };
        model.config.rebuild_form();

        let dotted = model
            .config
            .form_rows
            .iter()
            .find(|row| row.path.ends_with("experiment.tests"))
            .unwrap()
            .clone();
        assert_eq!(
            dotted.locator,
            vec![
                FormPathToken::Key("reverse_display_edges".to_owned()),
                FormPathToken::Key("experiment.tests".to_owned()),
            ]
        );
        let special = model
            .config
            .form_rows
            .iter()
            .find(|row| row.path.ends_with("metric[primary]/$name"))
            .unwrap()
            .clone();
        model
            .apply_form_edit(&EditScalarDraft {
                document_path: dotted.document_path,
                path: dotted.path,
                value: "validates".to_owned(),
                kind: dotted.kind,
                cursor: 0,
                locator: dotted.locator,
            })
            .unwrap();
        model
            .apply_form_edit(&EditScalarDraft {
                document_path: special.document_path,
                path: special.path,
                value: "primary score".to_owned(),
                kind: special.kind,
                cursor: 0,
                locator: special.locator,
            })
            .unwrap();

        let parsed: Value = serde_yaml::from_str(&model.config.documents[0].text).unwrap();
        assert_eq!(
            parsed["reverse_display_edges"]["experiment.tests"],
            "validates"
        );
        assert_eq!(
            parsed["reverse_display_edges"]["metric[primary]/$name"],
            "primary score"
        );
        assert!(
            parsed["reverse_display_edges"].get("experiment").is_none(),
            "the dotted key must not be rewritten as nested mappings"
        );
    }

    #[test]
    fn domain_form_binding_edits_its_document_even_when_raw_selection_changes() {
        let project_text = r#"
project: {id: demo, title: Demo}
default_run_type: medium
run_types: []
"#;
        let graph_text = r#"
node_types:
  - id: task
    stage: planning
    statuses: [open, done]
"#;
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), Value::Null);
        model.config = ConfigState {
            documents: vec![
                configuration_document("project.yaml", project_text),
                configuration_document("graph.yaml", graph_text),
            ],
            ..ConfigState::default()
        };
        model.config.rebuild_projection();
        model.config.select_resource_for(
            ConfigDomain::GraphRules,
            Path::new("graph.yaml"),
            ConfigResourceKind::NodeType,
        );
        let stage = model
            .config
            .form_rows
            .iter()
            .find(|row| row.path.ends_with(".stage"))
            .unwrap()
            .clone();
        assert_eq!(stage.document_path, Path::new("graph.yaml"));

        // Simulate an unrelated raw-file selection after the dialog opened.
        model.config.selected = 0;
        model
            .apply_form_edit(&EditScalarDraft {
                document_path: stage.document_path,
                path: stage.path,
                value: "execution".to_owned(),
                kind: stage.kind,
                cursor: 0,
                locator: stage.locator,
            })
            .unwrap();

        assert_eq!(model.config.documents[0].text, project_text);
        let graph: Value = serde_yaml::from_str(&model.config.documents[1].text).unwrap();
        assert_eq!(graph["node_types"][0]["stage"], "execution");
    }

    #[test]
    fn guided_resources_hide_internal_yaml_identity_and_source_fields() {
        let mut model = ControlCenterModel::from_snapshot("/tmp/demo".into(), Value::Null);
        model.config = ConfigState {
            documents: vec![
                configuration_document(
                    "project.yaml",
                    r#"
schema_version: "1.0"
project: {id: demo, title: Demo}
default_run_type: medium
run_types: [{id: medium, path: run-types/medium.yaml}]
"#,
                ),
                configuration_document(
                    "run-types/medium.yaml",
                    r#"
schema_version: "1.0"
id: medium
title: Medium
profile: {source: .codex/koni/profile.yaml}
pipeline: {stages: {}, order: []}
agents:
  roles:
    planner: {model: planner-model, reasoning_effort: xhigh}
"#,
                ),
            ],
            ..ConfigState::default()
        };
        model.config.rebuild_projection();
        model.config.select_resource_for(
            ConfigDomain::RunTypes,
            Path::new("run-types/medium.yaml"),
            ConfigResourceKind::RunType,
        );

        let paths = model
            .config
            .form_rows
            .iter()
            .map(|row| row.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.iter().any(|path| path.ends_with(".title")));
        assert!(paths.iter().any(|path| path.ends_with(".model")));
        assert!(!paths.iter().any(|path| path.ends_with("schema_version")));
        assert!(!paths.iter().any(|path| path.ends_with(".id")));
        assert!(!paths.iter().any(|path| path.ends_with("profile.source")));
    }

    #[test]
    fn yaml_editor_inserts_multiline_bracketed_paste_at_the_cursor() {
        let mut document = ConfigDocument {
            relative_path: "project.yaml".into(),
            source_path: "project.yaml".into(),
            draft_path: "draft.yaml".into(),
            original: "items:\n  - tail\n".to_owned(),
            text: "items:\n  - tail\n".to_owned(),
            diagnostics: Vec::new(),
            cursor_line: 1,
            cursor_column: 4,
            is_new: false,
        };

        document.insert_text("first\r\n  - nested ✓\r  - ");

        assert_eq!(document.text, "items:\n  - first\n  - nested ✓\n  - tail\n");
        assert_eq!((document.cursor_line, document.cursor_column), (3, 4));
        assert!(document.diagnostics.is_empty());
    }

    #[test]
    fn all_and_other_tabs_keep_custom_ticket_states_visible() {
        let ticket = json!({"id":"custom", "status":"quality_gate", "blockers":[]});
        assert!(TicketTab::All.includes(&ticket));
        assert!(TicketTab::Other.includes(&ticket));
        assert!(!TicketTab::Active.includes(&ticket));
    }

    #[test]
    fn resume_pending_question_reopens_with_its_durable_answer_locked() {
        let mut model = ControlCenterModel::from_snapshot(
            PathBuf::from("/tmp/project"),
            json!({
                "run":{"id":"run-1","goal":"Goal","status":"active","profile_id":"test"},
                "questions":[{
                    "id":"q-1",
                    "status":"answered_pending_resume",
                    "prompt":"Choose",
                    "context":"Bound context",
                    "allow_custom_answer":true,
                    "options":[
                        {"id":"one","label":"One","description":"First","recommended":true},
                        {"id":"two","label":"Two","description":"Second","recommended":false}
                    ],
                    "answer":{"option_id":"two"}
                }]
            }),
        );
        assert_eq!(model.runs[0].summary.as_ref().unwrap().open_questions, 1);
        model.open_first_question();
        let Some(Dialog::AnswerQuestion(answer)) = model.dialog else {
            panic!("pending question did not reopen");
        };
        assert!(answer.pending_resume);
        assert_eq!(answer.options[answer.selected].0, "two");
    }

    #[test]
    fn shutdown_autosave_persists_every_unpublished_edit() {
        let fixture = publication_fixture();
        let mut model = publication_model(fixture.path());
        let project = config_document_index(&model, "project.yaml");
        let profile = config_document_index(&model, "profile.yaml");
        model.config.documents[project]
            .text
            .push_str("# project draft\n");
        model.config.documents[profile]
            .text
            .push_str("# profile draft\n");

        assert_eq!(model.save_all_config_drafts().unwrap(), 2);
        assert!(
            fs::read_to_string(&model.config.documents[project].draft_path)
                .unwrap()
                .ends_with("# project draft\n")
        );
        assert!(
            fs::read_to_string(&model.config.documents[profile].draft_path)
                .unwrap()
                .ends_with("# profile draft\n")
        );
    }

    #[test]
    fn load_surfaces_catalog_errors_without_disabling_configuration() {
        let fixture = TempDir::new().unwrap();
        write_fixture_file(
            fixture.path(),
            ".codex/koni/project.yaml",
            "schema_version: \"1.0\"\nrun_types: []\n",
        );

        let mut model = ControlCenterModel::load(fixture.path()).unwrap();

        assert!(model.catalog_error.is_some());
        assert!(model.status.contains("catalog compilation failed"));
        assert!(model.run_types.is_empty());
        assert_eq!(model.config.documents.len(), 1);
        model.open_new_config_document();
        assert!(matches!(model.dialog, Some(Dialog::NewConfigDocument(_))));
    }

    #[test]
    fn run_type_options_preserve_catalog_order_and_compiled_metadata() {
        let fixture = publication_fixture();
        let catalog = ProjectCatalogCompiler::compile(fixture.path()).unwrap();

        let options = run_type_options(&catalog);

        assert_eq!(
            options
                .iter()
                .map(|option| option.title.as_str())
                .collect::<Vec<_>>(),
            vec!["Base run", "Fast run"]
        );
        assert_eq!(options[0].planning_passes, 1);
        assert_eq!(options[0].question_policy, "interactive");
        assert_eq!(options[0].max_parallel, Some(3));
        assert_eq!(options[1].question_policy, "autonomous");
    }

    #[test]
    fn load_preserves_launch_directory_and_discovers_project_root() {
        let fixture = publication_fixture();
        let status = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(fixture.path())
            .status()
            .unwrap();
        assert!(status.success());
        let nested = fixture.path().join("nested/work");
        fs::create_dir_all(&nested).unwrap();

        let model = ControlCenterModel::load(&nested).unwrap();

        assert_eq!(model.launch_root, nested.canonicalize().unwrap());
        assert_eq!(model.root, fixture.path().canonicalize().unwrap());
        assert!(model.catalog_error.is_none());
    }

    #[test]
    fn configured_checkout_wins_over_a_shared_registry_display_root() {
        let fixture = publication_fixture();
        let status = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(fixture.path())
            .status()
            .unwrap();
        assert!(status.success());
        let historical_root = fixture.path().join("historical-primary");
        fs::create_dir(&historical_root).unwrap();
        let registry = git_common_dir(fixture.path())
            .unwrap()
            .join("koni/project.yaml");
        fs::create_dir_all(registry.parent().unwrap()).unwrap();
        fs::write(
            &registry,
            format!(
                "schema_version: '1.0'\nproject_id: test\nrepository_root: {}\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\nruns: {{}}\n",
                historical_root.display()
            ),
        )
        .unwrap();

        assert_eq!(
            canonical_project_root(fixture.path()).unwrap(),
            fixture.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn configured_git_project_without_a_run_loads_an_empty_control_center() {
        let fixture = TempDir::new().unwrap();
        let root = fixture.path().join("fresh-project");
        fs::create_dir_all(&root).unwrap();
        let status = std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&root)
            .status()
            .unwrap();
        assert!(status.success());

        let profile = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../profiles/research");
        Engine::open_with_profile(&root, Some(&profile)).unwrap();
        let registry_path = git_common_dir(&root).unwrap().join("koni/project.yaml");

        assert_eq!(project_snapshots(&root).unwrap(), Vec::<Value>::new());
        assert!(
            !registry_path.exists(),
            "opening a configured project must not create a registry"
        );

        let model = ControlCenterModel::load(&root).unwrap();
        assert!(model.runs.is_empty());
        assert_eq!(model.status, "No runs yet — press n to start planning");
        assert!(
            !registry_path.exists(),
            "loading the control center must remain read-only"
        );
    }

    #[test]
    fn configured_directory_without_git_opens_before_its_first_run() {
        let fixture = publication_fixture();

        let model = ControlCenterModel::load(fixture.path()).unwrap();

        assert!(git_common_dir(fixture.path()).is_none());
        assert!(model.catalog_error.is_none());
        assert!(model.runs.is_empty());
        assert_eq!(model.status, "No runs yet — press n to start planning");
        assert!(
            !fixture.path().join(".git").exists(),
            "opening Koni must not initialize Git"
        );
    }

    #[test]
    fn snapshot_discovery_does_not_create_or_bypass_a_project_registry() {
        let fixture = TempDir::new().unwrap();
        let root = fixture.path().join("compat-project");
        let profile = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../profiles/research");
        let mut engine = Engine::open_with_profile(&root, Some(&profile)).unwrap();
        let run_id = engine.initialize_run("Read-only discovery").unwrap();
        let registry_path = git_common_dir(&root).unwrap().join("koni/project.yaml");
        assert!(!registry_path.exists());

        let snapshots = project_snapshots(&root).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0]["run"]["id"], run_id);
        assert!(
            !registry_path.exists(),
            "observing a compatibility run must not create a modern registry"
        );

        Engine::project_registry(&root).unwrap();
        assert!(registry_path.exists());
        assert!(
            project_snapshots(&root).unwrap().is_empty(),
            "an explicit modern registry must never fall back to unregistered compatibility state"
        );
    }

    #[test]
    fn snapshot_discovery_fails_closed_when_an_existing_registry_is_invalid() {
        let fixture = TempDir::new().unwrap();
        let root = fixture.path().join("invalid-registry-project");
        let profile = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../profiles/research");
        let mut engine = Engine::open_with_profile(&root, Some(&profile)).unwrap();
        engine.initialize_run("Compatibility state").unwrap();

        let registry_path = git_common_dir(&root).unwrap().join("koni/project.yaml");
        fs::create_dir_all(registry_path.parent().unwrap()).unwrap();
        fs::write(&registry_path, "runs: [not valid\n").unwrap();

        assert!(matches!(
            project_snapshots(&root),
            Err(KoniError::Yaml { .. })
        ));
        assert_eq!(
            fs::read_to_string(&registry_path).unwrap(),
            "runs: [not valid\n",
            "failed discovery must not replace a malformed registry"
        );
    }

    fn snapshot_cache_registration(id: &str, status: RunRegistrationStatus) -> RunRegistration {
        let now = Utc::now();
        RunRegistration {
            id: id.to_owned(),
            slug: id.to_owned(),
            goal: format!("Exercise {id}"),
            profile_id: "cache-profile".to_owned(),
            profile_version: "1.0.0".to_owned(),
            profile_hash: "sha256:cache-profile".to_owned(),
            run_type_id: Some("base".to_owned()),
            run_type_title: Some("Base run".to_owned()),
            run_type_hash: Some("sha256:base".to_owned()),
            question_policy: Some("interactive".to_owned()),
            target_branch: Some("refs/heads/main".to_owned()),
            base_commit: "0".repeat(40),
            config_snapshot_hash: "sha256:config".to_owned(),
            config_snapshot_path: PathBuf::from("config-snapshot"),
            status,
            planning_worktree: None,
            planning_read_only: false,
            integration_branch: Some(format!("refs/heads/koni/runs/{id}")),
            integration_worktree: None,
            created_at: now,
            updated_at: now,
        }
    }

    fn snapshot_cache_registry(runs: BTreeMap<String, RunRegistration>) -> ProjectRegistry {
        let now = Utc::now();
        ProjectRegistry {
            schema_version: "1.0".to_owned(),
            project_id: "cache-project".to_owned(),
            repository_root: PathBuf::from("/tmp/cache-project"),
            created_at: now,
            updated_at: now,
            selected_run: None,
            runs,
        }
    }

    fn write_snapshot_cache_marker(common_dir: &Path, run_id: &str, body: &str) {
        let marker = common_dir
            .join("koni/runs")
            .join(run_id)
            .join("events.jsonl");
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(marker, body).unwrap();
    }

    fn counting_cached_refresh(
        root: &Path,
        common_dir: &Path,
        registry: &ProjectRegistry,
        selected_run_id: Option<&str>,
        cache: &mut ProjectSnapshotCache,
        loads: &mut BTreeMap<String, usize>,
    ) -> Vec<Value> {
        cached_registered_snapshots(
            root,
            common_dir,
            registry,
            selected_run_id,
            cache,
            |run_id, _| {
                let count = loads.entry(run_id.to_owned()).or_default();
                *count += 1;
                RegisteredSnapshotLoad::valid(json!({
                    "run":{"id":run_id,"goal":run_id,"status":"recorded"},
                    "board":{},
                    "projection_generation":*count
                }))
            },
        )
    }

    #[test]
    fn many_inactive_snapshots_reuse_exact_generations_while_selected_and_live_runs_stay_eager() {
        let fixture = TempDir::new().unwrap();
        let common_dir = fixture.path().join("common");
        let mut runs = BTreeMap::new();
        for index in 0..32 {
            let run_id = format!("inactive-{index:02}");
            write_snapshot_cache_marker(&common_dir, &run_id, "terminal\n");
            runs.insert(
                run_id.clone(),
                snapshot_cache_registration(&run_id, RunRegistrationStatus::Concluded),
            );
        }
        for (run_id, status) in [
            ("active", RunRegistrationStatus::Active),
            ("paused-draining", RunRegistrationStatus::Paused),
        ] {
            write_snapshot_cache_marker(&common_dir, run_id, "live\n");
            runs.insert(
                run_id.to_owned(),
                snapshot_cache_registration(run_id, status),
            );
        }
        let mut registry = snapshot_cache_registry(runs);
        let mut cache = ProjectSnapshotCache::default();
        let mut loads = BTreeMap::<String, usize>::new();

        let first = counting_cached_refresh(
            fixture.path(),
            &common_dir,
            &registry,
            None,
            &mut cache,
            &mut loads,
        );
        assert_eq!(first.len(), 34);
        assert_eq!(loads.values().sum::<usize>(), 34);

        counting_cached_refresh(
            fixture.path(),
            &common_dir,
            &registry,
            None,
            &mut cache,
            &mut loads,
        );
        assert_eq!(loads["inactive-00"], 1);
        assert_eq!(loads["inactive-31"], 1);
        assert_eq!(loads["active"], 2);
        assert_eq!(loads["paused-draining"], 2);

        counting_cached_refresh(
            fixture.path(),
            &common_dir,
            &registry,
            Some("inactive-00"),
            &mut cache,
            &mut loads,
        );
        assert_eq!(loads["inactive-00"], 2, "the selected row stays eager");
        assert_eq!(loads["inactive-01"], 1);
        assert_eq!(loads["active"], 3);
        assert_eq!(loads["paused-draining"], 3);

        write_snapshot_cache_marker(&common_dir, "inactive-01", "terminal changed\n");
        counting_cached_refresh(
            fixture.path(),
            &common_dir,
            &registry,
            None,
            &mut cache,
            &mut loads,
        );
        assert_eq!(
            loads["inactive-01"], 2,
            "durable mutation invalidates one run"
        );
        assert_eq!(loads["inactive-02"], 1);

        registry.runs.get_mut("inactive-02").unwrap().status = RunRegistrationStatus::Active;
        counting_cached_refresh(
            fixture.path(),
            &common_dir,
            &registry,
            None,
            &mut cache,
            &mut loads,
        );
        counting_cached_refresh(
            fixture.path(),
            &common_dir,
            &registry,
            None,
            &mut cache,
            &mut loads,
        );
        assert_eq!(loads["inactive-02"], 3, "a newly live row is never reused");

        registry.runs.remove("inactive-03");
        counting_cached_refresh(
            fixture.path(),
            &common_dir,
            &registry,
            None,
            &mut cache,
            &mut loads,
        );
        assert!(!cache.entries.contains_key("inactive-03"));
        assert_eq!(loads["inactive-03"], 1);

        write_snapshot_cache_marker(&common_dir, "inactive-new", "new\n");
        registry.runs.insert(
            "inactive-new".to_owned(),
            snapshot_cache_registration("inactive-new", RunRegistrationStatus::Stopped),
        );
        counting_cached_refresh(
            fixture.path(),
            &common_dir,
            &registry,
            None,
            &mut cache,
            &mut loads,
        );
        assert_eq!(loads["inactive-new"], 1);
    }

    #[test]
    fn invalid_snapshot_fallbacks_never_poison_the_inactive_cache() {
        let fixture = TempDir::new().unwrap();
        let common_dir = fixture.path().join("common");
        write_snapshot_cache_marker(&common_dir, "broken", "broken\n");
        let registry = snapshot_cache_registry(BTreeMap::from([(
            "broken".to_owned(),
            snapshot_cache_registration("broken", RunRegistrationStatus::Failed),
        )]));
        let mut cache = ProjectSnapshotCache::default();
        let mut loads = 0;

        for _ in 0..2 {
            let snapshots = cached_registered_snapshots(
                fixture.path(),
                &common_dir,
                &registry,
                None,
                &mut cache,
                |run_id, registration| {
                    loads += 1;
                    RegisteredSnapshotLoad::invalid(json!({
                        "run":{"id":run_id,"goal":registration.goal,"status":"failed"},
                        "validation_errors":["invalid run snapshot"]
                    }))
                },
            );
            assert_eq!(snapshots[0]["validation_errors"][0], "invalid run snapshot");
        }
        assert_eq!(loads, 2);
        assert!(cache.entries.is_empty());

        cached_registered_snapshots(
            fixture.path(),
            &common_dir,
            &registry,
            None,
            &mut cache,
            |run_id, _| {
                loads += 1;
                RegisteredSnapshotLoad::valid(json!({
                    "run":{"id":run_id,"goal":run_id,"status":"failed"},
                    "board":{}
                }))
            },
        );
        assert_eq!(loads, 3);
        assert!(cache.entries.contains_key("broken"));

        cached_registered_snapshots(
            fixture.path(),
            &common_dir,
            &registry,
            None,
            &mut cache,
            |_, _| {
                loads += 1;
                panic!("a stable valid fallback replacement should be reused")
            },
        );
        assert_eq!(loads, 3);
    }

    #[test]
    fn terminal_registration_with_a_live_or_draining_agent_remains_eager() {
        let fixture = TempDir::new().unwrap();
        let common_dir = fixture.path().join("common");
        write_snapshot_cache_marker(&common_dir, "draining", "agent record\n");
        let registry = snapshot_cache_registry(BTreeMap::from([(
            "draining".to_owned(),
            snapshot_cache_registration("draining", RunRegistrationStatus::Stopped),
        )]));
        let mut cache = ProjectSnapshotCache::default();
        let mut loads = 0;

        for _ in 0..2 {
            cached_registered_snapshots(
                fixture.path(),
                &common_dir,
                &registry,
                None,
                &mut cache,
                |run_id, _| {
                    loads += 1;
                    RegisteredSnapshotLoad::valid(json!({
                        "run":{"id":run_id,"goal":run_id,"status":"stopped"},
                        "board":{},
                        "lifecycle":{"active_agents":1,"draining":true},
                        "agents":[{"id":"worker","status":"running"}]
                    }))
                },
            );
        }

        assert_eq!(loads, 2);
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn durable_fingerprint_covers_sidecar_and_tracked_state_but_ignores_lock_churn() {
        let fixture = TempDir::new().unwrap();
        let sidecar = fixture.path().join("sidecar-run");
        let tracked = fixture.path().join("integration/program");
        fs::create_dir_all(sidecar.join("locks")).unwrap();
        fs::create_dir_all(tracked.join("locks")).unwrap();
        write_fixture_file(
            fixture.path(),
            "sidecar-run/receipts/check.yaml",
            "status: passed\n",
        );
        write_fixture_file(
            fixture.path(),
            "integration/program/graph/change.yaml",
            "id: change\n",
        );
        let roots = vec![sidecar.clone(), tracked.clone()];
        let initial = DurableRunFingerprint::capture(&roots).unwrap();

        fs::write(sidecar.join("locks/reader.lock"), "transient").unwrap();
        fs::write(tracked.join("locks/compiler.lock"), "transient").unwrap();
        assert_eq!(DurableRunFingerprint::capture(&roots).unwrap(), initial);

        fs::write(sidecar.join("receipts/check.yaml"), "status: stale\n").unwrap();
        let sidecar_changed = DurableRunFingerprint::capture(&roots).unwrap();
        assert_ne!(sidecar_changed, initial);

        fs::write(tracked.join("graph/change.yaml"), "id: replacement\n").unwrap();
        assert_ne!(
            DurableRunFingerprint::capture(&roots).unwrap(),
            sidecar_changed,
            "tracked-backend graph state must share the same invalidation boundary"
        );
    }

    #[test]
    fn tracked_profile_snapshot_resolves_its_exact_compiler_state_root() {
        let fixture = TempDir::new().unwrap();
        let common_dir = fixture.path().join("common");
        let run_root = common_dir.join("koni/runs/tracked-run");
        let snapshot_root = run_root.join("config-snapshot");
        write_fixture_file(&snapshot_root, ".codex/koni/project.yaml", PROJECT_CATALOG);
        write_fixture_file(
            &snapshot_root,
            ".codex/koni/run-types/base.yaml",
            BASE_RUN_TYPE,
        );
        write_fixture_file(
            &snapshot_root,
            ".codex/koni/run-types/fast.yaml",
            FAST_RUN_TYPE,
        );
        write_fixture_file(&snapshot_root, ".codex/koni/profile.yaml", YAML_PROFILE);
        write_fixture_file(
            &snapshot_root,
            ".codex/koni/modules/nodes.yaml",
            NODE_MODULE,
        );
        let integration_worktree = fixture.path().join("integration");
        fs::create_dir_all(integration_worktree.join("program")).unwrap();
        let mut registration =
            snapshot_cache_registration("tracked-run", RunRegistrationStatus::Concluded);
        registration.integration_worktree = Some(integration_worktree.clone());

        let roots = registered_snapshot_watch_roots(&common_dir, "tracked-run", &registration);

        assert_eq!(
            roots,
            vec![run_root, integration_worktree.join("program")],
            "tracked storage must watch the profile-defined state parent, not the whole repository"
        );
    }

    #[test]
    fn new_configuration_document_survives_draft_reload_and_validated_publish() {
        let fixture = publication_fixture();
        let mut model = publication_model(fixture.path());
        model
            .create_config_document("modules/additional.yaml")
            .unwrap();
        let index = config_document_index(&model, "modules/additional.yaml");
        model.config.documents[index].text = "node_types: []\n".to_owned();
        model.config.selected = index;
        model.save_config_draft().unwrap();
        assert!(!model.config.documents[index].source_path.exists());

        let mut reloaded = publication_model(fixture.path());
        let index = config_document_index(&reloaded, "modules/additional.yaml");
        assert!(reloaded.config.documents[index].is_new);
        assert_eq!(reloaded.config.documents[index].text, "node_types: []\n");
        reloaded.publish_config().unwrap();

        assert_eq!(
            fs::read_to_string(fixture.path().join(".codex/koni/modules/additional.yaml")).unwrap(),
            "node_types: []\n"
        );
        assert!(!reloaded.config.documents[index].is_new);
        assert!(!reloaded.config.documents[index].draft_path.exists());
    }

    #[test]
    fn native_codex_agents_skills_and_project_settings_share_draft_publish_safety() {
        let fixture = publication_fixture();
        write_fixture_file(
            fixture.path(),
            ".codex/config.toml",
            "[agents]\nmax_threads = 4\n",
        );
        write_fixture_file(
            fixture.path(),
            ".codex/agents/reviewer.toml",
            "name = \"reviewer\"\ndescription = \"Review changes\"\ndeveloper_instructions = \"Review carefully.\"\nmodel = \"gpt-5.6-terra\"\nmodel_reasoning_effort = \"high\"\nsandbox_mode = \"workspace-write\"\n",
        );
        write_fixture_file(
            fixture.path(),
            ".agents/skills/review/SKILL.md",
            "---\nname: review\ndescription: Review finished changes.\n---\n# Review\n",
        );
        let profile_path = fixture.path().join(".codex/koni/profile.yaml");
        fs::write(
            &profile_path,
            fs::read_to_string(&profile_path).unwrap().replace(
                "  graph: [modules/nodes.yaml]",
                "  graph: [modules/nodes.yaml]\n  personas: [personas.yaml]",
            ),
        )
        .unwrap();
        write_fixture_file(
            fixture.path(),
            ".codex/koni/personas.yaml",
            "personas:\n  - id: reviewer\n    codex_agent: reviewer\n    model_role: reviewer\n    sandbox: {mode: read-only, approval_policy: never, network_access: false}\n",
        );
        let mut model = publication_model(fixture.path());

        model.config.select_resource_for(
            ConfigDomain::Agents,
            Path::new(".codex/agents/reviewer.toml"),
            ConfigResourceKind::NativeAgent,
        );
        assert!(model.config.form_rows.iter().any(|row| {
            row.document_path == Path::new(".codex/agents/reviewer.toml")
                && row.path.ends_with("model_reasoning_effort")
        }));
        assert!(model.config.form_rows.iter().any(|row| {
            row.document_path == Path::new("personas.yaml") && row.path.ends_with("sandbox.mode")
        }));
        assert!(
            !model
                .config
                .form_rows
                .iter()
                .any(|row| row.path.ends_with("codex_agent"))
        );
        let network = model
            .config
            .form_rows
            .iter()
            .find(|row| {
                row.document_path == Path::new("personas.yaml")
                    && row.path.ends_with("network_access")
            })
            .cloned()
            .unwrap();
        model
            .apply_form_edit(&EditScalarDraft {
                document_path: network.document_path,
                path: network.path,
                value: "false".to_owned(),
                kind: network.kind,
                cursor: 0,
                locator: network.locator,
            })
            .unwrap();

        for (relative, from, to) in [
            (".codex/config.toml", "max_threads = 4", "max_threads = 8"),
            (
                ".codex/agents/reviewer.toml",
                "Review changes",
                "Review completed changes",
            ),
            (
                ".agents/skills/review/SKILL.md",
                "Review finished changes.",
                "Review completed changes.",
            ),
        ] {
            let index = config_document_index(&model, relative);
            assert_eq!(
                model.config.documents[index].source_path,
                fixture.path().canonicalize().unwrap().join(relative)
            );
            model.config.documents[index].text =
                model.config.documents[index].text.replace(from, to);
        }
        model.save_all_config_drafts().unwrap();

        let mut reloaded = publication_model(fixture.path());
        assert!(
            reloaded.config.documents[config_document_index(&reloaded, ".codex/config.toml")]
                .text
                .contains("max_threads = 8")
        );
        reloaded.publish_config().unwrap();

        assert!(
            fs::read_to_string(fixture.path().join(".codex/config.toml"))
                .unwrap()
                .contains("max_threads = 8")
        );
        assert!(
            fs::read_to_string(fixture.path().join(".codex/agents/reviewer.toml"))
                .unwrap()
                .contains("Review completed changes")
        );
        assert!(
            fs::read_to_string(fixture.path().join(".agents/skills/review/SKILL.md"))
                .unwrap()
                .contains("Review completed changes.")
        );
        assert!(
            fs::read_to_string(fixture.path().join(".codex/koni/personas.yaml"))
                .unwrap()
                .contains("network_access: false")
        );
    }

    #[test]
    fn publication_rejects_cross_document_errors_before_writing_any_source() {
        let fixture = publication_fixture();
        let project_path = fixture.path().join(".codex/koni/project.yaml");
        let profile_path = fixture.path().join(".codex/koni/profile.yaml");
        let original_project = fs::read_to_string(&project_path).unwrap();
        let original_profile = fs::read_to_string(&profile_path).unwrap();
        let mut model = publication_model(fixture.path());

        // Both documents remain valid YAML, but the catalog entry no longer
        // agrees with the run-type document it references.
        replace_and_save(
            &mut model,
            "project.yaml",
            "  - id: fast\n",
            "  - id: turbo\n",
        );
        replace_and_save(
            &mut model,
            "profile.yaml",
            "description: Original profile",
            "description: Draft profile",
        );

        let error = model.publish_config().unwrap_err().to_string();
        assert!(
            error.contains("does not match document id `fast`"),
            "unexpected publication error: {error}"
        );
        assert_eq!(fs::read_to_string(project_path).unwrap(), original_project);
        assert_eq!(fs::read_to_string(profile_path).unwrap(), original_profile);
        assert!(
            model
                .config
                .documents
                .iter()
                .filter(|document| document.dirty())
                .all(|document| document.draft_path.is_file())
        );
    }

    #[test]
    fn rename_and_delete_are_durable_validated_configuration_operations() {
        let fixture = publication_fixture();
        let mut model = publication_model(fixture.path());
        replace_and_save(
            &mut model,
            "profile.yaml",
            "modules/nodes.yaml",
            "modules/entities.yaml",
        );
        model.config.selected = config_document_index(&model, "modules/nodes.yaml");
        model
            .rename_config_document("modules/entities.yaml")
            .unwrap();
        model.save_all_config_drafts().unwrap();

        let mut reloaded = publication_model(fixture.path());
        assert!(
            reloaded
                .config
                .pending_renames
                .contains_key(Path::new("modules/nodes.yaml"))
        );
        assert!(
            reloaded
                .config
                .documents
                .iter()
                .any(|document| document.relative_path == Path::new("modules/entities.yaml"))
        );
        reloaded.publish_config().unwrap();
        assert!(
            !fixture
                .path()
                .join(".codex/koni/modules/nodes.yaml")
                .exists()
        );
        assert!(
            fixture
                .path()
                .join(".codex/koni/modules/entities.yaml")
                .exists()
        );

        reloaded
            .create_config_document("modules/unused.yaml")
            .unwrap();
        let unused = config_document_index(&reloaded, "modules/unused.yaml");
        reloaded.config.documents[unused].text = "node_types: []\n".to_owned();
        reloaded.publish_config().unwrap();
        reloaded.config.selected = config_document_index(&reloaded, "modules/unused.yaml");
        reloaded.toggle_delete_config_document().unwrap();
        assert!(
            reloaded.status.contains("press d to undo"),
            "{}",
            reloaded.status
        );
        assert!(!reloaded.status.contains("press D"), "{}", reloaded.status);
        reloaded.publish_config().unwrap();
        assert!(
            !fixture
                .path()
                .join(".codex/koni/modules/unused.yaml")
                .exists()
        );
    }

    #[test]
    fn published_delete_removes_saved_draft_and_does_not_resurrect_on_reload() {
        let fixture = publication_fixture();
        let relative = Path::new("modules/unused.yaml");
        let source_path = fixture.path().join(".codex/koni").join(relative);
        write_fixture_file(
            fixture.path(),
            ".codex/koni/modules/unused.yaml",
            "node_types: []\n",
        );
        let mut model = publication_model(fixture.path());
        let index = config_document_index(&model, "modules/unused.yaml");
        model.config.documents[index].text = "node_types: []\nqueries: []\n".to_owned();
        model.config.selected = index;
        model.save_config_draft().unwrap();
        let draft_path = model.config.documents[index].draft_path.clone();
        assert!(draft_path.is_file());

        model.toggle_delete_config_document().unwrap();
        model.publish_config().unwrap();

        assert!(!source_path.exists());
        assert!(!draft_path.exists());
        let reloaded = publication_model(fixture.path());
        assert!(
            reloaded
                .config
                .documents
                .iter()
                .all(|document| document.relative_path != relative),
            "a published deletion must not reload its old draft as a new document"
        );
        assert!(!draft_path.exists());
    }

    #[test]
    fn multi_document_publication_preserves_an_active_runs_pinned_snapshot() {
        let fixture = publication_fixture();
        let run_root = fixture.path().join("active-run");
        let snapshot =
            ConfigSnapshot::capture_project_configuration(fixture.path(), &run_root).unwrap();
        let snapshot_root = run_root.join(&snapshot.path);
        let pinned_catalog = ProjectCatalogCompiler::compile(&snapshot_root).unwrap();
        let pinned_run_type_hash = pinned_catalog.default_run_type().hash.clone();
        let pinned_profile =
            ProfileCompiler::compile(&pinned_catalog.default_run_type().profile.resolved_path)
                .unwrap();
        let pinned_profile_hash = pinned_profile.hash.clone();

        let mut model = publication_model(fixture.path());
        replace_and_save(
            &mut model,
            "project.yaml",
            "default_run_type: base",
            "default_run_type: fast",
        );
        replace_and_save(
            &mut model,
            "run-types/fast.yaml",
            "title: Fast run",
            "title: Express run",
        );
        replace_and_save(
            &mut model,
            "profile.yaml",
            "description: Original profile",
            "description: Published profile",
        );
        let draft_paths = model
            .config
            .documents
            .iter()
            .filter(|document| document.dirty())
            .map(|document| document.draft_path.clone())
            .collect::<Vec<_>>();

        model.publish_config().unwrap();
        assert_eq!(model.default_run_type, "fast");
        assert!(model.run_types.iter().any(|run_type| run_type.id == "fast"));
        assert_eq!(
            model.status,
            "published configuration for future runs · 2 run types validated"
        );
        assert!(draft_paths.iter().all(|path| !path.exists()));
        assert!(
            model
                .config
                .documents
                .iter()
                .all(|document| !document.dirty())
        );

        let live_catalog = ProjectCatalogCompiler::compile(fixture.path()).unwrap();
        assert_eq!(live_catalog.default_run_type().id, "fast");
        assert_eq!(live_catalog.default_run_type().title, "Express run");
        assert_ne!(live_catalog.hash, pinned_catalog.hash);
        let live_profile =
            ProfileCompiler::compile(&live_catalog.default_run_type().profile.resolved_path)
                .unwrap();
        assert_eq!(
            live_profile.manifest.profile.description,
            "Published profile"
        );
        assert_ne!(live_profile.hash, pinned_profile_hash);

        assert_eq!(ConfigSnapshot::load_verified(&run_root).unwrap(), snapshot);
        let still_pinned_catalog = ProjectCatalogCompiler::compile(&snapshot_root).unwrap();
        assert_eq!(still_pinned_catalog.default_run_type().id, "base");
        assert_eq!(
            still_pinned_catalog.default_run_type().hash,
            pinned_run_type_hash
        );
        let still_pinned_profile = ProfileCompiler::compile(
            &still_pinned_catalog
                .default_run_type()
                .profile
                .resolved_path,
        )
        .unwrap();
        assert_eq!(still_pinned_profile.hash, pinned_profile_hash);
        assert_eq!(
            still_pinned_profile.manifest.profile.description,
            "Original profile"
        );
    }
}
