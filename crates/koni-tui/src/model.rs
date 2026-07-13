use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use koni_core::catalog::{
    LEGACY_RUN_TYPE_ID, ProfileSourceDef, ProjectCatalogDocument, ProjectCatalogSource,
    ResolvedRunType, RunTypeCatalogEntry, RunTypeDocument,
};
use koni_core::config::ProfileManifest;
use koni_core::{
    CompiledProjectCatalog, Engine, KoniError, ProfileCompiler, ProjectCatalogCompiler,
    RunDeletionPreview, RunLifecycleUpdate,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::codex_models::CodexModelCatalog;
use crate::configure::{ConfigDomain, ConfigResource, ConfigResourceKind, derive_resources};
use crate::help::HelpTopic;

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

/// Keys whose panel-level meaning must not be shadowed by profile-defined orchestration
/// shortcuts. Both dispatch and contextual help use this single runtime protection list.
pub(crate) const PROTECTED_CONFIGURED_ORCHESTRATION_KEYS: &[char] = &[
    'h', 'q', 'r', 'R', 'c', '1', '2', '4', 'n', '?', 'D', 'a', 'j', 'k', 'l', '[', ']',
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
            Self::Planning => "planning",
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
    pub branch: Option<String>,
    pub base: Option<String>,
    pub ticket_count: usize,
    pub open_questions: usize,
    pub active_agents: usize,
    pub validation_errors: usize,
    #[serde(default)]
    pub total_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveAgentSummary {
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSummary {
    pub title: String,
    pub status: String,
    pub live: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RunData {
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
                total_tokens: snapshot
                    .get("token_usage")
                    .and_then(|usage| usage.get("total_tokens"))
                    .and_then(Value::as_u64)
                    .or_else(|| {
                        let usage = snapshot.get("token_usage")?;
                        Some(
                            usage
                                .get("input_tokens")
                                .and_then(Value::as_u64)
                                .unwrap_or_default()
                                .saturating_add(
                                    usage
                                        .get("output_tokens")
                                        .and_then(Value::as_u64)
                                        .unwrap_or_default(),
                                ),
                        )
                    })
                    .unwrap_or_default(),
            });
        let mut data = Self {
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
        }
        data
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
                    Some("starting" | "running" | "resuming")
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
            status: String,
            live: bool,
            updated_at: String,
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

        for (agent_index, agent) in self.agents.iter().enumerate() {
            let status = agent
                .get("status")
                .or_else(|| agent.get("state"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let stage_id = agent.get("stage_id").and_then(Value::as_str);
            let ticket_id = agent.get("ticket_id").and_then(Value::as_str);
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
            let key = agent
                .get("process_identity")
                .and_then(|identity| identity.get("pid"))
                .or_else(|| agent.get("pid"))
                .and_then(Value::as_u64)
                .map_or_else(
                    || {
                        agent.get("id").and_then(Value::as_str).map_or_else(
                            || format!("stage:{}:{agent_index}", stage_id.unwrap_or_default()),
                            |id| format!("agent:{id}"),
                        )
                    },
                    |pid| format!("process:{pid}"),
                );
            candidates.push(Candidate {
                key,
                group,
                order,
                title: concise_work_title(&title),
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
                status: "running".to_owned(),
                live: true,
                updated_at: String::new(),
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
                    status: "completed".to_owned(),
                    live: false,
                    updated_at: output
                        .get("recorded_at")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
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
                title: candidate.title,
                status: candidate.status,
                live: candidate.live,
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
    let extension = document
        .source_path
        .extension()
        .and_then(|extension| extension.to_str());
    match extension {
        Some("md") => None,
        Some("toml") => toml::from_str::<toml::Value>(&document.text)
            .ok()
            .and_then(|value| serde_json::to_value(value).ok()),
        _ => serde_yaml::from_str::<Value>(&document.text).ok(),
    }
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
    pub selected_agent: usize,
    pub run_scroll: usize,
    pub ticket_scroll: usize,
    pub graph_scroll: usize,
    pub detail_scroll: usize,
    pub activity_tick: u64,
    pub config: ConfigState,
    pub status: String,
    pub orchestration_running: bool,
    pub max_parallel: usize,
    pub unchained: bool,
    pub dialog: Option<Dialog>,
    suspended_dialog: Option<Dialog>,
    pub run_types: Vec<RunTypeOption>,
    /// Models and model-specific reasoning levels exposed by the installed Codex CLI.
    pub(crate) codex_models: CodexModelCatalog,
    pub default_run_type: String,
    pub run_type_intake: BTreeMap<String, Vec<IntakeFieldDraft>>,
    pub catalog_error: Option<String>,
    /// The compatibility catalog is readable, but conversion is always an explicit staged edit.
    pub legacy_migration_available: bool,
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
    pub base_ref: String,
    pub question_policy: String,
    pub max_parallel: usize,
    pub agent_roles: BTreeMap<String, RunAgentSetting>,
    pub overridden_fields: BTreeSet<String>,
    pub active_field: usize,
    pub intake_fields: Vec<IntakeFieldDraft>,
    pub submitted: bool,
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
            base_ref: "HEAD".to_owned(),
            question_policy: "interactive".to_owned(),
            max_parallel: 1,
            agent_roles: BTreeMap::new(),
            overridden_fields: BTreeSet::new(),
            active_field: 0,
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
    pub approve_focused: bool,
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
        self.approve_focused = false;
    }

    pub fn scroll_by(&mut self, delta: isize) {
        self.scroll = self.scroll.saturating_add_signed(delta);
        self.approve_focused = false;
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

impl ControlCenterModel {
    pub fn load(root: &Path) -> anyhow::Result<Self> {
        let launch_root = root.canonicalize()?;
        let root = canonical_project_root(&launch_root)?;
        let config = load_config_state(&root)?;
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
            selected_agent: 0,
            run_scroll: 0,
            ticket_scroll: 0,
            graph_scroll: 0,
            detail_scroll: 0,
            activity_tick: 0,
            config,
            status: String::new(),
            orchestration_running: true,
            max_parallel: 3,
            unchained: false,
            dialog: None,
            suspended_dialog: None,
            run_types,
            codex_models: CodexModelCatalog::available(),
            default_run_type,
            run_type_intake,
            catalog_error,
            legacy_migration_available,
        };
        model.reload();
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
            selected_agent: 0,
            run_scroll: 0,
            ticket_scroll: 0,
            graph_scroll: 0,
            detail_scroll: 0,
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
            codex_models: CodexModelCatalog::fallback(),
            default_run_type: "default".to_owned(),
            run_type_intake: BTreeMap::new(),
            catalog_error: None,
            legacy_migration_available: false,
        };
        model.normalize_selection();
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

    pub fn selected_run_data(&self) -> Option<&RunData> {
        self.runs.get(self.selected_run)
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
        self.selected_agent = 0;
        self.graph_scroll = 0;
        self.detail_scroll = 0;
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
            return;
        }
        self.selected_question = self
            .selected_question
            .saturating_add_signed(delta)
            .min(count - 1);
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
        }
    }

    pub fn select_next_agent(&mut self, delta: isize) {
        let count = self
            .selected_run_data()
            .map(|run| run.agent_summaries().len())
            .unwrap_or_default();
        if count == 0 {
            self.selected_agent = 0;
            return;
        }
        self.selected_agent = self
            .selected_agent
            .saturating_add_signed(delta)
            .min(count - 1);
    }

    pub fn advance_activity_animation(&mut self) {
        self.activity_tick = self.activity_tick.wrapping_add(1);
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
        self.selected_ticket_value()
            .and_then(|ticket| ticket.get("id"))
            .and_then(Value::as_str)
            .is_some_and(|ticket_id| run.ticket_graphs.contains_key(ticket_id))
    }

    pub fn select_next_run(&mut self, delta: isize) {
        self.overview_subject = OverviewSubject::Run;
        if self.runs.is_empty() {
            return;
        }
        self.selected_run = self
            .selected_run
            .saturating_add_signed(delta)
            .min(self.runs.len() - 1);
        self.selected_ticket = 0;
        self.selected_question = 0;
        self.selected_agent = 0;
        self.graph_scroll = 0;
        self.detail_scroll = 0;
        self.normalize_conditional_focus();
        self.sync_orchestration();
    }

    pub fn select_next_ticket(&mut self, delta: isize) {
        self.overview_subject = OverviewSubject::Ticket;
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
        let current = Panel::ALL
            .iter()
            .position(|candidate| *candidate == self.detail_panel)
            .unwrap_or(0);
        self.detail_panel = Panel::ALL[wrap_index(current, delta, Panel::ALL.len())];
        self.detail_scroll = 0;
    }

    pub fn cycle_focus(&mut self, backwards: bool) {
        let operate = [
            Focus::Runs,
            Focus::Tickets,
            Focus::Details,
            Focus::Agents,
            Focus::Graph,
        ];
        let operate_with_questions = [
            Focus::Runs,
            Focus::Tickets,
            Focus::Details,
            Focus::Questions,
            Focus::Agents,
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
    }

    pub fn focus_runs(&mut self) {
        self.focus = Focus::Runs;
        self.overview_subject = OverviewSubject::Run;
    }

    pub fn focus_tickets(&mut self) {
        self.focus = Focus::Tickets;
        self.overview_subject = OverviewSubject::Ticket;
    }

    fn sync_overview_subject_to_focus(&mut self) {
        match self.focus {
            Focus::Runs => self.overview_subject = OverviewSubject::Run,
            Focus::Tickets => self.overview_subject = OverviewSubject::Ticket,
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
                "convert the Legacy configuration first · press L in Configure".to_owned();
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
            !self.root.join(".codex/koni").join(relative_path).exists(),
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
        let source_path = self.root.join(".codex/koni").join(relative_path);
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
                "deletion staged for {} (press D to undo, Ctrl-P to publish)",
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
            Some("toml") => "# New Codex project resource\n".to_owned(),
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
        let Some(question) = self
            .selected_run_data()
            .and_then(|run| run.pending_questions().get(index).copied())
            .cloned()
        else {
            self.status = "no open question for this run".to_owned();
            return;
        };
        self.selected_question = index;
        let options = question
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
                        .unwrap_or_default()
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
            .collect::<Vec<_>>();
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
            .unwrap_or_default()
            .to_owned();
        let selected = stored_option
            .and_then(|stored| options.iter().position(|(id, _, _, _)| id == stored))
            .or_else(|| {
                options
                    .iter()
                    .position(|(_, _, _, recommended)| *recommended)
            })
            .unwrap_or(0);
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
            custom_active: !stored_custom.is_empty(),
            custom: stored_custom,
            allow_custom: question
                .get("allow_custom_answer")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            pending_resume,
            waiting_for_batch: pending_resume
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
        let config_root = self.root.join(".codex/koni");
        let staged_config_root = validation_root.join(".codex/koni");
        copy_tree(&config_root, &staged_config_root)?;
        copy_tree(
            &self.root.join(".codex/agents"),
            &validation_root.join(".codex/agents"),
        )?;
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
        let config_root = self.root.join(".codex/koni");
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
        self.selected_agent = self.selected_agent.min(
            self.selected_run_data()
                .map(|run| run.agent_summaries().len())
                .unwrap_or_default()
                .saturating_sub(1),
        );
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
        schema_version: "1.0".to_owned(),
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
                        .reasoning_effort
                        .as_ref()
                        .map_or_else(|| model.to_owned(), |effort| format!("{model}/{effort}"));
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
                                .and_then(|setting| setting.reasoning_effort.clone())
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

pub(crate) fn project_snapshots(root: &Path) -> koni_core::Result<Vec<Value>> {
    let Some(common_dir) = git_common_dir(root) else {
        // Installation is intentionally configuration-only. A brand-new directory therefore
        // has no Git repository until the user submits the first run, at which point the engine
        // creates the baseline commit. Opening the control center before that remains read-only.
        return Ok(Vec::new());
    };
    let registry_exists = common_dir.join("koni/project.yaml").exists();
    if !registry_exists {
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
    let mut snapshots = registry
        .runs
        .iter()
        .map(|(run_id, registration)| {
            Engine::open_run(root, run_id)
                .and_then(|engine| engine.cockpit_snapshot())
                .unwrap_or_else(|error| {
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
                })
        })
        .collect::<Vec<_>>();
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
    Ok(snapshots)
}

fn canonical_project_root(root: &Path) -> anyhow::Result<PathBuf> {
    let root = root.canonicalize()?;
    let repository = git2_discover_root(&root).unwrap_or(root);
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
    let config_root = root.join(".codex/koni");
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
    let codex_project_config = root.join(".codex/config.toml");
    if codex_project_config.exists() {
        paths.push(codex_project_config);
    }
    collect_config_files(&root.join(".codex/agents"), &mut paths)?;
    collect_config_files(&root.join(".agents/skills"), &mut paths)?;
    let mut draft_paths = Vec::new();
    collect_config_files(&draft_root, &mut draft_paths)?;
    for draft_path in draft_paths {
        let Ok(relative_path) = draft_path.strip_prefix(&draft_root) else {
            continue;
        };
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
            || source_path
                .strip_prefix(root)
                .is_ok_and(native_config_relative_path)
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
        .join("koni/config-drafts")
}

fn native_config_relative_path(path: &Path) -> bool {
    path == Path::new(".codex/config.toml")
        || (path.parent() == Some(Path::new(".codex/agents"))
            && path.extension().and_then(|extension| extension.to_str()) == Some("toml"))
        || path
            .strip_prefix(Path::new(".agents/skills"))
            .is_ok_and(|relative| relative.components().count() >= 2)
}

fn config_document_source_path(root: &Path, relative_path: &Path) -> PathBuf {
    if native_config_relative_path(relative_path) {
        root.join(relative_path)
    } else {
        root.join(".codex/koni").join(relative_path)
    }
}

fn staged_config_document_path(validation_root: &Path, relative_path: &Path) -> PathBuf {
    if native_config_relative_path(relative_path) {
        validation_root.join(relative_path)
    } else {
        validation_root.join(".codex/koni").join(relative_path)
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
    required: bool,
    succeeded: bool,
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

fn approval_draft(run: &RunData, summary: &RunSummary, run_type_title: String) -> ApprovalDraft {
    let passes = approval_planning_passes(run);
    let mut blockers = passes
        .iter()
        .filter(|pass| pass.required && (!pass.succeeded || pass.body.is_none()))
        .map(|pass| format!("{} is incomplete", pass.title))
        .collect::<Vec<_>>();
    if run.questions.iter().any(question_needs_attention) {
        blockers.push("Planning decisions still need attention".to_owned());
    }

    let mut sections = vec![ApprovalSection {
        title: "Resolved decisions".to_owned(),
        body: resolved_decisions_body(&run.questions),
    }];
    for (title, kind, empty_copy) in [
        (
            "Architecture plan",
            ApprovalPlanKind::Architecture,
            "No separate architecture planning pass is required for this run type.",
        ),
        (
            "Risk plan",
            ApprovalPlanKind::Risk,
            "No separate risk planning pass is required for this run type.",
        ),
        (
            "Verification plan",
            ApprovalPlanKind::Verification,
            "No separate verification planning pass is required for this run type.",
        ),
    ] {
        sections.push(ApprovalSection {
            title: title.to_owned(),
            body: approval_plan_body(&passes, kind, empty_copy),
        });
    }
    sections.extend(
        passes
            .iter()
            .filter(|pass| pass.kind == ApprovalPlanKind::Other)
            .map(|pass| ApprovalSection {
                title: pass.title.clone(),
                body: pass.body.clone().unwrap_or_else(|| {
                    "This planning pass has not produced durable review text yet.".to_owned()
                }),
            }),
    );
    let redactions = approval_body_redactions(run, summary);
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
        approve_focused: false,
        approval_enabled: blockers.is_empty(),
        blockers,
        submitted: false,
    }
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
) -> String {
    let direct = passes
        .iter()
        .filter(|pass| pass.kind == kind)
        .collect::<Vec<_>>();
    let selected = if direct.is_empty() {
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
            pass.body.as_ref().map_or_else(
                || format!("{} has not produced durable review text yet.", pass.title),
                |body| format!("{}\n\n{body}", pass.title),
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn resolved_decisions_body(questions: &[Value]) -> String {
    let mut decisions = questions
        .iter()
        .enumerate()
        .filter(|(_, question)| question.get("answer").is_some_and(Value::is_object))
        .collect::<Vec<_>>();
    sort_question_rows(&mut decisions);
    let decisions = decisions
        .into_iter()
        .filter_map(|(_, question)| {
            let prompt = question
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|prompt| !prompt.is_empty())?;
            let answer = question.get("answer")?;
            let selected = answer
                .get("custom")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|answer| !answer.is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| {
                    let option_id = answer.get("option_id").and_then(Value::as_str)?;
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
                })
                .unwrap_or_else(|| "Recorded response".to_owned());
            Some((prompt.to_owned(), selected))
        })
        .collect::<Vec<_>>();
    if decisions.is_empty() {
        return "No planning questions were required for this run.".to_owned();
    }
    decisions
        .into_iter()
        .enumerate()
        .map(|(index, (prompt, answer))| format!("{}. {prompt}\n   Decision: {answer}", index + 1))
        .collect::<Vec<_>>()
        .join("\n\n")
}

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

pub(crate) fn question_answer_is_pending_resume(question: &Value) -> bool {
    matches!(
        question.get("status").and_then(Value::as_str),
        Some("resume_pending" | "answered_pending_resume" | "auto_resolved_pending_resume")
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
    use koni_core::state::ConfigSnapshot;
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn run_summary_projects_explicit_fallback_and_missing_token_totals() {
        let summary = |token_usage: Value| {
            RunData::from_snapshot(json!({
                "run": {"id": "run-1", "goal": "Test", "status": "active"},
                "token_usage": token_usage
            }))
            .summary
            .unwrap()
            .total_tokens
        };

        assert_eq!(summary(json!({"total_tokens": 123})), 123);
        assert_eq!(
            summary(json!({"input_tokens": 20, "output_tokens": 10})),
            30
        );
        assert_eq!(summary(Value::Null), 0);
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
                    title: "Plan risk controls".to_owned(),
                    status: "running".to_owned(),
                    live: true,
                },
                AgentSummary {
                    title: "Notes editor".to_owned(),
                    status: "starting".to_owned(),
                    live: true,
                },
                AgentSummary {
                    title: "Research outline".to_owned(),
                    status: "completed".to_owned(),
                    live: false,
                },
                AgentSummary {
                    title: "Notes editor".to_owned(),
                    status: "completed".to_owned(),
                    live: false,
                },
                AgentSummary {
                    title: "Waiting stage".to_owned(),
                    status: "waiting".to_owned(),
                    live: false,
                },
                AgentSummary {
                    title: "Closed work".to_owned(),
                    status: "running".to_owned(),
                    live: false,
                },
                AgentSummary {
                    title: "Reviewer".to_owned(),
                    status: "active".to_owned(),
                    live: false,
                },
            ]
        );
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
            (Focus::Details, OverviewSubject::Ticket),
            (Focus::Agents, OverviewSubject::Ticket),
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
        assert_eq!(model.focus, Focus::Agents);
        model.cycle_focus(true);
        assert_eq!(model.focus, Focus::Questions);

        model.runs[model.selected_run].questions.clear();
        model.normalize_conditional_focus();
        assert_eq!(model.focus, Focus::Details);
        model.cycle_focus(false);
        assert_eq!(model.focus, Focus::Agents);
        model.cycle_focus(true);
        assert_eq!(model.focus, Focus::Details);
        model.cycle_focus(true);
        assert_eq!(model.focus, Focus::Tickets);
    }

    #[test]
    fn details_cycle_contains_only_overview_planning_and_stages() {
        let mut model =
            ControlCenterModel::from_snapshot(PathBuf::from("/tmp/project"), Value::Null);
        assert_eq!(
            Panel::ALL.map(Panel::label),
            ["overview", "planning", "stages"]
        );

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
                            "output":architecture_body
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
                        "output":{"output":{"agent_id":"planning-risk-plan","output":"Risk research plan body"}}
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
                        "output":{"output":{"agent_id":"planning-verification-plan","output":"Verification research plan body"}}
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
        for (section, (title, body)) in approval.sections.iter().skip(1).zip([
            ("Architecture plan", "Architecture research plan body"),
            ("Risk plan", "Risk research plan body"),
            ("Verification plan", "Verification research plan body"),
        ]) {
            assert_eq!(section.title, title);
            assert!(section.body.contains(body), "{}", section.body);
            assert!(!section.body.contains("No separate"), "{}", section.body);
        }
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
        ] {
            assert!(!rendered.contains(secret), "approval leaked {secret}");
        }
        assert!(!rendered.contains(&format!("PID {pid}")), "{rendered}");
        assert!(rendered.contains("the current run"));
        assert!(rendered.contains("the planning checkout"));
        assert!(rendered.contains(base_commit));
        assert!(rendered.contains("C1"));
        assert!(rendered.contains("G2"));
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
        assert!(approval.sections[1].body.contains("Legacy planning body"));
        assert!(approval.approval_enabled);
    }

    #[test]
    fn approval_review_projects_decisions_and_each_durable_planning_fallback_without_ids() {
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
            [
                "Resolved decisions",
                "Architecture plan",
                "Risk plan",
                "Verification plan"
            ]
        );
        assert!(
            approval.sections[0]
                .body
                .contains("How should invalid inputs be rejected?")
        );
        assert!(
            approval.sections[0]
                .body
                .contains("Decision: Raise TypeError")
        );
        assert!(approval.sections[1].body.contains("Architecture full text"));
        assert!(approval.sections[2].body.contains("Risk full text"));
        assert!(approval.sections[3].body.contains("Verification full text"));
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
            approval.sections[2]
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
            "  experiment.target_claims: tests\n",
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
            .find(|row| row.path.ends_with("experiment.target_claims"))
            .unwrap()
            .clone();
        assert_eq!(
            dotted.locator,
            vec![
                FormPathToken::Key("reverse_display_edges".to_owned()),
                FormPathToken::Key("experiment.target_claims".to_owned()),
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
            parsed["reverse_display_edges"]["experiment.target_claims"],
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
