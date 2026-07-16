//! Structured, Codex-inspired rendering for Koni-owned agent transcripts.
//!
//! Codex's TUI history cells are intentionally internal to that crate. Koni therefore keeps a
//! small local presentation model: JSONL transport events are parsed once into durable chat
//! blocks, and those blocks are re-rendered when the details panel changes width.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::Value;
use syntect::easy::HighlightLines;
use syntect::highlighting::{FontStyle, Theme, ThemeSet};
use syntect::parsing::SyntaxSet;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const MAX_TRANSCRIPT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PROMPT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CACHED_AGENTS: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentChatRequest {
    pub key: String,
    pub root: PathBuf,
    pub transcript_path: Option<PathBuf>,
    pub prompt_path: Option<PathBuf>,
    pub output_path: Option<PathBuf>,
    pub codex_session_id: Option<String>,
    pub guidance: Vec<String>,
    pub live: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentChatRender {
    pub lines: Rc<Vec<Line<'static>>>,
    pub has_running_operation: bool,
}

#[derive(Debug, Default)]
pub(crate) struct AgentChatCache {
    entries: BTreeMap<String, CachedChat>,
}

#[derive(Debug)]
struct CachedChat {
    fingerprint: ChatFingerprint,
    document: AgentChatDocument,
    rendered_width: Option<u16>,
    rendered_lines: Rc<Vec<Line<'static>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChatFingerprint {
    transcript: Option<FileStamp>,
    prompt: Option<FileStamp>,
    output: Option<FileStamp>,
    session: Option<String>,
    guidance: Vec<String>,
    live: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileStamp {
    path: PathBuf,
    length: Option<u64>,
    modified_nanos: Option<u128>,
}

impl AgentChatCache {
    pub(crate) fn render(&mut self, request: &AgentChatRequest, width: u16) -> AgentChatRender {
        let fingerprint = ChatFingerprint::for_request(request);
        let reload = self
            .entries
            .get(&request.key)
            .is_none_or(|cached| cached.fingerprint != fingerprint);
        if reload {
            if !self.entries.contains_key(&request.key)
                && self.entries.len() >= MAX_CACHED_AGENTS
                && let Some(oldest) = self.entries.keys().next().cloned()
            {
                self.entries.remove(&oldest);
            }
            self.entries.insert(
                request.key.clone(),
                CachedChat {
                    fingerprint,
                    document: load_document(request),
                    rendered_width: None,
                    rendered_lines: Rc::new(Vec::new()),
                },
            );
        }

        let cached = self
            .entries
            .get_mut(&request.key)
            .expect("agent chat cache entry was inserted");
        if cached.rendered_width != Some(width) {
            cached.rendered_lines = Rc::new(render_document(&cached.document, width));
            cached.rendered_width = Some(width);
        }
        AgentChatRender {
            lines: Rc::clone(&cached.rendered_lines),
            has_running_operation: cached.document.has_running_operation(),
        }
    }
}

impl ChatFingerprint {
    fn for_request(request: &AgentChatRequest) -> Self {
        Self {
            transcript: request
                .transcript_path
                .as_deref()
                .map(|path| file_stamp(&request.root, path)),
            prompt: request
                .prompt_path
                .as_deref()
                .map(|path| file_stamp(&request.root, path)),
            output: request
                .output_path
                .as_deref()
                .map(|path| file_stamp(&request.root, path)),
            session: request.codex_session_id.clone(),
            guidance: request.guidance.clone(),
            live: request.live,
        }
    }
}

fn file_stamp(root: &Path, path: &Path) -> FileStamp {
    let candidate = rooted_path(root, path);
    let metadata = fs::metadata(&candidate).ok();
    let modified_nanos = metadata
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    FileStamp {
        path: candidate,
        length: metadata.as_ref().map(fs::Metadata::len),
        modified_nanos,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentChatDocument {
    blocks: Vec<AgentChatBlock>,
}

impl AgentChatDocument {
    fn has_running_operation(&self) -> bool {
        self.blocks.iter().any(|block| {
            matches!(
                block,
                AgentChatBlock::Operation(OperationBlock {
                    status: OperationStatus::Running,
                    ..
                })
            )
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AgentChatBlock {
    User(String),
    Assistant(String),
    Reasoning(String),
    Operation(OperationBlock),
    Error(String),
    Usage {
        input: u64,
        output: u64,
    },
    Notice {
        title: String,
        body: Option<String>,
        warning: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OperationBlock {
    kind: OperationKind,
    invocation: String,
    body: Vec<OperationLine>,
    status: OperationStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OperationLine {
    text: String,
    tone: OperationTone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperationTone {
    Muted,
    Added,
    Modified,
    Deleted,
    Header,
    PlanPending,
    PlanActive,
    PlanDone,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OperationKind {
    Command,
    Mcp,
    FileChange,
    Search,
    Plan,
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperationStatus {
    Running,
    Succeeded,
    Failed,
    Skipped,
}

fn load_document(request: &AgentChatRequest) -> AgentChatDocument {
    let mut blocks = Vec::new();
    let mut prompt = None;
    if let Some(path) = request.prompt_path.as_deref() {
        match read_project_file(&request.root, path, MAX_PROMPT_BYTES, "agent prompt") {
            Ok(text) if !text.trim().is_empty() => {
                let text = sanitize_terminal_text(&text);
                prompt = Some(text.clone());
                blocks.push(AgentChatBlock::User(text));
            }
            Ok(_) => {}
            Err(error) => blocks.push(AgentChatBlock::Notice {
                title: "Prompt unavailable".to_owned(),
                body: Some(error),
                warning: true,
            }),
        }
    }
    for message in &request.guidance {
        let message = sanitize_terminal_text(message).trim().to_owned();
        if message.is_empty()
            || prompt
                .as_deref()
                .is_some_and(|prompt| prompt.contains(&message))
        {
            continue;
        }
        blocks.push(AgentChatBlock::User(message));
    }

    match request.transcript_path.as_deref() {
        Some(path) => match read_project_file(
            &request.root,
            path,
            MAX_TRANSCRIPT_BYTES,
            "Codex transcript",
        ) {
            Ok(text) => {
                parse_jsonl_transcript(&text, request.codex_session_id.as_deref(), &mut blocks)
            }
            Err(error) => blocks.push(AgentChatBlock::Error(error)),
        },
        None if request.live => blocks.push(AgentChatBlock::Notice {
            title: "Waiting for Codex output".to_owned(),
            body: None,
            warning: false,
        }),
        None if blocks.is_empty() => blocks.push(AgentChatBlock::Notice {
            title: "No Codex transcript was recorded".to_owned(),
            body: None,
            warning: false,
        }),
        None => {}
    }

    // Direct Pi and Codex both publish the authoritative final assistant
    // artifact separately. Use it as a lossless compatibility fallback for
    // older compact Pi logs, but do not duplicate a message already present
    // in a rich transcript.
    if let Some(path) = request.output_path.as_deref() {
        match read_project_file(&request.root, path, MAX_TRANSCRIPT_BYTES, "agent output") {
            Ok(text) if !text.trim().is_empty() => {
                let text = sanitize_terminal_text(&text);
                let duplicate = blocks.iter().any(|block| {
                    matches!(block, AgentChatBlock::Assistant(existing) if existing.trim() == text.trim())
                });
                if !duplicate {
                    blocks.push(AgentChatBlock::Assistant(text));
                }
            }
            Ok(_) => {}
            Err(error) if !request.live => blocks.push(AgentChatBlock::Notice {
                title: "Final agent output unavailable".to_owned(),
                body: Some(error),
                warning: true,
            }),
            Err(_) => {}
        }
    }

    if blocks.is_empty() {
        blocks.push(AgentChatBlock::Notice {
            title: "The agent has not emitted a visible message yet".to_owned(),
            body: None,
            warning: false,
        });
    }
    AgentChatDocument { blocks }
}

fn rooted_path(root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    }
}

fn read_project_file(
    root: &Path,
    path: &Path,
    maximum: u64,
    label: &str,
) -> Result<String, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Project boundary is unavailable: {error}"))?;
    let candidate = rooted_path(&root, path);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("{label} is unavailable: {error}"))?;
    if !canonical.starts_with(&root) {
        return Err(format!("{label} failed the project boundary check"));
    }
    let metadata =
        fs::metadata(&canonical).map_err(|error| format!("Could not inspect {label}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{label} is not a regular file"));
    }
    if metadata.len() > maximum {
        return Err(format!(
            "{label} is too large to preview safely ({} > {})",
            compact_bytes(metadata.len()),
            compact_bytes(maximum)
        ));
    }
    fs::read_to_string(&canonical).map_err(|error| format!("Could not read {label}: {error}"))
}

fn compact_bytes(value: u64) -> String {
    if value >= 1024 * 1024 {
        format!("{:.1} MiB", value as f64 / (1024.0 * 1024.0))
    } else if value >= 1024 {
        format!("{:.1} KiB", value as f64 / 1024.0)
    } else {
        format!("{value} B")
    }
}

#[derive(Debug)]
struct JsonlEvent {
    source_line: usize,
    value: Value,
}

fn parse_jsonl_transcript(text: &str, session_id: Option<&str>, blocks: &mut Vec<AgentChatBlock>) {
    let complete_last_line = text.ends_with('\n');
    let source_lines = text.lines().collect::<Vec<_>>();
    let mut events = Vec::new();
    let mut malformed = Vec::new();
    for (index, line) in source_lines.iter().enumerate() {
        if !complete_last_line && index + 1 == source_lines.len() {
            break;
        }
        if line.trim().is_empty() || is_ignorable_codex_transport_line(line) {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(value) => events.push(JsonlEvent {
                source_line: index + 1,
                value,
            }),
            Err(error) => malformed.push((index + 1, error.to_string())),
        }
    }

    let thread_starts = events
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            event.value.get("type").and_then(Value::as_str) == Some("thread.started")
        })
        .collect::<Vec<_>>();
    let requested_start = session_id.and_then(|session| {
        thread_starts.iter().find_map(|(index, event)| {
            (event.value.get("thread_id").and_then(Value::as_str) == Some(session))
                .then_some(*index)
        })
    });
    if session_id.is_some() && requested_start.is_none() && !thread_starts.is_empty() {
        blocks.push(AgentChatBlock::Notice {
            title: "Requested Codex session was not found".to_owned(),
            body: Some("Showing the newest recorded session instead.".to_owned()),
            warning: true,
        });
    }
    let start = requested_start
        .or_else(|| thread_starts.last().map(|(index, _)| *index))
        .unwrap_or(0);
    let end = events
        .iter()
        .enumerate()
        .skip(start.saturating_add(1))
        .find_map(|(index, event)| {
            (event.value.get("type").and_then(Value::as_str) == Some("thread.started"))
                .then_some(index)
        })
        .unwrap_or(events.len());
    let selected_start_line = events
        .get(start)
        .map(|event| event.source_line)
        .unwrap_or(1);
    let selected_end_line = events
        .get(end)
        .map(|event| event.source_line)
        .unwrap_or_else(|| source_lines.len().saturating_add(1));

    let mut item_blocks = BTreeMap::<String, usize>::new();
    let mut pi_tool_blocks = BTreeMap::<String, usize>::new();
    for event in events.iter().take(end).skip(start) {
        let event_type = event
            .value
            .get("type")
            .and_then(Value::as_str)
            // Compatibility for direct-Pi logs written before every runtime
            // path adopted the canonical `type: pi.event` envelope. Those
            // rows already contain the full safe payload under `event`.
            .or_else(|| {
                event
                    .value
                    .get("event")
                    .and_then(|payload| payload.get("event"))
                    .and_then(Value::as_str)
                    .map(|_| "pi.event")
            })
            .unwrap_or_default();
        match event_type {
            "thread.started" | "turn.started" => {}
            "item.started" | "item.updated" | "item.completed" => {
                let Some(item) = event.value.get("item") else {
                    blocks.push(AgentChatBlock::Notice {
                        title: format!("Malformed {event_type}"),
                        body: Some(format!(
                            "JSONL line {} has no item payload.",
                            event.source_line
                        )),
                        warning: true,
                    });
                    continue;
                };
                let phase = if event_type == "item.completed" {
                    ItemPhase::Completed
                } else {
                    ItemPhase::Running
                };
                let Some(block) = block_from_item(item, phase) else {
                    continue;
                };
                let item_id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                if let Some(index) = item_id.as_ref().and_then(|id| item_blocks.get(id)).copied() {
                    blocks[index] = block;
                } else {
                    let index = blocks.len();
                    blocks.push(block);
                    if let Some(item_id) = item_id {
                        item_blocks.insert(item_id, index);
                    }
                }
            }
            "turn.completed" => {
                finish_unclosed_pi_tools(blocks, &pi_tool_blocks);
                let usage = event.value.get("usage").unwrap_or(&Value::Null);
                blocks.push(AgentChatBlock::Usage {
                    input: usage
                        .get("input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    output: usage
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                });
            }
            "pi.turn_usage" => {
                finish_unclosed_pi_tools(blocks, &pi_tool_blocks);
                let usage = event.value.get("usage").unwrap_or(&Value::Null);
                blocks.push(AgentChatBlock::Usage {
                    input: usage
                        .get("total_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        .saturating_sub(
                            usage
                                .get("output_tokens")
                                .and_then(Value::as_u64)
                                .unwrap_or(0),
                        ),
                    output: usage
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                });
            }
            "pi.event" => {
                if let Some(pi_event) = event.value.get("event") {
                    append_pi_event(pi_event, blocks, &mut pi_tool_blocks);
                }
            }
            "turn.failed" | "error" => blocks.push(AgentChatBlock::Error(
                event
                    .value
                    .get("message")
                    .or_else(|| {
                        event
                            .value
                            .get("error")
                            .and_then(|error| error.get("message"))
                    })
                    .map(full_value_text)
                    .filter(|message| !message.trim().is_empty())
                    .unwrap_or_else(|| "Agent turn failed".to_owned()),
            )),
            unknown if !unknown.is_empty() => blocks.push(AgentChatBlock::Notice {
                title: format!("Event · {}", humanize(unknown)),
                body: event
                    .value
                    .get("message")
                    .or_else(|| event.value.get("error"))
                    .map(full_value_text),
                warning: false,
            }),
            _ => {}
        }
    }
    let malformed_in_selected_session = malformed
        .into_iter()
        .filter(|(line, _error)| {
            thread_starts.is_empty() || (*line >= selected_start_line && *line < selected_end_line)
        })
        .count();
    if malformed_in_selected_session > 0 {
        blocks.push(AgentChatBlock::Notice {
            title: "Some transcript output was not displayable".to_owned(),
            body: Some(format!(
                "Ignored {} unstructured transport {} in this agent session.",
                malformed_in_selected_session,
                if malformed_in_selected_session == 1 {
                    "line"
                } else {
                    "lines"
                }
            )),
            warning: true,
        });
    }
}

fn append_pi_event(
    event: &Value,
    blocks: &mut Vec<AgentChatBlock>,
    tool_blocks: &mut BTreeMap<String, usize>,
) {
    match event
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "message_completed" => append_pi_message(event, blocks, tool_blocks),
        "tool_started" => {
            let call_id = event
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = event
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("compiler_tool");
            upsert_pi_tool(
                call_id,
                name,
                None,
                OperationStatus::Running,
                blocks,
                tool_blocks,
            );
        }
        "tool_completed" => {
            let call_id = event
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let failed = event
                .get("outcome")
                .and_then(|outcome| outcome.get("status"))
                .and_then(Value::as_str)
                == Some("error");
            let status = if failed {
                OperationStatus::Failed
            } else {
                OperationStatus::Succeeded
            };
            let index = ensure_pi_tool(call_id, "compiler_tool", blocks, tool_blocks);
            if let AgentChatBlock::Operation(operation) = &mut blocks[index] {
                operation.status = status;
                if let Some(outcome) = event.get("outcome") {
                    append_labeled_value("Result", outcome, &mut operation.body, status);
                }
            }
        }
        "tool_rejected" => {
            let call_id = event
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let name = event
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("compiler_tool");
            let index = ensure_pi_tool(call_id, name, blocks, tool_blocks);
            if let AgentChatBlock::Operation(operation) = &mut blocks[index] {
                operation.status = OperationStatus::Failed;
                if let Some(message) = event.get("message") {
                    append_labeled_value(
                        "Rejected",
                        message,
                        &mut operation.body,
                        OperationStatus::Failed,
                    );
                }
            }
        }
        "retry" => blocks.push(AgentChatBlock::Notice {
            title: "Provider retry".to_owned(),
            body: event.get("reason").map(full_value_text),
            warning: true,
        }),
        "compaction" => blocks.push(AgentChatBlock::Notice {
            title: "Context compacted".to_owned(),
            body: event
                .get("source_message_count")
                .and_then(Value::as_u64)
                .map(|count| format!("Summarized {count} earlier messages.")),
            warning: false,
        }),
        "runtime_error" => blocks.push(AgentChatBlock::Error(
            event
                .get("message")
                .map(full_value_text)
                .unwrap_or_else(|| "Agent runtime failed".to_owned()),
        )),
        // These are transport/lifecycle accounting, not conversation cells.
        "turn_started" | "message_delta" | "tool_updated" | "usage" | "turn_completed"
        | "authentication" | "" => {}
        _ => {}
    }
}

fn append_pi_message(
    event: &Value,
    blocks: &mut Vec<AgentChatBlock>,
    tool_blocks: &mut BTreeMap<String, usize>,
) {
    let Some(content) = event.get("content") else {
        // Older Pi transcripts intentionally retained only a hash. Do not
        // turn that transport envelope into a meaningless "Pi event" row.
        return;
    };
    match event
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "assistant" => append_pi_assistant_content(content, blocks, tool_blocks),
        // The compiler outcome carried by tool_completed is the authoritative
        // local tool-result cell. Pi's following toolResult message repeats it.
        "toolResult" | "tool_result" => {}
        "user" => {
            let text = extract_text(content);
            if !text.trim().is_empty() {
                blocks.push(AgentChatBlock::User(text));
            }
        }
        _ => {
            let text = extract_text(content);
            if !text.trim().is_empty() {
                blocks.push(AgentChatBlock::Assistant(text));
            }
        }
    }
}

fn append_pi_assistant_content(
    content: &Value,
    blocks: &mut Vec<AgentChatBlock>,
    tool_blocks: &mut BTreeMap<String, usize>,
) {
    let parts = content
        .as_array()
        .map_or_else(|| vec![content], |parts| parts.iter().collect());
    for part in parts {
        let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
        match kind {
            "toolCall" | "tool_call" => {
                let call_id = part
                    .get("id")
                    .or_else(|| part.get("call_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let name = part
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("compiler_tool");
                let arguments = part.get("arguments");
                upsert_pi_tool(
                    call_id,
                    name,
                    arguments,
                    OperationStatus::Running,
                    blocks,
                    tool_blocks,
                );
            }
            "thinking" | "reasoning" | "reasoning_summary" => {
                let text = extract_text(part);
                if !text.trim().is_empty() {
                    blocks.push(AgentChatBlock::Reasoning(text));
                }
            }
            "text" | "output_text" | "" => {
                let text = extract_text(part);
                if !text.trim().is_empty() {
                    blocks.push(AgentChatBlock::Assistant(text));
                }
            }
            _ => {
                let text = extract_text(part);
                if !text.trim().is_empty() {
                    blocks.push(AgentChatBlock::Assistant(text));
                }
            }
        }
    }
}

fn ensure_pi_tool(
    call_id: &str,
    name: &str,
    blocks: &mut Vec<AgentChatBlock>,
    tool_blocks: &mut BTreeMap<String, usize>,
) -> usize {
    if !call_id.is_empty()
        && let Some(index) = tool_blocks.get(call_id).copied()
    {
        return index;
    }
    let index = blocks.len();
    blocks.push(AgentChatBlock::Operation(OperationBlock {
        kind: OperationKind::Mcp,
        invocation: humanize(name),
        body: Vec::new(),
        status: OperationStatus::Running,
    }));
    if !call_id.is_empty() {
        tool_blocks.insert(call_id.to_owned(), index);
    }
    index
}

fn upsert_pi_tool(
    call_id: &str,
    name: &str,
    arguments: Option<&Value>,
    status: OperationStatus,
    blocks: &mut Vec<AgentChatBlock>,
    tool_blocks: &mut BTreeMap<String, usize>,
) {
    let index = ensure_pi_tool(call_id, name, blocks, tool_blocks);
    if let AgentChatBlock::Operation(operation) = &mut blocks[index] {
        operation.invocation = humanize(name);
        operation.status = status;
        if let Some(arguments) = arguments
            && !arguments.is_null()
            && !operation.body.iter().any(|line| line.text == "Input")
        {
            append_labeled_value("Input", arguments, &mut operation.body, status);
        }
    }
}

fn append_labeled_value(
    label: &str,
    value: &Value,
    body: &mut Vec<OperationLine>,
    status: OperationStatus,
) {
    body.push(OperationLine {
        text: label.to_owned(),
        tone: OperationTone::Header,
    });
    let tone = if status == OperationStatus::Failed {
        OperationTone::Failed
    } else {
        OperationTone::Muted
    };
    for line in full_value_text(value).lines() {
        body.push(OperationLine {
            text: line.to_owned(),
            tone,
        });
    }
}

fn finish_unclosed_pi_tools(blocks: &mut [AgentChatBlock], tool_blocks: &BTreeMap<String, usize>) {
    for index in tool_blocks.values().copied() {
        let Some(AgentChatBlock::Operation(operation)) = blocks.get_mut(index) else {
            continue;
        };
        if operation.status == OperationStatus::Running {
            operation.status = OperationStatus::Skipped;
            operation.body.push(OperationLine {
                text: "Not executed after the compiler closed this tool turn.".to_owned(),
                tone: OperationTone::Muted,
            });
        }
    }
}

fn is_ignorable_codex_transport_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed == "Reading additional input from stdin..."
        || (trimmed.contains("codex_models_manager::manager:")
            && trimmed.contains("failed to refresh available models"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ItemPhase {
    Running,
    Completed,
}

fn block_from_item(item: &Value, phase: ItemPhase) -> Option<AgentChatBlock> {
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    match item_type {
        "agent_message" | "agentMessage" => extract_item_text(item).map(AgentChatBlock::Assistant),
        "reasoning" | "reasoning_summary" => extract_item_text(item).map(AgentChatBlock::Reasoning),
        "command_execution" | "commandExecution" => {
            Some(AgentChatBlock::Operation(command_operation(item, phase)))
        }
        "mcp_tool_call" | "mcpToolCall" => {
            Some(AgentChatBlock::Operation(mcp_operation(item, phase)))
        }
        "file_change" | "file_changes" | "fileChange" => Some(AgentChatBlock::Operation(
            file_change_operation(item, phase),
        )),
        "web_search" | "webSearch" => {
            Some(AgentChatBlock::Operation(search_operation(item, phase)))
        }
        "plan" | "plan_update" | "todo_list" => {
            Some(AgentChatBlock::Operation(plan_operation(item, phase)))
        }
        "error" => Some(AgentChatBlock::Error(
            extract_item_text(item).unwrap_or_else(|| "Agent item failed".to_owned()),
        )),
        "user_message" | "userMessage" => extract_item_text(item).map(AgentChatBlock::User),
        "" => Some(AgentChatBlock::Notice {
            title: "Item without a type".to_owned(),
            body: extract_item_text(item),
            warning: true,
        }),
        other => Some(AgentChatBlock::Operation(other_operation(
            item, phase, other,
        ))),
    }
}

fn operation_status(item: &Value, phase: ItemPhase) -> OperationStatus {
    if phase == ItemPhase::Running {
        return OperationStatus::Running;
    }
    let failed = matches!(
        item.get("status").and_then(Value::as_str),
        Some("failed" | "error")
    ) || item.get("error").is_some_and(|error| !error.is_null())
        || item
            .get("exit_code")
            .or_else(|| item.get("exitCode"))
            .and_then(Value::as_i64)
            .is_some_and(|code| code != 0);
    if failed {
        OperationStatus::Failed
    } else {
        OperationStatus::Succeeded
    }
}

fn command_operation(item: &Value, phase: ItemPhase) -> OperationBlock {
    let invocation = item
        .get("command")
        .map(command_value_text)
        .filter(|command| !command.trim().is_empty())
        .unwrap_or_else(|| "shell command".to_owned());
    let status = operation_status(item, phase);
    let mut output = Vec::new();
    let mut seen = BTreeSet::new();
    for key in [
        "aggregated_output",
        "aggregatedOutput",
        "output",
        "stdout",
        "stderr",
    ] {
        if let Some(value) = item.get(key).filter(|value| !value.is_null()) {
            for line in compact_text_lines(value) {
                if seen.insert(line.clone()) {
                    output.push(line);
                }
            }
        }
    }
    let limit = if status == OperationStatus::Failed {
        8
    } else {
        2
    };
    let omitted = output.len().saturating_sub(limit);
    let mut body = output
        .into_iter()
        .take(limit)
        .map(|text| OperationLine {
            text,
            tone: if status == OperationStatus::Failed {
                OperationTone::Failed
            } else {
                OperationTone::Muted
            },
        })
        .collect::<Vec<_>>();
    if omitted > 0 {
        body.push(OperationLine {
            text: format!("… {omitted} output line{} hidden", plural(omitted)),
            tone: OperationTone::Muted,
        });
    }
    if status == OperationStatus::Failed
        && let Some(exit) = item
            .get("exit_code")
            .or_else(|| item.get("exitCode"))
            .and_then(Value::as_i64)
    {
        body.push(OperationLine {
            text: format!("exit code {exit}"),
            tone: OperationTone::Failed,
        });
    }
    OperationBlock {
        kind: OperationKind::Command,
        invocation,
        body,
        status,
    }
}

fn mcp_operation(item: &Value, phase: ItemPhase) -> OperationBlock {
    let tool = item
        .get("tool")
        .or_else(|| item.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let server = item.get("server").and_then(Value::as_str);
    let invocation = server.map_or_else(
        || humanize(tool),
        |server| format!("{} · {}", humanize(server), humanize(tool)),
    );
    let status = operation_status(item, phase);
    // Codex history cells keep successful tool calls compact. Arguments and
    // complete result payloads remain in the durable transcript, but the chat
    // only expands actionable failure text.
    let body = if status == OperationStatus::Failed {
        item.get("error")
            .or_else(|| item.get("output"))
            .into_iter()
            .flat_map(compact_text_lines)
            .take(8)
            .map(|text| OperationLine {
                text,
                tone: OperationTone::Failed,
            })
            .collect()
    } else {
        Vec::new()
    };
    OperationBlock {
        kind: OperationKind::Mcp,
        invocation,
        body,
        status,
    }
}

fn file_change_operation(item: &Value, phase: ItemPhase) -> OperationBlock {
    let mut body = Vec::new();
    if let Some(changes) = item.get("changes").and_then(Value::as_array) {
        for change in changes {
            append_file_change_summary(change, &mut body);
            if let Some(diff) = change.get("diff").and_then(Value::as_str) {
                append_diff_lines(diff, &mut body);
            }
        }
    }
    if let Some(files) = item.get("files").and_then(Value::as_array) {
        for file in files {
            if let Some(path) = file.as_str() {
                body.push(OperationLine {
                    text: path.to_owned(),
                    tone: OperationTone::Header,
                });
            } else {
                append_file_change_summary(file, &mut body);
            }
        }
    }
    if let Some(diff) = item.get("diff").and_then(Value::as_str) {
        append_diff_lines(diff, &mut body);
    }
    body.dedup();
    let invocation = item
        .get("path")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            let count = item
                .get("changes")
                .or_else(|| item.get("files"))
                .and_then(Value::as_array)
                .map(Vec::len)?;
            Some(format!("{count} file{}", plural(count)))
        })
        .unwrap_or_else(|| "project files".to_owned());
    OperationBlock {
        kind: OperationKind::FileChange,
        invocation,
        body,
        status: operation_status(item, phase),
    }
}

fn search_operation(item: &Value, phase: ItemPhase) -> OperationBlock {
    let invocation = item
        .get("query")
        .or_else(|| item.get("text"))
        .map(full_value_text)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "web".to_owned());
    OperationBlock {
        kind: OperationKind::Search,
        invocation,
        body: Vec::new(),
        status: operation_status(item, phase),
    }
}

fn plan_operation(item: &Value, phase: ItemPhase) -> OperationBlock {
    let invocation = item
        .get("explanation")
        .and_then(Value::as_str)
        .map(sanitize_terminal_text)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "work plan".to_owned());
    let mut body = Vec::new();
    for key in ["plan", "items", "steps"] {
        if let Some(value) = item.get(key).filter(|value| !value.is_null()) {
            append_plan_items(value, &mut body);
            if !body.is_empty() {
                break;
            }
        }
    }
    OperationBlock {
        kind: OperationKind::Plan,
        invocation,
        body,
        status: operation_status(item, phase),
    }
}

fn other_operation(item: &Value, phase: ItemPhase, item_type: &str) -> OperationBlock {
    OperationBlock {
        kind: OperationKind::Other(humanize(item_type)),
        invocation: extract_item_text(item).unwrap_or_else(|| humanize(item_type)),
        body: Vec::new(),
        status: operation_status(item, phase),
    }
}

fn compact_text_lines(value: &Value) -> Vec<String> {
    match value {
        Value::Null => Vec::new(),
        Value::String(text) => sanitize_terminal_text(text)
            .lines()
            .map(str::trim_end)
            .filter(|line| !line.trim().is_empty())
            .map(ToOwned::to_owned)
            .collect(),
        Value::Array(values) => values.iter().flat_map(compact_text_lines).collect(),
        Value::Object(object) => ["message", "text", "content", "output", "error"]
            .iter()
            .find_map(|key| object.get(*key).map(compact_text_lines))
            .unwrap_or_default(),
        _ => vec![full_value_text(value)],
    }
}

fn append_file_change_summary(change: &Value, output: &mut Vec<OperationLine>) {
    let Some(object) = change.as_object() else {
        if let Some(path) = change.as_str() {
            output.push(OperationLine {
                text: path.to_owned(),
                tone: OperationTone::Header,
            });
        }
        return;
    };
    let path = ["path", "file", "filename"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .unwrap_or("project file");
    let kind = ["kind", "change", "status", "type"]
        .iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .unwrap_or("modified");
    let (marker, tone) = match kind {
        "add" | "added" | "create" | "created" => ("+", OperationTone::Added),
        "delete" | "deleted" | "remove" | "removed" => ("−", OperationTone::Deleted),
        _ => ("~", OperationTone::Modified),
    };
    output.push(OperationLine {
        text: format!("{marker} {path}"),
        tone,
    });
}

fn append_diff_lines(diff: &str, output: &mut Vec<OperationLine>) {
    for source in sanitize_terminal_text(diff).lines() {
        let tone = if source.starts_with('+') && !source.starts_with("+++") {
            OperationTone::Added
        } else if source.starts_with('-') && !source.starts_with("---") {
            OperationTone::Deleted
        } else if source.starts_with("@@")
            || source.starts_with("diff ")
            || source.starts_with("---")
            || source.starts_with("+++")
        {
            OperationTone::Header
        } else {
            OperationTone::Muted
        };
        output.push(OperationLine {
            text: source.to_owned(),
            tone,
        });
    }
}

fn append_plan_items(value: &Value, output: &mut Vec<OperationLine>) {
    match value {
        Value::Array(items) => {
            for item in items {
                append_plan_items(item, output);
            }
        }
        Value::Object(object) => {
            if let Some(nested) = ["plan", "items", "steps"]
                .iter()
                .find_map(|key| object.get(*key))
            {
                append_plan_items(nested, output);
                return;
            }
            let label = ["step", "text", "title", "description", "content"]
                .iter()
                .find_map(|key| object.get(*key).and_then(Value::as_str))
                .map(sanitize_terminal_text);
            let Some(label) = label.filter(|label| !label.trim().is_empty()) else {
                return;
            };
            let status = object
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");
            let (marker, tone) = match status {
                "completed" | "complete" | "done" | "succeeded" => ("✓", OperationTone::PlanDone),
                "in_progress" | "in-progress" | "inProgress" | "active" | "running" => {
                    ("◉", OperationTone::PlanActive)
                }
                "failed" | "blocked" | "error" => ("!", OperationTone::Failed),
                _ => ("○", OperationTone::PlanPending),
            };
            output.push(OperationLine {
                text: format!("{marker} {label}"),
                tone,
            });
        }
        Value::String(label) if !label.trim().is_empty() => output.push(OperationLine {
            text: format!("○ {}", sanitize_terminal_text(label)),
            tone: OperationTone::PlanPending,
        }),
        _ => {}
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

fn extract_item_text(item: &Value) -> Option<String> {
    for key in ["text", "message", "content", "summary"] {
        if let Some(value) = item.get(key) {
            let text = extract_text(value);
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn extract_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => sanitize_terminal_text(text),
        Value::Array(values) => values
            .iter()
            .map(extract_text)
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => {
            for key in [
                "text",
                "thinking",
                "reasoning",
                "content",
                "message",
                "summary",
            ] {
                if let Some(value) = object.get(key) {
                    let text = extract_text(value);
                    if !text.trim().is_empty() {
                        return text;
                    }
                }
            }
            full_value_text(value)
        }
        _ => full_value_text(value),
    }
}

fn command_value_text(value: &Value) -> String {
    match value {
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                part.as_str()
                    .map_or_else(|| full_value_text(part), sanitize_terminal_text)
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => full_value_text(value),
    }
}

fn full_value_text(value: &Value) -> String {
    match value {
        Value::String(text) => sanitize_terminal_text(text),
        _ => serde_json::to_string_pretty(value)
            .map(|text| sanitize_terminal_text(&text))
            .unwrap_or_else(|_| "<unrenderable value>".to_owned()),
    }
}

pub(crate) fn sanitize_terminal_text(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' && chars.next_if_eq(&'[').is_some() {
            for candidate in chars.by_ref() {
                if ('@'..='~').contains(&candidate) {
                    break;
                }
            }
        } else if matches!(character, '\n' | '\t') || !character.is_control() {
            sanitized.push(character);
        }
    }
    sanitized
}

fn humanize(value: &str) -> String {
    let mut output = value.replace(['_', '-', '.'], " ");
    if let Some(first) = output.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    output
}

fn render_document(document: &AgentChatDocument, width: u16) -> Vec<Line<'static>> {
    let width = usize::from(width.max(1));
    let mut lines = Vec::new();
    for block in &document.blocks {
        match block {
            AgentChatBlock::User(message) => render_user_message(message, width, &mut lines),
            AgentChatBlock::Assistant(message) => {
                let rendered = render_markdown(message, width.saturating_sub(2).max(1));
                append_prefixed_block(
                    &mut lines,
                    rendered,
                    Span::styled("• ", Style::default().fg(Color::DarkGray)),
                    "  ",
                    None,
                );
                lines.push(Line::raw(""));
            }
            AgentChatBlock::Reasoning(message) => {
                let mut rendered = render_markdown(message, width.saturating_sub(2).max(1));
                let reasoning = Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::ITALIC | Modifier::DIM);
                patch_lines(&mut rendered, reasoning);
                append_prefixed_block(
                    &mut lines,
                    rendered,
                    Span::styled("• ", reasoning),
                    "  ",
                    None,
                );
            }
            AgentChatBlock::Operation(operation) => render_operation(operation, width, &mut lines),
            AgentChatBlock::Error(message) => {
                let rendered = wrap_plain_lines(
                    message,
                    width.saturating_sub(2).max(1),
                    Style::default().fg(Color::LightRed),
                );
                append_prefixed_block(
                    &mut lines,
                    rendered,
                    Span::styled("! ", Style::default().fg(Color::LightRed)),
                    "  ",
                    None,
                );
            }
            AgentChatBlock::Usage { input, output } => lines.push(Line::styled(
                format!(
                    "  {} in · {} out",
                    compact_token_count(*input),
                    compact_token_count(*output)
                ),
                Style::default().fg(Color::DarkGray),
            )),
            AgentChatBlock::Notice {
                title,
                body,
                warning,
            } => render_notice(title, body.as_deref(), *warning, width, &mut lines),
        }
    }
    while line_is_blank(lines.last()) {
        lines.pop();
    }
    lines
}

fn render_user_message(message: &str, width: usize, output: &mut Vec<Line<'static>>) {
    let background = Style::default().bg(Color::Rgb(42, 43, 47));
    output.push(padded_line(Line::raw(""), width, background));
    let rendered = wrap_plain_lines(
        message.trim_end_matches(['\r', '\n']),
        width.saturating_sub(2).max(1),
        background,
    );
    append_prefixed_block(
        output,
        rendered,
        Span::styled(
            "› ",
            background.add_modifier(Modifier::BOLD | Modifier::DIM),
        ),
        "  ",
        Some((width, background)),
    );
    output.push(padded_line(Line::raw(""), width, background));
}

fn render_operation(operation: &OperationBlock, width: usize, output: &mut Vec<Line<'static>>) {
    let (bullet, bullet_color) = match operation.status {
        OperationStatus::Running => ("◌", Color::Cyan),
        OperationStatus::Succeeded => ("•", Color::LightGreen),
        OperationStatus::Failed => ("•", Color::LightRed),
        OperationStatus::Skipped => ("○", Color::DarkGray),
    };
    let label = operation_label(&operation.kind, operation.status);
    let header = Line::from(vec![
        Span::styled(format!("{bullet} "), Style::default().fg(bullet_color)),
        Span::styled(label, Style::default().add_modifier(Modifier::BOLD)),
        Span::raw(" "),
        Span::styled(
            operation.invocation.clone(),
            Style::default().fg(Color::Cyan),
        ),
    ]);
    output.extend(wrap_styled_line(&header, width.max(1)));
    let body_width = width.saturating_sub(4).max(1);
    let mut first = true;
    for body_line in &operation.body {
        let rendered = wrap_plain_lines(
            &body_line.text,
            body_width,
            operation_tone_style(body_line.tone),
        );
        for line in rendered {
            let prefix = if first { "  └ " } else { "    " };
            let mut spans = vec![Span::styled(prefix, Style::default().fg(Color::DarkGray))];
            spans.extend(line.spans);
            output.push(Line::from(spans));
            first = false;
        }
    }
}

fn operation_tone_style(tone: OperationTone) -> Style {
    match tone {
        OperationTone::Muted => Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::DIM),
        OperationTone::Added | OperationTone::PlanDone => Style::default().fg(Color::LightGreen),
        OperationTone::Modified => Style::default().fg(Color::Yellow),
        OperationTone::Deleted | OperationTone::Failed => Style::default().fg(Color::LightRed),
        OperationTone::Header => Style::default().fg(Color::LightBlue),
        OperationTone::PlanPending => Style::default().fg(Color::DarkGray),
        OperationTone::PlanActive => Style::default().fg(Color::Cyan),
    }
}

fn operation_label(kind: &OperationKind, status: OperationStatus) -> String {
    if status == OperationStatus::Skipped {
        return "Skipped".to_owned();
    }
    let label = match (kind, status) {
        (OperationKind::Command, OperationStatus::Running) => "Running",
        (OperationKind::Command, OperationStatus::Succeeded) => "Ran",
        (OperationKind::Command, OperationStatus::Failed) => "Command failed",
        (OperationKind::Mcp, OperationStatus::Running) => "Calling",
        (OperationKind::Mcp, OperationStatus::Succeeded) => "Called",
        (OperationKind::Mcp, OperationStatus::Failed) => "Call failed",
        (OperationKind::FileChange, OperationStatus::Running) => "Editing",
        (OperationKind::FileChange, OperationStatus::Succeeded) => "Edited",
        (OperationKind::FileChange, OperationStatus::Failed) => "Edit failed",
        (OperationKind::Search, OperationStatus::Running) => "Searching",
        (OperationKind::Search, OperationStatus::Succeeded) => "Searched",
        (OperationKind::Search, OperationStatus::Failed) => "Search failed",
        (OperationKind::Plan, OperationStatus::Running) => "Updating plan",
        (OperationKind::Plan, OperationStatus::Succeeded) => "Updated plan",
        (OperationKind::Plan, OperationStatus::Failed) => "Plan update failed",
        (OperationKind::Other(label), OperationStatus::Running) => {
            return format!("Running {label}");
        }
        (OperationKind::Other(label), OperationStatus::Succeeded) => return label.clone(),
        (OperationKind::Other(label), OperationStatus::Failed) => return format!("{label} failed"),
        (_, OperationStatus::Skipped) => unreachable!("skipped operations return above"),
    };
    label.to_owned()
}

fn render_notice(
    title: &str,
    body: Option<&str>,
    warning: bool,
    width: usize,
    output: &mut Vec<Line<'static>>,
) {
    let color = if warning {
        Color::Yellow
    } else {
        Color::DarkGray
    };
    let rendered = wrap_plain_lines(
        title,
        width.saturating_sub(2).max(1),
        Style::default().fg(color),
    );
    append_prefixed_block(
        output,
        rendered,
        Span::styled(
            if warning { "! " } else { "• " },
            Style::default().fg(color),
        ),
        "  ",
        None,
    );
    if let Some(body) = body {
        for line in wrap_plain_lines(
            body,
            width.saturating_sub(4).max(1),
            Style::default().fg(Color::DarkGray),
        ) {
            let mut spans = vec![Span::styled("  └ ", Style::default().fg(Color::DarkGray))];
            spans.extend(line.spans);
            output.push(Line::from(spans));
        }
    }
}

fn append_prefixed_block(
    output: &mut Vec<Line<'static>>,
    lines: Vec<Line<'static>>,
    first_prefix: Span<'static>,
    continuation_prefix: &'static str,
    fill: Option<(usize, Style)>,
) {
    let mut first = true;
    for line in lines {
        let prefix = if first {
            first_prefix.clone()
        } else {
            Span::raw(continuation_prefix)
        };
        let mut spans = vec![prefix];
        spans.extend(line.spans);
        let line = Line::from(spans);
        output.push(fill.map_or(line.clone(), |(width, style)| {
            padded_line(line, width, style)
        }));
        first = false;
    }
}

fn patch_lines(lines: &mut [Line<'static>], style: Style) {
    for line in lines {
        for span in &mut line.spans {
            span.style = span.style.patch(style);
        }
    }
}

fn padded_line(mut line: Line<'static>, width: usize, style: Style) -> Line<'static> {
    for span in &mut line.spans {
        span.style = span.style.patch(style);
    }
    let used = line
        .spans
        .iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum::<usize>();
    if used < width {
        line.spans
            .push(Span::styled(" ".repeat(width - used), style));
    }
    line
}

fn compact_token_count(value: u64) -> String {
    if value >= 1_000_000 {
        format!("{:.1}M tks", value as f64 / 1_000_000.0)
    } else if value >= 1_000 {
        format!("{:.1}K tks", value as f64 / 1_000.0)
    } else {
        format!("{value} tks")
    }
}

#[derive(Debug)]
struct MarkdownWriter {
    rows: Vec<MarkdownRow>,
    current: Vec<Span<'static>>,
    style: Style,
    style_stack: Vec<Style>,
    lists: Vec<Option<u64>>,
    item_indents: Vec<usize>,
    item_has_content: Vec<bool>,
    quote_depth: usize,
    code: Option<CodeBuffer>,
    width: usize,
    preserve_soft_breaks: bool,
}

#[derive(Debug)]
struct MarkdownRow {
    line: Line<'static>,
    wrap: bool,
    hanging_indent: usize,
}

#[derive(Debug)]
struct CodeBuffer {
    language: Option<String>,
    text: String,
}

pub(crate) fn render_markdown(source: &str, width: usize) -> Vec<Line<'static>> {
    render_markdown_with_soft_breaks(source, width, false)
}

pub(crate) fn render_markdown_preserving_lines(source: &str, width: usize) -> Vec<Line<'static>> {
    render_markdown_with_soft_breaks(source, width, true)
}

fn render_markdown_with_soft_breaks(
    source: &str,
    width: usize,
    preserve_soft_breaks: bool,
) -> Vec<Line<'static>> {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let source = normalize_markdown_list_markers(source);
    let mut writer = MarkdownWriter::new(width.max(1), preserve_soft_breaks);
    for event in Parser::new_ext(&source, options) {
        writer.event(event);
    }
    writer.finish()
}

/// Planner output sometimes uses typographic bullets even though the rest of
/// the document is Markdown. Treat those markers as list syntax outside fenced
/// code so every TUI Markdown surface gets the same nesting and wrapping.
fn normalize_markdown_list_markers(source: &str) -> String {
    let mut normalized = String::with_capacity(source.len());
    let mut fence = None::<char>;
    for segment in source.split_inclusive('\n') {
        let (line, newline) = segment
            .strip_suffix('\n')
            .map_or((segment, ""), |line| (line, "\n"));
        let content = line.trim_start_matches([' ', '\t']);
        let fence_marker = content
            .chars()
            .next()
            .filter(|marker| matches!(marker, '`' | '~'))
            .filter(|marker| content.chars().take_while(|char| char == marker).count() >= 3);
        if let Some(marker) = fence_marker {
            match fence {
                Some(open) if open == marker => fence = None,
                None => fence = Some(marker),
                _ => {}
            }
            normalized.push_str(line);
        } else if fence.is_none() {
            let indentation = &line[..line.len().saturating_sub(content.len())];
            let mut chars = content.chars();
            let marker = chars.next();
            let remainder = chars.as_str();
            if matches!(marker, Some('•' | '●' | '◦' | '‣')) && remainder.starts_with([' ', '\t'])
            {
                normalized.push_str(indentation);
                normalized.push_str("- ");
                normalized.push_str(remainder.trim_start_matches([' ', '\t']));
            } else {
                normalized.push_str(line);
            }
        } else {
            normalized.push_str(line);
        }
        normalized.push_str(newline);
    }
    normalized
}

impl MarkdownWriter {
    fn new(width: usize, preserve_soft_breaks: bool) -> Self {
        Self {
            rows: Vec::new(),
            current: Vec::new(),
            style: Style::default(),
            style_stack: Vec::new(),
            lists: Vec::new(),
            item_indents: Vec::new(),
            item_has_content: Vec::new(),
            quote_depth: 0,
            code: None,
            width,
            preserve_soft_breaks,
        }
    }

    fn event(&mut self, event: Event<'_>) {
        if let Some(code) = self.code.as_mut() {
            match event {
                Event::End(TagEnd::CodeBlock) => {
                    let code = self.code.take().expect("code block exists");
                    self.push_code(code);
                    self.push_blank_line();
                }
                Event::Text(text) | Event::Code(text) => code.text.push_str(&text),
                Event::SoftBreak | Event::HardBreak => code.text.push('\n'),
                _ => {}
            }
            return;
        }

        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => self.push_text(&text),
            Event::Code(code) => self.push_span(code.into_string(), self.style.fg(Color::Cyan)),
            Event::SoftBreak => {
                self.finish_line(self.preserve_soft_breaks);
                self.push_blank_line();
            }
            Event::HardBreak => {
                self.finish_line(true);
                self.push_blank_line();
            }
            Event::Rule => {
                self.finish_line(false);
                self.rows.push(MarkdownRow {
                    line: Line::styled(
                        "─".repeat(self.width.min(48)),
                        Style::default().fg(Color::DarkGray),
                    ),
                    wrap: false,
                    hanging_indent: 0,
                });
            }
            Event::TaskListMarker(checked) => {
                let marker = if checked { "☑ " } else { "☐ " };
                if let Some(indent) = self.item_indents.last_mut() {
                    *indent = indent.saturating_add(UnicodeWidthStr::width(marker));
                }
                self.push_span(marker.to_owned(), Style::default().fg(Color::DarkGray));
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                self.push_span(html.into_string(), self.style.fg(Color::DarkGray))
            }
            Event::FootnoteReference(reference) => self.push_span(
                format!("[{}]", reference.into_string()),
                self.style.fg(Color::Cyan),
            ),
            Event::InlineMath(math) | Event::DisplayMath(math) => {
                self.push_span(math.into_string(), self.style.fg(Color::LightBlue))
            }
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => {
                if !self.current.is_empty() {
                    self.finish_line(false);
                }
            }
            Tag::Heading { .. } => {
                self.finish_line(false);
                self.push_style(self.style.fg(Color::Cyan).add_modifier(Modifier::BOLD));
            }
            Tag::BlockQuote(_) => self.quote_depth += 1,
            Tag::CodeBlock(kind) => {
                self.finish_line(false);
                let language = match kind {
                    CodeBlockKind::Indented => None,
                    CodeBlockKind::Fenced(info) => info
                        .split([',', ' ', '\t'])
                        .next()
                        .filter(|value| !value.is_empty())
                        .map(ToOwned::to_owned),
                };
                self.code = Some(CodeBuffer {
                    language,
                    text: String::new(),
                });
            }
            Tag::List(start) => self.lists.push(start),
            Tag::Item => {
                self.finish_line(false);
                let indent = "  ".repeat(self.lists.len());
                let marker = if let Some(counter) = self.lists.last_mut().and_then(Option::as_mut) {
                    let marker = format!("{counter}. ");
                    *counter = counter.saturating_add(1);
                    marker
                } else {
                    "• ".to_owned()
                };
                self.item_indents
                    .push(UnicodeWidthStr::width(format!("{indent}{marker}").as_str()));
                self.item_has_content.push(false);
                self.push_span(
                    format!("{indent}{marker}"),
                    Style::default().fg(Color::DarkGray),
                );
            }
            Tag::Emphasis => self.push_style(self.style.add_modifier(Modifier::ITALIC)),
            Tag::Strong => self.push_style(self.style.add_modifier(Modifier::BOLD)),
            Tag::Strikethrough => self.push_style(self.style.add_modifier(Modifier::CROSSED_OUT)),
            Tag::Link { .. } | Tag::Image { .. } => self.push_style(
                self.style
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::UNDERLINED),
            ),
            Tag::Table(_) => self.finish_line(false),
            Tag::TableHead | Tag::TableRow => self.finish_line(false),
            Tag::TableCell if !self.current.is_empty() => {
                self.push_span(" │ ".to_owned(), Style::default().fg(Color::DarkGray));
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => {
                self.finish_line(false);
                self.push_blank_line();
            }
            TagEnd::Heading(_) => {
                self.pop_style();
                self.finish_line(false);
                self.push_blank_line();
            }
            TagEnd::BlockQuote(_) => {
                self.finish_line(false);
                self.quote_depth = self.quote_depth.saturating_sub(1);
                self.push_blank_line();
            }
            TagEnd::List(_) => {
                self.finish_line(false);
                self.lists.pop();
            }
            TagEnd::Item => {
                self.finish_line(false);
                self.item_indents.pop();
                self.item_has_content.pop();
                self.push_blank_line();
            }
            TagEnd::Emphasis
            | TagEnd::Strong
            | TagEnd::Strikethrough
            | TagEnd::Link
            | TagEnd::Image => {
                self.pop_style();
            }
            TagEnd::TableHead => {
                self.finish_line(false);
                self.rows.push(MarkdownRow {
                    line: Line::styled(
                        "─".repeat(self.width.min(48)),
                        Style::default().fg(Color::DarkGray),
                    ),
                    wrap: false,
                    hanging_indent: 0,
                });
            }
            TagEnd::TableRow => self.finish_line(false),
            TagEnd::Table => {
                self.finish_line(false);
                self.push_blank_line();
            }
            TagEnd::TableCell | TagEnd::CodeBlock => {}
            _ => {}
        }
    }

    fn push_style(&mut self, style: Style) {
        self.style_stack.push(self.style);
        self.style = style;
    }

    fn pop_style(&mut self) {
        if let Some(style) = self.style_stack.pop() {
            self.style = style;
        }
    }

    fn push_text(&mut self, text: &str) {
        let mut parts = text.split('\n').peekable();
        while let Some(part) = parts.next() {
            if !part.is_empty() {
                self.push_semantic_text(part);
            }
            if parts.peek().is_some() {
                self.finish_line(true);
            }
        }
    }

    fn push_semantic_text(&mut self, text: &str) {
        for segment in text.split_inclusive(char::is_whitespace) {
            let token_end = segment.trim_end_matches(char::is_whitespace).len();
            let (token, whitespace) = segment.split_at(token_end);
            let leading = token
                .find(|character: char| !matches!(character, '(' | '[' | '{' | '<' | '"' | '\''))
                .unwrap_or(token.len());
            let trailing = token
                .trim_end_matches(|character: char| {
                    matches!(
                        character,
                        ')' | ']' | '}' | '>' | '"' | '\'' | ',' | ';' | '!' | '?' | '.'
                    )
                })
                .len()
                .max(leading);
            let (prefix, remainder) = token.split_at(leading);
            let (candidate, suffix) = remainder.split_at(trailing.saturating_sub(leading));
            if !prefix.is_empty() {
                self.push_span(prefix.to_owned(), self.style);
            }
            if !candidate.is_empty() {
                let style = if looks_like_filename(candidate) && self.style.fg.is_none() {
                    self.style.fg(Color::LightBlue)
                } else {
                    self.style
                };
                self.push_span(candidate.to_owned(), style);
            }
            if !suffix.is_empty() {
                self.push_span(suffix.to_owned(), self.style);
            }
            if !whitespace.is_empty() {
                self.push_span(whitespace.to_owned(), self.style);
            }
        }
    }

    fn push_span(&mut self, text: String, style: Style) {
        if self.current.is_empty()
            && self.item_has_content.last().copied().unwrap_or(false)
            && let Some(indent) = self.item_indents.last().copied()
        {
            self.current.push(Span::raw(" ".repeat(indent)));
        }
        if self.current.is_empty() && self.quote_depth > 0 {
            self.current.push(Span::styled(
                "│ ".repeat(self.quote_depth),
                Style::default().fg(Color::DarkGray),
            ));
        }
        self.current.push(Span::styled(text, style));
    }

    fn finish_line(&mut self, force: bool) {
        if self.current.is_empty() && !force {
            return;
        }
        self.rows.push(MarkdownRow {
            line: Line::from(std::mem::take(&mut self.current)),
            wrap: true,
            hanging_indent: self.item_indents.last().copied().unwrap_or(0),
        });
        if let Some(has_content) = self.item_has_content.last_mut() {
            *has_content = true;
        }
    }

    fn push_blank_line(&mut self) {
        if self
            .rows
            .last()
            .is_some_and(|row| !row.line.spans.is_empty())
        {
            self.rows.push(MarkdownRow {
                line: Line::raw(""),
                wrap: false,
                hanging_indent: 0,
            });
        }
    }

    fn push_code(&mut self, code: CodeBuffer) {
        if let Some(language) = &code.language {
            self.rows.push(MarkdownRow {
                line: Line::styled(language.clone(), Style::default().fg(Color::DarkGray)),
                wrap: false,
                hanging_indent: 0,
            });
        }
        for line in highlighted_code_lines(&code.text, code.language.as_deref(), self.width) {
            self.rows.push(MarkdownRow {
                line,
                wrap: false,
                hanging_indent: 0,
            });
        }
    }

    fn finish(mut self) -> Vec<Line<'static>> {
        self.finish_line(false);
        let mut lines = Vec::new();
        for row in self.rows {
            if row.wrap {
                lines.extend(wrap_styled_line_with_hanging_indent(
                    &row.line,
                    self.width,
                    row.hanging_indent,
                ));
            } else {
                lines.push(row.line);
            }
        }
        while line_is_blank(lines.first()) {
            lines.remove(0);
        }
        while line_is_blank(lines.last()) {
            lines.pop();
        }
        if lines.is_empty() {
            lines.push(Line::raw(""));
        }
        lines
    }
}

fn looks_like_filename(candidate: &str) -> bool {
    if candidate.contains("://") || candidate.is_empty() {
        return false;
    }
    let mut without_location = candidate;
    for _ in 0..2 {
        let Some((path, location)) = without_location.rsplit_once(':') else {
            break;
        };
        if location.is_empty() || !location.chars().all(|char| char.is_ascii_digit()) {
            break;
        }
        without_location = path;
    }
    let name = without_location
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(without_location);
    if matches!(
        name,
        "Cargo.toml"
            | "Cargo.lock"
            | "Dockerfile"
            | "Gemfile"
            | "Justfile"
            | "Makefile"
            | "Procfile"
            | "README"
            | "LICENSE"
            | ".editorconfig"
            | ".env"
            | ".gitignore"
            | ".npmrc"
            | ".prettierrc"
    ) {
        return true;
    }
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    if stem.is_empty() || extension.is_empty() {
        return false;
    }
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "c" | "cc"
            | "cpp"
            | "cs"
            | "css"
            | "csv"
            | "dart"
            | "go"
            | "graphql"
            | "h"
            | "hpp"
            | "html"
            | "java"
            | "js"
            | "json"
            | "jsx"
            | "kt"
            | "kts"
            | "lock"
            | "lua"
            | "md"
            | "mdx"
            | "mjs"
            | "php"
            | "proto"
            | "py"
            | "r"
            | "rb"
            | "rs"
            | "scss"
            | "sh"
            | "sql"
            | "swift"
            | "toml"
            | "ts"
            | "tsx"
            | "txt"
            | "vue"
            | "xml"
            | "yaml"
            | "yml"
            | "zig"
    )
}

fn syntax_set() -> &'static SyntaxSet {
    static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();
    SYNTAXES.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn syntax_theme() -> &'static Theme {
    static THEMES: OnceLock<ThemeSet> = OnceLock::new();
    let themes = THEMES.get_or_init(ThemeSet::load_defaults);
    themes
        .themes
        .get("base16-ocean.dark")
        .or_else(|| themes.themes.values().next())
        .expect("syntect ships at least one default theme")
}

fn highlighted_code_lines(code: &str, language: Option<&str>, width: usize) -> Vec<Line<'static>> {
    let syntax_set = syntax_set();
    let syntax = language
        .and_then(|language| syntax_set.find_syntax_by_token(language))
        .unwrap_or_else(|| syntax_set.find_syntax_plain_text());
    let mut highlighter = HighlightLines::new(syntax, syntax_theme());
    let code_background = Color::Rgb(30, 31, 35);
    let mut output = Vec::new();
    for source in code.split_inclusive('\n') {
        let source = source.trim_end_matches(['\r', '\n']);
        let spans = highlighter
            .highlight_line(source, syntax_set)
            .map(|ranges| {
                ranges
                    .into_iter()
                    .map(|(style, value)| {
                        let mut ratatui = Style::default()
                            .fg(Color::Rgb(
                                style.foreground.r,
                                style.foreground.g,
                                style.foreground.b,
                            ))
                            .bg(code_background);
                        if style.font_style.contains(FontStyle::BOLD) {
                            ratatui = ratatui.add_modifier(Modifier::BOLD);
                        }
                        if style.font_style.contains(FontStyle::ITALIC) {
                            ratatui = ratatui.add_modifier(Modifier::ITALIC);
                        }
                        if style.font_style.contains(FontStyle::UNDERLINE) {
                            ratatui = ratatui.add_modifier(Modifier::UNDERLINED);
                        }
                        Span::styled(value.to_owned(), ratatui)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|_| {
                vec![Span::styled(
                    source.to_owned(),
                    Style::default().fg(Color::LightBlue).bg(code_background),
                )]
            });
        output.push(padded_line(
            Line::from(spans),
            width,
            Style::default().bg(code_background),
        ));
    }
    if output.is_empty() {
        output.push(padded_line(
            Line::raw(""),
            width,
            Style::default().bg(code_background),
        ));
    }
    output
}

fn wrap_plain_lines(text: &str, width: usize, style: Style) -> Vec<Line<'static>> {
    let mut output = Vec::new();
    for source in text.split('\n') {
        output.extend(wrap_styled_line(
            &Line::from(Span::styled(source.to_owned(), style)),
            width.max(1),
        ));
    }
    if output.is_empty() {
        output.push(Line::raw(""));
    }
    output
}

#[derive(Debug, Clone)]
struct StyledGlyph {
    character: char,
    width: usize,
    whitespace: bool,
    style: Style,
}

fn wrap_styled_line(line: &Line<'static>, width: usize) -> Vec<Line<'static>> {
    wrap_styled_line_with_hanging_indent(line, width, 0)
}

fn wrap_styled_line_with_hanging_indent(
    line: &Line<'static>,
    width: usize,
    hanging_indent: usize,
) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut glyphs = line
        .spans
        .iter()
        .flat_map(|span| {
            span.content
                .chars()
                .map(|character| StyledGlyph {
                    character,
                    width: UnicodeWidthChar::width(character).unwrap_or(0),
                    whitespace: character.is_whitespace(),
                    style: span.style,
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    if glyphs.is_empty() {
        return vec![Line::raw("")];
    }
    let mut output = Vec::new();
    while !glyphs.is_empty() {
        let continuation_indent = if output.is_empty() {
            0
        } else {
            hanging_indent.min(width.saturating_sub(1))
        };
        let available = width.saturating_sub(continuation_indent).max(1);
        let mut used = 0usize;
        let mut fit = 0usize;
        for glyph in &glyphs {
            if fit > 0 && used.saturating_add(glyph.width) > available {
                break;
            }
            used = used.saturating_add(glyph.width);
            fit += 1;
            if used >= available {
                break;
            }
        }
        fit = fit.max(1).min(glyphs.len());
        let take = if fit < glyphs.len() {
            glyphs[..fit]
                .iter()
                .enumerate()
                .rev()
                .find_map(|(index, glyph)| glyph.whitespace.then_some(index + 1))
                .filter(|index| *index > 0)
                .unwrap_or(fit)
        } else {
            fit
        };
        let mut row = glyphs.drain(..take).collect::<Vec<_>>();
        while row.last().is_some_and(|glyph| glyph.whitespace) {
            row.pop();
        }
        while glyphs.first().is_some_and(|glyph| glyph.whitespace) {
            glyphs.remove(0);
        }
        let mut line = line_from_glyphs(row);
        if continuation_indent > 0 {
            line.spans
                .insert(0, Span::raw(" ".repeat(continuation_indent)));
        }
        output.push(line);
    }
    output
}

fn line_from_glyphs(glyphs: Vec<StyledGlyph>) -> Line<'static> {
    let mut spans = Vec::<Span<'static>>::new();
    let mut buffer = String::new();
    let mut style = None;
    for glyph in glyphs {
        if style.is_some_and(|candidate| candidate != glyph.style) {
            spans.push(Span::styled(std::mem::take(&mut buffer), style.unwrap()));
        }
        style = Some(glyph.style);
        buffer.push(glyph.character);
    }
    if let Some(style) = style {
        spans.push(Span::styled(buffer, style));
    }
    Line::from(spans)
}

fn line_is_blank(line: Option<&Line<'static>>) -> bool {
    line.is_some_and(|line| line.spans.iter().all(|span| span.content.trim().is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered_text(lines: &[Line<'static>]) -> String {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn full_transcript_keeps_visible_payloads_and_selected_session_only() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join(".git/koni/agents/worker");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("prompt.md"), "Build **the index**.").unwrap();
        fs::write(
            state.join("stdout.jsonl"),
            concat!(
                "Reading additional input from stdin...\n",
                "{\"type\":\"thread.started\",\"thread_id\":\"old\"}\n",
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"old-message\",\"type\":\"agent_message\",\"text\":\"older hidden output\"}}\n",
                "old-session transport noise\n",
                "{\"type\":\"thread.started\",\"thread_id\":\"current\"}\n",
                "2026-07-14T07:31:52Z ERROR codex_models_manager::manager: failed to refresh available models: timeout\n",
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"reason\",\"type\":\"reasoning\",\"text\":\"Mapped dependencies\"}}\n",
                "{\"type\":\"item.started\",\"item\":{\"id\":\"cmd\",\"type\":\"command_execution\",\"command\":\"cargo test\",\"status\":\"in_progress\"}}\n",
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"cmd\",\"type\":\"command_execution\",\"command\":\"cargo test\",\"aggregated_output\":\"all green\",\"exit_code\":0,\"status\":\"completed\"}}\n",
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"tool\",\"type\":\"mcp_tool_call\",\"tool\":\"lookup_claim\",\"arguments\":{\"claim_id\":\"claim-secret\"},\"result\":{\"content\":[{\"text\":\"tool-secret\"}]},\"status\":\"completed\"}}\n",
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"message\",\"type\":\"agent_message\",\"text\":\"## Result\\n\\nDone with `index.rs`.\"}}\n",
                "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1200,\"output_tokens\":300}}\n"
            ),
        )
        .unwrap();
        let request = AgentChatRequest {
            key: "agent:worker".to_owned(),
            root: root.path().to_path_buf(),
            transcript_path: Some(state.join("stdout.jsonl")),
            prompt_path: Some(state.join("prompt.md")),
            output_path: None,
            codex_session_id: Some("current".to_owned()),
            guidance: vec!["Check the negative case.".to_owned()],
            live: false,
        };
        let mut cache = AgentChatCache::default();
        let rendered = cache.render(&request, 80);
        let text = rendered_text(&rendered.lines);

        for expected in [
            "Build **the index**.",
            "Check the negative case.",
            "Mapped dependencies",
            "Ran cargo test",
            "all green",
            "Result",
            "Done with index.rs.",
            "1.2K tks in · 300 tks out",
        ] {
            assert!(text.contains(expected), "missing {expected}:\n{text}");
        }
        assert!(!text.contains("older hidden output"), "{text}");
        assert!(!text.contains("transport noise"), "{text}");
        assert!(!text.contains("not displayable"), "{text}");
        assert!(!text.contains("models_manager"), "{text}");
        assert!(!text.contains("claim-secret"), "{text}");
        assert!(!text.contains("tool-secret"), "{text}");
        assert!(
            !text.contains("current"),
            "transport session id leaked: {text}"
        );
        assert!(!rendered.has_running_operation);
    }

    #[test]
    fn malformed_selected_session_transport_is_grouped_into_one_notice() {
        let mut blocks = Vec::new();
        parse_jsonl_transcript(
            concat!(
                "{\"type\":\"thread.started\",\"thread_id\":\"current\"}\n",
                "first unstructured line\n",
                "second unstructured line\n",
                "{\"type\":\"turn.completed\",\"usage\":{}}\n"
            ),
            Some("current"),
            &mut blocks,
        );
        let text = rendered_text(&render_document(&AgentChatDocument { blocks }, 60));

        assert_eq!(
            text.matches("Some transcript output was not displayable")
                .count(),
            1
        );
        assert!(
            text.contains("Ignored 2 unstructured transport lines"),
            "{text}"
        );
        assert!(!text.contains("JSONL line"), "{text}");
        assert!(!text.contains("first unstructured"), "{text}");
    }

    #[test]
    fn pi_turn_failure_renders_the_compiler_validated_action() {
        let mut blocks = Vec::new();
        parse_jsonl_transcript(
            concat!(
                "{\"type\":\"thread.started\",\"thread_id\":\"current\"}\n",
                "{\"type\":\"turn.failed\",\"runtime\":\"pi-sdk\",\"message\":\"OpenAI Codex is temporarily unavailable. Retry this turn.\",\"event\":{\"event\":\"runtime_error\",\"code\":\"provider_unavailable\",\"retryable\":true}}\n"
            ),
            Some("current"),
            &mut blocks,
        );
        let text = rendered_text(&render_document(&AgentChatDocument { blocks }, 80));
        assert!(
            text.contains("OpenAI Codex is temporarily unavailable. Retry this turn."),
            "{text}"
        );
        assert!(!text.contains("Agent turn failed"), "{text}");
    }

    #[test]
    fn rich_pi_transcript_renders_messages_tools_and_results_without_transport_noise() {
        let mut blocks = Vec::new();
        parse_jsonl_transcript(
            concat!(
                "{\"type\":\"thread.started\",\"thread_id\":\"pi-session\",\"runtime\":\"pi-sdk\"}\n",
                "{\"type\":\"pi.event\",\"runtime\":\"pi-sdk\",\"event\":{\"event\":\"message_completed\",\"turn_id\":\"turn-1\",\"message_id\":\"message-1\",\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"Mapped the dependency boundary.\"},{\"type\":\"text\",\"text\":\"I found the shared contract.\"},{\"type\":\"toolCall\",\"id\":\"call-1\",\"name\":\"read_project_file\",\"arguments\":{\"path\":\"src/contracts.ts\"}}]}}\n",
                "{\"type\":\"pi.event\",\"runtime\":\"pi-sdk\",\"event\":{\"event\":\"tool_started\",\"turn_id\":\"turn-1\",\"call_id\":\"call-1\",\"name\":\"read_project_file\"}}\n",
                "{\"type\":\"pi.event\",\"runtime\":\"pi-sdk\",\"event\":{\"event\":\"tool_completed\",\"turn_id\":\"turn-1\",\"call_id\":\"call-1\",\"outcome\":{\"status\":\"success\",\"value\":{\"content\":\"export const sections = [];\"}}}}\n",
                "{\"type\":\"pi.event\",\"runtime\":\"pi-sdk\",\"event\":{\"event\":\"message_completed\",\"turn_id\":\"turn-1\",\"message_id\":\"message-2\",\"role\":\"toolResult\",\"content\":[{\"type\":\"text\",\"text\":\"duplicate tool result\"}]}}\n",
                "{\"type\":\"pi.turn_usage\",\"runtime\":\"pi-sdk\",\"turn_id\":\"turn-1\",\"usage\":{\"total_tokens\":1250,\"output_tokens\":250}}\n"
            ),
            Some("pi-session"),
            &mut blocks,
        );
        let text = rendered_text(&render_document(&AgentChatDocument { blocks }, 100));

        for expected in [
            "Mapped the dependency boundary.",
            "I found the shared contract.",
            "Called Read project file",
            "src/contracts.ts",
            "export const sections = [];",
            "1.0K tks in · 250 tks out",
        ] {
            assert!(text.contains(expected), "missing {expected}:\n{text}");
        }
        assert!(!text.contains("Pi event"), "{text}");
        assert!(!text.contains("duplicate tool result"), "{text}");
        assert!(!text.contains("call-1"), "{text}");
    }

    #[test]
    fn legacy_direct_pi_envelope_renders_the_full_worker_conversation() {
        let mut blocks = Vec::new();
        parse_jsonl_transcript(
            concat!(
                "{\"runtime\":\"pi-sdk\",\"event\":{\"event\":\"message_completed\",\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"Inspecting the historical seam.\"},{\"type\":\"text\",\"text\":\"The complete worker answer is preserved.\"}]}}\n",
                "{\"runtime\":\"pi-sdk\",\"event\":{\"event\":\"usage\",\"usage\":{\"input_tokens\":900,\"output_tokens\":100}}}\n"
            ),
            None,
            &mut blocks,
        );
        let text = rendered_text(&render_document(&AgentChatDocument { blocks }, 80));

        assert!(text.contains("Inspecting the historical seam."), "{text}");
        assert!(
            text.contains("The complete worker answer is preserved."),
            "{text}"
        );
        assert!(!text.contains("Pi event"), "{text}");
        assert!(!text.contains("900 tks"), "{text}");
    }

    #[test]
    fn final_output_fills_legacy_compact_pi_transcript_without_duplication() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join(".git/koni/agents/planner");
        fs::create_dir_all(&state).unwrap();
        fs::write(
            state.join("stdout.jsonl"),
            concat!(
                "{\"type\":\"thread.started\",\"thread_id\":\"pi-session\"}\n",
                "{\"type\":\"pi.event\",\"runtime\":\"pi-sdk\",\"event\":{\"event\":\"message_completed\",\"role\":\"assistant\",\"content_hash\":\"sha256:old\",\"content_bytes\":42}}\n"
            ),
        )
        .unwrap();
        fs::write(
            state.join("last-message.md"),
            "## Final plan\n\nUse the shared contract.",
        )
        .unwrap();
        let request = AgentChatRequest {
            key: "agent:planner".to_owned(),
            root: root.path().to_path_buf(),
            transcript_path: Some(state.join("stdout.jsonl")),
            prompt_path: None,
            output_path: Some(state.join("last-message.md")),
            codex_session_id: Some("pi-session".to_owned()),
            guidance: Vec::new(),
            live: false,
        };
        let text = rendered_text(&AgentChatCache::default().render(&request, 80).lines);
        assert_eq!(text.matches("Final plan").count(), 1, "{text}");
        assert!(text.contains("Use the shared contract."), "{text}");
        assert!(!text.contains("Pi event"), "{text}");
        assert!(!text.contains("sha256:old"), "{text}");
    }

    #[test]
    fn pi_turn_boundary_marks_an_unexecuted_batched_tool_call_skipped() {
        let mut blocks = Vec::new();
        parse_jsonl_transcript(
            concat!(
                "{\"type\":\"thread.started\",\"thread_id\":\"pi-session\"}\n",
                "{\"type\":\"pi.event\",\"runtime\":\"pi-sdk\",\"event\":{\"event\":\"message_completed\",\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"not-run\",\"name\":\"read_project_file\",\"arguments\":{\"path\":\"later.ts\"}}]}}\n",
                "{\"type\":\"pi.turn_usage\",\"runtime\":\"pi-sdk\",\"turn_id\":\"turn-1\",\"usage\":{\"total_tokens\":10,\"output_tokens\":2}}\n"
            ),
            Some("pi-session"),
            &mut blocks,
        );
        let document = AgentChatDocument { blocks };
        let text = rendered_text(&render_document(&document, 80));
        assert!(text.contains("Skipped Read project file"), "{text}");
        assert!(
            text.contains("Not executed after the compiler closed this tool turn."),
            "{text}"
        );
        assert!(!document.has_running_operation());
    }

    #[test]
    fn running_items_replace_their_started_cell_when_completed() {
        let mut blocks = Vec::new();
        parse_jsonl_transcript(
            concat!(
                "{\"type\":\"item.started\",\"item\":{\"id\":\"cmd\",\"type\":\"command_execution\",\"command\":\"cargo check\"}}\n",
                "{\"type\":\"item.completed\",\"item\":{\"id\":\"cmd\",\"type\":\"command_execution\",\"command\":\"cargo check\",\"output\":\"ok\",\"exit_code\":0}}\n"
            ),
            None,
            &mut blocks,
        );
        assert_eq!(
            blocks
                .iter()
                .filter(|block| matches!(block, AgentChatBlock::Operation(_)))
                .count(),
            1
        );
        let text = rendered_text(&render_document(&AgentChatDocument { blocks }, 60));
        assert!(text.contains("Ran cargo check"), "{text}");
        assert!(text.contains("ok"), "{text}");
        assert!(!text.contains("Running cargo check"), "{text}");
    }

    #[test]
    fn markdown_reflows_and_highlights_code_without_losing_structure() {
        let lines = render_markdown(
            "# Heading\n\n- first item with enough words to wrap naturally\n- second\n\n```rust\nfn main() { println!(\"hi\"); }\n```",
            24,
        );
        let text = rendered_text(&lines);
        assert!(text.contains("Heading"), "{text}");
        assert!(text.contains("• first item"), "{text}");
        assert!(text.contains("fn main()"), "{text}");
        assert!(lines.iter().any(|line| {
            line.spans
                .iter()
                .any(|span| span.style.bg == Some(Color::Rgb(30, 31, 35)))
        }));
        assert!(lines.iter().any(|line| {
            line.spans.iter().any(|span| {
                span.content.contains("Heading")
                    && span.style.fg == Some(Color::Cyan)
                    && span.style.add_modifier.contains(Modifier::BOLD)
            })
        }));
    }

    #[test]
    fn markdown_source_newlines_add_one_blank_visual_row_without_spacing_wraps() {
        for lines in [
            render_markdown("First line\nSecond line", 80),
            render_markdown_preserving_lines("First line\nSecond line", 80),
        ] {
            assert_eq!(
                rendered_text(&lines),
                "First line\n\nSecond line",
                "{lines:#?}"
            );
        }

        let wrapped = render_markdown(
            "A single source line with enough words to wrap on the terminal",
            18,
        );
        assert!(wrapped.len() > 1, "{wrapped:#?}");
        assert!(
            wrapped.iter().all(|line| !line_is_blank(Some(line))),
            "terminal wrapping added vertical spacing: {wrapped:#?}"
        );
    }

    #[test]
    fn markdown_lists_indent_markers_nesting_and_wrapped_continuations() {
        let lines = render_markdown(
            "- top-level item with enough words that its continuation must wrap\n  1. nested numbered item\n• typographic bullet",
            24,
        );
        let rendered = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();

        assert!(rendered[0].starts_with("  • top-level"), "{rendered:#?}");
        assert!(
            rendered
                .iter()
                .skip(1)
                .take_while(|line| !line.contains("nested numbered"))
                .all(|line| line.is_empty() || line.starts_with("    ")),
            "{rendered:#?}"
        );
        assert!(
            rendered
                .iter()
                .any(|line| line.starts_with("    1. nested numbered")),
            "{rendered:#?}"
        );
        assert!(
            rendered
                .iter()
                .any(|line| line.starts_with("  • typographic bullet")),
            "{rendered:#?}"
        );
    }

    #[test]
    fn markdown_gives_plain_filenames_a_consistent_color() {
        let lines = render_markdown(
            "Edit src/ui.rs, package.json and README.md:12 before release.",
            80,
        );
        for filename in ["src/ui.rs", "package.json", "README.md:12"] {
            assert!(
                lines.iter().flat_map(|line| &line.spans).any(|span| {
                    span.content.contains(filename) && span.style.fg == Some(Color::LightBlue)
                }),
                "missing filename styling for {filename}: {lines:#?}"
            );
        }
    }

    #[test]
    fn file_diffs_and_plans_render_semantically_without_raw_json() {
        let file = block_from_item(
            &serde_json::json!({
                "type":"file_change",
                "status":"completed",
                "changes":[{"path":"src/app.rs","kind":"modified"}],
                "diff":"@@ -1,2 +1,2 @@\n-old value\n+new value\n context"
            }),
            ItemPhase::Completed,
        )
        .unwrap();
        let plan = block_from_item(
            &serde_json::json!({
                "type":"plan_update",
                "explanation":"Implementation plan",
                "plan":[
                    {"step":"Inspect the graph","status":"completed"},
                    {"step":"Render the diff","status":"in_progress"},
                    {"step":"Verify behavior","status":"pending"}
                ]
            }),
            ItemPhase::Completed,
        )
        .unwrap();
        let lines = render_document(
            &AgentChatDocument {
                blocks: vec![file, plan],
            },
            80,
        );
        let text = rendered_text(&lines);
        assert!(text.contains("~ src/app.rs"), "{text}");
        assert!(text.contains("-old value"), "{text}");
        assert!(text.contains("+new value"), "{text}");
        assert!(text.contains("✓ Inspect the graph"), "{text}");
        assert!(text.contains("◉ Render the diff"), "{text}");
        assert!(!text.contains("\"step\""), "{text}");
        assert!(!text.contains('{'), "{text}");
        assert!(lines.iter().any(|line| {
            line.spans.iter().any(|span| {
                span.content.contains("+new value") && span.style.fg == Some(Color::LightGreen)
            })
        }));
        assert!(lines.iter().any(|line| {
            line.spans.iter().any(|span| {
                span.content.contains("-old value") && span.style.fg == Some(Color::LightRed)
            })
        }));
    }

    #[test]
    fn successful_command_output_is_dimmed_and_bounded() {
        let block = block_from_item(
            &serde_json::json!({
                "type":"command_execution",
                "command":"cargo test",
                "status":"completed",
                "output":"line one\nline two\nline three\nline four",
                "exit_code":0
            }),
            ItemPhase::Completed,
        )
        .unwrap();
        let lines = render_document(
            &AgentChatDocument {
                blocks: vec![block],
            },
            80,
        );
        let text = rendered_text(&lines);
        assert!(text.contains("line one"), "{text}");
        assert!(text.contains("line two"), "{text}");
        assert!(!text.contains("line three"), "{text}");
        assert!(text.contains("2 output lines hidden"), "{text}");
        assert!(lines.iter().flat_map(|line| &line.spans).any(|span| {
            span.content.contains("line one")
                && span.style.fg == Some(Color::DarkGray)
                && span.style.add_modifier.contains(Modifier::DIM)
        }));
    }

    #[test]
    fn transcript_paths_must_stay_inside_the_project() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "{\"type\":\"turn.started\"}\n").unwrap();
        let request = AgentChatRequest {
            key: "agent:outside".to_owned(),
            root: root.path().to_path_buf(),
            transcript_path: Some(outside.path().to_path_buf()),
            prompt_path: None,
            output_path: None,
            codex_session_id: None,
            guidance: Vec::new(),
            live: false,
        };
        let text = rendered_text(&AgentChatCache::default().render(&request, 80).lines);
        assert!(text.contains("project boundary check"), "{text}");
        assert!(
            !text.contains(outside.path().to_string_lossy().as_ref()),
            "{text}"
        );
    }

    #[test]
    fn terminal_control_sequences_are_removed_from_full_payloads() {
        assert_eq!(
            sanitize_terminal_text("safe\u{1b}[31m red\u{1b}[0m\u{7}"),
            "safe red"
        );
    }
}
