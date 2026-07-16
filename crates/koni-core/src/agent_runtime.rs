//! Provider-neutral agent runtime contracts and supervised stdio transport.

use std::fmt;
use std::fs;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(test)]
use crate::agent::owned_agent_process_is_alive;
use crate::agent::{
    AgentProcessIdentity, capture_owned_agent_process_identity, isolate_process_group,
    terminate_agent_process,
};
use crate::agent_tool_broker::{AgentToolCall, AgentToolOutcome};
use crate::error::{KoniError, Result, io_error};
use crate::pi_auth::{
    CredentialBrokerRequest, CredentialBrokerResponse, CredentialLeaseId, OAuthInteraction,
};
use crate::pi_protocol::{
    DEFAULT_MAX_PI_FRAME_BYTES, PiFrame, PiFrameHeader, PiProtocolSequenceValidator, read_pi_frame,
    write_pi_frame,
};

const MAX_AGENT_RUNTIME_STDERR_BYTES: usize = 256 * 1024;
const AGENT_RUNTIME_STDERR_TRUNCATION_MARKER: &[u8] =
    b"\n[koni: additional runtime stderr was discarded at the 256 KiB limit]\n";

type HostStderrThread = thread::JoinHandle<std::io::Result<()>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeModelRef {
    pub provider: String,
    pub model: String,
    pub thinking_level: RuntimeThinkingLevel,
    #[serde(default)]
    pub input_capabilities: Vec<String>,
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeModelInfo {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub api: String,
    pub reasoning: bool,
    #[serde(default)]
    pub input: Vec<String>,
    pub context_window: u64,
    pub max_tokens: u64,
    #[serde(default)]
    pub thinking_levels: Vec<RuntimeThinkingLevel>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeHostMetadata {
    pub host_version: String,
    pub pi_sdk_version: String,
    pub provider: String,
    pub ambient_resources: bool,
    pub ambient_credentials: bool,
    pub tools: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeSessionRef {
    pub runtime: String,
    pub protocol_version: u16,
    pub provider: String,
    pub model: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PiRuntimeFailure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl PiRuntimeFailure {
    pub(crate) fn from_wire(code: &str, message: &str, retryable: bool) -> Option<Self> {
        let (canonical_message, canonical_retryable) = match code {
            "provider_usage_limit" => (
                "Your ChatGPT Codex usage limit has been reached. Wait for it to reset, then resume the run.",
                false,
            ),
            "provider_authentication" => (
                "OpenAI Codex rejected the stored sign-in. Run koni auth login, then resume the run.",
                false,
            ),
            "provider_access_denied" => (
                "OpenAI Codex denied this account or model. Check ChatGPT subscription and model access, then retry.",
                false,
            ),
            "provider_request_rejected" => (
                "OpenAI Codex rejected the request. Check the selected model and Koni runtime compatibility before retrying.",
                false,
            ),
            "provider_rate_limited" => (
                "OpenAI Codex is temporarily rate-limiting requests. Retry after a short delay.",
                true,
            ),
            "provider_unavailable" => (
                "OpenAI Codex is temporarily unavailable. Retry this turn.",
                true,
            ),
            "provider_error" => (
                "OpenAI Codex failed for an unclassified reason. Retry manually; if it repeats, reauthenticate and check service status.",
                false,
            ),
            "runtime_broker_timeout" => (
                "The compiler tool broker did not respond in time. Inspect the run state, then resume safely.",
                false,
            ),
            "runtime_credential_channel" => (
                "The Pi runtime private credential channel is unavailable.",
                false,
            ),
            "runtime_output_limit" => (
                "The agent response was too large for this run's output allowance. Its transcript was preserved; start a larger run or revise the run-type limits before retrying.",
                false,
            ),
            "runtime_protocol_error" => (
                "The Pi runtime protocol failed closed. Restart Koni before resuming the run.",
                false,
            ),
            "runtime_unsupported" => (
                "This Koni installation cannot run the requested Pi operation. Update Koni before retrying.",
                false,
            ),
            "runtime_internal" => (
                "The Pi runtime failed internally. Retry manually; if it repeats, inspect Koni diagnostics.",
                false,
            ),
            _ => return None,
        };
        (message == canonical_message && retryable == canonical_retryable).then(|| Self {
            code: code.to_owned(),
            message: canonical_message.to_owned(),
            retryable: canonical_retryable,
        })
    }
}

impl fmt::Display for PiRuntimeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeSessionStart {
    pub session_id: String,
    pub run_id: String,
    pub agent_id: String,
    pub attempt: u32,
    pub model: RuntimeModelRef,
    pub instructions: String,
    #[serde(default)]
    pub tools: Vec<RuntimeToolDefinition>,
    /// Exact compiler-issued tools whose accepted outcomes end the current
    /// assignment. An empty list disables the bounded prose-only correction,
    /// which is the default for legacy, planning, and read-only sessions.
    #[serde(default)]
    pub terminal_boundary_tools: Vec<String>,
    /// Compiler-bound context-observation policy. Missing/false preserves the
    /// wire identity and same-message behavior of historical and read-only
    /// sessions; only new complete-before-product Workers set it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub context_completion_required: bool,
    pub credential_lease: CredentialLeaseId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuntimeInput {
    Text {
        text: String,
    },
    Image {
        media_type: String,
        sha256: String,
        /// Base64-encoded media bytes verified and bounded by Rust before the
        /// host frame is constructed. The Node host receives no path access.
        data_base64: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeTurnRequest {
    pub turn_id: String,
    pub input: Vec<RuntimeInput>,
    pub output_schema: Option<Value>,
    /// Cumulative provider-reported output-token cap for this turn. Input and
    /// cache-read tokens are metered separately and are not part of this cap.
    pub output_token_budget: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "control", rename_all = "snake_case")]
pub enum RuntimeControl {
    Steer { text: String },
    FollowUp { text: String },
    Cancel { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum RuntimeCommand {
    ListModels,
    Metadata,
    StartSession {
        request: RuntimeSessionStart,
    },
    StartTurn {
        request: RuntimeTurnRequest,
    },
    Control {
        control: RuntimeControl,
    },
    Authenticate {
        /// Opaque Rust-issued capability binding every private fd3 credential
        /// frame for this authentication host session.
        credential_lease: CredentialLeaseId,
        request: CredentialBrokerRequest,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuntimeResponse {
    Accepted,
    Models {
        models: Vec<RuntimeModelInfo>,
    },
    Metadata {
        metadata: RuntimeHostMetadata,
    },
    SessionStarted {
        session: RuntimeSessionRef,
    },
    Authentication {
        response: CredentialBrokerResponse,
    },
    Rejected {
        code: String,
        message: String,
        retryable: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum RuntimeEvent {
    TurnStarted {
        turn_id: String,
    },
    MessageDelta {
        turn_id: String,
        message_id: String,
        text: String,
    },
    MessageCompleted {
        turn_id: String,
        message_id: String,
        role: String,
        content: Value,
    },
    ToolStarted {
        turn_id: String,
        call_id: String,
        name: String,
    },
    ToolUpdated {
        turn_id: String,
        call_id: String,
        update: Value,
    },
    ToolCompleted {
        turn_id: String,
        call_id: String,
        outcome: AgentToolOutcome,
    },
    /// Pi rejected malformed/truncated arguments before the compiler broker
    /// was invoked. This is model-visible validation failure, never evidence
    /// that a Koni tool ran.
    ToolRejected {
        turn_id: String,
        call_id: String,
        name: String,
        code: String,
        message: String,
    },
    Usage {
        turn_id: String,
        usage: RuntimeUsage,
    },
    Retry {
        turn_id: String,
        attempt: u32,
        delay_ms: u64,
        reason: String,
    },
    Compaction {
        turn_id: String,
        source_message_ids: Vec<String>,
        summary_sha256: String,
    },
    TurnCompleted {
        turn_id: String,
        stop_reason: String,
        usage: RuntimeUsage,
    },
    RuntimeError {
        turn_id: Option<String>,
        code: String,
        message: String,
        retryable: bool,
    },
    Authentication {
        interaction: OAuthInteraction,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "message", rename_all = "snake_case")]
pub enum RuntimeInbound {
    Response {
        sequence: u64,
        request_id: String,
        response: RuntimeResponse,
    },
    Event {
        sequence: u64,
        event: RuntimeEvent,
    },
    ToolCall {
        sequence: u64,
        call: AgentToolCall,
    },
}

/// Common runtime surface consumed by the deterministic engine.
pub trait AgentRuntime {
    fn session_id(&self) -> &str;
    fn process_identity(&self) -> &AgentProcessIdentity;
    fn send_command(&mut self, request_id: &str, command: RuntimeCommand) -> Result<()>;
    fn send_tool_result(&mut self, call_id: &str, outcome: AgentToolOutcome) -> Result<()>;
    fn receive(&mut self) -> Result<Option<RuntimeInbound>>;
    /// Wait at most `timeout` for one complete inbound frame. `None` means
    /// only that the deadline elapsed; EOF and reader failure are errors.
    fn receive_timeout(&mut self, timeout: Duration) -> Result<Option<RuntimeInbound>>;
    fn terminate(&mut self) -> Result<()>;
}

#[derive(Debug, Clone)]
pub(crate) struct AgentRuntimeHostRequest {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub working_directory: PathBuf,
    pub stderr_path: PathBuf,
    pub session_id: String,
    pub environment_set: Vec<(String, String)>,
    pub environment_remove: Vec<String>,
    /// A trusted host should normally receive only explicitly supplied values.
    pub inherit_environment: bool,
    pub max_frame_bytes: usize,
}

impl AgentRuntimeHostRequest {
    pub(crate) fn with_defaults(
        executable: impl Into<PathBuf>,
        working_directory: impl Into<PathBuf>,
        stderr_path: impl Into<PathBuf>,
        session_id: impl Into<String>,
    ) -> Self {
        Self {
            executable: executable.into(),
            args: Vec::new(),
            working_directory: working_directory.into(),
            stderr_path: stderr_path.into(),
            session_id: session_id.into(),
            environment_set: Vec::new(),
            environment_remove: Vec::new(),
            inherit_environment: false,
            max_frame_bytes: DEFAULT_MAX_PI_FRAME_BYTES,
        }
    }
}

/// Supervised bidirectional child transport for a Koni-owned runtime host.
///
/// Invalid inbound data terminates the complete owned process group. Drop is
/// also fail-closed and reaps the child, so a Node helper cannot outlive the
/// Rust authority that launched it.
pub(crate) struct SupervisedAgentRuntimeHost {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    inbound: Option<Receiver<HostReaderMessage>>,
    reader_thread: Option<thread::JoinHandle<()>>,
    stderr_thread: Option<HostStderrThread>,
    identity: AgentProcessIdentity,
    session_id: String,
    max_frame_bytes: usize,
    outbound_sequence: u64,
    inbound_validator: PiProtocolSequenceValidator,
    terminated: bool,
}

impl std::fmt::Debug for SupervisedAgentRuntimeHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SupervisedAgentRuntimeHost")
            .field("identity", &self.identity)
            .field("session_id", &self.session_id)
            .field("max_frame_bytes", &self.max_frame_bytes)
            .field("outbound_sequence", &self.outbound_sequence)
            .field("terminated", &self.terminated)
            .finish_non_exhaustive()
    }
}

impl SupervisedAgentRuntimeHost {
    #[cfg(test)]
    pub(crate) fn spawn(
        request: &AgentRuntimeHostRequest,
        on_started: &mut dyn FnMut(&AgentProcessIdentity) -> Result<()>,
    ) -> Result<Self> {
        #[cfg(unix)]
        {
            Self::spawn_inner(request, None, on_started)
        }
        #[cfg(not(unix))]
        {
            Self::spawn_inner(request, on_started)
        }
    }

    /// Spawn the host with its secret-bearing credential protocol attached to
    /// inherited fd 3. Public stdin/stdout remain token-free.
    #[cfg(unix)]
    pub(crate) fn spawn_with_credential_socket(
        request: &AgentRuntimeHostRequest,
        credential_socket: UnixStream,
        on_started: &mut dyn FnMut(&AgentProcessIdentity) -> Result<()>,
    ) -> Result<Self> {
        Self::spawn_inner(request, Some(credential_socket), on_started)
    }

    fn spawn_inner(
        request: &AgentRuntimeHostRequest,
        #[cfg(unix)] credential_socket: Option<UnixStream>,
        on_started: &mut dyn FnMut(&AgentProcessIdentity) -> Result<()>,
    ) -> Result<Self> {
        validate_host_request(request)?;
        let stderr_parent = request.stderr_path.parent().ok_or_else(|| {
            KoniError::Process(format!(
                "agent runtime stderr path has no parent: {}",
                request.stderr_path.display()
            ))
        })?;
        fs::create_dir_all(stderr_parent).map_err(|error| io_error(stderr_parent, error))?;
        let stderr_capture = fs::File::create(&request.stderr_path)
            .map_err(|error| io_error(&request.stderr_path, error))?;

        let mut command = Command::new(&request.executable);
        if !request.inherit_environment {
            command.env_clear();
        }
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
            .stderr(Stdio::piped());
        #[cfg(unix)]
        let inherited_credential = if let Some(credential_socket) = credential_socket {
            // Duplicate above fd 3 before fork so the pre-exec dup2 always
            // clears CLOEXEC, even when the original socket happened to be
            // allocated as descriptor 3.
            let inherited =
                rustix::io::fcntl_dupfd_cloexec(&credential_socket, 4).map_err(|error| {
                    KoniError::Process(format!(
                        "could not prepare Pi private credential descriptor: {error}"
                    ))
                })?;
            drop(credential_socket);
            command.env("KONI_PI_CREDENTIAL_FD", "3");
            Some(inherited)
        } else {
            None
        };
        #[cfg(unix)]
        let max_fd = rustix::process::getrlimit(rustix::process::Resource::Nofile)
            .current
            .unwrap_or(1_048_576)
            .min(i32::MAX as u64) as i32;
        #[cfg(unix)]
        // SAFETY: only async-signal-safe syscalls run between fork and exec.
        // fd 3 is the sole intentional private capability. Every other
        // descriptor is marked CLOEXEC, including descriptors inherited from
        // an embedding application; Rust's own exec-error pipe stays usable
        // until the successful exec boundary.
        unsafe {
            command.pre_exec(move || {
                if let Some(inherited) = inherited_credential.as_ref()
                    && libc::dup2(inherited.as_raw_fd(), 3) == -1
                {
                    return Err(std::io::Error::last_os_error());
                }
                if inherited_credential.is_none() {
                    let _ = libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC);
                }
                #[cfg(target_os = "linux")]
                {
                    let closed = libc::syscall(
                        libc::SYS_close_range,
                        4_u32,
                        u32::MAX,
                        libc::CLOSE_RANGE_CLOEXEC,
                    );
                    if closed == 0 {
                        return Ok(());
                    }
                }
                for fd in 4..max_fd {
                    let _ = libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                }
                Ok(())
            });
        }
        isolate_process_group(&mut command);

        let mut child = command.spawn().map_err(|error| {
            KoniError::Process(format!(
                "failed to spawn agent runtime host {}: {error}",
                request.executable.display()
            ))
        })?;
        let pid = child.id();
        let Some(stderr) = child.stderr.take() else {
            let _ = terminate_agent_process(&mut child, pid);
            let _ = child.wait();
            return Err(KoniError::Process(
                "agent runtime host has no stderr pipe".to_owned(),
            ));
        };
        let mut stderr_thread = match spawn_host_stderr_drain(stderr, stderr_capture) {
            Ok(thread) => Some(thread),
            Err(error) => {
                let _ = terminate_agent_process(&mut child, pid);
                let _ = child.wait();
                return Err(error);
            }
        };
        let identity = capture_identity_after_spawn(pid).ok_or_else(|| {
            finish_failed_host_spawn(&mut child, pid, &mut stderr_thread);
            KoniError::Process(format!(
                "could not capture durable identity for agent runtime host {pid}"
            ))
        })?;
        if let Err(error) = on_started(&identity) {
            finish_failed_host_spawn(&mut child, identity.process_group_id, &mut stderr_thread);
            return Err(error);
        }
        let Some(stdin) = child.stdin.take() else {
            finish_failed_host_spawn(&mut child, identity.process_group_id, &mut stderr_thread);
            return Err(KoniError::Process(
                "agent runtime host has no stdin pipe".to_owned(),
            ));
        };
        let Some(stdout) = child.stdout.take() else {
            finish_failed_host_spawn(&mut child, identity.process_group_id, &mut stderr_thread);
            return Err(KoniError::Process(
                "agent runtime host has no stdout pipe".to_owned(),
            ));
        };
        let (inbound_sender, inbound) = mpsc::sync_channel(1);
        let reader_thread = match spawn_host_reader(stdout, request.max_frame_bytes, inbound_sender)
        {
            Ok(reader_thread) => reader_thread,
            Err(error) => {
                finish_failed_host_spawn(&mut child, identity.process_group_id, &mut stderr_thread);
                return Err(error);
            }
        };

        Ok(Self {
            child,
            stdin: BufWriter::new(stdin),
            inbound: Some(inbound),
            reader_thread: Some(reader_thread),
            stderr_thread,
            identity,
            session_id: request.session_id.clone(),
            max_frame_bytes: request.max_frame_bytes,
            outbound_sequence: 1,
            inbound_validator: PiProtocolSequenceValidator::new(&request.session_id),
            terminated: false,
        })
    }

    pub(crate) fn identity(&self) -> &AgentProcessIdentity {
        &self.identity
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    pub(crate) fn send_command(&mut self, request_id: &str, command: RuntimeCommand) -> Result<()> {
        let frame = PiFrame::Request {
            header: self.next_header()?,
            request_id: request_id.to_owned(),
            command,
        };
        self.write_frame(&frame)
    }

    pub(crate) fn send_tool_result(
        &mut self,
        call_id: &str,
        outcome: AgentToolOutcome,
    ) -> Result<()> {
        let frame = PiFrame::ToolResult {
            header: self.next_header()?,
            call_id: call_id.to_owned(),
            outcome,
        };
        self.write_frame(&frame)
    }

    pub(crate) fn receive(&mut self) -> Result<Option<RuntimeInbound>> {
        let frame = self
            .wait_for_frame(None)?
            .expect("blocking receive returns a frame");
        self.accept_inbound_frame(frame).map(Some)
    }

    pub(crate) fn receive_timeout(&mut self, timeout: Duration) -> Result<Option<RuntimeInbound>> {
        let Some(frame) = self.wait_for_frame(Some(timeout))? else {
            return Ok(None);
        };
        self.accept_inbound_frame(frame).map(Some)
    }

    fn accept_inbound_frame(&mut self, frame: PiFrame) -> Result<RuntimeInbound> {
        if let Err(error) = self.inbound_validator.validate(&frame) {
            let _ = self.terminate();
            return Err(error);
        }
        let sequence = frame.header().sequence;
        match frame {
            PiFrame::Response {
                request_id,
                response,
                ..
            } => Ok(RuntimeInbound::Response {
                sequence,
                request_id,
                response,
            }),
            PiFrame::Event { event, .. } => Ok(RuntimeInbound::Event { sequence, event }),
            PiFrame::ToolCall { call, .. } => Ok(RuntimeInbound::ToolCall { sequence, call }),
            PiFrame::Request { .. } | PiFrame::ToolResult { .. } => {
                let error = KoniError::Process(
                    "agent runtime host sent a compiler-only protocol frame".to_owned(),
                );
                let _ = self.terminate();
                Err(error)
            }
        }
    }

    fn wait_for_frame(&mut self, timeout: Option<Duration>) -> Result<Option<PiFrame>> {
        let message = {
            let inbound = self.inbound.as_ref().ok_or_else(|| {
                KoniError::Process("agent runtime host is already terminated".to_owned())
            })?;
            match timeout {
                Some(timeout) => match inbound.recv_timeout(timeout) {
                    Ok(message) => Some(message),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => Some(HostReaderMessage::Closed),
                },
                None => Some(inbound.recv().unwrap_or(HostReaderMessage::Closed)),
            }
        };
        let Some(message) = message else {
            return Ok(None);
        };
        match message {
            HostReaderMessage::Frame(frame) => Ok(Some(*frame)),
            HostReaderMessage::Closed => {
                let error = KoniError::Process(
                    "agent runtime host closed its protocol stdout unexpectedly".to_owned(),
                );
                let _ = self.terminate();
                Err(error)
            }
            HostReaderMessage::Error(message) => {
                let error = KoniError::Process(message);
                let _ = self.terminate();
                Err(error)
            }
        }
    }

    pub(crate) fn terminate(&mut self) -> Result<()> {
        if self.terminated {
            return Ok(());
        }
        self.terminated = true;
        // Release a reader blocked on the one-frame channel before process
        // termination closes its stdout pipe.
        self.inbound.take();
        // Signal the owned process group even after its leader exits. The
        // unreaped `Child` keeps the leader PID from being recycled, so its
        // PGID remains safe to address while same-group helpers may survive.
        let terminate_result =
            terminate_runtime_host_group(&mut self.child, self.identity.process_group_id);
        if terminate_result.is_err() {
            let _ = self.child.kill();
        }
        let wait_result = self.child.wait().map_err(|error| {
            KoniError::Process(format!(
                "could not reap agent runtime host {}: {error}",
                self.identity.pid
            ))
        });
        let reader_panicked = self
            .reader_thread
            .take()
            .is_some_and(|reader| reader.join().is_err());
        let stderr_result = join_host_stderr_thread(self.stderr_thread.take(), self.identity.pid);
        terminate_result?;
        wait_result?;
        if reader_panicked {
            return Err(KoniError::Process(format!(
                "agent runtime reader thread panicked for host {}",
                self.identity.pid
            )));
        }
        stderr_result
    }

    fn next_header(&mut self) -> Result<PiFrameHeader> {
        let sequence = self.outbound_sequence;
        self.outbound_sequence = self.outbound_sequence.checked_add(1).ok_or_else(|| {
            KoniError::Process(format!(
                "Pi runtime protocol sequence exhausted for session {}",
                self.session_id
            ))
        })?;
        Ok(PiFrameHeader::new(&self.session_id, sequence))
    }

    fn write_frame(&mut self, frame: &PiFrame) -> Result<()> {
        if let Err(error) = write_pi_frame(&mut self.stdin, frame, self.max_frame_bytes) {
            let _ = self.terminate();
            return Err(error);
        }
        Ok(())
    }
}

impl AgentRuntime for SupervisedAgentRuntimeHost {
    fn session_id(&self) -> &str {
        self.session_id()
    }

    fn process_identity(&self) -> &AgentProcessIdentity {
        self.identity()
    }

    fn send_command(&mut self, request_id: &str, command: RuntimeCommand) -> Result<()> {
        SupervisedAgentRuntimeHost::send_command(self, request_id, command)
    }

    fn send_tool_result(&mut self, call_id: &str, outcome: AgentToolOutcome) -> Result<()> {
        SupervisedAgentRuntimeHost::send_tool_result(self, call_id, outcome)
    }

    fn receive(&mut self) -> Result<Option<RuntimeInbound>> {
        SupervisedAgentRuntimeHost::receive(self)
    }

    fn receive_timeout(&mut self, timeout: Duration) -> Result<Option<RuntimeInbound>> {
        SupervisedAgentRuntimeHost::receive_timeout(self, timeout)
    }

    fn terminate(&mut self) -> Result<()> {
        SupervisedAgentRuntimeHost::terminate(self)
    }
}

impl Drop for SupervisedAgentRuntimeHost {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

fn validate_host_request(request: &AgentRuntimeHostRequest) -> Result<()> {
    if !request.executable.is_absolute() || !request.executable.is_file() {
        return Err(KoniError::Process(format!(
            "agent runtime executable must be an absolute file: {}",
            request.executable.display()
        )));
    }
    if !request.working_directory.is_dir() {
        return Err(KoniError::Process(format!(
            "agent runtime working directory does not exist: {}",
            request.working_directory.display()
        )));
    }
    if request.max_frame_bytes == 0 || request.max_frame_bytes > DEFAULT_MAX_PI_FRAME_BYTES {
        return Err(KoniError::Process(format!(
            "agent runtime frame limit must be 1..={DEFAULT_MAX_PI_FRAME_BYTES} bytes"
        )));
    }
    crate::pi_protocol::validate_pi_identifier("session_id", &request.session_id)?;
    Ok(())
}

fn capture_identity_after_spawn(pid: u32) -> Option<AgentProcessIdentity> {
    for _ in 0..20 {
        if let Some(identity) = capture_owned_agent_process_identity(pid) {
            return Some(identity);
        }
        thread::sleep(Duration::from_millis(5));
    }
    None
}

fn terminate_runtime_host_group(child: &mut Child, process_group_id: u32) -> Result<()> {
    match terminate_agent_process(child, process_group_id) {
        Ok(()) => Ok(()),
        #[cfg(unix)]
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            // On macOS, killpg can report EPERM when the naturally exited
            // leader is now only a zombie. The unreaped Child keeps this PGID
            // from being recycled. It is safe to accept that result only
            // after an independent process-table scan proves the group has no
            // live member; a surviving helper keeps termination fail-closed.
            if process_group_has_live_member(process_group_id)? {
                Err(KoniError::Process(format!(
                    "could not terminate agent runtime host group {process_group_id}: {error}"
                )))
            } else {
                Ok(())
            }
        }
        Err(error) => Err(KoniError::Process(format!(
            "could not terminate agent runtime host group {process_group_id}: {error}"
        ))),
    }
}

#[cfg(unix)]
fn process_group_has_live_member(process_group_id: u32) -> Result<bool> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pgid=,stat="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|error| {
            KoniError::Process(format!(
                "could not inspect agent runtime host group {process_group_id}: {error}"
            ))
        })?;
    if !output.status.success() {
        return Err(KoniError::Process(format!(
            "could not inspect agent runtime host group {process_group_id}: ps exited {}",
            output.status
        )));
    }
    let stdout = String::from_utf8(output.stdout).map_err(|_| {
        KoniError::Process(format!(
            "could not inspect agent runtime host group {process_group_id}: ps returned non-UTF-8 output"
        ))
    })?;
    Ok(stdout.lines().any(|line| {
        let mut fields = line.split_whitespace();
        let Some(group) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            return false;
        };
        let Some(state) = fields.next() else {
            return false;
        };
        group == process_group_id && !state.starts_with('Z')
    }))
}

fn finish_failed_host_spawn(
    child: &mut Child,
    process_group_id: u32,
    stderr_thread: &mut Option<HostStderrThread>,
) {
    let _ = terminate_agent_process(child, process_group_id);
    let _ = child.wait();
    let _ = join_host_stderr_thread(stderr_thread.take(), child.id());
}

fn join_host_stderr_thread(thread: Option<HostStderrThread>, pid: u32) -> Result<()> {
    let Some(thread) = thread else {
        return Ok(());
    };
    match thread.join() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(KoniError::Process(format!(
            "could not capture bounded stderr for agent runtime host {pid}: {error}"
        ))),
        Err(_) => Err(KoniError::Process(format!(
            "agent runtime stderr thread panicked for host {pid}"
        ))),
    }
}

fn spawn_host_stderr_drain(
    mut stderr: ChildStderr,
    mut capture: fs::File,
) -> Result<HostStderrThread> {
    thread::Builder::new()
        .name("koni-agent-runtime-stderr".to_owned())
        .spawn(move || {
            let prefix_limit = MAX_AGENT_RUNTIME_STDERR_BYTES
                .saturating_sub(AGENT_RUNTIME_STDERR_TRUNCATION_MARKER.len());
            let mut buffer = [0_u8; 16 * 1024];
            let mut captured = 0_usize;
            let mut truncated = false;
            let mut capture_error = None;
            loop {
                let read = match stderr.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                };
                let keep = prefix_limit.saturating_sub(captured).min(read);
                if keep > 0 && capture_error.is_none() {
                    match capture.write_all(&buffer[..keep]) {
                        Ok(()) => captured += keep,
                        Err(error) => capture_error = Some(error),
                    }
                }
                if keep < read || capture_error.is_some() {
                    truncated = true;
                }
            }
            if let Some(error) = capture_error {
                return Err(error);
            }
            if truncated {
                capture.write_all(AGENT_RUNTIME_STDERR_TRUNCATION_MARKER)?;
            }
            capture.flush()?;
            capture.sync_data()
        })
        .map_err(|error| {
            KoniError::Process(format!(
                "could not start bounded agent runtime stderr drain: {error}"
            ))
        })
}

enum HostReaderMessage {
    Frame(Box<PiFrame>),
    Error(String),
    Closed,
}

fn spawn_host_reader(
    stdout: ChildStdout,
    max_frame_bytes: usize,
    sender: mpsc::SyncSender<HostReaderMessage>,
) -> Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("koni-agent-runtime-reader".to_owned())
        .spawn(move || {
            let mut stdout = BufReader::new(stdout);
            loop {
                let message = match read_pi_frame(&mut stdout, max_frame_bytes) {
                    Ok(Some(frame)) => HostReaderMessage::Frame(Box::new(frame)),
                    Ok(None) => HostReaderMessage::Closed,
                    Err(error) => HostReaderMessage::Error(error.to_string()),
                };
                let terminal = !matches!(message, HostReaderMessage::Frame(_));
                if sender.send(message).is_err() || terminal {
                    break;
                }
            }
        })
        .map_err(|error| {
            KoniError::Process(format!("could not start agent runtime reader: {error}"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    #[test]
    fn supervised_fake_host_uses_ordered_bounded_protocol_and_owned_identity() {
        let temp = tempfile::TempDir::new().unwrap();
        let script = temp.path().join("fake-host.sh");
        fs::write(
            &script,
            r##"#!/bin/sh
IFS= read -r request
printf '%s\n' '{"frame":"response","protocol_version":1,"session_id":"session-1","sequence":1,"request_id":"start-1","response":{"kind":"accepted"}}'
IFS= read -r tool_result
"##,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let mut request = AgentRuntimeHostRequest::with_defaults(
            &script,
            temp.path(),
            temp.path().join("host.stderr"),
            "session-1",
        );
        request.max_frame_bytes = 4096;
        let mut recorded = None;
        let mut host = SupervisedAgentRuntimeHost::spawn(&request, &mut |identity| {
            recorded = Some(identity.clone());
            Ok(())
        })
        .unwrap();

        assert_eq!(recorded.as_ref(), Some(host.identity()));
        assert_eq!(host.identity().pid, host.identity().process_group_id);
        host.send_command("start-1", RuntimeCommand::Shutdown)
            .unwrap();
        assert_eq!(
            host.receive().unwrap(),
            Some(RuntimeInbound::Response {
                sequence: 1,
                request_id: "start-1".to_owned(),
                response: RuntimeResponse::Accepted,
            })
        );
        host.send_tool_result(
            "call-1",
            AgentToolOutcome::Success {
                value: serde_json::json!({"ok": true}),
            },
        )
        .unwrap();
        host.terminate().unwrap();
        assert!(!owned_agent_process_is_alive(host.identity()));
    }

    #[cfg(unix)]
    #[test]
    fn supervised_host_drains_stderr_without_blocking_and_caps_diagnostics() {
        let temp = tempfile::TempDir::new().unwrap();
        let script = temp.path().join("stderr-spam-host.sh");
        let script_body = r##"#!/bin/sh
printf '%s\n' 'diagnostic-prefix' >&2
/usr/bin/head -c __SPAM_BYTES__ /dev/zero >&2
IFS= read -r request
printf '%s\n' '{"frame":"response","protocol_version":1,"session_id":"session-stderr","sequence":1,"request_id":"start-1","response":{"kind":"accepted"}}'
"##
        .replace(
            "__SPAM_BYTES__",
            &(MAX_AGENT_RUNTIME_STDERR_BYTES * 4).to_string(),
        );
        fs::write(&script, script_body).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let stderr_path = temp.path().join("host.stderr");
        let request = AgentRuntimeHostRequest::with_defaults(
            &script,
            temp.path(),
            &stderr_path,
            "session-stderr",
        );
        let mut host =
            SupervisedAgentRuntimeHost::spawn(&request, &mut |_identity| Ok(())).unwrap();
        host.send_command("start-1", RuntimeCommand::Shutdown)
            .unwrap();
        assert_eq!(
            host.receive_timeout(Duration::from_secs(10)).unwrap(),
            Some(RuntimeInbound::Response {
                sequence: 1,
                request_id: "start-1".to_owned(),
                response: RuntimeResponse::Accepted,
            })
        );
        host.terminate().unwrap();

        let captured = fs::read(&stderr_path).unwrap();
        assert_eq!(captured.len(), MAX_AGENT_RUNTIME_STDERR_BYTES);
        assert!(captured.starts_with(b"diagnostic-prefix\n"));
        assert!(captured.ends_with(AGENT_RUNTIME_STDERR_TRUNCATION_MARKER));
    }

    #[cfg(unix)]
    #[test]
    fn receive_timeout_keeps_the_owned_host_terminable() {
        let temp = tempfile::TempDir::new().unwrap();
        let script = temp.path().join("slow-fake-host.sh");
        fs::write(
            &script,
            r##"#!/bin/sh
IFS= read -r request
/bin/sleep 1
printf '%s\n' '{"frame":"response","protocol_version":1,"session_id":"session-slow","sequence":1,"request_id":"slow-1","response":{"kind":"accepted"}}'
"##,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let request = AgentRuntimeHostRequest::with_defaults(
            &script,
            temp.path(),
            temp.path().join("host.stderr"),
            "session-slow",
        );
        let mut host =
            SupervisedAgentRuntimeHost::spawn(&request, &mut |_identity| Ok(())).unwrap();
        host.send_command("slow-1", RuntimeCommand::Shutdown)
            .unwrap();

        assert_eq!(
            host.receive_timeout(Duration::from_millis(20)).unwrap(),
            None
        );
        assert!(owned_agent_process_is_alive(host.identity()));
        host.terminate().unwrap();
        assert!(!owned_agent_process_is_alive(host.identity()));
    }

    #[cfg(unix)]
    #[test]
    fn credential_socket_is_inherited_only_as_fd_three() {
        let temp = tempfile::TempDir::new().unwrap();
        let script = temp.path().join("credential-fd-host.sh");
        fs::write(
            &script,
            r##"#!/bin/sh
IFS= read -r credential <&3 || exit 7
[ "$credential" = "credential-ping" ] || exit 8
IFS= read -r request
printf '%s\n' '{"frame":"response","protocol_version":1,"session_id":"session-fd3","sequence":1,"request_id":"start-1","response":{"kind":"accepted"}}'
"##,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let request = AgentRuntimeHostRequest::with_defaults(
            &script,
            temp.path(),
            temp.path().join("host.stderr"),
            "session-fd3",
        );
        let (mut credential_parent, credential_child) = UnixStream::pair().unwrap();
        credential_parent.write_all(b"credential-ping\n").unwrap();
        let mut host = SupervisedAgentRuntimeHost::spawn_with_credential_socket(
            &request,
            credential_child,
            &mut |_identity| Ok(()),
        )
        .unwrap();
        host.send_command("start-1", RuntimeCommand::Shutdown)
            .unwrap();
        assert_eq!(
            host.receive_timeout(Duration::from_secs(10)).unwrap(),
            Some(RuntimeInbound::Response {
                sequence: 1,
                request_id: "start-1".to_owned(),
                response: RuntimeResponse::Accepted,
            })
        );
        host.terminate().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unrelated_non_cloexec_descriptor_is_not_inherited() {
        let temp = tempfile::TempDir::new().unwrap();
        let sentinel_path = temp.path().join("sentinel");
        fs::write(&sentinel_path, "secret").unwrap();
        let sentinel = fs::File::open(&sentinel_path).unwrap();
        rustix::io::fcntl_setfd(&sentinel, rustix::io::FdFlags::empty()).unwrap();
        let sentinel_fd = sentinel.as_raw_fd();

        let script = temp.path().join("fd-hygiene-host.sh");
        fs::write(
            &script,
            r##"#!/bin/sh
[ ! -e "/dev/fd/$1" ] || exit 9
IFS= read -r request
printf '%s\n' '{"frame":"response","protocol_version":1,"session_id":"session-fd-hygiene","sequence":1,"request_id":"start-1","response":{"kind":"accepted"}}'
"##,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let mut request = AgentRuntimeHostRequest::with_defaults(
            &script,
            temp.path(),
            temp.path().join("host.stderr"),
            "session-fd-hygiene",
        );
        request.args.push(sentinel_fd.to_string());
        let mut host =
            SupervisedAgentRuntimeHost::spawn(&request, &mut |_identity| Ok(())).unwrap();
        host.send_command("start-1", RuntimeCommand::Shutdown)
            .unwrap();
        assert!(matches!(
            host.receive_timeout(Duration::from_secs(10)).unwrap(),
            Some(RuntimeInbound::Response {
                response: RuntimeResponse::Accepted,
                ..
            })
        ));
        host.terminate().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn leader_exit_still_terminates_same_group_descendants() {
        let temp = tempfile::TempDir::new().unwrap();
        let helper_pid = temp.path().join("helper.pid");
        let script = temp.path().join("exiting-leader.sh");
        fs::write(
            &script,
            r##"#!/bin/sh
/bin/sleep 30 </dev/null >/dev/null 2>&1 &
printf '%s\n' "$!" > "$1"
exit 0
"##,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let mut request = AgentRuntimeHostRequest::with_defaults(
            &script,
            temp.path(),
            temp.path().join("host.stderr"),
            "session-descendant",
        );
        request.args.push(helper_pid.display().to_string());
        let mut host =
            SupervisedAgentRuntimeHost::spawn(&request, &mut |_identity| Ok(())).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let pid = loop {
            if let Ok(contents) = fs::read_to_string(&helper_pid)
                && let Ok(pid) = contents.trim().parse::<i32>()
            {
                break pid;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "helper PID file was not populated before the deadline"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let helper = rustix::process::Pid::from_raw(pid).unwrap();
        assert!(rustix::process::test_kill_process(helper).is_ok());

        let error = host
            .receive_timeout(Duration::from_secs(10))
            .unwrap_err()
            .to_string();
        assert!(error.contains("closed its protocol stdout"));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while rustix::process::test_kill_process(helper).is_ok()
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            rustix::process::test_kill_process(helper).is_err(),
            "runtime helper survived its exited process-group leader"
        );
    }

    #[test]
    fn host_request_rejects_unbounded_or_relative_runtime() {
        let temp = tempfile::TempDir::new().unwrap();
        let mut request = AgentRuntimeHostRequest::with_defaults(
            "node",
            temp.path(),
            temp.path().join("stderr"),
            "session-1",
        );
        let error = validate_host_request(&request).unwrap_err().to_string();
        assert!(error.contains("absolute file"));

        request.executable = std::env::current_exe().unwrap();
        request.max_frame_bytes = 0;
        let error = validate_host_request(&request).unwrap_err().to_string();
        assert!(error.contains("frame limit must be 1..="));

        request.max_frame_bytes = DEFAULT_MAX_PI_FRAME_BYTES + 1;
        let error = validate_host_request(&request).unwrap_err().to_string();
        assert!(error.contains("frame limit must be 1..="));
    }

    #[test]
    fn runtime_response_uses_unambiguous_kind_tag() {
        let response = RuntimeResponse::Authentication {
            response: CredentialBrokerResponse::Denied {
                code: "login_required".to_owned(),
                message: "sign in again".to_owned(),
            },
        };
        let encoded = serde_json::to_value(&response).unwrap();
        assert_eq!(encoded["kind"], "authentication");
        assert_eq!(encoded["response"]["response"], "denied");
        assert_eq!(
            serde_json::from_value::<RuntimeResponse>(encoded).unwrap(),
            response
        );
    }

    #[test]
    fn runtime_session_terminal_boundary_policy_is_backward_compatible() {
        let legacy = json!({
            "session_id": "session-legacy",
            "run_id": "run-legacy",
            "agent_id": "agent-legacy",
            "attempt": 1,
            "model": {
                "provider": "openai-codex",
                "model": "model-legacy",
                "thinking_level": "high",
                "input_capabilities": ["text"],
                "context_window": 1000
            },
            "instructions": "legacy session",
            "tools": [],
            "credential_lease": "lease-legacy"
        });
        let decoded = serde_json::from_value::<RuntimeSessionStart>(legacy).unwrap();
        assert!(decoded.terminal_boundary_tools.is_empty());
        assert!(!decoded.context_completion_required);

        let mut current = decoded;
        current.terminal_boundary_tools = vec!["submit_and_compile".to_owned()];
        let encoded = serde_json::to_value(current).unwrap();
        assert_eq!(
            encoded["terminal_boundary_tools"],
            json!(["submit_and_compile"])
        );
        assert!(encoded.get("context_completion_required").is_none());
    }

    #[test]
    fn image_input_contains_bounded_transport_data_not_a_host_path() {
        let image = RuntimeInput::Image {
            media_type: "image/png".to_owned(),
            sha256: "sha256:abc".to_owned(),
            data_base64: "aGVsbG8=".to_owned(),
        };
        let encoded = serde_json::to_value(image).unwrap();
        assert_eq!(encoded["kind"], "image");
        assert_eq!(encoded["data_base64"], "aGVsbG8=");
        assert!(encoded.get("path").is_none());
    }
}
