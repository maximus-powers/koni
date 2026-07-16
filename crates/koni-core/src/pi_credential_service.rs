//! Private fd3 service joining Pi's `CredentialStore` to Koni's account file.
//!
//! This channel is deliberately distinct from the public runtime protocol.
//! Only the exact Rust-issued lease for one supervised host is accepted, and
//! a `modify_begin` keeps the cross-process account lock until commit, abort,
//! disconnect, or host termination.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::io::{BufRead, BufReader, BufWriter};
#[cfg(unix)]
use std::os::unix::net::UnixStream;

use uuid::Uuid;

use crate::error::{KoniError, Result};
use crate::pi_auth::{
    CredentialLeaseId, PI_CREDENTIAL_PROTOCOL_VERSION, PiCredentialFrame,
    PiOAuthCredentialMaterial, read_pi_credential_frame, write_pi_credential_frame,
};
use crate::pi_credentials::{
    PI_OAUTH_PROVIDER_ID, PiCredentialBroker, PiCredentialMaterial, PiCredentialTransaction,
};

pub(crate) struct PiCredentialService {
    #[cfg(unix)]
    child_socket: Option<UnixStream>,
    thread: Option<thread::JoinHandle<Result<()>>>,
    authority: CredentialAuthority,
}

/// Rust-owned reason that the untrusted host may touch the private credential
/// store. A lease identifies the process; this intent authorizes one bounded
/// operation performed by that process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CredentialAccessIntent {
    ReadOnly,
    Login,
    Logout,
    InferenceRefresh,
}

#[derive(Debug, Clone)]
struct AuthorizedIntent {
    id: String,
    kind: CredentialAccessIntent,
    expires_at: Instant,
    delete_available: bool,
    login_modify_available: bool,
    refresh_modify_available: bool,
}

#[derive(Debug, Clone, Default)]
struct CredentialAuthority(Arc<Mutex<Option<AuthorizedIntent>>>);

pub(crate) struct CredentialIntentGuard {
    authority: CredentialAuthority,
    id: String,
}

impl Drop for CredentialIntentGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.authority.0.lock()
            && active.as_ref().map(|intent| intent.id.as_str()) == Some(self.id.as_str())
        {
            active.take();
        }
    }
}

impl std::fmt::Debug for PiCredentialService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PiCredentialService")
            .field("child_socket_available", &self.child_socket_available())
            .field("thread_running", &self.thread.is_some())
            .finish()
    }
}

impl PiCredentialService {
    pub(crate) fn spawn(lease: CredentialLeaseId) -> Result<Self> {
        #[cfg(not(unix))]
        {
            let _ = lease;
            return Err(KoniError::Process(
                "Pi subscription OAuth requires a private Unix credential socket".to_owned(),
            ));
        }
        #[cfg(unix)]
        {
            let (parent, child) = UnixStream::pair().map_err(|error| {
                KoniError::Process(format!(
                    "could not create Pi private credential socket: {error}"
                ))
            })?;
            let authority = CredentialAuthority::default();
            let service_authority = authority.clone();
            let thread = thread::Builder::new()
                .name("koni-pi-credentials".to_owned())
                .spawn(move || {
                    serve_credential_stream(parent, lease, FileCredentialBackend, service_authority)
                })
                .map_err(|error| {
                    KoniError::Process(format!(
                        "could not start Pi private credential service: {error}"
                    ))
                })?;
            Ok(Self {
                child_socket: Some(child),
                thread: Some(thread),
                authority,
            })
        }
    }

    pub(crate) fn authorize(
        &self,
        kind: CredentialAccessIntent,
        ttl: Duration,
    ) -> Result<CredentialIntentGuard> {
        if ttl.is_zero() {
            return Err(KoniError::Process(
                "Pi credential intent must have a positive lifetime".to_owned(),
            ));
        }
        let id = format!("intent-{}", Uuid::now_v7());
        let mut active =
            self.authority.0.lock().map_err(|_| {
                KoniError::Process("Pi credential intent lock was poisoned".to_owned())
            })?;
        if active
            .as_ref()
            .is_some_and(|intent| intent.expires_at > Instant::now())
        {
            return Err(KoniError::Process(
                "Pi credential service already has an active operation intent".to_owned(),
            ));
        }
        *active = Some(AuthorizedIntent {
            id: id.clone(),
            kind,
            expires_at: Instant::now() + ttl,
            delete_available: kind == CredentialAccessIntent::Logout,
            login_modify_available: kind == CredentialAccessIntent::Login,
            refresh_modify_available: kind == CredentialAccessIntent::InferenceRefresh,
        });
        drop(active);
        Ok(CredentialIntentGuard {
            authority: self.authority.clone(),
            id,
        })
    }

    pub(crate) fn child_socket_available(&self) -> bool {
        #[cfg(unix)]
        {
            self.child_socket.is_some()
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    #[cfg(unix)]
    pub(crate) fn take_child_socket(&mut self) -> Result<UnixStream> {
        self.child_socket.take().ok_or_else(|| {
            KoniError::Process("Pi private credential socket was already consumed".to_owned())
        })
    }

    /// Join only after the host-side socket has closed. An unexpected service
    /// error is a runtime failure, never a warning that permits credential
    /// fallback.
    pub(crate) fn finish(mut self) -> Result<()> {
        #[cfg(unix)]
        drop(self.child_socket.take());
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while !thread.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if !thread.is_finished() {
            drop(thread);
            return Err(KoniError::Process(
                "Pi private credential service did not stop within its bounded shutdown window"
                    .to_owned(),
            ));
        }
        thread
            .join()
            .map_err(|_| KoniError::Process("Pi private credential service panicked".to_owned()))?
    }
}

impl Drop for PiCredentialService {
    fn drop(&mut self) {
        #[cfg(unix)]
        drop(self.child_socket.take());
        // A live host owns the peer and therefore the service lifetime. Drop
        // cannot block indefinitely; closing or terminating the host closes
        // fd3 and lets this bounded thread exit naturally.
        let _ = self.thread.take();
    }
}

trait CredentialBackend: Send + 'static {
    fn read(&self) -> Result<(u64, Option<PiCredentialMaterial>)>;
    fn begin_modify(&self) -> Result<Box<dyn CredentialTransactionBackend>>;
    fn delete(&self) -> Result<()>;
}

trait CredentialTransactionBackend {
    fn current(&self) -> Option<&PiCredentialMaterial>;
    fn commit(&mut self, next: PiCredentialMaterial) -> Result<()>;
    fn abort(&mut self);
}

#[derive(Debug, Clone, Copy)]
struct FileCredentialBackend;

impl CredentialBackend for FileCredentialBackend {
    fn read(&self) -> Result<(u64, Option<PiCredentialMaterial>)> {
        PiCredentialBroker::default().read_revisioned(PI_OAUTH_PROVIDER_ID)
    }

    fn begin_modify(&self) -> Result<Box<dyn CredentialTransactionBackend>> {
        Ok(Box::new(FileCredentialTransaction(
            PiCredentialBroker::default().begin_modify(PI_OAUTH_PROVIDER_ID)?,
        )))
    }

    fn delete(&self) -> Result<()> {
        PiCredentialBroker::default().delete()
    }
}

struct FileCredentialTransaction(PiCredentialTransaction);

impl CredentialTransactionBackend for FileCredentialTransaction {
    fn current(&self) -> Option<&PiCredentialMaterial> {
        self.0.current()
    }

    fn commit(&mut self, next: PiCredentialMaterial) -> Result<()> {
        self.0.commit(self.0.revision(), next).map(|_| ())
    }

    fn abort(&mut self) {
        self.0.abort();
    }
}

struct ActiveTransaction {
    id: String,
    intent_id: String,
    intent_kind: CredentialAccessIntent,
    original_account_id: Option<String>,
    transaction: Box<dyn CredentialTransactionBackend>,
}

#[cfg(unix)]
fn serve_credential_stream<B: CredentialBackend>(
    stream: UnixStream,
    allowed_lease: CredentialLeaseId,
    backend: B,
    authority: CredentialAuthority,
) -> Result<()> {
    // A bounded read wakeup lets Rust revoke an operation intent and abort a
    // transaction even when a hostile host abandons fd3 mid-refresh.
    stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .map_err(|error| {
            KoniError::Process(format!(
                "could not bound the Pi credential service read: {error}"
            ))
        })?;
    let writer = stream.try_clone().map_err(|error| {
        KoniError::Process(format!(
            "could not clone Pi private credential socket: {error}"
        ))
    })?;
    let mut reader = BufReader::new(stream);
    let mut writer = BufWriter::new(writer);
    let mut active: Option<ActiveTransaction> = None;
    loop {
        abort_revoked_transaction(&mut active, &authority);
        match reader.fill_buf() {
            Ok([]) => break,
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(error) => {
                return Err(KoniError::Process(format!(
                    "Pi credential protocol error: could not read private frame: {error}"
                )));
            }
        }
        let Some(frame) = read_pi_credential_frame(&mut reader)? else {
            break;
        };
        let response =
            handle_credential_frame(frame, &allowed_lease, &backend, &authority, &mut active)?;
        write_pi_credential_frame(&mut writer, &response)?;
    }
    if let Some(mut active) = active {
        active.transaction.abort();
    }
    Ok(())
}

fn abort_revoked_transaction(
    active: &mut Option<ActiveTransaction>,
    authority: &CredentialAuthority,
) {
    let revoked = active.as_ref().is_some_and(|transaction| {
        !intent_is_current(authority, &transaction.intent_id, transaction.intent_kind)
    });
    if revoked && let Some(mut transaction) = active.take() {
        transaction.transaction.abort();
    }
}

fn handle_credential_frame<B: CredentialBackend>(
    frame: PiCredentialFrame,
    allowed_lease: &CredentialLeaseId,
    backend: &B,
    authority: &CredentialAuthority,
    active: &mut Option<ActiveTransaction>,
) -> Result<PiCredentialFrame> {
    let (request_id, lease_id) = request_identity(&frame).ok_or_else(|| {
        KoniError::Process(
            "Pi credential protocol error: host sent a broker-only response frame".to_owned(),
        )
    })?;
    if &lease_id != allowed_lease {
        return Ok(credential_error(
            request_id,
            "credential_lease_denied",
            "The credential lease is not valid for this runtime host.",
            false,
        ));
    }

    match frame {
        PiCredentialFrame::Read { request_id, .. } => {
            let intent = match current_intent(authority) {
                Ok(intent) => intent,
                Err(()) => return Ok(intent_error(request_id)),
            };
            if !matches!(
                intent.kind,
                CredentialAccessIntent::ReadOnly | CredentialAccessIntent::InferenceRefresh
            ) {
                return Ok(intent_error(request_id));
            }
            match backend.read() {
                Ok((revision, credential))
                    if intent_is_current(authority, &intent.id, intent.kind) =>
                {
                    Ok(PiCredentialFrame::ReadResult {
                        protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                        request_id,
                        lease_id,
                        revision,
                        credential: credential.as_ref().map(material_to_wire).transpose()?,
                    })
                }
                Ok(_) => Ok(intent_error(request_id)),
                Err(_) => Ok(storage_error(request_id)),
            }
        }
        PiCredentialFrame::ModifyBegin { request_id, .. } => {
            if active.is_some() {
                return Ok(credential_error(
                    request_id,
                    "credential_transaction_busy",
                    "A credential refresh transaction is already active.",
                    true,
                ));
            }
            let intent = match available_modify_intent(authority) {
                Ok(intent) => intent,
                Err(()) => return Ok(intent_error(request_id)),
            };
            match backend.begin_modify() {
                Ok(transaction) => {
                    if !intent_is_current(authority, &intent.id, intent.kind) {
                        let mut transaction = transaction;
                        transaction.abort();
                        return Ok(intent_error(request_id));
                    }
                    if intent.kind == CredentialAccessIntent::InferenceRefresh
                        && transaction
                            .current()
                            .and_then(|material| material.metadata().account_id.as_deref())
                            .is_none()
                    {
                        let mut transaction = transaction;
                        transaction.abort();
                        return Ok(intent_error(request_id));
                    }
                    if !claim_modify_intent(authority, &intent) {
                        let mut transaction = transaction;
                        transaction.abort();
                        return Ok(intent_error(request_id));
                    }
                    // A login intent may replace credentials, but it never
                    // grants the untrusted host a read capability over the
                    // previously signed-in account. Refresh needs the current
                    // material and is identity-pinned below.
                    let current = if intent.kind == CredentialAccessIntent::InferenceRefresh {
                        transaction.current().map(material_to_wire).transpose()?
                    } else {
                        None
                    };
                    let original_account_id = transaction
                        .current()
                        .and_then(|material| material.metadata().account_id.clone());
                    let transaction_id = format!("transaction-{}", Uuid::now_v7());
                    *active = Some(ActiveTransaction {
                        id: transaction_id.clone(),
                        intent_id: intent.id,
                        intent_kind: intent.kind,
                        original_account_id,
                        transaction,
                    });
                    Ok(PiCredentialFrame::ModifyBeginResult {
                        protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                        request_id,
                        lease_id,
                        transaction_id,
                        current,
                    })
                }
                Err(_) => Ok(storage_error(request_id)),
            }
        }
        PiCredentialFrame::ModifyCommit {
            request_id,
            transaction_id,
            credential,
            ..
        } => {
            if active.as_ref().map(|active| active.id.as_str()) != Some(&transaction_id) {
                return Ok(transaction_error(request_id));
            }
            let mut transaction = active.take().expect("identity checked above");
            if !intent_is_current(authority, &transaction.intent_id, transaction.intent_kind) {
                transaction.transaction.abort();
                return Ok(intent_error(request_id));
            }
            let committed = wire_to_material(&credential)?;
            if transaction.intent_kind == CredentialAccessIntent::InferenceRefresh
                && committed.metadata().account_id != transaction.original_account_id
            {
                transaction.transaction.abort();
                return Ok(credential_error(
                    request_id,
                    "credential_identity_changed",
                    "Credential refresh changed the signed-in account identity.",
                    false,
                ));
            }
            let response_credential = material_to_wire(&committed)?;
            match transaction.transaction.commit(committed) {
                Ok(()) => Ok(PiCredentialFrame::ModifyCommitResult {
                    protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                    request_id,
                    lease_id,
                    transaction_id,
                    credential: response_credential,
                }),
                Err(_) => Ok(storage_error(request_id)),
            }
        }
        PiCredentialFrame::ModifyAbort {
            request_id,
            transaction_id,
            ..
        } => {
            if active.as_ref().map(|active| active.id.as_str()) != Some(&transaction_id) {
                return Ok(transaction_error(request_id));
            }
            let mut transaction = active.take().expect("identity checked above");
            transaction.transaction.abort();
            Ok(PiCredentialFrame::ModifyAbortResult {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id,
                lease_id,
                transaction_id,
            })
        }
        PiCredentialFrame::Delete { request_id, .. } => {
            if active.is_some() {
                return Ok(credential_error(
                    request_id,
                    "credential_transaction_busy",
                    "A credential refresh transaction is already active.",
                    true,
                ));
            }
            if !consume_logout_intent(authority) {
                return Ok(intent_error(request_id));
            }
            match backend.delete() {
                Ok(()) => Ok(PiCredentialFrame::DeleteResult {
                    protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                    request_id,
                    lease_id,
                }),
                Err(_) => Ok(storage_error(request_id)),
            }
        }
        _ => Err(KoniError::Process(
            "Pi credential protocol error: host sent a broker-only response frame".to_owned(),
        )),
    }
}

fn request_identity(frame: &PiCredentialFrame) -> Option<(String, CredentialLeaseId)> {
    match frame {
        PiCredentialFrame::Read {
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::ModifyBegin {
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::ModifyCommit {
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::ModifyAbort {
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::Delete {
            request_id,
            lease_id,
            ..
        } => Some((request_id.clone(), lease_id.clone())),
        _ => None,
    }
}

fn material_to_wire(material: &PiCredentialMaterial) -> Result<PiOAuthCredentialMaterial> {
    serde_json::from_slice(material.expose_bytes()).map_err(|_| {
        KoniError::Process(
            "Pi authentication failed: stored OAuth credential could not be transferred".to_owned(),
        )
    })
}

fn wire_to_material(credential: &PiOAuthCredentialMaterial) -> Result<PiCredentialMaterial> {
    let encoded = serde_json::to_vec(credential).map_err(|_| {
        KoniError::Process(
            "Pi authentication failed: refreshed OAuth credential could not be transferred"
                .to_owned(),
        )
    })?;
    PiCredentialMaterial::from_json_bytes(PI_OAUTH_PROVIDER_ID, encoded)
}

fn credential_error(
    request_id: String,
    code: &str,
    message: &str,
    retryable: bool,
) -> PiCredentialFrame {
    PiCredentialFrame::Error {
        protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
        request_id,
        code: code.to_owned(),
        message: message.to_owned(),
        retryable,
    }
}

fn storage_error(request_id: String) -> PiCredentialFrame {
    credential_error(
        request_id,
        "credential_store_unavailable",
        "Koni's credential file could not complete this request.",
        true,
    )
}

fn transaction_error(request_id: String) -> PiCredentialFrame {
    credential_error(
        request_id,
        "credential_transaction_invalid",
        "The credential transaction is not current for this runtime host.",
        false,
    )
}

fn intent_error(request_id: String) -> PiCredentialFrame {
    credential_error(
        request_id,
        "credential_intent_denied",
        "This credential operation was not authorized by the active Rust request.",
        false,
    )
}

fn current_intent(authority: &CredentialAuthority) -> std::result::Result<AuthorizedIntent, ()> {
    let mut active = authority.0.lock().map_err(|_| ())?;
    if active
        .as_ref()
        .is_some_and(|intent| intent.expires_at <= Instant::now())
    {
        active.take();
    }
    active.clone().ok_or(())
}

fn available_modify_intent(
    authority: &CredentialAuthority,
) -> std::result::Result<AuthorizedIntent, ()> {
    let mut active = authority.0.lock().map_err(|_| ())?;
    if active
        .as_ref()
        .is_some_and(|intent| intent.expires_at <= Instant::now())
    {
        active.take();
        return Err(());
    }
    let intent = active.as_ref().ok_or(())?;
    match intent.kind {
        CredentialAccessIntent::Login if intent.login_modify_available => {}
        CredentialAccessIntent::InferenceRefresh if intent.refresh_modify_available => {}
        _ => return Err(()),
    }
    Ok(intent.clone())
}

fn claim_modify_intent(authority: &CredentialAuthority, expected: &AuthorizedIntent) -> bool {
    let Ok(mut active) = authority.0.lock() else {
        return false;
    };
    if active
        .as_ref()
        .is_some_and(|intent| intent.expires_at <= Instant::now())
    {
        active.take();
        return false;
    }
    let Some(intent) = active.as_mut() else {
        return false;
    };
    if intent.id != expected.id || intent.kind != expected.kind {
        return false;
    }
    match intent.kind {
        CredentialAccessIntent::Login if intent.login_modify_available => {
            intent.login_modify_available = false;
            true
        }
        CredentialAccessIntent::InferenceRefresh if intent.refresh_modify_available => {
            intent.refresh_modify_available = false;
            true
        }
        _ => false,
    }
}

fn intent_is_current(
    authority: &CredentialAuthority,
    id: &str,
    kind: CredentialAccessIntent,
) -> bool {
    current_intent(authority).is_ok_and(|intent| intent.id == id && intent.kind == kind)
}

fn consume_logout_intent(authority: &CredentialAuthority) -> bool {
    let Ok(mut active) = authority.0.lock() else {
        return false;
    };
    if active
        .as_ref()
        .is_some_and(|intent| intent.expires_at <= Instant::now())
    {
        active.take();
        return false;
    }
    let allowed = active.as_ref().is_some_and(|intent| {
        intent.kind == CredentialAccessIntent::Logout && intent.delete_available
    });
    if allowed {
        active.take();
    }
    allowed
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::pi_auth::{PiCredentialKind, SensitiveCredential};
    use serde_json::Value;

    #[derive(Default)]
    struct FakeState {
        revision: u64,
        credential: Option<Vec<u8>>,
        transaction_active: bool,
        deletes: usize,
    }

    #[derive(Clone, Default)]
    struct FakeBackend(Arc<Mutex<FakeState>>);

    impl CredentialBackend for FakeBackend {
        fn read(&self) -> Result<(u64, Option<PiCredentialMaterial>)> {
            let state = self.0.lock().unwrap();
            Ok((
                state.revision,
                state
                    .credential
                    .clone()
                    .map(|bytes| PiCredentialMaterial::from_json_bytes(PI_OAUTH_PROVIDER_ID, bytes))
                    .transpose()?,
            ))
        }

        fn begin_modify(&self) -> Result<Box<dyn CredentialTransactionBackend>> {
            let mut state = self.0.lock().unwrap();
            if state.transaction_active {
                return Err(KoniError::Process("fake transaction busy".to_owned()));
            }
            state.transaction_active = true;
            let current = state
                .credential
                .clone()
                .map(|bytes| PiCredentialMaterial::from_json_bytes(PI_OAUTH_PROVIDER_ID, bytes))
                .transpose()?;
            drop(state);
            Ok(Box::new(FakeTransaction {
                state: self.0.clone(),
                current,
                finished: false,
            }))
        }

        fn delete(&self) -> Result<()> {
            let mut state = self.0.lock().unwrap();
            state.credential = None;
            state.deletes += 1;
            Ok(())
        }
    }

    struct FakeTransaction {
        state: Arc<Mutex<FakeState>>,
        current: Option<PiCredentialMaterial>,
        finished: bool,
    }

    impl CredentialTransactionBackend for FakeTransaction {
        fn current(&self) -> Option<&PiCredentialMaterial> {
            self.current.as_ref()
        }

        fn commit(&mut self, next: PiCredentialMaterial) -> Result<()> {
            let mut state = self.state.lock().unwrap();
            state.revision += 1;
            state.credential = Some(next.expose_bytes().to_vec());
            state.transaction_active = false;
            self.finished = true;
            Ok(())
        }

        fn abort(&mut self) {
            self.state.lock().unwrap().transaction_active = false;
            self.finished = true;
        }
    }

    impl Drop for FakeTransaction {
        fn drop(&mut self) {
            if !self.finished {
                self.state.lock().unwrap().transaction_active = false;
            }
        }
    }

    fn wire_credential(access: &str) -> PiOAuthCredentialMaterial {
        wire_credential_for_account(access, "account-1")
    }

    fn wire_credential_for_account(access: &str, account: &str) -> PiOAuthCredentialMaterial {
        PiOAuthCredentialMaterial {
            kind: PiCredentialKind::OAuth,
            access: SensitiveCredential::new(access),
            refresh: SensitiveCredential::new("refresh-secret"),
            expires: 1_900_000_000_000,
            metadata: std::collections::BTreeMap::from([(
                "accountId".to_owned(),
                Value::String(account.to_owned()),
            )]),
        }
    }

    fn authorized_intent(
        kind: CredentialAccessIntent,
    ) -> (CredentialAuthority, CredentialIntentGuard) {
        let authority = CredentialAuthority::default();
        let id = format!("test-intent-{}", Uuid::now_v7());
        *authority.0.lock().unwrap() = Some(AuthorizedIntent {
            id: id.clone(),
            kind,
            expires_at: Instant::now() + Duration::from_secs(30),
            delete_available: kind == CredentialAccessIntent::Logout,
            login_modify_available: kind == CredentialAccessIntent::Login,
            refresh_modify_available: kind == CredentialAccessIntent::InferenceRefresh,
        });
        let guard = CredentialIntentGuard {
            authority: authority.clone(),
            id,
        };
        (authority, guard)
    }

    #[test]
    fn lease_bound_service_serializes_modify_commit_and_delete() {
        let backend = FakeBackend::default();
        let lease = CredentialLeaseId("lease-1".to_owned());
        let mut active = None;
        let (authority, login_guard) = authorized_intent(CredentialAccessIntent::Login);
        let begin = handle_credential_frame(
            PiCredentialFrame::ModifyBegin {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "begin-1".to_owned(),
                lease_id: lease.clone(),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        let transaction_id = match begin {
            PiCredentialFrame::ModifyBeginResult {
                transaction_id,
                current,
                ..
            } => {
                assert!(
                    current.is_none(),
                    "login must not disclose stored credentials"
                );
                transaction_id
            }
            other => panic!("unexpected response: {other:?}"),
        };
        assert!(backend.0.lock().unwrap().transaction_active);

        let committed = handle_credential_frame(
            PiCredentialFrame::ModifyCommit {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "commit-1".to_owned(),
                lease_id: lease.clone(),
                transaction_id,
                credential: wire_credential("access-secret"),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        assert!(matches!(
            committed,
            PiCredentialFrame::ModifyCommitResult { .. }
        ));
        assert!(!backend.0.lock().unwrap().transaction_active);
        assert_eq!(backend.0.lock().unwrap().revision, 1);

        let replayed_login_write = handle_credential_frame(
            PiCredentialFrame::ModifyBegin {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "begin-replay".to_owned(),
                lease_id: lease.clone(),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        assert!(matches!(
            replayed_login_write,
            PiCredentialFrame::Error { ref code, .. } if code == "credential_intent_denied"
        ));

        drop(login_guard);
        let (logout_authority, _logout_guard) = authorized_intent(CredentialAccessIntent::Logout);

        let deleted = handle_credential_frame(
            PiCredentialFrame::Delete {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "delete-1".to_owned(),
                lease_id: lease.clone(),
            },
            &lease,
            &backend,
            &logout_authority,
            &mut active,
        )
        .unwrap();
        assert!(matches!(deleted, PiCredentialFrame::DeleteResult { .. }));
        assert_eq!(backend.0.lock().unwrap().deletes, 1);
    }

    #[test]
    fn wrong_lease_and_parallel_modify_fail_without_touching_storage() {
        let backend = FakeBackend::default();
        let lease = CredentialLeaseId("lease-1".to_owned());
        let mut active = None;
        let (authority, _guard) = authorized_intent(CredentialAccessIntent::Login);
        let denied = handle_credential_frame(
            PiCredentialFrame::Read {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "read-1".to_owned(),
                lease_id: CredentialLeaseId("lease-forged".to_owned()),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        assert!(matches!(
            denied,
            PiCredentialFrame::Error { ref code, .. } if code == "credential_lease_denied"
        ));

        let _ = handle_credential_frame(
            PiCredentialFrame::ModifyBegin {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "begin-1".to_owned(),
                lease_id: lease.clone(),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        let busy = handle_credential_frame(
            PiCredentialFrame::ModifyBegin {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "begin-2".to_owned(),
                lease_id: lease,
            },
            &CredentialLeaseId("lease-1".to_owned()),
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        assert!(matches!(
            busy,
            PiCredentialFrame::Error { ref code, .. } if code == "credential_transaction_busy"
        ));
    }

    #[test]
    fn mutation_requires_matching_live_operation_intent_and_logout_is_one_shot() {
        let backend = FakeBackend::default();
        let lease = CredentialLeaseId("lease-1".to_owned());
        let authority = CredentialAuthority::default();
        let mut active = None;

        let denied = handle_credential_frame(
            PiCredentialFrame::Delete {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "delete-denied".to_owned(),
                lease_id: lease.clone(),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        assert!(matches!(
            denied,
            PiCredentialFrame::Error { ref code, .. } if code == "credential_intent_denied"
        ));
        assert_eq!(backend.0.lock().unwrap().deletes, 0);

        let (logout_authority, _guard) = authorized_intent(CredentialAccessIntent::Logout);
        for (index, expected) in [true, false].into_iter().enumerate() {
            let response = handle_credential_frame(
                PiCredentialFrame::Delete {
                    protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                    request_id: format!("delete-{index}"),
                    lease_id: lease.clone(),
                },
                &lease,
                &backend,
                &logout_authority,
                &mut active,
            )
            .unwrap();
            assert_eq!(
                matches!(response, PiCredentialFrame::DeleteResult { .. }),
                expected
            );
        }
        assert_eq!(backend.0.lock().unwrap().deletes, 1);
    }

    #[test]
    fn login_and_logout_intents_do_not_grant_credential_reads() {
        let backend = FakeBackend::default();
        backend.0.lock().unwrap().credential =
            Some(serde_json::to_vec(&wire_credential("existing-access")).unwrap());
        let lease = CredentialLeaseId("lease-1".to_owned());
        for kind in [
            CredentialAccessIntent::Login,
            CredentialAccessIntent::Logout,
        ] {
            let (authority, _guard) = authorized_intent(kind);
            let response = handle_credential_frame(
                PiCredentialFrame::Read {
                    protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                    request_id: format!("read-{kind:?}"),
                    lease_id: lease.clone(),
                },
                &lease,
                &backend,
                &authority,
                &mut None,
            )
            .unwrap();
            assert!(matches!(
                response,
                PiCredentialFrame::Error { ref code, .. } if code == "credential_intent_denied"
            ));
        }
    }

    #[test]
    fn inference_refresh_requires_existing_same_account_credential() {
        let backend = FakeBackend::default();
        let lease = CredentialLeaseId("lease-1".to_owned());
        let mut active = None;
        let (authority, _guard) = authorized_intent(CredentialAccessIntent::InferenceRefresh);

        let without_current = handle_credential_frame(
            PiCredentialFrame::ModifyBegin {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "begin-empty".to_owned(),
                lease_id: lease.clone(),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        assert!(matches!(
            without_current,
            PiCredentialFrame::Error { ref code, .. } if code == "credential_intent_denied"
        ));

        backend.0.lock().unwrap().credential = Some(
            serde_json::to_vec(&wire_credential_for_account("old-access", "account-1")).unwrap(),
        );
        let begin = handle_credential_frame(
            PiCredentialFrame::ModifyBegin {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "begin-refresh".to_owned(),
                lease_id: lease.clone(),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        let transaction_id = match begin {
            PiCredentialFrame::ModifyBeginResult { transaction_id, .. } => transaction_id,
            other => panic!("unexpected response: {other:?}"),
        };
        let changed = handle_credential_frame(
            PiCredentialFrame::ModifyCommit {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "commit-changed-account".to_owned(),
                lease_id: lease.clone(),
                transaction_id,
                credential: wire_credential_for_account("new-access", "account-2"),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        assert!(matches!(
            changed,
            PiCredentialFrame::Error { ref code, .. } if code == "credential_identity_changed"
        ));
        assert_eq!(backend.0.lock().unwrap().revision, 0);
        let replay = handle_credential_frame(
            PiCredentialFrame::ModifyBegin {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "begin-refresh-replay".to_owned(),
                lease_id: lease.clone(),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        assert!(matches!(
            replay,
            PiCredentialFrame::Error { ref code, .. } if code == "credential_intent_denied"
        ));
    }

    #[test]
    fn revoked_intent_aborts_an_abandoned_transaction() {
        let backend = FakeBackend::default();
        let lease = CredentialLeaseId("lease-1".to_owned());
        let mut active = None;
        let (authority, guard) = authorized_intent(CredentialAccessIntent::Login);
        let response = handle_credential_frame(
            PiCredentialFrame::ModifyBegin {
                protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                request_id: "begin-abandoned".to_owned(),
                lease_id: lease.clone(),
            },
            &lease,
            &backend,
            &authority,
            &mut active,
        )
        .unwrap();
        assert!(matches!(
            response,
            PiCredentialFrame::ModifyBeginResult { .. }
        ));
        assert!(backend.0.lock().unwrap().transaction_active);

        drop(guard);
        abort_revoked_transaction(&mut active, &authority);
        assert!(active.is_none());
        assert!(!backend.0.lock().unwrap().transaction_active);

        let (next_authority, _next_guard) = authorized_intent(CredentialAccessIntent::Login);
        let mut next_active = None;
        assert!(matches!(
            handle_credential_frame(
                PiCredentialFrame::ModifyBegin {
                    protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
                    request_id: "begin-next".to_owned(),
                    lease_id: lease,
                },
                &CredentialLeaseId("lease-1".to_owned()),
                &backend,
                &next_authority,
                &mut next_active,
            )
            .unwrap(),
            PiCredentialFrame::ModifyBeginResult { .. }
        ));
    }

    #[test]
    fn credential_material_conversion_preserves_provider_metadata() {
        let wire = wire_credential("access-secret");
        let material = wire_to_material(&wire).unwrap();
        let restored = material_to_wire(&material).unwrap();
        assert_eq!(
            restored.metadata.get("accountId"),
            Some(&Value::String("account-1".to_owned()))
        );
        assert_eq!(
            restored.access.expose_to_credential_adapter(),
            "access-secret"
        );
    }
}
