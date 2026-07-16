//! Process-bound MCP broker for compiler-owned Codex agents.
//!
//! The command line contains only an opaque one-time grant and the durable
//! agent attempt that Codex is expected to parent. All semantic authority is
//! recovered from the claimed grant and revalidated by the core on every call.

use anyhow::Context;
use koni_core::{
    AgentBrokerIngress, AgentBrokerRole, AgentBrokerSafeError, KoniError,
    agent_mcp_safe_error_for_tool, claim_agent_mcp_grant, execute_agent_mcp_tool,
    wait_for_spawned_agent_reapers,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};

const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_CLIENT_PROTOCOLS: &[&str] = &[PROTOCOL_VERSION, "2025-11-25"];
const MAX_REQUEST_FRAME_BYTES: usize = 2 * 1024 * 1024;
// Core caps the serialized tool value at 16 MiB. Embedding that JSON as MCP
// text can escape it once more, so reserve more than twice that bounded size.
const MAX_RESPONSE_FRAME_BYTES: usize = 34 * 1024 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_VALIDATION_REJECTIONS_PER_TOOL: usize = 3;

#[derive(Debug, Clone, Default)]
struct ValidationRejectionState {
    count: usize,
    last_correction: Option<AgentBrokerSafeError>,
}

#[derive(Debug, Clone)]
pub(crate) struct AgentMcpOptions {
    pub grant: String,
    pub agent_id: String,
    pub attempt: u32,
}

pub(crate) fn run(options: AgentMcpOptions) -> anyhow::Result<()> {
    anyhow::ensure!(
        !options.grant.trim().is_empty()
            && !options.agent_id.trim().is_empty()
            && options.attempt > 0,
        "agent-mcp requires an opaque grant, durable agent ID, and positive attempt"
    );
    let cwd = std::env::current_dir().context("agent-mcp could not resolve its checkout")?;
    let mut ingress =
        claim_agent_mcp_grant(&cwd, &options.grant, &options.agent_id, options.attempt)?;
    let view = ingress.view()?;
    let catalog = ToolCatalog::new(view.role, view.enabled_tools)?;
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    serve(
        stdin.lock(),
        stdout.lock(),
        &catalog,
        &mut EngineBrokerBackend {
            ingress: &mut ingress,
        },
    )
}

#[derive(Debug, Clone)]
struct ToolCatalog {
    role: AgentBrokerRole,
    ordered: Vec<String>,
    allowed: BTreeSet<String>,
}

impl ToolCatalog {
    fn new(role: AgentBrokerRole, ordered: Vec<String>) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !ordered.is_empty(),
            "runtime MCP grant has no enabled tools"
        );
        let allowed = ordered.iter().cloned().collect::<BTreeSet<_>>();
        anyhow::ensure!(
            allowed.len() == ordered.len(),
            "runtime MCP grant repeats an enabled tool"
        );
        for tool in &ordered {
            tool_definition(tool, &role)?;
        }
        Ok(Self {
            role,
            ordered,
            allowed,
        })
    }
}

trait BrokerBackend {
    fn call(&mut self, tool: &str, arguments: Value) -> Result<Value, KoniError>;
}

struct EngineBrokerBackend<'a> {
    ingress: &'a mut AgentBrokerIngress,
}

impl BrokerBackend for EngineBrokerBackend<'_> {
    fn call(&mut self, tool: &str, arguments: Value) -> Result<Value, KoniError> {
        let result = execute_agent_mcp_tool(self.ingress, tool, arguments);
        if tool == "yield_lead" && result.is_ok() {
            // Workers are spawned by this MCP broker process, not by the
            // outer CLI/TUI supervisor. Keep their actual parent-side wait(2)
            // handles alive through the accepted Lead yield so every raw
            // process exit is durable before control returns to orchestration.
            // A dispatch batch reaches yield only after all of its workers are
            // started, so the workers still execute in parallel.
            wait_for_spawned_agent_reapers();
        }
        result
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArguments {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubmitOutputArguments {
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompileArguments {
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
enum GraphContextDirection {
    Outgoing,
    Incoming,
    #[default]
    Both,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GraphContextArguments {
    #[serde(default)]
    anchors: Vec<String>,
    #[serde(default)]
    relations: Vec<String>,
    #[serde(default)]
    direction: GraphContextDirection,
    #[serde(default)]
    max_depth: Option<u64>,
    #[serde(default)]
    node_types: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RecordNoteKind {
    Observation,
    ImplementationDetail,
    Rationale,
    Nit,
    OpenQuestion,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordNoteArguments {
    node_id: String,
    kind: RecordNoteKind,
    body: String,
    #[serde(default)]
    supersedes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketArguments {
    ticket: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct YieldArguments {
    #[serde(default)]
    reason: Option<String>,
}

fn validate_tool_arguments(
    role: &AgentBrokerRole,
    tool: &str,
    arguments: Value,
) -> anyhow::Result<Value> {
    match (role, tool) {
        (AgentBrokerRole::Worker { .. }, "context") => {
            serde_json::from_value::<EmptyArguments>(arguments.clone())?;
        }
        (AgentBrokerRole::Worker { .. }, "graph_context") => {
            let parsed = serde_json::from_value::<GraphContextArguments>(arguments.clone())?;
            validate_string_list(&parsed.anchors, "anchors", 16)?;
            validate_string_list(&parsed.relations, "relations", 32)?;
            validate_string_list(&parsed.node_types, "node_types", 32)?;
            let _ = (parsed.direction, parsed.max_depth);
        }
        (AgentBrokerRole::Worker { .. }, "record_note") => {
            let parsed = serde_json::from_value::<RecordNoteArguments>(arguments.clone())?;
            anyhow::ensure!(
                !parsed.node_id.trim().is_empty(),
                "node_id must not be empty"
            );
            anyhow::ensure!(!parsed.body.trim().is_empty(), "body must not be empty");
            if let Some(supersedes) = parsed.supersedes {
                anyhow::ensure!(
                    !supersedes.trim().is_empty(),
                    "supersedes must not be empty"
                );
            }
            let _ = parsed.kind;
        }
        (AgentBrokerRole::Worker { .. }, "submit_output" | "submit_and_compile") => {
            let parsed = serde_json::from_value::<SubmitOutputArguments>(arguments.clone())?;
            anyhow::ensure!(parsed.payload.is_object(), "payload must be a JSON object");
        }
        (AgentBrokerRole::Worker { .. }, "compile") => {
            let parsed = serde_json::from_value::<CompileArguments>(arguments.clone())?;
            if let Some(summary) = parsed.summary {
                anyhow::ensure!(!summary.trim().is_empty(), "summary must not be empty");
            }
        }
        (
            AgentBrokerRole::Lead {
                boundary: koni_core::LeadSliceBoundary::DispatchBatch { .. },
                ..
            },
            "start" | "spawn_worker",
        ) => {
            let parsed = serde_json::from_value::<TicketArguments>(arguments.clone())?;
            anyhow::ensure!(!parsed.ticket.trim().is_empty(), "ticket must not be empty");
        }
        (AgentBrokerRole::Lead { .. }, "yield_lead") => {
            let parsed = serde_json::from_value::<YieldArguments>(arguments.clone())?;
            if let Some(reason) = parsed.reason {
                anyhow::ensure!(
                    matches!(
                        reason.as_str(),
                        "boundary-complete" | "paused" | "capacity-reached"
                    ),
                    "invalid yield reason"
                );
            }
        }
        (AgentBrokerRole::Lead { .. }, _) => {
            serde_json::from_value::<EmptyArguments>(arguments.clone())?;
        }
        _ => anyhow::bail!("tool is invalid for this compiler-issued role"),
    }
    Ok(arguments)
}

fn validate_string_list(values: &[String], name: &str, maximum: usize) -> anyhow::Result<()> {
    anyhow::ensure!(
        values.len() <= maximum,
        "{name} accepts at most {maximum} entries"
    );
    anyhow::ensure!(
        values.iter().all(|value| !value.trim().is_empty()),
        "{name} entries must be nonempty strings"
    );
    Ok(())
}

fn minimal_model_response(tool: &str, value: Value) -> anyhow::Result<Value> {
    match tool {
        "context" => {
            if let Some(document) = value.get("document").cloned() {
                return Ok(json!({"document": document}));
            }
            let document_path = value
                .get("document_path")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("context response is missing its document"))?;
            Ok(json!({
                "status": "already_issued",
                "document_path": document_path,
                "message": value.get("message").and_then(Value::as_str).unwrap_or(
                    "Use the complete context from the first call or read only this exact compiler-issued document path."
                ),
            }))
        }
        "graph_context" => Ok(value),
        "record_note" => {
            let note_id = value
                .get("note")
                .and_then(|note| note.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("record_note response is missing its note ID"))?;
            Ok(json!({
                "status": "accepted",
                "note_id": note_id,
                "replayed": value.get("replayed").and_then(Value::as_bool).unwrap_or(false),
                "authority": value.get("authority").and_then(Value::as_str).unwrap_or(
                    "advisory_non_authoritative"
                ),
            }))
        }
        // WorkerWaitOutcome is deliberately a compact public broker DTO: it
        // contains no process identity, path, persona, or internal step.
        "wait_worker" => Ok(value),
        _ => Ok(json!({"status": "accepted"})),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProtocolState {
    AwaitInitialize,
    AwaitInitializedNotification,
    Ready,
}

enum RequestFrame {
    Eof,
    Oversized,
    Bytes(Vec<u8>),
}

fn read_request_frame(reader: &mut impl BufRead) -> anyhow::Result<RequestFrame> {
    let mut output = Vec::new();
    let mut oversized = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if output.is_empty() {
                Ok(RequestFrame::Eof)
            } else if oversized {
                Ok(RequestFrame::Oversized)
            } else {
                Ok(RequestFrame::Bytes(output))
            };
        }
        let take = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        if !oversized {
            if output.len().saturating_add(take) > MAX_REQUEST_FRAME_BYTES {
                oversized = true;
                output.clear();
            } else {
                output.extend_from_slice(&buffer[..take]);
            }
        }
        let ended = buffer.get(take.saturating_sub(1)) == Some(&b'\n');
        reader.consume(take);
        if ended {
            return if oversized {
                Ok(RequestFrame::Oversized)
            } else {
                Ok(RequestFrame::Bytes(output))
            };
        }
    }
}

fn serve<R: BufRead, W: Write, B: BrokerBackend>(
    mut reader: R,
    mut writer: W,
    catalog: &ToolCatalog,
    backend: &mut B,
) -> anyhow::Result<()> {
    let mut state = ProtocolState::AwaitInitialize;
    let mut validation_rejections = BTreeMap::<String, ValidationRejectionState>::new();
    loop {
        let frame = match read_request_frame(&mut reader)? {
            RequestFrame::Eof => return Ok(()),
            RequestFrame::Oversized => {
                write_response(
                    &mut writer,
                    jsonrpc_error(Value::Null, -32600, "request frame exceeded the safe limit"),
                )?;
                continue;
            }
            RequestFrame::Bytes(frame) => frame,
        };
        let request = match serde_json::from_slice::<Value>(&frame) {
            Ok(request) => request,
            Err(_) => {
                write_response(
                    &mut writer,
                    jsonrpc_error(Value::Null, -32700, "malformed JSON"),
                )?;
                continue;
            }
        };
        let Some(object) = request.as_object() else {
            write_response(
                &mut writer,
                jsonrpc_error(Value::Null, -32600, "invalid JSON-RPC request"),
            )?;
            continue;
        };
        let id = object.get("id").cloned();
        let invalid_id = id.as_ref().is_some_and(|id| !valid_request_id(id));
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || object.get("method").and_then(Value::as_str).is_none()
            || object
                .keys()
                .any(|key| !matches!(key.as_str(), "jsonrpc" | "id" | "method" | "params"))
            || invalid_id
        {
            if let Some(id) = id {
                write_response(
                    &mut writer,
                    jsonrpc_error(
                        if invalid_id { Value::Null } else { id },
                        -32600,
                        "invalid JSON-RPC request",
                    ),
                )?;
            }
            continue;
        }
        let method = object["method"].as_str().expect("method checked above");
        if id.is_none() {
            if method == "notifications/initialized"
                && state == ProtocolState::AwaitInitializedNotification
                && empty_params(object.get("params"))
            {
                state = ProtocolState::Ready;
            }
            continue;
        }
        let id = id.expect("request ID checked above");
        let response = match method {
            "initialize" if state == ProtocolState::AwaitInitialize => {
                if valid_initialize_params(object.get("params")) {
                    state = ProtocolState::AwaitInitializedNotification;
                    jsonrpc_result(
                        id,
                        json!({
                            "protocolVersion": PROTOCOL_VERSION,
                            "capabilities": {"tools": {"listChanged": false}},
                            "serverInfo": {"name": "koni-runtime", "version": env!("CARGO_PKG_VERSION")},
                            "instructions": "Use only the compiler-issued tools exposed for this process."
                        }),
                    )
                } else {
                    jsonrpc_error(id, -32602, "unsupported or invalid initialize parameters")
                }
            }
            "initialize" => jsonrpc_error(id, -32600, "MCP session is already initialized"),
            "ping" if empty_params(object.get("params")) => jsonrpc_result(id, json!({})),
            "ping" => jsonrpc_error(id, -32602, "invalid ping parameters"),
            "tools/list" | "tools/call" if state != ProtocolState::Ready => {
                jsonrpc_error(id, -32600, "MCP initialization is incomplete")
            }
            "tools/list" if valid_tools_list_params(object.get("params")) => jsonrpc_result(
                id,
                json!({
                    "tools": catalog
                        .ordered
                        .iter()
                        .map(|tool| tool_definition(tool, &catalog.role))
                        .collect::<anyhow::Result<Vec<_>>>()?
                }),
            ),
            "tools/list" => jsonrpc_error(id, -32602, "invalid tools/list parameters"),
            "tools/call" => {
                let params = object.get("params").cloned().unwrap_or(Value::Null);
                if !valid_tools_call_params(&params) {
                    write_response(
                        &mut writer,
                        jsonrpc_error(id, -32602, "invalid tools/call parameters"),
                    )?;
                    continue;
                }
                let name = params.get("name").and_then(Value::as_str);
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match name {
                    Some(name) if !catalog.allowed.contains(name) => {
                        tool_error_result(id, "tool is outside this compiler-issued capability")
                    }
                    Some(_) if !arguments.is_object() => {
                        tool_error_result(id, "tool arguments must be a JSON object")
                    }
                    Some(name) => match validate_tool_arguments(&catalog.role, name, arguments) {
                        Err(_) => tool_error_result(
                            id,
                            "invalid_arguments: use exactly the compiler-issued tool schema",
                        ),
                        Ok(arguments) => {
                            let rejection_state = validation_rejections.get(name);
                            if bounded_validation_tool(name)
                                && rejection_state.is_some_and(|state| {
                                    state.count >= MAX_VALIDATION_REJECTIONS_PER_TOOL
                                })
                            {
                                tool_error_result(
                                    id,
                                    serialize_safe_error(validation_retry_limit_error(
                                        rejection_state
                                            .and_then(|state| state.last_correction.as_ref()),
                                    )),
                                )
                            } else {
                                match backend.call(name, arguments) {
                                    Ok(value) => match minimal_model_response(name, value) {
                                        Ok(value) => tool_success_result(id, value),
                                        Err(_) => tool_error_result(id, safe_tool_error(name)),
                                    },
                                    Err(error) => {
                                        let mut safe = agent_mcp_safe_error_for_tool(name, &error);
                                        if bounded_validation_tool(name)
                                            && safe.code == "revise_validation"
                                        {
                                            let rejection_state = validation_rejections
                                                .entry(name.to_owned())
                                                .or_default();
                                            rejection_state.count += 1;
                                            rejection_state.last_correction = Some(safe.clone());
                                            if rejection_state.count
                                                >= MAX_VALIDATION_REJECTIONS_PER_TOOL
                                            {
                                                safe = validation_retry_limit_error(
                                                    rejection_state.last_correction.as_ref(),
                                                );
                                            }
                                        }
                                        tool_error_result(id, serialize_safe_error(safe))
                                    }
                                }
                            }
                        }
                    },
                    None => jsonrpc_error(id, -32602, "tools/call requires a tool name"),
                }
            }
            _ => jsonrpc_error(id, -32601, "unknown method"),
        };
        write_response(&mut writer, response)?;
    }
}

fn bounded_validation_tool(tool: &str) -> bool {
    matches!(tool, "submit_output" | "submit_and_compile" | "compile")
}

fn validation_retry_limit_error(
    last_correction: Option<&AgentBrokerSafeError>,
) -> AgentBrokerSafeError {
    let mut message = "The compiler returned three bounded validation rejections in this agent session. Stop this agent so Koni can preserve the exact ticket boundary and recover without an unbounded retry loop."
        .to_owned();
    if let Some(correction) =
        last_correction.filter(|correction| correction.code == "revise_validation")
    {
        message.push_str(" Final compiler correction: ");
        message.push_str(correction.message.trim());
    }
    AgentBrokerSafeError {
        code: "validation_retry_limit".to_owned(),
        message,
        retryable: false,
    }
}

fn serialize_safe_error(error: AgentBrokerSafeError) -> String {
    serde_json::to_string(&error).unwrap_or_else(|_| {
        "{\"code\":\"internal_stop\",\"message\":\"Stop this agent and let the supervisor recover.\",\"retryable\":false}"
            .to_owned()
    })
}

fn safe_tool_error(tool: &str) -> &'static str {
    match tool {
        "context" => "context_unavailable: the compiler could not provide this step context",
        "submit_output" | "submit_and_compile" => {
            "output_rejected: revise the structured payload to satisfy the issued context"
        }
        "compile" => {
            "compile_rejected: revise and resubmit the structured output before compiling again"
        }
        "wait_worker" => "wait_rejected: the issued worker boundary is no longer waitable",
        "yield_lead" => "yield_rejected: complete the issued Lead boundary before yielding",
        _ => "boundary_rejected: the compiler rejected this lifecycle transition",
    }
}

fn valid_request_id(id: &Value) -> bool {
    id.as_i64().is_some()
        || id.as_u64().is_some()
        || id.as_str().is_some_and(|value| {
            value.len() <= MAX_REQUEST_ID_BYTES && !value.chars().any(char::is_control)
        })
}

fn empty_params(params: Option<&Value>) -> bool {
    match params {
        None | Some(Value::Null) => true,
        Some(Value::Object(object)) => object.is_empty(),
        _ => false,
    }
}

fn valid_tools_list_params(params: Option<&Value>) -> bool {
    match params {
        None | Some(Value::Null) => true,
        Some(Value::Object(object)) => {
            object
                .keys()
                .all(|key| matches!(key.as_str(), "cursor" | "_meta"))
                && object.get("cursor").is_none_or(Value::is_null)
                && object.get("_meta").is_none_or(Value::is_object)
        }
        _ => false,
    }
}

fn valid_initialize_params(params: Option<&Value>) -> bool {
    let Some(params) = params.and_then(Value::as_object) else {
        return false;
    };
    if params.keys().any(|key| {
        !matches!(
            key.as_str(),
            "protocolVersion" | "capabilities" | "clientInfo" | "_meta"
        )
    }) || !params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .is_some_and(|protocol| SUPPORTED_CLIENT_PROTOCOLS.contains(&protocol))
        || !params.get("capabilities").is_some_and(Value::is_object)
        || params.get("_meta").is_some_and(|value| !value.is_object())
    {
        return false;
    }
    let Some(client) = params.get("clientInfo").and_then(Value::as_object) else {
        return false;
    };
    if client
        .keys()
        .any(|key| !matches!(key.as_str(), "name" | "title" | "version"))
    {
        return false;
    }
    ["name", "version"].into_iter().all(|key| {
        client
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.len() <= 256)
    }) && client
        .get("title")
        .is_none_or(|value| value.as_str().is_some_and(|value| value.len() <= 256))
}

fn valid_tools_call_params(params: &Value) -> bool {
    params.as_object().is_some_and(|params| {
        !params
            .keys()
            .any(|key| !matches!(key.as_str(), "name" | "arguments" | "_meta"))
            && params
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty() && name.len() <= 128)
            && params
                .get("arguments")
                .is_none_or(|arguments| arguments.is_object())
            && params.get("_meta").is_none_or(Value::is_object)
    })
}

fn write_response(writer: &mut impl Write, response: Value) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec(&response)?;
    anyhow::ensure!(
        bytes.len() <= MAX_RESPONSE_FRAME_BYTES,
        "runtime MCP response exceeded its safe size limit"
    );
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn jsonrpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn jsonrpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn tool_success_result(id: Value, value: Value) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".to_owned());
    jsonrpc_result(
        id,
        json!({"content": [{"type": "text", "text": text}], "isError": false}),
    )
}

fn tool_error_result(id: Value, message: impl Into<String>) -> Value {
    jsonrpc_result(
        id,
        json!({
            "content": [{"type": "text", "text": message.into()}],
            "isError": true
        }),
    )
}

fn tool_definition(name: &str, role: &AgentBrokerRole) -> anyhow::Result<Value> {
    let empty = || json!({"type": "object", "additionalProperties": false});
    let ticket = |allowed: &[String]| {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["ticket"],
            "properties": {"ticket": {"type": "string", "enum": allowed}}
        })
    };
    let (description, input_schema, read_only) = match (role, name) {
        (AgentBrokerRole::Worker { .. }, "context") => (
            "Read the complete compiler-issued context for this ticket step.",
            empty(),
            true,
        ),
        (AgentBrokerRole::Worker { .. }, "graph_context") => (
            "Read a bounded graph neighborhood anchored within this ticket's compiler-issued scope, including advisory working notes.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "anchors": {
                        "type": "array",
                        "maxItems": 16,
                        "items": {"type": "string", "minLength": 1}
                    },
                    "relations": {
                        "type": "array",
                        "maxItems": 32,
                        "items": {"type": "string", "minLength": 1}
                    },
                    "direction": {
                        "type": "string",
                        "enum": ["outgoing", "incoming", "both"],
                        "default": "both"
                    },
                    "max_depth": {
                        "type": "integer",
                        "minimum": 0,
                        "default": 1
                    },
                    "node_types": {
                        "type": "array",
                        "maxItems": 32,
                        "items": {"type": "string", "minLength": 1}
                    }
                }
            }),
            true,
        ),
        (AgentBrokerRole::Worker { .. }, "record_note") => (
            "Append a provenance-bound advisory working note to a graph node visible from this ticket. This does not change typed graph authority.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["node_id", "kind", "body"],
                "properties": {
                    "node_id": {"type": "string", "minLength": 1},
                    "kind": {
                        "type": "string",
                        "enum": [
                            "observation",
                            "implementation_detail",
                            "rationale",
                            "nit",
                            "open_question"
                        ]
                    },
                    "body": {"type": "string", "minLength": 1},
                    "supersedes": {"type": "string", "minLength": 1}
                }
            }),
            false,
        ),
        (AgentBrokerRole::Worker { .. }, "submit_output") => (
            "Submit structured output for this ticket step.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["payload"],
                "properties": {"payload": {"type": "object"}}
            }),
            false,
        ),
        (AgentBrokerRole::Worker { .. }, "submit_and_compile") => (
            "Atomically submit structured output, materialize its graph delta, and run the scoped compile for this ticket step.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["payload"],
                "properties": {"payload": {"type": "object"}}
            }),
            false,
        ),
        (AgentBrokerRole::Worker { .. }, "compile") => (
            "Validate and compile the accepted output for this ticket step.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {"summary": {"type": "string", "minLength": 1}}
            }),
            false,
        ),
        (
            AgentBrokerRole::Lead {
                boundary: koni_core::LeadSliceBoundary::DispatchBatch { tickets },
                ..
            },
            "start",
        ) => (
            "Start the next issued dispatch ticket.",
            ticket(tickets),
            false,
        ),
        (
            AgentBrokerRole::Lead {
                boundary: koni_core::LeadSliceBoundary::DispatchBatch { tickets },
                ..
            },
            "spawn_worker",
        ) => (
            "Spawn the worker for the next issued dispatch ticket.",
            ticket(tickets),
            false,
        ),
        (AgentBrokerRole::Lead { .. }, "spawn_worker") => (
            "Spawn the worker for the compiler-issued ticket.",
            empty(),
            false,
        ),
        (AgentBrokerRole::Lead { .. }, "wait_worker") => (
            "Wait at the exact compiler-issued worker boundary.",
            empty(),
            false,
        ),
        (AgentBrokerRole::Lead { .. }, "recover") => {
            ("Run the compiler-owned recovery boundary.", empty(), false)
        }
        (AgentBrokerRole::Lead { .. }, "review") => (
            "Run the compiler-owned review for the issued ticket.",
            empty(),
            false,
        ),
        (AgentBrokerRole::Lead { .. }, "finish") => (
            "Finish and integrate the compiler-issued ticket.",
            empty(),
            false,
        ),
        (AgentBrokerRole::Lead { .. }, "yield_lead") => (
            "Return this completed or compiler-verified interrupted Lead boundary to the supervisor and stop.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "reason": {
                        "type": "string",
                        "enum": ["boundary-complete", "paused", "capacity-reached"]
                    }
                }
            }),
            false,
        ),
        _ => anyhow::bail!("tool is invalid for this compiler-issued role"),
    };
    Ok(json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
        "annotations": {
            "readOnlyHint": read_only,
            "destructiveHint": false,
            "idempotentHint": read_only,
            "openWorldHint": false
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[derive(Default)]
    struct FakeBackend {
        calls: Vec<(String, Value)>,
    }

    impl BrokerBackend for FakeBackend {
        fn call(&mut self, tool: &str, arguments: Value) -> Result<Value, KoniError> {
            self.calls.push((tool.to_owned(), arguments));
            Ok(json!({"accepted": tool}))
        }
    }

    fn worker_catalog() -> ToolCatalog {
        ToolCatalog::new(
            AgentBrokerRole::Worker {
                ticket: "TK-pinned".to_owned(),
                step: "implement".to_owned(),
                persona: "builder".to_owned(),
            },
            [
                "context",
                "graph_context",
                "record_note",
                "submit_and_compile",
                "submit_output",
                "compile",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        )
        .unwrap()
    }

    fn run_protocol<B: BrokerBackend>(
        input: &str,
        catalog: &ToolCatalog,
        backend: &mut B,
    ) -> Vec<Value> {
        let mut output = Vec::new();
        serve(Cursor::new(input.as_bytes()), &mut output, catalog, backend).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn handshake() -> &'static str {
        concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test-client\",\"version\":\"1\"}}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n"
        )
    }

    #[test]
    fn handshake_uses_fixed_protocol_and_lists_only_granted_tools() {
        let catalog = worker_catalog();
        let mut backend = FakeBackend::default();
        let input = format!(
            "{}{tail}",
            handshake(),
            tail = "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n"
        );
        let responses = run_protocol(&input, &catalog, &mut backend);
        assert_eq!(responses[0]["result"]["protocolVersion"], PROTOCOL_VERSION);
        let names = responses[1]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "context",
                "graph_context",
                "record_note",
                "submit_and_compile",
                "submit_output",
                "compile",
            ]
        );
    }

    #[test]
    fn first_page_tools_list_accepts_current_mcp_pagination_and_metadata_shape() {
        let catalog = worker_catalog();
        let mut backend = FakeBackend::default();
        let input = format!(
            "{}{}{}",
            handshake(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{\"cursor\":null}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/list\",\"params\":{\"_meta\":{\"progressToken\":\"inventory\"}}}\n"
        );
        let responses = run_protocol(&input, &catalog, &mut backend);
        assert_eq!(responses[1]["result"]["tools"].as_array().unwrap().len(), 6);
        assert_eq!(responses[2]["result"]["tools"].as_array().unwrap().len(), 6);
        assert!(backend.calls.is_empty());
    }

    #[test]
    fn graph_resource_tools_publish_bounded_non_destructive_schemas() {
        let role = AgentBrokerRole::Worker {
            ticket: "TK-pinned".to_owned(),
            step: "implement".to_owned(),
            persona: "builder".to_owned(),
        };
        let graph_context = tool_definition("graph_context", &role).unwrap();
        assert_eq!(
            graph_context["inputSchema"]["properties"]["anchors"]["maxItems"],
            16
        );
        assert_eq!(
            graph_context["inputSchema"]["properties"]["relations"]["maxItems"],
            32
        );
        assert_eq!(
            graph_context["inputSchema"]["properties"]["direction"]["enum"],
            json!(["outgoing", "incoming", "both"])
        );
        assert_eq!(
            graph_context["inputSchema"]["properties"]["direction"]["default"],
            "both"
        );
        assert_eq!(
            graph_context["inputSchema"]["properties"]["max_depth"]["minimum"],
            0
        );
        assert_eq!(graph_context["annotations"]["readOnlyHint"], true);
        assert_eq!(graph_context["annotations"]["destructiveHint"], false);

        let record_note = tool_definition("record_note", &role).unwrap();
        assert_eq!(
            record_note["inputSchema"]["required"],
            json!(["node_id", "kind", "body"])
        );
        assert_eq!(
            record_note["inputSchema"]["properties"]["kind"]["enum"],
            json!([
                "observation",
                "implementation_detail",
                "rationale",
                "nit",
                "open_question"
            ])
        );
        assert_eq!(record_note["annotations"]["readOnlyHint"], false);
        assert_eq!(record_note["annotations"]["destructiveHint"], false);
    }

    #[test]
    fn graph_resource_tool_arguments_are_strictly_validated() {
        let role = AgentBrokerRole::Worker {
            ticket: "TK-pinned".to_owned(),
            step: "implement".to_owned(),
            persona: "builder".to_owned(),
        };
        assert!(
            validate_tool_arguments(
                &role,
                "graph_context",
                json!({
                    "anchors": ["ND-root"],
                    "relations": ["contains"],
                    "direction": "incoming",
                    "max_depth": 0,
                    "node_types": ["system"]
                }),
            )
            .is_ok()
        );
        for invalid in [
            json!({"direction": "sideways"}),
            json!({"max_depth": -1}),
            json!({"max_depth": 1.5}),
            json!({"anchors": [""]}),
            json!({"anchors": (0..17).map(|index| format!("ND-{index}")).collect::<Vec<_>>() }),
            json!({"invented_scope": "all"}),
        ] {
            assert!(
                validate_tool_arguments(&role, "graph_context", invalid).is_err(),
                "invalid graph query reached dispatch"
            );
        }

        assert!(
            validate_tool_arguments(
                &role,
                "record_note",
                json!({
                    "node_id": "ND-root",
                    "kind": "rationale",
                    "body": "The existing seam keeps this change local.",
                    "supersedes": "NT-previous"
                }),
            )
            .is_ok()
        );
        for invalid in [
            json!({"node_id": "ND-root", "kind": "decision", "body": "text"}),
            json!({"node_id": " ", "kind": "nit", "body": "text"}),
            json!({"node_id": "ND-root", "kind": "nit", "body": "  "}),
            json!({"node_id": "ND-root", "kind": "nit", "body": "text", "supersedes": " "}),
            json!({"node_id": "ND-root", "kind": "nit", "body": "text", "state": "confirmed"}),
        ] {
            assert!(
                validate_tool_arguments(&role, "record_note", invalid).is_err(),
                "invalid advisory note reached dispatch"
            );
        }
    }

    #[test]
    fn graph_context_and_record_note_keep_their_model_facing_results() {
        let graph_context = json!({
            "nodes": [{"id": "ND-root", "type": "objective"}],
            "edges": [],
            "supplement_hash": "sha256:bounded"
        });
        assert_eq!(
            minimal_model_response("graph_context", graph_context.clone()).unwrap(),
            graph_context
        );

        let note = minimal_model_response(
            "record_note",
            json!({
                "accepted": true,
                "replayed": false,
                "authority": "advisory_non_authoritative",
                "note": {"id": "NT-new", "body": "private working detail"}
            }),
        )
        .unwrap();
        assert_eq!(note["status"], "accepted");
        assert_eq!(note["note_id"], "NT-new");
        assert_eq!(note["authority"], "advisory_non_authoritative");
        assert!(note.get("body").is_none());
    }

    #[test]
    fn tools_are_denied_until_the_full_handshake_completes() {
        let catalog = worker_catalog();
        let mut backend = FakeBackend::default();
        let responses = run_protocol(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}\n",
            &catalog,
            &mut backend,
        );
        assert_eq!(responses[0]["error"]["code"], -32600);
    }

    #[test]
    fn unsupported_protocol_does_not_initialize_the_server() {
        let catalog = worker_catalog();
        let mut backend = FakeBackend::default();
        let responses = run_protocol(
            concat!(
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"future-version\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1\"}}}\n",
                "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
                "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n"
            ),
            &catalog,
            &mut backend,
        );
        assert_eq!(responses[0]["error"]["code"], -32602);
        assert_eq!(responses[1]["error"]["code"], -32600);
    }

    #[test]
    fn duplicate_initialize_invalid_ids_and_extra_params_are_rejected() {
        let catalog = worker_catalog();
        let mut backend = FakeBackend::default();
        let input = format!(
            "{}{}{}{}",
            handshake(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"initialize\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":1.5,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/list\",\"params\":{\"cursor\":\"forged\"}}\n"
        );
        let responses = run_protocol(&input, &catalog, &mut backend);
        assert_eq!(responses[1]["error"]["code"], -32600);
        assert_eq!(responses[2]["error"]["code"], -32600);
        assert_eq!(responses[3]["error"]["code"], -32602);
        assert!(backend.calls.is_empty());
    }

    #[test]
    fn excessive_json_nesting_is_generic_and_does_not_kill_the_server() {
        let catalog = worker_catalog();
        let mut backend = FakeBackend::default();
        let nested = format!("{}0{}\n", "[".repeat(256), "]".repeat(256));
        let input = format!("{nested}{{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}}\n");
        let responses = run_protocol(&input, &catalog, &mut backend);
        assert_eq!(responses[0]["error"]["code"], -32700);
        assert_eq!(responses[1]["result"], json!({}));
    }

    #[test]
    fn malformed_and_oversized_frames_are_generic_and_server_recovers() {
        let catalog = worker_catalog();
        let mut backend = FakeBackend::default();
        let oversized = format!(
            "{{\"padding\":\"{}\"}}\n",
            "x".repeat(MAX_REQUEST_FRAME_BYTES)
        );
        let input =
            format!("not-json\n{oversized}{{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}}\n");
        let responses = run_protocol(&input, &catalog, &mut backend);
        assert_eq!(responses[0]["error"]["code"], -32700);
        assert_eq!(responses[1]["error"]["code"], -32600);
        assert_eq!(responses[2]["result"], json!({}));
    }

    #[test]
    fn cross_tool_and_scope_shaped_arguments_never_reach_dispatch() {
        let catalog = worker_catalog();
        let mut backend = FakeBackend::default();
        let input = format!(
            "{}{}{}",
            handshake(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"finish\",\"arguments\":{}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"context\",\"arguments\":{\"run\":\"other\",\"ticket\":\"other\"}}}\n"
        );
        let responses = run_protocol(&input, &catalog, &mut backend);
        assert!(
            responses[1..]
                .iter()
                .all(|response| response["result"]["isError"] == true)
        );
        assert!(backend.calls.is_empty());
    }

    #[test]
    fn single_ticket_lead_tools_have_no_ticket_selector() {
        let role = AgentBrokerRole::Lead {
            generation: 4,
            boundary: koni_core::LeadSliceBoundary::Finish {
                ticket: "TK-issued".to_owned(),
            },
        };
        let definition = tool_definition("finish", &role).unwrap();
        assert_eq!(
            definition["inputSchema"],
            json!({"type": "object", "additionalProperties": false})
        );
        assert!(validate_tool_arguments(&role, "finish", json!({"ticket": "TK-other"})).is_err());
    }

    #[test]
    fn dispatch_ticket_schema_enumerates_only_the_issued_batch() {
        let role = AgentBrokerRole::Lead {
            generation: 4,
            boundary: koni_core::LeadSliceBoundary::DispatchBatch {
                tickets: vec!["TK-a".to_owned(), "TK-b".to_owned()],
            },
        };
        let definition = tool_definition("start", &role).unwrap();
        assert_eq!(
            definition["inputSchema"]["properties"]["ticket"]["enum"],
            json!(["TK-a", "TK-b"])
        );
        let yield_definition = tool_definition("yield_lead", &role).unwrap();
        assert_eq!(
            yield_definition["inputSchema"]["properties"]["reason"]["enum"],
            json!(["boundary-complete", "paused", "capacity-reached"])
        );
        assert!(
            validate_tool_arguments(&role, "yield_lead", json!({"reason": "capacity-reached"}),)
                .is_ok()
        );
        assert!(
            validate_tool_arguments(&role, "yield_lead", json!({"reason": "invented"})).is_err()
        );
    }

    #[test]
    fn engine_errors_are_replaced_by_the_core_safe_diagnostic_dto() {
        struct RejectingBackend;
        impl BrokerBackend for RejectingBackend {
            fn call(&mut self, _tool: &str, _arguments: Value) -> Result<Value, KoniError> {
                Err(KoniError::Graph(
                    "SECRET_SENTINEL absolute /private/path".to_owned(),
                ))
            }
        }
        let catalog = worker_catalog();
        let mut backend = RejectingBackend;
        let input = format!(
            "{}{}",
            handshake(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"submit_and_compile\",\"arguments\":{\"payload\":{}}}}\n"
        );
        let responses = run_protocol(&input, &catalog, &mut backend);
        let text = responses[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(text.contains("validation_stop"));
        assert!(!text.contains("SECRET_SENTINEL"));
        assert!(!text.contains("/private/path"));
    }

    #[test]
    fn repeated_validation_rejections_stop_before_an_agent_can_loop_forever() {
        #[derive(Default)]
        struct RejectingBackend {
            calls: usize,
        }

        impl BrokerBackend for RejectingBackend {
            fn call(&mut self, _tool: &str, _arguments: Value) -> Result<Value, KoniError> {
                self.calls += 1;
                let diagnostic = match self.calls {
                    1 => "node SECRET_CHANGE_ID type change requires field scope",
                    2 => "node SECRET_PROOF_ID type proof field layer has the wrong type",
                    _ => {
                        "node SECRET_RISK_ID type risk requires field detection; offending_value=SECRET_VALUE /private/SECRET_PATH"
                    }
                };
                Err(KoniError::Graph(diagnostic.to_owned()))
            }
        }

        let catalog = worker_catalog();
        let mut backend = RejectingBackend::default();
        let requests = (2..=6)
            .map(|id| {
                format!(
                    "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"tools/call\",\"params\":{{\"name\":\"submit_and_compile\",\"arguments\":{{\"payload\":{{}}}}}}}}\n"
                )
            })
            .collect::<String>();
        let responses = run_protocol(
            &format!("{}{requests}", handshake()),
            &catalog,
            &mut backend,
        );
        let errors = responses[1..]
            .iter()
            .map(|response| {
                serde_json::from_str::<Value>(
                    response["result"]["content"][0]["text"].as_str().unwrap(),
                )
                .unwrap()
            })
            .collect::<Vec<_>>();

        assert_eq!(
            backend.calls, 3,
            "later retries must not reach the compiler"
        );
        assert_eq!(errors[0]["code"], "revise_validation");
        assert_eq!(errors[1]["code"], "revise_validation");
        for error in &errors[2..] {
            assert_eq!(error["code"], "validation_retry_limit");
            assert_eq!(error["retryable"], false);
            let message = error["message"].as_str().unwrap();
            assert!(message.contains("Stop this agent"));
            assert!(message.contains("Final compiler correction:"));
            assert!(message.contains("node type `risk` is missing required field `detection`"));
            for secret in [
                "SECRET_CHANGE_ID",
                "SECRET_PROOF_ID",
                "SECRET_RISK_ID",
                "SECRET_VALUE",
                "/private/SECRET_PATH",
                "offending_value",
            ] {
                assert!(!message.contains(secret), "leaked {secret}: {message}");
            }
        }
    }

    #[test]
    fn zero_argument_review_rejections_stop_instead_of_retrying() {
        struct RejectingReviewBackend;
        impl BrokerBackend for RejectingReviewBackend {
            fn call(&mut self, _tool: &str, _arguments: Value) -> Result<Value, KoniError> {
                Err(KoniError::Action(
                    "SECRET_SENTINEL has no dependency-ready configured review step".to_owned(),
                ))
            }
        }
        let catalog = ToolCatalog::new(
            AgentBrokerRole::Lead {
                generation: 7,
                boundary: koni_core::LeadSliceBoundary::Review {
                    ticket: "TK-issued".to_owned(),
                },
            },
            ["review"].into_iter().map(str::to_owned).collect(),
        )
        .unwrap();
        let mut backend = RejectingReviewBackend;
        let input = format!(
            "{}{}",
            handshake(),
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"review\",\"arguments\":{}}}\n"
        );
        let responses = run_protocol(&input, &catalog, &mut backend);
        let text = responses[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(text.contains("review_boundary_stop"));
        assert!(text.contains("\"retryable\":false"));
        assert!(!text.contains("SECRET_SENTINEL"));
    }

    #[test]
    fn repeated_context_is_a_compact_recovery_pointer() {
        let response = minimal_model_response(
            "context",
            json!({
                "status": "already_issued",
                "document_path": "program/work/tickets/TK-test/context/context.md",
                "message": "Use the first response.",
            }),
        )
        .unwrap();
        assert_eq!(response["status"], "already_issued");
        assert_eq!(
            response["document_path"],
            "program/work/tickets/TK-test/context/context.md"
        );
        assert!(response.get("document").is_none());
    }
}
