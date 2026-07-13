//! Process-bound MCP broker for compiler-owned Codex agents.
//!
//! The command line contains only an opaque one-time grant and the durable
//! agent attempt that Codex is expected to parent. All semantic authority is
//! recovered from the claimed grant and revalidated by the core on every call.

use anyhow::Context;
use koni_core::{
    AgentBrokerIngress, AgentBrokerRole, KoniError, agent_mcp_safe_error, claim_agent_mcp_grant,
    execute_agent_mcp_tool,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io::{BufRead, Write};

const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_CLIENT_PROTOCOLS: &[&str] = &[PROTOCOL_VERSION, "2025-11-25"];
const MAX_REQUEST_FRAME_BYTES: usize = 2 * 1024 * 1024;
// Core caps the serialized tool value at 16 MiB. Embedding that JSON as MCP
// text can escape it once more, so reserve more than twice that bounded size.
const MAX_RESPONSE_FRAME_BYTES: usize = 34 * 1024 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 128;

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
        execute_agent_mcp_tool(self.ingress, tool, arguments)
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
        (AgentBrokerRole::Worker { .. }, "submit_output") => {
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
                    matches!(reason.as_str(), "boundary-complete" | "paused"),
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

fn minimal_model_response(tool: &str, value: Value) -> anyhow::Result<Value> {
    match tool {
        "context" => {
            let document = value
                .get("document")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("context response is missing its document"))?;
            Ok(json!({"document": document}))
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
            "tools/list" if empty_params(object.get("params")) => jsonrpc_result(
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
                        Ok(arguments) => match backend.call(name, arguments) {
                            Ok(value) => match minimal_model_response(name, value) {
                                Ok(value) => tool_success_result(id, value),
                                Err(_) => tool_error_result(id, safe_tool_error(name)),
                            },
                            Err(error) => tool_error_result(
                                id,
                                serde_json::to_string(&agent_mcp_safe_error(&error))
                                    .unwrap_or_else(|_| {
                                        "{\"code\":\"internal_stop\",\"message\":\"Stop this agent and let the supervisor recover.\",\"retryable\":false}".to_owned()
                                    }),
                            ),
                        },
                    },
                    None => jsonrpc_error(id, -32602, "tools/call requires a tool name"),
                }
            }
            _ => jsonrpc_error(id, -32601, "unknown method"),
        };
        write_response(&mut writer, response)?;
    }
}

fn safe_tool_error(tool: &str) -> &'static str {
    match tool {
        "context" => "context_unavailable: the compiler could not provide this step context",
        "submit_output" => {
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
            "Return this completed Lead boundary to the supervisor and stop.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "reason": {
                        "type": "string",
                        "enum": ["boundary-complete", "paused"]
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
            ["context", "submit_output", "compile"]
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
        assert_eq!(names, ["context", "submit_output", "compile"]);
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
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"compile\",\"arguments\":{}}}\n"
        );
        let responses = run_protocol(&input, &catalog, &mut backend);
        let text = responses[1]["result"]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert!(text.contains("revise_validation"));
        assert!(!text.contains("SECRET_SENTINEL"));
        assert!(!text.contains("/private/path"));
    }
}
