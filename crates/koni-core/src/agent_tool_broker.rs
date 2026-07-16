//! Provider-neutral boundary between an agent runtime and compiler-owned tools.
//!
//! Model runtimes never receive the authority needed to execute a tool. They
//! may only describe a call; the compiler supplies the authenticated process
//! and attempt context before dispatching it to an implementation of
//! [`AgentToolBroker`].

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use crate::agent_runtime::RuntimeToolDefinition;
use crate::engine::{
    AgentBrokerIngress, AgentBrokerIngressView, AgentBrokerRole, AgentBrokerSafeError,
    agent_mcp_safe_error_for_tool, execute_agent_mcp_tool, wait_for_spawned_agent_reapers,
};
use crate::{AgentProcessIdentity, KoniError, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentToolContext {
    pub session_id: String,
    pub run_id: String,
    pub agent_id: String,
    pub attempt: u32,
    pub runtime_process: AgentProcessIdentity,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentToolCall {
    pub call_id: String,
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AgentToolOutcome {
    Success {
        value: Value,
    },
    Error {
        code: String,
        message: String,
        retryable: bool,
    },
    /// The tool result is valid and the current agent turn must stop without
    /// asking the model for another completion.
    Terminate {
        value: Value,
    },
}

impl AgentToolOutcome {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminate { .. })
    }
}

/// Compiler-owned tool authority.
///
/// Implementations are expected to validate `context` against an immutable
/// grant before inspecting the call. Returning an error means the broker
/// boundary itself failed; ordinary model-visible tool failures use
/// [`AgentToolOutcome::Error`].
pub trait AgentToolBroker: Send + Sync {
    fn execute(&self, context: &AgentToolContext, call: &AgentToolCall)
    -> Result<AgentToolOutcome>;
}

const MAX_VALIDATION_REJECTIONS_PER_TOOL: usize = 3;
const MAX_FILE_SCOPE_REJECTIONS_PER_TOOL: usize = 2;
pub(crate) const MAX_WORKER_WRITE_CONTENT_BYTES: usize = 384 * 1024;
pub(crate) const MAX_WORKER_EDIT_TEXT_BYTES: usize = 64 * 1024;
pub(crate) const MAX_AGENT_BROKER_CONTEXT_DOCUMENT_BYTES: usize = 4_000_000;
/// Compatibility ceiling for policy-absent historical Workers and
/// Lead/observer context packs. The smaller receipt-derived limit above is a
/// capability of `complete_before_product`, not an implicit migration of
/// already-issued sessions.
pub(crate) const MAX_LEGACY_AGENT_BROKER_CONTEXT_DOCUMENT_BYTES: usize = 64 * 1024 * 1024;
/// Context continuations must make enough progress for the compiler's
/// context/receipt arithmetic to remain true. Product reads may still request
/// smaller pages; this minimum is enforced only for the exact outstanding
/// compiler-context continuation.
pub(crate) const MIN_AGENT_BROKER_CONTEXT_CONTINUATION_BYTES: usize = 32 * 1024;

pub(crate) fn valid_worker_write_content(content: &str) -> bool {
    content.len() <= MAX_WORKER_WRITE_CONTENT_BYTES
        && !content
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

#[derive(Debug, Clone)]
pub struct AgentRuntimeToolCatalog {
    role: AgentBrokerRole,
    ordered: Vec<RuntimeToolDefinition>,
    allowed: BTreeSet<String>,
    context_completion_required: bool,
}

impl AgentRuntimeToolCatalog {
    pub fn from_ingress_view(view: &AgentBrokerIngressView) -> Result<Self> {
        if view.enabled_tools.is_empty() {
            return Err(KoniError::Process(
                "runtime tool grant has no enabled tools".to_owned(),
            ));
        }
        let allowed = view.enabled_tools.iter().cloned().collect::<BTreeSet<_>>();
        if allowed.len() != view.enabled_tools.len() {
            return Err(KoniError::Process(
                "runtime tool grant repeats an enabled tool".to_owned(),
            ));
        }
        if view.context_completion_required
            && (!matches!(view.role, AgentBrokerRole::Worker { .. })
                || !allowed.contains("context")
                || !allowed.contains("read_file"))
        {
            return Err(KoniError::Process(
                "context-complete runtime policy requires worker context and read_file tools"
                    .to_owned(),
            ));
        }
        let ordered = view
            .enabled_tools
            .iter()
            .map(|name| runtime_tool_definition(name, &view.role, view.context_completion_required))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            role: view.role.clone(),
            ordered,
            allowed,
            context_completion_required: view.context_completion_required,
        })
    }

    pub fn role(&self) -> &AgentBrokerRole {
        &self.role
    }

    pub fn definitions(&self) -> &[RuntimeToolDefinition] {
        &self.ordered
    }

    /// Project the terminal boundary from the same claimed catalog and the
    /// same outcome predicate used by broker execution. This intentionally
    /// avoids a second persona- or prompt-derived authority model.
    pub fn terminal_boundary_tools(&self) -> Vec<String> {
        self.ordered
            .iter()
            .filter(|tool| terminal_boundary_tool(&tool.name))
            .map(|tool| tool.name.clone())
            .collect()
    }

    pub fn context_completion_required(&self) -> bool {
        self.context_completion_required
    }

    pub fn into_definitions(self) -> Vec<RuntimeToolDefinition> {
        self.ordered
    }

    fn contains(&self, name: &str) -> bool {
        self.allowed.contains(name)
    }
}

trait ClaimedToolIngress: Send {
    fn call(&mut self, tool: &str, arguments: Value) -> Result<Value>;
}

struct EngineClaimedToolIngress {
    ingress: AgentBrokerIngress,
    direct_pi: bool,
}

impl ClaimedToolIngress for EngineClaimedToolIngress {
    fn call(&mut self, tool: &str, arguments: Value) -> Result<Value> {
        let result = execute_agent_mcp_tool(&mut self.ingress, tool, arguments);
        if tool == "yield_lead" && result.is_ok() && !self.direct_pi {
            wait_for_spawned_agent_reapers();
        }
        result
    }
}

#[derive(Debug, Clone, Default)]
struct ValidationRejectionState {
    count: usize,
    last_correction: Option<AgentBrokerSafeError>,
}

#[derive(Debug, Clone)]
enum ContextCompletionCursor {
    Disabled,
    AwaitingContext,
    Paging {
        document_path: String,
        next_offset: u64,
        sha256: Option<String>,
    },
    Complete,
}

#[derive(Debug, Clone)]
struct ContextCompletionState {
    cursor: ContextCompletionCursor,
    rejections: usize,
}

impl ContextCompletionState {
    fn new(required: bool) -> Self {
        Self {
            cursor: if required {
                ContextCompletionCursor::AwaitingContext
            } else {
                ContextCompletionCursor::Disabled
            },
            rejections: 0,
        }
    }

    fn exact_continuation(&self, call: &AgentToolCall) -> bool {
        let ContextCompletionCursor::Paging {
            document_path,
            next_offset,
            ..
        } = &self.cursor
        else {
            return false;
        };
        call.name == "read_file"
            && call.arguments.get("path").and_then(Value::as_str) == Some(document_path)
            && call
                .arguments
                .get("offset")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                == *next_offset
    }

    fn gate(&mut self, call: &AgentToolCall) -> Option<AgentBrokerSafeError> {
        if matches!(self.cursor, ContextCompletionCursor::Disabled) {
            return None;
        }

        if call.name == "context" {
            if matches!(self.cursor, ContextCompletionCursor::AwaitingContext) {
                return None;
            }
            let message = match &self.cursor {
                ContextCompletionCursor::Paging {
                    document_path,
                    next_offset,
                    ..
                } => format!(
                    "Compiler context was already issued. Continue only with `read_file` at exact path `{document_path}` and offset {next_offset}; repeating `context` cannot rewind this session."
                ),
                ContextCompletionCursor::Complete => {
                    "Compiler context is already complete. Continue the assignment without repeating `context`."
                        .to_owned()
                }
                ContextCompletionCursor::Disabled | ContextCompletionCursor::AwaitingContext => {
                    unreachable!("disabled/awaiting context handled above")
                }
            };
            if self.rejections == 0 {
                self.rejections = 1;
                return Some(AgentBrokerSafeError {
                    code: "context_already_issued".to_owned(),
                    message,
                    retryable: true,
                });
            }
            return Some(AgentBrokerSafeError {
                code: "context_incomplete_retry_limit".to_owned(),
                message: "Compiler context was already issued and cannot be restarted in this broker session. Stop this agent rather than spending more context receipts."
                    .to_owned(),
                retryable: false,
            });
        }

        if matches!(self.cursor, ContextCompletionCursor::Complete) {
            return None;
        }

        if self.exact_continuation(call) {
            let requested = call
                .arguments
                .get("max_bytes")
                .and_then(Value::as_u64)
                .unwrap_or(MIN_AGENT_BROKER_CONTEXT_CONTINUATION_BYTES as u64);
            if requested >= MIN_AGENT_BROKER_CONTEXT_CONTINUATION_BYTES as u64 {
                return None;
            }
            if self.rejections == 0 {
                self.rejections = 1;
                return Some(AgentBrokerSafeError {
                    code: "context_page_too_small".to_owned(),
                    message: format!(
                        "Compiler-context continuations must request at least {} bytes so the complete document fits its bounded receipt allowance. Retry the exact path and offset with max_bytes at least {}.",
                        MIN_AGENT_BROKER_CONTEXT_CONTINUATION_BYTES,
                        MIN_AGENT_BROKER_CONTEXT_CONTINUATION_BYTES,
                    ),
                    retryable: true,
                });
            }
            return Some(AgentBrokerSafeError {
                code: "context_incomplete_retry_limit".to_owned(),
                message: "Compiler context is still incomplete after one bounded correction. Stop this agent so Koni can preserve the exact ticket boundary without an uninformed retry loop."
                    .to_owned(),
                retryable: false,
            });
        }

        if self.rejections == 0 {
            self.rejections = 1;
            let instruction = match &self.cursor {
                ContextCompletionCursor::AwaitingContext => {
                    "Call `context` once, then page its exact `document_path` from every returned `next_offset` until `eof:true`."
                        .to_owned()
                }
                ContextCompletionCursor::Paging {
                    document_path,
                    next_offset,
                    ..
                } => format!(
                    "Call `read_file` with the exact compiler context path `{document_path}` and offset {next_offset}, then continue from each returned `next_offset` until `eof:true`."
                ),
                ContextCompletionCursor::Disabled | ContextCompletionCursor::Complete => {
                    unreachable!("complete context was handled above")
                }
            };
            return Some(AgentBrokerSafeError {
                code: "context_incomplete".to_owned(),
                message: format!(
                    "Compiler context is incomplete. {instruction} Do not call product file, check, or submission tools before context reaches EOF."
                ),
                retryable: true,
            });
        }

        Some(AgentBrokerSafeError {
            code: "context_incomplete_retry_limit".to_owned(),
            message: "Compiler context is still incomplete after one bounded correction. Stop this agent so Koni can preserve the exact ticket boundary without an uninformed retry loop."
                .to_owned(),
            retryable: false,
        })
    }

    fn observe_success(&mut self, tool: &str, arguments: &Value, value: &Value) -> Result<()> {
        if matches!(self.cursor, ContextCompletionCursor::Disabled) {
            return Ok(());
        }
        if tool == "context" {
            if !matches!(self.cursor, ContextCompletionCursor::AwaitingContext) {
                return Err(KoniError::Process(
                    "context response attempted to rewind an issued compiler context".to_owned(),
                ));
            }
            if value.get("status").and_then(Value::as_str) == Some("paged") {
                let eof = value.get("eof").and_then(Value::as_bool).ok_or_else(|| {
                    KoniError::Process("paged context response is missing eof".to_owned())
                })?;
                if eof {
                    if value.get("document").and_then(Value::as_str).is_none() {
                        return Err(KoniError::Process(
                            "terminal paged context response is missing its document".to_owned(),
                        ));
                    }
                    self.cursor = ContextCompletionCursor::Complete;
                    return Ok(());
                }
                let document_path = value
                    .get("document_path")
                    .and_then(Value::as_str)
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| {
                        KoniError::Process(
                            "paged context response is missing its document path".to_owned(),
                        )
                    })?;
                let next_offset = value
                    .get("next_offset")
                    .and_then(Value::as_u64)
                    .filter(|offset| *offset > 0)
                    .ok_or_else(|| {
                        KoniError::Process(
                            "paged context response is missing its continuation offset".to_owned(),
                        )
                    })?;
                let sha256 = value
                    .get("sha256")
                    .and_then(Value::as_str)
                    .filter(|value| valid_context_sha256(value))
                    .ok_or_else(|| {
                        KoniError::Process(
                            "paged context response is missing a valid sha256".to_owned(),
                        )
                    })?
                    .to_owned();
                self.cursor = ContextCompletionCursor::Paging {
                    document_path: document_path.to_owned(),
                    next_offset,
                    sha256: Some(sha256),
                };
            } else if value.get("status").and_then(Value::as_str) == Some("already_issued") {
                if matches!(self.cursor, ContextCompletionCursor::AwaitingContext) {
                    let document_path = value
                        .get("document_path")
                        .and_then(Value::as_str)
                        .filter(|path| !path.is_empty())
                        .ok_or_else(|| {
                            KoniError::Process(
                                "issued context response is missing its document path".to_owned(),
                            )
                        })?;
                    self.cursor = ContextCompletionCursor::Paging {
                        document_path: document_path.to_owned(),
                        next_offset: 0,
                        sha256: None,
                    };
                }
            } else if value.get("document").and_then(Value::as_str).is_some() {
                self.cursor = ContextCompletionCursor::Complete;
            } else {
                return Err(KoniError::Process(
                    "context response does not establish completion or continuation".to_owned(),
                ));
            }
            return Ok(());
        }

        if tool != "read_file" || !self.exact_continuation_call(arguments) {
            return Ok(());
        }
        let ContextCompletionCursor::Paging {
            document_path,
            next_offset,
            sha256,
        } = &self.cursor
        else {
            return Ok(());
        };
        if value.get("path").and_then(Value::as_str) != Some(document_path)
            || value.get("offset").and_then(Value::as_u64) != Some(*next_offset)
        {
            return Err(KoniError::Process(
                "context continuation response crossed its exact path or offset".to_owned(),
            ));
        }
        let eof = value.get("eof").and_then(Value::as_bool).ok_or_else(|| {
            KoniError::Process("context continuation response is missing eof".to_owned())
        })?;
        let response_sha = value
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|value| valid_context_sha256(value))
            .ok_or_else(|| {
                KoniError::Process(
                    "context continuation response is missing a valid sha256".to_owned(),
                )
            })?;
        if sha256
            .as_deref()
            .is_some_and(|expected| expected != response_sha)
        {
            return Err(KoniError::Process(
                "context continuation response changed document identity".to_owned(),
            ));
        }
        if eof {
            self.cursor = ContextCompletionCursor::Complete;
        } else {
            let continued = value
                .get("next_offset")
                .and_then(Value::as_u64)
                .filter(|offset| *offset > *next_offset)
                .ok_or_else(|| {
                    KoniError::Process(
                        "context continuation response did not advance its offset".to_owned(),
                    )
                })?;
            self.cursor = ContextCompletionCursor::Paging {
                document_path: document_path.clone(),
                next_offset: continued,
                sha256: Some(response_sha.to_owned()),
            };
        }
        Ok(())
    }

    fn exact_continuation_call(&self, arguments: &Value) -> bool {
        let ContextCompletionCursor::Paging {
            document_path,
            next_offset,
            ..
        } = &self.cursor
        else {
            return false;
        };
        arguments.get("path").and_then(Value::as_str) == Some(document_path)
            && arguments.get("offset").and_then(Value::as_u64).unwrap_or(0) == *next_offset
    }
}

struct DurableBrokerState {
    ingress: Box<dyn ClaimedToolIngress>,
    bounded_rejections: BTreeMap<String, ValidationRejectionState>,
    context_completion: ContextCompletionState,
}

/// Provider-neutral adapter over one process-bound durable tool grant.
///
/// The caller constructs `context` from the same compiler-owned session and
/// exact Pi host identity used for the direct grant claim. Every call must
/// present that complete value unchanged before the adapter even inspects the
/// requested tool.
pub struct DurableAgentToolBroker {
    expected_context: AgentToolContext,
    catalog: AgentRuntimeToolCatalog,
    state: Mutex<DurableBrokerState>,
}

impl DurableAgentToolBroker {
    pub fn new(ingress: AgentBrokerIngress, context: AgentToolContext) -> Result<Self> {
        validate_trusted_tool_context(&context)?;
        let catalog = AgentRuntimeToolCatalog::from_ingress_view(&ingress.view()?)?;
        let context_completion = ContextCompletionState::new(catalog.context_completion_required());
        let direct_pi = ingress.is_direct_pi();
        Ok(Self {
            expected_context: context,
            catalog,
            state: Mutex::new(DurableBrokerState {
                ingress: Box::new(EngineClaimedToolIngress { ingress, direct_pi }),
                bounded_rejections: BTreeMap::new(),
                context_completion,
            }),
        })
    }

    pub fn tool_catalog(&self) -> &AgentRuntimeToolCatalog {
        &self.catalog
    }

    pub fn runtime_tools(&self) -> Vec<RuntimeToolDefinition> {
        self.catalog.definitions().to_vec()
    }

    #[cfg(test)]
    fn with_test_ingress(
        catalog: AgentRuntimeToolCatalog,
        context: AgentToolContext,
        ingress: impl ClaimedToolIngress + 'static,
    ) -> Self {
        let context_completion = ContextCompletionState::new(catalog.context_completion_required());
        Self {
            expected_context: context,
            catalog,
            state: Mutex::new(DurableBrokerState {
                ingress: Box::new(ingress),
                bounded_rejections: BTreeMap::new(),
                context_completion,
            }),
        }
    }
}

impl AgentToolBroker for DurableAgentToolBroker {
    fn execute(
        &self,
        context: &AgentToolContext,
        call: &AgentToolCall,
    ) -> Result<AgentToolOutcome> {
        if context != &self.expected_context {
            return Err(KoniError::Process(
                "runtime tool call crossed its compiler-owned session or host identity".to_owned(),
            ));
        }
        if !self.catalog.contains(&call.name) {
            return Ok(AgentToolOutcome::Error {
                code: "capability_denied".to_owned(),
                message: "Tool is outside this compiler-issued capability.".to_owned(),
                retryable: false,
            });
        }
        if !call.arguments.is_object() {
            return Ok(AgentToolOutcome::Error {
                code: "invalid_arguments".to_owned(),
                message: "Use exactly the compiler-issued tool schema.".to_owned(),
                retryable: true,
            });
        }
        if validate_tool_arguments(self.catalog.role(), &call.name, call.arguments.clone()).is_err()
        {
            return Ok(AgentToolOutcome::Error {
                code: "invalid_arguments".to_owned(),
                message: "Use exactly the compiler-issued tool schema.".to_owned(),
                retryable: true,
            });
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| KoniError::Process("runtime tool broker lock was poisoned".to_owned()))?;
        if let Some(error) = state.context_completion.gate(call) {
            return Ok(safe_error_outcome(error));
        }
        if bounded_validation_tool(&call.name)
            && state
                .bounded_rejections
                .get(&call.name)
                .is_some_and(|rejections| rejections.count >= MAX_VALIDATION_REJECTIONS_PER_TOOL)
        {
            let safe = validation_retry_limit_error(
                state
                    .bounded_rejections
                    .get(&call.name)
                    .and_then(|rejections| rejections.last_correction.as_ref()),
            );
            return Ok(safe_error_outcome(safe));
        }
        if bounded_file_scope_tool(&call.name)
            && state
                .bounded_rejections
                .get(&call.name)
                .is_some_and(|rejections| rejections.count >= MAX_FILE_SCOPE_REJECTIONS_PER_TOOL)
        {
            return Ok(safe_error_outcome(file_scope_retry_limit_error()));
        }

        let result = {
            let DurableBrokerState {
                ingress,
                bounded_rejections: _,
                context_completion: _,
            } = &mut *state;
            ingress.call(&call.name, call.arguments.clone())
        };
        match result {
            Ok(value) => match minimal_model_response(&call.name, value) {
                Ok(value) => {
                    if state
                        .context_completion
                        .observe_success(&call.name, &call.arguments, &value)
                        .is_err()
                    {
                        return Ok(safe_error_outcome(response_projection_error(&call.name)));
                    }
                    if terminal_boundary_tool(&call.name) {
                        Ok(AgentToolOutcome::Terminate { value })
                    } else {
                        Ok(AgentToolOutcome::Success { value })
                    }
                }
                Err(_) => Ok(safe_error_outcome(response_projection_error(&call.name))),
            },
            Err(error) => {
                let mut safe = agent_mcp_safe_error_for_tool(&call.name, &error);
                if bounded_validation_tool(&call.name)
                    && matches!(
                        safe.code.as_str(),
                        "revise_validation" | "configured_check_failed"
                    )
                {
                    let rejections = state
                        .bounded_rejections
                        .entry(call.name.clone())
                        .or_default();
                    rejections.count += 1;
                    rejections.last_correction = Some(safe.clone());
                    if rejections.count >= MAX_VALIDATION_REJECTIONS_PER_TOOL {
                        safe = validation_retry_limit_error(rejections.last_correction.as_ref());
                    }
                } else if bounded_file_scope_tool(&call.name) && safe.code == "file_scope_retry" {
                    let rejections = state
                        .bounded_rejections
                        .entry(call.name.clone())
                        .or_default();
                    rejections.count += 1;
                    rejections.last_correction = Some(safe.clone());
                    if rejections.count >= MAX_FILE_SCOPE_REJECTIONS_PER_TOOL {
                        safe = file_scope_retry_limit_error();
                    }
                }
                Ok(safe_error_outcome(safe))
            }
        }
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
struct WorkerPathArguments {
    path: String,
    #[serde(default)]
    offset: Option<u64>,
    #[serde(default)]
    max_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerListArguments {
    path: String,
    #[serde(default)]
    max_entries: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerSearchArguments {
    path: String,
    query: String,
    #[serde(default)]
    max_matches: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerWriteArguments {
    path: String,
    expected_sha256: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerEditArguments {
    path: String,
    expected_sha256: String,
    old_text: String,
    new_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerCheckArguments {
    check_id: String,
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
) -> std::result::Result<(), ()> {
    match (role, tool) {
        (AgentBrokerRole::Worker { .. }, "context") => {
            serde_json::from_value::<EmptyArguments>(arguments).map_err(|_| ())?;
        }
        (AgentBrokerRole::Worker { .. }, "graph_context") => {
            let parsed =
                serde_json::from_value::<GraphContextArguments>(arguments).map_err(|_| ())?;
            validate_string_list(&parsed.anchors, 16)?;
            validate_string_list(&parsed.relations, 32)?;
            validate_string_list(&parsed.node_types, 32)?;
            let _ = (parsed.direction, parsed.max_depth);
        }
        (AgentBrokerRole::Worker { .. }, "record_note") => {
            let parsed =
                serde_json::from_value::<RecordNoteArguments>(arguments).map_err(|_| ())?;
            if parsed.node_id.trim().is_empty() || parsed.body.trim().is_empty() {
                return Err(());
            }
            if parsed
                .supersedes
                .as_deref()
                .is_some_and(|supersedes| supersedes.trim().is_empty())
            {
                return Err(());
            }
            let _ = parsed.kind;
        }
        (AgentBrokerRole::Worker { .. }, "read_file") => {
            let parsed =
                serde_json::from_value::<WorkerPathArguments>(arguments).map_err(|_| ())?;
            if parsed.path.trim().is_empty()
                || parsed
                    .offset
                    .is_some_and(|offset| offset > 64 * 1024 * 1024)
                || parsed
                    .max_bytes
                    .is_some_and(|maximum| !(1..=64 * 1024).contains(&maximum))
            {
                return Err(());
            }
        }
        (AgentBrokerRole::Worker { .. }, "list_files") => {
            let parsed =
                serde_json::from_value::<WorkerListArguments>(arguments).map_err(|_| ())?;
            if parsed.path.trim().is_empty()
                || parsed
                    .max_entries
                    .is_some_and(|maximum| !(1..=1_000).contains(&maximum))
            {
                return Err(());
            }
        }
        (AgentBrokerRole::Worker { .. }, "search_files") => {
            let parsed =
                serde_json::from_value::<WorkerSearchArguments>(arguments).map_err(|_| ())?;
            if parsed.path.trim().is_empty()
                || parsed.query.trim().is_empty()
                || parsed.query.len() > 256
                || parsed
                    .max_matches
                    .is_some_and(|maximum| !(1..=200).contains(&maximum))
            {
                return Err(());
            }
        }
        (AgentBrokerRole::Worker { .. }, "write_file") => {
            let parsed =
                serde_json::from_value::<WorkerWriteArguments>(arguments).map_err(|_| ())?;
            let valid_hash = |value: &str| {
                value.len() == 71
                    && value.starts_with("sha256:")
                    && value[7..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            };
            if parsed.path.trim().is_empty()
                || (parsed.expected_sha256 != "missing" && !valid_hash(&parsed.expected_sha256))
                || !valid_worker_write_content(&parsed.content)
            {
                return Err(());
            }
        }
        (AgentBrokerRole::Worker { .. }, "edit_file") => {
            let parsed =
                serde_json::from_value::<WorkerEditArguments>(arguments).map_err(|_| ())?;
            let valid_hash = |value: &str| {
                value.len() == 71
                    && value.starts_with("sha256:")
                    && value[7..]
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            };
            if parsed.path.trim().is_empty()
                || !valid_hash(&parsed.expected_sha256)
                || parsed.old_text.is_empty()
                || parsed.old_text == parsed.new_text
                || parsed.old_text.len() > MAX_WORKER_EDIT_TEXT_BYTES
                || parsed.new_text.len() > MAX_WORKER_EDIT_TEXT_BYTES
                || !valid_worker_write_content(&parsed.old_text)
                || !valid_worker_write_content(&parsed.new_text)
            {
                return Err(());
            }
        }
        (AgentBrokerRole::Worker { .. }, "run_configured_check") => {
            let parsed =
                serde_json::from_value::<WorkerCheckArguments>(arguments).map_err(|_| ())?;
            if parsed.check_id.trim().is_empty() {
                return Err(());
            }
        }
        (AgentBrokerRole::Worker { .. }, "submit_output" | "submit_and_compile") => {
            let parsed =
                serde_json::from_value::<SubmitOutputArguments>(arguments).map_err(|_| ())?;
            if !parsed.payload.is_object() {
                return Err(());
            }
        }
        (AgentBrokerRole::Worker { .. }, "compile") => {
            let parsed = serde_json::from_value::<CompileArguments>(arguments).map_err(|_| ())?;
            if parsed
                .summary
                .as_deref()
                .is_some_and(|summary| summary.trim().is_empty())
            {
                return Err(());
            }
        }
        (
            AgentBrokerRole::Lead {
                boundary: crate::LeadSliceBoundary::DispatchBatch { .. },
                ..
            },
            "start" | "spawn_worker",
        ) => {
            let parsed = serde_json::from_value::<TicketArguments>(arguments).map_err(|_| ())?;
            if parsed.ticket.trim().is_empty() {
                return Err(());
            }
        }
        (AgentBrokerRole::Lead { .. }, "yield_lead") => {
            let parsed = serde_json::from_value::<YieldArguments>(arguments).map_err(|_| ())?;
            if parsed.reason.as_deref().is_some_and(|reason| {
                !matches!(reason, "boundary-complete" | "paused" | "capacity-reached")
            }) {
                return Err(());
            }
        }
        (AgentBrokerRole::Lead { .. }, _) => {
            serde_json::from_value::<EmptyArguments>(arguments).map_err(|_| ())?;
        }
        _ => return Err(()),
    }
    Ok(())
}

fn validate_string_list(values: &[String], maximum: usize) -> std::result::Result<(), ()> {
    if values.len() > maximum || values.iter().any(|value| value.trim().is_empty()) {
        return Err(());
    }
    Ok(())
}

fn validate_trusted_tool_context(context: &AgentToolContext) -> Result<()> {
    if context.session_id.trim().is_empty()
        || context.run_id.trim().is_empty()
        || context.agent_id.trim().is_empty()
        || context.attempt == 0
        || context.runtime_process.pid == 0
        || context.runtime_process.process_group_id != context.runtime_process.pid
        || context.runtime_process.birth_marker.trim().is_empty()
    {
        return Err(KoniError::Process(
            "runtime tool broker requires a complete compiler-owned session context".to_owned(),
        ));
    }
    Ok(())
}

fn safe_error_outcome(error: AgentBrokerSafeError) -> AgentToolOutcome {
    AgentToolOutcome::Error {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
    }
}

fn bounded_validation_tool(tool: &str) -> bool {
    matches!(tool, "submit_output" | "submit_and_compile" | "compile")
}

fn bounded_file_scope_tool(tool: &str) -> bool {
    matches!(tool, "read_file" | "list_files" | "search_files")
}

fn valid_context_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn terminal_boundary_tool(tool: &str) -> bool {
    matches!(tool, "compile" | "submit_and_compile" | "yield_lead")
}

fn validation_retry_limit_error(
    last_correction: Option<&AgentBrokerSafeError>,
) -> AgentBrokerSafeError {
    let mut message = "The compiler returned three bounded validation rejections in this agent session. Stop this agent so Koni can preserve the exact ticket boundary and recover without an unbounded retry loop."
        .to_owned();
    if let Some(correction) = last_correction.filter(|correction| {
        matches!(
            correction.code.as_str(),
            "revise_validation" | "configured_check_failed"
        )
    }) {
        message.push_str(" Final compiler correction: ");
        message.push_str(correction.message.trim());
    }
    AgentBrokerSafeError {
        code: "validation_retry_limit".to_owned(),
        message,
        retryable: false,
    }
}

fn file_scope_retry_limit_error() -> AgentBrokerSafeError {
    AgentBrokerSafeError {
        code: "file_scope_retry_limit".to_owned(),
        message: "The corrected file-tool call still used an unlisted ancestor of the compiler-issued read scope. Stop this agent so Koni can preserve the exact ticket boundary without an unbounded discovery loop."
            .to_owned(),
        retryable: false,
    }
}

fn response_projection_error(tool: &str) -> AgentBrokerSafeError {
    let (code, message) = match tool {
        "context" => (
            "context_unavailable",
            "The compiler could not provide this step context.",
        ),
        "submit_output" | "submit_and_compile" => (
            "output_rejected",
            "Revise the structured payload to satisfy the issued context.",
        ),
        "compile" => (
            "compile_rejected",
            "Revise and resubmit the structured output before compiling again.",
        ),
        "wait_worker" => (
            "wait_rejected",
            "The issued worker boundary is no longer waitable.",
        ),
        "yield_lead" => (
            "yield_rejected",
            "Complete the issued Lead boundary before yielding.",
        ),
        _ => (
            "boundary_rejected",
            "The compiler rejected this lifecycle transition.",
        ),
    };
    AgentBrokerSafeError {
        code: code.to_owned(),
        message: message.to_owned(),
        retryable: false,
    }
}

fn minimal_model_response(tool: &str, value: Value) -> Result<Value> {
    match tool {
        "context" => {
            if let Some(document) = value.get("document").cloned() {
                if value.get("status").and_then(Value::as_str) == Some("paged") {
                    return Ok(json!({
                        "status": "paged",
                        "document": document,
                        "document_path": value["document_path"],
                        "offset": value["offset"],
                        "next_offset": value["next_offset"],
                        "eof": value["eof"],
                        "sha256": value["sha256"],
                        "bytes": value["bytes"],
                        "message": value["message"],
                    }));
                }
                return Ok(json!({"document": document}));
            }
            let document_path = value
                .get("document_path")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    KoniError::Process("context response is missing its document".to_owned())
                })?;
            Ok(json!({
                "status": "already_issued",
                "document_path": document_path,
                "message": value.get("message").and_then(Value::as_str).unwrap_or(
                    "Use the complete context from the first call or read only this exact compiler-issued document path."
                ),
            }))
        }
        "read_file"
        | "list_files"
        | "search_files"
        | "write_file"
        | "edit_file"
        | "run_configured_check"
        | "graph_context"
        | "wait_worker" => Ok(value),
        "record_note" => {
            let note_id = value
                .get("note")
                .and_then(|note| note.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    KoniError::Process("record_note response is missing its note ID".to_owned())
                })?;
            Ok(json!({
                "status": "accepted",
                "note_id": note_id,
                "replayed": value.get("replayed").and_then(Value::as_bool).unwrap_or(false),
                "authority": value.get("authority").and_then(Value::as_str).unwrap_or(
                    "advisory_non_authoritative"
                ),
            }))
        }
        _ => Ok(json!({"status": "accepted"})),
    }
}

fn runtime_tool_definition(
    name: &str,
    role: &AgentBrokerRole,
    context_completion_required: bool,
) -> Result<RuntimeToolDefinition> {
    let empty = || json!({"type": "object", "additionalProperties": false});
    let ticket = |allowed: &[String]| {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["ticket"],
            "properties": {"ticket": {"type": "string", "enum": allowed}}
        })
    };
    let (description, input_schema) = match (role, name) {
        (AgentBrokerRole::Worker { .. }, "context") => (
            "Read the compiler-issued context for this ticket step. Context is incomplete until eof is true: when a large document returns eof:false, page its exact document_path from every returned next_offset with read_file and at least 32768 max_bytes before any product file, check, or submission call. Each successful delivery must be observed before issuing another call.",
            empty(),
        ),
        (AgentBrokerRole::Worker { .. }, "graph_context") => (
            "Read a bounded graph neighborhood anchored within this ticket's compiler-issued scope, including advisory working notes.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "anchors": {"type": "array", "maxItems": 16, "items": {"type": "string", "minLength": 1}},
                    "relations": {"type": "array", "maxItems": 32, "items": {"type": "string", "minLength": 1}},
                    "direction": {"type": "string", "enum": ["outgoing", "incoming", "both"], "default": "both"},
                    "max_depth": {"type": "integer", "minimum": 0, "default": 1},
                    "node_types": {"type": "array", "maxItems": 32, "items": {"type": "string", "minLength": 1}}
                }
            }),
        ),
        (AgentBrokerRole::Worker { .. }, "record_note") => (
            "Append a provenance-bound advisory working note to a graph node visible from this ticket. This does not change typed graph authority.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["node_id", "kind", "body"],
                "properties": {
                    "node_id": {"type": "string", "minLength": 1},
                    "kind": {"type": "string", "enum": ["observation", "implementation_detail", "rationale", "nit", "open_question"]},
                    "body": {"type": "string", "minLength": 1},
                    "supersedes": {"type": "string", "minLength": 1}
                }
            }),
        ),
        (AgentBrokerRole::Worker { .. }, "read_file") => (
            "Read one page of a bounded UTF-8 product file inside this step's compiler-issued read scope. Use an issued file entry, a descendant of an issued directory entry, or the exact compiler-issued context document_path; never substitute an unlisted ancestor. Exact context continuations require at least 32768 max_bytes and each returned page must be observed before the next call; finish to eof:true before product calls. For a known literal in a product file larger than one page, search first and read only the required region. Treat an eof:true result as retained in the transcript; do not search it merely to relocate returned text. Continue partial reads from next_offset; symlinks and compiler-owned paths are rejected.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path"],
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "offset": {"type": "integer", "minimum": 0, "maximum": if context_completion_required { MAX_AGENT_BROKER_CONTEXT_DOCUMENT_BYTES } else { MAX_LEGACY_AGENT_BROKER_CONTEXT_DOCUMENT_BYTES }, "default": 0},
                    "max_bytes": {"type": "integer", "minimum": 1, "maximum": 65536, "default": 32768}
                }
            }),
        ),
        (AgentBrokerRole::Worker { .. }, "list_files") => (
            "List a bounded product subtree inside this step's compiler-issued read scope without following symlinks. Use an issued directory entry or its descendant; never substitute an unlisted ancestor of separately issued paths.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path"],
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "max_entries": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 200}
                }
            }),
        ),
        (AgentBrokerRole::Worker { .. }, "search_files") => (
            "Search for one literal string inside an issued file/directory entry or below an issued directory entry, after compiler context reaches eof:true. For a known literal in a file larger than one read page, search before reading broadly, then read only the required region. Do not search an eof:true file merely to relocate text already retained in the transcript. Never substitute an unlisted ancestor of separately issued files; search those files explicitly. This never accepts a regex or command.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "query"],
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "query": {"type": "string", "minLength": 1, "maxLength": 256},
                    "max_matches": {"type": "integer", "minimum": 1, "maximum": 200, "default": 100}
                }
            }),
        ),
        (AgentBrokerRole::Worker { .. }, "write_file") => (
            "Atomically replace or create one UTF-8 product file of at most 393,216 bytes inside this step's compiler-issued write scope. Supply the prior hash returned by read_file, or `missing` for a new file; Rust computes and returns the new content hash and stale writes fail closed.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "expected_sha256", "content"],
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "expected_sha256": {"type": "string", "pattern": "^(missing|sha256:[0-9a-f]{64})$"},
                    "content": {
                        "type": "string",
                        "maxLength": MAX_WORKER_WRITE_CONTENT_BYTES,
                        "description": "Complete replacement UTF-8 content, bounded by encoded byte length to 393,216 bytes. Newline, carriage return, and tab are the only accepted control characters."
                    }
                }
            }),
        ),
        (AgentBrokerRole::Worker { .. }, "edit_file") => (
            "Surgically replace exactly one UTF-8 snippet in an existing product file inside this step's compiler-issued write scope. Supply the whole-file hash returned by read_file. Each snippet is bounded by encoded byte length to 65,536 bytes, and the resulting whole file must be at most 393,216 bytes. Zero or multiple old_text matches, stale hashes, symlinks, and out-of-scope paths fail before mutation; the compiler atomically commits the resulting whole-file postimage.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "expected_sha256", "old_text", "new_text"],
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "expected_sha256": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
                    "old_text": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": MAX_WORKER_EDIT_TEXT_BYTES,
                        "description": "Exact unique UTF-8 snippet currently present in the file, bounded by encoded byte length to 65,536 bytes. Newline, carriage return, and tab are the only accepted control characters."
                    },
                    "new_text": {
                        "type": "string",
                        "maxLength": MAX_WORKER_EDIT_TEXT_BYTES,
                        "description": "Replacement UTF-8 snippet, bounded by encoded byte length to 65,536 bytes; use an empty string only for deletion. Newline, carriage return, and tab are the only accepted control characters."
                    }
                }
            }),
        ),
        (AgentBrokerRole::Worker { .. }, "run_configured_check") => (
            "Run one compiler-configured read-only validation check assigned to this exact step. After editing, run every assigned validation check and repair setup or assertion failures before terminal submission. The model cannot supply argv, environment, cwd, or shell text.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["check_id"],
                "properties": {"check_id": {"type": "string", "minLength": 1}}
            }),
        ),
        (AgentBrokerRole::Worker { .. }, "submit_output" | "submit_and_compile") => (
            if name == "submit_and_compile" {
                "Atomically submit structured output, materialize its graph delta, and run the scoped compile for this ticket step. Call this only after every assigned configured check has reached its intended result; a newly failed compiler check remains nonterminal and returns bounded repair feedback."
            } else {
                "Submit structured output for this ticket step."
            },
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["payload"],
                "properties": {"payload": {"type": "object"}}
            }),
        ),
        (AgentBrokerRole::Worker { .. }, "compile") => (
            "Validate and compile the accepted output for this ticket step.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {"summary": {"type": "string", "minLength": 1}}
            }),
        ),
        (
            AgentBrokerRole::Lead {
                boundary: crate::LeadSliceBoundary::DispatchBatch { tickets },
                ..
            },
            "start",
        ) => ("Start the next issued dispatch ticket.", ticket(tickets)),
        (
            AgentBrokerRole::Lead {
                boundary: crate::LeadSliceBoundary::DispatchBatch { tickets },
                ..
            },
            "spawn_worker",
        ) => (
            "Spawn the worker for the next issued dispatch ticket.",
            ticket(tickets),
        ),
        (AgentBrokerRole::Lead { .. }, "spawn_worker") => {
            ("Spawn the worker for the compiler-issued ticket.", empty())
        }
        (AgentBrokerRole::Lead { .. }, "wait_worker") => (
            "Wait at the exact compiler-issued worker boundary.",
            empty(),
        ),
        (AgentBrokerRole::Lead { .. }, "recover") => {
            ("Run the compiler-owned recovery boundary.", empty())
        }
        (AgentBrokerRole::Lead { .. }, "review") => (
            "Run the compiler-owned review for the issued ticket.",
            empty(),
        ),
        (AgentBrokerRole::Lead { .. }, "finish") => {
            ("Finish and integrate the compiler-issued ticket.", empty())
        }
        (AgentBrokerRole::Lead { .. }, "yield_lead") => (
            "Return this completed or compiler-verified interrupted Lead boundary to the supervisor and stop.",
            json!({
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "reason": {"type": "string", "enum": ["boundary-complete", "paused", "capacity-reached"]}
                }
            }),
        ),
        _ => {
            return Err(KoniError::Process(format!(
                "tool {name} is invalid for this compiler-issued role"
            )));
        }
    };
    Ok(RuntimeToolDefinition {
        name: name.to_owned(),
        description: description.to_owned(),
        input_schema,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LeadSliceBoundary;
    use std::collections::VecDeque;
    use std::sync::Arc;

    fn trusted_context() -> AgentToolContext {
        AgentToolContext {
            session_id: "session-pi".to_owned(),
            run_id: "run-test".to_owned(),
            agent_id: "agent-test".to_owned(),
            attempt: 1,
            runtime_process: AgentProcessIdentity {
                pid: 42,
                process_group_id: 42,
                birth_marker: "pi-host-birth".to_owned(),
            },
        }
    }

    fn worker_view(tools: &[&str]) -> AgentBrokerIngressView {
        AgentBrokerIngressView {
            role: AgentBrokerRole::Worker {
                ticket: "TK-test".to_owned(),
                step: "implement".to_owned(),
                persona: "builder".to_owned(),
            },
            context_completion_required: false,
            enabled_tools: tools.iter().map(|tool| (*tool).to_owned()).collect(),
        }
    }

    fn context_bound_worker_view(tools: &[&str]) -> AgentBrokerIngressView {
        let mut view = worker_view(tools);
        view.context_completion_required = true;
        view
    }

    enum FakeReply {
        Success(Value),
        Error(KoniError),
    }

    struct FakeIngress {
        replies: VecDeque<FakeReply>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl ClaimedToolIngress for FakeIngress {
        fn call(&mut self, tool: &str, _arguments: Value) -> Result<Value> {
            self.calls.lock().unwrap().push(tool.to_owned());
            match self.replies.pop_front().expect("one fake reply per call") {
                FakeReply::Success(value) => Ok(value),
                FakeReply::Error(error) => Err(error),
            }
        }
    }

    fn test_broker(
        view: AgentBrokerIngressView,
        replies: impl IntoIterator<Item = FakeReply>,
    ) -> (DurableAgentToolBroker, Arc<Mutex<Vec<String>>>) {
        let catalog = AgentRuntimeToolCatalog::from_ingress_view(&view).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let broker = DurableAgentToolBroker::with_test_ingress(
            catalog,
            trusted_context(),
            FakeIngress {
                replies: replies.into_iter().collect(),
                calls: calls.clone(),
            },
        );
        (broker, calls)
    }

    #[test]
    fn tool_outcome_distinguishes_model_error_from_terminating_success() {
        let failure = AgentToolOutcome::Error {
            code: "scope_denied".to_owned(),
            message: "outside the assignment".to_owned(),
            retryable: false,
        };
        let terminal = AgentToolOutcome::Terminate {
            value: serde_json::json!({"decision": "accepted"}),
        };

        assert!(!failure.is_terminal());
        assert!(terminal.is_terminal());
        assert_eq!(
            serde_json::to_value(terminal).unwrap(),
            serde_json::json!({
                "status": "terminate",
                "value": {"decision": "accepted"}
            })
        );
    }

    #[test]
    fn runtime_catalog_preserves_grant_order_and_role_bounded_schemas() {
        let worker = AgentRuntimeToolCatalog::from_ingress_view(&worker_view(&[
            "context",
            "graph_context",
            "record_note",
            "submit_and_compile",
        ]))
        .unwrap();
        assert_eq!(
            worker
                .definitions()
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            [
                "context",
                "graph_context",
                "record_note",
                "submit_and_compile"
            ]
        );
        assert_eq!(
            worker.terminal_boundary_tools(),
            ["submit_and_compile".to_owned()]
        );
        assert_eq!(
            worker.definitions()[1].input_schema["properties"]["anchors"]["maxItems"],
            16
        );
        assert_eq!(
            worker.definitions()[2].input_schema["properties"]["kind"]["enum"],
            json!([
                "observation",
                "implementation_detail",
                "rationale",
                "nit",
                "open_question"
            ])
        );

        let lead_view = AgentBrokerIngressView {
            role: AgentBrokerRole::Lead {
                generation: 1,
                boundary: LeadSliceBoundary::DispatchBatch {
                    tickets: vec!["TK-a".to_owned(), "TK-b".to_owned()],
                },
            },
            context_completion_required: false,
            enabled_tools: vec!["start".to_owned(), "spawn_worker".to_owned()],
        };
        let lead = AgentRuntimeToolCatalog::from_ingress_view(&lead_view).unwrap();
        assert_eq!(
            lead.definitions()[0].input_schema["properties"]["ticket"]["enum"],
            json!(["TK-a", "TK-b"])
        );
        assert!(lead.terminal_boundary_tools().is_empty());

        let worker_boundaries = AgentRuntimeToolCatalog::from_ingress_view(&worker_view(&[
            "context",
            "submit_and_compile",
            "submit_output",
            "compile",
        ]))
        .unwrap();
        assert_eq!(
            worker_boundaries.terminal_boundary_tools(),
            ["submit_and_compile".to_owned(), "compile".to_owned()]
        );
        let lead_boundary = AgentRuntimeToolCatalog::from_ingress_view(&AgentBrokerIngressView {
            role: AgentBrokerRole::Lead {
                generation: 1,
                boundary: LeadSliceBoundary::Review {
                    ticket: "TK-a".to_owned(),
                },
            },
            context_completion_required: false,
            enabled_tools: vec!["review".to_owned(), "yield_lead".to_owned()],
        })
        .unwrap();
        assert_eq!(
            lead_boundary.terminal_boundary_tools(),
            ["yield_lead".to_owned()]
        );
        assert!(
            AgentRuntimeToolCatalog::from_ingress_view(&AgentBrokerIngressView {
                role: lead_view.role,
                context_completion_required: false,
                enabled_tools: vec!["invented".to_owned()],
            })
            .is_err()
        );
    }

    #[test]
    fn context_read_and_search_catalog_copy_teaches_complete_adaptive_reads() {
        let catalog = AgentRuntimeToolCatalog::from_ingress_view(&context_bound_worker_view(&[
            "context",
            "read_file",
            "search_files",
        ]))
        .unwrap();
        let descriptions = catalog
            .definitions()
            .iter()
            .map(|definition| (definition.name.as_str(), definition.description.as_str()))
            .collect::<BTreeMap<_, _>>();
        assert!(descriptions["context"].contains("incomplete until eof is true"));
        assert!(descriptions["context"].contains("exact document_path"));
        assert!(descriptions["context"].contains("at least 32768 max_bytes"));
        assert!(descriptions["context"].contains("observed before issuing another call"));
        assert!(descriptions["read_file"].contains("known literal"));
        assert!(descriptions["read_file"].contains("retained in the transcript"));
        assert!(descriptions["search_files"].contains("search before reading broadly"));
        assert!(descriptions["search_files"].contains("Do not search an eof:true file"));
        assert!(
            AgentRuntimeToolCatalog::from_ingress_view(&context_bound_worker_view(&["context"]))
                .is_err(),
            "a new context-complete catalog must carry the exact paging tool"
        );
    }

    #[test]
    fn direct_pi_worker_product_catalog_is_bounded_and_forwards_safe_results() {
        let tools = [
            "read_file",
            "list_files",
            "search_files",
            "write_file",
            "edit_file",
            "run_configured_check",
        ];
        let catalog = AgentRuntimeToolCatalog::from_ingress_view(&worker_view(&tools)).unwrap();
        assert_eq!(
            catalog
                .definitions()
                .iter()
                .map(|definition| definition.name.as_str())
                .collect::<Vec<_>>(),
            tools
        );
        assert_eq!(
            catalog.definitions()[1].input_schema["properties"]["max_entries"]["maximum"],
            1000
        );
        assert_eq!(
            catalog.definitions()[2].input_schema["properties"]["max_matches"]["maximum"],
            200
        );
        assert!(
            catalog.definitions()[2]
                .description
                .contains("issued file/directory entry")
        );
        assert!(
            catalog.definitions()[2]
                .description
                .contains("unlisted ancestor")
        );
        assert_eq!(
            catalog.definitions()[3].input_schema["properties"]["content"]["maxLength"],
            MAX_WORKER_WRITE_CONTENT_BYTES
        );
        assert!(
            catalog.definitions()[4]
                .description
                .contains("exactly one UTF-8 snippet")
        );
        assert_eq!(
            catalog.definitions()[4].input_schema["properties"]["old_text"]["maxLength"],
            MAX_WORKER_EDIT_TEXT_BYTES
        );
        assert_eq!(
            catalog.definitions()[4].input_schema["properties"]["new_text"]["maxLength"],
            MAX_WORKER_EDIT_TEXT_BYTES
        );
        assert!(
            catalog.definitions()[5].input_schema["properties"]
                .get("argv")
                .is_none()
        );

        let content = "pub fn bounded() {}\n";
        let digest = format!("sha256:{}", "a".repeat(64));
        let (broker, calls) = test_broker(
            worker_view(&tools),
            [
                FakeReply::Success(json!({
                    "path": "src/lib.rs",
                    "content": content,
                    "sha256": digest,
                    "bytes": content.len(),
                })),
                FakeReply::Success(json!({
                    "path": "src/lib.rs",
                    "sha256": digest,
                    "bytes": content.len(),
                    "created": false,
                })),
                FakeReply::Success(json!({
                    "path": "src/lib.rs",
                    "sha256": digest,
                    "bytes": content.len(),
                    "created": false,
                    "replacements": 1,
                })),
                FakeReply::Success(json!({
                    "check_id": "unit",
                    "status": "passed",
                    "receipt_id": "receipt-safe",
                })),
            ],
        );
        let execute = |name: &str, arguments: Value| {
            broker
                .execute(
                    &trusted_context(),
                    &AgentToolCall {
                        call_id: format!("call-{name}"),
                        name: name.to_owned(),
                        arguments,
                    },
                )
                .unwrap()
        };
        assert_eq!(
            execute("read_file", json!({"path": "src/lib.rs"})),
            AgentToolOutcome::Success {
                value: json!({
                    "path": "src/lib.rs",
                    "content": content,
                    "sha256": digest,
                    "bytes": content.len(),
                })
            }
        );
        assert_eq!(
            execute(
                "write_file",
                json!({
                    "path": "src/lib.rs",
                    "expected_sha256": digest,
                    "content": content,
                })
            ),
            AgentToolOutcome::Success {
                value: json!({
                    "path": "src/lib.rs",
                    "sha256": digest,
                    "bytes": content.len(),
                    "created": false,
                })
            }
        );
        assert_eq!(
            execute(
                "edit_file",
                json!({
                    "path": "src/lib.rs",
                    "expected_sha256": digest,
                    "old_text": "bounded",
                    "new_text": "surgical",
                })
            ),
            AgentToolOutcome::Success {
                value: json!({
                    "path": "src/lib.rs",
                    "sha256": digest,
                    "bytes": content.len(),
                    "created": false,
                    "replacements": 1,
                })
            }
        );
        assert_eq!(
            execute("run_configured_check", json!({"check_id": "unit"})),
            AgentToolOutcome::Success {
                value: json!({
                    "check_id": "unit",
                    "status": "passed",
                    "receipt_id": "receipt-safe",
                })
            }
        );
        assert_eq!(
            &*calls.lock().unwrap(),
            &[
                "read_file",
                "write_file",
                "edit_file",
                "run_configured_check"
            ]
        );
    }

    #[test]
    fn durable_broker_checks_exact_context_before_inspecting_or_dispatching_call() {
        let (broker, calls) = test_broker(
            worker_view(&["context"]),
            [FakeReply::Success(json!({"document": "bounded context"}))],
        );
        let call = AgentToolCall {
            call_id: "secret-call-that-must-not-be-inspected".to_owned(),
            name: "context".to_owned(),
            arguments: json!({}),
        };
        let mut wrong_contexts = Vec::new();
        let mut wrong = trusted_context();
        wrong.session_id = "other-session".to_owned();
        wrong_contexts.push(wrong);
        let mut wrong = trusted_context();
        wrong.run_id = "other-run".to_owned();
        wrong_contexts.push(wrong);
        let mut wrong = trusted_context();
        wrong.agent_id = "other-agent".to_owned();
        wrong_contexts.push(wrong);
        let mut wrong = trusted_context();
        wrong.attempt += 1;
        wrong_contexts.push(wrong);
        let mut wrong = trusted_context();
        wrong.runtime_process.birth_marker = "recycled-host".to_owned();
        wrong_contexts.push(wrong);
        for wrong in wrong_contexts {
            assert!(broker.execute(&wrong, &call).is_err());
        }
        assert!(calls.lock().unwrap().is_empty());

        let outcome = broker.execute(&trusted_context(), &call).unwrap();
        assert_eq!(
            outcome,
            AgentToolOutcome::Success {
                value: json!({"document": "bounded context"})
            }
        );
        assert_eq!(&*calls.lock().unwrap(), &["context"]);
    }

    #[test]
    fn paged_context_projection_preserves_recovery_metadata_below_pi_transport_limit() {
        let preview = "compiler context\n".repeat(2_000);
        let value = json!({
            "status": "paged",
            "document": preview,
            "document_path": "program/work/tickets/TK-test/context/0123456789abcdef/context.md",
            "offset": 0,
            "next_offset": 34_000,
            "eof": false,
            "sha256": format!("sha256:{}", "a".repeat(64)),
            "bytes": 1_200_000,
            "message": "Continue with read_file.",
        });
        let projected = minimal_model_response("context", value).unwrap();
        assert_eq!(projected["status"], "paged");
        assert_eq!(projected["next_offset"], 34_000);
        assert_eq!(projected["bytes"], 1_200_000);
        let outcome = AgentToolOutcome::Success { value: projected };
        assert!(
            serde_json::to_vec(&outcome).unwrap().len() < 128 * 1024,
            "paged context must remain far below Pi's 768 KiB outcome ceiling"
        );
    }

    #[test]
    fn context_complete_policy_rejects_product_work_once_then_allows_exact_paging() {
        let document_path = "program/work/tickets/TK-test/context/0123456789abcdef/context.md";
        let preview = "c".repeat(32 * 1024);
        let tail = "tail-context";
        let full_bytes = preview.len() + tail.len();
        let sha256 = format!("sha256:{}", "a".repeat(64));
        let (broker, calls) = test_broker(
            context_bound_worker_view(&["context", "read_file", "search_files"]),
            [
                FakeReply::Success(json!({
                    "status": "paged",
                    "document": preview,
                    "document_path": document_path,
                    "offset": 0,
                    "next_offset": 32 * 1024,
                    "eof": false,
                    "sha256": sha256.clone(),
                    "bytes": full_bytes,
                    "message": "Continue with read_file.",
                })),
                FakeReply::Success(json!({
                    "path": document_path,
                    "content": tail,
                    "offset": 32 * 1024,
                    "next_offset": full_bytes,
                    "eof": true,
                    "sha256": sha256,
                    "bytes": full_bytes,
                })),
                FakeReply::Success(json!({
                    "path": "src/lib.rs",
                    "content": "pub fn ready() {}\n",
                    "offset": 0,
                    "next_offset": 18,
                    "eof": true,
                    "sha256": format!("sha256:{}", "b".repeat(64)),
                    "bytes": 18,
                })),
            ],
        );
        let execute = |call_id: &str, name: &str, arguments: Value| {
            broker
                .execute(
                    &trusted_context(),
                    &AgentToolCall {
                        call_id: call_id.to_owned(),
                        name: name.to_owned(),
                        arguments,
                    },
                )
                .unwrap()
        };

        let AgentToolOutcome::Success { value: context } = execute("context", "context", json!({}))
        else {
            panic!("context preview must be delivered");
        };
        assert_eq!(context["document"].as_str().unwrap().len(), 32 * 1024);

        assert_eq!(
            execute(
                "premature-product",
                "read_file",
                json!({"path": "src/lib.rs"}),
            ),
            AgentToolOutcome::Error {
                code: "context_incomplete".to_owned(),
                message: format!(
                    "Compiler context is incomplete. Call `read_file` with the exact compiler context path `{document_path}` and offset 32768, then continue from each returned `next_offset` until `eof:true`. Do not call product file, check, or submission tools before context reaches EOF."
                ),
                retryable: true,
            }
        );
        assert_eq!(&*calls.lock().unwrap(), &["context"]);

        let AgentToolOutcome::Success {
            value: continuation,
        } = execute(
            "context-tail",
            "read_file",
            json!({"path": document_path, "offset": 32 * 1024}),
        )
        else {
            panic!("exact context continuation must be delivered");
        };
        let rebuilt = format!(
            "{}{}",
            context["document"].as_str().unwrap(),
            continuation["content"].as_str().unwrap()
        );
        assert_eq!(rebuilt.len(), full_bytes);
        assert!(rebuilt.ends_with(tail));

        assert!(matches!(
            execute(
                "product-after-eof",
                "read_file",
                json!({"path": "src/lib.rs"}),
            ),
            AgentToolOutcome::Success { .. }
        ));
        assert_eq!(
            &*calls.lock().unwrap(),
            &["context", "read_file", "read_file"]
        );
    }

    #[test]
    fn context_complete_policy_bounds_an_uninformed_second_product_attempt() {
        let document_path = "program/work/tickets/TK-test/context/context.md";
        let (broker, calls) = test_broker(
            context_bound_worker_view(&["context", "read_file", "submit_and_compile"]),
            [FakeReply::Success(json!({
                "status": "paged",
                "document": "preview",
                "document_path": document_path,
                "offset": 0,
                "next_offset": 7,
                "eof": false,
                "sha256": format!("sha256:{}", "a".repeat(64)),
                "bytes": 14,
                "message": "Continue with read_file.",
            }))],
        );
        let call = |call_id: &str| AgentToolCall {
            call_id: call_id.to_owned(),
            name: "submit_and_compile".to_owned(),
            arguments: json!({"payload": {}}),
        };
        broker
            .execute(
                &trusted_context(),
                &AgentToolCall {
                    call_id: "context".to_owned(),
                    name: "context".to_owned(),
                    arguments: json!({}),
                },
            )
            .unwrap();
        assert!(matches!(
            broker.execute(&trusted_context(), &call("first")).unwrap(),
            AgentToolOutcome::Error {
                code,
                retryable: true,
                ..
            } if code == "context_incomplete"
        ));
        assert!(matches!(
            broker.execute(&trusted_context(), &call("second")).unwrap(),
            AgentToolOutcome::Error {
                code,
                retryable: false,
                ..
            } if code == "context_incomplete_retry_limit"
        ));
        assert_eq!(&*calls.lock().unwrap(), &["context"]);
    }

    #[test]
    fn context_policy_defaults_every_unlisted_future_tool_closed() {
        for tool in [
            "graph_context",
            "record_note",
            "read_file",
            "list_files",
            "search_files",
            "write_file",
            "edit_file",
            "run_configured_check",
            "submit_output",
            "submit_and_compile",
            "compile",
            "future_worker_effect",
        ] {
            let mut state = ContextCompletionState::new(true);
            assert!(
                state
                    .gate(&AgentToolCall {
                        call_id: format!("closed-{tool}"),
                        name: tool.to_owned(),
                        arguments: json!({}),
                    })
                    .is_some(),
                "{tool} must fail closed until compiler context reaches EOF"
            );
        }
    }

    #[test]
    fn context_policy_cannot_spend_product_receipts_on_supplements_before_eof() {
        let document_path = "program/work/tickets/TK-test/context/context.md";
        let sha256 = format!("sha256:{}", "a".repeat(64));
        for supplement in ["graph_context", "record_note"] {
            let (broker, calls) = test_broker(
                context_bound_worker_view(&[
                    "context",
                    "read_file",
                    "graph_context",
                    "record_note",
                ]),
                [FakeReply::Success(json!({
                    "status": "paged",
                    "document": "preview",
                    "document_path": document_path,
                    "offset": 0,
                    "next_offset": 7,
                    "eof": false,
                    "sha256": sha256.clone(),
                    "bytes": 14,
                }))],
            );
            let supplement_arguments = if supplement == "graph_context" {
                json!({"anchors": ["claim:test"]})
            } else {
                json!({
                    "node_id": "claim:test",
                    "kind": "observation",
                    "body": "premature supplement"
                })
            };
            let before_context = broker
                .execute(
                    &trusted_context(),
                    &AgentToolCall {
                        call_id: format!("{supplement}-before-context"),
                        name: supplement.to_owned(),
                        arguments: supplement_arguments.clone(),
                    },
                )
                .unwrap();
            assert!(
                matches!(
                    &before_context,
                    AgentToolOutcome::Error {
                        code,
                        retryable: true,
                        ..
                    } if code == "context_incomplete"
                ),
                "{before_context:?}"
            );
            assert!(calls.lock().unwrap().is_empty());
            assert!(matches!(
                broker
                    .execute(
                        &trusted_context(),
                        &AgentToolCall {
                            call_id: "context".to_owned(),
                            name: "context".to_owned(),
                            arguments: json!({}),
                        },
                    )
                    .unwrap(),
                AgentToolOutcome::Success { .. }
            ));
            assert!(matches!(
                broker
                    .execute(
                        &trusted_context(),
                        &AgentToolCall {
                            call_id: format!("{supplement}-during-paging"),
                            name: supplement.to_owned(),
                            arguments: supplement_arguments,
                        },
                    )
                    .unwrap(),
                AgentToolOutcome::Error {
                    code,
                    retryable: false,
                    ..
                } if code == "context_incomplete_retry_limit"
            ));
            assert_eq!(&*calls.lock().unwrap(), &["context"]);
        }
    }

    #[test]
    fn context_continuation_rejects_tiny_pages_once_without_dispatch() {
        let document_path = "program/work/tickets/TK-test/context/context.md";
        let sha256 = format!("sha256:{}", "a".repeat(64));
        let (broker, calls) = test_broker(
            context_bound_worker_view(&["context", "read_file"]),
            [
                FakeReply::Success(json!({
                    "status": "paged",
                    "document": "preview",
                    "document_path": document_path,
                    "offset": 0,
                    "next_offset": 7,
                    "eof": false,
                    "sha256": sha256,
                    "bytes": 14,
                    "message": "Continue with read_file.",
                })),
                FakeReply::Success(json!({
                    "path": document_path,
                    "content": "tail",
                    "offset": 7,
                    "next_offset": 14,
                    "eof": true,
                    "sha256": sha256,
                    "bytes": 14,
                })),
            ],
        );
        let execute = |call_id: &str, name: &str, arguments: Value| {
            broker
                .execute(
                    &trusted_context(),
                    &AgentToolCall {
                        call_id: call_id.to_owned(),
                        name: name.to_owned(),
                        arguments,
                    },
                )
                .unwrap()
        };
        assert!(matches!(
            execute("context", "context", json!({})),
            AgentToolOutcome::Success { .. }
        ));
        assert!(matches!(
            execute(
                "tiny",
                "read_file",
                json!({"path": document_path, "offset": 7, "max_bytes": 1}),
            ),
            AgentToolOutcome::Error {
                code,
                retryable: true,
                ..
            } if code == "context_page_too_small"
        ));
        assert_eq!(&*calls.lock().unwrap(), &["context"]);
        assert!(matches!(
            execute(
                "corrected",
                "read_file",
                json!({"path": document_path, "offset": 7}),
            ),
            AgentToolOutcome::Success { .. }
        ));
        assert_eq!(&*calls.lock().unwrap(), &["context", "read_file"]);
    }

    #[test]
    fn context_cursor_rejects_wrong_request_path_and_offset_without_dispatch() {
        let document_path = "program/work/tickets/TK-test/context/context.md";
        for (label, arguments) in [
            (
                "wrong-path",
                json!({"path": "other/context.md", "offset": 7}),
            ),
            ("wrong-offset", json!({"path": document_path, "offset": 8})),
        ] {
            let (broker, calls) = test_broker(
                context_bound_worker_view(&["context", "read_file"]),
                [FakeReply::Success(json!({
                    "status": "paged",
                    "document": "preview",
                    "document_path": document_path,
                    "offset": 0,
                    "next_offset": 7,
                    "eof": false,
                    "sha256": format!("sha256:{}", "a".repeat(64)),
                    "bytes": 14,
                    "message": "Continue with read_file.",
                }))],
            );
            assert!(matches!(
                broker
                    .execute(
                        &trusted_context(),
                        &AgentToolCall {
                            call_id: format!("{label}-context"),
                            name: "context".to_owned(),
                            arguments: json!({}),
                        },
                    )
                    .unwrap(),
                AgentToolOutcome::Success { .. }
            ));
            assert!(matches!(
                broker
                    .execute(
                        &trusted_context(),
                        &AgentToolCall {
                            call_id: label.to_owned(),
                            name: "read_file".to_owned(),
                            arguments,
                        },
                    )
                    .unwrap(),
                AgentToolOutcome::Error {
                    code,
                    retryable: true,
                    ..
                } if code == "context_incomplete"
            ));
            assert_eq!(&*calls.lock().unwrap(), &["context"]);
        }
    }

    #[test]
    fn context_cursor_is_one_shot_and_cannot_rewind_paging_or_completion() {
        let document_path = "program/work/tickets/TK-test/context/context.md";
        let sha256 = format!("sha256:{}", "a".repeat(64));
        let (paging, paging_calls) = test_broker(
            context_bound_worker_view(&["context", "read_file"]),
            [
                FakeReply::Success(json!({
                    "status": "paged",
                    "document": "preview",
                    "document_path": document_path,
                    "offset": 0,
                    "next_offset": 32768,
                    "eof": false,
                    "sha256": sha256,
                    "bytes": 70000,
                })),
                FakeReply::Success(json!({
                    "path": document_path,
                    "content": "middle",
                    "offset": 32768,
                    "next_offset": 65536,
                    "eof": false,
                    "sha256": sha256,
                    "bytes": 70000,
                })),
            ],
        );
        let call = |id: &str, name: &str, arguments: Value| AgentToolCall {
            call_id: id.to_owned(),
            name: name.to_owned(),
            arguments,
        };
        assert!(matches!(
            paging
                .execute(&trusted_context(), &call("context", "context", json!({})))
                .unwrap(),
            AgentToolOutcome::Success { .. }
        ));
        assert!(matches!(
            paging
                .execute(
                    &trusted_context(),
                    &call("repeat-context", "context", json!({})),
                )
                .unwrap(),
            AgentToolOutcome::Error {
                code,
                retryable: true,
                ..
            } if code == "context_already_issued"
        ));
        assert_eq!(&*paging_calls.lock().unwrap(), &["context"]);
        assert!(matches!(
            paging
                .execute(
                    &trusted_context(),
                    &call(
                        "page",
                        "read_file",
                        json!({
                            "path": document_path,
                            "offset": 32768,
                            "max_bytes": 32768,
                        }),
                    ),
                )
                .unwrap(),
            AgentToolOutcome::Success { .. }
        ));
        assert!(matches!(
            paging
                .execute(
                    &trusted_context(),
                    &call(
                        "old-page-varied-size",
                        "read_file",
                        json!({
                            "path": document_path,
                            "offset": 32768,
                            "max_bytes": 32769,
                        }),
                    ),
                )
                .unwrap(),
            AgentToolOutcome::Error { .. }
        ));
        assert_eq!(&*paging_calls.lock().unwrap(), &["context", "read_file"]);

        let (complete, complete_calls) = test_broker(
            context_bound_worker_view(&["context", "read_file"]),
            [FakeReply::Success(json!({
                "document": "complete compiler context",
                "document_path": document_path,
            }))],
        );
        assert!(matches!(
            complete
                .execute(&trusted_context(), &call("full", "context", json!({})))
                .unwrap(),
            AgentToolOutcome::Success { .. }
        ));
        assert!(matches!(
            complete
                .execute(
                    &trusted_context(),
                    &call("repeat-full", "context", json!({})),
                )
                .unwrap(),
            AgentToolOutcome::Error {
                code,
                retryable: true,
                ..
            } if code == "context_already_issued"
        ));
        assert_eq!(&*complete_calls.lock().unwrap(), &["context"]);
    }

    #[test]
    fn context_cursor_rejects_malformed_path_offset_hash_and_nonadvance() {
        let document_path = "program/work/tickets/TK-test/context/context.md";
        let sha256 = format!("sha256:{}", "a".repeat(64));
        let malformed = [
            (
                "wrong-path",
                json!({
                    "path": "other/context.md",
                    "content": "tail",
                    "offset": 7,
                    "next_offset": 14,
                    "eof": true,
                    "sha256": sha256,
                    "bytes": 14,
                }),
            ),
            (
                "wrong-offset",
                json!({
                    "path": document_path,
                    "content": "tail",
                    "offset": 8,
                    "next_offset": 14,
                    "eof": true,
                    "sha256": sha256,
                    "bytes": 14,
                }),
            ),
            (
                "changed-sha",
                json!({
                    "path": document_path,
                    "content": "tail",
                    "offset": 7,
                    "next_offset": 14,
                    "eof": true,
                    "sha256": format!("sha256:{}", "b".repeat(64)),
                    "bytes": 14,
                }),
            ),
            (
                "nonadvance",
                json!({
                    "path": document_path,
                    "content": "",
                    "offset": 7,
                    "next_offset": 7,
                    "eof": false,
                    "sha256": sha256,
                    "bytes": 14,
                }),
            ),
        ];
        for (label, malformed_page) in malformed {
            let (broker, calls) = test_broker(
                context_bound_worker_view(&["context", "read_file"]),
                [
                    FakeReply::Success(json!({
                        "status": "paged",
                        "document": "preview",
                        "document_path": document_path,
                        "offset": 0,
                        "next_offset": 7,
                        "eof": false,
                        "sha256": sha256,
                        "bytes": 14,
                        "message": "Continue with read_file.",
                    })),
                    FakeReply::Success(malformed_page),
                ],
            );
            assert!(matches!(
                broker
                    .execute(
                        &trusted_context(),
                        &AgentToolCall {
                            call_id: format!("{label}-context"),
                            name: "context".to_owned(),
                            arguments: json!({}),
                        },
                    )
                    .unwrap(),
                AgentToolOutcome::Success { .. }
            ));
            assert!(matches!(
                broker
                    .execute(
                        &trusted_context(),
                        &AgentToolCall {
                            call_id: label.to_owned(),
                            name: "read_file".to_owned(),
                            arguments: json!({"path": document_path, "offset": 7}),
                        },
                    )
                    .unwrap(),
                AgentToolOutcome::Error {
                    code,
                    retryable: false,
                    ..
                } if code == "boundary_rejected"
            ));
            assert_eq!(&*calls.lock().unwrap(), &["context", "read_file"]);
        }
    }

    #[test]
    fn context_cursor_requires_valid_initial_hash_and_string_document() {
        for malformed in [
            json!({
                "status": "paged",
                "document": "preview",
                "document_path": "program/work/tickets/TK-test/context/context.md",
                "offset": 0,
                "next_offset": 7,
                "eof": false,
                "sha256": "not-a-hash",
                "bytes": 14,
                "message": "Continue with read_file.",
            }),
            json!({"document": null}),
        ] {
            let (broker, calls) = test_broker(
                context_bound_worker_view(&["context", "read_file"]),
                [FakeReply::Success(malformed)],
            );
            assert!(matches!(
                broker
                    .execute(
                        &trusted_context(),
                        &AgentToolCall {
                            call_id: "context".to_owned(),
                            name: "context".to_owned(),
                            arguments: json!({}),
                        },
                    )
                    .unwrap(),
                AgentToolOutcome::Error {
                    code,
                    retryable: false,
                    ..
                } if code == "context_unavailable"
            ));
            assert_eq!(&*calls.lock().unwrap(), &["context"]);
        }
    }

    #[test]
    fn already_issued_context_recovers_from_exact_zero_offset() {
        let document_path = "program/work/tickets/TK-test/context/context.md";
        let sha256 = format!("sha256:{}", "a".repeat(64));
        let (broker, calls) = test_broker(
            context_bound_worker_view(&["context", "read_file"]),
            [
                FakeReply::Success(json!({
                    "document_path": document_path,
                    "message": "Recover exact context.",
                })),
                FakeReply::Success(json!({
                    "path": document_path,
                    "content": "complete",
                    "offset": 0,
                    "next_offset": 8,
                    "eof": true,
                    "sha256": sha256,
                    "bytes": 8,
                })),
            ],
        );
        assert!(matches!(
            broker
                .execute(
                    &trusted_context(),
                    &AgentToolCall {
                        call_id: "recover-context".to_owned(),
                        name: "context".to_owned(),
                        arguments: json!({}),
                    },
                )
                .unwrap(),
            AgentToolOutcome::Success { value }
                if value.get("status").and_then(Value::as_str) == Some("already_issued")
        ));
        assert!(matches!(
            broker
                .execute(
                    &trusted_context(),
                    &AgentToolCall {
                        call_id: "recover-page".to_owned(),
                        name: "read_file".to_owned(),
                        arguments: json!({"path": document_path, "offset": 0}),
                    },
                )
                .unwrap(),
            AgentToolOutcome::Success { .. }
        ));
        assert_eq!(&*calls.lock().unwrap(), &["context", "read_file"]);
    }

    #[test]
    fn legacy_catalog_without_context_policy_keeps_its_pinned_behavior() {
        let legacy: AgentBrokerIngressView = serde_json::from_value(json!({
            "role": {
                "kind": "worker",
                "ticket": "TK-test",
                "step": "implement",
                "persona": "builder"
            },
            "enabled_tools": ["read_file"]
        }))
        .unwrap();
        assert!(!legacy.context_completion_required);
        let (broker, calls) = test_broker(
            legacy,
            [FakeReply::Success(json!({
                "path": "src/lib.rs",
                "content": "legacy\n",
                "offset": 0,
                "next_offset": 7,
                "eof": true,
                "sha256": format!("sha256:{}", "a".repeat(64)),
                "bytes": 7,
            }))],
        );
        assert!(matches!(
            broker
                .execute(
                    &trusted_context(),
                    &AgentToolCall {
                        call_id: "legacy-read".to_owned(),
                        name: "read_file".to_owned(),
                        arguments: json!({"path": "src/lib.rs"}),
                    },
                )
                .unwrap(),
            AgentToolOutcome::Success { .. }
        ));
        assert_eq!(&*calls.lock().unwrap(), &["read_file"]);
    }

    #[test]
    fn durable_broker_rejects_out_of_schema_arguments_before_dispatch() {
        let (broker, calls) = test_broker(
            worker_view(&[
                "context",
                "read_file",
                "list_files",
                "search_files",
                "write_file",
                "edit_file",
                "run_configured_check",
                "graph_context",
                "record_note",
                "submit_and_compile",
            ]),
            std::iter::empty::<FakeReply>(),
        );
        for (name, arguments) in [
            ("context", json!({"invented": true})),
            ("read_file", json!({"path": ""})),
            ("list_files", json!({"path": "src", "max_entries": 1001})),
            (
                "search_files",
                json!({"path": "src", "query": "needle", "max_matches": 201}),
            ),
            (
                "write_file",
                json!({
                    "path": "src/lib.rs",
                    "expected_sha256": "not-a-hash",
                    "content": "after",
                    "content_sha256": "also-not-a-hash",
                }),
            ),
            (
                "edit_file",
                json!({
                    "path": "src/lib.rs",
                    "expected_sha256": "missing",
                    "old_text": "before",
                    "new_text": "after",
                }),
            ),
            (
                "edit_file",
                json!({
                    "path": "src/lib.rs",
                    "expected_sha256": format!("sha256:{}", "a".repeat(64)),
                    "old_text": "",
                    "new_text": "after",
                }),
            ),
            (
                "edit_file",
                json!({
                    "path": "src/lib.rs",
                    "expected_sha256": format!("sha256:{}", "a".repeat(64)),
                    "old_text": "same",
                    "new_text": "same",
                }),
            ),
            (
                "edit_file",
                json!({
                    "path": "src/lib.rs",
                    "expected_sha256": format!("sha256:{}", "a".repeat(64)),
                    "old_text": "before",
                    "new_text": "after\u{0000}",
                }),
            ),
            (
                "run_configured_check",
                json!({"check_id": "unit", "argv": ["sh", "-c", "forbidden"]}),
            ),
            ("graph_context", json!({"anchors": [""]})),
            (
                "record_note",
                json!({"node_id": "ND-a", "kind": "invented", "body": "bounded"}),
            ),
            ("submit_and_compile", json!({"payload": []})),
        ] {
            assert_eq!(
                broker
                    .execute(
                        &trusted_context(),
                        &AgentToolCall {
                            call_id: format!("invalid-{name}"),
                            name: name.to_owned(),
                            arguments,
                        },
                    )
                    .unwrap(),
                AgentToolOutcome::Error {
                    code: "invalid_arguments".to_owned(),
                    message: "Use exactly the compiler-issued tool schema.".to_owned(),
                    retryable: true,
                }
            );
        }
        assert!(calls.lock().unwrap().is_empty());

        let role = worker_view(&["edit_file"]).role;
        assert!(
            validate_tool_arguments(
                &role,
                "edit_file",
                json!({
                    "path": "src/lib.rs",
                    "expected_sha256": format!("sha256:{}", "a".repeat(64)),
                    "old_text": "é",
                    "new_text": "",
                }),
            )
            .is_ok(),
            "an exact multibyte anchor may be deleted"
        );
        assert!(
            validate_tool_arguments(
                &role,
                "edit_file",
                json!({
                    "path": "src/lib.rs",
                    "expected_sha256": format!("sha256:{}", "a".repeat(64)),
                    "old_text": "é".repeat(MAX_WORKER_EDIT_TEXT_BYTES / 2 + 1),
                    "new_text": "after",
                }),
            )
            .is_err(),
            "the edit limit is encoded UTF-8 bytes, not Unicode scalar count"
        );
    }

    #[test]
    fn worst_case_worker_write_arguments_fit_one_complete_pi_tool_call_frame() {
        use crate::pi_protocol::{
            DEFAULT_MAX_PI_FRAME_BYTES, MAX_PI_TOOL_ARGUMENT_JSON_BYTES, PiFrame, PiFrameHeader,
            write_pi_frame,
        };

        // Every accepted byte in this pattern expands to two JSON bytes.
        // Other control characters could expand to six, so the public/Rust
        // boundary rejects them instead of pretending a character limit is a
        // wire-size limit.
        let content = "\"\\\n\t".repeat(MAX_WORKER_WRITE_CONTENT_BYTES / 4);
        assert_eq!(content.len(), MAX_WORKER_WRITE_CONTENT_BYTES);
        let arguments = json!({
            "path": "src/lib.rs",
            "expected_sha256": format!("sha256:{}", "a".repeat(64)),
            "content": content,
        });
        let write_view = worker_view(&["write_file"]);
        let valid = validate_tool_arguments(&write_view.role, "write_file", arguments.clone());
        assert!(valid.is_ok());
        let frame = PiFrame::ToolCall {
            header: PiFrameHeader::new("session-pi", 1),
            call: AgentToolCall {
                call_id: "call-write".to_owned(),
                name: "write_file".to_owned(),
                arguments,
            },
        };
        let mut encoded = Vec::new();
        write_pi_frame(&mut encoded, &frame, DEFAULT_MAX_PI_FRAME_BYTES).unwrap();
        assert!(encoded.len() < DEFAULT_MAX_PI_FRAME_BYTES);
        assert!(
            serde_json::to_vec(&frame).unwrap().len() < MAX_PI_TOOL_ARGUMENT_JSON_BYTES,
            "the largest accepted full-file write must fit the Pi host argument preflight"
        );

        let forbidden_control = json!({
            "path": "src/lib.rs",
            "expected_sha256": "missing",
            "content": "prefix\u{0000}suffix",
        });
        let invalid = validate_tool_arguments(&write_view.role, "write_file", forbidden_control);
        assert!(invalid.is_err());

        let edit_old_text = "\"\\\n\t".repeat(MAX_WORKER_EDIT_TEXT_BYTES / 4);
        let edit_new_text = "\t\n\\\"".repeat(MAX_WORKER_EDIT_TEXT_BYTES / 4);
        assert_eq!(edit_old_text.len(), MAX_WORKER_EDIT_TEXT_BYTES);
        assert_eq!(edit_new_text.len(), MAX_WORKER_EDIT_TEXT_BYTES);
        let edit_arguments = json!({
            "path": "src/lib.rs",
            "expected_sha256": format!("sha256:{}", "a".repeat(64)),
            "old_text": edit_old_text,
            "new_text": edit_new_text,
        });
        let edit_view = worker_view(&["edit_file"]);
        assert!(
            validate_tool_arguments(&edit_view.role, "edit_file", edit_arguments.clone()).is_ok()
        );
        let frame = PiFrame::ToolCall {
            header: PiFrameHeader::new("session-pi", 2),
            call: AgentToolCall {
                call_id: "call-edit".to_owned(),
                name: "edit_file".to_owned(),
                arguments: edit_arguments,
            },
        };
        let mut encoded = Vec::new();
        write_pi_frame(&mut encoded, &frame, DEFAULT_MAX_PI_FRAME_BYTES).unwrap();
        assert!(
            encoded.len() < MAX_PI_TOOL_ARGUMENT_JSON_BYTES,
            "the largest accepted edit must fit the Pi host argument preflight"
        );
        assert!(
            encoded.len() < 640 * 1024,
            "surgical edits retain substantial headroom even with two maximally escaped snippets"
        );
    }

    #[test]
    fn durable_broker_minimizes_results_and_marks_consuming_boundaries_terminal() {
        let (broker, calls) = test_broker(
            worker_view(&["context", "record_note", "submit_and_compile"]),
            [
                FakeReply::Success(json!({
                    "document": {"ticket": "TK-test"},
                    "document_path": "/private/compiler/path",
                    "internal": "must-not-cross"
                })),
                FakeReply::Success(json!({
                    "note": {"id": "NT-safe", "internal": "must-not-cross"},
                    "replayed": true,
                    "authority": "advisory_non_authoritative",
                    "internal": "must-not-cross"
                })),
                FakeReply::Success(json!({
                    "accepted": true,
                    "compiler_receipt": "must-not-cross"
                })),
            ],
        );
        let execute = |name: &str, arguments: Value| {
            broker
                .execute(
                    &trusted_context(),
                    &AgentToolCall {
                        call_id: format!("call-{name}"),
                        name: name.to_owned(),
                        arguments,
                    },
                )
                .unwrap()
        };
        assert_eq!(
            execute("context", json!({})),
            AgentToolOutcome::Success {
                value: json!({"document": {"ticket": "TK-test"}})
            }
        );
        assert_eq!(
            execute(
                "record_note",
                json!({"node_id": "ND-a", "kind": "nit", "body": "bounded"})
            ),
            AgentToolOutcome::Success {
                value: json!({
                    "status": "accepted",
                    "note_id": "NT-safe",
                    "replayed": true,
                    "authority": "advisory_non_authoritative"
                })
            }
        );
        assert_eq!(
            execute("submit_and_compile", json!({"payload": {}})),
            AgentToolOutcome::Terminate {
                value: json!({"status": "accepted"})
            }
        );
        assert_eq!(
            &*calls.lock().unwrap(),
            &["context", "record_note", "submit_and_compile"]
        );
        assert!(terminal_boundary_tool("compile"));
        assert!(terminal_boundary_tool("yield_lead"));
        assert!(!terminal_boundary_tool("submit_output"));
    }

    #[test]
    fn durable_broker_bounds_safe_validation_rejections_without_a_fourth_dispatch() {
        let validation_error = || {
            KoniError::Graph(
                "node PRIVATE_NODE type proof requires field command_result_contract".to_owned(),
            )
        };
        let (broker, calls) = test_broker(
            worker_view(&["submit_and_compile"]),
            [
                FakeReply::Error(validation_error()),
                FakeReply::Error(validation_error()),
                FakeReply::Error(validation_error()),
            ],
        );
        let call = AgentToolCall {
            call_id: "call-submit".to_owned(),
            name: "submit_and_compile".to_owned(),
            arguments: json!({"payload": {}}),
        };
        for attempt in 1..=4 {
            let outcome = broker.execute(&trusted_context(), &call).unwrap();
            let AgentToolOutcome::Error {
                code,
                message,
                retryable,
            } = outcome
            else {
                panic!("validation rejection must be a safe error")
            };
            assert!(!message.contains("PRIVATE_NODE"));
            if attempt < 3 {
                assert_eq!(code, "revise_validation");
                assert!(retryable);
            } else {
                assert_eq!(code, "validation_retry_limit");
                assert!(!retryable);
            }
        }
        assert_eq!(calls.lock().unwrap().len(), 3);
    }

    #[test]
    fn durable_broker_allows_one_read_scope_parent_correction_then_stops() {
        let scope_parent_error = || {
            KoniError::Action(
                "ticket PRIVATE_TICKET step baseline referenced unlisted ancestors of its configured read scope: private/parent"
                    .to_owned(),
            )
        };
        let (broker, calls) = test_broker(
            worker_view(&["search_files"]),
            [
                FakeReply::Error(scope_parent_error()),
                FakeReply::Error(scope_parent_error()),
            ],
        );
        let call = AgentToolCall {
            call_id: "call-search".to_owned(),
            name: "search_files".to_owned(),
            arguments: json!({"path": "src", "query": "needle"}),
        };

        for attempt in 1..=3 {
            let AgentToolOutcome::Error {
                code,
                message,
                retryable,
            } = broker.execute(&trusted_context(), &call).unwrap()
            else {
                panic!("scope correction must stay a safe model-visible error")
            };
            assert!(!message.contains("PRIVATE_TICKET"));
            assert!(!message.contains("private/parent"));
            if attempt == 1 {
                assert_eq!(code, "file_scope_retry");
                assert!(retryable);
                assert!(message.contains("selected_step.read_paths"));
            } else {
                assert_eq!(code, "file_scope_retry_limit");
                assert!(!retryable);
            }
        }
        assert_eq!(calls.lock().unwrap().len(), 2);
    }

    #[test]
    fn failed_terminal_check_stays_nonterminal_and_bounds_same_session_repair() {
        let check_failure = || {
            KoniError::AgentToolFeedback {
            code: "configured_check_failed".to_owned(),
            message: "Assigned check failed safely. Repair it, call `run_configured_check`, then resubmit."
                .to_owned(),
            retryable: true,
        }
        };
        let (broker, calls) = test_broker(
            worker_view(&["submit_and_compile"]),
            [
                FakeReply::Error(check_failure()),
                FakeReply::Error(check_failure()),
                FakeReply::Error(check_failure()),
            ],
        );
        let call = AgentToolCall {
            call_id: "call-submit".to_owned(),
            name: "submit_and_compile".to_owned(),
            arguments: json!({"payload": {}}),
        };

        for attempt in 1..=4 {
            let outcome = broker.execute(&trusted_context(), &call).unwrap();
            assert!(!outcome.is_terminal());
            let AgentToolOutcome::Error {
                code,
                message,
                retryable,
            } = outcome
            else {
                panic!("a failed terminal check must remain model-repairable")
            };
            if attempt < 3 {
                assert_eq!(code, "configured_check_failed");
                assert!(retryable);
                assert!(message.contains("run_configured_check"));
            } else {
                assert_eq!(code, "validation_retry_limit");
                assert!(!retryable);
                assert!(message.contains("Final compiler correction"));
            }
        }
        assert_eq!(calls.lock().unwrap().len(), 3);
    }
}
