//! Production composition of the supervised Rust runtime boundary and the
//! Koni-owned direct Pi SDK host.
//!
//! This module is the only place that joins the public protocol, private fd3
//! credential service, artifact verification, and OS containment. The Node
//! host never receives workspace pathname authority; compiler-owned tools are
//! executed in Rust through [`AgentToolBroker`].

use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;

use crate::agent::AgentProcessIdentity;
use crate::agent_runtime::{
    AgentRuntimeHostRequest, PiRuntimeFailure, RuntimeCommand, RuntimeControl, RuntimeEvent,
    RuntimeHostMetadata, RuntimeInbound, RuntimeModelInfo, RuntimeResponse, RuntimeSessionRef,
    RuntimeSessionStart, RuntimeTurnRequest, RuntimeUsage, SupervisedAgentRuntimeHost,
};
use crate::agent_tool_broker::{AgentToolBroker, AgentToolContext, AgentToolOutcome};
use crate::error::{KoniError, Result, io_error};
use crate::pi_auth::{
    CredentialBrokerRequest, CredentialBrokerResponse, CredentialLeaseId, OAuthInteraction,
    OAuthLoginFlow,
};
use crate::pi_credential_service::{CredentialAccessIntent, PiCredentialService};
use crate::pi_runtime_state::PiRuntimeStateMachine;
use crate::runtime_containment::{RuntimeContainmentCommand, RuntimeContainmentRequest};

/// Pi model/provider registry ID. This intentionally differs from the
/// token-free OAuth request enum's serialized `open-ai-codex` spelling.
pub const PI_RUNTIME_PROVIDER_ID: &str = "openai-codex";
pub const MINIMUM_PI_NODE_VERSION: &str = "22.19.0";
const PI_BUNDLE_NAME: &str = "koni-pi-host.mjs";
const PI_BUNDLE_CHECKSUM_NAME: &str = "koni-pi-host.sha256";
const PI_BUNDLE_BUILD_CHECKSUM: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../runtime/pi-host/dist/koni-pi-host.sha256"
));
const PI_NODE_BUILD_PATH: &str = env!("KONI_PINNED_NODE_PATH");
const PI_NODE_BUILD_CHECKSUM: &str = env!("KONI_PINNED_NODE_SHA256");
const DEFAULT_START_TIMEOUT: Duration = Duration::from_secs(30);
// Leave deterministic headroom for the protocol envelope, request/call IDs,
// and JSON escaping inside the 1 MiB public-frame ceiling.
const MAX_PI_TOOL_OUTCOME_BYTES: usize = 768 * 1024;

/// A verified, single-file Pi host and the exact Node image used to execute
/// it. Both paths are canonical regular files outside every agent-writable
/// root supplied by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiRuntimeArtifact {
    node_executable: PathBuf,
    node_sha256: String,
    bundle_path: PathBuf,
    bundle_sha256: String,
}

impl PiRuntimeArtifact {
    /// Discover the host only relative to the already-running Koni image.
    /// Mutable `PATH`, home, cwd, and environment overrides are deliberately
    /// not artifact roots because this process grants fd3 and outbound TLS.
    pub fn discover(forbidden_writable_roots: &[&Path]) -> Result<Self> {
        let node = discover_node_executable()?;
        let current_exe = env::current_exe().map_err(|error| {
            KoniError::Process(format!("could not resolve the Koni executable: {error}"))
        })?;
        let mut roots = Vec::new();
        if let Some(bin) = current_exe.parent() {
            roots.push(bin.join("koni-pi-host"));
            roots.push(bin.join("../libexec/koni/pi-host"));
            roots.push(bin.join("../lib/koni/pi-host"));
        }
        roots.sort();
        roots.dedup();

        let mut inspected = Vec::new();
        for root in roots {
            let bundle = root.join(PI_BUNDLE_NAME);
            let checksum = root.join(PI_BUNDLE_CHECKSUM_NAME);
            inspected.push(bundle.clone());
            if bundle.is_file() && checksum.is_file() {
                return Self::verify_expected(
                    node,
                    bundle,
                    checksum,
                    build_bundle_checksum()?,
                    PI_NODE_BUILD_CHECKSUM,
                    forbidden_writable_roots,
                );
            }
        }
        Err(KoniError::Process(format!(
            "the verified Koni Pi host is not installed; expected {} and {} together beneath one of: {}",
            PI_BUNDLE_NAME,
            PI_BUNDLE_CHECKSUM_NAME,
            inspected
                .iter()
                .filter_map(|path| path.parent())
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )))
    }

    fn verify_expected(
        node_executable: impl AsRef<Path>,
        bundle_path: impl AsRef<Path>,
        checksum_path: impl AsRef<Path>,
        build_checksum: &str,
        build_node_checksum: &str,
        forbidden_writable_roots: &[&Path],
    ) -> Result<Self> {
        let node_executable = canonical_regular_file(node_executable.as_ref(), "Node executable")?;
        let bundle_path = canonical_regular_file(bundle_path.as_ref(), "Pi host bundle")?;
        let checksum_path = canonical_regular_file(checksum_path.as_ref(), "Pi host checksum")?;
        if bundle_path.parent() != checksum_path.parent() {
            return Err(KoniError::Process(
                "Pi host bundle and checksum must share one immutable directory".to_owned(),
            ));
        }
        reject_paths_beneath_writable_roots(
            [&node_executable, &bundle_path, &checksum_path],
            forbidden_writable_roots,
        )?;
        let observed_node_sha256 = raw_file_sha256(&node_executable)?;
        if observed_node_sha256 != build_node_checksum {
            return Err(KoniError::Process(
                "the installed Node image differs from Koni's build-time digest".to_owned(),
            ));
        }
        let packaged = read_checksum(&checksum_path)?;
        if packaged != build_checksum {
            return Err(KoniError::Process(
                "the installed Pi host manifest differs from Koni's build-time digest".to_owned(),
            ));
        }
        let actual = raw_file_sha256(&bundle_path)?;
        if build_checksum != actual {
            return Err(KoniError::Process(format!(
                "Pi host bundle checksum mismatch for {}: expected {build_checksum}, observed {actual}",
                bundle_path.display()
            )));
        }
        Ok(Self {
            node_sha256: observed_node_sha256,
            node_executable,
            bundle_path,
            bundle_sha256: actual,
        })
    }

    pub fn node_executable(&self) -> &Path {
        &self.node_executable
    }

    pub fn bundle_path(&self) -> &Path {
        &self.bundle_path
    }

    pub fn bundle_sha256(&self) -> &str {
        &self.bundle_sha256
    }

    fn revalidate_node(&self) -> Result<()> {
        let current = canonical_regular_file(&self.node_executable, "Node executable")?;
        if current != self.node_executable || raw_file_sha256(&current)? != self.node_sha256 {
            return Err(KoniError::Process(
                "the pinned Node executable changed after Pi artifact verification".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct PiRuntimeLaunchRequest {
    pub artifact: PiRuntimeArtifact,
    pub session: RuntimeSessionStart,
    pub timeout: Duration,
    /// The Pi provider requires outbound TLS. This remains explicit so tests
    /// and non-inference probes can prove network denial.
    pub network_access: bool,
}

#[derive(Debug, Clone)]
pub struct PiRuntimeBootstrapRequest {
    pub artifact: PiRuntimeArtifact,
    pub transport_session_id: String,
    pub credential_lease: CredentialLeaseId,
    pub timeout: Duration,
    pub network_access: bool,
    /// Permit the pinned Pi browser OAuth callback on localhost:1455. Only a
    /// short-lived `koni auth login` control process should set this.
    pub oauth_callback_access: bool,
}

impl PiRuntimeLaunchRequest {
    pub fn validate(&self) -> Result<()> {
        if self.timeout.is_zero() {
            return Err(KoniError::Process(
                "Pi runtime timeout must be positive".to_owned(),
            ));
        }
        if self.session.model.provider != PI_RUNTIME_PROVIDER_ID {
            return Err(KoniError::Process(format!(
                "Pi runtime provider must be {PI_RUNTIME_PROVIDER_ID}, got {}",
                self.session.model.provider
            )));
        }
        validate_runtime_identifier("session id", &self.session.session_id)?;
        validate_runtime_identifier("run id", &self.session.run_id)?;
        validate_runtime_identifier("agent id", &self.session.agent_id)?;
        if self.session.credential_lease.0.trim().is_empty() {
            return Err(KoniError::Process(
                "Pi runtime credential lease must be nonempty".to_owned(),
            ));
        }
        Ok(())
    }

    fn bootstrap_request(&self) -> PiRuntimeBootstrapRequest {
        PiRuntimeBootstrapRequest {
            artifact: self.artifact.clone(),
            transport_session_id: self.session.session_id.clone(),
            credential_lease: self.session.credential_lease.clone(),
            timeout: self.timeout,
            network_access: self.network_access,
            oauth_callback_access: false,
        }
    }
}

impl PiRuntimeBootstrapRequest {
    pub fn validate(&self) -> Result<()> {
        if self.timeout.is_zero() {
            return Err(KoniError::Process(
                "Pi runtime timeout must be positive".to_owned(),
            ));
        }
        validate_runtime_identifier("transport session id", &self.transport_session_id)?;
        validate_runtime_identifier("credential lease", &self.credential_lease.0)?;
        if self.oauth_callback_access && !self.network_access {
            return Err(KoniError::Process(
                "Pi browser OAuth callback access requires outbound network access".to_owned(),
            ));
        }
        Ok(())
    }
}

/// One direct Pi SDK session. Drop terminates and reaps the complete runtime
/// process group; the private credential service exits when fd3 closes.
pub struct PiRuntimeProcess {
    host: Option<SupervisedAgentRuntimeHost>,
    credential_service: Option<PiCredentialService>,
    _scratch: TempDir,
    credential_lease: CredentialLeaseId,
    session: Option<RuntimeSessionStart>,
    runtime_session: Option<RuntimeSessionRef>,
    state: PiRuntimeStateMachine,
    timeout: Duration,
    oauth_callback_access: bool,
}

impl std::fmt::Debug for PiRuntimeProcess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PiRuntimeProcess")
            .field(
                "identity",
                &self.host.as_ref().map(SupervisedAgentRuntimeHost::identity),
            )
            .field("session", &self.runtime_session)
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl PiRuntimeProcess {
    /// Start the contained host without creating an inference session. This
    /// narrow bootstrap surface supports model discovery and OAuth status/
    /// login/logout before a project or model has been selected.
    pub fn bootstrap(
        request: PiRuntimeBootstrapRequest,
        on_started: &mut dyn FnMut(&AgentProcessIdentity) -> Result<()>,
    ) -> Result<Self> {
        request.validate()?;
        let (scratch, scratch_path) = create_runtime_scratch()?;
        request.artifact.revalidate_node()?;
        let staged_node = stage_verified_node(&request.artifact, &scratch_path)?;
        let staged_bundle = stage_verified_bundle(&request.artifact, &scratch_path)?;
        let containment = RuntimeContainmentRequest {
            platform: current_containment_platform()?,
            executable: staged_node,
            args: vec![path_string(&staged_bundle)?],
            working_directory: scratch_path.clone(),
            readable_roots: Vec::new(),
            writable_roots: vec![scratch_path.clone()],
            network_access: request.network_access,
            oauth_callback_access: request.oauth_callback_access,
        }
        .compile()?;
        let host_request = host_request(&request, &scratch_path, containment)?;
        let mut credential_service = PiCredentialService::spawn(request.credential_lease.clone())?;
        #[cfg(unix)]
        let socket = credential_service.take_child_socket()?;
        #[cfg(not(unix))]
        return Err(KoniError::Process(
            "Pi runtime requires Unix fd3 credential isolation".to_owned(),
        ));
        #[cfg(unix)]
        let host = SupervisedAgentRuntimeHost::spawn_with_credential_socket(
            &host_request,
            socket,
            on_started,
        )?;
        Ok(Self {
            host: Some(host),
            credential_service: Some(credential_service),
            _scratch: scratch,
            credential_lease: request.credential_lease,
            session: None,
            runtime_session: None,
            state: PiRuntimeStateMachine::default(),
            timeout: request.timeout,
            oauth_callback_access: request.oauth_callback_access,
        })
    }

    pub fn launch(
        request: PiRuntimeLaunchRequest,
        on_started: &mut dyn FnMut(&AgentProcessIdentity) -> Result<()>,
    ) -> Result<Self> {
        request.validate()?;
        let mut process = Self::bootstrap(request.bootstrap_request(), on_started)?;
        process.start_session(request.session)?;
        Ok(process)
    }

    pub fn start_session(&mut self, session: RuntimeSessionStart) -> Result<&RuntimeSessionRef> {
        self.ensure_live()?;
        if let Err(error) = self.start_session_inner(session) {
            let _ = self.terminate();
            return Err(error);
        }
        Ok(self
            .runtime_session
            .as_ref()
            .expect("runtime session was just assigned"))
    }

    fn start_session_inner(&mut self, session: RuntimeSessionStart) -> Result<()> {
        if self.session.is_some() {
            return Err(KoniError::Process(
                "Pi runtime host already owns an inference session".to_owned(),
            ));
        }
        if session.session_id != self.host().session_id()
            || session.credential_lease != self.credential_lease
            || session.model.provider != PI_RUNTIME_PROVIDER_ID
        {
            return Err(KoniError::Process(
                "Pi inference session does not match its bootstrapped host identity".to_owned(),
            ));
        }
        validate_runtime_identifier("run id", &session.run_id)?;
        validate_runtime_identifier("agent id", &session.agent_id)?;
        let start_id = format!("start-{}", Uuid::now_v7());
        self.send_command(
            &start_id,
            RuntimeCommand::StartSession {
                request: session.clone(),
            },
        )?;
        let timeout = self.timeout.min(DEFAULT_START_TIMEOUT);
        let runtime_session = match wait_for_response(self, &start_id, timeout, |_| Ok(()))? {
            RuntimeResponse::SessionStarted { session } => session,
            RuntimeResponse::Rejected { code, message, .. } => {
                return Err(KoniError::Process(format!(
                    "Pi host rejected session start ({code}): {message}"
                )));
            }
            other => {
                return Err(KoniError::Process(format!(
                    "Pi host returned an invalid session-start response: {other:?}"
                )));
            }
        };
        if runtime_session.session_id != session.session_id
            || runtime_session.runtime != "pi-sdk"
            || runtime_session.protocol_version != 1
            || runtime_session.provider != session.model.provider
            || runtime_session.model != session.model.model
        {
            return Err(KoniError::Process(
                "Pi host session identity does not match the compiler request".to_owned(),
            ));
        }
        self.session = Some(session);
        self.runtime_session = Some(runtime_session);
        Ok(())
    }

    pub fn process_identity(&self) -> Result<&AgentProcessIdentity> {
        self.ensure_live()?;
        Ok(self.host().identity())
    }

    pub fn runtime_session(&self) -> Option<&RuntimeSessionRef> {
        self.runtime_session.as_ref()
    }

    /// Run one complete model turn. Public events remain observable while
    /// every tool call is synchronously authorized by the supplied Rust
    /// broker using this exact process/session/attempt identity.
    pub fn run_turn(
        &mut self,
        request: RuntimeTurnRequest,
        broker: &dyn AgentToolBroker,
        on_event: &mut dyn FnMut(&RuntimeEvent) -> Result<()>,
    ) -> Result<PiTurnResult> {
        self.run_turn_authorized(request, broker, None, on_event)
    }

    /// Run a turn while accepting compiler/operator steering. Controls are
    /// correlated like every other request; cancel still waits for the exact
    /// terminal turn event before Rust returns.
    pub fn run_turn_controlled(
        &mut self,
        request: RuntimeTurnRequest,
        broker: &dyn AgentToolBroker,
        controls: &Receiver<RuntimeControl>,
        on_event: &mut dyn FnMut(&RuntimeEvent) -> Result<()>,
    ) -> Result<PiTurnResult> {
        self.run_turn_authorized(request, broker, Some(controls), on_event)
    }

    fn run_turn_authorized(
        &mut self,
        request: RuntimeTurnRequest,
        broker: &dyn AgentToolBroker,
        controls: Option<&Receiver<RuntimeControl>>,
        on_event: &mut dyn FnMut(&RuntimeEvent) -> Result<()>,
    ) -> Result<PiTurnResult> {
        self.ensure_live()?;
        let intent = self
            .credential_service()
            .authorize(CredentialAccessIntent::InferenceRefresh, self.timeout)?;
        let result = self.run_turn_inner(request, broker, controls, on_event);
        drop(intent);
        if result.is_err() {
            let _ = self.terminate();
        }
        result
    }

    fn run_turn_inner(
        &mut self,
        request: RuntimeTurnRequest,
        broker: &dyn AgentToolBroker,
        controls: Option<&Receiver<RuntimeControl>>,
        on_event: &mut dyn FnMut(&RuntimeEvent) -> Result<()>,
    ) -> Result<PiTurnResult> {
        let deadline = Instant::now() + self.timeout;
        let session = self.session.clone().ok_or_else(|| {
            KoniError::Process("Pi runtime has no active inference session".to_owned())
        })?;
        validate_runtime_identifier("turn id", &request.turn_id)?;
        if let Some(schema) = request.output_schema.as_ref() {
            jsonschema::validator_for(schema).map_err(|error| {
                KoniError::Process(format!("Pi turn output schema is invalid: {error}"))
            })?;
        }
        let turn_id = request.turn_id.clone();
        let output_schema = request.output_schema.clone();
        let request_id = format!("turn-{}", Uuid::now_v7());
        self.send_command(&request_id, RuntimeCommand::StartTurn { request })?;
        let start_timeout = deadline
            .saturating_duration_since(Instant::now())
            .min(DEFAULT_START_TIMEOUT);
        if start_timeout.is_zero() {
            return Err(KoniError::Process(format!(
                "Pi runtime turn {turn_id} exceeded its {:?} timeout before acceptance",
                self.timeout
            )));
        }
        match wait_for_response(self, &request_id, start_timeout, &mut *on_event)? {
            RuntimeResponse::Accepted => {}
            RuntimeResponse::Rejected { code, message, .. } => {
                return Err(KoniError::Process(format!(
                    "Pi host rejected turn {turn_id} ({code}): {message}"
                )));
            }
            other => {
                return Err(KoniError::Process(format!(
                    "Pi host returned an invalid turn-start response: {other:?}"
                )));
            }
        }

        let mut messages = Vec::new();
        let mut runtime_failure: Option<PiRuntimeFailure> = None;
        let mut pending_control: Option<String> = None;
        let mut pending_terminal: Option<(String, RuntimeUsage)> = None;
        let mut controls_open = controls.is_some();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let _ = self.host_mut().terminate();
                return Err(KoniError::Process(format!(
                    "Pi runtime turn {turn_id} exceeded its {:?} timeout",
                    self.timeout
                )));
            }
            if pending_control.is_none()
                && controls_open
                && let Some(controls) = controls
            {
                match controls.try_recv() {
                    Ok(control) => {
                        let control_id = format!("control-{}", Uuid::now_v7());
                        self.send_command(&control_id, RuntimeCommand::Control { control })?;
                        pending_control = Some(control_id);
                    }
                    Err(TryRecvError::Empty) => {}
                    Err(TryRecvError::Disconnected) => controls_open = false,
                }
            }
            let receive_slice = if controls_open {
                remaining.min(Duration::from_millis(50))
            } else {
                remaining
            };
            let Some(inbound) = self.receive_timeout(receive_slice)? else {
                if receive_slice < remaining {
                    continue;
                }
                return Err(KoniError::Process(format!(
                    "Pi runtime turn {turn_id} timed out"
                )));
            };
            match inbound {
                RuntimeInbound::ToolCall { call, .. } => {
                    let context = AgentToolContext {
                        session_id: session.session_id.clone(),
                        run_id: session.run_id.clone(),
                        agent_id: session.agent_id.clone(),
                        attempt: session.attempt,
                        runtime_process: self.process_identity()?.clone(),
                    };
                    let call_id = call.call_id.clone();
                    let outcome = broker.execute(&context, &call)?;
                    self.send_tool_result(&call_id, outcome)?;
                }
                RuntimeInbound::Event { event, .. } => {
                    on_event(&event)?;
                    match event {
                        RuntimeEvent::MessageCompleted {
                            turn_id: ref event_turn_id,
                            ref role,
                            ref content,
                            ..
                        } if event_turn_id == &turn_id && role == "assistant" => {
                            messages.push(content.clone());
                        }
                        RuntimeEvent::TurnCompleted {
                            turn_id: completed,
                            stop_reason,
                            usage,
                        } if completed == turn_id => {
                            if pending_control.is_some() {
                                pending_terminal = Some((stop_reason, usage));
                            } else {
                                return finish_turn(
                                    turn_id,
                                    stop_reason,
                                    usage,
                                    messages,
                                    runtime_failure,
                                    output_schema.as_ref(),
                                );
                            }
                        }
                        RuntimeEvent::RuntimeError {
                            turn_id: failed_turn,
                            code,
                            message,
                            retryable,
                        } if failed_turn.as_deref().is_none()
                            || failed_turn.as_deref() == Some(turn_id.as_str()) =>
                        {
                            runtime_failure = Some(
                                PiRuntimeFailure::from_wire(&code, &message, retryable)
                                    .expect("Pi runtime state accepted only a canonical failure"),
                            );
                        }
                        _ => {}
                    }
                }
                RuntimeInbound::Response {
                    request_id,
                    response,
                    ..
                } if pending_control.as_deref() == Some(request_id.as_str()) => {
                    pending_control = None;
                    let terminal_raced = pending_terminal.is_some();
                    match response {
                        RuntimeResponse::Accepted => {}
                        RuntimeResponse::Rejected { code, message, .. } if !terminal_raced => {
                            return Err(KoniError::Process(format!(
                                "Pi host rejected turn control ({code}): {message}"
                            )));
                        }
                        RuntimeResponse::Rejected { .. } => {}
                        other => {
                            return Err(KoniError::Process(format!(
                                "Pi host returned an invalid control response: {other:?}"
                            )));
                        }
                    }
                    if let Some((stop_reason, usage)) = pending_terminal.take() {
                        return finish_turn(
                            turn_id,
                            stop_reason,
                            usage,
                            messages,
                            runtime_failure,
                            output_schema.as_ref(),
                        );
                    }
                }
                RuntimeInbound::Response { request_id, .. } => {
                    return Err(KoniError::Process(format!(
                        "Pi host sent unexpected response {request_id} during turn {turn_id}"
                    )));
                }
            }
        }
    }

    /// Drive token-free OAuth control through Pi's provider. Authorization
    /// URLs/device codes are delivered as public events; token material stays
    /// exclusively on fd3. Browser login is accepted only when bootstrap gave
    /// the short-lived host its exact localhost callback capability.
    pub fn authenticate(
        &mut self,
        request: CredentialBrokerRequest,
        on_interaction: &mut dyn FnMut(&OAuthInteraction) -> Result<()>,
    ) -> Result<CredentialBrokerResponse> {
        self.ensure_live()?;
        if matches!(
            request,
            CredentialBrokerRequest::BeginLogin {
                preferred_flow: OAuthLoginFlow::BrowserPkce,
                ..
            }
        ) && !self.oauth_callback_access
        {
            return Err(KoniError::Process(
                "Pi browser OAuth requires a host bootstrapped with localhost callback access"
                    .to_owned(),
            ));
        }
        let intent_kind = match &request {
            CredentialBrokerRequest::Status { .. }
            | CredentialBrokerRequest::AcquireLease { .. } => CredentialAccessIntent::ReadOnly,
            CredentialBrokerRequest::BeginLogin { .. } => CredentialAccessIntent::Login,
            CredentialBrokerRequest::Logout { .. } => CredentialAccessIntent::Logout,
        };
        let intent = self
            .credential_service()
            .authorize(intent_kind, self.timeout)?;
        let result = self.authenticate_inner(request, on_interaction);
        drop(intent);
        if result.is_err() {
            let _ = self.terminate();
        }
        result
    }

    fn authenticate_inner(
        &mut self,
        request: CredentialBrokerRequest,
        on_interaction: &mut dyn FnMut(&OAuthInteraction) -> Result<()>,
    ) -> Result<CredentialBrokerResponse> {
        let request_id = format!("auth-{}", Uuid::now_v7());
        let credential_lease = self.credential_lease.clone();
        self.send_command(
            &request_id,
            RuntimeCommand::Authenticate {
                credential_lease,
                request,
            },
        )?;
        let timeout = self.timeout;
        let response = wait_for_response(self, &request_id, timeout, |event| {
            if let RuntimeEvent::Authentication { interaction } = event {
                on_interaction(interaction)?;
            }
            Ok(())
        })?;
        match response {
            RuntimeResponse::Authentication { response } => Ok(response),
            RuntimeResponse::Rejected { code, message, .. } => Err(KoniError::Process(format!(
                "Pi authentication request was rejected ({code}): {message}"
            ))),
            other => Err(KoniError::Process(format!(
                "Pi host returned an invalid authentication response: {other:?}"
            ))),
        }
    }

    pub fn list_models(&mut self) -> Result<Vec<RuntimeModelInfo>> {
        self.ensure_live()?;
        let result = self.list_models_inner();
        if result.is_err() {
            let _ = self.terminate();
        }
        result
    }

    fn list_models_inner(&mut self) -> Result<Vec<RuntimeModelInfo>> {
        let request_id = format!("models-{}", Uuid::now_v7());
        self.send_command(&request_id, RuntimeCommand::ListModels)?;
        let timeout = self.timeout.min(DEFAULT_START_TIMEOUT);
        match wait_for_response(self, &request_id, timeout, |_| Ok(()))? {
            RuntimeResponse::Models { models } => Ok(models),
            RuntimeResponse::Rejected { code, message, .. } => Err(KoniError::Process(format!(
                "Pi model discovery was rejected ({code}): {message}"
            ))),
            other => Err(KoniError::Process(format!(
                "Pi host returned an invalid model response: {other:?}"
            ))),
        }
    }

    pub fn metadata(&mut self) -> Result<RuntimeHostMetadata> {
        self.ensure_live()?;
        let result = self.metadata_inner();
        if result.is_err() {
            let _ = self.terminate();
        }
        result
    }

    fn metadata_inner(&mut self) -> Result<RuntimeHostMetadata> {
        let request_id = format!("metadata-{}", Uuid::now_v7());
        self.send_command(&request_id, RuntimeCommand::Metadata)?;
        let timeout = self.timeout.min(DEFAULT_START_TIMEOUT);
        match wait_for_response(self, &request_id, timeout, |_| Ok(()))? {
            RuntimeResponse::Metadata { metadata } => {
                if metadata.ambient_resources
                    || metadata.ambient_credentials
                    || metadata.provider != PI_RUNTIME_PROVIDER_ID
                {
                    return Err(KoniError::Process(
                        "Pi host metadata violates the Koni runtime authority contract".to_owned(),
                    ));
                }
                Ok(metadata)
            }
            RuntimeResponse::Rejected { code, message, .. } => Err(KoniError::Process(format!(
                "Pi metadata request was rejected ({code}): {message}"
            ))),
            other => Err(KoniError::Process(format!(
                "Pi host returned an invalid metadata response: {other:?}"
            ))),
        }
    }

    pub fn terminate(&mut self) -> Result<()> {
        let host_result = self.host.as_mut().map_or(Ok(()), |host| host.terminate());
        self.host.take();
        let credential_result = self
            .credential_service
            .take()
            .map_or(Ok(()), PiCredentialService::finish);
        host_result.and(credential_result)
    }

    fn host(&self) -> &SupervisedAgentRuntimeHost {
        self.host.as_ref().expect("live Pi runtime owns a host")
    }

    fn host_mut(&mut self) -> &mut SupervisedAgentRuntimeHost {
        self.host.as_mut().expect("live Pi runtime owns a host")
    }

    fn credential_service(&self) -> &PiCredentialService {
        self.credential_service
            .as_ref()
            .expect("live Pi runtime owns a credential service")
    }

    fn ensure_live(&self) -> Result<()> {
        if self.host.is_none() || self.credential_service.is_none() {
            return Err(KoniError::Process(
                "Pi runtime process is terminated and cannot be reused".to_owned(),
            ));
        }
        Ok(())
    }

    fn send_command(&mut self, request_id: &str, command: RuntimeCommand) -> Result<()> {
        self.state.register_command(request_id, &command)?;
        self.host_mut().send_command(request_id, command)
    }

    fn send_tool_result(&mut self, call_id: &str, outcome: AgentToolOutcome) -> Result<()> {
        let outcome = transport_safe_tool_outcome(outcome)?;
        self.state.record_tool_result(call_id, &outcome)?;
        self.host_mut().send_tool_result(call_id, outcome)
    }

    fn receive_timeout(&mut self, timeout: Duration) -> Result<Option<RuntimeInbound>> {
        let Some(inbound) = self.host_mut().receive_timeout(timeout)? else {
            return Ok(None);
        };
        if let Err(error) = self.state.accept_inbound(&inbound) {
            let _ = self.host_mut().terminate();
            return Err(error);
        }
        Ok(Some(inbound))
    }
}

fn transport_safe_tool_outcome(outcome: AgentToolOutcome) -> Result<AgentToolOutcome> {
    let encoded = serde_json::to_vec(&outcome).map_err(|error| {
        KoniError::Process(format!(
            "could not size the compiler-owned Pi tool result: {error}"
        ))
    })?;
    if encoded.len() <= MAX_PI_TOOL_OUTCOME_BYTES {
        return Ok(outcome);
    }
    if outcome.is_terminal() {
        return Err(KoniError::Process(
            "compiler terminal tool result exceeds the Pi transport limit".to_owned(),
        ));
    }
    Ok(AgentToolOutcome::Error {
        code: "tool_result_too_large".to_owned(),
        message: "The compiler result exceeds the runtime transport limit; narrow or paginate the request."
            .to_owned(),
        retryable: true,
    })
}

impl Drop for PiRuntimeProcess {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PiTurnResult {
    pub turn_id: String,
    pub stop_reason: String,
    pub usage: RuntimeUsage,
    pub assistant_messages: Vec<Value>,
}

fn finish_turn(
    turn_id: String,
    stop_reason: String,
    usage: RuntimeUsage,
    assistant_messages: Vec<Value>,
    runtime_failure: Option<PiRuntimeFailure>,
    output_schema: Option<&Value>,
) -> Result<PiTurnResult> {
    if let Some(failure) = runtime_failure {
        return Err(KoniError::PiRuntimeTurn { turn_id, failure });
    }
    if stop_reason == "error" {
        return Err(KoniError::Process(format!(
            "Pi runtime turn {turn_id} completed with an error stop reason"
        )));
    }
    if let Some(schema) = output_schema {
        let payload = structured_assistant_payload(&assistant_messages).ok_or_else(|| {
            KoniError::Process(format!(
                "Pi runtime turn {turn_id} produced no assistant payload for its output schema"
            ))
        })?;
        let validator = jsonschema::validator_for(schema).map_err(|error| {
            KoniError::Process(format!("Pi turn output schema is invalid: {error}"))
        })?;
        if let Err(error) = validator.validate(&payload) {
            return Err(KoniError::Process(format!(
                "Pi runtime turn {turn_id} violated its Rust-owned output schema: {error}"
            )));
        }
    }
    Ok(PiTurnResult {
        turn_id,
        stop_reason,
        usage,
        assistant_messages,
    })
}

fn structured_assistant_payload(messages: &[Value]) -> Option<Value> {
    let last = messages.last()?;
    let text = match last {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let texts = parts
                .iter()
                .filter_map(|part| {
                    (part.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| part.get("text").and_then(Value::as_str))
                        .flatten()
                })
                .collect::<Vec<_>>();
            (!texts.is_empty()).then(|| texts.join(""))
        }
        _ => None,
    };
    if let Some(text) = text {
        let trimmed = text.trim();
        let json_text = if trimmed.starts_with("```") && trimmed.ends_with("```") {
            let after_open = trimmed.split_once('\n').map_or(trimmed, |(_, rest)| rest);
            after_open.strip_suffix("```").unwrap_or(after_open).trim()
        } else {
            trimmed
        };
        return serde_json::from_str(json_text)
            .ok()
            .or(Some(Value::String(text)));
    }
    Some(last.clone())
}

fn wait_for_response(
    process: &mut PiRuntimeProcess,
    expected_request_id: &str,
    timeout: Duration,
    mut on_event: impl FnMut(&RuntimeEvent) -> Result<()>,
) -> Result<RuntimeResponse> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = process.host_mut().terminate();
            return Err(KoniError::Process(format!(
                "Pi runtime request {expected_request_id} timed out"
            )));
        }
        let inbound = process.receive_timeout(remaining)?.ok_or_else(|| {
            KoniError::Process(format!(
                "Pi runtime request {expected_request_id} timed out"
            ))
        })?;
        match inbound {
            RuntimeInbound::Response {
                request_id,
                response,
                ..
            } if request_id == expected_request_id => return Ok(response),
            RuntimeInbound::Event { event, .. } => on_event(&event)?,
            RuntimeInbound::ToolCall { call, .. } => {
                return Err(KoniError::Process(format!(
                    "Pi host requested tool {} before request {expected_request_id} was accepted",
                    call.name
                )));
            }
            RuntimeInbound::Response { request_id, .. } => {
                return Err(KoniError::Process(format!(
                    "Pi host response identity mismatch: expected {expected_request_id}, received {request_id}"
                )));
            }
        }
    }
}

fn host_request(
    request: &PiRuntimeBootstrapRequest,
    scratch: &Path,
    containment: RuntimeContainmentCommand,
) -> Result<AgentRuntimeHostRequest> {
    let mut host = AgentRuntimeHostRequest::with_defaults(
        containment.executable,
        scratch,
        scratch.join("host.stderr"),
        &request.transport_session_id,
    );
    host.args = containment.args;
    host.environment_set = vec![
        ("HOME".to_owned(), path_string(scratch)?),
        ("TMPDIR".to_owned(), path_string(scratch)?),
        ("NODE_NO_WARNINGS".to_owned(), "1".to_owned()),
    ];
    host.environment_remove = secret_environment_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    host.inherit_environment = false;
    Ok(host)
}

fn secret_environment_names() -> [&'static str; 13] {
    [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AZURE_OPENAI_API_KEY",
        "CODEX_API_KEY",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "LEAD_SLICE_TOKEN",
        "LEAD_SLICE_GENERATION",
    ]
}

fn current_containment_platform() -> Result<crate::runtime_containment::RuntimeContainmentPlatform>
{
    if cfg!(target_os = "macos") {
        Ok(crate::runtime_containment::RuntimeContainmentPlatform::MacOs)
    } else if cfg!(target_os = "linux") {
        Ok(crate::runtime_containment::RuntimeContainmentPlatform::Linux)
    } else {
        Err(KoniError::Process(
            "Pi runtime is supported only on macOS and Linux".to_owned(),
        ))
    }
}

fn create_runtime_scratch() -> Result<(TempDir, PathBuf)> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("koni-pi-runtime-");
    #[cfg(unix)]
    builder.permissions(fs::Permissions::from_mode(0o700));
    let temp = builder
        .tempdir()
        .map_err(|error| KoniError::Process(format!("could not create Pi scratch: {error}")))?;
    #[cfg(unix)]
    {
        let metadata =
            fs::symlink_metadata(temp.path()).map_err(|error| io_error(temp.path(), error))?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o777 != 0o700
        {
            return Err(KoniError::Process(format!(
                "Pi scratch is not an owner-only real directory: {}",
                temp.path().display()
            )));
        }
    }
    let canonical = temp
        .path()
        .canonicalize()
        .map_err(|error| io_error(temp.path(), error))?;
    Ok((temp, canonical))
}

fn discover_node_executable() -> Result<PathBuf> {
    // Installed siblings come first so clean-extract/release smoke exercises
    // the bytes shipped in the archive rather than a coincidentally matching
    // Node image left on the build runner.
    let mut candidates = Vec::new();
    if let Ok(current_exe) = env::current_exe()
        && let Some(bin) = current_exe.parent()
    {
        candidates.extend([
            bin.join("koni-pi-host/node"),
            bin.join("../libexec/koni/pi-runtime/node"),
            bin.join("../lib/koni/pi-runtime/node"),
        ]);
    }
    candidates.push(PathBuf::from(PI_NODE_BUILD_PATH));
    candidates.extend(
        [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        .map(PathBuf::from),
    );
    let mut seen = std::collections::BTreeSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.clone()))
        .filter_map(|candidate| fs::canonicalize(candidate).ok())
        .find(|candidate| {
            candidate.is_file()
                && raw_file_sha256(candidate)
                    .is_ok_and(|digest| digest == PI_NODE_BUILD_CHECKSUM)
        })
        .ok_or_else(|| {
            KoniError::Process(format!(
                "Koni Pi runtime requires its build-pinned Node >= {MINIMUM_PI_NODE_VERSION}; PATH lookup and unpinned Node images are intentionally disabled"
            ))
        })
}

fn canonical_regular_file(path: &Path, label: &str) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(path, error))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(KoniError::Process(format!(
            "{label} must be a real regular file: {}",
            path.display()
        )));
    }
    fs::canonicalize(path).map_err(|error| io_error(path, error))
}

fn reject_paths_beneath_writable_roots<const N: usize>(
    paths: [&PathBuf; N],
    forbidden_writable_roots: &[&Path],
) -> Result<()> {
    let roots = forbidden_writable_roots
        .iter()
        .map(|root| fs::canonicalize(root).map_err(|error| io_error(root, error)))
        .collect::<Result<Vec<_>>>()?;
    for path in paths {
        if let Some(root) = roots.iter().find(|root| path.starts_with(root)) {
            return Err(KoniError::Process(format!(
                "Pi runtime artifact {} is beneath agent-writable root {}",
                path.display(),
                root.display()
            )));
        }
    }
    Ok(())
}

fn read_checksum(path: &Path) -> Result<String> {
    let text = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    validated_checksum(
        text.split_whitespace().next().unwrap_or_default(),
        &path.display().to_string(),
    )
    .map(str::to_owned)
}

fn build_bundle_checksum() -> Result<&'static str> {
    validated_checksum(
        PI_BUNDLE_BUILD_CHECKSUM
            .split_whitespace()
            .next()
            .unwrap_or_default(),
        "the Koni build-time Pi manifest",
    )
}

fn validated_checksum<'a>(digest: &'a str, label: &str) -> Result<&'a str> {
    if digest.len() != 64
        || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        || digest.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(KoniError::Process(format!(
            "Pi host checksum must begin with one lowercase SHA-256 digest: {label}",
        )));
    }
    Ok(digest)
}

fn raw_file_sha256(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|error| io_error(path, error))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| io_error(path, error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn stage_verified_bundle(artifact: &PiRuntimeArtifact, scratch: &Path) -> Result<PathBuf> {
    stage_verified_file(
        &artifact.bundle_path,
        &scratch.join(PI_BUNDLE_NAME),
        &artifact.bundle_sha256,
        false,
    )
}

fn stage_verified_node(artifact: &PiRuntimeArtifact, scratch: &Path) -> Result<PathBuf> {
    stage_verified_file(
        &artifact.node_executable,
        &scratch.join("node"),
        &artifact.node_sha256,
        true,
    )
}

fn stage_verified_file(
    source_path: &Path,
    destination: &Path,
    expected_sha256: &str,
    executable: bool,
) -> Result<PathBuf> {
    #[cfg(unix)]
    let descriptor = rustix::fs::open(
        source_path,
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::CLOEXEC | rustix::fs::OFlags::NOFOLLOW,
        rustix::fs::Mode::empty(),
    )
    .map_err(|error| io_error(source_path, std::io::Error::from(error)))?;
    #[cfg(unix)]
    let mut source = fs::File::from(descriptor);
    #[cfg(not(unix))]
    let mut source = fs::File::open(source_path).map_err(|error| io_error(source_path, error))?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| io_error(destination, error))?;
    std::io::copy(&mut source, &mut output).map_err(|error| io_error(destination, error))?;
    #[cfg(unix)]
    fs::set_permissions(
        destination,
        fs::Permissions::from_mode(if executable { 0o500 } else { 0o400 }),
    )
    .map_err(|error| io_error(destination, error))?;
    output
        .sync_all()
        .map_err(|error| io_error(destination, error))?;
    if raw_file_sha256(destination)? != expected_sha256 {
        return Err(KoniError::Process(
            "a Pi runtime artifact changed while it was staged for launch".to_owned(),
        ));
    }
    fs::File::open(
        destination
            .parent()
            .expect("staged Pi artifact has a parent"),
    )
    .and_then(|directory| directory.sync_all())
    .map_err(|error| io_error(destination, error))?;
    Ok(destination.to_path_buf())
}

fn validate_runtime_identifier(label: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(KoniError::Process(format!(
            "Pi runtime {label} must be 1..=128 bytes without surrounding whitespace or controls"
        )));
    }
    Ok(())
}

fn path_string(path: &Path) -> Result<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        KoniError::Process(format!(
            "Pi runtime path is not valid Unicode: {}",
            path.display()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn write_executable(path: &Path, text: &str) {
        fs::write(path, text).unwrap();
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn artifact_verification_binds_node_bundle_and_checksum() {
        let temp = tempfile::tempdir().unwrap();
        let node = temp.path().join("node");
        write_executable(&node, "#!/bin/sh\necho v22.19.0\n");
        let bundle = temp.path().join(PI_BUNDLE_NAME);
        fs::write(&bundle, "console.log('bound');\n").unwrap();
        let checksum = temp.path().join(PI_BUNDLE_CHECKSUM_NAME);
        fs::write(
            &checksum,
            format!(
                "{}  {}\n",
                raw_file_sha256(&bundle).unwrap(),
                PI_BUNDLE_NAME
            ),
        )
        .unwrap();

        let expected = raw_file_sha256(&bundle).unwrap();
        let expected_node = raw_file_sha256(&node).unwrap();
        let artifact = PiRuntimeArtifact::verify_expected(
            &node,
            &bundle,
            &checksum,
            &expected,
            &expected_node,
            &[],
        )
        .unwrap();
        assert_eq!(artifact.bundle_sha256(), raw_file_sha256(&bundle).unwrap());
    }

    #[test]
    #[cfg(unix)]
    fn artifact_verification_rejects_mutation_and_writable_location() {
        let temp = tempfile::tempdir().unwrap();
        let node = temp.path().join("node");
        write_executable(&node, "#!/bin/sh\necho v22.19.0\n");
        let bundle = temp.path().join(PI_BUNDLE_NAME);
        let checksum = temp.path().join(PI_BUNDLE_CHECKSUM_NAME);
        fs::write(&bundle, "first").unwrap();
        let expected = raw_file_sha256(&bundle).unwrap();
        fs::write(&checksum, format!("{expected}\n")).unwrap();
        fs::write(&bundle, "changed").unwrap();
        assert!(
            PiRuntimeArtifact::verify_expected(
                &node,
                &bundle,
                &checksum,
                &expected,
                &raw_file_sha256(&node).unwrap(),
                &[],
            )
            .unwrap_err()
            .to_string()
            .contains("checksum mismatch")
        );

        fs::write(
            &checksum,
            format!("{}\n", raw_file_sha256(&bundle).unwrap()),
        )
        .unwrap();
        assert!(
            PiRuntimeArtifact::verify_expected(
                &node,
                &bundle,
                &checksum,
                &raw_file_sha256(&bundle).unwrap(),
                &raw_file_sha256(&node).unwrap(),
                &[temp.path()],
            )
            .unwrap_err()
            .to_string()
            .contains("agent-writable root")
        );
    }

    #[test]
    #[cfg(unix)]
    fn staging_rejects_post_verification_node_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let node = temp.path().join("node-source");
        write_executable(&node, "#!/bin/sh\necho original\n");
        let bundle = temp.path().join(PI_BUNDLE_NAME);
        fs::write(&bundle, "console.log('bound');\n").unwrap();
        let checksum = temp.path().join(PI_BUNDLE_CHECKSUM_NAME);
        let bundle_digest = raw_file_sha256(&bundle).unwrap();
        fs::write(&checksum, format!("{bundle_digest}\n")).unwrap();
        let artifact = PiRuntimeArtifact::verify_expected(
            &node,
            &bundle,
            &checksum,
            &bundle_digest,
            &raw_file_sha256(&node).unwrap(),
            &[],
        )
        .unwrap();
        write_executable(&node, "#!/bin/sh\necho replaced\n");
        let scratch = tempfile::tempdir().unwrap();
        assert!(
            stage_verified_node(&artifact, scratch.path())
                .unwrap_err()
                .to_string()
                .contains("changed while it was staged")
        );
    }

    #[test]
    #[cfg(unix)]
    fn runtime_scratch_is_created_owner_only() {
        let (scratch, launch_path) = create_runtime_scratch().expect("owner-only runtime scratch");
        let metadata = fs::symlink_metadata(scratch.path()).unwrap();
        assert!(metadata.is_dir());
        assert!(!metadata.file_type().is_symlink());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
        assert_eq!(launch_path, fs::canonicalize(scratch.path()).unwrap());
    }

    #[test]
    fn oversized_nonterminal_tool_results_become_bounded_retryable_errors() {
        let outcome = transport_safe_tool_outcome(AgentToolOutcome::Success {
            value: Value::String("x".repeat(MAX_PI_TOOL_OUTCOME_BYTES + 1)),
        })
        .unwrap();
        assert_eq!(
            outcome,
            AgentToolOutcome::Error {
                code: "tool_result_too_large".to_owned(),
                message: "The compiler result exceeds the runtime transport limit; narrow or paginate the request."
                    .to_owned(),
                retryable: true,
            }
        );
        assert!(serde_json::to_vec(&outcome).unwrap().len() < MAX_PI_TOOL_OUTCOME_BYTES);
    }

    #[test]
    fn oversized_terminal_tool_results_fail_closed() {
        let error = transport_safe_tool_outcome(AgentToolOutcome::Terminate {
            value: Value::String("x".repeat(MAX_PI_TOOL_OUTCOME_BYTES + 1)),
        })
        .unwrap_err();
        assert!(error.to_string().contains("terminal tool result exceeds"));
    }

    #[test]
    fn secret_environment_is_explicitly_denied() {
        let names = secret_environment_names();
        assert!(names.contains(&"OPENAI_API_KEY"));
        assert!(names.contains(&"GITHUB_TOKEN"));
        assert!(names.contains(&"LEAD_SLICE_TOKEN"));
    }

    #[test]
    fn browser_oauth_callback_capability_requires_outbound_networking() {
        let mut request = PiRuntimeBootstrapRequest {
            artifact: PiRuntimeArtifact {
                node_executable: PathBuf::from("/unused/node"),
                node_sha256: "unused".to_owned(),
                bundle_path: PathBuf::from("/unused/bundle"),
                bundle_sha256: "unused".to_owned(),
            },
            transport_session_id: "auth-session".to_owned(),
            credential_lease: CredentialLeaseId("auth-lease".to_owned()),
            timeout: Duration::from_secs(1),
            network_access: false,
            oauth_callback_access: true,
        };
        assert!(
            request
                .validate()
                .unwrap_err()
                .to_string()
                .contains("requires outbound network access")
        );
        request.network_access = true;
        request.validate().unwrap();
    }

    #[test]
    fn rust_validates_structured_assistant_output() {
        let schema = serde_json::json!({
            "type": "object",
            "required": ["ok"],
            "properties": {"ok": {"const": true}},
            "additionalProperties": false
        });
        let messages = vec![serde_json::json!([
            {"type": "text", "text": "```json\n{\"ok\":true}\n```"}
        ])];
        assert_eq!(
            structured_assistant_payload(&messages),
            Some(serde_json::json!({"ok": true}))
        );
        assert!(
            finish_turn(
                "turn-1".to_owned(),
                "stop".to_owned(),
                RuntimeUsage::default(),
                messages,
                None,
                Some(&schema),
            )
            .is_ok()
        );
        assert!(
            finish_turn(
                "turn-2".to_owned(),
                "stop".to_owned(),
                RuntimeUsage::default(),
                vec![serde_json::json!([{"type":"text", "text":"{\"ok\":false}"}])],
                None,
                Some(&schema),
            )
            .unwrap_err()
            .to_string()
            .contains("Rust-owned output schema")
        );
    }

    #[test]
    fn turn_failure_preserves_the_validated_retry_disposition() {
        for (code, message, retryable) in [
            (
                "provider_rate_limited",
                "OpenAI Codex is temporarily rate-limiting requests. Retry after a short delay.",
                true,
            ),
            (
                "provider_authentication",
                "OpenAI Codex rejected the stored sign-in. Run koni auth login, then resume the run.",
                false,
            ),
        ] {
            let failure = PiRuntimeFailure::from_wire(code, message, retryable).unwrap();
            let error = finish_turn(
                "turn-failed".to_owned(),
                "error".to_owned(),
                RuntimeUsage::default(),
                Vec::new(),
                Some(failure.clone()),
                None,
            )
            .unwrap_err();
            match error {
                KoniError::PiRuntimeTurn {
                    turn_id,
                    failure: actual,
                } => {
                    assert_eq!(turn_id, "turn-failed");
                    assert_eq!(actual, failure);
                    assert_eq!(actual.retryable, retryable);
                }
                other => panic!("expected typed Pi failure, got {other}"),
            }
        }
    }
}
