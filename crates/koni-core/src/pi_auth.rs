//! Token-free authentication contracts for the Pi runtime boundary.
//!
//! These types deliberately never carry bearer or refresh tokens. A future
//! credential broker can resolve an opaque lease over a separate authenticated
//! channel without exposing credentials to transcripts, argv, or environment.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{BufRead, Write};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

use crate::error::{KoniError, Result};
use crate::pi_protocol::read_bounded_line;

pub(crate) const PI_CREDENTIAL_PROTOCOL_VERSION: u16 = 1;
pub(crate) const MAX_PI_CREDENTIAL_FRAME_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OAuthProvider {
    OpenAiCodex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OAuthLoginFlow {
    BrowserPkce,
    DeviceCode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "interaction", rename_all = "snake_case")]
pub enum OAuthInteraction {
    AuthUrl {
        url: String,
        instructions: Option<String>,
    },
    DeviceCode {
        user_code: String,
        verification_uri: String,
        interval_seconds: Option<u64>,
        expires_in_seconds: Option<u64>,
    },
    Progress {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialLeaseId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "request", rename_all = "snake_case")]
pub enum CredentialBrokerRequest {
    Status {
        provider: OAuthProvider,
    },
    BeginLogin {
        provider: OAuthProvider,
        preferred_flow: OAuthLoginFlow,
    },
    AcquireLease {
        provider: OAuthProvider,
        session_id: String,
    },
    Logout {
        provider: OAuthProvider,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OAuthStatus {
    SignedOut,
    LoginPending {
        flow: OAuthLoginFlow,
        verification_uri: Option<String>,
        user_code: Option<String>,
        expires_at: DateTime<Utc>,
    },
    SignedIn {
        account_label: Option<String>,
        expires_at: Option<DateTime<Utc>>,
    },
    ReauthenticationRequired {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "response", rename_all = "snake_case")]
pub enum CredentialBrokerResponse {
    Status {
        provider: OAuthProvider,
        status: OAuthStatus,
    },
    LoginStarted {
        provider: OAuthProvider,
        status: OAuthStatus,
    },
    LeaseGranted {
        provider: OAuthProvider,
        lease_id: CredentialLeaseId,
        expires_at: Option<DateTime<Utc>>,
    },
    LoggedOut {
        provider: OAuthProvider,
    },
    Denied {
        code: String,
        message: String,
    },
}

/// Token-free broker surface used by CLI/TUI and durable runtime setup.
pub trait CredentialBroker: Send + Sync {
    fn handle(&self, request: &CredentialBrokerRequest) -> Result<CredentialBrokerResponse>;
}

/// Secret text confined to the private credential channel. It intentionally
/// has no `Clone`, `Display`, or public accessor and always redacts `Debug`.
pub(crate) struct SensitiveCredential(String);

impl SensitiveCredential {
    #[cfg(test)]
    pub(crate) fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub(crate) fn expose_to_credential_adapter(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SensitiveCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("[REDACTED]")
    }
}

impl Drop for SensitiveCredential {
    fn drop(&mut self) {
        // SAFETY: replacing every byte with zero preserves UTF-8 validity and
        // the string is not observed again while it is being dropped.
        unsafe { self.0.as_bytes_mut() }.fill(0);
    }
}

impl Serialize for SensitiveCredential {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SensitiveCredential {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(Self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PiCredentialKind {
    #[serde(rename = "oauth")]
    OAuth,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct PiOAuthCredentialMaterial {
    #[serde(rename = "type")]
    pub(crate) kind: PiCredentialKind,
    pub(crate) access: SensitiveCredential,
    pub(crate) refresh: SensitiveCredential,
    /// Pi credential expiry as Unix epoch milliseconds.
    pub(crate) expires: u64,
    /// Provider-owned metadata such as the OpenAI account id is retained
    /// losslessly across a brokered refresh transaction.
    #[serde(flatten)]
    pub(crate) metadata: BTreeMap<String, Value>,
}

impl fmt::Debug for PiOAuthCredentialMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PiOAuthCredentialMaterial")
            .field("kind", &self.kind)
            .field("access", &self.access)
            .field("refresh", &self.refresh)
            .field("expires", &self.expires)
            .field("metadata_keys", &self.metadata.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// Private request/response protocol carried on a distinct inherited pipe.
/// It is intentionally not a variant of `PiFrame`, `RuntimeInbound`, or
/// `RuntimeEvent`. A `ModifyBegin` transaction holds the Rust-owned per-user
/// credential lock until `ModifyCommit` or `ModifyAbort`, exactly matching
/// Pi's serialized asynchronous `CredentialStore.modify` callback. Production
/// integration carries these frames on a duplex Unix `SOCK_STREAM` inherited
/// by the host as fd 3; it must never multiplex them onto stdout or stderr.
#[derive(Serialize, Deserialize)]
#[serde(tag = "frame", rename_all = "snake_case")]
pub(crate) enum PiCredentialFrame {
    Read {
        protocol_version: u16,
        request_id: String,
        lease_id: CredentialLeaseId,
    },
    ReadResult {
        protocol_version: u16,
        request_id: String,
        lease_id: CredentialLeaseId,
        revision: u64,
        credential: Option<PiOAuthCredentialMaterial>,
    },
    ModifyBegin {
        protocol_version: u16,
        request_id: String,
        lease_id: CredentialLeaseId,
    },
    ModifyBeginResult {
        protocol_version: u16,
        request_id: String,
        lease_id: CredentialLeaseId,
        transaction_id: String,
        current: Option<PiOAuthCredentialMaterial>,
    },
    ModifyCommit {
        protocol_version: u16,
        request_id: String,
        lease_id: CredentialLeaseId,
        transaction_id: String,
        credential: PiOAuthCredentialMaterial,
    },
    ModifyCommitResult {
        protocol_version: u16,
        request_id: String,
        lease_id: CredentialLeaseId,
        transaction_id: String,
        credential: PiOAuthCredentialMaterial,
    },
    ModifyAbort {
        protocol_version: u16,
        request_id: String,
        lease_id: CredentialLeaseId,
        transaction_id: String,
        reason: String,
    },
    ModifyAbortResult {
        protocol_version: u16,
        request_id: String,
        lease_id: CredentialLeaseId,
        transaction_id: String,
    },
    Delete {
        protocol_version: u16,
        request_id: String,
        lease_id: CredentialLeaseId,
    },
    DeleteResult {
        protocol_version: u16,
        request_id: String,
        lease_id: CredentialLeaseId,
    },
    Error {
        protocol_version: u16,
        request_id: String,
        code: String,
        message: String,
        retryable: bool,
    },
}

impl fmt::Debug for PiCredentialFrame {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read {
                request_id,
                lease_id,
                ..
            } => formatter
                .debug_struct("Read")
                .field("request_id", request_id)
                .field("lease_id", lease_id)
                .finish(),
            Self::ReadResult {
                request_id,
                lease_id,
                revision,
                credential,
                ..
            } => formatter
                .debug_struct("ReadResult")
                .field("request_id", request_id)
                .field("lease_id", lease_id)
                .field("revision", revision)
                .field("credential", &credential.as_ref().map(|_| "[REDACTED]"))
                .finish(),
            Self::ModifyBegin {
                request_id,
                lease_id,
                ..
            } => formatter
                .debug_struct("ModifyBegin")
                .field("request_id", request_id)
                .field("lease_id", lease_id)
                .finish(),
            Self::ModifyBeginResult {
                request_id,
                lease_id,
                transaction_id,
                current,
                ..
            } => formatter
                .debug_struct("ModifyBeginResult")
                .field("request_id", request_id)
                .field("lease_id", lease_id)
                .field("transaction_id", transaction_id)
                .field("current", &current.as_ref().map(|_| "[REDACTED]"))
                .finish(),
            Self::ModifyCommit {
                request_id,
                lease_id,
                transaction_id,
                ..
            } => formatter
                .debug_struct("ModifyCommit")
                .field("request_id", request_id)
                .field("lease_id", lease_id)
                .field("transaction_id", transaction_id)
                .field("credential", &"[REDACTED]")
                .finish(),
            Self::ModifyCommitResult {
                request_id,
                lease_id,
                transaction_id,
                ..
            } => formatter
                .debug_struct("ModifyCommitResult")
                .field("request_id", request_id)
                .field("lease_id", lease_id)
                .field("transaction_id", transaction_id)
                .field("credential", &"[REDACTED]")
                .finish(),
            Self::ModifyAbort {
                request_id,
                lease_id,
                transaction_id,
                ..
            } => formatter
                .debug_struct("ModifyAbort")
                .field("request_id", request_id)
                .field("lease_id", lease_id)
                .field("transaction_id", transaction_id)
                .finish(),
            Self::ModifyAbortResult {
                request_id,
                lease_id,
                transaction_id,
                ..
            } => formatter
                .debug_struct("ModifyAbortResult")
                .field("request_id", request_id)
                .field("lease_id", lease_id)
                .field("transaction_id", transaction_id)
                .finish(),
            Self::Delete {
                request_id,
                lease_id,
                ..
            } => formatter
                .debug_struct("Delete")
                .field("request_id", request_id)
                .field("lease_id", lease_id)
                .finish(),
            Self::DeleteResult {
                request_id,
                lease_id,
                ..
            } => formatter
                .debug_struct("DeleteResult")
                .field("request_id", request_id)
                .field("lease_id", lease_id)
                .finish(),
            Self::Error {
                request_id,
                code,
                retryable,
                ..
            } => formatter
                .debug_struct("Error")
                .field("request_id", request_id)
                .field("code", code)
                .field("retryable", retryable)
                .finish(),
        }
    }
}

pub(crate) fn read_pi_credential_frame(
    reader: &mut impl BufRead,
) -> Result<Option<PiCredentialFrame>> {
    let Some(mut encoded) = read_bounded_line(reader, MAX_PI_CREDENTIAL_FRAME_BYTES)? else {
        return Ok(None);
    };
    let decoded = serde_json::from_slice::<PiCredentialFrame>(&encoded).map_err(|error| {
        KoniError::Process(format!(
            "Pi credential protocol error: invalid JSON: {error}"
        ))
    });
    encoded.fill(0);
    let frame = decoded?;
    validate_credential_frame(&frame)?;
    Ok(Some(frame))
}

pub(crate) fn write_pi_credential_frame(
    writer: &mut impl Write,
    frame: &PiCredentialFrame,
) -> Result<()> {
    validate_credential_frame(frame)?;
    let mut encoded = serde_json::to_vec(frame).map_err(|error| {
        KoniError::Process(format!(
            "Pi credential protocol error: could not encode frame: {error}"
        ))
    })?;
    if encoded.len() > MAX_PI_CREDENTIAL_FRAME_BYTES {
        encoded.fill(0);
        return Err(KoniError::Process(format!(
            "Pi credential protocol error: frame exceeds the {MAX_PI_CREDENTIAL_FRAME_BYTES}-byte limit"
        )));
    }
    let result = writer
        .write_all(&encoded)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|error| {
            KoniError::Process(format!(
                "Pi credential protocol error: could not write frame: {error}"
            ))
        });
    encoded.fill(0);
    result
}

fn validate_credential_frame(frame: &PiCredentialFrame) -> Result<()> {
    let (protocol_version, request_id, lease_id) = match frame {
        PiCredentialFrame::Read {
            protocol_version,
            request_id,
            lease_id,
        }
        | PiCredentialFrame::ReadResult {
            protocol_version,
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::ModifyBegin {
            protocol_version,
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::ModifyBeginResult {
            protocol_version,
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::ModifyCommit {
            protocol_version,
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::ModifyCommitResult {
            protocol_version,
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::ModifyAbort {
            protocol_version,
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::ModifyAbortResult {
            protocol_version,
            request_id,
            lease_id,
            ..
        }
        | PiCredentialFrame::Delete {
            protocol_version,
            request_id,
            lease_id,
        }
        | PiCredentialFrame::DeleteResult {
            protocol_version,
            request_id,
            lease_id,
            ..
        } => (*protocol_version, request_id, Some(lease_id)),
        PiCredentialFrame::Error {
            protocol_version,
            request_id,
            ..
        } => (*protocol_version, request_id, None),
    };
    if protocol_version != PI_CREDENTIAL_PROTOCOL_VERSION {
        return Err(KoniError::Process(format!(
            "Pi credential protocol error: unsupported version {protocol_version}"
        )));
    }
    crate::pi_protocol::validate_pi_identifier("credential request_id", request_id)?;
    if let Some(lease_id) = lease_id {
        crate::pi_protocol::validate_pi_identifier("credential lease_id", &lease_id.0)?;
    }
    let transaction_id = match frame {
        PiCredentialFrame::ModifyBeginResult { transaction_id, .. }
        | PiCredentialFrame::ModifyCommit { transaction_id, .. }
        | PiCredentialFrame::ModifyCommitResult { transaction_id, .. }
        | PiCredentialFrame::ModifyAbort { transaction_id, .. }
        | PiCredentialFrame::ModifyAbortResult { transaction_id, .. } => Some(transaction_id),
        _ => None,
    };
    if let Some(transaction_id) = transaction_id {
        crate::pi_protocol::validate_pi_identifier("credential transaction_id", transaction_id)?;
    }
    let credential = match frame {
        PiCredentialFrame::ReadResult { credential, .. } => credential.as_ref(),
        PiCredentialFrame::ModifyBeginResult { current, .. } => current.as_ref(),
        PiCredentialFrame::ModifyCommit { credential, .. }
        | PiCredentialFrame::ModifyCommitResult { credential, .. } => Some(credential),
        _ => None,
    };
    if let Some(credential) = credential {
        validate_credential_material(credential)?;
    }
    Ok(())
}

fn validate_credential_material(credential: &PiOAuthCredentialMaterial) -> Result<()> {
    for (name, value) in [
        ("access", &credential.access),
        ("refresh", &credential.refresh),
    ] {
        let value = value.expose_to_credential_adapter();
        if value.is_empty() || value.len() > 32 * 1024 || value.chars().any(char::is_control) {
            return Err(KoniError::Process(format!(
                "Pi credential protocol error: OAuth {name} credential is invalid"
            )));
        }
    }
    const MAX_SAFE_JAVASCRIPT_INTEGER: u64 = 9_007_199_254_740_991;
    if credential.expires == 0 || credential.expires > MAX_SAFE_JAVASCRIPT_INTEGER {
        return Err(KoniError::Process(
            "Pi credential protocol error: OAuth expiry is outside the exact JavaScript integer range"
                .to_owned(),
        ));
    }
    for reserved in ["type", "access", "refresh", "expires"] {
        if credential.metadata.contains_key(reserved) {
            return Err(KoniError::Process(format!(
                "Pi credential protocol error: duplicate reserved OAuth field {reserved}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    #[test]
    fn credential_messages_expose_only_an_opaque_lease() {
        let response = CredentialBrokerResponse::LeaseGranted {
            provider: OAuthProvider::OpenAiCodex,
            lease_id: CredentialLeaseId("lease-7".to_owned()),
            expires_at: None,
        };
        let encoded = serde_json::to_string(&response).unwrap();

        assert!(encoded.contains("lease-7"));
        assert!(!encoded.contains("access_token"));
        assert!(!encoded.contains("refresh_token"));
        assert!(!encoded.contains("bearer"));
    }

    #[test]
    fn private_credential_frame_round_trips_but_redacts_debug() {
        let credential = PiOAuthCredentialMaterial {
            kind: PiCredentialKind::OAuth,
            access: SensitiveCredential::new("access-secret"),
            refresh: SensitiveCredential::new("refresh-secret"),
            expires: 1_750_000_000_000,
            metadata: BTreeMap::from([(
                "accountId".to_owned(),
                Value::String("account-1".to_owned()),
            )]),
        };
        assert_eq!(
            credential.access.expose_to_credential_adapter(),
            "access-secret"
        );
        let frame = PiCredentialFrame::ModifyCommit {
            protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
            request_id: "refresh-1".to_owned(),
            lease_id: CredentialLeaseId("lease-7".to_owned()),
            transaction_id: "transaction-3".to_owned(),
            credential,
        };
        let debug = format!("{frame:?}");
        assert!(!debug.contains("access-secret"));
        assert!(!debug.contains("refresh-secret"));

        let mut encoded = Vec::new();
        write_pi_credential_frame(&mut encoded, &frame).unwrap();
        let encoded_text = String::from_utf8(encoded.clone()).unwrap();
        assert!(encoded_text.contains("\"frame\":\"modify_commit\""));
        assert!(encoded_text.contains("\"accountId\":\"account-1\""));
        let mut reader = BufReader::new(Cursor::new(encoded));
        let decoded = read_pi_credential_frame(&mut reader).unwrap().unwrap();
        let decoded_debug = format!("{decoded:?}");
        assert!(!decoded_debug.contains("access-secret"));
        assert!(!decoded_debug.contains("refresh-secret"));
        match decoded {
            PiCredentialFrame::ModifyCommit {
                transaction_id,
                credential,
                ..
            } => {
                assert_eq!(transaction_id, "transaction-3");
                assert_eq!(
                    credential.refresh.expose_to_credential_adapter(),
                    "refresh-secret"
                );
                assert_eq!(
                    credential.metadata.get("accountId"),
                    Some(&Value::String("account-1".to_owned()))
                );
            }
            other => panic!("expected commit-modify frame, received {other:?}"),
        }
    }

    #[test]
    fn credential_frames_are_not_runtime_protocol_frames() {
        let frame = PiCredentialFrame::Read {
            protocol_version: PI_CREDENTIAL_PROTOCOL_VERSION,
            request_id: "read-1".to_owned(),
            lease_id: CredentialLeaseId("lease-7".to_owned()),
        };
        let encoded = serde_json::to_vec(&frame).unwrap();
        assert!(serde_json::from_slice::<crate::pi_protocol::PiFrame>(&encoded).is_err());
    }
}
