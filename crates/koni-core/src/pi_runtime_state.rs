//! Rust-owned semantic state machine for the untrusted Pi host protocol.
//!
//! Directional sequence numbers protect framing order, but they do not prove
//! that a response, event, or tool call is valid for the compiler's current
//! request/turn. This module supplies that higher-level fail-closed contract.

use std::collections::{BTreeMap, BTreeSet};

use crate::agent_runtime::{
    PiRuntimeFailure, RuntimeCommand, RuntimeEvent, RuntimeInbound, RuntimeResponse, RuntimeUsage,
};
use crate::agent_tool_broker::AgentToolOutcome;
use crate::error::{KoniError, Result};

const MAX_TURN_EVENTS: usize = 4_096;
const MAX_TURN_EVENT_BYTES: usize = 16 * 1024 * 1024;
const MAX_TURN_MESSAGES: usize = 256;
const MAX_TURN_TOOL_CALLS: usize = 256;

#[derive(Debug, Clone)]
enum PendingRequest {
    Models,
    Metadata,
    StartSession {
        tools: BTreeSet<String>,
    },
    StartTurn {
        turn_id: String,
        output_token_budget: Option<u64>,
    },
    Control,
    Authenticate,
    Shutdown,
}

#[derive(Debug, Clone)]
struct ActiveTurn {
    id: String,
    started: bool,
    declared_tools: BTreeSet<String>,
    announced_tools: BTreeMap<String, String>,
    returned_tools: BTreeMap<String, AgentToolOutcome>,
    completed_tools: BTreeSet<String>,
    completed_messages: BTreeSet<String>,
    usage: RuntimeUsage,
    runtime_error: bool,
    output_token_budget: Option<u64>,
    terminal_tool_call_id: Option<String>,
    event_count: usize,
    event_bytes: usize,
}

#[derive(Debug, Default)]
pub(crate) struct PiRuntimeStateMachine {
    pending: BTreeMap<String, PendingRequest>,
    session_started: bool,
    declared_tools: BTreeSet<String>,
    active_turn: Option<ActiveTurn>,
    terminal_turns: BTreeSet<String>,
}

impl PiRuntimeStateMachine {
    pub(crate) fn register_command(
        &mut self,
        request_id: &str,
        command: &RuntimeCommand,
    ) -> Result<()> {
        if self.pending.contains_key(request_id) {
            return Err(state_error(format!(
                "duplicate outbound request id {request_id}"
            )));
        }
        if !self.pending.is_empty() {
            return Err(state_error(
                "a public runtime request is already awaiting its response",
            ));
        }
        let pending = match command {
            RuntimeCommand::ListModels => PendingRequest::Models,
            RuntimeCommand::Metadata => PendingRequest::Metadata,
            RuntimeCommand::StartSession { request } => {
                if self.session_started || self.active_turn.is_some() {
                    return Err(state_error("runtime session was already started"));
                }
                let tools = request
                    .tools
                    .iter()
                    .map(|tool| tool.name.clone())
                    .collect::<BTreeSet<_>>();
                if tools.len() != request.tools.len() {
                    return Err(state_error("runtime session declares duplicate tools"));
                }
                PendingRequest::StartSession { tools }
            }
            RuntimeCommand::StartTurn { request } => {
                if !self.session_started {
                    return Err(state_error("runtime turn began before its session"));
                }
                if self.active_turn.is_some() || self.terminal_turns.contains(&request.turn_id) {
                    return Err(state_error(format!(
                        "runtime turn id {} is active or was already terminal",
                        request.turn_id
                    )));
                }
                PendingRequest::StartTurn {
                    turn_id: request.turn_id.clone(),
                    output_token_budget: request.output_token_budget,
                }
            }
            RuntimeCommand::Control { .. } => {
                if self.active_turn.is_none() {
                    return Err(state_error("runtime control has no active turn"));
                }
                PendingRequest::Control
            }
            RuntimeCommand::Authenticate { .. } => {
                if self.active_turn.is_some() {
                    return Err(state_error(
                        "authentication cannot overlap an inference turn",
                    ));
                }
                PendingRequest::Authenticate
            }
            RuntimeCommand::Shutdown => PendingRequest::Shutdown,
        };
        self.pending.insert(request_id.to_owned(), pending);
        Ok(())
    }

    pub(crate) fn accept_inbound(&mut self, inbound: &RuntimeInbound) -> Result<()> {
        match inbound {
            RuntimeInbound::Response {
                request_id,
                response,
                ..
            } => self.accept_response(request_id, response),
            RuntimeInbound::Event { event, .. } => self.accept_event(event),
            RuntimeInbound::ToolCall { call, .. } => {
                let turn = self.active_turn_mut("tool call")?;
                if turn.terminal_tool_call_id.is_some() {
                    return Err(state_error(
                        "tool call arrived after a compiler-terminal tool result",
                    ));
                }
                let Some(name) = turn.announced_tools.get(&call.call_id) else {
                    return Err(state_error(format!(
                        "tool call {} was not announced by the active turn",
                        call.call_id
                    )));
                };
                if name != &call.name || !turn.declared_tools.contains(&call.name) {
                    return Err(state_error(format!(
                        "tool call {} requested undeclared or mismatched tool {}",
                        call.call_id, call.name
                    )));
                }
                if turn.returned_tools.contains_key(&call.call_id)
                    || turn.completed_tools.contains(&call.call_id)
                {
                    return Err(state_error(format!(
                        "duplicate tool call id {}",
                        call.call_id
                    )));
                }
                if turn.announced_tools.len() > MAX_TURN_TOOL_CALLS {
                    return Err(state_error("runtime exceeded the per-turn tool-call limit"));
                }
                Ok(())
            }
        }
    }

    pub(crate) fn record_tool_result(
        &mut self,
        call_id: &str,
        outcome: &AgentToolOutcome,
    ) -> Result<()> {
        let turn = self.active_turn_mut("tool result")?;
        if !turn.announced_tools.contains_key(call_id)
            || turn.returned_tools.contains_key(call_id)
            || turn.completed_tools.contains(call_id)
        {
            return Err(state_error(format!(
                "tool result {call_id} does not match one fresh active call"
            )));
        }
        turn.returned_tools
            .insert(call_id.to_owned(), outcome.clone());
        if outcome.is_terminal() {
            if turn.terminal_tool_call_id.is_some() {
                return Err(state_error(
                    "more than one compiler-terminal tool result was recorded",
                ));
            }
            turn.terminal_tool_call_id = Some(call_id.to_owned());
        }
        Ok(())
    }

    fn accept_response(&mut self, request_id: &str, response: &RuntimeResponse) -> Result<()> {
        let pending = self
            .pending
            .remove(request_id)
            .ok_or_else(|| state_error(format!("unknown or duplicate response id {request_id}")))?;
        if let RuntimeResponse::Rejected { .. } = response {
            return Ok(());
        }
        match (pending, response) {
            (PendingRequest::Models, RuntimeResponse::Models { .. })
            | (PendingRequest::Metadata, RuntimeResponse::Metadata { .. })
            | (PendingRequest::Control, RuntimeResponse::Accepted)
            | (PendingRequest::Authenticate, RuntimeResponse::Authentication { .. })
            | (PendingRequest::Shutdown, RuntimeResponse::Accepted) => Ok(()),
            (PendingRequest::StartSession { tools }, RuntimeResponse::SessionStarted { .. }) => {
                self.session_started = true;
                self.declared_tools = tools;
                Ok(())
            }
            (
                PendingRequest::StartTurn {
                    turn_id,
                    output_token_budget,
                },
                RuntimeResponse::Accepted,
            ) => {
                self.active_turn = Some(ActiveTurn {
                    id: turn_id,
                    started: false,
                    declared_tools: self.declared_tools.clone(),
                    announced_tools: BTreeMap::new(),
                    returned_tools: BTreeMap::new(),
                    completed_tools: BTreeSet::new(),
                    completed_messages: BTreeSet::new(),
                    usage: RuntimeUsage::default(),
                    runtime_error: false,
                    output_token_budget,
                    terminal_tool_call_id: None,
                    event_count: 0,
                    event_bytes: 0,
                });
                Ok(())
            }
            (expected, actual) => Err(state_error(format!(
                "response kind {actual:?} does not match pending request {expected:?}"
            ))),
        }
    }

    fn accept_event(&mut self, event: &RuntimeEvent) -> Result<()> {
        if matches!(event, RuntimeEvent::Authentication { .. }) {
            if self
                .pending
                .values()
                .any(|pending| matches!(pending, PendingRequest::Authenticate))
            {
                return Ok(());
            }
            return Err(state_error(
                "authentication interaction has no pending auth request",
            ));
        }
        let event_turn_id = event_turn_id(event)
            .ok_or_else(|| state_error("non-authentication runtime event has no turn identity"))?;
        let encoded_bytes = serde_json::to_vec(event)
            .map_err(|error| state_error(format!("could not size runtime event: {error}")))?
            .len();
        let turn = self.active_turn_mut("runtime event")?;
        turn.event_count = turn
            .event_count
            .checked_add(1)
            .ok_or_else(|| state_error("runtime event count overflow"))?;
        turn.event_bytes = turn
            .event_bytes
            .checked_add(encoded_bytes)
            .ok_or_else(|| state_error("runtime event byte count overflow"))?;
        if turn.event_count > MAX_TURN_EVENTS || turn.event_bytes > MAX_TURN_EVENT_BYTES {
            return Err(state_error(
                "runtime exceeded the bounded per-turn public event transcript",
            ));
        }
        if event_turn_id != turn.id {
            return Err(state_error(format!(
                "cross-turn event: active {}, received {event_turn_id}",
                turn.id
            )));
        }
        if let Some(terminal_call_id) = turn.terminal_tool_call_id.as_deref() {
            let allowed = matches!(
                event,
                RuntimeEvent::ToolCompleted { call_id, .. } if call_id == terminal_call_id
            ) || matches!(
                event,
                RuntimeEvent::TurnCompleted { .. } | RuntimeEvent::RuntimeError { .. }
            );
            if !allowed {
                return Err(state_error(format!(
                    "runtime event arrived after compiler-terminal tool {terminal_call_id}"
                )));
            }
        }
        match event {
            RuntimeEvent::TurnStarted { .. } => {
                if turn.started {
                    return Err(state_error("duplicate turn_started event"));
                }
                turn.started = true;
                Ok(())
            }
            _ if !turn.started => Err(state_error("runtime event arrived before turn_started")),
            RuntimeEvent::MessageDelta { message_id, .. } => {
                if turn.completed_messages.contains(message_id) {
                    return Err(state_error(format!(
                        "message delta arrived after completion for {message_id}"
                    )));
                }
                Ok(())
            }
            RuntimeEvent::MessageCompleted { message_id, .. } => {
                if turn.completed_messages.len() >= MAX_TURN_MESSAGES {
                    return Err(state_error("runtime exceeded the per-turn message limit"));
                }
                if !turn.completed_messages.insert(message_id.clone()) {
                    return Err(state_error(format!(
                        "duplicate completed message {message_id}"
                    )));
                }
                Ok(())
            }
            RuntimeEvent::ToolStarted { call_id, name, .. } => {
                if turn.announced_tools.len() >= MAX_TURN_TOOL_CALLS {
                    return Err(state_error("runtime exceeded the per-turn tool-call limit"));
                }
                if !turn.declared_tools.contains(name)
                    || turn
                        .announced_tools
                        .insert(call_id.clone(), name.clone())
                        .is_some()
                    || turn.completed_tools.contains(call_id)
                {
                    return Err(state_error(format!(
                        "duplicate or undeclared tool start {call_id}:{name}"
                    )));
                }
                Ok(())
            }
            RuntimeEvent::ToolUpdated { call_id, .. } => {
                if !turn.announced_tools.contains_key(call_id)
                    || turn.completed_tools.contains(call_id)
                {
                    return Err(state_error(format!(
                        "tool update {call_id} has no active call"
                    )));
                }
                Ok(())
            }
            RuntimeEvent::ToolCompleted {
                call_id, outcome, ..
            } => {
                if turn.returned_tools.get(call_id) != Some(outcome)
                    || !turn.completed_tools.insert(call_id.clone())
                {
                    return Err(state_error(format!(
                        "tool completion {call_id} does not match its broker result"
                    )));
                }
                Ok(())
            }
            RuntimeEvent::ToolRejected {
                call_id,
                name,
                code,
                ..
            } => {
                if code.trim().is_empty()
                    || turn.announced_tools.get(call_id) != Some(name)
                    || turn.returned_tools.contains_key(call_id)
                    || !turn.completed_tools.insert(call_id.clone())
                {
                    return Err(state_error(format!(
                        "tool rejection {call_id}:{name} is not one fresh host-local validation failure"
                    )));
                }
                Ok(())
            }
            RuntimeEvent::Usage { usage, .. } => {
                let output_token_budget = turn.output_token_budget;
                add_usage(&mut turn.usage, usage, output_token_budget)
            }
            RuntimeEvent::TurnCompleted {
                stop_reason, usage, ..
            } => {
                if !turn
                    .announced_tools
                    .keys()
                    .all(|call_id| turn.completed_tools.contains(call_id))
                {
                    return Err(state_error(
                        "turn completed with an unfinished compiler-brokered tool call",
                    ));
                }
                if &turn.usage != usage {
                    return Err(state_error(
                        "terminal usage does not match checked incremental usage",
                    ));
                }
                if turn.runtime_error && !matches!(stop_reason.as_str(), "error" | "aborted") {
                    return Err(state_error(
                        "runtime failure was reconciled with a successful stop reason",
                    ));
                }
                let id = turn.id.clone();
                self.active_turn = None;
                if !self.terminal_turns.insert(id) {
                    return Err(state_error("duplicate terminal turn event"));
                }
                Ok(())
            }
            RuntimeEvent::RuntimeError {
                code,
                message,
                retryable,
                ..
            } => {
                if PiRuntimeFailure::from_wire(code, message, *retryable).is_none() {
                    return Err(state_error(
                        "runtime error tuple is not in the compiler allowlist",
                    ));
                }
                if std::mem::replace(&mut turn.runtime_error, true) {
                    return Err(state_error("duplicate runtime error event"));
                }
                Ok(())
            }
            RuntimeEvent::Retry { .. } | RuntimeEvent::Compaction { .. } => Ok(()),
            RuntimeEvent::Authentication { .. } => {
                unreachable!("handled above")
            }
        }
    }

    fn active_turn_mut(&mut self, subject: &str) -> Result<&mut ActiveTurn> {
        self.active_turn
            .as_mut()
            .ok_or_else(|| state_error(format!("{subject} has no accepted active turn")))
    }
}

fn event_turn_id(event: &RuntimeEvent) -> Option<&str> {
    match event {
        RuntimeEvent::TurnStarted { turn_id }
        | RuntimeEvent::MessageDelta { turn_id, .. }
        | RuntimeEvent::MessageCompleted { turn_id, .. }
        | RuntimeEvent::ToolStarted { turn_id, .. }
        | RuntimeEvent::ToolUpdated { turn_id, .. }
        | RuntimeEvent::ToolCompleted { turn_id, .. }
        | RuntimeEvent::ToolRejected { turn_id, .. }
        | RuntimeEvent::Usage { turn_id, .. }
        | RuntimeEvent::Retry { turn_id, .. }
        | RuntimeEvent::Compaction { turn_id, .. }
        | RuntimeEvent::TurnCompleted { turn_id, .. } => Some(turn_id),
        RuntimeEvent::RuntimeError {
            turn_id: Some(turn_id),
            ..
        } => Some(turn_id),
        RuntimeEvent::RuntimeError { turn_id: None, .. } | RuntimeEvent::Authentication { .. } => {
            None
        }
    }
}

fn add_usage(
    total: &mut RuntimeUsage,
    delta: &RuntimeUsage,
    output_token_budget: Option<u64>,
) -> Result<()> {
    let next = RuntimeUsage {
        input_tokens: checked_add(total.input_tokens, delta.input_tokens, "input")?,
        cached_input_tokens: checked_add(
            total.cached_input_tokens,
            delta.cached_input_tokens,
            "cached input",
        )?,
        output_tokens: checked_add(total.output_tokens, delta.output_tokens, "output")?,
        reasoning_tokens: checked_add(total.reasoning_tokens, delta.reasoning_tokens, "reasoning")?,
        total_tokens: checked_add(total.total_tokens, delta.total_tokens, "total")?,
    };
    if next.reasoning_tokens > next.output_tokens {
        return Err(state_error("runtime reasoning tokens exceed output tokens"));
    }
    if output_token_budget.is_some_and(|budget| next.output_tokens > budget) {
        return Err(state_error(
            "runtime output usage exceeded the compiler-issued token cap",
        ));
    }
    let visible_total = next
        .input_tokens
        .checked_add(next.cached_input_tokens)
        .and_then(|sum| sum.checked_add(next.output_tokens))
        .ok_or_else(|| state_error("runtime visible token usage overflow"))?;
    if visible_total > next.total_tokens {
        return Err(state_error(
            "runtime visible token buckets exceed provider total tokens",
        ));
    }
    *total = next;
    Ok(())
}

fn checked_add(left: u64, right: u64, label: &str) -> Result<u64> {
    left.checked_add(right)
        .ok_or_else(|| state_error(format!("runtime {label} token usage overflow")))
}

fn state_error(message: impl Into<String>) -> KoniError {
    KoniError::Process(format!("Pi runtime state error: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_runtime::{
        RuntimeModelRef, RuntimeSessionStart, RuntimeThinkingLevel, RuntimeToolDefinition,
        RuntimeTurnRequest,
    };
    use crate::pi_auth::CredentialLeaseId;
    use serde_json::json;

    fn session() -> RuntimeSessionStart {
        RuntimeSessionStart {
            session_id: "session-1".to_owned(),
            run_id: "run-1".to_owned(),
            agent_id: "agent-1".to_owned(),
            attempt: 1,
            model: RuntimeModelRef {
                provider: "openai-codex".to_owned(),
                model: "model-1".to_owned(),
                thinking_level: RuntimeThinkingLevel::High,
                input_capabilities: vec!["text".to_owned()],
                context_window: Some(1000),
            },
            instructions: "work".to_owned(),
            tools: vec![RuntimeToolDefinition {
                name: "context".to_owned(),
                description: "context".to_owned(),
                input_schema: json!({"type":"object"}),
            }],
            terminal_boundary_tools: Vec::new(),
            context_completion_required: false,
            credential_lease: CredentialLeaseId("lease-1".to_owned()),
        }
    }

    fn response(request_id: &str, response: RuntimeResponse) -> RuntimeInbound {
        RuntimeInbound::Response {
            sequence: 1,
            request_id: request_id.to_owned(),
            response,
        }
    }

    fn event(event: RuntimeEvent) -> RuntimeInbound {
        RuntimeInbound::Event { sequence: 1, event }
    }

    fn started_machine() -> PiRuntimeStateMachine {
        let mut state = PiRuntimeStateMachine::default();
        state
            .register_command(
                "start",
                &RuntimeCommand::StartSession { request: session() },
            )
            .unwrap();
        state
            .accept_inbound(&response(
                "start",
                RuntimeResponse::SessionStarted {
                    session: crate::agent_runtime::RuntimeSessionRef {
                        runtime: "pi-sdk".to_owned(),
                        protocol_version: 1,
                        provider: "openai-codex".to_owned(),
                        model: "model-1".to_owned(),
                        session_id: "session-1".to_owned(),
                    },
                },
            ))
            .unwrap();
        state
    }

    fn begin_turn(state: &mut PiRuntimeStateMachine) {
        begin_turn_with_budget(state, None);
    }

    fn begin_turn_with_budget(state: &mut PiRuntimeStateMachine, output_token_budget: Option<u64>) {
        state
            .register_command(
                "turn-request",
                &RuntimeCommand::StartTurn {
                    request: RuntimeTurnRequest {
                        turn_id: "turn-1".to_owned(),
                        input: vec![],
                        output_schema: None,
                        output_token_budget,
                    },
                },
            )
            .unwrap();
        state
            .accept_inbound(&response("turn-request", RuntimeResponse::Accepted))
            .unwrap();
        state
            .accept_inbound(&event(RuntimeEvent::TurnStarted {
                turn_id: "turn-1".to_owned(),
            }))
            .unwrap();
    }

    #[test]
    fn rejects_unknown_wrong_kind_and_duplicate_responses() {
        let mut state = PiRuntimeStateMachine::default();
        assert!(
            state
                .accept_inbound(&response("unknown", RuntimeResponse::Accepted))
                .is_err()
        );
        state
            .register_command("models", &RuntimeCommand::ListModels)
            .unwrap();
        assert!(
            state
                .accept_inbound(&response("models", RuntimeResponse::Accepted))
                .is_err()
        );
    }

    #[test]
    fn rejects_events_before_turn_cross_turn_and_after_terminal() {
        let mut state = started_machine();
        assert!(
            state
                .accept_inbound(&event(RuntimeEvent::TurnStarted {
                    turn_id: "turn-1".to_owned()
                }))
                .is_err()
        );
        begin_turn(&mut state);
        assert!(
            state
                .accept_inbound(&event(RuntimeEvent::MessageDelta {
                    turn_id: "other".to_owned(),
                    message_id: "message-1".to_owned(),
                    text: "x".to_owned(),
                }))
                .is_err()
        );
        state
            .accept_inbound(&event(RuntimeEvent::TurnCompleted {
                turn_id: "turn-1".to_owned(),
                stop_reason: "stop".to_owned(),
                usage: RuntimeUsage::default(),
            }))
            .unwrap();
        assert!(
            state
                .accept_inbound(&event(RuntimeEvent::TurnCompleted {
                    turn_id: "turn-1".to_owned(),
                    stop_reason: "stop".to_owned(),
                    usage: RuntimeUsage::default(),
                }))
                .is_err()
        );
    }

    #[test]
    fn terminal_may_race_a_control_but_correlated_response_is_still_consumed() {
        let mut state = started_machine();
        begin_turn(&mut state);
        state
            .register_command(
                "control-1",
                &RuntimeCommand::Control {
                    control: crate::agent_runtime::RuntimeControl::Cancel {
                        reason: "operator".to_owned(),
                    },
                },
            )
            .unwrap();
        let terminal = event(RuntimeEvent::TurnCompleted {
            turn_id: "turn-1".to_owned(),
            stop_reason: "aborted".to_owned(),
            usage: RuntimeUsage::default(),
        });
        state.accept_inbound(&terminal).unwrap();
        state
            .accept_inbound(&response("control-1", RuntimeResponse::Accepted))
            .unwrap();
        assert!(
            state
                .accept_inbound(&response("control-1", RuntimeResponse::Accepted))
                .is_err()
        );
    }

    #[test]
    fn runtime_error_requires_error_terminal_reconciliation() {
        let mut state = started_machine();
        begin_turn(&mut state);
        state
            .accept_inbound(&event(RuntimeEvent::RuntimeError {
                turn_id: Some("turn-1".to_owned()),
                code: "provider_error".to_owned(),
                message: "OpenAI Codex failed for an unclassified reason. Retry manually; if it repeats, reauthenticate and check service status.".to_owned(),
                retryable: false,
            }))
            .unwrap();
        assert!(
            state
                .accept_inbound(&event(RuntimeEvent::TurnCompleted {
                    turn_id: "turn-1".to_owned(),
                    stop_reason: "stop".to_owned(),
                    usage: RuntimeUsage::default(),
                }))
                .is_err()
        );
        state
            .accept_inbound(&event(RuntimeEvent::TurnCompleted {
                turn_id: "turn-1".to_owned(),
                stop_reason: "error".to_owned(),
                usage: RuntimeUsage::default(),
            }))
            .unwrap();
    }

    #[test]
    fn runtime_error_requires_one_exact_canonical_tuple() {
        let valid = [
            (
                "provider_usage_limit",
                "Your ChatGPT Codex usage limit has been reached. Wait for it to reset, then resume the run.",
                false,
            ),
            (
                "provider_authentication",
                "OpenAI Codex rejected the stored sign-in. Run koni auth login, then resume the run.",
                false,
            ),
            (
                "provider_access_denied",
                "OpenAI Codex denied this account or model. Check ChatGPT subscription and model access, then retry.",
                false,
            ),
            (
                "provider_request_rejected",
                "OpenAI Codex rejected the request. Check the selected model and Koni runtime compatibility before retrying.",
                false,
            ),
            (
                "provider_rate_limited",
                "OpenAI Codex is temporarily rate-limiting requests. Retry after a short delay.",
                true,
            ),
            (
                "provider_unavailable",
                "OpenAI Codex is temporarily unavailable. Retry this turn.",
                true,
            ),
            (
                "provider_error",
                "OpenAI Codex failed for an unclassified reason. Retry manually; if it repeats, reauthenticate and check service status.",
                false,
            ),
            (
                "runtime_broker_timeout",
                "The compiler tool broker did not respond in time. Inspect the run state, then resume safely.",
                false,
            ),
            (
                "runtime_credential_channel",
                "The Pi runtime private credential channel is unavailable.",
                false,
            ),
            (
                "runtime_output_limit",
                "The agent response was too large for this run's output allowance. Its transcript was preserved; start a larger run or revise the run-type limits before retrying.",
                false,
            ),
            (
                "runtime_protocol_error",
                "The Pi runtime protocol failed closed. Restart Koni before resuming the run.",
                false,
            ),
            (
                "runtime_unsupported",
                "This Koni installation cannot run the requested Pi operation. Update Koni before retrying.",
                false,
            ),
            (
                "runtime_internal",
                "The Pi runtime failed internally. Retry manually; if it repeats, inspect Koni diagnostics.",
                false,
            ),
        ];
        for (code, message, retryable) in valid {
            let mut state = started_machine();
            begin_turn(&mut state);
            state
                .accept_inbound(&event(RuntimeEvent::RuntimeError {
                    turn_id: Some("turn-1".to_owned()),
                    code: code.to_owned(),
                    message: message.to_owned(),
                    retryable,
                }))
                .unwrap_or_else(|error| panic!("valid tuple {code} was rejected: {error}"));
        }

        for (code, message, retryable) in [
            (
                "provider_unknown",
                "OpenAI Codex is temporarily unavailable. Retry this turn.",
                true,
            ),
            ("provider_unavailable", "arbitrary-provider-secret", true),
            (
                "provider_unavailable",
                "OpenAI Codex is temporarily unavailable. Retry this turn.",
                false,
            ),
        ] {
            let mut state = started_machine();
            begin_turn(&mut state);
            let error = state
                .accept_inbound(&event(RuntimeEvent::RuntimeError {
                    turn_id: Some("turn-1".to_owned()),
                    code: code.to_owned(),
                    message: message.to_owned(),
                    retryable,
                }))
                .expect_err("mismatched runtime failure must fail closed");
            assert!(!error.to_string().contains("arbitrary-provider-secret"));
        }
    }

    #[test]
    fn tool_calls_are_declared_unique_and_exactly_bound_to_results() {
        let mut state = started_machine();
        begin_turn(&mut state);
        state
            .accept_inbound(&event(RuntimeEvent::ToolStarted {
                turn_id: "turn-1".to_owned(),
                call_id: "call-1".to_owned(),
                name: "context".to_owned(),
            }))
            .unwrap();
        let call = RuntimeInbound::ToolCall {
            sequence: 2,
            call: crate::agent_tool_broker::AgentToolCall {
                call_id: "call-1".to_owned(),
                name: "context".to_owned(),
                arguments: json!({}),
            },
        };
        state.accept_inbound(&call).unwrap();
        let outcome = AgentToolOutcome::Success {
            value: json!({"ok":true}),
        };
        state.record_tool_result("call-1", &outcome).unwrap();
        state
            .accept_inbound(&event(RuntimeEvent::ToolCompleted {
                turn_id: "turn-1".to_owned(),
                call_id: "call-1".to_owned(),
                outcome,
            }))
            .unwrap();
        assert!(state.accept_inbound(&call).is_err());
    }

    #[test]
    fn usage_is_checked_for_overflow_subcounts_and_terminal_equality() {
        let mut state = started_machine();
        begin_turn(&mut state);
        let usage = RuntimeUsage {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 5,
            reasoning_tokens: 1,
            total_tokens: 17,
        };
        state
            .accept_inbound(&event(RuntimeEvent::Usage {
                turn_id: "turn-1".to_owned(),
                usage: usage.clone(),
            }))
            .unwrap();
        let mut wrong = usage.clone();
        wrong.total_tokens += 1;
        assert!(
            state
                .accept_inbound(&event(RuntimeEvent::TurnCompleted {
                    turn_id: "turn-1".to_owned(),
                    stop_reason: "stop".to_owned(),
                    usage: wrong,
                }))
                .is_err()
        );

        let mut overflow = started_machine();
        begin_turn(&mut overflow);
        overflow.active_turn.as_mut().unwrap().usage.total_tokens = u64::MAX;
        assert!(
            overflow
                .accept_inbound(&event(RuntimeEvent::Usage {
                    turn_id: "turn-1".to_owned(),
                    usage: RuntimeUsage {
                        total_tokens: 1,
                        ..RuntimeUsage::default()
                    },
                }))
                .is_err()
        );
    }

    #[test]
    fn usage_allows_separate_cache_bucket_but_enforces_output_cap_and_visible_total() {
        let mut cached = started_machine();
        begin_turn_with_budget(&mut cached, Some(10));
        cached
            .accept_inbound(&event(RuntimeEvent::Usage {
                turn_id: "turn-1".to_owned(),
                usage: RuntimeUsage {
                    input_tokens: 1,
                    cached_input_tokens: 100,
                    output_tokens: 10,
                    reasoning_tokens: 3,
                    total_tokens: 111,
                },
            }))
            .unwrap();

        let mut over_budget = started_machine();
        begin_turn_with_budget(&mut over_budget, Some(9));
        assert!(
            over_budget
                .accept_inbound(&event(RuntimeEvent::Usage {
                    turn_id: "turn-1".to_owned(),
                    usage: RuntimeUsage {
                        output_tokens: 10,
                        total_tokens: 10,
                        ..RuntimeUsage::default()
                    },
                }))
                .is_err()
        );

        let mut inconsistent = started_machine();
        begin_turn(&mut inconsistent);
        assert!(
            inconsistent
                .accept_inbound(&event(RuntimeEvent::Usage {
                    turn_id: "turn-1".to_owned(),
                    usage: RuntimeUsage {
                        input_tokens: 5,
                        output_tokens: 5,
                        total_tokens: 9,
                        ..RuntimeUsage::default()
                    },
                }))
                .is_err()
        );

        let mut underreported_cache = started_machine();
        begin_turn(&mut underreported_cache);
        assert!(
            underreported_cache
                .accept_inbound(&event(RuntimeEvent::Usage {
                    turn_id: "turn-1".to_owned(),
                    usage: RuntimeUsage {
                        cached_input_tokens: 100,
                        output_tokens: 100,
                        total_tokens: 1,
                        ..RuntimeUsage::default()
                    },
                }))
                .is_err()
        );
    }

    #[test]
    fn compiler_terminal_tool_latches_before_another_broker_call() {
        let mut state = started_machine();
        begin_turn(&mut state);
        state
            .accept_inbound(&event(RuntimeEvent::ToolStarted {
                turn_id: "turn-1".to_owned(),
                call_id: "terminal-call".to_owned(),
                name: "context".to_owned(),
            }))
            .unwrap();
        let call = RuntimeInbound::ToolCall {
            sequence: 2,
            call: crate::agent_tool_broker::AgentToolCall {
                call_id: "terminal-call".to_owned(),
                name: "context".to_owned(),
                arguments: json!({}),
            },
        };
        state.accept_inbound(&call).unwrap();
        let outcome = AgentToolOutcome::Terminate {
            value: json!({"done": true}),
        };
        state.record_tool_result("terminal-call", &outcome).unwrap();
        assert!(
            state
                .accept_inbound(&event(RuntimeEvent::ToolStarted {
                    turn_id: "turn-1".to_owned(),
                    call_id: "second-call".to_owned(),
                    name: "context".to_owned(),
                }))
                .is_err()
        );
        state
            .accept_inbound(&event(RuntimeEvent::ToolCompleted {
                turn_id: "turn-1".to_owned(),
                call_id: "terminal-call".to_owned(),
                outcome,
            }))
            .unwrap();
        state
            .accept_inbound(&event(RuntimeEvent::TurnCompleted {
                turn_id: "turn-1".to_owned(),
                stop_reason: "stop".to_owned(),
                usage: RuntimeUsage::default(),
            }))
            .unwrap();
    }
}
