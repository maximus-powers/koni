//! Minimal, supervised Codex app-server client used by planning turns.
//!
//! Workers continue to use `codex exec`. Planning needs app-server's live
//! `thread/tokenUsage/updated` notifications so Koni can enforce a cumulative
//! run budget before a long tool-using turn has already overspent it.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::agent::{isolate_process_group, terminate_agent_process};
use crate::catalog::PlanningTokenMetric;
use crate::control::PlanningTokenUsage;
use crate::error::{KoniError, Result, io_error};

const INITIALIZE_ID: u64 = 1;
const THREAD_ID: u64 = 2;
const TURN_ID: u64 = 3;
const STEER_ID: u64 = 4;
const INTERRUPT_ID: u64 = 5;

#[derive(Debug, Clone, Copy)]
pub(crate) struct AppServerPlanningBudget {
    pub metric: PlanningTokenMetric,
    pub limit: u64,
    pub synthesis_reserve: u64,
    /// Cumulative usage already emitted by a legacy `codex exec` thread and
    /// therefore already charged before app-server adopted the session.
    pub accounted_baseline: PlanningTokenUsage,
}

impl AppServerPlanningBudget {
    fn used(self, usage: PlanningTokenUsage) -> u64 {
        let usage = usage.saturating_sub(self.accounted_baseline);
        match self.metric {
            PlanningTokenMetric::NewTokens => usage.new_tokens,
            PlanningTokenMetric::ProcessedTokens => usage.total_tokens,
        }
    }

    fn steer_at(self) -> u64 {
        self.limit.saturating_sub(self.synthesis_reserve)
    }

    fn interrupt_at(self) -> u64 {
        self.limit
            .saturating_sub(self.synthesis_reserve.saturating_div(2))
    }
}

pub(crate) struct CodexAppServerTurnRequest {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub working_directory: PathBuf,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub output_path: PathBuf,
    pub timeout: Duration,
    pub environment_set: Vec<(String, String)>,
    pub environment_remove: Vec<String>,
    pub session_id: Option<String>,
    pub developer_instructions: String,
    pub permission_profile: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub prompt: String,
    pub output_schema: Value,
    pub budget: Option<AppServerPlanningBudget>,
    pub synthesis_only: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct CodexAppServerTurnResult {
    pub pid: u32,
    pub session_id: String,
    pub output: Option<String>,
    pub usage: PlanningTokenUsage,
    pub turn_status: String,
    pub needs_forced_synthesis: bool,
    pub budget_exhausted: bool,
}

pub(crate) fn run_codex_app_server_turn(
    request: &CodexAppServerTurnRequest,
    on_started: &mut dyn FnMut(u32) -> Result<()>,
    on_session: &mut dyn FnMut(&str) -> Result<()>,
    on_usage: &mut dyn FnMut(PlanningTokenUsage) -> Result<()>,
) -> Result<CodexAppServerTurnResult> {
    if request.timeout.is_zero() {
        return Err(KoniError::Process(
            "Codex app-server planning timeout must be positive".to_owned(),
        ));
    }
    if !request.working_directory.is_dir() {
        return Err(KoniError::Process(format!(
            "Codex app-server planning directory does not exist: {}",
            request.working_directory.display()
        )));
    }
    for path in [
        &request.stdout_path,
        &request.stderr_path,
        &request.output_path,
    ] {
        let parent = path.parent().ok_or_else(|| {
            KoniError::Process(format!(
                "Codex app-server output has no parent: {}",
                path.display()
            ))
        })?;
        fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    }

    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&request.stderr_path)
        .map_err(|error| io_error(&request.stderr_path, error))?;
    let mut command = Command::new(&request.executable);
    for (name, value) in &request.environment_set {
        command.env(name, value);
    }
    for name in &request.environment_remove {
        command.env_remove(name);
    }
    command
        .args(&request.args)
        .current_dir(&request.working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr));
    isolate_process_group(&mut command);
    let mut child = command.spawn().map_err(|error| {
        KoniError::Process(format!("failed to spawn Codex app-server: {error}"))
    })?;
    let pid = child.id();
    if let Err(error) = on_started(pid) {
        cleanup_child(&mut child, pid);
        return Err(error);
    }

    let stdin = child.stdin.take().ok_or_else(|| {
        cleanup_child(&mut child, pid);
        KoniError::Process("Codex app-server did not expose stdin".to_owned())
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        cleanup_child(&mut child, pid);
        KoniError::Process("Codex app-server did not expose stdout".to_owned())
    })?;
    let (tx, rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let value = line.map_err(|error| error.to_string()).and_then(|line| {
                serde_json::from_str::<Value>(&line).map_err(|error| error.to_string())
            });
            if tx.send(value).is_err() {
                break;
            }
        }
    });
    let mut stdin = stdin;
    // A forced synthesis pass resumes the same thread and appends to the same
    // durable attempt transcript. Never truncate evidence from the exploratory
    // turn when the reserve boundary asks for a second, tool-free turn.
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&request.stdout_path)
        .map_err(|error| io_error(&request.stdout_path, error))?;
    let deadline = Instant::now() + request.timeout;
    let protocol_result = run_protocol(
        request, pid, &mut stdin, &rx, &mut log, deadline, on_session, on_usage,
    );
    drop(stdin);
    cleanup_child(&mut child, pid);
    let _ = reader.join();
    protocol_result
}

#[allow(clippy::too_many_arguments)]
fn run_protocol(
    request: &CodexAppServerTurnRequest,
    pid: u32,
    stdin: &mut impl Write,
    rx: &Receiver<std::result::Result<Value, String>>,
    log: &mut fs::File,
    deadline: Instant,
    on_session: &mut dyn FnMut(&str) -> Result<()>,
    on_usage: &mut dyn FnMut(PlanningTokenUsage) -> Result<()>,
) -> Result<CodexAppServerTurnResult> {
    let mut pending = VecDeque::new();
    send_request(
        stdin,
        INITIALIZE_ID,
        "initialize",
        json!({
            "clientInfo": {
                "name": "koni",
                "title": "Koni planning runtime",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": {"experimentalApi": true},
        }),
    )?;
    wait_for_response(rx, &mut pending, INITIALIZE_ID, deadline)?;
    send_notification(stdin, "initialized", None)?;

    let thread_method;
    let thread_params;
    if let Some(session_id) = &request.session_id {
        thread_method = "thread/resume";
        thread_params = json!({
            "threadId": session_id,
            "cwd": request.working_directory,
            "model": request.model,
            "developerInstructions": request.developer_instructions,
            "approvalPolicy": "never",
            "permissions": request.permission_profile,
        });
    } else {
        thread_method = "thread/start";
        thread_params = json!({
            "cwd": request.working_directory,
            "model": request.model,
            "developerInstructions": request.developer_instructions,
            "approvalPolicy": "never",
            "permissions": request.permission_profile,
            "ephemeral": false,
        });
    }
    send_request(stdin, THREAD_ID, thread_method, thread_params)?;
    let thread_response = wait_for_response(rx, &mut pending, THREAD_ID, deadline)?;
    let session_id = thread_response
        .pointer("/result/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            KoniError::Process("Codex app-server thread response omitted thread.id".to_owned())
        })?
        .to_owned();
    on_session(&session_id)?;
    let started_event = json!({"type":"thread.started", "thread_id": session_id});
    append_event(log, &started_event)?;

    send_request(
        stdin,
        TURN_ID,
        "turn/start",
        json!({
            "threadId": session_id,
            "input": [{"type":"text", "text": request.prompt, "text_elements": []}],
            "cwd": request.working_directory,
            "model": request.model,
            "effort": request.reasoning_effort,
            "approvalPolicy": "never",
            "outputSchema": request.output_schema,
        }),
    )?;
    let turn_response = wait_for_response(rx, &mut pending, TURN_ID, deadline)?;
    let turn_id = turn_response
        .pointer("/result/turn/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            KoniError::Process("Codex app-server turn response omitted turn.id".to_owned())
        })?
        .to_owned();
    append_event(log, &json!({"type":"turn.started", "turn_id": turn_id}))?;

    let mut usage = PlanningTokenUsage::default();
    let mut output = None;
    let turn_status;
    let mut steered = false;
    let mut interrupted_for_budget = false;
    let mut budget_exhausted = false;
    let mut next_message = pending.pop_front();
    loop {
        let message = if let Some(message) = next_message.take() {
            message
        } else {
            receive(rx, deadline)?
        };
        if let Some(error) = message.get("error") {
            return Err(KoniError::Process(format!(
                "Codex app-server request failed: {}",
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown JSON-RPC error")
            )));
        }
        let method = message.get("method").and_then(Value::as_str);
        match method {
            Some("thread/tokenUsage/updated") => {
                if let Some(current) = planning_usage_from_notification(&message) {
                    usage = current;
                    on_usage(usage)?;
                    append_event(
                        log,
                        &json!({
                            "type": "token.usage.updated",
                            "turn_id": turn_id,
                            "usage": usage,
                        }),
                    )?;
                    if let Some(budget) = request.budget {
                        let used = budget.used(usage);
                        if request.synthesis_only && used >= budget.limit && !budget_exhausted {
                            send_request(
                                stdin,
                                INTERRUPT_ID,
                                "turn/interrupt",
                                json!({"threadId": session_id, "turnId": turn_id}),
                            )?;
                            budget_exhausted = true;
                        } else if !request.synthesis_only
                            && used >= budget.interrupt_at()
                            && !interrupted_for_budget
                        {
                            send_request(
                                stdin,
                                INTERRUPT_ID,
                                "turn/interrupt",
                                json!({"threadId": session_id, "turnId": turn_id}),
                            )?;
                            interrupted_for_budget = true;
                        } else if !request.synthesis_only && used >= budget.steer_at() && !steered {
                            send_request(
                                stdin,
                                STEER_ID,
                                "turn/steer",
                                json!({
                                    "threadId": session_id,
                                    "expectedTurnId": turn_id,
                                    "input": [{
                                        "type":"text",
                                        "text":"The compiler-owned planning budget has entered its synthesis reserve. Stop repository exploration now. Do not call another tool. Return the required structured planning response using the evidence already collected.",
                                        "text_elements": [],
                                    }],
                                }),
                            )?;
                            steered = true;
                        }
                    }
                }
            }
            Some("item/started") => {
                if let Some(item) = message.pointer("/params/item") {
                    append_event(
                        log,
                        &json!({"type":"item.started", "item":normalize_item(item)}),
                    )?;
                }
                if steered
                    && !request.synthesis_only
                    && !interrupted_for_budget
                    && message
                        .pointer("/params/item/type")
                        .and_then(Value::as_str)
                        .is_some_and(is_tool_item)
                {
                    send_request(
                        stdin,
                        INTERRUPT_ID,
                        "turn/interrupt",
                        json!({"threadId": session_id, "turnId": turn_id}),
                    )?;
                    interrupted_for_budget = true;
                }
            }
            Some("item/completed") => {
                if let Some(item) = message.pointer("/params/item") {
                    if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                        output = item
                            .get("text")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned);
                    }
                    let event = normalize_item_completed(item);
                    append_event(log, &event)?;
                }
            }
            Some("turn/completed") => {
                let turn = message.pointer("/params/turn").unwrap_or(&Value::Null);
                turn_status = turn
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("completed")
                    .to_owned();
                if let Some(final_output) = final_agent_message(turn) {
                    output = Some(final_output);
                }
                append_event(
                    log,
                    &json!({
                        "type": "turn.finished",
                        "turn_id": turn_id,
                        "status": turn_status,
                        "usage": usage,
                    }),
                )?;
                break;
            }
            Some("error")
                if message
                    .pointer("/params/willRetry")
                    .and_then(Value::as_bool)
                    != Some(true) =>
            {
                let detail = message
                    .pointer("/params/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex app-server turn failed");
                return Err(KoniError::Process(detail.to_owned()));
            }
            _ => {}
        }
        next_message = pending.pop_front();
    }

    if let Some(output) = &output {
        fs::write(&request.output_path, output)
            .map_err(|error| io_error(&request.output_path, error))?;
    }
    Ok(CodexAppServerTurnResult {
        pid,
        session_id,
        output,
        usage,
        turn_status,
        needs_forced_synthesis: interrupted_for_budget && !request.synthesis_only,
        budget_exhausted,
    })
}

fn send_request(writer: &mut impl Write, id: u64, method: &str, params: Value) -> Result<()> {
    write_message(
        writer,
        &json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
    )
}

fn send_notification(writer: &mut impl Write, method: &str, params: Option<Value>) -> Result<()> {
    let mut message = json!({"jsonrpc":"2.0", "method":method});
    if let Some(params) = params {
        message["params"] = params;
    }
    write_message(writer, &message)
}

fn write_message(writer: &mut impl Write, message: &Value) -> Result<()> {
    serde_json::to_writer(&mut *writer, message).map_err(|error| {
        KoniError::Process(format!("could not encode app-server request: {error}"))
    })?;
    writer
        .write_all(b"\n")
        .and_then(|()| writer.flush())
        .map_err(|error| KoniError::Process(format!("could not write app-server request: {error}")))
}

fn wait_for_response(
    rx: &Receiver<std::result::Result<Value, String>>,
    pending: &mut VecDeque<Value>,
    id: u64,
    deadline: Instant,
) -> Result<Value> {
    loop {
        let message = receive(rx, deadline)?;
        if message.get("id").and_then(Value::as_u64) == Some(id) {
            if let Some(error) = message.get("error") {
                return Err(KoniError::Process(format!(
                    "Codex app-server request {id} failed: {}",
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown JSON-RPC error")
                )));
            }
            return Ok(message);
        }
        pending.push_back(message);
    }
}

fn receive(rx: &Receiver<std::result::Result<Value, String>>, deadline: Instant) -> Result<Value> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(KoniError::Process(
            "Codex app-server planning turn timed out".to_owned(),
        ));
    }
    rx.recv_timeout(remaining)
        .map_err(|error| {
            KoniError::Process(format!(
                "Codex app-server stream ended before completion: {error}"
            ))
        })?
        .map_err(|error| KoniError::Process(format!("invalid Codex app-server event: {error}")))
}

fn append_event(log: &mut fs::File, event: &Value) -> Result<()> {
    serde_json::to_writer(&mut *log, event)
        .map_err(|error| KoniError::Process(format!("could not encode planning event: {error}")))?;
    log.write_all(b"\n")
        .and_then(|()| log.flush())
        .map_err(|error| KoniError::Process(format!("could not persist planning event: {error}")))
}

fn planning_usage_from_notification(message: &Value) -> Option<PlanningTokenUsage> {
    let total = message.pointer("/params/tokenUsage/total")?;
    Some(PlanningTokenUsage::from_breakdown(
        total.get("inputTokens")?.as_u64()?,
        total.get("cachedInputTokens")?.as_u64()?,
        total.get("outputTokens")?.as_u64()?,
        total.get("reasoningOutputTokens")?.as_u64()?,
    ))
}

fn normalize_item_completed(item: &Value) -> Value {
    json!({"type":"item.completed", "item":normalize_item(item)})
}

fn normalize_item(item: &Value) -> Value {
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    match item_type {
        "agentMessage" | "plan" => json!({
            "id": item.get("id").cloned().unwrap_or(Value::Null),
            "type": "agent_message",
            "text": item.get("text").cloned().unwrap_or(Value::String(String::new())),
        }),
        "commandExecution" => json!({
            "id": item.get("id").cloned().unwrap_or(Value::Null),
            "type": "command_execution",
            "command": item.get("command").cloned().unwrap_or(Value::String(String::new())),
            "aggregated_output": item.get("aggregatedOutput").cloned().unwrap_or(Value::String(String::new())),
            "exit_code": item.get("exitCode").cloned().unwrap_or(Value::Null),
            "status": item.get("status").cloned().unwrap_or(Value::String(String::new())),
        }),
        _ => item.clone(),
    }
}

fn final_agent_message(turn: &Value) -> Option<String> {
    turn.get("items")?
        .as_array()?
        .iter()
        .rev()
        .find(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("agentMessage" | "plan")
            )
        })
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn is_tool_item(item_type: &str) -> bool {
    matches!(
        item_type,
        "commandExecution" | "mcpToolCall" | "dynamicToolCall" | "fileChange"
    )
}

fn cleanup_child(child: &mut Child, pid: u32) {
    if child.try_wait().ok().flatten().is_none() {
        let _ = terminate_agent_process(child, pid);
    }
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_metric_excludes_cached_input_without_double_counting_reasoning() {
        let usage = PlanningTokenUsage::from_breakdown(1_000, 800, 100, 50);
        assert_eq!(usage.total_tokens, 1_100);
        assert_eq!(usage.new_tokens, 300);
        let budget = AppServerPlanningBudget {
            metric: PlanningTokenMetric::NewTokens,
            limit: 1_000_000,
            synthesis_reserve: 200_000,
            accounted_baseline: PlanningTokenUsage::default(),
        };
        assert_eq!(budget.used(usage), 300);
        assert_eq!(budget.steer_at(), 800_000);
        assert_eq!(budget.interrupt_at(), 900_000);

        let migrated = AppServerPlanningBudget {
            accounted_baseline: PlanningTokenUsage::from_breakdown(600, 500, 50, 25),
            ..budget
        };
        assert_eq!(
            migrated.used(PlanningTokenUsage::from_breakdown(1_000, 800, 100, 50)),
            150,
            "legacy thread usage already present in exec logs must not be charged twice"
        );
    }

    #[test]
    fn usage_notification_uses_cumulative_thread_total() {
        let message = json!({
            "params": {"tokenUsage": {"total": {
                "inputTokens": 500,
                "cachedInputTokens": 300,
                "outputTokens": 75,
                "reasoningOutputTokens": 25,
                "totalTokens": 575
            }}}
        });
        assert_eq!(
            planning_usage_from_notification(&message),
            Some(PlanningTokenUsage::from_breakdown(500, 300, 75, 25))
        );
    }

    #[test]
    fn app_server_items_remain_compatible_with_existing_planning_transcripts() {
        let event = normalize_item_completed(&json!({
            "id":"item-1",
            "type":"commandExecution",
            "command":"rg planning",
            "aggregatedOutput":"match",
            "exitCode":0,
            "status":"completed"
        }));
        assert_eq!(
            event.pointer("/item/type").and_then(Value::as_str),
            Some("command_execution")
        );
        assert_eq!(
            event
                .pointer("/item/aggregated_output")
                .and_then(Value::as_str),
            Some("match")
        );
    }
}
